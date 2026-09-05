import { useState } from "react";
import { DISABLED_KEY, disabledUnits } from "../../../shared/policy";
import { Field, Modal } from "./common";

/**
 * The policy editor: one card per attached unit, an **Add policy** picker for the rest, and a form
 * for each — the shape the previous portal's policy screen had, over this platform's native units
 * rather than over Azure policy XML.
 *
 * Three properties are the point.
 *
 * **The catalogue drives it.** The unit list comes from `meta.policyUnits`, which is
 * `shared/policy.ts`'s `UNIT_CATALOGUE` — the same table the validator reads. A unit added to the
 * platform appears here without anybody editing this file, and the editor cannot offer something
 * the control plane will refuse.
 *
 * **Order on the page is order at the gateway.** The sections are the pipeline — inbound,
 * upstream, outbound — and within a section the rows are in the order the units actually run. A
 * list that sorted alphabetically, or by when somebody happened to add each one, would teach the
 * reader something false about their own route.
 *
 * **Off and gone are different.** The power control moves a unit into the document's `disabled`
 * list, which the control plane subtracts before the config is rendered: the configuration stays
 * exactly as it is and no gateway is told about it. Somebody suppressing a rate limit during an
 * incident should not have to retype it afterwards, and that is not the same act as deleting it —
 * which the bin does, values and all.
 *
 * **Nothing is hidden without a sentence.** A unit that needs a second backend, or that only
 * applies to one variant, or that only an administrator may change, says so where the control would
 * have been.
 */

export interface UnitDef {
  key: string;
  title: string;
  group: "identity" | "traffic" | "shape" | "backend" | "protocol";
  description: string;
  defaultValue: unknown;
  appliesToKinds?: string[];
  global: boolean;
}

/**
 * Where in the pipeline each unit runs. The catalogue's `group` says what a unit is *about*;
 * this says *when* it happens, which is the question somebody reading a list of policies down the
 * page is actually asking — the order on screen has to be the order at the gateway or the list
 * teaches the wrong thing.
 *
 * A unit that straddles the boundary is filed where it is decided: `validate` and `cache` are
 * inbound even though both also touch the response, because that is where the request either
 * continues or does not.
 */
const PHASES: Array<{ id: string; label: string; note: string; units: string[] }> = [
  {
    id: "inbound",
    label: "Inbound",
    note: "on the request, before the backend is called",
    units: [
      "auth.subscriptionKey",
      "auth.basic",
      "auth.jwt",
      "auth.introspection",
      "auth.mtls",
      "ipAllow",
      "preconditions",
      "cors",
      "rateLimit",
      "quota",
      "concurrency",
      "cache",
      "validate",
      "rewrite",
      "headers.request",
      "transform",
    ],
  },
  {
    id: "upstream",
    label: "Upstream",
    note: "how the call to the backend is made",
    units: ["backendAuth", "timeoutMs", "retries", "circuitBreaker", "passthrough"],
  },
  {
    id: "outbound",
    label: "Outbound",
    note: "on the response, on the way back",
    units: ["headers.response", "errorFormat"],
  },
];

function phaseOf(unitKey: string): string {
  return PHASES.find((phase) => phase.units.includes(unitKey))?.id ?? "inbound";
}

/**
 * A one-line reading of what a unit is *set to*, for the collapsed row.
 *
 * The description says what a policy does and is the same on every API; this says what this one
 * says, which is the only thing that differs between two rows with the same title. Hand-written
 * where the shape has a headline number, and a generic scan of the top-level fields otherwise —
 * a wrong-but-confident summary would be worse than none, so the generic path only reports what
 * it can read literally.
 */
