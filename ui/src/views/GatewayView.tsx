import { formatDateTime } from "../lib/datetime";
import { api, type EnvironmentsView, type FleetHealth, type Meta, type User } from "../api";
import { Panel, Digest, Notice, Pill, useAsync } from "../components";

/**
 * Health Status: what each environment's gateway is *doing*. Nothing on this screen changes the
 * estate — adding a gateway, publishing its hostname and minting a replica's token live on the
 * admin **Gateways** screen, because "is it healthy" and "does it exist" are different questions
 * and merging them left the second one with no page of its own.
 *
 * The in-sync flag lags exactly one poll, by design: a replica reports the digest it has
 * *activated*, so the control plane learns about a new config on the poll after the one that
 * delivered it (design section 8.7).
 */
function Fleet({ environment }: { environment: string }) {
  const health = useAsync(
    () => api.get<FleetHealth>(`/api/targets/${environment}/health`),
    [environment],
  );

  if (health.error) return <Notice kind="error">{health.error}</Notice>;
  if (!health.data) return <p className="muted">Loading {environment}…</p>;
  const fleet = health.data;

  return (
    <Panel title={environment.toUpperCase()} className="replica-environment">
      <div className="row wrap">
        {/* "In sync" counts every replica that has not been revoked, not only the ones answering.
            Counting only the live ones let a killed replica improve the headline (finding 10).
            Each replica is compared against its *own* gateway's config, because two gateways in
            one environment serve different subsets of it. */}
        <Pill kind={fleet.inSync ? "ok" : "warn"}>
          {fleet.inSync ? "in sync" : `${fleet.behindInstances} behind`}
        </Pill>
        <Pill kind="muted">{fleet.routes} routes</Pill>
        <Pill kind="muted">{fleet.subscriptions} subscriptions</Pill>
        <Pill kind={fleet.liveInstances === fleet.expectedInstances ? "muted" : "warn"}>
          {fleet.liveInstances} of {fleet.expectedInstances} replicas answering
        </Pill>
        {fleet.paused && <Pill kind="warn">paused</Pill>}
      </div>

      {/* One block per gateway: an environment can be served from several localities, and a
          disagreement between replicas lives in one of them rather than in the environment. */}
      {fleet.gateways.map((gateway) => (
        <div key={gateway.name} className="gateway-env">
          <h4>
            {gateway.name}
            {gateway.label ? <span className="muted"> · {gateway.label}</span> : null}
          </h4>
          <div className="row wrap">
            <Pill kind={gateway.inSync ? "ok" : "warn"}>
              {gateway.inSync
                ? "in sync"
                : gateway.expectedReplicas === 0
                  ? "no replicas"
                  : `${gateway.behindReplicas} behind`}
            </Pill>
            <Pill kind="muted">{gateway.routes} routes</Pill>
            {gateway.paused && <Pill kind="warn">paused</Pill>}
            <span className="muted">
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
                . The replicas below sit behind those names and are never addressed directly by a
                consumer.
              </>
            ) : (
              <>
                This gateway has no published address yet, so the portal has no URL to give
                consumers for it. An administrator sets one on the Gateways screen.
              </>
            )}
          </p>
        </div>
      ))}

      <table>
        <thead>
          <tr>
            <th>Replica</th>
            <th>Gateway</th>
            <th>Active config</th>
            <th>Last seen</th>
            <th>Requests</th>
            <th>State</th>
          </tr>
        </thead>
        <tbody>
          {fleet.instances.map((instance) => (
            <tr key={instance.id}>
              <td>{instance.name}</td>
              <td className="muted">{instance.gateway}</td>
              <td>
                <Digest value={instance.configDigest} />
                {/* Against its own gateway's document, not the environment's: an on-premise
                    replica serving a subset is current, not behind. */}
                {instance.configDigest ===
                fleet.gateways.find((g) => g.name === instance.gateway)?.configDigest ? (
                  <Pill kind="ok">current</Pill>
                ) : (
                  <Pill kind="warn">behind</Pill>
                )}
                {/* Why it is behind, rather than leaving it looking merely slow to converge: a
                    config whose artifacts or certificates are not available is never activated,
                    and the replica keeps serving the last good one (plan `[R1-21]`). */}
                {typeof instance.process?.activationBlocked === "string" && (
                  <Notice kind="error">
                    not activated: {instance.process.activationBlocked}
                  </Notice>
                )}
              </td>
              <td className="muted">
                {instance.lastSeenAt ? formatDateTime(instance.lastSeenAt) : "never"}
              </td>
              <td className="muted">
                {(instance.process?.requestsTotal as number | undefined)?.toLocaleString() ?? "—"}
              </td>
              <td>
                {instance.revoked ? (
                  <Pill kind="warn">revoked</Pill>
                ) : instance.stale ? (
                  <Pill kind="warn">stale</Pill>
                ) : (
                  <Pill kind="ok">live</Pill>
                )}
              </td>
            </tr>
          ))}
          {fleet.instances.length === 0 && (
            <tr>
              <td colSpan={6} className="muted">
                No replicas are registered, so nothing serves this environment.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </Panel>
  );
}

/**
 * The rate-limit arithmetic, read from the fleet rather than from the session's cached meta.
 *
 * An aside rather than a card. It is reference — the same sentence every time, true whether or not
 * anything is wrong — and as a panel of its own at the foot of a status page it had the same weight
 * as "what each replica is running", which is the thing somebody came here to read.
 */
function RateLimitArithmetic({ chain }: { chain: string[] }) {
  const environments = useAsync(() => api.get<EnvironmentsView>("/api/environments"), []);
  return (
    <details className="page-aside">
      <summary>How a rate limit adds up</summary>
      <p className="hint">
        Rate limiting is per replica and needs no coordination (design section 5.7), so the fleet
        ceiling is <code>calls x replicas</code>:
      </p>
      <Notice kind="error">{environments.error}</Notice>
      <ul>
        {(environments.data?.items ?? []).map((item) => (
          <li key={item.environment}>
            <strong>{item.environment}</strong>: {item.liveInstances} replica
            {item.liveInstances === 1 ? "" : "s"} answering of {item.instances} — a limit of{" "}
            <code>N</code> calls admits up to <code>N x {item.liveInstances}</code> across the
            fleet right now.
          </li>
        ))}
      </ul>
    </details>
  );
}

export function GatewayView({ meta, user }: { meta: Meta; user: User }) {
  const environments = useAsync(() => api.get<EnvironmentsView>("/api/environments"), []);

  return (
    <>
      <header className="page">
        <div>
          {/* Named for what it shows rather than for the screen it sits on: the shell already
              renders "Health Status" above it, and a second heading with the same words reads as
              the page having started over. This is the detail underneath the summary. */}
          <h2>What each replica is running</h2>
          <p className="muted">
            Each environment is served by one or more gateways, with any number of replicas behind
            each one's proxy. A replica keeps serving through a control-plane outage from its
            last-good config; a revoked token stops it at the next poll.
          </p>
        </div>
      </header>

      <Notice kind="error">{environments.error}</Notice>
      {environments.data?.items.map((item) => (
        <div key={item.environment}>
          {!item.hasTarget ? (
            <Panel title={item.environment}>
              <Notice kind="warn">
                This environment has no gateway, so nothing published to it is served.
                {user.isAdmin
                  ? " Add one on the Gateways screen."
                  : " An administrator adds one on the Gateways screen."}
              </Notice>
            </Panel>
          ) : (
            <Fleet environment={item.environment} />
          )}
        </div>
      ))}

      <RateLimitArithmetic chain={meta.chain} />
    </>
  );
}
