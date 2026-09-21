/**
 * A JSON Schema compiler and validator, written here rather than depended on.
 *
 * Design section 2 budgets `santhosh-tekuri/jsonschema` for the Go data plane; there is no such
 * thing for this one that does not also bring a large transitive tree onto the request path. What
 * design section 5.1 actually needs is narrower than a conformance-complete implementation: the
 * keywords that appear in OpenAPI documents, evaluated against a request body, with a bound on
 * how much work one hostile payload can cause.
 *
 * The subset is enumerated (`ASSERTIONS`) and so is what is refused (`REFUSED`). A schema using a
 * keyword from the second list is **rejected at compile time**, and the operation it belongs to is
 * reported as `unsupported-schema` and left unvalidated rather than quietly half-validated — an
 * unvalidated operation is an unvalidated operation however it got there, and it is listed beside
 * real downgrades in `GET /api/validation/downgrades` (plan `[R1-15]`).
 *
 * Two rules make this safe to run on the request path:
 *
 *  - **Every `pattern` is linted at compile time** with the same linter policy uses (deviation D8),
 *    because JavaScript's regular expressions backtrack where design section 5.6 assumed RE2 and
 *    the value being matched is caller-controlled.
 *  - **Errors are bounded.** A 10,000-element array failing per element would otherwise produce a
 *    10,000-entry response body; collection stops at `maxErrors` (plan `[R3-07]`).
 *
 * Compilation produces plain JSON — the compiled artifact of design section 8.7 — so the data
 * plane never parses OpenAPI or WSDL, only walks a normalized tree.
 */
import { canonicalJson } from "./canonical.ts";
import { lintPattern } from "./policy.ts";

export type JsonSchemaNode = Record<string, unknown>;

/** Keywords this validator implements. Anything here is enforced, not annotated. */
export const ASSERTIONS = [
  "type",
  "enum",
  "const",
  "properties",
  "patternProperties",
  "additionalProperties",
  "propertyNames",
  "required",
  "minProperties",
  "maxProperties",
  "items",
  "prefixItems",
  "minItems",
  "maxItems",
  "uniqueItems",
  "contains",
  "minContains",
  "maxContains",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minLength",
  "maxLength",
  "pattern",
  "allOf",
  "anyOf",
  "oneOf",
  "not",
  "if",
  "then",
  "else",
  "format",
  "$ref",
] as const;

/**
 * Keywords that are refused rather than ignored, because ignoring them would silently drop a
 * constraint the author wrote. `contentEncoding` and `contentMediaType` are *not* here: in
 * 2020-12 they are annotations unless `contentSchema` is present, and we do not decode.
 */
export const REFUSED: Record<string, string> = {
  $dynamicRef: "dynamic references need a runtime scope this validator does not model",
  $dynamicAnchor: "dynamic anchors need a runtime scope this validator does not model",
  unevaluatedProperties: "unevaluated* needs annotation collection across applicators",
  unevaluatedItems: "unevaluated* needs annotation collection across applicators",
  $vocabulary: "custom vocabularies are not supported",
  dependentSchemas: "dependent schemas are not implemented",
  dependentRequired: "dependent required is not implemented",
  contentSchema: "content schemas would require decoding the encoded payload",
};

/** Annotations: carried by real documents, never asserted, safely ignored. */
const ANNOTATIONS = new Set([
  "title",
  "description",
  "default",
  "example",
  "examples",
  "deprecated",
  "readOnly",
  "writeOnly",
  "xml",
  "externalDocs",
  "discriminator",
  "$comment",
  "$id",
  "$schema",
  "$anchor",
  "$defs",
  "definitions",
  "components",
  "contentEncoding",
  "contentMediaType",
  "nullable",
  "collectionFormat",
]);

const SIMPLE_TYPES = new Set(["null", "boolean", "object", "array", "number", "string", "integer"]);

export class SchemaUnsupported extends Error {
  constructor(
    readonly keyword: string,
    readonly where: string,
    reason: string,
  ) {
    super(`${where}: "${keyword}" is not supported — ${reason}`);
    this.name = "SchemaUnsupported";
  }
}

