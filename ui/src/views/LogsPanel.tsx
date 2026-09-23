import { useMemo, useState } from "react";
import {
  api,
  type BodyCapturePage,
  type LogEntry,
  type LogHistogram,
  type LogPage,
} from "../api";
import {
  EmptyState,
  Field,
  Modal,
  Notice,
  Segmented,
  Skeleton,
  StatusChip,
  envLabel,
  useAction,
  useAsync,
  useTicker,
} from "../components";
import { httpStatusChip } from "../lib/status";
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

const RANGES = [
  { value: "15m", label: "15m", minutes: 15 },
  { value: "1h", label: "1h", minutes: 60 },
  { value: "6h", label: "6h", minutes: 360 },
  { value: "24h", label: "24h", minutes: 1440 },
  { value: "7d", label: "7d", minutes: 10080 },
] as const;

const STATUS_FILTERS: Array<{ value: string; label: string }> = [
  { value: "", label: "Any status" },
  { value: "2xx", label: "2xx succeeded" },
  { value: "3xx", label: "3xx redirected" },
  { value: "4xx", label: "4xx refused" },
  { value: "5xx", label: "5xx failed" },
];

const PAGE_SIZE = 50;

/** What "slow" means for the one-click filter: a call a person would have noticed waiting for. */
const SLOW_MS = 1000;

/**
 * Which preset the window is, or `custom` for one somebody typed or dragged. `custom` is not an
 * option of the control, so no preset reads as pressed while the window is something else.
 */
export function rangeOf(window: { from: number; to: number }): string {
  const span = window.to - window.from;
  return RANGES.find((range) => range.minutes * 60_000 === span)?.value ?? "custom";
}

/**
 * The preset a `?sinceMin=` asks for, snapped to the nearest one offered, or 60 when there is none.
 *
 * The dashboard's traffic rows link here with the window they were counted over (dashboard-health,
 * "Make traffic drillable"), and a drill-down that opened on the last hour regardless showed a
 * different set of calls from the number that was clicked. Nearest on a log scale, because the
 * presets are, and a tie goes to the wider one so the calls that were counted are all inside it.
 */
