-- Schema version 4 — v4 goals: a per-environment trust store (G4), a server-side playground
-- history (G1), and the provenance and tombstone columns revision management needs (G3).
--
-- Nothing is rebuilt, so this migration needs no `foreignKeysOff` and cannot repeat [V1-02].

------------------------------------------------------------------ G4 §5.4 rung 1: the trust store
-- The certificates whose signature makes a backend's certificate verify. Admin-only, per
-- environment, and distributed to every gateway in that environment inside the config document
-- (plan §8.2) — deviation D26, which moves this off per-process `BACKEND_CA_BUNDLE` config so the
-- portal owns it like every other piece of desired state.
--
-- Distinct from `certificate`, which holds identities we PRESENT and therefore holds private keys.
-- An anchor is a public certificate: nothing here is secret, which is why it may travel inline and
-- sit in the fail-static cache unencrypted [P2-10].
CREATE TABLE trust_anchor (
  id          TEXT PRIMARY KEY,
  environment TEXT NOT NULL,
  name        TEXT NOT NULL,
  cert_pem    TEXT NOT NULL,
  subject     TEXT NOT NULL,
  issuer      TEXT NOT NULL,
  thumbprint  TEXT NOT NULL,          -- sha256 of the DER, uppercase hex, no colons
  not_before  TEXT NOT NULL,
  not_after   TEXT NOT NULL,
  added_by    TEXT NOT NULL,
  added_at    TEXT NOT NULL,
  -- Removal is dated rather than destructive, so "who trusted this, and when did we stop" survives
  -- the answer. A removed anchor stops travelling at the next config build.
  removed_at  TEXT
);
-- Partial, so removing an anchor and registering the same CA again is allowed; a *live* duplicate
-- is not (review [P1-06]).
CREATE UNIQUE INDEX trust_anchor_live_unique ON trust_anchor(environment, thumbprint)
  WHERE removed_at IS NULL;
CREATE INDEX trust_anchor_live ON trust_anchor(environment, removed_at, not_after);

------------------------------------------------------------------ G1: playground history (D27)
-- The caller's own scratchpad, not a call ledger — §5.7's "no per-call ledger" is about metering,
-- and this table is bounded per (user, resource) and pruned by age. Scoped to `user_id` rather than
-- to the team because a request body is test data somebody typed: a team-mate sees the API's
-- traffic in telemetry, not what a colleague put in a form.
--
-- No key, ever. `subscription_id` is a reference that is re-resolved on replay, and the header the
-- key was injected into is not stored either.
CREATE TABLE playground_call (
  id                    TEXT PRIMARY KEY,
  user_id               TEXT NOT NULL,
  resource_id           TEXT NOT NULL REFERENCES resource(id) ON DELETE CASCADE,
  environment           TEXT NOT NULL,
  subscription_id       TEXT,           -- reference only; re-resolved live on replay
  key_kind              TEXT NOT NULL,  -- 'primary' | 'secondary' | 'none'
  operation_id          TEXT,
  method                TEXT NOT NULL,
  path                  TEXT NOT NULL,  -- below the route's base path, as sent
  query_json            TEXT NOT NULL,
  headers_json          TEXT NOT NULL,  -- as sent, minus the key header
  body                  TEXT,
  gateway_label         TEXT NOT NULL,
  status                INTEGER,        -- NULL when the call never completed
  status_text           TEXT,
  duration_ms           INTEGER,
  response_headers_json TEXT,
  -- A preview, not a body: PLAYGROUND_HISTORY_BODY_BYTES bounds it and `response_truncated` says
  -- so, the same discipline `includeBodyExcerptBytes` applies to validation failures (§5.1).
  response_preview      TEXT,
  response_encoding     TEXT,           -- 'utf-8' | 'base64'
  response_truncated    INTEGER NOT NULL DEFAULT 0,
  error                 TEXT,
  created_at            TEXT NOT NULL
);
CREATE INDEX playground_by_user ON playground_call(user_id, resource_id, created_at DESC);

------------------------------------------------------------------ G3 §4.1: retention and provenance
-- A pruned revision keeps its row as a tombstone: id, rev, digests, author and timestamps intact,
-- so release foreign keys and audit trails survive the content going away. Every existing revision
-- is unpruned, which is what NULL says — no backfill.
ALTER TABLE revision ADD COLUMN pruned_at TEXT;

-- How THIS revision came to exist. `resource.discovery_url` is per resource, so it cannot answer
-- the question the revision list asks (review [P2-05]). Written by every creation path; rows that
-- predate the column read as 'upload', which is what all of them were.
ALTER TABLE revision ADD COLUMN source        TEXT NOT NULL DEFAULT 'upload';
                                              -- 'upload' | 'url' | 'discovery' | 'copied' | 'corrected'
ALTER TABLE revision ADD COLUMN source_detail TEXT;   -- the URL, or the revision copied from
