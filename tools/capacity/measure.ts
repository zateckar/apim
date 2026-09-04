import { availableParallelism } from "node:os";
import type { RunResult, Target } from "../loadgen/runner.ts";
import type { CoreLayout } from "./world.ts";

/**
 * One instant, from the two sources that each know something the other does not.
 *
 * **CPU comes from Windows, not from the process.** `process.cpuUsage()` under Bun on Windows
 * reports roughly a third of what `Get-Process | TotalProcessorTime` reports for the same
 * interval — it appears to account for the JavaScript thread and not the whole process, and a
 * proxy spends a lot of its time in socket work off that thread. Using it would have understated
 * every CPU figure in this report by 3×.
 *
 * **Requests served comes from the process**, because Windows cannot know it, and it is the
 * denominator that makes the CPU figure independent of how well the sampling window lines up with
 * the measured one.
 *
 * Either half may be missing — a `pwsh` spawn under load occasionally returns nothing — and a
 * missing half is `null`, never zero. Zero is indistinguishable from "idle" in a CPU column.
 */
export interface ProcessSample {
  atMs: number;
  /** Process-wide CPU, all threads, from Windows. Null when the spawn did not answer. */
  cpuMs: number | null;
  /** The same quantity as the processes themselves report it, via `process.cpuUsage()`. */
  cpuMsSelf: number | null;
  workingSetBytes: number | null;
  privateBytes: number | null;
  peakWorkingSetBytes: number | null;
  /** Requests answered, self-reported, whether or not telemetry is counting. */
  served: number | null;
  inFlight: number | null;
}

async function fromGateways(urls: string[]): Promise<{
  served: number | null;
  inFlight: number | null;
  rss: number | null;
  cpuMsSelf: number | null;
}> {
  const bodies = await Promise.all(
    urls.map(async (url) => {
      try {
        const response = await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(5000) });
        return (await response.json()) as any;
      } catch {
        return null;
      }
    }),
  );
  // In shared-port mode only one process can be addressed, so a partial answer is expected there;
  // it is the caller that decides whether a partial sample is usable.
  const seen = bodies.filter(Boolean);
  if (seen.length !== urls.length) {
    return { served: null, inFlight: null, rss: null, cpuMsSelf: null };
  }
  const sum = (pick: (body: any) => number) =>
    seen.reduce((total, body) => total + (pick(body) || 0), 0);
  return {
    served: sum((b) => b.process?.served),
    inFlight: sum((b) => b.process?.inFlight),
    rss: sum((b) => b.process?.rssBytes),
    cpuMsSelf: sum((b) => b.process?.cpuUserMs) + sum((b) => b.process?.cpuSystemMs),
  };
}

function fromWindows(pids: number[]): {
  cpuMs: number | null;
  workingSetBytes: number | null;
  privateBytes: number | null;
  peakWorkingSetBytes: number | null;
} {
  const run = () =>
    Bun.spawnSync([
      "pwsh",
      "-NoProfile",
      "-Command",
      `Get-Process -Id ${pids.join(",")} -ErrorAction SilentlyContinue | ForEach-Object { ` +
        `[pscustomobject]@{ cpu = $_.TotalProcessorTime.TotalMilliseconds; ws = $_.WorkingSet64; ` +
        `pb = $_.PrivateMemorySize64; peak = $_.PeakWorkingSet64 } } | ConvertTo-Json -AsArray -Compress`,
    ]);
  let rows: Array<{ cpu: number; ws: number; pb: number; peak: number }> = [];
  const complete = (candidate: typeof rows) =>
    candidate.length === pids.length &&
    candidate.every((r) => [r.cpu, r.ws, r.pb, r.peak].every((v) => typeof v === "number" && Number.isFinite(v)));
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const text = run().stdout.toString().trim();
      if (!text) continue;
      rows = JSON.parse(text);
      if (complete(rows)) break;
    } catch {
      rows = [];
    }
  }
  // A short sample means a process did not answer. A *complete* sample with a null field is worse:
  // `TotalProcessorTime` is intermittently unavailable, and summing `null` as zero produced a
  // 0 ms CPU delta that looked exactly like an idle gateway. Either way, unknown.
  if (!complete(rows)) {
    return { cpuMs: null, workingSetBytes: null, privateBytes: null, peakWorkingSetBytes: null };
  }
  return {
    cpuMs: rows.reduce((sum, r) => sum + r.cpu, 0),
    workingSetBytes: rows.reduce((sum, r) => sum + r.ws, 0),
    privateBytes: rows.reduce((sum, r) => sum + r.pb, 0),
    peakWorkingSetBytes: rows.reduce((sum, r) => sum + r.peak, 0),
  };
}

