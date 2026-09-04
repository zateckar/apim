import { randomUUID } from "node:crypto";
import { MCP_PROTOCOL_VERSION, MCP_SESSION_HEADER } from "../../shared/mcp.ts";

/**
 * A real-enough MCP server to publish (plan section 9, goal G4).
 *
 * "Real enough" means it is discovered by speaking the protocol rather than by reading a file:
 * `initialize` negotiates, the capability flags decide which lists exist, `tools/list` pages, and a
 * session id is minted and then required. Those are exactly the four things a publisher's client
 * can get wrong, so a server that got them right by accident would test nothing.
 *
 * It is deliberately *not* a general MCP implementation. There is no subscription, no completion,
 * no sampling and no elicitation — the gateway does not interpret any of them, and a demo server
 * that implemented half of each would suggest it did.
 */

export interface McpServerOptions {
  port: number;
  name?: string;
  version?: string;
  /**
   * Tools per `tools/list` page. Zero means one page — which is what most servers do, and is why
   * the non-zero case has to be exercised deliberately or the publisher's paging is never run.
   */
  pageSize?: number;
  /**
   * Whether a non-`initialize` call must carry the session the handshake minted. On by default,
   * because a client that quietly drops the header works against a lenient server and fails
   * against every real one.
   */
  requireSession?: boolean;
  quiet?: boolean;
}

interface ToolDef {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  call: (args: Record<string, unknown>) => { text: string; isError?: boolean };
}

const PETS = [
  { id: 1, name: "doggie", status: "available" },
  { id: 2, name: "kitty", status: "pending" },
  { id: 3, name: "birdie", status: "sold" },
];

const TOOLS: ToolDef[] = [
  {
    name: "getPet",
    title: "Get a pet",
    description: "Look one pet up by its id.",
    inputSchema: {
      type: "object",
      required: ["petId"],
      additionalProperties: false,
      properties: { petId: { type: "integer", minimum: 1, description: "The pet's id" } },
    },
    call: (args) => {
      const pet = PETS.find((p) => p.id === args.petId);
      return pet
        ? { text: JSON.stringify(pet) }
        : { text: `no pet ${String(args.petId)}`, isError: true };
    },
  },
  {
    name: "addPet",
    title: "Add a pet",
    description: "Register a new pet.",
    inputSchema: {
      type: "object",
      required: ["name"],
      additionalProperties: false,
      properties: {
        name: { type: "string", minLength: 1, maxLength: 64 },
        status: { enum: ["available", "pending", "sold"] },
      },
    },
    call: (args) => ({
      text: JSON.stringify({ id: 10, name: args.name, status: args.status ?? "available" }),
    }),
  },
  {
    name: "listInventory",
    title: "List the inventory",
    description: "Count the pets in each status.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
    call: () => ({ text: JSON.stringify({ available: 1, pending: 1, sold: 1 }) }),
  },
];

const RESOURCES = [
  {
    uri: "pet://inventory",
    name: "inventory",
    description: "The current inventory, as JSON.",
    mimeType: "application/json",
  },
];

const PROMPTS = [{ name: "describePet", description: "Describe a pet for a listing page." }];

export interface McpStats {
  calls: Record<string, number>;
  sessions: number;
  streamsOpen: number;
}

export class McpServer {
  readonly stats: McpStats = { calls: {}, sessions: 0, streamsOpen: 0 };
  private readonly sessions = new Set<string>();

  constructor(readonly options: McpServerOptions) {}

