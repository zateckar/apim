import { resolvePointer } from "./jsonschema.ts";
import type { ApiModel, ApiOperation, ApiParameter } from "./types.ts";

/**
 * The structural diff of two revisions (G3, plan §7.2).
 *
 * Over the **normalized model**, never a text diff of the upload: design section 4.1 makes the
 * model the contract, so a document reformatted, reordered or converted from Swagger 2.0 to
 * OpenAPI 3.1 has to diff as "no change" — and a renamed field has to diff as a change even if the
 * file's line count is identical.
 *
 * **Breaking is an enumerated list of rules, not a feeling.** Every flagged item carries the rule
 * that fired and the UI shows it, because a classifier nobody can interrogate stops being
 * trusted — and the failure mode of an over-eager one is that people stop reading it.
 *
 * The function is pure, so the diff needs no storage: it is recomputed from two models on request.
 */

/** Every way a revision can break a caller. The list is closed; adding to it is a reviewed change. */
export type BreakingRule =
  /** The operation is gone. For an MCP tool and an A2A skill this has its own name, below. */
  | "operation-removed"
  | "mcp-tool-removed"
  | "a2a-skill-removed"
  /** The same operation id now answers a different method or path, so old callers miss it. */
  | "method-changed"
  | "path-changed"
  /** A request the caller was allowed to send is now refused. */
  | "required-added"
  | "type-changed"
  | "enum-value-removed"
  | "path-parameter-removed"
  /** A response the caller was allowed to rely on is no longer promised. */
  | "response-status-removed"
  | "response-property-removed"
  | "response-property-retyped"
  /** SOAP: the body element *is* the operation's identity (design section 5.1). */
  | "soap-element-changed";

export type ChangeKind = "added" | "removed" | "changed";

export type DetailKind =
  | "method"
  | "path"
  | "parameter"
  | "request-content-type"
  | "request-schema"
  | "response-status"
  | "response-schema"
  | "soap-element"
  | "selector";

export interface DiffDetail {
  kind: DetailKind;
  /** Where: a parameter name, a status code, or a JSON pointer into the schema. */
  path: string;
  was?: string;
  now?: string;
  breaking: boolean;
  rule?: BreakingRule;
}

export interface OperationDiff {
  operationId: string;
  change: ChangeKind;
  breaking: boolean;
  rule?: BreakingRule;
  method?: string;
  path?: string;
  details?: DiffDetail[];
  /**
   * The schemas were larger than the bound, so this operation's schema comparison was abandoned.
   * Said out loud rather than reported as "no change", which would be a lie of the worst kind here.
   */
  tooLargeToDiff?: boolean;
}

export interface SkillDiff {
  id: string;
  name?: string;
  change: ChangeKind;
  breaking: boolean;
  rule?: BreakingRule;
}

export interface MetadataDiff {
  field: string;
  was: string | null;
  now: string | null;
}

export interface ModelDiff {
  summary: { added: number; removed: number; changed: number; breaking: number };
  operations: OperationDiff[];
  /** A2A only: skills are advertised on the card and are not operations (plan §7.2). */
  skills?: SkillDiff[];
  metadata: MetadataDiff[];
}

/** Design section 4.1's bounds, so a recursive or generated schema cannot hang a request. */
const MAX_SCHEMA_DEPTH = 32;
const MAX_SCHEMA_NODES = 2000;

export function diffModels(from: ApiModel, to: ApiModel): ModelDiff {
  const operations: OperationDiff[] = [];
  const fromOps = byOperationId(from.operations ?? []);
  const toOps = byOperationId(to.operations ?? []);

  for (const [operationId, before] of fromOps) {
    const after = toOps.get(operationId);
    if (!after) {
      const rule = removalRule(operationId, from);
      operations.push({
        operationId,
        change: "removed",
        breaking: true,
        rule,
        method: before.method,
        path: before.path,
      });
      continue;
    }
    const diff = diffOperation(operationId, before, after, from, to);
    if (diff) operations.push(diff);
  }
  for (const [operationId, after] of toOps) {
    if (fromOps.has(operationId)) continue;
    // A new operation breaks nobody: no caller was using it a moment ago.
    operations.push({
      operationId,
      change: "added",
      breaking: false,
      method: after.method,
      path: after.path,
    });
  }

  operations.sort(
    (a, b) =>
      Number(b.breaking) - Number(a.breaking) || a.operationId.localeCompare(b.operationId),
  );

  const skills = diffSkills(from, to);
  const summary = {
    added: operations.filter((op) => op.change === "added").length,
    removed: operations.filter((op) => op.change === "removed").length,
    changed: operations.filter((op) => op.change === "changed").length,
    breaking:
      operations.filter((op) => op.breaking).length + (skills ?? []).filter((s) => s.breaking).length,
  };

  return {
    summary,
    operations,
    ...(skills ? { skills } : {}),
    metadata: diffMetadata(from, to),
  };
}

