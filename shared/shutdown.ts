/**
 * Orderly shutdown, for both planes.
 *
 * This exists because of a rule about PID 1 that is easy to be bitten by twice. A container's main
 * process *is* PID 1, and Linux does not deliver a signal to PID 1 when that process has installed
 * no handler for it — the default disposition is suppressed for init, on the theory that a kernel
 * killing init is worse than a signal going nowhere. So a Bun process that never calls
 * `process.on("SIGTERM")` does not die on `docker stop` or `podman stop`: the runtime waits out the
 * whole grace period and sends SIGKILL.
 *
 * That is exactly what both planes did until this module existed. Measured on the alpha deployment:
 *
 *     podman stop -t 30 apim-gateway
 *     StopSignal SIGTERM failed to stop container in 30 seconds, resorting to SIGKILL
 *
 * with `/proc/1/exe -> /usr/local/bin/bun` (so the base image's entrypoint does `exec`, and the
 * signal had nowhere else to be lost) and `SigCgt: 00000000200004f8` — bit 14 clear, meaning no
 * SIGTERM handler. Every restart was therefore the hard-kill case the access log's own comment
 * describes as the thing a buffer costs you, and the estate lost the unflushed tail of a compliance
 * log on every deploy.
 *
 * The fix is only ever "install a handler". It is **not** `--init` or a `STOPSIGNAL` change: the
 * stop signal was already SIGTERM and there is no shell between the runtime and the signal. An init
 * process would work by putting something else at PID 1 to forward the signal, which is a second
 * process to reason about in place of one line of code.
 *
 * Two properties beyond catching the signal, both of which are the point rather than defensiveness:
 *
 *  - **The wind-down is bounded.** A shutdown that hangs is the same outage as no handler at all —
 *    the container still sits there until the runtime kills it — except now it looks handled. Past
 *    the grace period the process exits anyway, and says that it did.
 *  - **A second signal exits immediately.** Somebody pressing Ctrl-C twice means it, and an
 *    operator who has to wait out a grace period they are already trying to skip learns to reach
 *    for `kill -9`, which is the habit this is trying to remove.
 */

export type ShutdownSignal = "SIGTERM" | "SIGINT";

/**
 * Comfortably inside the ten seconds a container runtime gives by default, so the process is gone
 * before the runtime's own patience runs out and the exit stays ours rather than becoming a kill.
 */
export const DEFAULT_GRACE_MS = 8_000;

export interface ShutdownOptions {
  /** How long the wind-down gets before the process exits regardless. */
  graceMs?: number;
  signals?: readonly ShutdownSignal[];
  log?: (message: string) => void;
  /** Injected by the tests, which must observe the exit rather than perform it. */
  exit?: (code: number) => void;
}

/**
 * Run `wind` on SIGTERM or SIGINT, once, then exit. Returns a disposer that removes the listeners,
 * which is what lets a test install this without owning the process.
 */
export function onShutdown(
  name: string,
  wind: () => void | Promise<void>,
  options: ShutdownOptions = {},
): () => void {
  const graceMs = options.graceMs ?? DEFAULT_GRACE_MS;
  const signals = options.signals ?? (["SIGTERM", "SIGINT"] as const);
  const log = options.log ?? ((message: string) => console.log(message));
  const exit = options.exit ?? ((code: number) => process.exit(code));

  let winding = false;

  const handle = (signal: ShutdownSignal): void => {
    if (winding) {
      log(`[${name}] ${signal} again — exiting now, without finishing`);
      exit(1);
      return;
    }
    winding = true;
    log(`[${name}] ${signal} — winding down`);

    let settled = false;
    const deadline = setTimeout(() => {
      if (settled) return;
      settled = true;
      log(`[${name}] wind-down did not finish within ${graceMs}ms — exiting anyway`);
      exit(1);
    }, graceMs);
    // The timer must not be the reason the process is still alive once the wind-down has finished.
    deadline.unref?.();

    void (async () => {
      let code = 0;
      try {
        await wind();
      } catch (err) {
        // Reported rather than rethrown: an unhandled rejection here would exit with a stack and
        // no explanation, and whatever the wind-down did manage to do would go unsaid.
        code = 1;
        log(`[${name}] wind-down failed: ${(err as Error).message}`);
      }
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      log(`[${name}] stopped`);
      exit(code);
    })();
  };

  const installed = signals.map((signal) => {
    const listener = () => handle(signal);
    process.on(signal, listener);
    return { signal, listener };
  });

  return () => {
    for (const { signal, listener } of installed) process.off(signal, listener);
  };
}

/**
 * Stop accepting new connections, and wait only so long for the ones in flight.
 *
 * Unbounded is wrong for both planes, and for the gateway it is wrong in a way that costs exactly
 * what this whole module is here to protect: a WebSocket or SSE passthrough is allowed to stay open
 * for as long as its own ceilings permit, so awaiting a graceful stop would routinely reach the
 * deadline — and the access log's final flush, which comes after this, would never run.
 */
export async function drain(
  server: { stop(closeActiveConnections?: boolean): void | Promise<void> },
  drainMs: number,
): Promise<void> {
  await Promise.race([Promise.resolve(server.stop()), Bun.sleep(drainMs)]);
}

/** Long enough for an ordinary request to finish, short enough to leave the flush room. */
export const DEFAULT_DRAIN_MS = 3_000;
