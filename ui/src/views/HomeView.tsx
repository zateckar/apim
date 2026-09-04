import { useState, type ReactNode } from "react";
import type { Session } from "../App";
import { api, type Dashboard, type DashboardQuota } from "../api";
import {
  AttentionList,
  Card,
  EmptyState,
  Link,
  Notice,
  Skeleton,
  StatusChip,
  Term,
  useAsync,
} from "../components";
import { labelFor } from "../lib/attention";
import { subscriptionChip } from "../lib/status";

/**
 * Home (goals G2 and G5, plan §6.1 and §9.5).
 *
 * One request, `GET /api/dashboard`, with a block per hat — so two numbers on this page cannot
 * disagree about what "now" means. Three properties are visible decisions rather than styling:
 *
 *  - **the estate, not one environment.** "What needs my attention" is not a question about DEV, so
 *    Home is the one screen with no environment switcher; each row carries the environment it is
 *    about, and the traffic block says which environments it added together.
 *  - **three traffic numbers, never one.** A 429 the gateway produced and a 500 the backend
 *    produced are different problems, and one "errors" figure hides which is happening.
 *  - **no delta when there is nothing to compare with.** `trendAvailable` is false when retention
 *    cannot cover two windows, and then the comparison is simply absent.
 */

/** Windows offered, smallest first. Anything past retention is not offered at all. */
const WINDOWS = [
  { min: 60, label: "Last hour" },
  { min: 360, label: "Last 6 hours" },
  { min: 1440, label: "Last 24 hours" },
];

export function HomeView({ session }: { session: Session }) {
  const retentionMin = session.meta.telemetryRetentionHours * 60;
  const windows = WINDOWS.filter((window) => window.min <= retentionMin);
  const [sinceMin, setSinceMin] = useState(windows[0]?.min ?? retentionMin);

  const dashboard = useAsync(
    () => api.get<Dashboard>(`/api/dashboard?environment=all&sinceMin=${sinceMin}`),
    [sinceMin],
  );

  if (dashboard.error) return <Notice kind="error">{dashboard.error}</Notice>;
  if (!dashboard.data) return <Skeleton rows={6} />;
  const data = dashboard.data;

  // A team that has neither published nor subscribed to anything gets the three paths instead of
  // three empty blocks (plan §9.5). Empty blocks would be an accurate answer to a question nobody
  // asked; this is the answer to the question they have.
  if (data.startHere) {
    return (
      <Card
        title={`Welcome, ${session.user.name.split(" ")[0]}`}
        hint="Three ways in. Each one takes a few minutes and ends somewhere real."
      >
        <div className="stack">
          {data.startHere.map((row) => {
            const label = labelFor(row.code);
            return (
              <div key={row.code} className="unit">
                <header>
                  <h4>{row.subject.name}</h4>
                </header>
                <p className="desc">{row.detail}</p>
                <Link to={row.href}>{label.action} →</Link>
              </div>
            );
          })}
        </div>
        <p className="muted small" style={{ marginTop: 14 }}>
          Not sure which? <Link to="/how">How this works</Link> explains the whole model on one page.
        </p>
      </Card>
    );
  }

  const showOwner = data.hats.includes("owner");
  const showConsumer = data.hats.includes("consumer");
  const showPlatform = data.hats.includes("platform");

  return (
    <div className="blocks">
      {showOwner && <OwnerBlock data={data} sinceMin={sinceMin} windows={windows} onWindow={setSinceMin} />}
      {showConsumer && <ConsumerBlock data={data} />}
      {showPlatform && <PlatformBlock data={data} />}
      {!showOwner && !showConsumer && !showPlatform && (
        <EmptyState
          title="Nothing here yet"
          detail="Your teams have not published or subscribed to anything, and you are not an administrator."
          action={<Link to="/catalog">Browse the catalog →</Link>}
        />
      )}
    </div>
  );
}

// --------------------------------------------------------------------------- owner

