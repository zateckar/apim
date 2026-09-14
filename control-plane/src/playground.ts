import type { ConfigOperation, ConfigRoute } from "../../shared/config-doc.ts";
import type { User } from "./auth.ts";
import { buildRoutes, limitsFor } from "./config-build.ts";
import { gatewayUrlsFor, type GatewayUrl } from "./config.ts";
import { boundGatewayOrigins } from "./api/fleet.ts";
import { decrypt } from "./crypto.ts";
import { checkEgress } from "./egress.ts";
import { denyRulesFor } from "./deny-rules.ts";
import { badRequest, conflict, forbidden, notFound, type App } from "./router.ts";
import { trustedFetch } from "./trust-store.ts";

/**
 * The playground (G1, design section 14's `POST /api/playground`).
 *
 * Three properties are the whole design, and each one is a refusal somewhere below:
 *
 *  - **the caller names no host.** There is no target URL field. The target is composed from
 *    `TARGETS_FILE`'s gateway URLs and the published route, and the composed URL is
 *    egress-checked anyway — so this endpoint cannot be turned into a request forger (§5.3).
 *  - **the key never reaches the browser.** The caller sends a `subscriptionId`; the key is
 *    decrypted here, injected into the header or query parameter the *effective policy* names, and
 *    never returned, logged or stored.
 *  - **the call is an ordinary gateway request.** It goes to the environment's gateway, not to the
 *    backend, so it passes through every policy on the route, spends the subscription's rate limit
 *    and quota, and appears in telemetry attributed to that subscription (D31).
 *
 * Resolution reads the route out of `buildRoutes` — the same function that renders the config
 * document — so the playground can never disagree with the gateway about the key header, the base
 * path or which operations exist `[P1-24]`.
 */

export interface PlaygroundHeader {
  name: string;
  value: string;
  enabled?: boolean;
}

export interface PlaygroundRequest {
  resourceId?: string;
  environment?: string;
  subscriptionId?: string | null;
  keyKind?: "primary" | "secondary";
  gatewayLabel?: string;
  operationId?: string;
  /** A2A only: fetch the agent card the gateway serves, rather than an operation (§5.4). */
  agentCard?: boolean;
  pathParams?: Record<string, string>;
  query?: PlaygroundHeader[];
  headers?: PlaygroundHeader[];
  body?: string | null;
}

export interface ComposedCall {
  url: string;
  method: string;
  /** The path as sent, below the gateway's origin — what the history row records. */
  path: string;
  search: string;
  /** Ready to send, key included. Never returned to a caller (§5.2). */
  headers: Record<string, string>;
  /** Everything above except the key header, for the response and the history row. */
  safeHeaders: Record<string, string>;
  body: string | null;
  route: ConfigRoute;
  operation: ConfigOperation | null;
  gateway: GatewayUrl;
  subscriptionId: string | null;
  keyKind: "primary" | "secondary" | "none";
  /** Caller headers that were dropped, named rather than silently removed (§5.2). */
  droppedHeaders: string[];
  /** Things the caller should know before reading the response as the API's fault. */
  warnings: string[];
}

/**
 * Hop-by-hop headers and the two a caller must not be able to forge here. `host` is set from the
 * route, not from the request: the route's host is what selects the route on the gateway, so
 * letting a caller override it would let them address any route from any API's console.
 */
const BLOCKED_HEADERS = new Set([
  "host",
  "content-length",
  "connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  "te",
  "trailer",
  "proxy-authenticate",
  "proxy-authorization",
]);

const A2A_CARD_OPERATION = "__agent_card__";

