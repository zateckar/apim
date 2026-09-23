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
import { EmptyState, envLabel, Link, Notice, Panel, Segmented, Skeleton, useAsync } from "../components";
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
 *
 * What the page *offers* follows the reader, though: Telemetry, Gateways and the log provider's
 * configuration are an administrator's, so a member is not handed a link that ends in "this screen
 * is for administrators" or told to set a variable on a host they cannot reach.
 */

const RANGES = [
  { value: "1h", label: "1 h" },
  { value: "6h", label: "6 h" },
  { value: "24h", label: "24 h" },
  { value: "48h", label: "48 h" },
] as const;
type Range = (typeof RANGES)[number]["value"];

/** The status word each probe wears, in the hero's vocabulary: `disabled` is "not configured". */
const STATUS_LABEL = { up: "Up", down: "Down", disabled: "Not configured" } as const;

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
        {/* Both destinations are administrators' screens; a member has nowhere to go from here but
            the page itself. */}
        <div className="native-actions">
          {user.isAdmin && (
            <>
              <Link className="btn ghost" to="/telemetry">Traffic &amp; errors →</Link>
              <Link className="btn ghost" to="/gateways">Manage gateways →</Link>
            </>
          )}
        </div>
        <button className="btn" onClick={() => void refresh()} disabled={health.loading}>
          {health.loading ? "Probing…" : "Refresh"}
        </button>
      </div>

      <Notice kind="error">{health.error}</Notice>

      <div className="health-hero">
        {(snapshot?.environments ?? []).map((rollup) => {
          const verdict = VERDICTS[rollup.status];
          const probeable = rollup.up + rollup.down;
          return (
            <div key={rollup.environment} className={`health-env-card ${verdict.tone}`}>
              <div className="env-tag">{envLabel(rollup.environment)}</div>
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

      <Synthetics
        admin={user.isAdmin}
        chain={(snapshot?.environments ?? []).map((rollup) => rollup.environment)}
      />

      {snapshot && (
        /* One panel, four sections. The groups were four cards in a row of cards, which made the
           page read as four separate subjects when it is one — every probe the control plane ran,
           sorted. Each group is a section with a heading and a rule, not a panel inside a panel. */
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
            Each row is its check's latest result, as of {formatDateTime(snapshot.generatedAt)}.
            Refresh asks for a new round.
          </p>
        </Panel>
      )}
    </div>
  );
}

function ComponentGroup({ title, items }: { title: string; items: HealthItem[] }) {
  if (items.length === 0) return null;
  return (
    <section className="workspace-section health-group">
      <h4>{title}</h4>
      <div className="health-rows">
          {items.map((item) => {
            const tone = STATUS_TONE[item.status];
            return (
              <div key={item.id} className="health-row" title={item.message ?? ""}>
                <div className={`health-status ${tone}`}>
                  <div className={`pulse ${tone}`} />
                  <span className="s">{STATUS_LABEL[item.status]}</span>
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
                    <span className="err-msg">{item.message ?? STATUS_LABEL[item.status]}</span>
                  )}
                  <span className="t"> · {formatAgo(item.checkedAt)}</span>
                </div>
              </div>
            );
          })}
      </div>
    </section>
  );
}

/** The tag's own class, so `Simulated` and `HTTPS` do not read as the same kind of fact. */
function tagClass(tag: string): string {
  if (tag === "Simulated") return "nocert";
  if (tag === "Local" || tag === "Reported") return "local";
  return "mtls";
}

/**
 * The uptime strips, one environment at a time.
 *
 * Its two choices are the shared `Segmented` rather than a tab strip and a hand-rolled button row,
 * which were two looks for the same kind of control inside one panel head. Every stage of the chain
 * is offered, and one with no gateway is disabled with the reason under the control: dropping it
 * made an estate with two gateways read as an estate with two environments.
 */
function Synthetics({ admin, chain }: { admin: boolean; chain: string[] }) {
  const [range, setRange] = useState<Range>("24h");
  const [environment, setEnvironment] = useState<string | null>(null);
  const history = useAsync(
    () => api.get<SyntheticsSnapshot>(`/api/health/synthetics?range=${range}`),
    [range],
    range,
  );
  const snapshot = history.data;
  const groups = useMemo(() => snapshot?.environments ?? [], [snapshot]);
  // The chain's first environment with a gateway until somebody chooses, and re-derived when the
  // list arrives so an estate whose first stage has no gateway does not open on an empty strip.
  const selected = groups.find((group) => group.environment === environment) ?? groups[0] ?? null;
  // The hero's list is the chain; until it arrives, the stages the history knows about.
  const stages = chain.length > 0 ? chain : groups.map((group) => group.environment);

  return (
    <Panel
      title="Gateway uptime"
      className="synthetics-panel"
      actions={
        <div className="synthetics-controls">
          {selected && (
            <Segmented
              label="Environment"
              value={selected.environment}
              onChange={setEnvironment}
              options={stages.map((stage) => {
                const watched = groups.some((group) => group.environment === stage);
                return {
                  value: stage,
                  label: envLabel(stage),
                  disabled: !watched,
                  reason: watched ? undefined : `${envLabel(stage)} has no gateway to watch.`,
                };
              })}
            />
          )}
          <Segmented
            label="Time range"
            value={range}
            onChange={setRange}
            options={RANGES.map((option) => ({ value: option.value, label: option.label }))}
          />
        </div>
      }
    >
      <Notice kind="error">{history.error}</Notice>
      {snapshot?.simulated && (
        <Notice kind="warn">
          These strips are <strong>simulated</strong>: nothing was checked, and the history is
          generated from the registered gateways.
          {/* The fix is a variable on the control plane's host, which only an administrator can
              act on; a member told to set it has been handed somebody else's task. */}
          {admin && (
            <>
              {" "}Set <code>LOGS_PROVIDER=elk</code> with <code>ELK_URL</code> to read the real
              uptime index.
            </>
          )}
        </Notice>
      )}
      {!selected ? (
        history.loading ? (
          <Skeleton rows={2} />
        ) : (
          <EmptyState
            title="No gateway is registered in any environment yet"
            detail={
              admin
                ? "An uptime strip is drawn per gateway, so there is nothing to draw until one exists."
                : "An uptime strip is drawn per gateway, so there is nothing to draw until an administrator adds one."
            }
            // A member cannot add a gateway, and a link to a screen that says so is not an action.
            action={
              admin ? (
                <Link className="btn primary" to="/gateways">
                  Add a gateway
                </Link>
              ) : undefined
            }
          />
        )
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
