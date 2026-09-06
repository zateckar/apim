import { useState } from "react";
import {
  api,
  type Meta,
  type TelemetryConsumerRow,
  type TelemetryInstanceRow,
  type TelemetryResourceRow,
  type TelemetrySummary,
  type TelemetryTotals,
} from "../api";
import { Card, EnvironmentPicker, Notice, Pill, StackedBars, useAsync } from "../components";

/**
 * G4: gateway telemetry, in the control plane.
 *
 * Two things this view refuses to do, both deliberate. It never collapses traffic into a single
 * "errors" number — a 429 the gateway produced and a 500 the backend produced are different
 * signals. And it labels every percentile approximate, because they are interpolated from 15
 * histogram buckets; claiming an exact p99 from that would be a lie.
 */
const WINDOWS = [
  { label: "15 min", value: 15 },
  { label: "1 hour", value: 60 },
  { label: "6 hours", value: 360 },
  { label: "24 hours", value: 1440 },
];

/**
 * The outcomes that mean the request got an answer, mirrored from `shared/telemetry.ts`'s
 * `SERVED_OUTCOMES`. Duplicated rather than imported: this bundle deliberately talks to the control
 * plane only over the API, and the cost of the duplication is one line in a chip's colour.
 */
const SERVED = new Set(["ok", "cache-hit", "stream-closed", "rpc-error"]);

function ms(value: number | null): string {
  return value === null ? "—" : `${value} ms`;
}

function bytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / 1024 / 1024).toFixed(1)} MiB`;
}

function Totals({ totals }: { totals: TelemetryTotals }) {
  return (
    <div className="stats">
      <div className="stat">
        <span className="value">{totals.requests.toLocaleString()}</span>
        <span className="label">requests</span>
      </div>
      <div className="stat">
        <span className="value ok">{totals.ok.toLocaleString()}</span>
        <span className="label">ok</span>
      </div>
      <div className="stat">
        <span className="value rejected">{totals.gatewayRejections.toLocaleString()}</span>
        <span className="label">gateway rejections</span>
      </div>
      <div className="stat">
        <span className="value upstream">{totals.upstreamErrors.toLocaleString()}</span>
        <span className="label">upstream errors</span>
      </div>
      <div className="stat">
        <span className="value">{ms(totals.p50Ms)}</span>
        <span className="label">p50 (approx.)</span>
      </div>
      <div className="stat">
        <span className="value">{ms(totals.p95Ms)}</span>
        <span className="label">p95 (approx.)</span>
      </div>
      <div className="stat">
        <span className="value">{bytes(totals.bytesOut)}</span>
        <span className="label">bytes out</span>
      </div>
    </div>
  );
}

export function TelemetryView({ meta }: { meta: Meta }) {
  const [environment, setEnvironment] = useState(meta.chain[0] ?? "dev");
  const [sinceMin, setSinceMin] = useState(60);
  const query = `environment=${environment}&sinceMin=${sinceMin}`;

  const summary = useAsync(
    () => api.get<TelemetrySummary>(`/api/telemetry/summary?${query}`),
    [environment, sinceMin],
  );
  const resources = useAsync(
    () => api.get<{ items: TelemetryResourceRow[] }>(`/api/telemetry/resources?${query}`),
    [environment, sinceMin],
  );
  const consumers = useAsync(
    () => api.get<{ items: TelemetryConsumerRow[] }>(`/api/telemetry/consumers?${query}`),
    [environment, sinceMin],
  );
  const instances = useAsync(
    () => api.get<{ items: TelemetryInstanceRow[] }>(`/api/telemetry/instances?${query}`),
    [environment, sinceMin],
  );

  return (
    <>
      {/* No heading: the shell renders the screen's title and its one-line purpose from the route
          table, and repeating the title here reads as the page having started over. */}
      <header className="page">
        <div>
          <p className="muted">
            Counted on each gateway, reported on the config poll it was already making, and
            aggregated per minute. Retained {meta.telemetryRetentionHours} hours.
          </p>
        </div>
        <div className="row">
          <EnvironmentPicker chain={meta.chain} value={environment} onChange={setEnvironment} />
          <select value={sinceMin} onChange={(event) => setSinceMin(Number(event.target.value))}>
            {WINDOWS.map((window) => (
              <option key={window.value} value={window.value}>
                last {window.label}
              </option>
            ))}
          </select>
          <button className="ghost small" onClick={() => {
            summary.reload();
            resources.reload();
            consumers.reload();
            instances.reload();
          }}>
            Refresh
          </button>
        </div>
      </header>

      <Notice kind="error">{summary.error}</Notice>

      {summary.data && (
        <Card title={`${environment} · last ${sinceMin} minutes`}>
          <Totals totals={summary.data.totals} />
          <p className="hint">
            Error rate {(summary.data.totals.errorRate * 100).toFixed(1)}%. A gateway rejection
            never reached a backend; an upstream error is a 4xx or 5xx the backend produced. They
            are never added together. "ok" counts every request that got an answer, which includes a
            cache hit, a stream that ran to completion, and a JSON-RPC error — the server said no,
            which is not the gateway failing. The breakdown below keeps all three separate.
          </p>
          <StackedBars
            rows={summary.data.series.map((point) => ({
              label: point.windowStart.slice(11, 16),
              ok: point.ok,
              rejected: point.gatewayRejections,
              upstream: point.upstreamErrors,
            }))}
          />
          <div className="legend">
            <span className="swatch bar-ok" /> ok
            <span className="swatch bar-rejected" /> gateway rejections
            <span className="swatch bar-upstream" /> upstream errors
          </div>
          {summary.data.outcomes.length > 0 && (
            <>
              <h4>Why requests ended where they did</h4>
              <div className="row wrap">
                {summary.data.outcomes.map((outcome) => (
                  <Pill key={outcome.outcome} kind={SERVED.has(outcome.outcome) ? "ok" : "warn"}>
                    {outcome.outcome} · {outcome.count}
                  </Pill>
                ))}
              </div>
            </>
          )}
        </Card>
      )}

      <Card title="By API">
        <Notice kind="error">{resources.error}</Notice>
        <table>
          <thead>
            <tr>
              <th>API</th>
              <th>Version</th>
              <th className="right">Requests</th>
              <th className="right">ok</th>
              <th className="right">Rejected</th>
              <th className="right">Upstream</th>
              <th className="right">p50</th>
              <th className="right">p95</th>
            </tr>
          </thead>
          <tbody>
            {resources.data?.items.map((row) => (
              <tr key={row.resourceId || "none"}>
                <td>{row.name}</td>
                <td className="muted">{row.apiVersion ?? "—"}</td>
                <td className="right">{row.requests.toLocaleString()}</td>
                <td className="right ok">{row.ok.toLocaleString()}</td>
                <td className="right rejected">{row.gatewayRejections.toLocaleString()}</td>
                <td className="right upstream">{row.upstreamErrors.toLocaleString()}</td>
                <td className="right">{ms(row.p50Ms)}</td>
                <td className="right">{ms(row.p95Ms)}</td>
              </tr>
            ))}
            {resources.data?.items.length === 0 && (
              <tr>
                <td colSpan={8} className="muted">
                  No traffic in this window.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Card>

      <Card title="By consumer">
        <Notice kind="error">{consumers.error}</Notice>
        <table>
          <thead>
            <tr>
              <th>Application</th>
              <th>Product</th>
              <th className="right">Requests</th>
              <th className="right">Rejected</th>
              <th className="right">p95</th>
            </tr>
          </thead>
          <tbody>
            {consumers.data?.items.map((row) => (
              <tr key={row.subscriptionId}>
                <td>{row.application}</td>
                <td className="muted">{row.product}</td>
                <td className="right">{row.requests.toLocaleString()}</td>
                <td className="right rejected">{row.gatewayRejections.toLocaleString()}</td>
                <td className="right">{ms(row.p95Ms)}</td>
              </tr>
            ))}
            {consumers.data?.items.length === 0 && (
              <tr>
                <td colSpan={5} className="muted">
                  No authenticated traffic in this window.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Card>

      <Card
        title="By gateway"
        hint="Rate limiting is per instance (design section 5.7), so how traffic is spread across the fleet is what decides the effective ceiling."
      >
        <Notice kind="error">{instances.error}</Notice>
        <table>
          <thead>
            <tr>
              <th>Gateway</th>
              <th className="right">Requests</th>
              <th className="right">Share</th>
              <th className="right">p95</th>
              <th className="right">RSS</th>
              <th className="right">Uptime</th>
              <th>Dropped</th>
            </tr>
          </thead>
          <tbody>
            {instances.data?.items.map((row) => (
              <tr key={row.instanceId}>
                <td>
                  {row.name} {row.revoked && <Pill kind="warn">revoked</Pill>}
                </td>
                <td className="right">{row.requests.toLocaleString()}</td>
                <td className="right">{(row.share * 100).toFixed(0)}%</td>
                <td className="right">{ms(row.p95Ms)}</td>
                <td className="right">
                  {row.process?.rssBytes ? bytes(row.process.rssBytes) : "—"}
                </td>
                <td className="right">
                  {row.process?.uptimeSec ? `${Math.round(row.process.uptimeSec / 60)} min` : "—"}
                </td>
                <td className="muted">
                  {(row.process?.droppedSeries ?? 0) + (row.process?.droppedWindows ?? 0) === 0
                    ? "none"
                    : `${row.process?.droppedSeries ?? 0} series, ${row.process?.droppedWindows ?? 0} windows`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="hint">
          Percentiles are interpolated inside histogram buckets and are approximate. Drop counters
          are shown rather than assumed to be zero: silent truncation would read as "that traffic
          did not happen".
        </p>
      </Card>
    </>
  );
}
