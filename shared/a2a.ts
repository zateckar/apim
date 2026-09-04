/**
 * A2A as a published API variant (goal G5, design section 4.4's `a2a`).
 *
 * An A2A agent publishes an **Agent Card** describing what it can do and where to reach it, and
 * speaks JSON-RPC 2.0 for the rest. Publishing one through this platform means two things:
 *
 *  - the contract is the card, normalized into the same `ApiModel` every other variant uses;
 *  - **the gateway serves the card itself, rewritten**, so `url` points at the route and the
 *    security schemes describe the gateway's own. Publishing an endpoint means consumers talk to
 *    us; a card that still pointed at the origin would send every consumer straight past every
 *    policy this platform exists to apply (plan `[R1-16]`).
 */
import type { A2aBinding, ApiOperation } from "./types.ts";

export const A2A_PROTOCOL_VERSION = "0.3.0";
export const AGENT_CARD_PATH = "/.well-known/agent-card.json";
/** The pre-0.3 location, still served by agents in the wild. */
export const LEGACY_AGENT_CARD_PATH = "/.well-known/agent.json";

export interface A2aMethodSpec {
  method: string;
  summary: string;
  params?: Record<string, unknown>;
  /** Methods that answer with an SSE stream and therefore need `passthrough.sse`. */
  streaming?: boolean;
  capability?: "streaming" | "pushNotifications";
}

const MESSAGE_PART = {
  type: "object",
  required: ["kind"],
  properties: {
    kind: { enum: ["text", "file", "data"] },
    text: { type: "string" },
    data: { type: "object" },
    file: {
      type: "object",
      properties: {
        name: { type: "string" },
        mimeType: { type: "string" },
        uri: { type: "string" },
        bytes: { type: "string" },
      },
    },
  },
};

const MESSAGE = {
  type: "object",
  required: ["role", "parts"],
  properties: {
    role: { enum: ["user", "agent"] },
    messageId: { type: "string", maxLength: 256 },
    taskId: { type: "string", maxLength: 256 },
    contextId: { type: "string", maxLength: 256 },
    kind: { const: "message" },
    parts: { type: "array", minItems: 1, maxItems: 100, items: MESSAGE_PART },
    metadata: { type: "object" },
  },
};

const SEND_PARAMS = {
  type: "object",
  required: ["message"],
  properties: {
    message: MESSAGE,
    configuration: {
      type: "object",
      properties: {
        acceptedOutputModes: { type: "array", items: { type: "string" } },
        blocking: { type: "boolean" },
        historyLength: { type: "integer", minimum: 0 },
      },
    },
    metadata: { type: "object" },
  },
};

const TASK_ID_PARAMS = {
  type: "object",
  required: ["id"],
  properties: {
    id: { type: "string", maxLength: 256 },
    historyLength: { type: "integer", minimum: 0 },
    metadata: { type: "object" },
  },
};

export const A2A_METHODS: A2aMethodSpec[] = [
  { method: "message/send", summary: "Send a message and wait for the result", params: SEND_PARAMS },
  {
    method: "message/stream",
    summary: "Send a message and stream updates as they happen",
    params: SEND_PARAMS,
    streaming: true,
    capability: "streaming",
  },
  { method: "tasks/get", summary: "Read a task's current state", params: TASK_ID_PARAMS },
  { method: "tasks/cancel", summary: "Cancel a task", params: TASK_ID_PARAMS },
  {
    method: "tasks/resubscribe",
    summary: "Re-attach to a task's update stream",
    params: TASK_ID_PARAMS,
    streaming: true,
    capability: "streaming",
  },
  {
    method: "tasks/pushNotificationConfig/set",
    summary: "Register a push-notification target for a task",
    capability: "pushNotifications",
    params: {
      type: "object",
      required: ["taskId", "pushNotificationConfig"],
      properties: {
        taskId: { type: "string", maxLength: 256 },
        pushNotificationConfig: {
          type: "object",
          required: ["url"],
          properties: {
            id: { type: "string" },
            url: { type: "string", maxLength: 2048 },
            token: { type: "string" },
          },
        },
      },
    },
  },
  {
    method: "tasks/pushNotificationConfig/get",
    summary: "Read a task's push-notification target",
    capability: "pushNotifications",
    params: TASK_ID_PARAMS,
  },
  {
    method: "agent/getAuthenticatedExtendedCard",
    summary: "Read the extended agent card available to authenticated callers",
    params: { type: "object" },
  },
];

export function operationsFromCard(binding: A2aBinding): ApiOperation[] {
  const operations: ApiOperation[] = [];
  for (const spec of A2A_METHODS) {
    if (spec.capability === "streaming" && !binding.capabilities.streaming) continue;
    if (spec.capability === "pushNotifications" && !binding.capabilities.pushNotifications) continue;
    operations.push({
      operationId: spec.method,
      method: "POST",
      path: "/",
      selector: spec.method,
      summary: spec.summary,
      parameters: [],
      ...(spec.params
        ? {
            requestBody: {
              required: true,
              content: {
                "application/json": {
                  type: "object",
                  required: ["jsonrpc", "method"],
                  properties: {
                    jsonrpc: { const: "2.0" },
                    id: { type: ["string", "number", "null"] },
                    method: { const: spec.method },
                    params: spec.params,
                  },
                },
              },
            },
          }
        : {}),
    });
  }
  operations.sort((a, b) => a.operationId.localeCompare(b.operationId));
  return operations;
}

export function isStreamingMethod(method: string): boolean {
  return A2A_METHODS.some((spec) => spec.method === method && spec.streaming === true);
}

/**
 * The card the gateway serves. `url` becomes this route's public URL and `securitySchemes` become
 * the gateway's own, because a consumer following this card must reach the gateway.
 */
export function rewriteCard(
  binding: A2aBinding,
  options: {
    url: string;
    /** The subscription key header, when one is required on this route. */
    apiKeyHeader?: string | null;
  },
): Record<string, unknown> {
  const security: Record<string, unknown> = {};
  const requirements: Array<Record<string, string[]>> = [];
  if (options.apiKeyHeader) {
    security.subscriptionKey = {
      type: "apiKey",
      in: "header",
      name: options.apiKeyHeader,
      description: "A subscription key issued by the Integration Portal for this product.",
    };
    requirements.push({ subscriptionKey: [] });
  }

  return {
    protocolVersion: binding.protocolVersion,
    name: binding.name,
    ...(binding.description ? { description: binding.description } : {}),
    version: binding.version,
    url: options.url,
    preferredTransport: binding.preferredTransport ?? "JSONRPC",
    capabilities: binding.capabilities,
    defaultInputModes: binding.defaultInputModes,
    defaultOutputModes: binding.defaultOutputModes,
    skills: binding.skills,
    ...(binding.provider ? { provider: binding.provider } : {}),
    ...(binding.documentationUrl ? { documentationUrl: binding.documentationUrl } : {}),
    ...(Object.keys(security).length > 0
      ? { securitySchemes: security, security: requirements }
      : {}),
  };
}
