import { Fragment, useState } from "react";
import {
  DEFAULT_TIMEOUT_MS,
  DISABLED_KEY,
  disabledUnits,
  MAX_TIMEOUT_MS,
} from "../../../shared/policy";
import { Field, Link, Modal, Notice } from "../components";
import * as I from "./icons";

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

/**
 * What the credential pickers are drawn from: the application's own credentials in this
 * environment, and the names an administrator registered in the integrations file.
 *
 * Both, from one call, because the editor's job is to stop somebody typing a reference. Every one
 * of these boxes used to be a free-text input whose placeholder read "a name registered in
 * INTEGRATIONS_FILE" — a file the person filling the box cannot open, cannot add to, and whose
 * contents they had to be told. A typo in it is not a validation error: it is a policy that saves
 * cleanly and answers 503 at the first request.
 */
export interface CredentialCatalogue {
  applicationId: string;
  own: Array<{ name: string; kind: string; principal: string | null; ref: string }>;
  registered: { secrets: string[]; hmacSchemes: string[]; issuers: string[]; tokenProviders: string[] };
}

export const EMPTY_CATALOGUE: CredentialCatalogue = {
  applicationId: "",
  own: [],
  registered: { secrets: [], hmacSchemes: [], issuers: [], tokenProviders: [] },
};

export interface UnitDef {
  key: string;
  title: string;
  group: "identity" | "traffic" | "shape" | "backend" | "protocol";
  description: string;
  defaultValue: unknown;
  appliesToKinds?: string[];
  global: boolean;
}

