import { useState } from "react";
import { api, type FleetHealth, type GatewayRow } from "../api";
import { Card, DangerZone, Field, Notice, Pill, useAction, useAsync } from "../components";
import { ALLOWED } from "../lib/capabilities";

/**
 * Gateway management (admin).
 *
 * The model this screen makes visible, because until now nothing did:
 *
 *  - **A gateway** serves one environment in one locality. It has a *published hostname* — the
 *    TLS-terminating L7 reverse proxy that sits in front of it — and that hostname is what every
 *    API URL in this portal is built from.
 *  - **A replica** is one process behind that proxy. Replicas are how the gateway scales and are
 *    an operational fact, not an address: a consumer given a replica's URL is holding something
 *    that stops working the next time the fleet is resized. So admins see them, mint their tokens
 *    and revoke them here, and nobody else is shown them at all.
 *
 * Health lives on its own screen. This one is where a gateway comes into existence, gets its
 * hostname, gains and loses replicas, and is removed.
 */
export function GatewayAdminView() {
  const gateways = useAsync(() => api.get<{ items: GatewayRow[] }>("/api/gateways"), []);

  return (
    <>
      <header className="page">
        <div>
          <h2>Gateways</h2>
          <p className="muted">
            One gateway per environment, published under its proxy's hostname, with as many
            replicas behind it as the load needs. Health and convergence are on Health Status.
          </p>
        </div>
      </header>

      <Notice kind="error">{gateways.error}</Notice>
      {gateways.data?.items.map((row) => (
        <Gateway key={row.environment} row={row} onChanged={gateways.reload} />
      ))}
    </>
  );
}

function Gateway({ row, onChanged }: { row: GatewayRow; onChanged: () => void }) {
  const action = useAction();
  const [publicUrl, setPublicUrl] = useState(row.publicUrl ?? "");
  const [label, setLabel] = useState(row.label ?? "");

  if (!row.exists) {
    return (
      <Card title={row.environment}>
        <p className="hint">
          This environment has no gateway. Nothing promoted to it is served until one exists, and
          it has no address to publish.
        </p>
        <Notice kind="error">{action.error}</Notice>
        <Field label="Published hostname" value={publicUrl} onChange={setPublicUrl} />
        <Field
          label="Locality"
          value={label}
          onChange={setLabel}
        />
        <button
          disabled={action.busy}
          onClick={async () => {
            const ok = await action.run(
              () =>
                api.post("/api/gateways", {
                  environment: row.environment,
                  publicUrl: publicUrl.trim() || null,
                  label: label.trim() || null,
                }),
              "created",
            );
            if (ok) onChanged();
          }}
        >
          Add a gateway for {row.environment}
        </button>
      </Card>
    );
  }

  const dirty = (row.publicUrl ?? "") !== publicUrl || (row.label ?? "") !== label;

  return (
    <Card title={`${row.environment}${row.label ? ` · ${row.label}` : ""}`}>
      <div className="row wrap">
        <Pill kind={row.publicUrl ? "ok" : "warn"}>
          {row.publicUrl ?? "no published hostname"}
        </Pill>
        <Pill kind="muted">
          {row.liveReplicas} of {row.replicas} replicas answering
        </Pill>
        {row.paused && <Pill kind="warn">paused</Pill>}
      </div>

      <Notice kind="error">{action.error}</Notice>
      <Notice kind="ok">{action.message}</Notice>

      <Field label="Published hostname" value={publicUrl} onChange={setPublicUrl} />
      <p className="hint">
        The reverse proxy in front of this gateway's replicas — an origin with an optional path
        prefix, no query string. Every API URL the portal shows a consumer in{" "}
        {row.environment.toUpperCase()} is built from it, so changing it changes what every
        consumer is told to call. It does not move any traffic by itself.
      </p>
      <Field label="Locality" value={label} onChange={setLabel} />
      <p className="hint">
        What to call this deployment — <code>cloud</code>, <code>on-prem</code> — so a gateway is
        identifiable by something other than its environment.
      </p>

      <div className="row">
        <button
          disabled={action.busy || !dirty}
          onClick={async () => {
            const ok = await action.run(
              () =>
                api.patch(`/api/gateways/${row.environment}`, {
                  publicUrl: publicUrl.trim() || null,
                  label: label.trim() || null,
                }),
              "saved",
            );
            if (ok) onChanged();
          }}
        >
          Save
        </button>
        <button
          className="ghost"
          disabled={action.busy}
          onClick={async () => {
            const ok = await action.run(
              () => api.patch(`/api/gateways/${row.environment}`, { paused: !row.paused }),
              row.paused ? "resumed" : "paused",
            );
            if (ok) onChanged();
          }}
        >
          {row.paused ? "Resume deployments" : "Pause deployments"}
        </button>
      </div>

      <Replicas environment={row.environment} max={row.maxReplicas} onChanged={onChanged} />

      <DangerZone
        what={`Remove the ${row.environment} gateway`}
        name={row.environment}
        consequence="Everything published to this environment stops being served. It is refused while any replica is un-revoked or any route still answers here."
        permission={ALLOWED}
        busy={action.busy}
        error={action.error}
        onConfirm={async () => {
          const ok = await action.run(() => api.del(`/api/gateways/${row.environment}`), "removed");
          if (ok) onChanged();
        }}
      />
    </Card>
  );
}

