import { api, type EnvironmentsView, type FleetHealth, type Meta, type User } from "../api";
import { Card, Digest, Notice, Pill, useAsync } from "../components";

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
    <Card title={`${environment}${fleet.label ? ` · ${fleet.label}` : ""}`}>
      <div className="row wrap">
        {/* "In sync" counts every replica that has not been revoked, not only the ones answering.
            Counting only the live ones let a killed replica improve the headline (finding 10). */}
        <Pill kind={fleet.inSync ? "ok" : "warn"}>
          {fleet.inSync ? "in sync" : `${fleet.behindInstances} behind`}
        </Pill>
        <Pill kind="muted">{fleet.routes} routes</Pill>
        <Pill kind="muted">{fleet.subscriptions} subscriptions</Pill>
        <Pill kind={fleet.liveInstances === fleet.expectedInstances ? "muted" : "warn"}>
          {fleet.liveInstances} of {fleet.expectedInstances} replicas answering
        </Pill>
        {fleet.paused && <Pill kind="warn">paused</Pill>}
        <span className="muted">
          config <Digest value={fleet.configDigest} />
        </span>
      </div>

      <p className="hint">
        {fleet.publicUrl ? (
          <>
            Published at <code>{fleet.publicUrl}</code>. The replicas below sit behind that proxy
            and are never addressed directly by a consumer.
          </>
        ) : (
          <>
            This gateway has no published hostname yet, so the portal has no address to give
            consumers. An administrator sets one on the Gateways screen.
          </>
        )}
      </p>

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
          {fleet.instances.map((instance) => (
            <tr key={instance.id}>
              <td>{instance.name}</td>
              <td>
                <Digest value={instance.configDigest} />
                {instance.configDigest === fleet.configDigest ? (
                  <Pill kind="ok">current</Pill>
                ) : (
                  <Pill kind="warn">behind</Pill>
                )}
                {/* Why it is behind, rather than leaving it looking merely slow to converge: a
                    config whose artifacts or certificates are not available is never activated,
                    and the replica keeps serving the last good one (plan `[R1-21]`). */}
                {typeof instance.process?.activationBlocked === "string" && (
                  <div className="notice error" style={{ margin: "6px 0 0" }}>
                    not activated: {instance.process.activationBlocked}
                  </div>
                )}
              </td>
              <td className="muted">
                {instance.lastSeenAt ? new Date(instance.lastSeenAt).toLocaleTimeString() : "never"}
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
              <td colSpan={5} className="muted">
                No replicas are registered, so nothing serves this environment.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </Card>
  );
}

/** The rate-limit arithmetic, read from the fleet rather than from the session's cached meta. */
function RateLimitArithmetic({ chain }: { chain: string[] }) {
  const environments = useAsync(() => api.get<EnvironmentsView>("/api/environments"), []);
  return (
    <Card title="How a rate limit adds up">
      <p className="hint">
        Rate limiting is per replica and needs no coordination (design section 5.7), so the fleet
        ceiling is <code>calls x replicas</code>:
      </p>
      <Notice kind="error">{environments.error}</Notice>
      <ul>
        {(environments.data?.items ?? chain.map((environment) => ({
          environment,
          liveInstances: 0,
          instances: 0,
        }))).map((item) => (
          <li key={item.environment}>
            <strong>{item.environment}</strong>: {item.liveInstances} replica
            {item.liveInstances === 1 ? "" : "s"} answering of {item.instances} — a limit of{" "}
            <code>N</code> calls admits up to <code>N x {item.liveInstances || 1}</code> across the
            fleet right now.
          </li>
        ))}
      </ul>
    </Card>
  );
}

export function GatewayView({ meta, user }: { meta: Meta; user: User }) {
  const environments = useAsync(() => api.get<EnvironmentsView>("/api/environments"), []);

  return (
    <>
      <header className="page">
        <div>
          <h2>Health Status</h2>
          <p className="muted">
            One gateway per environment, any number of replicas behind its proxy. A replica keeps
            serving through a control-plane outage from its last-good config; a revoked token stops
            it at the next poll.
          </p>
        </div>
      </header>

      <Notice kind="error">{environments.error}</Notice>
      {environments.data?.items.map((item) => (
        <div key={item.environment}>
          {!item.hasTarget ? (
            <Card title={item.environment}>
              <Notice kind="warn">
                This environment has no gateway, so nothing published to it is served.
                {user.isAdmin
                  ? " Add one on the Gateways screen."
                  : " An administrator adds one on the Gateways screen."}
              </Notice>
            </Card>
          ) : (
            <Fleet environment={item.environment} />
          )}
        </div>
      ))}

      <RateLimitArithmetic chain={meta.chain} />
    </>
  );
}
