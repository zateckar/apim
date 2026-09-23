import { timingSafeEqual } from "node:crypto";
import type { ValidationArtifact } from "../../shared/artifact.ts";
import { selectionOrder, type BreakerSettings } from "../../shared/backend.ts";
import type {
  BackendEntry,
  ConfigLimits,
  ConfigOperation,
  ConfigRoute,
  ConfigSubscription,
} from "../../shared/config-doc.ts";
import { codeForStatus, parseRpc, RPC_CODES } from "../../shared/jsonrpc.ts";
import type { ValidationIssue } from "../../shared/jsonschema.ts";
import { hashSubscriptionKey } from "../../shared/keys.ts";
import { isStreamingMethod, rewriteCard } from "../../shared/a2a.ts";
import { selectorFor } from "../../shared/mcp.ts";
import { matchCompiled, renderPathTemplate } from "../../shared/opmatch.ts";
import {
  DEFAULT_TIMEOUT_MS,
  isIdempotent,
  operationUnitKey,
  PATTERN_VALUE_MAX_BYTES,
  type CacheUnit,
  type ErrorFormatUnit,
  type PolicyDocument,
  type PreconditionRule,
  type QuotaUnit,
  type RateLimitUnit,
  type RequireHeaderCheck,
  type RequireQueryCheck,
  type ValidateUnit,
} from "../../shared/policy.ts";
import { joinBackend, stripBasePath } from "../../shared/routing.ts";
import { actionAgrees, declaredAction, mediaTypeOf } from "../../shared/soap.ts";
import { baseContext, render, renderDeep, type TemplateContext } from "../../shared/template.ts";
import { roundMs, type Outcome } from "../../shared/telemetry.ts";
import { ipInCidr } from "../../shared/net.ts";
import { scanEnvelope, XmlError, parseDocument } from "../../shared/xml.ts";
import { bodyExcerpt, logTimestamp, redactQuery, MAX_LOGGED_BODY_BYTES } from "./accesslog.ts";
import type { ArtifactCache } from "./artifacts.ts";
import { applyBackendAuth, tokenCacheKey, type TokenCache } from "./backend-auth.ts";
import { cacheKeyFor, downstreamCacheControl, isCacheable, type ResponseCache } from "./cache.ts";
import type { ConcurrencyGate } from "./concurrency.ts";
import {
  bearerToken,
  scopeMapMisses,
  secretMatches,
  verifyBasic,
  verifyMtls,
  type ClientCertificate,
  type Identity,
  type IntrospectionCache,
  type JwksCache,
} from "./identity.ts";
import { verifyJwt } from "./identity.ts";
import type { QuotaCounters } from "./quota.ts";
import { DEFAULT_ERROR_FORMAT, gatewayError, STATUS_TITLES } from "./respond.ts";
import type { RateLimiter, RateVerdict } from "./ratelimit.ts";
import type { RouteTable } from "./route-table.ts";
import { superviseSse, type StreamRegistry, type UpgradeIntent } from "./stream.ts";
import { traceContextFrom, traceStateFor } from "./trace.ts";
import { soapToJson } from "./transform.ts";
import {
  BlockingBudget,
  readJsonBody,
  Sampler,
  validateBody,
  validateParameters,
  validateResponseHeaders,
  ValidationCounterSet,
  ValidationPool,
  type ValidationOutcome,
} from "./validate.ts";
import type { CircuitBreaker } from "../../shared/backend.ts";

/**
 * Design section 5.2: the pipeline order is part of the contract, and several orderings are
 * constraints rather than conveniences.
 *
 *   1  route match                 · 13  rewrite (or kafkaProduce's path, method and body)
 *   2  trusted-proxy context       · 14  request headers
 *   3  always-on limits            · 15  request transform (none — D21)
 *   4  ipAllow                     · 16  cache lookup
 *   5  CORS preflight              · 17  backend select
 *   6  authenticate                · 18  backend auth
 *   7  authorize                   · 19  proxy (timeout, retries, breaker)
 *   8  rate limit                  · 20  response validation, then response transform
 *   9  quota                       · 21  response headers + CORS
 *  10  preconditions               · 22  backend-auth invalidation
 *  11  operation resolution        · 23  cache store
 *  12  request validation          · 24  telemetry + access log
 *
 * The ones that are load-bearing:
 *  - validation and preconditions sit after authenticate and authorize, so unauthenticated traffic
 *    cannot consume validation CPU or trigger a precondition;
 *  - operation resolution sits at 11 for the same reason: parsing a body is work, and work an
 *    unauthenticated caller can cause is a lever;
 *  - credential stripping (14) precedes backend auth (18), so a route cannot forward the inbound
 *    credential alongside the outbound one;
 *  - response validation (20) precedes the response transform, because the declared schema
 *    describes what the backend sends, not what we hand on.
 */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/**
 * A buffer this process allocated, rather than one that might be backed by a `SharedArrayBuffer`.
 * `Response` will not take the latter, and every buffer here is ours.
 */
type Bytes = Uint8Array<ArrayBuffer>;

const patternCache = new Map<string, RegExp>();

function compiled(pattern: string): RegExp {
  let regex = patternCache.get(pattern);
  if (!regex) {
    regex = new RegExp(pattern);
    patternCache.set(pattern, regex);
  }
  return regex;
}

function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

function valueMatches(
  check: RequireHeaderCheck | RequireQueryCheck,
  value: string | null,
  references: PipelineDeps["table"]["references"],
): boolean {
  if (value === null) return false;
  if (check.present) return true;
  // Design section 5.6: the estate's `!=` on a header is timing-variable; this one is not.
  if (check.equals !== undefined) return constantTimeEquals(value, check.equals);
  if ("credentialRef" in check && check.credentialRef !== undefined) {
    return secretMatches(value, check.credentialRef, references);
  }
  if (check.pattern !== undefined) {
    // Deviation D8: JS RegExp backtracks, so the input is bounded as well as the pattern.
    if (Buffer.byteLength(value, "utf8") > PATTERN_VALUE_MAX_BYTES) return false;
    return compiled(check.pattern).test(value);
  }
  return false;
}

/**
 * Design section 4.2. Set on **every** response for a deprecated route, including rejections: a
 * consumer being rate limited still needs to know the version is going away.
 */
function lifecycleHeaders(route: ConfigRoute): Record<string, string> {
  if (route.lifecycle === "active") return {};
  const headers: Record<string, string> = { deprecation: "true" };
  if (route.sunsetAt) {
    const at = new Date(route.sunsetAt);
    if (!Number.isNaN(at.getTime())) headers.sunset = at.toUTCString();
  }
  return headers;
}

/**
 * CORS headers go on **every** response the gateway writes, including its own rejections: a 401
 * without them reaches a browser as an opaque CORS failure, so the consumer sees "CORS error"
 * instead of "your key is wrong" (plan `[R2-06]`).
 */
function corsHeaders(route: ConfigRoute, origin: string | null): Record<string, string> {
  const unit = route.policy.cors;
  if (!unit || !origin) return {};
  const allowed = unit.origins.includes("*") || unit.origins.includes(origin);
  if (!allowed) return {};
  const headers: Record<string, string> = {
    "access-control-allow-origin": unit.origins.includes("*") && !unit.credentials ? "*" : origin,
    vary: "Origin",
  };
  if (unit.credentials) headers["access-control-allow-credentials"] = "true";
  if (unit.exposeHeaders?.length) {
    headers["access-control-expose-headers"] = unit.exposeHeaders.join(", ");
  }
  return headers;
}

function preflightResponse(route: ConfigRoute, req: Request, requestId: string): Response | null {
  const unit = route.policy.cors;
  if (!unit || req.method !== "OPTIONS") return null;
  // Only a route with a `cors` unit short-circuits OPTIONS. Without one it is an ordinary request
  // and goes to the backend, which may well handle it (plan `[R3-12]`).
  if (!req.headers.get("access-control-request-method")) return null;
  const origin = req.headers.get("origin");
  const headers: Record<string, string> = {
    ...corsHeaders(route, origin),
    "access-control-allow-methods": (unit.methods ?? ["GET", "POST", "PUT", "PATCH", "DELETE"]).join(", "),
    "access-control-max-age": String(unit.maxAgeSec ?? 600),
    "x-request-id": requestId,
    "content-length": "0",
  };
  const requested = req.headers.get("access-control-request-headers");
  if (unit.headers?.length) headers["access-control-allow-headers"] = unit.headers.join(", ");
  else if (requested) headers["access-control-allow-headers"] = requested;
  return new Response(null, { status: 204, headers });
}

function denyResponse(
  rule: PreconditionRule,
  format: ErrorFormatUnit,
  ctx: TemplateContext,
  requestId: string,
  extraHeaders: Record<string, string>,
): Response {
  const status = rule.deny.status;
  const reason = render(rule.deny.reason, ctx);
  const headers: Record<string, string> = {
    ...extraHeaders,
    ...renderDeep(rule.deny.headers ?? {}, ctx),
    "x-request-id": requestId,
  };

  if (rule.deny.body === undefined) {
    return gatewayError(format, status, STATUS_TITLES[status] ?? "Denied", reason, requestId, {}, headers);
  }
  if (typeof rule.deny.body === "string") {
    const body = render(rule.deny.body, ctx);
    return new Response(body, {
      status,
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "content-length": String(Buffer.byteLength(body, "utf8")),
        ...headers,
      },
    });
  }
  const body = JSON.stringify(renderDeep(rule.deny.body, ctx));
  return new Response(body, {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-length": String(Buffer.byteLength(body, "utf8")),
      ...headers,
    },
  });
}

/** Counts bytes and reports once, on completion or on client cancellation. */
function countingStream(
  source: ReadableStream<Uint8Array>,
  onDone: (bytes: number) => void,
): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  let bytes = 0;
  let reported = false;
  const report = () => {
    if (reported) return;
    reported = true;
    onDone(bytes);
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const result = await reader.read();
        if (result.done) {
          report();
          controller.close();
          return;
        }
        bytes += result.value.byteLength;
        controller.enqueue(result.value);
      } catch (err) {
        report();
        controller.error(err);
      }
    },
    cancel(reason) {
      report();
      return reader.cancel(reason);
    },
  });
}

export interface TelemetryRecord {
  resourceId: string | null;
  subscriptionId: string | null;
  outcome: Outcome;
  status: number;
  /** Fractional milliseconds. See `roundMs` for why this is not an integer. */
  durationMs: number;
  /** The backend call's own time, or `null` when this gateway answered without making one. */
  backendMs: number | null;
  bytesIn: number;
  bytesOut: number;
}

export interface PipelineDeps {
  table: RouteTable;
  limiter: RateLimiter;
  quota: QuotaCounters;
  artifacts: ArtifactCache;
  jwks: JwksCache;
  introspection: IntrospectionCache;
  tokens: TokenCache;
  breaker: CircuitBreaker;
  cache: ResponseCache;
  sampler: Sampler;
  pool: ValidationPool;
  counters: ValidationCounterSet;
  budget: BlockingBudget;
  streams: StreamRegistry;
  maxBodyBytes: number;
  /**
   * The address policy matches against: the socket peer, or — behind a trusted proxy — the caller
   * that proxy reported. Resolved by the caller, because only it knows the trust boundary.
   */
  clientIp: string;
  /**
   * The socket peer, when it differs from `clientIp`. This is what goes on the outbound
   * `X-Forwarded-For` chain, since a proxy appends the address it received from.
   */
  peerIp?: string;
  requestId: string;
  /**
   * The parsed request URL. The server has already built one — it has to, to tell `/healthz` from
   * traffic — so it travels rather than being parsed again here: `new URL` is not free at the rate
   * the rejection paths answer (`reports/perf-report.md`), and two parses of one string cannot
   * disagree usefully.
   */
  url: URL;
  /** This gateway and this replica, so a log line identifies itself without the shipper's help. */
  gatewayName: string;
  runId: string;
  /** True only when the peer is inside TRUSTED_PROXY_CIDRS (design section 8.1). */
  trustedPeer: boolean;
  clientCertHeaders: { dn: string; issuer: string; verify: string; fingerprint: string; san: string };
  /**
   * Whether every response carries `Server-Timing` (the `serverTiming` gateway setting).
   *
   * What it is for: a caller measuring this gateway's overhead has no other way to separate it from
   * the network, and the difference is not small — a rig measuring across a WAN attributes two
   * round trips to the proxy sitting between them. The gateway is the only party holding a clock
   * with no wire in it, so it is the only party that can answer.
   */
  serverTiming: boolean;
  log?: (record: Record<string, unknown>) => void;
  /** Returns a handle for the response bytes, which are only known once the body has streamed. */
  record?: (record: TelemetryRecord) => { addBytesOut: (bytes: number) => void };
  /** Absent means unbounded in-flight upstream work, which is what the bulkhead exists to prevent. */
  gate?: ConcurrencyGate;
  fetchImpl?: typeof fetch;
}