// --------------------------------------------------------------------------- compilation

export interface CompileOptions {
  /** `oas-3.0` turns `nullable` and boolean `exclusiveMinimum` into their 2020-12 equivalents. */
  dialect: "2020-12" | "oas-3.0" | "swagger-2.0";
  /** Where `#/components/schemas/X`, `#/definitions/X` and `#/$defs/X` are looked up. */
  components: Record<string, unknown>;
  maxDepth?: number;
}

/**
 * Compiles one document's schemas into a flat, `$ref`-resolved bundle. Every inline schema is
 * hoisted into `defs` under a synthetic name, so the runtime walks a flat map and a cycle is a
 * name lookup rather than an infinite structure.
 */
export class SchemaCompiler {
  readonly defs: Record<string, JsonSchemaNode> = {};
  private counter = 0;
  private readonly byComponent = new Map<string, string>();
  private readonly maxDepth: number;

  constructor(private readonly options: CompileOptions) {
    this.maxDepth = options.maxDepth ?? 64;
  }

  /** Hoists `schema` into `defs` and returns the def name to reference it by. */
  hoist(schema: unknown, where: string): string {
    const node = this.compile(schema, where, 0);
    const name = `s${++this.counter}`;
    this.defs[name] = node;
    return name;
  }

  private componentDef(pointer: string, where: string): string {
    const existing = this.byComponent.get(pointer);
    if (existing) return existing;

    const name = pointer.replace(/[^A-Za-z0-9]+/g, "_");

    // Resolved before anything is registered. The placeholder below makes a self-referencing
    // schema terminate, but it is also an *accept-anything* schema, and registering it for a
    // pointer that turns out to resolve to nothing left it behind after the throw: one compiler
    // serves every operation of a document, so the second operation to use the same broken pointer
    // found the memo, compiled clean, and was reported `ok` while validating nothing at all. That
    // is worse than the honest `unsupported-schema` the first operation got.
    const target = resolvePointer(this.options.components, pointer);
    if (target === undefined) {
      throw new SchemaUnsupported("$ref", where, `"${pointer}" does not resolve inside the document`);
    }

    // Registered before compiling, so a schema that references itself terminates.
    this.byComponent.set(pointer, name);
    this.defs[name] = {};
    try {
      this.defs[name] = this.compile(target, pointer, 0);
    } catch (err) {
      // Same reasoning one level down: a component whose *body* is unsupported must not leave an
      // accept-anything stub for the next operation that references it.
      this.byComponent.delete(pointer);
      delete this.defs[name];
      throw err;
    }
    return name;
  }

  private compile(raw: unknown, where: string, depth: number): JsonSchemaNode {
    if (depth > this.maxDepth) {
      throw new SchemaUnsupported("$ref", where, `nested deeper than ${this.maxDepth} schemas`);
    }
    // A boolean schema is legal 2020-12: `true` accepts anything, `false` accepts nothing.
    if (raw === true) return {};
    if (raw === false) return { not: {} };
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new SchemaUnsupported("schema", where, "expected an object or a boolean");
    }
    const input = raw as Record<string, unknown>;
    const out: JsonSchemaNode = {};

    if (typeof input.$ref === "string") {
      const ref = input.$ref;
      if (!ref.startsWith("#/")) {
        throw new SchemaUnsupported("$ref", where, `"${ref}" points outside the document`);
      }
      out.$ref = this.componentDef(ref, where);
      // 2020-12 allows keywords beside $ref; OAS 3.0 ignores them. Keep them: an allOf of the two
      // is what both dialects mean when they are used together in practice.
      const siblings = Object.keys(input).filter((k) => k !== "$ref" && !ANNOTATIONS.has(k));
      if (siblings.length === 0) return out;
    }

