import type { ConfigOperation, ConfigRoute } from "../../shared/config-doc.ts";
import type { ApiModel, ApiOperation, ApiParameter } from "../../shared/types.ts";
import type { User } from "./auth.ts";
import { publicGatewayUrl } from "./api/fleet.ts";
import { callableGateways, routeFor } from "./playground.ts";
import { notFound, type App } from "./router.ts";

/**
 * What the console needs to draw the form (G1, plan §5.4).
 *
 * The browser is never asked to work any of this out. It cannot: the operation set belongs to the
 * revision **converged in this environment**, the key header belongs to that environment's
 * effective policy, and the body prefill is generated from the revision's model, which is tens of
 * kilobytes and never leaves the control plane. So the same resolution `composeCall` performs runs
 * once more here, and the answer is a form.
 *
 * The consequence worth stating: everything below is derived from `buildRoutes`, so a form that
 * offers an operation is a form whose send will be accepted, and a form that refuses says the same
 * sentence the send would have `[P1-24]`.
 */

/** Design §4.1's bounds, applied to the *example* rather than to validation `[P1-08]`. */
const MAX_DEPTH = 8;
const MAX_NODES = 64;

export interface FormParameter {
  name: string;
  required: boolean;
  /** A value that satisfies the declared schema, so the form starts in a sendable state. */
  value: string;
  description?: string;
}

export interface FormOperation {
  id: string;
  name: string;
  method: string;
  /** Relative to the base path, as declared: `/pet/{petId}`. */
  template: string;
  summary: string | null;
  pathParams: FormParameter[];
  query: FormParameter[];
  headers: FormParameter[];
  /** Prefilled request body, or null when this operation carries none. */
  body: string | null;
  bodyKind: "json" | "xml" | null;
  /** Why this operation is or is not validated by the gateway. */
  schemaState: ConfigOperation["schemaState"];
  /** MCP/A2A: the JSON-RPC method this operation is, carried in the body rather than the path. */
  selector?: string;
}

export interface FormSubscription {
  id: string;
  name: string;
  application: string;
  product: string;
  hasSecondary: boolean;
}

export function buildPlaygroundForm(app: App, user: User, resourceId: string, environment: string) {
  const resource = app.db
    .query<
      { id: string; name: string; api_version: string; kind: string; application_id: string },
      [string]
    >("SELECT id, name, api_version, kind, application_id FROM resource WHERE id = ?")
    .get(resourceId);
  if (!resource) throw notFound(`no API ${resourceId}`);

  // The same refusals a send would produce — not published here, published but not served — so the
  // console never draws a form for a call that could not be made.
  const route = routeFor(app, environment, resource);
  const model = modelFor(app, route.revisionId);

  const key = route.policy["auth.subscriptionKey"] ?? null;
  const subscriptions = key ? usableSubscriptions(app, user, route, environment) : [];

  const passthrough = route.policy.passthrough;
  const streaming = passthrough?.websocket ? "websocket" : passthrough?.sse ? "sse" : null;
  // Every address this API can be called at here, published hostnames first. The console's target
  // is therefore the URL its own Properties tab tells a consumer to use, rather than one replica's
  // address — see `callableGateways`.
  const gateways = callableGateways(app, environment, resource.id);
  // The address in the copyable `curl` is the reverse proxy's, never a replica's: what somebody
  // pastes into their own terminal has to keep working after the fleet is resized.
  const origin = gateways[0]?.url ?? publicGatewayUrl(app.db, environment) ?? "";
  const base = `${origin}${route.basePath === "/" ? "" : route.basePath}`;

  const warnings: string[] = [];
  // Said on the form rather than only on the send: a console that draws a Send it knows will be
  // refused has kept the reason to itself until the click (`[P1-24]`).
  if (gateways.length === 0) {
    warnings.push(
      `No gateway in ${environment.toUpperCase()} has an address the portal can call. An ` +
        "administrator publishes the gateway's hostname on the Gateways screen.",
    );
  }
  if (route.policy.ipAllow) {
    warnings.push(
      "This route restricts callers by IP address, and a call from here arrives from the portal's " +
        "address rather than yours — a 403 may mean the portal is not on the list.",
    );
  }
  if (route.lifecycle !== "active") {
    warnings.push(`This version is ${route.lifecycle}. Calls to it may stop working.`);
  }

  return {
    resourceId: resource.id,
    resourceName: resource.name,
    apiVersion: resource.api_version,
    kind: route.kind,
    environment,
    rev: route.rev,
    host: route.host,
    basePath: route.basePath,
    gateways,
    /**
     * Whether a key is needed is decided by the route, not by who is asking `[P2-02]`. Null here
     * means the route accepts anonymous traffic, and the console says so — a route that needs no
     * key is worth seeing.
     */
    key: key ? { in: key.in, name: key.name } : null,
    subscriptions,
    /** The owner path `[P1-10]`: a key is required and the caller's applications hold none for it. */
    needsSubscription: key !== null && subscriptions.length === 0,
    operations: operationsFor(route, model),
    // A2A serves its card at a fixed path on the gateway, which is the copy worth seeing.
    agentCard: route.a2a ? { path: route.a2a.cardPath } : null,
    // Listed, not hidden: the console cannot hold a stream open, and the line that does work is
    // more useful than the control's absence (§2).
    streaming: streaming
      ? {
          kind: streaming,
          command:
            streaming === "websocket"
              ? `websocat "${base.replace(/^http/, "ws")}" -H "${key?.name ?? "X-Api-Key"}: $KEY"`
              : `curl -N "${base}" -H "${key?.name ?? "X-Api-Key"}: $KEY"`,
        }
      : null,
    warnings,
    limits: {
      maxBodyBytes: app.config.playgroundMaxBodyBytes,
      maxResponseBytes: app.config.playgroundMaxResponseBytes,
      timeoutMs: app.config.playgroundTimeoutMs,
      ratePerMin: app.config.playgroundRatePerMin,
      historyPerResource: app.config.playgroundHistoryPerResource,
      historyRetentionDays: app.config.playgroundHistoryRetentionDays,
    },
    note:
      "A call from here goes through the gateway like any other: it spends the subscription's " +
      "rate limit and quota and appears in telemetry.",
  };
}

