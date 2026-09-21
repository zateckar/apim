// Client-side validator for the API definition editor. Catches the structural
// issues the control plane refuses (bad version field, missing info.title or
// info.version, missing paths, malformed operations, bad URLs) before the user
// pays the round-trip. Also handles JSON↔YAML detection and conversion.
//
// Trade-off: this is structural validation only — no full $ref resolution, no
// JSON-schema check of every parameter. `control-plane/src/normalize.ts` is the
// source of truth. We aim to surface the mistakes that have an obvious fix, not
// to replace the server check.
//
// This file was ported from the Azure-APIM-backed predecessor and, until it was
// wired to a screen, nothing had ever read its messages. They described what
// *Azure* would accept: a "tested matrix" of 3.0.0–3.0.3, OpenAPI 3.1 supported
// "with limitations", `paths: {}` as something "APIM accepts". None of that is
// true here — `resources.ts` accepts `swagger-2.0`, `openapi-3.0` and
// `openapi-3.1` alike, and normalises all three to one model. The rules below
// are this system's, and the two that actually get a document refused were the
// two the Azure-era validator never checked: it must be JSON, and it must be
// self-contained.

import * as YAML from 'yaml';

export type SpecFormat = 'json' | 'yaml';

export type DiagnosticSeverity = 'error' | 'warning' | 'info';

export interface SpecDiagnostic {
  severity: DiagnosticSeverity;
  message: string;
  // Path inside the parsed document, e.g. ['info', 'title']. Empty for
  // top-level diagnostics.
  path?: (string | number)[];
  // Best-effort source location. Parse errors carry these from the underlying
  // parser; structural errors usually only have `path`.
  line?: number;
  col?: number;
  // 0-based char offset into the source text, when known. CodeMirror lint
  // needs this; we leave it undefined when we can't resolve it.
  from?: number;
  to?: number;
}

export interface ParseResult {
  ok: boolean;
  doc?: unknown;
  format: SpecFormat;
  diagnostics: SpecDiagnostic[];
}

const HTTP_METHODS = new Set([
  'get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'
]);

// Format detection: a leading `{` or `[` (after whitespace) means JSON, since
// no real OpenAPI YAML doc starts that way. Everything else (block-style
// mappings, comments, etc.) is YAML. Detection is purely lexical so users get
// the parser error matching what they typed instead of a misleading fallback
// when their JSON is broken.
export function detectFormat(text: string): SpecFormat {
  const trimmed = text.trim();
  if (!trimmed) return 'yaml';
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return 'json';
  return 'yaml';
}

export function parseSpec(text: string): ParseResult {
  const format = detectFormat(text);
  const diagnostics: SpecDiagnostic[] = [];
  if (!text.trim()) {
    diagnostics.push({ severity: 'error', message: 'Definition is empty.' });
    return { ok: false, format, diagnostics };
  }
  if (format === 'json') {
    try {
      const doc = JSON.parse(text);
      return { ok: true, doc, format, diagnostics };
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Invalid JSON';
      const loc = extractJsonErrorLocation(msg, text);
      diagnostics.push({
        severity: 'error',
        message: `JSON parse error: ${msg}`,
        line: loc?.line,
        col: loc?.col,
        from: loc?.offset,
        to: loc != null ? loc.offset + 1 : undefined
      });
      return { ok: false, format, diagnostics };
    }
  }
  // YAML branch
  try {
    const parsed = YAML.parseDocument(text, { prettyErrors: true });
    for (const e of parsed.errors) {
      const pos = e.linePos?.[0];
      diagnostics.push({
        severity: 'error',
        message: `YAML parse error: ${e.message}`,
        line: pos?.line,
        col: pos?.col,
        from: e.pos?.[0],
        to: e.pos?.[1]
      });
    }
    for (const w of parsed.warnings) {
      const pos = w.linePos?.[0];
      diagnostics.push({
        severity: 'warning',
        message: `YAML warning: ${w.message}`,
        line: pos?.line,
        col: pos?.col,
        from: w.pos?.[0],
        to: w.pos?.[1]
      });
    }
    if (parsed.errors.length > 0) {
      return { ok: false, format, diagnostics };
    }
    const doc = parsed.toJS({ maxAliasCount: 100 });
    return { ok: true, doc, format, diagnostics };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Invalid YAML';
    diagnostics.push({ severity: 'error', message: `YAML parse error: ${msg}` });
    return { ok: false, format, diagnostics };
  }
}

