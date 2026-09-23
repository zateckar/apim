import { integerError } from "../lib/form-validation";
import { useMemo, useState } from "react";
import {
  api,
  type GatewaySettingsModel,
  type SettingDef,
  type SettingScope,
  type SettingValue,
} from "../api";
import { DangerZone, envLabel, Field, Link, Notice, Panel, Skeleton, useAction, useAsync } from "../components";
import { ALLOWED } from "../lib/capabilities";
import { formatDateTime } from "../lib/datetime";

/**
 * Gateway settings (admin).
 *
 * Everything here was an environment variable on each gateway container until v6, which meant the
 * fleet's configuration was the union of N compose files: two gateways in one environment could
 * disagree about their own concurrency ceiling, and nothing said so until the smaller one started
 * shedding load. The values are the control plane's now, they travel in the configuration document
 * every replica already polls for, and this is where they are set.
 *
 * Three layers, most specific winning — a gateway over its environment over the fleet, with the
 * build's defaults under all three. The layer picker is the whole navigation: one layer is on screen
 * at a time, because a grid of every setting against every gateway is a spreadsheet nobody can read
 * and almost every cell in it would say "inherited".
 *
 * What this screen deliberately does *not* do is report whether a change arrived. A settings change
 * produces a new configuration digest, so Health Status already answers that per replica — including
 * a replica that refused the document because its container cannot honour a ceiling — and a second,
 * weaker copy of that answer here is the two-places-to-look problem this change exists to end.
 */

interface Layer {
  scope: SettingScope;
  scopeId: string;
  /** How the layer is named in the picker and in headings. */
  label: string;
  /** The short token typed back into a destructive confirmation. */
  name: string;
  /** One line saying which gateways this layer reaches. */
  reach: string;
}

/** A sensitive switch is not a cell in the table — see `SensitiveSwitch` below. */
function isSensitiveFlag(def: SettingDef): boolean {
  return Boolean(def.sensitive) && def.kind === "flag";
}

/**
 * The units a size or a duration is shown and typed in, smallest first.
 *
 * The control plane stores bytes and seconds, and the screen used to ask for them too: an 8 MB body
 * cap was a box holding `8388608` with "bytes" under it, and the only way to set 16 MB was to do the
 * multiplication somewhere else. The unit sits beside the input now and the conversion is here.
 * KB, MB and GB are the binary multiples, because the build declares its defaults that way
 * (`shared/gateway-settings.ts` writes `8 * MIB`) and a decimal megabyte would turn every default
 * into a fraction.
 */
export const UNITS: Record<"bytes" | "seconds", ReadonlyArray<readonly [string, number]>> = {
  bytes: [
    ["KB", 1024],
    ["MB", 1024 ** 2],
    ["GB", 1024 ** 3],
  ],
  seconds: [
    ["s", 1],
    ["min", 60],
    ["h", 3600],
  ],
};

function unitsOf(def: SettingDef): ReadonlyArray<readonly [string, number]> | null {
  return def.kind === "bytes" || def.kind === "seconds" ? UNITS[def.kind] : null;
}

/** The largest unit the value is a whole number of, so 8 MB opens as `8` beside MB, not `8192` KB. */
export function unitFor(def: SettingDef, value: number): string {
  const units = unitsOf(def);
  if (!units) return "";
  for (const [unit, size] of [...units].reverse()) {
    if (value >= size && value % size === 0) return unit;
  }
  return units[0]![0];
}

function sizeOf(def: SettingDef, unit: string): number {
  return unitsOf(def)?.find(([name]) => name === unit)?.[1] ?? 1;
}

/** A value as somebody would say it: `8 MB`, `1 min`, `On`. */
export function formatValue(def: SettingDef, value: SettingValue): string {
  if (def.kind === "flag") return value ? "On" : "Off";
  const amount = Number(value);
  if (!unitsOf(def)) return amount.toLocaleString("en-GB");
  const unit = unitFor(def, amount);
  const size = sizeOf(def, unit);
  // Below the smallest unit is only reachable for bytes — a body cap of 1500 — and saying "1.46 KB"
  // there would hide the number somebody actually typed.
  if (def.kind === "bytes" && amount > 0 && amount < size) return `${amount} bytes`;
  const scaled = amount / size;
  return `${Number.isInteger(scaled) ? scaled : scaled.toFixed(2)} ${unit}`;
}

/**
 * What is typed, in the chosen unit, as the stored whole number — or the reason it cannot be.
 *
 * Refused rather than rounded, as the control plane refuses rather than clamps (gateway-settings,
 * "An administrator types a value outside the bounds"): `0.3 KB` is not a whole number of bytes, and
 * quietly storing 307 would be a value nobody chose.
 */
