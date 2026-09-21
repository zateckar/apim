import { formatDateTime } from "../lib/datetime";
import { useState } from "react";
import {
  api,
  type DowngradeReport,
  type FleetHealth,
  type GlobalPolicyView as GlobalPolicy,
  type Meta,
  type User,
  type ValidationCounters,
} from "../api";
import { Panel, EnvironmentPicker, Link, Notice, Skeleton, useAction, useAsync } from "../components";

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
 */
export function GlobalPolicyView({
  meta,
  user,
  environment,
  onEnvironment,
}: {
  meta: Meta;
  user: User;
  environment: string;
  onEnvironment: (next: string) => void;
}) {
  const policy = useAsync(
    () => api.get<GlobalPolicy>(`/api/policy/global?environment=${environment}`),
    [environment],
  );
  const downgrades = useAsync(
    () => api.get<DowngradeReport>(`/api/validation/downgrades?environment=${environment}`),
    [environment],
  );

  const attachable = policy.data?.attachable ?? [];
  const attached = new Map((policy.data?.units ?? []).map((unit) => [unit.unitKey, unit]));
  if (policy.error) return <Notice kind="error">{policy.error}</Notice>;
  if (!policy.data) return <Skeleton rows={4} />;

  return (
    <>
      <p className="muted small">
        Merged <strong>under</strong> every API's own policy: an API that sets the same unit keeps
        its own value, and detaching here removes it only from the APIs that were relying on it.
      </p>

      <Notice kind="error">{policy.error}</Notice>
      {/* The same linter the per-API screen uses, so the wording is per-route. Said out loud here,
          because on this page the subject is the environment rather than one API. */}
      {(policy.data?.warnings ?? []).map((warning) => (
        <Notice key={warning} kind="warn">
          <strong>Every API in {environment}, unless it says otherwise:</strong> {warning}
        </Notice>
      ))}
      {policy.data && !policy.data.canEdit && (
        <Notice kind="warn">
          Read-only: the global tier is admin-only, because one edit here changes every API in{" "}
          {environment} at once.
        </Notice>
      )}

      <Panel>
        <div className="stats">
          <div className="stat">
            <span className="value">{policy.data?.affectedResources ?? 0}</span>
            <span className="label">APIs in {environment}</span>
          </div>
          <div className="stat">
            <span className="value">{policy.data?.units.length ?? 0}</span>
            <span className="label">units attached here</span>
          </div>
          <div className="stat">
            <span className="value">{attachable.length}</span>
            <span className="label">units that may be</span>
          </div>
          <div className="stat">
            <span className="value">{meta.policyUnits.length - attachable.length}</span>
            <span className="label">that may not</span>
          </div>
        </div>
        {/* Folded away. It answers one number on this card and nothing else on the screen, and as
            an open paragraph it was the longest text on a page whose subject is a list of units.
            The count is computed rather than written: it said "the six that are missing" beside a
            figure that moves whenever the vocabulary or the allowlist does. */}
        <details className="page-aside">
          <summary>
            Why {meta.policyUnits.length - attachable.length} units may not be attached here
          </summary>
          <p className="muted" style={{ marginBottom: 0 }}>
            The allowlist is deliberate: a unit is not globally attachable until somebody decides it
            should be. The ones that are missing are per-API by nature —{" "}
            <span className="mono">errorFormat</span> follows the variant;{" "}
            <span className="mono">rewrite</span>, <span className="mono">transform</span> and{" "}
            <span className="mono">backendAuth</span> describe one backend;{" "}
            <span className="mono">cache</span> depends on what a particular response means; and{" "}
            <span className="mono">passthrough</span> changes what a route <em>is</em>.
          </p>
        </details>
      </Panel>

      {/* Keyed for the same reason as the units below: the source list and the plan both belong to
          the environment being edited, and carrying either across a switch would be wrong. */}
      <CopyFrom
        key={environment}
        meta={meta}
        environment={environment}
        canEdit={policy.data?.canEdit === true}
        reload={policy.reload}
      />

      <Panel title={`Global units in ${environment.toUpperCase()}`} className="global-policy-units">
        {attachable.map((unitKey) => {
          const catalogue = meta.policyUnits.find((unit) => unit.key === unitKey);
          return (
            <GlobalUnit
              // Keyed by environment as well as unit: without it, switching dev → prod would keep
              // the editor's in-progress JSON and the next Save would write dev's value to prod.
              key={`${environment}:${unitKey}`}
              unitKey={unitKey}
              title={catalogue?.title ?? unitKey}
              description={catalogue?.description ?? ""}
              defaultValue={catalogue?.defaultValue ?? {}}
              attached={attached.get(unitKey) ?? null}
              environment={environment}
              canEdit={policy.data?.canEdit === true && user.isAdmin}
              reload={policy.reload}
            />
          );
        })}
      </Panel>

      <ValidationHealth environment={environment} />

      <Panel
        title="Validation downgrades"
        hint="Every route in this environment not validating at the default, with the reason its owner gave. Downgrading is allowed; being on this list is the price (design section 5.1)."
      >
        <Notice kind="error">{downgrades.error}</Notice>
        <table>
          <thead>
            <tr>
              <th>API</th>
              <th>Environment</th>
              <th>Request</th>
              <th>Response</th>
              <th>Reason</th>
              <th>Changed by</th>
            </tr>
          </thead>
          <tbody>
            {(downgrades.data?.items ?? []).map((row) => (
              <tr key={`${row.resourceId}:${row.environment}`}>
                <td>
                  <Link to={`/apis/${row.resourceId}`}>{row.resourceName}</Link>{" "}
                  <span className="badge">{row.kind}</span>
                </td>
                <td>{row.environment}</td>
                <td>
                  <span className={`badge ${row.request === "blocking" ? "ok" : "warn"}`}>
                    {row.request}
                  </span>
                </td>
                <td>
                  <span className="badge">{row.response}</span>
                </td>
                <td>{row.downgradeReason ?? <span className="muted">none given</span>}</td>
                <td className="muted">{row.updatedBy}</td>
              </tr>
            ))}
            {downgrades.data?.items.length === 0 && (
              <tr>
                <td colSpan={6} className="muted">
                  Nothing is downgraded here — every route validates at the default.
                </td>
              </tr>
            )}
          </tbody>
        </table>

        {(downgrades.data?.unvalidatable.length ?? 0) > 0 && (
          <>
            <h4>Operations that cannot be validated at all</h4>
            <p className="muted">
              Not a downgrade anybody chose: the contract uses a schema keyword or a WSDL construct
              outside the implemented subset, so no state validates these. They are listed separately
              because the fix is to the definition, not to the policy — and for the same reason each
              appears once, from the definition currently in force, rather than once per environment
              it happens to be live in.
            </p>
            <ul className="units">
              {(downgrades.data?.unvalidatable ?? []).map((row) => (
                <li key={`${row.resourceId}:${row.operationId}`}>
                  <Link to={`/apis/${row.resourceId}`}>{row.resourceName}</Link>{" "}
                  <span className="mono">{row.operationId}</span>{" "}
                  <span className="badge warn">{row.schemaState}</span>
                </li>
              ))}
            </ul>
          </>
        )}
      </Panel>
    </>
  );
}

