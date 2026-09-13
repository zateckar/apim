import { httpUrlError, integerError, nameError, NAME_HINT } from "../lib/form-validation";
import * as I from "../portal/icons";
import { formatDate } from "../lib/datetime";
import { useState } from "react";
import {
  api,
  type BlockedRoute,
  type CertificateRow,
  type DenyRuleList,
  type DenyRuleRow,
  type GovernanceReport,
  type Meta,
  type Resource,
  type TlsExceptionRow,
  type User,
} from "../api";
import {
  Panel,
  DangerZone,
  EmptyState,
  TextField,
  Link,
  Notice,
  Skeleton,
  useAction,
  useAsync,
} from "../components";
import { ALLOWED } from "../lib/capabilities";
import { TrustAnchors } from "./TrustAnchors";

/**
 * Trust, in the two directions it runs (design sections 4.3 and 5.4).
 *
 * Certificates are the identity this estate *presents* to a backend; TLS exceptions are the
 * verification it is willing to *skip*. They share a screen because they are the same question
 * asked from either end, and because the answer to "what are we not verifying" has to live
 * somewhere an auditor can find without knowing which API to look at.
 *
 * Two things this screen insists on, both from section 5.4: an exception has an end date with a
 * ceiling, and it has a reason long enough to be one. The form checks the reason and whole-day lifetime; the control plane
 * also enforces the configured ceiling. Asking for them up front is the difference between a policy
 * and a nag.
 */
export function TrustView({
  meta,
  user,
  environment,
  applicationId,
}: {
  applicationId?: string;
  meta: Meta;
  user: User;
  environment: string;
}) {
  // Authorities first, and deliberately: it is the rung that removes the need for the other two
  // tabs, and putting exceptions first would teach the expensive habit (plan §8).
  const [tab, setTab] = useState<"anchors" | "certificates" | "exceptions" | "deny" | "report">(applicationId ? "certificates" : "anchors");

  return (
    <>
      {!applicationId && <div className="tabs" role="group" aria-label="Trust sections">
        <button className={tab === "anchors" ? "tab active" : "tab"} onClick={() => setTab("anchors")}>
          Certificate authorities
        </button>
        <button className={tab === "certificates" ? "tab active" : "tab"} onClick={() => setTab("certificates")}>
          Client certificates
        </button>
        <button className={tab === "exceptions" ? "tab active" : "tab"} onClick={() => setTab("exceptions")}>
          TLS exceptions
        </button>
        {user.isAdmin && (
          <button className={tab === "deny" ? "tab active" : "tab"} onClick={() => setTab("deny")}>
            Blocked backends
          </button>
        )}
        {user.isAdmin && (
          <button className={tab === "report" ? "tab active" : "tab"} onClick={() => setTab("report")}>
            Governance report
          </button>
        )}
      </div>}

      {tab === "anchors" && (
        <TrustAnchors meta={meta} environment={environment} isAdmin={user.isAdmin} />
      )}
      {tab === "certificates" && <Certificates user={user} environment={environment} applicationId={applicationId} />}
      {tab === "exceptions" && <Exceptions user={user} environment={environment} />}
      {tab === "deny" && user.isAdmin && <DenyRules meta={meta} environment={environment} />}
      {tab === "report" && user.isAdmin && <Report />}
    </>
  );
}

// ---------------------------------------------------------------- client certificates

