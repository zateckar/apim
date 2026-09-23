import { useState } from "react";
import {
  api,
  type FleetHealth,
  type Meta,
  type TelemetryConsumerRow,
  type TelemetryInstanceRow,
  type TelemetryResourceRow,
  type TelemetrySummary,
  type TelemetryTotals,
  type ValidationCounters,
} from "../api";
import {
  Panel,
  EmptyState,
  Link,
  Notice,
  Segmented,
  Skeleton,
  StackedBars,
  StatusChip,
  envLabel,
  useAsync,
} from "../components";
import { formatClock, formatDuration } from "../lib/datetime";
import { instanceChip, telemetryOutcomeChip } from "../lib/status";

/**
 * G4: gateway telemetry, in the control plane.
 *
 * Three things this view refuses to do, all deliberate. It never collapses traffic into a single
 * "errors" number — a 429 the gateway produced and a 500 the backend produced are different
 * signals. It labels every percentile approximate, because they are interpolated from histogram
 * buckets; claiming an exact p99 from that would be a lie. And it never shows a latency without
 * saying whose it was: every percentile here is paired with the gateway's own share of it, because
 * "p95 is 500 ms" is not a finding until you know whether 499 of those milliseconds were a backend.
 */
const WINDOWS = [
  { label: "15 min", value: "15" },
  { label: "1 hour", value: "60" },
  { label: "6 hours", value: "360" },
  { label: "24 hours", value: "1440" },
] as const;
type WindowValue = (typeof WINDOWS)[number]["value"];

/**
 * `formatDuration` decides how a duration reads, here as everywhere else — a screen that formatted
 * its own would be the second place the sub-millisecond rule had to be got right. Only the empty
 * cell differs: a table says "—" where a KPI tile says "n/a".
 */
function ms(value: number | null): string {
  return value === null ? "—" : formatDuration(value);
}

function bytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / 1024 / 1024).toFixed(1)} MiB`;
}

/** A replica's uptime in the unit a person would say it in; "4320 min" is three days. */
export function uptime(seconds: number | undefined): string {
  if (!seconds) return "—";
  if (seconds < 3600) return `${Math.max(1, Math.round(seconds / 60))} min`;
  if (seconds < 48 * 3600) return `${Math.round(seconds / 3600)} h`;
  return `${Math.round(seconds / 86400)} days`;
}

/**
 * The telemetry breakdown is per *replica* — the control plane counts by minted instance — so the
 * panel is labelled that way, and the gateway each one belongs to is joined in from the fleet's
 * health read. It was titled "By gateway" over a list of replicas, which on an environment with two
 * gateways of three replicas each read as six gateways. Grouped by gateway, then by name, so the
 * replicas of one deployment sit together and a slow one stands out against its siblings.
 *
 * `null` for the gateway when the health read has not answered: the column says "—" rather than
 * guessing, and the health read's failure is rendered once, on the validation panel that owns it.
 */
export function replicasByGateway(
  rows: TelemetryInstanceRow[],
  health: FleetHealth | null,
): Array<TelemetryInstanceRow & { gateway: string | null }> {
  const gatewayOf = new Map((health?.instances ?? []).map((instance) => [instance.id, instance.gateway]));
  const labelOf = new Map((health?.gateways ?? []).map((gateway) => [gateway.name, gateway.label]));
  return rows
    .map((row) => {
      const name = gatewayOf.get(row.instanceId);
      return { ...row, gateway: name ? labelOf.get(name) || name : null };
    })
    .sort((a, b) => {
      // An unplaced replica goes last rather than first: it is the least-known row, not the most.
      if (a.gateway !== b.gateway) {
        if (a.gateway === null) return 1;
        if (b.gateway === null) return -1;
        return a.gateway.localeCompare(b.gateway);
      }
      return a.name.localeCompare(b.name);
    });
}

function Totals({ totals }: { totals: TelemetryTotals }) {
  return (
    <div className="stats telemetry-totals">
      <div className="stat">
        <span className="value">{totals.requests.toLocaleString()}</span>
        <span className="label">Requests</span>
      </div>
      <div className="stat">
        <span className="value ok">{totals.ok.toLocaleString()}</span>
        <span className="label">Served</span>
      </div>
      <div className="stat">
        <span className="value rejected">{totals.gatewayRejections.toLocaleString()}</span>
        <span className="label">Refused by the gateway</span>
      </div>
      <div className="stat">
        <span className="value upstream">{totals.upstreamErrors.toLocaleString()}</span>
        <span className="label">Failed upstream</span>
      </div>
      <div className="stat">
        <span className="value">{ms(totals.p50Ms)}</span>
        <span className="label">p50 (approx.)</span>
      </div>
      <div className="stat">
        <span className="value">{ms(totals.p95Ms)}</span>
        <span className="label">p95 (approx.)</span>
      </div>
      {/* Beside the totals rather than in a panel of its own: the pair is the reading. A p95 of
          500 ms next to a gateway p95 of 0.4 ms is a backend to go and look at; the same p95 next
          to a gateway p95 of 480 ms is this platform's problem. Separating them onto two screens
          would be separating a number from the only thing that makes it actionable. */}
      <div className="stat">
        <span className="value">{ms(totals.gatewayP95Ms)}</span>
        <span className="label">p95 in the gateway</span>
      </div>
      <div className="stat">
        <span className="value">{ms(totals.avgBackendMs)}</span>
        <span className="label">Average backend</span>
      </div>
      <div className="stat">
        <span className="value">{bytes(totals.bytesOut)}</span>
        <span className="label">Bytes out</span>
      </div>
    </div>
  );
}

export function TelemetryView({ meta, environment }: { meta: Meta; environment: string }) {
  const [since, setSince] = useState<WindowValue>("60");
  const windowLabel = WINDOWS.find((entry) => entry.value === since)!.label;
  const query = `environment=${environment}&sinceMin=${since}`;

  // Every read is scoped by the query, so a changed window or environment never labels the previous
  // result as its own (`dashboard-health`, *A time range changes*).
  const summary = useAsync(
    () => api.get<TelemetrySummary>(`/api/telemetry/summary?${query}`),
    [environment, since],
    query,
  );
  const resources = useAsync(
    () => api.get<{ items: TelemetryResourceRow[] }>(`/api/telemetry/resources?${query}`),
    [environment, since],
    query,
  );
  const consumers = useAsync(
    () => api.get<{ items: TelemetryConsumerRow[] }>(`/api/telemetry/consumers?${query}`),
    [environment, since],
    query,
  );
  const instances = useAsync(
    () => api.get<{ items: TelemetryInstanceRow[] }>(`/api/telemetry/instances?${query}`),
    [environment, since],
    query,
  );
  const health = useAsync(
    () => api.get<FleetHealth>(`/api/targets/${environment}/health`),
    [environment],
    environment,
  );
  const replicas = replicasByGateway(instances.data?.items ?? [], health.data);
  const quiet = summary.data?.totals.requests === 0;

  return (
    <>
      {/* No heading: the shell renders the screen's title and its one-line purpose from the route
          table. The window governs everything below it, so it sits above all of it
          (`frontend-visual-system`, *Controls govern the content below them*). */}
      <header className="page-toolbar">
        <p className="muted">Per-minute traffic, kept for {meta.telemetryRetentionHours} hours.</p>
        <div className="row">
          <Segmented
            label="Time window"
            value={since}
            onChange={setSince}
            options={WINDOWS.map((entry) => ({ value: entry.value, label: entry.label }))}
          />
          <button
            type="button"
            className="btn sm"
            onClick={() => {
              summary.reload();
              resources.reload();
              consumers.reload();
              instances.reload();
              health.reload();
            }}
          >
            Refresh
          </button>
        </div>
      </header>

      <Notice kind="error">{summary.error}</Notice>

      <Panel title={`${envLabel(environment)} · last ${windowLabel}`} className="telemetry-overview">
        {!summary.data ? (
          !summary.error && <Skeleton rows={4} />
        ) : quiet ? (
          <EmptyState
            title="No traffic in this window"
            detail={`No gateway in ${envLabel(environment)} reported a request in the last ${windowLabel}.`}
            action={
              since === "1440" ? (
                <button type="button" className="btn sm" onClick={summary.reload}>Refresh</button>
              ) : (
                <button type="button" className="btn sm" onClick={() => setSince("1440")}>Show the last 24 hours</button>
              )
            }
          />
        ) : (
          <>
            <Totals totals={summary.data.totals} />
            <p className="hint">
              Error rate {(summary.data.totals.errorRate * 100).toFixed(1)}%. A refusal by the
              gateway never reached a backend; a failure upstream is a 4xx or 5xx the backend
              produced. They are never added together. Served includes cache hits, streams that ran
              to completion and JSON-RPC errors — the server answered, even if it said no.
            </p>
            <StackedBars
              rows={summary.data.series.map((point) => ({
                // The reader's own clock, as every other time in the portal is (`lib/datetime`):
                // the axis was sliced out of the UTC string, so it disagreed with the audit log.
                label: formatClock(point.windowStart),
                ok: point.ok,
                rejected: point.gatewayRejections,
                upstream: point.upstreamErrors,
              }))}
            />
            <div className="legend">
              <span className="swatch bar-ok" /> Served
              <span className="swatch bar-rejected" /> Refused by the gateway
              <span className="swatch bar-upstream" /> Failed upstream
            </div>
            {summary.data.outcomes.length > 0 && (
              <>
                <h4>How requests ended</h4>
                <div className="row wrap">
                  {summary.data.outcomes.map((outcome) => (
                    <StatusChip key={outcome.outcome} chip={telemetryOutcomeChip(outcome.outcome, outcome.count)} />
                  ))}
                </div>
              </>
            )}
            {summary.data.truncated && (
              <Notice kind="warn">
                This window holds more rows than one query scans, so these figures cover part of it.
                Choose a shorter window for a complete count.
              </Notice>
            )}
          </>
        )}
      </Panel>

      <Panel title="By API">
        <Notice kind="error">{resources.error}</Notice>
        {!resources.data ? (
          !resources.error && <Skeleton rows={3} />
        ) : (
          <table>
            <thead>
              <tr>
                <th>API</th>
                <th>Version</th>
                <th className="right">Requests</th>
                <th className="right">Served</th>
                <th className="right">Refused</th>
                <th className="right">Upstream</th>
                <th className="right">p50</th>
                <th className="right">p95</th>
                <th className="right">p95 in gateway</th>
              </tr>
            </thead>
            <tbody>
              {resources.data.items.map((row) => (
                <tr key={row.resourceId || "none"}>
                  <td>{row.resourceId ? <Link to={`/apis/${row.resourceId}`}>{row.name}</Link> : row.name}</td>
                  <td className="muted">{row.apiVersion ?? "—"}</td>
                  <td className="right">{row.requests.toLocaleString()}</td>
                  <td className="right ok">{row.ok.toLocaleString()}</td>
                  <td className="right rejected">{row.gatewayRejections.toLocaleString()}</td>
                  <td className="right upstream">{row.upstreamErrors.toLocaleString()}</td>
                  <td className="right">{ms(row.p50Ms)}</td>
                  <td className="right">{ms(row.p95Ms)}</td>
                  <td className="right">{ms(row.gatewayP95Ms)}</td>
                </tr>
              ))}
              {resources.data.items.length === 0 && (
                <tr>
                  <td colSpan={9} className="muted">No traffic in this window.</td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </Panel>

      <Panel title="By consumer">
        <Notice kind="error">{consumers.error}</Notice>
        {!consumers.data ? (
          !consumers.error && <Skeleton rows={3} />
        ) : (
          <table>
            <thead>
              <tr>
                <th>Application</th>
                <th>Product</th>
                <th className="right">Requests</th>
                <th className="right">Refused</th>
                <th className="right">p95</th>
                <th className="right">p95 in gateway</th>
              </tr>
            </thead>
            <tbody>
              {consumers.data.items.map((row) => (
                <tr key={row.subscriptionId}>
                  <td>{row.application}</td>
                  <td className="muted">{row.product}</td>
                  <td className="right">{row.requests.toLocaleString()}</td>
                  <td className="right rejected">{row.gatewayRejections.toLocaleString()}</td>
                  <td className="right">{ms(row.p95Ms)}</td>
                  <td className="right">{ms(row.gatewayP95Ms)}</td>
                </tr>
              ))}
              {consumers.data.items.length === 0 && (
                <tr>
                  <td colSpan={6} className="muted">No traffic with a subscription key in this window.</td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </Panel>

      <Panel
        title="By replica"
        hint="Rate limits are counted per replica, so how evenly traffic is spread across them decides the effective ceiling."
      >
        <Notice kind="error">{instances.error}</Notice>
        {!instances.data ? (
          !instances.error && <Skeleton rows={3} />
        ) : (
          <table>
            <thead>
              <tr>
                <th>Gateway</th>
                <th>Replica</th>
                <th className="right">Requests</th>
                <th className="right">Share</th>
                <th className="right">p95</th>
                <th className="right">p95 in gateway</th>
                <th className="right">Memory</th>
                <th className="right">Uptime</th>
                <th>Dropped</th>
              </tr>
            </thead>
            <tbody>
              {replicas.map((row) => (
                <tr key={row.instanceId}>
                  <td>{row.gateway ?? <span className="muted">—</span>}</td>
                  <td>
                    {row.name}{" "}
                    {row.revoked && <StatusChip chip={instanceChip({ revoked: true, stale: false })} />}
                  </td>
                  <td className="right">{row.requests.toLocaleString()}</td>
                  <td className="right">{(row.share * 100).toFixed(0)}%</td>
                  <td className="right">{ms(row.p95Ms)}</td>
                  {/* Per replica, because this is where a slow *instance* shows up: one replica
                      adding 40 ms while its siblings add 0.4 is a machine to go and look at, and
                      nothing else on this screen would distinguish it from a slow backend. */}
                  <td className="right">{ms(row.gatewayP95Ms)}</td>
                  <td className="right">{row.process?.rssBytes ? bytes(row.process.rssBytes) : "—"}</td>
                  <td className="right">{uptime(row.process?.uptimeSec)}</td>
                  {/* Shown rather than assumed to be zero: silent truncation would read as "that
                      traffic did not happen". */}
                  <td className="muted">
                    {(row.process?.droppedSeries ?? 0) + (row.process?.droppedWindows ?? 0) === 0
                      ? "none"
                      : `${row.process?.droppedSeries ?? 0} series, ${row.process?.droppedWindows ?? 0} windows`}
                  </td>
                </tr>
              ))}
              {replicas.length === 0 && (
                <tr>
                  <td colSpan={9} className="muted">No replica reported traffic in this window.</td>
                </tr>
              )}
            </tbody>
          </table>
        )}
        <p className="hint">
          Percentiles are interpolated inside histogram buckets and are approximate; the smallest
          bucket is 0.25 ms, so a gateway faster than that reads as that floor. <strong>p95 in
          gateway</strong> is the gateway's own share of each request — its total minus its backend
          call — so it is the percentile of the difference, not the difference of two percentiles.
          A stream contributes none of it, because a connection's lifetime is not proxying time.
          {summary.data && summary.data.totals.gatewayAttributed < summary.data.totals.requests && (
            <>
              {" "}
              {summary.data.totals.gatewayAttributed.toLocaleString()} of{" "}
              {summary.data.totals.requests.toLocaleString()} requests in this window carry that
              figure; the rest are streams, or were recorded by a gateway that could not report it.
            </>
          )}
        </p>
      </Panel>

      <ValidationHealth environment={environment} health={health} />
    </>
  );
}

/**
 * What validation is actually doing out there, as opposed to what it is configured to do.
 *
 * Moved here from Global policy: it is a reading of the fleet at run time, like everything else on
 * this screen, and on Global policy it sat among the controls as if it were one of them. The counters
 * are per instance and not windowed, so they are summed across the fleet rather than charted — and
 * the panel says it is not governed by the window above, because every other figure here is.
 * `rejected` is enforcement working, `observed` is warning mode finding things nobody is acting on,
 * and `sampleDropped`, `budgetShed` and `unavailable` are the ways a request goes unchecked without
 * anybody being told — which is the number this panel exists to surface.
 */
function ValidationHealth({
  environment,
  health,
}: {
  environment: string;
  health: { data: FleetHealth | null; error: string | null };
}) {
  const totals: ValidationCounters = {
    rejected: 0,
    observed: 0,
    sampleDropped: 0,
    unavailable: 0,
    budgetShed: 0,
  };
  let reporting = 0;
  for (const instance of health.data?.instances ?? []) {
    const counters = instance.process?.validation as Partial<ValidationCounters> | null | undefined;
    if (!counters) continue;
    reporting++;
    for (const key of Object.keys(totals) as Array<keyof ValidationCounters>) {
      totals[key] += counters[key] ?? 0;
    }
  }
  const unchecked = totals.sampleDropped + totals.budgetShed + totals.unavailable;

  return (
    <Panel
      title="Validation at the gateways"
      hint="Summed across the replicas in this environment since each one last reported — recent activity, not the window above."
    >
      <Notice kind="error">{health.error}</Notice>
      {!health.data ? (
        !health.error && <Skeleton rows={2} />
      ) : reporting === 0 ? (
        <p className="muted">No replica in {envLabel(environment)} has reported validation counters yet.</p>
      ) : (
        <>
          <div className="stats">
            <div className="stat">
              <span className="value ok">{totals.rejected.toLocaleString()}</span>
              <span className="label">Refused — blocking mode</span>
            </div>
            <div className="stat">
              <span className="value rejected">{totals.observed.toLocaleString()}</span>
              <span className="label">Passed with a warning</span>
            </div>
            <div className="stat">
              <span className="value">{totals.sampleDropped.toLocaleString()}</span>
              <span className="label">Not sampled</span>
            </div>
            <div className="stat">
              <span className={totals.budgetShed > 0 ? "value upstream" : "value"}>
                {totals.budgetShed.toLocaleString()}
              </span>
              <span className="label">Shed at the memory budget</span>
            </div>
            <div className="stat">
              <span className={totals.unavailable > 0 ? "value upstream" : "value"}>
                {totals.unavailable.toLocaleString()}
              </span>
              <span className="label">No compiled schema</span>
            </div>
          </div>

          {totals.observed > 0 && (
            <Notice kind="warn">
              {totals.observed.toLocaleString()} request{totals.observed === 1 ? "" : "s"} failed
              validation and {totals.observed === 1 ? "was" : "were"} passed through anyway. Warning
              mode is an observation, not a control.
            </Notice>
          )}
          {totals.budgetShed > 0 && (
            <Notice kind="error">
              {totals.budgetShed.toLocaleString()} request{totals.budgetShed === 1 ? " was" : "s were"}{" "}
              refused because the blocking validation budget was full. Raise it on{" "}
              <Link to="/gateway-settings">Gateway settings</Link>, or lower the body limit on the
              routes doing it.
            </Notice>
          )}
          {totals.unavailable > 0 && (
            <Notice kind="error">
              {totals.unavailable.toLocaleString()} request{totals.unavailable === 1 ? "" : "s"} could
              not be validated because the compiled schema was missing on the replica. A replica is
              meant to refuse a configuration whose schemas it cannot load, so check its activation on{" "}
              <Link to="/fleet">Health Status</Link>.
            </Notice>
          )}
          <p className="muted small">
            {unchecked.toLocaleString()} of{" "}
            {(totals.rejected + totals.observed + unchecked).toLocaleString()} requests due a check
            went unchecked, across {reporting} reporting replica{reporting === 1 ? "" : "s"}.
          </p>
        </>
      )}
    </Panel>
  );
}
