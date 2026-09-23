import { httpUrlError } from "../lib/form-validation";
import { formatDateTime } from "../lib/datetime";
import * as I from "../portal/icons";
import { useState } from "react";
import { api, type FleetHealth, type GatewayRow } from "../api";
import {
  CopyButton,
  DangerZone,
  EmptyState,
  envLabel,
  Link,
  Modal,
  Notice,
  Panel,
  Skeleton,
  StatusChip,
  TextField,
  useAction,
  useAsync,
} from "../components";
import { ALLOWED } from "../lib/capabilities";
import { PAUSED_CHIP, replicaChip } from "../lib/status";

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
 *
 * Every change is behind a button that opens a dialog. The screen used to draw each gateway's
 * address form and a mint form open, always, so a page an administrator came to *read* was three
 * editable boxes per gateway, and a pause — which holds every deployment to that gateway — was one
 * unconfirmed click beside Save.
 */
interface GatewayList {
  items: GatewayRow[];
  environments: string[];
}

/** The gateway and replica name rule, as the control plane enforces it. */
const NAME_RULE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const NAME_HINT = "1–32 lowercase letters, digits or hyphens.";

export function GatewayAdminView() {
  const gateways = useAsync(() => api.get<GatewayList>("/api/gateways"), []);
  const environments = gateways.data?.environments ?? [];
  const [adding, setAdding] = useState<string | null>(null);

  return (
    <>
      {/* No heading: the shell renders the screen's title and its one-line purpose from the route
          table, and repeating the title here reads as the page having started over. */}
      <header className="page">
        <div>
          <p className="muted">
            An API says which of an environment's gateways it answers on. Whether each one is
            healthy and up to date is on <Link to="/fleet">Health Status</Link>.
          </p>
        </div>
      </header>

      <Notice kind="error">{gateways.error}</Notice>
      {gateways.loading && !gateways.data && <Skeleton rows={4} />}
      {environments.map((environment) => {
        const rows = (gateways.data?.items ?? []).filter((g) => g.environment === environment);
        return (
          <section key={environment} className="gateway-env">
            <h3>{envLabel(environment)}</h3>
            {rows.length === 0 ? (
              <EmptyState
                title={`No gateway in ${envLabel(environment)}`}
                detail="Nothing promoted to this environment is served until a gateway exists, and there is no address to publish for it."
                action={
                  <button className="btn primary" onClick={() => setAdding(environment)}>
                    <I.Plus /> Add a gateway
                  </button>
                }
              />
            ) : (
              <>
                {rows.map((row) => (
                  <Gateway key={row.id} row={row} onChanged={gateways.reload} />
                ))}
                <button className="btn" onClick={() => setAdding(environment)}>
                  <I.Plus /> Add a gateway to {envLabel(environment)}
                </button>
              </>
            )}
          </section>
        );
      })}

      {adding && (
        <AddGateway
          environment={adding}
          taken={(gateways.data?.items ?? []).filter((g) => g.environment === adding).map((g) => g.name)}
          close={() => setAdding(null)}
          onChanged={gateways.reload}
        />
      )}
    </>
  );
}

function AddGateway({
  environment,
  taken,
  close,
  onChanged,
}: {
  environment: string;
  taken: string[];
  close: () => void;
  onChanged: () => void;
}) {
  const action = useAction();
  const [name, setName] = useState("");
  const [label, setLabel] = useState("");
  const [publicUrl, setPublicUrl] = useState("");
  const [intranetUrl, setIntranetUrl] = useState("");

  const nameProblem = !NAME_RULE.test(name.trim()) ? `Use ${NAME_HINT.toLowerCase()}` : taken.includes(name.trim()) ? "This gateway name is already used in this environment." : null;
  const invalid = Boolean(nameProblem || httpUrlError(publicUrl, true) || httpUrlError(intranetUrl, true));

  return (
    <Modal title={`Add a gateway to ${envLabel(environment)}`} close={close}>
      <TextField
        label="Name"
        value={name}
        onChange={setName}
        error={name ? nameProblem : null}
        maxLength={32}
        placeholder="managed"
        hint={`${NAME_HINT} Use the same name in every environment this gateway exists in: a publish carries it along the promotion chain.${taken.length > 0 ? ` Already taken here: ${taken.join(", ")}.` : ""}`}
      />
      <TextField label="Locality (optional)" value={label} onChange={setLabel} placeholder="Mladá Boleslav" hint="Where this deployment physically is, so it can be told apart by more than its name." />
      <TextField label="Internet address (optional)" type="url" value={publicUrl} onChange={setPublicUrl} error={httpUrlError(publicUrl, true)} placeholder="https://gateway.example.com" />
      <TextField label="Intranet address (optional)" type="url" value={intranetUrl} onChange={setIntranetUrl} error={httpUrlError(intranetUrl, true)} placeholder="https://gateway.internal" />
      <p className="hint">
        It starts empty: nothing already published in {envLabel(environment)} moves onto it. Each API
        arrives here when somebody publishes or promotes it onto this gateway.
      </p>
      <Notice kind="error">{action.error}</Notice>
      <div className="native-actions">
        <button className="btn" onClick={close}>
          Cancel
        </button>
        <button
          className="btn primary"
          disabled={action.busy || invalid}
          onClick={async () => {
            const ok = await action.run(() =>
              api.post("/api/gateways", {
                environment,
                name: name.trim(),
                label: label.trim() || null,
                publicUrl: publicUrl.trim() || null,
                intranetUrl: intranetUrl.trim() || null,
              }),
            );
            if (ok) {
              onChanged();
              close();
            }
          }}
        >
          Add gateway
        </button>
      </div>
    </Modal>
  );
}

