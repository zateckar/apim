import type { ServerWebSocket } from "bun";
import type { PassthroughUnit } from "../../shared/policy.ts";
import { logTimestamp } from "./accesslog.ts";

/**
 * WebSocket and SSE passthrough (design section 5.8).
 *
 * Both mean no buffering and no body validation, and they are different shapes:
 *
 *  - **SSE is a normal request with a long-lived response.** The whole request side works
 *    unchanged; only the response side degrades — no response validation, transform or cache.
 *  - **WebSocket is a normal request that stops being HTTP.** The upgrade runs the full
 *    request-side pipeline; once the 101 is returned the connection is an opaque bidirectional
 *    byte stream.
 *
 * Three consequences are deliberate and are what the ceilings here bound:
 *
 *  - **No frame parsing.** After the upgrade we copy messages and do not interpret them, so
 *    enforcement is in bytes and seconds, never per-message size or count. A route that needs
 *    per-message validation is a request/response route and should be modelled as one.
 *  - **The upgrade authenticates once**, and nothing re-checks afterwards — which would contradict
 *    section 8.5's guarantee that a revoked credential stops working at the next poll. Two things
 *    close it: `maxConnectionSec` forces a reconnect on a bounded schedule, and the poll actively
 *    closes a revoked subscription's open connections. That is the only place a config update
 *    reaches backwards into in-flight work.
 *  - **Capacity is concurrent connections, not requests per second.** Each open stream holds
 *    buffers and one backend connection for its lifetime, so it has its own ceiling.
 */

export type StreamKind = "websocket" | "sse";

export interface StreamHandle {
  id: number;
  kind: StreamKind;
  resourceId: string;
  subscriptionId: string | null;
  openedAtMs: number;
  bytesIn: number;
  bytesOut: number;
  close: (reason: string) => void;
}

export type StreamCloseReason =
  | "client"
  | "backend"
  | "idle"
  | "max-connection"
  | "byte-budget"
  | "revoked"
  | "shutdown";

/**
 * Every open stream, so a poll can close the ones whose subscription has gone. Also the enforcer
 * of both ceilings: the route's `maxConcurrentConnections` and the instance's
 * `MAX_CONCURRENT_UPGRADES` — two ceilings because they bound different things, and two outcomes
 * because which one fired is the whole diagnosis (plan `[R3-09]`).
 */
export class StreamRegistry {
  private readonly streams = new Map<number, StreamHandle>();
  private nextId = 1;
  peak = 0;
  closed: Record<string, number> = {};

  constructor(private maxTotal: number) {}

  /**
   * Lowered below the number of streams already open, nothing is closed: a stream is a connection
   * somebody is using, and shedding new ones until the count comes down is the honest reading of a
   * ceiling. Only a revoked subscription closes a stream that is already open.
   */
  resize(maxTotal: number): void {
    this.maxTotal = maxTotal;
  }

  get size(): number {
    return this.streams.size;
  }

  countFor(resourceId: string): number {
    let count = 0;
    for (const stream of this.streams.values()) if (stream.resourceId === resourceId) count++;
    return count;
  }

  admit(resourceId: string, unit: PassthroughUnit | undefined): "ok" | "route-full" | "instance-full" {
    if (this.streams.size >= this.maxTotal) return "instance-full";
    const routeCeiling = unit?.maxConcurrentConnections;
    if (routeCeiling !== undefined && this.countFor(resourceId) >= routeCeiling) return "route-full";
    return "ok";
  }

  open(handle: Omit<StreamHandle, "id">): StreamHandle {
    const stream: StreamHandle = { ...handle, id: this.nextId++ };
    this.streams.set(stream.id, stream);
    this.peak = Math.max(this.peak, this.streams.size);
    return stream;
  }

  close(id: number, reason: StreamCloseReason): void {
    if (!this.streams.delete(id)) return;
    this.closed[reason] = (this.closed[reason] ?? 0) + 1;
  }

  /**
   * Design section 5.8: when a poll reports a subscription revoked or suspended, the instance
   * closes that subscription's open connections. `active` is the set that survived; anything held
   * for a subscription outside it goes.
   */
  closeRevoked(active: Set<string>): number {
    let closed = 0;
    for (const stream of [...this.streams.values()]) {
      if (!stream.subscriptionId) continue;
      if (active.has(stream.subscriptionId)) continue;
      stream.close("revoked");
      closed++;
    }
    return closed;
  }

