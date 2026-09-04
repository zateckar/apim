import {
  MCP_PROTOCOL_VERSION,
  MCP_PROTOCOL_HEADER,
  MCP_SESSION_HEADER,
  operationsFromManifest,
} from "../../shared/mcp.ts";
import type { ApiModel, McpBinding, McpTool } from "../../shared/types.ts";
import { checkEgress, type Integrations } from "./egress.ts";
import { badGateway, badRequest } from "./router.ts";
import type { NormalizeResult } from "./normalize.ts";

/**
 * Publishing an existing MCP server (goal G4, plan section 9).
 *
 * An MCP server has no document to upload — its contract is something you ask it for. So discovery
 * *is* the import: the control plane speaks the protocol once, at publish time, and freezes what it
 * heard as a revision. Everything after that is the ordinary spine — the same revision, digest,
 * promotion, policy and validation every other variant gets.
 *
 * Three consequences are deliberate:
 *
 *  - **The manifest is the `original`.** It is stored verbatim, so "what did this server say when
 *    we published it" is answerable years later, and `regenerate` has something to diff against.
 *  - **A server that changes its tools produces a new revision, not a silent drift.** That is the
 *    whole reason discovery is frozen rather than live: a tool whose arguments changed would
 *    otherwise start failing validation against a contract nobody edited.
 *  - **Discovery is a fetch of an owner-supplied URL**, so it passes `checkEgress`, never follows a
 *    redirect and is bounded in bytes and seconds, exactly like `specUrl` (plan `[R2-40]`).
 */

/** The shape stored as `revision.original`: everything discovery learned, in one document. */
export interface McpManifest {
  protocolVersion: string;
  serverInfo: { name: string; version?: string };
  capabilities: Record<string, unknown>;
  tools: McpTool[];
  resources: Array<{ uri: string; name?: string; description?: string; mimeType?: string }>;
  prompts: Array<{ name: string; description?: string }>;
  /** Where it was discovered, when it was discovered by URL rather than uploaded. */
  originUrl?: string;
}

export interface DiscoverOptions {
  integrations: Integrations;
  maxBytes: number;
  timeoutMs?: number;
  /** Injectable so a test drives a server object rather than a socket. */
  fetchImpl?: typeof fetch;
}

const PAGE_LIMIT = 20;

