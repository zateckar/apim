import { runTarget, type RunResult, type Target } from "../loadgen/runner.ts";

/**
 * One load-generating process.
 *
 * It exists because a single Bun process cannot both generate and absorb load: `fetch` response
 * handling, TLS-less socket reads and JSON parsing all run on the same JavaScript thread as
 * everything else in that process. A generator that saturates before the gateway does is not
 * measuring the gateway, it is measuring itself — so the orchestrator starts several of these,
 * splits the concurrency between them, and merges the results.
 *
 * The job arrives as JSON on stdin, one line; the result leaves as JSON on stdout, one line.
 */
export interface Job {
  targets: Target[];
  concurrency: number;
  durationMs: number;
  /** Traffic at full concurrency, discarded: JIT, connection pool, and the gateway's own warm-up. */
  warmupMs: number;
  keepSamples: number;
  /** Wall clock at which every worker starts measuring, so they measure the same window. */
  startAtMs?: number;
}

async function main(): Promise<void> {
  const input = await Bun.stdin.text();
  const job = JSON.parse(input) as Job;
  const targets = job.targets.length === 1 ? job.targets[0]! : job.targets;
  const shared = { concurrency: job.concurrency, warmup: 0 };

  if (job.warmupMs > 0) {
    await runTarget(targets, { ...shared, durationMs: job.warmupMs });
  }
  if (job.startAtMs) {
    const wait = job.startAtMs - Date.now();
    if (wait > 0) await Bun.sleep(wait);
  }

  const result: RunResult = await runTarget(targets, {
    ...shared,
    durationMs: job.durationMs,
    keepSamples: job.keepSamples,
  });
  process.stdout.write(JSON.stringify(result));
}

if (import.meta.main) {
  await main();
  process.exit(0);
}