export function initialMinutes(search: string): number {
  const asked = Number(new URLSearchParams(search).get("sinceMin"));
  if (!Number.isFinite(asked) || asked <= 0) return 60;
  let best: number = RANGES[0].minutes;
  for (const range of RANGES) {
    const distance = Math.abs(Math.log(range.minutes / asked));
    const bestDistance = Math.abs(Math.log(best / asked));
    if (distance < bestDistance || (distance === bestDistance && range.minutes > best)) best = range.minutes;
  }
  return best;
}

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
    const minutes = initialMinutes(typeof location === "undefined" ? "" : location.search);
    return { from: to - minutes * 60_000, to };
  });
  const [status, setStatus] = useState("");
  const [method, setMethod] = useState("");
  const [path, setPath] = useState("");
  const [slowOnly, setSlowOnly] = useState(false);
  // Set from a line's detail rather than typed: a subscription id is nothing anybody knows by
  // heart, and "whose calls were these" is always asked about a call already on the screen.
  const [subscriptionId, setSubscriptionId] = useState<string | null>(null);
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
    if (slowOnly) params.set("minDurationMs", String(SLOW_MS));
    if (subscriptionId) params.set("subscriptionId", subscriptionId);
    return params;
  }, [environment, resourceId, window.from, window.to, status, method, path, slowOnly, subscriptionId]);

  const list = useAsync(
    () =>
      canRead
        ? api.get<LogPage>(`/api/logs?${query}&limit=${PAGE_SIZE}&cursor=${cursorOf(offset)}`)
        : Promise.resolve(null),
    [query.toString(), offset, canRead],
    `${query}:${offset}:${canRead}`,
  );
  const chart = useAsync(
    () => (canRead ? api.get<LogHistogram>(`/api/logs/histogram?${query}&buckets=48`) : Promise.resolve(null)),
    [query.toString(), canRead],
    `${query}:${canRead}`,
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
        // What the reader needs is the fact and its consequence. Which variable an operator sets
        // to connect a real index is `request-logs` and the README's business, and a publisher
        // reading this banner cannot set it anyway.
        <Notice kind="warn">
          These request logs are <strong>simulated</strong>: no log index is connected, so this
          traffic is generated from the APIs published here. Nothing below was observed.
        </Notice>
      )}

      <BodyCapture resourceId={resourceId} environment={environment} />

      <div className="filter-bar">
        <Segmented
          label="Time range"
          value={rangeOf(window)}
          onChange={(value) => {
            const range = RANGES.find((entry) => entry.value === value)!;
            retarget(Date.now() - range.minutes * 60_000, Date.now());
          }}
          options={RANGES.map((range) => ({ value: range.value, label: range.label }))}
        />
        <button
          type="button"
          className="btn sm ghost"
          title="Keep the start, move the end of the window to now"
          onClick={() => retarget(window.from, Date.now())}
        >
          Extend to now
        </button>

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

        {/* A checkbox, because it is one: on or off. It was drawn as a fourth range button, which
            read as a sixth window length rather than as a filter. */}
        <label className="check-inline">
          <input
            type="checkbox"
            checked={slowOnly}
            onChange={(event) => {
              setSlowOnly(event.target.checked);
              setOffset(0);
            }}
          />
          Only slow calls ({formatDuration(SLOW_MS)} or more)
        </label>

        {subscriptionId && (
          <span className="chip logs-filter-chip">
            Subscription <span className="mono">{subscriptionId}</span>
            <button
              type="button"
              className="btn sm ghost"
              aria-label="Show every subscription again"
              onClick={() => {
                setSubscriptionId(null);
                setOffset(0);
              }}
            >
              ×
            </button>
          </span>
        )}
      </div>

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
        <Skeleton rows={6} />
      ) : list.error ? null : items.length === 0 ? (
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
                  onSubscription={
                    entry.subscriptionId && entry.subscriptionId !== subscriptionId
                      ? () => {
                          setSubscriptionId(entry.subscriptionId);
                          setOffset(0);
                        }
                      : undefined
                  }
                />
              ))}
            </tbody>
          </table>

          <div className="logs-pager">
            <span className="muted small">
              {page!.total.toLocaleString()}
              {page!.totalIsLowerBound ? "+" : ""} request{page!.total === 1 ? "" : "s"}
              {simulated ? " · simulated" : ""}
            </span>
            <div className="logs-pager-nums">
              <button
                type="button"
                className="btn sm"
                disabled={current === 0}
                onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
              >
                Previous
              </button>
              <span className="logs-pager-gap">
                Page {current + 1} of {Math.max(1, pages)}
              </span>
              <button
                type="button"
                className="btn sm"
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

/**
 * Body capture: an hour in which this API's request and response bodies are written into its log
 * lines as well, for the bug that cannot be reproduced from status codes and timings.
 *
 * The screen's job here is to make the cost visible rather than to make the switch convenient. What
 * it says out loud, every time: bodies go to the same index everybody else reads, the window is an
 * hour and not renewable by accident, only the first 8 KiB is kept, and the row saying you asked
 * outlives the window. The reason is required by the server and the box says why — it is what
 * somebody reads later when they find bodies in the index and want to know who wanted them there.
 *
 * The countdown runs off `expiresAt` rather than off `remainingSec`, and the shell's tick moves it
 * without re-reading the list. `expiresAt` is an absolute instant the server chose and the *gateway*
 * enforces on its own clock; `remainingSec` was only ever that instant minus the moment the response
 * was built. Polling once every tick to watch a number tick down would be a request every three
 * seconds for an hour, to learn something arithmetic already knows.
 *
 * Starting and stopping are two actions with two errors. They shared one, so a refused start was
 * printed twice while its dialog was open — once inside it and once on the page behind.
 */
