import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
// The fixture generator, whose home is the test tree because that is where its other callers are
// (plan §12). It has no test imports of its own, so using it here costs nothing at runtime.
import { generateCertificate } from "../../test/x509.ts";

/**
 * The local petstore (plan G6). It exists so load results are reproducible and nobody's public
 * service is hammered — and so a 30-second backend can be simulated without waiting on one.
 *
 * Everything it does is deterministic under `--seed`: the same run reproduces, which is what
 * makes a performance report comparable to the previous one.
 */
export interface BackendOptions {
  port: number;
  seed: number;
  /**
   * Which copy of the petstore this is. Echoed on every response as `x-backend-instance`, so a
   * pool of these makes load balancing *visible*: "round-robin spread the calls" is an assertion
   * about which backend answered, and without a name in the response there is nothing to assert.
   */
  instance?: string;
  /**
   * Serve HTTPS with this identity (G4). The pair is generated at startup rather than checked in,
   * for the same reason the certificate fixtures are: a PEM in the repository expires one day and
   * takes the perf run down on a date nobody chose.
   */
  tls?: { certPem: string; keyPem: string };
  quiet?: boolean;
}

/** mulberry32 — small, fast, and seeded, so "random" latency is reproducible. */
function makeRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const MAX_DELAY_MS = 30_000;
const SOAP_NS = "http://schemas.xmlsoap.org/soap/envelope/";
const PETSTORE_NS = "urn:apim:petstore";
/** The two streaming endpoints `passthrough` exists for (design section 5.8). */
export const EVENTS_PATH = "/v2/events";
export const SOCKET_PATH = "/v2/socket";