/** Either a response to write, or an instruction to the server to upgrade the connection. */
export type PipelineResult = Response | UpgradeIntent;

export async function handleRequest(req: Request, deps: PipelineDeps): Promise<PipelineResult> {
  const started = performance.now();
  const url = deps.url;
  const limits: ConfigLimits = deps.table.limits;
  let route: ConfigRoute | null = null;
  let subscription: ConfigSubscription | null = null;
  let identity: Identity | null = null;
  let backendStatus: number | null = null;
  let operation: ConfigOperation | null = null;
  let pathParams: Record<string, string> = {};
  let rpcId: string | number | null = null;
  let bytesIn = 0;
  let format: ErrorFormatUnit = DEFAULT_ERROR_FORMAT;
  let corsOut: Record<string, string> = {};
  /** The trace this call belongs to: continued from the caller, or started here. */
  const trace = traceContextFrom(req.headers.get("traceparent"));
  /** Set once the route is known and its window checked; false for every request that is not in one. */
  let captureBodies = false;
  /** The route's own key parameter, when it carries one in the query: a credential by declaration. */
  let keyParamName: string | null = null;
  /**
   * What the line learns as the request progresses. One object rather than four variables because
   * the line is written from a closure, and a `let` that is still `null` where the closure is
   * created is a `let` the compiler is entitled to believe will always be `null`.
   *
   * `failure` is the reason a 5xx or a transport error happened; it and `responseBody` are written
   * for those cases whatever the body window says.
   */
  const logged: {
    requestBody: { body: string; truncated: boolean } | null;
    responseBody: { body: string; truncated: boolean } | null;
    backendMs: number | null;
    failure: string | null;
  } = { requestBody: null, responseBody: null, backendMs: null, failure: null };

  /** Fractional milliseconds since this request arrived. The one clock everything below reads. */
  const elapsed = (): number => roundMs(performance.now() - started);

  const emit = (status: number, outcome: Outcome, bytesOut: number, durationMs?: number) =>
    deps.record?.({
      resourceId: route?.resourceId ?? null,
      subscriptionId: subscription?.id ?? null,
      outcome,
      status,
      durationMs: durationMs ?? elapsed(),
      // Whatever the backend attempt cost, or `null` where there was no attempt — which is what
      // makes the rest of the duration this gateway's, provably rather than by assumption.
      backendMs: logged.backendMs,
      bytesIn,
      bytesOut,
    });

  /**
   * `Server-Timing`, when the fleet has asked for it.
   *
   * `gw` is the duration **minus** the backend call, not the total: a caller subtracting a number
   * this header already gave them would be doing the gateway's arithmetic, and the whole reason the
   * header exists is that the gateway is the only party that can do it correctly. `backend` is
   * omitted rather than sent as zero when no backend was called, because a rejection and an
   * instantaneous upstream are different facts.
   *
   * Both clocks stop at the response headers, so they are subtractable: `backendMs` is measured to
   * the upstream's status line and `durationMs` to the point this gateway hands the response on,
   * neither including the time a body spends streaming to a slow client.
   */
  const stamp = (headers: Headers, durationMs: number): void => {
    if (!deps.serverTiming) return;
    const backendMs = logged.backendMs;
    const gatewayMs = roundMs(Math.max(0, durationMs - (backendMs ?? 0)));
    headers.set(
      "server-timing",
      backendMs === null ? `gw;dur=${gatewayMs}` : `gw;dur=${gatewayMs}, backend;dur=${backendMs}`,
    );
  };

  /**
   * The one place a line is assembled, for the two paths that write one: a response this gateway
   * produced, and a response streamed from a backend.
   *
   * What is deliberately **not** here: any header. The subscription key and the `Authorization` it
   * arrived under are the two things this file spends most of its length protecting, and a log is
   * a copy of a request that outlives it — so headers are not omitted for size, they are omitted
   * because one of them is always a credential. The query string is written down redacted, because
   * a caller that put its key in a URL still needs the rest of that URL to be debuggable.
   */
  const writeLog = (o: {
    status: number;
    outcome: Outcome;
    note?: string | null;
    durationMs: number;
  }): void => {
    deps.log?.({
      ts: logTimestamp(),
      requestId: deps.requestId,
      traceId: trace.traceId,
      spanId: trace.spanId,
      parentSpanId: trace.parentSpanId,
      environment: deps.table.environment,
      gateway: deps.gatewayName,
      instance: deps.runId,
      method: req.method,
      path: url.pathname,
      query: redactQuery(url.search, keyParamName),
      host: req.headers.get("host"),
      status: o.status,
      backendStatus,
      outcome: o.outcome,
      error: logged.failure,
      resourceId: route?.resourceId ?? null,
      resourceName: route?.resourceName ?? null,
      apiVersion: route?.apiVersion ?? null,
      rev: route?.rev ?? null,
      operationId: operation?.id ?? null,
      subscriptionId: subscription?.id ?? null,
      applicationId: subscription?.applicationId ?? null,
      clientIp: deps.clientIp,
      durationMs: o.durationMs,
      backendMs: logged.backendMs,
      note: o.note ?? null,
      ...(logged.requestBody
        ? { requestBody: logged.requestBody.body, requestBodyTruncated: logged.requestBody.truncated }
        : {}),
      ...(logged.responseBody
        ? { responseBody: logged.responseBody.body, responseBodyTruncated: logged.responseBody.truncated }
        : {}),
    });
  };

  /** Terminal for every response the gateway itself writes: body length is already known. */
  const finish = (response: Response, outcome: Outcome, note?: string): Response => {
    for (const [name, value] of Object.entries(route ? lifecycleHeaders(route) : {})) {
      response.headers.set(name, value);
    }
    for (const [name, value] of Object.entries(corsOut)) response.headers.set(name, value);
    response.headers.set("x-request-id", deps.requestId);
    const bytesOut = Number(response.headers.get("content-length") ?? "0");
    // Once, for all three readers: the log line, the telemetry cell and the `Server-Timing` header
    // describe the same request, and two `performance.now()` calls either side of a
    // `JSON.stringify` describe it differently.
    const durationMs = elapsed();
    stamp(response.headers, durationMs);
    writeLog({ status: response.status, outcome, note, durationMs });
    emit(response.status, outcome, bytesOut, durationMs);
    return response;
  };

  const deny = (
    status: number,
    detail: string,
    outcome: Outcome,
    extra: Record<string, unknown> = {},
    headers: Record<string, string> = {},
  ): Response => {
    if (status >= 500) {
      // A 5xx is this estate's failure rather than the caller's, and the reason for it is the whole
      // content of the line: a log that recorded `502` and not why is one somebody has to reproduce
      // an outage to read. So the reason is written whatever the body window says — it is the
      // gateway's own sentence about its own failure, and it contains nothing the caller sent.
      logged.failure = logged.failure ?? detail;
      logged.responseBody = { body: detail, truncated: false };
    }
    return finish(
      gatewayError(
        format,
        status,
        STATUS_TITLES[status] ?? "Error",
        detail,
        deps.requestId,
        extra,
        headers,
        rpcId,
      ),
      outcome,
      outcome,
    );
  };

  // 1 — route match
  route = deps.table.match(req.headers.get("host"), url.pathname);
  if (!route) {
    return deny(404, "no published route matches this host and path", "no-route");
  }
  const policy = route.policy;
  format = policy.errorFormat ?? DEFAULT_ERROR_FORMAT;
  keyParamName = policy["auth.subscriptionKey"]?.in === "query"
    ? policy["auth.subscriptionKey"].name
    : null;
  /*
   * The body window (design section 5.1's sibling): bodies are captured only while an
   * administrator has asked for them on this API, and the instance stops on its own clock the
   * moment the window closes — a control-plane outage cannot hold one open. The window arrives in
   * the configuration document, so turning it on is an act somebody performed on the control
   * plane, against one API, with an audit row behind it.
   */
  captureBodies =
    route.logBodiesUntil !== undefined && Date.parse(route.logBodiesUntil) > Date.now();
  const validate: ValidateUnit = policy.validate ?? {};
  corsOut = corsHeaders(route, req.headers.get("origin"));

  // 2 — trusted-proxy context (the effective client IP is resolved by the caller)
  const clientCertificate = deps.trustedPeer
    ? readCertificate(req.headers, deps.clientCertHeaders)
    : null;

  // 3 — always-on limits. Checked at header time from Content-Length *and* enforced while
  // streaming, because a chunked request declares no length.
  const routeMaxBody = Math.min(validate.always?.maxBodyBytes ?? deps.maxBodyBytes, deps.maxBodyBytes);
  const declaredLength = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > routeMaxBody) {
    return deny(
      413,
      `body larger than ${routeMaxBody} bytes (${
        routeMaxBody === deps.maxBodyBytes ? "this gateway's ceiling" : "this route's validate.always ceiling"
      })`,
      "body-too-large",
    );
  }

  const hasBody = req.method !== "GET" && req.method !== "HEAD" && req.body !== null;
  const allowedTypes = validate.always?.contentType;
  if (hasBody && allowedTypes && allowedTypes.length > 0) {
    const media = mediaTypeOf(req.headers.get("content-type"));
    if (!matchesMedia(media, allowedTypes)) {
      return deny(
        415,
        `this route accepts only ${allowedTypes.join(" or ")} (got "${media || "nothing"}")`,
        "content-type",
      );
    }
  }

  // 4 — ipAllow, against the EFFECTIVE client IP: behind a proxy every request would otherwise
  // appear to come from the proxy, so the allowlist would admit everyone or nobody (plan [R2-23]).
  if (policy.ipAllow && policy.ipAllow.length > 0) {
    if (!policy.ipAllow.some((cidr) => ipInCidr(deps.clientIp, cidr))) {
      return deny(403, "this client address is not allowed to call this API", "ip-denied");
    }
  }

  // 5 — CORS preflight short-circuit, and the A2A agent card when it is public
  const preflight = preflightResponse(route, req, deps.requestId);
  if (preflight) return finish(preflight, "ok");

  if (route.a2a && url.pathname === route.a2a.cardPath && req.method === "GET") {
    if (route.a2a.cardPublic) return finish(agentCardResponse(route, req, deps.requestId), "ok");
    // An unlisted agent's card needs the key, so it falls through to authentication below.
  }

  let bodyOverCap = false;
  const cappedBody = (body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> =>
    body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          bytesIn += chunk.byteLength;
          if (bytesIn > routeMaxBody) {
            bodyOverCap = true;
            controller.error(new Error("request body over cap"));
            return;
          }
          controller.enqueue(chunk);
        },
      }),
    );

  // 6 — authenticate
  const keyUnit = policy["auth.subscriptionKey"];
  if (keyUnit) {
    const presented =
      keyUnit.in === "header" ? req.headers.get(keyUnit.name) : url.searchParams.get(keyUnit.name);
    if (!presented) {
      return deny(401, `a subscription key is required in the ${keyUnit.name} ${keyUnit.in}`, "no-key");
    }
    subscription = deps.table.subscriptionByKeyHash(hashSubscriptionKey(presented));
    if (!subscription) return deny(401, "unknown or revoked subscription key", "bad-key");

    // 7 — authorize: the product this subscription grants must contain this API
    if (!route.productIds.includes(subscription.productId)) {
      return deny(403, "this subscription's product does not contain this API", "not-in-product");
    }
  }

  const basicUnit = policy["auth.basic"];
  if (basicUnit) {
    const result = verifyBasic(req.headers.get("authorization"), basicUnit, deps.table.references);
    if (!result.ok) return deny(result.status, result.detail, "bad-credential", {}, result.headers ?? {});
    identity = result.identity;
  }

  const jwtUnit = policy["auth.jwt"];
  if (jwtUnit) {
    const issuer = deps.table.references.issuers[jwtUnit.issuerRef];
    if (!issuer) {
      return deny(503, `the issuer "${jwtUnit.issuerRef}" is not configured on this gateway`, "bad-credential");
    }
    const token = bearerToken(req.headers, jwtUnit.headerName ?? "authorization", jwtUnit.scheme ?? "Bearer");
    if (!token) return deny(401, "a bearer token is required", "bad-credential");
    const result = await verifyJwt(token, jwtUnit, issuer, deps.jwks);
    if (!result.ok) return deny(result.status, result.detail, "bad-credential", {}, result.headers ?? {});
    identity = result.identity;
  }

  const introspectionUnit = policy["auth.introspection"];
  if (introspectionUnit) {
    const issuer = deps.table.references.issuers[introspectionUnit.issuerRef];
    if (!issuer) {
      return deny(
        503,
        `the issuer "${introspectionUnit.issuerRef}" is not configured on this gateway`,
        "bad-credential",
      );
    }
    const token = bearerToken(req.headers, "authorization", "Bearer");
    if (!token) return deny(401, "a bearer token is required", "bad-credential");
    const result = await deps.introspection.check(token, introspectionUnit, issuer);
    if (!result.ok) return deny(result.status, result.detail, "bad-credential");
    identity = result.identity;
  }

  const mtlsUnit = policy["auth.mtls"];
  if (mtlsUnit) {
    const result = verifyMtls(clientCertificate, mtlsUnit);
    if (!result.ok) return deny(result.status, result.detail, "bad-credential");
    identity = result.identity;
  }

  // The unlisted agent card: authenticated above, answered here without touching the backend.
  if (route.a2a && url.pathname === route.a2a.cardPath && req.method === "GET") {
    return finish(agentCardResponse(route, req, deps.requestId), "ok");
  }

  // 8 — rate limit
  let rateHeaders: Record<string, string> = {};
  const rateVerdict = applyRateLimit(deps, route, policy.rateLimit, subscription);
  if (rateVerdict) {
    if (policy.rateLimit!.emitHeaders) rateHeaders = rateHeadersOf(rateVerdict);
    if (!rateVerdict.allowed) {
      const unit = policy.rateLimit!;
      return deny(
        429,
        `rate limit of ${unit.calls} calls per ${unit.periodSec}s exceeded for this subscription`,
        "rate-limited",
        { limit: unit.calls, periodSec: unit.periodSec },
        { ...rateHeaders, "retry-after": String(rateVerdict.retryAfter) },
      );
    }
  }

  // 9 — quota
  if (policy.quota && subscription) {
    const verdict = applyQuota(deps, route, policy.quota, subscription);
    if (policy.quota.emitHeaders) Object.assign(rateHeaders, quotaHeadersOf(verdict));
    if (!verdict.allowed) {
      return deny(
        403,
        `the fleet quota of ${policy.quota.calls} calls per ${policy.quota.periodSec}s is exhausted ` +
          "for this subscription",
        "quota-exceeded",
        { limit: policy.quota.calls, periodSec: policy.quota.periodSec, resetSec: verdict.resetSec },
        rateHeaders,
      );
    }
  }

  const templateCtx: TemplateContext = {
    ...baseContext(),
    "subscription.id": subscription?.id ?? "",
    "subscription.name": subscription?.subscriptionName ?? "",
    "application.id": subscription?.applicationId ?? "",
    "application.name": subscription?.applicationName ?? "",
    "product.id": subscription?.productId ?? "",
    "product.name": subscription?.productName ?? "",
    "resource.name": route.resourceName,
    "revision.rev": String(route.rev),
    environment: deps.table.environment,
    "route.basePath": route.basePath,
    "request.id": deps.requestId,
    "trace.id": traceIdOf(req.headers.get("traceparent")) ?? deps.requestId,
    "client.ip": deps.clientIp,
    "jwt.sub": identity?.method === "jwt" ? identity.subject : "",
    "cert.subject.cn": clientCertificate?.cn ?? "",
    "cert.issuer": clientCertificate?.issuer ?? "",
    "cert.thumbprint": clientCertificate?.thumbprint ?? "",
  };
  for (const [name, value] of url.searchParams) templateCtx[`query.${name}`] = value;
  for (const [claim, value] of Object.entries(identity?.claims ?? {})) {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      templateCtx[`jwt.claim.${claim}`] = String(value);
    }
  }

  // 10 — preconditions
  for (const rule of policy.preconditions ?? []) {
    if (!precondition(rule, req, url, clientCertificate, deps)) {
      return finish(
        denyResponse(rule, format, templateCtx, deps.requestId, { ...rateHeaders, ...corsOut }),
        "precondition",
        `precondition:${checkNameOf(rule)}`,
      );
    }
  }

  // The capped stream is built once and is the only reader of the request body, so the cap and
  // `bytesIn` cover every byte the SOAP scan and the RPC read see too (review V1-11).
  let upstreamBody: ReadableStream<Uint8Array> | null = hasBody ? cappedBody(req.body!) : null;
  /** Set when the body was fully read here: the only case in which a retry can replay it. */
  let bufferedBody: Bytes | null = null;
  let parsedJson: unknown;
  let parsedXmlText: string | null = null;

  // 11 — operation resolution
  const relativePath = stripBasePath(url.pathname, route.basePath);

  if (route.kind === "soap" && route.soap && upstreamBody) {
    const taken = await takePrefix(upstreamBody, limits.xml.maxPrefixBytes);
    if (taken.overCap) {
      return deny(413, `body larger than ${routeMaxBody} bytes (enforced while streaming)`, "body-too-large");
    }
    upstreamBody = taken.stream;

    let scanned;
    try {
      scanned = scanEnvelope(new TextDecoder().decode(taken.prefix), {
        maxDepth: limits.xml.maxDepth,
        maxElements: validate.always?.xml?.maxElements ?? limits.xml.maxElements,
        maxBytes: limits.xml.maxBytes,
      });
    } catch (err) {
      const message = err instanceof XmlError ? err.message : String((err as Error).message);
      return deny(400, `the SOAP envelope was rejected: ${message}`, "soap-mismatch");
    }

    if (!scanned.bodyChild) {
      return deny(
        400,
        `no operation element was found in the first ${limits.xml.maxPrefixBytes} bytes of the envelope`,
        "soap-mismatch",
      );
    }
    const soapOperation = route.soap.operations.find((op) => op.element === scanned.bodyChild);
    if (!soapOperation) {
      return deny(
        400,
        `the envelope body element ${scanned.bodyChild} is not an operation of this API`,
        "soap-mismatch",
      );
    }
    operation = route.operations.find((op) => op.id === soapOperation.operationId) ?? null;

    // Agreement, not presence: an absent declaration and an empty one are the same thing.
    const declared = declaredAction(
      route.soap.version,
      req.headers.get("soapaction"),
      req.headers.get("content-type"),
    );
    if (!actionAgrees(declared, soapOperation.soapAction)) {
      return deny(
        400,
        `the declared action "${declared ?? ""}" disagrees with the body, which is ` +
          `${soapOperation.operationId} (action "${soapOperation.soapAction}")`,
        "soap-mismatch",
      );
    }
  } else if (
    (route.kind === "mcp" || route.kind === "a2a") &&
    !(route.kind === "mcp" && (req.method === "GET" || req.method === "DELETE"))
  ) {
    // A single-endpoint RPC protocol keeps its operation inside the body, so the body is buffered
    // here whatever the validation state — that is inherent, not a validation cost (plan [R2-03]).
    if (req.method !== "POST") {
      return deny(405, `this ${route.kind} route accepts POST`, "no-route");
    }
    const read = await readWholeBody(upstreamBody, routeMaxBody);
    if (read.overCap) {
      return deny(413, `body larger than ${routeMaxBody} bytes (enforced while streaming)`, "body-too-large");
    }
    bufferedBody = read.bytes;
    upstreamBody = null;

    const text = new TextDecoder().decode(read.bytes);
    const json = readJsonBody(text, validate);
    if ("error" in json) {
      return deny(400, `the request body is not acceptable JSON: ${json.error.message}`, "validation-rejected");
    }
    parsedJson = json.value;
    const parsed = parseRpc(json.value);
    if (!parsed.ok) return denyRpc(parsed.code, parsed.message, 400);
    rpcId = parsed.parsed.id;

    const selector =
      route.kind === "mcp"
        ? selectorFor(parsed.parsed.request.method, parsed.parsed.request.params)
        : parsed.parsed.request.method;
    operation = route.operations.find((op) => op.selector === selector) ?? null;
    if (!operation) {
      return denyRpc(
        RPC_CODES.methodNotFound,
        `"${selector}" is not an operation this API declares`,
        404,
        "rpc-unknown-method",
      );
    }
    if (route.kind === "a2a" && isStreamingMethod(parsed.parsed.request.method) && !policy.passthrough?.sse) {
      return denyRpc(
        RPC_CODES.unavailable,
        "streaming is not enabled for this route",
        503,
        "rpc-unknown-method",
      );
    }
  } else if (route.kind === "mcp") {
    // Plan section 9.2: an `mcp` base path also takes `GET` — the server→client stream — and
    // `DELETE`, which ends a session. Neither carries a JSON-RPC body, so there is no operation to
    // resolve and no params to validate; they are proxied as they arrived. Both are gated on
    // `passthrough.sse`, because the stream is the reason either exists and a route that would
    // buffer it should not offer it.
    if (!policy.passthrough?.sse) {
      return denyRpc(
        RPC_CODES.unavailable,
        `${req.method} on an mcp route opens the server→client stream or ends a session, which ` +
          "need passthrough.sse; without it this route accepts POST only",
        405,
        "no-route",
      );
    }
  } else if (route.operations.length > 0) {
    // Against the index the table compiled when this config was activated, not the raw templates.
    const matched = matchCompiled(deps.table.operationsFor(route), req.method, relativePath);
    if (matched) {
      operation = matched.operation;
      pathParams = matched.params;
      for (const [name, value] of Object.entries(pathParams)) templateCtx[`path.${name}`] = value;
    } else {
      /*
       * The contract is the whole point. SOAP refuses a body element it does not declare, and MCP
       * and A2A refuse a method they do not declare — REST used to be the one variant that let
       * anything under the base path through to the backend, unmatched and therefore unvalidated,
       * because `wantsBodyValidation` needs an operation. That made a published API a blanket proxy
       * for its backend's entire surface: an owner who declared `/pets/{petId}` was also publishing
       * `/pet/{petId}`, `/admin`, and whatever else the backend happened to answer.
       *
       * The escape hatch is the branch condition, not a flag: a route whose definition declares no
       * operations at all has no contract to enforce and still forwards everything.
       */
      return deny(
        404,
        `"${req.method} ${relativePath}" is not an operation this API declares`,
        "no-operation",
      );
    }
  }

  if (operation) {
    templateCtx["operation.id"] = operation.id;
    templateCtx["operation.method"] = operation.method;
    templateCtx["operation.template"] = operation.template;
  }

  // Per-operation policy is resolved here and overrides the route's for the units that may be
  // overridden. `auth.*` is not among them: route authentication already ran at step 6, so an
  // override could only re-authenticate or loosen the route (plan [R2-04]).
  const opPolicy = operationPolicy(policy, operation?.id ?? null);

  // Per-operation scopes, which is where design section 5's `scopeMap` belongs.
  if (jwtUnit && identity) {
    const missing = scopeMapMisses(
      jwtUnit,
      identity,
      operation?.id ?? null,
      req.method,
      operation?.template ?? null,
    );
    if (missing.length > 0) {
      return deny(403, `this operation requires the scope "${missing[0]}"`, "bad-credential");
    }
  }
  if (opPolicy.rateLimit && subscription) {
    const verdict = deps.limiter.check(
      `${subscription.id}|${route.resourceId}|op:${operation?.id ?? ""}`,
      opPolicy.rateLimit.calls,
      opPolicy.rateLimit.periodSec,
    );
    if (!verdict.allowed) {
      return deny(
        429,
        `rate limit of ${opPolicy.rateLimit.calls} calls per ${opPolicy.rateLimit.periodSec}s ` +
          `exceeded for this operation`,
        "rate-limited",
        { limit: opPolicy.rateLimit.calls, scope: "operation" },
        { ...rateHeaders, "retry-after": String(verdict.retryAfter) },
      );
    }
  }
  if (opPolicy.quota && subscription && operation) {
    const key = deps.quota.keyFor(
      subscription.id,
      "operation",
      `${route.resourceId}:${operation.id}`,
      opPolicy.quota.periodSec,
    );
    const verdict = deps.quota.check(key, opPolicy.quota.calls);
    if (!verdict.allowed) {
      return deny(
        403,
        `the fleet quota for this operation is exhausted`,
        "quota-exceeded",
        { limit: opPolicy.quota.calls, resetSec: verdict.resetSec },
        rateHeaders,
      );
    }
  }

  const effectiveValidate: ValidateUnit = { ...validate, ...(opPolicy.validate ?? {}) };
  const artifact = artifactFor(deps, route);

  // 12 — request validation
  if (operation && operation.schemaState === "ok" && !artifact) {
    // A route whose compiled validator is unavailable fails closed, while every other route on
    // this instance serves normally (design section 8.7).
    deps.counters.unavailable();
    return deny(
      503,
      "this route's compiled validator is not available on this gateway instance, so the request " +
        "cannot be validated and is refused rather than passed through unchecked",
      "validation-unavailable",
      {},
      rateHeaders,
    );
  }

  if (artifact && operation && effectiveValidate.headers !== false) {
    const result = validateParameters({
      artifact,
      operationId: operation.id,
      pathParams,
      query: url.searchParams,
      headers: req.headers,
    });
    if (!result.ok) {
      const state = effectiveValidate.request ?? "blocking";
      if (state === "blocking") {
        deps.counters.rejected();
        logValidation(deps, route, operation, subscription, "blocking", "rejected", "request", result);
        return deny(400, validationDetail(result), "validation-rejected", { errors: result.issues }, rateHeaders);
      }
      if (state === "warning") {
        deps.counters.observed();
        logValidation(deps, route, operation, subscription, "warning", "observed", "request", result);
      }
    }
  }

  const requestState = effectiveValidate.request ?? "blocking";
  const wantsBodyValidation =
    artifact !== null &&
    operation !== null &&
    operation.schemaState === "ok" &&
    effectiveValidate.body !== false &&
    requestState !== "disabled";

  /**
   * The `always` block's structural limits — depth, array length, duplicate keys — are not part of
   * any state (plan section 6.3). They hold in `blocking`, `warning` and `disabled` alike, because
   * they are not schema checks: they bound what this process will do with a document, and they are
   * what makes this gateway's reading of a body the same reading the backend will get.
   *
   * The consequence is that a JSON body is read once whatever the state, so `disabled` means "no
   * schema work", not "no work". The cost is bounded by `always.maxBodyBytes` and charged against
   * the same budget, for the same reason: the memory is the same memory.
   */
  // A request with no body has nothing for either check to read. A `GET` is not an empty document.
  const hasRequestBody = upstreamBody !== null || bufferedBody !== null;
  const needsAlwaysScan =
    // SOAP goes through `shared/xml.ts`, which enforces the XML half at the envelope scan; an RPC
    // route has already been read as JSON to find its method.
    route.kind !== "soap" &&
    route.kind !== "mcp" &&
    route.kind !== "a2a" &&
    hasRequestBody &&
    matchesMedia(mediaTypeOf(req.headers.get("content-type")), JSON_MEDIA);
  // `kafkaProduce` wraps the whole body in the REST Proxy's record envelope at step 13, so it has to
  // be read here, under the same cap and budget as every other buffered body — never around them.
  const kafkaNeedsBody =
    policy.kafkaProduce !== undefined &&
    matchesMedia(mediaTypeOf(req.headers.get("content-type")), JSON_MEDIA);

  if (
    hasRequestBody &&
    (needsAlwaysScan || kafkaNeedsBody || (wantsBodyValidation && requestState === "blocking"))
  ) {
    if (!bufferedBody) {
      const reserved = deps.budget.tryReserve(routeMaxBody);
      if (!reserved) {
        deps.counters.budgetShed();
        return deny(
          503,
          "this gateway is at its body-buffer ceiling; the request was shed rather than passed " +
            "through without the checks its route requires",
          "validate-budget",
          {},
          { ...rateHeaders, "retry-after": "1" },
        );
      }
      try {
        const read = await readWholeBody(upstreamBody, routeMaxBody);
        if (read.overCap) {
          return deny(413, `body larger than ${routeMaxBody} bytes (enforced while streaming)`, "body-too-large");
        }
        bufferedBody = read.bytes;
        upstreamBody = null;
      } finally {
        deps.budget.release(routeMaxBody);
      }
    }

    if (needsAlwaysScan && bufferedBody.byteLength > 0) {
      const read = readJsonBody(new TextDecoder().decode(bufferedBody), effectiveValidate);
      if ("error" in read) {
        // A 400 in every state. There is no state in which the gateway proceeds with a document it
        // has decided it cannot read the same way as the backend.
        const outcome: ValidationOutcome = { ok: false, issues: [read.error], truncated: false };
        deps.counters.rejected();
        // Logged as `blocking` whatever the state, because that is what it did: the always block
        // is not a mode, and reporting it as "observed" would misdescribe a rejected request.
        logValidation(deps, route, operation, subscription, "blocking", "rejected", "request", outcome);
        return deny(400, validationDetail(outcome), "validation-rejected", { errors: outcome.issues }, rateHeaders);
      }
    }
  }

  if (wantsBodyValidation && bufferedBody !== null) {
    if (requestState === "blocking") {
      const outcome = validateRequestBody(deps, route, operation!, artifact!, bufferedBody, req, effectiveValidate);
      if (!outcome.ok) {
        deps.counters.rejected();
        logValidation(deps, route, operation, subscription, "blocking", "rejected", "request", outcome);
        return deny(400, validationDetail(outcome), "validation-rejected", { errors: outcome.issues }, rateHeaders);
      }
    } else if (requestState === "warning") {
      // The schema check is queued and the request proceeds: nothing about the response changes,
      // which is asserted by comparing it against the same call with validation disabled.
      const sample = effectiveValidate.sample;
      const key = deps.sampler.key(operation!.id, subscription?.id ?? null, sample?.key);
      const shouldSample = deps.sampler.decide(
        key,
        deps.requestId,
        {
          rate: sample?.rate ?? 0.1,
          coldStart: sample?.coldStart ?? 20,
          alwaysUnderBytes: sample?.alwaysUnderBytes ?? 65_536,
        },
        bufferedBody.byteLength,
      );
      if (shouldSample) {
        const copy = bufferedBody;
        const accepted = deps.pool.submit({
          run: () => {
            const outcome = validateRequestBody(
              deps,
              route!,
              operation!,
              artifact!,
              copy,
              req,
              effectiveValidate,
            );
            if (!outcome.ok) {
              deps.counters.observed();
              deps.sampler.escalate(key, sample?.onFailureEscalateSec ?? 300);
              logValidation(deps, route!, operation, subscription, "warning", "observed", "request", outcome);
            }
          },
        });
        if (!accepted) deps.counters.sampleDropped();
      }
    }
  } else if (wantsBodyValidation && upstreamBody !== null && requestState === "warning") {
    // A body the always-scan did not buffer — a non-JSON media type on a route that declares a
    // schema for it. Tee'd rather than buffered, so the request is not held up.
    const sample = effectiveValidate.sample;
    const key = deps.sampler.key(operation!.id, subscription?.id ?? null, sample?.key);
    const declared = Number(req.headers.get("content-length") ?? "0");
    const shouldSample = deps.sampler.decide(
      key,
      deps.requestId,
      {
        rate: sample?.rate ?? 0.1,
        coldStart: sample?.coldStart ?? 20,
        alwaysUnderBytes: sample?.alwaysUnderBytes ?? 65_536,
      },
      Number.isFinite(declared) ? declared : 0,
    );
    if (shouldSample) {
      const tee = await teeBody(upstreamBody, bufferedBody, routeMaxBody);
      upstreamBody = tee.forward;
      if (tee.copy) {
        const copy = tee.copy;
        const accepted = deps.pool.submit({
          run: () => {
            const outcome = validateRequestBody(
              deps,
              route!,
              operation!,
              artifact!,
              copy,
              req,
              effectiveValidate,
            );
            if (!outcome.ok) {
              deps.counters.observed();
              deps.sampler.escalate(key, sample?.onFailureEscalateSec ?? 300);
              logValidation(deps, route!, operation, subscription, "warning", "observed", "request", outcome);
            }
          },
        });
        if (!accepted) deps.counters.sampleDropped();
      }
    }
  }

  /*
   * Whether this response may be carried through in whatever encoding the backend chose.
   *
   * The decision is made *here*, on the request, rather than on the response — because what makes
   * a compressed response cheap is not decoding it, and the only way to have a compressed response
   * at all is to have asked for one. Everything the test depends on is already resolved: the
   * validation state, the artifact, the operation, the transform, the cache unit and the route's
   * kind. The one thing that is not is the status, so the question asked is whether this operation
   * *could* validate a response rather than whether it will validate this one.
   *
   * `passthrough.sse` is excluded on its own merits: compressing an event stream makes the encoder
   * buffer, which is exactly the latency the stream exists to avoid.
   */
  /*
   * The request body, while a window is open. Taken as a bounded prefix rather than by buffering
   * the whole thing: what is being read is the shape of a request that went wrong, and a debugging
   * window must not turn a 40 MiB upload into 40 MiB of log. The prefix is put back in front of
   * the stream the backend reads, so capturing changes what is written down and nothing else.
   *
   * One byte more than the cap is taken, so "there was more" is a fact rather than an inference
   * from a body that happened to be exactly 8 KiB.
   */
  if (captureBodies && bufferedBody) {
    logged.requestBody = bodyExcerpt(bufferedBody);
  } else if (captureBodies && upstreamBody) {
    const taken = await takePrefix(upstreamBody, MAX_LOGGED_BODY_BYTES + 1);
    if (taken.overCap) {
      return deny(413, `body larger than ${routeMaxBody} bytes (enforced while streaming)`, "body-too-large");
    }
    logged.requestBody = bodyExcerpt(taken.prefix);
    upstreamBody = taken.stream;
  }

  const cacheUnit = opPolicy.cache ?? policy.cache;
  const passCompressed =
    // A window that is open is a window somebody has to be able to read: an excerpt of gzip is not
    // a body anybody can look at, so capturing costs the passthrough for as long as it lasts.
    !captureBodies &&
    // Only what the caller negotiated. The runtime supplies an `Accept-Encoding` of its own when a
    // request carries none, so without this test a caller that asked for nothing could be handed a
    // gzip body it never agreed to — and by the time that is visible the chance to decode it has
    // gone. A caller that asks for no encoding gets exactly what it got before this existed.
    (req.headers.get("accept-encoding") ?? "").trim().length > 0 &&
    !(effectiveValidate.response !== undefined && effectiveValidate.response !== "disabled") &&
    (policy.transform?.response ?? "none") === "none" &&
    route.kind !== "mcp" &&
    route.kind !== "a2a" &&
    !(cacheUnit && isCacheable(req.method)) &&
    !policy.passthrough?.sse;

  // 13 — rewrite
  const rewrite = policy.rewrite;
  /*
   * The base path is the *gateway's* address for this API, not the backend's, so it comes off
   * before the backend is called — `/business-support/events/orders/v1/pets` on a backend of
   * `https://petstore.swagger.io/v2` is `GET /v2/pets`, not `/v2/business-support/events/…`.
   *
   * This defaulted to `false`, which meant an API published with no `rewrite` unit forwarded the
   * whole public path and every backend answered 404 for a URL it had never heard of. Nothing
   * chose that: `POLICY_CATALOG`'s own `defaultValue` for the unit is `{ stripBasePath: true }`,
   * every API in the perf and capacity harnesses sets it, and 56 places across the test suite set
   * it — a flag that every caller has to turn on is a default that is the wrong way round.
   * `stripBasePath: false` is still the opt-out, for a backend mounted at the same path the
   * gateway publishes.
   */
  const strip = rewrite?.stripBasePath ?? true;
  let path = strip ? relativePath : url.pathname;
  if (rewrite?.path) {
    const rendered = renderPathTemplate(rewrite.path, pathParams);
    path = strip ? rendered : `${route.basePath === "/" ? "" : route.basePath}${rendered}`;
  }

  /*
   * 13 and 15 at once, for `kafkaProduce`: the upstream call is a Confluent REST Proxy v3 produce,
   * so the unit writes its path, method and body outright (api-policy-controls, "Produce to Kafka
   * through the Confluent REST Proxy"). It sits here rather than earlier so request validation at
   * 12 has already judged the *caller's* body against the API's own schema; what the proxy
   * receives is an envelope nobody's definition describes. `validateDocument` refuses `rewrite`
   * and `transform` beside it, so nothing above is being overridden that anybody wrote.
   */
  let upstreamMethod = req.method;
  const kafka = policy.kafkaProduce;
  if (kafka) {
    const topic = operation ? pathParams.topic : undefined;
    if (topic === undefined || topic === "") {
      return deny(
        500,
        "this route produces to Kafka, and its contract has no {topic} path parameter to take the " +
          "topic from — the API's definition needs an operation like POST /topics/{topic}",
        "route-misconfigured",
        {},
        rateHeaders,
      );
    }
    const media = mediaTypeOf(req.headers.get("content-type"));
    if (!matchesMedia(media, JSON_MEDIA)) {
      return deny(
        415,
        `this route produces a JSON record, so it accepts application/json (got "${media || "nothing"}")`,
        "content-type",
        {},
        rateHeaders,
      );
    }
    // Read with the route's own JSON limits, so the record is the document the always block agreed
    // to — and an empty body is refused here rather than produced as a record with no value.
    const read = readJsonBody(new TextDecoder().decode(bufferedBody ?? new Uint8Array()), effectiveValidate);
    if ("error" in read) {
      return deny(
        400,
        `the request body is not acceptable JSON: ${read.error.message}`,
        "validation-rejected",
        {},
        rateHeaders,
      );
    }
    const envelope = JSON.stringify({ value: { type: "JSON", data: read.value } });
    // Buffered, so a retry can replay it exactly as it could the caller's own body.
    bufferedBody = new TextEncoder().encode(envelope) as Bytes;
    upstreamBody = null;
    upstreamMethod = "POST";
    path = `/v3/clusters/${kafka.clusterId}/topics/${encodeURIComponent(topic)}/records`;
  }

  const params = new URLSearchParams(
    rewrite?.path && rewrite.copyUnmatchedParams === false ? "" : url.search,
  );
  if (keyUnit?.in === "query" && !keyUnit.forwardCredentials) params.delete(keyUnit.name);
  for (const name of rewrite?.query?.remove ?? []) params.delete(name);
  for (const [name, value] of Object.entries(rewrite?.query?.set ?? {})) {
    params.set(name, render(value, templateCtx));
  }
  const renderedQuery = params.toString();
  let query = renderedQuery ? `?${renderedQuery}` : "";

  // 14 — request headers
  const outHeaders = new Headers();
  for (const [name, value] of req.headers) {
    if (!HOP_BY_HOP.has(name.toLowerCase())) outHeaders.set(name, value);
  }
  outHeaders.delete("host");
  outHeaders.delete("content-length");
  /*
   * Kept as the caller wrote it when the response will be carried through as it arrives.
   *
   * Otherwise it is set to `identity` rather than deleted, which is the correction to an
   * assumption this line used to carry. Deleting it does not mean "do not compress": the runtime
   * supplies an `Accept-Encoding` of its own when a request has none, so the backend compressed,
   * the runtime expanded it again, and both machines paid for an encoding nobody wanted. Saying
   * `identity` is how a proxy that has to read the body asks for one it can read.
   */
  if (!passCompressed) outHeaders.set("accept-encoding", "identity");

  /*
   * W3C Trace Context. The backend is handed a `traceparent` naming *this* hop as its parent, so
   * the call it makes onward joins the same trace — which is what makes one identifier follow a
   * request across the portal, this gateway and whatever the backend calls next. `tracestate` is
   * vendor data this gateway carries and never reads, and only when the trace was continued: it
   * belongs to a trace, so attaching it to one started here would be a claim about somebody else's
   * call.
   */
  outHeaders.set("traceparent", trace.header);
  const traceState = traceStateFor(trace, req.headers.get("tracestate"));
  if (traceState) outHeaders.set("tracestate", traceState);
  else outHeaders.delete("tracestate");

  if (keyUnit && !keyUnit.forwardCredentials && keyUnit.in === "header") outHeaders.delete(keyUnit.name);
  // The inbound Authorization belongs to this gateway's auth, not the backend's. A route with no
  // auth unit does not own the credential, so it is left alone there.
  const ownsAuthorization = Boolean(keyUnit || basicUnit || jwtUnit || introspectionUnit);
  const forwards =
    (keyUnit?.forwardCredentials ?? false) ||
    (basicUnit?.forwardCredentials ?? false) ||
    (jwtUnit?.forwardCredentials ?? false) ||
    (introspectionUnit?.forwardCredentials ?? false);
  if (ownsAuthorization && !forwards) outHeaders.delete("authorization");

  const headerRules = policy["headers.request"];
  for (const name of headerRules?.remove ?? []) outHeaders.delete(name);
  for (const [name, value] of Object.entries(headerRules?.set ?? {})) {
    outHeaders.set(name, render(value, templateCtx));
  }
  for (const [name, value] of Object.entries(headerRules?.append ?? {})) {
    outHeaders.append(name, render(value, templateCtx));
  }
  for (const [name, value] of Object.entries(headerRules?.skip ?? {})) {
    if (!outHeaders.has(name)) outHeaders.set(name, render(value, templateCtx));
  }
  // After the rules, not before: the body is the unit's envelope, and its media type is part of it.
  // The caller's `+json` subtype described the caller's document, not the REST Proxy's.
  if (kafka) outHeaders.set("content-type", "application/json");

  if (deps.trustedPeer) {
    // Append the address this hop received from — the proxy — so the chain reads
    // `client, …, proxy`. `clientIp` is already inside it, put there by that proxy.
    const inbound = req.headers.get("x-forwarded-for");
    const peer = deps.peerIp ?? deps.clientIp;
    outHeaders.set("x-forwarded-for", inbound ? `${inbound}, ${peer}` : peer);
  } else {
    // Not behind a trusted proxy: an inbound X-Forwarded-For is a claim, not evidence.
    outHeaders.set("x-forwarded-for", deps.clientIp);
  }
  outHeaders.set("x-forwarded-proto", url.protocol.replace(":", ""));
  outHeaders.set("x-forwarded-host", req.headers.get("host") ?? "");
  outHeaders.set("x-request-id", deps.requestId);

  // WebSocket: the whole request-side pipeline has run; hand the connection over.
  if (policy.passthrough?.websocket && req.headers.get("upgrade")?.toLowerCase() === "websocket") {
    const admission = deps.streams.admit(route.resourceId, policy.passthrough);
    if (admission !== "ok") {
      return deny(
        503,
        admission === "route-full"
          ? "this route is at its concurrent-connection ceiling"
          : "this gateway instance is at its concurrent-stream ceiling",
        admission === "route-full" ? "upgrade-rejected" : "upgrade-saturated",
        {},
        { ...rateHeaders, "retry-after": "5" },
      );
    }
    const backend = firstBackend(deps, route);
    if (!backend) return deny(503, "every backend for this route is unavailable", "pool-open", {}, rateHeaders);
    const target = joinBackend(backend.url, path, query).replace(/^http/, "ws");
    const wsHeaders: Record<string, string> = {};
    for (const [name, value] of outHeaders) {
      if (name === "sec-websocket-key" || name === "sec-websocket-version" || name === "upgrade") continue;
      wsHeaders[name] = value;
    }
    return {
      kind: "upgrade",
      target,
      headers: wsHeaders,
      resourceId: route.resourceId,
      resourceName: route.resourceName,
      subscriptionId: subscription?.id ?? null,
      applicationId: subscription?.applicationId ?? null,
      requestId: deps.requestId,
      passthrough: policy.passthrough,
      startedMs: Date.now(),
      clientIp: deps.clientIp,
    };
  }

  // 16 — cache lookup
  let cacheKey: string | null = null;
  if (cacheUnit && isCacheable(req.method)) {
    cacheKey = cacheKeyFor({
      configDigest: deps.table.digest,
      routeId: route.resourceId,
      method: req.method,
      pathAndQuery: url.pathname + url.search,
      subscriptionId: subscription?.id ?? null,
      vary: cacheUnit.vary ?? [],
      headers: req.headers,
      unit: cacheUnit,
    });
    const hit = deps.cache.get(cacheKey);
    if (hit) {
      const headers = new Headers(hit.headers);
      for (const [name, value] of Object.entries(rateHeaders)) headers.set(name, value);
      headers.set("age", String(Math.floor((Date.now() - hit.storedAtMs) / 1000)));
      headers.set("x-cache", "hit");
      return finish(new Response(hit.body, { status: hit.status, headers }), "cache-hit");
    }
  }

  // 17 — backend select, 18 — backend auth, 19 — proxy
  const timeoutMs = opPolicy.timeoutMs ?? policy.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const deadlineAt = Date.now() + timeoutMs;
  const breakerSettings = breakerOf(route);
  const order = selectionOrder(route.backend.pool, route.backend.rule, deps.table.nextCursor(route.resourceId), (backendUrl) =>
    deps.breaker.state(`${route!.resourceId}|${backendUrl}`, breakerSettings) !== "open",
  );
  if (order.length === 0) {
    return deny(503, "this route has no backend configured", "backend-unreachable", {}, rateHeaders);
  }

  const retries = policy.retries;
  const maxAttempts = retries
    ? // The method the backend receives, which is what a replay repeats: a Kafka produce is a POST
      // whatever the caller sent.
      retries.idempotentOnly !== false && !isIdempotent(upstreamMethod)
      ? 1
      : // A body that was streamed cannot be replayed, so only a request with no body, or one that
        // blocking validation already buffered, can be retried past the first attempt (plan [R1-11]).
        upstreamBody !== null
        ? 1
        : Math.min(retries.attempts + 1, order.length + 1)
    : 1;

  const gate = deps.gate;
  const concurrency = policy.concurrency;
  const admission = gate ? gate.tryAcquire(route.resourceId, concurrency?.maxInFlight) : "ok";
  if (admission !== "ok") {
    const retryAfter = String(concurrency?.retryAfterSec ?? 1);
    return deny(
      503,
      admission === "route-saturated"
        ? `this route already has ${concurrency?.maxInFlight} requests in flight to its backends on ` +
            "this instance; the request was shed rather than queued"
        : "this gateway instance is at its concurrent-request ceiling; the request was shed rather than queued",
      admission,
      admission === "route-saturated"
        ? { maxInFlight: concurrency?.maxInFlight, scope: "route" }
        : { maxInFlight: gate?.maxTotal, scope: "instance" },
      { ...rateHeaders, "retry-after": retryAfter },
    );
  }

  const clientGone = req.signal;
  const doFetch = deps.fetchImpl ?? fetch;
  let upstream: Response | null = null;
  let lastError: { status: number; detail: string; outcome: Outcome; backend: string } | null = null;
  let usedBackend: BackendEntry | null = null;
  let backendAuthKey: string | null = null;

  try {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const entry = order[Math.min(attempt, order.length - 1)]!;
      const breakerKey = `${route.resourceId}|${entry.url}`;
      if (!deps.breaker.tryAcquire(breakerKey, breakerSettings)) {
        lastError = {
          status: 503,
          detail: `the circuit breaker is open for ${new URL(entry.url).origin}`,
          outcome: "pool-open",
          backend: entry.url,
        };
        continue;
      }
      usedBackend = entry;

      const auth = await applyBackendAuth(
        policy.backendAuth,
        {
          method: upstreamMethod,
          operationTemplate: operation?.template ?? relativePath,
          references: deps.table.references,
        },
        deps.tokens,
      );
      if (!auth.ok) {
        deps.breaker.onSuccess(breakerKey, breakerSettings);
        return deny(auth.status, auth.detail, "backend-unreachable", {}, rateHeaders);
      }
      backendAuthKey = tokenCacheKey(policy.backendAuth ?? { type: "none" });
      const attemptHeaders = new Headers(outHeaders);
      for (const [name, value] of Object.entries(auth.headers)) attemptHeaders.set(name, value);
      let attemptQuery = query;
      if (auth.query) {
        const merged = new URLSearchParams(renderedQuery);
        for (const [name, value] of Object.entries(auth.query)) merged.set(name, value);
        attemptQuery = merged.toString() ? `?${merged.toString()}` : "";
      }

      // The timeout is the WHOLE-request budget: each attempt gets what remains, so `attempts`
      // does not multiply the worst case a caller waits (plan [R1-12]).
      const remaining = deadlineAt - Date.now();
      if (remaining <= 0) {
        lastError = {
          status: 504,
          detail: `the backend did not respond within ${timeoutMs}ms`,
          outcome: "backend-timeout",
          backend: entry.url,
        };
        break;
      }

      const target = joinBackend(entry.url, path, attemptQuery);
      const deadline = AbortSignal.timeout(remaining);
      const init: RequestInit & { duplex?: "half"; tls?: unknown; decompress?: boolean } = {
        method: upstreamMethod,
        headers: attemptHeaders,
        redirect: "manual",
        signal: clientGone ? AbortSignal.any([clientGone, deadline]) : deadline,
        // The runtime decodes a compressed response by default, which is right when the gateway
        // has to read it and pure cost when it does not.
        ...(passCompressed ? { decompress: false } : {}),
      };
      const tls = tlsOptionsFor(route, entry.url, deps);
      if (tls) init.tls = tls;
      if (bufferedBody) init.body = bufferedBody;
      else if (upstreamBody) {
        init.body = upstreamBody;
        init.duplex = "half";
      }

      const attemptStarted = performance.now();
      try {
        const response = await doFetch(target, init);
        // Headers and status, not the whole body: the same boundary the bulkhead releases on, and
        // the one an operator means by "how long did the backend take". Fractional, because it is
        // subtracted from a fractional total to produce this gateway's own cost.
        logged.backendMs = roundMs(performance.now() - attemptStarted);
        if (isRetryable(response.status, retries) && attempt + 1 < maxAttempts) {
          deps.breaker.onFailure(breakerKey, breakerSettings);
          lastError = {
            status: response.status,
            detail: `the backend answered ${response.status}`,
            outcome: "upstream-error",
            backend: entry.url,
          };
          // The body is drained so the connection can be reused for the next attempt.
          await response.body?.cancel().catch(() => {});
          continue;
        }
        if (response.status >= 500 && retries?.on.includes(String(response.status) as never)) {
          deps.breaker.onFailure(breakerKey, breakerSettings);
        } else {
          deps.breaker.onSuccess(breakerKey, breakerSettings);
        }
        upstream = response;
        break;
      } catch (err) {
        if (bodyOverCap) {
          return deny(413, `body larger than ${routeMaxBody} bytes (enforced while streaming)`, "body-too-large");
        }
        // Which signal fired decides what this was: a caller that left is not a backend that was
        // slow, and counting it as one would put 504s in the dashboard for requests nobody awaited.
        if (clientGone?.aborted) {
          deps.breaker.onSuccess(breakerKey, breakerSettings);
          return deny(
            499,
            "the client disconnected before the backend answered; the upstream call was abandoned too",
            "client-gone",
            { backend: new URL(entry.url).origin },
            rateHeaders,
          );
        }
        const error = err as Error;
        const timedOut = error.name === "TimeoutError" || error.name === "AbortError";
        logged.backendMs = roundMs(performance.now() - attemptStarted);
        /*
         * The transport's own words, kept whole and kept whatever the body window says.
         *
         * A refused connection, a reset, a TLS handshake that failed on a name or an expired
         * certificate, a DNS answer that did not come: these are the failures where the response
         * the caller sees ("could not reach the backend") is the least useful sentence anybody
         * has, and the runtime's message — `ECONNREFUSED`, `CERT_HAS_EXPIRED`, a hostname
         * mismatch — is the one that ends the investigation. `cause` carries it when the error
         * itself is a wrapper, which is what a TLS failure usually arrives as.
         */
        const cause = (error as { cause?: unknown }).cause;
        const causeText =
          cause instanceof Error ? `: ${cause.message}` : typeof cause === "string" ? `: ${cause}` : "";
        logged.failure = `${error.name}: ${error.message}${causeText} (backend ${new URL(entry.url).origin})`;
        deps.breaker.onFailure(breakerKey, breakerSettings);
        lastError = {
          status: timedOut ? 504 : 502,
          detail: timedOut
            ? `the backend did not respond within ${timeoutMs}ms`
            : `could not reach the backend: ${error.message}`,
          outcome: timedOut ? "backend-timeout" : "backend-unreachable",
          backend: entry.url,
        };
        const canRetry =
          attempt + 1 < maxAttempts &&
          (retries?.on.includes(timedOut ? "timeout" : "connect") ?? false);
        if (!canRetry) break;
      }
    }
  } finally {
    // Released once the upstream has answered with its status and headers — the part a sick
    // backend uses to accumulate work here. Streaming the body afterwards is bounded by the same
    // signal, which aborts a trickling body too.
    if (gate) gate.release(route.resourceId);
  }

  if (!upstream) {
    const reopens = usedBackend
      ? Math.ceil(deps.breaker.reopensInMs(`${route.resourceId}|${usedBackend.url}`, breakerSettings) / 1000)
      : 1;
    const failure = lastError ?? {
      status: 503,
      detail: "no backend accepted the request",
      outcome: "pool-open" as Outcome,
      backend: "",
    };
    const headers =
      failure.outcome === "pool-open"
        ? { ...rateHeaders, "retry-after": String(Math.max(1, reopens)) }
        : rateHeaders;
    return deny(
      failure.status,
      failure.detail,
      failure.outcome,
      failure.backend ? { backend: new URL(failure.backend).origin } : {},
      headers,
    );
  }

  backendStatus = upstream.status;

  // 22 — backend-auth invalidation. Invalidate, never retry: the next request gets a fresh token.
  if (
    backendAuthKey &&
    policy.backendAuth?.type === "oauth2-client-credentials" &&
    (policy.backendAuth.invalidateOnStatus ?? [401, 403]).includes(upstream.status)
  ) {
    deps.tokens.invalidate(backendAuthKey);
  }

  // 20/21 — response
  const responseHeaders = new Headers();
  for (const [name, value] of upstream.headers) {
    if (!HOP_BY_HOP.has(name.toLowerCase())) responseHeaders.set(name, value);
  }
  if (passCompressed) {
    // Nothing was decoded, so the upstream's framing headers describe the body being forwarded and
    // travel as they arrived. `Vary` is the correctness half: without it an intermediary that
    // cached this answer could hand a gzip body to a caller that never asked for one.
    if (responseHeaders.has("content-encoding")) {
      const vary = responseHeaders.get("vary");
      const already = (vary ?? "")
        .split(",")
        .some((value) => value.trim().toLowerCase() === "accept-encoding");
      if (!already) responseHeaders.set("vary", vary ? `${vary}, Accept-Encoding` : "Accept-Encoding");
    }
  } else {
    // The body reaching us is already decoded, so the upstream's framing headers would be a lie.
    responseHeaders.delete("content-encoding");
    responseHeaders.delete("content-length");
  }
  for (const [name, value] of Object.entries(rateHeaders)) responseHeaders.set(name, value);
  for (const [name, value] of Object.entries(lifecycleHeaders(route))) responseHeaders.set(name, value);
  for (const [name, value] of Object.entries(corsOut)) responseHeaders.set(name, value);

  const responseRules = policy["headers.response"];
  for (const name of responseRules?.remove ?? []) responseHeaders.delete(name);
  for (const [name, value] of Object.entries(responseRules?.set ?? {})) {
    responseHeaders.set(name, render(value, templateCtx));
  }
  for (const [name, value] of Object.entries(responseRules?.append ?? {})) {
    responseHeaders.append(name, render(value, templateCtx));
  }
  for (const [name, value] of Object.entries(responseRules?.skip ?? {})) {
    if (!responseHeaders.has(name)) responseHeaders.set(name, render(value, templateCtx));
  }
  responseHeaders.set("x-request-id", deps.requestId);

  const status = upstream.status;
  const responseState = effectiveValidate.response ?? "disabled";
  const transform = policy.transform?.response ?? "none";
  /**
   * A single-endpoint RPC protocol keeps its *outcome* in the body as well as its operation: a
   * tool answering "no" is a 200 carrying a JSON-RPC error. Recording that as `upstream-error`
   * would blame the gateway's backend for working correctly, so the body is read here (plan
   * section 9.2, `[R1-13]`). It is affordable because it is bounded by the same `always` cap the
   * request side already applies — 256 KiB by default, because a JSON-RPC call is not an upload.
   */
  const rpcRoute = route.kind === "mcp" || route.kind === "a2a";
  const wantsResponseWork =
    (responseState !== "disabled" && artifact && operation && operation.schemaState === "ok") ||
    transform === "soap-to-json" ||
    rpcRoute ||
    (cacheKey !== null && status >= 200 && status < 300);

  // SSE: stream, and skip everything on the response side that would have to buffer.
  if (policy.passthrough?.sse && isEventStream(responseHeaders)) {
    const admission = deps.streams.admit(route.resourceId, policy.passthrough);
    if (admission !== "ok") {
      await upstream.body?.cancel().catch(() => {});
      return deny(
        503,
        admission === "route-full"
          ? "this route is at its concurrent-connection ceiling"
          : "this gateway instance is at its concurrent-stream ceiling",
        admission === "route-full" ? "upgrade-rejected" : "upgrade-saturated",
        {},
        { ...rateHeaders, "retry-after": "5" },
      );
    }
    // Stamped with the time to the *first* byte, which for a stream is the only latency this
    // gateway is responsible for: everything after it is the backend's pace, not ours.
    stamp(responseHeaders, elapsed());
    const counted = emit(status, "ok", 0);
    if (!upstream.body) return new Response(null, { status, headers: responseHeaders });
    const supervised = superviseSse(
      upstream.body,
      policy.passthrough,
      deps.streams,
      { resourceId: route.resourceId, subscriptionId: subscription?.id ?? null },
      (reason, bytes) => {
        counted?.addBytesOut(bytes);
        deps.log?.({
          ts: logTimestamp(),
          requestId: deps.requestId,
          kind: "sse",
          resourceId: route!.resourceId,
          subscriptionId: subscription?.id ?? null,
          bytesOut: bytes,
          closeReason: reason,
        });
      },
    );
    return new Response(supervised, { status, headers: responseHeaders });
  }

  if (!wantsResponseWork) {
    // Streamed to the caller, so the excerpt is taken the same way the request's was: a bounded
    // prefix, put back in front of the stream that is forwarded.
    let outStream: ReadableStream<Uint8Array<ArrayBufferLike>> | null = upstream.body;
    if (captureBodies && outStream) {
      const taken = await takePrefix(outStream, MAX_LOGGED_BODY_BYTES + 1);
      // `overCap` on a response means the read itself threw — the upstream body broke mid-flight.
      // Answered as the failure it is rather than by dropping the stream, which handed the caller a
      // clean `200` with an empty body: a backend that died halfway through would have looked like
      // one that succeeded and had nothing to say, and only on the routes an administrator had
      // opened a capture window on.
      if (taken.overCap) {
        logged.responseBody = bodyExcerpt(taken.prefix);
        return deny(
          502,
          "the backend's response body ended before it was complete",
          "upstream-error",
          {},
          rateHeaders,
        );
      }
      logged.responseBody = bodyExcerpt(taken.prefix);
      outStream = taken.stream;
    }
    const outcome: Outcome = status >= 400 ? "upstream-error" : "ok";
    const durationMs = elapsed();
    stamp(responseHeaders, durationMs);
    writeLog({ status, outcome, durationMs });
    const counted = emit(status, outcome, 0, durationMs);
    if (!outStream) return new Response(null, { status, headers: responseHeaders });
    if (!counted) return new Response(outStream, { status, headers: responseHeaders });
    const declared = declaredBodyBytes(upstream, passCompressed);
    if (declared !== null) {
      counted.addBytesOut(declared);
      return new Response(outStream, { status, headers: responseHeaders });
    }
    return new Response(countingStream(outStream, (bytes) => counted.addBytesOut(bytes)), {
      status,
      headers: responseHeaders,
    });
  }

  // Blocking response validation, the transform, the cache and the JSON-RPC outcome all need the
  // whole body. That makes such a route not a streaming route, which the schema already refuses to
  // combine with SSE.
  const cap = Math.min(effectiveValidate.always?.maxBodyBytes ?? deps.maxBodyBytes, deps.maxBodyBytes);
  const reserved = responseState === "blocking" ? deps.budget.tryReserve(cap) : true;
  if (!reserved) {
    deps.counters.budgetShed();
    await upstream.body?.cancel().catch(() => {});
    return deny(
      502,
      "this gateway is at its blocking-validation buffer ceiling, so the response could not be " +
        "validated and is refused rather than passed through unchecked",
      "validate-budget",
      {},
      rateHeaders,
    );
  }

  let bodyBytes: Bytes;
  try {
    const read = await readResumable(upstream.body, cap);
    if (read.overCap) {
      if (responseState === "blocking") {
        deps.counters.budgetShed();
        await read.rest?.cancel().catch(() => {});
        return deny(
          502,
          `the backend's response is larger than ${cap} bytes, so it could not be validated`,
          "validate-budget",
          {},
          rateHeaders,
        );
      }
      // Not blocking: the *sample* is dropped and counted, not the response (plan `[R2-18]`). A
      // body too large to inspect is not a body too large to deliver, so what was read is put
      // back in front of the rest and the whole thing is streamed on — unvalidated, uncached,
      // and with the JSON-RPC outcome unclassified, all of which are counted rather than silent.
      deps.counters.sampleDropped();
      const outcome: Outcome = status >= 400 ? "upstream-error" : "ok";
      const durationMs = elapsed();
      stamp(responseHeaders, durationMs);
      writeLog({ status, outcome, durationMs });
      const counted = emit(status, outcome, 0, durationMs);
      if (!read.rest) return new Response(null, { status, headers: responseHeaders });
      const rest = counted
        ? countingStream(read.rest, (bytes) => counted.addBytesOut(bytes))
        : read.rest;
      return new Response(rest, { status, headers: responseHeaders });
    }
    bodyBytes = read.bytes;
  } finally {
    if (responseState === "blocking") deps.budget.release(cap);
  }

  if (responseState !== "disabled" && artifact && operation && operation.schemaState === "ok") {
    const outcome = validateResponse(deps, artifact, operation, status, bodyBytes, responseHeaders, effectiveValidate);
    if (!outcome.ok) {
      if (responseState === "blocking") {
        deps.counters.rejected();
        logValidation(deps, route, operation, subscription, "blocking", "rejected", "response", outcome);
        return deny(
          502,
          `the backend's response does not match this API's contract: ${validationDetail(outcome)}`,
          "validation-rejected",
          { errors: outcome.issues },
          rateHeaders,
        );
      }
      deps.counters.observed();
      logValidation(deps, route, operation, subscription, "warning", "observed", "response", outcome);
    }
  }

  // 20 (second half) — the transform runs AFTER validation: the declared schema describes what the
  // backend sends, not what we hand on.
  let outBody: Bytes = bodyBytes;
  if (transform === "soap-to-json") {
    const converted = soapToJson(new TextDecoder().decode(bodyBytes), {
      maxDepth: limits.xml.maxDepth,
      maxElements: limits.xml.maxElements,
      maxBytes: limits.xml.maxBytes,
    });
    if (converted.ok) {
      outBody = new TextEncoder().encode(JSON.stringify(converted.value));
      responseHeaders.set("content-type", "application/json; charset=utf-8");
    }
  }

  responseHeaders.set("content-length", String(outBody.byteLength));

  // 23 — cache store
  if (cacheKey && cacheUnit && status >= 200 && status < 300) {
    const maxCacheBody = cacheUnit.maxBodyBytes ?? 1024 * 1024;
    if (outBody.byteLength <= maxCacheBody) {
      const control = downstreamCacheControl(cacheUnit);
      if (control) responseHeaders.set("cache-control", control);
      deps.cache.set(cacheKey, {
        status,
        headers: [...responseHeaders].filter(([name]) => name !== "age" && name !== "x-cache"),
        body: outBody,
        storedAtMs: Date.now(),
        expiresAtMs: Date.now() + cacheUnit.ttlSec * 1000,
      });
      responseHeaders.set("x-cache", "miss");
    }
  }

  const finalOutcome: Outcome =
    status >= 400
      ? "upstream-error"
      : rpcRoute && rpcErrorInBody(bodyBytes, responseHeaders)
        ? "rpc-error"
        : "ok";
  if (captureBodies) logged.responseBody = bodyExcerpt(outBody);
  const finalDurationMs = elapsed();
  stamp(responseHeaders, finalDurationMs);
  writeLog({ status, outcome: finalOutcome, durationMs: finalDurationMs });
  emit(status, finalOutcome, outBody.byteLength, finalDurationMs);
  return new Response(outBody, { status, headers: responseHeaders });

  // ------------------------------------------------------------------ local helpers

  function denyRpc(code: number, message: string, status: number, outcome: Outcome = "validation-rejected") {
    void code;
    return deny(status, message, outcome, {}, rateHeaders);
  }
}

