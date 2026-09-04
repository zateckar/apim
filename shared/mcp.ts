/**
 * MCP as a published API variant (goal G4, design section 4.4's `mcp`).
 *
 * An MCP server is already an API: it has a contract (its tool list, each tool carrying a JSON
 * Schema for its arguments), an endpoint, and callers who need to be authenticated, rate limited
 * and kept honest. What it lacks is everything this platform provides — subscriptions, promotion,
 * telemetry, policy — so publishing one means normalizing its manifest into the same `ApiModel`
 * every other variant uses, and letting the rest of the spine work unchanged.
 *
 * The whole variant is therefore two things: how the contract is discovered, and how the operation
 * is resolved out of a JSON-RPC body. Everything else is the ordinary pipeline.
 */
import type { ApiOperation, McpBinding, McpTool } from "./types.ts";

export const MCP_PROTOCOL_VERSION = "2025-06-18";
export const MCP_SESSION_HEADER = "mcp-session-id";
export const MCP_PROTOCOL_HEADER = "mcp-protocol-version";

/** The method a `tools/call` names, as an operation selector: `tools/call:<tool>`. */
export function toolSelector(name: string): string {
  return `tools/call:${name}`;
}

export interface McpMethodSpec {
  method: string;
  summary: string;
  /** JSON Schema for `params`, as written — compiled with everything else in `artifacts.ts`. */
  params?: Record<string, unknown>;
  /** The capability a server must declare for this method to be published. */
  capability?: "tools" | "resources" | "prompts" | "logging" | "completions";
}

/**
 * The protocol methods, with fixed schemas. They are operations like any other, so a publisher can
 * rate limit `tools/list` differently from `tools/call`, and validation rejects a malformed
 * `params` before it reaches the server.
 */
export const MCP_METHODS: McpMethodSpec[] = [
  {
    method: "initialize",
    summary: "Negotiate the protocol version and exchange capabilities",
    params: {
      type: "object",
      required: ["protocolVersion", "capabilities"],
      properties: {
        protocolVersion: { type: "string", maxLength: 64 },
        capabilities: { type: "object" },
        clientInfo: {
          type: "object",
          properties: { name: { type: "string" }, version: { type: "string" } },
        },
      },
    },
  },
  { method: "ping", summary: "Liveness check", params: { type: "object" } },
  {
    method: "tools/list",
    summary: "List the tools this server offers",
    capability: "tools",
    params: { type: "object", properties: { cursor: { type: "string", maxLength: 512 } } },
  },
  {
    method: "resources/list",
    summary: "List the resources this server offers",
    capability: "resources",
    params: { type: "object", properties: { cursor: { type: "string", maxLength: 512 } } },
  },
  {
    method: "resources/templates/list",
    summary: "List the resource templates this server offers",
    capability: "resources",
    params: { type: "object", properties: { cursor: { type: "string", maxLength: 512 } } },
  },
  {
    method: "resources/read",
    summary: "Read one resource",
    capability: "resources",
    params: {
      type: "object",
      required: ["uri"],
      properties: { uri: { type: "string", maxLength: 2048 } },
    },
  },
  {
    method: "prompts/list",
    summary: "List the prompts this server offers",
    capability: "prompts",
    params: { type: "object", properties: { cursor: { type: "string", maxLength: 512 } } },
  },
  {
    method: "prompts/get",
    summary: "Render one prompt",
    capability: "prompts",
    params: {
      type: "object",
      required: ["name"],
      properties: { name: { type: "string", maxLength: 256 }, arguments: { type: "object" } },
    },
  },
];

/** Notifications a client may send. They carry no id and expect no response. */
export const MCP_NOTIFICATIONS = ["notifications/initialized", "notifications/cancelled"];

/**
 * One operation per tool plus one per supported protocol method. A tool's `inputSchema` becomes
 * the schema for `params.arguments`, so design section 5.1's blocking default rejects a malformed
 * tool call at the gateway — before the server, with a typed error.
 */
export function operationsFromManifest(binding: McpBinding): ApiOperation[] {
  const operations: ApiOperation[] = [];

  for (const spec of MCP_METHODS) {
    if (spec.capability && !binding.capabilities[spec.capability]) continue;
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
              content: { "application/json": rpcEnvelopeSchema(spec.method, spec.params) },
            },
          }
        : {}),
    });
  }

  for (const tool of binding.tools) {
    operations.push({
      operationId: toolSelector(tool.name),
      method: "POST",
      path: "/",
      selector: toolSelector(tool.name),
      summary: tool.description ?? tool.title ?? `Call the ${tool.name} tool`,
      parameters: [],
      requestBody: {
        required: true,
        content: { "application/json": toolCallSchema(tool) },
      },
    });
  }

  operations.sort((a, b) => a.operationId.localeCompare(b.operationId));
  return operations;
}

/** The whole JSON-RPC envelope, so `jsonrpc`, `method` and `params` are all checked at once. */
function rpcEnvelopeSchema(method: string, params: Record<string, unknown>): Record<string, unknown> {
  return {
    type: "object",
    required: ["jsonrpc", "method"],
    properties: {
      jsonrpc: { const: "2.0" },
      id: { type: ["string", "number", "null"] },
      method: { const: method },
      params,
    },
  };
}

function toolCallSchema(tool: McpTool): Record<string, unknown> {
  return rpcEnvelopeSchema("tools/call", {
    type: "object",
    required: ["name"],
    properties: {
      name: { const: tool.name },
      // A tool with no declared input schema is reported as `no-schema` for that operation rather
      // than validated against a guess.
      ...(tool.inputSchema ? { arguments: tool.inputSchema } : {}),
    },
  });
}

/** Resolves a JSON-RPC body to an operation id: the method, or the tool it names. */
export function selectorFor(method: string, params: unknown): string {
  if (method !== "tools/call") return method;
  const name = (params as { name?: unknown } | undefined)?.name;
  return typeof name === "string" ? toolSelector(name) : "tools/call";
}
