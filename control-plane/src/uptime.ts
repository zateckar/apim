import { gatewayAddresses, gatewaysIn, instancesOf } from "./api/fleet.ts";
import { MOCK_INTEGRATIONS } from "./integrations.ts";
import { createLogSearch } from "./logs.ts";
import type { App } from "./router.ts";

/**
 * "Is the estate up, and if not, which part of it is not."
 *
 * The Health screen answers that, and this module is what it reads. Three properties shape it.
 *
 *  - **Each component is probed on its own timer.** A snapshot is assembled from the latest result
 *    of each probe rather than by running them all when somebody opens the page: an expensive or
 *    hung check must not make the screen hang, and a screen that is being watched must not turn
 *    into a load generator against a gateway that is already struggling.
 *  - **A probe that throws keeps its previous answer.** Every check maps its own failures onto a
 *    `down` item with the reason; the catch around it is a safety net, and the honest thing for a
 *    safety net to do is to leave the last real observation alone rather than invent a verdict.
 *  - **`disabled` is a third state, and it is not `down`.** A gateway with no address registered
 *    is not broken — nobody has told the portal where it is. Rolling that into "down" produces a
 *    red environment nobody can fix, so disabled components are excluded from the verdict.
 *
 * The vocabulary is deliberately the *estate's*, not a monitoring tool's: the components are the
 * control plane, its database, each gateway's replicas, each gateway's published address, the log
 * index and the six external systems.
 */

export type ComponentStatus = "up" | "down" | "disabled";

export type ComponentKind =
  | "control-plane"
  | "database"
  | "fleet"
  | "gateway"
  | "log-index"
  | "integration";

export interface HealthItem {
  id: string;
  label: string;
  kind: ComponentKind;
  /** `null` for components that are not per-environment — the control plane, its database. */
  environment: string | null;
  status: ComponentStatus;
  latencyMs: number | null;
  checkedAt: string;
  /** One line: what was observed, or why it could not be. Always set for `down` and `disabled`. */
  message: string | null;
  /** A short capability tag that tells two probes of the same kind apart: `Simulated`, `HTTP`. */
  tag: string | null;
  /** True when nothing was really contacted. The screen marks these, and never counts them as evidence. */
  simulated: boolean;
}

/**
 * One environment's verdict.
 *
 * `unknown` is not a failure to compute — it is the honest answer when an environment has no
 * probeable component at all, which is exactly what a chain stage looks like before a gateway has
 * been registered in it.
 */
export type EnvironmentVerdict = "healthy" | "degraded" | "down" | "unknown";

export interface EnvironmentRollup {
  environment: string;
  status: EnvironmentVerdict;
  up: number;
  down: number;
  disabled: number;
  total: number;
  /** The components that are down, by label — what the hero card lists under its verdict. */
  impact: string[];
}

export interface HealthSnapshot {
  generatedAt: string;
  /** What the screen should poll at, in milliseconds. The server owns the cadence, not the browser. */
  intervalMs: number;
  summary: { up: number; down: number; disabled: number; total: number };
  environments: EnvironmentRollup[];
  items: HealthItem[];
  /** True while at least one probe has never produced a result — a cold start, not a healthy estate. */
  warming: boolean;
}

/** What the browser polls at. Slower than any probe, so a poll never races a half-written snapshot. */
export const SNAPSHOT_POLL_MS = 30_000;

const PROBE_DATABASE_MS = 30_000;
const PROBE_FLEET_MS = 15_000;
const PROBE_GATEWAY_MS = 60_000;
const PROBE_LOG_INDEX_MS = 60_000;
const PROBE_INTEGRATION_MS = 60_000;

/** How long a gateway address may take to answer before the probe calls it down. */
const GATEWAY_TIMEOUT_MS = 5_000;

interface ProbeDef {
  id: string;
  intervalMs: number;
  run: () => Promise<HealthItem>;
}

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * The monitor for one control plane.
 *
 * An instance rather than module state: the test suite runs several control planes in one process,
 * and a shared `Map` keyed on probe id would have one world's gateway reported as another's.
 */
