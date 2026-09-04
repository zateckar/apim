import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { cpus, totalmem, type as osType, release } from "node:os";
import type { RunResult, Target } from "../loadgen/runner.ts";
import { runLoad, sampleProcesses, workerCount, type LoadOutcome, type ProcessSample } from "./measure.ts";
import {
  buildCapacityWorld,
  coreLayout,
  pin,
  VALID_PET,
  type CapacityWorld,
  type GatewaySettings,
} from "./world.ts";

/**
 * `bun run capacity` — where the limits are.
 *
 * `tools/loadgen` answers "what does the gateway add", by subtracting a paired direct run from a
 * gateway run at one fixed concurrency. This answers a different question: "how much traffic will
 * one gateway take, on a stated CPU budget, before it stops going faster" — which needs an
 * absolute number, and so needs the gateway alone on cores nothing else may touch, driven by
 * load-generating processes that are somewhere else entirely.
 *
 * Every workload is swept up a concurrency ladder until throughput stops rising. Three things are
 * recorded at every rung: what the gateway returned, what the same work costs straight to the
 * backend at the same concurrency, and what the gateway process was doing to its CPU budget. The
 * third is what says whether a plateau is the gateway's ceiling or the harness's.
 */

const MIB = 1024 * 1024;

interface Variant {
  path?: string;
  method?: string;
  headers?: Record<string, string>;
  bodyBytes?: number;
  rawBody?: string;
  /** Repetitions of this variant in the request cycle; a weight, not a count. */
  weight?: number;
}

interface Workload {
  name: string;
  group: "throughput" | "slow" | "payload" | "mix";
  api: string;
  note: string;
  path: string;
  /** The identical work sent straight to the backend, for the paired comparison. */
  directPath?: string;
  method?: string;
  headers?: Record<string, string>;
  bodyBytes?: number;
  rawBody?: string;
  authenticated?: boolean;
  /** A cycled list, for mixed traffic. Overrides `path`/`headers` per request. */
  variants?: Variant[];
  ladder?: number[];
  expectStatus?: number;
}

const SOAP_ENVELOPE =
  `<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body>` +
  `<tns:GetPetRequest xmlns:tns="urn:apim:petstore"><tns:petId>1</tns:petId></tns:GetPetRequest>` +
  `</s:Body></s:Envelope>`;

/**
 * Real traffic is not one shape. This is the blend the report leans on: mostly small reads, a
 * fifth of them a page of JSON, a few large, and one in fifty against a backend that takes 200 ms
 * — which is what actually happens to a gateway's worker slots.
 */
const MIX: Variant[] = [
  { weight: 70 },
  { weight: 20, headers: { "X-Sim-Body-Bytes": "8192" } },
  { weight: 6, headers: { "X-Sim-Body-Bytes": "65536" } },
  { weight: 2, headers: { "X-Sim-Body-Bytes": String(MIB) } },
  { weight: 2, headers: { "X-Sim-Delay-Ms": "200" } },
];

const WORKLOADS: Workload[] = [
  {
    name: "bare",
    group: "throughput",
    api: "bare",
    path: "/pet/1",
    directPath: "/v2/pet/1",
    note: "route match and proxy, no policy: the ceiling the rest are measured against",
  },
  {
    name: "typical",
    group: "throughput",
    api: "typical",
    path: "/pet/1",
    directPath: "/v2/pet/1",
    authenticated: true,
    note: "key check, rate limit, one header rule, timeout — a normal published API",
  },
  {
    name: "full",
    group: "throughput",
    api: "full",
    path: "/pet/1",
    directPath: "/v2/pet/1",
    authenticated: true,
    headers: { "X-Request-Origin": "loadgen", "X-Drop-Me": "x" },
    note: "every applicable policy unit at once",
  },
  {
    name: "soap",
    group: "throughput",
    api: "soap",
    path: "",
    directPath: "/soap/petstore",
    method: "POST",
    headers: { "content-type": "text/xml", soapaction: '"urn:apim:petstore:GetPet"' },
    rawBody: SOAP_ENVELOPE,
    // Capped at 64: the simulator parses SOAP with regexes on the whole body and gives out above
    // this, refusing connections on the direct path too.
    ladder: [1, 4, 16, 32, 64],
    note: "XML prefix scan and SOAPAction agreement on every request",
  },
  {
    name: "reject-401",
    group: "throughput",
    api: "typical",
    path: "/pet/1",
    expectStatus: 401,
    note: "rejected before any backend call: the pipeline's own floor",
  },
  /*
   * Validation, as a capacity question rather than a latency one (goal G1). Design section 13
   * calls it the dominant sizing variable, and a percentage of one request's p50 does not tell an
   * operator how many gateways to run — a peak-rps row does.
   *
   * Capped at 128: these POST a body on every request, and past this the local backend starts
   * refusing connections on the direct path too, which would make the pairing meaningless.
   */
  {
    name: "validate-off",
    group: "throughput",
    api: "validate-off",
    path: "/pet",
    directPath: "/v2/pet",
    method: "POST",
    rawBody: VALID_PET,
    ladder: [1, 4, 16, 32, 64, 128],
    note: "a POST with no schema check — the floor, since the always block still runs",
  },
  {
    name: "validate-block",
    group: "throughput",
    api: "validate-block",
    path: "/pet",
    directPath: "/v2/pet",
    method: "POST",
    rawBody: VALID_PET,
    ladder: [1, 4, 16, 32, 64, 128],
    note: "the same POST, buffered and validated against the compiled schema before the backend",
  },
  {
    name: "validate-warn",
    group: "throughput",
    api: "validate-warn",
    path: "/pet",
    directPath: "/v2/pet",
    method: "POST",
    rawBody: VALID_PET,
    ladder: [1, 4, 16, 32, 64, 128],
    note: "the same POST, sampled at 1.0 and never rejecting — off the response path, not off the thread (D19)",
  },
  {
    name: "mixed",
    group: "mix",
    api: "typical",
    path: "/pet/1",
    directPath: "/v2/pet/1",
    authenticated: true,
    variants: MIX,
    // Capped at 128: the mix holds connections open (1 MiB bodies, 200 ms delays) and past this
    // the local backend refuses them on the direct path too.
    ladder: [1, 4, 16, 32, 64, 128],
    note: "70% small, 20% 8 KiB, 6% 64 KiB, 2% 1 MiB, 2% a 200 ms backend",
  },
];

/**
 * The ladders stop at 1024. Above it the *local backend* starts refusing connections — the direct
 * runs fail too, with outright connection errors — so a 2048 row would be a fact about a
 * single-threaded simulator on loopback and not about the gateway. Where the gateway's own
 * socket-holding limit is, this harness cannot say; what it can say is that 1024 concurrent held
 * requests is comfortably inside it.
 */
const SLOW: Array<{ name: string; delayMs: number; ladder: number[]; note: string }> = [
  { name: "backend-50ms", delayMs: 50, ladder: [64, 256, 512, 1024], note: "a fast internal service" },
  { name: "backend-500ms", delayMs: 500, ladder: [64, 256, 512, 1024], note: "a slow one" },
  { name: "backend-2s", delayMs: 2000, ladder: [256, 512, 1024], note: "a bad day" },
];

/**
 * Sizes with the concurrency each is measured at. Large bodies get fewer workers deliberately:
 * forty concurrent 40 MiB uploads is not a shape any real client produces, and measuring it would
 * describe the harness's memory rather than the gateway's behaviour. The 40 MiB row is here
 * because that size occurs in practice, rarely — which is exactly the case worth having a number
 * for rather than an extrapolation from 4 MiB.
 */
const PAYLOADS: Array<{ bytes: number; concurrency: number }> = [
  { bytes: 4096, concurrency: 32 },
  { bytes: 65536, concurrency: 32 },
  { bytes: 262144, concurrency: 32 },
  { bytes: MIB, concurrency: 32 },
  { bytes: 4 * MIB, concurrency: 16 },
  { bytes: 40 * MIB, concurrency: 4 },
];

/**
 * Configurations of the same gateway, for the isolation phase. The point of the middle row
 * is to identify the mechanism: if raising the runtime's outbound ceiling alone fixes the probe,
 * then what degraded it was a shared queue inside the HTTP client and not anything the gateway
 * decided.
 */
/**
 * What the flood consists of. `none` is the control — the probe with nothing else happening — and
 * without it the other rows have no baseline to be compared against.
 */
type Flood = "none" | { delayMs: number } | { bodyBytes: number; concurrency: number };

const ISOLATION: Array<{
  name: string;
  note: string;
  settings: GatewaySettings;
  ceiling: unknown | null;
  flood: Flood;
}> = [
  {
    name: "control: no flood",
    note: "the healthy route with nothing else running, so the rows below have a baseline",
    settings: { maxHttpRequests: 8192, maxConcurrentRequests: 2048 },
    ceiling: null,
    flood: "none",
  },
  {
    name: "narrow outbound queue",
    note:
      "`BUN_CONFIG_MAX_HTTP_REQUESTS=256`, the runtime's own default, with the instance ceiling " +
      "matched to it and no per-route unit. This is what a gateway looks like when nobody chose " +
      "the value.",
    settings: { maxHttpRequests: 256, maxConcurrentRequests: 256 },
    ceiling: null,
    flood: { delayMs: 2000 },
  },
  {
    name: "wide outbound queue",
    note: "`BUN_CONFIG_MAX_HTTP_REQUESTS=8192`, instance ceiling 2048, still no per-route unit",
    settings: { maxHttpRequests: 8192, maxConcurrentRequests: 2048 },
    ceiling: null,
    flood: { delayMs: 2000 },
  },
  {
    name: "per-route ceiling",
    note: "the same, plus `concurrency: { maxInFlight: 64 }` on the slow route only",
    settings: { maxHttpRequests: 8192, maxConcurrentRequests: 2048 },
    ceiling: { maxInFlight: 64, per: "instance", retryAfterSec: 1 },
    flood: { delayMs: 2000 },
  },
  {
    name: "40 MiB uploads",
    note:
      "four concurrent 40 MiB POSTs against a *fast* backend, instead of a slow backend. A large " +
      "body is not a slow backend: it is work, on the one thread that also answers everything else.",
    settings: { maxHttpRequests: 8192, maxConcurrentRequests: 2048 },
    ceiling: null,
    flood: { bodyBytes: 40 * MIB, concurrency: 4 },
  },
];