function modelFor(app: App, revisionId: string): ApiModel | null {
  const row = app.db
    .query<{ model: string }, [string]>("SELECT model FROM revision WHERE id = ?")
    .get(revisionId);
  if (!row?.model) return null;
  try {
    return JSON.parse(row.model) as ApiModel;
  } catch {
    // A pruned or malformed model costs the prefill, not the form: the operation list comes from
    // the index, which is what the gateway is actually serving.
    return null;
  }
}

/**
 * The caller's own subscriptions that would work here: active, in this environment, held by an
 * application on an application the caller is in, for a product that contains this API. Anything else is a
 * key that produces a `403` the reader would read as a platform fault.
 */
function usableSubscriptions(
  app: App,
  user: User,
  route: ConfigRoute,
  environment: string,
): FormSubscription[] {
  if (route.productIds.length === 0) return [];
  const products = route.productIds.map(() => "?").join(", ");
  const rows = app.db
    .query<
      {
        id: string;
        application_id: string;
        application_name: string;
        product_name: string;
        secondary_key_enc: string | null;
      },
      string[]
    >(
      `SELECT s.id, a.id AS application_id, a.name AS application_name, p.name AS product_name, s.secondary_key_enc
         FROM subscription s
         JOIN application a ON a.id = s.application_id
         JOIN product p ON p.id = s.product_id
        WHERE s.state = 'active' AND s.environment = ? AND s.product_id IN (${products})
        ORDER BY a.name, p.name`,
    )
    .all(environment, ...route.productIds);

  return rows
    .filter((row) => user.isAdmin || user.applications.includes(row.application_id))
    .map((row) => ({
      id: row.id,
      name: `${row.application_name} → ${row.product_name}`,
      application: row.application_name,
      product: row.product_name,
      hasSecondary: row.secondary_key_enc !== null,
    }));
}

// --------------------------------------------------------------------------- per variant (§5.4)

function operationsFor(route: ConfigRoute, model: ApiModel | null): FormOperation[] {
  const declared = new Map((model?.operations ?? []).map((operation) => [operation.operationId, operation]));
  return route.operations.map((operation) => {
    const source = declared.get(operation.id) ?? null;
    switch (route.kind) {
      case "soap":
        return soapForm(route, operation, source);
      case "mcp":
      case "a2a":
        return rpcForm(operation, source, model);
      default:
        return restForm(operation, source, model);
    }
  });
}

function base(operation: ConfigOperation, source: ApiOperation | null): FormOperation {
  return {
    id: operation.id,
    name: operation.id,
    method: operation.method,
    template: operation.template,
    summary: operation.summary ?? source?.summary ?? null,
    pathParams: [],
    query: [],
    headers: [],
    body: null,
    bodyKind: null,
    schemaState: operation.schemaState,
    ...(operation.selector ? { selector: operation.selector } : {}),
  };
}

