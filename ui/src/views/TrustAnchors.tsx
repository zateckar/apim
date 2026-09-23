import { nameError, NAME_HINT, NAME_PATTERN } from "../lib/form-validation";
import { formatDate } from "../lib/datetime";
import { useState } from "react";
import {
  api,
  type Meta,
  type TrustAnchorCopy,
  type TrustAnchorList,
  type TrustAnchorPreview,
  type TrustAnchorRow,
} from "../api";
import {
  Panel,
  DangerZone,
  EmptyState,
  Field,
  Modal,
  TextField,
  Notice,
  Skeleton,
  StatusChip,
  Term,
  envLabel,
  useAction,
  useAsync,
} from "../components";
import { ALLOWED, permitAdmin } from "../lib/capabilities";
import { anchorExpiryChip } from "../lib/status";

/**
 * Certificate authorities, per environment (G4, plan §8).
 *
 * This is rung 1 of the TLS ladder and it is the one that should absorb most cases: a backend whose
 * certificate chains to an authority registered here **verifies normally, with no exception**. The
 * screen therefore says two things that are easy to get wrong and expensive to get wrong:
 *
 *  - **an anchor is not an exception.** It is never counted as one, and registering the authority
 *    that signed your internal backends is what removes the need for exceptions rather than what
 *    creates them.
 *  - **it applies to every gateway in this environment**, at the next poll — not to one API, not to
 *    one backend, and not to the next environment along the chain. Trusting a CA in PROD is a PROD
 *    decision, so copying is an explicit act with a diff and a confirmation.
 */