// Category colour helps scan the catalogue; the title remains the identifier.
const GROUP_ICONS = { identity: I.Shield, traffic: I.Activity, shape: I.Edit, backend: I.Server, protocol: I.Globe };
function PolicyIcon({ group }: { group: UnitDef["group"] }) {
  const Icon = GROUP_ICONS[group];
  return <span className={`policy-category policy-category-${group}`} aria-hidden="true"><Icon size={18} /></span>;
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
 * A number of seconds as a person reads it: `30s`, `5m`, `2h`, `30d`. A quota's period is a month
 * in seconds, and nobody reads 2592000.
 */
export function humanDuration(sec: unknown): string {
  if (typeof sec !== "number" || !Number.isFinite(sec)) return "?";
  if (sec >= 86_400 && sec % 86_400 === 0) return `${sec / 86_400}d`;
  if (sec >= 3_600 && sec % 3_600 === 0) return `${sec / 3_600}h`;
  if (sec >= 120 && sec % 60 === 0) return `${sec / 60}m`;
  return `${sec}s`;
}

/** The units a duration field offers, and what one of each is worth in the stored unit. */
export const SECOND_UNITS = [
  { unit: "s", label: "seconds", factor: 1 },
  { unit: "min", label: "minutes", factor: 60 },
  { unit: "h", label: "hours", factor: 3_600 },
  { unit: "d", label: "days", factor: 86_400 },
] as const;
export const MILLISECOND_UNITS = [
  { unit: "ms", label: "milliseconds", factor: 1 },
  { unit: "s", label: "seconds", factor: 1_000 },
  { unit: "min", label: "minutes", factor: 60_000 },
] as const;
type DurationUnits = typeof SECOND_UNITS | typeof MILLISECOND_UNITS;

/**
 * The unit a stored duration opens in: the largest one it is a whole number of, so a month-long
 * quota opens as 30 days and a sixty-second cache as 1 minute, rather than as 2592000 and 60 in a
 * box labelled "(seconds)".
 */
export function unitFor(value: number, units: DurationUnits): string {
  if (!Number.isFinite(value) || value <= 0) return units[0].unit;
  let chosen: string = units[0].unit;
  for (const entry of units) if (value % entry.factor === 0) chosen = entry.unit;
  return chosen;
}

/**
 * A duration, typed as an amount and a unit and stored in the unit the vocabulary uses.
 *
 * Every period on this form was a bare number of seconds — the quota's default was 2592000 — which
 * is a sum the reader does before they can tell whether the value is right. Changing the unit keeps
 * the amount typed and changes the duration ("30", then "days"), which is what somebody choosing
 * a unit means; the stored value is always a whole number of the base unit.
 */
function DurationField({
  label,
  value,
  onChange,
  units = SECOND_UNITS,
  min = 0,
  max,
  hint,
}: {
  label: string;
  value: number;
  onChange: (next: number) => void;
  units?: DurationUnits;
  min?: number;
  max?: number;
  hint?: string;
}) {
  const [unit, setUnit] = useState(() => unitFor(value, units));
  const factor = units.find((entry) => entry.unit === unit)?.factor ?? 1;
  const amount = Number.isFinite(value) ? Number((value / factor).toFixed(3)) : "";
  return (
    <Field label={label} hint={hint}>
      <span className="duration-input">
        <input
          type="number"
          aria-label={label}
          min={min / factor}
          max={max === undefined ? undefined : max / factor}
          step="any"
          value={amount}
          onChange={(event) => onChange(Math.round(Number(event.target.value) * factor))}
        />
        <select
          aria-label={`${label}, unit`}
          value={unit}
          onChange={(event) => {
            const next = units.find((entry) => entry.unit === event.target.value)!;
            setUnit(next.unit);
            if (typeof amount === "number") onChange(Math.round(amount * next.factor));
          }}
        >
          {units.map((entry) => (
            <option key={entry.unit} value={entry.unit}>
              {entry.label}
            </option>
          ))}
        </select>
      </span>
    </Field>
  );
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
  const duration = humanDuration;
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
      return `${v.calls ?? "?"} calls / ${duration(v.periodSec)} per gateway`;
    case "quota":
      return `${v.calls ?? "?"} calls / ${duration(v.periodSec)} across all gateways`;
    case "cache":
      return `${duration(v.ttlSec)}`;
    case "concurrency":
      return `${v.maxInFlight ?? "?"} in flight per gateway`;
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
    case "headers.response": {
      // The collapsed row says what the rules *do*. It used to read "0 sets · 0 removals", which
      // named two of the four actions and counted a unit doing three things as doing none.
      const rules = headerRulesOf(v);
      if (rules.length === 0) return "no rules";
      const verbs: Record<string, string> = {
        remove: "removed",
        set: "overwritten",
        append: "appended",
        skip: "set if missing",
      };
      return HEADER_ACTIONS.map((entry) => ({
        verb: verbs[entry.action]!,
        n: rules.filter((rule) => rule.action === entry.action).length,
      }))
        .filter((entry) => entry.n > 0)
        .map((entry) => `${entry.n} ${entry.verb}`)
        .join(" · ");
    }
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

/**
 * A reference, chosen rather than typed.
 *
 * Two sources and they are not interchangeable, so they are two groups rather than one list: the
 * application's own credentials, which whoever is reading this can add to on the Credentials
 * screen, and the administrator-registered names, which they cannot. A value that matches neither
 * — a credential since deleted, a document written against another estate — is kept as its own
 * option and marked, because silently resetting somebody's policy to "none" while they were
 * looking at a different tab is worse than showing them a reference that no longer resolves.
 */
function CredentialPicker({
  label,
  hint,
  value,
  onChange,
  catalogue,
  kinds,
  registered,
}: {
  label: string;
  hint?: string;
  value: string;
  onChange: (next: string) => void;
  catalogue: CredentialCatalogue;
  /** Which of the three shapes can answer here. An API key is not a username and password. */
  kinds: string[];
  /** Which administrator-registered list applies, if any. */
  registered: string[];
}) {
  const own = catalogue.own.filter((entry) => kinds.includes(entry.kind));
  const known = [...own.map((entry) => entry.ref), ...registered];
  const dangling = value !== "" && !known.includes(value);
  return (
    <>
      <Field label={label} hint={hint}>
        <select value={value} onChange={(event) => onChange(event.target.value)}>
          <option value="">— Select a credential —</option>
          {own.length > 0 && (
            <optgroup label="This application's own">
              {own.map((entry) => (
                <option key={entry.ref} value={entry.ref}>
                  {entry.name}
                  {entry.principal ? ` — ${entry.principal}` : ""}
                </option>
              ))}
            </optgroup>
          )}
          {registered.length > 0 && (
            <optgroup label="Registered by an administrator">
              {registered.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </optgroup>
          )}
          {dangling && (
            <option value={value}>{value} — not found in this environment</option>
          )}
        </select>
      </Field>
      {dangling && (
        <Notice kind="warn">
          {catalogue.applicationId ? `Nothing in ${catalogue.applicationId}, and nothing` : "Nothing"} an
          administrator registered, answers to <span className="mono">{value}</span>. Every request
          through this route is refused with 503 until it does —{" "}
          {catalogue.applicationId ? "choose another, or add it on Credentials." : "choose another."}
        </Notice>
      )}
      {/* No application on the global tier: a whole environment's default can name only what an
          administrator registered, so there is no Credentials screen to send anybody to. */}
      {own.length === 0 && catalogue.applicationId && (
        <p className="muted">
          This application has no credential of this kind in this environment.{" "}
          <Link to={`/${catalogue.applicationId}/credentials`}>Add one on Credentials</Link> — it
          takes no administrator, and the secret is never written into a policy.
        </p>
      )}
    </>
  );
}

/**
 * The half an owner may name but not create: a token issuer, or a token endpoint. Both resolve to
 * a URL the gateway itself fetches, so both stay administrator-registered — and the picker says
 * that where the box used to say nothing at all.
 */
function AdminRefPicker({
  label,
  hint,
  nothing,
  value,
  onChange,
  registered,
}: {
  label: string;
  hint: string;
  /** What to say when none is registered — the answer is always "ask an admin". */
  nothing: string;
  value: string;
  onChange: (next: string) => void;
  registered: string[];
}) {
  const dangling = value !== "" && !registered.includes(value);
  return (
    <>
      <Field label={label} hint={hint}>
        <select value={value} onChange={(event) => onChange(event.target.value)}>
          <option value="">— Select —</option>
          {registered.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
          {dangling && <option value={value}>{value} — not registered here</option>}
        </select>
      </Field>
      {dangling && (
        <Notice kind="warn">
          Nothing called <span className="mono">{value}</span> is registered, so every request
          through this route is refused with 503. Choose another, or ask an administrator to
          register it.
        </Notice>
      )}
      {registered.length === 0 && <p className="muted">{nothing}</p>}
    </>
  );
}

function IssuerPicker({
  value,
  onChange,
  registered,
}: {
  value: string;
  onChange: (next: string) => void;
  registered: string[];
}) {
  return (
    <AdminRefPicker
      label="Token issuer"
      hint="The algorithm allowlist and the JWKS come from the issuer's own registration, so an API cannot widen what its issuer will accept."
      nothing="No token issuer is registered yet. Deciding whose tokens the gateways believe is an administrator's decision — ask one to add it, then it appears here."
      value={value}
      onChange={onChange}
      registered={registered}
    />
  );
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

/** Said on Remove, which takes an inherited unit off this one API and is refused for everybody. */
const INHERITED_TITLE =
  "Set for every API in this environment — it cannot be taken off one API, on Global policy " +
  "instead";

/**
 * Said wherever an inherited unit's own controls are closed to the reader. Overriding the
 * environment's tier — a different value here, or switching it off for this API — is an
 * administrator's decision, so for everybody else the card is a reading of the current state.
 */
const INHERITED_ADMIN_ONLY =
  "Set for every API in this environment. Only a platform administrator can override it for this " +
  "API; you can see the current value here.";

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
  catalogue,
  globalUnits = [],
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
  catalogue: CredentialCatalogue;
  /**
   * The units this environment sets for every API. The document the workspace loads is the
   * *effective* one, so without this list an inherited unit is indistinguishable from the API's
   * own — and the editor offered to remove both, which for an inherited one was an edit the
   * control plane quietly undid at the next read. Empty on the global screen itself, where every
   * unit on the page is the environment's by definition.
   */
  globalUnits?: string[];
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
      <Notice kind="error">
        The advanced JSON below is not valid ({(err as Error).message}), so the controls cannot be
        drawn over it. Correct it, or revert this tab, and they come back.
      </Notice>
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
        <Notice kind="warn">
          {unrecognised.length} unit{unrecognised.length === 1 ? "" : "s"} in this document
          {unrecognised.length === 1 ? " is" : " are"} not offered for a {kind.toUpperCase()} API:{" "}
          <span className="mono">{unrecognised.join(", ")}</span>. They are kept exactly as they are
          and can be edited in the advanced JSON below.
        </Notice>
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
                inherited={globalUnits.includes(unit.key)}
                canOverrideGlobal={isAdmin}
                lockedReason={
                  globalUnits.includes(unit.key) && !isAdmin
                    ? INHERITED_ADMIN_ONLY
                    : unit.key === "auth.subscriptionKey" && !isAdmin
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
                catalogue={catalogue}
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
          <I.Plus /> Add policy
        </button>
        <span className="muted">
          {attached.length} attached · {available.length} available for a {kind.toUpperCase()} API
        </span>
      </div>

      {adding && (
        <Modal title="Add a policy" close={() => setAdding(false)}>
          <p className="muted">Choose a policy, then configure it before saving your changes.</p>
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
                      <button
                        key={unit.key}
                        type="button"
                        className="policy-choice"
                        disabled={Boolean(blocked)}
                        onClick={() => {
                          set(unit.key, removed[unit.key] ?? unit.defaultValue);
                          setEditing(unit.key);
                          setAdding(false);
                        }}
                      >
                        <PolicyIcon group={unit.group} />
                        <span className="policy-choice-copy">
                          <strong>{unit.title}</strong>
                          <span>{unit.description}</span>
                          {blocked && <span className="policy-choice-reason">{blocked}</span>}
                        </span>
                        <span className="policy-choice-arrow" aria-hidden="true"><I.Plus /></span>
                      </button>
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
  inherited,
  canOverrideGlobal,
  warning,
  instances,
  certificates,
  certificate,
  onCertificate,
  catalogue,
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
  /** The environment sets this unit for every API, so what this one API may do about it is bounded. */
  inherited: boolean;
  /** Whether the reader is an administrator, and so may override the environment for this API. */
  canOverrideGlobal: boolean;
  warning: string | null;
  instances: number;
  certificates: Array<{ id: string; name: string }>;
  certificate: string;
  onCertificate: (id: string) => void;
  catalogue: CredentialCatalogue;
}) {
  const locked = disabled || Boolean(lockedReason);
  // Two different rules meet on an inherited unit's controls, and they are not the same rule.
  //
  // **Remove** is refused for everybody, administrators included: the unit is not stored on this
  // API, so removing it stores nothing and the environment's value merges straight back in at the
  // next read. Undoing it on Global policy is the only thing that works.
  //
  // **Switching it off**, and editing its fields, are overrides — the API keeps running, on
  // something other than what the environment says — so they are an administrator's decision.
  // A non-admin gets `lockedReason` instead, which closes the fields for the same reason.
  const detachable = !locked && !inherited;
  const switchable = !locked && (!inherited || canOverrideGlobal);
  return (
    <div className="policy-item">
      <div className={`policy-card${enabled ? "" : " off"}`}>
        <PolicyIcon group={unit.group} />
        <div className="policy-card-body">
          <div className="policy-card-title">
            {unit.title} <span className="mono muted">{unit.key}</span>
            {inherited && <span className="chip">whole environment</span>}
          </div>
          <div className="policy-card-summary">
            {summary ?? unit.description.split(".")[0]}
          </div>
        </div>
        <div className="policy-card-actions">
          <button
            type="button"
            className={`icon-btn${enabled ? "" : " inactive"}`}
            disabled={!switchable}
            aria-pressed={enabled}
            title={
              inherited && !canOverrideGlobal
                ? INHERITED_ADMIN_ONLY
                : enabled
                  ? "Switch off — the configuration is kept and the gateway stops applying it"
                  : "Switch back on"
            }
            aria-label={`${enabled ? "Switch off" : "Switch on"} ${unit.title}`}
            onClick={onToggle}
          >
            <I.Power size={16} />
          </button>
          <button
            type="button"
            className="icon-btn"
            title={open ? "Close" : "Edit"}
            aria-label={`${open ? "Close" : "Edit"} ${unit.title}`}
            onClick={onOpen}
          >
            {open ? <I.ChevDown size={16} /> : <I.Edit size={16} />}
          </button>
          <button
            type="button"
            className="icon-btn danger"
            disabled={!detachable}
            title={inherited ? INHERITED_TITLE : "Remove — deletes the configuration as well"}
            aria-label={`Remove ${unit.title}`}
            onClick={onRemove}
          >
            <I.X size={16} />
          </button>
        </div>
      </div>
      {!enabled && (
        <p className="muted small">
          Switched off. Its configuration is kept here and no gateway is told about it.
        </p>
      )}
      {inherited && canOverrideGlobal && (
        <p className="muted small">
          Set for every API in this environment. As an administrator you can give this one its own
          value, or switch it off here; taking it off the API altogether is a decision for the
          whole environment, on <Link to="/policy">Global policy</Link>.
        </p>
      )}
      {lockedReason && (
        <p className="muted small">
          {lockedReason}
          {inherited && !canOverrideGlobal && (
            <>
              {" "}
              The current value is on <Link to="/policy">Global policy</Link>.
            </>
          )}
        </p>
      )}
      {warning && <Notice kind="warn">{warning}</Notice>}
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
              catalogue={catalogue}
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

/**
 * What one unit's form takes. Exported, and meant to stay this shape, because the global-policy
 * screen is to edit its units with these same controls rather than with a JSON box: one form per
 * unit, whichever document the unit belongs to. A caller with no application passes
 * `EMPTY_CATALOGUE`, an empty certificate list and a no-op `onCertificate`.
 */
export interface UnitFormProps {
  /** The unit's key in the closed vocabulary, `rateLimit`, `auth.jwt`, `timeoutMs`… */
  unitKey: string;
  /** The unit's current value, exactly as it sits in the policy document. */
  value: any;
  /** The unit's next value, exactly as it should sit in the policy document. */
  onChange: (next: unknown) => void;
  /** Gateways running in the environment, for the "in total" arithmetic in the notes. */
  instances: number;
  /** The client certificates the owner may attach to the backend call, when backend authentication is mutual TLS. */
  certificates: Array<{ id: string; name: string }>;
  certificate: string;
  onCertificate: (id: string) => void;
  /** What the credential and issuer pickers are drawn from. */
  catalogue: CredentialCatalogue;
}

export function UnitForm({
  unitKey,
  value,
  onChange,
  instances,
  certificates,
  certificate,
  onCertificate,
  catalogue,
}: UnitFormProps) {
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
        <CredentialPicker
          label="The username and password callers must present"
          hint="Only a username-and-password credential can answer here: what is compared is the whole pair, exactly as the caller sends it."
          value={value?.credentialRef ?? ""}
          onChange={(next) => onChange({ ...value, credentialRef: next })}
          catalogue={catalogue}
          kinds={["basic"]}
          registered={catalogue.registered.secrets}
        />
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
        <IssuerPicker
          value={value?.issuerRef ?? ""}
          onChange={(next) => onChange({ ...value, issuerRef: next })}
          registered={catalogue.registered.issuers}
        />
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
        <IssuerPicker
          value={value?.issuerRef ?? ""}
          onChange={(next) => onChange({ ...value, issuerRef: next })}
          registered={catalogue.registered.issuers}
        />
        <DurationField
          label="Cache the answer for"
          value={value?.cacheTtlSec ?? 60}
          onChange={(next) => onChange({ ...value, cacheTtlSec: next })}
        />
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
        <DurationField
          label="Browsers may cache the preflight for"
          value={value?.maxAgeSec ?? 600}
          onChange={(next) => onChange({ ...value, maxAgeSec: next })}
        />
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
          <Notice kind="error">
            Every browser refuses credentials with a wildcard origin, so this route would look
            configured and never work. List the origins instead.
          </Notice>
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
          <Notice kind="warn">
            A blocking response check turns the backend's own bug into a 502 the consumer sees. It
            is the right setting while a backend is being certified and the wrong one afterwards.
          </Notice>
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
    return <HeaderRulesForm direction={unitKey === "headers.request" ? "request" : "response"} value={value} onChange={onChange} />;
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
        <DurationField
          label="Keep a response for"
          min={1}
          value={value?.ttlSec ?? 60}
          onChange={(next) => onChange({ ...value, ttlSec: next })}
        />
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
          Each gateway keeps its own copy in memory, emptied whenever this API's configuration
          changes. GET and HEAD only.
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
        <DurationField
          label="Per"
          min={1}
          value={periodSec}
          onChange={(next) => onChange({ ...value, periodSec: next })}
        />
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
              Each gateway counts on its own: with {Math.max(instances, 1)} running, up to{" "}
              {calls * Math.max(instances, 1)} calls per {humanDuration(periodSec)} in total. Counted
              per subscription, so the subscription-key policy has to be attached too.
            </>
          ) : (
            <>
              Counted across all gateways together. The total can briefly run over while the
              gateways' counts are combined — by seconds of traffic, not by a multiple of the quota.
            </>
          )}
        </p>
      </>
    );
  }

  if (unitKey === "timeoutMs") {
    return (
      <>
        {/* Both bounds come from the vocabulary rather than being retyped here. The fallback was a
            literal `30000` that stayed behind when the default moved, and there was no `max` at
            all, so the ceiling was something you discovered from a 400 after saving. */}
        <DurationField
          label="Backend timeout"
          units={MILLISECOND_UNITS}
          min={1}
          max={MAX_TIMEOUT_MS}
          value={typeof value === "number" ? value : DEFAULT_TIMEOUT_MS}
          onChange={onChange}
        />
        <p className="muted">
          The whole upstream exchange, retries included. Defaults to{" "}
          {DEFAULT_TIMEOUT_MS / 1000}s and cannot exceed{" "}
          {MAX_TIMEOUT_MS / 1000}s. Raising it holds a slot and two sockets for longer when a
          backend stops answering, so attach a concurrency ceiling alongside it.
        </p>
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
          <Notice kind="warn">
            Retrying a POST means the backend may process it twice.
          </Notice>
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
        <DurationField
          label="Within"
          min={1}
          value={windowSec}
          onChange={(next) => onChange({ ...value, windowSec: next })}
        />
        <DurationField
          label="Stay open for"
          min={1}
          value={openSec}
          onChange={(next) => onChange({ ...value, openSec: next })}
        />
        <Field label="Half-open probes">
          <input
            type="number"
            min={1}
            value={probes}
            onChange={(e) => onChange({ ...value, halfOpenProbes: num(e.target.value) })}
          />
        </Field>
        <p className="muted">
          {failures} failures within {humanDuration(windowSec)} take that backend out of the pool for{" "}
          {humanDuration(openSec)}, then {probes} request{probes === 1 ? "" : "s"} is let through to
          see whether it recovered. Each gateway counts on its own, per backend, so one gateway's
          connectivity fault cannot take the backend away from every gateway.
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
        <DurationField
          label="Ask callers to retry after"
          value={value?.retryAfterSec ?? 1}
          onChange={(next) => onChange({ ...value, retryAfterSec: next })}
        />
        <p className="muted">
          With {Math.max(instances, 1)} gateway{instances === 1 ? "" : "s"} running, up to{" "}
          {maxInFlight * Math.max(instances, 1)} requests in flight in total. Past the ceiling
          requests are refused with 503 rather than queued.
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
              <Notice kind="warn">
                Mutual TLS is selected and no certificate is bound in this environment, so the
                gateway will refuse to activate this route. Pick one, or add one on{" "}
                <Link to={`/${catalogue.applicationId}/credentials`}>Credentials</Link>.
              </Notice>
            )}
            <p className="muted">
              The certificate is bound per environment: promoting this API carries the policy, not
              the certificate, so each environment presents its own identity.
            </p>
          </>
        )}
        {type === "basic" && (
          <CredentialPicker
            label="The username and password to present"
            value={value?.credentialRef ?? ""}
            onChange={(next) => onChange({ ...value, credentialRef: next })}
            catalogue={catalogue}
            kinds={["basic"]}
            registered={catalogue.registered.secrets}
          />
        )}
        {type === "api-key" && (
          <>
            <CredentialPicker
              label="The key to present"
              value={value?.credentialRef ?? ""}
              onChange={(next) => onChange({ ...value, credentialRef: next })}
              catalogue={catalogue}
              kinds={["secret"]}
              registered={catalogue.registered.secrets}
            />
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
            <AdminRefPicker
              label="Token endpoint"
              hint="Where the gateway asks for a backend token, and the client secret it presents there."
              nothing="No token endpoint is registered yet. Where a client secret is sent is an administrator's decision, so this one is not yours to add — ask one, and it appears here."
              value={value?.tokenProviderRef ?? ""}
              onChange={(next) => onChange({ ...value, tokenProviderRef: next })}
              registered={catalogue.registered.tokenProviders}
            />
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
            <CredentialPicker
              label="The application id and key to sign with"
              value={value?.schemeRef ?? ""}
              onChange={(next) => onChange({ ...value, schemeRef: next })}
              catalogue={catalogue}
              kinds={["hmac"]}
              registered={catalogue.registered.hmacSchemes}
            />
            <Field label="Service shortcut">
              <input
                value={value?.serviceShortcut ?? ""}
                onChange={(e) => onChange({ ...value, serviceShortcut: e.target.value })}
              />
            </Field>
          </>
        )}
        <p className="muted">
          Whichever is chosen, the secret itself never enters this document: the policy carries a
          name, and the value is attached when the environment's configuration is built. Anything
          with a URL behind it stays administrator-registered; a password does not.
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
        <DurationField
          label="Close an idle stream after"
          min={1}
          value={value?.streamIdleTimeoutSec ?? 300}
          onChange={(next) => onChange({ ...value, streamIdleTimeoutSec: next })}
        />
        <DurationField
          label="Longest connection"
          min={1}
          value={value?.maxConnectionSec ?? 3600}
          onChange={(next) => onChange({ ...value, maxConnectionSec: next })}
        />
        <Field label="Concurrent connections per gateway">
          <input
            type="number"
            min={1}
            value={value?.maxConcurrentConnections ?? 50}
            onChange={(e) => onChange({ ...value, maxConcurrentConnections: num(e.target.value) })}
          />
        </Field>
        {!websocket && !sse && (
          <Notice kind="error">
            Turn on at least one. An attached unit that enables neither changes nothing and reads as
            if it did.
          </Notice>
        )}
        {websocket && (
          <Notice kind="warn">
            A WebSocket route cannot also validate requests, transform, or cache: after the upgrade
            there are frames rather than requests. Those units are refused on save rather than
            ignored at runtime.
          </Notice>
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

// ------------------------------------------------------------------ header rules
//
// The unit is four maps — `remove`, `set`, `append`, `skip` — and the form used to edit exactly one
// entry of one of them, under the labels "Set header" and "Value", with a sentence beneath reading
// "remove → set → append → skip, in that order" and "use the advanced JSON for the other three
// actions". That sentence is the whole of what the screen said about three of the four things this
// unit does, and it says it in the vocabulary of the stored document rather than of the decision:
// nobody arrives wanting to `skip` a header. They arrive wanting to *not overwrite one that is
// already there*.
//
// So the form is a list of rules, each naming its action in words, and the four actions are the
// four things that can be done to a header. The pipeline order is still the pipeline order — it is
// a property of the gateway, not of the order somebody typed the rows in — so the list is shown
// sorted by it and says so once, rather than per row.

const HEADER_ACTIONS = [
  { action: "remove", label: "Remove", takesValue: false, said: "is deleted if present" },
  { action: "set", label: "Overwrite", takesValue: true, said: "replaces whatever was there" },
  { action: "append", label: "Append", takesValue: true, said: "is added alongside any existing value" },
  { action: "skip", label: "Set if missing", takesValue: true, said: "is set only when it is absent" },
] as const;

type HeaderAction = (typeof HEADER_ACTIONS)[number]["action"];

interface HeaderRule {
  /** Stable across edits, so renaming a header does not remount its row and steal the caret. */
  id: number;
  action: HeaderAction;
  name: string;
  value: string;
}

/** The stored unit, read as a list in the order the gateway applies it. */
export function headerRulesOf(unit: unknown): Array<Omit<HeaderRule, "id">> {
  const value = (unit ?? {}) as Record<string, unknown>;
  const out: Array<Omit<HeaderRule, "id">> = [];
  for (const name of Array.isArray(value.remove) ? (value.remove as string[]) : []) {
    if (typeof name === "string") out.push({ action: "remove", name, value: "" });
  }
  for (const action of ["set", "append", "skip"] as const) {
    const entries = value[action];
    if (typeof entries !== "object" || entries === null) continue;
    for (const [name, entry] of Object.entries(entries as Record<string, unknown>)) {
      out.push({ action, name, value: typeof entry === "string" ? entry : "" });
    }
  }
  return out;
}

/**
 * The list, back as the stored unit. A rule with no header name is dropped — it is a row somebody
 * is still filling in, not an instruction — and an empty action map is omitted rather than written
 * as `{}`, so an untouched unit is byte-identical to the one that was loaded and the workspace's
 * Save does not cut a revision that says nothing.
 */
export function headerUnitOf(rules: Array<Omit<HeaderRule, "id">>): Record<string, unknown> {
  const unit: Record<string, unknown> = {};
  const remove = rules.filter((rule) => rule.action === "remove" && rule.name).map((rule) => rule.name);
  if (remove.length > 0) unit.remove = remove;
  for (const action of ["set", "append", "skip"] as const) {
    const entries = Object.fromEntries(
      rules.filter((rule) => rule.action === action && rule.name).map((rule) => [rule.name, rule.value]),
    );
    if (Object.keys(entries).length > 0) unit[action] = entries;
  }
  return unit;
}

function HeaderRulesForm({
  direction,
  value,
  onChange,
}: {
  direction: "request" | "response";
  value: unknown;
  onChange: (next: unknown) => void;
}) {
  // Seeded once and held locally, like the JSON fallback: two rows can legitimately be half-typed
  // and share an empty name, and a list derived from the map on every keystroke would collapse
  // them into one and take the caret with it.
  const [rules, setRules] = useState<HeaderRule[]>(() =>
    headerRulesOf(value).map((rule, index) => ({ ...rule, id: index })),
  );
  const [nextId, setNextId] = useState(() => headerRulesOf(value).length);

  const write = (next: HeaderRule[]) => {
    setRules(next);
    onChange(headerUnitOf(next));
  };
  const edit = (id: number, patch: Partial<HeaderRule>) =>
    write(rules.map((rule) => (rule.id === id ? { ...rule, ...patch } : rule)));

  const noun = direction === "request" ? "the request sent to the backend" : "the response returned to the caller";
  return (
    // A rule is four controls reading left to right, so it needs the whole row: the enclosing
    // `.native-form-grid` is two columns, and without this each rule sat in a half-width cell
    // beside another rule, which read as a two-column table nobody had given headings.
    <div className="header-rules">
      {rules.length === 0 && (
        <p className="muted">
          No header rules, so {noun} carries the headers it already had.
        </p>
      )}
      {rules.map((rule) => {
        const shape = HEADER_ACTIONS.find((entry) => entry.action === rule.action)!;
        return (
          <div className="header-rule" key={rule.id}>
            <select
              aria-label="What to do with this header"
              value={rule.action}
              onChange={(event) => edit(rule.id, { action: event.target.value as HeaderAction })}
            >
              {HEADER_ACTIONS.map((entry) => (
                <option key={entry.action} value={entry.action}>
                  {entry.label}
                </option>
              ))}
            </select>
            <input
              aria-label="Header name"
              placeholder="X-Subscription-Name"
              value={rule.name}
              onChange={(event) => edit(rule.id, { name: event.target.value })}
            />
            {shape.takesValue ? (
              <input
                aria-label="Header value"
                placeholder="${subscription.name}"
                value={rule.value}
                onChange={(event) => edit(rule.id, { value: event.target.value })}
              />
            ) : (
              // Not a disabled input: a greyed box beside "Remove" reads as a value somebody
              // failed to fill in, and there is no value to fill in.
              <span className="muted small">no value — the header is taken off</span>
            )}
            <button
              type="button"
              className="btn sm"
              aria-label={`Remove the rule for ${rule.name || "an unnamed header"}`}
              onClick={() => write(rules.filter((entry) => entry.id !== rule.id))}
            >
              Remove
            </button>
          </div>
        );
      })}
      <button
        type="button"
        className="btn sm"
        onClick={() => {
          write([...rules, { id: nextId, action: "set", name: "", value: "" }]);
          setNextId(nextId + 1);
        }}
      >
        <I.Plus /> Add a header rule
      </button>
      <p className="muted">
        Applied in this order, whatever order the rules are listed in:{" "}
        {HEADER_ACTIONS.map((entry, index) => (
          <Fragment key={entry.action}>
            {index > 0 && ", then "}
            <strong>{entry.label.toLowerCase()}</strong> — the header {entry.said}
          </Fragment>
        ))}
        . Values may use <span className="mono">{"${subscription.name}"}</span>,{" "}
        <span className="mono">{"${application.name}"}</span> and the rest of the closed variable
        set; anything else is refused on save.
      </p>
    </div>
  );
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
      {error && <Notice kind="error">Not valid JSON: {error}</Notice>}
    </>
  );
}