// JSON.parse errors include "at position N" in V8/Spidermonkey; convert that
// offset back to a line/col so CodeMirror can highlight the exact spot.
function extractJsonErrorLocation(message: string, text: string): { line: number; col: number; offset: number } | undefined {
  const m = message.match(/position\s+(\d+)/i);
  if (!m) return undefined;
  const offset = Number(m[1]);
  if (!Number.isFinite(offset) || offset < 0) return undefined;
  let line = 1;
  let col = 1;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text.codePointAt(i) === 10) { line++; col = 1; }
    else col++;
  }
  return { line, col, offset };
}

// Structural validation. We accept either OpenAPI 3.x or Swagger 2.0 — APIM
// supports both — and apply slightly different rules. Each diagnostic carries
// a path inside the doc so the diagnostics panel can show "info.title" etc.
export function validateOpenApi(doc: unknown): SpecDiagnostic[] {
  const diagnostics: SpecDiagnostic[] = [];
  if (!isPlainObject(doc)) {
    diagnostics.push({ severity: 'error', message: 'Top-level value must be an object.' });
    return diagnostics;
  }
  const root = doc as Record<string, unknown>;
  const openapi = typeof root.openapi === 'string' ? root.openapi.trim() : undefined;
  const swagger = typeof root.swagger === 'string' ? root.swagger.trim() : undefined;

  if (!openapi && !swagger) {
    diagnostics.push({
      severity: 'error',
      message: 'Missing `openapi` (3.x) or `swagger` (2.0) version field.'
    });
  } else if (openapi) {
    // 3.0 and 3.1 are both first-class: `normalize.ts` reads either into the same
    // model and records the schema dialect rather than rewriting the schemas, so
    // there is no fidelity argument for preferring one. Anything that is not 3.x
    // is refused outright.
    if (!/^3\.\d+(\.\d+)?$/.test(openapi)) {
      diagnostics.push({
        severity: 'error',
        message: `\`openapi\` must be a 3.x version string (got "${openapi}").`,
        path: ['openapi']
      });
    }
  } else if (swagger) {
    if (swagger !== '2.0') {
      diagnostics.push({
        severity: 'error',
        message: `\`swagger\` must be exactly "2.0" (got "${swagger}"). Swagger 1.x is not accepted — convert it to 2.0 or to OpenAPI 3.`,
        path: ['swagger']
      });
    }
  }

  validateInfo(root.info, diagnostics);
  validatePaths(root.paths, diagnostics);

  if (openapi) {
    if (root.servers !== undefined) validateServers(root.servers, diagnostics);
  } else if (swagger) {
    validateSwaggerHost(root, diagnostics);
  }

  validateSelfContained(root, diagnostics, [], root);

  // Components / definitions: not required, but a malformed container at the top
  // level is worth saying on its own — `validateSelfContained` reports the broken
  // references, and "every `$ref` is broken" is a worse way to learn that
  // `components` is an array.
  if (root.components !== undefined && !isPlainObject(root.components)) {
    diagnostics.push({
      severity: 'error',
      message: '`components` must be an object.',
      path: ['components']
    });
  }
  if (root.definitions !== undefined && !isPlainObject(root.definitions)) {
    diagnostics.push({
      severity: 'error',
      message: '`definitions` must be an object.',
      path: ['definitions']
    });
  }

  return diagnostics;
}

/**
 * Every `$ref` must point inside the document, and must point at something.
 *
 * `control-plane/src/normalize.ts` refuses both outright. An external `$ref` is an
 * SSRF vector and an availability dependency on somebody else's web server at
 * validation time (design section 5.3); it is the single most common reason a
 * real-world document is rejected, because exported specs routinely split their
 * schemas across files, and until the editor said so the author found out from a
 * 400 at publish.
 *
 * A `$ref` that stays inside the document and resolves to nothing is the quieter
 * half of the same mistake — usually the residue of exactly that split, where the
 * `#/components/schemas/X` survived the bundling and `X` did not. It cannot be
 * compiled into a validator, so the operations that use it would publish
 * unvalidated, and the same 400 now names it.
 */
