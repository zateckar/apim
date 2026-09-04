-- Schema version 2 — v2 goals: versioning, promotion plans, the fleet, telemetry.
-- Runs with foreign keys OFF, set by the runner outside the transaction (see db.ts), because
-- this migration rebuilds `resource`.

------------------------------------------------------------------ G2: versioning
-- An API's identity includes its consumer-visible version, so two versions are two rows sharing
-- a family name. SQLite cannot drop an inline UNIQUE, so the table is rebuilt.
CREATE TABLE resource_new (
  id           TEXT PRIMARY KEY,
  kind         TEXT NOT NULL,
  name         TEXT NOT NULL,
  team_id      TEXT NOT NULL REFERENCES team(id),
  api_version  TEXT NOT NULL DEFAULT 'v1',
  lifecycle    TEXT NOT NULL DEFAULT 'active',
  sunset_at    TEXT,
  derived_from TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  UNIQUE (team_id, name, api_version)
);

INSERT INTO resource_new (id, kind, name, team_id, api_version, lifecycle, sunset_at,
                          derived_from, created_at, updated_at)
     SELECT id, kind, name, team_id, api_version, lifecycle, sunset_at,
            derived_from, created_at, updated_at
       FROM resource;

DROP TABLE resource;
ALTER TABLE resource_new RENAME TO resource;
CREATE INDEX resource_family ON resource(team_id, name, api_version);

------------------------------------------------------------------ G1: promotion
-- The gate asks "has this revision ever reached the fleet in the predecessor". That is
-- state IN ('converged','superseded','withdrawn') only while those two terminal states remain
-- reachable *only* from converged -- so the invariant is enforced here rather than by the two
-- WHERE clauses in the reconcile job that happen to preserve it today.
CREATE TRIGGER release_state_history BEFORE UPDATE ON release
WHEN new.state IN ('superseded', 'withdrawn') AND old.state <> 'converged'
BEGIN
  SELECT RAISE(ABORT, 'a release reaches superseded/withdrawn only from converged');
END;

CREATE INDEX release_by_revision ON release(revision_id, environment, state);

-- The plan is computed on dry run, persisted, and re-computed by the job, which refuses to apply
-- if the digest moved (design section 6.3).
CREATE TABLE release_plan (
  id           TEXT PRIMARY KEY,
  resource_id  TEXT NOT NULL REFERENCES resource(id) ON DELETE CASCADE,
  revision_id  TEXT NOT NULL REFERENCES revision(id) ON DELETE CASCADE,
  environment  TEXT NOT NULL,
  plan_json    TEXT NOT NULL,
  plan_digest  TEXT NOT NULL,
  computed_by  TEXT NOT NULL,
  computed_at  TEXT NOT NULL
);
CREATE INDEX release_plan_by_resource ON release_plan(resource_id, environment, computed_at DESC);

ALTER TABLE release ADD COLUMN plan_id TEXT REFERENCES release_plan(id);

------------------------------------------------------------------ G3: the fleet
ALTER TABLE gateway_instance ADD COLUMN created_at   TEXT;
ALTER TABLE gateway_instance ADD COLUMN created_by   TEXT;
ALTER TABLE gateway_instance ADD COLUMN last_ip      TEXT;
-- Last known values, not a series: the instance's process block plus the report's drop counters.
-- Diagnostics about telemetry are not themselves telemetry, so they get no rollup.
ALTER TABLE gateway_instance ADD COLUMN process_json TEXT;

------------------------------------------------------------------ G4: telemetry
-- Pre-aggregated per minute per instance run. Deviation D15: the design keeps no usage store,
-- this one is bounded the way design section 5.7 bounds usage_counter and is not a ledger.
--
-- resource_id and subscription_id are '' rather than NULL, because SQLite allows NULLs in a
-- PRIMARY KEY and treats every NULL as distinct -- which would defeat the upsert and add a row
-- per flush. run_id is in the key so an instance restart writes new rows instead of replacing a
-- minute's pre-restart counts. environment is denormalised from the instance's target because
-- every dashboard query filters on it first.
CREATE TABLE telemetry_rollup (
  environment      TEXT    NOT NULL,
  instance_id      TEXT    NOT NULL REFERENCES gateway_instance(id) ON DELETE CASCADE,
  run_id           TEXT    NOT NULL,
  window_start     TEXT    NOT NULL,
  resource_id      TEXT    NOT NULL,
  subscription_id  TEXT    NOT NULL,
  outcome          TEXT    NOT NULL,
  status           INTEGER NOT NULL,
  count            INTEGER NOT NULL,
  duration_ms_sum  INTEGER NOT NULL,
  duration_ms_max  INTEGER NOT NULL,
  bytes_in         INTEGER NOT NULL,
  bytes_out        INTEGER NOT NULL,
  buckets_json     TEXT    NOT NULL,
  PRIMARY KEY (environment, instance_id, run_id, window_start,
               resource_id, subscription_id, outcome, status)
);
CREATE INDEX telemetry_by_window   ON telemetry_rollup(environment, window_start);
CREATE INDEX telemetry_by_resource ON telemetry_rollup(resource_id, window_start);