function Certificates({ user, environment, applicationId }: { user: User; environment: string; applicationId?: string }) {
  const certificates = useAsync(
    () => api.get<{ environment: string; items: CertificateRow[] }>(`/api/certificates?environment=${environment}`),
    [environment],
  );
  const [uploading, setUploading] = useState(false);

  // Sorted by how soon they break something: an expired client certificate is an outage on every
  // request through its binding, and nothing else on this platform warns about it.
  const items = [...(certificates.data?.items ?? [])].filter(row => !applicationId || row.applicationId === applicationId).sort((a, b) => a.expiresInDays - b.expiresInDays);
  const expiring = items.filter((row) => !row.expired && row.expiresInDays <= 30);
  const expired = items.filter((row) => row.expired);
  if (certificates.error) return <Notice kind="error">{certificates.error}</Notice>;
  if (!certificates.data) return <Skeleton rows={4} />;

  return (
    <>
      <Notice kind="error">{certificates.error}</Notice>
      {expired.length > 0 && (
        <Notice kind="error">
          {expired.length} certificate{expired.length === 1 ? " has" : "s have"} expired. Every
          request through a binding that uses one is failing its TLS handshake right now.
        </Notice>
      )}
      {expiring.length > 0 && (
        <Notice kind="warn">
          {expiring.length} certificate{expiring.length === 1 ? "" : "s"} expire within 30 days.
        </Notice>
      )}

      <Panel
        title={`Certificates in ${environment.toUpperCase()}`}
        hint="Uploaded once, held encrypted under the KEK, and handed only to a live gateway instance over its own channel. The private key is never readable back through this API — not by you, not by an admin."
      >
        {/* An empty table used to be seven column headings over one grey sentence in a `<td>`. The
            headings name columns that are not there, and the sentence is an empty state written
            out longhand without the one thing an empty state owes the reader: what to do next. */}
        {items.length === 0 ? (!uploading && (
          <EmptyState
            title={`No client certificates in ${environment.toUpperCase()}`}
            detail="A binding only needs one if its backend asks for mutual TLS. Uploading it here is what makes it available to choose on a backend."
            action={
              <button className="btn primary" onClick={() => setUploading(true)}>
                <I.Upload />
                Upload a certificate
              </button>
            }
          />
        )) : (
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Subject</th>
                <th>Issuer</th>
                <th>Expires</th>
                <th>Thumbprint</th>
                <th>Used by</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {items.map((row) => (
                <CertificateRowView
                  key={row.id}
                  row={row}
                  user={user}
                  reload={certificates.reload}
                />
              ))}
            </tbody>
          </table>
        )}

        {/* With rows above, the button is how you add another; with none, the empty state already
            offered it and this would be the same control twice on one card. */}
        {(items.length > 0 || uploading) && (
          <div className="inline" style={{ marginTop: 12 }}>
            <button className={uploading ? "btn ghost" : "btn primary"} onClick={() => setUploading(!uploading)}>
              {!uploading && <I.Upload />}
              {uploading ? "Cancel" : "Upload a certificate"}
            </button>
          </div>
        )}
        {uploading && (
          <UploadCertificate
            owner={applicationId}
            taken={items.map(item => item.name)}
            user={user}
            environment={environment}
            onDone={() => {
              setUploading(false);
              certificates.reload();
            }}
          />
        )}
      </Panel>
    </>
  );
}

function CertificateRowView({
  row,
  user,
  reload,
}: {
  row: CertificateRow;
  user: User;
  reload: () => void;
}) {
  const action = useAction();
  const mine = user.isAdmin || user.applications.includes(row.applicationId);
  const [renewing, setRenewing] = useState(false);

  return (
    <>
    <tr className={row.expired ? "row-bad" : ""}>
      <td>
        <strong>{row.name}</strong>
        <div className="muted">{row.applicationId}</div>
      </td>
      <td className="mono small">{row.subject}</td>
      <td className="mono small">{row.issuer}</td>
      <td>
        {row.expired ? (
          <span className="badge bad">expired</span>
        ) : row.expiresInDays <= 30 ? (
          <span className="badge warn">{row.expiresInDays} days</span>
        ) : (
          <span className="badge ok">{row.expiresInDays} days</span>
        )}
        <div className="muted">{formatDate(row.notAfter)}</div>
      </td>
      <td className="mono small" title={row.thumbprint}>
        {row.thumbprint.slice(0, 16)}…
      </td>
      <td>
        {row.usedBy.length === 0 ? (
          <span className="muted">nothing</span>
        ) : (
          row.usedBy.map((use) => (
            <div key={`${use.resourceId}:${use.environment}`}>
              <Link to={`/apis/${use.resourceId}`}>{use.resourceName}</Link>{" "}
              <span className="muted">{use.environment}</span>
            </div>
          ))
        )}
      </td>
      <td>
        {/* Renewal comes before deletion, in that order and on the same row, because it is the
            thing somebody arriving at an expiry warning actually came to do. Deleting and
            re-uploading was the only path there was, and it is the one that takes the route down
            in between. */}
        <button
          className="ghost small"
          disabled={!mine}
          title={
            mine
              ? undefined
              : "Only the owning application, or an administrator, can renew this certificate."
          }
          onClick={() => setRenewing(!renewing)}
        >
          {renewing ? "Cancel" : "Renew"}
        </button>
        <DangerZone
          what={`Delete ${row.name}`}
          name={row.name}
          consequence="The private key is destroyed with it. Any binding that later needs this identity has to have the certificate uploaded again."
          permission={
            !mine
              ? { enabled: false, reason: "Only the owning application, or an administrator, can delete this certificate." }
              : row.usedBy.length > 0
                ? {
                    enabled: false,
                    reason: `${row.usedBy.length} binding${row.usedBy.length === 1 ? " names" : "s name"} this certificate; change ${row.usedBy.length === 1 ? "it" : "them"} first.`,
                  }
                : ALLOWED
          }
          busy={action.busy}
          error={action.error}
          onConfirm={async () => {
            const ok = await action.run(() => api.del(`/api/certificates/${row.id}`));
            if (ok) reload();
          }}
        />
      </td>
    </tr>
    {renewing && (
      <tr>
        <td colSpan={7}>
          <RenewCertificate
            row={row}
            onDone={() => {
              setRenewing(false);
              reload();
            }}
          />
        </td>
      </tr>
    )}
    </>
  );
}

