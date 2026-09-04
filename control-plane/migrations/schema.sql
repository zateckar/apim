-- Schema version 1 — the MVP subset of design section 4.
-- Names and columns are the design's; tables the MVP does not need are absent, not renamed,
-- so the rest is additive later.

CREATE TABLE schema_version (
  version    INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

-- identity and all of authorization (design section 9)
CREATE TABLE team (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL UNIQUE,
  source_group TEXT
);

CREATE TABLE membership (
  team_id TEXT NOT NULL REFERENCES team(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  PRIMARY KEY (team_id, user_id)
);

CREATE TABLE session (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  roles_json TEXT NOT NULL,
  teams_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  idle_until TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT
);

-- the publishable thing
CREATE TABLE resource (
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
  UNIQUE (team_id, name)
);

-- the CONTRACT only; `model` is normalized, `original` is the upload byte for byte
CREATE TABLE revision (
  id              TEXT PRIMARY KEY,
  resource_id     TEXT NOT NULL REFERENCES resource(id) ON DELETE CASCADE,
  rev             INTEGER NOT NULL,
  model           TEXT NOT NULL,
  original        TEXT NOT NULL,
  original_format TEXT NOT NULL,
  version_digest  TEXT NOT NULL,
  frozen_at       TEXT,
  created_by      TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  UNIQUE (resource_id, rev)
);
CREATE INDEX revision_by_resource ON revision(resource_id, rev DESC);

-- one row per policy per environment: the row's existence is the policy (design section 5)
CREATE TABLE policy_entry (
  resource_id     TEXT NOT NULL REFERENCES resource(id) ON DELETE CASCADE,
  environment     TEXT NOT NULL,
  unit_key        TEXT NOT NULL,
  value_json      TEXT NOT NULL,
  origin          TEXT NOT NULL DEFAULT 'local',
  seeded_from_env TEXT,
  seeded_at       TEXT,
  updated_by      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  PRIMARY KEY (resource_id, environment, unit_key)
);

CREATE TABLE route (
  resource_id TEXT NOT NULL REFERENCES resource(id) ON DELETE CASCADE,
  environment TEXT NOT NULL,
  host        TEXT NOT NULL,
  base_path   TEXT NOT NULL,
  PRIMARY KEY (resource_id, environment),
  UNIQUE (environment, host, base_path)
);

CREATE TABLE binding (
  resource_id  TEXT NOT NULL REFERENCES resource(id) ON DELETE CASCADE,
  environment  TEXT NOT NULL,
  backend_json TEXT NOT NULL,
  PRIMARY KEY (resource_id, environment)
);

-- the consumable thing
CREATE TABLE product (
  id        TEXT PRIMARY KEY,
  name      TEXT NOT NULL UNIQUE,
  team_id   TEXT NOT NULL REFERENCES team(id),
  lifecycle TEXT NOT NULL DEFAULT 'active',
  terms     TEXT
);

CREATE TABLE product_member (
  product_id  TEXT NOT NULL REFERENCES product(id) ON DELETE CASCADE,
  resource_id TEXT NOT NULL REFERENCES resource(id) ON DELETE CASCADE,
  PRIMARY KEY (product_id, resource_id)
);
CREATE INDEX product_member_by_resource ON product_member(resource_id);

CREATE TABLE application (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  team_id    TEXT NOT NULL REFERENCES team(id),
  created_at TEXT NOT NULL
);

CREATE TABLE subscription (
  id                 TEXT PRIMARY KEY,
  product_id         TEXT NOT NULL REFERENCES product(id) ON DELETE CASCADE,
  application_id     TEXT NOT NULL REFERENCES application(id) ON DELETE CASCADE,
  environment        TEXT NOT NULL,
  state              TEXT NOT NULL DEFAULT 'active',
  primary_key_enc    TEXT NOT NULL,
  secondary_key_enc  TEXT,
  key_rotated_at     TEXT,
  created_at         TEXT NOT NULL,
  UNIQUE (product_id, application_id, environment)
);

-- promotion
CREATE TABLE release (
  id             TEXT PRIMARY KEY,
  resource_id    TEXT NOT NULL REFERENCES resource(id) ON DELETE CASCADE,
  revision_id    TEXT NOT NULL REFERENCES revision(id) ON DELETE CASCADE,
  environment    TEXT NOT NULL,
  state          TEXT NOT NULL,
  reason         TEXT,
  version_digest TEXT NOT NULL,
  released_by    TEXT NOT NULL,
  released_at    TEXT NOT NULL
);
CREATE INDEX release_by_resource ON release(resource_id, environment, released_at DESC);
-- at most one live release per resource per environment
CREATE UNIQUE INDEX release_live ON release(resource_id, environment) WHERE state = 'converged';

-- targets and fleet
CREATE TABLE target (
  id                TEXT PRIMARY KEY,
  environment       TEXT NOT NULL,
  adapter           TEXT NOT NULL,
  config_json       TEXT NOT NULL DEFAULT '{}',
  enforce           INTEGER NOT NULL DEFAULT 1,
  paused            INTEGER NOT NULL DEFAULT 0,
  lease_holder      TEXT,
  lease_expires_at  TEXT,
  UNIQUE (environment, adapter)
);

CREATE TABLE gateway_instance (
  id            TEXT PRIMARY KEY,
  target_id     TEXT NOT NULL REFERENCES target(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  token_hash    TEXT NOT NULL UNIQUE,
  config_digest TEXT,
  last_seen_at  TEXT,
  revoked_at    TEXT
);

-- what the target actually has
CREATE TABLE applied (
  target_id        TEXT NOT NULL REFERENCES target(id) ON DELETE CASCADE,
  resource_id      TEXT NOT NULL REFERENCES resource(id) ON DELETE CASCADE,
  revision_id      TEXT NOT NULL,
  applied_digest   TEXT NOT NULL,
  compiler_version TEXT NOT NULL,
  applied_at       TEXT NOT NULL,
  PRIMARY KEY (target_id, resource_id)
);

-- operations
CREATE TABLE job (
  id              TEXT PRIMARY KEY,
  kind            TEXT NOT NULL,
  state           TEXT NOT NULL,
  payload         TEXT NOT NULL,
  idempotency_key TEXT UNIQUE,
  attempts        INTEGER NOT NULL DEFAULT 0,
  result          TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX job_by_state ON job(state, created_at);

CREATE TABLE audit (
  id      TEXT PRIMARY KEY,
  at      TEXT NOT NULL,
  actor   TEXT NOT NULL,
  action  TEXT NOT NULL,
  subject TEXT NOT NULL,
  outcome TEXT NOT NULL,
  detail  TEXT
);
CREATE INDEX audit_by_time ON audit(at DESC);

-- SQLite has no grants, so append-only is a pair of triggers (design section 4)
CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit
BEGIN SELECT RAISE(ABORT, 'audit is append-only'); END;
CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit
BEGIN SELECT RAISE(ABORT, 'audit is append-only'); END;