// --------------------------------------------------------------------------- helpers

/** What the `always` block's JSON half applies to. Anything else is bytes we do not interpret. */
const JSON_MEDIA = ["application/json", "application/*+json"];

function matchesMedia(media: string, allowed: string[]): boolean {
  if (!media) return false;
  return allowed.some((pattern) => {
    const p = pattern.toLowerCase();
    if (p === media) return true;
    if (p === "*/*") return true;
    if (p.endsWith("/*")) return media.startsWith(p.slice(0, -1));
    // `application/*+json` covers `application/vnd.thing+json`.
    if (p.includes("*+")) {
      const suffix = p.slice(p.indexOf("*") + 1);
      return media.startsWith(p.slice(0, p.indexOf("*"))) && media.endsWith(suffix.slice(1));
    }
    return false;
  });
}

function traceIdOf(traceparent: string | null): string | null {
  if (!traceparent) return null;
  const parts = traceparent.split("-");
  return parts.length >= 3 && /^[0-9a-f]{32}$/.test(parts[1]!) ? parts[1]! : null;
}

function readCertificate(
  headers: Headers,
  names: PipelineDeps["clientCertHeaders"],
): ClientCertificate | null {
  const subject = headers.get(names.dn);
  if (!subject) return null;
  const verify = (headers.get(names.verify) ?? "").toUpperCase();
  const cnMatch = /(?:^|,)\s*CN=((?:\\.|[^,])*)/i.exec(subject);
  return {
    subject,
    issuer: headers.get(names.issuer) ?? "",
    cn: cnMatch ? cnMatch[1]!.replace(/\\(.)/g, "$1").trim() : "",
    sans: (headers.get(names.san) ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    thumbprint: headers.get(names.fingerprint) ?? "",
    verified: verify === "SUCCESS" || verify === "OK" || verify === "TRUE",
  };
}

function checkNameOf(rule: PreconditionRule): string {
  if (rule.requireHeader) return `header:${rule.requireHeader.name}`;
  if (rule.requireQuery) return `query:${rule.requireQuery.name}`;
  if (rule.requireClientCert) return "clientCert";
  if (rule.requireOperation) return "operation";
  return "unknown";
}

function precondition(
  rule: PreconditionRule,
  req: Request,
  url: URL,
  certificate: ClientCertificate | null,
  deps: PipelineDeps,
): boolean {
  if (rule.requireHeader) {
    return valueMatches(rule.requireHeader, req.headers.get(rule.requireHeader.name), deps.table.references);
  }
  if (rule.requireQuery) {
    return valueMatches(rule.requireQuery, url.searchParams.get(rule.requireQuery.name), deps.table.references);
  }
  if (rule.requireOperation) {
    return rule.requireOperation.methods.some((m) => m.toUpperCase() === req.method.toUpperCase());
  }
  if (rule.requireClientCert) {
    if (!certificate || !certificate.verified) return false;
    const check = rule.requireClientCert;
    if (check.issuers?.length && !check.issuers.includes(certificate.issuer)) return false;
    if (check.subjectCns?.length && !check.subjectCns.includes(certificate.cn)) return false;
    if (check.sans?.length && !certificate.sans.some((san) => check.sans!.includes(san))) return false;
    return true;
  }
  return false;
}

function rateHeadersOf(verdict: RateVerdict): Record<string, string> {
  return {
    "x-ratelimit-limit": String(verdict.limit),
    "x-ratelimit-remaining": String(verdict.remaining),
    "x-ratelimit-reset": String(verdict.reset),
  };
}

function quotaHeadersOf(verdict: { limit: number; remaining: number; resetSec: number }): Record<string, string> {
  // The design defines X-RateLimit-* for rate limiting and nothing for quota; these are an
  // extension, recorded as one rather than implied (plan `[R3-13]`).
  return {
    "x-quota-limit": String(verdict.limit),
    "x-quota-remaining": String(verdict.remaining),
    "x-quota-reset": String(verdict.resetSec),
  };
}

function applyRateLimit(
  deps: PipelineDeps,
  route: ConfigRoute,
  unit: RateLimitUnit | undefined,
  subscription: ConfigSubscription | null,
): RateVerdict | null {
  if (!unit || !subscription) return null;
  const scopeId = unit.scope === "product" ? subscription.productId : route.resourceId;
  return deps.limiter.check(`${subscription.id}|${unit.scope}|${scopeId}`, unit.calls, unit.periodSec);
}

function applyQuota(
  deps: PipelineDeps,
  route: ConfigRoute,
  unit: QuotaUnit,
  subscription: ConfigSubscription,
) {
  const scopeId = unit.scope === "product" ? subscription.productId : route.resourceId;
  const key = deps.quota.keyFor(subscription.id, unit.scope, scopeId, unit.periodSec);
  return deps.quota.check(key, unit.calls);
}

/** The units a per-operation override may carry, resolved for the matched operation. */
function operationPolicy(policy: PolicyDocument, operationId: string | null) {
  if (!operationId) return {} as Partial<PolicyDocument>;
  const out: Record<string, unknown> = {};
  for (const unit of ["validate", "rateLimit", "quota", "timeoutMs", "cache"]) {
    const value = policy[operationUnitKey(operationId, unit)];
    if (value !== undefined) out[unit] = value;
  }
  return out as {
    validate?: ValidateUnit;
    rateLimit?: RateLimitUnit;
    quota?: QuotaUnit;
    timeoutMs?: number;
    cache?: CacheUnit;
  };
}

function artifactFor(deps: PipelineDeps, route: ConfigRoute): ValidationArtifact | null {
  const ref = route.artifacts[0];
  if (!ref) return null;
  return deps.artifacts.get(ref.digest);
}

function breakerOf(route: ConfigRoute): BreakerSettings | null {
  const unit = route.policy.circuitBreaker;
  if (!unit) return null;
  return {
    failures: unit.failures,
    windowSec: unit.windowSec,
    openSec: unit.openSec,
    halfOpenProbes: unit.halfOpenProbes ?? 1,
  };
}

function firstBackend(deps: PipelineDeps, route: ConfigRoute): BackendEntry | null {
  const settings = breakerOf(route);
  const order = selectionOrder(
    route.backend.pool,
    route.backend.rule,
    deps.table.nextCursor(route.resourceId),
    (url) => deps.breaker.state(`${route.resourceId}|${url}`, settings) !== "open",
  );
  return order[0] ?? null;
}

function isRetryable(status: number, retries: PolicyDocument["retries"]): boolean {
  if (!retries) return false;
  return retries.on.includes(String(status) as never);
}

/**
 * Design section 5.4: verified by default. An exception self-expires on this instance's own clock,
 * so fail-static config cannot hold one open through a control-plane outage.
 *
 * G4 adds the environment's trust anchors (plan §8.3). They apply to every mode that verifies
 * anything — `verify`, and also `pin` and `skip-hostname`, where the chain is still checked before
 * the pin is compared or the name check relaxed. Not to `insecure`, where nothing is verified and
 * adding a CA would be theatre.
 */
function tlsOptionsFor(route: ConfigRoute, backendUrl: string, deps: PipelineDeps): unknown | null {
  const material = route.backend.clientCertRef
    ? deps.table.certificateFor(route.backend.clientCertRef, deps.artifacts)
    : null;
  const tls = route.backend.tls;
  const expired = tls.expiresAt !== undefined && Date.parse(tls.expiresAt) <= Date.now();
  const mode = expired ? "verify" : tls.mode;
  const anchors = mode === "insecure" ? null : deps.table.trust.bundle();

  if (mode === "verify" && !material && !anchors) return null;
  const options: Record<string, unknown> = {};
  if (material) {
    options.cert = material.certPem;
    options.key = material.keyPem;
  }
  // One `ca`, because there is only one: the environment's anchors, plus the client identity's own
  // chain when it has one. `anchors` already carries the system roots — setting `ca` replaces the
  // default store, so anything left out here is not trusted at all.
  const ca = [anchors, material?.chainPem].filter(Boolean).join("\n");
  if (ca.length > 0) options.ca = ca;
  if (mode === "insecure") options.rejectUnauthorized = false;
  if (mode === "skip-hostname") {
    options.checkServerIdentity = () => undefined;
  }
  if (mode === "pin" && tls.pinThumbprint) {
    // A pin makes a self-signed backend *verifiable* rather than unverified: the chain is not
    // trusted, but the exact certificate is, and anything else is refused.
    options.rejectUnauthorized = false;
    options.checkServerIdentity = (_host: string, cert: { fingerprint256?: string }) => {
      const presented = (cert.fingerprint256 ?? "").replace(/:/g, "").toUpperCase();
      return presented === tls.pinThumbprint!.replace(/:/g, "").toUpperCase()
        ? undefined
        : new Error("the backend certificate does not match the pinned thumbprint");
    };
  }
  void backendUrl;
  return Object.keys(options).length > 0 ? options : null;
}

function isEventStream(headers: Headers): boolean {
  return (headers.get("content-type") ?? "").toLowerCase().includes("text/event-stream");
}

function agentCardResponse(route: ConfigRoute, req: Request, requestId: string): Response {
  const url = new URL(req.url);
  // The `Host` header first, because behind a proxy that is the name the consumer used; the
  // request line only when there is no header, so a card is never advertised at `http:///…`.
  const host = req.headers.get("host") || url.host;
  const proto = url.protocol.replace(":", "");
  const card = rewriteCard(route.a2a!.card, {
    url: `${proto}://${host}${route.basePath === "/" ? "" : route.basePath}`,
    apiKeyHeader:
      route.policy["auth.subscriptionKey"]?.in === "header"
        ? route.policy["auth.subscriptionKey"]!.name
        : null,
  });
  const body = JSON.stringify(card);
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-length": String(Buffer.byteLength(body, "utf8")),
      "cache-control": "public, max-age=60",
      "x-request-id": requestId,
    },
  });
}