export function composeCall(app: App, user: User, request: PlaygroundRequest): ComposedCall {
  const resourceId = request.resourceId ?? "";
  const environment = request.environment ?? "";
  if (!app.config.promotionChain.includes(environment)) {
    throw badRequest(
      `unknown environment "${environment}" (PROMOTION_CHAIN is ${app.config.promotionChain.join(",")})`,
    );
  }

  const resource = app.db
    .query<{ id: string; name: string; api_version: string; kind: string; application_id: string }, [string]>(
      "SELECT id, name, api_version, kind, application_id FROM resource WHERE id = ?",
    )
    .get(resourceId);
  if (!resource) throw notFound(`no API ${resourceId}`);

  const gateway = gatewayFor(app, environment, resource.id, request.gatewayLabel);
  const route = routeFor(app, environment, resource);

  // A stream cannot be proxied through here and back into a browser without a second streaming
  // implementation on the wrong tier, so it is refused with the line that does work (§2).
  const passthrough = route.policy.passthrough;
  if (passthrough?.websocket || passthrough?.sse) {
    const path = `${gateway.url}${route.basePath}`;
    throw conflict(
      `${resource.name} ${resource.api_version} is a streaming route, and the console cannot hold ` +
        "a stream open. Use the command below instead",
      {
        streaming: passthrough.websocket ? "websocket" : "sse",
        command: passthrough.websocket
          ? `websocat "${path.replace(/^http/, "ws")}" -H "X-Api-Key: $KEY"`
          : `curl -N "${path}" -H "X-Api-Key: $KEY"`,
      },
    );
  }

  const warnings: string[] = [];
  if (route.policy.ipAllow) {
    // Otherwise the gateway's correct 403 reads as a platform bug `[P1-23]`.
    warnings.push(
      "this route restricts callers by IP address (ipAllow), and the request will arrive from the " +
        "portal's address rather than yours — a 403 here may mean the portal is not on the list",
    );
  }

  const operation = operationFor(route, request, resource.kind);
  const { subscriptionId, keyKind, keyValue, keyHeader } = resolveKey(app, user, route, request, resource);

  // The path the gateway will match: its base path plus the operation's own template, with every
  // substituted segment percent-encoded so a path parameter cannot introduce a path of its own.
  const base = trimSlash(route.basePath);
  const path = request.agentCard
    ? // Already absolute: the config document carries the card path with the base path inside it,
      // so prefixing the base path again would address `/agent/agent/.well-known/...`.
      (route.a2a?.cardPath ?? `${base}/.well-known/agent-card.json`)
    : joinPath(base, renderTemplate(operation?.template ?? "/", request.pathParams ?? {}));

  const search = new URLSearchParams();
  for (const entry of request.query ?? []) {
    if (entry.enabled === false || !entry.name) continue;
    search.append(entry.name, entry.value ?? "");
  }

  const headers: Record<string, string> = {};
  const droppedHeaders: string[] = [];
  for (const entry of request.headers ?? []) {
    if (entry.enabled === false || !entry.name) continue;
    const name = entry.name.trim().toLowerCase();
    if (BLOCKED_HEADERS.has(name) || name.startsWith("proxy-") || name === keyHeader) {
      droppedHeaders.push(entry.name);
      continue;
    }
    headers[name] = entry.value ?? "";
  }
  // The route's host, not the caller's: `route.host` is how the gateway selects a host-bound
  // route, and Bun's fetch sends a caller-set `Host` verbatim (probed, review `[P1-05]`).
  if (route.host && route.host !== "*") headers.host = route.host;

  const body = normalizeBody(app, request, operation);
  if (body !== null && !headers["content-type"]) {
    headers["content-type"] = route.kind === "soap" ? "text/xml; charset=utf-8" : "application/json";
  }

  const safeHeaders = { ...headers };
  if (keyValue !== null) {
    if (keyHeader) headers[keyHeader] = keyValue;
    else search.set(route.policy["auth.subscriptionKey"]!.name, keyValue);
  }

  const query = search.toString();
  return {
    url: `${gateway.url}${path}${query ? `?${query}` : ""}`,
    method: request.agentCard ? "GET" : (operation?.method ?? "GET"),
    path,
    // The key, when it travels as a query parameter, is not in what we report or store.
    search: reportableSearch(search, route, keyValue !== null && !keyHeader),
    headers,
    safeHeaders,
    body,
    route,
    operation,
    gateway,
    subscriptionId,
    keyKind,
    droppedHeaders,
    warnings,
  };
}

function trimSlash(basePath: string): string {
  return basePath === "/" ? "" : basePath.replace(/\/+$/, "");
}

