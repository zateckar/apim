import { randomUUID } from "node:crypto";
import { A2A_PROTOCOL_VERSION, AGENT_CARD_PATH } from "../../shared/a2a.ts";

/**
 * A real-enough A2A agent to publish (plan section 10, goal G5).
 *
 * The point of this one is the **card**. An agent card names a URL, and consumers follow it — so
 * an agent published through the platform whose card still pointed here would send every consumer
 * straight past every policy (plan `[R1-16]`). This agent therefore serves a card pointing at
 * itself, honestly, and the interesting assertion is that what the gateway serves is *different*.
 *
 * Beyond that it speaks enough JSON-RPC to be worth proxying: `message/send` answers, and
 * `message/stream` streams — which is the case that needs `passthrough.sse` and would otherwise be
 * buffered into a non-stream by a gateway that treated it as an ordinary call.
 */

export interface A2aAgentOptions {
  port: number;
  name?: string;
  version?: string;
  /** What the card advertises as its own URL. Defaults to this listener's address. */
  publicUrl?: string;
  quiet?: boolean;
}

const SKILLS = [
  {
    id: "pet-lookup",
    name: "Pet lookup",
    description: "Finds a pet by name or id and reports its status.",
    tags: ["pets", "lookup", "catalogue"],
    examples: ["Is doggie still available?", "What is the status of pet 2?"],
    inputModes: ["text/plain"],
    outputModes: ["text/plain"],
  },
  {
    id: "adoption-advice",
    name: "Adoption advice",
    description: "Suggests a pet from the shelter's inventory given what somebody is looking for.",
    tags: ["pets", "advice"],
    examples: ["I want a quiet pet for a small flat."],
    inputModes: ["text/plain"],
    outputModes: ["text/plain"],
  },
];

const PETS = [
  { id: 1, name: "doggie", status: "available" },
  { id: 2, name: "kitty", status: "pending" },
  { id: 3, name: "birdie", status: "sold" },
];

export interface A2aStats {
  calls: Record<string, number>;
  cardsServed: number;
  streamsOpen: number;
}

export class A2aAgent {
  readonly stats: A2aStats = { calls: {}, cardsServed: 0, streamsOpen: 0 };
  private readonly tasks = new Map<string, { state: string; text: string }>();
  /** Set once the listener has a port, so the card can advertise a real address. */
  publicUrl: string;

  constructor(readonly options: A2aAgentOptions) {
    this.publicUrl = options.publicUrl ?? `http://127.0.0.1:${options.port}`;
  }

  card(): Record<string, unknown> {
    return {
      protocolVersion: A2A_PROTOCOL_VERSION,
      name: this.options.name ?? "Shelter agent",
      description: "Answers questions about the shelter's pets and suggests adoptions.",
      version: this.options.version ?? "1.0.0",
      url: this.publicUrl,
      preferredTransport: "JSONRPC",
      provider: { organization: "Petstore Shelter", url: "https://petstore.invalid" },
      documentationUrl: "https://petstore.invalid/docs",
      capabilities: { streaming: true, pushNotifications: false, stateTransitionHistory: false },
      defaultInputModes: ["text/plain"],
      defaultOutputModes: ["text/plain"],
      skills: SKILLS,
      // The origin's own scheme. The gateway replaces it with the subscription key, because a
      // consumer reaching us must present ours, not this one.
      securitySchemes: {
        agentToken: { type: "http", scheme: "bearer", description: "A token issued by the shelter." },
      },
      security: [{ agentToken: [] }],
    };
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/healthz") return Response.json({ ok: true, service: "a2a-agent" });
    if (url.pathname === AGENT_CARD_PATH || url.pathname === "/.well-known/agent.json") {
      this.stats.cardsServed++;
      return Response.json(this.card(), { headers: { "cache-control": "public, max-age=60" } });
    }
    if (req.method !== "POST") {
      return new Response(`this agent speaks JSON-RPC over POST; its card is at ${AGENT_CARD_PATH}`, {
        status: 405,
      });
    }

    let body: unknown;
    try {
      body = JSON.parse(await req.text());
    } catch (err) {
      return this.rpc(null, { error: { code: -32700, message: (err as Error).message } }, 400);
    }
    const request = (body ?? {}) as Record<string, unknown>;
    const method = typeof request.method === "string" ? request.method : "";
    const id = (request.id ?? null) as string | number | null;
    const params = (request.params ?? {}) as Record<string, unknown>;
    this.stats.calls[method] = (this.stats.calls[method] ?? 0) + 1;

    switch (method) {
      case "message/send": {
        const task = this.answer(params);
        return this.rpc(id, { result: task });
      }
      case "message/stream":
        return this.stream(id, params);
      case "tasks/get": {
        const task = this.tasks.get(String(params.id));
        if (!task) return this.rpc(id, { error: { code: -32001, message: "no such task" } });
        return this.rpc(id, {
          result: { id: params.id, kind: "task", status: { state: task.state }, history: [] },
        });
      }
      case "tasks/cancel": {
        const task = this.tasks.get(String(params.id));
        if (!task) return this.rpc(id, { error: { code: -32001, message: "no such task" } });
        task.state = "canceled";
        return this.rpc(id, { result: { id: params.id, kind: "task", status: { state: "canceled" } } });
      }
      case "agent/getAuthenticatedExtendedCard":
        return this.rpc(id, { result: { ...this.card(), skills: SKILLS } });
      default:
        return this.rpc(id, { error: { code: -32601, message: `no method ${method}` } });
    }
  }

