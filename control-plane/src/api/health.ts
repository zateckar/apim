import { badRequest, json, requireUser, Router, type App, type Ctx } from "../router.ts";
import {
  createSynthetics,
  SYNTHETICS_RANGE_KEYS,
  type SyntheticsProvider,
  type SyntheticsRange,
} from "../synthetics.ts";
import { UptimeMonitor } from "../uptime.ts";

/**
 * What the Health screen reads.
 *
 * Both endpoints are `session` rather than public, and deliberately. A component matrix names the
 * estate's gateways, its log cluster and its external systems, with error text attached; an uptime
 * strip says when each of them was down. That is a map of what to attack and when it is weakest,
 * and it is not information a signed-out caller needs.
 *
 * Neither endpoint probes anything on the request path. `uptime` reads the monitor's latest
 * results, and `synthetics` reads an index. A screen somebody leaves open must not turn into load
 * against the thing it is watching.
 */

/**
 * One monitor per control plane, created on first use.
 *
 * Keyed on the `App` rather than held in a module variable, because the test suite runs several
 * control planes in one process and a shared monitor would report one world's gateways as
 * another's. A `WeakMap` so a closed test world's monitor is collectable with it.
 */
const monitors = new WeakMap<App, UptimeMonitor>();

export function uptimeMonitorFor(app: App): UptimeMonitor {
  const existing = monitors.get(app);
  if (existing) return existing;
  const created = new UptimeMonitor(app);
  monitors.set(app, created);
  return created;
}

const synthetics = new WeakMap<App, { provider: SyntheticsProvider; key: string }>();

function syntheticsFor(app: App): SyntheticsProvider {
  const key = `${app.config.logs.provider}|${app.config.logs.url ?? ""}|${app.config.logs.uptimeIndex}`;
  const existing = synthetics.get(app);
  if (existing && existing.key === key) return existing.provider;
  const provider = createSynthetics(app);
  synthetics.set(app, { provider, key });
  return provider;
}

function rangeOf(ctx: Ctx): SyntheticsRange {
  const raw = ctx.url.searchParams.get("range") ?? "24h";
  if (!SYNTHETICS_RANGE_KEYS.includes(raw as SyntheticsRange)) {
    throw badRequest(`range: expected one of ${SYNTHETICS_RANGE_KEYS.join(", ")}`);
  }
  return raw as SyntheticsRange;
}

export function registerHealthRoutes(router: Router): void {
  router.add("GET", "/api/health/uptime", "session", async (ctx) => {
    requireUser(ctx);
    const monitor = uptimeMonitorFor(ctx.app);
    const snapshot = monitor.snapshot();
    /*
     * Two cases re-probe everything before answering: an explicit Refresh, and a cold snapshot.
     *
     * The cold case is what makes the screen usable at all — without it the first visit after a
     * restart would show an empty matrix and the reader would conclude the estate is unmonitored
     * rather than that the monitor has not ticked yet. It costs one round of probes, once.
     */
    const refresh = ctx.url.searchParams.get("refresh") === "1";
    if (refresh || snapshot.warming) {
      await monitor.refreshAll();
      return json(monitor.snapshot());
    }
    return json(snapshot);
  });

  router.add("GET", "/api/health/synthetics", "session", async (ctx) => {
    const user = requireUser(ctx);
    const range = rangeOf(ctx);
    const provider = syntheticsFor(ctx.app);
    // `admin` decides only whether the failure *text* comes back; the strips themselves are the
    // same for everybody, because "was the gateway up yesterday" is not privileged.
    return json(await provider.history(range, { admin: user.isAdmin, now: Date.now() }));
  });
}