function validationDetail(outcome: ValidationOutcome): string {
  const first = outcome.issues[0];
  const suffix = outcome.issues.length > 1 ? ` (and ${outcome.issues.length - 1} more)` : "";
  const truncated = outcome.truncated ? "; more errors were not collected" : "";
  return first
    ? `${first.path}: ${first.message}${suffix}${truncated}`
    : "the request does not match this API's contract";
}

function validateRequestBody(
  deps: PipelineDeps,
  route: ConfigRoute,
  operation: ConfigOperation,
  artifact: ValidationArtifact,
  body: Bytes,
  req: Request,
  validate: ValidateUnit,
): ValidationOutcome {
  const text = new TextDecoder().decode(body);
  if (artifact.kind === "xsd-set") {
    // The element under test is the SOAP body's first child, not the envelope.
    const child = soapBodyChild(text, deps.table.limits);
    if (!child) return { ok: true, issues: [], truncated: false, skipped: true };
    return validateBody({
      artifact,
      operationId: operation.id,
      direction: "request",
      contentType: req.headers.get("content-type"),
      xml: child,
      xmlLimits: {
        maxBytes: deps.table.limits.xml.maxBytes,
        maxDepth: deps.table.limits.xml.maxDepth,
        maxElements: validate.always?.xml?.maxElements ?? deps.table.limits.xml.maxElements,
      },
    });
  }
  const json = readJsonBody(text, validate);
  if ("error" in json) {
    return { ok: false, issues: [json.error], truncated: false };
  }
  return validateBody({
    artifact,
    operationId: operation.id,
    direction: "request",
    contentType: req.headers.get("content-type"),
    json: json.value,
  });
}

