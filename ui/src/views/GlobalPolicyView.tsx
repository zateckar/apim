import { formatDateTime } from "../lib/datetime";
import { useState } from "react";
import {
  api,
  type DowngradeReport,
  type GlobalPolicyView as GlobalPolicy,
  type Meta,
  type User,
} from "../api";
import {
  Panel,
  Field,
  Link,
  Modal,
  Notice,
  Skeleton,
  StatusChip,
  envLabel,
  useAction,
  useAsync,
  useLeaveGuard,
} from "../components";
import { globalUnitChip, schemaStateChip, validationChip } from "../lib/status";
import { EMPTY_CATALOGUE, summarize, UnitForm, type CredentialCatalogue } from "../portal/PolicyForm";

/**
 * The global policy tier (goal G2, deviation D18) — one environment's defaults, applied under
 * every API in it.
 *
 * The screen is built around the one number that matters: how many APIs this changes. A global
 * unit is the only edit in this platform that touches an estate rather than a resource, so the
 * blast radius is stated before the button, the units already overriding it are counted next to
 * each value, and every write is admin-only.
 *
 * Merged *under*, never over: an API that sets its own value keeps it, and the count of overrides
 * is how an admin sees that a global default is doing nothing.
 *
 * The environment is the shell's: this is an environment-scoped route, and a second switcher on the
 * page was a second place the environment could be chosen and disagree with the first.
 */
