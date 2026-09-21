import { useState } from "react";
import { api, type CertificateRow, type User } from "../api";
import {
  DangerZone,
  EmptyState,
  Field,
  Modal,
  Notice,
  Panel,
  Skeleton,
  TextField,
  Link,
  useAction,
  useAsync,
} from "../components";
import { ALLOWED } from "../lib/capabilities";
import { formatDate, formatDateTime } from "../lib/datetime";
import * as I from "../portal/icons";
import type { Session } from "../App";

/**
 * Everything an application holds that proves who it is, per environment: the passwords, the API
 * keys, the HMAC pairs and the client certificates.
 *
 * The secrets half exists because the policy editor used to ask an API owner to type the name of
 * an entry in `INTEGRATIONS_FILE` — a JSON document on the control plane's disk that only an
 * administrator with shell access can edit, read once at boot. What stayed behind in that file is
 * the half that carries a **URL**: which identity provider this estate believes, and which token
 * endpoint it will send a client secret to. Neither is an API owner's decision.
 *
 * **Certificates are on this screen and not their own.** They were a separate entry in the
 * navigation, which made an owner answer "where do I put the thing my backend authenticates me
 * with" differently depending on whether that thing was a password or a key pair — the same
 * question, the same environment, the same audience, two screens. A certificate is a credential
 * with an expiry date; that is the whole of the difference, and an expiry date is a column, not a
 * screen. What is *not* here is the estate-wide view of the same rows, which is an administrator's
 * and lives on Trust.
 *
 * Nothing here can be read back. There is no reveal button and there is not going to be one: this
 * is somewhere to put a secret the gateway needs, not a vault to look one up in. Losing one means
 * rotating it, which every policy naming it survives untouched.
 */

interface SecretRow {
  id: string;
  applicationId: string;
  environment: string;
  name: string;
  kind: "basic" | "secret" | "hmac";
  principal: string | null;
  note: string | null;
  ref: string;
  createdBy: string;
  createdAt: string;
  rotatedAt: string | null;
  usedBy: Array<{ resourceId: string | null; resourceName: string; unitKey: string }>;
}

/**
 * The four shapes, in the words the forms use. The first three match the table in
 * `control-plane/src/credentials.ts`, because the server refuses in those terms and a screen that
 * invented its own would be describing a different product. `certificate` is the fourth only
 * here: the control plane keeps certificates in their own table, with their own endpoints, because
 * a key pair has a subject, an issuer and an expiry that a password does not.
 */
export const KINDS = [
  {
    kind: "basic" as const,
    label: "Username and password",
    principal: "Username",
    secret: "Password",
    detail: "HTTP Basic — checking callers with the Basic auth policy, or presenting to a backend.",
  },
  {
    kind: "secret" as const,
    label: "A single secret value",
    principal: null,
    secret: "Value",
    detail: "An API key a backend expects, or a shared secret a required header has to match.",
  },
  {
    kind: "hmac" as const,
    label: "HMAC application id and key",
    principal: "Application id",
    secret: "Application key",
    detail: "The SA-Key-Lite signature a backend verifies.",
  },
  {
    kind: "certificate" as const,
    label: "Client certificate (mutual TLS)",
    principal: null,
    secret: "Private key",
    detail: "The key pair a backend asks for when it wants mutual TLS. Choose it on a backend.",
  },
];

export function shapeOf(kind: string) {
  return KINDS.find((entry) => entry.kind === kind) ?? KINDS[1]!;
}

/** What the list renders, whichever of the two stores a row came out of. */
interface Held {
  id: string;
  kind: string;
  name: string;
  applicationId: string;
  /** The line under the name: what this is and what it opens. */
  detail: string;
  /** The line a policy names it by — a reference for a secret, a thumbprint for a certificate. */
  identifier: string;
  /** When it was last replaced, or first added. */
  age: string;
  /** Empty when nothing names it: that is also what makes it deletable. */
  usedBy: string[];
  /** Why deleting is refused, or null. */
  pinned: string | null;
  expiry: { label: string; tone: "ok" | "warn" | "bad"; on: string } | null;
  secret: SecretRow | null;
  certificate: CertificateRow | null;
}