/**
 * `/orders` + `/pets/1` → `/orders/pets/1`, and `/orders` + `/` → `/orders`. Every SOAP operation
 * is a POST to the one endpoint, so its template is `/`; appending that would send `/orders/`,
 * which is a different path to the backend than the one every other caller of that route sends.
 */
function joinPath(base: string, rendered: string): string {
  return rendered === "/" ? base || "/" : `${base}${rendered}`;
}

/** `/pet/{petId}` + `{petId: "1 2"}` → `/pet/1%202`. A missing parameter is a 400, not a literal. */
function renderTemplate(template: string, params: Record<string, string>): string {
  const missing: string[] = [];
  const rendered = template.replace(/\{([^}]+)\}/g, (_match, name: string) => {
    const value = params[name];
    if (value === undefined || value === "") {
      missing.push(name);
      return "";
    }
    return encodeURIComponent(value);
  });
  if (missing.length > 0) {
    throw badRequest(
      `this operation's path needs ${missing.map((name) => `"${name}"`).join(", ")}; ` +
        "fill the path parameter(s) before sending",
    );
  }
  return rendered.startsWith("/") ? rendered : `/${rendered}`;
}

function reportableSearch(search: URLSearchParams, route: ConfigRoute, keyInQuery: boolean): string {
  if (!keyInQuery) return search.toString();
  const copy = new URLSearchParams(search);
  copy.delete(route.policy["auth.subscriptionKey"]!.name);
  return copy.toString();
}

/**
 * One address the console may send to, and what it is.
 *
 * `label` is the whole contract with the browser: it is what the select shows and what comes back
 * on the send, and it is unique within an environment.
 */
export interface PlaygroundGateway extends GatewayUrl {
  /** The gateway (target) whose address this is, or `null` for a replica that names no gateway. */
  gateway: string | null;
  /**
   * `internet` and `intranet` are the gateway's own published hostnames — the addresses a consumer
   * is actually given. `replica` is one process behind it, from `config.gatewayUrls`.
   */
  kind: "internet" | "intranet" | "replica";
}

/**
 * Every address this API can be called at in this environment, best first.
 *
 * The console used to offer only `config.gatewayUrls`, which are the **replicas** — `dev-1`,
 * `dev-2`, an address per process. That is the one list the rest of the portal is careful never to
 * publish (see `publicGatewayUrl`): it changes whenever the fleet is resized, and a URL somebody
 * copied out of the console was a URL that would stop working. It also meant the console's target
 * was not the URL the API's own Properties tab had just told them to call, so "it works in the
 * playground" and "it works" were two different claims.
 *
 * So the gateway's **published hostname comes first**, one entry per address it answers on, and
 * only the gateways this API is actually bound to. The replicas stay on the list underneath: they
 * are how a rate limit counted per instance is demonstrated by hand, and they are the only thing
 * left when a gateway has no published hostname yet.
 */
export function callableGateways(
  app: App,
  environment: string,
  resourceId: string,
): PlaygroundGateway[] {
  const out: PlaygroundGateway[] = [];
  const taken = new Set<string>();
  /** Labels are what the caller names, so a collision has to be resolved rather than shadowed. */
  const push = (entry: PlaygroundGateway) => {
    let label = entry.label;
    for (let n = 2; taken.has(label); n++) label = `${entry.label} (${n})`;
    taken.add(label);
    out.push({ ...entry, label });
  };

  for (const address of boundGatewayOrigins(app.db, resourceId, environment)) {
    push({
      // The gateway's name is the identity the publisher chose it by, on the Properties tab and in
      // the promotion; the network only needs saying when one gateway answers on both.
      label: address.network === "internet" ? address.gateway : `${address.gateway} (intranet)`,
      url: address.origin,
      gateway: address.gateway,
      kind: address.network,
    });
  }
  // Every replica in the environment, not only this API's gateway's: `config.gatewayUrls` is
  // declared per target but is not attributed to one anywhere the console can read, so narrowing
  // it would mean guessing.
  for (const replica of gatewayUrlsFor(app.config, environment)) {
    push({ ...replica, gateway: null, kind: "replica" });
  }
  return out;
}