    for (const [keyword, value] of Object.entries(input)) {
      if (keyword === "$ref") continue;
      if (ANNOTATIONS.has(keyword)) continue;
      if (keyword.startsWith("x-")) continue;
      const reason = REFUSED[keyword];
      if (reason) throw new SchemaUnsupported(keyword, where, reason);
      if (!(ASSERTIONS as readonly string[]).includes(keyword)) continue; // unknown → ignored

      switch (keyword) {
        case "type": {
          const types = Array.isArray(value) ? value : [value];
          for (const t of types) {
            if (typeof t !== "string" || !SIMPLE_TYPES.has(t)) {
              // Swagger 2.0's "file" is not a JSON type and asserts nothing about a JSON body.
              if (t === "file") continue;
              throw new SchemaUnsupported("type", where, `"${String(t)}" is not a JSON type`);
            }
          }
          const kept = types.filter((t) => typeof t === "string" && SIMPLE_TYPES.has(t as string));
          if (kept.length > 0) out.type = kept;
          break;
        }
        case "properties":
        case "patternProperties": {
          if (!isObject(value)) throw new SchemaUnsupported(keyword, where, "expected an object");
          const map: Record<string, JsonSchemaNode> = {};
          for (const [key, sub] of Object.entries(value)) {
            if (keyword === "patternProperties") {
              const errors = lintPattern(key, `${where}.patternProperties`);
              if (errors.length > 0) throw new SchemaUnsupported(keyword, where, errors.join("; "));
            }
            map[key] = this.compile(sub, `${where}.${keyword}.${key}`, depth + 1);
          }
          out[keyword] = map;
          break;
        }
        case "additionalProperties":
        case "propertyNames":
        case "not":
        case "if":
        case "then":
        case "else":
        case "contains":
          out[keyword] = this.compile(value, `${where}.${keyword}`, depth + 1);
          break;
        case "items":
          // Swagger 2.0 and OAS 3.x always use the single-schema form; 2020-12's tuple form is
          // `prefixItems`, and an array here is read as that.
          if (Array.isArray(value)) {
            out.prefixItems = value.map((sub, index) =>
              this.compile(sub, `${where}.items[${index}]`, depth + 1),
            );
          } else {
            out.items = this.compile(value, `${where}.items`, depth + 1);
          }
          break;
        case "prefixItems":
          if (!Array.isArray(value)) throw new SchemaUnsupported(keyword, where, "expected an array");
          out.prefixItems = value.map((sub, index) =>
            this.compile(sub, `${where}.prefixItems[${index}]`, depth + 1),
          );
          break;
        case "allOf":
        case "anyOf":
        case "oneOf":
          if (!Array.isArray(value)) throw new SchemaUnsupported(keyword, where, "expected an array");
          out[keyword] = value.map((sub, index) =>
            this.compile(sub, `${where}.${keyword}[${index}]`, depth + 1),
          );
          break;
        case "pattern": {
          if (typeof value !== "string") throw new SchemaUnsupported(keyword, where, "expected a string");
          const errors = lintPattern(value, `${where}.pattern`);
          if (errors.length > 0) throw new SchemaUnsupported(keyword, where, errors.join("; "));
          out.pattern = value;
          break;
        }
        case "required":
          if (!Array.isArray(value)) throw new SchemaUnsupported(keyword, where, "expected an array");
          out.required = value.filter((v) => typeof v === "string");
          break;
        case "enum":
          if (!Array.isArray(value)) throw new SchemaUnsupported(keyword, where, "expected an array");
          out.enum = value;
          break;
        default:
          out[keyword] = value;
      }
    }