export function TrustAnchors({
  meta,
  environment,
  isAdmin,
}: {
  meta: Meta;
  environment: string;
  isAdmin: boolean;
}) {
  const permission = permitAdmin(isAdmin, "register or remove a certificate authority");
  const anchors = useAsync(
    () =>
      isAdmin
        ? api.get<TrustAnchorList>(`/api/trust/anchors?environment=${environment}`)
        : Promise.resolve(null),
    [environment, isAdmin],
    environment,
  );

  if (!isAdmin) {
    // `[P1-26]`: the screen is not hidden, and it names who can change what is on it.
    return (
      <EmptyState
        title="Certificate authorities are managed by platform administrators"
        detail={permission.reason!}
        action={
          <span className="muted small">
            Deciding whose certificates a gateway verifies is an estate-wide decision, not an API's.
          </span>
        }
      />
    );
  }

  if (anchors.error) return <Notice kind="error">{anchors.error}</Notice>;
  if (!anchors.data) return <Skeleton rows={5} />;
  const items = anchors.data.items;
  const expiring = items.filter((row) => row.live && row.expiresInDays <= 30);
  const env = envLabel(environment);

  return (
    <>
      {expiring.length > 0 && (
        <Notice kind="warn">
          {expiring.length} authorit{expiring.length === 1 ? "y expires" : "ies expire"} within 30
          days. When one lapses, every backend whose certificate chains to it stops verifying —
          register the replacement before that date rather than after.
        </Notice>
      )}

      <Panel title={`Authorities trusted in ${env}`} hint={anchors.data.note}>
        {items.length === 0 ? (
          <EmptyState
            title="No internal authority registered here"
            detail="Until one is, a backend presenting an internally-signed certificate fails verification, and the only way past it is a dated TLS exception per backend."
            action={
              // Focus rather than navigation: the form is already on this page, below the list,
              // and what the empty state has to say is where the next step is.
              <button
                type="button"
                className="btn primary"
                onClick={() => document.getElementById("anchor-pem")?.focus()}
              >
                Register an authority
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
                <th>Fingerprint</th>
                <th>Also trusted in</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {items.map((row) => (
                <AnchorRow key={row.id} row={row} onChanged={anchors.reload} />
              ))}
            </tbody>
          </table>
        )}
        <p className="muted small">
          At most {anchors.data.maxAnchors} authorities per <Term name="environment" />. Each one is
          a set of backends somebody has decided to believe, so the list is meant to be short.
        </p>
      </Panel>

      <div className="trust-authority-actions">
        <Register taken={items.map(item => item.name)} environment={environment} onRegistered={anchors.reload} />
        <CopyFrom meta={meta} environment={environment} onCopied={anchors.reload} />
      </div>
    </>
  );
}

function AnchorRow({ row, onChanged }: { row: TrustAnchorRow; onChanged: () => void }) {
  const action = useAction();
  const [deleting, setDeleting] = useState(false);

  return (
    <tr className={row.expired ? "row-dim" : ""}>
      <td>
        <strong>{row.name}</strong>
        <div className="muted small">
          {row.addedBy} · {formatDate(row.addedAt)}
          {row.selfSigned === false && " · an intermediate, not a root"}
          {row.keyAlgorithm && ` · ${row.keyAlgorithm}`}
        </div>
      </td>
      <td className="small">{row.subject}</td>
      <td className="small muted">{row.issuer}</td>
      <td>
        <StatusChip chip={anchorExpiryChip(row, formatDate(row.notAfter))} />
        <div className="muted small">{formatDate(row.notAfter)}</div>
      </td>
      <td className="mono small" title={row.thumbprint}>
        {row.thumbprint.slice(0, 12)}…
      </td>
      <td>
        {row.alsoLiveIn.length === 0 ? (
          <span className="muted">only here</span>
        ) : (
          row.alsoLiveIn.map((other) => (
            <span key={other} className="chip">
              {envLabel(other)}
            </span>
          ))
        )}
      </td>
      <td className="right">
        <button type="button" className="btn danger sm" onClick={() => setDeleting(true)}>
          Delete…
        </button>
        {/* A dialog opened from the row, as every typed confirmation on Trust now is: collapsed
            inline, the confirmation box stretched its cell to the width of a form. */}
        {deleting && (
          <Modal title={`Stop trusting ${row.name}?`} close={() => setDeleting(false)}>
            <DangerZone
              open
              what="Delete this authority"
              name={row.name}
              consequence={`Every gateway in ${envLabel(row.environment)} stops trusting it at the next poll, and any backend whose certificate chains to it fails verification from that moment.`}
              permission={ALLOWED}
              busy={action.busy}
              error={action.error}
              onConfirm={async () => {
                const ok = await action.run(() => api.del(`/api/trust/anchors/${row.id}`));
                if (ok) {
                  setDeleting(false);
                  onChanged();
                }
              }}
            />
          </Modal>
        )}
      </td>
    </tr>
  );
}

/** Parse, look, then register. Nothing is stored by the preview, so nobody trusts blind. */
function Register({ environment, onRegistered, taken }: { environment: string; onRegistered: () => void; taken: string[] }) {
  const [pem, setPem] = useState("");
  const [name, setName] = useState("");
  const [preview, setPreview] = useState<TrustAnchorPreview | null>(null);
  const previewAction = useAction();
  const registerAction = useAction();
  const nameProblem = nameError(name) ?? (taken.includes(name) ? "An authority with this name is already registered in this environment." : null);
  const env = envLabel(environment);

  return (
    <Panel
      title={`Register an authority for ${env}`}
      hint="Paste the certificate authority's certificate in PEM form. It is parsed and shown to you before anything is stored."
    >
      <Notice kind="error">{previewAction.error || registerAction.error}</Notice>
      <Notice kind="ok">{registerAction.message}</Notice>

      <Field label="Certificate (PEM)">
        <textarea
          id="anchor-pem"
          disabled={previewAction.busy || registerAction.busy}
          value={pem}
          placeholder={"-----BEGIN CERTIFICATE-----\n…\n-----END CERTIFICATE-----"}
          onChange={(event) => {
            setPem(event.target.value);
            setPreview(null);
          }}
        />
      </Field>

      {preview ? (
        <>
          <dl className="kv">
            <dt>Subject</dt>
            <dd>{preview.subject}</dd>
            <dt>Issuer</dt>
            <dd>{preview.issuer}</dd>
            <dt>Valid until</dt>
            <dd>
              {formatDate(preview.notAfter)} ({preview.expiresInDays} days)
            </dd>
            <dt>Fingerprint</dt>
            <dd className="mono">{preview.thumbprint}</dd>
            <dt>Key</dt>
            <dd>{preview.keyAlgorithm}</dd>
            <dt>Kind</dt>
            <dd>
              {preview.ca ? "a certificate authority" : "not marked as an authority"}
              {preview.selfSigned ? ", self-signed (a root)" : ", signed by another (an intermediate)"}
            </dd>
          </dl>
          {!preview.ca && (
            <Notice kind="warn">
              This certificate is not marked as a certificate authority. Registering a server's own
              certificate here trusts exactly that one server and nothing it signs — which is
              usually not what was meant.
            </Notice>
          )}
          <TextField
            label="Name it" hint={NAME_HINT} pattern={NAME_PATTERN} maxLength={61} error={name ? nameProblem : null}
            value={name}
            onChange={setName}
            placeholder="corp-internal-root"
          />
          <button
            type="button"
            className="btn primary"
            disabled={registerAction.busy || Boolean(nameProblem)}
            onClick={async () => {
              const ok = await registerAction.run(
                () => api.post("/api/trust/anchors", { environment, name, pem }),
                `${name} is registered. Every gateway in ${env} will trust it at its next poll.`,
              );
              if (ok) {
                setPem("");
                setName("");
                setPreview(null);
                onRegistered();
              }
            }}
          >
            Trust this authority in {env}
          </button>
        </>
      ) : (
        <button
          type="button"
          className="btn"
          disabled={previewAction.busy || pem.trim().length === 0}
          onClick={async () => {
            setPreview(null);
            await previewAction.run(async () => {
              setPreview(await api.post<TrustAnchorPreview>("/api/trust/anchors/preview", { pem }));
            });
          }}
        >
          Read this certificate
        </button>
      )}
    </Panel>
  );
}

/**
 * Copying to another environment is an explicit act with a diff and a confirmation, exactly as
 * promoting a policy is: nothing about trust propagates along the chain on its own.
 */
function CopyFrom({
  meta,
  environment,
  onCopied,
}: {
  meta: Meta;
  environment: string;
  onCopied: () => void;
}) {
  const others = meta.chain.filter((candidate) => candidate !== environment);
  const [from, setFrom] = useState(others[0] ?? "");
  const [chosen, setChosen] = useState<string[]>([]);
  const [plan, setPlan] = useState<TrustAnchorCopy | null>(null);
  const source = useAsync(
    () => (from ? api.get<TrustAnchorList>(`/api/trust/anchors?environment=${from}`) : Promise.resolve(null)),
    [from],
    from,
  );
  const action = useAction();

  if (others.length === 0) return null;
  const candidates = (source.data?.items ?? []).filter((row) => row.live);
  const env = envLabel(environment);
  const blocked =
    plan === null
      ? "Read the plan first: copying trust is not something to do by accident."
      : plan.copy.length === 0
        ? "Nothing would be copied."
        : null;

  return (
    <Panel
      title="Copy an authority from another environment"
      hint="Trusting a certificate authority in PROD is a PROD decision, so nothing arrives here by being promoted. This copies what you pick, after showing you what it would do."
    >
      <Notice kind="error">{action.error}</Notice>
      <Notice kind="ok">{action.message}</Notice>

      <div className="row wrap">
        <Field label="From">
          <select
            disabled={action.busy}
            value={from}
            onChange={(event) => {
              setFrom(event.target.value);
              setChosen([]);
              setPlan(null);
            }}
          >
            {others.map((candidate) => (
              <option key={candidate} value={candidate}>
                {envLabel(candidate)}
              </option>
            ))}
          </select>
        </Field>
      </div>

      {source.error ? (
        // "Trusts nothing" and "could not be read" look identical as an empty list, and the first
        // is the one somebody would act on by uploading a duplicate PEM.
        <Notice kind="error">
          {envLabel(from)}'s authorities could not be listed: {source.error}
        </Notice>
      ) : source.loading ? <Skeleton rows={3} /> : candidates.length === 0 ? (
        <p className="muted small">{envLabel(from)} trusts no authorities of its own.</p>
      ) : (
        <ul className="plain">
          {candidates.map((row) => (
            <li key={row.id}>
              <label className="check-inline">
                <input
                  type="checkbox"
                  disabled={action.busy}
                  checked={chosen.includes(row.id)}
                  onChange={(event) => {
                    setPlan(null);
                    setChosen(
                      event.target.checked
                        ? [...chosen, row.id]
                        : chosen.filter((id) => id !== row.id),
                    );
                  }}
                />
                <strong>{row.name}</strong>
                <span className="muted small">
                  {row.subject} · expires in {row.expiresInDays} days
                </span>
              </label>
            </li>
          ))}
        </ul>
      )}

      {plan && (
        <>
          {plan.copy.length > 0 && (
            <Notice kind="warn">
              {plan.copy.length} authorit{plan.copy.length === 1 ? "y" : "ies"} would become trusted
              by every gateway in {env}: {plan.copy.map((entry) => entry.name).join(", ")}.
            </Notice>
          )}
          {plan.skipped.length > 0 && (
            <ul className="plain small muted">
              {plan.skipped.map((entry) => (
                <li key={entry.id}>
                  {candidates.find((row) => row.id === entry.id)?.name ?? entry.id}: {entry.reason}
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      <div className="native-actions">
        <button
          type="button"
          className="btn"
          disabled={action.busy || source.loading || Boolean(source.error) || chosen.length === 0}
          onClick={async () => {
            await action.run(async () => {
              setPlan(
                await api.post<TrustAnchorCopy>("/api/trust/anchors/copy-from", {
                  fromEnvironment: from,
                  environment,
                  ids: chosen,
                }),
              );
            });
          }}
        >
          Show me what this would do
        </button>
        <span className="action">
          <button
            type="button"
            className="btn primary"
            disabled={action.busy || blocked !== null}
            onClick={async () => {
              const ok = await action.run(
                () =>
                  api.post("/api/trust/anchors/copy-from", {
                    fromEnvironment: from,
                    environment,
                    ids: chosen,
                    dryRun: false,
                  }),
                `Copied into ${env}. Every gateway there picks it up at its next poll.`,
              );
              if (ok) {
                setPlan(null);
                setChosen([]);
                onCopied();
              }
            }}
          >
            Copy into {env}
          </button>
          {blocked && <span className="action-reason">{blocked}</span>}
        </span>
      </div>
    </Panel>
  );
}