function Gateway({ row, onChanged }: { row: GatewayRow; onChanged: () => void }) {
  const remove = useAction();
  const [dialog, setDialog] = useState<"edit" | "pause" | null>(null);
  const resume = useAction();

  return (
    <Panel
      title={`${row.name}${row.label ? ` · ${row.label}` : ""}`}
      actions={
        <div className="native-actions">
          {row.paused && <StatusChip chip={PAUSED_CHIP} />}
          <button className="btn sm" onClick={() => setDialog("edit")}>
            Edit
          </button>
          {row.paused ? (
            // Resuming is the safe direction — held changes go out, nothing stops — so it is one
            // click, as turning the access log back on is.
            <button
              className="btn sm"
              disabled={resume.busy}
              onClick={async () => {
                const ok = await resume.run(() =>
                  api.patch(`/api/gateways/${row.environment}/${row.name}`, { paused: false }),
                );
                if (ok) onChanged();
              }}
            >
              Resume deployments
            </button>
          ) : (
            <button className="btn sm" onClick={() => setDialog("pause")}>
              Pause deployments…
            </button>
          )}
        </div>
      }
    >
      <Notice kind="error">{resume.error}</Notice>
      <dl className="kv">
        <dt>Internet address</dt>
        <dd>{row.publicUrl ? <Address url={row.publicUrl} /> : <span className="muted">Not published</span>}</dd>
        <dt>Intranet address</dt>
        <dd>{row.intranetUrl ? <Address url={row.intranetUrl} /> : <span className="muted">None</span>}</dd>
        <dt>APIs published</dt>
        <dd>{row.published}</dd>
        <dt>Replicas answering</dt>
        <dd>
          {row.liveReplicas} of {row.replicas}
          <span className="muted"> · at most {row.maxReplicas}</span>
        </dd>
      </dl>
      {row.addresses.length === 0 && (
        <Notice kind="warn">
          This gateway has no published address, so the portal has no URL to give consumers for the
          APIs on it. Edit it to add one.
        </Notice>
      )}

      <Replicas row={row} onChanged={onChanged} />

      <DangerZone
        what={`Remove the ${row.name} gateway from ${envLabel(row.environment)}`}
        name={row.name}
        consequence="Everything published on this gateway stops being served there. It is refused while any replica is un-revoked or any API is still published on it."
        permission={ALLOWED}
        busy={remove.busy}
        error={remove.error}
        onConfirm={async () => {
          const ok = await remove.run(() => api.del(`/api/gateways/${row.environment}/${row.name}`));
          if (ok) onChanged();
        }}
      />

      {dialog === "edit" && <EditGateway row={row} close={() => setDialog(null)} onChanged={onChanged} />}
      {dialog === "pause" && <PauseGateway row={row} close={() => setDialog(null)} onChanged={onChanged} />}
    </Panel>
  );
}

/** A published address, and the button that copies it — it is about to be pasted into a proxy or a ticket. */
function Address({ url }: { url: string }) {
  return (
    <span className="copy-row">
      <code>{url}</code>
      <CopyButton value={url} what={url} />
    </span>
  );
}

