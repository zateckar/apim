-- ---------------------------------------------------------------------------------------------
-- v11 — a gateway's operational settings are the control plane's, not its container's.
--
-- Every key here was an environment variable on each data-plane container. That made a fleet's
-- configuration the union of N compose files: two gateways in one environment could disagree about
-- their own concurrency ceiling, and nothing said so until the smaller one started shedding. The
-- values move into the configuration document, resolved per gateway from three layers, and the
-- containers keep only what a process must know before it can poll at all.
--
-- Sparse by design: a row exists only where somebody overrode something. The defaults live in
-- `shared/gateway-settings.ts` and are what an estate with an empty table gets, so an upgrade
-- changes no behaviour until an administrator sets something.
--
-- `scope_id` is `''` for `fleet`, the environment's name for `environment`, and the *target id* for
-- `gateway` — an id rather than a name, so a gateway's overrides follow it through a rename and
-- leave with it when it is deleted. The `gateway` rows are the only ones with a referent, so they
-- are the only ones that can carry a foreign key; the trigger below is what keeps the other two
-- scopes honest instead.
-- ---------------------------------------------------------------------------------------------

CREATE TABLE gateway_setting (
  scope      TEXT NOT NULL CHECK (scope IN ('fleet', 'environment', 'gateway')),
  scope_id   TEXT NOT NULL,
  key        TEXT NOT NULL,
  -- JSON, so an integer and a boolean are stored as what they are rather than as `1`. The write
  -- path validates against the key's declared kind and bounds before anything lands here.
  value_json TEXT NOT NULL,
  set_at     TEXT NOT NULL,
  set_by     TEXT NOT NULL,
  PRIMARY KEY (scope, scope_id, key)
);

-- `fleet` is a single row set; naming a scope_id for it would create a second, invisible fleet.
CREATE TRIGGER gateway_setting_fleet_scope_insert
  BEFORE INSERT ON gateway_setting
  WHEN NEW.scope = 'fleet' AND NEW.scope_id <> ''
BEGIN
  SELECT RAISE(ABORT, 'gateway_setting: the fleet scope takes no scope_id');
END;

-- A deleted gateway leaves no overrides behind to be inherited by whatever takes its id next.
CREATE TRIGGER gateway_setting_target_delete
  AFTER DELETE ON target
BEGIN
  DELETE FROM gateway_setting WHERE scope = 'gateway' AND scope_id = OLD.id;
END;