  get info(): { name: string; version: string } {
    return { name: this.options.name ?? "petstore-mcp", version: this.options.version ?? "1.0.0" };
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/healthz") return Response.json({ ok: true, service: "mcp-server" });

    if (req.method === "DELETE") {
      const session = req.headers.get(MCP_SESSION_HEADER);
      if (session) this.sessions.delete(session);
      return new Response(null, { status: 204 });
    }
    if (req.method === "GET") return this.serverStream(req);
    if (req.method !== "POST") {
      return new Response("this endpoint speaks POST (JSON-RPC), GET (SSE) and DELETE", {
        status: 405,
      });
    }

    let body: unknown;
    try {
      body = JSON.parse(await req.text());
    } catch (err) {
      return this.rpc(null, { error: { code: -32700, message: (err as Error).message } }, 400);
    }
    if (Array.isArray(body)) {
      return this.rpc(null, { error: { code: -32600, message: "batches are not accepted" } }, 400);
    }
    const request = (body ?? {}) as Record<string, unknown>;
    const method = typeof request.method === "string" ? request.method : "";
    const id = (request.id ?? null) as string | number | null;
    const params = (request.params ?? {}) as Record<string, unknown>;
    this.stats.calls[method] = (this.stats.calls[method] ?? 0) + 1;

    if (method.startsWith("notifications/")) return new Response(null, { status: 202 });

    if (method === "initialize") {
      const session = randomUUID();
      this.sessions.add(session);
      this.stats.sessions++;
      return this.rpc(
        id,
        {
          result: {
            protocolVersion: MCP_PROTOCOL_VERSION,
            serverInfo: this.info,
            // Only what this server actually answers. A capability it declared and did not
            // implement would be published as an operation that always fails.
            capabilities: { tools: { listChanged: false }, resources: {}, prompts: {} },
          },
        },
        200,
        { [MCP_SESSION_HEADER]: session },
      );
    }

    if (this.options.requireSession !== false) {
      const session = req.headers.get(MCP_SESSION_HEADER);
      if (!session || !this.sessions.has(session)) {
        return this.rpc(
          id,
          {
            error: {
              code: -32001,
              message: `${MCP_SESSION_HEADER} is missing or unknown; call initialize first`,
            },
          },
          404,
        );
      }
    }

    switch (method) {
      case "ping":
        return this.rpc(id, { result: {} });
      case "tools/list":
        return this.rpc(id, { result: this.pageOf(TOOLS.map(publicTool), "tools", params) });
      case "resources/list":
        return this.rpc(id, { result: this.pageOf(RESOURCES, "resources", params) });
      case "resources/read": {
        const resource = RESOURCES.find((entry) => entry.uri === params.uri);
        if (!resource) {
          return this.rpc(id, { error: { code: -32602, message: `no resource ${String(params.uri)}` } });
        }
        return this.rpc(id, {
          result: {
            contents: [
              {
                uri: resource.uri,
                mimeType: resource.mimeType,
                text: JSON.stringify({ available: 1, pending: 1, sold: 1 }),
              },
            ],
          },
        });
      }
      case "prompts/list":
        return this.rpc(id, { result: this.pageOf(PROMPTS, "prompts", params) });
      case "prompts/get": {
        const prompt = PROMPTS.find((entry) => entry.name === params.name);
        if (!prompt) {
          return this.rpc(id, { error: { code: -32602, message: `no prompt ${String(params.name)}` } });
        }
        return this.rpc(id, {
          result: {
            description: prompt.description,
            messages: [
              {
                role: "user",
                content: { type: "text", text: "Describe this pet in one friendly sentence." },
              },
            ],
          },
        });
      }
      case "tools/call": {
        const tool = TOOLS.find((entry) => entry.name === params.name);
        if (!tool) {
          return this.rpc(id, {
            error: { code: -32602, message: `no tool named ${String(params.name)}` },
          });
        }
        const outcome = tool.call((params.arguments ?? {}) as Record<string, unknown>);
        // A tool saying "no" is a *result* with `isError`, not a JSON-RPC error — the call
        // succeeded, the answer was negative. The gateway counts them differently for the same
        // reason (plan `[R1-13]`).
        return this.rpc(id, {
          result: { content: [{ type: "text", text: outcome.text }], isError: outcome.isError ?? false },
        });
      }
      default:
        return this.rpc(id, { error: { code: -32601, message: `no method ${method}` } });
    }
  }

  /** The server→client stream. Only meaningful through a route with `passthrough.sse`. */
  private serverStream(req: Request): Response {
    if (!(req.headers.get("accept") ?? "").includes("text/event-stream")) {
      return new Response("GET on this endpoint opens the server→client SSE stream", { status: 405 });
    }
    const encoder = new TextEncoder();
    let timer: ReturnType<typeof setInterval> | null = null;
    let seq = 0;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      if (timer) clearInterval(timer);
      this.stats.streamsOpen--;
    };
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.stats.streamsOpen++;
        // Flushed immediately, so the headers are on the wire before the first notification.
        controller.enqueue(encoder.encode(": open\n\n"));
        timer = setInterval(() => {
          seq++;
          const message = JSON.stringify({
            jsonrpc: "2.0",
            method: "notifications/message",
            params: { level: "info", data: { seq } },
          });
          try {
            controller.enqueue(encoder.encode(`data: ${message}\n\n`));
          } catch {
            finish();
          }
        }, 200);
      },
      cancel: finish,
    });
    return new Response(stream, {
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
    });
  }

  /** `pageSize` pages of anything, so the publisher's cursor loop is exercised rather than assumed. */
  private pageOf<T>(items: T[], field: string, params: Record<string, unknown>): Record<string, unknown> {
    const size = this.options.pageSize ?? 0;
    if (size <= 0) return { [field]: items };
    const offset = Number(params.cursor ?? "0");
    const start = Number.isFinite(offset) && offset > 0 ? offset : 0;
    const slice = items.slice(start, start + size);
    const next = start + size;
    return { [field]: slice, ...(next < items.length ? { nextCursor: String(next) } : {}) };
  }

  private rpc(
    id: string | number | null,
    payload: { result?: unknown; error?: { code: number; message: string } },
    status = 200,
    headers: Record<string, string> = {},
  ): Response {
    return new Response(JSON.stringify({ jsonrpc: "2.0", id, ...payload }), {
      status,
      headers: { "content-type": "application/json; charset=utf-8", ...headers },
    });
  }
}

function publicTool(tool: ToolDef) {
  return {
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: tool.inputSchema,
  };
}

export function startMcpServer(server: McpServer) {
  return Bun.serve({
    port: server.options.port,
    idleTimeout: 120,
    fetch: (req) => server.fetch(req),
  });
}

function flag(name: string, fallback: string): string {
  const prefix = `--${name}=`;
  for (const arg of Bun.argv) if (arg.startsWith(prefix)) return arg.slice(prefix.length);
  return fallback;
}

if (import.meta.main) {
  const server = new McpServer({
    port: Number(flag("port", process.env.MCP_PORT ?? "9085")),
    name: flag("name", process.env.MCP_NAME ?? "petstore-mcp"),
    pageSize: Number(flag("page-size", process.env.MCP_PAGE_SIZE ?? "0")),
    requireSession: flag("require-session", "1") !== "0",
  });
  const listening = startMcpServer(server);
  console.log(
    `[mcp] ${server.info.name} on http://localhost:${listening.port} — POST for JSON-RPC, ` +
      `GET for the SSE stream, DELETE to end a session; protocol ${MCP_PROTOCOL_VERSION}`,
  );
}