function heldSecret(row: SecretRow): Held {
  const shape = shapeOf(row.kind);
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    applicationId: row.applicationId,
    detail: [
      shape.label,
      row.principal ? `${shape.principal?.toLowerCase()} ${row.principal}` : null,
      row.note,
    ]
      .filter(Boolean)
      .join(" · "),
    identifier: row.ref,
    age: row.rotatedAt
      ? `Rotated ${formatDateTime(row.rotatedAt)}`
      : `Added ${formatDateTime(row.createdAt)}`,
    usedBy: row.usedBy.map((use) => `${use.resourceName} · ${use.unitKey}`),
    pinned:
      row.usedBy.length > 0
        ? `Named by ${row.usedBy.map((use) => `${use.resourceName} (${use.unitKey})`).join(", ")}. Change those policies first.`
        : null,
    expiry: null,
    secret: row,
    certificate: null,
  };
}

function heldCertificate(row: CertificateRow): Held {
  return {
    id: row.id,
    kind: "certificate",
    name: row.name,
    applicationId: row.applicationId,
    detail: `Client certificate · ${row.subject} · issued by ${row.issuer}`,
    identifier: row.thumbprint,
    age: `Added ${formatDateTime(row.createdAt)}`,
    usedBy: row.usedBy.map((use) => `${use.resourceName} · ${use.environment}`),
    pinned:
      row.usedBy.length > 0
        ? `${row.usedBy.length} binding${row.usedBy.length === 1 ? " names" : "s name"} this certificate; change ${row.usedBy.length === 1 ? "it" : "them"} first.`
        : null,
    expiry: {
      label: row.expired ? "expired" : `${row.expiresInDays} days`,
      tone: row.expired ? "bad" : row.expiresInDays <= 30 ? "warn" : "ok",
      on: formatDate(row.notAfter),
    },
    secret: null,
    certificate: row,
  };
}

/**
 * The two reads this screen is made of, kept in one hook so every caller gets the same list and
 * the same reload. Certificates are fetched for the environment and narrowed here rather than by
 * the endpoint, which is the same shape the estate-wide list on Trust reads.
 */
function useHeld(environment: string, applicationId?: string) {
  const secrets = useAsync(
    () =>
      applicationId
        ? api.get<{ items: SecretRow[] }>(
            `/api/credentials?environment=${encodeURIComponent(environment)}`,
          )
        : Promise.resolve({ items: [] as SecretRow[] }),
    [environment, applicationId],
  );
  const certificates = useAsync(
    () =>
      api.get<{ items: CertificateRow[] }>(
        `/api/certificates?environment=${encodeURIComponent(environment)}`,
      ),
    [environment],
  );
  const mine = <T extends { applicationId: string }>(rows: T[]) =>
    applicationId ? rows.filter((row) => row.applicationId === applicationId) : rows;

  return {
    loading: !secrets.data || !certificates.data,
    error: secrets.error ?? certificates.error,
    certificates: mine(certificates.data?.items ?? []),
    // Certificates first and soonest-to-expire first within them: an expired one is an outage on
    // every request through its binding, and nothing else on this platform warns about it.
    items: [
      ...mine(certificates.data?.items ?? [])
        .sort((a, b) => a.expiresInDays - b.expiresInDays)
        .map(heldCertificate),
      ...mine(secrets.data?.items ?? [])
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(heldSecret),
    ],
    reload: () => {
      secrets.reload();
      certificates.reload();
    },
  };
}