export class UptimeMonitor {
  private readonly latest = new Map<string, HealthItem>();
  private readonly timers: ReturnType<typeof setInterval>[] = [];
  private started = false;
  private readonly startedAt = Date.now();

  constructor(private readonly app: App) {}

  /**
   * The probe set, rebuilt on each call.
   *
   * Gateways are registered and removed at runtime, so a set captured at boot would keep reporting
   * a gateway an administrator deleted and would never notice one they added. Rebuilding is cheap —
   * it is two indexed reads — and it means the timers below are the only thing that is long-lived.
   *
   * Rebuilding reads the database, which is one of the things being monitored, so a failure there
   * falls back to the last set that built. The alternative is a health screen that goes blank
   * exactly when it has something to say.
   */
  private lastProbes: ProbeDef[] = [];

  private probes(): ProbeDef[] {
    try {
      this.lastProbes = this.buildProbes();
    } catch {
      // Keep the previous set. The database probe in it will report the failure by name.
    }
    return this.lastProbes;
  }

  private buildProbes(): ProbeDef[] {
    const defs: ProbeDef[] = [
      { id: "database", intervalMs: PROBE_DATABASE_MS, run: () => this.checkDatabase() },
      { id: "log-index", intervalMs: PROBE_LOG_INDEX_MS, run: () => this.checkLogIndex() },
    ];
    for (const environment of this.app.config.promotionChain) {
      for (const gateway of gatewaysIn(this.app.db, environment)) {
        defs.push({
          id: `fleet:${environment}:${gateway.name}`,
          intervalMs: PROBE_FLEET_MS,
          run: async () => this.checkFleet(environment, gateway.name),
        });
        defs.push({
          id: `gateway:${environment}:${gateway.name}`,
          intervalMs: PROBE_GATEWAY_MS,
          run: () => this.checkGatewayAddress(environment, gateway.name),
        });
      }
    }
    for (const name of MOCK_INTEGRATIONS) {
      defs.push({
        id: `integration:${name}`,
        intervalMs: PROBE_INTEGRATION_MS,
        run: async () => this.checkIntegration(name),
      });
    }
    return defs;
  }

  // ------------------------------------------------------------------ the probes

  /**
   * The control plane, answered from inside it.
   *
   * It is trivially up — this code is running — and it is on the matrix anyway, because a screen
   * that lists five components and silently omits the one serving it teaches the reader that the
   * list is not the whole system.
   */
  private controlPlane(): HealthItem {
    return {
      id: "control-plane",
      label: "Control plane",
      kind: "control-plane",
      environment: null,
      status: "up",
      latencyMs: null,
      checkedAt: nowIso(),
      message: `serving for ${Math.round((Date.now() - this.startedAt) / 1000)}s`,
      tag: "Local",
      simulated: false,
    };
  }

  private async checkDatabase(): Promise<HealthItem> {
    const started = Date.now();
    const base = {
      id: "database",
      label: "Configuration database",
      kind: "database" as const,
      environment: null,
      tag: "Local",
      simulated: false,
    };
    try {
      // A read that touches a real table rather than `SELECT 1`: an open handle to a file whose
      // schema has gone is not a working database, and it is the failure a restart can produce.
      const row = this.app.db
        .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM resource")
        .get();
      return {
        ...base,
        status: "up",
        latencyMs: Date.now() - started,
        checkedAt: nowIso(),
        message: `${row?.n ?? 0} API(s) on file`,
      };
    } catch (err) {
      return {
        ...base,
        status: "down",
        latencyMs: Date.now() - started,
        checkedAt: nowIso(),
        message: (err as Error).message,
      };
    }
  }

