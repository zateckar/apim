/** Shared vocabulary for both planes. Mirrors design section 4's data model. */
import type { XsdBundle } from "./xsd.ts";

/**
 * v3 implements four of design section 4.4's variants. The set stays closed and is extended by
 * reviewed work in the codebase, never by configuration: a variant carries a request shape and a
 * validation model, which is more than a config file should be able to introduce.
 */
export const RESOURCE_KINDS = ["rest", "soap", "mcp", "a2a"] as const;
export type ResourceKind = (typeof RESOURCE_KINDS)[number];

/** The two variants whose request shape is a JSON-RPC call to one endpoint (plan section 9, 10). */
export const RPC_KINDS: readonly ResourceKind[] = ["mcp", "a2a"];

export const LIFECYCLES = ["active", "deprecated", "retired"] as const;
export type Lifecycle = (typeof LIFECYCLES)[number];

/**
 * Enumerable, not just a union: the UI's status vocabulary is asserted **total** over these
 * lists (plan §9.4), and a list you cannot iterate cannot be checked for totality.
 *
 * `stale` is a release overtaken before it was applied: one confirmed after it has already reached
 * the fleet in that environment (api-versioning-and-stage). Design section 6.3's other meaning, a
 * plan digest that moved, no longer produces it; a changed plan is re-computed instead.
 */
export const RELEASE_STATES = [
  "pending",
  "converging",
  "converged",
  "superseded",
  "withdrawn",
  "failed",
  "stale",
] as const;
export type ReleaseState = (typeof RELEASE_STATES)[number];

/**
 * `superseded` and `withdrawn` are reachable only from `converged`, enforced by a trigger, which
 * is what lets the promotion gate read "has this revision ever reached the fleet here" from
 * `release.state` alone (design section 6.2, review V2-02).
 */
export const REACHED_FLEET_STATES: ReleaseState[] = ["converged", "superseded", "withdrawn"];

/**
 * What a durable operation is doing (`control-plane-surface` §"an operation moves through states").
 *
 * `applying` is the phase inside the apply transaction: the spec names it, and the reconciler
 * passes through it without persisting a row, because the transaction that would write it is the
 * one doing the work. It is listed anyway — the vocabulary has to have a word ready for a state
 * the contract promises, or the day it is persisted the portal shows a blank chip.
 *
 * `superseded` is likewise never written today, only defended against: several queries read
 * `state <> 'superseded'` so a later change to the same API can overtake an earlier one.
 */
export const OPERATION_STATES = [
  "queued",
  "applying",
  "retrying",
  "blocked",
  "waiting-for-gateways",
  "complete",
  "superseded",
] as const;
export type OperationState = (typeof OPERATION_STATES)[number];

/**
 * A consumer's access to a product, from asking to losing it.
 *
 * `cancelled` is the consumer withdrawing their own request before it was decided; `rejected` is
 * the publisher declining it. Both end the request and neither is `revoked`, which is access that
 * existed and was taken away.
 */
/**
 * How old a subscription key may get.
 *
 * Two numbers, and they mean different things. `warn` is when the portal starts saying so — on the
 * subscription, on the dashboard's attention list and in the owner's mail. `expire` is when the key
 * stops working: it is dropped from the environment's configuration document, so the gateway that
 * has never heard of an expiry simply does not know the key and answers `401`.
 *
 * The gap between them is the runway. It is deliberately most of a year by default, because the
 * remedy — rotate the idle slot, move callers across, rotate the other — is work somebody has to
 * schedule with the teams that call them, and a warning that arrives a fortnight before the key
 * dies is an outage with extra steps.
 *
 * Neither is stored on the row. They are read at request time and applied to the key's own minting
 * date, so an administrator who changes the policy changes it for the keys that already exist. A
 * stored `expires_at` would apply the new number to keys minted afterwards and leave the estate
 * holding two answers about the same deadline.
 */
export const SUBSCRIPTION_KEY_DEFAULTS = {
  warnDays: 365,
  expireDays: 600,
} as const;

export const SUBSCRIPTION_STATES = [
  "pending",
  "activating",
  "active",
  "revoking",
  "revoked",
  "rejected",
  "cancelled",
] as const;
export type SubscriptionState = (typeof SUBSCRIPTION_STATES)[number];

/** A simulated Kafka topic: the broker confirms it before it can be produced to. */
export const KAFKA_TOPIC_STATES = ["provisioning", "ready", "deleted"] as const;
export type KafkaTopicState = (typeof KAFKA_TOPIC_STATES)[number];

/** One application's access to one topic. The same seven steps as a subscription. */
export const KAFKA_GRANT_STATES = SUBSCRIPTION_STATES;
export type KafkaGrantState = SubscriptionState;

/**
 * An outbox entry for one of the six simulated external systems.
 *
 * Three terminal states rather than one, because they are three different facts: `delivered` is
 * the system accepted it, `completed` is FixMe's diagnostics running to the end, and
 * `awaiting-decision` is SkoNET holding it for a person — which then becomes `approved` or
 * `rejected` (`skonet-integration` §"a request settles in awaiting-decision").
 */