function byOperationId(operations: ApiOperation[]): Map<string, ApiOperation> {
  const out = new Map<string, ApiOperation>();
  for (const operation of operations) out.set(operation.operationId, operation);
  return out;
}

function removalRule(operationId: string, from: ApiModel): BreakingRule {
  if (from.mcp && operationId.startsWith("tools/call:")) return "mcp-tool-removed";
  return "operation-removed";
}

// --------------------------------------------------------------------------- one operation

function diffOperation(
  operationId: string,
  before: ApiOperation,
  after: ApiOperation,
  fromModel: ApiModel,
  toModel: ApiModel,
): OperationDiff | null {
  const details: DiffDetail[] = [];
  const budget = { nodes: MAX_SCHEMA_NODES, exhausted: false };

  if (before.method !== after.method) {
    details.push({
      kind: "method",
      path: operationId,
      was: before.method,
      now: after.method,
      breaking: true,
      rule: "method-changed",
    });
  }
  if (before.path !== after.path) {
    details.push({
      kind: "path",
      path: operationId,
      was: before.path,
      now: after.path,
      breaking: true,
      rule: "path-changed",
    });
  }
  if ((before.selector ?? null) !== (after.selector ?? null)) {
    details.push({
      kind: "selector",
      path: operationId,
      was: before.selector ?? "—",
      now: after.selector ?? "—",
      breaking: true,
      rule: "path-changed",
    });
  }
  // SOAP: the body element is how the gateway recognises the operation at all, so a change here
  // is a different operation wearing the same name (design section 5.1).
  for (const field of ["inputElement", "outputElement", "soapAction"] as const) {
    const was = before[field] ?? null;
    const now = after[field] ?? null;
    if (was === now) continue;
    details.push({
      kind: "soap-element",
      path: field,
      was: was ?? "—",
      now: now ?? "—",
      breaking: field !== "soapAction" || was !== null,
      rule: "soap-element-changed",
    });
  }

  details.push(...diffParameters(before.parameters ?? [], after.parameters ?? []));
  details.push(...diffRequestBody(before, after, fromModel, toModel, budget));
  details.push(...diffResponses(before, after, fromModel, toModel, budget));

  if (details.length === 0 && !budget.exhausted) return null;
  return {
    operationId,
    change: "changed",
    breaking: details.some((detail) => detail.breaking),
    ...(firstRule(details) ? { rule: firstRule(details) } : {}),
    method: after.method,
    path: after.path,
    details,
    ...(budget.exhausted ? { tooLargeToDiff: true } : {}),
  };
}

function firstRule(details: DiffDetail[]): BreakingRule | undefined {
  return details.find((detail) => detail.breaking)?.rule;
}

function diffParameters(before: ApiParameter[], after: ApiParameter[]): DiffDetail[] {
  const details: DiffDetail[] = [];
  const key = (parameter: ApiParameter) => `${parameter.in}:${parameter.name}`;
  const beforeByKey = new Map(before.map((parameter) => [key(parameter), parameter]));
  const afterByKey = new Map(after.map((parameter) => [key(parameter), parameter]));

  for (const [id, was] of beforeByKey) {
    const now = afterByKey.get(id);
    if (!now) {
      // A removed query or header parameter is ignored by the new revision, which old callers
      // survive. A removed *path* parameter changes the URL, which they do not.
      details.push({
        kind: "parameter",
        path: id,
        was: describeParameter(was),
        breaking: was.in === "path",
        ...(was.in === "path" ? { rule: "path-parameter-removed" as BreakingRule } : {}),
      });
      continue;
    }
    if (!was.required && now.required) {
      details.push({
        kind: "parameter",
        path: id,
        was: "optional",
        now: "required",
        breaking: true,
        rule: "required-added",
      });
    }
    const wasType = typeOf(was.schema);
    const nowType = typeOf(now.schema);
    if (wasType !== nowType) {
      details.push({
        kind: "parameter",
        path: id,
        was: wasType ?? "—",
        now: nowType ?? "—",
        breaking: true,
        rule: "type-changed",
      });
    }
    const lost = enumLoss(was.schema, now.schema);
    if (lost.length > 0) {
      details.push({
        kind: "parameter",
        path: id,
        was: lost.join(", "),
        now: "no longer accepted",
        breaking: true,
        rule: "enum-value-removed",
      });
    }
  }
  for (const [id, now] of afterByKey) {
    if (beforeByKey.has(id)) continue;
    details.push({
      kind: "parameter",
      path: id,
      now: describeParameter(now),
      // A new required parameter is the classic silent break.
      breaking: now.required,
      ...(now.required ? { rule: "required-added" as BreakingRule } : {}),
    });
  }
  return details;
}