/**
 * Replace one certificate's material without touching anything that names it.
 *
 * Deliberately not an "upload" form with the same fields: there is no name, no application and no
 * environment to choose, because a renewal cannot change any of them. What it can change is the
 * material, and the screen says what that means for the routes below it before anything is sent.
 */
function RenewCertificate({ row, onDone }: { row: CertificateRow; onDone: () => void }) {
  const [certPem, setCertPem] = useState("");
  const [chainPem, setChainPem] = useState("");
  const [keyPem, setKeyPem] = useState("");
  const action = useAction();

  return (
    <div className="subform">
      <Notice kind="error">{action.error}</Notice>
      <Notice kind="ok">{action.message}</Notice>
      <p className="muted">
        Renewing keeps the name <strong>{row.name}</strong> and the identity{" "}
        <span className="mono">{row.subject}</span>, so the{" "}
        {row.usedBy.length === 0
          ? "bindings that later name it"
          : `${row.usedBy.length} binding${row.usedBy.length === 1 ? "" : "s"} that name it`}{" "}
        keep working and nothing has to be re-approved. A certificate for a different subject is not
        a renewal — upload that one separately and move each binding to it deliberately.
      </p>
      <div className="field">
        <label>New certificate (PEM)</label>
        <textarea
          value={certPem}
          placeholder="-----BEGIN CERTIFICATE-----"
          onChange={(event) => setCertPem(event.target.value)}
        />
      </div>
      <div className="field">
        <label>
          Intermediates (PEM, optional) <span className="muted">leaf first, root omitted</span>
        </label>
        <textarea value={chainPem} onChange={(event) => setChainPem(event.target.value)} />
      </div>
      <div className="field">
        <label>
          New private key (PEM) <span className="muted">encrypted on arrival, never returned</span>
        </label>
        <textarea
          value={keyPem}
          placeholder="-----BEGIN PRIVATE KEY-----"
          onChange={(event) => setKeyPem(event.target.value)}
        />
      </div>
      <button
        disabled={action.busy || !certPem.trim() || !keyPem.trim()}
        onClick={async () => {
          const ok = await action.run(
            () =>
              api.post(`/api/certificates/${row.id}/renew`, {
                certPem,
                chainPem: chainPem.trim() ? chainPem : null,
                keyPem,
              }),
            "renewed — the gateways pick the new material up on their next poll",
          );
          if (ok) onDone();
        }}
      >
        Renew in place
      </button>
    </div>
  );
}

