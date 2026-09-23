import { formatDateTime } from "../lib/datetime";
import { api, type EnvironmentsView, type FleetHealth, type Meta, type User } from "../api";
import { Digest, EmptyState, envLabel, Link, Notice, Panel, Skeleton, StatusChip, useAsync } from "../components";
import { gatewaySyncChip, PAUSED_CHIP, replicaChip } from "../lib/status";

/**
 * Health Status's administrators' detail: what each environment's gateways are *doing*. Nothing on
 * this screen changes the estate — adding a gateway, publishing its hostname and minting a
 * replica's token live on the admin **Gateways** screen, because "is it healthy" and "does it
 * exist" are different questions and merging them left the second one with no page of its own.
 *
 * The in-sync flag lags exactly one poll, by design: a replica reports the digest it has
 * *activated*, so the control plane learns about a new config on the poll after the one that
 * delivered it (design section 8.7).
 *
 * Replicas are listed under the gateway they belong to rather than in one table per environment
 * with a "Gateway" column: a disagreement between replicas lives in one gateway, and the
 * environment-wide table made the reader do the grouping.
 */
type Instance = FleetHealth["instances"][number];
type GatewayHealth = FleetHealth["gateways"][number];

function Fleet({ environment }: { environment: string }) {
  const health = useAsync(
    () => api.get<FleetHealth>(`/api/targets/${environment}/health`),
    [environment],
  );
  const fleet = health.data;

  return (
    <Panel
      title={envLabel(environment)}
      className="replica-environment"
      actions={
        fleet && (
          <div className="native-actions">
            {/* "In sync" counts every replica that has not been revoked, not only the ones
                answering. Counting only the live ones let a killed replica improve the headline
                (finding 10). */}
            <StatusChip
              chip={gatewaySyncChip({
                inSync: fleet.inSync,
                expectedReplicas: fleet.expectedInstances,
                behindReplicas: fleet.behindInstances,
              })}
            />
            <span className="chip">
              {fleet.liveInstances} of {fleet.expectedInstances} replicas answering
            </span>
          </div>
        )
      }
    >
      <Notice kind="error">{health.error}</Notice>
      {!fleet && !health.error && <Skeleton rows={3} />}
      {fleet && (
        <>
          <p className="muted small">
            {fleet.routes} routes · {fleet.subscriptions} subscriptions
          </p>
          {/* One section per gateway: an environment can be served from several localities, and a
              disagreement between replicas lives in one of them rather than in the environment. */}
          {fleet.gateways.map((gateway) => (
            <GatewaySection
              key={gateway.name}
              gateway={gateway}
              instances={fleet.instances.filter((instance) => instance.gateway === gateway.name)}
            />
          ))}
        </>
      )}
    </Panel>
  );
}