function clampInt(raw: string | null, fallback: number, min: number, max: number): number {
  const value = Number(raw ?? "");
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

const WSDL = readFileSync(fileURLToPath(new URL("./petstore.wsdl", import.meta.url)), "utf8");

export interface BackendStats {
  requests: number;
  inFlight: number;
  maxInFlight: number;
  bytesIn: number;
  bytesOut: number;
  byPath: Record<string, number>;
  byStatus: Record<string, number>;
  /** Streams are counted apart from requests: one of them is not one unit of work (§5.8). */
  sseOpen: number;
  sseTotal: number;
  socketsOpen: number;
  socketsTotal: number;
}

interface Profile {
  delayMs?: number;
  delayDist?: string;
  status?: number;
  failRate?: number;
  bodyBytes?: number;
  chunkDelayMs?: number;
}

/** Path-prefix defaults, so a scenario need not send simulation headers on every request. */
export type Profiles = Array<{ prefix: string; profile: Profile }>;

function escapeXml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const PETS = [
  { id: 1, name: "doggie", status: "available" },
  { id: 2, name: "kitty", status: "pending" },
  { id: 3, name: "birdie", status: "sold" },
];

export class PetstoreBackend {
  readonly stats: BackendStats = {
    requests: 0,
    inFlight: 0,
    maxInFlight: 0,
    bytesIn: 0,
    bytesOut: 0,
    byPath: {},
    byStatus: {},
    sseOpen: 0,
    sseTotal: 0,
    socketsOpen: 0,
    socketsTotal: 0,
  };
  private readonly random: () => number;

  constructor(
    readonly options: BackendOptions,
    private readonly profiles: Profiles = [],
  ) {
    this.random = makeRandom(options.seed);
  }

  private profileFor(url: URL, headers: Headers): Profile {
    const base: Profile = {};
    for (const entry of this.profiles) {
      if (url.pathname.startsWith(entry.prefix)) Object.assign(base, entry.profile);
    }
    const num = (name: string): number | undefined => {
      const raw = headers.get(name);
      if (raw === null) return undefined;
      const value = Number(raw);
      return Number.isFinite(value) ? value : undefined;
    };
    // Request headers win over the profile: a scenario can override one request at a time.
    const delayMs = num("x-sim-delay-ms");
    if (delayMs !== undefined) base.delayMs = delayMs;
    const status = num("x-sim-status");
    if (status !== undefined) base.status = status;
    const failRate = num("x-sim-fail-rate");
    if (failRate !== undefined) base.failRate = failRate;
    const bodyBytes = num("x-sim-body-bytes");
    if (bodyBytes !== undefined) base.bodyBytes = bodyBytes;
    const chunkDelayMs = num("x-sim-chunk-delay-ms");
    if (chunkDelayMs !== undefined) base.chunkDelayMs = chunkDelayMs;
    const dist = headers.get("x-sim-delay-dist");
    if (dist !== null) base.delayDist = dist;
    return base;
  }

  /** `exp:200` — exponential with that mean; `p95:2000` — 95% fast, 5% at the stated latency. */
  private delayFor(profile: Profile): number {
    if (profile.delayDist) {
      const [kind, rawArg] = profile.delayDist.split(":");
      const arg = Number(rawArg ?? "0");
      if (kind === "exp" && Number.isFinite(arg) && arg > 0) {
        return Math.min(MAX_DELAY_MS, Math.round(-Math.log(1 - this.random()) * arg));
      }
      if (kind === "p95" && Number.isFinite(arg)) {
        return this.random() < 0.05 ? Math.min(MAX_DELAY_MS, arg) : 1;
      }
    }
    return Math.min(MAX_DELAY_MS, Math.max(0, profile.delayMs ?? 0));
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    this.stats.requests++;
    this.stats.inFlight++;
    this.stats.maxInFlight = Math.max(this.stats.maxInFlight, this.stats.inFlight);
    this.stats.byPath[url.pathname] = (this.stats.byPath[url.pathname] ?? 0) + 1;
    try {
      const response = await this.route(req, url);
      this.stats.byStatus[String(response.status)] =
        (this.stats.byStatus[String(response.status)] ?? 0) + 1;
      if (this.options.instance) response.headers.set("x-backend-instance", this.options.instance);
      return response;
    } finally {
      this.stats.inFlight--;
    }
  }

  private async route(req: Request, url: URL): Promise<Response> {
    if (url.pathname === "/__stats") return Response.json(this.stats);
    if (url.pathname === "/__reset") {
      // `inFlight` is deliberately not reset: this very request is in flight, and zeroing the
      // counter here would leave it at -1 when the `finally` runs, after which `maxInFlight`
      // never rises above 0 again.
      Object.assign(this.stats, {
        requests: 0,
        maxInFlight: this.stats.inFlight,
        bytesIn: 0,
        bytesOut: 0,
        byPath: {},
        byStatus: {},
        sseTotal: 0,
        socketsTotal: 0,
      });
      return Response.json({ ok: true });
    }
    if (url.pathname === "/healthz") {
      return Response.json({
        ok: true,
        service: "petstore-backend",
        instance: this.options.instance ?? null,
      });
    }

    const profile = this.profileFor(url, req.headers);
    const delay = this.delayFor(profile);
    if (delay > 0) await Bun.sleep(delay);

    if (profile.failRate !== undefined && this.random() < profile.failRate) {
      return this.json({ code: 500, message: "simulated failure" }, 500);
    }
    if (profile.status !== undefined && profile.status !== 200) {
      return this.json({ code: profile.status, message: "simulated status" }, profile.status);
    }

    // Ahead of `rest`, because a stream is not a body: the size and padding knobs there describe
    // one response, and this endpoint's whole point is that it does not have one.
    if (url.pathname === EVENTS_PATH) return this.events(url);
    if (url.pathname.startsWith("/soap/petstore")) return this.soap(req, url);
    if (url.pathname.startsWith("/v2/")) return this.rest(req, url, profile);
    return this.json({ code: 404, message: `no handler for ${url.pathname}` }, 404);
  }

  private json(body: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
    const text = JSON.stringify(body);
    this.stats.bytesOut += Buffer.byteLength(text, "utf8");
    return new Response(text, {
      status,
      headers: { "content-type": "application/json; charset=utf-8", ...extraHeaders },
    });
  }

  private async rest(req: Request, url: URL, profile: Profile): Promise<Response> {
    const path = url.pathname;

    if (profile.bodyBytes && profile.bodyBytes > 0) {
      // Padded to an exact size, for the response-size scenarios.
      const filler = "x".repeat(Math.max(0, profile.bodyBytes - 32));
      return this.json({ padded: true, data: filler });
    }

    if (path === "/v2/store/inventory") {
      return this.json({ available: 1, pending: 1, sold: 1 });
    }
    if (path === "/v2/pet/findByStatus") {
      const status = url.searchParams.get("status");
      return this.json(status ? PETS.filter((p) => p.status === status) : PETS);
    }
    if (path === "/v2/echo") {
      const body = await req.text();
      this.stats.bytesIn += Buffer.byteLength(body, "utf8");
      return this.json({
        method: req.method,
        path,
        query: url.search,
        headers: Object.fromEntries(req.headers),
        bodyBytes: Buffer.byteLength(body, "utf8"),
      });
    }
    if (path === "/v2/pet" && req.method === "POST") {
      const body = await req.text();
      this.stats.bytesIn += Buffer.byteLength(body, "utf8");
      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(body || "{}") as Record<string, unknown>;
      } catch {
        return this.json({ code: 400, message: "body is not valid JSON" }, 400);
      }
      return this.json({ id: 10, name: parsed.name ?? "unnamed", status: parsed.status ?? "available" });
    }
    const match = /^\/v2\/pet\/(\d+)$/.exec(path);
    if (match) {
      const id = Number(match[1]);
      const pet = PETS.find((p) => p.id === id);
      if (!pet) return this.json({ code: 1, type: "error", message: "Pet not found" }, 404);
      return this.json({ ...pet, category: { id: 1, name: "dogs" }, photoUrls: [] });
    }
    return this.json({ code: 404, message: `no handler for ${path}` }, 404);
  }

  /**
   * A real event stream, for `passthrough.sse` (design section 5.8).
   *
   * `?count=0` runs until somebody hangs up, which is what makes the gateway's idle timeout,
   * lifetime and byte budget demonstrable rather than theoretical — they are the only things that
   * can end it. The opening comment is not decoration: a response whose body has been produced
   * but never written keeps its headers in the sender's buffer, so a consumer waiting on the
   * response object and a producer waiting on a subscriber would deadlock against each other.
   */
  private events(url: URL): Response {
    const intervalMs = clampInt(url.searchParams.get("intervalMs"), 250, 10, 60_000);
    const count = clampInt(url.searchParams.get("count"), 0, 0, 10_000);
    const encoder = new TextEncoder();
    let timer: ReturnType<typeof setInterval> | null = null;
    let seq = 0;
    // Both the tick and `cancel` can end this stream, and they race, so the bookkeeping is done
    // once here rather than at each of the exits.
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      if (timer) clearInterval(timer);
      this.stats.sseOpen--;
    };

    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        const write = (text: string): boolean => {
          try {
            controller.enqueue(encoder.encode(text));
            this.stats.bytesOut += Buffer.byteLength(text, "utf8");
            return true;
          } catch {
            // The consumer went away between the tick and the write.
            return false;
          }
        };
        this.stats.sseOpen++;
        this.stats.sseTotal++;
        write(": open\n\n");
        timer = setInterval(() => {
          seq++;
          // No wall clock in the payload: this backend is reproducible under `--seed`, and a
          // timestamp would make two identical runs differ.
          const pet = PETS[seq % PETS.length]!;
          if (!write(`event: pet\nid: ${seq}\ndata: ${JSON.stringify({ seq, pet })}\n\n`)) {
            finish();
            return;
          }
          if (count > 0 && seq >= count) {
            finish();
            try {
              controller.close();
            } catch {
              // Already gone.
            }
          }
        }, intervalMs);
      },
      cancel: finish,
    });

    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        // Named so a reader of a packet capture can tell the gateway's stream from the origin's.
        "x-stream-source": "petstore-backend",
      },
    });
  }

  private async soap(req: Request, url: URL): Promise<Response> {
    if (req.method === "GET" && url.searchParams.has("wsdl")) {
      return new Response(WSDL, { headers: { "content-type": "text/xml; charset=utf-8" } });
    }
    if (req.method !== "POST") {
      return this.fault(405, "Client", "the SOAP endpoint accepts POST");
    }
    const body = await req.text();
    this.stats.bytesIn += Buffer.byteLength(body, "utf8");

    // A deliberately simple reader: this is the *backend*, not the gateway. The gateway's own
    // scanner is the hardened one.
    const operation = /<(?:\w+:)?(GetPetRequest|AddPetRequest)[\s>]/.exec(body)?.[1];
    if (!operation) return this.fault(500, "Client", "no known operation element in the SOAP body");

    if (operation === "GetPetRequest") {
      const petId = Number(/<(?:\w+:)?petId>\s*(\d+)\s*<\//.exec(body)?.[1] ?? "0");
      const pet = PETS.find((p) => p.id === petId);
      if (!pet) return this.fault(500, "Client", `pet ${petId} not found`);
      return this.envelope(
        `<tns:GetPetResponse xmlns:tns="${PETSTORE_NS}">` +
          `<tns:petId>${pet.id}</tns:petId><tns:name>${escapeXml(pet.name)}</tns:name>` +
          `<tns:status>${escapeXml(pet.status)}</tns:status></tns:GetPetResponse>`,
      );
    }

    const name = /<(?:\w+:)?name>([^<]*)<\//.exec(body)?.[1] ?? "unnamed";
    return this.envelope(
      `<tns:AddPetResponse xmlns:tns="${PETSTORE_NS}">` +
        `<tns:petId>10</tns:petId><tns:name>${escapeXml(name)}</tns:name></tns:AddPetResponse>`,
    );
  }

  private envelope(inner: string): Response {
    const body =
      `<?xml version="1.0" encoding="UTF-8"?>` +
      `<soap:Envelope xmlns:soap="${SOAP_NS}"><soap:Body>${inner}</soap:Body></soap:Envelope>`;
    this.stats.bytesOut += Buffer.byteLength(body, "utf8");
    return new Response(body, { headers: { "content-type": "text/xml; charset=utf-8" } });
  }

  private fault(status: number, code: string, reason: string): Response {
    const body =
      `<?xml version="1.0" encoding="UTF-8"?>` +
      `<soap:Envelope xmlns:soap="${SOAP_NS}"><soap:Body><soap:Fault>` +
      `<faultcode>soap:${code}</faultcode><faultstring>${escapeXml(reason)}</faultstring>` +
      `</soap:Fault></soap:Body></soap:Envelope>`;
    this.stats.bytesOut += Buffer.byteLength(body, "utf8");
    return new Response(body, {
      status,
      headers: { "content-type": "text/xml; charset=utf-8" },
    });
  }
}

