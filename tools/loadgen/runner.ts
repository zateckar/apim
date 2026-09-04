/**
 * The measurement engine (plan G6).
 *
 * One rule shapes everything here: the reported number is the **difference** between the same
 * work done through the gateway and done straight to the backend, in the same run. Absolute
 * throughput on a developer laptop measures the laptop.
 */
export interface Target {
  base: string;
  path: string;
  method: string;
  headers: Record<string, string>;
  bodyBytes: number;
  /** Sent verbatim when set, for scenarios whose body has to be a real document (SOAP). */
  rawBody?: string;
}

export interface RunOptions {
  concurrency: number;
  durationMs: number;
  /** Requests to run and discard before measuring, so JIT warm-up is not in the numbers. */
  warmup: number;
  /**
   * Return the raw latency samples. The capacity harness spreads one measurement over several
   * load-generating processes and has to merge their percentiles, which cannot be done from
   * summaries — p95 of a set is not any function of the p95s of its parts.
   */
  keepSamples?: number;
}

export interface RunResult {
  completed: number;
  errors: number;
  /**
   * Requests per second. For a latency-bound scenario this is `concurrency / latency` and says
   * nothing about capacity, which is why `concurrency` travels beside it everywhere it is shown.
   */
  rps: number;
  concurrency: number;
  /** Bytes of request body sent, so a size scenario can be read as throughput. */
  bytesSent: number;
  p50: number;
  p90: number;
  p95: number;
  p99: number;
  min: number;
  max: number;
  mean: number;
  statuses: Record<string, number>;
  bytesOut: number;
  wallMs: number;
  /** Present only when `keepSamples` asked for them; capped, and a uniform sample when capped. */
  samples?: number[];
}

function body(bytes: number): string | undefined {
  if (bytes <= 0) return undefined;
  return JSON.stringify({ name: "load", pad: "x".repeat(Math.max(0, bytes - 24)) });
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[index]!;
}

/**
 * Systematic sampling of the order statistics: take every k-th element of the *sorted* array.
 * Unlike a reservoir this is deterministic, and it preserves every quantile to within 1/cap —
 * which is the only property the merged percentiles need.
 */
function thin(sorted: number[], cap: number): number[] {
  if (sorted.length <= cap) return sorted;
  const stride = sorted.length / cap;
  const out: number[] = [];
  for (let i = 0; i < cap; i++) out.push(sorted[Math.min(sorted.length - 1, Math.floor(i * stride))]!);
  return out;
}

/**
 * A single target, or a list cycled request by request. The list is how a "mixed traffic" workload
 * is expressed: one connection pool, one set of workers, several shapes of request interleaved,
 * which is what a real gateway sees and what a single-shape benchmark never shows.
 */
export async function runTarget(
  target: Target | Target[],
  options: RunOptions,
): Promise<RunResult> {
  const variants = (Array.isArray(target) ? target : [target]).map((t) => {
    const payload = t.rawBody ?? body(t.bodyBytes);
    const headers = { ...t.headers };
    if (payload && !headers["content-type"]) headers["content-type"] = "application/json";
    return { url: `${t.base}${t.path}`, method: t.method, headers, payload };
  });
  const payloadBytesOf = variants.map((v) => (v.payload ? Buffer.byteLength(v.payload, "utf8") : 0));
  let cursor = 0;

  const once = async (): Promise<{ ms: number; status: number; bytes: number; ok: boolean; sent: number }> => {
    const index = variants.length === 1 ? 0 : cursor++ % variants.length;
    const variant = variants[index]!;
    const started = performance.now();
    try {
      const response = await fetch(variant.url, {
        method: variant.method,
        headers: variant.headers,
        body: variant.payload,
      });
      // The body must be drained, or the gateway's byte counting and the client's timing both
      // stop at the headers and the number means nothing.
      const text = await response.arrayBuffer();
      return {
        ms: performance.now() - started,
        status: response.status,
        bytes: text.byteLength,
        ok: true,
        sent: payloadBytesOf[index]!,
      };
    } catch {
      return { ms: performance.now() - started, status: 0, bytes: 0, ok: false, sent: 0 };
    }
  };

  for (let i = 0; i < options.warmup; i++) await once();

  const samples: number[] = [];
  const statuses: Record<string, number> = {};
  let errors = 0;
  let bytesOut = 0;
  let bytesSent = 0;
  const deadline = performance.now() + options.durationMs;
  const startedAt = performance.now();

  const worker = async (): Promise<void> => {
    while (performance.now() < deadline) {
      const result = await once();
      samples.push(result.ms);
      bytesOut += result.bytes;
      bytesSent += result.sent;
      const key = String(result.status);
      statuses[key] = (statuses[key] ?? 0) + 1;
      if (!result.ok) errors++;
    }
  };

  await Promise.all(Array.from({ length: options.concurrency }, () => worker()));
  const wallMs = performance.now() - startedAt;

  const sorted = [...samples].sort((a, b) => a - b);
  const round = (n: number) => Math.round(n * 100) / 100;
  return {
    completed: samples.length,
    errors,
    rps: round((samples.length / wallMs) * 1000),
    concurrency: options.concurrency,
    bytesSent,
    p50: round(quantile(sorted, 0.5)),
    p90: round(quantile(sorted, 0.9)),
    p95: round(quantile(sorted, 0.95)),
    p99: round(quantile(sorted, 0.99)),
    min: round(sorted[0] ?? 0),
    max: round(sorted[sorted.length - 1] ?? 0),
    mean: round(samples.reduce((sum, n) => sum + n, 0) / Math.max(1, samples.length)),
    statuses,
    bytesOut,
    wallMs: round(wallMs),
    ...(options.keepSamples ? { samples: thin(sorted, options.keepSamples) } : {}),
  };
}
