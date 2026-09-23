import { useState, type ReactNode } from "react";
import type { Session } from "../App";
import { api, type AttentionRow, type Dashboard } from "../api";
import {
  AttentionList,
  EmptyState,
  Link,
  Notice,
  OperationList,
  Panel,
  Segmented,
  Skeleton,
  envLabel,
  go,
  useAsync,
} from "../components";
import * as I from "./icons";
import { formatDuration } from "../lib/datetime";

/**
 * The application dashboard: what my application publishes, how it is being called, and what
 * needs me.
 *
 * It reads `/api/dashboard` — one request, not five — because the alternative is five chances for
 * two numbers on one page to disagree about what "now" means. The screen's own decisions:
 *
 *  - **Three numbers about traffic, never one.** A 429 the gateway produced and a 500 the backend
 *    produced are different signals with different owners, and an "errors" figure that adds them
 *    up hides which one is happening.
 *  - **A trend is shown only when it is real.** `trendAvailable` is false when telemetry retention
 *    cannot cover two windows, and then the delta is absent rather than computed over a short one.
 *  - **Every number leads somewhere.** A KPI whose value raises a question and offers no way to
 *    answer it is decoration; each card here either navigates or explains why it does not.
 */

/**
 * The windows the KPIs can describe. Anything wider is the Telemetry screen's job. The labels are
 * also how the choice is written in a drill-down link, which is why they are words and not indices.
 */
const WINDOWS = [
  { label: "1h", sinceMin: 60 },
  { label: "6h", sinceMin: 360 },
  { label: "24h", sinceMin: 1440 },
] as const;

/**
 * Where a traffic row leads: that API's Logs panel, for the window the dashboard is showing
 * (dashboard-health, "Make traffic drillable"). The link used to carry the tab and drop the window,
 * so a reader looking at a spike in the last six hours landed on the last hour.
 */
export function trafficDrillHref(applicationId: string, resourceId: string, sinceMin: number): string {
  return `/${applicationId}/apis/${encodeURIComponent(resourceId)}?tab=logs&sinceMin=${sinceMin}`;
}

/** "last 6h" for a window the control plane may have chosen itself, which need not be one of ours. */
function windowLabel(sinceMin: number): string {
  const known = WINDOWS.find((entry) => entry.sinceMin === sinceMin);
  if (known) return known.label;
  return sinceMin % 60 === 0 ? `${sinceMin / 60}h` : `${sinceMin}m`;
}