function GatewaySection({ gateway, instances }: { gateway: GatewayHealth; instances: Instance[] }) {
  return (
    <section className="workspace-section">
      <h4>
        {gateway.name}
        {gateway.label ? ` · ${gateway.label}` : ""}
      </h4>
      <div className="row wrap">
        <StatusChip chip={gatewaySyncChip(gateway)} />
        {gateway.paused && <StatusChip chip={PAUSED_CHIP} />}
        <span className="chip">{gateway.routes} routes</span>
        <span className="muted small">
          config <Digest value={gateway.configDigest} />
        </span>
      </div>
      <p className="hint">
        {gateway.addresses.length > 0 ? (
          <>
            Published at{" "}
            {gateway.addresses.map((address, index) => (
              <span key={address.url}>
                {index > 0 ? " and " : ""}
                <code>{address.url}</code> ({address.network})
              </span>
            ))}
            .
          </>
        ) : (
          <>
            No published address, so consumers have no URL for the APIs on it.{" "}
            <Link to="/gateways">Add one on Gateways</Link>.
          </>
        )}
      </p>

      {instances.length === 0 ? (
        <EmptyState
          title="No replicas registered"
          detail="Nothing serves this gateway until a replica is started with a minted token."
          action={
            <Link className="btn" to="/gateways">
              Mint a token on Gateways
            </Link>
          }
        />
      ) : (
        <table>
          <thead>
            <tr>
              <th>Replica</th>
              <th>Active config</th>
              <th>Last seen</th>
              <th>Requests</th>
              <th>State</th>
            </tr>
          </thead>
          <tbody>
            {instances.map((instance) => {
              // Why it is behind, rather than leaving it looking merely slow to converge: a config
              // whose artifacts or certificates are not available is never activated, and the
              // replica keeps serving the last good one (plan `[R1-21]`).
              const blocked = instance.process?.activationBlocked;
              const refused = typeof blocked === "string" ? blocked : null;
              return (
                <tr key={instance.id}>
                  <td>{instance.name}</td>
                  <td>
                    {/* Against its own gateway's document, not the environment's: an on-premise
                        replica serving a subset is current, not behind. */}
                    <Digest value={instance.configDigest} />
                    {refused && <p className="field-error">Not activated: {refused}</p>}
                  </td>
                  <td className="muted">
                    {instance.lastSeenAt ? formatDateTime(instance.lastSeenAt) : "never"}
                  </td>
                  <td className="muted">
                    {(instance.process?.requestsTotal as number | undefined)?.toLocaleString() ?? "—"}
                  </td>
                  <td>
                    <StatusChip
                      chip={replicaChip({
                        revoked: instance.revoked,
                        stale: instance.stale,
                        current: instance.configDigest === gateway.configDigest,
                        refused,
                      })}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}

/**
 * The rate-limit arithmetic, read from the fleet rather than from the session's cached meta.
 *
 * An aside rather than a card. It is reference — the same sentence every time, true whether or not
 * anything is wrong — and as a panel of its own at the foot of a status page it had the same weight
 * as "what each replica is running", which is the thing somebody came here to read. It is handed
 * the inventory the screen already read rather than asking for it a second time, so one failure is
 * one banner.
 */
function RateLimitArithmetic({ items }: { items: EnvironmentsView["items"] }) {
  return (
    <details className="page-aside">
      <summary>How a rate limit adds up</summary>
      <p className="hint">
        Rate limiting is counted per replica, with no coordination between them, so the ceiling
        across a fleet is <code>calls × replicas</code>:
      </p>
      <ul>
        {items.map((item) => (
          <li key={item.environment}>
            <strong>{envLabel(item.environment)}</strong>: {item.liveInstances} replica
            {item.liveInstances === 1 ? "" : "s"} answering of {item.instances} — a limit of{" "}
            <code>N</code> calls admits up to <code>N × {item.liveInstances}</code> across the
            fleet right now.
          </li>
        ))}
      </ul>
    </details>
  );
}

// `meta` and `user` are the screen registry's props; the detail is administrators' only, so there
// is no second audience to phrase anything for.
export function GatewayView(_props: { meta: Meta; user: User }) {
  const environments = useAsync(() => api.get<EnvironmentsView>("/api/environments"), []);
  const items = environments.data?.items ?? [];

  return (
    <>
      <header className="page">
        <div>
          {/* Named for what it shows rather than for the screen it sits on: the shell already
              renders "Health Status" above it, and a second heading with the same words reads as
              the page having started over. This is the detail underneath the summary. */}
          <h2>What each replica is running</h2>
          <p className="muted">
            Which configuration each replica has applied, and anything it refused. A replica keeps
            serving its last good configuration through a control-plane outage; a revoked token
            stops it at the next poll.
          </p>
        </div>
      </header>

      <Notice kind="error">{environments.error}</Notice>
      {environments.loading && !environments.data && <Skeleton rows={3} />}
      {items.map((item) =>
        item.hasTarget ? (
          <Fleet key={item.environment} environment={item.environment} />
        ) : (
          <Panel key={item.environment} title={envLabel(item.environment)}>
            <EmptyState
              title={`No gateway in ${envLabel(item.environment)}`}
              detail="Nothing published to this environment is served until a gateway exists."
              action={
                <Link className="btn" to="/gateways">
                  Add a gateway
                </Link>
              }
            />
          </Panel>
        ),
      )}

      {environments.data && <RateLimitArithmetic items={items} />}
    </>
  );
}