/** Per-socket state: the tick timer, so it can be stopped when the client goes away. */
interface SocketData {
  timer: ReturnType<typeof setInterval> | null;
  tickMs: number;
  seq: number;
}

/**
 * The upgrade is handled here rather than in `PetstoreBackend.fetch`, because completing one needs
 * the `Server` object and a handler that returns a `Response` cannot have it — the same split the
 * gateway itself makes between its pipeline and `startDataPlane`.
 */
export function startBackend(backend: PetstoreBackend) {
  return Bun.serve<SocketData, never>({
    port: backend.options.port,
    idleTimeout: 120,
    ...(backend.options.tls
      ? { tls: { cert: backend.options.tls.certPem, key: backend.options.tls.keyPem } }
      : {}),
    fetch(req, server) {
      const url = new URL(req.url);
      if (url.pathname !== SOCKET_PATH) return backend.fetch(req);
      backend.stats.byPath[SOCKET_PATH] = (backend.stats.byPath[SOCKET_PATH] ?? 0) + 1;
      // `?tickMs=` makes the backend the talkative side, which is how a byte budget and an idle
      // timeout can be told apart: one fires on a busy stream, the other never does.
      const data: SocketData = {
        timer: null,
        tickMs: clampInt(url.searchParams.get("tickMs"), 0, 0, 60_000),
        seq: 0,
      };
      if (server.upgrade(req, { data })) return undefined;
      return new Response("expected a websocket upgrade", { status: 426 });
    },
    websocket: {
      open(ws) {
        backend.stats.socketsOpen++;
        backend.stats.socketsTotal++;
        if (ws.data.tickMs === 0) return;
        ws.data.timer = setInterval(() => {
          ws.data.seq++;
          const tick = JSON.stringify({ tick: ws.data.seq, pet: PETS[ws.data.seq % PETS.length] });
          backend.stats.bytesOut += Buffer.byteLength(tick, "utf8");
          ws.send(tick);
        }, ws.data.tickMs);
      },
      message(ws, message) {
        const text = String(message);
        backend.stats.bytesIn += Buffer.byteLength(text, "utf8");
        ws.data.seq++;
        const reply = JSON.stringify({ seq: ws.data.seq, echo: text });
        backend.stats.bytesOut += Buffer.byteLength(reply, "utf8");
        ws.send(reply);
      },
      close(ws) {
        if (ws.data.timer) clearInterval(ws.data.timer);
        backend.stats.socketsOpen = Math.max(0, backend.stats.socketsOpen - 1);
      },
    },
  });
}

