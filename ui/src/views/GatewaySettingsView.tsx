import { useMemo, useState } from "react";
import {
  api,
  type GatewaySettingsModel,
  type SettingDef,
  type SettingScope,
  type SettingValue,
} from "../api";
import { DangerZone, Field, Notice, Panel, Skeleton, useAction, useAsync } from "../components";
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

/** Bytes in the unit somebody would have typed, so an 8 MiB cap does not read as seven digits. */
function formatValue(def: SettingDef, value: SettingValue): string {
  if (def.kind === "flag") return value ? "On" : "Off";
  if (def.kind === "seconds") return `${value} s`;
  if (def.kind !== "bytes") return String(value);
  const bytes = Number(value);
  for (const [unit, size] of [
    ["GiB", 1024 ** 3],
    ["MiB", 1024 ** 2],
    ["KiB", 1024],
  ] as const) {
    if (bytes >= size && bytes % size === 0) return `${bytes / size} ${unit}`;
  }
  return `${bytes} B`;
}

function fromLayer(scope: SettingScope | null): string {
  if (scope === null) return "the built-in default";
  return scope === "fleet"
    ? "the fleet"
    : scope === "environment"
      ? "the environment"
      : "this gateway";
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
          label: environment.toUpperCase(),
          name: environment,
          reach: `The ${count} gateway${count === 1 ? "" : "s"} in ${environment.toUpperCase()}, except where one of them overrides a setting itself.`,
        };
      }),
      ...model.data.gateways.map<Layer>((gateway) => ({
        scope: "gateway",
        scopeId: gateway.id,
        label: `${gateway.environment.toUpperCase()} · ${gateway.name}`,
        name: gateway.name,
        reach: `Only ${gateway.name} in ${gateway.environment.toUpperCase()}${gateway.label ? ` (${gateway.label})` : ""}, whose own values win over both layers above.`,
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
            The ceilings, caches and counters every gateway enforces. They reach the fleet in the
            configuration document each replica already polls for, so setting one needs no restart
            and no edit on any container — and every gateway a layer reaches has the same value for
            it, which a compose file per host could never promise. Whether a replica has taken a
            change is on Health Status, by digest.
          </p>
        </div>
      </header>

      <Notice kind="error">{model.error}</Notice>

      {model.data && layer && (
        <>
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
  /** Pending edits, held as typed text so a half-written number is not read as a value. */
  const [edits, setEdits] = useState<Record<string, string>>({});

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

  const keys = Object.keys(model.defs);
  const pending = Object.keys(edits).length;

  const submit = async (values: Record<string, SettingValue | null>, okMessage: string) => {
    const ok = await action.run(
      () => api.patch("/api/gateway-settings", { scope: layer.scope, scopeId: layer.scopeId, values }),
      okMessage,
    );
    if (ok) {
      setEdits({});
      onChanged();
    }
  };

  const save = () => {
    const values: Record<string, SettingValue | null> = {};
    for (const [key, raw] of Object.entries(edits)) {
      if (raw.trim() === "") values[key] = null;
      else if (model.defs[key]!.kind === "flag") values[key] = raw === "true";
      else values[key] = Number(raw);
    }
    return submit(values, `${pending} setting${pending === 1 ? "" : "s"} saved`);
  };

  return (
    <Panel
      title={`Settings for ${layer.label}`}
      hint="A change is saved as one set or refused as one: these numbers are chosen against each other — a buffer budget makes sense for a concurrency ceiling — and half of a considered pair applied is a fleet nobody configured."
    >
      <Notice kind="error">{action.error}</Notice>
      <Notice kind="ok">{action.message}</Notice>

      <table>
        <thead>
          <tr>
            <th>Setting</th>
            <th>In force</th>
            <th>Set here</th>
          </tr>
        </thead>
        <tbody>
          {keys
            .filter((key) => !isSensitiveFlag(model.defs[key]!))
            .map((key) => {
              const def = model.defs[key]!;
              const source = effective[key];
              const row = own.get(key);
              const inherited = source?.value ?? def.default;
              const current = edits[key] ?? (row ? String(row.value) : "");
              return (
                <tr key={key}>
                  <th scope="row">
                    {def.label}
                    <div className="muted small">{def.purpose}</div>
                    {/* The variable it replaced: somebody reading this screen after an upgrade is
                        looking for the name they used to set in a compose file. */}
                    <div className="muted small">
                      was <code>{def.env}</code>
                    </div>
                  </th>
                  <td>
                    {source ? formatValue(def, source.value) : "—"}
                    <div className="muted small">
                      from {fromLayer(source?.scope ?? null)}
                      {row && ` · ${row.setBy}, ${formatDateTime(row.setAt)}`}
                    </div>
                  </td>
                  <td>
                    {def.kind === "flag" ? (
                      <select
                        aria-label={def.label}
                        value={current}
                        onChange={(event) => setEdits({ ...edits, [key]: event.target.value })}
                      >
                        <option value="">Inherit ({formatValue(def, inherited)})</option>
                        <option value="true">On</option>
                        <option value="false">Off</option>
                      </select>
                    ) : (
                      <input
                        aria-label={def.label}
                        type="number"
                        min={def.min}
                        max={def.max}
                        placeholder={`inherit ${inherited}`}
                        value={current}
                        onChange={(event) => setEdits({ ...edits, [key]: event.target.value })}
                      />
                    )}
                    <div className="muted small">
                      {def.kind === "flag"
                        ? "Empty inherits."
                        : `${def.min ?? 0}–${def.max ?? "∞"}${def.kind === "seconds" ? " seconds" : def.kind === "bytes" ? " bytes" : ""}. Empty inherits.`}
                    </div>
                  </td>
                </tr>
              );
            })}
        </tbody>
      </table>

      <div className="row">
        <button disabled={action.busy || pending === 0} onClick={save}>
          Save {pending === 0 ? "" : pending} change{pending === 1 ? "" : "s"}
        </button>
        <button className="ghost" disabled={pending === 0} onClick={() => setEdits({})}>
          Discard
        </button>
      </div>
      <p className="hint">
        A saved value reaches each replica this layer covers on its next poll — seconds, and nothing
        restarts. A replica whose container cannot honour one of them refuses the whole document,
        keeps serving what it already had, and says why on Health Status, rather than applying half
        of it.
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
            error={action.error}
            onSet={(value) =>
              submit({ [key]: value }, `${model.defs[key]!.label} ${value ? "on" : "off"}`)
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
        <div className="row">
          <button disabled={busy} onClick={() => onSet(true)}>
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
      consequence={`${def.purpose} Every gateway this layer reaches will answer requests without recording that it did, from its next poll until somebody turns it back on — and ${layer.reach.charAt(0).toLowerCase()}${layer.reach.slice(1)} The change is audited.`}
      permission={ALLOWED}
      busy={busy}
      error={error}
      onConfirm={() => onSet(false)}
    />
  );
}