    // --- dialect fixes, applied once, here, so the runtime knows one dialect (design section 4.1)
    if (this.options.dialect !== "2020-12") {
      if (input.nullable === true) {
        const types = (out.type as string[] | undefined) ?? null;
        if (types && !types.includes("null")) out.type = [...types, "null"];
        else if (!types) out.nullableAny = true;
      }
      if (out.exclusiveMinimum === true) {
        out.exclusiveMinimum = out.minimum;
        delete out.minimum;
      } else if (out.exclusiveMinimum === false) {
        delete out.exclusiveMinimum;
      }
      if (out.exclusiveMaximum === true) {
        out.exclusiveMaximum = out.maximum;
        delete out.maximum;
      } else if (out.exclusiveMaximum === false) {
        delete out.exclusiveMaximum;
      }
    }
    return out;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** RFC 6901, restricted to the `#/a/b` form the document's own refs use. */
export function resolvePointer(root: unknown, pointer: string): unknown {
  const parts = pointer.slice(2).split("/");
  let current: unknown = root;
  for (const rawPart of parts) {
    const part = rawPart.replace(/~1/g, "/").replace(/~0/g, "~");
    if (!isObject(current)) return undefined;
    current = current[part];
  }
  return current;
}

// --------------------------------------------------------------------------- validation

export interface ValidationIssue {
  /** RFC 6901 pointer into the instance. */
  path: string;
  rule: string;
  message: string;
}

export interface ValidateOptions {
  maxErrors?: number;
  /** Guard for `pattern`: the linter bounds the expression, this bounds the subject. */
  maxPatternInputBytes?: number;
  maxDepth?: number;
}

interface Ctx {
  defs: Record<string, JsonSchemaNode>;
  issues: ValidationIssue[];
  maxErrors: number;
  maxPatternInputBytes: number;
  maxDepth: number;
  truncated: boolean;
}

export interface ValidationResult {
  ok: boolean;
  issues: ValidationIssue[];
  /** True when collection stopped at `maxErrors`; the body says so rather than implying totality. */
  truncated: boolean;
}

const patternCache = new Map<string, RegExp>();
function compiledPattern(pattern: string): RegExp {
  let regex = patternCache.get(pattern);
  if (!regex) {
    regex = new RegExp(pattern, "u");
    patternCache.set(pattern, regex);
  }
  return regex;
}

export function validate(
  value: unknown,
  schema: JsonSchemaNode,
  defs: Record<string, JsonSchemaNode>,
  options: ValidateOptions = {},
): ValidationResult {
  const ctx: Ctx = {
    defs,
    issues: [],
    maxErrors: options.maxErrors ?? 20,
    maxPatternInputBytes: options.maxPatternInputBytes ?? 4096,
    maxDepth: options.maxDepth ?? 64,
    truncated: false,
  };
  check(value, schema, "", ctx, 0);
  return { ok: ctx.issues.length === 0, issues: ctx.issues, truncated: ctx.truncated };
}

function add(ctx: Ctx, path: string, rule: string, message: string): void {
  if (ctx.issues.length >= ctx.maxErrors) {
    ctx.truncated = true;
    return;
  }
  ctx.issues.push({ path: path === "" ? "/" : path, rule, message });
}

/**
 * True once the error budget is spent. Reaching it also marks the result truncated: every caller
 * uses this to stop scanning, so hitting it means there may be failures nobody looked for, and a
 * response that listed twenty errors without saying so would read as a complete list.
 */
function full(ctx: Ctx): boolean {
  if (ctx.issues.length < ctx.maxErrors) return false;
  ctx.truncated = true;
  return true;
}

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  const t = typeof value;
  if (t === "number") return Number.isInteger(value as number) ? "integer" : "number";
  return t;
}

function matchesType(value: unknown, type: string): boolean {
  switch (type) {
    case "null":
      return value === null;
    case "boolean":
      return typeof value === "boolean";
    case "string":
      return typeof value === "string";
    case "object":
      return isObject(value);
    case "array":
      return Array.isArray(value);
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value);
    default:
      return true;
  }
}

/** Deep equality by canonical form: it is what `enum`, `const` and `uniqueItems` all need. */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (typeof a !== "object") return false;
  return canonicalJson(a) === canonicalJson(b);
}