function OwnerBlock({
  data,
  sinceMin,
  windows,
  onWindow,
}: {
  data: Dashboard;
  sinceMin: number;
  windows: Array<{ min: number; label: string }>;
  onWindow: (next: number) => void;
}) {
  const { apis, traffic, topApis, attention, attentionTruncated } = data.owner;
  const environments = Object.keys(apis.liveByEnvironment);

  return (
    <Card>
      <div className="block">
        <header>
          <div>
            <h3>The APIs you publish</h3>
            <p className="hint">
              {apis.total} <Term name="api">API</Term>
              {apis.total === 1 ? "" : "s"} across your teams
              {environments.length > 0 && (
                <>
                  {" — "}
                  {environments
                    .map((environment) => `${apis.liveByEnvironment[environment]} live in ${environment.toUpperCase()}`)
                    .join(", ")}
                </>
              )}
              .
            </p>
          </div>
          <div className="inline">
            {windows.map((window) => (
              <button
                key={window.min}
                className={window.min === sinceMin ? "chip active small" : "chip small"}
                onClick={() => onWindow(window.min)}
              >
                {window.label}
              </button>
            ))}
          </div>
        </header>

        <div className="tiles">
          <Tile
            label="Requests"
            value={traffic.requests}
            previous={data.trendAvailable ? (traffic.previous?.requests ?? 0) : null}
            better="up"
          />
          <Tile
            label="Served"
            value={traffic.ok}
            previous={data.trendAvailable ? (traffic.previous?.ok ?? 0) : null}
            better="up"
          />
          <Tile
            label="Refused by the gateway"
            value={traffic.gatewayRejections}
            previous={data.trendAvailable ? (traffic.previous?.gatewayRejections ?? 0) : null}
            better="down"
            title="Rate limits, quotas, a missing or wrong key, validation — the gateway answered, the backend was never asked."
          />
          <Tile
            label="Failed upstream"
            value={traffic.upstreamErrors}
            previous={data.trendAvailable ? (traffic.previous?.upstreamErrors ?? 0) : null}
            better="down"
            title="The gateway forwarded and the backend answered with a 5xx, or did not answer at all."
          />
          <div className="tile">
            <span className="value">{traffic.p95Ms === null ? "—" : `${traffic.p95Ms} ms`}</span>
            <span className="label">p95 latency</span>
          </div>
        </div>

        {!data.trendAvailable && (
          <p className="muted small">
            No comparison with the previous {formatWindow(sinceMin)}: that needs{" "}
            {formatWindow(sinceMin * 2)} of telemetry and it is kept for less than that.
          </p>
        )}
        {traffic.truncated && (
          <p className="muted small">
            More telemetry rows matched than are read in one request, so these totals are a floor.
            <Link to="/telemetry"> See telemetry</Link> for one environment at a time.
          </p>
        )}

        {topApis.length > 0 ? (
          <table>
            <thead>
              <tr>
                <th>Busiest APIs</th>
                <th className="right">Requests</th>
                <th className="right">Served</th>
                <th className="right">Refused</th>
                <th className="right">Failed</th>
                <th className="right">p95</th>
              </tr>
            </thead>
            <tbody>
              {topApis.map((row) => (
                <tr key={row.resourceId || "unmatched"}>
                  <td>
                    {row.resourceId ? <Link to={`/apis/${row.resourceId}`}>{row.name}</Link> : row.name}
                  </td>
                  <td className="right">{row.requests.toLocaleString()}</td>
                  <td className="right ok">{row.ok.toLocaleString()}</td>
                  <td className="right rejected">{row.gatewayRejections.toLocaleString()}</td>
                  <td className="right upstream">{row.upstreamErrors.toLocaleString()}</td>
                  <td className="right">{row.p95Ms === null ? "—" : `${row.p95Ms} ms`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="muted small">
            No traffic in this window. That is not the same as nothing being live —{" "}
            <Link to="/apis">see your APIs</Link>.
          </p>
        )}

        <Attention
          rows={attention}
          truncated={attentionTruncated}
          empty="Nothing is wrong with the APIs you publish."
          more={<Link to="/apis">See all your APIs</Link>}
        />
      </div>
    </Card>
  );
}

// --------------------------------------------------------------------------- consumer

function ConsumerBlock({ data }: { data: Dashboard }) {
  const { applications, subscriptions, subscriptionsTruncated, attention, attentionTruncated } =
    data.consumer;

  return (
    <Card>
      <div className="block">
        <header>
          <div>
            <h3>The APIs you call</h3>
            <p className="hint">
              {applications.length} <Term name="application">application</Term>
              {applications.length === 1 ? "" : "s"} and {subscriptions.length}{" "}
              <Term name="subscription">subscription</Term>
              {subscriptions.length === 1 ? "" : "s"}.
            </p>
          </div>
          <Link to="/subscriptions">Manage them →</Link>
        </header>

        {subscriptions.length === 0 ? (
          <EmptyState
            title="No subscriptions yet"
            detail="Subscribing an application to a product is what gives it a key, and the key is what lets it call anything."
            action={<Link to="/catalog">Find an API to subscribe to →</Link>}
          />
        ) : (
          <table>
            <thead>
              <tr>
                <th>Subscription</th>
                <th>Environment</th>
                <th>State</th>
                <th>Quota</th>
                <th className="right">Key age</th>
              </tr>
            </thead>
            <tbody>
              {subscriptions.map((subscription) => (
                <tr key={subscription.id}>
                  <td>
                    <Link to={`/subscriptions/${subscription.id}`}>{subscription.name}</Link>
                  </td>
                  <td>
                    <span className="pill">{subscription.environment}</span>
                  </td>
                  <td>
                    <StatusChip chip={subscriptionChip(subscription.state)} />
                  </td>
                  <td>
                    <Quota quota={subscription.quota} />
                  </td>
                  <td className="right">{subscription.keyAgeDays} days</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {subscriptionsTruncated > 0 && (
          <p className="muted small">
            {subscriptionsTruncated} more not shown. <Link to="/subscriptions">See all</Link>
          </p>
        )}

        <Attention
          rows={attention}
          truncated={attentionTruncated}
          empty="Nothing is wrong with the subscriptions you hold."
          more={<Link to="/subscriptions">See all your subscriptions</Link>}
        />
      </div>
    </Card>
  );
}

/** "No quota" and "0 of 0" are different statements, so they are worded differently. */
function Quota({ quota }: { quota: DashboardQuota | null }) {
  if (!quota) return <span className="muted">No quota</span>;
  const percent = quota.fraction === null ? 0 : Math.round(quota.fraction * 100);
  const tone = percent >= 100 ? "stop" : percent >= 80 ? "warn" : "live";
  return (
    <span className={`chip-status tone-${tone}`} title={`${quota.used} of ${quota.limit} used`}>
      {quota.used.toLocaleString()} / {quota.limit?.toLocaleString()} ({percent}%)
    </span>
  );
}

// --------------------------------------------------------------------------- platform

function PlatformBlock({ data }: { data: Dashboard }) {
  const { environments, attention, attentionTruncated, admin } = data.platform;

  return (
    <Card>
      <div className="block">
        <header>
          <div>
            <h3>The estate</h3>
            <p className="hint">
              Every <Term name="environment" />, the <Term name="gateway">gateways</Term> running in
              it, and what they are serving.
            </p>
          </div>
          <Link to="/fleet">See the gateways →</Link>
        </header>

        <table>
          <thead>
            <tr>
              <th>Environment</th>
              <th>Gateways</th>
              <th>Configuration</th>
              <th className="right">Trust anchors</th>
              <th className="right">TLS exceptions</th>
              <th className="right">Not served</th>
            </tr>
          </thead>
          <tbody>
            {environments.map((environment) => (
              <tr key={environment.environment} className={environment.configErrors > 0 ? "row-bad" : ""}>
                <td>
                  <strong>{environment.environment.toUpperCase()}</strong>
                </td>
                <td>
                  {environment.hasTarget ? (
                    `${environment.live} of ${environment.instances} reporting`
                  ) : (
                    <span className="muted">No target configured</span>
                  )}
                </td>
                <td>
                  {environment.hasTarget && (
                    <StatusChip
                      chip={
                        environment.inSync
                          ? { label: "In sync", tone: "live", title: "every reporting gateway is on the current configuration" }
                          : { label: "Catching up", tone: "wait", title: "at least one gateway is not yet on the current configuration" }
                      }
                    />
                  )}
                </td>
                <td className="right">
                  {environment.trustAnchors}
                  {environment.expiringAnchors > 0 && (
                    <span className="chip-status tone-warn" style={{ marginLeft: 6 }}>
                      {environment.expiringAnchors} expiring
                    </span>
                  )}
                </td>
                <td className="right">{environment.activeTlsExceptions}</td>
                <td className="right">{environment.configErrors}</td>
              </tr>
            ))}
          </tbody>
        </table>

        {admin && (
          <div className="tiles">
            <div className="tile">
              <span className="value">{admin.failedJobs}</span>
              <span className="label">Failed jobs</span>
            </div>
            <div className="tile">
              <span className="value">{admin.staleReleases}</span>
              <span className="label">Releases needing attention</span>
            </div>
            <div className="tile">
              <span className="value">{admin.downgrades}</span>
              <span className="label">APIs with validation downgraded</span>
            </div>
          </div>
        )}

        <Attention
          rows={attention}
          truncated={attentionTruncated}
          empty="Every gateway is reporting and on the current configuration."
          more={<Link to="/fleet">See the gateways</Link>}
        />
      </div>
    </Card>
  );
}

// --------------------------------------------------------------------------- shared

function Attention({
  rows,
  truncated,
  empty,
  more,
}: {
  rows: Dashboard["owner"]["attention"];
  truncated: number;
  empty: string;
  more: ReactNode;
}) {
  if (rows.length === 0) {
    return (
      <p className="muted small" style={{ marginTop: 14 }}>
        {empty}
      </p>
    );
  }
  return (
    <div style={{ marginTop: 16 }}>
      <AttentionList rows={rows} truncated={truncated} more={more} />
    </div>
  );
}

function Tile({
  label,
  value,
  previous,
  better,
  title,
}: {
  label: string;
  value: number;
  /** Null when retention cannot cover two windows — then there is simply no comparison. */
  previous: number | null;
  better: "up" | "down";
  title?: string;
}) {
  return (
    <div className="tile" title={title}>
      <span className="value">
        {value.toLocaleString()}
        {previous !== null && <Delta now={value} was={previous} better={better} />}
      </span>
      <span className="label">{label}</span>
    </div>
  );
}

function Delta({ now, was, better }: { now: number; was: number; better: "up" | "down" }) {
  if (was === 0 && now === 0) return null;
  const change = was === 0 ? 1 : (now - was) / was;
  const percent = Math.round(change * 100);
  if (percent === 0) return <span className="delta flat">—</span>;
  const good = percent > 0 === (better === "up");
  return (
    <span
      className={`delta ${good ? "up" : "down"}`}
      title={`${was.toLocaleString()} in the previous window`}
    >
      {percent > 0 ? "▲" : "▼"} {Math.abs(percent)}%
    </span>
  );
}

function formatWindow(minutes: number): string {
  if (minutes % 1440 === 0) return `${minutes / 1440} day${minutes === 1440 ? "" : "s"}`;
  if (minutes % 60 === 0) return `${minutes / 60} hour${minutes === 60 ? "" : "s"}`;
  return `${minutes} minutes`;
}
