import { useState, type ReactNode } from "react";
import type { Session } from "../App";
import { api, type AttentionRow, type Dashboard } from "../api";
import {
  EmptyState,
  Notice,
  OperationList,
  Panel,
  Skeleton,
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

/** The window the KPIs describe. Anything wider is the Telemetry screen's job. */
const WINDOWS = [
  { label: "1h", sinceMin: 60 },
  { label: "6h", sinceMin: 360 },
  { label: "24h", sinceMin: 1440 },
] as const;

export function Dashboard({
  session: s,
  operations,
  tick,
}: {
  session: Session;
  operations: any[];
  tick: number;
}) {
  const [windowIndex, setWindowIndex] = useWindowChoice();
  const sinceMin = WINDOWS[windowIndex]!.sinceMin;
  const data = useAsync(
    () =>
      api.get<Dashboard>(
        `/api/dashboard?applicationId=${encodeURIComponent(s.application)}&environment=${encodeURIComponent(s.environment)}&sinceMin=${sinceMin}`,
      ),
    [s.environment, sinceMin, s.application, tick],
  );
  const d = data.data;
  const traffic = d?.owner.traffic;
  const previous = traffic?.previous ?? null;
  const inFlight = operations.filter((row) => !["complete", "superseded"].includes(row.state));

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

      {d?.startHere && d.startHere.length > 0 && (
        <Panel title="Start here">
          <div className="native-list">
            {d.startHere.map((row) => (
              <AttentionRowView key={`${row.code}:${row.subject.id}`} row={row} />
            ))}
          </div>
        </Panel>
      )}

      <div className="page-toolbar">
        <h2>Traffic overview</h2>
        <div className="uptime-range" role="group" aria-label="Window">
          {WINDOWS.map((entry, index) => (
            <button
              key={entry.label}
              className={`uptime-range-btn ${index === windowIndex ? "active" : ""}`}
              aria-pressed={index === windowIndex}
              onClick={() => setWindowIndex(index)}
            >
              {entry.label}
            </button>
          ))}
        </div>
      </div>
      <div className="kpi-row">
        <Kpi
          label={`Requests · last ${WINDOWS[windowIndex]!.label}`}
          value={traffic ? traffic.requests.toLocaleString() : null}
          delta={delta(traffic?.requests, previous?.requests, "more")}
          spark={<Sparkline series={traffic?.series ?? []} />}
          onOpen={() => go(`/${s.application}/apis`)}
          hint={`in ${s.environment.toUpperCase()}`}
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
          hint={traffic?.approximate ? "approximate — from bucketed histograms" : "over the window"}
        />
      </div>

      <div className="kpi-row">
        <Kpi
          label="Published APIs"
          value={d ? String(d.owner.apis.total) : null}
          onOpen={() => go(`/${s.application}/apis`)}
          hint={
            d
              ? `${d.owner.apis.liveByEnvironment[s.environment] ?? 0} live in ${s.environment.toUpperCase()}`
              : undefined
          }
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
          <Skeleton rows={4} />
        ) : d.owner.topApis.length === 0 ? (
          <EmptyState
            title={`No traffic in ${s.environment.toUpperCase()} over this window`}
            detail="The gateways report what they served every minute, so an API that answered nothing in this window has no row. A longer window is one click above."
            action={
              <button className="btn sm" onClick={() => go(`/${s.application}/apis`)}>
                Open your APIs
              </button>
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
                        Everything else drills into that API's own log lines for this window. */}
                    {row.resourceId ? (
                      <button
                        className="linklike"
                        onClick={() => go(`/${s.application}/apis/${row.resourceId}?tab=logs`)}
                      >
                        {row.name}
                      </button>
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
            More telemetry rows matched than this screen scans, so these figures are a floor.
            Narrow the window for exact numbers.
          </p>
        )}
      </Panel>

      {attention.length > 0 && (
        <Panel title="Needs attention">
          <div className="native-list">
            {attention.map((row) => (
              <AttentionRowView key={`${row.code}:${row.subject.id}:${row.environment ?? ""}`} row={row} />
            ))}
          </div>
          {truncated > 0 && (
            <p className="muted small">
              {truncated} more not listed. Fixing the ones above usually clears them.
            </p>
          )}
        </Panel>
      )}

      <Panel title="Recent activity">
        <OperationList items={operations.slice(0, 8)} />
      </Panel>
    </>
  );
}

/**
 * The window choice, remembered.
 *
 * Somebody who works in six-hour windows should not have to reset the control on every visit, and
 * this is a display preference rather than a fact about the estate — so it lives in the browser.
 */
function useWindowChoice(): [number, (next: number) => void] {
  const [index, setIndex] = useState(() => {
    const stored = Number(localStorage.getItem("portal-dashboard-window"));
    return Number.isInteger(stored) && stored >= 0 && stored < WINDOWS.length ? stored : 0;
  });
  return [
    index,
    (next) => {
      localStorage.setItem("portal-dashboard-window", String(next));
      setIndex(next);
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
      <span className="kpi-label">{label}</span>
      <div className="kpi-value-row">
        {value === null ? (
          <span className="skl" style={{ width: 64, height: 28 }} aria-hidden="true" />
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

function AttentionRowView({ row }: { row: AttentionRow }) {
  const tone = row.severity === "blocker" ? "err" : row.severity === "warning" ? "warn" : "neutral";
  return (
    <div className="native-row">
      <div>
        <strong>
          {row.subject.name}
          {row.environment ? ` · ${row.environment.toUpperCase()}` : ""}
        </strong>
        <small>{row.detail}</small>
      </div>
      <div className="native-actions">
        {/* A bare `chip` is the neutral variant; `info` has no colour of its own for a reason. */}
        <span className={`chip ${tone === "neutral" ? "" : tone}`}>{row.severity}</span>
        <button className="btn sm" onClick={() => go(row.href)}>
          <I.ChevRight size={13} /> Fix
        </button>
      </div>
    </div>
  );
}