export function summarize(unitKey: string, value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (unitKey === "timeoutMs" && typeof value === "number") {
    return value % 1000 === 0 ? `${value / 1000}s` : `${value}ms`;
  }
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "on" : "off";
  if (Array.isArray(value)) {
    if (value.length === 0) return "empty";
    return value.every((entry) => typeof entry === "string")
      ? value.slice(0, 3).join(", ") + (value.length > 3 ? ` +${value.length - 3}` : "")
      : `${value.length} ${value.length === 1 ? "rule" : "rules"}`;
  }
  if (typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const count = (key: string, noun: string) => {
    const entry = v[key];
    const n = Array.isArray(entry) ? entry.length : 0;
    return `${n} ${noun}${n === 1 ? "" : "s"}`;
  };
  // A quota's period is a month in seconds. Nobody reads 2592000.
  const duration = (sec: unknown) => {
    if (typeof sec !== "number" || !Number.isFinite(sec)) return "?";
    if (sec >= 86_400 && sec % 86_400 === 0) return `${sec / 86_400}d`;
    if (sec >= 3_600 && sec % 3_600 === 0) return `${sec / 3_600}h`;
    if (sec >= 120 && sec % 60 === 0) return `${sec / 60}m`;
    return `${sec}s`;
  };
  switch (unitKey) {
    case "auth.subscriptionKey":
      return `${String(v.in ?? "header")} ${String(v.name ?? "")}`.trim();
    case "auth.jwt":
      return `${v.issuerRef || "no issuer"} · ${count("audience", "audience")}`;
    case "auth.introspection":
      return `${v.issuerRef || "no issuer"} · ${v.cacheTtlSec ?? 0}s cache`;
    case "auth.mtls":
      return `${count("allowedIssuers", "issuer")} · ${count("allowedSubjectCns", "CN")}`;
    case "auth.basic":
      return String(v.credentialRef || "no credential");
    case "rateLimit":
      return `${v.calls ?? "?"} calls / ${duration(v.periodSec)} per replica`;
    case "quota":
      return `${v.calls ?? "?"} calls / ${duration(v.periodSec)} across the fleet`;
    case "cache":
      return `${duration(v.ttlSec)}`;
    case "concurrency":
      return `${v.maxInFlight ?? "?"} in flight per replica`;
    case "retries":
      return `${v.attempts ?? "?"} ${v.attempts === 1 ? "attempt" : "attempts"}`;
    case "circuitBreaker":
      return `open after ${v.failures ?? "?"} ${v.failures === 1 ? "failure" : "failures"} in ${duration(v.windowSec)}`;
    case "validate":
      return `request ${v.request ?? "default"} · response ${v.response ?? "default"}`;
    case "rewrite": {
      const bits: string[] = [];
      if (v.stripBasePath) bits.push("strip base path");
      if (typeof v.path === "string" && v.path) bits.push(`path ${v.path}`);
      return bits.length > 0 ? bits.join(" · ") : "no change";
    }
    case "backendAuth":
      return String(v.type ?? "none");
    case "headers.request":
    case "headers.response":
      return `${count("set", "set")} · ${count("remove", "removal")}`;
    case "cors":
      return count("origins", "origin");
    case "errorFormat":
      return String(v.shape ?? "problem+json");
    default: {
      // Whatever the object literally says, up to three fields, skipping anything nested — a
      // summary that flattens an object is a summary that misleads.
      const parts = Object.entries(v)
        .filter(([, entry]) => typeof entry !== "object" || entry === null)
        .slice(0, 3)
        .map(([key, entry]) => `${key} ${String(entry)}`);
      return parts.length > 0 ? parts.join(" · ") : null;
    }
  }
}

/** Units that only make sense against more than one backend, and why. */
const NEEDS_POOL: Record<string, string> = {
  circuitBreaker:
    "A breaker takes a failing backend out of the pool. With one backend there is nothing to take " +
    "it out of — every request would be refused rather than routed elsewhere.",
  retries:
    "Each attempt goes to the next backend in the pool, so against a single backend a retry only " +
    "doubles the load on something that is already failing.",
};

export function attachedKeys(document: Record<string, unknown>): string[] {
  return Object.keys(document).filter((key) => key !== "operations");
}

export function PolicyForm({
  value,
  onChange,
  disabled,
  units,
  kind,
  isAdmin,
  instances,
  poolSize,
  certificates,
  certificate,
  onCertificate,
}: {
  /** The document as JSON text, because that is what the workspace holds and sends. */
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
  units: UnitDef[];
  kind: string;
  isAdmin: boolean;
  instances: number;
  poolSize: number;
  certificates: Array<{ id: string; name: string }>;
  certificate: string;
  onCertificate: (id: string) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  /** Values of units removed in this editing session, so Remove is recoverable before Save. */
  const [removed, setRemoved] = useState<Record<string, unknown>>({});

  let document: Record<string, unknown>;
  try {
    document = JSON.parse(value) as Record<string, unknown>;
  } catch (err) {
    return (
      <div className="notice error" data-testid="policies-parse-failed">
        The advanced JSON below is not valid ({(err as Error).message}), so the controls cannot be
        drawn over it. Correct it, or revert this tab, and they come back.
      </div>
    );
  }

  const offered = units.filter((unit) => !unit.appliesToKinds || unit.appliesToKinds.includes(kind));
  const known = new Set(offered.map((unit) => unit.key));
  const attached = attachedKeys(document).filter((key) => key !== DISABLED_KEY);
  /** Units in the document that this build has no card for: shown, never silently dropped. */
  const unrecognised = attached.filter((key) => !known.has(key));

  const write = (next: Record<string, unknown>) => onChange(JSON.stringify(next, null, 2));
  const set = (key: string, unit: unknown) => write({ ...document, [key]: unit });
  const remove = (key: string) => {
    const next = { ...document };
    setRemoved({ ...removed, [key]: next[key] });
    delete next[key];
    // A unit that is gone cannot also be switched off, and leaving its name behind would resurrect
    // the entry the next time somebody added it back.
    const stillOff = off.filter((entry) => entry !== key);
    if (stillOff.length > 0) next[DISABLED_KEY] = stillOff;
    else delete next[DISABLED_KEY];
    write(next);
    if (editing === key) setEditing(null);
  };

  const off = disabledUnits(document);
  /** Switched off, not removed: the value stays exactly as it is and the gateway is not told. */
  const toggle = (key: string) => {
    const next = { ...document };
    const stillOff = off.includes(key) ? off.filter((entry) => entry !== key) : [...off, key];
    if (stillOff.length > 0) next[DISABLED_KEY] = stillOff.sort();
    else delete next[DISABLED_KEY];
    write(next);
  };

  const cards = offered.filter((unit) => attached.includes(unit.key));
  const available = offered.filter((unit) => !attached.includes(unit.key));

  return (
    <div className="policy-editor">
      {unrecognised.length > 0 && (
        <div className="notice warn">
          {unrecognised.length} unit{unrecognised.length === 1 ? "" : "s"} in this document
          {unrecognised.length === 1 ? " is" : " are"} not offered for a {kind.toUpperCase()} API:{" "}
          <span className="mono">{unrecognised.join(", ")}</span>. They are kept exactly as they are
          and can be edited in the advanced JSON below.
        </div>
      )}

      {cards.length === 0 && (
        <p className="muted">
          No policy is attached in this environment, so this route runs on the platform defaults —
          which are not "nothing": requests are still validated against the definition, and the
          gateway's own limits still apply.
        </p>
      )}

      {cards.length > 0 && (
        <p className="muted small policy-order">
          Applied in order · request → upstream → response
        </p>
      )}

      {PHASES.map((phase) => {
        // Sorted by the phase's own list, so the page reads top to bottom in the order the
        // gateway runs them rather than in the order somebody happened to add them.
        const section = cards
          .filter((unit) => phaseOf(unit.key) === phase.id)
          .sort((a, b) => phase.units.indexOf(a.key) - phase.units.indexOf(b.key));
        if (section.length === 0) return null;
        return (
          <div className="policy-section" key={phase.id}>
            <div className="policy-section-label">
              {phase.label} — {phase.note}
            </div>
            {section.map((unit) => (
              <PolicyCard
                key={unit.key}
                unit={unit}
                value={document[unit.key]}
                summary={summarize(unit.key, document[unit.key])}
                enabled={!off.includes(unit.key)}
                onToggle={() => toggle(unit.key)}
                open={editing === unit.key}
                onOpen={() => setEditing(editing === unit.key ? null : unit.key)}
                onChange={(next) => set(unit.key, next)}
                onRemove={() => remove(unit.key)}
                disabled={disabled}
                lockedReason={
                  unit.key === "auth.subscriptionKey" && !isAdmin
                    ? "Whether this API requires a subscription key is an administrator's " +
                      "decision. You can see it here; ask an administrator to change it."
                    : null
                }
                warning={
                  NEEDS_POOL[unit.key] && poolSize < 2
                    ? `${NEEDS_POOL[unit.key]} This API has ${poolSize === 1 ? "one backend" : "no backends"}.`
                    : null
                }
                instances={instances}
                certificates={certificates}
                certificate={certificate}
                onCertificate={onCertificate}
              />
            ))}
          </div>
        );
      })}

      {off.length > 0 && (
        <p className="muted small">
          {off.length} polic{off.length === 1 ? "y is" : "ies are"} switched off: kept exactly as
          configured, and not sent to any gateway. Turning one back on is one click and no
          re-typing.
        </p>
      )}

      {Object.keys(removed).length > 0 && (
        <p className="muted">
          Removed in this tab and not yet saved:{" "}
          <span className="mono">{Object.keys(removed).join(", ")}</span>. Add one back to restore
          the values it had, or Save to make the removal real.
        </p>
      )}

      <div className="native-actions">
        <button
          type="button"
          className="btn"
          disabled={disabled || available.length === 0}
          onClick={() => setAdding(true)}
        >
          Add policy
        </button>
        <span className="muted">
          {attached.length} attached · {available.length} available for a {kind.toUpperCase()} API
        </span>
      </div>

      {adding && (
        <Modal title="Add a policy" close={() => setAdding(false)}>
          {/* Grouped by pipeline phase, the same way the attached list is: a policy that appears
              under Inbound when you add it should not appear under something else afterwards. */}
          {PHASES.map((phase) => {
            const section = available
              .filter((unit) => phaseOf(unit.key) === phase.id)
              .sort((a, b) => phase.units.indexOf(a.key) - phase.units.indexOf(b.key));
            if (section.length === 0) return null;
            return (
              <div key={phase.id}>
                <div className="policy-section-label">
                  {phase.label} — {phase.note}
                </div>
                {section.map((unit) => {
                  const blocked =
                    unit.key === "auth.subscriptionKey" && !isAdmin
                      ? "Only an administrator can attach this."
                      : NEEDS_POOL[unit.key] && poolSize < 2
                        ? NEEDS_POOL[unit.key]
                        : null;
                  return (
                    <div className="native-row" key={unit.key}>
                      <div>
                        <strong>{unit.title}</strong>{" "}
                        <span className="mono muted">{unit.key}</span>
                        <p>{unit.description}</p>
                        {blocked && <p className="muted">{blocked}</p>}
                      </div>
                      <button
                        type="button"
                        className="btn"
                        disabled={Boolean(blocked)}
                        onClick={() => {
                          set(unit.key, removed[unit.key] ?? unit.defaultValue);
                          setEditing(unit.key);
                          setAdding(false);
                        }}
                      >
                        Add
                      </button>
                    </div>
                  );
                })}
              </div>
            );
          })}
        </Modal>
      )}
    </div>
  );
}

/**
 * One attached policy, collapsed to a line: what it is, what it is set to, and three controls.
 *
 * Collapsed rather than a card of prose, because the question a policy list answers is "what runs
 * on this route, in what order" and eight paragraphs of description answer a different one. The
 * description is still there — it moves under the row when you open it, where somebody who is
 * about to change the thing will read it.
 */
function PolicyCard({
  unit,
  value,
  summary,
  enabled,
  onToggle,
  open,
  onOpen,
  onChange,
  onRemove,
  disabled,
  lockedReason,
  warning,
  instances,
  certificates,
  certificate,
  onCertificate,
}: {
  unit: UnitDef;
  value: unknown;
  summary: string | null;
  enabled: boolean;
  onToggle: () => void;
  open: boolean;
  onOpen: () => void;
  onChange: (next: unknown) => void;
  onRemove: () => void;
  disabled: boolean;
  lockedReason: string | null;
  warning: string | null;
  instances: number;
  certificates: Array<{ id: string; name: string }>;
  certificate: string;
  onCertificate: (id: string) => void;
}) {
  const locked = disabled || Boolean(lockedReason);
  return (
    <div className="policy-item">
      <div className={`policy-card${enabled ? "" : " off"}`}>
        <div className="policy-card-body">
          <div className="policy-card-title">
            {unit.title} <span className="mono muted">{unit.key}</span>
          </div>
          <div className="policy-card-summary">
            {summary ?? unit.description.split(".")[0]}
          </div>
        </div>
        <div className="policy-card-actions">
          <button
            type="button"
            className={`icon-btn${enabled ? "" : " inactive"}`}
            disabled={locked}
            aria-pressed={enabled}
            title={
              enabled
                ? "Switch off — the configuration is kept and the gateway stops applying it"
                : "Switch back on"
            }
            aria-label={`${enabled ? "Switch off" : "Switch on"} ${unit.title}`}
            onClick={onToggle}
          >
            ⏻
          </button>
          <button
            type="button"
            className="icon-btn"
            title={open ? "Close" : "Edit"}
            aria-label={`${open ? "Close" : "Edit"} ${unit.title}`}
            onClick={onOpen}
          >
            {open ? "▴" : "✎"}
          </button>
          <button
            type="button"
            className="icon-btn danger"
            disabled={locked}
            title="Remove — deletes the configuration as well"
            aria-label={`Remove ${unit.title}`}
            onClick={onRemove}
          >
            ✕
          </button>
        </div>
      </div>
      {!enabled && (
        <p className="muted small">
          Switched off. Its configuration is kept here and no gateway is told about it.
        </p>
      )}
      {lockedReason && <p className="muted small">{lockedReason}</p>}
      {warning && <div className="notice warn">{warning}</div>}
      {open && (
        <div className="policy-item-open">
          <p className="muted small">{unit.description}</p>
          <fieldset disabled={locked} className="native-form-grid">
            <UnitForm
              unitKey={unit.key}
              value={value}
              onChange={onChange}
              instances={instances}
              certificates={certificates}
              certificate={certificate}
              onCertificate={onCertificate}
            />
          </fieldset>
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ the per-unit forms
//
// A real control wherever one removes a genuine chance of getting it wrong — a number with units, a
// closed set of choices, an interaction worth spelling out. Everything else falls through to a JSON
// box for that unit alone, which is still better than the whole document: the field names and the
// error message belong to one policy.

function UnitForm({
  unitKey,
  value,
  onChange,
  instances,
  certificates,
  certificate,
  onCertificate,
}: {
  unitKey: string;
  value: any;
  onChange: (next: unknown) => void;
  instances: number;
  certificates: Array<{ id: string; name: string }>;
  certificate: string;
  onCertificate: (id: string) => void;
}) {
  const num = (next: string) => Number(next);

  if (unitKey === "auth.subscriptionKey") {
    return (
      <>
        <Field label="The key is sent in">
          <select value={value?.in ?? "header"} onChange={(e) => onChange({ ...value, in: e.target.value })}>
            <option value="header">a header</option>
            <option value="query">a query parameter</option>
          </select>
        </Field>
        <Field label="Named">
          <input value={value?.name ?? ""} onChange={(e) => onChange({ ...value, name: e.target.value })} />
        </Field>
        <Field label="Forward the credential to the backend">
          <select
            value={value?.forwardCredentials ? "yes" : "no"}
            onChange={(e) => onChange({ ...value, forwardCredentials: e.target.value === "yes" })}
          >
            <option value="no">No — strip it at the gateway</option>
            <option value="yes">Yes — the backend checks it too</option>
          </select>
        </Field>
      </>
    );
  }

  if (unitKey === "auth.basic") {
    return (
      <>
        <Field label="Credential reference">
          <input
            value={value?.credentialRef ?? ""}
            placeholder="a name registered in INTEGRATIONS_FILE"
            onChange={(e) => onChange({ ...value, credentialRef: e.target.value })}
          />
        </Field>
        <Field label="Realm">
          <input value={value?.realm ?? "api"} onChange={(e) => onChange({ ...value, realm: e.target.value })} />
        </Field>
        <p className="muted">
          The secret itself is never written here. The comparison is constant-time.
        </p>
      </>
    );
  }

  if (unitKey === "auth.jwt") {
    return (
      <>
        <Field label="Issuer reference">
          <input
            value={value?.issuerRef ?? ""}
            placeholder="an issuer an administrator registered"
            onChange={(e) => onChange({ ...value, issuerRef: e.target.value })}
          />
        </Field>
        <Field label="Header">
          <input
            value={value?.headerName ?? "Authorization"}
            onChange={(e) => onChange({ ...value, headerName: e.target.value })}
          />
        </Field>
        <Field label="Scheme">
          <input value={value?.scheme ?? "Bearer"} onChange={(e) => onChange({ ...value, scheme: e.target.value })} />
        </Field>
        <Field label="Audience (one per line)">
          <textarea
            value={(value?.audience ?? []).join("\n")}
            onChange={(e) =>
              onChange({
                ...value,
                audience: e.target.value.split("\n").map((line) => line.trim()).filter(Boolean),
              })
            }
          />
        </Field>
        <p className="muted">
          The algorithm allowlist and the JWKS come from the issuer's own registration, not from
          here — an API cannot widen what its issuer will accept.
        </p>
      </>
    );
  }

  if (unitKey === "auth.introspection") {
    return (
      <>
        <Field label="Issuer reference">
          <input
            value={value?.issuerRef ?? ""}
            onChange={(e) => onChange({ ...value, issuerRef: e.target.value })}
          />
        </Field>
        <Field label="Cache the answer for (seconds)">
          <input
            type="number"
            min={0}
            value={value?.cacheTtlSec ?? 60}
            onChange={(e) => onChange({ ...value, cacheTtlSec: num(e.target.value) })}
          />
        </Field>
        <p className="muted">
          The cache TTL is how long a revoked token keeps working. Shorter is safer and costs a
          round trip per call.
        </p>
      </>
    );
  }

  if (unitKey === "auth.mtls") {
    return (
      <>
        <Field label="Accept certificates issued by (one per line)">
          <textarea
            value={(value?.allowedIssuers ?? []).join("\n")}
            onChange={(e) =>
              onChange({
                ...value,
                allowedIssuers: e.target.value.split("\n").map((l) => l.trim()).filter(Boolean),
              })
            }
          />
        </Field>
        <Field label="Accept subject CNs (one per line, empty means any)">
          <textarea
            value={(value?.allowedSubjectCns ?? []).join("\n")}
            onChange={(e) =>
              onChange({
                ...value,
                allowedSubjectCns: e.target.value.split("\n").map((l) => l.trim()).filter(Boolean),
              })
            }
          />
        </Field>
        <p className="muted">
          This reads the certificate the reverse proxy already verified and passed on. A gateway
          with no trusted-proxy boundary configured refuses to activate a config using it, because
          the headers would otherwise be caller-controlled.
        </p>
      </>
    );
  }

  if (unitKey === "ipAllow") {
    const ranges: string[] = Array.isArray(value) ? value : [];
    return (
      <>
        <Field label="Allowed CIDR ranges (one per line)">
          <textarea
            value={ranges.join("\n")}
            placeholder="10.0.0.0/8"
            onChange={(e) =>
              onChange(e.target.value.split("\n").map((line) => line.trim()).filter(Boolean))
            }
          />
        </Field>
        <p className="muted">
          Behind a proxy the address checked is the rightmost untrusted one in{" "}
          <span className="mono">X-Forwarded-For</span>, not the proxy's own.
        </p>
      </>
    );
  }

  if (unitKey === "cors") {
    const origins: string[] = Array.isArray(value?.origins) ? value.origins : [];
    const methods: string[] = Array.isArray(value?.methods) ? value.methods : [];
    return (
      <>
        <Field label="Allowed origins (one per line, or a single *)">
          <textarea
            value={origins.join("\n")}
            placeholder="https://portal.example"
            onChange={(e) =>
              onChange({
                ...value,
                origins: e.target.value.split("\n").map((line) => line.trim()).filter(Boolean),
              })
            }
          />
        </Field>
        <Field label="Methods">
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
        </Field>
        <Field label="Preflight cache (seconds)">
          <input
            type="number"
            min={0}
            value={value?.maxAgeSec ?? 600}
            onChange={(e) => onChange({ ...value, maxAgeSec: num(e.target.value) })}
          />
        </Field>
        <Field label="Allow credentials">
          <select
            value={value?.credentials ? "yes" : "no"}
            onChange={(e) => onChange({ ...value, credentials: e.target.value === "yes" })}
          >
            <option value="no">No</option>
            <option value="yes">Yes</option>
          </select>
        </Field>
        {origins.includes("*") && value?.credentials && (
          <div className="notice error">
            Every browser refuses credentials with a wildcard origin, so this route would look
            configured and never work. List the origins instead.
          </div>
        )}
      </>
    );
  }

  if (unitKey === "preconditions") {
    const rules = Array.isArray(value) ? value : [];
    if (rules.length !== 1 || !rules[0]?.requireHeader) {
      return <JsonUnit value={value} onChange={onChange} note={`This unit has ${rules.length} rules.`} />;
    }
    const rule = rules[0];
    const check = rule.requireHeader;
    const mode = check.pattern !== undefined ? "pattern" : check.equals !== undefined ? "equals" : "present";
    const expected = check.pattern ?? check.equals ?? "";
    const rebuild = (next: Partial<{ name: string; mode: string; expected: string; status: number; reason: string }>) => {
      const name = next.name ?? check.name;
      const nextMode = next.mode ?? mode;
      const nextExpected = next.expected ?? expected;
      const status = next.status ?? rule.deny.status;
      const reason = next.reason ?? rule.deny.reason;
      const requireHeader: Record<string, unknown> = { name };
      if (nextMode === "present") requireHeader.present = true;
      else requireHeader[nextMode] = nextExpected;
      onChange([{ requireHeader, deny: { status, reason, body: { statusCode: status, message: reason } } }]);
    };
    return (
      <>
        <Field label="Header name">
          <input value={check.name} onChange={(e) => rebuild({ name: e.target.value })} />
        </Field>
        <Field label="Requirement">
          <select value={mode} onChange={(e) => rebuild({ mode: e.target.value })}>
            <option value="present">is present</option>
            <option value="equals">equals (constant-time compare)</option>
            <option value="pattern">matches a regular expression</option>
          </select>
        </Field>
        {mode !== "present" && (
          <Field label="Value">
            <input value={expected} onChange={(e) => rebuild({ expected: e.target.value })} />
          </Field>
        )}
        <Field label="Deny status">
          <input
            type="number"
            value={rule.deny.status}
            onChange={(e) => rebuild({ status: num(e.target.value) })}
          />
        </Field>
        <Field label="Deny reason">
          <input value={rule.deny.reason} onChange={(e) => rebuild({ reason: e.target.value })} />
        </Field>
        <p className="muted">
          Evaluated after authentication and the limits, so a denied request has already spent
          rate-limit budget.
        </p>
      </>
    );
  }

  if (unitKey === "validate") {
    const request = value?.request ?? "blocking";
    const response = value?.response ?? "disabled";
    const setRequest = (next: string) => {
      const draft = { ...value, request: next };
      if (next === "blocking") delete draft.downgradeReason;
      onChange(draft);
    };
    return (
      <>
        <Field label="Requests">
          <select value={request} onChange={(e) => setRequest(e.target.value)}>
            <option value="blocking">blocking — reject what does not match</option>
            <option value="warning">warning — let it through, record it</option>
            <option value="disabled">disabled — do not look</option>
          </select>
        </Field>
        <Field label="Responses">
          <select value={response} onChange={(e) => onChange({ ...value, response: e.target.value })}>
            <option value="disabled">disabled — do not look</option>
            <option value="warning">warning — record a mismatch</option>
            <option value="blocking">blocking — 502 on a mismatch</option>
          </select>
        </Field>
        {request !== "blocking" && (
          <Field label="Why (required, and recorded in the governance report)">
            <input
              value={value?.downgradeReason ?? ""}
              placeholder="INT-4412: the vendor sends an undeclared field until their March release"
              onChange={(e) => onChange({ ...value, downgradeReason: e.target.value })}
            />
          </Field>
        )}
        {response === "blocking" && (
          <div className="notice warn">
            A blocking response check turns the backend's own bug into a 502 the consumer sees. It
            is the right setting while a backend is being certified and the wrong one afterwards.
          </div>
        )}
        <p className="muted">
          Absence of this unit is not "off" — it is these defaults.
        </p>
      </>
    );
  }

  if (unitKey === "rewrite") {
    return (
      <Field label="Strip the route base path before calling the backend">
        <select
          value={value?.stripBasePath ? "yes" : "no"}
          onChange={(e) => onChange({ ...value, stripBasePath: e.target.value === "yes" })}
        >
          <option value="yes">Yes — the backend sees the path without it</option>
          <option value="no">No — forward the path as it arrived</option>
        </select>
      </Field>
    );
  }

  if (unitKey === "headers.request" || unitKey === "headers.response") {
    const sets = (value?.set ?? {}) as Record<string, string>;
    const first = Object.entries(sets)[0] ?? ["X-Subscription-Name", "${subscription.name}"];
    return (
      <>
        <Field label="Set header">
          <input
            value={first[0]}
            onChange={(e) => onChange({ ...value, set: { [e.target.value]: first[1] } })}
          />
        </Field>
        <Field label="Value (templates allowed)">
          <input
            value={first[1]}
            onChange={(e) => onChange({ ...value, set: { [first[0]]: e.target.value } })}
          />
        </Field>
        <p className="muted">
          remove → set → append → skip, in that order. Values may use{" "}
          <span className="mono">{"${subscription.name}"}</span>,{" "}
          <span className="mono">{"${application.name}"}</span> and the rest of the closed variable
          set; anything else is refused on save. Use the advanced JSON for the other three actions.
        </p>
      </>
    );
  }

  if (unitKey === "transform") {
    return (
      <>
        <Field label="Response">
          <select
            value={value?.response ?? "soap-to-json"}
            onChange={(e) => onChange({ ...value, request: "none", response: e.target.value })}
          >
            <option value="soap-to-json">SOAP to JSON</option>
            <option value="none">none</option>
          </select>
        </Field>
        <p className="muted">
          The request direction is <span className="mono">none</span> only: generating XML from an
          XSD is a writer, not a reader.
        </p>
      </>
    );
  }

  if (unitKey === "cache") {
    return (
      <>
        <Field label="Time to live (seconds)">
          <input
            type="number"
            min={1}
            value={value?.ttlSec ?? 60}
            onChange={(e) => onChange({ ...value, ttlSec: num(e.target.value) })}
          />
        </Field>
        <Field label="Separate cache per subscription">
          <select
            value={value?.varyBySubscription === false ? "no" : "yes"}
            onChange={(e) => onChange({ ...value, varyBySubscription: e.target.value === "yes" })}
          >
            <option value="yes">Yes — one consumer never sees another's response</option>
            <option value="no">No — shared across consumers</option>
          </select>
        </Field>
        <Field label="What downstream caches may do">
          <select
            value={value?.downstream ?? "private"}
            onChange={(e) => onChange({ ...value, downstream: e.target.value })}
          >
            <option value="private">private</option>
            <option value="public">public</option>
            <option value="no-store">no-store</option>
          </select>
        </Field>
        <p className="muted">
          Per instance, in memory, bounded, and keyed under the active config digest — activating a
          new config empties it. GET and HEAD only.
        </p>
      </>
    );
  }

  if (unitKey === "rateLimit" || unitKey === "quota") {
    const calls = value?.calls ?? (unitKey === "rateLimit" ? 5 : 100_000);
    const periodSec = value?.periodSec ?? (unitKey === "rateLimit" ? 60 : 2_592_000);
    return (
      <>
        <Field label="Calls">
          <input
            type="number"
            min={1}
            value={calls}
            onChange={(e) => onChange({ ...value, calls: num(e.target.value) })}
          />
        </Field>
        <Field label="Per (seconds)">
          <input
            type="number"
            min={1}
            value={periodSec}
            onChange={(e) => onChange({ ...value, periodSec: num(e.target.value) })}
          />
        </Field>
        <Field label="Counted per">
          <select
            value={value?.scope ?? (unitKey === "rateLimit" ? "route" : "product")}
            onChange={(e) => onChange({ ...value, scope: e.target.value })}
          >
            <option value="route">route</option>
            <option value="product">product (shared across its APIs)</option>
          </select>
        </Field>
        <Field label="Send the counter headers">
          <select
            value={value?.emitHeaders === false ? "no" : "yes"}
            onChange={(e) => onChange({ ...value, emitHeaders: e.target.value === "yes" })}
          >
            <option value="yes">Yes</option>
            <option value="no">No</option>
          </select>
        </Field>
        <p className="muted">
          {unitKey === "rateLimit" ? (
            <>
              Per instance: {calls}/{periodSec}s × {Math.max(instances, 1)} gateway
              {instances === 1 ? "" : "s"} ⇒ up to {calls * Math.max(instances, 1)} per {periodSec}s
              across the fleet. Counted per subscription, so the subscription-key unit has to be
              attached too.
            </>
          ) : (
            <>
              Fleet-wide, aggregated on the config poll, so the worst case is one poll interval of
              overshoot rather than a quota multiplied by {Math.max(instances, 1)}.
            </>
          )}
        </p>
      </>
    );
  }

  if (unitKey === "timeoutMs") {
    return (
      <>
        <Field label="Backend timeout (milliseconds)">
          <input
            type="number"
            min={1}
            value={typeof value === "number" ? value : 30000}
            onChange={(e) => onChange(num(e.target.value))}
          />
        </Field>
        <p className="muted">The whole upstream exchange, retries included.</p>
      </>
    );
  }

  if (unitKey === "retries") {
    const on: string[] = Array.isArray(value?.on) ? value.on : [];
    return (
      <>
        <Field label="Additional attempts">
          <input
            type="number"
            min={1}
            value={value?.attempts ?? 1}
            onChange={(e) => onChange({ ...value, attempts: num(e.target.value) })}
          />
        </Field>
        <Field label="Only retry idempotent methods">
          <select
            value={value?.idempotentOnly === false ? "no" : "yes"}
            onChange={(e) => onChange({ ...value, idempotentOnly: e.target.value === "yes" })}
          >
            <option value="yes">Yes</option>
            <option value="no">No — the backend is idempotent by key</option>
          </select>
        </Field>
        <Field label="Retry on">
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
        </Field>
        {value?.idempotentOnly === false && (
          <div className="notice warn">
            Retrying a POST means the backend may process it twice.
          </div>
        )}
      </>
    );
  }

  if (unitKey === "circuitBreaker") {
    const failures = value?.failures ?? 5;
    const windowSec = value?.windowSec ?? 60;
    const openSec = value?.openSec ?? 30;
    const probes = value?.halfOpenProbes ?? 1;
    return (
      <>
        <Field label="Failures">
          <input
            type="number"
            min={1}
            value={failures}
            onChange={(e) => onChange({ ...value, failures: num(e.target.value) })}
          />
        </Field>
        <Field label="Within (seconds)">
          <input
            type="number"
            min={1}
            value={windowSec}
            onChange={(e) => onChange({ ...value, windowSec: num(e.target.value) })}
          />
        </Field>
        <Field label="Stay open for (seconds)">
          <input
            type="number"
            min={1}
            value={openSec}
            onChange={(e) => onChange({ ...value, openSec: num(e.target.value) })}
          />
        </Field>
        <Field label="Half-open probes">
          <input
            type="number"
            min={1}
            value={probes}
            onChange={(e) => onChange({ ...value, halfOpenProbes: num(e.target.value) })}
          />
        </Field>
        <p className="muted">
          {failures} failures within {windowSec}s take that backend out of the pool for {openSec}s,
          then {probes} request{probes === 1 ? "" : "s"} is let through to see whether it recovered.
          The counter is per instance and per backend, so one gateway's connectivity fault cannot
          trip the fleet.
        </p>
      </>
    );
  }

  if (unitKey === "concurrency") {
    const maxInFlight = value?.maxInFlight ?? 64;
    return (
      <>
        <Field label="Requests in flight per gateway">
          <input
            type="number"
            min={1}
            value={maxInFlight}
            onChange={(e) => onChange({ ...value, maxInFlight: num(e.target.value), per: "instance" })}
          />
        </Field>
        <Field label="Retry-After (seconds)">
          <input
            type="number"
            min={0}
            value={value?.retryAfterSec ?? 1}
            onChange={(e) => onChange({ ...value, retryAfterSec: num(e.target.value) })}
          />
        </Field>
        <p className="muted">
          {maxInFlight} × {Math.max(instances, 1)} gateway{instances === 1 ? "" : "s"} ⇒{" "}
          {maxInFlight * Math.max(instances, 1)} in flight across the fleet. Past the ceiling
          requests are shed with 503 rather than queued.
        </p>
      </>
    );
  }

  /**
   * The backend client certificate, as a policy — which is where somebody looks for it, and where
   * the previous portal kept it. The certificate reference itself lives on the environment's
   * backend binding rather than in the policy document, because it is per environment and the
   * document is promoted; the control that picks it belongs here all the same, so `onCertificate`
   * writes through to the same Save.
   */
  if (unitKey === "backendAuth") {
    const type = value?.type ?? "none";
    return (
      <>
        <Field label="How the gateway authenticates to the backend">
          <select value={type} onChange={(e) => onChange({ type: e.target.value })}>
            <option value="none">Nothing</option>
            <option value="mtls">A client certificate (mutual TLS)</option>
            <option value="basic">HTTP Basic</option>
            <option value="api-key">An API key</option>
            <option value="oauth2-client-credentials">OAuth 2 client credentials</option>
            <option value="hmac-sa-key-lite">HMAC (SA-Key-Lite)</option>
          </select>
        </Field>
        {type === "mtls" && (
          <>
            <Field label="Client certificate">
              <select value={certificate} onChange={(e) => onCertificate(e.target.value)}>
                <option value="">No client certificate</option>
                {certificates.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </Field>
            {!certificate && (
              <div className="notice warn">
                Mutual TLS is selected and no certificate is bound in this environment, so the
                gateway will refuse to activate this route. Pick one, or upload one under
                Certificates.
              </div>
            )}
            <p className="muted">
              The certificate is bound per environment: promoting this API carries the policy, not
              the certificate, so each environment presents its own identity.
            </p>
          </>
        )}
        {type === "basic" && (
          <Field label="Credential reference">
            <input
              value={value?.credentialRef ?? ""}
              onChange={(e) => onChange({ ...value, credentialRef: e.target.value })}
            />
          </Field>
        )}
        {type === "api-key" && (
          <>
            <Field label="Credential reference">
              <input
                value={value?.credentialRef ?? ""}
                onChange={(e) => onChange({ ...value, credentialRef: e.target.value })}
              />
            </Field>
            <Field label="Sent in">
              <select value={value?.in ?? "header"} onChange={(e) => onChange({ ...value, in: e.target.value })}>
                <option value="header">a header</option>
                <option value="query">a query parameter</option>
              </select>
            </Field>
            <Field label="Named">
              <input
                value={value?.name ?? ""}
                onChange={(e) => onChange({ ...value, name: e.target.value })}
              />
            </Field>
          </>
        )}
        {type === "oauth2-client-credentials" && (
          <>
            <Field label="Token provider reference">
              <input
                value={value?.tokenProviderRef ?? ""}
                onChange={(e) => onChange({ ...value, tokenProviderRef: e.target.value })}
              />
            </Field>
            <Field label="Scope">
              <input
                value={value?.scope ?? ""}
                onChange={(e) => onChange({ ...value, scope: e.target.value })}
              />
            </Field>
          </>
        )}
        {type === "hmac-sa-key-lite" && (
          <>
            <Field label="Scheme reference">
              <input
                value={value?.schemeRef ?? ""}
                onChange={(e) => onChange({ ...value, schemeRef: e.target.value })}
              />
            </Field>
            <Field label="Service shortcut">
              <input
                value={value?.serviceShortcut ?? ""}
                onChange={(e) => onChange({ ...value, serviceShortcut: e.target.value })}
              />
            </Field>
          </>
        )}
        <p className="muted">
          Every reference resolves through the integrations file, so no owner writes a secret or a
          URL the gateway will call.
        </p>
      </>
    );
  }

  if (unitKey === "passthrough") {
    const websocket = value?.websocket === true;
    const sse = value?.sse === true;
    return (
      <>
        <Field label="WebSocket upgrades">
          <select
            value={websocket ? "yes" : "no"}
            onChange={(e) => onChange({ ...value, websocket: e.target.value === "yes" })}
          >
            <option value="no">No</option>
            <option value="yes">Yes</option>
          </select>
        </Field>
        <Field label="Server-sent events">
          <select
            value={sse ? "yes" : "no"}
            onChange={(e) => onChange({ ...value, sse: e.target.value === "yes" })}
          >
            <option value="no">No</option>
            <option value="yes">Yes</option>
          </select>
        </Field>
        <Field label="Idle timeout (seconds)">
          <input
            type="number"
            min={1}
            value={value?.streamIdleTimeoutSec ?? 300}
            onChange={(e) => onChange({ ...value, streamIdleTimeoutSec: num(e.target.value) })}
          />
        </Field>
        <Field label="Maximum connection (seconds)">
          <input
            type="number"
            min={1}
            value={value?.maxConnectionSec ?? 3600}
            onChange={(e) => onChange({ ...value, maxConnectionSec: num(e.target.value) })}
          />
        </Field>
        <Field label="Concurrent connections per gateway">
          <input
            type="number"
            min={1}
            value={value?.maxConcurrentConnections ?? 50}
            onChange={(e) => onChange({ ...value, maxConcurrentConnections: num(e.target.value) })}
          />
        </Field>
        {!websocket && !sse && (
          <div className="notice error">
            Turn on at least one. An attached unit that enables neither changes nothing and reads as
            if it did.
          </div>
        )}
        {websocket && (
          <div className="notice warn">
            A WebSocket route cannot also validate requests, transform, or cache: after the upgrade
            there are frames rather than requests. Those units are refused on save rather than
            ignored at runtime.
          </div>
        )}
      </>
    );
  }

  if (unitKey === "errorFormat") {
    return (
      <>
        <Field label="How a gateway rejection is rendered">
          <select value={value?.shape ?? "problem+json"} onChange={(e) => onChange({ shape: e.target.value })}>
            <option value="problem+json">problem+json</option>
            <option value="soap-fault">SOAP fault</option>
            <option value="jsonrpc">JSON-RPC error</option>
          </select>
        </Field>
        <p className="muted">
          The default is derived from the variant; attach this unit only to override it.
        </p>
      </>
    );
  }

  return <JsonUnit value={value} onChange={onChange} />;
}

/** The fallback for a unit with no purpose-built form: JSON for that unit alone. */
function JsonUnit({
  value,
  onChange,
  note,
}: {
  value: unknown;
  onChange: (next: unknown) => void;
  note?: string;
}) {
  const [text, setText] = useState(() => JSON.stringify(value, null, 2));
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <Field label="This unit, as JSON">
        <textarea
          rows={8}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            try {
              onChange(JSON.parse(e.target.value));
              setError(null);
            } catch (err) {
              setError((err as Error).message);
            }
          }}
        />
      </Field>
      {note && <p className="muted">{note}</p>}
      {error && <div className="notice error">Not valid JSON: {error}</div>}
    </>
  );
}