function restForm(
  operation: ConfigOperation,
  source: ApiOperation | null,
  model: ApiModel | null,
): FormOperation {
  const form = base(operation, source);
  // Path parameters come from the template rather than only from the declaration: a template with
  // a placeholder the document forgot to declare still needs a box, or the call cannot be made.
  const declared = new Map((source?.parameters ?? []).map((parameter) => [parameter.name, parameter]));
  for (const match of operation.template.matchAll(/\{([^}]+)\}/g)) {
    const name = match[1]!;
    form.pathParams.push(parameterFor(name, declared.get(name), true));
  }
  for (const parameter of source?.parameters ?? []) {
    if (parameter.in === "query") form.query.push(parameterFor(parameter.name, parameter, parameter.required));
    else if (parameter.in === "header") {
      form.headers.push(parameterFor(parameter.name, parameter, parameter.required));
    }
  }

  const body = bodySchemaFor(source);
  if (body) {
    form.body = JSON.stringify(exampleFor(body.schema, model), null, 2);
    form.bodyKind = "json";
    form.headers.push({ name: "content-type", required: false, value: body.mediaType });
  }
  return form;
}

/**
 * One endpoint, one method: every SOAP operation is a `POST` to the base path, and which operation
 * is being called is carried by the envelope and `SOAPAction`. That header is set here and shown
 * read-only in the console — getting it wrong is design §5.1's routing bypass, not something to
 * leave to typing.
 */
function soapForm(route: ConfigRoute, operation: ConfigOperation, source: ApiOperation | null): FormOperation {
  const form = base(operation, source);
  const version = route.soap?.version ?? "1.1";
  const envelopeNs =
    version === "1.2" ? "http://www.w3.org/2003/05/soap-envelope" : "http://schemas.xmlsoap.org/soap/envelope/";
  const element = source?.inputElement ?? operation.element ?? "";
  const parsed = element.match(/^\{([^}]*)\}(.+)$/);
  const namespace = parsed?.[1] ?? "";
  const local = parsed?.[2] ?? operation.id;

  form.body =
    `<soap:Envelope xmlns:soap="${envelopeNs}">\n` +
    "  <soap:Body>\n" +
    `    <op:${local}${namespace ? ` xmlns:op="${namespace}"` : ""}>\n` +
    "      <!-- the operation's own elements go here -->\n" +
    `    </op:${local}>\n` +
    "  </soap:Body>\n" +
    "</soap:Envelope>";
  form.bodyKind = "xml";
  form.headers.push({
    name: "content-type",
    required: true,
    value: version === "1.2" ? "application/soap+xml; charset=utf-8" : "text/xml; charset=utf-8",
  });
  if (version === "1.1") {
    form.headers.push({
      name: "SOAPAction",
      required: true,
      value: `"${operation.soapAction ?? ""}"`,
      description: "Set from the WSDL. The gateway checks it agrees with the envelope.",
    });
  }
  return form;
}

/** MCP and A2A: one endpoint, and the operation is a JSON-RPC method in the body. */
function rpcForm(
  operation: ConfigOperation,
  source: ApiOperation | null,
  model: ApiModel | null,
): FormOperation {
  const form = base(operation, source);
  const selector = operation.selector ?? operation.id;
  const [method, name] = selector.split(":");

  let params: unknown = {};
  if (method === "tools/call" && name) {
    const tool = model?.mcp?.tools.find((candidate) => candidate.name === name);
    params = { name, arguments: exampleFor(tool?.inputSchema ?? {}, model) };
  } else if (method === "initialize") {
    params = {
      protocolVersion: model?.mcp?.protocolVersion ?? "2025-06-18",
      capabilities: {},
      clientInfo: { name: "integration-portal-console", version: "1" },
    };
  } else if (method === "message/send") {
    params = {
      message: { role: "user", parts: [{ kind: "text", text: "Hello" }], messageId: "msg-1" },
    };
  }

  form.body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: method ?? selector, params }, null, 2);
  form.bodyKind = "json";
  form.headers.push({ name: "content-type", required: true, value: "application/json" });
  form.headers.push({ name: "accept", required: false, value: "application/json, text/event-stream" });
  return form;
}

function parameterFor(name: string, parameter: ApiParameter | undefined, required: boolean): FormParameter {
  return {
    name,
    required,
    value: scalarFor(parameter?.schema),
  };
}

function bodySchemaFor(source: ApiOperation | null): { mediaType: string; schema: unknown } | null {
  const content = source?.requestBody?.content;
  if (!content) return null;
  // JSON first, then whatever was declared: an example in a media type nobody reads is noise.
  const mediaType =
    Object.keys(content).find((type) => type.includes("json")) ?? Object.keys(content)[0];
  if (!mediaType) return null;
  // `content` maps a media type to the schema **as declared** — not to an OpenAPI media-type
  // object. The model normalizes both dialects into that one shape (`normalize.ts`).
  return { mediaType, schema: content[mediaType] ?? {} };
}

// --------------------------------------------------------------------------- the example generator