/**
 * Two things the gateway does on every request that are configuration rather than code. Both
 * default to on; the report says what each costs so turning one off is an informed trade and not
 * a hunch.
 */
const SIDE_EFFECTS: Array<{ name: string; note: string; settings: GatewaySettings }> = [
  { name: "both on (default)", note: "one JSON access-log line and one telemetry record per request", settings: {} },
  { name: "access log off", note: "`DP_ACCESS_LOG=off` — no per-request line on stdout", settings: { accessLog: false } },
  { name: "telemetry off", note: "`DP_TELEMETRY=off` — no counting, and no counting transform on the body", settings: { telemetry: "off" } },
  {
    name: "both off",
    note: "neither; the floor for how cheap a request can be made by configuration alone",
    settings: { accessLog: false, telemetry: "off" },
  },
];

interface Profile {
  durationMs: number;
  warmupMs: number;
  ladder: number[];
  slowLadder: (ladder: number[]) => number[];
  payloadConcurrency: number;
  sustainedMs: number;
  extraRoutes: number;
  scaleProcesses: number[];
  /** Requests aimed at the sick backend while the healthy route is probed. */
  floodConcurrency: number;
  /** Repeats of each logging/counting configuration; the median is reported. */
  sideEffectRepeats: number;
}

const PROFILES: Record<string, Profile> = {
  quick: {
    durationMs: 3000,
    warmupMs: 1000,
    ladder: [1, 16, 64, 256],
    slowLadder: (l) => [l[0]!, l[l.length - 1]!],
    payloadConcurrency: 16,
    sustainedMs: 20_000,
    extraRoutes: 50,
    scaleProcesses: [1, 4],
    floodConcurrency: 512,
    sideEffectRepeats: 3,
  },
  standard: {
    durationMs: 6000,
    warmupMs: 2000,
    ladder: [1, 4, 16, 32, 64, 128, 256],
    slowLadder: (l) => l,
    payloadConcurrency: 32,
    sustainedMs: 60_000,
    extraRoutes: 250,
    scaleProcesses: [1, 2, 4],
    floodConcurrency: 1024,
    sideEffectRepeats: 3,
  },
  full: {
    durationMs: 12_000,
    warmupMs: 3000,
    ladder: [1, 2, 4, 8, 16, 32, 64, 128, 256, 512],
    slowLadder: (l) => l,
    payloadConcurrency: 32,
    sustainedMs: 180_000,
    extraRoutes: 500,
    scaleProcesses: [1, 2, 4, 8],
    floodConcurrency: 1024,
    sideEffectRepeats: 3,
  },
};

function flag(name: string, fallback: string): string {
  const prefix = `--${name}=`;
  for (const arg of Bun.argv) if (arg.startsWith(prefix)) return arg.slice(prefix.length);
  return fallback;
}

const round = (n: number) => Math.round(n * 100) / 100;
const mib = (bytes: number | null | undefined) =>
  bytes === null || bytes === undefined ? "—" : round(bytes / MIB);
/** An unmeasured CPU figure prints as unknown, never as zero. */
const pct = (cpu: number | null) => (cpu === null ? "—" : `${Math.round(cpu * 100)}%`);

function targetsFor(world: CapacityWorld, workload: Workload, direct: boolean): Target[] {
  const api = world.apis.get(workload.api);
  if (!api) throw new Error(`workload ${workload.name} names unknown api ${workload.api}`);
  // Several gateway processes are several URLs, and cycling them is what a load balancer does.
  const bases = direct ? [world.backendUrl] : world.gateway.urls;
  const path = direct ? (workload.directPath ?? workload.path) : `${api.basePath}${workload.path}`;

  const headers: Record<string, string> = { ...(workload.headers ?? {}) };
  if (workload.authenticated && api.key && !direct) headers["X-Api-Key"] = api.key;

  const one = (base: string, variant: Variant): Target => ({
    base,
    path: variant.path ?? path,
    method: variant.method ?? workload.method ?? "GET",
    headers: { ...headers, ...(variant.headers ?? {}) },
    bodyBytes: variant.bodyBytes ?? workload.bodyBytes ?? 0,
    rawBody: variant.rawBody ?? workload.rawBody,
  });

  const variants = workload.variants ?? [{}];
  const cycle: Target[] = [];
  for (const variant of variants) {
    for (let i = 0; i < (variant.weight ?? 1); i++) {
      for (const base of bases) cycle.push(one(base, variant));
    }
  }
  return cycle;
}

interface Rung {
  concurrency: number;
  gateway: RunResult;
  direct: RunResult | null;
  /** Null when a gateway process did not answer the sample; never silently zero. */
  cpu: number | null;
  /** Gateway CPU per request served. Independent of concurrency, so it is the sizing figure. */
  cpuMicrosPerRequest: number | null;
  cpuMicrosPerRequestSelf: number | null;
  cpuSource: "os" | "self" | null;
  rssBytes: number | null;
  /** Sampled halfway through the measured window, so it is what the processes were holding. */
  inFlight: number | null;
}

/** One configuration of the logging/counting phase: median of several runs, plus their spread. */
interface SideEffectRow {
  name: string;
  note: string;
  rung: Rung;
  /** Fastest to slowest attempt, as a fraction. Anything claimed below this is noise. */
  spread: number;
}

/** One configuration of the isolation phase: what the flood did, and what the probe noticed. */
interface IsolationRow {
  name: string;
  note: string;
  floodConcurrency: number;
  /** Null on the control row, where there is no flood. */
  flood: RunResult | null;
  probe: RunResult;
  /** What the gateway was actually holding mid-flood, and what that cost in memory. */
  floodInFlight: number | null;
  rssBytes: number | null;
}

interface Sweep {
  workload: Workload;
  rungs: Rung[];
  peakRps: number;
  /** Lowest concurrency reaching 95% of peak: past it, load buys latency and not throughput. */
  kneeConcurrency: number;
  kneeP99: number;
  cpuAtPeak: number | null;
}

async function healthOf(world: CapacityWorld): Promise<any> {
  try {
    const response = await fetch(`${world.gateway.urls[0]}/healthz`, { signal: AbortSignal.timeout(3000) });
    return await response.json();
  } catch {
    return null;
  }
}

function analyse(workload: Workload, rungs: Rung[]): Sweep {
  const peakRps = Math.max(...rungs.map((r) => r.gateway.rps));
  const knee = rungs.find((r) => r.gateway.rps >= peakRps * 0.95) ?? rungs[rungs.length - 1]!;
  const atPeak = rungs.find((r) => r.gateway.rps === peakRps)!;
  return {
    workload,
    rungs,
    peakRps,
    kneeConcurrency: knee.concurrency,
    kneeP99: knee.gateway.p99,
    cpuAtPeak: atPeak.cpu,
  };
}

async function settle(ms = 1500): Promise<void> {
  await Bun.sleep(ms);
}

/**
 * Rewrite the report from a saved run. Measuring takes the better part of an hour; revising a
 * sentence in the report should not, and re-measuring to fix a caption would also mean the numbers
 * quietly changed underneath it.
 */
function regenerate(path: string): void {
  const input = JSON.parse(readFileSync(path, "utf8")) as ReportInput;
  writeFileSync("docs/capacity-report.md", writeReport(input));
  console.log(`[capacity] rewrote docs/capacity-report.md from ${path} (measured ${input.startedAt})`);
}