function describeParameter(parameter: ApiParameter): string {
  return `${parameter.required ? "required" : "optional"} ${typeOf(parameter.schema) ?? "untyped"}`;
}

function diffRequestBody(
  before: ApiOperation,
  after: ApiOperation,
  fromModel: ApiModel,
  toModel: ApiModel,
  budget: Budget,
): DiffDetail[] {
  const details: DiffDetail[] = [];
  const wasBody = before.requestBody;
  const nowBody = after.requestBody;
  if (!wasBody && !nowBody) return details;

  if (wasBody && !nowBody) {
    details.push({ kind: "request-schema", path: "/", was: "a body", now: "no body", breaking: false });
    return details;
  }
  if (!wasBody && nowBody) {
    details.push({
      kind: "request-schema",
      path: "/",
      was: "no body",
      now: nowBody.required ? "a required body" : "an optional body",
      breaking: nowBody.required,
      ...(nowBody.required ? { rule: "required-added" as BreakingRule } : {}),
    });
    return details;
  }
  if (!wasBody!.required && nowBody!.required) {
    details.push({
      kind: "request-schema",
      path: "/",
      was: "optional",
      now: "required",
      breaking: true,
      rule: "required-added",
    });
  }

  const wasContent = wasBody!.content ?? {};
  const nowContent = nowBody!.content ?? {};
  for (const mediaType of Object.keys(wasContent)) {
    if (mediaType in nowContent) continue;
    // The caller's content type is no longer accepted, which is a 415 where there used to be a 200.
    details.push({
      kind: "request-content-type",
      path: mediaType,
      was: "accepted",
      now: "not accepted",
      breaking: true,
      rule: "type-changed",
    });
  }
  for (const mediaType of Object.keys(nowContent)) {
    if (mediaType in wasContent) continue;
    details.push({ kind: "request-content-type", path: mediaType, now: "accepted", breaking: false });
  }
  for (const [mediaType, wasSchema] of Object.entries(wasContent)) {
    const nowSchema = nowContent[mediaType];
    if (nowSchema === undefined) continue;
    details.push(
      ...compareSchemas(wasSchema, nowSchema, {
        side: "request",
        kind: "request-schema",
        pointer: mediaType === "application/json" ? "" : `[${mediaType}]`,
        fromComponents: fromModel.components ?? {},
        toComponents: toModel.components ?? {},
        budget,
        depth: 0,
        seen: new Set<string>(),
      }),
    );
  }
  return details;
}

function diffResponses(
  before: ApiOperation,
  after: ApiOperation,
  fromModel: ApiModel,
  toModel: ApiModel,
  budget: Budget,
): DiffDetail[] {
  const details: DiffDetail[] = [];
  const wasResponses = before.responses ?? {};
  const nowResponses = after.responses ?? {};

  for (const status of Object.keys(wasResponses)) {
    if (status in nowResponses) continue;
    details.push({
      kind: "response-status",
      path: status,
      was: "documented",
      now: "gone",
      breaking: true,
      rule: "response-status-removed",
    });
  }
  for (const status of Object.keys(nowResponses)) {
    if (status in wasResponses) continue;
    details.push({ kind: "response-status", path: status, now: "documented", breaking: false });
  }
  for (const [status, wasResponse] of Object.entries(wasResponses)) {
    const nowResponse = nowResponses[status];
    if (!nowResponse) continue;
    const wasContent = wasResponse.content ?? {};
    const nowContent = nowResponse.content ?? {};
    for (const [mediaType, wasSchema] of Object.entries(wasContent)) {
      const nowSchema = nowContent[mediaType];
      if (nowSchema === undefined) {
        details.push({
          kind: "response-schema",
          path: `${status} ${mediaType}`,
          was: "documented",
          now: "gone",
          breaking: true,
          rule: "response-property-removed",
        });
        continue;
      }
      details.push(
        ...compareSchemas(wasSchema, nowSchema, {
          side: "response",
          kind: "response-schema",
          pointer: `${status}`,
          fromComponents: fromModel.components ?? {},
          toComponents: toModel.components ?? {},
          budget,
          depth: 0,
          seen: new Set<string>(),
        }),
      );
    }
  }
  return details;
}