export function gatewayFor(
  app: App,
  environment: string,
  resourceId: string,
  label: string | undefined,
): PlaygroundGateway {
  const gateways = callableGateways(app, environment, resourceId);
  if (gateways.length === 0) {
    // Reaching here means the environment has no `config.gatewayUrls` *and* no gateway this API is
    // on publishes a hostname — so the remedy is either of the two, and both are named.
    throw conflict(
      `no gateway URL is configured for ${environment.toUpperCase()}, so nothing can be called ` +
        "there from the portal. An administrator publishes the gateway's own hostname on the " +
        "Gateways screen, or sets config.gatewayUrls for that target in TARGETS_FILE",
    );
  }
  if (!label) return gateways[0]!;
  const found = gateways.find((gateway) => gateway.label === label);
  if (!found) {
    throw badRequest(
      `unknown gateway "${label}" in ${environment}; this API can be called at ` +
        gateways.map((gateway) => gateway.label).join(", "),
    );
  }
  return found;
}

/**
 * The route as the gateway has it, or the reason there is none. **Published is not the same as
 * served** `[P3-02]`: v3 omits a route whose effective policy document is invalid and records it in
 * `errors`, so the playground applies the same test and refuses first — rather than sending a
 * request the gateway has never heard of and showing a 404 that reads as a platform fault.
 */
export function routeFor(
  app: App,
  environment: string,
  resource: { id: string; name: string; api_version: string },
): ConfigRoute {
  const { routes, errors } = buildRoutes(
    app.db,
    environment,
    limitsFor(app.config.integrations),
    denyRulesFor(app.db, app.config.publicUrl),
  );
  const route = routes.find((candidate) => candidate.resourceId === resource.id);
  if (route) return route;

  const error = errors.find((candidate) => candidate.resourceId === resource.id);
  if (error) {
    throw conflict(
      `${resource.name} ${resource.api_version} is published in ${environment.toUpperCase()} but is ` +
        `not currently being served: ${error.detail}`,
      { fix: { screen: "policy", resourceId: resource.id, environment } },
    );
  }
  throw conflict(
    `${resource.name} ${resource.api_version} is not published in ${environment.toUpperCase()} yet, ` +
      "so there is nothing to call there. Promote a revision to that environment first",
    { fix: { screen: "publish", resourceId: resource.id, environment } },
  );
}

function operationFor(
  route: ConfigRoute,
  request: PlaygroundRequest,
  kind: string,
): ConfigOperation | null {
  if (request.agentCard) {
    if (kind !== "a2a") throw badRequest("agentCard applies to a2a APIs only");
    return null;
  }
  const operationId = request.operationId ?? "";
  if (!operationId) {
    throw badRequest("operationId is required: the method and path come from the operation, never from the request");
  }
  const operation = route.operations.find((candidate) => candidate.id === operationId);
  if (!operation) {
    throw badRequest(
      `revision ${route.rev} has no operation "${operationId}". It has ` +
        `${route.operations.length} operation(s); reload the console to pick one that exists`,
    );
  }
  return operation;
}

/**
 * **When a subscription is required is decided by the route, not by who is asking** `[P2-02]`: a
 * subscription is required exactly when the effective policy carries an `auth.subscriptionKey`
 * unit. Without that unit the route accepts anonymous traffic and the call is sent without a key.
 */
