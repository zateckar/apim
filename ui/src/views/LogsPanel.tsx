import { useMemo, useState } from "react";
import { api, type LogEntry, type LogHistogram, type LogPage } from "../api";
import { EmptyState, Notice, useAsync } from "../components";
import { formatDateTime, formatDuration, toDateTimeInput, fromDateTimeInput } from "../lib/datetime";
import { LogsHistogram } from "./LogsHistogram";

/**
 * Per-request logs for one API in one environment.
 *
 * The control plane does not store these; it reads them from the log index and says which index
 * answered. When that index is the simulated one, the banner at the top of this panel says so in
 * words — a screen of plausible request lines that nobody observed is worse than an empty screen,
 * because it looks like evidence.
 *
 * The window is owned here and pushed into both reads, so the timeline and the table can never
 * describe different ranges. Everything else is a filter, and every filter narrows: there is no
 * control on this panel that can widen the set beyond what the caller may read, because the
 * server decides that from the session before a query exists.
 */

const RANGES: Array<{ label: string; minutes: number }> = [
  { label: "15m", minutes: 15 },
  { label: "1h", minutes: 60 },
  { label: "6h", minutes: 360 },
  { label: "24h", minutes: 1440 },
  { label: "7d", minutes: 10080 },
];

const STATUS_FILTERS: Array<{ value: string; label: string }> = [
  { value: "", label: "Any status" },
  { value: "2xx", label: "2xx succeeded" },
  { value: "3xx", label: "3xx redirected" },
  { value: "4xx", label: "4xx refused" },
  { value: "5xx", label: "5xx failed" },
];

const PAGE_SIZE = 50;