/** The replicas behind one gateway: mint a token, watch it converge, revoke it. */
function Replicas({
  environment,
  max,
  onChanged,
}: {
  environment: string;
  max: number;
  onChanged: () => void;
}) {
  const health = useAsync(
    () => api.get<FleetHealth>(`/api/targets/${environment}/health`),
    [environment],
  );
  const action = useAction();
  const [name, setName] = useState("");
  const [minted, setMinted] = useState<{ name: string; token: string } | null>(null);

  const instances = health.data?.instances ?? [];
  const liveCount = instances.filter((i) => !i.revoked).length;

  return (
    <>
      <h4>Replicas</h4>
      <Notice kind="error">{health.error}</Notice>
      <table>
        <thead>
          <tr>
            <th>Replica</th>
            <th>Last seen</th>
            <th>State</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {instances.map((instance) => (
            <tr key={instance.id}>
              <td>{instance.name}</td>
              <td className="muted">
                {instance.lastSeenAt ? new Date(instance.lastSeenAt).toLocaleTimeString() : "never"}
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
              <td>
                {!instance.revoked && (
                  <DangerZone
                    what={`Revoke ${instance.name}`}
                    name={instance.name}
                    consequence="It stops serving at its next poll and cannot be un-revoked; mint a new replica to replace it."
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
            </tr>
          ))}
          {instances.length === 0 && (
            <tr>
              <td colSpan={4} className="muted">
                None yet. Mint a token below and start a gateway process with it.
              </td>
            </tr>
          )}
        </tbody>
      </table>

      <Notice kind="error">{action.error}</Notice>
      <div className="row">
        <input
          placeholder={`new replica name, e.g. ${environment}-${liveCount + 1}`}
          aria-label={`New replica name for ${environment}`}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <button
          disabled={action.busy || name.trim() === "" || liveCount >= max}
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
        {liveCount >= max && (
          <span className="muted">
            {environment} is at its ceiling of {max} replicas; revoke one first.
          </span>
        )}
      </div>

      {minted && (
        <Notice kind="warn">
          <strong>{minted.name}</strong> — copy this token now, it is shown once and only its hash
          is stored:
          <pre>{minted.token}</pre>
          Start the replica with it:
          <pre>{`DP_NAME=${minted.name} DP_PORT=<port> GATEWAY_TOKEN=${minted.token} bun run dp`}</pre>
          Then put it behind this gateway's proxy. Consumers are never given this process's own
          address.
        </Notice>
      )}
    </>
  );
}