function check(value: unknown, schema: JsonSchemaNode, path: string, ctx: Ctx, depth: number): void {
  if (full(ctx)) return;
  if (depth > ctx.maxDepth) {
    add(ctx, path, "depth", `schema evaluation nested deeper than ${ctx.maxDepth}`);
    return;
  }

  if (typeof schema.$ref === "string") {
    const target = ctx.defs[schema.$ref];
    if (!target) {
      add(ctx, path, "$ref", `the compiled bundle has no definition "${schema.$ref}"`);
      return;
    }
    check(value, target, path, ctx, depth + 1);
    // 2020-12 keywords beside $ref still apply; OAS 3.0 documents rarely have them.
    if (Object.keys(schema).length === 1) return;
  }

  // `nullable: true` on a schema with no `type` (OAS 3.0) asserts nothing on its own.
  if (schema.nullableAny === true && value === null) return;

  const types = schema.type as string[] | undefined;
  if (types && !types.some((t) => matchesType(value, t))) {
    add(
      ctx,
      path,
      "type",
      `expected ${types.join(" or ")}, got ${typeOf(value)}`,
    );
    return; // Every other keyword is about a value of the right type; reporting them would be noise.
  }

  if (schema.enum !== undefined) {
    const allowed = schema.enum as unknown[];
    if (!allowed.some((candidate) => sameValue(candidate, value))) {
      add(ctx, path, "enum", `expected one of ${allowed.map((v) => JSON.stringify(v)).join(", ")}`);
    }
  }
  if (schema.const !== undefined && !sameValue(schema.const, value)) {
    add(ctx, path, "const", `expected ${JSON.stringify(schema.const)}`);
  }

  if (typeof value === "string") checkString(value, schema, path, ctx);
  else if (typeof value === "number") checkNumber(value, schema, path, ctx);
  else if (Array.isArray(value)) checkArray(value, schema, path, ctx, depth);
  else if (isObject(value)) checkObject(value, schema, path, ctx, depth);

  checkApplicators(value, schema, path, ctx, depth);
}

function checkString(value: string, schema: JsonSchemaNode, path: string, ctx: Ctx): void {
  // Code points, not UTF-16 units: "🙂".length is 2 and its JSON Schema length is 1.
  const length = [...value].length;
  if (typeof schema.minLength === "number" && length < schema.minLength) {
    add(ctx, path, "minLength", `shorter than ${schema.minLength} characters`);
  }
  if (typeof schema.maxLength === "number" && length > schema.maxLength) {
    add(ctx, path, "maxLength", `longer than ${schema.maxLength} characters`);
  }
  if (typeof schema.pattern === "string") {
    if (Buffer.byteLength(value, "utf8") > ctx.maxPatternInputBytes) {
      add(ctx, path, "pattern", `longer than ${ctx.maxPatternInputBytes} bytes, so it was not matched`);
    } else if (!compiledPattern(schema.pattern).test(value)) {
      add(ctx, path, "pattern", `does not match ${schema.pattern}`);
    }
  }
  if (typeof schema.format === "string") {
    const message = formatError(schema.format, value);
    if (message) add(ctx, path, "format", message);
  }
}

function checkNumber(value: number, schema: JsonSchemaNode, path: string, ctx: Ctx): void {
  if (typeof schema.minimum === "number" && value < schema.minimum) {
    add(ctx, path, "minimum", `less than ${schema.minimum}`);
  }
  if (typeof schema.maximum === "number" && value > schema.maximum) {
    add(ctx, path, "maximum", `greater than ${schema.maximum}`);
  }
  if (typeof schema.exclusiveMinimum === "number" && value <= schema.exclusiveMinimum) {
    add(ctx, path, "exclusiveMinimum", `not greater than ${schema.exclusiveMinimum}`);
  }
  if (typeof schema.exclusiveMaximum === "number" && value >= schema.exclusiveMaximum) {
    add(ctx, path, "exclusiveMaximum", `not less than ${schema.exclusiveMaximum}`);
  }
  if (typeof schema.multipleOf === "number" && schema.multipleOf > 0) {
    const quotient = value / schema.multipleOf;
    if (Math.abs(quotient - Math.round(quotient)) > 1e-9) {
      add(ctx, path, "multipleOf", `not a multiple of ${schema.multipleOf}`);
    }
  }
  if (typeof schema.format === "string") {
    const message = formatError(schema.format, value);
    if (message) add(ctx, path, "format", message);
  }
}