function validateResponse(
  deps: PipelineDeps,
  artifact: ValidationArtifact,
  operation: ConfigOperation,
  status: number,
  body: Bytes,
  headers: Headers,
  validate: ValidateUnit,
): ValidationOutcome {
  const headerOutcome = validateResponseHeaders(artifact, operation.id, status, headers);
  const text = new TextDecoder().decode(body);
  let bodyOutcome: ValidationOutcome;
  if (artifact.kind === "xsd-set") {
    const child = soapBodyChild(text, deps.table.limits);
    bodyOutcome = child
      ? validateBody({
          artifact,
          operationId: operation.id,
          direction: "response",
          contentType: headers.get("content-type"),
          status,
          xml: child,
        })
      : { ok: true, issues: [], truncated: false, skipped: true };
  } else {
    const json = readJsonBody(text, validate);
    bodyOutcome =
      "error" in json
        ? { ok: false, issues: [json.error], truncated: false }
        : validateBody({
            artifact,
            operationId: operation.id,
            direction: "response",
            contentType: headers.get("content-type"),
            status,
            json: json.value,
          });
  }
  return {
    ok: headerOutcome.ok && bodyOutcome.ok,
    issues: [...headerOutcome.issues, ...bodyOutcome.issues],
    truncated: headerOutcome.truncated || bodyOutcome.truncated,
  };
}