/**
 * What validation is actually doing out there, as opposed to what it is configured to do.
 *
 * The counters are per instance and not windowed, so they are summed across the fleet rather than
 * charted. Four of the five are the ones that matter: `rejected` is enforcement working,
 * `observed` is warning mode finding things nobody is acting on, and `sampleDropped` plus
 * `budgetShed` are the two ways a request goes unchecked without anybody being told — which is the
 * number this card exists to surface.
 */
function ValidationHealth({ environment }: { environment: string }) {
  const health = useAsync(
    () => api.get<FleetHealth>(`/api/targets/${environment}/health`),
    [environment],
  );

  const totals: ValidationCounters = {
    rejected: 0,
    observed: 0,
    sampleDropped: 0,
    unavailable: 0,
    budgetShed: 0,
  };
  let reporting = 0;
  for (const instance of health.data?.instances ?? []) {
    const counters = instance.process?.validation as Partial<ValidationCounters> | null | undefined;
    if (!counters) continue;
    reporting++;
    for (const key of Object.keys(totals) as Array<keyof ValidationCounters>) {
      totals[key] += counters[key] ?? 0;
    }
  }
  const unchecked = totals.sampleDropped + totals.budgetShed + totals.unavailable;

  return (
    <Panel
      title="Validation health"
      hint="Summed across the live gateways in this environment. The counters are per instance and reset when the control plane accepts a report, so this is recent activity rather than a lifetime total."
    >
      <Notice kind="error">{health.error}</Notice>
      {reporting === 0 ? (
        <p className="muted">
          No instance in {environment} has reported validation counters yet.
        </p>
      ) : (
        <>
          <div className="stats">
            <div className="stat">
              <span className="value ok">{totals.rejected.toLocaleString()}</span>
              <span className="label">rejected — blocking mode</span>
            </div>
            <div className="stat">
              <span className="value rejected">{totals.observed.toLocaleString()}</span>
              <span className="label">observed — warning mode</span>
            </div>
            <div className="stat">
              <span className="value">{totals.sampleDropped.toLocaleString()}</span>
              <span className="label">not sampled</span>
            </div>
            <div className="stat">
              <span className={totals.budgetShed > 0 ? "value upstream" : "value"}>
                {totals.budgetShed.toLocaleString()}
              </span>
              <span className="label">shed — memory budget</span>
            </div>
            <div className="stat">
              <span className={totals.unavailable > 0 ? "value upstream" : "value"}>
                {totals.unavailable.toLocaleString()}
              </span>
              <span className="label">no artifact available</span>
            </div>
          </div>

          {totals.observed > 0 && (
            <Notice kind="warn">
              {totals.observed.toLocaleString()} request
              {totals.observed === 1 ? "" : "s"} failed validation and were passed through anyway.
              Warning mode is an observation, not a control — a security review must not read it as
              one.
            </Notice>
          )}
          {totals.budgetShed > 0 && (
            <Notice kind="error">
              {totals.budgetShed.toLocaleString()} request
              {totals.budgetShed === 1 ? " was" : "s were"} shed at the blocking-mode memory ceiling.
              A blocking route that sheds is refusing traffic it would otherwise have validated;
              raise <span className="mono">BLOCKING_BUFFER_BUDGET_BYTES</span> or lower{" "}
              <span className="mono">always.maxBodyBytes</span> on the routes doing it.
            </Notice>
          )}
          {totals.unavailable > 0 && (
            <Notice kind="error">
              {totals.unavailable.toLocaleString()} request
              {totals.unavailable === 1 ? "" : "s"} could not be validated because the compiled
              artifact was missing. Activation is supposed to be gated on artifact availability, so
              this points at a gateway serving a config it should have refused.
            </Notice>
          )}
          <p className="muted" style={{ marginBottom: 0 }}>
            {unchecked.toLocaleString()} of{" "}
            {(totals.rejected + totals.observed + unchecked).toLocaleString()} candidate requests
            went unchecked, across {reporting} reporting instance{reporting === 1 ? "" : "s"}.
          </p>
        </>
      )}
    </Panel>
  );
}