function checkArray(
  value: unknown[],
  schema: JsonSchemaNode,
  path: string,
  ctx: Ctx,
  depth: number,
): void {
  if (typeof schema.minItems === "number" && value.length < schema.minItems) {
    add(ctx, path, "minItems", `fewer than ${schema.minItems} items`);
  }
  if (typeof schema.maxItems === "number" && value.length > schema.maxItems) {
    add(ctx, path, "maxItems", `more than ${schema.maxItems} items`);
  }
  if (schema.uniqueItems === true) {
    const seen = new Set<string>();
    for (let i = 0; i < value.length; i++) {
      const key = canonicalJson(value[i]);
      if (seen.has(key)) {
        add(ctx, `${path}/${i}`, "uniqueItems", "duplicates an earlier item");
        break;
      }
      seen.add(key);
    }
  }

  const prefix = schema.prefixItems as JsonSchemaNode[] | undefined;
  if (prefix) {
    for (let i = 0; i < Math.min(prefix.length, value.length); i++) {
      check(value[i], prefix[i]!, `${path}/${i}`, ctx, depth + 1);
      if (full(ctx)) return;
    }
  }
  const items = schema.items as JsonSchemaNode | undefined;
  if (items) {
    for (let i = prefix?.length ?? 0; i < value.length; i++) {
      check(value[i], items, `${path}/${i}`, ctx, depth + 1);
      if (full(ctx)) return;
    }
  }

  const contains = schema.contains as JsonSchemaNode | undefined;
  if (contains) {
    let matches = 0;
    for (const item of value) {
      const probe: Ctx = { ...ctx, issues: [], truncated: false, maxErrors: 1 };
      check(item, contains, path, probe, depth + 1);
      if (probe.issues.length === 0) matches++;
    }
    const min = typeof schema.minContains === "number" ? schema.minContains : 1;
    const max = typeof schema.maxContains === "number" ? schema.maxContains : Infinity;
    if (matches < min) add(ctx, path, "contains", `fewer than ${min} items match "contains"`);
    if (matches > max) add(ctx, path, "maxContains", `more than ${max} items match "contains"`);
  }
}

function checkObject(
  value: Record<string, unknown>,
  schema: JsonSchemaNode,
  path: string,
  ctx: Ctx,
  depth: number,
): void {
  const keys = Object.keys(value);
  if (typeof schema.minProperties === "number" && keys.length < schema.minProperties) {
    add(ctx, path, "minProperties", `fewer than ${schema.minProperties} properties`);
  }
  if (typeof schema.maxProperties === "number" && keys.length > schema.maxProperties) {
    add(ctx, path, "maxProperties", `more than ${schema.maxProperties} properties`);
  }
  for (const name of (schema.required as string[] | undefined) ?? []) {
    if (!Object.prototype.hasOwnProperty.call(value, name)) {
      add(ctx, `${path}/${pointerSegment(name)}`, "required", `required property "${name}" is missing`);
      if (full(ctx)) return;
    }
  }

  const properties = schema.properties as Record<string, JsonSchemaNode> | undefined;
  const patternProperties = schema.patternProperties as Record<string, JsonSchemaNode> | undefined;
  const additional = schema.additionalProperties as JsonSchemaNode | undefined;
  const propertyNames = schema.propertyNames as JsonSchemaNode | undefined;

  for (const key of keys) {
    const child = `${path}/${pointerSegment(key)}`;
    if (propertyNames) check(key, propertyNames, child, ctx, depth + 1);

    let matched = false;
    if (properties && Object.prototype.hasOwnProperty.call(properties, key)) {
      matched = true;
      check(value[key], properties[key]!, child, ctx, depth + 1);
    }
    if (patternProperties) {
      for (const [pattern, sub] of Object.entries(patternProperties)) {
        if (compiledPattern(pattern).test(key)) {
          matched = true;
          check(value[key], sub, child, ctx, depth + 1);
        }
      }
    }
    if (!matched && additional) {
      // `additionalProperties: false` compiles to `{ not: {} }`, which fails everything.
      check(value[key], additional, child, ctx, depth + 1);
    }
    if (full(ctx)) return;
  }
}