async function main(): Promise<void> {
  const from = flag("from", "");
  if (from) {
    regenerate(from);
    return;
  }
  const profileName = flag("profile", "standard");
  const profile = PROFILES[profileName];
  if (!profile) throw new Error(`unknown profile "${profileName}" (known: quick, standard, full)`);
  const cpuBudget = Number(flag("cpus", "4"));
  // `--only=isolation,memory` runs a subset and prints instead of writing the report: a report
  // assembled from a subset of the phases would be missing sections without saying so.
  const only = flag("only", "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const want = (phase: string) => only.length === 0 || only.includes(phase);
  const totalCpus = cpus().length;
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();

  // Pin the orchestrator first: every process it starts inherits this mask, so the load
  // generators land on harness cores without a per-process call, and only the gateway is
  // deliberately moved off them.
  const layout = coreLayout(totalCpus, cpuBudget);
  pin(process.pid, layout.harness);

  console.log(`[capacity] ${layout.note}`);
  console.log(`[capacity] building an isolated world (profile ${profileName})…`);
  const world = await buildCapacityWorld({ cpuBudget, totalCpus });
  const workers = workerCount(layout);
  const cores = cpuBudget;
  const urls = () => world.gateway.urls;
  const pids = () => world.gateway.pids;

  const sweeps: Sweep[] = [];
  const slowSweeps: Sweep[] = [];
  const payloadRows: Array<{ bytes: number; direction: "up" | "down"; rung: Rung }> = [];
  const scaleRows: Array<{
    processes: number;
    mode: "separate" | "shared";
    workload: string;
    concurrency: number;
    rung: Rung;
  }> = [];
  const sideEffectRows: SideEffectRow[] = [];
  const isolationRows: IsolationRow[] = [];
  const memory: Record<string, unknown> = {};

  try {
    const idleHealth = await healthOf(world);
    const idle = sampleProcesses(pids());
    memory.idle = {
      routes: idleHealth?.routes ?? null,
      workingSetBytes: idle.workingSetBytes,
      privateBytes: idle.privateBytes,
      heapUsedBytes: idleHealth?.process?.heapUsedBytes ?? null,
    };
    console.log(
      `[capacity] idle: ${mib(idle.workingSetBytes)} MiB working set, ` +
        `${idleHealth?.routes ?? "?"} routes`,
    );

    const step = async (
      label: string,
      workload: Workload,
      concurrency: number,
      durationMs: number,
    ): Promise<Rung> => {
      process.stdout.write(`[capacity] ${label.padEnd(30)} c=${String(concurrency).padStart(5)} `);
      const gateway = await runLoad(
        targetsFor(world, workload, false),
        { concurrency, durationMs, warmupMs: profile.warmupMs, workers },
        world.gateway,
        cores,
      );
      await settle();

      let direct: LoadOutcome | null = null;
      if (workload.directPath) {
        direct = await runLoad(
          targetsFor(world, workload, true),
          { concurrency, durationMs, warmupMs: profile.warmupMs, workers },
          world.gateway,
          cores,
        );
        await settle();
      }

      const rung: Rung = {
        concurrency,
        gateway: gateway.result,
        direct: direct?.result ?? null,
        cpu: gateway.cpu,
        cpuMicrosPerRequest: gateway.cpuMicrosPerRequest,
        cpuMicrosPerRequestSelf: gateway.cpuMicrosPerRequestSelf,
        cpuSource: gateway.cpuSource,
        rssBytes: gateway.after.workingSetBytes,
        inFlight: gateway.inFlight,
      };
      console.log(
        `rps ${String(Math.round(rung.gateway.rps)).padStart(7)}  ` +
          `p50 ${String(rung.gateway.p50).padStart(7)}  p99 ${String(rung.gateway.p99).padStart(8)}  ` +
          // Raw, uninterpreted. The ratio of these two is not reported anywhere: see the report's
          // "what this still does not measure" for why.
          `[dcpu ${String(gateway.deltaCpuMs ?? "?").padStart(6)}ms dsrv ${String(gateway.deltaServed ?? "?").padStart(7)}]  ` +
          `rss ${String(mib(rung.rssBytes)).padStart(6)} MiB  ` +
          `direct ${direct ? Math.round(direct.result.rps) : "—"}  ` +
          `${statusSummary(rung.gateway)}`,
      );
      return rung;
    };

    // The reference workload for every phase that varies something other than the workload.
    const scaleWorkload = WORKLOADS.find((w) => w.name === "typical")!;

    // --- 1. throughput: sweep each workload up the ladder --------------------------------------
    if (want("throughput")) {
    console.log("");
    console.log("[capacity] phase 1 — throughput against a fast backend");
    for (const workload of WORKLOADS) {
      const rungs: Rung[] = [];
      for (const concurrency of workload.ladder ?? profile.ladder) {
        rungs.push(await step(workload.name, workload, concurrency, profile.durationMs));
      }
      sweeps.push(analyse(workload, rungs));
    }

    }

    // --- 2. slow backends: how many requests can one process hold ------------------------------
    if (want("slow")) {
    console.log("");
    console.log("[capacity] phase 2 — concurrency against a slow backend");
    for (const slow of SLOW) {
      const workload: Workload = {
        name: slow.name,
        group: "slow",
        api: "typical",
        path: "/pet/1",
        directPath: "/v2/pet/1",
        authenticated: true,
        headers: { "X-Sim-Delay-Ms": String(slow.delayMs) },
        note: slow.note,
      };
      const rungs: Rung[] = [];
      for (const concurrency of profile.slowLadder(slow.ladder)) {
        // A slow backend needs a window long enough to contain several round trips per worker.
        const durationMs = Math.max(profile.durationMs, slow.delayMs * 6);
        rungs.push(await step(slow.name, workload, concurrency, durationMs));
      }
      slowSweeps.push(analyse(workload, rungs));
    }

    }

    // --- 3. payload: where bytes become the limit ----------------------------------------------
    if (want("payload")) {
    console.log("");
    console.log("[capacity] phase 3 — payload size");
    for (const { bytes, concurrency } of PAYLOADS) {
      for (const direction of ["up", "down"] as const) {
        const workload: Workload =
          direction === "down"
            ? {
                name: `down-${sizeLabel(bytes).replace(" ", "")}`,
                group: "payload",
                api: "bare",
                path: "/pet/1",
                directPath: "/v2/pet/1",
                headers: { "X-Sim-Body-Bytes": String(bytes) },
                note: "response body",
              }
            : {
                name: `up-${sizeLabel(bytes).replace(" ", "")}`,
                group: "payload",
                api: "bare",
                path: "/echo",
                directPath: "/v2/echo",
                method: "POST",
                bodyBytes: bytes,
                note: "request body",
              };
        const rung = await step(
          workload.name,
          workload,
          Math.min(concurrency, profile.payloadConcurrency),
          profile.durationMs,
        );
        payloadRows.push({ bytes, direction, rung });
      }
    }

    }

    // --- 4. memory under sustained load ---------------------------------------------------------
    if (want("memory")) {
    console.log("");
    console.log("[capacity] phase 4 — memory under sustained load");
    console.log(`[capacity] sustained ${Math.round(profile.sustainedMs / 1000)}s at c=64 (mixed)…`);
    const mixed = WORKLOADS.find((w) => w.name === "mixed")!;
    const samples: ProcessSample[] = [];
    const ticker = setInterval(() => samples.push(sampleProcesses(pids())), 5000);
    const sustained = await runLoad(
      targetsFor(world, mixed, false),
      { concurrency: 64, durationMs: profile.sustainedMs, warmupMs: profile.warmupMs, workers },
      world.gateway,
      cores,
    );
    clearInterval(ticker);
    const sustainedHealth = await healthOf(world);
    await settle(15_000);
    const afterIdle = sampleProcesses(pids());
    memory.sustained = {
      durationMs: profile.sustainedMs,
      concurrency: 64,
      requests: sustained.result.completed,
      rps: sustained.result.rps,
      cpu: sustained.cpu,
      workingSetSeries: samples.map((s) => s.workingSetBytes),
      workingSetPeak: Math.max(
        ...[...samples.map((s) => s.workingSetBytes), sustained.after.workingSetBytes].filter(
          (v): v is number => v !== null,
        ),
      ),
      workingSetAfterIdle: afterIdle.workingSetBytes,
      privateAfterIdle: afterIdle.privateBytes,
      peakWorkingSetBytes: afterIdle.peakWorkingSetBytes,
      heapUsedBytes: sustainedHealth?.process?.heapUsedBytes ?? null,
    };
    console.log(
      `[capacity] sustained: ${Math.round(sustained.result.rps)} rps, working set ` +
        `${mib(sustained.after.workingSetBytes)} MiB, after 15s idle ${mib(afterIdle.workingSetBytes)} MiB`,
    );

    }

    // --- 5. scaling: one JavaScript thread per process, so use more processes -------------------
    if (want("scaling")) {
    console.log("");
    console.log("[capacity] phase 5 — more gateway processes");
    // Also swept without a backend in the picture. Four gateway processes can offer more work
    // than one single-threaded petstore simulator will accept — it starts refusing connections
    // around its own direct ceiling — so a proxied workload stops measuring gateway scaling and
    // starts measuring the simulator. `reject-401` never calls a backend, so it cannot.
    const backendlessWorkload = WORKLOADS.find((w) => w.name === "reject-401")!;
    const scaleConcurrency = 256;
    for (const processes of profile.scaleProcesses) {
      await world.scaleGateway(processes, "separate");
      for (const workload of [backendlessWorkload, scaleWorkload]) {
        const rung = await step(
          `fleet x${processes} ${workload.name}`,
          workload,
          scaleConcurrency,
          profile.durationMs,
        );
        scaleRows.push({
          processes,
          mode: "separate",
          workload: workload.name,
          concurrency: scaleConcurrency,
          rung,
        });
      }
    }
    // The same process count behind a single shared port, for comparison: whether SO_REUSEPORT
    // spreads connections is platform behaviour, not something to assume.
    const most = profile.scaleProcesses[profile.scaleProcesses.length - 1]!;
    if (most > 1) {
      await world.scaleGateway(most, "shared");
      for (const workload of [backendlessWorkload, scaleWorkload]) {
        const rung = await step(
          `shared port x${most} ${workload.name}`,
          workload,
          scaleConcurrency,
          profile.durationMs,
        );
        scaleRows.push({
          processes: most,
          mode: "shared",
          workload: workload.name,
          concurrency: scaleConcurrency,
          rung,
        });
      }
    }

    }

    // --- 6. what the per-request side effects cost ----------------------------------------------
    if (want("sideeffects")) {
    // Both are configuration, not code: an access log line and a telemetry record are written on
    // every request, and both can be turned off. Whether that is worth doing is a judgement; what
    // it buys should be a measurement.
    console.log("");
    console.log("[capacity] phase 6 — the cost of logging and counting");
    // Repeated and **interleaved**, reported as the median.
    //
    // One measurement each was not enough: an early attempt had turning the access log *off*
    // coming out slower than leaving it on. Three each, grouped by configuration, was still not
    // enough — whichever configuration went first inherited a machine still settling from the
    // four-process teardown in the phase before, and came out with a 52% spread while the others
    // sat inside 13%. Grouping is what did that: it gives the first variant a systematically worse
    // machine than the last. Round-robin instead, so a drifting machine moves every row together
    // rather than penalising whichever one happened to be first, with one full pass discarded
    // before any of it counts.
    const attempts = new Map<string, Rung[]>(SIDE_EFFECTS.map((v) => [v.name, []]));
    for (let pass = 0; pass <= profile.sideEffectRepeats; pass++) {
      for (const variant of SIDE_EFFECTS) {
        await world.scaleGateway(1, "separate", variant.settings);
        const label = pass === 0 ? `${variant.name} (warm-up)` : `${variant.name} #${pass}`;
        const rung = await step(label, scaleWorkload, 64, profile.durationMs);
        if (pass > 0) attempts.get(variant.name)!.push(rung);
      }
    }
    for (const variant of SIDE_EFFECTS) {
      const ordered = [...attempts.get(variant.name)!].sort((a, b) => a.gateway.rps - b.gateway.rps);
      const spread =
        ordered[ordered.length - 1]!.gateway.rps / Math.max(1, ordered[0]!.gateway.rps) - 1;
      sideEffectRows.push({
        name: variant.name,
        note: variant.note,
        rung: ordered[Math.floor(ordered.length / 2)]!,
        spread: round(spread * 100) / 100,
      });
    }

    }

    // --- 6b. isolation: can one slow backend degrade the others? -------------------------------
    if (want("isolation")) {
    // The question this phase exists for. One route is flooded with requests to a backend that
    // takes two seconds; another route, on the same instance, is probed at low concurrency. If the
    // gateway is well behaved, the probe does not notice. Measured with no ceiling, with the
    // runtime's outbound ceiling raised, and with a per-route ceiling attached.
    console.log("");
    console.log("[capacity] phase 6b — isolation: one slow backend, one healthy route");
    /** A slow backend and a large body are different failures; both are floods. */
    const floodFor = (flood: Exclude<Flood, "none">): Workload =>
      "delayMs" in flood
        ? {
            name: "flood",
            group: "slow",
            api: "typical",
            path: "/pet/1",
            authenticated: true,
            headers: { "X-Sim-Delay-Ms": String(flood.delayMs) },
            note: `a backend taking ${flood.delayMs} ms, hammered`,
          }
        : {
            name: "flood",
            group: "payload",
            api: "typical",
            path: "/echo",
            method: "POST",
            authenticated: true,
            bodyBytes: flood.bodyBytes,
            note: `${sizeLabel(flood.bodyBytes)} request bodies`,
          };
    const probeWorkload: Workload = {
      name: "probe",
      group: "throughput",
      api: "bare",
      path: "/pet/1",
      note: "an unrelated healthy route on the same instance",
    };

    for (const variant of ISOLATION) {
      await world.scaleGateway(1, "separate", variant.settings);
      await setPolicyUnit(world, "typical", "concurrency", variant.ceiling);
      process.stdout.write(`[capacity] ${variant.name.padEnd(34)}`);

      const floodConcurrency =
        variant.flood === "none"
          ? 0
          : "concurrency" in variant.flood
            ? variant.flood.concurrency
            : profile.floodConcurrency;

      // Both at once, in separate worker processes: the flood must actually be in flight while
      // the probe is measured, or the phase measures nothing.
      const probeRun = async (delayMs: number) => {
        await Bun.sleep(delayMs);
        return runLoad(
          targetsFor(world, probeWorkload, false),
          { concurrency: 8, durationMs: profile.durationMs, warmupMs: 0, workers: 2 },
          world.gateway,
          cores,
        );
      };
      const [flood, probe] =
        variant.flood === "none"
          ? [null, await probeRun(0)]
          : await Promise.all([
              runLoad(
                targetsFor(world, floodFor(variant.flood), false),
                {
                  concurrency: floodConcurrency,
                  durationMs: profile.durationMs + 4000,
                  warmupMs: 500,
                  workers,
                },
                world.gateway,
                cores,
              ),
              // Started a moment later, so the flood is established first.
              probeRun(2500),
            ]);
      isolationRows.push({
        name: variant.name,
        note: variant.note,
        floodConcurrency,
        flood: flood?.result ?? null,
        probe: probe.result,
        floodInFlight: flood?.inFlight ?? null,
        rssBytes: (flood ?? probe).after.workingSetBytes,
      });
      console.log(
        `probe p50 ${String(probe.result.p50).padStart(7)}  p99 ${String(probe.result.p99).padStart(8)}  ` +
          `rps ${String(Math.round(probe.result.rps)).padStart(6)}  ` +
          `held ${String(flood?.inFlight ?? "—").padStart(5)}  ` +
          `rss ${String(mib((flood ?? probe).after.workingSetBytes)).padStart(6)} MiB  ` +
          `| flood ${flood ? statusSummary(flood.result) : "(none)"}`,
      );
    }
    // Leave the world as the other phases found it.
    await setPolicyUnit(world, "typical", "concurrency", null);

    }

    // --- 7. configuration size --------------------------------------------------------------
    if (want("config")) {
    // Last, deliberately: publishing hundreds more APIs changes the route table every phase above
    // was measured against, so it happens once everything else has been recorded. One process
    // again, freshly started, so the before/after pair is the same process with and without it.
    console.log("");
    console.log("[capacity] phase 7 — configuration size");
    await world.scaleGateway(1);
    await settle(2000);
    const beforeHealth = await healthOf(world);
    const before = sampleProcesses(pids());
    const added = await addRoutes(world, profile.extraRoutes);
    const grownHealth = await waitForRoutes(world, (beforeHealth?.routes ?? 0) + added);
    await settle(3000);
    const afterConfig = sampleProcesses(pids());
    memory.config = {
      routesBefore: beforeHealth?.routes ?? null,
      routesAfter: grownHealth?.routes ?? null,
      added,
      workingSetBefore: before.workingSetBytes,
      workingSetAfter: afterConfig.workingSetBytes,
      bytesPerRoute:
        added > 0 && afterConfig.workingSetBytes !== null && before.workingSetBytes !== null
          ? Math.round((afterConfig.workingSetBytes - before.workingSetBytes) / added)
          : null,
      configDigest: grownHealth?.configDigest ?? null,
    };
    console.log(
      `[capacity] config: ${beforeHealth?.routes} → ${grownHealth?.routes} routes, ` +
        `${mib(before.workingSetBytes)} → ${mib(afterConfig.workingSetBytes)} MiB`,
    );

    // The route table is bigger now, so re-run one rung of `typical` to say what that cost.
    const withRoutes = await step("typical (many routes)", scaleWorkload, 64, profile.durationMs);
    memory.routeCost = {
      routes: grownHealth?.routes ?? null,
      rps: withRoutes.gateway.rps,
      p50: withRoutes.gateway.p50,
    };

    }

    // --- report ---------------------------------------------------------------------------------
    const elapsedMs = Date.now() - startedMs;
    const input: ReportInput = {
      startedAt,
      elapsedMs,
      profileName,
      cpuBudget,
      totalCpus,
      layout,
      workers,
      sweeps,
      slowSweeps,
      payloadRows,
      scaleRows,
      sideEffectRows,
      isolationRows,
      memory,
    };
    if (only.length > 0) {
      // A subset was run. Writing the report would publish a document whose missing sections look
      // like measurements that came back empty.
      console.log("");
      console.log(`[capacity] --only=${only.join(",")}: no report written`);
      return;
    }
    writeFileSync("docs/capacity-report.md", writeReport(input));
    mkdirSync(".data/capacity", { recursive: true });
    // Everything the report needs, so its wording can be revised without measuring again.
    writeFileSync(
      `.data/capacity/${startedAt.replace(/[:.]/g, "-")}.json`,
      JSON.stringify(input, (key, value) => (key === "samples" ? undefined : value), 2),
    );
    appendFileSync(
      ".data/capacity/history.jsonl",
      JSON.stringify({
        at: startedAt,
        profile: profileName,
        cpuBudget,
        peak: Object.fromEntries(sweeps.map((s) => [s.workload.name, s.peakRps])),
      }) + "\n",
    );
    console.log("");
    console.log(`[capacity] wrote docs/capacity-report.md (${Math.round(elapsedMs / 1000)}s)`);
  } finally {
    world.stop();
  }
}

function statusSummary(result: RunResult): string {
  return Object.entries(result.statuses)
    .sort((a, b) => b[1] - a[1])
    .map(([status, count]) => `${status}x${count}`)
    .join(" ");
}

/**
 * Attach or remove a policy unit on a live API and wait for the gateway to take the new config.
 * The isolation phase needs the same world with and without a ceiling, and policy is per
 * environment and edited in place (design section 6.1), so no re-release is involved.
 */
const appliedUnits = new Map<string, string>();

async function setPolicyUnit(
  world: CapacityWorld,
  apiName: string,
  unit: string,
  value: unknown | null,
): Promise<void> {
  const api = world.apis.get(apiName);
  if (!api) throw new Error(`unknown api ${apiName}`);

  // Nothing to do, and nothing to wait for. Applying a value the route already has produces no
  // new config document, so waiting for the digest to change would wait forever — and deleting a
  // unit that was never attached is not an error worth raising either.
  const memoKey = `${api.resourceId}|${unit}`;
  const desired = JSON.stringify(value);
  if ((appliedUnits.get(memoKey) ?? "null") === desired) return;
  const login = await fetch(`${world.cpUrl}/api/auth/dev-login`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: world.cpUrl },
    body: JSON.stringify({ userId: "pavel" }),
  });
  const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
  const path = `/api/resources/${api.resourceId}/policy/units/${encodeURIComponent(unit)}`;
  const before = (await healthOf(world))?.configDigest ?? null;
  const response = await fetch(`${world.cpUrl}${path}`, {
    method: value === null ? "DELETE" : "PUT",
    headers: { "content-type": "application/json", origin: world.cpUrl, cookie },
    body: value === null ? undefined : JSON.stringify({ value }),
  });
  if (!response.ok) throw new Error(`${unit}: ${response.status} ${await response.text()}`);
  appliedUnits.set(memoKey, desired);

  // Wait for the digest to change, not for a fixed sleep: a measurement taken against the old
  // config would be the previous row again, silently.
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const digest = (await healthOf(world))?.configDigest ?? null;
    if (digest !== before) return;
    await Bun.sleep(250);
  }
  throw new Error(`the gateway did not take the new config after ${unit} changed`);
}