export function CredentialsView({ session: s }: { session: Session }) {
  const held = useHeld(s.environment, s.application);
  const [adding, setAdding] = useState(false);
  const [rotating, setRotating] = useState<Held | null>(null);

  const expired = held.certificates.filter((row) => row.expired);
  const expiring = held.certificates.filter((row) => !row.expired && row.expiresInDays <= 30);

  return (
    <>
      <Notice kind="error">{held.error}</Notice>
      {expired.length > 0 && (
        <Notice kind="error">
          {expired.length} certificate{expired.length === 1 ? " has" : "s have"} expired. Every
          request through a binding that uses one is failing its TLS handshake right now.
        </Notice>
      )}
      {expiring.length > 0 && (
        <Notice kind="warn">
          {expiring.length} certificate{expiring.length === 1 ? "" : "s"} expire within 30 days.
          Rotating one keeps its name, so nothing that uses it has to be re-saved.
        </Notice>
      )}
      <Panel
        title={`${held.items.length} in ${s.environment.toUpperCase()}`}
        hint="Held encrypted under the platform key and handed only to a gateway building its configuration. Nobody can read one back — not you, not an administrator."
        actions={
          <button className="btn primary" onClick={() => setAdding(true)}>
            <I.Plus /> Add
          </button>
        }
      >
        {held.loading ? (
          <Skeleton rows={3} />
        ) : held.items.length === 0 ? (
          <EmptyState
            title={`Nothing held in ${s.environment.toUpperCase()}`}
            detail="A credential is per environment, because a test backend and a production backend do not share a password. Add one here and it appears in the policy editor's picker, on every API this application owns."
            action={
              <button className="btn primary" onClick={() => setAdding(true)}>
                Add a credential
              </button>
            }
          />
        ) : (
          held.items.map((row) => (
            <HeldRow
              key={row.id}
              row={row}
              onRotate={() => setRotating(row)}
              onChanged={held.reload}
            />
          ))
        )}
      </Panel>

      <p className="muted">
        A <strong>JWT issuer</strong> and an <strong>OAuth 2 token endpoint</strong> are not here,
        and are not oversights. Both resolve to a URL the gateway itself fetches — one to decide
        whose tokens this estate believes, the other to send a client secret to — so both stay in
        the administrator-registered integrations file, where nothing clickable can widen them.
        Everything on this screen is only a secret: it is compared, or presented, and never fetched
        from.
      </p>

      {adding && (
        <AddCredential
          session={s}
          taken={held.items.map((row) => row.name)}
          close={() => setAdding(false)}
          onDone={() => {
            setAdding(false);
            held.reload();
          }}
        />
      )}
      {rotating && (
        <RotateCredential
          row={rotating}
          close={() => setRotating(null)}
          onDone={() => {
            setRotating(null);
            held.reload();
          }}
        />
      )}
    </>
  );
}

/**
 * The same rows, for every application at once — the administrator's half, on Trust.
 *
 * One component rather than two, so a certificate does not describe itself one way to its owner
 * and another way to an auditor. Adding is not offered here: a certificate belongs to an
 * application, and choosing which one from an estate-wide list is how it ends up under the wrong
 * one.
 */
export function CertificateList({ environment, user }: { environment: string; user: User }) {
  const held = useHeld(environment);
  const [rotating, setRotating] = useState<Held | null>(null);

  return (
    <>
      <Notice kind="error">{held.error}</Notice>
      <Panel
        title={`Client certificates in ${environment.toUpperCase()}`}
        hint="Uploaded by the owning application on its Credentials screen, held encrypted under the KEK, and handed only to a live gateway instance over its own channel."
      >
        {held.loading ? (
          <Skeleton rows={4} />
        ) : held.items.length === 0 ? (
          <EmptyState
            title={`No client certificates in ${environment.toUpperCase()}`}
            detail="A binding only needs one if its backend asks for mutual TLS. An application uploads its own on Credentials, and it becomes available to choose on a backend."
            action={<Link to="/catalog">Browse the catalog →</Link>}
          />
        ) : (
          held.items.map((row) => (
            <HeldRow
              key={row.id}
              row={row}
              showOwner
              canWrite={user.isAdmin || user.applications.includes(row.applicationId)}
              onRotate={() => setRotating(row)}
              onChanged={held.reload}
            />
          ))
        )}
      </Panel>
      {rotating && (
        <RotateCredential
          row={rotating}
          close={() => setRotating(null)}
          onDone={() => {
            setRotating(null);
            held.reload();
          }}
        />
      )}
    </>
  );
}

function HeldRow({
  row,
  showOwner,
  canWrite = true,
  onRotate,
  onChanged,
}: {
  row: Held;
  showOwner?: boolean;
  canWrite?: boolean;
  onRotate: () => void;
  onChanged: () => void;
}) {
  const w = useAction();
  const endpoint = row.certificate ? "certificates" : "credentials";
  return (
    <div className={row.expiry?.tone === "bad" ? "native-row row-bad" : "native-row"}>
      <div>
        <strong>{row.name}</strong>
        {row.expiry && (
          <span className={`badge ${row.expiry.tone}`}>
            {row.expiry.label}
          </span>
        )}
        <small>
          {row.detail}
          {showOwner ? ` · ${row.applicationId}` : ""}
        </small>
        <small className="mono">{row.identifier}</small>
        <small>
          {row.expiry ? `Expires ${row.expiry.on} · ` : ""}
          {row.age}
          {" · "}
          {row.usedBy.length === 0 ? "not named by any policy" : row.usedBy.join(", ")}
        </small>
        <Notice kind="error">{w.error}</Notice>
      </div>
      <div className="native-actions">
        {/* Rotation before deletion, and on the same row: replacing the material is what somebody
            arriving at an expiry warning has come to do, and every policy naming this keeps
            working through it. Deleting and adding again was the only path there was, and it is
            the one that takes the route down in between. */}
        <button className="btn" disabled={!canWrite} onClick={onRotate}>
          <I.Refresh /> Rotate
        </button>
        <DangerZone
          what={`Delete ${row.name}`}
          name={row.name}
          consequence={
            row.certificate
              ? "The private key is destroyed with it. Any binding that later needs this identity has to have the certificate uploaded again."
              : "The secret is destroyed with it. A gateway refuses any request whose credential it cannot resolve, so a policy that still names this would start answering 503 at its next configuration build."
          }
          permission={
            !canWrite
              ? {
                  enabled: false,
                  reason: "Only the owning application, or an administrator, can delete this.",
                }
              : row.pinned
                ? { enabled: false, reason: row.pinned }
                : ALLOWED
          }
          busy={w.busy}
          error={w.error}
          onConfirm={() =>
            void w.run(async () => {
              await api.del(`/api/${endpoint}/${row.id}`);
              onChanged();
            })
          }
        />
      </div>
    </div>
  );
}