  closeAll(reason: StreamCloseReason): void {
    for (const stream of [...this.streams.values()]) stream.close(reason);
  }

  snapshot(): { open: number; peak: number; maxTotal: number; closed: Record<string, number> } {
    return { open: this.streams.size, peak: this.peak, maxTotal: this.maxTotal, closed: this.closed };
  }
}

/** What the pipeline hands to the server when a route is a WebSocket passthrough. */
export interface UpgradeIntent {
  kind: "upgrade";
  target: string;
  headers: Record<string, string>;
  resourceId: string;
  resourceName: string;
  subscriptionId: string | null;
  applicationId: string | null;
  requestId: string;
  passthrough: PassthroughUnit;
  startedMs: number;
  clientIp: string;
}

export interface BridgeDeps {
  registry: StreamRegistry;
  log?: (record: Record<string, unknown>) => void;
  record?: (bytesIn: number, bytesOut: number, durationMs: number, reason: StreamCloseReason) => void;
  /** Injectable for tests; `WebSocket` in production. */
  connect?: (url: string, headers: Record<string, string>) => WebSocket;
}

/**
 * A bidirectional copy between an accepted client socket and one opened to the backend.
 *
 * Backpressure is inherent in the shape: messages are forwarded one at a time and a socket that is
 * not draining stops being written to, so a slow client throttles the backend rather than
 * accumulating here. Messages that arrive before the backend socket is open are held in a bounded
 * queue and dropped past it, because an unbounded queue is the accumulation this is avoiding.
 */
export class WebSocketBridge {
  private upstream: WebSocket | null = null;
  private handle: StreamHandle | null = null;
  private readonly pending: Array<string | Uint8Array> = [];
  private closing = false;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private lifeTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly client: ServerWebSocket<{ intent: UpgradeIntent }>,
    private readonly intent: UpgradeIntent,
    private readonly deps: BridgeDeps,
  ) {}

  start(): void {
    const connect = this.deps.connect ?? ((url, headers) => new WebSocket(url, { headers } as never));
    let upstream: WebSocket;
    try {
      upstream = connect(this.intent.target, this.intent.headers);
    } catch {
      this.client.close(1011, "the backend could not be reached");
      return;
    }
    this.upstream = upstream;
    upstream.binaryType = "arraybuffer";

    this.handle = this.deps.registry.open({
      kind: "websocket",
      resourceId: this.intent.resourceId,
      subscriptionId: this.intent.subscriptionId,
      openedAtMs: Date.now(),
      bytesIn: 0,
      bytesOut: 0,
      close: (reason) => this.finish(reason as StreamCloseReason),
    });

    upstream.onopen = () => {
      for (const message of this.pending) upstream.send(message as never);
      this.pending.length = 0;
    };
    upstream.onmessage = (event) => {
      const data = normalize(event.data);
      this.count(0, byteLength(data));
      if (this.closing) return;
      this.client.send(data as never);
      this.touch();
    };
    upstream.onclose = () => this.finish("backend");
    upstream.onerror = () => this.finish("backend");

    this.armTimers();
  }

  fromClient(message: string | Uint8Array): void {
    this.count(byteLength(message), 0);
    if (this.closing) return;
    if (!this.upstream || this.upstream.readyState !== WebSocket.OPEN) {
      // Bounded: the alternative is holding an unbounded queue for a backend that may never open.
      if (this.pending.length < 32) this.pending.push(message);
      return;
    }
    this.upstream.send(message as never);
    this.touch();
  }

  clientClosed(): void {
    this.finish("client");
  }

  private count(inBytes: number, outBytes: number): void {
    if (!this.handle) return;
    this.handle.bytesIn += inBytes;
    this.handle.bytesOut += outBytes;
    const budget = this.intent.passthrough.maxBytesPerConnection ?? 0;
    if (budget > 0 && this.handle.bytesIn + this.handle.bytesOut > budget) {
      this.finish("byte-budget");
    }
  }

  private armTimers(): void {
    const life = this.intent.passthrough.maxConnectionSec;
    if (life) this.lifeTimer = setTimeout(() => this.finish("max-connection"), life * 1000);
    this.touch();
  }

  /** Idle timeout bounds *silence* on an established stream; it is not the request timeout. */
  private touch(): void {
    const idle = this.intent.passthrough.streamIdleTimeoutSec;
    if (!idle) return;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.finish("idle"), idle * 1000);
  }

  private finish(reason: StreamCloseReason): void {
    if (this.closing) return;
    this.closing = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.lifeTimer) clearTimeout(this.lifeTimer);

    const handle = this.handle;
    if (handle) this.deps.registry.close(handle.id, reason);

    try {
      // 1008 is "policy violation", which is what a revocation is from the client's point of view.
      this.client.close(reason === "revoked" ? 1008 : 1000, reason);
    } catch {
      // Already gone.
    }
    try {
      this.upstream?.close();
    } catch {
      // Already gone.
    }

    const durationMs = handle ? Date.now() - handle.openedAtMs : 0;
    this.deps.record?.(handle?.bytesIn ?? 0, handle?.bytesOut ?? 0, durationMs, reason);
    this.deps.log?.({
      ts: logTimestamp(),
      requestId: this.intent.requestId,
      kind: "websocket",
      resourceId: this.intent.resourceId,
      resourceName: this.intent.resourceName,
      subscriptionId: this.intent.subscriptionId,
      applicationId: this.intent.applicationId,
      clientIp: this.intent.clientIp,
      bytesIn: handle?.bytesIn ?? 0,
      bytesOut: handle?.bytesOut ?? 0,
      durationMs,
      closeReason: reason,
    });
  }
}