  /**
   * One gateway's replicas, from what they themselves reported.
   *
   * No network call: the replicas poll *us*, so their liveness and the digest they are serving are
   * already on file. That makes this the one component whose answer cannot be wrong because of a
   * firewall between the control plane and the thing it is describing.
   */
  private checkFleet(environment: string, gateway: string): HealthItem {
    const base = {
      id: `fleet:${environment}:${gateway}`,
      label: `${gateway} replicas`,
      kind: "fleet" as const,
      environment,
      tag: "Reported",
      simulated: false,
    };
    const target = gatewaysIn(this.app.db, environment).find((row) => row.name === gateway);
    if (!target) {
      return {
        ...base,
        status: "disabled",
        latencyMs: null,
        checkedAt: nowIso(),
        message: "this gateway is no longer registered",
      };
    }
    const mine = instancesOf(this.app, environment).filter(
      (instance) => instance.targetId === target.id && !instance.revoked,
    );
    const live = mine.filter((instance) => !instance.stale);
    if (mine.length === 0) {
      // No replica has ever been minted, so there is nothing to be up or down about. A brand-new
      // gateway reading `down` would put a whole environment in the red before it was deployed.
      return {
        ...base,
        status: "disabled",
        latencyMs: null,
        checkedAt: nowIso(),
        message: "no replica has been minted for this gateway yet",
      };
    }
    if (live.length === 0) {
      return {
        ...base,
        status: "down",
        latencyMs: null,
        checkedAt: nowIso(),
        message: `none of its ${mine.length} replica(s) has polled recently`,
      };
    }
    return {
      ...base,
      status: "up",
      latencyMs: null,
      checkedAt: nowIso(),
      message:
        live.length === mine.length
          ? `${live.length} replica(s) reporting`
          : `${live.length} of ${mine.length} replica(s) reporting`,
    };
  }

