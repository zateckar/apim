-- ---------------------------------------------------------------------------------------------
-- v13 — the egress boundary is stated the other way round.
--
-- `egressAllowlist` in INTEGRATIONS_FILE is retired (readIntegrations now refuses a file that still
-- carries one). Every backend host had to be registered there and the control plane restarted,
-- which at a self-service estate's size made registering an API a ticket — and a list that is a
-- ticket is a list nobody reads. Egress is now allowed by default and forbidden two ways: the
-- denied CIDR ranges, which stay in the file where nothing clickable can widen them, and the
-- per-host rules in this table, which an administrator states in the portal with a reason.
--
-- The half that lives here is the half that changes. That is also why it carries an author, a
-- reason and a dated removal rather than being a list of strings: "who blocked this, and when did
-- we stop" is the question asked months later, and it outlives the rule itself.
--
-- Enforced twice — at write time on a backend, an import and a discovery URL, and again when the
-- environment's configuration document is built, where a route whose backend matches is omitted
-- with the rule in the document's `errors[]`. The second is what makes a rule retroactive: the
-- fleet stops serving a route already running, within one poll. Nothing new travels to a gateway,
-- so CONFIG_VERSION is unchanged and no instance reports `activationBlocked`.
-- ---------------------------------------------------------------------------------------------

CREATE TABLE egress_deny_rule (
  id           TEXT PRIMARY KEY,
  -- NULL is estate-wide. "Nothing may ever proxy to the domain controllers" is an estate sentence;
  -- "not from dev" is an environment one, and both are real.
  environment  TEXT,
  -- NULL matches both schemes.
  scheme       TEXT CHECK (scheme IS NULL OR scheme IN ('http','https')),
  -- An exact host, or `*.suffix` — which does not match the bare suffix. Matched textually and
  -- case-insensitively, never resolved: `denyCidrs` already owns the resolved-address question,
  -- and a rule whose verdict can be read off the screen is one that can be explained in a refusal.
  host_pattern TEXT NOT NULL,
  -- Both NULL means every port. `ports_json` is '[443,8443]'; `port_range_json` is '[1024,65535]'.
  ports_json      TEXT,
  port_range_json TEXT,
  reason       TEXT NOT NULL,
  created_by   TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  -- Dated rather than destructive, like a trust anchor's removal. Routes a removed rule was
  -- blocking are served again at the next configuration build.
  removed_at   TEXT
);

-- COALESCE rather than the bare columns: SQLite treats NULLs as distinct in a unique index, so
-- two estate-wide rules for the same host would both be allowed and only the first would ever be
-- reported as the one that matched. Partial, so removing a rule and re-stating it later is fine.
CREATE UNIQUE INDEX egress_deny_rule_live_unique
  ON egress_deny_rule(COALESCE(environment,'*'), COALESCE(scheme,'*'), lower(host_pattern))
  WHERE removed_at IS NULL;
CREATE INDEX egress_deny_rule_live ON egress_deny_rule(removed_at, environment);

-- The one rule the platform cannot derive for itself. The control plane denies its own PUBLIC_URL
-- origin without being told, but the address *gateways* reach it on is GATEWAY_CP_URL, which is set
-- on each gateway container and is not knowable from here. `control-plane` is the compose service
-- name; an estate that reaches the control plane under another name should state that one too.
--
-- Shipped rather than left to be remembered: a route pointed back at the portal's own API is the
-- case this whole boundary exists to prevent, and it is the one nobody thinks of.
INSERT INTO egress_deny_rule (id, environment, scheme, host_pattern, reason, created_by, created_at)
VALUES (
  'deny-control-plane-self',
  NULL,
  NULL,
  'control-plane',
  'The control plane''s own API. A route pointed back at the portal would let a gateway proxy to it, which is neither a backend nor something a subscription should reach.',
  'system',
  strftime('%Y-%m-%dT%H:%M:%fZ','now')
);