export function Dashboard({
  session: s,
  operations,
  tick,
}: {
  session: Session;
  operations: any[];
  tick: number;
}) {
  const [chosen, choose] = useWindowChoice();
  const data = useAsync(
    () =>
      api.get<Dashboard>(
        `/api/dashboard?applicationId=${encodeURIComponent(s.application)}&environment=${encodeURIComponent(s.environment)}${chosen === null ? "" : `&sinceMin=${chosen}`}`,
      ),
    [s.environment, chosen, s.application, tick],
    `${s.application}:${s.environment}:${chosen}`,
  );
  const d = data.data;
  // Nothing chosen yet means the control plane's `DASHBOARD_DEFAULT_SINCE_MIN`, which the response
  // echoes. The screen used to default to its own first button, an hour, whatever the deployment
  // had configured (dashboard-health, "The window is changed").
  const sinceMin = chosen ?? d?.sinceMin ?? null;
  const traffic = d?.owner.traffic;
  const previous = traffic?.previous ?? null;
  const inFlight = operations.filter((row) => !["complete", "superseded"].includes(row.state));
  const env = envLabel(s.environment);

  // Every attention row the caller has, in one list. Splitting them by hat made a publisher who is
  // also a consumer read two lists to find out whether anything was wrong.
  const attention: AttentionRow[] = [
    ...(d?.owner.attention ?? []),
    ...(d?.consumer.attention ?? []),
    ...(s.user.isAdmin ? (d?.platform.attention ?? []) : []),
  ];
  const truncated =
    (d?.owner.attentionTruncated ?? 0) +
    (d?.consumer.attentionTruncated ?? 0) +
    (s.user.isAdmin ? (d?.platform.attentionTruncated ?? 0) : 0);
  return (
    <>
      <Notice kind="error">{data.error}</Notice>

      {/* The same rows the attention list below draws, so the same component: this was a second
          rendering with its own chip, its own button and the raw severity word as its label. */}
      {d?.startHere && d.startHere.length > 0 && (
        <Panel title="Start here">
          <AttentionList rows={d.startHere} />
        </Panel>
      )}

      {/* The window governs every figure below it, so it sits above them (dashboard-health, "The
          window is changed") — the shared `Segmented`, not a third hand-drawn button group. */}
      <div className="page-toolbar">
        <h2>Traffic overview</h2>
        <Segmented
          label="Window"
          value={sinceMin === null ? "" : String(sinceMin)}
          onChange={(next) => choose(Number(next))}
          options={WINDOWS.map((entry) => ({ value: String(entry.sinceMin), label: entry.label }))}
        />
      </div>
      <div className="kpi-row">
        <Kpi
          label={sinceMin === null ? "Requests" : `Requests · last ${windowLabel(sinceMin)}`}
          value={traffic ? traffic.requests.toLocaleString() : null}
          delta={delta(traffic?.requests, previous?.requests, "more")}
          spark={<Sparkline series={traffic?.series ?? []} />}
          onOpen={() => go(`/${s.application}/apis`)}
          hint={`in ${env}`}
        />
        <Kpi
          label="Refused by the gateway"
          value={traffic ? traffic.gatewayRejections.toLocaleString() : null}
          tone={traffic && traffic.gatewayRejections > 0 ? "warn" : undefined}
          delta={delta(traffic?.gatewayRejections, previous?.gatewayRejections, "fewer")}
          hint="rate limits, quotas, missing or invalid keys"
        />
        <Kpi
          label="Failed upstream"
          value={traffic ? traffic.upstreamErrors.toLocaleString() : null}
          tone={traffic && traffic.upstreamErrors > 0 ? "err" : undefined}
          delta={delta(traffic?.upstreamErrors, previous?.upstreamErrors, "fewer")}
          hint="your backend answered 5xx, or did not answer"
        />
        <Kpi
          label="p95 latency"
          value={traffic ? (traffic.p95Ms === null ? "—" : formatDuration(traffic.p95Ms)) : null}
          /* The gateway's own share, in the hint rather than as a tile of its own: what an owner
             opening this page needs is their API's latency, and the one thing they cannot work out
             from it is how much of it this platform is responsible for. Saying it here answers
             "is this us or you" without spending a tile on a number that is usually a rounding
             error — and makes the case where it is *not* a rounding error impossible to miss. */
          hint={
            traffic?.gatewayP95Ms != null
              ? `${formatDuration(traffic.gatewayP95Ms)} of it in the gateway — approximate`
              : traffic?.approximate
                ? "approximate — from bucketed histograms"
                : "over the window"
          }
        />
      </div>

      <div className="kpi-row">
        <Kpi
          label="Published APIs"
          value={d ? String(d.owner.apis.total) : null}
          onOpen={() => go(`/${s.application}/apis`)}
          hint={d ? `${d.owner.apis.liveByEnvironment[s.environment] ?? 0} live in ${env}` : undefined}
        />
        <Kpi
          label="Subscriptions"
          value={d ? String(d.consumer.subscriptions.length) : null}
          onOpen={() => go(`/${s.application}/subscriptions`)}
          hint="products this application consumes"
        />
        <Kpi
          label="Changes in progress"
          value={String(inFlight.length)}
          tone={inFlight.length > 0 ? "warn" : undefined}
          onOpen={() => go(`/${s.application}/activity`)}
          hint={inFlight.length > 0 ? "still settling across the gateways" : "everything has converged"}
        />
        <Kpi
          label="Needs attention"
          value={d ? String(attention.length + truncated) : null}
          tone={attention.some((row) => row.severity === "blocker") ? "err" : attention.length ? "warn" : undefined}
          hint={attention.length === 0 ? "nothing is waiting on you" : "listed below"}
        />
      </div>

      <Panel title="Traffic by API">
        {!d ? (
          !data.error && <Skeleton rows={4} />
        ) : d.owner.topApis.length === 0 ? (
          <EmptyState
            title={`No traffic in ${env} over this window`}
            detail="An API that answered nothing in this window has no row. Try a longer window."
            action={
              <Link className="btn sm" to={`/${s.application}/apis`}>
                Open your APIs
              </Link>
            }
          />
        ) : (
          <table className="tbl">
            <thead>
              <tr>
                <th>API</th>
                <th className="num">Requests</th>
                <th className="num">Served</th>
                <th className="num">Refused</th>
                <th className="num">Failed</th>
                <th className="num">p95</th>
              </tr>
            </thead>
            <tbody>
              {d.owner.topApis.map((row) => (
                <tr key={row.resourceId || "unmatched"}>
                  <td>
                    {/* The estate's unmatched traffic has no resource to open, so it is text.
                        Everything else is a link — navigation, so an `<a>` that opens in a new tab
                        like any other — into that API's log lines for this same window. */}
                    {row.resourceId ? (
                      <Link to={trafficDrillHref(s.application, row.resourceId, d.sinceMin)}>
                        {row.name}
                      </Link>
                    ) : (
                      <span className="muted">{row.name}</span>
                    )}
                  </td>
                  <td className="num">{row.requests.toLocaleString()}</td>
                  <td className="num">{row.ok.toLocaleString()}</td>
                  <td className="num">{row.gatewayRejections.toLocaleString()}</td>
                  <td className="num">{row.upstreamErrors.toLocaleString()}</td>
                  <td className="num">{row.p95Ms === null ? "—" : formatDuration(row.p95Ms)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {d?.owner.traffic.truncated && (
          <p className="muted small">
            These figures are a floor: more telemetry matched than this screen scans. Narrow the
            window for exact numbers.
          </p>
        )}
      </Panel>

      {attention.length > 0 && (
        <Panel title="Needs attention">
          <AttentionList
            rows={attention}
            truncated={truncated}
            more="Fixing the ones above usually clears them."
          />
        </Panel>
      )}

      <Panel title="Recent activity">
        <OperationList items={operations.slice(0, 8)} />
      </Panel>
    </>
  );
}

/**
 * The window choice, remembered — or `null` until somebody makes one, so the deployment's default
 * applies.
 *
 * Somebody who works in six-hour windows should not have to reset the control on every visit, and
 * this is a display preference rather than a fact about the estate — so it lives in the browser.
 * Stored as minutes under a new key: the old one held an index into this list, and reading an old
 * `0` as minutes would have asked for an empty window.
 */
function useWindowChoice(): [number | null, (next: number) => void] {
  const [sinceMin, setSinceMin] = useState<number | null>(() => {
    const stored = Number(localStorage.getItem("portal-dashboard-since-min"));
    return WINDOWS.some((entry) => entry.sinceMin === stored) ? stored : null;
  });
  return [
    sinceMin,
    (next) => {
      localStorage.setItem("portal-dashboard-since-min", String(next));
      setSinceMin(next);
    },
  ];
}
function Kpi({
  label,
  value,
  hint,
  tone,
  delta,
  spark,
  onOpen,
}: {
  label: string;
  /** `null` while loading — the card keeps its size so the grid does not jump. */
  value: string | null;
  hint?: string;
  tone?: "ok" | "warn" | "err";
  delta?: ReactNode;
  spark?: ReactNode;
  onOpen?: () => void;
}) {
  const body = (
    <>
      <span className="kpi-label kpi-heading">{label}{onOpen && <span aria-hidden="true"><I.ChevRight size={16} /></span>}</span>
      <div className="kpi-value-row">
        {value === null ? (
          <span className="skl kpi-skl" aria-hidden="true" />
        ) : (
          <span className="kpi-value">{value}</span>
        )}
        {delta}
        {spark && <span className="kpi-spark">{spark}</span>}
      </div>
      {hint && <span className="kpi-label">{hint}</span>}
    </>
  );
  const className = `kpi-card ${tone ? `tone-${tone}` : ""} ${onOpen ? "is-actionable" : ""}`;
  // A card that navigates is a button; one that only reports is not. Making every card clickable
  // would put six tab stops on the page that do nothing.
  return onOpen ? (
    <button className={className} onClick={onOpen}>
      {body}
    </button>
  ) : (
    <div className={className}>{body}</div>
  );
}

/**
 * The change against the same window one step back.
 *
 * `undefined` when the previous window is not available — telemetry retention decides that, not
 * this component — and the card simply omits the line rather than showing a delta against zero.
 * `better` names which direction is good, because "requests up" and "failures up" are not the same
 * news even though they are the same arithmetic.
 */
function delta(
  current: number | undefined,
  previous: number | undefined,
  better: "more" | "fewer",
): ReactNode {
  if (current === undefined || previous === undefined) return null;
  if (previous === 0 && current === 0) return null;
  const change = previous === 0 ? 1 : (current - previous) / previous;
  const up = current >= previous;
  const good = better === "more" ? up : !up;
  const percent = previous === 0 ? "new" : `${Math.abs(Math.round(change * 100))}%`;
  return (
    <span className={`kpi-delta tone-${good ? "ok" : "err"}`}>
      <span className="kpi-delta-arrow">{up ? "▲" : "▼"}</span> {percent}
    </span>
  );
}

/**
 * A 60×20 sparkline of the request series.
 *
 * No axis and no labels on purpose: this is a shape, not a reading. The number beside it is the
 * reading, and anybody who wants the axis has the Traffic table below and the Logs tab under that.
 */
function Sparkline({ series }: { series: Array<{ requests: number }> }) {
  if (series.length < 2) return null;
  const width = 60;
  const height = 20;
  const max = Math.max(...series.map((point) => point.requests), 1);
  const points = series
    .map((point, index) => {
      const x = (index / (series.length - 1)) * width;
      const y = height - (point.requests / max) * (height - 2) - 1;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
      <polyline points={points} fill="none" stroke="currentColor" strokeWidth={1.5} opacity={0.55} />
    </svg>
  );
}
