import { useState } from "react";
import { api, type EnvironmentsView, type FleetHealth, type Meta, type User } from "../api";
import { Card, DangerZone, Digest, Notice, Pill, useAction, useAsync } from "../components";
import { ALLOWED } from "../lib/capabilities";

/**
 * G3: the fleet. Design section 8.5 keys the poll on `gateway_instance`, so more gateways is more
 * rows plus one process each.
 *
 * The in-sync flag lags exactly one poll, by design: an instance reports the digest it has
 * *activated*, so the control plane learns about a new config on the poll after the one that
 * delivered it (design section 8.7).
 */
function Fleet({ environment, isAdmin, onChanged }: { environment: string; isAdmin: boolean; onChanged: () => void }) {
  const health = useAsync(
    () => api.get<FleetHealth>(`/api/targets/${environment}/health`),
    [environment],
  );
  const action = useAction();
  const [name, setName] = useState("");
  const [minted, setMinted] = useState<{ name: string; token: string } | null>(null);

  if (health.error) return <Notice kind="error">{health.error}</Notice>;
  if (!health.data) return <p className="muted">Loading {environment}…</p>;
  const fleet = health.data;

  return (
    <Card title={environment}>
      <div className="row wrap">
        <Pill kind={fleet.inSync ? "ok" : "warn"}>{fleet.inSync ? "in sync" : "converging"}</Pill>
        <Pill kind="muted">{fleet.routes} routes</Pill>
        <Pill kind="muted">{fleet.subscriptions} subscriptions</Pill>
        <Pill kind="muted">{fleet.liveInstances} live</Pill>
        {fleet.paused && <Pill kind="warn">paused</Pill>}
        <span className="muted">
          config <Digest value={fleet.configDigest} />
        </span>
      </div>

      <table>
        <thead>
          <tr>
            <th>Gateway</th>
            <th>Active config</th>
            <th>Last seen</th>
            <th>Requests</th>
            <th>State</th>
            {isAdmin && <th />}
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
                    and the instance keeps serving the last good one (plan `[R1-21]`). */}
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
              {isAdmin && (
                <td>
                  {!instance.revoked && (
                    <DangerZone
                      what={`Revoke ${instance.name}`}
                      name={instance.name}
                      consequence="It stops serving at its next poll and cannot be un-revoked; mint a new instance to replace it."
                      permission={ALLOWED}
                      busy={action.busy}
                      error={action.error}
                      onConfirm={async () => {
                        const ok = await action.run(() => api.del(`/api/instances/${instance.id}`));
                        if (ok) {
                          health.reload();
                          onChanged();
                        }
                      }}
                    />
                  )}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>

      <Notice kind="error">{action.error}</Notice>

      {isAdmin && (
        <div className="row">
          <input
            placeholder="new gateway name, e.g. dev-3"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
          <button
            disabled={action.busy || name.trim() === ""}
            onClick={async () => {
              const created = await api
                .post<{ name: string; token: string }>(`/api/targets/${environment}/instances`, {
                  name: name.trim(),
                })
                .catch((err) => {
                  action.setError(String(err));
                  return null;
                });
              if (created) {
                setMinted(created);
                setName("");
                health.reload();
                onChanged();
              }
            }}
          >
            Mint a token
          </button>
        </div>
      )}

      {minted && (
        <Notice kind="warn">
          <strong>{minted.name}</strong> — copy this token now, it is shown once and only its hash
          is stored:
          <pre>{minted.token}</pre>
          Start the gateway with it:
          <pre>{`DP_NAME=${minted.name} DP_PORT=<port> GATEWAY_TOKEN=${minted.token} bun run dp`}</pre>
        </Notice>
      )}
    </Card>
  );
}

export function GatewayView({ meta, user }: { meta: Meta; user: User }) {
  const environments = useAsync(() => api.get<EnvironmentsView>("/api/environments"), []);

  return (
    <>
      <header className="page">
        <div>
          <h2>Gateways</h2>
          <p className="muted">
            One target per environment, any number of gateways behind it. A gateway keeps serving
            through a control-plane outage from its last-good config; a revoked token stops it at
            the next poll.
          </p>
        </div>
      </header>

      <Notice kind="error">{environments.error}</Notice>
      {environments.data?.items.map((item) => (
        <div key={item.environment}>
          {!item.hasTarget ? (
            <Card title={item.environment}>
              <Notice kind="warn">No standalone target is configured for this environment.</Notice>
            </Card>
          ) : (
            <Fleet
              environment={item.environment}
              isAdmin={user.isAdmin}
              onChanged={environments.reload}
            />
          )}
        </div>
      ))}

      <Card title="How a rate limit adds up">
        <p className="hint">
          Rate limiting is per instance and needs no coordination (design section 5.7), so the
          fleet ceiling is <code>calls x instances</code>:
        </p>
        <ul>
          {meta.environments.map((environment) => (
            <li key={environment.environment}>
              <strong>{environment.environment}</strong>: {environment.liveInstances} live gateway
              {environment.liveInstances === 1 ? "" : "s"} — a limit of <code>N</code> calls admits
              up to <code>N x {environment.liveInstances || 1}</code> across the fleet.
            </li>
          ))}
        </ul>
      </Card>
    </>
  );
}