function normalize(data: unknown): string | Uint8Array {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return String(data);
}

function byteLength(data: string | Uint8Array): number {
  return typeof data === "string" ? Buffer.byteLength(data, "utf8") : data.byteLength;
}

/**
 * Wraps an SSE response body so the stream is bounded the same way a WebSocket is, and so a
 * revocation can close it. `flush per event` is inherent: the body is passed through chunk by
 * chunk rather than buffered, which is what makes SSE work in production rather than only in tests.
 */
export function superviseSse(
  body: ReadableStream<Uint8Array>,
  passthrough: PassthroughUnit,
  registry: StreamRegistry,
  meta: { resourceId: string; subscriptionId: string | null },
  onClose: (reason: StreamCloseReason, bytes: number) => void,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let bytes = 0;
  let finished = false;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let lifeTimer: ReturnType<typeof setTimeout> | null = null;
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null;

  const stop = (reason: StreamCloseReason) => {
    if (finished) return;
    finished = true;
    if (idleTimer) clearTimeout(idleTimer);
    if (lifeTimer) clearTimeout(lifeTimer);
    registry.close(handle.id, reason);
    onClose(reason, bytes);
    void reader.cancel(reason).catch(() => {});
    try {
      controllerRef?.close();
    } catch {
      // Already closed by the consumer.
    }
  };

  const handle = registry.open({
    kind: "sse",
    resourceId: meta.resourceId,
    subscriptionId: meta.subscriptionId,
    openedAtMs: Date.now(),
    bytesIn: 0,
    bytesOut: 0,
    close: (reason) => stop(reason as StreamCloseReason),
  });

  const touch = () => {
    if (!passthrough.streamIdleTimeoutSec) return;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => stop("idle"), passthrough.streamIdleTimeoutSec * 1000);
  };
  if (passthrough.maxConnectionSec) {
    lifeTimer = setTimeout(() => stop("max-connection"), passthrough.maxConnectionSec * 1000);
  }
  touch();

  return new ReadableStream<Uint8Array>({
    start(controller) {
      controllerRef = controller;
    },
    async pull(controller) {
      if (finished) {
        controller.close();
        return;
      }
      try {
        const result = await reader.read();
        if (result.done) {
          stop("backend");
          controller.close();
          return;
        }
        bytes += result.value.byteLength;
        handle.bytesOut = bytes;
        const budget = passthrough.maxBytesPerConnection ?? 0;
        if (budget > 0 && bytes > budget) {
          stop("byte-budget");
          controller.close();
          return;
        }
        touch();
        controller.enqueue(result.value);
      } catch (err) {
        stop("backend");
        controller.error(err);
      }
    },
    cancel() {
      stop("client");
    },
  });
}