/** The PEM fields, shared by the add and the rotate form because a renewal needs the same three. */
function PemFields({
  certPem,
  chainPem,
  keyPem,
  onCert,
  onChain,
  onKey,
}: {
  certPem: string;
  chainPem: string;
  keyPem: string;
  onCert: (next: string) => void;
  onChain: (next: string) => void;
  onKey: (next: string) => void;
}) {
  return (
    <>
      <Field label="Certificate (PEM)">
        <textarea
          value={certPem}
          rows={5}
          placeholder="-----BEGIN CERTIFICATE-----"
          onChange={(event) => onCert(event.target.value)}
        />
      </Field>
      <Field label="Intermediates (PEM, optional)" hint="Leaf first, root omitted.">
        <textarea value={chainPem} rows={3} onChange={(event) => onChain(event.target.value)} />
      </Field>
      <Field
        label="Private key (PEM)"
        hint="Encrypted on arrival and never returned. The pair is checked before it is stored, so a mismatched one fails here rather than at 3 a.m. on the first handshake."
      >
        <textarea
          value={keyPem}
          rows={5}
          placeholder="-----BEGIN PRIVATE KEY-----"
          onChange={(event) => onKey(event.target.value)}
        />
      </Field>
    </>
  );
}

function AddCredential({
  session: s,
  taken,
  close,
  onDone,
}: {
  session: Session;
  taken: string[];
  close: () => void;
  onDone: () => void;
}) {
  const w = useAction();
  const [name, setName] = useState("");
  const [kind, setKind] = useState("basic");
  const [principal, setPrincipal] = useState("");
  const [secret, setSecret] = useState("");
  const [note, setNote] = useState("");
  const [certPem, setCertPem] = useState("");
  const [chainPem, setChainPem] = useState("");
  const [keyPem, setKeyPem] = useState("");
  const shape = shapeOf(kind);
  const isCertificate = kind === "certificate";

  // Checked here as well as on the server, because the conflict the server returns arrives after
  // the dialog has closed on its way to a credential that was never created.
  const clash = taken.includes(name.trim().toLowerCase());
  const nameProblem = !name
    ? null
    : clash
      ? `This application already holds something called ${name.trim().toLowerCase()} in ${s.environment.toUpperCase()}.`
      : /^[a-z0-9][a-z0-9-]{1,60}$/.test(name)
        ? null
        : "2–61 lowercase letters, digits or hyphens.";
  const blocked =
    Boolean(nameProblem) ||
    !name ||
    (isCertificate
      ? !certPem.trim() || !keyPem.trim()
      : !secret || (shape.principal !== null && !principal.trim()));

  return (
    <Modal title={`Add to ${s.environment.toUpperCase()}`} close={close}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (blocked) return;
          void w.run(async () => {
            if (isCertificate) {
              await api.post("/api/certificates", {
                environment: s.environment,
                applicationId: s.application,
                name: name.trim().toLowerCase(),
                certPem,
                chainPem: chainPem.trim() ? chainPem : null,
                keyPem,
              });
            } else {
              await api.post("/api/credentials", {
                environment: s.environment,
                applicationId: s.application,
                name: name.trim().toLowerCase(),
                kind,
                principal: shape.principal ? principal.trim() : null,
                secret,
                note: note.trim() || null,
              });
            }
            onDone();
          });
        }}
      >
        <Notice kind="error">{w.error}</Notice>
        <TextField
          label="Name"
          value={name}
          onChange={setName}
          required
          maxLength={61}
          error={nameProblem}
          hint="How you will recognise it in the policy editor's picker. It is not the secret and it is not sensitive."
        />
        <Field label="What kind" hint={shape.detail}>
          <select
            value={kind}
            onChange={(e) => {
              setKind(e.target.value);
              setPrincipal("");
            }}
          >
            {KINDS.map((entry) => (
              <option key={entry.kind} value={entry.kind}>
                {entry.label}
              </option>
            ))}
          </select>
        </Field>
        {isCertificate ? (
          <PemFields
            certPem={certPem}
            chainPem={chainPem}
            keyPem={keyPem}
            onCert={setCertPem}
            onChain={setChainPem}
            onKey={setKeyPem}
          />
        ) : (
          <>
            {shape.principal && (
              <TextField
                label={shape.principal}
                value={principal}
                onChange={setPrincipal}
                required
                maxLength={256}
                autoComplete="off"
                hint="Kept in the clear, so a list can say which account this is without decrypting anything."
              />
            )}
            <TextField
              label={shape.secret}
              value={secret}
              onChange={setSecret}
              type="password"
              required
              maxLength={4096}
              autoComplete="new-password"
              hint="Encrypted on arrival. This is the last time it is readable anywhere in the portal."
            />
            <TextField
              label="What it opens (optional)"
              value={note}
              onChange={setNote}
              maxLength={500}
              hint="One line for whoever inherits this — which backend, which account, who to ask."
            />
          </>
        )}
        <button className="btn primary" disabled={w.busy || blocked}>
          {w.busy ? "Saving…" : "Add"}
        </button>
      </form>
    </Modal>
  );
}

