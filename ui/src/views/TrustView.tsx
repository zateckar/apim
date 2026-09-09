import { formatDate } from "../lib/datetime";
import { useState } from "react";
import {
  api,
  type CertificateRow,
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
 * ceiling, and it has a reason long enough to be one. Neither is enforced here — the control plane
 * refuses either way — but a form that asks for them up front is the difference between a policy
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
  const [tab, setTab] = useState<"anchors" | "certificates" | "exceptions" | "report">(applicationId ? "certificates" : "anchors");

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
        {items.length === 0 ? (
          <EmptyState
            title={`No client certificates in ${environment.toUpperCase()}`}
            detail="A binding only needs one if its backend asks for mutual TLS. Uploading it here is what makes it available to choose on a backend."
            action={
              <button className="ghost small" onClick={() => setUploading(true)}>
                Upload a certificate
              </button>
            }
          />
        ) : (
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
            <button className="ghost small" onClick={() => setUploading(!uploading)}>
              {uploading ? "Cancel" : "Upload a certificate"}
            </button>
          </div>
        )}
        {uploading && (
          <UploadCertificate
            owner={applicationId}
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
  owner,
  user,
  environment,
  onDone,
}: {
  user: User;
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

  return (
    <div className="subform">
      <Notice kind="error">{action.error}</Notice>
      <Notice kind="ok">{action.message}</Notice>
      <div className="row">
        {owner ? <div className="field"><label>Application</label><input value={owner} readOnly/></div> : <TextField label="Application" value={applicationId} onChange={setApplicationId} />}
        <TextField label="Name" value={name} onChange={setName} placeholder="orders-backend" />
        <div className="field">
          <label>Environment</label>
          <input value={environment} readOnly />
        </div>
      </div>
      <div className="field">
        <label>Certificate (PEM)</label>
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
          Private key (PEM) <span className="muted">encrypted on arrival, never returned</span>
        </label>
        <textarea
          value={keyPem}
          placeholder="-----BEGIN PRIVATE KEY-----"
          onChange={(event) => setKeyPem(event.target.value)}
        />
      </div>
      <button
        disabled={action.busy}
        onClick={async () => {
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

  const chosen = MODES.find((entry) => entry.value === mode);

  return (
    <div className="subform">
      <Notice kind="error">{action.error ?? resources.error}</Notice>
      <Notice kind="ok">{action.message}</Notice>
      <div className="row">
        <div className="field">
          <label>API</label>
          <select value={resourceId} onChange={(event) => setResourceId(event.target.value)}>
            <option value="">choose…</option>
            {(resources.data?.items ?? []).map((resource) => (
              <option key={resource.id} value={resource.id}>
                {resource.name} {resource.apiVersion}
              </option>
            ))}
          </select>
        </div>
        <TextField
          label="Backend URL (blank = the whole pool)"
          value={backendUrl}
          onChange={setBackendUrl}
          placeholder="https://backend.internal:8443"
        />
        <TextField label="Expires in (days)" type="number" value={days} onChange={(next) => setDays(Number(next))} />
      </div>

      <div className="field">
        <label>Mode</label>
        <select value={mode} onChange={(event) => setMode(event.target.value)}>
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
          label="Pinned sha256 thumbprint (64 hex characters)"
          value={pinThumbprint}
          onChange={setPinThumbprint}
        />
      )}

      <div className="field">
        <label>
          Reason <span className="muted">at least 20 characters — name the ticket and the plan to remove it</span>
        </label>
        <textarea value={reason} onChange={(event) => setReason(event.target.value)} />
      </div>

      <button
        disabled={action.busy}
        onClick={async () => {
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

// ---------------------------------------------------------------- the governance report

function Report() {
  const report = useAsync(() => api.get<GovernanceReport>("/api/governance/exceptions"), []);

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
