import { httpUrlError, integerError } from "../lib/form-validation";
import { formatDate } from "../lib/datetime";
import { useState } from "react";
import {
  api,
  type BlockedRoute,
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
  ChoiceField,
  DangerZone,
  EmptyState,
  Field,
  TextField,
  Link,
  Modal,
  Notice,
  Skeleton,
  StatusChip,
  envLabel,
  useAction,
  useAsync,
} from "../components";
import { ALLOWED } from "../lib/capabilities";
import { tlsExceptionChip, tlsModeChip } from "../lib/status";
import { CertificateList } from "./CredentialsView";
import { TrustAnchors } from "./TrustAnchors";

/**
 * Trust, in the two directions it runs (design sections 4.3 and 5.4).
 *
 * Certificates are the identity this estate *presents* to a backend; TLS exceptions are the
 * verification it is willing to *skip*. They share a screen because they are the same question
 * asked from either end, and because the answer to "what are we not verifying" has to live
 * somewhere an auditor can find without knowing which API to look at.
 *
 * The certificates tab is the estate-wide *reading* only. An application manages its own on
 * Credentials, beside the passwords and keys it holds for the same backends — a certificate is a
 * credential with an expiry date, and that was two navigation entries for one question.
 *
 * Two things this screen insists on, both from section 5.4: an exception has an end date with a
 * ceiling, and it has a reason long enough to be one. The form checks the reason and whole-day
 * lifetime; the control plane also enforces the configured ceiling. Asking for them up front is the
 * difference between a policy and a nag.
 */
export function TrustView({
  meta,
  user,
  environment,
}: {
  meta: Meta;
  user: User;
  environment: string;
}) {
  // Authorities first, and deliberately: it is the rung that removes the need for the other two
  // tabs, and putting exceptions first would teach the expensive habit (plan §8).
  type Tab = "anchors" | "certificates" | "exceptions" | "deny" | "report";
  const [tab, setTab] = useState<Tab>("anchors");
  const tabs: Array<{ id: Tab; label: string }> = [
    { id: "anchors", label: "Certificate authorities" },
    { id: "certificates", label: "Client certificates" },
    { id: "exceptions", label: "TLS exceptions" },
    ...(user.isAdmin
      ? [
          { id: "deny", label: "Blocked backends" },
          { id: "report", label: "Governance report" },
        ] as const
      : []),
  ];

  return (
    <>
      <div className="tabs" role="group" aria-label="Trust sections">
        {tabs.map((entry) => (
          <button
            type="button"
            key={entry.id}
            className={tab === entry.id ? "tab active" : "tab"}
            aria-pressed={tab === entry.id}
            onClick={() => setTab(entry.id)}
          >
            {entry.label}
          </button>
        ))}
      </div>

      {tab === "anchors" && (
        <TrustAnchors meta={meta} environment={environment} isAdmin={user.isAdmin} />
      )}
      {/* The estate-wide reading of the rows an application manages on its own Credentials screen.
          One component for both, so a certificate does not describe itself one way to its owner
          and another way to an auditor. */}
      {tab === "certificates" && <CertificateList environment={environment} user={user} />}
      {tab === "exceptions" && <Exceptions user={user} environment={environment} />}
      {tab === "deny" && user.isAdmin && <DenyRules meta={meta} environment={environment} />}
      {tab === "report" && user.isAdmin && <Report />}
    </>
  );
}

// ---------------------------------------------------------------- TLS exceptions

const MODES = [
  { value: "pin", label: "Pin one certificate", help: "Verify against exactly this thumbprint. The strongest of the three, and the only one that is not a downgrade." },
  { value: "skip-hostname", label: "Skip the hostname check", help: "The chain is still verified; only the name in the certificate is ignored. For a backend reached by IP or an internal alias." },
  { value: "insecure", label: "Skip verification entirely", help: "Nothing about the backend's certificate is checked. Anything on the path can read and rewrite this traffic." },
];

/** `POST /api/trust/exceptions/:id/check` — one handshake per backend the exception covers. */
interface ExceptionCheck {
  anchors: number;
  backends: Array<{ url: string; wouldVerify: boolean; detail: string }>;
  wouldVerify: boolean;
}