function flag(name: string, fallback: string): string {
  const prefix = `--${name}=`;
  for (const arg of Bun.argv) if (arg.startsWith(prefix)) return arg.slice(prefix.length);
  return fallback;
}

function hasFlag(name: string): boolean {
  return Bun.argv.includes(`--${name}`) || Bun.argv.some((arg) => arg.startsWith(`--${name}=`));
}

/**
 * `--tls` (G4): a fresh internal CA and a server certificate signed by it, written where a harness
 * or a person can pick the CA up and register it as a trust anchor. This is the backend the trust
 * store exists for — one whose certificate no public store has ever heard of.
 */
function startTls(): { tls: { certPem: string; keyPem: string }; caPath: string } {
  const ca = generateCertificate({ cn: "apim-local-backend-ca", ca: true });
  const leaf = generateCertificate({
    cn: "petstore.internal",
    issuer: ca,
    // Both, because the harness dials 127.0.0.1 and a person types localhost.
    dnsNames: ["localhost", "petstore.internal"],
    ipAddresses: ["127.0.0.1"],
  });
  const caPath = flag("tls-ca-out", ".data/backend-ca.pem");
  mkdirSync(dirname(caPath), { recursive: true });
  writeFileSync(caPath, `${ca.certPem}\n`);
  return { tls: { certPem: leaf.certPem, keyPem: leaf.keyPem }, caPath };
}