function EditGateway({ row, close, onChanged }: { row: GatewayRow; close: () => void; onChanged: () => void }) {
  const action = useAction();
  const [publicUrl, setPublicUrl] = useState(row.publicUrl ?? "");
  const [intranetUrl, setIntranetUrl] = useState(row.intranetUrl ?? "");
  const [label, setLabel] = useState(row.label ?? "");

  const dirty =
    (row.publicUrl ?? "") !== publicUrl ||
    (row.intranetUrl ?? "") !== intranetUrl ||
    (row.label ?? "") !== label;
  const addressChanged = (row.publicUrl ?? "") !== publicUrl || (row.intranetUrl ?? "") !== intranetUrl;

  return (
    <Modal title={`Edit ${row.name} in ${envLabel(row.environment)}`} close={close}>
      <TextField
        label="Internet address (optional)"
        type="url"
        value={publicUrl}
        onChange={setPublicUrl}
        error={httpUrlError(publicUrl, true)}
        placeholder="https://gateway.example.com"
        hint="The reverse proxy in front of this gateway's replicas: an origin with an optional path prefix, no query string."
      />
      <TextField
        label="Intranet address (optional)"
        type="url"
        value={intranetUrl}
        onChange={setIntranetUrl}
        error={httpUrlError(intranetUrl, true)}
        placeholder="https://gateway.internal"
        hint="The same gateway's inside-only name, if it has one. An API published here is reachable at both."
      />
      <TextField label="Locality (optional)" value={label} onChange={setLabel} placeholder="Mladá Boleslav" hint="Where this deployment physically is." />
      {addressChanged && (
        <Notice kind="warn">
          Every API URL the portal shows consumers for this gateway is built from these addresses, so
          saving changes what they are told to call. It does not move any traffic by itself.
        </Notice>
      )}
      <Notice kind="error">{action.error}</Notice>
      <div className="native-actions">
        <button className="btn" onClick={close}>
          Cancel
        </button>
        <button
          className="btn primary"
          disabled={action.busy || !dirty || Boolean(httpUrlError(publicUrl, true) || httpUrlError(intranetUrl, true))}
          onClick={async () => {
            const ok = await action.run(() =>
              api.patch(`/api/gateways/${row.environment}/${row.name}`, {
                publicUrl: publicUrl.trim() || null,
                intranetUrl: intranetUrl.trim() || null,
                label: label.trim() || null,
              }),
            );
            if (ok) {
              onChanged();
              close();
            }
          }}
        >
          <I.Save /> Save changes
        </button>
      </div>
    </Modal>
  );
}

/**
 * Pausing holds every deployment that includes this gateway — and, because a change published on
 * two gateways must not land on one of them (control-plane-surface, "The environment cannot take
 * the change"), every change that names it alongside another. That is a consequence worth one
 * sentence and a second click; it is not a deletion, so it does not ask for the name.
 */
function PauseGateway({ row, close, onChanged }: { row: GatewayRow; close: () => void; onChanged: () => void }) {
  const action = useAction();
  return (
    <Modal title={`Pause deployments to ${row.name}?`} close={close}>
      <p>
        {row.name} keeps serving what it already has. Publishes, policy changes and promotions in{" "}
        {envLabel(row.environment)} that include it are held until it is resumed, and then continue
        on their own.
      </p>
      <Notice kind="error">{action.error}</Notice>
      <div className="native-actions">
        <button className="btn" onClick={close}>
          Keep deploying
        </button>
        <button
          className="btn primary"
          disabled={action.busy}
          onClick={async () => {
            const ok = await action.run(() =>
              api.patch(`/api/gateways/${row.environment}/${row.name}`, { paused: true }),
            );
            if (ok) {
              onChanged();
              close();
            }
          }}
        >
          Pause deployments
        </button>
      </div>
    </Modal>
  );
}

type Instance = FleetHealth["instances"][number];