function BodyCapture({ resourceId, environment }: { resourceId: string; environment: string }) {
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState("");
  const [reload, setReload] = useState(0);
  const tick = useTicker();
  const start = useAction();
  const stop = useAction();

  const windows = useAsync(
    () =>
      api.get<BodyCapturePage>(
        `/api/logs/body-capture?environment=${encodeURIComponent(environment)}` +
          `&resourceId=${encodeURIComponent(resourceId)}`,
      ),
    [resourceId, environment, reload],
  );

  const page = windows.data;
  const found = page?.items.find((item) => item.live) ?? null;
  // Recomputed on the tick, so the banner goes away by itself when the hour is up rather than
  // waiting for somebody to change tabs.
  const remainingMs = useMemo(
    () => (found ? Date.parse(found.expiresAt) - Date.now() : 0),
    [found?.expiresAt, tick],
  );
  const live = remainingMs > 0 ? found : null;
  const kib = page ? Math.round(page.maxBytes / 1024) : 8;
  const minutes = page ? page.maxMinutes : 60;

  return (
    <>
      <Notice kind="error">{windows.error}</Notice>
      <Notice kind="error">{stop.error}</Notice>

      {live ? (
        <Notice kind="warn">
          <strong>Bodies are being captured</strong> for this API in {envLabel(environment)}, for
          another {formatDuration(remainingMs)}. Requested by {live.openedBy}:{" "}
          <em>{live.reason}</em>. The first {kib} KiB of each request and response is written into
          the log index, with credential-shaped fields replaced. Headers never are.{" "}
          <button
            className="btn sm"
            disabled={stop.busy}
            onClick={() =>
              stop
                .run(() => api.del(`/api/logs/body-capture/${live.id}`))
                .then(() => setReload((n) => n + 1))
            }
          >
            Stop capturing
          </button>
        </Notice>
      ) : (
        <div className="filter-bar">
          <span className="muted small">
            Bodies are not logged. Capture them for an hour if you need to see one.
          </span>
          <button className="btn sm" onClick={() => setAsking(true)}>
            Capture bodies for an hour…
          </button>
        </div>
      )}

      {asking && (
        <Modal title="Capture request and response bodies" close={() => setAsking(false)}>
          <p className="hint">
            For {minutes === 60 ? "one hour" : `${minutes} minutes`}, on this API in{" "}
            {envLabel(environment)}, the first {kib} KiB of each request and response body is written
            into its log lines. Anyone who can read this API's traffic can read them. The window
            cannot be extended — opening a second one is a second decision.
          </p>
          <Field
            label="Why"
            hint="At least 20 characters. Name the ticket and the call you are trying to reproduce; this is shown beside the API for as long as the record exists."
          >
            <textarea
              rows={3}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="INC-4471: the order POST returns 400 for one consumer only"
            />
          </Field>
          <Notice kind="error">{start.error}</Notice>
          <div className="native-actions">
            <button className="btn" onClick={() => setAsking(false)}>
              Cancel
            </button>
            <button
              className="btn primary"
              disabled={start.busy || reason.trim().length < 20}
              onClick={async () => {
                const ok = await start.run(() =>
                  api.post("/api/logs/body-capture", {
                    resourceId,
                    environment,
                    reason: reason.trim(),
                  }),
                );
                if (!ok) return;
                setAsking(false);
                setReason("");
                setReload((n) => n + 1);
              }}
            >
              Start capturing
            </button>
            {reason.trim().length < 20 && (
              <span className="action-reason">
                {20 - reason.trim().length} more character{20 - reason.trim().length === 1 ? "" : "s"} of reason needed.
              </span>
            )}
          </div>
        </Modal>
      )}
    </>
  );
}

function cursorOf(offset: number): string {
  return offset === 0 ? "" : btoa(String(offset)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function Row({
  entry,
  open,
  onToggle,
  onSubscription,
}: {
  entry: LogEntry;
  open: boolean;
  onToggle: () => void;
  /** Narrow the table to this line's subscription; absent when it has none or already is. */
  onSubscription?: () => void;
}) {
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
          <StatusChip chip={httpStatusChip(entry.status, { durationMs: entry.durationMs })} />
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
                {onSubscription && (
                  <button type="button" className="btn sm" onClick={onSubscription}>
                    Only this subscription's calls
                  </button>
                )}
              </section>
              <section className="log-detail-section">
                <div className="title">Served by</div>
                <div className="kv-list compact">
                  <Kv k="Environment" v={envLabel(entry.environment)} />
                  <Kv k="Gateway" v={entry.gateway} />
                  <Kv k="Instance" v={entry.instance ?? "not recorded"} />
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
      aria-invalid={parsed === undefined ? true : undefined}
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