export function looksLikeMcpManifest(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{")) return false;
  try {
    const doc = JSON.parse(trimmed) as Record<string, unknown>;
    return doc.serverInfo !== undefined && doc.capabilities !== undefined;
  } catch {
    return false;
  }
}

/**
 * One operation per tool plus one per supported protocol method, and `model.mcp` carrying what the
 * catalog renders. The title is the server's own name: an MCP server already has one, and inventing
 * a second would give the catalog two answers to the same question.
 */
export function normalizeMcp(raw: string): NormalizeResult {
  let doc: Record<string, unknown>;
  try {
    doc = JSON.parse(raw.trim()) as Record<string, unknown>;
  } catch (err) {
    throw badRequest(`the MCP manifest is not valid JSON: ${(err as Error).message}`);
  }
  const manifest = readManifest(doc);
  const binding: McpBinding = {
    protocolVersion: manifest.protocolVersion,
    serverInfo: manifest.serverInfo,
    capabilities: manifest.capabilities,
    tools: manifest.tools,
    resources: manifest.resources,
    prompts: manifest.prompts,
  };

  const model: ApiModel = {
    title: manifest.serverInfo.name,
    version: manifest.serverInfo.version ?? manifest.protocolVersion,
    ...(descriptionOf(manifest) ? { description: descriptionOf(manifest)! } : {}),
    servers: manifest.originUrl ? [manifest.originUrl] : [],
    operations: operationsFromManifest(binding),
    mcp: binding,
    // Tool schemas are written as plain JSON Schema, which is the 2020-12 dialect for our purposes:
    // there is no OpenAPI wrapper here to give `nullable` or `example` a different meaning.
    schemaDialect: "2020-12",
  };
  return { model, format: "mcp-manifest" };
}

function descriptionOf(manifest: McpManifest): string | undefined {
  const counts = [
    `${manifest.tools.length} tool${manifest.tools.length === 1 ? "" : "s"}`,
    ...(manifest.resources.length > 0 ? [`${manifest.resources.length} resources`] : []),
    ...(manifest.prompts.length > 0 ? [`${manifest.prompts.length} prompts`] : []),
  ];
  return `MCP server speaking protocol ${manifest.protocolVersion}, offering ${counts.join(", ")}.`;
}

/**
 * Reads a manifest defensively. Everything here came off the network from a server this platform
 * does not control, so a missing capability is an absent section rather than a crash, and a tool
 * without a name is dropped rather than published as an operation nobody can call.
 */
function readManifest(doc: Record<string, unknown>): McpManifest {
  const serverInfo = asRecord(doc.serverInfo);
  const name = typeof serverInfo.name === "string" && serverInfo.name.length > 0 ? serverInfo.name : null;
  if (!name) {
    throw badRequest("the MCP manifest has no serverInfo.name, so there is nothing to publish it as");
  }
  const capabilities = asRecord(doc.capabilities);
  const tools = asArray(doc.tools)
    .map((entry) => readTool(asRecord(entry)))
    .filter((tool): tool is McpTool => tool !== null);
  if (capabilities.tools !== undefined && tools.length === 0) {
    // Not an error: a server may legitimately expose the capability and no tools yet. Said out
    // loud because "published, zero operations" is otherwise a puzzling catalog entry.
    capabilities.tools = capabilities.tools ?? {};
  }
  return {
    protocolVersion:
      typeof doc.protocolVersion === "string" ? doc.protocolVersion : MCP_PROTOCOL_VERSION,
    serverInfo: {
      name,
      ...(typeof serverInfo.version === "string" ? { version: serverInfo.version } : {}),
    },
    capabilities,
    tools,
    resources: asArray(doc.resources)
      .map((entry) => asRecord(entry))
      .filter((entry) => typeof entry.uri === "string")
      .map((entry) => ({
        uri: entry.uri as string,
        ...(typeof entry.name === "string" ? { name: entry.name } : {}),
        ...(typeof entry.description === "string" ? { description: entry.description } : {}),
        ...(typeof entry.mimeType === "string" ? { mimeType: entry.mimeType } : {}),
      })),
    prompts: asArray(doc.prompts)
      .map((entry) => asRecord(entry))
      .filter((entry) => typeof entry.name === "string")
      .map((entry) => ({
        name: entry.name as string,
        ...(typeof entry.description === "string" ? { description: entry.description } : {}),
      })),
    ...(typeof doc.originUrl === "string" ? { originUrl: doc.originUrl } : {}),
  };
}

function readTool(entry: Record<string, unknown>): McpTool | null {
  if (typeof entry.name !== "string" || entry.name.length === 0) return null;
  return {
    name: entry.name,
    ...(typeof entry.title === "string" ? { title: entry.title } : {}),
    ...(typeof entry.description === "string" ? { description: entry.description } : {}),
    ...(isPlainObject(entry.inputSchema) ? { inputSchema: entry.inputSchema } : {}),
    ...(isPlainObject(entry.outputSchema) ? { outputSchema: entry.outputSchema } : {}),
  };
}

/**
 * Speaks MCP over Streamable HTTP well enough to learn a contract: initialize, then the lists the
 * server says it has. Paging is followed to `PAGE_LIMIT` pages — bounded, because a server that
 * always returns a cursor would otherwise page forever.
 */
export async function discoverMcp(discoverUrl: string, options: DiscoverOptions): Promise<McpManifest> {
  const errors = await checkEgress(discoverUrl, options.integrations, "discoverUrl");
  if (errors.length > 0) throw badRequest(errors.join("; "));

  const call = rpcCaller(discoverUrl, options);

  const initialized = asRecord(
    await call("initialize", {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "apim-control-plane", version: "3" },
    }),
  );
  const serverInfo = asRecord(initialized.serverInfo);
  if (typeof serverInfo.name !== "string") {
    throw badRequest(
      `${discoverUrl} answered initialize without a serverInfo.name; it does not look like an MCP server`,
    );
  }
  const capabilities = asRecord(initialized.capabilities);
  // Not a request: the server is told the handshake finished, and a server that ignores it is
  // still usable, so a failure here must not fail the import.
  await call("notifications/initialized", {}, { notification: true }).catch(() => undefined);

  const tools = capabilities.tools ? await page(call, "tools/list", "tools") : [];
  const resources = capabilities.resources ? await page(call, "resources/list", "resources") : [];
  const prompts = capabilities.prompts ? await page(call, "prompts/list", "prompts") : [];

  return readManifest({
    protocolVersion: initialized.protocolVersion,
    serverInfo,
    capabilities,
    tools,
    resources,
    prompts,
    originUrl: discoverUrl,
  });
}