function Exceptions({ user, environment }: { user: User; environment: string }) {
  const [includeExpired, setIncludeExpired] = useState(false);
  const scope = `${environment}:${includeExpired}`;
  const exceptions = useAsync(
    () =>
      api.get<{ items: TlsExceptionRow[] }>(
        `/api/trust/exceptions?environment=${environment}&includeExpired=${includeExpired ? "1" : "0"}`,
      ),
    [environment, includeExpired],
    scope,
  );
  const [creating, setCreating] = useState(false);
  const env = envLabel(environment);
  const items = exceptions.data?.items ?? [];

  return (
    <Panel
      title={`TLS exceptions in ${env}`}
      hint="Administrator-only, dated and reasoned. They live here rather than in an API's backend settings so that an owner cannot decide alone to stop verifying their own backend, and so that this list exists."
      actions={
        user.isAdmin && (
          <button type="button" className={creating ? "btn ghost sm" : "btn sm"} onClick={() => setCreating(!creating)}>
            {creating ? "Cancel" : "Add an exception"}
          </button>
        )
      }
    >
      {creating && (
        <NewException
          environment={environment}
          onDone={() => {
            setCreating(false);
            exceptions.reload();
          }}
        />
      )}

      <label className="check-inline">
        <input
          type="checkbox"
          checked={includeExpired}
          onChange={(event) => setIncludeExpired(event.target.checked)}
        />
        Show expired and revoked
      </label>

      <Notice kind="error">{exceptions.error}</Notice>
      {!exceptions.data ? (
        !exceptions.error && <Skeleton rows={3} />
      ) : items.length === 0 ? (
        <EmptyState
          title={includeExpired ? "No exception has ever been made here" : "Every backend is fully verified"}
          detail={`No live TLS exception in ${env}. This is the state to be in.`}
          action={
            includeExpired ? (
              <button type="button" className="btn sm" onClick={exceptions.reload}>Refresh</button>
            ) : (
              <button type="button" className="btn sm" onClick={() => setIncludeExpired(true)}>
                Show expired and revoked
              </button>
            )
          }
        />
      ) : (
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
            {items.map((row) => (
              <ExceptionRowView key={row.id} row={row} isAdmin={user.isAdmin} reload={exceptions.reload} />
            ))}
          </tbody>
        </table>
      )}
    </Panel>
  );
}

/**
 * One exception, with the two things somebody does about it: ask whether it is still needed, and
 * revoke it.
 *
 * Re-check comes first and is the cheap one. `trust-store`, *Check whether an exception is still
 * needed*, is a server probe that has existed since `[P3-04]` without a control anywhere in the
 * portal — so the only way to find out whether registering an authority had made an exception
 * redundant was to revoke it and see what broke, which is the order this row now reverses.
 */