export function parseAmount(
  def: SettingDef,
  raw: string,
  unit: string,
): { value: number; error: null } | { value: null; error: string } {
  const amount = Number(raw);
  if (!unitsOf(def)) {
    const error = integerError(amount, def.min ?? 0, def.max);
    return error ? { value: null, error } : { value: amount, error: null };
  }
  if (raw.trim() === "" || !Number.isFinite(amount)) return { value: null, error: "Enter a number." };
  const exact = amount * sizeOf(def, unit);
  const value = Math.round(exact);
  if (Math.abs(exact - value) > 1e-6) {
    return { value: null, error: `That is not a whole number of ${def.kind === "bytes" ? "bytes" : "seconds"}; use a smaller unit.` };
  }
  const min = def.min ?? 0;
  if (value < min || (def.max !== undefined && value > def.max)) {
    return { value: null, error: `Enter ${rangeOf(def)}.` };
  }
  return { value, error: null };
}

function rangeOf(def: SettingDef): string {
  const min = formatValue(def, def.min ?? 0);
  return def.max === undefined ? `at least ${min}` : `${min} to ${formatValue(def, def.max)}`;
}

/** Where an inherited value comes from, as the sentence under the field names it. */
function fromLayer(scope: SettingScope | null, environment?: string): string {
  if (scope === null) return "the built-in default";
  if (scope === "fleet") return "the fleet";
  if (scope === "environment") return environment ? envLabel(environment) : "the environment";
  return "this gateway";
}

export function GatewaySettingsView() {
  const model = useAsync(() => api.get<GatewaySettingsModel>("/api/gateway-settings"), []);
  const [selected, setSelected] = useState("fleet:");

  const layers = useMemo<Layer[]>(() => {
    if (!model.data) return [];
    const { environments, gateways } = model.data;
    return [
      {
        scope: "fleet",
        scopeId: "",
        label: "Every gateway",
        name: "fleet",
        reach: `All ${gateways.length} gateway${gateways.length === 1 ? "" : "s"}, in every environment, except where a layer below overrides one of these.`,
      },
      ...environments.map<Layer>((environment) => {
        const count = gateways.filter((gateway) => gateway.environment === environment).length;
        return {
          scope: "environment",
          scopeId: environment,
          label: envLabel(environment),
          name: environment,
          reach: `The ${count} gateway${count === 1 ? "" : "s"} in ${envLabel(environment)}, except where one of them overrides a setting itself.`,
        };
      }),
      ...model.data.gateways.map<Layer>((gateway) => ({
        scope: "gateway",
        scopeId: gateway.id,
        label: `${envLabel(gateway.environment)} · ${gateway.name}`,
        name: gateway.name,
        reach: `Only ${gateway.name} in ${envLabel(gateway.environment)}${gateway.label ? ` (${gateway.label})` : ""}, whose own values win over both layers above.`,
      })),
    ];
  }, [model.data]);

  if (model.loading && !model.data) return <Skeleton rows={6} />;

  const layer = layers.find((entry) => `${entry.scope}:${entry.scopeId}` === selected) ?? layers[0];

  return (
    <>
      <header className="page">
        <div>
          <p className="muted">
            Choose where these settings apply. Changes take effect without a restart;{" "}
            <Link to="/fleet">Health Status</Link> shows when each replica has applied them.
          </p>
        </div>
      </header>

      <Notice kind="error">{model.error}</Notice>

      {model.data && layer && (
        <>
          <div className="settings-scope">
          <Field label="Applies to" hint={layer.reach}>
            <select value={selected} onChange={(event) => setSelected(event.target.value)}>
              {layers.map((entry) => (
                <option
                  key={`${entry.scope}:${entry.scopeId}`}
                  value={`${entry.scope}:${entry.scopeId}`}
                >
                  {entry.label}
                </option>
              ))}
            </select>
          </Field>
          </div>
          {/* Keyed on the layer so switching layers discards half-typed edits rather than carrying
              them onto a different set of gateways, which would be the worst kind of surprise. */}
          <LayerEditor
            key={selected}
            model={model.data}
            layer={layer}
            onChanged={model.reload}
          />
        </>
      )}
    </>
  );
}

