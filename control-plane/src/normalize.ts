import type {
  ApiModel,
  ApiOperation,
  ApiParameter,
  ApiRequestBody,
  ApiResponse,
  OriginalFormat,
} from "../../shared/types.ts";
import { badRequest } from "./router.ts";

/**
 * Design section 4.1: uploaded definitions are parsed into one internal model, and everything
 * downstream reads the model. Routing, policy resolution, validation and export are one code path
 * regardless of the dialect the document arrived in.
 *
 * Export is generation, not the bytes back: `original` is kept verbatim beside it and the UI
 * labels which is which.
 *
 * v3 makes the model carry **schemas**, because design section 5.1's validation is derived from
 * the definition and nothing else. The schemas are kept as written — the dialect is recorded
 * rather than rewritten — and compiled once, in `artifacts.ts`, so `revision.model` stays a
 * normalization and the compiled bundle stays a derived artifact (design section 8.7).
 *
 * MVP scope: JSON documents in Swagger 2.0 or OpenAPI 3.x. YAML needs the `yaml` dependency;
 * WSDL, MCP and A2A have their own normalizers.
 */
const METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"] as const;

export interface NormalizeResult {
  model: ApiModel;
  format: OriginalFormat;
}

export function parseSpecDocument(raw: string): Record<string, unknown> {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{")) {
    throw badRequest(
      "expected a JSON OpenAPI or Swagger document (YAML is not supported in the MVP; convert to JSON)",
    );
  }
  try {
    return JSON.parse(trimmed) as Record<string, unknown>;
  } catch (err) {
    throw badRequest(`spec is not valid JSON: ${(err as Error).message}`);
  }
}

/**
 * Design section 5.3: uploaded specs must be self-contained. A remote or file `$ref` is both an
 * SSRF vector and an availability dependency on someone else's web server at validation time.
 *
 * And self-contained means *resolved*, not merely local. A `$ref` that stays inside the document
 * and points at nothing was accepted here for as long as this function only looked at the `#/`
 * prefix, and the cost landed two layers down: `SchemaCompiler` refuses the pointer, `artifacts.ts`
 * catches that and marks the operation `unsupported-schema`, and the gateway skips it. The API
 * publishes, its `validate` unit reads `blocking` on the policy screen, and every body goes
 * through unchecked. A contract with a broken reference is not a contract that validates less —
 * it is one that cannot be used for the thing it was uploaded for, and the moment to say so is
 * while somebody is still holding the file.
 *
 * `root` is the whole document, so a pointer into any of it resolves the way a reader would expect:
 * `#/components/schemas/Pet`, `#/definitions/Pet`, `#/paths/~1pets/get/responses/200`.
 */
export function assertSelfContained(doc: unknown, path = "$", root?: unknown): void {
  const document = root ?? doc;
  if (Array.isArray(doc)) {
    doc.forEach((item, i) => assertSelfContained(item, `${path}[${i}]`, document));
    return;
  }
  if (!doc || typeof doc !== "object") return;
  for (const [key, value] of Object.entries(doc as Record<string, unknown>)) {
    if (key === "$ref" && typeof value === "string") {
      if (!value.startsWith("#/")) {
        throw badRequest(
          `${path}.$ref points outside the document ("${value}"); uploaded specs must be self-contained ` +
            "(design section 5.3)",
        );
      }
      if (resolveJsonPointer(document, value) === undefined) {
        throw badRequest(
          `${path}.$ref is broken: "${value}" does not resolve anywhere in this document. A ` +
            "reference that points at nothing cannot be compiled into a validator, so the " +
            "operations that use it would publish unvalidated. Add the missing definition, or " +
            "remove the reference.",
        );
      }
    }
    assertSelfContained(value, `${path}.${key}`, document);
  }
}

/**
 * RFC 6901 over the whole document, including array indices — a `$ref` into `paths` or into an
 * `allOf` member is legal OpenAPI and this is the reader's own rule for what "resolves" means.
 * `shared/jsonschema.ts` has a narrower one for the compiled bundle; that one is about the
 * pointers the bundle itself uses, and is deliberately not this.
 */