function resolveKey(
  app: App,
  user: User,
  route: ConfigRoute,
  request: PlaygroundRequest,
  resource: { id: string; name: string; api_version: string },
): {
  subscriptionId: string | null;
  keyKind: "primary" | "secondary" | "none";
  keyValue: string | null;
  keyHeader: string | null;
} {
  const unit = route.policy["auth.subscriptionKey"];
  if (!unit) {
    if (request.subscriptionId) {
      // Sending a key to a route that does not read one would be misleading in the other
      // direction: the console says plainly that this route needs none.
      throw badRequest(
        `${resource.name} ${resource.api_version} does not require a subscription key in this ` +
          "environment, so none is sent. Clear the subscription and send again",
      );
    }
    return { subscriptionId: null, keyKind: "none", keyValue: null, keyHeader: null };
  }

  const keyHeader = unit.in === "header" ? unit.name.toLowerCase() : null;
  if (!request.subscriptionId) {
    throw conflict(
      `${resource.name} ${resource.api_version} requires a subscription key in ` +
        `${route.policy["auth.subscriptionKey"]!.in === "header" ? unit.name : `?${unit.name}`}. ` +
        "Pick one of your applications' subscriptions, or subscribe an application to try this",
      { needsSubscription: true, resourceId: resource.id },
    );
  }

  const subscription = app.db
    .query<
      {
        id: string;
        state: string;
        environment: string;
        product_id: string;
        primary_key_enc: string;
        secondary_key_enc: string | null;
        application_id: string;
        application_name: string;
      },
      [string]
    >(
      `SELECT s.id, s.state, s.environment, s.product_id, s.primary_key_enc, s.secondary_key_enc,
              a.id AS application_id, a.name AS application_name
         FROM subscription s JOIN application a ON a.id = s.application_id
        WHERE s.id = ?`,
    )
    .get(request.subscriptionId);
  // A subscription that is not the caller's is not distinguishable from one that does not exist,
  // deliberately: `can()` unchanged, checked against the application's application.
  if (!subscription || (!user.isAdmin && !user.applications.includes(subscription.application_id))) {
    throw forbidden("this subscription belongs to another application");
  }
  if (subscription.state !== "active") {
    throw conflict(`this subscription is ${subscription.state}, so its key no longer works`);
  }
  if (subscription.environment !== request.environment) {
    throw conflict(
      `this subscription is for ${subscription.environment.toUpperCase()}, and you are calling ` +
        `${(request.environment ?? "").toUpperCase()}. A subscription is per environment ` +
        "(design section 6.1), so each one has its own keys",
    );
  }
  if (!route.productIds.includes(subscription.product_id)) {
    // Otherwise the gateway answers 403 and the reason looks like a platform fault.
    throw conflict(
      `${subscription.application_name}'s subscription does not include ${resource.name} ` +
        `${resource.api_version}. Subscribe to a product that contains this API`,
    );
  }

  const kind = request.keyKind ?? "primary";
  if (kind === "secondary" && !subscription.secondary_key_enc) {
    // "Test the secondary before I rotate" is the only reason this control exists, so falling
    // back to the primary would defeat the point silently `[P3-01]`.
    throw badRequest(
      "this subscription has no secondary key yet. Create one on the subscription's page " +
        "(Rotate key) before testing with it",
    );
  }
  const encrypted = kind === "secondary" ? subscription.secondary_key_enc! : subscription.primary_key_enc;
  return {
    subscriptionId: subscription.id,
    keyKind: kind,
    keyValue: decrypt(encrypted, app.kek),
    keyHeader,
  };
}

function normalizeBody(
  app: App,
  request: PlaygroundRequest,
  operation: ConfigOperation | null,
): string | null {
  const body = request.body;
  if (body === undefined || body === null || body === "") return null;
  const method = request.agentCard ? "GET" : (operation?.method ?? "GET");
  if (method === "GET" || method === "HEAD") {
    // A body on a GET is dropped rather than sent: the gateway would forward it, some backends
    // reject it, and nobody meant it.
    return null;
  }
  const bytes = Buffer.byteLength(body, "utf8");
  if (bytes > app.config.playgroundMaxBodyBytes) {
    throw badRequest(
      `the request body is ${bytes} bytes and PLAYGROUND_MAX_BODY_BYTES is ` +
        `${app.config.playgroundMaxBodyBytes}. Send a smaller body from the console, or use curl ` +
        "for a large one",
    );
  }
  return body;
}

// --------------------------------------------------------------------------- sending

export interface PlaygroundResult {
  status: number | null;
  statusText: string | null;
  durationMs: number;
  responseHeaders: Record<string, string>;
  bodyText: string | null;
  encoding: "utf-8" | "base64";
  truncated: boolean;
  bytesOut: number;
  error: string | null;
}

/**
 * One request to the environment's gateway. Redirects are never followed, the response is returned
 * verbatim up to `PLAYGROUND_MAX_RESPONSE_BYTES`, and a body that is not valid UTF-8 comes back
 * base64 rather than mangled.
 */
