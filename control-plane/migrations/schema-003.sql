-- Schema version 3 — v3 goals: validation from the definition, a global policy tier, the rest of
-- the design's vocabulary, MCP and A2A, the catalog, and backend pools.
--
-- Nothing is rebuilt, so this migration needs no `foreignKeysOff` and cannot repeat [V1-02].

------------------------------------------------------------------ G1: compiled validators (§8.7)
-- Content-addressed and immutable: a digest never changes meaning, so there is no invalidation
-- logic, only eviction. `bytes` is the COMPILED bundle — every $ref resolved, every pattern
-- linted — not the source schema, because the data plane never parses OpenAPI or WSDL.
CREATE TABLE artifact (
  digest      TEXT PRIMARY KEY,
  kind        TEXT    NOT NULL,           -- 'json-schema' | 'xsd-set'
  bytes       TEXT    NOT NULL,
  size_bytes  INTEGER NOT NULL,
  created_at  TEXT    NOT NULL
);

-- One bundle per revision. Compiled when the revision is CREATED rather than at release, so
-- attaching `validate` to an API released months ago works, and so compilation happens once per
-- contract instead of once per environment it reaches [R3-01]. Two revisions with an unchanged
-- schema share one row; pruning is out of scope, so the reference count is a COUNT over this
-- column rather than a join table [R3-02].
ALTER TABLE revision ADD COLUMN artifact_digest TEXT;

-- The compact operation index — id, method, path template, SOAP element, RPC selector — derived
-- from `model` at the same moment. Routing and selection only, never schemas (§8.7). It lives here
-- rather than being re-derived because the config document is rebuilt on every poll, and parsing a
-- multi-megabyte model per route per poll is exactly the read load §13 warns about.
ALTER TABLE revision ADD COLUMN index_json TEXT;

------------------------------------------------------------------ G2: the global policy tier (D18)
-- Per environment, admin-only, never promoted, merged UNDER the resource's own units so the API
-- always wins a conflict. Only the units on §5's allowlist may be attached here.
CREATE TABLE global_policy_entry (
  environment TEXT NOT NULL,
  unit_key    TEXT NOT NULL,
  value_json  TEXT NOT NULL,
  updated_by  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (environment, unit_key)
);

------------------------------------------------------------------ G3 §4.3: client identities
-- Certificates we PRESENT, with their private keys. Distinct from trust anchors, which are
-- admin-registered in INTEGRATIONS_FILE and contain no secrets. PEM only (deviation D24).
CREATE TABLE certificate (
  id          TEXT PRIMARY KEY,
  team_id     TEXT NOT NULL REFERENCES team(id),
  environment TEXT NOT NULL,
  name        TEXT NOT NULL,
  cert_pem    TEXT NOT NULL,
  chain_pem   TEXT,
  key_enc     TEXT NOT NULL,              -- KEK-encrypted PKCS#8 PEM
  thumbprint  TEXT NOT NULL,              -- sha256 over the DER, uppercase hex
  subject     TEXT NOT NULL,
  issuer      TEXT NOT NULL,
  not_before  TEXT NOT NULL,
  not_after   TEXT NOT NULL,
  usage       TEXT NOT NULL,              -- 'backend-mtls'
  created_by  TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  UNIQUE (team_id, environment, name)
);

------------------------------------------------------------------ G3 §5.4: backend TLS exceptions
-- Its own table, admin-written, always with an expiry. Inside binding.backend_json it would be
-- owner-writable, invisible to "list every unverified backend", and permanent by default.
CREATE TABLE tls_exception (
  id             TEXT PRIMARY KEY,
  resource_id    TEXT NOT NULL REFERENCES resource(id) ON DELETE CASCADE,
  environment    TEXT NOT NULL,
  backend_url    TEXT,                    -- NULL = every backend in that binding's pool
  mode           TEXT NOT NULL,           -- 'pin' | 'skip-hostname' | 'insecure'
  pin_thumbprint TEXT,
  reason         TEXT NOT NULL,
  created_by     TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  expires_at     TEXT NOT NULL,
  revoked_at     TEXT
);
CREATE INDEX tls_exception_live ON tls_exception(environment, expires_at);

------------------------------------------------------------------ G3 §5.7: the fleet quota aggregate
-- Enforcement only, never a ledger (D15 still holds). `period_sec` is in the key because two
-- policies on one subscription with different windows are different counters and would otherwise
-- collide on window_start.
CREATE TABLE usage_counter (
  subscription_id TEXT    NOT NULL,
  environment     TEXT    NOT NULL,
  scope_kind      TEXT    NOT NULL,       -- 'route' | 'product' | 'operation'
  scope_id        TEXT    NOT NULL,
  period_sec      INTEGER NOT NULL,
  window_start    TEXT    NOT NULL,
  count           INTEGER NOT NULL,
  updated_at      TEXT    NOT NULL,
  PRIMARY KEY (subscription_id, environment, scope_kind, scope_id, period_sec, window_start)
);
CREATE INDEX usage_by_window ON usage_counter(environment, window_start);

------------------------------------------------------------------ G6: the catalog
-- Marketing metadata belongs to the resource, not to a separate "listing" entity: a listing that
-- can disagree with the thing it lists is a second source of truth.
ALTER TABLE resource ADD COLUMN summary       TEXT;
ALTER TABLE resource ADD COLUMN description   TEXT;
ALTER TABLE resource ADD COLUMN tags_json     TEXT NOT NULL DEFAULT '[]';
ALTER TABLE resource ADD COLUMN docs_url      TEXT;
ALTER TABLE resource ADD COLUMN icon          TEXT;
ALTER TABLE resource ADD COLUMN visibility    TEXT NOT NULL DEFAULT 'listed';
-- G4/G5: where a discovered contract came from, so "regenerate" knows what to re-fetch.
ALTER TABLE resource ADD COLUMN discovery_url TEXT;

ALTER TABLE product ADD COLUMN summary     TEXT;
ALTER TABLE product ADD COLUMN description TEXT;
ALTER TABLE product ADD COLUMN tags_json   TEXT NOT NULL DEFAULT '[]';

-- The projection §14 asks for. Not an external-content table and not trigger-maintained: what it
-- indexes includes the operation list, which lives inside revision.model as JSON, so it is
-- rebuilt by search.ts at every write that changes it [R2-10].
CREATE VIRTUAL TABLE resource_fts USING fts5(
  resource_id UNINDEXED,
  name,
  title,
  summary,
  description,
  tags,
  operations,
  tokenize = 'unicode61 remove_diacritics 2'
);
