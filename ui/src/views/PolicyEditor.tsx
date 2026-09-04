import { useEffect, useState } from "react";
import {
  api,
  type EffectivePolicyView,
  type Meta,
  type PolicyUnitRow,
  type ResourceDetail,
} from "../api";
import { Card, Field, Notice, useAction, useAsync } from "../components";

/**
 * Design section 5: whether a policy is attached is one fact, what its values are is another.
 * So every unit is attached or detached independently, and the form is driven by the catalogue
 * the control plane serves — the editor and the validator cannot disagree about what exists.
 *
 * Since the global tier exists (goal G2, deviation D18) this screen also has to answer *where a
 * unit came from*. That is the whole reason an environment-wide tier is tolerable: "why is this API
 * rate limited" stays answerable from the API's own page. Each unit therefore reads one of three
 * ways — set here, inherited from the environment, or set here **over** an environment default —
 * and the third says so explicitly `[R2-33]`.
 */
export function PolicyEditor({
  resource,
  meta,
  canEdit,
  environment,
}: {
  resource: ResourceDetail;
  meta: Meta;
  canEdit: boolean;
  environment: string;
}) {
  const policy = useAsync(
    () =>
      api.get<{ units: PolicyUnitRow[]; document: Record<string, unknown>; warnings: string[] }>(
        `/api/resources/${resource.id}/policy?environment=${environment}`,
      ),
    [resource.id, environment],
  );
  // The merged view, which is the only place the environment's own units are visible from here.
  const effective = useAsync(
    () =>
      api.get<EffectivePolicyView>(
        `/api/resources/${resource.id}/policy/effective?environment=${environment}`,
      ),
    [resource.id, environment],
  );

  const instances = meta.environments.find((e) => e.environment === environment)?.liveInstances ?? 1;
  // `errorFormat` only applies to `soap`; the catalogue says which variants offer each unit.
  const units = meta.policyUnits.filter(
    (unit) => !unit.appliesToKinds || unit.appliesToKinds.includes(resource.kind),
  );
  const inherited = new Map(
    (effective.data?.units ?? [])
      .filter((unit) => unit.origin === "global")
      .map((unit) => [unit.unitKey, unit.value]),
  );
  const globalKeys = new Set(effective.data?.globalUnits ?? []);

  const reload = () => {
    policy.reload();
    effective.reload();
  };

  return (
    <>
      <Card
        title={`Policy in ${environment}`}
        hint="Policy lives beside the backend binding, not on the frozen revision, so a limit or a header check can change without a release. It is per environment and a promotion seeds it forward without ever overwriting a local value."
      >
        <Notice kind="error">{policy.error}</Notice>
        {/* Without the merged view an inherited unit looks like an unattached one, so this is the
            remedy rather than a footnote: what is shown below is this API's own units only. */}
        {effective.error && (
          <Notice kind="warn">
            The environment's own units could not be read ({effective.error}), so what is inherited
            is not marked below. Reload before deciding a unit is not running.
          </Notice>
        )}
        {(policy.data?.warnings ?? []).map((warning) => (
          <Notice key={warning} kind="warn">
            {warning}
          </Notice>
        ))}
        {globalKeys.size > 0 && (
          <Notice kind="warn">
            {globalKeys.size} unit{globalKeys.size === 1 ? " is" : "s are"} inherited from{" "}
            {environment}'s environment-wide policy. Attaching the same unit here overrides it for
            this API — whole units, never field by field.
          </Notice>
        )}
        {units.map((unit) => (
          <Unit
            // Keyed by environment too: an editor carried across a switch would still hold dev's
            // value while the header said prod, and the next Save would write it there.
            key={`${environment}:${unit.key}`}
            unit={unit}
            attached={policy.data?.units.find((u) => u.unitKey === unit.key) ?? null}
            inheritedValue={inherited.has(unit.key) ? inherited.get(unit.key) : undefined}
            resourceId={resource.id}
            canEdit={canEdit}
            instances={instances}
            environment={environment}
            reload={reload}
          />
        ))}
      </Card>

      <Card title="Assembled document" hint="Exactly what the data plane receives for this route.">
        <pre className="pre">{JSON.stringify(effective.data?.document ?? policy.data?.document ?? {}, null, 2)}</pre>
      </Card>
    </>
  );
}