function validateSelfContained(
  node: unknown,
  diagnostics: SpecDiagnostic[],
  path: (string | number)[] = [],
  root?: unknown
): void {
  const document = root ?? node;
  if (Array.isArray(node)) {
    node.forEach((item, index) =>
      validateSelfContained(item, diagnostics, [...path, index], document)
    );
    return;
  }
  if (!isPlainObject(node)) return;
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key === '$ref' && typeof value === 'string') {
      if (!value.startsWith('#/')) {
        diagnostics.push({
          severity: 'error',
          message: `\`$ref\` points outside this document ("${value}"). Uploaded definitions must be self-contained — inline the target, or bundle the document before importing it.`,
          path: [...path, key]
        });
        continue;
      }
      if (resolveJsonPointer(document, value) === undefined) {
        diagnostics.push({
          severity: 'error',
          message: `\`$ref\` is broken: "${value}" does not resolve anywhere in this document. An operation that references it cannot be validated, so the import is refused — add the missing definition, or remove the reference.`,
          path: [...path, key]
        });
      }
      continue;
    }
    validateSelfContained(value, diagnostics, [...path, key], document);
  }
}

/** RFC 6901, including array indices. The mirror of `resolveJsonPointer` in `normalize.ts`. */
function resolveJsonPointer(root: unknown, pointer: string): unknown {
  let current: unknown = root;
  for (const raw of pointer.slice(2).split('/')) {
    const part = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    if (Array.isArray(current)) {
      const index = Number(part);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) return undefined;
      current = current[index];
      continue;
    }
    if (!isPlainObject(current)) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function validateInfo(info: unknown, diagnostics: SpecDiagnostic[]) {
  if (info === undefined) {
    diagnostics.push({ severity: 'error', message: 'Missing required `info` block.', path: ['info'] });
    return;
  }
  if (!isPlainObject(info)) {
    diagnostics.push({ severity: 'error', message: '`info` must be an object.', path: ['info'] });
    return;
  }
  const i = info as Record<string, unknown>;
  if (typeof i.title !== 'string' || !i.title.trim()) {
    diagnostics.push({
      severity: 'error',
      message: '`info.title` is required and must be a non-empty string.',
      path: ['info', 'title']
    });
  }
  if (typeof i.version !== 'string' || !i.version.trim()) {
    diagnostics.push({
      severity: 'error',
      message: '`info.version` is required and must be a non-empty string.',
      path: ['info', 'version']
    });
  }
}

function validatePaths(paths: unknown, diagnostics: SpecDiagnostic[]) {
  if (paths === undefined) {
    diagnostics.push({ severity: 'error', message: 'Missing required `paths` block.', path: ['paths'] });
    return;
  }
  if (!isPlainObject(paths)) {
    diagnostics.push({ severity: 'error', message: '`paths` must be an object.', path: ['paths'] });
    return;
  }
  const entries = Object.entries(paths as Record<string, unknown>);
  if (entries.length === 0) {
    diagnostics.push({
      severity: 'warning',
      message: '`paths` is empty — this publishes, but the API will expose no operations, and the gateway refuses a call to anything the definition does not declare.',
      path: ['paths']
    });
    return;
  }
  for (const [pathKey, pathItem] of entries) {
    if (!pathKey.startsWith('/')) {
      diagnostics.push({
        severity: 'error',
        message: `Path "${pathKey}" must start with "/".`,
        path: ['paths', pathKey]
      });
    }
    if (!isPlainObject(pathItem)) {
      diagnostics.push({
        severity: 'error',
        message: `Path "${pathKey}" must be an object.`,
        path: ['paths', pathKey]
      });
      continue;
    }
    const item = pathItem as Record<string, unknown>;
    let opCount = 0;
    for (const method of Object.keys(item)) {
      if (method === 'parameters' || method === 'summary' || method === 'description' || method === 'servers' || method === '$ref') continue;
      const lower = method.toLowerCase();
      if (!HTTP_METHODS.has(lower)) {
        diagnostics.push({
          severity: 'warning',
          message: `Unknown operation key "${method}" on path "${pathKey}".`,
          path: ['paths', pathKey, method]
        });
        continue;
      }
      opCount++;
      if (!isPlainObject(item[method])) {
        diagnostics.push({
          severity: 'error',
          message: `Operation \`${lower.toUpperCase()} ${pathKey}\` must be an object.`,
          path: ['paths', pathKey, method]
        });
        continue;
      }
      const op = item[method] as Record<string, unknown>;
      if (op.responses === undefined) {
        diagnostics.push({
          severity: 'error',
          message: `Operation \`${lower.toUpperCase()} ${pathKey}\` is missing required \`responses\`.`,
          path: ['paths', pathKey, method, 'responses']
        });
      } else if (!isPlainObject(op.responses)) {
        diagnostics.push({
          severity: 'error',
          message: `Operation \`${lower.toUpperCase()} ${pathKey}\` \`responses\` must be an object.`,
          path: ['paths', pathKey, method, 'responses']
        });
      } else if (Object.keys(op.responses as Record<string, unknown>).length === 0) {
        diagnostics.push({
          severity: 'warning',
          message: `Operation \`${lower.toUpperCase()} ${pathKey}\` declares no responses.`,
          path: ['paths', pathKey, method, 'responses']
        });
      }
    }
    if (opCount === 0) {
      diagnostics.push({
        severity: 'warning',
        message: `Path "${pathKey}" has no HTTP operations.`,
        path: ['paths', pathKey]
      });
    }
  }
}

function validateServers(servers: unknown, diagnostics: SpecDiagnostic[]) {
  if (!Array.isArray(servers)) {
    diagnostics.push({ severity: 'error', message: '`servers` must be an array.', path: ['servers'] });
    return;
  }
  servers.forEach((server, idx) => {
    if (!isPlainObject(server)) {
      diagnostics.push({
        severity: 'error',
        message: `\`servers[${idx}]\` must be an object.`,
        path: ['servers', idx]
      });
      return;
    }
    const url = (server as Record<string, unknown>).url;
    if (typeof url !== 'string' || !url.trim()) {
      diagnostics.push({
        severity: 'error',
        message: `\`servers[${idx}].url\` is required and must be a non-empty string.`,
        path: ['servers', idx, 'url']
      });
      return;
    }
    try {
      // Allow templated URLs ({var}) by replacing placeholders before parsing.
      // eslint-disable-next-line no-new
      new URL(url.replace(/\{[^}]+\}/g, 'placeholder'));
    } catch {
      diagnostics.push({
        severity: 'warning',
        message: `\`servers[${idx}].url\` "${url}" does not look like a valid URL.`,
        path: ['servers', idx, 'url']
      });
    }
  });
}