  /**
   * The gateway's published address, fetched from outside.
   *
   * Different question from the one above, and the difference is the whole reason both are on the
   * matrix: the replicas can be healthy and polling while the proxy in front of them is refusing
   * connections, and only an outside request finds that. **Any** HTTP answer counts as up — a 404
   * from a gateway that has no route at `/` still proves the address is being served.
   */
  private async checkGatewayAddress(environment: string, gateway: string): Promise<HealthItem> {
    const base = {
      id: `gateway:${environment}:${gateway}`,
      label: `${gateway} address`,
      kind: "gateway" as const,
      environment,
      simulated: false,
    };
    const target = gatewaysIn(this.app.db, environment).find((row) => row.name === gateway);
    // The first address, which is the internet one when there is one. A gateway with two names is
    // one gateway, and probing both would report a single component twice with two verdicts.
    const address = target ? (gatewayAddresses(target)[0]?.url ?? null) : null;
    if (!address) {
      return {
        ...base,
        status: "disabled",
        latencyMs: null,
        checkedAt: nowIso(),
        message: "no address has been published for this gateway",
        tag: null,
      };
    }
    const tag = address.startsWith("https:") ? "HTTPS" : "HTTP";
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), GATEWAY_TIMEOUT_MS);
    try {
      const response = await fetch(address, {
        signal: controller.signal,
        // A gateway that answers a redirect is a misconfiguration to report, not one to follow.
        redirect: "manual",
        headers: { "user-agent": "integration-portal-health" },
      });
      return {
        ...base,
        status: "up",
        latencyMs: Date.now() - started,
        checkedAt: nowIso(),
        message: `HTTP ${response.status}`,
        tag,
      };
    } catch (err) {
      const aborted = (err as Error).name === "AbortError";
      return {
        ...base,
        status: "down",
        latencyMs: Date.now() - started,
        checkedAt: nowIso(),
        message: aborted ? `no answer within ${GATEWAY_TIMEOUT_MS} ms` : (err as Error).message,
        tag,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  private async checkLogIndex(): Promise<HealthItem> {
    const provider = createLogSearch(this.app);
    const result = await provider.probe();
    return {
      id: "log-index",
      label: "Log search (ELK)",
      kind: "log-index",
      environment: null,
      status: result.reachable ? "up" : "down",
      latencyMs: result.latencyMs,
      checkedAt: nowIso(),
      message: result.detail,
      tag: provider.kind === "mock" ? "Simulated" : "HTTP",
      simulated: provider.kind === "mock",
    };
  }

  /**
   * One external system.
   *
   * Every one of the six is a mock in this phase, so the honest answer is "up, and nothing was
   * contacted" — carried as `simulated`, which the screen renders rather than hides. The queue
   * depth is real, though: it is this portal's own outbox, and a system with events piling up in
   * `retrying` is worth seeing even when the transport is simulated.
   */
  private checkIntegration(name: string): HealthItem {
    const stuck = this.app.db
      .query<{ n: number }, [string]>(
        "SELECT COUNT(*) AS n FROM integration_event WHERE integration = ? AND state IN ('queued','retrying')",
      )
      .get(name);
    const waiting = stuck?.n ?? 0;
    return {
      id: `integration:${name}`,
      label: name,
      kind: "integration",
      environment: null,
      status: "up",
      latencyMs: null,
      checkedAt: nowIso(),
      message: waiting > 0 ? `${waiting} event(s) waiting in the outbox` : "simulated — nothing was contacted",
      tag: "Simulated",
      simulated: true,
    };
  }

  // ------------------------------------------------------------------ running them

  private async runProbe(probe: ProbeDef): Promise<void> {
    try {
      this.latest.set(probe.id, await probe.run());
    } catch {
      // Keep the last real observation. A probe that threw tells us nothing about the component.
    }
  }

  /** Every probe once, concurrently. Used on a cold start and by the screen's Refresh button. */
  async refreshAll(): Promise<void> {
    await Promise.all(this.probes().map((probe) => this.runProbe(probe)));
  }

  /**
   * Start the timers. Idempotent, and a no-op in the test suite unless a test asks for it — a
   * background fetch against a gateway address would make unrelated tests depend on the network.
   */
  start(): void {
    if (this.started) return;
    this.started = true;
    for (const probe of this.probes()) {
      void this.runProbe(probe);
      const timer = setInterval(() => void this.runProbe(probe), probe.intervalMs);
      // Never a reason to keep the process alive; the server's own listener does that.
      if (typeof (timer as { unref?: () => void }).unref === "function") {
        (timer as unknown as { unref: () => void }).unref();
      }
      this.timers.push(timer);
    }
  }

  stop(): void {
    for (const timer of this.timers) clearInterval(timer);
    this.timers.length = 0;
    this.started = false;
  }

  /**
   * The current picture. Assembled from `latest`, so it is cheap and never blocks; a component
   * whose probe has not produced anything yet is simply absent, and `warming` says so.
   */
  snapshot(): HealthSnapshot {
    const defs = this.probes();
    const items: HealthItem[] = [this.controlPlane()];
    let warming = false;
    for (const probe of defs) {
      const item = this.latest.get(probe.id);
      if (item) items.push(item);
      else warming = true;
    }
    const summary = { up: 0, down: 0, disabled: 0, total: items.length };
    for (const item of items) summary[item.status]++;
    return {
      generatedAt: nowIso(),
      intervalMs: SNAPSHOT_POLL_MS,
      summary,
      environments: this.app.config.promotionChain.map((environment) => rollup(environment, items)),
      items,
      warming,
    };
  }
}

/**
 * One environment's components rolled into a verdict.
 *
 * Components with no environment — the control plane, its database, the log index, the six
 * external systems — are deliberately excluded. They are estate-wide, and folding them in would
 * paint all three environments red for one shared failure, which tells the reader nothing about
 * which stage of the chain to stop promoting into.
 */
export function rollup(environment: string, items: HealthItem[]): EnvironmentRollup {
  const scoped = items.filter((item) => item.environment === environment);
  let up = 0;
  let down = 0;
  let disabled = 0;
  for (const item of scoped) {
    if (item.status === "up") up++;
    else if (item.status === "down") down++;
    else disabled++;
  }
  const probeable = up + down;
  const status: EnvironmentVerdict =
    probeable === 0 ? "unknown" : down === 0 ? "healthy" : up === 0 ? "down" : "degraded";
  return {
    environment,
    status,
    up,
    down,
    disabled,
    total: scoped.length,
    impact: scoped.filter((item) => item.status === "down").map((item) => item.label),
  };
}
