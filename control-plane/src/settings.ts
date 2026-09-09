/**
 * The store behind `shared/gateway-settings.ts`: three layers of sparse overrides, and the one
 * resolution the configuration document is built from.
 *
 * The whole table is read on every build rather than cached. It holds at most a few dozen rows —
 * one per setting somebody actually changed — and a cache here would be a second copy of the fleet's
 * configuration that could be stale at exactly the moment an administrator was watching a screen to
 * see whether their change had landed.
 */
import { writeAudit } from "./audit.ts";
import { type DB, nowIso } from "./db.ts";
import {
  GATEWAY_SETTING_DEFS,
  type GatewaySettings,
  isSettingKey,
  parseSetting,
  resolveGatewaySettings,
  resolveGatewaySettingSources,
  type SettingKey,
  type SettingOverride,
  type SettingScope,
  type SettingSubject,
  type SettingValue,
} from "../../shared/gateway-settings.ts";

interface SettingRow {
  scope: string;
  scope_id: string;
  key: string;
  value_json: string;
  set_at: string;
  set_by: string;
}

/** Every stored override, in no particular order — the resolver imposes the precedence. */
export function readSettingOverrides(db: DB): SettingOverride[] {
  const rows = db
    .query<SettingRow, []>("SELECT scope, scope_id, key, value_json, set_at, set_by FROM gateway_setting")
    .all();
  const out: SettingOverride[] = [];
  for (const row of rows) {
    if (!isSettingKey(row.key)) continue;
    let value: unknown;
    try {
      value = JSON.parse(row.value_json);
    } catch {
      // A row this cannot read is one setting reverting to its default, never a fleet that stops
      // converging. The resolver makes the same call about a value of the wrong shape.
      continue;
    }
    if (typeof value !== "number" && typeof value !== "boolean") continue;
    out.push({
      scope: row.scope as SettingScope,
      scopeId: row.scope_id,
      key: row.key,
      value: value as SettingValue,
    });
  }
  return out;
}

/** What one gateway's replicas are to be handed. */
export function settingsFor(db: DB, subject: SettingSubject): GatewaySettings {
  return resolveGatewaySettings(readSettingOverrides(db), subject);
}

/** The same, with the layer each value came from — for a screen that explains inheritance. */
export function settingSourcesFor(db: DB, subject: SettingSubject) {
  return resolveGatewaySettingSources(readSettingOverrides(db), subject);
}

/** One row, as the settings screen lists them. */
export interface StoredSetting extends SettingOverride {
  setAt: string;
  setBy: string;
}

export function listSettingOverrides(db: DB): StoredSetting[] {
  return db
    .query<SettingRow, []>(
      "SELECT scope, scope_id, key, value_json, set_at, set_by FROM gateway_setting ORDER BY scope, scope_id, key",
    )
    .all()
    .filter((row) => isSettingKey(row.key))
    .map((row) => ({
      scope: row.scope as SettingScope,
      scopeId: row.scope_id,
      key: row.key as SettingKey,
      value: JSON.parse(row.value_json) as SettingValue,
      setAt: row.set_at,
      setBy: row.set_by,
    }));
}

export interface SettingWrite {
  scope: SettingScope;
  scopeId: string;
  /** `null` clears the override, so the layer below is inherited again. */
  values: Record<string, SettingValue | null>;
}

/**
 * Apply one screen's worth of changes to one layer, or refuse the whole set.
 *
 * All-or-nothing on purpose: capacity settings are chosen against each other — a buffer budget
 * makes sense for a concurrency ceiling — and half of a considered pair applied is a fleet nobody
 * configured. `parseSetting` refuses an out-of-range value rather than clamping it, for the reason
 * it gives.
 */
export function writeSettingOverrides(
  db: DB,
  write: SettingWrite,
  actor: string,
  environments: readonly string[],
): { changed: SettingKey[]; cleared: SettingKey[] } {
  assertScope(db, write.scope, write.scopeId, environments);

  const parsed: Array<[SettingKey, SettingValue | null]> = [];
  for (const [key, raw] of Object.entries(write.values)) {
    if (!isSettingKey(key)) {
      throw new Error(
        `${key} is not a gateway setting. The settings are ${Object.keys(GATEWAY_SETTING_DEFS).join(", ")}`,
      );
    }
    parsed.push([key, raw === null ? null : parseSetting(key, raw)]);
  }

  const changed: SettingKey[] = [];
  const cleared: SettingKey[] = [];
  const at = nowIso();
  db.transaction(() => {
    for (const [key, value] of parsed) {
      if (value === null) {
        db.run("DELETE FROM gateway_setting WHERE scope = ? AND scope_id = ? AND key = ?", [
          write.scope,
          write.scopeId,
          key,
        ]);
        cleared.push(key);
        continue;
      }
      db.run(
        `INSERT INTO gateway_setting (scope, scope_id, key, value_json, set_at, set_by)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (scope, scope_id, key)
           DO UPDATE SET value_json = excluded.value_json, set_at = excluded.set_at, set_by = excluded.set_by`,
        [write.scope, write.scopeId, key, JSON.stringify(value), at, actor],
      );
      changed.push(key);
    }
  })();

  // One entry per call rather than per key: the audit trail should read the way the change was
  // made. `sensitive` settings are named in the detail so a query can find them without knowing
  // the table — turning the access log off is the event an auditor comes looking for.
  writeAudit(db, {
    actor,
    action: "gateway-settings.write",
    subject: `${write.scope}:${write.scopeId || "*"}`,
    outcome: "ok",
    detail: {
      set: Object.fromEntries(parsed.filter(([, value]) => value !== null)),
      cleared,
      sensitive: [...changed, ...cleared].filter((key) => GATEWAY_SETTING_DEFS[key].sensitive),
    },
  });

  return { changed, cleared };
}

/**
 * A scope_id that names nothing is refused here rather than stored: an override on a misspelled
 * environment would be a setting an administrator can see on a screen and no gateway will ever
 * read, which is worse than an error.
 */
function assertScope(
  db: DB,
  scope: SettingScope,
  scopeId: string,
  environments: readonly string[],
): void {
  if (scope === "fleet") {
    if (scopeId !== "") throw new Error("the fleet scope takes no scope id");
    return;
  }
  if (scope === "environment") {
    if (!environments.includes(scopeId)) {
      throw new Error(
        `"${scopeId}" is not an environment in PROMOTION_CHAIN (${environments.join(", ")})`,
      );
    }
    return;
  }
  const target = db
    .query<{ id: string }, [string]>("SELECT id FROM target WHERE id = ?")
    .get(scopeId);
  if (!target) throw new Error(`"${scopeId}" is not a gateway`);
}