export function loadProfiles(path: string | undefined): Profiles {
  if (!path) return [];
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Profiles;
  } catch {
    return [];
  }
}

if (import.meta.main) {
  const port = Number(flag("port", process.env.BACKEND_PORT ?? "9080"));
  const started = hasFlag("tls") || hasFlag("tls-ca-out") ? startTls() : null;
  const backend = new PetstoreBackend(
    {
      port,
      seed: Number(flag("seed", process.env.BACKEND_SEED ?? "1")),
      // Defaults to the port, so a pool started without the flag is still distinguishable.
      instance: flag("instance", process.env.BACKEND_INSTANCE ?? `petstore-${port}`),
      ...(started ? { tls: started.tls } : {}),
    },
    loadProfiles(process.env.BACKEND_PROFILES),
  );
  const server = startBackend(backend);
  console.log(
    `[backend] petstore "${backend.options.instance}" on ` +
      `${started ? "https" : "http"}://localhost:${server.port} — ` +
      `REST /v2/*, SOAP /soap/petstore (?wsdl), SSE ${EVENTS_PATH}, WebSocket ${SOCKET_PATH}, ` +
      `seed ${backend.options.seed}, stats /__stats`,
  );
  if (started) {
    console.log(
      `[backend] TLS with a generated internal CA — register ${started.caPath} as a trust anchor ` +
        "for this environment, and the gateway verifies this backend with no TLS exception",
    );
  }
}