// --------------------------------------------------------------------------- schemas

interface Budget {
  nodes: number;
  exhausted: boolean;
}

interface CompareContext {
  side: "request" | "response";
  kind: DetailKind;
  pointer: string;
  fromComponents: Record<string, unknown>;
  toComponents: Record<string, unknown>;
  budget: Budget;
  depth: number;
  seen: Set<string>;
}

/**
 * Structural comparison over the resolved shape. `$ref` is followed on both sides, with the pair
 * of pointers remembered so a recursive schema terminates — and the node budget is shared across
 * the whole diff, so a document with a thousand large schemas cannot turn one request into a
 * minute of CPU.
 */
function compareSchemas(rawWas: unknown, rawNow: unknown, ctx: CompareContext): DiffDetail[] {
  if (ctx.budget.nodes <= 0 || ctx.depth > MAX_SCHEMA_DEPTH) {
    ctx.budget.exhausted = true;
    return [];
  }
  ctx.budget.nodes -= 1;

  const wasRef = refOf(rawWas);
  const nowRef = refOf(rawNow);
  if (wasRef || nowRef) {
    // The pair of pointers, deliberately **without** the position they were reached from: two
    // schemas compared once cannot compare differently the second time, and a recursive type
    // reached at a new path every time is how a cycle would otherwise run to the depth bound and
    // report itself as too large to diff. The consequence is that a difference inside a recursive
    // type is reported at the first path it was reached by, which is where a reader wants it.
    const key = `${wasRef ?? "-"}|${nowRef ?? "-"}`;
    if (ctx.seen.has(key)) return [];
    ctx.seen.add(key);
  }
  const was = deref(rawWas, ctx.fromComponents);
  const now = deref(rawNow, ctx.toComponents);
  if (!isObject(was) || !isObject(now)) return [];

  const details: DiffDetail[] = [];
  const at = ctx.pointer === "" ? "/" : ctx.pointer;

  const wasType = typeOf(was);
  const nowType = typeOf(now);
  if (wasType !== nowType && (wasType || nowType)) {
    details.push({
      kind: ctx.kind,
      path: at,
      was: wasType ?? "untyped",
      now: nowType ?? "untyped",
      breaking: true,
      rule: ctx.side === "request" ? "type-changed" : "response-property-retyped",
    });
    // A different type makes a property-by-property comparison meaningless.
    return details;
  }

  if (ctx.side === "request") {
    const lost = enumLoss(was, now);
    if (lost.length > 0) {
      details.push({
        kind: ctx.kind,
        path: at,
        was: lost.join(", "),
        now: "no longer accepted",
        breaking: true,
        rule: "enum-value-removed",
      });
    }
  }

  const wasRequired = new Set(stringArray(was.required));
  const nowRequired = new Set(stringArray(now.required));
  const wasProperties = isObject(was.properties) ? was.properties : {};
  const nowProperties = isObject(now.properties) ? now.properties : {};

  for (const name of Object.keys(nowProperties)) {
    const pointer = `${ctx.pointer}/properties/${name}`;
    if (!(name in wasProperties)) {
      const required = nowRequired.has(name);
      details.push({
        kind: ctx.kind,
        path: pointer,
        now: required ? "required" : "optional",
        breaking: ctx.side === "request" && required,
        ...(ctx.side === "request" && required ? { rule: "required-added" as BreakingRule } : {}),
      });
      continue;
    }
    if (ctx.side === "request" && !wasRequired.has(name) && nowRequired.has(name)) {
      details.push({
        kind: ctx.kind,
        path: pointer,
        was: "optional",
        now: "required",
        breaking: true,
        rule: "required-added",
      });
    }
    details.push(
      ...compareSchemas(wasProperties[name], nowProperties[name], {
        ...ctx,
        pointer,
        depth: ctx.depth + 1,
      }),
    );
  }
  for (const name of Object.keys(wasProperties)) {
    if (name in nowProperties) continue;
    // A request property nobody reads any more is ignored; a response property nobody sends any
    // more is a field the caller was parsing.
    details.push({
      kind: ctx.kind,
      path: `${ctx.pointer}/properties/${name}`,
      was: wasRequired.has(name) ? "required" : "optional",
      now: "gone",
      breaking: ctx.side === "response",
      ...(ctx.side === "response" ? { rule: "response-property-removed" as BreakingRule } : {}),
    });
  }

  if (was.items !== undefined || now.items !== undefined) {
    details.push(
      ...compareSchemas(was.items, now.items, {
        ...ctx,
        pointer: `${ctx.pointer}/items`,
        depth: ctx.depth + 1,
      }),
    );
  }
  return details;
}

