/**
 * JSON-RPC 2.0, as MCP and A2A both speak it (plan sections 9 and 10).
 *
 * Two variants, one envelope: `mcp` and `a2a` are single-endpoint protocols whose operation lives
 * inside the body, which is why design section 5.2's step 11 becomes "read the body, resolve the
 * method" for them — and why they buffer at that step whatever the validation state, since a
 * protocol that keeps its operation in the body cannot route without reading it.
 */

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: unknown;
}

/** Gateway rejections carry the real HTTP status *and* a JSON-RPC error body (plan `[R4-05]`). */
export const RPC_CODES = {
  unauthenticated: -32001,
  forbidden: -32002,
  rateLimited: -32003,
  unavailable: -32004,
  invalidParams: -32602,
  methodNotFound: -32601,
  parseError: -32700,
  invalidRequest: -32600,
  internal: -32000,
} as const;

export function codeForStatus(status: number): number {
  switch (status) {
    case 401:
      return RPC_CODES.unauthenticated;
    case 403:
      return RPC_CODES.forbidden;
    case 429:
      return RPC_CODES.rateLimited;
    case 400:
      return RPC_CODES.invalidParams;
    case 404:
      return RPC_CODES.methodNotFound;
    case 413:
      return RPC_CODES.invalidRequest;
    case 503:
      return RPC_CODES.unavailable;
    default:
      return status >= 500 ? RPC_CODES.internal : RPC_CODES.invalidRequest;
  }
}

export interface ParsedRpc {
  request: JsonRpcRequest;
  /** `null` for a notification, which is a legal request with no response. */
  id: string | number | null;
}

export type RpcParseResult =
  | { ok: true; parsed: ParsedRpc }
  | { ok: false; code: number; message: string };

/**
 * A batch is refused rather than partially handled. The current MCP revision removed batching, and
 * a gateway that authorized, rate-limited and validated a batch as one request would be counting
 * and checking the wrong thing.
 */
export function parseRpc(value: unknown): RpcParseResult {
  if (Array.isArray(value)) {
    return {
      ok: false,
      code: RPC_CODES.invalidRequest,
      message:
        "batched JSON-RPC requests are not accepted: policy, counting and validation apply per " +
        "call, and a batch would be authorized and counted as one",
    };
  }
  if (!value || typeof value !== "object") {
    return { ok: false, code: RPC_CODES.invalidRequest, message: "expected a JSON-RPC request object" };
  }
  const request = value as Record<string, unknown>;
  if (request.jsonrpc !== "2.0") {
    return { ok: false, code: RPC_CODES.invalidRequest, message: 'expected "jsonrpc": "2.0"' };
  }
  if (typeof request.method !== "string" || request.method.length === 0) {
    return { ok: false, code: RPC_CODES.invalidRequest, message: "expected a method name" };
  }
  const id =
    typeof request.id === "string" || typeof request.id === "number" ? request.id : null;
  return {
    ok: true,
    parsed: {
      request: { jsonrpc: "2.0", method: request.method, id, params: request.params },
      id,
    },
  };
}

export function rpcErrorBody(
  id: string | number | null,
  code: number,
  message: string,
  data?: Record<string, unknown>,
): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id,
    error: { code, message, ...(data ? { data } : {}) },
  });
}
