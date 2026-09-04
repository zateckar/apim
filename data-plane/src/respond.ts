import { codeForStatus, rpcErrorBody } from "../../shared/jsonrpc.ts";
import type { ErrorFormatUnit } from "../../shared/policy.ts";
import { soapContentType, soapFault } from "../../shared/soap.ts";

/**
 * One place writes gateway response bodies (plan section 5). `errorFormat` arrives resolved in
 * every route's policy document, so nothing here computes a default and there is no second
 * renderer to drift from this one.
 */
export const DEFAULT_ERROR_FORMAT: ErrorFormatUnit = { shape: "problem+json" };

export const STATUS_TITLES: Record<number, string> = {
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  405: "Method Not Allowed",
  409: "Conflict",
  413: "Payload Too Large",
  415: "Unsupported Media Type",
  429: "Too Many Requests",
  // Not an IANA status. Nginx's convention for "client closed request", and it never reaches a
  // client by definition — it exists so the outcome has something to be recorded against.
  499: "Client Closed Request",
  500: "Internal Server Error",
  502: "Bad Gateway",
  503: "Service Unavailable",
  504: "Gateway Timeout",
};

export function gatewayError(
  format: ErrorFormatUnit,
  status: number,
  title: string,
  detail: string,
  requestId: string,
  extra: Record<string, unknown> = {},
  headers: Record<string, string> = {},
  /** The JSON-RPC id to answer with, when the body had already been parsed (plan `[R2-07]`). */
  rpcId: string | number | null = null,
): Response {
  if (format.shape === "jsonrpc") {
    // The real HTTP status *and* a JSON-RPC error body: an MCP or A2A client reads the status, and
    // the edge proxy reads nothing else. The specification allows a non-200 carrying an error.
    const body = rpcErrorBody(rpcId, codeForStatus(status), detail, {
      status,
      requestId,
      title,
      ...extra,
    });
    return new Response(body, {
      status,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "content-length": String(Buffer.byteLength(body, "utf8")),
        "x-request-id": requestId,
        ...headers,
      },
    });
  }
  if (format.shape === "soap-fault") {
    const body = soapFault({
      version: format.soapVersion ?? "1.1",
      status,
      reason: detail,
      requestId,
    });
    return new Response(body, {
      // The real HTTP status, not 500: a consumer that reads status codes keeps working, and
      // Retry-After on a 429 still means something.
      status,
      headers: {
        "content-type": soapContentType(format.soapVersion ?? "1.1"),
        // Set explicitly because it is known, and because it is how the pipeline accounts for
        // bytes out without re-serialising the body.
        "content-length": String(Buffer.byteLength(body, "utf8")),
        "x-request-id": requestId,
        ...headers,
      },
    });
  }
  const body = JSON.stringify({ type: "about:blank", title, status, detail, requestId, ...extra });
  return new Response(body, {
    status,
    headers: {
      "content-type": "application/problem+json; charset=utf-8",
      "content-length": String(Buffer.byteLength(body, "utf8")),
      "x-request-id": requestId,
      ...headers,
    },
  });
}

/** Kept for the paths that run before a route is known, where there is no policy to consult. */
export function problem(
  status: number,
  title: string,
  detail: string,
  requestId: string,
  extra: Record<string, unknown> = {},
  headers: Record<string, string> = {},
): Response {
  return gatewayError(DEFAULT_ERROR_FORMAT, status, title, detail, requestId, extra, headers);
}