function validateSwaggerHost(root: Record<string, unknown>, diagnostics: SpecDiagnostic[]) {
  if (root.host !== undefined && typeof root.host !== 'string') {
    diagnostics.push({ severity: 'error', message: '`host` must be a string.', path: ['host'] });
  }
  if (root.basePath !== undefined && typeof root.basePath !== 'string') {
    diagnostics.push({ severity: 'error', message: '`basePath` must be a string.', path: ['basePath'] });
  }
  if (root.schemes !== undefined && !Array.isArray(root.schemes)) {
    diagnostics.push({ severity: 'error', message: '`schemes` must be an array of strings.', path: ['schemes'] });
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// Operation detail surfaced in the Definition tab's Operations panel. Each
// element is one (method, path) pair with enough metadata for the
// expandable row UI: parameters (path/query/header/cookie), the request
// body content-types, and the response status-code → description map.
// Path-level `parameters` are merged with op-level (op-level wins by
// (name, in) tuple per OpenAPI 3 semantics).
export interface SpecParameter {
  name: string;
  in: 'path' | 'query' | 'header' | 'cookie';
  required: boolean;
  description?: string;
  schemaType?: string;
  schemaFormat?: string;
}

export interface SpecRequestBody {
  description?: string;
  required: boolean;
  contentTypes: string[];
}

export interface SpecResponse {
  status: string;
  description?: string;
  contentTypes: string[];
}

export interface SpecOperation {
  method: 'GET' | 'PUT' | 'POST' | 'DELETE' | 'OPTIONS' | 'HEAD' | 'PATCH' | 'TRACE';
  path: string;
  summary?: string;
  description?: string;
  operationId?: string;
  parameters: SpecParameter[];
  requestBody?: SpecRequestBody;
  responses: SpecResponse[];
}

const PARAM_LOCATIONS = new Set(['path', 'query', 'header', 'cookie']);

function asParameter(raw: unknown): SpecParameter | null {
  if (!isPlainObject(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.name !== 'string' || typeof r.in !== 'string') return null;
  if (!PARAM_LOCATIONS.has(r.in.toLowerCase())) return null;
  const schema = isPlainObject(r.schema) ? (r.schema as Record<string, unknown>) : null;
  return {
    name: r.name,
    in: r.in.toLowerCase() as SpecParameter['in'],
    required: r.required === true,
    description: typeof r.description === 'string' ? r.description : undefined,
    schemaType: schema && typeof schema.type === 'string' ? schema.type : undefined,
    schemaFormat: schema && typeof schema.format === 'string' ? schema.format : undefined
  };
}

function mergeParameters(pathItem: Record<string, unknown>, op: Record<string, unknown>): SpecParameter[] {
  const collected = new Map<string, SpecParameter>();
  const pathArr = Array.isArray(pathItem.parameters) ? pathItem.parameters : [];
  const opArr = Array.isArray(op.parameters) ? op.parameters : [];
  for (const raw of pathArr) {
    const p = asParameter(raw);
    if (p) collected.set(`${p.in}:${p.name}`, p);
  }
  // Op-level parameters override path-level by (in, name) per OpenAPI 3.
  for (const raw of opArr) {
    const p = asParameter(raw);
    if (p) collected.set(`${p.in}:${p.name}`, p);
  }
  return Array.from(collected.values());
}

function extractRequestBody(op: Record<string, unknown>): SpecRequestBody | undefined {
  const rb = op.requestBody;
  if (!isPlainObject(rb)) return undefined;
  const r = rb as Record<string, unknown>;
  const content = isPlainObject(r.content) ? (r.content as Record<string, unknown>) : {};
  return {
    description: typeof r.description === 'string' ? r.description : undefined,
    required: r.required === true,
    contentTypes: Object.keys(content)
  };
}

function extractResponses(op: Record<string, unknown>): SpecResponse[] {
  const out: SpecResponse[] = [];
  if (!isPlainObject(op.responses)) return out;
  for (const [status, body] of Object.entries(op.responses as Record<string, unknown>)) {
    if (!isPlainObject(body)) continue;
    const b = body as Record<string, unknown>;
    const content = isPlainObject(b.content) ? (b.content as Record<string, unknown>) : {};
    out.push({
      status,
      description: typeof b.description === 'string' ? b.description : undefined,
      contentTypes: Object.keys(content)
    });
  }
  // Standardised status code order: 1xx, 2xx, 3xx, 4xx, 5xx, then `default`.
  out.sort((a, b) => {
    const aNum = /^\d{3}$/.test(a.status) ? Number(a.status) : 999;
    const bNum = /^\d{3}$/.test(b.status) ? Number(b.status) : 999;
    return aNum - bNum;
  });
  return out;
}

export function extractOperations(doc: unknown): SpecOperation[] {
  if (!isPlainObject(doc)) return [];
  const root = doc as Record<string, unknown>;
  const paths = root.paths;
  if (!isPlainObject(paths)) return [];
  const ops: SpecOperation[] = [];
  for (const [pathKey, pathItem] of Object.entries(paths as Record<string, unknown>)) {
    if (!isPlainObject(pathItem)) continue;
    const item = pathItem as Record<string, unknown>;
    for (const key of Object.keys(item)) {
      const lower = key.toLowerCase();
      if (!HTTP_METHODS.has(lower)) continue;
      const op = item[key];
      if (!isPlainObject(op)) continue;
      const opObj = op as Record<string, unknown>;
      ops.push({
        method: lower.toUpperCase() as SpecOperation['method'],
        path: pathKey,
        summary: typeof opObj.summary === 'string' ? opObj.summary : undefined,
        description: typeof opObj.description === 'string' ? opObj.description : undefined,
        operationId: typeof opObj.operationId === 'string' ? opObj.operationId : undefined,
        parameters: mergeParameters(item, opObj),
        requestBody: extractRequestBody(opObj),
        responses: extractResponses(opObj)
      });
    }
  }
  return ops;
}

// Convenience for callers that want a single combined diagnostics list.
export function lintSource(text: string): { format: SpecFormat; diagnostics: SpecDiagnostic[]; doc?: unknown } {
  const parsed = parseSpec(text);
  if (!parsed.ok || parsed.doc === undefined) {
    return { format: parsed.format, diagnostics: parsed.diagnostics };
  }
  const structural = validateOpenApi(parsed.doc);
  return { format: parsed.format, diagnostics: [...parsed.diagnostics, ...structural], doc: parsed.doc };
}

/**
 * The same, plus the rule that has nothing to do with the document's contents:
 * `parseSpecDocument` refuses anything that does not start with `{`.
 *
 * This is separate from `lintSource` because it is a fact about *this* control
 * plane rather than about OpenAPI, and because the editor can offer a one-click
 * fix for it — `convertSource` is right here, and the `yaml` package it uses is
 * already a dependency of the portal.
 *
 * The mismatch is worth naming: the workspace editor loads CodeMirror's YAML
 * mode and `prettyDefinition` deliberately leaves YAML untouched, so the portal
 * reads as though YAML were a supported input all the way up to the 400 at
 * publish. Converting silently on save is the other way to close that gap, and
 * it is the wrong one — it rewrites the author's document, with its comments and
 * its key order, without asking.
 */
export function lintDefinition(text: string): {
  format: SpecFormat;
  diagnostics: SpecDiagnostic[];
  doc?: unknown;
  /** True when the only thing wrong is the serialisation, which one click fixes. */
  convertible: boolean;
} {
  const result = lintSource(text);
  if (!text.trim() || result.format === 'json') return { ...result, convertible: false };
  const yamlParsed = result.doc !== undefined;
  return {
    ...result,
    convertible: yamlParsed,
    diagnostics: [
      {
        severity: 'error',
        message: yamlParsed
          ? 'This definition is YAML. The control plane accepts JSON only, so publishing it would be refused.'
          : 'This definition is not JSON. The control plane accepts JSON only.',
        path: []
      },
      ...result.diagnostics
    ]
  };
}

// Round-trip conversion. We stringify with `null` replacer + 2-space indent
// for JSON; for YAML we rely on the `yaml` package's default emitter, which
// preserves key order. Caller is expected to have validated the input first.
export function convertJsonToYaml(text: string): string {
  const doc = JSON.parse(text);
  return YAML.stringify(doc, { indent: 2, lineWidth: 0 });
}

export function convertYamlToJson(text: string): string {
  const doc = YAML.parse(text);
  return JSON.stringify(doc, null, 2);
}

// Format-aware converter: returns the same logical document re-serialised in
// the target format. Throws on parse failure so the caller can surface a
// toast instead of silently writing garbage into the editor.
export function convertSource(text: string, from: SpecFormat, to: SpecFormat): string {
  if (from === to) return text;
  if (from === 'json' && to === 'yaml') return convertJsonToYaml(text);
  if (from === 'yaml' && to === 'json') return convertYamlToJson(text);
  throw new Error(`Unsupported conversion ${from} → ${to}`);
}

// Order-independent structural equality check, used to tell "user converted
// JSON↔YAML" apart from "user edited the document". Plain JSON.stringify
// would treat the two as different because keys round-trip in different
// orders, so we serialise with sorted keys before comparing.
export function deepEqualSpec(a: unknown, b: unknown): boolean {
  return stableStringify(a) === stableStringify(b);
}

function stableStringify(v: unknown): string {
  if (v === null || v === undefined) return JSON.stringify(v ?? null);
  if (typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const obj = v as Record<string, unknown>;
  const keys = Object.keys(obj).sort((a, b) => a.localeCompare(b));
  return `{${keys.map(k => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}
