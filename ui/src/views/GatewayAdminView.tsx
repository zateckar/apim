import { formatDateTime } from "../lib/datetime";
import { useState } from "react";
import { api, type FleetHealth, type GatewayRow } from "../api";
import { Panel, DangerZone, TextField, Notice, Pill, useAction, useAsync } from "../components";
import { ALLOWED } from "../lib/capabilities";

/**
 * Gateway management (admin).
 *
 * The model this screen makes visible, because until now nothing did:
 *
 *  - **A gateway** serves one environment in one locality — a managed one in the cloud, an
 *    on-premise one in a data centre — and an environment may have several. It has one or two
 *    *published addresses*: the TLS-terminating L7 reverse proxy in front of it, and, where the
 *    same deployment answers on a second DNS name reachable only from inside, that one too. Those
 *    addresses are what every API URL in this portal is built from.
 *  - **A replica** is one process behind that proxy. Replicas are how a gateway scales and are an
 *    operational fact, not an address: a consumer given a replica's URL is holding something that
 *    stops working the next time the fleet is resized. So admins see them, mint their tokens and
 *    revoke them here, and nobody else is shown them at all.
 *
 * Health lives on its own screen. This one is where a gateway comes into existence, gets its
 * addresses, gains and loses replicas, and is removed.
 */
interface GatewayList {
  items: GatewayRow[];
  environments: string[];
}

export function GatewayAdminView() {
  const gateways = useAsync(() => api.get<GatewayList>("/api/gateways"), []);
  const environments = gateways.data?.environments ?? [];

  return (
    <>
      {/* No heading: the shell renders the screen's title and its one-line purpose from the route
          table, and repeating the title here reads as the page having started over. */}
      <header className="page">
        <div>
          <p className="muted">
            Each environment is served by one or more gateways, every one published under its
            proxy's hostname with as many replicas behind it as the load needs. An API says which
            of them it answers on. Health and convergence are on Health Status.
          </p>
        </div>
      </header>

      <Notice kind="error">{gateways.error}</Notice>
      {environments.map((environment) => {
        const rows = (gateways.data?.items ?? []).filter((g) => g.environment === environment);
        return (
          <section key={environment} className="gateway-env">
            <h3>{environment.toUpperCase()}</h3>
            {rows.length === 0 && (
              <p className="hint">
                This environment has no gateway. Nothing promoted to it is served until one
                exists, and it has no address to publish.
              </p>
            )}
            {rows.map((row) => (
              <Gateway key={row.id} row={row} onChanged={gateways.reload} />
            ))}
            <AddGateway
              environment={environment}
              taken={rows.map((r) => r.name)}
              onChanged={gateways.reload}
            />
          </section>
        );
      })}
    </>
  );
}

function AddGateway({
  environment,
  taken,
  onChanged,
}: {
  environment: string;
  taken: string[];
  onChanged: () => void;
}) {
  const action = useAction();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [label, setLabel] = useState("");
  const [publicUrl, setPublicUrl] = useState("");
  const [intranetUrl, setIntranetUrl] = useState("");

  if (!open) {
    return (
      <button className="ghost small" onClick={() => setOpen(true)}>
        Add a gateway to {environment}
      </button>
    );
  }

  return (
    <Panel title={`New gateway in ${environment}`}>
      <Notice kind="error">{action.error}</Notice>
      <TextField label="Name" value={name} onChange={setName} />
      <p className="hint">
        Lower-case letters, digits and hyphens — <code>managed</code>, <code>onprem</code>. It is
        how an API says where it is published, and it should be the same name in every environment
        this gateway exists in, because a publish carries the name along the promotion chain.
        {taken.length > 0 && ` Already taken here: ${taken.join(", ")}.`}
      </p>
      <TextField label="Locality" value={label} onChange={setLabel} />
      <TextField label="Internet address" value={publicUrl} onChange={setPublicUrl} />
      <TextField label="Intranet address" value={intranetUrl} onChange={setIntranetUrl} />
      <div className="row">
        <button
          disabled={action.busy || name.trim() === ""}
          onClick={async () => {
            const ok = await action.run(
              () =>
                api.post("/api/gateways", {
                  environment,
                  name: name.trim(),
                  label: label.trim() || null,
                  publicUrl: publicUrl.trim() || null,
                  intranetUrl: intranetUrl.trim() || null,
                }),
              "created",
            );
            if (ok) {
              setOpen(false);
              setName("");
              setLabel("");
              setPublicUrl("");
              setIntranetUrl("");
              onChanged();
            }
          }}
        >
          Create
        </button>
        <button className="ghost" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
      <p className="hint">
        It starts empty. Nothing already published in {environment.toUpperCase()} moves onto a
        gateway that did not exist when it was published — each API arrives here when somebody
        decides it belongs.
      </p>
    </Panel>
  );
}