function GlobalUnit({
  unitKey,
  title,
  description,
  defaultValue,
  attached,
  environment,
  canEdit,
  reload,
}: {
  unitKey: string;
  title: string;
  description: string;
  defaultValue: unknown;
  attached: GlobalPolicy["units"][number] | null;
  environment: string;
  canEdit: boolean;
  reload: () => void;
}) {
  const [json, setJson] = useState(() => JSON.stringify(attached?.value ?? defaultValue, null, 2));
  const [open, setOpen] = useState(false);
  const action = useAction();

  return (
    <div className={`unit ${attached ? "attached" : ""}`}>
      <header>
        <h4>
          {title} <span className="mono muted">{unitKey}</span>
        </h4>
        <div className="inline">
          {attached ? (
            <>
              <span className="badge ok">attached</span>
              {attached.overriddenBy > 0 && (
                <span className="badge warn" title="APIs that set this unit themselves">
                  {attached.overriddenBy} override{attached.overriddenBy === 1 ? "s" : ""} it
                </span>
              )}
            </>
          ) : (
            <span className="badge">not attached</span>
          )}
          <button className="ghost small" onClick={() => setOpen(!open)}>
            {open ? "hide" : attached ? "edit" : "attach"}
          </button>
        </div>
      </header>
      <p className="desc">{description}</p>

      {attached && !open && <details className="policy-value"><summary>Current configuration</summary><pre className="pre">{JSON.stringify(attached.value, null, 2)}</pre></details>}

      {open && (
        <>
          <Notice kind="error">{action.error}</Notice>
          <Notice kind="ok">{action.message}</Notice>
          <div className="field">
            <textarea aria-label={`${title} configuration`} value={json} onChange={(event) => setJson(event.target.value)} />
          </div>
          <div className="inline" style={{ marginTop: 10 }}>
            <button
              className="small"
              disabled={!canEdit || action.busy}
              onClick={async () => {
                let value: unknown;
                try {
                  value = JSON.parse(json);
                } catch (err) {
                  action.setError(`not valid JSON: ${(err as Error).message}`);
                  return;
                }
                const ok = await action.run(
                  () =>
                    api.put(
                      `/api/policy/global/units/${encodeURIComponent(unitKey)}?environment=${environment}`,
                      { value },
                    ),
                  "saved for every API in this environment",
                );
                if (ok) reload();
              }}
            >
              {attached ? "Save" : "Attach globally"}
            </button>
            {attached && (
              <button
                className="danger small"
                disabled={!canEdit || action.busy}
                onClick={async () => {
                  const ok = await action.run(
                    () =>
                      api.del(
                        `/api/policy/global/units/${encodeURIComponent(unitKey)}?environment=${environment}`,
                      ),
                    "detached",
                  );
                  if (ok) reload();
                }}
              >
                Detach
              </button>
            )}
          </div>
        </>
      )}

      {attached && (
        <p className="muted" style={{ marginTop: 8, marginBottom: 0 }}>
          last changed by {attached.updatedBy} at {formatDateTime(attached.updatedAt)}
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

  return (
    <Panel
      title="Copy from another environment"
      hint="A copy, not a synchronisation: units this environment has and the source does not are left alone, because silently deleting a prod-only global would be the worse default."
    >
      <Notice kind="error">{action.error}</Notice>
      <Notice kind="ok">{action.message}</Notice>
      <div className="row">
        <div className="field">
          <label>Copy from</label>
          <select value={from} disabled={action.busy} onChange={(event) => { setFrom(event.target.value); setPlan(null); }}>
            {others.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </div>
        <button
          className="ghost"
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
            disabled={!canEdit || action.busy}
            onClick={async () => {
              const ok = await action.run(
                () =>
                  api.post(`/api/policy/global/copy-from?environment=${environment}`, {
                    from,
                    dryRun: false,
                  }),
                `copied ${plan.length} unit(s) from ${from}`,
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
        <p className="muted" style={{ marginTop: 10, marginBottom: 0 }}>
          Nothing would change — {environment} already has {from}'s global units.
        </p>
      )}
      {plan && plan.length > 0 && (
        <ul className="units" style={{ marginTop: 10 }}>
          {plan.map((change) => (
            <li key={change.unitKey}>
              <strong className="mono">{change.unitKey}</strong>{" "}
              {change.before === undefined ? (
                <span className="badge ok">new</span>
              ) : (
                <span className="badge warn">changes</span>
              )}
              <pre>{JSON.stringify(change.after, null, 2)}</pre>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
