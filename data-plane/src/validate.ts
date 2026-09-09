import { createHash } from "node:crypto";
import type { OperationSchemas, ValidationArtifact } from "../../shared/artifact.ts";
import { readJsonBounded, JsonError } from "../../shared/json-reader.ts";
import { coerceParameter, validate as validateJson, type ValidationIssue } from "../../shared/jsonschema.ts";
import type { ValidateUnit } from "../../shared/policy.ts";
import { emptyValidationCounters, type ValidationCounters } from "../../shared/telemetry.ts";
import { validateXmlDocument, type XsdIssue } from "../../shared/xsd.ts";

/**
 * Design section 5.1, on the request path.
 *
 * Three states, and the difference between them is the whole design:
 *
 *  - **`blocking`** — the default, and the only *enforcing* mode. Buffers the body up to
 *    `always.maxBodyBytes`, validates it, and rejects on failure. Deterministic.
 *  - **`warning`** — never rejects. Sampled, asynchronous, contributing zero request latency. It
 *    is an observation, so it must not be read as a gateway-enforced control in a security review.
 *  - **`disabled`** — no schema validation. The `always` block still applies.
 *
 * Deviation D19: the design runs warning-mode work in a pool of OS threads with per-request
 * isolation. This runtime has one thread, so the pool is a bounded queue drained with explicit
 * yields. Its depth and concurrency are bounded and saturation is counted exactly as section 8.4
 * requires, but the work is not isolated from the request path the way a goroutine is — which is
 * why `VALIDATE_POOL_SIZE` also bounds how much of a tick validation may take.
 */

export interface ValidationOutcome {
  ok: boolean;
  issues: ValidationIssue[];
  truncated: boolean;
  /** `true` when nothing was checked because there is no schema for this operation. */
  skipped?: boolean;
}

export const OK: ValidationOutcome = { ok: true, issues: [], truncated: false };

function toIssues(issues: XsdIssue[]): ValidationIssue[] {
  return issues.map((issue) => ({ path: issue.path, rule: issue.rule, message: issue.message }));
}

/** The `always` block, resolved into the shapes the readers take. */
export function jsonLimitsOf(validate: ValidateUnit) {
  return {
    maxDepth: validate.always?.maxDepth ?? 32,
    maxArrayLength: validate.always?.json?.maxArrayLength ?? 10_000,
    maxObjectKeys: 5_000,
    duplicateKeys: validate.always?.json?.duplicateKeys ?? ("reject" as const),
  };
}

/**
 * Parses a JSON body under the `always` block. A parse failure is a validation failure in every
 * state, because the bounds it enforces are not schema checks — they are the difference between
 * this gateway and the backend agreeing on what the document says.
 */
export function readJsonBody(
  text: string,
  validate: ValidateUnit,
): { value: unknown } | { error: ValidationIssue } {
  try {
    return { value: readJsonBounded(text, jsonLimitsOf(validate)) };
  } catch (err) {
    const jsonError = err instanceof JsonError ? err : null;
    return {
      error: {
        path: jsonError?.path || "/",
        rule: "json",
        message: jsonError ? jsonError.message : String((err as Error).message),
      },
    };
  }
}

export interface BodyValidationInput {
  artifact: ValidationArtifact;
  operationId: string;
  direction: "request" | "response";
  contentType: string | null;
  status?: number;
  /** Already parsed for JSON, raw text for XML. */
  json?: unknown;
  xml?: string;
  xmlLimits?: { maxBytes: number; maxDepth: number; maxElements: number };
  maxErrors?: number;
}

/** Which media-type entry in a compiled operation covers this request's Content-Type. */
function contentRefFor(
  content: Record<string, string> | undefined,
  contentType: string | null,
): string | null {
  if (!content) return null;
  const media = (contentType ?? "").split(";")[0]!.trim().toLowerCase();
  if (media && content[media]) return content[media]!;
  // OpenAPI allows `application/*+json` and `*/*`; a body with no declared type falls back to the
  // single entry when there is exactly one, which is what a document with one media type means.
  for (const [declared, ref] of Object.entries(content)) {
    if (declared === "*/*") return ref;
    if (declared.endsWith("/*") && media.startsWith(declared.slice(0, -1))) return ref;
    if (declared.startsWith("application/") && declared.endsWith("+json") && media.endsWith("+json")) {
      return ref;
    }
  }
  const only = Object.values(content);
  return only.length === 1 && !media ? only[0]! : null;
}

/** The response entry for a status code: exact, then `2XX`-style ranges, then `default`. */
function responseFor(op: OperationSchemas, status: number): OperationSchemas["responses"] extends undefined ? never : NonNullable<OperationSchemas["responses"]>[string] | null {
  const responses = op.responses;
  if (!responses) return null;
  return (
    responses[String(status)] ??
    responses[`${Math.floor(status / 100)}XX`] ??
    responses[`${Math.floor(status / 100)}xx`] ??
    responses.default ??
    null
  );
}