export const INTEGRATION_EVENT_STATES = [
  "queued",
  "retrying",
  "delivered",
  "completed",
  "awaiting-decision",
  "approved",
  "rejected",
] as const;
export type IntegrationEventState = (typeof INTEGRATION_EVENT_STATES)[number];

export type PolicyOrigin = "local" | "seeded";

/** Normalized API model (design section 4.1). Everything downstream reads this, not the upload. */
export interface ApiModel {
  title: string;
  version: string;
  description?: string;
  /** Declared servers from the source document, most specific first. */
  servers: string[];
  operations: ApiOperation[];
  /** Present only for `soap`: what a WSDL carries that OpenAPI has no place for. */
  soap?: SoapBinding;
  /** Present only for `mcp` (plan section 9). */
  mcp?: McpBinding;
  /** Present only for `a2a` (plan section 10). */
  a2a?: A2aBinding;
  /**
   * Shared schemas the operations' `$ref`s point into, kept in the document's own shape
   * (`{ components: { schemas } }` or `{ definitions }`) so a reference resolves the way it was
   * written. Compilation into a validator happens once, in `artifacts.ts`.
   */
  components?: Record<string, unknown>;
  /** Which dialect the schemas in this model are written in, resolved once at normalization. */
  schemaDialect?: "2020-12" | "oas-3.0" | "swagger-2.0";
}

export interface SoapBinding {
  version: "1.1" | "1.2";
  service: string;
  port: string;
  /** `soap:address location` — what `binding.backend_json` is prefilled from. */
  endpoint: string;
  targetNamespace: string;
  /**
   * The WSDL's inline schemas, already compiled (plan section 6.1). XSD has no compact JSON form
   * of its own, so the compiled bundle *is* how the model carries the schema set — which also
   * means a schema-only change to a WSDL changes `version_digest`, as a contract change should.
   */
  schema?: XsdBundle;
}

export interface McpBinding {
  protocolVersion: string;
  serverInfo: { name: string; version?: string };
  capabilities: Record<string, unknown>;
  tools: McpTool[];
  resources: Array<{ uri: string; name?: string; description?: string; mimeType?: string }>;
  prompts: Array<{ name: string; description?: string }>;
}

export interface McpTool {
  name: string;
  title?: string;
  description?: string;
  /** JSON Schema for `params.arguments` of `tools/call`. */
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
}

export interface A2aBinding {
  protocolVersion: string;
  name: string;
  description?: string;
  version: string;
  /** Where the card was fetched from — what the gateway rewrites away (plan `[R1-16]`). */
  originUrl: string;
  preferredTransport?: string;
  capabilities: { streaming?: boolean; pushNotifications?: boolean; stateTransitionHistory?: boolean };
  defaultInputModes: string[];
  defaultOutputModes: string[];
  skills: A2aSkill[];
  /** The origin's schemes, kept for the record; the gateway advertises its own instead. */
  securitySchemes?: Record<string, unknown>;
  documentationUrl?: string;
  provider?: { organization?: string; url?: string };
}

export interface A2aSkill {
  id: string;
  name: string;
  description?: string;
  tags: string[];
  examples?: string[];
  inputModes?: string[];
  outputModes?: string[];
}

export interface ApiOperation {
  operationId: string;
  method: string;
  /** Path template as declared, e.g. `/pet/{petId}`. Relative to the server URL. */
  path: string;
  summary?: string;
  parameters: ApiParameter[];
  /**
   * SOAP only. `soapAction` may legitimately be the empty string — WSDL 1.1 allows it and SOAP
   * 1.2 has no SOAPAction header at all — so absent and "" are the same thing when the data plane
   * checks agreement (review V1-10).
   */
  soapAction?: string;
  /** `{namespace}LocalName` of the body's first child element, the operation's identity. */
  inputElement?: string;
  outputElement?: string;
  /**
   * The JSON-RPC method (and, for an MCP tool call, its tool name) that selects this operation on
   * a single-endpoint variant. `tools/call:search` reads as "the method, then what it names".
   */
  selector?: string;
  /** Raw schemas as written in the source document; compiled in `artifacts.ts`. */
  requestBody?: ApiRequestBody;
  /** Keyed by status code, or `default`. */
  responses?: Record<string, ApiResponse>;
}

export interface ApiRequestBody {
  required: boolean;
  /** Media type → schema, exactly as declared. An absent schema means "no contract for this type". */
  content: Record<string, unknown>;
}

export interface ApiResponse {
  description?: string;
  content?: Record<string, unknown>;
  headers?: ApiParameter[];
}

export interface ApiParameter {
  name: string;
  in: "path" | "query" | "header" | "cookie" | "body" | "formData";
  required: boolean;
  /** The parameter's schema as declared. Strings are coerced to it before validation. */
  schema?: unknown;
}

export type OriginalFormat =
  | "swagger-2.0"
  | "openapi-3.0"
  | "openapi-3.1"
  | "wsdl-1.1"
  | "mcp-manifest"
  | "a2a-agent-card";

/** Contract versions are positive integer identifiers: v1, v2, … (api-versioning-and-stage). */
export const API_VERSION_PATTERN = /^v[1-9][0-9]{0,30}$/;