function refOf(schema: unknown): string | null {
  return isObject(schema) && typeof schema.$ref === "string" ? schema.$ref : null;
}

/** One hop is enough: a `$ref` to a `$ref` is resolved by the next recursion. */
function deref(schema: unknown, components: Record<string, unknown>): unknown {
  const ref = refOf(schema);
  if (!ref || !ref.startsWith("#/")) return schema;
  const target = resolvePointer(components, ref);
  return target === undefined ? schema : target;
}

function typeOf(schema: unknown): string | null {
  if (!isObject(schema)) return null;
  const type = schema.type;
  if (typeof type === "string") return type;
  if (Array.isArray(type)) return [...type].map(String).sort().join("|");
  return null;
}

/** Values the old revision accepted and the new one does not. */
function enumLoss(was: unknown, now: unknown): string[] {
  if (!isObject(was) || !isObject(now)) return [];
  if (!Array.isArray(was.enum)) return [];
  if (!Array.isArray(now.enum)) return [];
  const allowed = new Set(now.enum.map((value) => JSON.stringify(value)));
  return was.enum
    .filter((value) => !allowed.has(JSON.stringify(value)))
    .map((value) => String(value));
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// --------------------------------------------------------------------------- skills and metadata

function diffSkills(from: ApiModel, to: ApiModel): SkillDiff[] | null {
  if (!from.a2a && !to.a2a) return null;
  const before = new Map((from.a2a?.skills ?? []).map((skill) => [skill.id, skill]));
  const after = new Map((to.a2a?.skills ?? []).map((skill) => [skill.id, skill]));
  const out: SkillDiff[] = [];
  for (const [id, skill] of before) {
    if (after.has(id)) continue;
    out.push({ id, name: skill.name, change: "removed", breaking: true, rule: "a2a-skill-removed" });
  }
  for (const [id, skill] of after) {
    if (before.has(id)) continue;
    out.push({ id, name: skill.name, change: "added", breaking: false });
  }
  return out;
}

/**
 * The fields a consumer reads on the listing. Never breaking on their own — a renamed API is
 * confusing, not incompatible — so they are reported apart from the operations.
 */
function diffMetadata(from: ApiModel, to: ApiModel): MetadataDiff[] {
  const out: MetadataDiff[] = [];
  const scalar: Array<[string, string | null, string | null]> = [
    ["title", from.title ?? null, to.title ?? null],
    ["version", from.version ?? null, to.version ?? null],
    ["description", from.description ?? null, to.description ?? null],
    ["servers", (from.servers ?? []).join(", ") || null, (to.servers ?? []).join(", ") || null],
    ["soap.targetNamespace", from.soap?.targetNamespace ?? null, to.soap?.targetNamespace ?? null],
    ["soap.endpoint", from.soap?.endpoint ?? null, to.soap?.endpoint ?? null],
    ["mcp.protocolVersion", from.mcp?.protocolVersion ?? null, to.mcp?.protocolVersion ?? null],
    ["a2a.protocolVersion", from.a2a?.protocolVersion ?? null, to.a2a?.protocolVersion ?? null],
  ];
  for (const [field, was, now] of scalar) {
    if (was === now) continue;
    out.push({ field, was, now });
  }
  return out;
}