export function validateBody(input: BodyValidationInput): ValidationOutcome {
  const op = input.artifact.operations[input.operationId];
  if (!op || op.state !== "ok") return { ...OK, skipped: true };

  if (input.artifact.kind === "xsd-set") {
    const element = input.direction === "request" ? op.inputElement : op.outputElement;
    if (!element || !input.xml || !input.artifact.xsd) return { ...OK, skipped: true };
    const result = validateXmlDocument(
      input.xml,
      input.artifact.xsd,
      input.xmlLimits ?? {},
      { maxErrors: input.maxErrors ?? 20 },
    );
    // The SOAP body child is the element under test; `validateXmlDocument` was handed exactly it.
    return { ok: result.ok, issues: toIssues(result.issues), truncated: result.truncated };
  }

  const defs = input.artifact.defs ?? {};
  const ref =
    input.direction === "request"
      ? contentRefFor(op.request?.content, input.contentType)
      : contentRefFor(responseFor(op, input.status ?? 200)?.content, input.contentType);
  if (!ref) return { ...OK, skipped: true };
  const schema = defs[ref];
  if (!schema) return { ...OK, skipped: true };

  const result = validateJson(input.json, schema, defs, { maxErrors: input.maxErrors ?? 20 });
  return { ok: result.ok, issues: result.issues, truncated: result.truncated };
}

export interface ParameterInput {
  artifact: ValidationArtifact;
  operationId: string;
  pathParams: Record<string, string>;
  query: URLSearchParams;
  headers: Headers;
  maxErrors?: number;
}

/**
 * Declared parameters only. An undeclared header or query parameter is allowed — OpenAPI does not
 * forbid them, and the opposite reading would reject every real request for carrying a
 * `User-Agent` (plan `[R2-24]`).
 */
export function validateParameters(input: ParameterInput): ValidationOutcome {
  const op = input.artifact.operations[input.operationId];
  if (!op?.parameters || op.parameters.length === 0) return OK;
  const defs = input.artifact.defs ?? {};
  const issues: ValidationIssue[] = [];
  const maxErrors = input.maxErrors ?? 20;

  for (const parameter of op.parameters) {
    if (issues.length >= maxErrors) break;
    let raw: string | null;
    switch (parameter.in) {
      case "path":
        raw = input.pathParams[parameter.name] ?? null;
        break;
      case "query":
        raw = input.query.get(parameter.name);
        break;
      case "header":
        raw = input.headers.get(parameter.name);
        break;
      default:
        continue;
    }
    const where = `${parameter.in}/${parameter.name}`;
    if (raw === null) {
      if (parameter.required) {
        issues.push({
          path: where,
          rule: "required",
          message: `required ${parameter.in} parameter "${parameter.name}" is missing`,
        });
      }
      continue;
    }
    if (!parameter.ref) continue;
    const schema = defs[parameter.ref];
    if (!schema) continue;
    const value = coerceParameter(raw, schema);
    const result = validateJson(value, schema, defs, { maxErrors: maxErrors - issues.length });
    for (const issue of result.issues) {
      issues.push({ ...issue, path: issue.path === "/" ? where : `${where}${issue.path}` });
    }
  }
  return { ok: issues.length === 0, issues, truncated: issues.length >= maxErrors };
}

export function validateResponseHeaders(
  artifact: ValidationArtifact,
  operationId: string,
  status: number,
  headers: Headers,
): ValidationOutcome {
  const op = artifact.operations[operationId];
  const response = op ? responseFor(op, status) : null;
  if (!response?.headers || response.headers.length === 0) return OK;
  const defs = artifact.defs ?? {};
  const issues: ValidationIssue[] = [];
  for (const header of response.headers) {
    const raw = headers.get(header.name);
    if (raw === null) {
      if (header.required) {
        issues.push({
          path: `header/${header.name}`,
          rule: "required",
          message: `the contract declares response header "${header.name}" as required`,
        });
      }
      continue;
    }
    if (!header.ref) continue;
    const schema = defs[header.ref];
    if (!schema) continue;
    const result = validateJson(coerceParameter(raw, schema), schema, defs, { maxErrors: 5 });
    for (const issue of result.issues) {
      issues.push({ ...issue, path: `header/${header.name}` });
    }
  }
  return { ok: issues.length === 0, issues, truncated: false };
}

// --------------------------------------------------------------------------- sampling

/**
 * Deterministic — `hash(key, requestId) < rate` — so it needs no per-instance counter, no eviction
 * table, and behaves consistently across the fleet. Sampling exists only in `warning` mode:
 * sampling plus rejecting would make the same payload succeed or fail depending on where a counter
 * landed, so callers could not retry and reports could not be reproduced.
 */
export class Sampler {
  /** Requests seen per key, for the cold-start burst. Bounded by eviction below. */
  private readonly seen = new Map<string, number>();
  /** Keys escalated to 100% after a failure, with the millisecond the escalation ends. */
  private readonly escalated = new Map<string, number>();

  constructor(
    private readonly maxKeys = 20_000,
    private readonly now: () => number = Date.now,
  ) {}