function RotateCredential({
  row,
  close,
  onDone,
}: {
  row: Held;
  close: () => void;
  onDone: () => void;
}) {
  const w = useAction();
  const shape = shapeOf(row.kind);
  const [principal, setPrincipal] = useState(row.secret?.principal ?? "");
  const [secret, setSecret] = useState("");
  const [certPem, setCertPem] = useState("");
  const [chainPem, setChainPem] = useState("");
  const [keyPem, setKeyPem] = useState("");
  const isCertificate = Boolean(row.certificate);
  const blocked = isCertificate
    ? !certPem.trim() || !keyPem.trim()
    : !secret || (shape.principal !== null && !principal.trim());

  return (
    <Modal title={`Rotate ${row.name}`} close={close}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (blocked) return;
          void w.run(async () => {
            if (isCertificate) {
              await api.post(`/api/certificates/${row.id}/renew`, {
                certPem,
                chainPem: chainPem.trim() ? chainPem : null,
                keyPem,
              });
            } else {
              await api.post(`/api/credentials/${row.id}/rotate`, {
                principal: shape.principal ? principal.trim() : null,
                secret,
              });
            }
            onDone();
          });
        }}
      >
        <p>
          The name {isCertificate ? "and the identity " : "and the reference "}do not change, so{" "}
          {row.usedBy.length === 0
            ? "nothing has to be re-saved"
            : `${row.usedBy.join(", ")} keep${row.usedBy.length === 1 ? "s" : ""} working`}{" "}
          — the new material reaches the gateways at the next configuration build.
          {isCertificate &&
            " A certificate for a different subject is not a rotation: add that one separately and move each backend to it deliberately."}
        </p>
        <Notice kind="error">{w.error}</Notice>
        {isCertificate ? (
          <PemFields
            certPem={certPem}
            chainPem={chainPem}
            keyPem={keyPem}
            onCert={setCertPem}
            onChain={setChainPem}
            onKey={setKeyPem}
          />
        ) : (
          <>
            {shape.principal && (
              <TextField
                label={shape.principal}
                value={principal}
                onChange={setPrincipal}
                required
                maxLength={256}
                autoComplete="off"
                hint="Change it too if this is a replacement account rather than a new password."
              />
            )}
            <TextField
              label={`New ${shape.secret.toLowerCase()}`}
              value={secret}
              onChange={setSecret}
              type="password"
              required
              maxLength={4096}
              autoComplete="new-password"
            />
          </>
        )}
        <button className="btn primary" disabled={w.busy || blocked}>
          {w.busy ? "Rotating…" : "Replace it"}
        </button>
      </form>
    </Modal>
  );
}