function ExceptionRowView({ row, isAdmin, reload }: { row: TlsExceptionRow; isAdmin: boolean; reload: () => void }) {
  const check = useAction();
  const revoke = useAction();
  const [result, setResult] = useState<ExceptionCheck | null>(null);
  const [revoking, setRevoking] = useState(false);
  const adminOnly = "Only a platform administrator can check or revoke a TLS exception.";

  return (
    <>
      <tr className={row.live ? "" : "row-dim"}>
        <td>
          <Link to={`/apis/${row.resourceId}`}>{row.resourceName}</Link>
        </td>
        <td className="mono small">{row.backendUrl ?? <span className="muted">every backend in the pool</span>}</td>
        <td>
          <StatusChip chip={tlsModeChip(row.mode)} />
          {row.pinThumbprint && (
            <div className="mono small muted" title={row.pinThumbprint}>
              {row.pinThumbprint.slice(0, 16)}…
            </div>
          )}
        </td>
        <td>
          <StatusChip chip={tlsExceptionChip(row)} />
          <div className="muted small">{formatDate(row.revokedAt ?? row.expiresAt)}</div>
        </td>
        <td className="small">{row.reason}</td>
        <td className="muted small">{row.createdBy}</td>
        <td>
          {row.live && (
            <div className="inline">
              <button
                type="button"
                className="btn sm"
                disabled={!isAdmin || check.busy}
                title={isAdmin ? "Try the backend without this exception" : adminOnly}
                onClick={() =>
                  check.run(async () => {
                    setResult(null);
                    setResult(await api.post<ExceptionCheck>(`/api/trust/exceptions/${row.id}/check`, {}));
                  })
                }
              >
                {check.busy ? "Checking…" : "Re-check"}
              </button>
              <button
                type="button"
                className="btn danger sm"
                disabled={!isAdmin}
                title={isAdmin ? undefined : adminOnly}
                onClick={() => setRevoking(true)}
              >
                Revoke…
              </button>
            </div>
          )}
          {revoking && (
            <Modal title={`Revoke the TLS exception for ${row.resourceName}?`} close={() => setRevoking(false)}>
              <DangerZone
                open
                what="Revoke this exception"
                name={row.resourceName}
                consequence={`${row.resourceName} goes back to full certificate verification in ${envLabel(row.environment)} at the next configuration. If its backend still presents a certificate the gateway cannot verify, its calls start failing — Re-check first, or register the authority.`}
                permission={ALLOWED}
                busy={revoke.busy}
                error={revoke.error}
                onConfirm={async () => {
                  const ok = await revoke.run(() => api.del(`/api/trust/exceptions/${row.id}`));
                  if (ok) {
                    setRevoking(false);
                    reload();
                  }
                }}
              />
            </Modal>
          )}
        </td>
      </tr>
      {(check.error || result) && (
        <tr>
          <td colSpan={7}>
            <Notice kind="error">{check.error}</Notice>
            {result && (
              <>
                <Notice kind={result.wouldVerify ? "ok" : "warn"}>
                  {result.wouldVerify
                    ? `Still needed: no. Every backend this covers verifies without it, against the system roots and ${result.anchors} registered authorit${result.anchors === 1 ? "y" : "ies"} — it can be revoked.`
                    : "Still needed: yes. Revoking it now would break the backend listed below."}
                </Notice>
                <ul className="plain small">
                  {result.backends.map((backend) => (
                    <li key={backend.url}>
                      <span className="mono">{backend.url}</span> — {backend.detail}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </td>
        </tr>
      )}
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
      <div className="row">
        <Field label="API">
          <select value={resourceId} onChange={(event) => setResourceId(event.target.value)}>
            <option value="">choose…</option>
            {(resources.data?.items ?? []).map((resource) => (
              <option key={resource.id} value={resource.id}>
                {resource.name} {resource.apiVersion}
              </option>
            ))}
          </select>
        </Field>
        <TextField
          label="Backend URL (optional)" type="url" hint="Leave empty to apply to every backend in this API’s pool." error={httpUrlError(backendUrl, true)}
          value={backendUrl}
          onChange={setBackendUrl}
          placeholder="https://backend.internal:8443"
        />
        <TextField label="Expires in (days)" type="number" min={1} step={1} error={daysError} hint="A whole number of days; the server also enforces the estate’s maximum lifetime." value={days} onChange={(next) => setDays(Number(next))} />
      </div>

      {/* Three exclusive choices whose difference is the whole decision, so all three stay on
          screen rather than behind a select. */}
      <ChoiceField
        label="What to relax"
        value={mode}
        onChange={setMode}
        options={MODES.map((entry) => ({ value: entry.value, label: entry.label }))}
        hint={mode === "insecure" ? undefined : chosen?.help}
      />
      {mode === "insecure" && <Notice kind="warn">{chosen?.help}</Notice>}

      {mode === "pin" && (
        <TextField
          label="Pinned SHA-256 thumbprint (64 hex characters)" error={pinThumbprint ? pinError : null}
          value={pinThumbprint}
          onChange={setPinThumbprint}
        />
      )}

      <Field label="Reason" hint="At least 20 characters — name the ticket and the plan to remove it.">
        <textarea minLength={20} value={reason} onChange={(event) => setReason(event.target.value)} />
      </Field>

      {invalid && <p className="hint">Choose an API, provide a reason of at least 20 characters, and complete the fields required by the selected mode.</p>}
      <button
        type="button"
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
          );
          if (ok) onDone();
        }}
      >
        Create exception
      </button>
      <p className="muted small">
        Each gateway expires the exception on its own clock, so it cannot outlive its date through a
        control-plane outage. A connection already open keeps its TLS settings until it closes.
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

  if (rules.error) return <Notice kind="error">{rules.error}</Notice>;
  if (!rules.data) return <Skeleton rows={4} />;

  const items = rules.data.items;
  const blockedTotal = items.reduce((sum, rule) => sum + rule.blocking.length, 0);

  return (
    <>
      {blockedTotal > 0 && (
        <Notice kind="warn">
          {blockedTotal} route{blockedTotal === 1 ? " is" : "s are"} not being served because a rule
          below blocks {blockedTotal === 1 ? "its" : "their"} backend. Each one is listed with the
          rule that stops it.
        </Notice>
      )}

      <Panel
        title="Hosts this estate does not reach"
        hint="Egress is allowed by default: a team registers a backend without asking anybody. A rule here takes that back for one host — and it applies to routes already running, not only to the next one written."
        actions={
          (items.length > 0 || creating) && (
            <button type="button" className={creating ? "btn ghost sm" : "btn sm"} onClick={() => setCreating(!creating)}>
              {creating ? "Cancel" : "Block a host"}
            </button>
          )
        }
      >
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
        {items.length === 0 ? (!creating && (
          <EmptyState
            title="No host is blocked"
            detail="Any backend a team can reach is a backend they can register, as long as it is outside the denied network ranges in the integrations file. Add a rule when there is a host this estate should not reach."
            action={
              <button type="button" className="btn primary" onClick={() => setCreating(true)}>
                Block a host
              </button>
            }
          />
        )) : (
          <>
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
            <p className="muted small">
              {items.length} of {rules.data.maxRules} rules used
            </p>
          </>
        )}
      </Panel>

      {/* Listed, and visibly not removable. An administrator who cannot see this rule will one day
          spend an afternoon working out why a backend pointed at the portal will not save. */}
      <Panel
        title="Stated by the platform"
        hint="Not an administrator's rule and not removable: a route pointed back at the portal would let a gateway proxy to the control plane, which is neither a backend nor something a subscription should reach."
      >
        <ul className="plain">
          {rules.data.platformRules.map((rule) => (
            <li key={rule.id}>
              <span className="mono">{rule.hostPattern}</span>{" "}
              <span className="muted">every environment</span>{" "}
              {rule.blocking.length > 0 && (
                <span className="chip warn">blocking {rule.blocking.length}</span>
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

/** Where a blocked route lives: the API, its environment, and the backend the rule matched. */
function BlockedRouteLine({ route }: { route: BlockedRoute }) {
  return (
    <li>
      <Link to={`/apis/${route.resourceId}`}>{route.resourceName}</Link>{" "}
      <span className="muted">{envLabel(route.environment)} ·</span>{" "}
      <Link to={`/applications/${route.applicationId}`}>
        <span className="mono small">{route.applicationId}</span>
      </Link>{" "}
      <span className="mono small">{route.backendUrl}</span>
    </li>
  );
}

function DenyRuleRowView({ rule, reload }: { rule: DenyRuleRow; reload: () => void }) {
  const [showing, setShowing] = useState(false);
  const [deleting, setDeleting] = useState(false);
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
        <td>{rule.environment ? envLabel(rule.environment) : <span className="muted">every environment</span>}</td>
        <td className="small">{rule.reason}</td>
        <td>
          {rule.blocking.length === 0 ? (
            <span className="muted">nothing</span>
          ) : (
            <button type="button" className="btn ghost sm" aria-expanded={showing} onClick={() => setShowing(!showing)}>
              {rule.blocking.length} route{rule.blocking.length === 1 ? "" : "s"}
            </button>
          )}
        </td>
        <td className="muted small">
          {rule.createdBy}
          <div>{formatDate(rule.createdAt)}</div>
        </td>
        <td>
          <button type="button" className="btn danger sm" onClick={() => setDeleting(true)}>
            Delete…
          </button>
          {/* In a dialog rather than a collapsed box in the row: open inline, a typed confirmation
              stretched its table cell to the width of a form and pushed every other row aside. */}
          {deleting && (
            <Modal title={`Delete the rule for ${rule.hostPattern}?`} close={() => setDeleting(false)}>
              <DangerZone
                open
                what="Delete this rule"
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
                  if (ok) {
                    setDeleting(false);
                    reload();
                  }
                }}
              />
            </Modal>
          )}
        </td>
      </tr>
      {showing && (
        <tr>
          <td colSpan={6}>
            <ul className="plain">
              {rule.blocking.map((route) => (
                <BlockedRouteLine key={`${route.resourceId}:${route.environment}`} route={route} />
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
        <Field label="Applies to">
          <select
            value={scope}
            onChange={(event) => {
              setScope(event.target.value);
              setPreview(null);
            }}
          >
            <option value="">Every environment</option>
            {meta.chain.map((name) => (
              <option key={name} value={name}>
                {envLabel(name)} only
              </option>
            ))}
          </select>
        </Field>
        <Field label="Scheme">
          <select
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
        </Field>
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

      <Field label="Reason" hint="At least 20 characters — name the ticket, and what would have to be true to remove this.">
        <textarea minLength={20} value={reason} onChange={(event) => setReason(event.target.value)} />
      </Field>

      {/* Before saving, not after. A rule here stops routes across the fleet within a poll or two,
          and this is the only moment where that is still a question rather than an incident. */}
      <div className="native-actions">
        <button
          type="button"
          className="btn"
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
            <BlockedRouteLine key={`${route.resourceId}:${route.environment}`} route={route} />
          ))}
        </ul>
      )}

      {invalid && (
        <p className="hint">
          Give a host pattern and a reason of at least 20 characters.
        </p>
      )}
      <button
        type="button"
        className="btn primary"
        disabled={action.busy || invalid}
        onClick={async () => {
          if (invalid) return;
          const ok = await action.run(() => api.post("/api/trust/deny-rules", draft()));
          if (ok) onDone();
        }}
      >
        Block this host
      </button>
      <p className="muted small">
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
            {report.data.tlsExceptions.map((row) => (
              <tr key={row.id}>
                <td>
                  <Link to={`/apis/${row.resourceId}`}>{row.resourceName}</Link>
                </td>
                <td>{envLabel(row.environment)}</td>
                <td className="mono small">{row.backendUrl ?? <span className="muted">every backend in the pool</span>}</td>
                <td>
                  <StatusChip chip={tlsModeChip(row.mode)} />
                </td>
                <td>
                  <StatusChip chip={tlsExceptionChip({ live: true, revokedAt: null, expiresInDays: row.expiresInDays })} />
                </td>
                <td className="small">{row.reason}</td>
                <td className="muted small">{row.createdBy}</td>
              </tr>
            ))}
            {report.data.tlsExceptions.length === 0 && (
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
        hint="A route whose backend an administrator has blocked is left out of its environment's configuration, so no replica serves it."
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
            {report.data.blockedRoutes.map((row) => (
              <tr key={`${row.resourceId}:${row.environment}:${row.hostPattern}`}>
                <td>
                  <Link to={`/apis/${row.resourceId}`}>{row.resourceName}</Link>
                  <div className="muted small mono">{row.applicationId}</div>
                </td>
                <td>{envLabel(row.environment)}</td>
                <td className="mono small">{row.backendUrl}</td>
                <td className="mono small">{row.hostPattern}</td>
                <td className="small">{row.reason}</td>
              </tr>
            ))}
            {report.data.blockedRoutes.length === 0 && (
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
        hint="Their owners acknowledged the risk when they chose it: a common name is unique only within one issuer, so how far this reaches is decided by how many issuers the reverse proxy trusts."
      >
        <ul className="plain">
          {report.data.cnOnlyRoutes.map((row) => (
            <li key={`${row.resourceId}:${row.environment}`}>
              <Link to={`/apis/${row.resourceId}`}>{row.resourceName}</Link>{" "}
              <span className="muted">{envLabel(row.environment)}</span>
            </li>
          ))}
          {report.data.cnOnlyRoutes.length === 0 && <li className="muted">None.</li>}
        </ul>
        {report.data.clientCaBundle ? (
          <>
            <p className="muted">
              The issuers the reverse proxy trusts, as declared in the integrations file:
            </p>
            <pre className="pre">{JSON.stringify(report.data.clientCaBundle, null, 2)}</pre>
          </>
        ) : (
          <p className="muted">
            No client-CA bundle is declared in the integrations file, so how wide CN-only actually is
            cannot be answered from here.
          </p>
        )}
      </Panel>
    </>
  );
}