/**
 * The SOAP body's first child, serialized back to XML for the XSD validator. Re-serializing rather
 * than slicing the original keeps the namespace declarations in scope, which is what makes a body
 * element validate against a schema that qualifies its children.
 */
function soapBodyChild(envelope: string, limits: ConfigLimits): string | null {
  try {
    const root = parseDocument(envelope, {
      maxBytes: limits.xml.maxBytes,
      maxDepth: limits.xml.maxDepth,
      maxElements: limits.xml.maxElements,
    });
    const body = root.children.find((child) => child.local === "Body");
    const first = body?.children[0];
    return first ? serialize(first, {}) : null;
  } catch {
    return null;
  }
}

function serialize(node: { qname: string; local: string; ns: string; attributes: Record<string, string>; nsAttributes: Record<string, string>; children: unknown[]; text: string }, inherited: Record<string, string>): string {
  const scope = { ...inherited };
  const attributes: string[] = [];
  if (node.ns && scope[""] !== node.ns) {
    scope[""] = node.ns;
    attributes.push(` xmlns="${escapeXml(node.ns)}"`);
  }
  for (const [name, value] of Object.entries(node.attributes)) {
    attributes.push(` ${name}="${escapeXml(value)}"`);
  }
  let nsIndex = 0;
  for (const [qname, value] of Object.entries(node.nsAttributes)) {
    const close = qname.indexOf("}");
    const ns = qname.slice(1, close);
    const local = qname.slice(close + 1);
    const prefix = `n${nsIndex++}`;
    attributes.push(` xmlns:${prefix}="${escapeXml(ns)}" ${prefix}:${local}="${escapeXml(value)}"`);
  }
  const children = (node.children as typeof node[]).map((child) => serialize(child, scope)).join("");
  const text = escapeXml(node.text);
  return `<${node.local}${attributes.join("")}>${text}${children}</${node.local}>`;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function logValidation(
  deps: PipelineDeps,
  route: ConfigRoute,
  operation: ConfigOperation | null,
  subscription: ConfigSubscription | null,
  mode: "blocking" | "warning",
  outcome: "rejected" | "observed",
  schema: "request" | "response",
  result: ValidationOutcome,
): void {
  // Design section 5.1's log record. The payload is not included: `includeBodyExcerptBytes`
  // defaults to 0 and its ceiling is admin config, because bodies routinely carry personal data.
  deps.log?.({
    ts: logTimestamp(),
    event: "validation.failed",
    requestId: deps.requestId,
    mode,
    outcome,
    schema,
    resourceId: route.resourceId,
    resourceName: route.resourceName,
    apiVersion: route.apiVersion,
    rev: route.rev,
    revisionId: route.revisionId,
    environment: deps.table.environment,
    operationId: operation?.id ?? null,
    subscriptionId: subscription?.id ?? null,
    applicationId: subscription?.applicationId ?? null,
    errors: result.issues.slice(0, 5),
    truncated: result.truncated,
  });
}

/**
 * The response body's size according to the backend, or `null` when that cannot be trusted.
 *
 * The trap is compression. The runtime decompresses transparently, so a gzipped response arrives
 * with its body already expanded while `Content-Length` still describes the *compressed* bytes.
 * It leaves `Content-Encoding` in place when it does that, which is what makes the case
 * detectable: no encoding header means nothing was expanded underneath us.
 *
 * `carriedThrough` is the other half of that: when the gateway asked the runtime not to decode,
 * the declared length describes exactly the bytes being forwarded, and those bytes are what went
 * on the wire — which is what the counter is for.
 */
function declaredBodyBytes(upstream: Response, carriedThrough = false): number | null {
  if (!carriedThrough && upstream.headers.has("content-encoding")) return null;
  const raw = upstream.headers.get("content-length");
  if (raw === null) return null;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : null;
}

/**
 * Reads up to `maxBytes` and, past that, hands back a stream that replays what was read followed
 * by the remainder — so a caller that only *wanted* the bytes can still deliver them.
 *
 * `readWholeBody` cancels instead, which is right on the request side: over the cap there is a
 * `413` to send and nothing to deliver. On the response side the caller has already promised the
 * client a body, and losing it because a warning-mode sample would not fit was silent corruption.
 */
async function readResumable(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<{ bytes: Bytes; overCap: boolean; rest: ReadableStream<Uint8Array> | null }> {
  if (!body) return { bytes: new Uint8Array(0), overCap: false, rest: null };
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    let result: Awaited<ReturnType<typeof reader.read>>;
    try {
      result = await reader.read();
    } catch {
      // A body that broke mid-flight: there is nothing to resume and nothing to validate.
      return { bytes: new Uint8Array(0), overCap: true, rest: null };
    }
    if (result.done) break;
    chunks.push(result.value);
    size += result.value.byteLength;
    if (size > maxBytes) {
      return {
        bytes: new Uint8Array(0),
        overCap: true,
        rest: new ReadableStream<Uint8Array>({
          start(controller) {
            for (const chunk of chunks) controller.enqueue(chunk);
            chunks.length = 0;
          },
          async pull(controller) {
            try {
              const next = await reader.read();
              if (next.done) controller.close();
              else controller.enqueue(next.value);
            } catch (err) {
              controller.error(err);
            }
          },
          cancel: (reason) => void reader.cancel(reason).catch(() => {}),
        }),
      };
    }
  }
  return { bytes: concatBytes(chunks, size), overCap: false, rest: null };
}

function concatBytes(chunks: Uint8Array[], size: number): Bytes {
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/**
 * Whether a JSON-RPC response carries an `error`. Read rather than validated: the question is
 * which outcome to *count*, so a body that does not parse is simply not an RPC error — the
 * response is passed through either way, and whether it matches the contract is a separate check
 * with its own state and its own counters.
 */
function rpcErrorInBody(bytes: Bytes, headers: Headers): boolean {
  if (bytes.byteLength === 0) return false;
  if (!matchesMedia(mediaTypeOf(headers.get("content-type")), JSON_MEDIA)) return false;
  try {
    const value = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    return (value as Record<string, unknown>).error !== undefined;
  } catch {
    return false;
  }
}

async function readWholeBody(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<{ bytes: Bytes; overCap: boolean }> {
  if (!body) return { bytes: new Uint8Array(0), overCap: false };
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      size += result.value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => {});
        return { bytes: new Uint8Array(0), overCap: true };
      }
      chunks.push(result.value);
    }
  } catch {
    return { bytes: new Uint8Array(0), overCap: true };
  }
  return { bytes: concatBytes(chunks, size), overCap: false };
}