type RpcCall = (
  method: string,
  params: Record<string, unknown>,
  opts?: { notification?: boolean },
) => Promise<unknown>;

function rpcCaller(url: string, options: DiscoverOptions): RpcCall {
  const doFetch = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 20_000;
  let sessionId: string | null = null;
  let id = 0;

  return async (method, params, opts = {}) => {
    const body = JSON.stringify({
      jsonrpc: "2.0",
      ...(opts.notification ? {} : { id: ++id }),
      method,
      params,
    });
    const headers: Record<string, string> = {
      "content-type": "application/json",
      // Streamable HTTP allows either; a server may answer a single call as an SSE event.
      accept: "application/json, text/event-stream",
      [MCP_PROTOCOL_HEADER]: MCP_PROTOCOL_VERSION,
    };
    if (sessionId) headers[MCP_SESSION_HEADER] = sessionId;

    let response: Response;
    try {
      response = await doFetch(url, {
        method: "POST",
        headers,
        body,
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      // The registered endpoint is down or unreachable. That is not the caller's mistake, and
      // answering 400 would send them looking at their own request.
      throw badGateway(`${method} on ${url} could not be reached: ${(err as Error).message}`);
    }
    if (response.status >= 300 && response.status < 400) {
      throw badRequest(
        `discovery of ${url} redirected to ${response.headers.get("location") ?? "elsewhere"}; ` +
          "redirects are never followed (design section 5.3)",
      );
    }
    const session = response.headers.get(MCP_SESSION_HEADER);
    if (session) sessionId = session;
    if (opts.notification) {
      await response.body?.cancel().catch(() => {});
      return undefined;
    }
    if (!response.ok) {
      throw badRequest(`${method} on ${url} returned HTTP ${response.status}`);
    }

    const text = await readBounded(response, options.maxBytes, method);
    const payload = parseRpcPayload(text, method);
    if (payload.error) {
      const detail = asRecord(payload.error);
      throw badRequest(
        `${method} on ${url} answered a JSON-RPC error: ${String(detail.message ?? "no message")}`,
      );
    }
    return payload.result;
  };
}

/** Streamable HTTP may answer a single call as one SSE event, so both framings are accepted. */
function parseRpcPayload(text: string, method: string): { result?: unknown; error?: unknown } {
  const trimmed = text.trim();
  const json = trimmed.startsWith("{") ? trimmed : lastSseData(trimmed);
  if (!json) throw badRequest(`${method} returned a body that is neither JSON nor an SSE event`);
  let doc: Record<string, unknown>;
  try {
    doc = JSON.parse(json) as Record<string, unknown>;
  } catch (err) {
    throw badRequest(`${method} returned a body that is not valid JSON: ${(err as Error).message}`);
  }
  if (Array.isArray(doc)) throw badRequest(`${method} answered a batch, which this client never sends`);
  return { result: doc.result, error: doc.error };
}

function lastSseData(text: string): string | null {
  const lines = text.split(/\r?\n/);
  const data = lines.filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim());
  return data.length > 0 ? data.join("\n") : null;
}

async function readBounded(response: Response, maxBytes: number, what: string): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) throw badRequest(`${what} returned an empty body`);
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => {});
      throw badRequest(`${what} returned more than MAX_SPEC_BYTES (${maxBytes}) bytes`);
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

async function page(call: RpcCall, method: string, field: string): Promise<unknown[]> {
  const items: unknown[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < PAGE_LIMIT; i++) {
    const result = asRecord(await call(method, cursor === undefined ? {} : { cursor }));
    items.push(...asArray(result[field]));
    const next = result.nextCursor;
    if (typeof next !== "string" || next.length === 0) return items;
    if (next === cursor) return items; // A server that repeats its cursor is not making progress.
    cursor = next;
  }
  throw badRequest(
    `${method} kept paging past ${PAGE_LIMIT} pages; discovery is bounded rather than following ` +
      "a cursor indefinitely",
  );
}

function asRecord(value: unknown): Record<string, unknown> {
  return isPlainObject(value) ? value : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