function Unit({
  unit,
  attached,
  inheritedValue,
  resourceId,
  canEdit,
  instances,
  environment,
  reload,
}: {
  unit: Meta["policyUnits"][number];
  attached: PolicyUnitRow | null;
  /** Present when the environment supplies this unit — `undefined` means it does not. */
  inheritedValue: unknown;
  environment: string;
  resourceId: string;
  canEdit: boolean;
  instances: number;
  reload: () => void;
}) {
  // What the form starts from: this API's value, else the environment's (so "override" begins from
  // what is actually in force rather than from a default nobody chose), else the catalogue default.
  const starting = attached?.value ?? inheritedValue ?? unit.defaultValue;
  const [value, setValue] = useState<unknown>(starting);
  const [advanced, setAdvanced] = useState(false);
  const [json, setJson] = useState(() => JSON.stringify(starting, null, 2));
  const action = useAction();
  const inherits = attached === null && inheritedValue !== undefined;

  useEffect(() => {
    const next = attached?.value ?? inheritedValue ?? unit.defaultValue;
    setValue(next);
    setJson(JSON.stringify(next, null, 2));
  }, [attached, inheritedValue, unit.defaultValue]);

  const update = (next: unknown) => {
    setValue(next);
    setJson(JSON.stringify(next, null, 2));
  };

  const save = async () => {
    let payload: unknown = value;
    if (advanced) {
      try {
        payload = JSON.parse(json);
      } catch (err) {
        action.setError(`not valid JSON: ${(err as Error).message}`);
        return;
      }
    }
    const ok = await action.run(
      () =>
        api.put(
          `/api/resources/${resourceId}/policy/units/${encodeURIComponent(unit.key)}?environment=${environment}`,
          { value: payload },
        ),
      attached ? "updated" : inherits ? "overridden for this API" : "attached",
    );
    if (ok) reload();
  };

  return (
    <div className={`unit ${attached ? "attached" : inherits ? "inherited" : ""}`}>
      <header>
        <h4>
          {unit.title} <span className="mono muted">{unit.key}</span>
        </h4>
        <div className="inline">
          <OriginBadge attached={attached} inherits={inherits} inheritedValue={inheritedValue} environment={environment} />
          <button className="ghost small" onClick={() => setAdvanced(!advanced)}>
            {advanced ? "form" : "JSON"}
          </button>
        </div>
      </header>
      <p className="desc">{unit.description}</p>

      {inherits && (
        <p className="muted">
          In force on this route because <strong>{environment}</strong> sets it for every API. Saving
          below attaches this API's own copy, which wins from then on; detaching it later falls back
          here again.
        </p>
      )}

      <Notice kind="error">{action.error}</Notice>
      <Notice kind="ok">{action.message}</Notice>

      {advanced ? (
        <div className="field">
          <textarea value={json} onChange={(event) => setJson(event.target.value)} />
        </div>
      ) : (
        <UnitForm unitKey={unit.key} value={value} onChange={update} instances={instances} />
      )}

      <div className="inline" style={{ marginTop: 10 }}>
        <button className="small" disabled={!canEdit || action.busy} onClick={save}>
          {attached ? "Save" : inherits ? "Override here" : "Attach"}
        </button>
        {attached && (
          <button
            className="danger small"
            disabled={!canEdit || action.busy}
            onClick={async () => {
              const ok = await action.run(
                () =>
                  api.del(
                    `/api/resources/${resourceId}/policy/units/${encodeURIComponent(unit.key)}?environment=${environment}`,
                  ),
                inheritedValue !== undefined ? "detached — the environment's value applies again" : "detached",
              );
              if (ok) reload();
            }}
          >
            Detach
          </button>
        )}
        {attached && (
          <span className="muted">
            last changed by {attached.updatedBy} at {new Date(attached.updatedAt).toLocaleString()}
          </span>
        )}
      </div>
    </div>
  );
}