/**
 * One HTTP read per gateway, and nothing else on the measurement path.
 *
 * This used to take CPU from Windows via `Get-Process`, on the belief that Bun's
 * `process.cpuUsage()` under-reported. Measured over a single clean 24-second window, the two
 * agree to **0.1%** — the earlier belief came from comparing intervals that were not the same
 * interval. What was actually wrong was the pairing: `pwsh` takes 200 ms to start when the machine
 * is idle and up to 1.7 s when it is busy, and the reading it returns is taken at an unknown
 * moment inside that. So "CPU" and "requests served" were captured up to a second and a half
 * apart, by a margin that varied with load, and their ratio was wrong in whichever direction the
 * skew happened to fall. That produced 60–80 µs per request where the truth is about 7, and
 * occasional zeroes.
 *
 * `/healthz` returns both counters from the same handler invocation. There is no window to
 * misalign. Windows is still asked for private and peak bytes in the memory phase, where nothing
 * is under load and no pairing is involved.
 */
export async function sampleAll(_pids: number[], urls: string[]): Promise<ProcessSample> {
  const gateways = await fromGateways(urls);
  return {
    atMs: Date.now(),
    cpuMs: gateways.cpuMsSelf,
    cpuMsSelf: gateways.cpuMsSelf,
    workingSetBytes: gateways.rss,
    privateBytes: null,
    peakWorkingSetBytes: null,
    served: gateways.served,
    inFlight: gateways.inFlight,
  };
}

/** Windows only, for when nothing is under load and no gateway needs to be asked. */
export function sampleProcesses(pids: number[]): ProcessSample {
  const windows = fromWindows(pids);
  return { atMs: Date.now(), ...windows, cpuMsSelf: null, served: null, inFlight: null };
}

/**
 * CPU milliseconds the gateways spent per request they answered.
 *
 * Per *request*, not per second of wall clock, and deliberately so. Utilisation needs the sampling
 * window and the measured window to be the same window, and they are only approximately the same:
 * the workers synchronise on a clock the parent set, warm-up can overrun, and the last request in
 * flight outlives the deadline. Dividing by the gateways' own request count cancels all of it —
 * whatever traffic happened between the two samples, its CPU is divided by exactly the requests it
 * consisted of.
 */
export function cpuPerRequestMs(
  before: ProcessSample,
  after: ProcessSample,
  source: "os" | "self" = "os",
): number | null {
  const beforeCpu = source === "os" ? before.cpuMs : before.cpuMsSelf;
  const afterCpu = source === "os" ? after.cpuMs : after.cpuMsSelf;
  if (beforeCpu === null || afterCpu === null) return null;
  if (before.served === null || after.served === null) return null;
  const requests = after.served - before.served;
  const cpuMs = afterCpu - beforeCpu;
  if (requests <= 0 || cpuMs < 0) return null;
  return cpuMs / requests;
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[index]!;
}

const round = (n: number) => Math.round(n * 100) / 100;

/**
 * Merge the results of the load-generating processes into one.
 *
 * Percentiles are the reason the workers return samples at all: p95 of a union is not any
 * function of the p95s of its parts. Each worker's samples are re-thinned in proportion to how
 * much of the work it actually did, so a worker that completed twice as many requests contributes
 * twice the weight.
 */
export function mergeWorkers(results: RunResult[]): RunResult {
  if (results.length === 1) return results[0]!;
  const completed = results.reduce((sum, r) => sum + r.completed, 0);
  const wallMs = Math.max(...results.map((r) => r.wallMs));
  const statuses: Record<string, number> = {};
  for (const result of results) {
    for (const [status, count] of Object.entries(result.statuses)) {
      statuses[status] = (statuses[status] ?? 0) + count;
    }
  }

  const budget = 50_000;
  const merged: number[] = [];
  for (const result of results) {
    const samples = result.samples ?? [];
    if (samples.length === 0) continue;
    const want = Math.max(1, Math.round((budget * result.completed) / Math.max(1, completed)));
    const stride = samples.length / Math.min(want, samples.length);
    for (let i = 0; i < Math.min(want, samples.length); i++) {
      merged.push(samples[Math.min(samples.length - 1, Math.floor(i * stride))]!);
    }
  }
  merged.sort((a, b) => a - b);

  return {
    completed,
    errors: results.reduce((sum, r) => sum + r.errors, 0),
    rps: round((completed / wallMs) * 1000),
    concurrency: results.reduce((sum, r) => sum + r.concurrency, 0),
    bytesSent: results.reduce((sum, r) => sum + r.bytesSent, 0),
    p50: round(quantile(merged, 0.5)),
    p90: round(quantile(merged, 0.9)),
    p95: round(quantile(merged, 0.95)),
    p99: round(quantile(merged, 0.99)),
    min: round(Math.min(...results.map((r) => r.min))),
    max: round(Math.max(...results.map((r) => r.max))),
    mean: round(
      results.reduce((sum, r) => sum + r.mean * r.completed, 0) / Math.max(1, completed),
    ),
    statuses,
    bytesOut: results.reduce((sum, r) => sum + r.bytesOut, 0),
    wallMs: round(wallMs),
    samples: merged,
  };
}

export interface LoadOptions {
  concurrency: number;
  durationMs: number;
  /** Full-concurrency traffic run and discarded before the measured window opens. */
  warmupMs: number;
  /** Load-generating processes. Concurrency is split between them as evenly as it divides. */
  workers: number;
}