  key(operationId: string | null, subscriptionId: string | null, parts?: string[]): string {
    const use = parts ?? ["operation", "subscription"];
    const bits: string[] = [];
    if (use.includes("operation")) bits.push(operationId ?? "-");
    if (use.includes("subscription")) bits.push(subscriptionId ?? "-");
    return bits.join("|");
  }

  decide(
    key: string,
    requestId: string,
    options: { rate: number; coldStart: number; alwaysUnderBytes: number },
    bodyBytes: number,
  ): boolean {
    // Gate on cost: sampling something that costs microseconds saves nothing.
    if (bodyBytes <= options.alwaysUnderBytes) return true;

    const until = this.escalated.get(key);
    if (until !== undefined) {
      if (until > this.now()) return true;
      this.escalated.delete(key);
    }

    const count = (this.seen.get(key) ?? 0) + 1;
    if (this.seen.size >= this.maxKeys && !this.seen.has(key)) {
      // Full: skip the burst bookkeeping rather than grow without bound. The rate still applies.
    } else {
      this.seen.set(key, count);
      if (count <= options.coldStart) return true;
    }

    const digest = createHash("sha256").update(`${key}|${requestId}`).digest();
    // The first four bytes as a fraction of 2^32: stable across instances and across restarts.
    const fraction = digest.readUInt32BE(0) / 0x1_0000_0000;
    return fraction < options.rate;
  }

  /** A failed sample raises that key to 100% for the configured window. */
  escalate(key: string, seconds: number): void {
    if (seconds <= 0) return;
    this.escalated.set(key, this.now() + seconds * 1000);
  }

  /** Re-armed by a new revision, a new subscription or a config change (design section 5.1). */
  reset(): void {
    this.seen.clear();
    this.escalated.clear();
  }
}

// --------------------------------------------------------------------------- the bounded pool

export interface PoolTask {
  run: () => void;
}

/**
 * Design section 8.4: bounded by a semaphore, with a bounded queue in front. On saturation the
 * sample is dropped and counted; it never queues unboundedly and never backpressures the request
 * path.
 */
export class ValidationPool {
  private readonly queue: PoolTask[] = [];
  private draining = 0;
  dropped = 0;

  constructor(
    private concurrency: number,
    private depth: number,
  ) {}

  /**
   * Both are the fleet's decision and change when a document is activated. Nothing queued is
   * thrown away: a narrower pool simply starts fewer new drains, and a shallower queue rejects the
   * next submissions until the backlog is under it.
   */
  resize(concurrency: number, depth: number): void {
    this.concurrency = concurrency;
    this.depth = depth;
  }

  submit(task: PoolTask): boolean {
    if (this.queue.length >= this.depth) {
      this.dropped++;
      return false;
    }
    this.queue.push(task);
    if (this.draining < this.concurrency) {
      this.draining++;
      // A macrotask, not a microtask: a microtask chain would starve the event loop, which is the
      // opposite of what a pool that must not backpressure the request path is for (D19).
      setTimeout(() => this.drain(), 0);
    }
    return true;
  }

  private drain(): void {
    const task = this.queue.shift();
    if (!task) {
      this.draining--;
      return;
    }
    try {
      task.run();
    } catch {
      // A validation sample that throws is a dropped sample, never a failed request.
      this.dropped++;
    }
    if (this.queue.length > 0) setTimeout(() => this.drain(), 0);
    else this.draining--;
  }

  get depthNow(): number {
    return this.queue.length;
  }
}

/** The counters design section 5.1 asks for, kept per instance and reported on the poll. */
export class ValidationCounterSet {
  private counters: ValidationCounters = emptyValidationCounters();

  rejected(): void {
    this.counters.rejected++;
  }
  observed(): void {
    this.counters.observed++;
  }
  sampleDropped(): void {
    this.counters.sampleDropped++;
  }
  unavailable(): void {
    this.counters.unavailable++;
  }
  budgetShed(): void {
    this.counters.budgetShed++;
  }

  snapshot(): ValidationCounters {
    return { ...this.counters };
  }

  /** Cleared only when the control plane accepted the report, like the rollup windows. */
  clear(): void {
    this.counters = emptyValidationCounters();
  }
}

/**
 * The blocking-mode memory ceiling (design section 8.4). `maxBodyBytes × in-flight blocking
 * requests` is the real number; this bounds it, and past the ceiling a request is shed rather than
 * validated half-way or let through unvalidated.
 */
export class BlockingBudget {
  private used = 0;

  constructor(public total: number) {}

  /**
   * Lowered below what is reserved, the reservations stand — they are bytes already held by
   * requests in flight — and the next one is shed until enough have been released.
   */
  resize(total: number): void {
    this.total = total;
  }

  tryReserve(bytes: number): boolean {
    if (this.used + bytes > this.total) return false;
    this.used += bytes;
    return true;
  }

  release(bytes: number): void {
    this.used = Math.max(0, this.used - bytes);
  }

  get inUse(): number {
    return this.used;
  }
}