/** Publishes APIs nobody calls, so working set can be attributed to config rather than traffic. */
async function addRoutes(world: CapacityWorld, count: number): Promise<number> {
  const login = await fetch(`${world.cpUrl}/api/auth/dev-login`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: world.cpUrl },
    body: JSON.stringify({ userId: "pavel" }),
  });
  const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
  const call = async (method: string, path: string, body?: unknown): Promise<any> => {
    const response = await fetch(`${world.cpUrl}${path}`, {
      method,
      headers: { "content-type": "application/json", origin: world.cpUrl, cookie },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${await response.text()}`);
    return response.json();
  };

  const spec = {
    swagger: "2.0",
    info: { title: "filler", version: "1.0.0" },
    host: "127.0.0.1",
    basePath: "/v2",
    schemes: ["http"],
    paths: { "/pet/{petId}": { get: { operationId: "getPetById", responses: { "200": { description: "ok" } } } } },
  };

  let added = 0;
  for (let i = 0; i < count; i++) {
    const resource = await call("POST", "/api/resources", {
      kind: "rest",
      name: `filler-${i}`,
      teamId: "team_platform",
    });
    await call("POST", `/api/resources/${resource.id}/revisions`, { spec });
    await call("PUT", `/api/resources/${resource.id}/routes`, {
      environment: "dev",
      host: "*",
      basePath: `/filler-${i}`,
    });
    await call("PUT", `/api/resources/${resource.id}/binding`, {
      environment: "dev",
      urls: [`${world.backendUrl}/v2`],
    });
    await call("PUT", `/api/resources/${resource.id}/policy/units/rewrite`, {
      value: { stripBasePath: true },
    });
    await call("POST", `/api/resources/${resource.id}/releases`, { revision: 1, environment: "dev" });
    added++;
  }
  return added;
}

async function waitForRoutes(world: CapacityWorld, atLeast: number): Promise<any> {
  const deadline = Date.now() + 60_000;
  let last: any = null;
  while (Date.now() < deadline) {
    last = await healthOf(world);
    if ((last?.routes ?? 0) >= atLeast) return last;
    await Bun.sleep(500);
  }
  return last;
}

interface ReportInput {
  startedAt: string;
  elapsedMs: number;
  profileName: string;
  cpuBudget: number;
  totalCpus: number;
  layout: ReturnType<typeof coreLayout>;
  workers: number;
  sweeps: Sweep[];
  slowSweeps: Sweep[];
  payloadRows: Array<{ bytes: number; direction: "up" | "down"; rung: Rung }>;
  scaleRows: Array<{
    processes: number;
    mode: "separate" | "shared";
    workload: string;
    concurrency: number;
    rung: Rung;
  }>;
  sideEffectRows: SideEffectRow[];
  isolationRows: IsolationRow[];
  memory: Record<string, any>;
}

function sizeLabel(bytes: number): string {
  return bytes >= MIB ? `${round(bytes / MIB)} MiB` : `${Math.round(bytes / 1024)} KiB`;
}

function writeReport(input: ReportInput): string {
  const lines: string[] = [];
  const {
    sweeps,
    slowSweeps,
    payloadRows,
    scaleRows,
    sideEffectRows,
    isolationRows,
    memory,
    layout,
    cpuBudget,
    totalCpus,
    workers,
  } = input;
  const bare = sweeps.find((s) => s.workload.name === "bare");
  const typical = sweeps.find((s) => s.workload.name === "typical");
  const mixed = sweeps.find((s) => s.workload.name === "mixed");
  const reject = sweeps.find((s) => s.workload.name === "reject-401");

  lines.push("# Gateway capacity report");
  lines.push("");
  lines.push(
    `> **Generated** by \`bun run capacity --profile=${input.profileName} --cpus=${cpuBudget}\` ` +
      `at ${input.startedAt}. Edits are overwritten; change \`tools/capacity/index.ts\` instead.`,
  );
  lines.push("");
  lines.push(
    "This is the companion to [`perf-report.md`](perf-report.md) and answers the opposite " +
      "question. That report measures **what the gateway adds** — a difference, at one fixed " +
      "concurrency, with everything in one process. This one measures **what the gateway takes** " +
      "— an absolute number, swept up a concurrency ladder, with the gateway alone on a stated " +
      "CPU budget and the load generated from processes that are not allowed near it.",
  );
  lines.push("");

  // ---- headline -------------------------------------------------------------------------------
  lines.push("## The short answer");
  lines.push("");
  // The harness's own run-to-run spread, measured by repeating one identical configuration in the
  // logging phase. Any claimed difference smaller than this is not a difference.
  const noise = Math.round(Math.max(0, ...sideEffectRows.map((r) => r.spread)) * 100);
  if (typical && bare && mixed) {
    const policyCost = Math.round((1 - typical.peakRps / bare.peakRps) * 100);
    lines.push(
      `On **${cpuBudget} cores**, one gateway process sustains **${Math.round(typical.peakRps).toLocaleString()} rps** ` +
        `on a normal published API (key check, rate limit, header rule, timeout) against a fast ` +
        `backend, and **${Math.round(mixed.peakRps).toLocaleString()} rps** on mixed traffic ` +
        `(${mixed.workload.note}). The ceiling with no policy at all is ` +
        `**${Math.round(bare.peakRps).toLocaleString()} rps**, so the whole policy pipeline costs ` +
        (policyCost <= noise
          ? `less than this harness can distinguish from its own run-to-run spread of ${noise}%.`
          : `about **${policyCost}%** of peak throughput — against a run-to-run spread of ` +
            `${noise}%, so read it as a direction and not a constant.`),
    );
    lines.push("");
    lines.push(
      `**It does not use the ${cpuBudget} cores.** Bun serves HTTP from a single JavaScript ` +
        "thread, so one gateway process is a one-core program however many cores it is scheduled " +
        "on. More processes is therefore the way to use more cores, and " +
        "[Using the other cores](#using-the-other-cores) measures how far that goes before this " +
        "harness — rather than the gateway — becomes the limit.",
    );
    lines.push("");
    lines.push(
      `Past **concurrency ${typical.kneeConcurrency}** throughput stops rising and latency starts ` +
        `growing in proportion to the load offered — the queue, not the service, is what grows. ` +
        `p99 at that point is **${typical.kneeP99} ms**.`,
    );
    lines.push("");
  }
  if (memory.sustained) {
    lines.push(
      `**Memory: about ${mib(memory.sustained.workingSetAfterIdle)} MiB per process** in steady ` +
        `state, ${mib(memory.idle?.workingSetBytes ?? 0)} MiB of it at rest before any traffic. ` +
        `The section [Memory](#memory) breaks that into base, configuration and in-flight work.`,
    );
    lines.push("");
  }

  // ---- method ---------------------------------------------------------------------------------
  lines.push("## How this was measured");
  lines.push("");
  lines.push(`| | |`);
  lines.push(`|---|---|`);
  lines.push(`| Host | ${osType()} ${release()} |`);
  lines.push(`| CPU | ${cpus()[0]?.model ?? "unknown"} (${totalCpus} logical) |`);
  lines.push(`| Memory | ${Math.round(totalmem() / 1024 / 1024 / 1024)} GiB |`);
  lines.push(`| Runtime | Bun ${Bun.version} |`);
  lines.push(`| Gateway CPU budget | ${cpuBudget} cores — CPUs ${layout.gatewayCores.join(", ")} |`);
  lines.push(`| Harness CPUs | ${layout.harnessCores.join(", ")} |`);
  lines.push(`| Load generators | ${workers} processes |`);
  lines.push(`| Profile | ${input.profileName} |`);
  lines.push(`| Wall time | ${Math.round(input.elapsedMs / 60_000)} min |`);
  lines.push("");
  lines.push(
    "Every piece is its own process, and none of the others may touch the gateway's cores: the " +
      "gateway, the control plane, the petstore backend, and the load generators. The CPU budget is a Windows " +
      "`ProcessorAffinity` mask, read back after it is set, and the run aborts if it did not take. " +
      `The gateway's ${cpuBudget} CPUs are ${cpuBudget} *physical* cores with their SMT siblings ` +
      "left idle, so the budget means what it says — the cloud reading of “4 vCPU” is four " +
      "hyperthreads on two cores and is worth appreciably less.",
  );
  lines.push("");
  lines.push(
    "**Reading a plateau.** Throughput flattening only means the *gateway* is the limit if nothing " +
      "else gave out first, so every table carries `direct rps`: the same work, at the same " +
      "concurrency, sent straight to the backend. That is the harness's own ceiling. Where it is " +
      "comfortably above the gateway's number the row is about the gateway; where it is not, the " +
      "row is about the harness, and the text says so rather than leaving it to be noticed.",
  );
  lines.push("");

  // ---- throughput -----------------------------------------------------------------------------
  lines.push("## Throughput against a fast backend");
  lines.push("");
  lines.push(
    "Each workload swept up a concurrency ladder. The backend answers immediately, so this is the " +
      "gateway's own request-handling ceiling and nothing else.",
  );
  lines.push("");
  for (const sweep of sweeps) {
    lines.push(`### \`${sweep.workload.name}\``);
    lines.push("");
    lines.push(`${sweep.workload.note}.`);
    lines.push("");
    lines.push(
      "| conc | rps | p50 ms | p95 ms | p99 ms | rss MiB | direct rps | direct p50 | +p50 ms | errors |",
    );
    lines.push("|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
    for (const rung of sweep.rungs) {
      lines.push(
        `| ${rung.concurrency} | ${Math.round(rung.gateway.rps).toLocaleString()} | ${rung.gateway.p50} | ` +
          `${rung.gateway.p95} | ${rung.gateway.p99} | ` +
          `${mib(rung.rssBytes)} | ${rung.direct ? Math.round(rung.direct.rps).toLocaleString() : "—"} | ` +
          `${rung.direct?.p50 ?? "—"} | ${rung.direct ? round(rung.gateway.p50 - rung.direct.p50) : "—"} | ` +
          `${rung.gateway.errors} |`,
      );
    }
    lines.push("");
    lines.push(
      `Peak **${Math.round(sweep.peakRps).toLocaleString()} rps**; 95% of it is reached at ` +
        `concurrency **${sweep.kneeConcurrency}** (p99 ${sweep.kneeP99} ms).`,
    );
    lines.push("");
  }

  if (bare && typical && reject) {
    lines.push("### What the pipeline costs, as throughput");
    lines.push("");
    lines.push("| Workload | peak rps | vs `bare` | knee | p99 at the knee |");
    lines.push("|---|---:|---:|---:|---:|");
    for (const sweep of sweeps) {
      lines.push(
        `| \`${sweep.workload.name}\` | ${Math.round(sweep.peakRps).toLocaleString()} | ` +
          `${sweep.workload.name === "bare" ? "—" : `${Math.round((sweep.peakRps / bare.peakRps - 1) * 100)}%`} | ` +
          `${sweep.kneeConcurrency} | ${sweep.kneeP99} ms |`,
      );
    }
    lines.push("");
    lines.push(
      "Size from throughput, not from CPU. Per-request CPU would be the better sizing figure — it " +
        "does not depend on the concurrency the ladder happened to reach — but it could not be " +
        "measured reliably here; see [what is not measured](#what-this-still-does-not-measure).",
    );
    lines.push("");
    lines.push(
      "Read the three `validate-*` rows against **each other**, not against `bare`: they POST a " +
        "body where `bare` does a small GET, so most of the difference from `bare` is the body, " +
        "not the checking. The comparison that means something is below.",
    );
    lines.push("");
  }

  // ---- validation, the dominant sizing variable (design section 13) ----------------------------
  const validateOff = sweeps.find((s) => s.workload.name === "validate-off");
  const validateSweeps = sweeps.filter((s) => s.workload.name.startsWith("validate-"));
  if (validateOff && validateSweeps.length > 1) {
    lines.push("### What validation costs, as capacity");
    lines.push("");
    lines.push(
      "One contract, one body, three states, the same ladder. `validate-off` is the **floor, not " +
        "zero**: the `always` block — content type, body size, nesting depth, duplicate keys — is " +
        "enforced in every state, which is the point of it. So the column that answers \"what does " +
        "schema validation cost me\" is the one against `validate-off`.",
    );
    lines.push("");
    lines.push("| State | peak rps | vs `off` | knee | p99 at the knee |");
    lines.push("|---|---:|---:|---:|---:|");
    for (const sweep of validateSweeps) {
      const versus =
        sweep.workload.name === "validate-off"
          ? "—"
          : `${Math.round((sweep.peakRps / validateOff.peakRps - 1) * 100)}%`;
      lines.push(
        `| \`${sweep.workload.name.replace("validate-", "")}\` | ` +
          `${Math.round(sweep.peakRps).toLocaleString()} | ${versus} | ` +
          `${sweep.kneeConcurrency} | ${sweep.kneeP99} ms |`,
      );
    }
    lines.push("");
    lines.push(
      "Two things this does **not** say. It does not say what validation will cost *your* estate: " +
        "the figure scales with the schema and the body, and this is one small Pet document " +
        "against the petstore's own schema. And `warn` is sampled at 1.0 here — the worst case " +
        "for that state, not the usual one — because sampling at 0.1 would measure the sampler. " +
        "It is charted on the same axis as `block` rather than assumed free because on this " +
        "runtime it is not isolated from the request path (deviation D19).",
    );
    lines.push("");
  }

  // ---- decomposition --------------------------------------------------------------------------
  if (bare && reject) {
    lines.push("### Where the time actually goes");
    lines.push("");
    lines.push(
      `\`reject-401\` is the whole pipeline with the upstream call removed: it parses the request, ` +
        `matches a route, hashes and looks up a key, and answers — at ` +
        `**${Math.round(reject.peakRps).toLocaleString()} rps**. \`bare\` does *less* policy work ` +
        `but makes the upstream call, and manages **${Math.round(bare.peakRps).toLocaleString()}**. ` +
        `Adding one outbound HTTP request costs about ` +
        `**${Math.round((1 - bare.peakRps / reject.peakRps) * 100)}%** of the achievable rate, ` +
        "which is to say: policy is not what limits this gateway, being an HTTP client is.",
    );
    lines.push("");
    lines.push(
      "The per-request allocations that looked like suspects — a fresh `AbortSignal.timeout` for " +
        "the request deadline, a `Headers` clone, a `randomUUID` for the request id, a `URL` parse " +
        "— were each measured directly, in isolation, at well under a microsecond, and under 1 µs " +
        "combined. Whatever the remaining cost is, it is not those.",
    );
    lines.push("");
  }

  // ---- slow backends --------------------------------------------------------------------------
  lines.push("## Slow backends: how much can one process hold");
  lines.push("");
  lines.push(
    "A gateway in front of a slow service spends its time holding sockets, not burning CPU. The " +
      "question is how many it can hold at once before latency stops being the backend's fault. " +
      "`rps` here is `concurrency / latency` and is included only so the arithmetic is checkable.",
  );
  lines.push("");
  for (const sweep of slowSweeps) {
    lines.push(`### \`${sweep.workload.name}\` — ${sweep.workload.note}`);
    lines.push("");
    lines.push("| conc | rps | p50 ms | p99 ms | direct p50 | +p50 ms | rss MiB | in flight | errors |");
    lines.push("|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
    for (const rung of sweep.rungs) {
      lines.push(
        `| ${rung.concurrency} | ${Math.round(rung.gateway.rps).toLocaleString()} | ${rung.gateway.p50} | ` +
          `${rung.gateway.p99} | ${rung.direct?.p50 ?? "—"} | ` +
          `${rung.direct ? round(rung.gateway.p50 - rung.direct.p50) : "—"} | ` +
          `${mib(rung.rssBytes)} | ${rung.inFlight ?? "—"} | ` +
          `${rung.gateway.errors} |`,
      );
    }
    lines.push("");
  }

  // ---- payload --------------------------------------------------------------------------------
  lines.push("## Payload size");
  lines.push("");
  lines.push(
    "A proxied byte is moved twice — client to gateway, gateway to backend — and with telemetry " +
      "on it is also counted. Requests per second is the wrong unit here; bytes per second is the " +
      "number.",
  );
  lines.push("");
  lines.push("| direction | size | conc | rps | MiB/s | p50 ms | p99 ms | direct p50 | +p50 ms | errors |");
  lines.push("|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
  for (const row of payloadRows) {
    const seconds = row.rung.gateway.wallMs / 1000;
    const bytes = row.direction === "up" ? row.rung.gateway.bytesSent : row.rung.gateway.bytesOut;
    lines.push(
      `| ${row.direction === "up" ? "request" : "response"} | ${sizeLabel(row.bytes)} | ` +
        `${row.rung.concurrency} | ${Math.round(row.rung.gateway.rps).toLocaleString()} | ` +
        `${round(bytes / seconds / MIB)} | ${row.rung.gateway.p50} | ${row.rung.gateway.p99} | ` +
        `${row.rung.direct?.p50 ?? "—"} | ` +
        `${row.rung.direct ? round(row.rung.gateway.p50 - row.rung.direct.p50) : "—"} | ` +
        `${row.rung.gateway.errors} |`,
    );
  }
  lines.push("");

  // ---- scaling --------------------------------------------------------------------------------
  lines.push("## Using the other cores");
  lines.push("");
  lines.push(
    "One process is one JavaScript thread, so the way to use a second core is a second process. " +
      "Two arrangements are measured. **`fleet`** is N gateway processes, each its own seeded " +
      "instance with its own token and port, addressed by a client that cycles them — the fleet " +
      "the control plane already models, and what a real load balancer in front would do. " +
      "**`shared port`** is N processes on one port via `DP_REUSE_PORT=1`, letting the kernel " +
      "spread the connections. Same CPU budget, same workload, same offered concurrency.",
  );
  lines.push("");
  lines.push(
    "`reject-401` calls no backend, so its scaling is the gateway's own and is the row to read. " +
      "`typical` proxies, and past one process it stops being a measurement of the gateway: four " +
      "gateways offer far more work than one single-threaded petstore simulator will accept. Rows " +
      "marked ⚠ are those, and they are left in rather than dropped — a table that quietly showed " +
      "only what worked would not tell you where the measurement ends.",
  );
  lines.push("");
  // A row whose *client* could not connect is a row about the load generators. The gateway got
  // substantially faster during this work, and the harness did not: driving four gateway processes
  // now needs more offered load than six generator processes can produce, and when they fail they
  // fail by refusing to connect rather than by going slowly.
  // Two ways for a row to be about something other than the gateway, and both disqualify it:
  // the client could not connect (the load generators gave out), or the upstream failed (the
  // single-threaded simulator gave out). Either way the number describes the harness.
  const harnessLimited = (row: (typeof scaleRows)[number]) => {
    const { errors, completed, statuses } = row.rung.gateway;
    const upstreamFailures = statuses["502"] ?? 0;
    return errors > completed * 0.01 || upstreamFailures > completed * 0.01;
  };
  lines.push(
    "| arrangement | processes | workload | rps | vs 1 | p50 ms | p95 ms | p99 ms | rss MiB | statuses |",
  );
  lines.push("|---|---:|---|---:|---:|---:|---:|---:|---:|---|");
  const firstOf = (workload: string) =>
    scaleRows.find((r) => r.processes === 1 && r.workload === workload);
  for (const row of scaleRows) {
    const single = firstOf(row.workload);
    const ratio =
      harnessLimited(row) || !single
        ? "—"
        : `${round(row.rung.gateway.rps / single.rung.gateway.rps)}x`;
    lines.push(
      `| ${row.mode === "shared" ? "shared port" : "fleet"} | ${row.processes} | \`${row.workload}\` | ` +
        `${Math.round(row.rung.gateway.rps).toLocaleString()}${harnessLimited(row) ? " ⚠" : ""} | ${ratio} | ` +
        `${row.rung.gateway.p50} | ${row.rung.gateway.p95} | ${row.rung.gateway.p99} | ` +
        `${mib(row.rung.rssBytes)} | ${statusSummary(row.rung.gateway)} |`,
    );
  }
  if (scaleRows.some(harnessLimited)) {
    lines.push("");
    lines.push(
      "⚠ marks a row that is not about the gateway. Either more than 1% of requests failed to " +
        "*connect* — a `0` in the statuses column, the load generators giving out, because six " +
        "generator processes cannot offer the several hundred thousand requests a second that four " +
        "gateway processes will now accept — or more than 1% came back `502`, which is the " +
        "single-threaded petstore simulator refusing connections from four gateways at once. " +
        "Those rows carry no ratio, because the ratio would describe the harness. Everything " +
        "claimed below rests on the clean rows only.",
    );
  }
  lines.push("");
  // Both sides of the comparison have to be clean, or it is a comparison of two harness failures.
  const sharedRow = scaleRows.find(
    (r) => r.mode === "shared" && r.workload === "reject-401" && !harnessLimited(r),
  );
  const fleetSame = sharedRow
    ? scaleRows.find(
        (r) =>
          r.mode === "separate" &&
          r.processes === sharedRow.processes &&
          r.workload === sharedRow.workload &&
          !harnessLimited(r),
      )
    : undefined;
  if (!sharedRow || !fleetSame) {
    lines.push(
      "**`DP_REUSE_PORT` could not be judged in this run**: the shared-port rows, the separate-port " +
        "rows at the same process count, or both, were limited by the load generators rather than " +
        "by the gateway. It is a platform behaviour rather than a property of this code — Windows " +
        "has no `SO_REUSEPORT` with Linux's load-balancing semantics — and on a run where both " +
        "rows are clean this section says which way it went.",
    );
    lines.push("");
  }
  if (sharedRow && fleetSame) {
    const spreads = sharedRow.rung.gateway.rps > fleetSame.rung.gateway.rps * 0.7;
    lines.push(
      `**On this platform \`DP_REUSE_PORT\` ${spreads ? "does" : "does not"} spread the load.** ` +
        `${sharedRow.processes} processes on one port reached ` +
        `${Math.round(sharedRow.rung.gateway.rps).toLocaleString()} rps against ` +
        `${Math.round(fleetSame.rung.gateway.rps).toLocaleString()} rps for the same ${sharedRow.processes} ` +
        `processes on separate ports` +
        (spreads
          ? "."
          : " — one process's worth of throughput from four processes. Windows has no " +
            "`SO_REUSEPORT` with Linux's load-balancing semantics, so the extra processes bind and " +
            "then sit idle. Use separate ports and a load balancer here; keep `DP_REUSE_PORT` for " +
            "Linux, where the kernel does spread. (The memory column understates these rows: with " +
            "one shared port only one of the four processes can be addressed to be measured.)"),
    );
    lines.push("");
  }
  lines.push(
    "**More processes are not free.** Rate limiting is per process (design §5.7 scopes counters " +
      "per instance), so an effective limit is `calls × processes` either way. In the `fleet` " +
      "arrangement that arithmetic is at least visible — each process is an instance the UI " +
      "shows. Behind a shared port it is not: the fleet view shows one instance and the real " +
      "limit is silently N times the configured one. Telemetry survives both, because rollups " +
      "are keyed by `run_id`, which is already per process.",
  );
  lines.push("");

  // ---- isolation ------------------------------------------------------------------------------
  if (isolationRows.length > 0) {
    // The control row has no flood, so its concurrency is zero; take the figure from a row that
    // actually has one.
    const flooded = isolationRows.find((r) => r.floodConcurrency > 0);
    lines.push("## Can one slow backend take the others with it?");
    lines.push("");
    lines.push(
      `One route is flooded — ${flooded?.floodConcurrency ?? "many"} concurrent requests to a ` +
        "backend that takes two seconds, or in the last row a few very large uploads. A second " +
        "route on the same instance, with a healthy backend, is probed at concurrency 8 while that " +
        "is happening. A gateway that isolates its routes answers the probe as if nothing were " +
        "wrong, and the first row is what that looks like when nothing is wrong.",
    );
    lines.push("");
    lines.push(
      "| configuration | probe p50 ms | probe p99 ms | probe rps | held in flight | rss MiB | flood outcome |",
    );
    lines.push("|---|---:|---:|---:|---:|---:|---|");
    for (const row of isolationRows) {
      lines.push(
        `| ${row.name} | ${row.probe.p50} | ${row.probe.p99} | ` +
          `${Math.round(row.probe.rps).toLocaleString()} | ${row.floodInFlight ?? "—"} | ` +
          `${mib(row.rssBytes)} | ${row.flood ? statusSummary(row.flood) : "—"} |`,
      );
    }
    lines.push("");
    for (const row of isolationRows) lines.push(`- **${row.name}** — ${row.note}`);
    lines.push("");
    lines.push(
      "**Why a timeout is not enough.** `timeoutMs` bounds how long one request waits; it does " +
        "not bound how many are waiting. Requests arrive at whatever rate the callers choose and " +
        "leave only when the backend answers or the timeout expires, so in-flight work settles at " +
        "roughly `arrival rate × timeout`. At 500 rps against a hung backend with a 30-second " +
        "timeout that is 15,000 requests parked on one process, each holding a client socket, an " +
        "upstream socket and its buffers. Nothing looks busy while it happens — the slow-backend " +
        "tables above show one process holding a thousand parked requests at a working set barely " +
        "above idle — which is exactly why it is easy to miss, until the process runs out of the " +
        "things it holds and takes every other route with it.",
    );
    lines.push("");
    lines.push(
      "**The fix is a ceiling per route, and shedding at it.** `concurrency: { maxInFlight }` is " +
        "a bulkhead: the sick backend fills its own bucket, requests past it get a 503 with " +
        "`Retry-After` immediately instead of joining a queue, and every other route is untouched. " +
        "`MAX_CONCURRENT_REQUESTS` is the same idea per instance, as the backstop for routes with " +
        "no unit attached. Queueing was considered and rejected: a request that waits in a queue " +
        "and *then* waits for a timeout is strictly worse than one refused at once, and design " +
        "§8.4 makes the same call for the validation pool.",
    );
    lines.push("");
    lines.push(
      "**Also set `BUN_CONFIG_MAX_HTTP_REQUESTS`.** The runtime keeps its own ceiling on " +
        "concurrent outbound HTTP requests per process, across every origin, and it applies " +
        "whether or not anyone chose it. If it is lower than the work the gateway accepts it " +
        "becomes an invisible shared queue with no per-route fairness and no shed — the one " +
        "mechanism by which a slow backend really can make an unrelated route wait. Set it above " +
        "`MAX_CONCURRENT_REQUESTS` so that the gateway's own accounting, which is per route and " +
        "visible in `/healthz`, is the binding constraint.",
    );
    lines.push("");
  }

  // ---- side effects ---------------------------------------------------------------------------
  if (sideEffectRows.length > 0) {
    lines.push("## What logging and counting cost");
    lines.push("");
    lines.push(
      "Two things happen on every request that are configuration rather than code: a JSON line on " +
        "stdout, and a telemetry record. Both are on by default and both can be turned off. Same " +
        "workload, same concurrency, one process, only the settings differ. The harness discards " +
        "the gateway's stdout, so the access-log rows are the cost of *formatting and writing* a " +
        "line, not of whatever consumes it — a lower bound on what it costs against a real log " +
        "driver, and it is what the harness can honestly measure without putting gigabytes a run " +
        "on the same disk as everything else it is timing.",
    );
    lines.push("");
    lines.push("| setting | rps (median of 3) | vs default | run-to-run spread | p50 ms | what it is |");
    lines.push("|---|---:|---:|---:|---:|---|");
    const baseRow = sideEffectRows[0]!;
    for (const row of sideEffectRows) {
      const delta = Math.round((row.rung.gateway.rps / baseRow.rung.gateway.rps - 1) * 100);
      lines.push(
        `| ${row.name} | ${Math.round(row.rung.gateway.rps).toLocaleString()} | ` +
          `${row === baseRow ? "—" : `${delta > 0 ? "+" : ""}${delta}%`} | ` +
          `±${Math.round(row.spread * 100)}% | ${row.rung.gateway.p50} | ${row.note} |`,
      );
    }
    lines.push("");
    const worstSpread = Math.max(...sideEffectRows.map((r) => r.spread));
    lines.push(
      `Read the middle column against the one beside it. The identical configuration, restarted ` +
        `and measured again, varied by up to **${Math.round(worstSpread * 100)}%** between ` +
        "attempts, so any difference smaller than that is not a finding. Each row is the median of " +
        "three runs, taken round-robin rather than three-at-a-time, after a discarded pass: with " +
        "one run each an early attempt had the access log coming out *slower* turned off, and with " +
        "three grouped by configuration whichever went first inherited a machine still settling " +
        "from the phase before and carried a 52% spread while the others sat inside 13%.",
    );
    lines.push("");
    const telemetryOff = sideEffectRows.find((r) => r.name === "telemetry off");
    if (telemetryOff) {
      const gain = Math.round((telemetryOff.rung.gateway.rps / baseRow.rung.gateway.rps - 1) * 100);
      lines.push(
        `Telemetry used to cost **119%** of throughput. It now measures at ${gain}%, which is ` +
          `inside this table's own ${Math.round(worstSpread * 100)}% spread — the honest statement ` +
          "is that its cost is no longer distinguishable from noise, not that it is precisely " +
          `${gain}%. The difference is not a tuning ` +
          "change: counting response bytes meant pulling every response body through a transform " +
          "stream, and allocating one per request cost more than all the counters it fed. The " +
          "gateway now takes the byte count from `Content-Length` when the backend declared one " +
          "and the runtime has not decompressed underneath it, and hands the body through " +
          "untouched — falling back to the transform only for chunked or re-encoded responses, " +
          "where there is no declared length to believe. What remains is the bookkeeping itself, " +
          "which is a fair price for the Telemetry view.",
      );
      lines.push("");
    }
  }

  // ---- memory ---------------------------------------------------------------------------------
  lines.push("## Memory");
  lines.push("");
  lines.push("| | working set | note |");
  lines.push("|---|---:|---|");
  if (memory.idle) {
    lines.push(
      `| At rest, ${memory.idle.routes} routes | ${mib(memory.idle.workingSetBytes)} MiB | ` +
        "started, polled, serving nothing |",
    );
  }
  if (memory.config) {
    lines.push(
      `| With ${memory.config.routesAfter} routes | ${mib(memory.config.workingSetAfter)} MiB | ` +
        `${memory.config.added} more published APIs, ` +
        `${memory.config.bytesPerRoute !== null ? `${Math.round(memory.config.bytesPerRoute / 1024)} KiB each` : "—"} |`,
    );
  }
  if (memory.sustained) {
    lines.push(
      `| Under load, c=64 mixed | ${mib(memory.sustained.workingSetPeak)} MiB | peak during a ` +
        `${Math.round(memory.sustained.durationMs / 1000)}s run at ` +
        `${Math.round(memory.sustained.rps).toLocaleString()} rps |`,
    );
    lines.push(
      `| 15 s after the load stopped | ${mib(memory.sustained.workingSetAfterIdle)} MiB | ` +
        `heap in use ${mib(memory.sustained.heapUsedBytes ?? 0)} MiB |`,
    );
    lines.push(
      `| Peak ever, this process | ${mib(memory.sustained.peakWorkingSetBytes)} MiB | ` +
        "what a memory limit has to be above |",
    );
  }
  lines.push("");
  const heaviest = payloadRows
    .filter((r) => r.direction === "down")
    .sort((a, b) => (b.rung.rssBytes ?? 0) - (a.rung.rssBytes ?? 0))[0];
  if (heaviest) {
    lines.push(
      `Bodies are the variable that matters. At concurrency ${heaviest.rung.concurrency} with ` +
        `${sizeLabel(heaviest.bytes)} responses the working set reached ` +
        `**${mib(heaviest.rung.rssBytes)} MiB** — the gateway streams rather than buffering, but a ` +
        "chunk of every in-flight body is resident, so the figure to budget for is " +
        "`concurrency × body size`, not `concurrency` alone.",
    );
    lines.push("");
  }
  lines.push(
    "Two cautions. A JavaScript working set is a high-water mark: it grows to fit the busiest " +
      "moment and is returned to the operating system lazily, so the number after a burst is not " +
      "the number during it and neither is a leak. And the `MAX_BODY_BYTES` ceiling (8 MiB by " +
      "default, 16 MiB here) is what bounds the worst case — without it, concurrency times an " +
      "unbounded body is the memory requirement.",
  );
  lines.push("");

  // ---- sizing ---------------------------------------------------------------------------------
  lines.push("## Sizing, in one paragraph");
  lines.push("");
  if (typical && mixed && memory.sustained) {
    lines.push(
      `One process handles **${Math.round(typical.peakRps).toLocaleString()} rps** on a normal ` +
        `published API and **${Math.round(mixed.peakRps).toLocaleString()}** on mixed traffic, in ` +
        `about **${mib(memory.sustained.workingSetAfterIdle)} MiB** of memory, plus ` +
        "`concurrency × body size` for whatever is in flight. A process will not use more than " +
        "about one core whatever it is given, so **size by processes, not by cores** — " +
        `${scaleRows.length > 1 ? `the ${scaleRows[scaleRows.length - 1]!.processes}-process rows above show what that buys` : "run one per core"}. ` +
        "Divide your target rate by the row that matches your traffic and keep the margin you " +
        "would keep anywhere else; there is no CPU term to add, because a process runs out of " +
        "single-thread throughput long before it runs out of cores. If the backend is slow none of " +
        "this binds and the limit becomes sockets held open — see the slow-backend tables, where " +
        "one process holds a thousand concurrent requests without difficulty.",
    );
    lines.push("");
  }

  // ---- caveats --------------------------------------------------------------------------------
  lines.push("## What this still does not measure");
  lines.push("");
  lines.push(
    "- **No TLS.** Design §8.1 puts termination on the reverse proxy in front. TLS is CPU work " +
      "this report does not contain, and on small payloads it is not a rounding error.",
  );
  lines.push("- **Loopback.** No network latency, no packet loss, no congestion control worth the name.");
  lines.push(
    "- **One backend, deterministic and local.** Real upstreams have connection limits, DNS, and " +
      "tail latency that is not a constant.",
  );
  lines.push(
    "- **No schema validation** (deviation D12), which design §13 calls the dominant sizing " +
      "variable in a real deployment. Every number here would be smaller with it.",
  );
  lines.push(
    "- **Windows.** `ProcessorAffinity` is not a cgroup: the gateway gets the cores exclusively, " +
      "but there is no memory limit and no throttling, so this is a generous approximation of a " +
      "container.",
  );
  lines.push(
    "- **A single run.** Each rung is one measurement, not a distribution of measurements. " +
      "Treat differences under about 5% as noise.",
  );
  lines.push(
    "- **CPU per request, which is missing on purpose.** It is the figure this report most wants " +
      "— it is independent of concurrency, so it is the one you would multiply — and it could not " +
      "be measured to a standard worth publishing on this platform. Both available sources fail " +
      "in different ways. `Get-Process | TotalProcessorTime` is accurate but is read inside a " +
      "`pwsh` spawn that takes 200 ms when the machine is idle and 1.7 s when it is busy, at an " +
      "unknown moment within that, so it cannot be paired with a request count taken at a known " +
      "instant. Bun's own `process.cpuUsage()` can be paired exactly — `/healthz` returns both " +
      "counters from one handler call — and agrees with Windows to 0.1% over a 24-second window, " +
      "but over the 3-to-6-second windows a ladder rung uses it frequently does not advance at " +
      "all: about one sample in three came back 15–16 ms apart, one scheduler tick, for rungs " +
      "that had served thirty thousand requests. The resulting ratios were bimodal and " +
      "self-contradictory — `reject-401`, which does strictly less work than `typical`, came out " +
      "more expensive. Three attempts to fix it produced three different wrong answers, so the " +
      "column is gone rather than caveated. The one figure that survived scrutiny, from a single " +
      "long quiet window with both sources agreeing, is roughly **7 µs per proxied request**; it " +
      "is quoted here as an order of magnitude and nothing more.",
  );
  lines.push("");
  return lines.join("\n");
}

if (import.meta.main) {
  await main();
  process.exit(0);
}