/**
 * Warning mode tees the body: the request proceeds immediately with one copy while the other goes
 * to the pool. Bounded by the same cap as everything else — past it there is no sample, which is
 * counted rather than allowed to hold memory.
 */
async function teeBody(
  streamed: ReadableStream<Uint8Array> | null,
  buffered: Bytes | null,
  maxBytes: number,
): Promise<{ forward: ReadableStream<Uint8Array> | null; copy: Bytes | null }> {
  if (buffered) return { forward: null, copy: buffered };
  if (!streamed) return { forward: null, copy: null };
  const read = await readWholeBody(streamed, maxBytes);
  if (read.overCap) return { forward: null, copy: null };
  const bytes = read.bytes;
  return {
    forward: new ReadableStream<Uint8Array>({
      start(controller) {
        if (bytes.byteLength > 0) controller.enqueue(bytes);
        controller.close();
      },
    }),
    copy: bytes,
  };
}

/**
 * Reads at most `maxBytes` from the (already capped) body and returns a stream that replays the
 * prefix before the remainder — so a large envelope still streams instead of being buffered.
 */
async function takePrefix(
  body: ReadableStream<Uint8Array>,
  maxBytes: number,
): Promise<{ prefix: Bytes; stream: ReadableStream<Uint8Array>; overCap: boolean }> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let done = false;
  try {
    while (size < maxBytes) {
      const result = await reader.read();
      if (result.done) {
        done = true;
        break;
      }
      chunks.push(result.value);
      size += result.value.byteLength;
    }
  } catch {
    // The only error the capped stream raises is the body cap.
    return { prefix: new Uint8Array(0), stream: new ReadableStream(), overCap: true };
  }

  const prefix = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    prefix.set(chunk, offset);
    offset += chunk.byteLength;
  }

  const finished = done;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      if (prefix.byteLength > 0) controller.enqueue(prefix);
      if (finished) controller.close();
    },
    async pull(controller) {
      const result = await reader.read();
      if (result.done) {
        controller.close();
        return;
      }
      controller.enqueue(result.value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
  return { prefix, stream, overCap: false };
}
