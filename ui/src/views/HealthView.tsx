import { useEffect, useMemo, useState } from "react";
import {
  api,
  type HealthItem,
  type HealthSnapshot,
  type SyntheticsBucket,
  type SyntheticsMonitor,
  type SyntheticsSnapshot,
  type User,
} from "../api";
import { EmptyState, Link, Notice, Panel, Skeleton, useAsync } from "../components";
import { formatAgo, formatDateTime, formatDateTimeShort } from "../lib/datetime";
import { SyntheticsChart } from "./SyntheticsChart";

/**
 * Health Status — is the estate up, which part of it is not, and has it been.
 *
 * Three layers, in the order somebody reads them under pressure.
 *
 *  1. **The hero.** One verdict per environment, biggest thing on the page, with the failing
 *     components listed underneath it. Somebody who has just been paged needs the environment
 *     name and the word, and nothing else.
 *  2. **Gateway uptime.** Availability strips and response time over a window, which is the
 *     question "is this new" — a component that is down now and was down all night is a different
 *     incident from one that has been flapping since a deploy.
 *  3. **The component matrix.** Every probe with its latency, its age and its failure text.
 *
 * Open to everybody, not just administrators. Which environment is healthy is what decides whether
 * a publisher promotes this afternoon, and a screen only admins can read makes them ask in chat.
 * The one thing that is admin-only is a failed check's *error text*, which quotes internal hosts —
 * and that gate is on the server, where it belongs.
 */

const RANGES = ["1h", "6h", "24h", "48h"] as const;

/** The verdict vocabulary, and the tone class each one wears. Closed, and shared with the CSS. */
const VERDICTS = {
  healthy: { label: "Healthy", tone: "ok" },
  degraded: { label: "Degraded", tone: "warn" },
  down: { label: "Down", tone: "err" },
  unknown: { label: "Not deployed", tone: "unknown" },
} as const;

const STATUS_TONE = { up: "ok", down: "err", disabled: "unknown" } as const;

/**
 * How components are grouped in the matrix. Order matters: the estate's own moving parts first,
 * then what it depends on. `null` collects everything a group did not claim, so a probe added later
 * shows up somewhere rather than vanishing.
 */
const GROUPS: Array<{ title: string; kinds: HealthItem["kind"][] }> = [
  { title: "Gateways", kinds: ["fleet", "gateway"] },
  { title: "Platform", kinds: ["control-plane", "database"] },
  { title: "External systems", kinds: ["log-index", "integration"] },
];

/** Latency worth flagging. A gateway answering in over a second is not down, and is not fine. */
function latencyTone(ms: number): string {
  if (ms >= 1000) return "err";
  if (ms >= 300) return "warn";
  return "ok";
}