function OriginBadge({
  attached,
  inherits,
  inheritedValue,
  environment,
}: {
  attached: PolicyUnitRow | null;
  inherits: boolean;
  inheritedValue: unknown;
  environment: string;
}) {
  if (attached) {
    return (
      <>
        <span className={`badge ${attached.origin === "local" ? "ok" : "warn"}`}>
          attached · {attached.origin}
        </span>
        {inheritedValue !== undefined && (
          <span className="badge warn" title={`${environment} sets this unit for every API; this API's own value wins`}>
            overrides {environment}
          </span>
        )}
      </>
    );
  }
  if (inherits) return <span className="badge warn">from {environment}</span>;
  return <span className="badge">not attached</span>;
}

// ---------------------------------------------------------------- the forms
//
// Real controls on the units people actually tune; everything else falls through to JSON. The line
// is drawn at units where a form removes a real chance of getting it wrong — a number with units, a
// closed set of choices, an interaction worth spelling out — rather than at "every unit deserves a
// form", which produces forty half-forms nobody trusts `[R2-33]`.

function UnitForm({
  unitKey,
  value,
  onChange,
  instances,
}: {
  unitKey: string;
  value: any;
  onChange: (next: unknown) => void;
  instances: number;
}) {
  if (unitKey === "auth.subscriptionKey") {
    return (
      <div className="row">
        <div className="field">
          <label>Key is sent in</label>
          <select value={value?.in ?? "header"} onChange={(e) => onChange({ ...value, in: e.target.value })}>
            <option value="header">header</option>
            <option value="query">query parameter</option>
          </select>
        </div>
        <Field label="Name" value={value?.name ?? ""} onChange={(name) => onChange({ ...value, name })} />
        <div className="field check">
          <input
            type="checkbox"
            checked={Boolean(value?.forwardCredentials)}
            onChange={(e) => onChange({ ...value, forwardCredentials: e.target.checked })}
          />
          <label>Forward the credential to the backend</label>
        </div>
      </div>
    );
  }

  if (unitKey === "rateLimit") {
    return (
      <>
        <div className="row">
          <Field
            label="Calls"
            type="number"
            value={value?.calls ?? 5}
            onChange={(calls) => onChange({ ...value, calls: Number(calls) })}
          />
          <Field
            label="Per (seconds)"
            type="number"
            value={value?.periodSec ?? 60}
            onChange={(periodSec) => onChange({ ...value, periodSec: Number(periodSec) })}
          />
          <div className="field">
            <label>Counted per</label>
            <select value={value?.scope ?? "route"} onChange={(e) => onChange({ ...value, scope: e.target.value })}>
              <option value="route">route</option>
              <option value="product">product (shared across its APIs)</option>
            </select>
          </div>
          <div className="field check">
            <input
              type="checkbox"
              checked={value?.emitHeaders !== false}
              onChange={(e) => onChange({ ...value, emitHeaders: e.target.checked })}
            />
            <label>Send X-RateLimit-* headers</label>
          </div>
        </div>
        <p className="muted" style={{ marginBottom: 0 }}>
          {value?.calls ?? 5}/{value?.periodSec ?? 60}s per instance × {instances} instance
          {instances === 1 ? "" : "s"} ⇒ up to {(value?.calls ?? 5) * Math.max(instances, 1)} per{" "}
          {value?.periodSec ?? 60}s across the fleet. Counted per subscription; requires the
          subscription-key unit.
        </p>
      </>
    );
  }

  if (unitKey === "quota") {
    const calls = value?.calls ?? 100_000;
    const periodSec = value?.periodSec ?? 2_592_000;
    return (
      <>
        <div className="row">
          <Field
            label="Calls"
            type="number"
            value={calls}
            onChange={(next) => onChange({ ...value, calls: Number(next) })}
          />
          <div className="field">
            <label>Per</label>
            <select
              value={String(periodSec)}
              onChange={(e) => onChange({ ...value, periodSec: Number(e.target.value) })}
            >
              <option value="86400">day</option>
              <option value="604800">week</option>
              <option value="2592000">30 days</option>
              <option value="31536000">365 days</option>
            </select>
          </div>
          <div className="field">
            <label>Counted per</label>
            <select value={value?.scope ?? "product"} onChange={(e) => onChange({ ...value, scope: e.target.value })}>
              <option value="product">product (shared across its APIs)</option>
              <option value="route">route</option>
            </select>
          </div>
          <div className="field check">
            <input
              type="checkbox"
              checked={value?.emitHeaders !== false}
              onChange={(e) => onChange({ ...value, emitHeaders: e.target.checked })}
            />
            <label>Send X-Quota-* headers</label>
          </div>
        </div>
        <p className="muted" style={{ marginBottom: 0 }}>
          Fleet-wide, unlike the rate limit: the control plane aggregates every instance's counter on
          the config poll, and an instance enforces the last aggregate plus its own delta since. So
          the worst case is one poll interval of overshoot, not a quota multiplied by{" "}
          {Math.max(instances, 1)}. A quota needs a subscription to count against, so the
          subscription-key unit has to be attached too.
        </p>
      </>
    );
  }

  if (unitKey === "validate") {
    const request = value?.request ?? "blocking";
    const response = value?.response ?? "disabled";
    const downgraded = request !== "blocking";
    // `downgradeReason` is only legal while request is downgraded, so switching back to blocking has
    // to drop it or the save is refused for a field the user cannot see.
    const setRequest = (next: string) => {
      const draft = { ...value, request: next };
      if (next === "blocking") delete draft.downgradeReason;
      onChange(draft);
    };
    return (
      <>
        <div className="row">
          <div className="field">
            <label>Requests</label>
            <select value={request} onChange={(e) => setRequest(e.target.value)}>
              <option value="blocking">blocking — reject what does not match</option>
              <option value="warning">warning — allow it through, record it</option>
              <option value="disabled">disabled — do not look</option>
            </select>
          </div>
          <div className="field">
            <label>Responses</label>
            <select value={response} onChange={(e) => onChange({ ...value, response: e.target.value })}>
              <option value="disabled">disabled — do not look</option>
              <option value="warning">warning — record a mismatch</option>
              <option value="blocking">blocking — 502 on a mismatch</option>
            </select>
          </div>
          <div className="field check">
            <input
              type="checkbox"
              checked={value?.headers !== false}
              onChange={(e) => onChange({ ...value, headers: e.target.checked })}
            />
            <label>Check headers and parameters</label>
          </div>
          <div className="field check">
            <input
              type="checkbox"
              checked={value?.body !== false}
              onChange={(e) => onChange({ ...value, body: e.target.checked })}
            />
            <label>Check bodies</label>
          </div>
        </div>

        {downgraded && (
          <div className="field">
            <label>
              Why <span className="muted">required, and recorded in the governance report</span>
            </label>
            <input
              value={value?.downgradeReason ?? ""}
              placeholder="INT-4412: the vendor sends an undeclared field until their March release"
              onChange={(e) => onChange({ ...value, downgradeReason: e.target.value })}
            />
          </div>
        )}

        {response === "blocking" && (
          <Notice kind="warn">
            A blocking response check turns the backend's own bug into a 502 the consumer sees. It is
            the right setting while a backend is being certified and the wrong one afterwards.
          </Notice>
        )}
        <p className="muted" style={{ marginBottom: 0 }}>
          Absence of this unit is not "off" — it is these defaults. The{" "}
          <span className="mono">always</span> block (content type, body size, nesting depth) is
          enforced in all three states and cannot be switched off from here; edit it as JSON.
          Response validation in warning mode is sampled, because sampling plus rejecting would make
          the same payload succeed by luck.
        </p>
      </>
    );
  }

  if (unitKey === "cors") {
    const origins: string[] = Array.isArray(value?.origins) ? value.origins : [];
    const methods: string[] = Array.isArray(value?.methods) ? value.methods : [];
    const wildcard = origins.includes("*");
    return (
      <>
        <div className="field">
          <label>
            Allowed origins <span className="muted">one per line, or a single *</span>
          </label>
          <textarea
            value={origins.join("\n")}
            placeholder="https://portal.example"
            onChange={(e) =>
              onChange({
                ...value,
                origins: e.target.value
                  .split("\n")
                  .map((line) => line.trim())
                  .filter(Boolean),
              })
            }
          />
        </div>
        <div className="field">
          <label>Methods</label>
          <div className="inline wrap">
            {["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].map((method) => (
              <label key={method} className="check-inline">
                <input
                  type="checkbox"
                  checked={methods.includes(method)}
                  onChange={(e) =>
                    onChange({
                      ...value,
                      methods: e.target.checked
                        ? [...methods, method]
                        : methods.filter((m) => m !== method),
                    })
                  }
                />
                {method}
              </label>
            ))}
          </div>
        </div>
        <div className="row">
          <Field
            label="Preflight cache (seconds)"
            type="number"
            value={value?.maxAgeSec ?? 600}
            onChange={(next) => onChange({ ...value, maxAgeSec: Number(next) })}
          />
          <div className="field check">
            <input
              type="checkbox"
              checked={Boolean(value?.credentials)}
              onChange={(e) => onChange({ ...value, credentials: e.target.checked })}
            />
            <label>Allow credentials</label>
          </div>
        </div>
        {wildcard && value?.credentials && (
          <Notice kind="error">
            Every browser refuses credentials with a wildcard origin, so this route would look
            configured and never work. List the origins instead.
          </Notice>
        )}
        <p className="muted" style={{ marginBottom: 0 }}>
          These headers are added to every response including the gateway's own rejections, so a
          browser sees a 401 rather than an opaque CORS failure. Use JSON for the request and exposed
          header lists.
        </p>
      </>
    );
  }

  if (unitKey === "retries") {
    const on: string[] = Array.isArray(value?.on) ? value.on : [];
    return (
      <>
        <div className="row">
          <Field
            label="Additional attempts"
            type="number"
            value={value?.attempts ?? 1}
            onChange={(next) => onChange({ ...value, attempts: Number(next) })}
          />
          <div className="field check">
            <input
              type="checkbox"
              checked={value?.idempotentOnly !== false}
              onChange={(e) => onChange({ ...value, idempotentOnly: e.target.checked })}
            />
            <label>Only retry idempotent methods</label>
          </div>
        </div>
        <div className="field">
          <label>Retry on</label>
          <div className="inline wrap">
            {["502", "503", "504", "timeout", "connect"].map((condition) => (
              <label key={condition} className="check-inline">
                <input
                  type="checkbox"
                  checked={on.includes(condition)}
                  onChange={(e) =>
                    onChange({
                      ...value,
                      on: e.target.checked ? [...on, condition] : on.filter((c) => c !== condition),
                    })
                  }
                />
                {condition}
              </label>
            ))}
          </div>
        </div>
        {value?.idempotentOnly === false && (
          <Notice kind="warn">
            Retrying a POST means the backend may process it twice. Turn this off only for a backend
            that is idempotent by key.
          </Notice>
        )}
        <p className="muted" style={{ marginBottom: 0 }}>
          Each attempt goes to the <em>next</em> backend in the pool, so a retry is only useful with
          more than one — against a single backend it doubles the load on something already failing.
          A request whose body was streamed cannot be retried at all.
        </p>
      </>
    );
  }

  if (unitKey === "circuitBreaker") {
    const failures = value?.failures ?? 5;
    const windowSec = value?.windowSec ?? 60;
    const openSec = value?.openSec ?? 30;
    return (
      <>
        <div className="row">
          <Field
            label="Failures"
            type="number"
            value={failures}
            onChange={(next) => onChange({ ...value, failures: Number(next) })}
          />
          <Field
            label="Within (seconds)"
            type="number"
            value={windowSec}
            onChange={(next) => onChange({ ...value, windowSec: Number(next) })}
          />
          <Field
            label="Stay open for (seconds)"
            type="number"
            value={openSec}
            onChange={(next) => onChange({ ...value, openSec: Number(next) })}
          />
          <Field
            label="Half-open probes"
            type="number"
            value={value?.halfOpenProbes ?? 1}
            onChange={(next) => onChange({ ...value, halfOpenProbes: Number(next) })}
          />
        </div>
        <p className="muted" style={{ marginBottom: 0 }}>
          {failures} failures within {windowSec}s take that backend out of the pool for {openSec}s,
          then {value?.halfOpenProbes ?? 1} request{(value?.halfOpenProbes ?? 1) === 1 ? "" : "s"} is
          let through to see whether it recovered. The counter is per instance and per backend, so
          one gateway's connectivity fault cannot trip the fleet — and, on the same reasoning, a
          genuinely dead backend is discovered independently by each instance.
        </p>
      </>
    );
  }

  if (unitKey === "passthrough") {
    const websocket = value?.websocket === true;
    const sse = value?.sse === true;
    return (
      <>
        <div className="row">
          <div className="field check">
            <input
              type="checkbox"
              checked={websocket}
              onChange={(e) => onChange({ ...value, websocket: e.target.checked })}
            />
            <label>WebSocket upgrades</label>
          </div>
          <div className="field check">
            <input
              type="checkbox"
              checked={sse}
              onChange={(e) => onChange({ ...value, sse: e.target.checked })}
            />
            <label>Server-sent events</label>
          </div>
        </div>
        <div className="row">
          <Field
            label="Idle timeout (seconds)"
            type="number"
            value={value?.streamIdleTimeoutSec ?? 300}
            onChange={(next) => onChange({ ...value, streamIdleTimeoutSec: Number(next) })}
          />
          <Field
            label="Maximum connection (seconds)"
            type="number"
            value={value?.maxConnectionSec ?? 3600}
            onChange={(next) => onChange({ ...value, maxConnectionSec: Number(next) })}
          />
          <Field
            label="Concurrent connections per instance"
            type="number"
            value={value?.maxConcurrentConnections ?? 50}
            onChange={(next) => onChange({ ...value, maxConcurrentConnections: Number(next) })}
          />
        </div>
        {!websocket && !sse && (
          <Notice kind="error">
            Turn on at least one. An attached unit that enables neither changes nothing and reads as
            if it did.
          </Notice>
        )}
        {websocket && (
          <Notice kind="warn">
            A WebSocket route cannot also validate requests, transform, or cache: after the upgrade
            there are frames rather than requests, and nothing in the contract describes them. Those
            units are refused at save time rather than ignored at runtime.
          </Notice>
        )}
        {sse && (
          <Notice kind="warn">
            An SSE route cannot validate or transform responses, or cache them — the response never
            ends, so there is nothing to check or store.
          </Notice>
        )}
        <p className="muted" style={{ marginBottom: 0 }}>
          The upgrade itself runs the entire request-side pipeline: authentication, the rate limit,
          the quota, IP rules, preconditions. After it, bytes are copied and bounded in bytes and
          seconds — never per message, because a per-message check is a protocol this gateway does
          not read. Revoking the subscription closes the socket at the next poll.
        </p>
      </>
    );
  }

  if (unitKey === "concurrency") {
    return (
      <>
        <div className="row">
          <Field
            label="Requests in flight per instance"
            type="number"
            value={value?.maxInFlight ?? 64}
            onChange={(next) => onChange({ ...value, maxInFlight: Number(next), per: "instance" })}
          />
          <Field
            label="Retry-After (seconds)"
            type="number"
            value={value?.retryAfterSec ?? 1}
            onChange={(next) => onChange({ ...value, retryAfterSec: Number(next) })}
          />
        </div>
        <p className="muted" style={{ marginBottom: 0 }}>
          {value?.maxInFlight ?? 64} × {Math.max(instances, 1)} instance
          {instances === 1 ? "" : "s"} ⇒ {(value?.maxInFlight ?? 64) * Math.max(instances, 1)} in
          flight across the fleet. Past the ceiling requests are shed with 503 rather than queued —
          queueing turns one slow backend into a gateway-wide outage.
        </p>
      </>
    );
  }

  if (unitKey === "preconditions") {
    const rules = Array.isArray(value) ? value : [];
    if (rules.length !== 1 || !rules[0]?.requireHeader) {
      return <p className="muted">This unit has {rules.length} rules — edit it as JSON.</p>;
    }
    const rule = rules[0];
    const check = rule.requireHeader;
    const mode = check.pattern !== undefined ? "pattern" : check.equals !== undefined ? "equals" : "present";
    const expected = check.pattern ?? check.equals ?? "";

    const rebuild = (next: { name?: string; mode?: string; expected?: string; status?: number; reason?: string }) => {
      const name = next.name ?? check.name;
      const nextMode = next.mode ?? mode;
      const nextExpected = next.expected ?? expected;
      const status = next.status ?? rule.deny.status;
      const reason = next.reason ?? rule.deny.reason;
      const requireHeader: Record<string, unknown> = { name };
      if (nextMode === "present") requireHeader.present = true;
      else requireHeader[nextMode] = nextExpected;
      onChange([
        {
          requireHeader,
          deny: { status, reason, body: { statusCode: status, message: reason } },
        },
      ]);
    };

    return (
      <>
        <div className="row">
          <Field label="Header name" value={check.name} onChange={(name) => rebuild({ name })} />
          <div className="field">
            <label>Requirement</label>
            <select value={mode} onChange={(e) => rebuild({ mode: e.target.value })}>
              <option value="present">is present</option>
              <option value="equals">equals (constant-time compare)</option>
              <option value="pattern">matches a regular expression</option>
            </select>
          </div>
          {mode !== "present" && (
            <Field label="Value" value={expected} onChange={(next) => rebuild({ expected: next })} />
          )}
        </div>
        <div className="row" style={{ marginTop: 10 }}>
          <Field
            label="Deny status"
            type="number"
            value={rule.deny.status}
            onChange={(status) => rebuild({ status: Number(status) })}
          />
          <Field label="Deny reason" value={rule.deny.reason} onChange={(reason) => rebuild({ reason })} />
        </div>
        <p className="muted" style={{ marginBottom: 0 }}>
          Evaluated after authentication and the rate limit, so a denied request has already spent
          rate-limit budget. Patterns are linted at write time: no nested quantifiers, no
          backreferences, no lookaround.
        </p>
      </>
    );
  }

  if (unitKey === "rewrite") {
    return (
      <div className="field check">
        <input
          type="checkbox"
          checked={Boolean(value?.stripBasePath)}
          onChange={(e) => onChange({ stripBasePath: e.target.checked })}
        />
        <label>Strip the route base path before calling the backend</label>
      </div>
    );
  }

  if (unitKey === "timeoutMs") {
    return (
      <div className="row">
        <Field
          label="Backend timeout (ms)"
          type="number"
          value={typeof value === "number" ? value : 30000}
          onChange={(next) => onChange(Number(next))}
        />
      </div>
    );
  }

  if (unitKey === "headers.request") {
    const sets = (value?.set ?? {}) as Record<string, string>;
    const first = Object.entries(sets)[0] ?? ["X-Subscription-Name", "${subscription.name}"];
    return (
      <>
        <div className="row">
          <Field
            label="Set header"
            value={first[0]}
            onChange={(name) => onChange({ ...value, set: { [name]: first[1] } })}
          />
          <Field
            label="Value (templates allowed)"
            value={first[1]}
            onChange={(next) => onChange({ ...value, set: { [first[0]]: next } })}
          />
        </div>
        <p className="muted" style={{ marginBottom: 0 }}>
          remove → set → append → skip, in that order. Values may use{" "}
          <span className="mono">{"${subscription.name}"}</span>,{" "}
          <span className="mono">{"${application.name}"}</span>,{" "}
          <span className="mono">{"${request.id}"}</span> and the rest of the closed variable set;
          anything else is rejected on save. Switch to JSON for the other three actions.
        </p>
      </>
    );
  }

  return <p className="muted">Edit this unit as JSON.</p>;
}