function Gateway({ row, onChanged }: { row: GatewayRow; onChanged: () => void }) {
  const action = useAction();
  const [publicUrl, setPublicUrl] = useState(row.publicUrl ?? "");
  const [intranetUrl, setIntranetUrl] = useState(row.intranetUrl ?? "");
  const [label, setLabel] = useState(row.label ?? "");

  const dirty =
    (row.publicUrl ?? "") !== publicUrl ||
    (row.intranetUrl ?? "") !== intranetUrl ||
    (row.label ?? "") !== label;

  return (
    <Panel title={`${row.name}${row.label ? ` · ${row.label}` : ""}`}>
      <div className="row wrap">
        {row.addresses.length === 0 ? (
          <Pill kind="warn">no published address</Pill>
        ) : (
          row.addresses.map((address) => (
            <Pill key={address.url} kind="ok">
              {address.network === "intranet" ? "Intranet" : "Internet"} · {address.url}
            </Pill>
          ))
        )}
        <Pill kind="muted">
          {row.liveReplicas} of {row.replicas} replicas answering
        </Pill>
        <Pill kind="muted">
          {row.published} API{row.published === 1 ? "" : "s"} published
        </Pill>
        {row.paused && <Pill kind="warn">paused</Pill>}
      </div>

      <Notice kind="error">{action.error}</Notice>
      <Notice kind="ok">{action.message}</Notice>

      <TextField label="Internet address" value={publicUrl} onChange={setPublicUrl} />
      <p className="hint">
        The reverse proxy in front of this gateway's replicas — an origin with an optional path
        prefix, no query string. Every API URL the portal shows a consumer for this gateway is
        built from it, so changing it changes what every consumer is told to call. It does not
        move any traffic by itself.
      </p>
      <TextField label="Intranet address" value={intranetUrl} onChange={setIntranetUrl} />
      <p className="hint">
        The same gateway's inside-only name, if it has one. Two DNS names for one deployment are
        two addresses, not two gateways: an API published here is reachable at both.
      </p>
      <TextField label="Locality" value={label} onChange={setLabel} />
      <p className="hint">
        Where this deployment physically is — <code>Azure Cloud</code>,{" "}
        <code>Mladá Boleslav</code> — so a gateway is identifiable by something other than its
        name.
      </p>

      <div className="row">
        <button
          disabled={action.busy || !dirty}
          onClick={async () => {
            const ok = await action.run(
              () =>
                api.patch(`/api/gateways/${row.environment}/${row.name}`, {
                  publicUrl: publicUrl.trim() || null,
                  intranetUrl: intranetUrl.trim() || null,
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
              () =>
                api.patch(`/api/gateways/${row.environment}/${row.name}`, { paused: !row.paused }),
              row.paused ? "resumed" : "paused",
            );
            if (ok) onChanged();
          }}
        >
          {row.paused ? "Resume deployments" : "Pause deployments"}
        </button>
      </div>

      <Replicas
        environment={row.environment}
        gateway={row.name}
        max={row.maxReplicas}
        onChanged={onChanged}
      />

      <DangerZone
        what={`Remove the ${row.name} gateway in ${row.environment}`}
        name={row.name}
        consequence="Everything published on this gateway stops being served there. It is refused while any replica is un-revoked or any API is still published on it."
        permission={ALLOWED}
        busy={action.busy}
        error={action.error}
        onConfirm={async () => {
          const ok = await action.run(
            () => api.del(`/api/gateways/${row.environment}/${row.name}`),
            "removed",
          );
          if (ok) onChanged();
        }}
      />
    </Panel>
  );
}

/** The replicas behind one gateway: mint a token, watch it converge, revoke it. */
function Replicas({
  environment,
  gateway,
  max,
  onChanged,
}: {
  environment: string;
  gateway: string;
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

  // The endpoint answers for the whole environment, and this card is one gateway in it.
  const instances = (health.data?.instances ?? []).filter((i) => i.gateway === gateway);
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
                {instance.lastSeenAt ? formatDateTime(instance.lastSeenAt) : "never"}
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
          placeholder={`new replica name, e.g. ${gateway}-${liveCount + 1}`}
          aria-label={`New replica name for ${environment}/${gateway}`}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <button
          disabled={action.busy || name.trim() === "" || liveCount >= max}
          onClick={async () => {
            const created = await api
              .post<{ name: string; token: string }>(`/api/targets/${environment}/instances`, {
                name: name.trim(),
                gateway,
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
            {gateway} is at its ceiling of {max} replicas; revoke one first.
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