export function HealthView({ user }: { user: User }) {
  const [refreshing, setRefreshing] = useState(false);
  const [tick, setTick] = useState(0);
  const health = useAsync(
    () => api.get<HealthSnapshot>(`/api/health/uptime${refreshing ? "?refresh=1" : ""}`),
    [tick],
  );
  const snapshot = health.data;

  // The server owns the cadence — it knows how often its own probes run, and a browser that polled
  // faster would only ever re-read the same snapshot.
  const intervalMs = snapshot?.intervalMs ?? 30_000;
  useEffect(() => {
    const timer = setInterval(() => setTick((value) => value + 1), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);

  async function refresh() {
    setRefreshing(true);
    setTick((value) => value + 1);
    // Cleared on the next paint rather than awaited: `useAsync` owns the request, and the flag only
    // decides which URL the *next* fetch uses.
    setTimeout(() => setRefreshing(false), 0);
  }

  const items = snapshot?.items ?? [];
  const claimed = new Set(GROUPS.flatMap((group) => group.kinds));

  return (
    <div className="health-overview">
      <div className="page-actions health-toolbar">
        <div className="native-actions"><Link to="/telemetry">Traffic &amp; errors →</Link>{user.isAdmin && <Link to="/gateways">Manage gateways →</Link>}</div>
        <button className="btn" onClick={() => void refresh()} disabled={health.loading}>
          {health.loading ? "Probing…" : "Refresh"}
        </button>
      </div>

      {health.error && <Notice kind="error">{health.error}</Notice>}

      <div className="health-hero">
        {(snapshot?.environments ?? []).map((rollup) => {
          const verdict = VERDICTS[rollup.status];
          const probeable = rollup.up + rollup.down;
          return (
            <div key={rollup.environment} className={`health-env-card ${verdict.tone}`}>
              <div className="env-tag">{rollup.environment.toUpperCase()}</div>
              <div className="health-env-verdict">
                <div className={`pulse ${verdict.tone}`} />
                <span className="v">{verdict.label}</span>
              </div>
              <div className="health-env-meta">
                {rollup.status === "unknown"
                  ? "No gateway has been registered here yet"
                  : `${rollup.up}/${probeable} components up${rollup.disabled ? ` · ${rollup.disabled} not configured` : ""}`}
              </div>
              {rollup.impact.length > 0 && (
                <ul className="health-impact">
                  {rollup.impact.map((label) => (
                    <li key={label}>{label} is not answering</li>
                  ))}
                </ul>
              )}
            </div>
          );
        })}
      </div>

      {health.loading && !snapshot && <Skeleton rows={3} />}

      <Synthetics admin={user.isAdmin} />

      {snapshot && (
        /* One panel, four sections. The groups were four cards in a row of cards, which made the
           page read as four separate subjects when it is one — every probe the control plane ran,
           sorted. A nested card renders as a heading and a rule (see `brand.css`), so the grouping
           survives and the boxes do not. */
        <Panel title="Components" className="health-detail">
          {GROUPS.map((group) => (
            <ComponentGroup
              key={group.title}
              title={group.title}
              items={items.filter((item) => group.kinds.includes(item.kind))}
            />
          ))}
          <ComponentGroup
            title="Other"
            items={items.filter((item) => !claimed.has(item.kind))}
          />
          <p className="muted small">
            Probed on the control plane's own timers; this page reads the latest result rather than
            starting a check. Last assembled {formatDateTime(snapshot.generatedAt)}.
          </p>
        </Panel>
      )}
    </div>
  );
}

function ComponentGroup({ title, items }: { title: string; items: HealthItem[] }) {
  if (items.length === 0) return null;
  return (
    <Panel title={title} className="health-group">
      <div className="health-rows">
          {items.map((item) => {
            const tone = STATUS_TONE[item.status];
            return (
              <div key={item.id} className="health-row" title={item.message ?? ""}>
                <div className={`health-status ${tone}`}>
                  <div className={`pulse ${tone}`} />
                  <span className="s">{item.status.toUpperCase()}</span>
                </div>
                <div className="health-label">
                  {item.tag && <span className={`health-tag ${tagClass(item.tag)}`}>{item.tag}</span>}
                  {item.label}
                </div>
                <div className="health-row-meta">
                  {item.status === "up" ? (
                    item.latencyMs !== null ? (
                      <span className={`lat ${latencyTone(item.latencyMs)}`}>{item.latencyMs}ms</span>
                    ) : (
                      (item.message ?? "—")
                    )
                  ) : (
                    <span className="err-msg">{item.message ?? item.status.toUpperCase()}</span>
                  )}
                  <span className="t"> · {formatAgo(item.checkedAt)}</span>
                </div>
              </div>
            );
          })}
      </div>
    </Panel>
  );
}

/** The tag's own class, so `Simulated` and `HTTPS` do not read as the same kind of fact. */
function tagClass(tag: string): string {
  if (tag === "Simulated") return "nocert";
  if (tag === "Local" || tag === "Reported") return "local";
  return "mtls";
}

function Synthetics({ admin }: { admin: boolean }) {
  const [range, setRange] = useState<(typeof RANGES)[number]>("24h");
  const [environment, setEnvironment] = useState<string | null>(null);
  const history = useAsync(
    () => api.get<SyntheticsSnapshot>(`/api/health/synthetics?range=${range}`),
    [range],
    range,
  );
  const snapshot = history.data;
  const groups = useMemo(() => snapshot?.environments ?? [], [snapshot]);
  // The chain's first environment until somebody chooses, and re-derived when the list arrives so
  // an estate whose first stage has no gateway does not open on an empty tab.
  const selected = groups.find((group) => group.environment === environment) ?? groups[0] ?? null;

  return (
    <Panel
      title="Gateway uptime"
      className="synthetics-panel"
      actions={
        <div className="synthetics-controls">
          <div className="tabs flat synthetics-env-tabs" role="group" aria-label="Environment">
            {groups.map((group) => (
              <button
                key={group.environment}
                className={`tab ${selected?.environment === group.environment ? "active" : ""}`}
                aria-pressed={selected?.environment === group.environment}
                onClick={() => setEnvironment(group.environment)}
              >
                {group.environment.toUpperCase()}
              </button>
            ))}
          </div>
          <div className="uptime-range" role="group" aria-label="Time range">
            {RANGES.map((value) => (
              <button
                key={value}
                className={`uptime-range-btn ${range === value ? "active" : ""}`}
                aria-pressed={range === value}
                onClick={() => setRange(value)}
              >
                {value}
              </button>
            ))}
          </div>
        </div>
      }
    >
      {history.error && <Notice kind="error">{history.error}</Notice>}
        {snapshot?.simulated && (
          <Notice kind="warn">
            These strips are <strong>simulated</strong>. Nothing was checked — the history is
            generated from the gateways that are registered. Set <code>LOGS_PROVIDER=elk</code> with{" "}
            <code>ELK_URL</code> to read the real uptime index.
          </Notice>
        )}
        {!selected ? (
          history.loading ? (
            <Skeleton rows={2} />
          ) : (
            <EmptyState
              title="No gateway is registered in any environment yet"
              detail="An uptime strip is drawn per gateway, so there is nothing to draw until one exists. A gateway is added, given a hostname and issued a replica token on the Gateways screen."
              action={<Link to="/gateways">Add a gateway →</Link>}
            />
          )
        ) : selected.monitors.length === 0 ? (
          <EmptyState
            title={`No monitor in ${selected.environment.toUpperCase()}`}
            detail="Every gateway registered in this environment gets a monitor. This environment has one registered and nothing watching it yet."
            action={<Link to="/gateways">Open Gateways →</Link>}
          />
        ) : (
          <div className="uptime-bars">
            {selected.monitors.map((monitor) => (
              <UptimeRow key={monitor.id} monitor={monitor} admin={admin} />
            ))}
          </div>
        )}
    </Panel>
  );
}

function UptimeRow({ monitor, admin }: { monitor: SyntheticsMonitor; admin: boolean }) {
  const durations = monitor.buckets
    .map((bucket) => bucket.avgDurationMs)
    .filter((value): value is number => value !== null);
  const stats =
    durations.length === 0
      ? null
      : {
          avg: Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length),
          peak: Math.max(...durations),
        };
  return (
    <div className="uptime-row">
      <div className="uptime-row-head">
        <span className="uptime-name" title={monitor.host ? `${monitor.name} — ${monitor.host}` : monitor.name}>
          {monitor.host ?? monitor.name}
        </span>
        {monitor.availability !== null && (
          <span className="uptime-stats">{(monitor.availability * 100).toFixed(2)}% up</span>
        )}
        {stats && (
          <span className="uptime-stats">
            avg {stats.avg} ms · peak {stats.peak} ms
          </span>
        )}
      </div>
      <div className="uptime-surface">
        <div className="uptime-strip">
          {monitor.buckets.map((bucket) => (
            <span
              key={bucket.at}
              className={`uptime-mark ${bucket.status}`}
              title={markTitle(monitor, bucket, admin)}
            />
          ))}
        </div>
        <SyntheticsChart monitorId={monitor.id} buckets={monitor.buckets} />
      </div>
    </div>
  );
}

/**
 * One mark's tooltip. `empty` says "no data" rather than a count, because the difference between
 * "nobody checked" and "every check passed" is the one thing a grey mark has to convey.
 */
function markTitle(monitor: SyntheticsMonitor, bucket: SyntheticsBucket, admin: boolean): string {
  const time = formatDateTimeShort(bucket.at);
  if (bucket.status === "empty") return `${time} — no data`;
  const base =
    bucket.status === "down"
      ? `${time} — ${bucket.down}/${bucket.total} checks failed`
      : `${time} — all ${bucket.total} checks up`;
  const extra: string[] = [];
  if (bucket.avgDurationMs !== null) extra.push(`avg response ${bucket.avgDurationMs} ms`);
  if (admin && bucket.status === "down" && monitor.lastError) extra.push(monitor.lastError);
  return extra.length > 0 ? `${base}\n${extra.join("\n")}` : base;
}