function resolveJsonPointer(root: unknown, pointer: string): unknown {
  let current: unknown = root;
  for (const raw of pointer.slice(2).split("/")) {
    const part = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (Array.isArray(current)) {
      const index = Number(part);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) return undefined;
      current = current[index];
      continue;
    }
    if (!current || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function parameterOf(raw: unknown, isV2: boolean): ApiParameter | null {
  const p = asRecord(raw);
  if (typeof p.name !== "string") return null;
  const location = typeof p.in === "string" ? p.in : "query";
  // Swagger 2.0 writes a non-body parameter's type inline; OAS 3 gives it a `schema`.
  const schema = isV2 && location !== "body" ? inlineV2Schema(p) : p.schema;
  return {
    name: p.name,
    in: location as ApiParameter["in"],
    required: p.required === true || location === "path",
    ...(schema === undefined ? {} : { schema }),
  };
}

/** Swagger 2.0's inline `type`/`format`/`items`/`enum` on a parameter, as a schema object. */
function inlineV2Schema(p: Record<string, unknown>): unknown {
  const keys = ["type", "format", "items", "enum", "minimum", "maximum", "minLength", "maxLength", "pattern", "multipleOf", "maxItems", "minItems", "uniqueItems", "exclusiveMinimum", "exclusiveMaximum"];
  const schema: Record<string, unknown> = {};
  for (const key of keys) if (p[key] !== undefined) schema[key] = p[key];
  return Object.keys(schema).length > 0 ? schema : undefined;
}

function requestBodyV3(op: Record<string, unknown>): ApiRequestBody | undefined {
  const body = asRecord(op.requestBody);
  if (Object.keys(body).length === 0) return undefined;
  const content: Record<string, unknown> = {};
  for (const [mediaType, entry] of Object.entries(asRecord(body.content))) {
    const schema = asRecord(entry).schema;
    if (schema !== undefined) content[mediaType] = schema;
  }
  return { required: body.required === true, content };
}

function requestBodyV2(
  op: Record<string, unknown>,
  parameters: unknown[],
  consumes: string[],
): ApiRequestBody | undefined {
  const bodyParam = parameters.map(asRecord).find((p) => p.in === "body");
  if (!bodyParam) return undefined;
  const types = consumes.length > 0 ? consumes : ["application/json"];
  const content: Record<string, unknown> = {};
  if (bodyParam.schema !== undefined) for (const type of types) content[type] = bodyParam.schema;
  return { required: bodyParam.required === true, content };
}

function responsesOf(
  op: Record<string, unknown>,
  isV2: boolean,
  produces: string[],
): Record<string, ApiResponse> | undefined {
  const raw = asRecord(op.responses);
  if (Object.keys(raw).length === 0) return undefined;
  const out: Record<string, ApiResponse> = {};
  for (const [status, entryRaw] of Object.entries(raw)) {
    const entry = asRecord(entryRaw);
    const response: ApiResponse = {};
    if (typeof entry.description === "string") response.description = entry.description;

    if (isV2) {
      if (entry.schema !== undefined) {
        const types = produces.length > 0 ? produces : ["application/json"];
        response.content = Object.fromEntries(types.map((type) => [type, entry.schema]));
      }
    } else {
      const content: Record<string, unknown> = {};
      for (const [mediaType, mediaRaw] of Object.entries(asRecord(entry.content))) {
        const schema = asRecord(mediaRaw).schema;
        if (schema !== undefined) content[mediaType] = schema;
      }
      if (Object.keys(content).length > 0) response.content = content;
    }

    const headers: ApiParameter[] = [];
    for (const [name, headerRaw] of Object.entries(asRecord(entry.headers))) {
      const header = asRecord(headerRaw);
      const schema = isV2 ? inlineV2Schema(header) : header.schema;
      headers.push({
        name,
        in: "header",
        required: header.required === true,
        ...(schema === undefined ? {} : { schema }),
      });
    }
    if (headers.length > 0) response.headers = headers;

    if (response.content || response.headers || response.description) out[status] = response;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function operationsFrom(doc: Record<string, unknown>, isV2: boolean): ApiOperation[] {
  const paths = asRecord(doc.paths);
  const operations: ApiOperation[] = [];
  const globalConsumes = stringArray(doc.consumes);
  const globalProduces = stringArray(doc.produces);

  for (const [pathTemplate, rawItem] of Object.entries(paths)) {
    const item = asRecord(rawItem);
    const sharedRaw = Array.isArray(item.parameters) ? item.parameters : [];
    const shared = sharedRaw.map((p) => parameterOf(p, isV2)).filter(Boolean) as ApiParameter[];

    for (const method of METHODS) {
      const rawOp = item[method];
      if (!rawOp || typeof rawOp !== "object") continue;
      const op = asRecord(rawOp);
      const ownRaw = Array.isArray(op.parameters) ? op.parameters : [];
      const own = ownRaw.map((p) => parameterOf(p, isV2)).filter(Boolean) as ApiParameter[];
      const parameters = [...shared, ...own];

      const consumes = stringArray(op.consumes).concat(globalConsumes);
      const produces = stringArray(op.produces).concat(globalProduces);
      const requestBody = isV2
        ? requestBodyV2(op, [...sharedRaw, ...ownRaw], consumes)
        : requestBodyV3(op);
      if (!isV2 && op.requestBody) {
        parameters.push({
          name: "body",
          in: "body",
          required: asRecord(op.requestBody).required === true,
        });
      }

      operations.push({
        operationId:
          typeof op.operationId === "string" && op.operationId.length > 0
            ? op.operationId
            : `${method}${pathTemplate.replace(/[^A-Za-z0-9]+/g, "_")}`,
        method: method.toUpperCase(),
        path: pathTemplate,
        summary: typeof op.summary === "string" ? op.summary : undefined,
        parameters,
        ...(requestBody ? { requestBody } : {}),
        ...(responsesOf(op, isV2, produces) ? { responses: responsesOf(op, isV2, produces) } : {}),
      });
    }
  }

  // Deterministic order: the model is digested, so iteration order must not leak into the digest.
  operations.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
  return operations;
}

function serversV2(doc: Record<string, unknown>): string[] {
  const host = typeof doc.host === "string" ? doc.host : "";
  const basePath = typeof doc.basePath === "string" ? doc.basePath.replace(/\/+$/, "") : "";
  const schemes = Array.isArray(doc.schemes)
    ? (doc.schemes.filter((s) => typeof s === "string") as string[])
    : ["https"];
  if (!host) return basePath ? [basePath] : [];
  const ordered = schemes.includes("https") ? ["https", ...schemes.filter((s) => s !== "https")] : schemes;
  return ordered.map((scheme) => `${scheme}://${host}${basePath}`);
}

function serversV3(doc: Record<string, unknown>): string[] {
  if (!Array.isArray(doc.servers)) return [];
  return doc.servers
    .map((entry) => asRecord(entry).url)
    .filter((url): url is string => typeof url === "string" && url.length > 0);
}

export function normalizeSpec(raw: string): NormalizeResult {
  const doc = parseSpecDocument(raw);
  assertSelfContained(doc);

  const info = asRecord(doc.info);
  const title = typeof info.title === "string" ? info.title : "untitled";
  const version = typeof info.version === "string" ? info.version : "1.0.0";
  const description = typeof info.description === "string" ? info.description : undefined;

  let format: OriginalFormat;
  let servers: string[];
  let isV2 = false;
  let schemaDialect: ApiModel["schemaDialect"];

  if (typeof doc.swagger === "string" && doc.swagger.startsWith("2.")) {
    format = "swagger-2.0";
    isV2 = true;
    servers = serversV2(doc);
    schemaDialect = "swagger-2.0";
  } else if (typeof doc.openapi === "string" && doc.openapi.startsWith("3.1")) {
    format = "openapi-3.1";
    servers = serversV3(doc);
    // OAS 3.1 *is* JSON Schema 2020-12; the dialect difference resolves once, here (§4.1).
    schemaDialect = "2020-12";
  } else if (typeof doc.openapi === "string" && doc.openapi.startsWith("3.")) {
    format = "openapi-3.0";
    servers = serversV3(doc);
    schemaDialect = "oas-3.0";
  } else {
    throw badRequest(
      'not an OpenAPI document: expected a "swagger": "2.0" or "openapi": "3.x" field at the top level',
    );
  }

  const operations = operationsFrom(doc, isV2);
  if (operations.length === 0) throw badRequest("the document declares no operations");

  // Kept in the shape the document's own `$ref`s were written against, so a reference resolves the
  // way its author wrote it rather than through a rewriting step nobody can see.
  const components: Record<string, unknown> = {};
  if (isV2 && doc.definitions) components.definitions = doc.definitions;
  if (!isV2 && doc.components) components.components = doc.components;

  return {
    model: {
      title,
      version,
      description,
      servers,
      operations,
      schemaDialect,
      ...(Object.keys(components).length > 0 ? { components } : {}),
    },
    format,
  };
}

/** Design section 4.1: export is generation from the model, never the uploaded bytes. */
export function toOpenApi31(model: ApiModel): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const op of model.operations) {
    const item = (paths[op.path] ??= {});
    const parameters = op.parameters
      .filter((p) => p.in === "path" || p.in === "query" || p.in === "header")
      .map((p) => ({
        name: p.name,
        in: p.in,
        required: p.required,
        schema: p.schema ?? { type: "string" },
      }));
    const entry: Record<string, unknown> = {
      operationId: op.operationId,
      responses: responsesToOpenApi(op),
    };
    if (op.summary) entry.summary = op.summary;
    if (parameters.length > 0) entry.parameters = parameters;
    if (op.requestBody) {
      entry.requestBody = {
        required: op.requestBody.required,
        content: Object.fromEntries(
          Object.entries(op.requestBody.content).map(([type, schema]) => [type, { schema }]),
        ),
      };
    } else if (op.parameters.some((p) => p.in === "body" || p.in === "formData")) {
      entry.requestBody = {
        required: op.parameters.some((p) => (p.in === "body" || p.in === "formData") && p.required),
        content: { "application/json": { schema: { type: "object" } } },
      };
    }
    item[op.method.toLowerCase()] = entry;
  }

  // 3.1 keeps shared schemas under `components.schemas`; a Swagger 2.0 model's `definitions` are
  // moved there and every `$ref` rewritten, because export is generation into one target dialect.
  const componentSchemas = componentSchemasOf(model);

  return {
    openapi: "3.1.0",
    info: {
      title: model.title,
      version: model.version,
      ...(model.description ? { description: model.description } : {}),
    },
    servers: model.servers.map((url) => ({ url })),
    paths: model.schemaDialect === "swagger-2.0" ? rewriteRefs(paths) : paths,
    ...(componentSchemas ? { components: { schemas: componentSchemas } } : {}),
  };
}

function responsesToOpenApi(op: ApiOperation): Record<string, unknown> {
  if (!op.responses) return { "200": { description: "OK" } };
  const out: Record<string, unknown> = {};
  for (const [status, response] of Object.entries(op.responses)) {
    out[status] = {
      description: response.description ?? "",
      ...(response.content
        ? {
            content: Object.fromEntries(
              Object.entries(response.content).map(([type, schema]) => [type, { schema }]),
            ),
          }
        : {}),
      ...(response.headers
        ? {
            headers: Object.fromEntries(
              response.headers.map((h) => [
                h.name,
                { required: h.required, schema: h.schema ?? { type: "string" } },
              ]),
            ),
          }
        : {}),
    };
  }
  return out;
}

function componentSchemasOf(model: ApiModel): Record<string, unknown> | null {
  const components = model.components;
  if (!components) return null;
  if (components.definitions) return rewriteRefs(components.definitions) as Record<string, unknown>;
  const schemas = asRecord(components.components).schemas;
  return schemas ? (schemas as Record<string, unknown>) : null;
}

/** `#/definitions/X` → `#/components/schemas/X`, which is the same schema under 3.1's name. */
function rewriteRefs(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(rewriteRefs);
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    out[key] =
      key === "$ref" && typeof v === "string" && v.startsWith("#/definitions/")
        ? `#/components/schemas/${v.slice("#/definitions/".length)}`
        : rewriteRefs(v);
  }
  return out;
}
