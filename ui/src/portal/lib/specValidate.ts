// Client-side validator for the API definition editor. Catches the structural
// issues APIM rejects (bad version field, missing info.title/version, missing
// paths, malformed operations, bad URLs) before the user pays the round-trip.
// Also handles JSON↔YAML detection and conversion.
//
// Trade-off: this is structural validation only — no full $ref resolution, no
// JSON-schema check of every parameter. APIM itself is the source of truth.
// We aim to surface the 90% of mistakes that have an obvious fix, not to
// replace the server check.

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
    // Azure APIM "Restrictions on API import" documents support for OpenAPI
    // 3.0 up to 3.0.3 and OpenAPI 3.1 with feature caveats. Anything else is
    // technically a 3.x string but lives outside Azure's tested matrix — we
    // warn rather than error so the user can still attempt the import.
    if (!/^3\.\d+(\.\d+)?$/.test(openapi)) {
      diagnostics.push({
        severity: 'error',
        message: `\`openapi\` must be a 3.x version string (got "${openapi}").`,
        path: ['openapi']
      });
    } else if (/^3\.0\.([0-3])$/.test(openapi)) {
      // Within the recommended range — no diagnostic.
    } else if (/^3\.1(\.\d+)?$/.test(openapi)) {
      diagnostics.push({
        severity: 'warning',
        message: `OpenAPI 3.1 (got "${openapi}") is supported by Azure APIM with limitations — 3.1-specific constructs (webhooks, JSON Schema 2020-12 keywords, type arrays, polymorphic discriminators) may be normalised or dropped on import. Use 3.0.0–3.0.3 for highest fidelity.`,
        path: ['openapi']
      });
    } else if (/^3\.0(\.\d+)?$/.test(openapi)) {
      diagnostics.push({
        severity: 'warning',
        message: `OpenAPI ${openapi} is outside Azure APIM's tested range (3.0.0–3.0.3). Import may fail or features may be lost.`,
        path: ['openapi']
      });
    } else {
      diagnostics.push({
        severity: 'warning',
        message: `OpenAPI ${openapi} is outside Azure APIM's documented support (3.0.0–3.0.3 or 3.1.x).`,
        path: ['openapi']
      });
    }
  } else if (swagger) {
    if (swagger !== '2.0') {
      diagnostics.push({
        severity: 'error',
        message: `\`swagger\` must be exactly "2.0" (got "${swagger}"). Azure APIM does not import Swagger 1.x.`,
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

  // Components / definitions: not required, but a common APIM gotcha is
  // referencing a schema that doesn't exist. Catching every $ref is overkill
  // here, but warn if components/definitions look malformed at the top level.
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
      message: '`paths` is empty — APIM accepts this, but the API will expose no endpoints.',
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