export interface LoadOutcome {
  result: RunResult;
  before: ProcessSample;
  after: ProcessSample;
  /** 1.0 = the whole CPU budget was busy for the whole step. Null when the sample was incomplete. */
  cpu: number | null;
  /** Microseconds of gateway CPU per request served — the figure to multiply when sizing. */
  cpuMicrosPerRequest: number | null;
  /** The same, as the process reports it about itself. Kept so the two can be compared. */
  cpuMicrosPerRequestSelf: number | null;
  /** Which source `cpuMicrosPerRequest` came from, so a fallback is never invisible. */
  cpuSource: "os" | "self" | null;
  deltaCpuMs: number | null;
  deltaServed: number | null;
  /** Sampled halfway through the window, when it is what the processes are actually holding. */
  inFlight: number | null;
}

/**
 * Run one step: N worker processes, a synchronised start, and a CPU/memory sample either side of
 * the measurement window.
 */
export async function runLoad(
  targets: Target[],
  options: LoadOptions,
  gateway: { pids: number[]; urls: string[] },
  cores: number,
): Promise<LoadOutcome> {
  const take = () => sampleAll(gateway.pids, gateway.urls);
  const workers = Math.max(1, Math.min(options.workers, options.concurrency));
  const share = Math.floor(options.concurrency / workers);
  const remainder = options.concurrency - share * workers;
  // The barrier: spawn, warm up at full concurrency, then all workers begin measuring at the same
  // instant. Without it a 6-worker step would have its first worker measuring alone.
  const startAtMs = Date.now() + 900 + options.warmupMs;

  const procs = Array.from({ length: workers }, (_, index) => {
    const job = {
      targets,
      concurrency: share + (index < remainder ? 1 : 0),
      durationMs: options.durationMs,
      warmupMs: options.warmupMs,
      keepSamples: 50_000,
      startAtMs,
    };
    // Workers inherit this process's affinity mask, which is the harness mask: a generator that
    // ran on the gateway's cores would report the harness's own cost as the gateway's limit.
    return Bun.spawn([process.execPath, "tools/capacity/worker.ts"], {
      stdin: new TextEncoder().encode(JSON.stringify(job)),
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, NODE_ENV: "production" },
    });
  });

  // Sample at the barrier, so the CPU window and the measured window are the same window.
  await Bun.sleep(Math.max(0, startAtMs - Date.now()) + 100);
  const before = await take();
  // HTTP only, deliberately: `take()` also runs a blocking `pwsh` spawn, and blocking the event
  // loop around an in-flight probe is a good way to measure the probe instead of the gateway.
  let mid: { inFlight: number | null } | null = null;
  const midProbe = setTimeout(
    () => void fromGateways(gateway.urls).then((sample) => (mid = sample)),
    Math.round(options.durationMs / 2),
  );
  // Closing the CPU window when the *measurement* ends, not when the last worker has been
  // reaped and its output parsed: those seconds are idle for the gateway and would deflate every
  // CPU figure in the report.
  let atEnd: ProcessSample | null = null;
  const endProbe = setTimeout(() => void take().then((sample) => (atEnd = sample)), options.durationMs + 50);

  const outputs = await Promise.all(
    procs.map(async (proc) => {
      const [out, err, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      if (code !== 0 || !out.trim()) {
        throw new Error(`load worker exited ${code}: ${err.slice(0, 500) || "no output"}`);
      }
      return JSON.parse(out) as RunResult;
    }),
  );
  clearTimeout(midProbe);
  clearTimeout(endProbe);
  const after: ProcessSample = atEnd ?? (await take());
  const result = mergeWorkers(outputs);
  const perRequestMs = cpuPerRequestMs(before, after, "os");
  const perRequestSelfMs = cpuPerRequestMs(before, after, "self");
  const effective = perRequestMs;

  return {
    result,
    before,
    after,
    // Utilisation derived from the per-request cost and the throughput actually achieved, rather
    // than from a wall-clock window that only approximately lines up with the measurement.
    cpu: effective === null ? null : round(((effective * result.rps) / 1000 / cores) * 100) / 100,
    cpuMicrosPerRequest: effective === null ? null : Math.round(effective * 1000),
    cpuMicrosPerRequestSelf: perRequestSelfMs === null ? null : Math.round(perRequestSelfMs * 1000),
    cpuSource: perRequestMs !== null ? "os" : null,
    // The raw pair the ratio is built from, so a suspect ratio can be diagnosed rather than argued
    // about: which of the two is wrong is not deducible from their quotient.
    deltaCpuMs: before.cpuMs !== null && after.cpuMs !== null ? after.cpuMs - before.cpuMs : null,
    deltaServed:
      before.served !== null && after.served !== null ? after.served - before.served : null,
    inFlight: (mid as { inFlight: number | null } | null)?.inFlight ?? null,
  };
}

/** How many load-generating processes to use, given the cores the harness is allowed. */
export function workerCount(layout: CoreLayout): number {
  return Math.max(2, Math.min(6, Math.floor(layout.harnessCores.length / 2), availableParallelism()));
}