  private answer(params: Record<string, unknown>): Record<string, unknown> {
    const taskId = randomUUID();
    const text = textOf(params);
    const pet = PETS.find((entry) => text.toLowerCase().includes(entry.name));
    const reply = pet
      ? `${pet.name} is ${pet.status}.`
      : "I could not find that pet; try doggie, kitty or birdie.";
    this.tasks.set(taskId, { state: "completed", text: reply });
    return {
      id: taskId,
      kind: "task",
      contextId: randomUUID(),
      status: {
        state: "completed",
        message: {
          role: "agent",
          kind: "message",
          messageId: randomUUID(),
          parts: [{ kind: "text", text: reply }],
        },
      },
    };
  }

  /**
   * The streaming half: one SSE event per state change. Each event is a whole JSON-RPC response,
   * which is what makes this a stream of answers rather than a chunked single answer.
   */
  private stream(id: string | number | null, params: Record<string, unknown>): Response {
    const taskId = randomUUID();
    const text = textOf(params);
    const pet = PETS.find((entry) => text.toLowerCase().includes(entry.name));
    const reply = pet
      ? `${pet.name} is ${pet.status}.`
      : "I could not find that pet; try doggie, kitty or birdie.";
    this.tasks.set(taskId, { state: "completed", text: reply });

    const encoder = new TextEncoder();
    const event = (payload: unknown) =>
      encoder.encode(`data: ${JSON.stringify({ jsonrpc: "2.0", id, result: payload })}\n\n`);
    let timer: ReturnType<typeof setTimeout> | null = null;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      this.stats.streamsOpen--;
    };

    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.stats.streamsOpen++;
        controller.enqueue(encoder.encode(": open\n\n"));
        controller.enqueue(
          event({ id: taskId, kind: "task", status: { state: "working" }, final: false }),
        );
        timer = setTimeout(() => {
          try {
            controller.enqueue(
              event({
                id: taskId,
                kind: "status-update",
                status: {
                  state: "completed",
                  message: {
                    role: "agent",
                    kind: "message",
                    messageId: randomUUID(),
                    parts: [{ kind: "text", text: reply }],
                  },
                },
                final: true,
              }),
            );
            controller.close();
          } catch {
            // The consumer left first.
          }
          finish();
        }, 50);
      },
      cancel: finish,
    });

    return new Response(stream, {
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
    });
  }

  private rpc(
    id: string | number | null,
    payload: { result?: unknown; error?: { code: number; message: string } },
    status = 200,
  ): Response {
    return new Response(JSON.stringify({ jsonrpc: "2.0", id, ...payload }), {
      status,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }
}

function textOf(params: Record<string, unknown>): string {
  const message = (params.message ?? {}) as Record<string, unknown>;
  const parts = Array.isArray(message.parts) ? message.parts : [];
  return parts
    .map((part) => (part as { text?: unknown }).text)
    .filter((text): text is string => typeof text === "string")
    .join(" ");
}

export function startA2aAgent(agent: A2aAgent) {
  const server = Bun.serve({
    port: agent.options.port,
    idleTimeout: 120,
    fetch: (req) => agent.fetch(req),
  });
  // Resolved after binding, because port 0 means "whatever is free" and a card advertising port 0
  // would be a card nobody can follow.
  if (!agent.options.publicUrl) agent.publicUrl = `http://127.0.0.1:${server.port}`;
  return server;
}

function flag(name: string, fallback: string): string {
  const prefix = `--${name}=`;
  for (const arg of Bun.argv) if (arg.startsWith(prefix)) return arg.slice(prefix.length);
  return fallback;
}

if (import.meta.main) {
  const agent = new A2aAgent({
    port: Number(flag("port", process.env.A2A_PORT ?? "9086")),
    name: flag("name", process.env.A2A_NAME ?? "Shelter agent"),
    ...(process.env.A2A_PUBLIC_URL ? { publicUrl: process.env.A2A_PUBLIC_URL } : {}),
  });
  const server = startA2aAgent(agent);
  console.log(
    `[a2a] ${agent.card().name} on http://localhost:${server.port} — card at ${AGENT_CARD_PATH}, ` +
      `JSON-RPC on POST /; protocol ${A2A_PROTOCOL_VERSION}`,
  );
}