function LayerEditor({
  model,
  layer,
  onChanged,
}: {
  model: GatewaySettingsModel;
  layer: Layer;
  onChanged: () => void;
}) {
  const action = useAction();
  /** Pending edits, held as typed text in the unit beside them, so a half-written number is not read as a value. */
  const [edits, setEdits] = useState<Record<string, string>>({});
  /** The unit each size or duration is being typed in. Choosing one is not an edit. */
  const [units, setUnits] = useState<Record<string, string>>({});
  /**
   * Which control the last save came from. The table and the access-log switch share one request
   * handle, and its failure was drawn at the top of the panel *and* inside the switch's
   * confirmation — the same error twice, one of them a screen away from the button pressed.
   */
  const [origin, setOrigin] = useState<"table" | "switch">("table");

  const effective =
    layer.scope === "fleet"
      ? model.effective.fleet
      : layer.scope === "environment"
        ? (model.effective.environments[layer.scopeId] ?? {})
        : (model.effective.gateways[layer.scopeId] ?? {});

  /** Set at *this* layer, as opposed to inherited from one above it or from the default. */
  const own = new Map(
    model.overrides
      .filter((row) => row.scope === layer.scope && row.scopeId === layer.scopeId)
      .map((row) => [row.key, row] as const),
  );
  const gateway = layer.scope === "gateway" ? model.gateways.find((entry) => entry.id === layer.scopeId) : undefined;

  /**
   * What clearing this layer's override would restore, and which layer it would come from — the
   * parent's effective value, never this layer's own (gateway-settings, "Inheritance is offered").
   */
  const parentOf = (key: string): { value: SettingValue; from: string } => {
    const def = model.defs[key]!;
    const source =
      layer.scope === "fleet"
        ? null
        : layer.scope === "environment"
          ? model.effective.fleet[key]
          : model.effective.environments[gateway?.environment ?? ""]?.[key];
    return { value: source?.value ?? def.default, from: fromLayer(source?.scope ?? null, gateway?.environment) };
  };
  const unitOf = (key: string): string => {
    const def = model.defs[key]!;
    return units[key] ?? unitFor(def, Number(own.get(key)?.value ?? parentOf(key).value));
  };

  const keys = Object.keys(model.defs);
  const pending = Object.keys(edits).length;

  const submit = async (values: Record<string, SettingValue | null>, okMessage: string, from: "table" | "switch") => {
    setOrigin(from);
    const ok = await action.run(
      () => api.patch("/api/gateway-settings", { scope: layer.scope, scopeId: layer.scopeId, values }),
      okMessage,
    );
    if (ok) {
      setEdits(current => Object.fromEntries(Object.entries(current).filter(([key]) => !(key in values))));
      onChanged();
    }
  };

  const errors = Object.fromEntries(Object.entries(edits).flatMap(([key, raw]) => {
    const def = model.defs[key]!;
    const error = raw.trim() && def.kind !== "flag" ? parseAmount(def, raw, unitOf(key)).error : null;
    return error ? [[key, error]] : [];
  }));
  const save = () => {
    if (Object.keys(errors).length) return;
    const values: Record<string, SettingValue | null> = {};
    for (const [key, raw] of Object.entries(edits)) {
      const def = model.defs[key]!;
      if (raw.trim() === "") values[key] = null;
      else if (def.kind === "flag") values[key] = raw === "true";
      else values[key] = parseAmount(def, raw, unitOf(key)).value;
    }
    return submit(values, `${pending} setting${pending === 1 ? "" : "s"} saved`, "table");
  };

  return (
    <Panel
      title={`Settings for ${layer.label}`}
      className="gateway-settings"
      hint="Changes are saved together. Leave a value empty to inherit it from the layer above."
    >
      <Notice kind="error">{origin === "table" ? action.error : null}</Notice>
      <Notice kind="ok">{action.message}</Notice>

      <table>
        <thead>
          <tr>
            <th>Setting</th>
            <th>In force</th>
            <th>Override here</th>
          </tr>
        </thead>
        <tbody>
          {keys
            .filter((key) => !isSensitiveFlag(model.defs[key]!))
            .map((key) => {
              const def = model.defs[key]!;
              const source = effective[key];
              const row = own.get(key);
              const parent = parentOf(key);
              const unit = unitOf(key);
              const scale = sizeOf(def, unit);
              const current =
                edits[key] ?? (row ? (def.kind === "flag" ? String(row.value) : String(Number(row.value) / scale)) : "");
              const help = `setting-${key}-help`;
              return (
                <tr key={key}>
                  {/* The container variable it replaced is the tooltip rather than a line of the
                      row: somebody upgrading from a compose file is looking for it, and nobody else
                      should have to read past it. */}
                  <th scope="row" title={`Was ${def.env} on each gateway container`}>
                    {def.label}
                    <div className="muted small">{def.purpose}</div>
                  </th>
                  <td>
                    {source ? formatValue(def, source.value) : "—"}
                    <div className="muted small">
                      {row
                        ? `Set here by ${row.setBy}, ${formatDateTime(row.setAt)}`
                        : `Inherited from ${parent.from}`}
                    </div>
                  </td>
                  <td>
                    {def.kind === "flag" ? (
                      <select
                        aria-label={def.label}
                        value={current}
                        onChange={(event) => setEdits({ ...edits, [key]: event.target.value })}
                      >
                        <option value="">
                          Inherit from {parent.from} ({formatValue(def, parent.value)})
                        </option>
                        <option value="true">On</option>
                        <option value="false">Off</option>
                      </select>
                    ) : (
                      <>
                        <div className="row">
                          <input
                            aria-label={def.label}
                            type="number"
                            step={unitsOf(def) ? "any" : 1}
                            aria-invalid={Boolean(errors[key])}
                            aria-describedby={help}
                            min={unitsOf(def) ? 0 : def.min}
                            max={unitsOf(def) ? undefined : def.max}
                            placeholder="Inherited"
                            value={current}
                            onChange={(event) => setEdits({ ...edits, [key]: event.target.value })}
                          />
                          {unitsOf(def) && (
                            <select
                              aria-label={`${def.label} unit`}
                              value={unit}
                              onChange={(event) => setUnits({ ...units, [key]: event.target.value })}
                            >
                              {unitsOf(def)!.map(([name]) => (
                                <option key={name} value={name}>
                                  {name}
                                </option>
                              ))}
                            </select>
                          )}
                        </div>
                        <p id={help} className={errors[key] ? "field-error" : "muted small"}>
                          {errors[key] ??
                            `Allowed ${rangeOf(def)}. Empty inherits ${formatValue(def, parent.value)} from ${parent.from}.`}
                        </p>
                      </>
                    )}
                  </td>
                </tr>
              );
            })}
        </tbody>
      </table>

      <div className="row settings-save">
        <button className="btn primary" disabled={action.busy || pending === 0 || Object.keys(errors).length > 0} onClick={save}>
          Save {pending === 0 ? "" : pending} change{pending === 1 ? "" : "s"}
        </button>
        <button className="btn ghost" disabled={pending === 0} onClick={() => setEdits({})}>
          Discard
        </button>
      </div>
      <p className="hint">
        A saved value reaches each replica this layer covers on its next poll, without a restart. A
        replica that cannot apply one keeps what it already had and says why on Health Status.
      </p>

      {keys
        .filter((key) => isSensitiveFlag(model.defs[key]!))
        .map((key) => (
          <SensitiveSwitch
            key={key}
            def={model.defs[key]!}
            on={Boolean(effective[key]?.value ?? model.defs[key]!.default)}
            layer={layer}
            busy={action.busy}
            error={origin === "switch" ? action.error : null}
            onSet={(value) =>
              submit({ [key]: value }, `${model.defs[key]!.label} ${value ? "on" : "off"}`, "switch")
            }
          />
        ))}
    </Panel>
  );
}