function UploadCertificate({
  taken,
  owner,
  user,
  environment,
  onDone,
}: {
  user: User;
  taken: string[];
  environment: string;
  onDone: () => void;
  owner?: string;
}) {
  const [applicationId, setApplicationId] = useState(owner ?? user.applications[0] ?? "");
  const [name, setName] = useState("");
  const [certPem, setCertPem] = useState("");
  const [chainPem, setChainPem] = useState("");
  const [keyPem, setKeyPem] = useState("");
  const action = useAction();
  const nameProblem = nameError(name) ?? (taken.includes(name) ? "A certificate with this name already exists here. Renew it in place instead." : null);
  const invalid = Boolean(nameProblem) || !applicationId || !certPem.trim() || !keyPem.trim();

  return (
    <div className="subform">
      <Notice kind="error">{action.error}</Notice>
      <Notice kind="ok">{action.message}</Notice>
      <div className="row">
        {owner ? <div className="field"><label>Application</label><input value={owner} readOnly/></div> : <TextField label="Application" value={applicationId} onChange={setApplicationId} />}
        <TextField label="Name" hint={NAME_HINT} maxLength={61} error={name ? nameProblem : null} value={name} onChange={setName} placeholder="orders-backend" />
        <div className="field">
          <label>Environment</label>
          <input value={environment} readOnly />
        </div>
      </div>
      <div className="field">
        <label htmlFor="upload-cert">Certificate (PEM)</label>
        <textarea
          id="upload-cert" value={certPem}
          placeholder="-----BEGIN CERTIFICATE-----"
          onChange={(event) => setCertPem(event.target.value)}
        />
      </div>
      <div className="field">
        <label htmlFor="upload-chain">
          Intermediates (PEM, optional) <span className="muted">leaf first, root omitted</span>
        </label>
        <textarea id="upload-chain" value={chainPem} onChange={(event) => setChainPem(event.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="upload-key">
          Private key (PEM) <span className="muted">encrypted on arrival, never returned</span>
        </label>
        <textarea
          id="upload-key" value={keyPem}
          placeholder="-----BEGIN PRIVATE KEY-----"
          onChange={(event) => setKeyPem(event.target.value)}
        />
      </div>
      <button
        className="btn primary"
        disabled={action.busy || invalid}
        onClick={async () => {
          if (invalid) return;
          const ok = await action.run(
            () =>
              api.post("/api/certificates", {
                environment,
                applicationId,
                name,
                certPem,
                chainPem: chainPem.trim() ? chainPem : null,
                keyPem,
              }),
            "uploaded",
          );
          if (ok) onDone();
        }}
      >
        Upload
      </button>
      <p className="muted" style={{ marginBottom: 0 }}>
        The certificate and key are checked as a pair before they are stored: a mismatched pair fails
        here rather than at 3 a.m. on the first handshake.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------- TLS exceptions

const MODES = [
  { value: "pin", label: "Pin one certificate", help: "Verify against exactly this thumbprint. The strongest of the three, and the only one that is not a downgrade." },
  { value: "skip-hostname", label: "Skip the hostname check", help: "The chain is still verified; only the name in the certificate is ignored. For a backend reached by IP or an internal alias." },
  { value: "insecure", label: "Skip verification entirely", help: "Nothing about the backend's certificate is checked. Anything on the path can read and rewrite this traffic." },
];

function Exceptions({ user, environment }: { user: User; environment: string }) {
  const [includeExpired, setIncludeExpired] = useState(false);
  const exceptions = useAsync(
    () =>
      api.get<{ items: TlsExceptionRow[] }>(
        `/api/trust/exceptions?environment=${environment}&includeExpired=${includeExpired ? "1" : "0"}`,
      ),
    [environment, includeExpired],
  );
  const [creating, setCreating] = useState(false);
  const action = useAction();

  return (
    <>
      <Notice kind="error">{exceptions.error}</Notice>
      <Panel
        title={`TLS exceptions in ${environment}`}
        hint="Admin-only, expiring, and reasoned. They live here rather than inside a binding so that an owner cannot decide to stop verifying their own backend, and so that this list can be asked for at all."
      >
        <div className="inline" style={{ marginBottom: 10 }}>
          <label className="check-inline">
            <input
              type="checkbox"
              checked={includeExpired}
              onChange={(event) => setIncludeExpired(event.target.checked)}
            />
            Show expired and revoked
          </label>
        </div>

        <table>
          <thead>
            <tr>
              <th>API</th>
              <th>Backend</th>
              <th>Mode</th>
              <th>Expires</th>
              <th>Reason</th>
              <th>Created by</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {(exceptions.data?.items ?? []).map((row) => (
              <tr key={row.id} className={row.live ? "" : "row-dim"}>
                <td>
                  <Link to={`/apis/${row.resourceId}`}>{row.resourceName}</Link>
                  <div className="muted">{row.environment}</div>
                </td>
                <td className="mono small">{row.backendUrl ?? "every backend in the pool"}</td>
                <td>
                  <span className={`badge ${row.mode === "pin" ? "ok" : row.mode === "insecure" ? "bad" : "warn"}`}>
                    {row.mode}
                  </span>
                  {row.pinThumbprint && (
                    <div className="mono small muted" title={row.pinThumbprint}>
                      {row.pinThumbprint.slice(0, 16)}…
                    </div>
                  )}
                </td>
                <td>
                  {row.revokedAt ? (
                    <span className="badge">revoked</span>
                  ) : row.live ? (
                    <span className={row.expiresInDays <= 7 ? "badge warn" : "badge"}>
                      {row.expiresInDays} days
                    </span>
                  ) : (
                    <span className="badge">expired</span>
                  )}
                  <div className="muted">{formatDate(row.expiresAt)}</div>
                </td>
                <td className="small">{row.reason}</td>
                <td className="muted small">{row.createdBy}</td>
                <td>
                  {row.live && (
                    <DangerZone
                      what={`Revoke this exception`}
                      name={row.resourceName}
                      consequence={`${row.resourceName} goes back to full certificate verification at the next poll. If its backend still presents a certificate the gateway cannot verify, its calls start failing — register the authority as a trust anchor first.`}
                      permission={
                        user.isAdmin
                          ? ALLOWED
                          : { enabled: false, reason: "Only an administrator can revoke a TLS exception." }
                      }
                      busy={action.busy}
                      error={action.error}
                      onConfirm={async () => {
                        const ok = await action.run(() => api.del(`/api/trust/exceptions/${row.id}`));
                        if (ok) exceptions.reload();
                      }}
                    />
                  )}
                </td>
              </tr>
            ))}
            {(exceptions.data?.items.length ?? 0) === 0 && (
              <tr>
                <td colSpan={7} className="muted">
                  Nothing here — every backend in {environment} is fully verified. This is the state
                  to be in.
                </td>
              </tr>
            )}
          </tbody>
        </table>
        <Notice kind="error">{action.error}</Notice>

        {user.isAdmin && (
          <div className="inline" style={{ marginTop: 12 }}>
            <button className="ghost small" onClick={() => setCreating(!creating)}>
              {creating ? "Cancel" : "Add an exception"}
            </button>
          </div>
        )}
        {creating && (
          <NewException
            environment={environment}
            onDone={() => {
              setCreating(false);
              exceptions.reload();
            }}
          />
        )}
      </Panel>
    </>
  );
}

function NewException({ environment, onDone }: { environment: string; onDone: () => void }) {
  const resources = useAsync(() => api.get<{ items: Resource[] }>("/api/resources"), []);
  const [resourceId, setResourceId] = useState("");
  const [backendUrl, setBackendUrl] = useState("");
  const [mode, setMode] = useState("pin");
  const [pinThumbprint, setPinThumbprint] = useState("");
  const [reason, setReason] = useState("");
  const [days, setDays] = useState(30);
  const action = useAction();

  const pinError = mode === "pin" && !/^[a-fA-F0-9]{64}$/.test(pinThumbprint.replace(/:/g, "")) ? "Enter the 64 hexadecimal characters of the SHA-256 thumbprint." : null;
  const daysError = integerError(days, 1);
  const invalid = !resourceId || Boolean(httpUrlError(backendUrl, true) || daysError || pinError) || reason.trim().length < 20 || resources.loading || Boolean(resources.error);
  const chosen = MODES.find((entry) => entry.value === mode);

  return (
    <div className="subform">
      <Notice kind="error">{action.error ?? resources.error}</Notice>
      <Notice kind="ok">{action.message}</Notice>
      <div className="row">
        <div className="field">
          <label htmlFor="exception-api">API</label>
          <select id="exception-api" value={resourceId} onChange={(event) => setResourceId(event.target.value)}>
            <option value="">choose…</option>
            {(resources.data?.items ?? []).map((resource) => (
              <option key={resource.id} value={resource.id}>
                {resource.name} {resource.apiVersion}
              </option>
            ))}
          </select>
        </div>
        <TextField
          label="Backend URL (optional)" type="url" hint="Leave empty to apply to every backend in this API’s pool." error={httpUrlError(backendUrl, true)}
          value={backendUrl}
          onChange={setBackendUrl}
          placeholder="https://backend.internal:8443"
        />
        <TextField label="Expires in (days)" type="number" min={1} step={1} error={daysError} hint="A whole number of days; the server also enforces the estate’s maximum lifetime." value={days} onChange={(next) => setDays(Number(next))} />
      </div>

      <div className="field">
        <label htmlFor="exception-mode">Mode</label>
        <select id="exception-mode" value={mode} onChange={(event) => setMode(event.target.value)}>
          {MODES.map((entry) => (
            <option key={entry.value} value={entry.value}>
              {entry.label}
            </option>
          ))}
        </select>
      </div>
      {chosen && (
        <p className={mode === "insecure" ? "notice warn" : "muted"}>{chosen.help}</p>
      )}

      {mode === "pin" && (
        <TextField
          label="Pinned sha256 thumbprint (64 hex characters)" error={pinThumbprint ? pinError : null}
          value={pinThumbprint}
          onChange={setPinThumbprint}
        />
      )}

      <div className="field">
        <label htmlFor="exception-reason">
          Reason <span className="muted">at least 20 characters — name the ticket and the plan to remove it</span>
        </label>
        <textarea id="exception-reason" minLength={20} value={reason} onChange={(event) => setReason(event.target.value)} />
      </div>

      {invalid && <p className="hint">Choose an API, provide a reason of at least 20 characters, and complete the fields required by the selected mode.</p>}
      <button
        className="btn primary" disabled={action.busy || invalid}
        onClick={async () => {
          if (invalid) return;
          const ok = await action.run(
            () =>
              api.post("/api/trust/exceptions", {
                resourceId,
                environment,
                backendUrl: backendUrl.trim() ? backendUrl.trim() : null,
                mode,
                pinThumbprint: mode === "pin" ? pinThumbprint : undefined,
                reason,
                days,
              }),
            "created",
          );
          if (ok) onDone();
        }}
      >
        Create exception
      </button>
      <p className="muted" style={{ marginBottom: 0 }}>
        The gateway expires this on its own clock, so it cannot outlive its date through a control
        plane outage. A connection already open keeps its TLS options until it closes (deviation
        D25).
      </p>
    </div>
  );
}

// ---------------------------------------------------------------- blocked backends

/**
 * The hosts this estate does not reach (`egress-governance`).
 *
 * This screen replaced an allowlist in a file that needed a control-plane restart per change. The
 * inversion is what makes self-service possible — a team registers a backend without asking anybody
 * — and the cost of the inversion is that this list is now the only place a host is refused. So two
 * things the old file never had are insisted on here: a reason long enough to be one, and the blast
 * radius shown *before* the rule is saved.
 *
 * That second one matters more than it looks. A rule takes effect at the next configuration build,
 * which means routes that have been serving for months stop within a poll or two. Saving one
 * without knowing what it hits is the mistake this form exists to make difficult.
 */
function DenyRules({ meta, environment }: { meta: Meta; environment: string }) {
  const rules = useAsync(() => api.get<DenyRuleList>("/api/trust/deny-rules"), []);
  const [creating, setCreating] = useState(false);
  const action = useAction();

  if (rules.error) return <Notice kind="error">{rules.error}</Notice>;
  if (!rules.data) return <Skeleton rows={4} />;

  const items = rules.data.items;
  const blockedTotal = items.reduce((sum, rule) => sum + rule.blocking.length, 0);

  return (
    <>
      <Notice kind="error">{action.error}</Notice>
      {blockedTotal > 0 && (
        <Notice kind="warn">
          {blockedTotal} route{blockedTotal === 1 ? " is" : "s are"} not being served because a rule
          below blocks {blockedTotal === 1 ? "its" : "their"} backend. Each one is listed with the
          rule that stops it.
        </Notice>
      )}

      <Panel
        title="Hosts this estate does not reach"
        hint="Egress is allowed by default: a team registers a backend without asking anybody. A rule here is how that default is taken back for one host — and it applies to routes already running, not only to the next one written."
      >
        {items.length === 0 ? (!creating && (
          <EmptyState
            title="No host is blocked"
            detail="Any backend a team can reach is a backend they can register, as long as it is outside the denied network ranges in the integrations file. Add a rule when there is a host this estate should not reach."
            action={
              <button className="btn primary" onClick={() => setCreating(true)}>
                Block a host
              </button>
            }
          />
        )) : (
          <table>
            <thead>
              <tr>
                <th>Host pattern</th>
                <th>Applies to</th>
                <th>Reason</th>
                <th>Blocking</th>
                <th>Added by</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {items.map((rule) => (
                <DenyRuleRowView key={rule.id} rule={rule} reload={rules.reload} />
              ))}
            </tbody>
          </table>
        )}

        {(items.length > 0 || creating) && (
          <div className="inline" style={{ marginTop: 12 }}>
            <button className={creating ? "btn ghost" : "btn primary"} onClick={() => setCreating(!creating)}>
              {creating ? "Cancel" : "Block a host"}
            </button>
            <span className="muted">
              {items.length} of {rules.data.maxRules} rules used
            </span>
          </div>
        )}
        {creating && (
          <NewDenyRule
            meta={meta}
            environment={environment}
            onDone={() => {
              setCreating(false);
              rules.reload();
            }}
          />
        )}
      </Panel>

      {/* Listed, and visibly not removable. An administrator who cannot see this rule will one day
          spend an afternoon working out why a backend pointed at the portal will not save. */}
      <Panel
        title="Stated by the platform"
        hint="Not an administrator's rule and not removable: a route pointed back at the control plane would let a gateway proxy to this API, which is neither a backend nor something a subscription should reach."
      >
        <ul className="plain">
          {rules.data.platformRules.map((rule) => (
            <li key={rule.id}>
              <span className="mono">{rule.hostPattern}</span>{" "}
              <span className="muted">every environment</span>
              {rule.blocking.length > 0 && (
                <span className="badge warn" style={{ marginLeft: 8 }}>
                  blocking {rule.blocking.length}
                </span>
              )}
            </li>
          ))}
          {rules.data.platformRules.length === 0 && (
            <li className="muted">
              None — PUBLIC_URL could not be read as a URL, so the portal's own address is not
              covered. Check the variable.
            </li>
          )}
        </ul>
      </Panel>
    </>
  );
}

function DenyRuleRowView({ rule, reload }: { rule: DenyRuleRow; reload: () => void }) {
  const [showing, setShowing] = useState(false);
  const action = useAction();
  const ports = rule.ports?.join(", ") ?? (rule.portRange ? `${rule.portRange[0]}–${rule.portRange[1]}` : null);

  return (
    <>
      <tr>
        <td>
          <strong className="mono">{rule.hostPattern}</strong>
          <div className="muted small">
            {rule.scheme ?? "http and https"}
            {ports ? ` · ports ${ports}` : " · every port"}
          </div>
        </td>
        <td>{rule.environment ?? <span className="muted">every environment</span>}</td>
        <td className="small">{rule.reason}</td>
        <td>
          {rule.blocking.length === 0 ? (
            <span className="muted">nothing</span>
          ) : (
            <button className="ghost small" aria-expanded={showing} onClick={() => setShowing(!showing)}>
              {rule.blocking.length} route{rule.blocking.length === 1 ? "" : "s"}
            </button>
          )}
        </td>
        <td className="muted small">
          {rule.createdBy}
          <div>{formatDate(rule.createdAt)}</div>
        </td>
        <td>
          <DangerZone
            what={`Remove the rule for ${rule.hostPattern}`}
            name={rule.hostPattern}
            consequence={
              rule.blocking.length === 0
                ? "Nothing is being blocked by it today, so nothing starts serving. Backends under this pattern become registrable again at the next write."
                : `${rule.blocking.length} route${rule.blocking.length === 1 ? "" : "s"} start${rule.blocking.length === 1 ? "s" : ""} serving again at the fleet's next configuration, within a poll or two.`
            }
            permission={ALLOWED}
            busy={action.busy}
            error={action.error}
            onConfirm={async () => {
              const ok = await action.run(() => api.del(`/api/trust/deny-rules/${rule.id}`));
              if (ok) reload();
            }}
          />
        </td>
      </tr>
      {showing && (
        <tr>
          <td colSpan={6}>
            <ul className="plain">
              {rule.blocking.map((route) => (
                <li key={`${route.resourceId}:${route.environment}`}>
                  <Link to={`/apis/${route.resourceId}`}>{route.resourceName}</Link>{" "}
                  <span className="muted">
                    {route.environment} · {route.applicationId}
                  </span>{" "}
                  <span className="mono small">{route.backendUrl}</span>
                </li>
              ))}
            </ul>
          </td>
        </tr>
      )}
    </>
  );
}

function NewDenyRule({
  meta,
  environment,
  onDone,
}: {
  meta: Meta;
  environment: string;
  onDone: () => void;
}) {
  const [hostPattern, setHostPattern] = useState("");
  const [scope, setScope] = useState<"" | string>("");
  const [scheme, setScheme] = useState<"" | "http" | "https">("");
  const [ports, setPorts] = useState("");
  const [reason, setReason] = useState("");
  const [preview, setPreview] = useState<{ blocking: BlockedRoute[]; count: number } | null>(null);
  const action = useAction();
  const dry = useAction();

  const portList = ports
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map(Number);
  const portsError =
    ports.trim() && portList.some((port) => !Number.isInteger(port) || port < 1 || port > 65535)
      ? "Ports are whole numbers from 1 to 65535, separated by commas."
      : null;
  const patternError = hostPattern.trim() && /[:/]/.test(hostPattern)
    ? "A rule matches a host, not a URL. Leave off the scheme and the path; ports go in their own field."
    : null;
  const invalid =
    !hostPattern.trim() || Boolean(patternError || portsError) || reason.trim().length < 20;

  const draft = () => ({
    hostPattern: hostPattern.trim(),
    environment: scope || null,
    scheme: scheme || null,
    ...(portList.length > 0 ? { ports: portList } : {}),
    reason: reason.trim(),
  });

  return (
    <div className="subform">
      <Notice kind="error">{action.error ?? dry.error}</Notice>
      <Notice kind="ok">{action.message}</Notice>
      <div className="row">
        <TextField
          label="Host pattern"
          hint="An exact host, or *.suffix — which does not match the bare suffix itself."
          error={patternError}
          value={hostPattern}
          onChange={(next) => {
            setHostPattern(next);
            setPreview(null);
          }}
          placeholder="*.internal.example.com"
        />
        <div className="field">
          <label htmlFor="deny-scope">Applies to</label>
          <select
            id="deny-scope"
            value={scope}
            onChange={(event) => {
              setScope(event.target.value);
              setPreview(null);
            }}
          >
            <option value="">Every environment</option>
            {meta.chain.map((name) => (
              <option key={name} value={name}>
                {name} only
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="deny-scheme">Scheme</label>
          <select
            id="deny-scheme"
            value={scheme}
            onChange={(event) => {
              setScheme(event.target.value as "" | "http" | "https");
              setPreview(null);
            }}
          >
            <option value="">Both</option>
            <option value="http">http only</option>
            <option value="https">https only</option>
          </select>
        </div>
        <TextField
          label="Ports (optional)"
          hint="Comma-separated. Empty means every port."
          error={portsError}
          value={ports}
          onChange={(next) => {
            setPorts(next);
            setPreview(null);
          }}
          placeholder="443, 8443"
        />
      </div>

      <div className="field">
        <label htmlFor="deny-reason">
          Reason{" "}
          <span className="muted">
            at least 20 characters — name the ticket, and what would have to be true to remove this
          </span>
        </label>
        <textarea
          id="deny-reason"
          minLength={20}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
        />
      </div>

      {/* Before saving, not after. A rule here stops routes across the fleet within a poll or two,
          and this is the only moment where that is still a question rather than an incident. */}
      <div className="inline">
        <button
          className="btn ghost"
          disabled={dry.busy || !hostPattern.trim() || Boolean(patternError || portsError)}
          onClick={() =>
            dry.run(async () => {
              setPreview(
                await api.post<{ blocking: BlockedRoute[]; count: number }>(
                  "/api/trust/deny-rules/preview",
                  draft(),
                ),
              );
            })
          }
        >
          {dry.busy ? "Checking…" : "What would this block?"}
        </button>
      </div>

      {preview && (
        <Notice kind={preview.count === 0 ? "ok" : "warn"}>
          {preview.count === 0
            ? "This rule blocks nothing that is running today. It still stands as the estate's position for anything registered later."
            : `This rule would take ${preview.count} route${preview.count === 1 ? "" : "s"} out of service at the fleet's next configuration:`}
        </Notice>
      )}
      {preview && preview.count > 0 && (
        <ul className="plain">
          {preview.blocking.map((route) => (
            <li key={`${route.resourceId}:${route.environment}`}>
              <Link to={`/apis/${route.resourceId}`}>{route.resourceName}</Link>{" "}
              <span className="muted">
                {route.environment} · {route.applicationId}
              </span>{" "}
              <span className="mono small">{route.backendUrl}</span>
            </li>
          ))}
        </ul>
      )}

      {invalid && (
        <p className="hint">
          Give a host pattern and a reason of at least 20 characters.
        </p>
      )}
      <button
        className="btn primary"
        disabled={action.busy || invalid}
        onClick={async () => {
          if (invalid) return;
          const ok = await action.run(
            () => api.post("/api/trust/deny-rules", draft()),
            "blocked — the fleet stops serving any route on this host at its next poll",
          );
          if (ok) onDone();
        }}
      >
        Block this host
      </button>
      <p className="muted" style={{ marginBottom: 0 }}>
        Rules match the backend URL as written. A hostname no rule matches may still resolve to the
        same address as one that does — the denied ranges in the integrations file catch that only
        when the address falls inside one. This is governance, not a firewall.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------- the governance report

function Report() {
  const report = useAsync(() => api.get<GovernanceReport>("/api/governance/exceptions"), []);
  if (report.error) return <Notice kind="error">{report.error}</Notice>;
  if (!report.data) return <Skeleton rows={4} />;

  return (
    <>
      <Notice kind="error">{report.error}</Notice>
      <Panel
        title="Every backend we are not fully verifying"
        hint="Asked about the estate rather than about an API, because asking it per API means never asking it."
      >
        <table>
          <thead>
            <tr>
              <th>API</th>
              <th>Environment</th>
              <th>Backend</th>
              <th>Mode</th>
              <th>Expires</th>
              <th>Reason</th>
              <th>By</th>
            </tr>
          </thead>
          <tbody>
            {(report.data?.tlsExceptions ?? []).map((row) => (
              <tr key={row.id}>
                <td>
                  <Link to={`/apis/${row.resourceId}`}>{row.resourceName}</Link>
                </td>
                <td>{row.environment}</td>
                <td className="mono small">{row.backendUrl}</td>
                <td>
                  <span className={`badge ${row.mode === "insecure" ? "bad" : "warn"}`}>{row.mode}</span>
                </td>
                <td>{row.expiresInDays} days</td>
                <td className="small">{row.reason}</td>
                <td className="muted small">{row.createdBy}</td>
              </tr>
            ))}
            {(report.data?.tlsExceptions.length ?? 0) === 0 && (
              <tr>
                <td colSpan={7} className="muted">
                  None anywhere in the estate.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Panel>

      {/* Asked about the estate, beside the other two: "what are we not verifying" and "what are we
          refusing to reach" are the same auditor's visit. */}
      <Panel
        title="Routes a deny rule is keeping off the air"
        hint="A route whose backend an administrator has blocked is omitted from its environment's configuration, so no instance serves it. This is the estate-wide list, including the rule that stops each one."
      >
        <table>
          <thead>
            <tr>
              <th>API</th>
              <th>Environment</th>
              <th>Backend</th>
              <th>Blocked by</th>
              <th>Reason</th>
            </tr>
          </thead>
          <tbody>
            {(report.data?.blockedRoutes ?? []).map((row) => (
              <tr key={`${row.resourceId}:${row.environment}:${row.hostPattern}`}>
                <td>
                  <Link to={`/apis/${row.resourceId}`}>{row.resourceName}</Link>
                  <div className="muted small">{row.applicationId}</div>
                </td>
                <td>{row.environment}</td>
                <td className="mono small">{row.backendUrl}</td>
                <td className="mono small">{row.hostPattern}</td>
                <td className="small">{row.reason}</td>
              </tr>
            ))}
            {(report.data?.blockedRoutes.length ?? 0) === 0 && (
              <tr>
                <td colSpan={5} className="muted">
                  None — every released route's backend is one this estate is willing to reach.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Panel>

      <Panel
        title="Routes that identify callers by CN alone"
        hint="Accepted with acknowledgeCnOnly, which is the point: a common name is unique only within one issuer, so the blast radius is the breadth of the reverse proxy's client-CA bundle."
      >
        <ul className="plain">
          {(report.data?.cnOnlyRoutes ?? []).map((row) => (
            <li key={`${row.resourceId}:${row.environment}`}>
              <Link to={`/apis/${row.resourceId}`}>{row.resourceName}</Link>{" "}
              <span className="muted">{row.environment}</span>
            </li>
          ))}
          {(report.data?.cnOnlyRoutes.length ?? 0) === 0 && <li className="muted">None.</li>}
        </ul>
        {report.data?.clientCaBundle && (
          <>
            <p className="muted">
              The bundle the reverse proxy trusts, as declared in the integrations file:
            </p>
            <pre className="pre">{JSON.stringify(report.data.clientCaBundle, null, 2)}</pre>
          </>
        )}
        {report.data && !report.data.clientCaBundle && (
          <p className="muted">
            No client-CA bundle is declared in the integrations file, so how wide CN-only actually is
            cannot be answered from here.
          </p>
        )}
      </Panel>
    </>
  );
}