/**
 * A value that satisfies the schema, bounded to `MAX_DEPTH` and `MAX_NODES` with cycles broken
 * `[P1-08]`. A recursive or generated schema must not be able to hang this request, and a partial
 * example is worth more than none: the reader is going to edit it anyway.
 */
export function exampleFor(schema: unknown, model: ApiModel | null): unknown {
  const budget = { nodes: MAX_NODES };
  return generate(schema, model, 0, budget, new Set());
}

function generate(
  schema: unknown,
  model: ApiModel | null,
  depth: number,
  budget: { nodes: number },
  seen: Set<object>,
): unknown {
  if (budget.nodes-- <= 0 || depth > MAX_DEPTH) return null;
  if (typeof schema !== "object" || schema === null) return null;
  const node = schema as Record<string, unknown>;

  if (typeof node.$ref === "string") {
    const target = resolve(node.$ref, model);
    // A `$ref` that points back at something already on this path is the cycle: stop rather than
    // recurse, and say nothing rather than say something wrong.
    if (!target || seen.has(target)) return null;
    return generate(target, model, depth + 1, budget, new Set([...seen, target]));
  }

  // Whatever the document said, said back: an example is better than a guess.
  if (node.example !== undefined) return node.example;
  if (node.default !== undefined) return node.default;
  if (Array.isArray(node.enum) && node.enum.length > 0) return node.enum[0];
  for (const key of ["allOf", "oneOf", "anyOf"] as const) {
    const branches = node[key];
    if (Array.isArray(branches) && branches.length > 0) {
      if (key === "allOf") {
        const merged: Record<string, unknown> = {};
        for (const branch of branches) {
          const value = generate(branch, model, depth, budget, seen);
          if (value && typeof value === "object") Object.assign(merged, value);
        }
        return merged;
      }
      return generate(branches[0], model, depth, budget, seen);
    }
  }

  const type = Array.isArray(node.type) ? node.type[0] : node.type;
  if (type === "array" || node.items !== undefined) {
    const item = generate(node.items, model, depth + 1, budget, seen);
    return item === null ? [] : [item];
  }
  if (type === "object" || node.properties !== undefined) {
    const properties = (node.properties ?? {}) as Record<string, unknown>;
    const required = new Set((node.required as string[] | undefined) ?? []);
    const out: Record<string, unknown> = {};
    // Required first, so a tight budget spends itself on the fields the backend will insist on.
    const names = Object.keys(properties).sort(
      (a, b) => Number(required.has(b)) - Number(required.has(a)),
    );
    for (const name of names) {
      if (budget.nodes <= 0) break;
      out[name] = generate(properties[name], model, depth + 1, budget, seen);
    }
    return out;
  }
  return scalar(type, typeof node.format === "string" ? node.format : undefined);
}

function scalar(type: unknown, format: string | undefined): unknown {
  switch (type) {
    case "integer":
      return 0;
    case "number":
      return 0;
    case "boolean":
      return true;
    case "null":
      return null;
    default:
      return stringFor(format);
  }
}

function stringFor(format: string | undefined): string {
  switch (format) {
    case "date-time":
      return "2026-01-01T00:00:00Z";
    case "date":
      return "2026-01-01";
    case "uuid":
      return "00000000-0000-0000-0000-000000000000";
    case "email":
      return "someone@example.com";
    case "uri":
    case "url":
      return "https://example.com";
    case "byte":
      return "";
    default:
      return "string";
  }
}

/** A path parameter is a string in a form box, so its example is rendered rather than typed. */
function scalarFor(schema: unknown): string {
  if (typeof schema !== "object" || schema === null) return "";
  const node = schema as Record<string, unknown>;
  if (node.example !== undefined) return String(node.example);
  if (node.default !== undefined) return String(node.default);
  if (Array.isArray(node.enum) && node.enum.length > 0) return String(node.enum[0]);
  const type = Array.isArray(node.type) ? node.type[0] : node.type;
  if (type === "integer" || type === "number") return "0";
  if (type === "boolean") return "true";
  return "";
}

/**
 * `#/components/schemas/Pet` and `#/definitions/Pet` both resolve, because the model keeps the
 * shared schemas in the shape the source document wrote them in.
 */
function resolve(ref: string, model: ApiModel | null): Record<string, unknown> | null {
  if (!ref.startsWith("#/") || !model?.components) return null;
  let node: unknown = model.components;
  for (const segment of ref.slice(2).split("/")) {
    if (typeof node !== "object" || node === null) return null;
    node = (node as Record<string, unknown>)[segment.replace(/~1/g, "/").replace(/~0/g, "~")];
  }
  return typeof node === "object" && node !== null ? (node as Record<string, unknown>) : null;
}