export async function forwardCall(app: App, composed: ComposedCall): Promise<PlaygroundResult> {
  const errors = await checkEgress(composed.url, "gateway", { integrations: app.config.integrations });
  // Even though no part of this URL came from the caller: design section 5.3 names this check as
  // what makes the endpoint safe, and a configuration that would let it reach elsewhere is worth
  // hearing about here rather than never.
  //
  // The denied ranges only, as at boot. This URL is composed from TARGETS_FILE, which is operator
  // configuration — a deny rule aimed at a backend should not silently disable the playground.
  if (errors.length > 0) throw conflict(errors.join("; "));

  const started = performance.now();
  let response: Response;
  try {
    response = await trustedFetch(app.db)(composed.url, {
      method: composed.method,
      headers: composed.headers,
      ...(composed.body === null ? {} : { body: composed.body }),
      redirect: "manual",
      signal: AbortSignal.timeout(app.config.playgroundTimeoutMs),
    });
  } catch (err) {
    const error = err as Error;
    const timedOut = error.name === "TimeoutError" || error.name === "AbortError";
    return {
      status: null,
      statusText: null,
      durationMs: Math.round(performance.now() - started),
      responseHeaders: {},
      bodyText: null,
      encoding: "utf-8",
      truncated: false,
      bytesOut: 0,
      // An outcome on the history entry, not an error banner (§5.3): the call happened, and this
      // is what happened.
      error: timedOut
        ? `no response within ${app.config.playgroundTimeoutMs} ms`
        : `the gateway could not be reached: ${error.message}`,
    };
  }

  const { bytes, truncated } = await readCapped(response, app.config.playgroundMaxResponseBytes);
  const durationMs = Math.round(performance.now() - started);
  const decoded = decodeBody(bytes);
  const responseHeaders: Record<string, string> = {};
  for (const [name, value] of response.headers) responseHeaders[name] = value;

  return {
    status: response.status,
    statusText: response.statusText || null,
    durationMs,
    responseHeaders,
    bodyText: decoded.text,
    encoding: decoded.encoding,
    truncated,
    bytesOut: bytes.length,
    error: null,
  };
}

async function readCapped(
  response: Response,
  max: number,
): Promise<{ bytes: Buffer; truncated: boolean }> {
  const reader = response.body?.getReader();
  if (!reader) return { bytes: Buffer.alloc(0), truncated: false };
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (size + value.byteLength > max) {
      chunks.push(value.subarray(0, Math.max(0, max - size)));
      size = max;
      truncated = true;
      await reader.cancel();
      break;
    }
    chunks.push(value);
    size += value.byteLength;
  }
  return { bytes: Buffer.concat(chunks), truncated };
}

function decodeBody(bytes: Buffer): { text: string | null; encoding: "utf-8" | "base64" } {
  if (bytes.length === 0) return { text: "", encoding: "utf-8" };
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes), encoding: "utf-8" };
  } catch {
    // A PDF, a protobuf, a truncated multi-byte character: shown as base64 rather than as
    // replacement characters that look like the backend sent rubbish.
    return { text: bytes.toString("base64"), encoding: "base64" };
  }
}

// --------------------------------------------------------------------------- rate limit

interface Window {
  startedAt: number;
  count: number;
}

/**
 * `PLAYGROUND_RATE_PER_MIN` **protects the control plane, not the consumer's quota** `[P1-17]`. In
 * memory and per control-plane process, because that is what it is defending; keyed by database so
 * two in-process control planes in a test cannot spend each other's allowance.
 */
const LIMITS = new WeakMap<object, Map<string, Window>>();

export function takeRateSlot(app: App, userId: string, now = Date.now()): number | null {
  let byUser = LIMITS.get(app.db);
  if (!byUser) {
    byUser = new Map();
    LIMITS.set(app.db, byUser);
  }
  const window = byUser.get(userId);
  if (!window || now - window.startedAt >= 60_000) {
    byUser.set(userId, { startedAt: now, count: 1 });
    return null;
  }
  if (window.count >= app.config.playgroundRatePerMin) {
    return Math.max(1, Math.ceil((window.startedAt + 60_000 - now) / 1000));
  }
  window.count += 1;
  return null;
}
