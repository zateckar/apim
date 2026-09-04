-- Schema version 5 — v5 goal G1: a principal directory, two authentication providers, and the
-- provenance that makes "where did this membership come from" answerable.
--
-- Additive. Nothing is rebuilt, so this migration needs no `foreignKeysOff` and cannot repeat
-- [V1-02]'s cascade.

------------------------------------------------------------------ the directory
-- Every human the portal knows, whichever provider authenticated them. Design section 9's two
-- roles and nothing else: there is no role editor and no per-environment role.
--
-- `provider` is part of the identity rather than an attribute of it (plan §4): `alice` from
-- Keycloak and `alice` in the local directory are two principals with two ids, and
-- UNIQUE (provider, subject) says so. Collapsing them on email would let a mail-address change in
-- one directory take over an account in the other.
CREATE TABLE principal (
  id            TEXT PRIMARY KEY,
  provider      TEXT NOT NULL,                    -- 'local' | 'oidc' | 'dev'
  subject       TEXT NOT NULL,                    -- local: the username; oidc: `sub`; dev: the id
  username      TEXT NOT NULL,                    -- typed, or `preferred_username`
  email         TEXT,
  display_name  TEXT NOT NULL,
  -- Authored here, by an admin. `idp_admin` is what the token last said. `isAdmin` is the OR of
  -- them, because one column would mean either an IdP demotion silently survives as a local grant
  -- or a local grant is wiped by the next claim re-read.
  role          TEXT NOT NULL DEFAULT 'member',   -- 'member' | 'admin'
  idp_admin     INTEGER NOT NULL DEFAULT 0,
  -- argon2id, and only ever argon2id. NULL for an OIDC or dev principal, and for a local one whose
  -- password has not been set yet — which cannot sign in, and is what "created, not yet usable"
  -- looks like.
  password_hash TEXT,
  must_change   INTEGER NOT NULL DEFAULT 0,
  disabled_at   TEXT,
  failed_count  INTEGER NOT NULL DEFAULT 0,
  locked_until  TEXT,
  created_at    TEXT NOT NULL,
  created_by    TEXT NOT NULL,
  last_login_at TEXT,
  UNIQUE (provider, subject)
);

-- Partial, and deliberately not (provider, username) [P1-12]: a local username is what a person
-- types, so it has to be unique. An OIDC `preferred_username` is mutable, is not guaranteed unique
-- across a realm's lifetime, and comes from a directory that owns its uniqueness — indexing it
-- would turn a legitimate rename in Keycloak into a 500 on that user's next sign-in.
CREATE UNIQUE INDEX principal_local_username ON principal(username) WHERE provider = 'local';
CREATE INDEX principal_by_provider ON principal(provider, disabled_at);

-- Every id already in the database belongs to somebody, and on any v4 database `seedBaseline` was
-- the only writer of `membership.user_id` — so backfilling one 'dev' principal per distinct value
-- there preserves ownership and authorship with nothing rewritten [P1-20]. Hard-coding three names
-- instead would have left a real deployment with memberships pointing at principals that do not
-- exist. On a fresh database this inserts nothing, because `membership` is still empty.
INSERT INTO principal (id, provider, subject, username, display_name, role, created_at, created_by)
SELECT DISTINCT m.user_id, 'dev', m.user_id, m.user_id, m.user_id, 'member',
       '1970-01-01T00:00:00.000Z', 'migration-005'
  FROM membership m
 WHERE NOT EXISTS (SELECT 1 FROM principal p WHERE p.id = m.user_id);

------------------------------------------------------------------ membership provenance (D33)
-- Two providers means two truths about the same fact, and hiding that would be worse than naming
-- it. The claim sync deletes and re-inserts only `source = 'idp'` rows for the principal it is
-- syncing, so an admin's grant survives a directory that has never heard of the team.
--
-- Existing rows read as 'local', which is what they are: they were authored here.
ALTER TABLE membership ADD COLUMN source     TEXT NOT NULL DEFAULT 'local';   -- 'idp' | 'local'
ALTER TABLE membership ADD COLUMN granted_by TEXT;
ALTER TABLE membership ADD COLUMN granted_at TEXT;

------------------------------------------------------------------ sessions
-- `provider` defaults to 'dev' because every session that exists when this migration runs is one.
ALTER TABLE session ADD COLUMN provider TEXT NOT NULL DEFAULT 'dev';

-- The one long-lived secret a session holds, through the same envelope as subscription keys and
-- certificate private keys [P1-10]: the KEK lives outside this file, so a database taken without
-- it yields no usable IdP credential, and a KEK rotation covers sessions with no second mechanism.
--
-- The access token is deliberately NOT here. Nothing downstream of the control plane takes a
-- user's token — gateways authenticate with their own instance tokens and the database is local —
-- so storing one would be a secret held for no reason [P1-06].
ALTER TABLE session ADD COLUMN refresh_token_enc   TEXT;
ALTER TABLE session ADD COLUMN claims_refreshed_at TEXT;
ALTER TABLE session ADD COLUMN user_agent          TEXT;   -- truncated; the "my sessions" screen
ALTER TABLE session ADD COLUMN last_seen_at        TEXT;

-- `roles_json` and `teams_json` stay, and stay NOT NULL, but stop being authoritative: they are
-- the login-time snapshot — what the directory said when this session started — and every request
-- resolves roles and teams live from `principal` and `membership` instead (D35). That is what
-- makes an admin's edit take effect on the next request rather than on the next sign-in.
CREATE INDEX session_by_user ON session(user_id, revoked_at);

------------------------------------------------------------------ one in-flight sign-in
-- Server-side rather than in a cookie, so a mid-sign-in control-plane restart does not strand the
-- user and the PKCE verifier is never anywhere a browser extension can read. Deleted on use, and
-- pruned past `expires_at` by the `prune` job [P1-19].
--
-- There is no `redirect_uri` column [P1-16]: there is one configured value, both the authorization
-- request and the token exchange use it, and per-host resolution is out of scope.
CREATE TABLE auth_flow (
  state         TEXT PRIMARY KEY,
  code_verifier TEXT NOT NULL,
  nonce         TEXT NOT NULL,
  return_to     TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  expires_at    TEXT NOT NULL
);
CREATE INDEX auth_flow_expiry ON auth_flow(expires_at);