/**
 * The access log is the one setting here that is a promise to somebody outside engineering: its
 * lines are the record that a request was served, and there is deliberately no setting that thins
 * them. So turning it off is not a cell in the table above — it asks for the layer's name back,
 * states what stops being recorded and for how many gateways, and is written to the audit trail
 * named as sensitive. Turning it back on is a plain button, because that is the safe direction.
 */
function SensitiveSwitch({
  def,
  on,
  layer,
  busy,
  error,
  onSet,
}: {
  def: SettingDef;
  on: boolean;
  layer: Layer;
  busy?: boolean;
  error: string | null;
  onSet: (value: boolean) => void;
}) {
  if (!on) {
    return (
      <>
        <Notice kind="warn">
          <strong>{def.label}</strong> is off for {layer.label}. {layer.reach}
        </Notice>
        <Notice kind="error">{error}</Notice>
        <div className="row">
          <button className="btn" disabled={busy} onClick={() => onSet(true)}>
            Turn {def.label.toLowerCase()} back on
          </button>
        </div>
      </>
    );
  }
  return (
    <DangerZone
      what={`Turn ${def.label.toLowerCase()} off for ${layer.label}`}
      name={layer.name}
      consequence={`${def.purpose} ${layer.reach} From each one's next poll until somebody turns it back on, requests are answered without being recorded. The change is audited.`}
      permission={ALLOWED}
      busy={busy}
      error={error}
      onConfirm={() => onSet(false)}
    />
  );
}