export function GlobalPolicyView({
  meta,
  user,
  environment,
}: {
  meta: Meta;
  user: User;
  environment: string;
}) {
  const policy = useAsync(
    () => api.get<GlobalPolicy>(`/api/policy/global?environment=${environment}`),
    [environment],
    environment,
  );
  const downgrades = useAsync(
    () => api.get<DowngradeReport>(`/api/validation/downgrades?environment=${environment}`),
    [environment],
    environment,
  );
  // The names an administrator registered, for the issuer and secret pickers. A refusal leaves the
  // pickers empty rather than the page broken, and says so above the units.
  const registered = useAsync(
    () => api.get<{ registered: CredentialCatalogue["registered"] }>(`/api/credentials?environment=${environment}`),
    [environment],
    environment,
  );
  const credentials: CredentialCatalogue = registered.data
    ? { ...EMPTY_CATALOGUE, registered: registered.data.registered }
    : EMPTY_CATALOGUE;
  const instances = meta.environments.find((row) => row.environment === environment)?.liveInstances ?? 1;

  if (policy.error) return <Notice kind="error">{policy.error}</Notice>;
  if (!policy.data) return <Skeleton rows={4} />;
  const attachable = policy.data.attachable;
  const attached = new Map(policy.data.units.map((unit) => [unit.unitKey, unit]));
  const canEdit = policy.data.canEdit && user.isAdmin;
  const env = envLabel(environment);
  const notAttachable = meta.policyUnits.length - attachable.length;

  return (
    <>
      <p className="muted small">
        Merged <strong>under</strong> every API's own policy: an API that sets the same unit keeps
        its own value, and detaching here removes it only from the APIs that were relying on it.
      </p>

      {/* The same linter the per-API screen uses, so the wording is per-route. Said out loud here,
          because on this page the subject is the environment rather than one API. */}
      {policy.data.warnings.map((warning) => (
        <Notice key={warning} kind="warn">
          <strong>Every API in {env}, unless it says otherwise:</strong> {warning}
        </Notice>
      ))}
      {!canEdit && (
        <Notice kind="info">
          Only a platform administrator can change the global tier, because one edit here changes
          every API in {env} at once. The current values are readable here.
        </Notice>
      )}

      <Panel>
        <div className="stats">
          <div className="stat">
            <span className="value">{policy.data.affectedResources}</span>
            <span className="label">APIs in {env}</span>
          </div>
          <div className="stat">
            <span className="value">{policy.data.units.length}</span>
            <span className="label">Units attached</span>
          </div>
          <div className="stat">
            <span className="value">{attachable.length}</span>
            <span className="label">Units that may be attached</span>
          </div>
        </div>
        {/* Folded away. It answers one number on this card and nothing else on the screen, and as
            an open paragraph it was the longest text on a page whose subject is a list of units.
            The count is computed rather than written: it said "the six that are missing" beside a
            figure that moves whenever the vocabulary or the allowlist does. */}
        {notAttachable > 0 && (
          <details className="page-aside">
            <summary>Why {notAttachable} units may not be attached here</summary>
            <p className="muted">
              The allowlist is deliberate: a unit is not globally attachable until somebody decides it
              should be. The ones that are missing are per-API by nature —{" "}
              <span className="mono">errorFormat</span> follows the variant;{" "}
              <span className="mono">rewrite</span>, <span className="mono">transform</span> and{" "}
              <span className="mono">backendAuth</span> describe one backend;{" "}
              <span className="mono">cache</span> depends on what a particular response means; and{" "}
              <span className="mono">passthrough</span> changes what a route <em>is</em>.
            </p>
          </details>
        )}
      </Panel>

      <Panel title={`Global units in ${env}`} className="global-policy-units">
        {registered.error && (
          <Notice kind="warn">
            The registered credential names could not be read, so the pickers below offer none:{" "}
            {registered.error}
          </Notice>
        )}
        {attachable.map((unitKey) => {
          const catalogue = meta.policyUnits.find((unit) => unit.key === unitKey);
          return (
            <GlobalUnit
              // Keyed by environment as well as unit: without it, switching dev → prod would keep
              // the editor's in-progress draft and the next Save would write dev's value to prod.
              key={`${environment}:${unitKey}`}
              unitKey={unitKey}
              title={catalogue?.title ?? unitKey}
              description={catalogue?.description ?? ""}
              defaultValue={catalogue?.defaultValue ?? {}}
              attached={attached.get(unitKey) ?? null}
              environment={environment}
              affected={policy.data!.affectedResources}
              canEdit={canEdit}
              reload={policy.reload}
              instances={instances}
              catalogue={credentials}
            />
          );
        })}
      </Panel>

      {/* Keyed for the same reason as the units above: the source list and the plan both belong to
          the environment being edited, and carrying either across a switch would be wrong. */}
      <CopyFrom
        key={environment}
        meta={meta}
        environment={environment}
        canEdit={canEdit}
        reload={policy.reload}
      />

      <Panel
        title="Validation downgrades"
        hint={`Every API in ${env} that does not refuse invalid requests, with the reason its owner gave. Downgrading is allowed; being on this list is the price.`}
      >
        <Notice kind="error">{downgrades.error}</Notice>
        {!downgrades.data ? (
          !downgrades.error && <Skeleton rows={3} />
        ) : (
          <>
            <table>
              <thead>
                <tr>
                  <th>API</th>
                  <th>Request</th>
                  <th>Response</th>
                  <th>Reason</th>
                  <th>Changed</th>
                </tr>
              </thead>
              <tbody>
                {downgrades.data.items.map((row) => (
                  <tr key={`${row.resourceId}:${row.environment}`}>
                    <td>
                      <Link to={`/apis/${row.resourceId}`}>{row.resourceName}</Link>{" "}
                      <span className="chip">{row.kind.toUpperCase()}</span>
                    </td>
                    <td><StatusChip chip={validationChip(row.request)} /></td>
                    <td><StatusChip chip={validationChip(row.response)} /></td>
                    <td>{row.downgradeReason ?? <span className="muted">none given</span>}</td>
                    {/* Who and when, both: the spec's reading of a downgrade is a decision somebody
                        made at a time, and a name without a date cannot be followed up. */}
                    <td className="muted small">
                      {row.updatedBy}
                      <div>{formatDateTime(row.updatedAt)}</div>
                    </td>
                  </tr>
                ))}
                {downgrades.data.items.length === 0 && (
                  <tr>
                    <td colSpan={5} className="muted">
                      Nothing is downgraded in {env} — every API refuses invalid requests.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>

            {downgrades.data.unvalidatable.length > 0 && (
              <>
                <h4>Operations that cannot be validated at all</h4>
                <p className="muted">
                  Not a downgrade anybody chose: the definition uses a schema keyword or a WSDL
                  construct outside the supported subset, so no setting validates these. The fix is
                  to the definition, not to the policy — which is also why each appears once, from
                  the definition currently in force.
                </p>
                <ul className="units">
                  {downgrades.data.unvalidatable.map((row) => (
                    <li key={`${row.resourceId}:${row.operationId}`}>
                      <Link to={`/apis/${row.resourceId}`}>{row.resourceName}</Link>{" "}
                      <span className="mono">{row.operationId}</span>{" "}
                      <StatusChip chip={schemaStateChip(row.schemaState)} />
                    </li>
                  ))}
                </ul>
              </>
            )}
          </>
        )}
      </Panel>
    </>
  );
}

/**
 * Whether a draft can be sent, said before Save rather than after.
 *
 * Only what the browser can know for certain: that it is the same *shape* as the unit's default — a
 * number where a number goes, an object where an object goes. The per-unit forms cannot produce
 * anything else; the JSON fallback some units still use can. Everything past that (bounds, field
 * names, the kind rules) is the control plane's, and its refusal is rendered on the same card.
 */
export function unitDraftError(value: unknown, defaultValue: unknown): string | null {
  const shape = (v: unknown) => (v === null ? "null" : Array.isArray(v) ? "list" : typeof v);
  const expected = shape(defaultValue);
  const actual = shape(value);
  if (expected === "null" || expected === "undefined" || expected === actual) return null;
  const said: Record<string, string> = {
    list: "a list ([ … ])",
    object: "an object ({ … })",
    number: "a number",
    boolean: "true or false",
    string: "a string in quotes",
  };
  return `This unit takes ${said[expected] ?? expected}, like its default — this is ${said[actual] ?? actual}.`;
}

function GlobalUnit({
  unitKey,
  title,
  description,
  defaultValue,
  attached,
  environment,
  affected,
  canEdit,
  reload,
  instances,
  catalogue,
}: {
  unitKey: string;
  title: string;
  description: string;
  defaultValue: unknown;
  attached: GlobalPolicy["units"][number] | null;
  environment: string;
  affected: number;
  canEdit: boolean;
  reload: () => void;
  instances: number;
  catalogue: CredentialCatalogue;
}) {
  const start = attached?.value ?? defaultValue;
  const [draft, setDraft] = useState<unknown>(start);
  // Remounts the form on Cancel, so a unit whose form holds text of its own (the JSON fallback, the
  // header rows) starts again from the stored value rather than from what was half-typed.
  const [round, setRound] = useState(0);
  const [open, setOpen] = useState(false);
  const [detaching, setDetaching] = useState(false);
  const action = useAction();
  // Its own handle, so a refused detach is said once, in the dialog, and not again on the editor
  // behind it.
  const detach = useAction();
  const env = envLabel(environment);
  const draftError = open ? unitDraftError(draft, defaultValue) : null;
  const changed = JSON.stringify(draft) !== JSON.stringify(start);
  // A half-written global value is the most expensive thing on this page to lose, and the most
  // expensive to save by accident — so leaving asks first, as the per-API editor does
  // (`api-policy-controls`, *Do not lose an unsaved policy edit*).
  useLeaveGuard(open && changed, `the ${title} global policy in ${env}`);
  const summary = attached ? summarize(unitKey, attached.value) : null;
  const endpoint = `/api/policy/global/units/${encodeURIComponent(unitKey)}?environment=${environment}`;
  const relying = attached ? Math.max(0, affected - attached.overriddenBy) : 0;

  return (
    <div className={`unit ${attached ? "attached" : ""}`}>
      <header>
        <h4>
          {title} <span className="mono muted">{unitKey}</span>
        </h4>
        <div className="inline">
          <StatusChip chip={globalUnitChip(Boolean(attached))} />
          {attached && attached.overriddenBy > 0 && (
            <StatusChip
              chip={{
                label: `${attached.overriddenBy} API${attached.overriddenBy === 1 ? "" : "s"} override it`,
                tone: "warn",
                title: "These APIs set this unit themselves, so the global value does not reach them.",
              }}
            />
          )}
          {/* Disabled rather than hidden for a reader who may not change it, with the reason said
              once at the top of the page (`platform-administration`, *nothing SHALL be hidden*). */}
          <button
            type="button"
            className="btn sm"
            aria-expanded={open}
            disabled={!canEdit}
            title={canEdit ? undefined : "Only a platform administrator can change the global tier."}
            onClick={() => {
              if (open) {
                setDraft(start);
                setRound(round + 1);
              }
              setOpen(!open);
            }}
          >
            {open ? "Cancel" : attached ? "Edit" : "Attach…"}
          </button>
        </div>
      </header>
      <p className="desc">{description}</p>

      {/* The value in the sentence the per-API editor uses for it, so the same unit reads the same
          on both tiers; the document itself only when the unit has no sentence. */}
      {attached && !open && (
        summary ? (
          <p className="policy-value">{summary}</p>
        ) : (
          <details className="policy-value">
            <summary>Current configuration</summary>
            <pre className="pre">{JSON.stringify(attached.value, null, 2)}</pre>
          </details>
        )
      )}

      {/* The per-API workspace's own form for this one unit, so an administrator sets a rate limit
          here with the same number-and-period controls a publisher does. This used to be a JSON box
          for every unit, because the forms lived inside `PolicyForm`; `UnitForm` is the half of it
          that edits one value. Only registered credential names are offered — no application's own
          credential can be the whole environment's default. */}
      {open && (
        <>
          <Notice kind="error">{action.error}</Notice>
          <fieldset className="unit-form" disabled={action.busy} key={round}>
            <UnitForm
              unitKey={unitKey}
              value={draft}
              onChange={setDraft}
              instances={instances}
              certificates={[]}
              certificate=""
              onCertificate={() => {}}
              catalogue={catalogue}
            />
          </fieldset>
          {draftError && <span className="field-error">{draftError}</span>}
          <div className="native-actions">
            <button
              type="button"
              className="btn primary sm"
              disabled={action.busy || Boolean(draftError) || (Boolean(attached) && !changed)}
              title={attached && !changed ? "Nothing has changed yet." : undefined}
              onClick={async () => {
                const ok = await action.run(
                  () => api.put(endpoint, { value: draft }),
                  attached ? `Saved for every API in ${env}.` : `Attached to every API in ${env}.`,
                );
                if (ok) {
                  setOpen(false);
                  reload();
                }
              }}
            >
              {attached ? "Save" : `Attach to every API in ${env}`}
            </button>
            {attached && (
              <button
                type="button"
                className="btn danger sm"
                disabled={action.busy}
                onClick={() => setDetaching(true)}
              >
                Detach…
              </button>
            )}
            <span className="muted small">
              Reaches {affected} API{affected === 1 ? "" : "s"} in {env} at the next configuration.
            </span>
          </div>
        </>
      )}
      {!open && <Notice kind="ok">{action.message ?? detach.message}</Notice>}

      {/* A dialog rather than a typed confirmation: detaching is undone by attaching again, so the
          typed name would be a guard pointing the wrong way. But it is not one click either — it
          changes every API relying on the value at once, and the value itself is not kept. */}
      {detaching && attached && (
        <Modal title={`Detach ${title} in ${env}?`} close={() => setDetaching(false)}>
          <p>
            {relying === 0
              ? `No API in ${env} is relying on it — every one sets ${title} itself — so nothing it serves changes.`
              : `${relying} API${relying === 1 ? "" : "s"} in ${env} stop${relying === 1 ? "s" : ""} receiving it at the next configuration.`}{" "}
            {attached.overriddenBy > 0 &&
              `The ${attached.overriddenBy} that set their own value keep it. `}
            The configuration here is discarded; attaching it again starts from the default.
          </p>
          <Notice kind="error">{detach.error}</Notice>
          <div className="native-actions">
            <button type="button" className="btn" onClick={() => setDetaching(false)}>
              Keep it attached
            </button>
            <button
              type="button"
              className="btn danger"
              disabled={detach.busy}
              onClick={async () => {
                const ok = await detach.run(() => api.del(endpoint), `Detached from ${env}.`);
                if (ok) {
                  setDetaching(false);
                  setOpen(false);
                  reload();
                }
              }}
            >
              Detach from {env}
            </button>
          </div>
        </Modal>
      )}

      {attached && (
        <p className="muted small">
          Last changed by {attached.updatedBy} on {formatDateTime(attached.updatedAt)}
        </p>
      )}
    </div>
  );
}

/** Copying an environment's globals forward, shown as a plan before it is applied. */
function CopyFrom({
  meta,
  environment,
  canEdit,
  reload,
}: {
  meta: Meta;
  environment: string;
  canEdit: boolean;
  reload: () => void;
}) {
  const others = meta.chain.filter((name) => name !== environment);
  const [from, setFrom] = useState(others[0] ?? "");
  const [plan, setPlan] = useState<Array<{ unitKey: string; before: unknown; after: unknown }> | null>(
    null,
  );
  const action = useAction();
  if (others.length === 0) return null;
  const env = envLabel(environment);

  return (
    <Panel
      title="Copy from another environment"
      hint="A copy, not a synchronisation: units this environment has and the source does not are left alone, because silently deleting a PROD-only global would be the worse default."
    >
      <Notice kind="error">{action.error}</Notice>
      <Notice kind="ok">{action.message}</Notice>
      <div className="row">
        <Field label="Copy from">
          <select value={from} disabled={action.busy} onChange={(event) => { setFrom(event.target.value); setPlan(null); }}>
            {others.map((name) => (
              <option key={name} value={name}>
                {envLabel(name)}
              </option>
            ))}
          </select>
        </Field>
        <button
          type="button"
          className="btn"
          disabled={!canEdit || action.busy}
          onClick={async () => {
            await action.run(async () => {
              const result = await api.post<{
                changes: Array<{ unitKey: string; before: unknown; after: unknown }>;
              }>(`/api/policy/global/copy-from?environment=${environment}`, { from, dryRun: true });
              setPlan(result.changes);
            });
          }}
        >
          Show what would change
        </button>
        {plan && plan.length > 0 && (
          <button
            type="button"
            className="btn primary"
            disabled={!canEdit || action.busy}
            onClick={async () => {
              const ok = await action.run(
                () =>
                  api.post(`/api/policy/global/copy-from?environment=${environment}`, {
                    from,
                    dryRun: false,
                  }),
                `Copied ${plan.length} unit${plan.length === 1 ? "" : "s"} from ${envLabel(from)} into ${env}.`,
              );
              if (ok) {
                setPlan(null);
                reload();
              }
            }}
          >
            Apply {plan.length} change{plan.length === 1 ? "" : "s"}
          </button>
        )}
      </div>

      {plan && plan.length === 0 && (
        <p className="muted">Nothing would change — {env} already has {envLabel(from)}'s global units.</p>
      )}
      {plan && plan.length > 0 && (
        <ul className="units">
          {plan.map((change) => (
            <li key={change.unitKey}>
              <strong className="mono">{change.unitKey}</strong>{" "}
              <span className="chip">{change.before === undefined ? "New here" : "Changes"}</span>
              <pre>{JSON.stringify(change.after, null, 2)}</pre>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