function checkApplicators(
  value: unknown,
  schema: JsonSchemaNode,
  path: string,
  ctx: Ctx,
  depth: number,
): void {
  const allOf = schema.allOf as JsonSchemaNode[] | undefined;
  if (allOf) {
    for (const sub of allOf) {
      check(value, sub, path, ctx, depth + 1);
      if (full(ctx)) return;
    }
  }

  const anyOf = schema.anyOf as JsonSchemaNode[] | undefined;
  if (anyOf) {
    const failures: ValidationIssue[] = [];
    let ok = false;
    for (const sub of anyOf) {
      const probe: Ctx = { ...ctx, issues: [], truncated: false, maxErrors: 3 };
      check(value, sub, path, probe, depth + 1);
      if (probe.issues.length === 0) {
        ok = true;
        break;
      }
      failures.push(...probe.issues);
    }
    if (!ok) {
      add(
        ctx,
        path,
        "anyOf",
        `matched none of the ${anyOf.length} alternatives (${failures
          .slice(0, 3)
          .map((f) => `${f.path}: ${f.message}`)
          .join("; ")})`,
      );
    }
  }

  const oneOf = schema.oneOf as JsonSchemaNode[] | undefined;
  if (oneOf) {
    let matches = 0;
    const failures: ValidationIssue[] = [];
    for (const sub of oneOf) {
      const probe: Ctx = { ...ctx, issues: [], truncated: false, maxErrors: 3 };
      check(value, sub, path, probe, depth + 1);
      if (probe.issues.length === 0) matches++;
      else failures.push(...probe.issues);
    }
    if (matches !== 1) {
      add(
        ctx,
        path,
        "oneOf",
        matches === 0
          ? `matched none of the ${oneOf.length} alternatives (${failures
              .slice(0, 3)
              .map((f) => `${f.path}: ${f.message}`)
              .join("; ")})`
          : `matched ${matches} of the ${oneOf.length} alternatives, expected exactly one`,
      );
    }
  }

  const not = schema.not as JsonSchemaNode | undefined;
  if (not) {
    const probe: Ctx = { ...ctx, issues: [], truncated: false, maxErrors: 1 };
    check(value, not, path, probe, depth + 1);
    if (probe.issues.length === 0) add(ctx, path, "not", "matched a schema it must not match");
  }

  const ifSchema = schema.if as JsonSchemaNode | undefined;
  if (ifSchema) {
    const probe: Ctx = { ...ctx, issues: [], truncated: false, maxErrors: 1 };
    check(value, ifSchema, path, probe, depth + 1);
    const branch = probe.issues.length === 0 ? schema.then : schema.else;
    if (branch) check(value, branch as JsonSchemaNode, path, ctx, depth + 1);
  }
}