export function LogsPanel({
  resourceId,
  environment,
  canRead,
  reason,
}: {
  resourceId: string;
  environment: string;
  /** False for somebody who may see the API but not its traffic. */
  canRead: boolean;
  reason?: string | null;
}) {
  // An explicit window, not a moving one: a page that silently re-anchored to "now" on every
  // reload would renumber the rows under somebody who is reading them.
  const [window, setWindow] = useState(() => {
    const to = Date.now();
    return { from: to - 60 * 60_000, to };
  });
  const [status, setStatus] = useState("");
  const [method, setMethod] = useState("");
  const [path, setPath] = useState("");
  const [slowOnly, setSlowOnly] = useState(false);
  const [offset, setOffset] = useState(0);
  const [expanded, setExpanded] = useState<string | null>(null);

  const query = useMemo(() => {
    const params = new URLSearchParams({
      environment,
      resourceId,
      from: new Date(window.from).toISOString(),
      to: new Date(window.to).toISOString(),
    });
    if (status) params.set("status", status);
    if (method) params.set("method", method);
    if (path.trim()) params.set("path", path.trim());
    if (slowOnly) params.set("minDurationMs", "1000");
    return params;
  }, [environment, resourceId, window.from, window.to, status, method, path, slowOnly]);

  const list = useAsync(
    () =>
      canRead
        ? api.get<LogPage>(`/api/logs?${query}&limit=${PAGE_SIZE}&cursor=${cursorOf(offset)}`)
        : Promise.resolve(null),
    [query.toString(), offset, canRead],
  );
  const chart = useAsync(
    () => (canRead ? api.get<LogHistogram>(`/api/logs/histogram?${query}&buckets=48`) : Promise.resolve(null)),
    [query.toString(), canRead],
  );

  function retarget(from: number, to: number) {
    setWindow({ from, to });
    setOffset(0);
  }

  if (!canRead) {
    return (
      <EmptyState
        title="Request logs are the publisher's view"
        detail={
          reason ??
          "An access line carries the backend's latency and its error text, which belong to the " +
            "application that publishes this API. Ask its owners if you need one."
        }
        action={null}
      />
    );
  }

  const page = list.data;
  const simulated = page?.simulated ?? chart.data?.simulated ?? false;
  const items = page?.items ?? [];
  const pages = page ? Math.ceil(page.total / PAGE_SIZE) : 0;
  const current = Math.floor(offset / PAGE_SIZE);

  return (
    <div className="logs-panel">
      {simulated && (
        <Notice kind="warn">
          These request logs are <strong>simulated</strong>. This deployment has no log index
          configured, so the control plane generates deterministic traffic from the APIs that are
          actually published here. Nothing below is an observation. Set <code>LOGS_PROVIDER=elk</code>{" "}
          with <code>ELK_URL</code> to read the real index.
        </Notice>
      )}

      <div className="filter-bar">
        <div className="uptime-range" role="group" aria-label="Time range">
          {RANGES.map((range) => {
            const active = window.to - window.from === range.minutes * 60_000;
            return (
              <button
                key={range.label}
                className={`uptime-range-btn${active ? " active" : ""}`}
                aria-pressed={active}
                onClick={() => retarget(Date.now() - range.minutes * 60_000, Date.now())}
              >
                {range.label}
              </button>
            );
          })}
          <button className="uptime-range-btn" onClick={() => retarget(window.from, Date.now())}>
            Now
          </button>
        </div>

        <div className="logs-range-inputs">
          <RangeInput label="From" value={window.from} onCommit={(ms) => retarget(ms, window.to)} />
          <span aria-hidden="true">→</span>
          <RangeInput label="To" value={window.to} onCommit={(ms) => retarget(window.from, ms)} />
        </div>

        <label className="sr-only" htmlFor="logs-status">
          Status
        </label>
        <select
          id="logs-status"
          className="owner-filter"
          value={status}
          onChange={(event) => {
            setStatus(event.target.value);
            setOffset(0);
          }}
        >
          {STATUS_FILTERS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>

        <label className="sr-only" htmlFor="logs-method">
          Method
        </label>
        <select
          id="logs-method"
          className="owner-filter"
          value={method}
          onChange={(event) => {
            setMethod(event.target.value);
            setOffset(0);
          }}
        >
          <option value="">Any method</option>
          {["GET", "POST", "PUT", "PATCH", "DELETE"].map((verb) => (
            <option key={verb} value={verb}>
              {verb}
            </option>
          ))}
        </select>

        <div className="search">
          <input
            aria-label="Filter by path"
            placeholder="Path contains…"
            value={path}
            onChange={(event) => {
              setPath(event.target.value);
              setOffset(0);
            }}
          />
        </div>

        <button
          className={`uptime-range-btn${slowOnly ? " active" : ""}`}
          aria-pressed={slowOnly}
          onClick={() => {
            setSlowOnly(!slowOnly);
            setOffset(0);
          }}
          title="Only calls that took a second or more"
        >
          Slow only
        </button>
      </div>

      <Notice kind="error">{chart.error}</Notice>
      <LogsHistogram
        data={chart.data}
        loading={chart.loading}
        error={chart.error}
        onSelectRange={retarget}
        onZoomOut={() => {
          const span = window.to - window.from;
          retarget(window.from - span / 2, window.to + span / 2);
        }}
      />

      <Notice kind="error">{list.error}</Notice>

      {list.loading && !page ? (
        <p className="muted">Loading request logs…</p>
      ) : items.length === 0 ? (
        <EmptyState
          title="No requests in this window"
          detail="Nothing matched. Widen the range, clear a filter, or call the API from the Playground tab and look again."
          action={
            <button className="btn" onClick={() => retarget(Date.now() - 24 * 3600_000, Date.now())}>
              Look at the last 24 hours
            </button>
          }
        />
      ) : (
        <>
          <table className="logs-table">
            <thead>
              <tr>
                <th scope="col" aria-label="Expand" />
                <th scope="col">When</th>
                <th scope="col">Method</th>
                <th scope="col">Path</th>
                <th scope="col">Status</th>
                <th scope="col">Took</th>
                <th scope="col">Consumer</th>
              </tr>
            </thead>
            <tbody>
              {items.map((entry) => (
                <Row
                  key={entry.id}
                  entry={entry}
                  open={expanded === entry.id}
                  onToggle={() => setExpanded(expanded === entry.id ? null : entry.id)}
                />
              ))}
            </tbody>
          </table>

          <div className="logs-pager">
            <span className="muted small">
              {page!.total.toLocaleString()}
              {page!.totalIsLowerBound ? "+" : ""} request{page!.total === 1 ? "" : "s"} ·{" "}
              {page!.provider === "mock" ? "simulated index" : "log index"}
            </span>
            <div className="logs-pager-nums">
              <button
                className="logs-pager-num"
                disabled={current === 0}
                onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
              >
                Previous
              </button>
              <span className="logs-pager-gap">
                page {current + 1} of {Math.max(1, pages)}
              </span>
              <button
                className="logs-pager-num"
                disabled={!page!.nextCursor}
                onClick={() => setOffset(offset + PAGE_SIZE)}
              >
                Next
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function cursorOf(offset: number): string {
  return offset === 0 ? "" : btoa(String(offset)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

/**
 * The status class as one of `lib/status.ts`'s six tone words, so the table never writes a colour
 * of its own and a 5xx here is the same red as a failed release everywhere else.
 */
function toneOf(status: number): string {
  if (status >= 500) return "stop";
  if (status >= 400) return "warn";
  if (status >= 300) return "neutral";
  return "live";
}

function Row({ entry, open, onToggle }: { entry: LogEntry; open: boolean; onToggle: () => void }) {
  return (
    <>
      <tr>
        <td>
          <button
            className="log-expand-btn"
            aria-expanded={open}
            aria-label={open ? "Hide request detail" : "Show request detail"}
            onClick={onToggle}
          >
            {open ? "−" : "+"}
          </button>
        </td>
        <td className="mono" title={entry.at}>
          {formatDateTime(entry.at)}
        </td>
        <td className="mono">{entry.method}</td>
        <td className="mono">{entry.path}</td>
        <td>
          <span className={`chip-status tone-${toneOf(entry.status)}`}>{entry.status}</span>
        </td>
        <td className="mono">{formatDuration(entry.durationMs)}</td>
        <td>{entry.consumerApplicationId ?? <span className="muted">—</span>}</td>
      </tr>
      {open && (
        <tr className="log-detail-row">
          <td colSpan={7}>
            <div className="log-detail-sections">
              <section className="log-detail-section">
                <div className="title">Request</div>
                <div className="kv-list compact">
                  <Kv k="Request id" v={entry.requestId} />
                  <Kv k="Operation" v={entry.operationId ?? "no operation matched"} />
                  <Kv k="Client" v={entry.clientIp ?? "not recorded"} />
                  <Kv k="Subscription" v={entry.subscriptionId ?? "none — refused before matching"} />
                </div>
              </section>
              <section className="log-detail-section">
                <div className="title">Served by</div>
                <div className="kv-list compact">
                  <Kv k="Environment" v={entry.environment.toUpperCase()} />
                  <Kv k="Gateway" v={entry.gateway} />
                  <Kv k="Replica" v={entry.instance ?? "not recorded"} />
                  <Kv k="Upstream took" v={formatDuration(entry.backendMs)} />
                </div>
              </section>
              {entry.error && (
                <section className="log-detail-section error">
                  <div className="title">Why it failed</div>
                  <div className="kv-list compact">
                    <Kv k="Reason" v={entry.error} />
                  </div>
                </section>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function Kv({ k, v }: { k: string; v: string }) {
  return (
    <div className="kv">
      <span className="k">{k}</span>
      <span className="v">{v}</span>
    </div>
  );
}

/**
 * A typed boundary of the window. Committed on blur or Enter rather than on every keystroke, and
 * an unparseable value is marked rather than swallowed — a date field that silently ignored what
 * was typed would look like the query was wrong.
 */
function RangeInput({
  label,
  value,
  onCommit,
}: {
  label: string;
  value: number;
  onCommit: (ms: number) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const text = draft ?? toDateTimeInput(value);
  const parsed = fromDateTimeInput(text);
  return (
    <input
      aria-label={label}
      className={parsed === undefined ? "invalid" : undefined}
      value={text}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => {
        if (parsed !== undefined) onCommit(parsed);
        setDraft(null);
      }}
      onKeyDown={(event) => {
        if (event.key !== "Enter") return;
        if (parsed !== undefined) onCommit(parsed);
        setDraft(null);
      }}
    />
  );
}