/** The replicas behind one gateway: mint a token, watch it converge, revoke it. */
function Replicas({ row, onChanged }: { row: GatewayRow; onChanged: () => void }) {
  const { environment, name: gateway, maxReplicas: max } = row;
  const health = useAsync(
    () => api.get<FleetHealth>(`/api/targets/${environment}/health`),
    [environment],
  );
  const [minting, setMinting] = useState(false);
  const [revoking, setRevoking] = useState<Instance | null>(null);

  // The endpoint answers for the whole environment, and this card is one gateway in it.
  const instances = (health.data?.instances ?? []).filter((i) => i.gateway === gateway);
  const digest = health.data?.gateways.find((g) => g.name === gateway)?.configDigest;
  const liveCount = instances.filter((i) => !i.revoked).length;
  const atCeiling = liveCount >= max;
  const refresh = () => {
    health.reload();
    onChanged();
  };

  return (
    <section className="workspace-section">
      <h4>Replicas</h4>
      <Notice kind="error">{health.error}</Notice>
      {health.loading && !health.data ? (
        <Skeleton rows={2} />
      ) : instances.length === 0 ? (
        <EmptyState
          title="No replicas yet"
          detail="Nothing serves this gateway until a replica is started with a token minted here."
          action={
            <button className="btn primary" disabled={Boolean(health.error)} onClick={() => setMinting(true)}>
              Mint a replica token
            </button>
          }
        />
      ) : (
        <>
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
                    <StatusChip
                      chip={replicaChip({
                        revoked: instance.revoked,
                        stale: instance.stale,
                        current: instance.configDigest === digest,
                        refused: refusal(instance),
                      })}
                    />
                  </td>
                  <td>
                    {!instance.revoked && (
                      <button className="btn sm danger" onClick={() => setRevoking(instance)}>
                        Revoke…
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="row wrap">
            <button className="btn" disabled={atCeiling || Boolean(health.error)} onClick={() => setMinting(true)}>
              Mint a replica token
            </button>
            {/* Disabled with the reason beside it, not only in a tooltip (plan §9.4). */}
            {atCeiling && (
              <span className="action-reason">
                {gateway} is at its ceiling of {max} replicas; revoke one first.
              </span>
            )}
          </div>
        </>
      )}

      {minting && (
        <MintReplica
          row={row}
          suggested={`${gateway}-${liveCount + 1}`}
          taken={instances.filter((i) => !i.revoked).map((i) => i.name)}
          close={() => setMinting(false)}
          onMinted={refresh}
        />
      )}
      {revoking && (
        <RevokeReplica
          instance={revoking}
          gateway={gateway}
          close={() => setRevoking(null)}
          onRevoked={refresh}
        />
      )}
    </section>
  );
}

/** Why a replica refused its document, when it has said so on the poll. */
function refusal(instance: Pick<Instance, "process">): string | null {
  const blocked = instance.process?.activationBlocked;
  return typeof blocked === "string" ? blocked : null;
}

/**
 * Minting, and the one time the token is ever shown.
 *
 * The token is in the dialog rather than a banner under the table, because a banner outlives the
 * moment it matters and stays on the page for anybody who walks past; closing the dialog is the
 * point after which it is gone. There was no copy button, so a 40-character secret was a
 * triple-click and a hope.
 */
function MintReplica({
  row,
  suggested,
  taken,
  close,
  onMinted,
}: {
  row: GatewayRow;
  suggested: string;
  taken: string[];
  close: () => void;
  onMinted: () => void;
}) {
  const action = useAction();
  const [name, setName] = useState(suggested);
  const [minted, setMinted] = useState<{ name: string; token: string } | null>(null);
  const nameProblem = !NAME_RULE.test(name.trim()) ? `Use ${NAME_HINT.toLowerCase()}` : taken.includes(name.trim()) ? "An active replica already uses this name." : null;

  if (minted) {
    return (
      <Modal title={`Token for ${minted.name}`} close={close}>
        <Notice kind="warn">
          Copy it now. It is not shown again — only its hash is stored — and a lost token means
          revoking this replica and minting another.
        </Notice>
        <div className="copy-row">
          <code>{minted.token}</code>
          <CopyButton value={minted.token} what="the replica token" />
        </div>
        <p className="hint">
          Start the replica with <code>DP_NAME={minted.name}</code> and this token in the file{" "}
          <code>GATEWAY_TOKEN_FILE</code> names (README.md, <em>Enrolling a gateway</em>), then put it
          behind {row.name}'s proxy. Consumers are never given the replica's own address.
        </p>
        <div className="native-actions">
          <button className="btn primary" onClick={close}>
            Done
          </button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title={`Mint a replica token for ${row.name} in ${envLabel(row.environment)}`} close={close}>
      <TextField label="Replica name" value={name} onChange={setName} hint={NAME_HINT} error={name ? nameProblem : null} maxLength={32} />
      <Notice kind="error">{action.error}</Notice>
      <div className="native-actions">
        <button className="btn" onClick={close}>
          Cancel
        </button>
        <button
          className="btn primary"
          disabled={action.busy || Boolean(nameProblem)}
          onClick={async () => {
            const ok = await action.run(async () =>
              setMinted(
                await api.post<{ name: string; token: string }>(`/api/targets/${row.environment}/instances`, {
                  name: name.trim(),
                  gateway: row.name,
                }),
              ),
            );
            if (ok) onMinted();
          }}
        >
          Mint token
        </button>
      </div>
    </Modal>
  );
}

/** Revoking a replica's token: final, and named, so it is the typed confirmation (plan §9.4). */
function RevokeReplica({
  instance,
  gateway,
  close,
  onRevoked,
}: {
  instance: Instance;
  gateway: string;
  close: () => void;
  onRevoked: () => void;
}) {
  const action = useAction();
  return (
    <Modal title={`Revoke ${instance.name}?`} close={close}>
      <DangerZone
        open
        what={`Revoke ${instance.name}`}
        name={instance.name}
        consequence={`It stops serving ${gateway} at its next poll and cannot be un-revoked; mint a new token to replace it.`}
        permission={ALLOWED}
        busy={action.busy}
        error={action.error}
        onConfirm={async () => {
          const ok = await action.run(() => api.del(`/api/instances/${instance.id}`));
          if (ok) {
            onRevoked();
            close();
          }
        }}
      />
      <div className="native-actions">
        <button className="btn" onClick={close}>
          Keep it
        </button>
      </div>
    </Modal>
  );
}