function pointerSegment(key: string): string {
  return key.replace(/~/g, "~0").replace(/\//g, "~1");
}

// --------------------------------------------------------------------------- formats

const RE_DATE = /^\d{4}-\d{2}-\d{2}$/;
const RE_TIME = /^\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})?$/;
const RE_DATE_TIME = /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/;
const RE_DURATION = /^P(?!$)(\d+Y)?(\d+M)?(\d+W)?(\d+D)?(T(?!$)(\d+H)?(\d+M)?(\d+(\.\d+)?S)?)?$/;
const RE_UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const RE_EMAIL = /^[^@\s]{1,64}@[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
const RE_HOSTNAME = /^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;
const RE_IPV4 = /^((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;
const RE_BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** `null` when the value satisfies the format, a message when it does not. */
export function formatError(format: string, value: unknown): string | null {
  if (typeof value === "number") {
    if (format === "int32") {
      return Number.isInteger(value) && value >= -2147483648 && value <= 2147483647
        ? null
        : "outside the range of a 32-bit signed integer";
    }
    if (format === "int64") {
      return Number.isInteger(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER
        ? null
        : "outside the range this validator can represent exactly (2^53)";
    }
    return null;
  }
  if (typeof value !== "string") return null;

  switch (format) {
    case "date":
      return RE_DATE.test(value) && isRealDate(value) ? null : "is not an RFC 3339 date";
    case "date-time":
      return RE_DATE_TIME.test(value) && isRealDate(value.slice(0, 10))
        ? null
        : "is not an RFC 3339 date-time";
    case "time":
      return RE_TIME.test(value) ? null : "is not an RFC 3339 time";
    case "duration":
      return RE_DURATION.test(value) ? null : "is not an ISO 8601 duration";
    case "uuid":
      return RE_UUID.test(value) ? null : "is not a UUID";
    case "email":
    case "idn-email":
      return RE_EMAIL.test(value) ? null : "is not an email address";
    case "hostname":
      return RE_HOSTNAME.test(value) && value.length <= 253 ? null : "is not a hostname";
    case "ipv4":
      return RE_IPV4.test(value) ? null : "is not an IPv4 address";
    case "ipv6":
      return isIpv6(value) ? null : "is not an IPv6 address";
    case "uri":
    case "uri-reference":
    case "iri":
      try {
        // eslint-disable-next-line no-new
        new URL(value, format === "uri" ? undefined : "http://example.invalid");
        return null;
      } catch {
        return "is not a URI";
      }
    case "byte":
      return value.length % 4 === 0 && RE_BASE64.test(value) ? null : "is not base64";
    default:
      // An unknown format is an annotation, per the specification. Nothing is asserted and
      // nothing is silently dropped, because no constraint was expressed.
      return null;
  }
}

function isRealDate(value: string): boolean {
  const [y, m, d] = value.split("-").map(Number) as [number, number, number];
  if (m < 1 || m > 12 || d < 1) return false;
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return d <= days;
}

function isIpv6(value: string): boolean {
  if (!/^[0-9a-fA-F:.]+$/.test(value)) return false;
  const doubleColons = value.split("::").length - 1;
  if (doubleColons > 1) return false;
  const [head, tail = ""] = value.split("::");
  const parts = [...head!.split(":"), ...tail.split(":")].filter((p) => p !== "");
  if (parts.length === 0 && doubleColons === 0) return false;
  const groups = doubleColons === 1 ? parts.length : parts.length;
  if (doubleColons === 0 && groups !== 8 && !parts.some((p) => p.includes("."))) return false;
  for (const part of parts) {
    if (part.includes(".")) {
      if (!RE_IPV4.test(part)) return false;
      continue;
    }
    if (!/^[0-9a-fA-F]{1,4}$/.test(part)) return false;
  }
  return true;
}

// --------------------------------------------------------------------------- string coercion

/**
 * Path, query and header parameters arrive as strings, and a schema that says `type: integer`
 * describes the value the caller *meant*, not the characters that carried it. Without coercion
 * every declared non-string parameter would fail, which would make parameter validation useless
 * rather than strict.
 *
 * Coercion is by the schema's declared type and nothing else — never by guessing at the content —
 * and a value that does not convert is left as the string, so the type check reports it.
 */
export function coerceParameter(raw: string, schema: JsonSchemaNode | undefined): unknown {
  if (!schema) return raw;
  const types = (schema.type as string[] | undefined) ?? [];
  if (types.length === 0) return raw;

  const wants = (t: string) => types.includes(t);
  if (wants("string")) return raw;

  if (wants("integer") || wants("number")) {
    if (raw.trim() === "") return raw;
    const value = Number(raw);
    if (!Number.isFinite(value)) return raw;
    if (wants("integer") && !Number.isInteger(value)) return value; // reported by `type`
    return value;
  }
  if (wants("boolean")) {
    if (raw === "true") return true;
    if (raw === "false") return false;
    return raw;
  }
  if (wants("array")) {
    // OpenAPI's default styles for query (`form`) and path/header (`simple`) both split on commas.
    if (raw === "") return [];
    const items = schema.items as JsonSchemaNode | undefined;
    return raw.split(",").map((part) => coerceParameter(part, items));
  }
  if (wants("null") && raw === "") return null;
  return raw;
}
