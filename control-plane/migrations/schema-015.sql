-- ---------------------------------------------------------------------------------------------
-- v15 — an application keeps its own credentials, instead of asking an administrator to edit a file.
--
-- Until now every `credentialRef` and `schemeRef` a policy could name resolved through
-- `INTEGRATIONS_FILE`: a JSON document on the control plane's disk, editable by an administrator
-- with shell access and read once at boot. For the two references that carry a URL the gateway
-- will *fetch* — `issuerRef` and `tokenProviderRef` — that is exactly right and does not change:
-- deciding which identity provider this estate believes is not an API owner's decision, and the
-- file is where a decision nothing clickable can widen belongs.
--
-- For the rest it was the wrong boundary, and the symptom was that the policy form asked owners to
-- type "a name registered in INTEGRATIONS_FILE" into a free-text box. A self-service estate cannot
-- make "my backend wants a username and password" into a ticket, a deploy and a restart. So the
-- credentials that are *only* secrets — nothing fetched, no URL, nothing that widens what the
-- platform trusts — move here, where the owning application manages them itself, per environment,
-- through the portal.
--
-- Three kinds, which is every app-ownable shape the policy vocabulary actually has:
--
--   basic          `user:pass`.      `auth.basic` compares its hash; `backendAuth.basic` presents it.
--   secret         one opaque value. `backendAuth.api-key` presents it;
--                                    `preconditions.requireHeader.credentialRef` compares its hash.
--   hmac           `appId:appKey`.   `backendAuth.hmac-sa-key-lite` signs with it.
--
-- A policy names one as `app:<applicationId>:<name>`. The application id is in the reference rather
-- than implied by the resource because the configuration document's `references.secrets` is one
-- flat map keyed by the reference string, and two applications are each entitled to a credential
-- called `backend`. Implying the owner would have collided them into one value, silently, and the
-- API that lost the toss would have presented somebody else's password. Nothing in the data plane
-- changes: it looks a reference up literally and answers 503 when it is absent, which is what a
-- deleted credential should do.
--
-- `secret_enc` is KEK-encrypted like a subscription key and a certificate's private key, and like
-- both of those it is never readable back through the portal API — not by the owner, not by an
-- administrator. Rotation replaces it; it is not a vault to look things up in.
--
-- `principal` is the half that is not a secret — the username, the client id, the app id — kept in
-- the clear so a list can say *which account* this is without decrypting anything. `rotated_at` is
-- the question asked of a credential more often than any other, and the one nothing recorded.
--
-- CONFIG_VERSION is unchanged: a new reference resolves into the same `references` map the document
-- has carried since v1, so a gateway on the previous build serves these without knowing they exist.
-- ---------------------------------------------------------------------------------------------

CREATE TABLE app_credential (
  id             TEXT PRIMARY KEY,
  application_id TEXT NOT NULL REFERENCES application(id) ON DELETE CASCADE,
  -- Per environment, like a certificate and for the same reason: a test backend and a production
  -- backend do not share a password, and promoting a policy must not promote a secret.
  environment    TEXT NOT NULL,
  name           TEXT NOT NULL,
  kind           TEXT NOT NULL CHECK (kind IN ('basic', 'secret', 'hmac')),
  secret_enc     TEXT NOT NULL,             -- KEK-encrypted; 'user:pass', a value, or 'appId:appKey'
  principal      TEXT,                      -- username / app id — the non-secret half, in the clear
  note           TEXT,                      -- what this opens, for the person who inherits it
  created_by     TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  rotated_at     TEXT,
  UNIQUE (application_id, environment, name)
);

CREATE INDEX app_credential_env ON app_credential(environment);
