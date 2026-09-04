# MVP v5 implementation plan — Integration Portal

Draft 1 · what changes to take the shipped v4 (see [`v4-plan.md`](v4-plan.md)) to four new goals,
without abandoning the spine of [`greenfield-design.md`](greenfield-design.md).

Review rounds and the findings that changed this document live in
[`v5-plan-review.md`](v5-plan-review.md). Finding ids appear inline as `[P1-01]`. The findings of
v1 (`R…`, `I…`), v2 (`V…`), v3 (`R…`) and v4 (`P…`) still hold and are not repeated.

Two claims below were checked by running Bun rather than by reasoning. One was wrong by a factor of
sixteen; both measurements are recorded where they are used.

---

## 1. Goals, restated as acceptance criteria

| # | Goal | Acceptance test |
|---|---|---|
| G1 | **User management, authorization, authentication — local *and* OIDC (Keycloak)** | A deployment can be configured with a local user directory, with Keycloak, or with both. A local admin signs in with a username and a password that is stored as argon2id and never logged; an OIDC user signs in through an authorization-code + PKCE round trip the **control plane** owns end to end, and the browser never sees a token. Roles and team membership arrive from the IdP's claims and are re-read on a bounded interval, so a group removal in Keycloak takes effect without a sign-out. An admin can create, disable, re-role and re-team local users, and can see where every membership came from. `can()` is unchanged and still the only authorization function |
| G2 | **Ready to deploy: GitHub Actions, one image per plane** | `docker/control-plane.Dockerfile` and `docker/data-plane.Dockerfile` build two independent images that share no runtime state. Each runs as a non-root user, reads all configuration from the environment and mounted files, has a `HEALTHCHECK`, and starts with no repository checkout. `.github/workflows/ci.yml` type-checks and runs both test suites on every push; `.github/workflows/images.yml` builds, smoke-tests and publishes both images. `docker compose up` brings up a working portal on a clean machine |
| G3 | **A design document describing the whole application** | [`docs/design.md`](design.md) describes what the product does and how a person moves through it — the objects, the roles, the six journeys, the promotion and subscription processes, the policy and validation model, what each plane is responsible for, and what the operator has to decide. It is written to be read by somebody who will never open the source: no file names, no function names, no SQL |
| G4 | **A README that says what this is and how to set it up** | [`README.md`](../README.md) is short. It says what the application is, what it needs, how to run it locally, how to run it in containers, how to configure the two authentication modes, and where to read more. Everything it drops is moved, not deleted |

G1's "no token in the browser", G1's "membership provenance is visible", G2's "no repository
checkout" and G3's "no file names" are the contract.

---

## 2. What is in and what is deliberately out

### In scope, on top of v4

- **A principal directory** — one table for every human the portal knows, whichever provider
  authenticated them, with the two design §9 roles and nothing else.
- **A local authentication provider** — username and password, argon2id, lockout, forced password
  change, and a bootstrap admin that exists only until somebody sets a password.
- **An OIDC provider** — discovery, authorization code + PKCE, `state` bound to a cookie, `nonce`
  checked, the `id_token` signature verified against the issuer's JWKS, refresh-token-driven claim
  re-read, and single logout.
- **Claims → roles and teams**, mapped through `team.source_group`, recomputed on every claim
  re-read, with locally granted membership kept separate and never overwritten.
- **User and team management** — admin surfaces for both, with membership provenance on every row.
- **Session management** — the user's own session list, "sign out everywhere", and an admin's
  "force sign-out".
- **Two container images**, a compose file that works on a clean machine, and three workflows.
- **A functional design document**, and a README that is a front door rather than a manual.

### Out of scope (named, with the section it comes from)

Everything v4 named stays out and stays **absent rather than stubbed**: `kafka` / `kafka-topic` /
`kafka-proxy` (§8.8–§8.10) · `graphql` (§4.4) · the `apim` adapter and import (§8, §16) · approvals
and announcements (§4.2, §6.3) · drift (§7) · OTEL/ELK (§13) · Postgres (§13) · automated
certificate issuance (§4.3) · active backend health checks (§18.13).

OIDC leaves that list. Two more items leave it in part, and the rest are new:

- **Service tokens** (§9) stay out. Automation that must talk to the control plane uses a local
  principal today. A machine identity that is not a person is a different lifecycle — no password
  rotation, no forced change, no sessions — and pretending a local user is one would make the user
  list dishonest. Named in the design document as the next thing.
- **SCIM or any scheduled directory sync** (§9's "synced from IdP groups"). Membership is derived
  at sign-in and at each claim re-read, which covers the user who is signing in and nobody else. A
  user who has never signed in does not exist here, so an admin cannot pre-assign them to a team.
  Stated as a limitation rather than covered by a claim `[P1-11]`.
- **Password reset by email** — there is no mail transport in this product (design §10's
  notification fan-out is out of scope), so a forgotten password is an admin reset. The reset sets
  `must_change_password`, so the admin never learns the password the user ends up with.
- **Multi-factor authentication** for the local provider. If a deployment needs MFA it configures
  Keycloak, which has it. Building a second-rate TOTP beside a working IdP is the wrong trade.
- **Per-host redirect-URI resolution** `[P1-16]`. There is one `OIDC_REDIRECT_URI`, used verbatim,
  and its origin must match `PUBLIC_URL`. The reference implementation in
  `existing-ui-for-inspiration/` derives the redirect URI from each request's forwarded host
  against an allow-list, because that portal is served on several custom domains. This one is
  served on one, and an allow-list guarding a decision nobody makes is a Host-header injection
  surface with no compensating feature.
- **A multi-instance control plane.** The images are independent, and the data-plane image scales
  horizontally, but design §13's "one SQLite writer, one host" still holds for the control plane.
  The compose file and the deployment document say so in the place where somebody would otherwise
  set `replicas: 3`.
- **Kubernetes manifests or a Helm chart.** The images and the environment contract are what a
  chart would need; writing one without a cluster to test it against would ship an untested
  artifact. The deployment document lists what a chart has to get right instead.

### Deviations from the design

D1–D31 stand, except D4 which this version retires. New ones:

| # | Design says | v5 does | Reason |
|---|---|---|---|
| ~~D4~~ | — | *Retired.* v1–v4 shipped only the §9 development identity bypass. G1 replaces it: the bypass is now one provider among three and has to be asked for by name | — |
| D32 | "Nothing about who-is-who is authored in this product" (§9) — identity comes from the corporate IdP | A **local provider** with usernames, argon2id password hashes, lockout and forced change, selectable beside or instead of OIDC | The goal asks for it, and a portal that cannot be signed into without an IdP cannot be evaluated, cannot be run in an air-gapped test environment, and has no way back in when the IdP is misconfigured. Local principals are marked as such everywhere they appear, so "authored here" is never mistaken for "came from the directory" |
| D33 | `team` and `membership` are synced from IdP groups; nothing else grants membership | `membership` carries a `source` — `idp` or `local`. IdP rows are replaced wholesale at every claim re-read; local rows are granted by an admin and never touched by the sync. A user's teams are the union | Two providers means two truths about the same fact, and hiding that would be worse than naming it. The provenance is on the row, so every team page can say "from group `SG-APIM-ORDERS`" or "granted by alice on 2026-09-04" — which is the question an auditor actually asks |
| D34 | The `id_token` from the code exchange is trusted because the exchange was a TLS-protected POST we initiated (the shape the reference implementation in `existing-ui-for-inspiration/` uses) | The `id_token` signature **is** verified against the issuer's JWKS, and `nonce`, `iss`, `aud`, `exp` and `nbf` with it | The verifier already exists — the data plane's `auth.jwt` unit has one, and it is the same primitive. Measured: JWK import **plus** RS256 verify is **0.019 ms**, and the import is 0.002 ms of it, so the cache does not even need to hold imported keys `[P1-02]`. The check runs once per sign-in and once per claim re-read; skipping a two-hundredth of a millisecond there would be a saving nobody asked for |
| D35 | Sessions carry the roles and teams they were issued with, and are re-issued on privilege change (§9) | The session row keeps the login-time snapshot for the audit trail, but **every request resolves roles and teams live** from the principal directory | Re-issue on privilege change needs something to notice the change; resolving live means an admin's edit takes effect on the next request rather than on the next sign-in, with no invalidation machinery to get wrong. The OIDC claim re-read is what makes the *directory* current; this is what makes the *session* current |
| D36 | `PROD_ADMIN_SUB_KEY`-style fallbacks are the failure mode to avoid; every value is explicit (§11) | `AUTH_PROVIDERS` is a required, ordered, closed list. There is no default, and `dev` has to be named to exist | The one place a fallback would be catastrophic. A deployment that forgets the variable does not quietly get the bypass — it does not boot, and the error names the variable and its three legal values |
| D37 | Deployment is "one artifact per deployable for all environments, with per-environment settings" and two build pipelines (§13) | Exactly that, with GitHub Actions and GHCR rather than the unnamed CI of the design, and a `docker-compose.yml` as the reference deployment instead of a chart | The design does not name a CI system. Compose rather than Kubernetes because a chart nobody has run against a cluster is an untested artifact; the environment contract both need is the same, and it is documented |

---

## 3. Shape

Nothing moves between the planes. The control plane grows a second inbound path — `/auth/*`, which
is browser navigation rather than API — and one new outbound dependency, the identity provider,
which goes through the same egress allowlist and the same trust anchors as every other outbound
fetch.

```
                Browser (React SPA)                  Keycloak / any OIDC provider
                   │        │                                    ▲
       /api/…  ────┘        └──── /auth/login, /auth/callback     │ discovery · token · JWKS
       (fetch, cookie)            (top-level navigation, 302)     │ revocation · end session
        ┌───────────────────────────▼──────────────────────────────┼────────────┐
        │ CONTROL PLANE — Bun/TS                        :8080      │            │
        │  AUTH: providers · sessions · principals · teams ────────┘            │
        │  resources · revisions · policy · promotion · catalog · playground    │
        │  telemetry · quota · certificates · trust anchors · dashboard         │
        │  POST /api/gateway/poll   config ⇄ telemetry                          │
        │                             bun:sqlite  ${DB_PATH}                    │
        └───┬──────────────┬──────────────┬──────────────┬──────────────────────┘
        ┌───▼────┐    ┌────▼───┐    ┌─────▼──┐    ┌──────▼─┐
        │ DP     │    │ DP     │    │ DP     │    │ DP     │   the data plane knows nothing
        │ dev-1  │    │ dev-2  │    │ test-1 │    │ prod-1 │   about people: its only identity
        └────────┘    └────────┘    └────────┘    └────────┘   is its own instance token
```

The data plane is untouched by G1. It authenticates gateway instances with a bearer token and
callers with a subscription key or an `auth.*` policy unit; neither is a person. This is worth
stating because it is what makes the two images independent, which is G2.

### Layout — what is added

```
shared/
  jwt.ts              JWKS cache + JWT signature verification, extracted from the data plane's
                      identity.ts so there is one implementation of the security-critical part
control-plane/src/
  schema-005.sql      migration 5 — principal, auth_flow, session and membership columns
  principals.ts       the directory: resolve, create, disable, role, membership + provenance
  auth-local.ts       password hashing, policy, verification, lockout, bootstrap
  auth-oidc.ts        discovery, PKCE, authorize URL, code exchange, refresh, revoke, claims
  claims.ts           token claims → roles and teams, through team.source_group
  api/auth.ts         /api/auth/* and /auth/* — the provider-agnostic sign-in surface
  api/users.ts        /api/users/*, /api/teams/*, /api/my/sessions
ui/src/views/
  LoginView.tsx       one card per enabled provider
  AccountView.tsx     who am I · my teams · my sessions · change my password
  UsersView.tsx       the directory, and one user
  TeamsView.tsx       teams, their source groups and their members
docker/
  control-plane.Dockerfile   ui build + control plane, non-root, healthcheck
  data-plane.Dockerfile      gateway only, non-root, healthcheck
  entrypoint notes           none — both images exec bun directly
.github/workflows/
  ci.yml              typecheck + both suites, on every push and pull request
  images.yml          build, smoke-test and publish both images
  perf.yml            unchanged
docker-compose.yml    the reference deployment
.dockerignore
docs/
  design.md           G3 — the functional design document
  deployment.md       the environment contract, the images, and what a chart would need
  walkthrough.md      the by-hand journey checklist and the curl tour, moved out of the README
scripts/
  mint-instance.ts    a gateway instance token from the command line, for headless deployment
test/
  auth-local.test.ts  auth-oidc.test.ts  users.test.ts  sessions.test.ts
ui/test/
  auth.test.tsx       the sign-in card per provider, the forced-change gate, the user list
```

---

## 4. Data model changes — `schema-005.sql`

Additive. Nothing is rebuilt, so this migration needs no `foreignKeysOff` and cannot repeat
`[V1-02]`.

### `principal` — every human the portal knows

```sql
CREATE TABLE principal (
  id            TEXT PRIMARY KEY,
  provider      TEXT NOT NULL,              -- 'local' | 'oidc' | 'dev'
  subject       TEXT NOT NULL,              -- local: the username; oidc: `sub`; dev: the dev id
  username      TEXT NOT NULL,              -- what a person types, or `preferred_username`
  email         TEXT,
  display_name  TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'member',   -- authored here: 'member' | 'admin'
  idp_admin     INTEGER NOT NULL DEFAULT 0,       -- last seen from the IdP's role claim
  password_hash TEXT,                       -- local only; argon2id, never anything else
  must_change   INTEGER NOT NULL DEFAULT 0,
  disabled_at   TEXT,
  failed_count  INTEGER NOT NULL DEFAULT 0,
  locked_until  TEXT,
  created_at    TEXT NOT NULL,
  created_by    TEXT NOT NULL,
  last_login_at TEXT,
  UNIQUE (provider, subject)
);
-- Partial, and deliberately not `(provider, username)` [P1-12]: a local username is what a person
-- types, so it has to be unique. An OIDC `preferred_username` is mutable, is not guaranteed unique
-- across a realm's lifetime, and arrives from a directory that owns its uniqueness — indexing it
-- would turn a legitimate rename in Keycloak into a 500 on that user's next sign-in.
CREATE UNIQUE INDEX principal_local_username ON principal(username) WHERE provider = 'local';
```

Five decisions worth recording.

- **`provider` is part of the identity, not an attribute of it.** `alice` from Keycloak and `alice`
  in the local directory are two principals with two ids, and `UNIQUE (provider, subject)` says so.
  Collapsing them on email would mean a mail-address change in one directory silently takes over an
  account in the other.
- **`id` is what every existing table already stores.** `membership.user_id`, `session.user_id`,
  `audit.actor`, `revision.created_by`, `release.released_by`, `playground_call.user_id` and
  `policy_entry.updated_by` all hold a bare user id today. The migration backfills one
  `provider='dev'` principal **per distinct `membership.user_id`** rather than three hard-coded
  names `[P1-20]`, so on any real v4 database — where `seedBaseline` was the only writer of that
  column — ownership and authorship survive with nothing rewritten and no history changing meaning
  `[P1-04]`.
- **New principals get an opaque `usr_…` id**, so renaming a person never rewrites their history.
  The cost is that `audit.actor` and `revision.created_by` stop being readable at a glance, which
  is `[P2-03]`: one helper resolves a set of ids to display names in a single query, and the audit
  log, the revision list and the release history all use it.
- **Two admin columns, not one.** `role` is what an admin set here; `idp_admin` is what the token
  last said. `isAdmin` is the OR of them. One column would mean either an IdP demotion silently
  survives as a local grant, or a local grant is wiped by the next claim re-read.
- **`password_hash` is nullable and only ever argon2id.** An OIDC or dev principal has none, and a
  local one that has none cannot sign in — which is what a principal created before its password is
  set looks like.

### `session` — five columns

```sql
ALTER TABLE session ADD COLUMN provider          TEXT NOT NULL DEFAULT 'dev';
ALTER TABLE session ADD COLUMN refresh_token_enc TEXT;   -- KEK-encrypted, OIDC only
ALTER TABLE session ADD COLUMN claims_refreshed_at TEXT; -- when the IdP last confirmed the claims
ALTER TABLE session ADD COLUMN user_agent        TEXT;   -- truncated; the "my sessions" screen
ALTER TABLE session ADD COLUMN last_seen_at      TEXT;
```

The refresh token is the one long-lived secret a session holds, so it goes through
`control-plane/src/crypto.ts`'s envelope — the same one that protects subscription keys and
certificate private keys `[P1-10]`. That is not decoration: the KEK lives outside the database
file, so a database taken without it yields no usable IdP credential, and a KEK rotation covers
sessions without a second mechanism.

The access token is **not** stored. Nothing downstream of the control plane takes a user's token:
gateways authenticate with their own instance tokens, and the database is local. Keeping an access
token we never present would be a secret held for no reason `[P1-06]`.

`roles_json` and `teams_json` stay, and stay NOT NULL, but become the **login-time snapshot** —
what the directory said when this session started. Authorization reads the directory live (D35).

### `membership` — provenance

```sql
ALTER TABLE membership ADD COLUMN source     TEXT NOT NULL DEFAULT 'local';
ALTER TABLE membership ADD COLUMN granted_by TEXT;
ALTER TABLE membership ADD COLUMN granted_at TEXT;
```

Existing rows read as `local`, which is what they are: `seedBaseline` authored them. The claim sync
deletes and re-inserts only `source = 'idp'` rows for the principal it is syncing, so an admin's
grant survives a directory that has never heard of the team.

### `auth_flow` — one in-flight sign-in

```sql
CREATE TABLE auth_flow (
  state         TEXT PRIMARY KEY,
  code_verifier TEXT NOT NULL,
  nonce         TEXT NOT NULL,
  return_to     TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  expires_at    TEXT NOT NULL
);
```

Server-side rather than in a cookie, so a mid-sign-in control-plane restart does not strand the
user, and so the verifier is never in a place a browser extension can read. Deleted on use.

There is no `redirect_uri` column `[P1-16]`: there is one configured value, the authorization
request and the token exchange both use it, and per-host resolution is out of scope.

### What prunes

Two new bounds, both added to the existing `prune` job, because "every bound has a defined
behaviour past it" is a rule this project keeps and both of these otherwise grow forever `[P1-19]`:

| | Bound | Past it |
|---|---|---|
| `auth_flow` | `expires_at` (two minutes after the row is written) | deleted — an abandoned sign-in leaves nothing |
| `session` | revoked or expired more than `SESSION_PRUNE_AFTER_DAYS` ago (default 30) | deleted. Thirty days rather than immediately, because "what signed in last week" is a question an operator gets asked |

### `team` — nothing

`team.source_group` already exists and already means "the IdP group that maps to this team". v5 is
the first version to read it.

---

## 5. Authentication (G1)

### 5.1 One switch, three providers, no default

`AUTH_PROVIDERS` is a required, ordered, comma-separated subset of `local,oidc,dev`. Order is the
order the sign-in screen shows them; the first is the one focused. Boot fails, naming the variable,
when it is missing, empty, or contains a word that is not one of the three (D36).

Two combination rules, both enforced at boot:

- **`dev` cannot be combined with `oidc`.** A bypass beside a real directory is the worst of both:
  it looks configured and it is not, and the reference implementation's history in
  `existing-ui-for-inspiration/` records exactly this failure — a portal running against production
  with every gate short-circuited because one mode check said `!== 'oidc'`.
- **`dev` is announced.** With `dev` enabled the control plane logs one line at boot saying that
  anybody may become any of the three development users without a password.

Enabling `local` requires either an existing local principal or `BOOTSTRAP_ADMIN_USERNAME` +
`BOOTSTRAP_ADMIN_PASSWORD`; enabling `oidc` requires `OIDC_ISSUER`, `OIDC_CLIENT_ID` and
`OIDC_REDIRECT_URI`. Both are checked at boot, and both errors name the variables.

### 5.2 What the browser is told before it signs in

Today `GET /api/meta` is public, and it carries the environment chain, the policy-unit catalogue,
the three development users, the public URL **and every gateway URL the playground may use**. An
anonymous caller learning the internal hostnames of a production gateway fleet is a leak, and it
exists only because the sign-in screen needed the development user list `[P1-01]`.

v5 splits it:

```
GET /api/auth/providers   public    { providers: [...], oidc: {label} | null, devUsers: [...] }
GET /api/meta             session   everything else, unchanged
```

`devUsers` is empty unless the `dev` provider is enabled. The SPA fetches `/api/me` and
`/api/auth/providers` at boot and `/api/meta` only once there is a user.

### 5.3 The local provider

```
POST /api/auth/login      public    { username, password } -> 204 + session cookie
POST /api/auth/password   session   { currentPassword, newPassword } -> 204
```

- **argon2id via `Bun.password`**, at OWASP's baseline — `memoryCost: 19456`, `timeCost: 2`.
  Measured at 18 ms per hash and per verify on the development machine, which is the number the
  lockout is sized against `[P1-03]`.
- **Password policy**: at least `LOCAL_PASSWORD_MIN_LEN` characters (default 12) and at most 200,
  and not equal to the username or the email. The ceiling is not cosmetic: argon2 cost is linear in
  nothing the caller controls except length, but an unbounded body would still be hashed.
- **Lockout**: `LOCAL_LOCKOUT_THRESHOLD` consecutive failures (default 10) locks the principal for
  `LOCAL_LOCKOUT_MINUTES` (default 15). Cleared by a success or by an admin reset. At 18 ms a
  verify, 10 attempts per 15 minutes is 40 guesses an hour against a 12-character minimum.
- **A wrong username and a wrong password are indistinguishable.** The same 401, the same message,
  and a verify against a fixed dummy hash when the username is unknown, so the response time does
  not answer a question the status code refuses to.
- **A global rate limit on the endpoint, not just a per-principal lockout** `[P1-05]`.
  `LOCAL_LOGIN_RATE_PER_MIN` (default 60) across all callers, answering `429` with `Retry-After`.
  Two things need it. A spray attack — one password, a thousand usernames — never trips a
  per-principal counter. And at 17.7 ms a verify `[P1-03]`, an unauthenticated caller can saturate
  the control plane's CPU with no credential at all; the dummy-hash rule above makes that *worse*
  by guaranteeing a hash per request. The limiter is what bounds both, and it is in front of the
  hash rather than behind it.
- **A locked or disabled principal gets the same 401**, because "this account exists but is locked"
  is the enumeration answer with extra steps. The audit row is where the difference is recorded.
- **`must_change` blocks everything.** A session whose principal has `must_change = 1` is refused
  on every route except `GET /api/me`, `POST /api/auth/password` and `POST /api/auth/logout`, with
  `403` and a `fix` pointing at the change-password screen. The SPA renders that screen and nothing
  else, so the forced change is a gate rather than a suggestion.
- **A password change re-hashes and revokes every *other* session** of that principal. The one
  making the change survives, so the user is not signed out by their own success.
- **The bootstrap admin** is created at boot when `local` is enabled and no local principal exists:
  role `admin`, `must_change = 1`, `created_by = 'bootstrap'`, and one audit row. It is created
  once — the check is "no local principal", not "no principal with this username", so deleting the
  bootstrap admin does not resurrect it and rotating the environment variable does not create a
  second one.

### 5.4 The OIDC provider

Two browser-facing routes, deliberately **not** under `/api`: they are top-level navigations that
answer with `302`, and a `fetch` wrapper that follows redirects into an IdP is a bug waiting to
happen.

```
GET /auth/login?return=/some/path    302 -> the IdP's authorization endpoint
GET /auth/callback?code=&state=      302 -> `return`, with a session cookie
```

`server.ts` gains `/auth` in its list of non-static prefixes, and the Vite dev server proxies
`/auth/*` alongside `/api/*`.

**Sign-in start.** Fetch and cache the discovery document. Mint a PKCE pair (32 random bytes
base64url, `S256`), a `state` and a `nonce`. Write them to `auth_flow` with a two-minute expiry,
set a cookie holding the `state`, and redirect with `response_type=code`, `client_id`,
`redirect_uri`, `scope`, `state`, `nonce`, `code_challenge`, `code_challenge_method=S256`.

The state cookie is `HttpOnly`, `SameSite=Lax`, `Secure` when `PUBLIC_URL` is https,
`Max-Age=120`, and **`Path=/auth/callback`** `[P1-09]` — it is needed on exactly one request, and
scoping it to `/` would send it with every request for its whole life. `SameSite=Lax` is what lets
it ride the IdP's top-level GET redirect back.

`return` is accepted only when it starts with a single `/`, does not start with `//` or `/\`, and
contains no control characters `[P1-08]`. The backslash case matters: some browsers normalise a
leading `/\` to `//`, which makes `/\evil.test` an off-site redirect.

**Callback.** In this order, because each step is only meaningful if the previous one passed:

1. `error` in the query → `400`, quoting the IdP's own `error_description`. Most "callback broken"
   reports are a mis-registered `redirect_uri`, and the IdP already says so.
2. `state` present, matching the cookie, and present in `auth_flow` → otherwise `400`. The cookie
   binding is what stops login-CSRF: an attacker who starts a flow and feeds a victim their own
   `code` has no way to put their `state` in the victim's browser.
3. Exchange the code with `grant_type=authorization_code` and the stored `code_verifier`. Delete
   the `auth_flow` row before the exchange, so a replayed callback cannot exchange twice.
4. Verify the `id_token`: signature against the issuer's JWKS, `iss` equal to the discovery
   document's issuer, `aud` containing the client id, `exp`/`nbf` within a 60-second skew, and
   `nonce` equal to the one in `auth_flow` (D34).
5. Resolve the principal from `(provider='oidc', subject=sub)`. Create it if
   `OIDC_AUTO_CREATE=1` and it does not exist; refuse with `403` if auto-create is off, naming the
   `sub` so an admin can pre-create it.
6. Update `username`, `email`, `display_name`, `idp_admin` and the `idp` memberships from the
   claims (§5.5), then create the session, storing the refresh token encrypted.
7. `302` to `return`.

**Claim re-read.** A session older than `OIDC_CLAIMS_REFRESH_SEC` (default 300) since
`claims_refreshed_at` triggers a `refresh_token` grant before the route handler runs. What comes
back is a new `id_token`, verified the same way, and its claims are re-applied. This is how design
§9's "a group removal in the IdP takes effect at the next refresh" happens.

It lives in `dispatch`, as `await refreshClaimsIfDue(app, sessionId)` **before** `sessionUser`
`[P1-13]`, which stays synchronous. Putting it inside `sessionUser` would make every route's
authentication path async and touch every call site for no gain. It is skipped for `/auth/*` and
`/api/auth/*`, which would otherwise recurse, and for `instance`-authenticated routes, which have
no session at all.

- **Serialised per session** through an in-process `Map<sessionId, Promise>`. Keycloak rotates the
  refresh token on every use, so two concurrent requests on one session would race and the loser
  would get `invalid_grant` — the reference implementation's `refresh-middleware.ts` records this
  and the fix.
- **Any 4xx from the token endpoint ends the session**: `401` with `code: session_expired`, the
  session revoked, the cookie cleared. `invalid_grant` is the common case, but Keycloak also
  answers `invalid_token` for "issued before the client session started", and treating that as
  transient produces a permanent 503 loop.
- **A 5xx or a network failure leaves the session alone** and answers `503` with
  `code: auth_backend_unavailable`. The next request retries. A provider outage must not sign the
  whole estate out.
- **No refresh token** (a provider that does not issue one, or a scope without `offline_access`)
  means the claims are never re-read, and `GET /api/me` says so in one sentence. Silently running
  on eight-hour-old claims would be worse than admitting it.

**Sign-out.** `POST /api/auth/logout` revokes the local session, posts the refresh token to the
IdP's `revocation_endpoint` if it has one (fire and forget — the local revocation is the
authoritative step), clears the cookie, and returns `{ ok: true, endSessionUrl }`. `endSessionUrl`
is the discovery document's `end_session_endpoint` with `post_logout_redirect_uri`, and is non-null
only when `OIDC_END_SESSION=1`; the SPA navigates to it when it is there. Off by default because
single logout also signs the user out of every other application behind that IdP, which is a
deployment decision and not ours.

**Egress and trust.** Every fetch to the IdP goes through design §5.3's allowlist and G4's trust
anchors, like every other outbound call — so an internal Keycloak behind an internal CA is
reachable without turning verification off, which is G4 paying for itself.

The check runs in two places, and deliberately not in one `[P1-15]`:

- **At boot, on the `OIDC_ISSUER` string**, with no network call. A misconfigured allowlist is a
  startup failure naming the host, not a mystery at the first sign-in.
- **At first discovery, on every endpoint the document names.** A discovery document may point
  `token_endpoint` or `jwks_uri` at a different host than the issuer, and an allowlist that only
  ever saw the issuer would not have covered it. A refused endpoint fails the sign-in with the URL
  and the rule.

Discovery itself is **not** fetched at boot. Doing so would make the control plane refuse to start
while Keycloak restarts — an availability coupling nobody asked for, and the opposite of the
fail-static discipline the data plane has.

### 5.5 Claims → roles and teams

One function, `claimsToIdentity`, so the OIDC callback and the claim re-read cannot disagree.

| From | Claim | Configured by | Result |
|---|---|---|---|
| Display name | `name`, else `preferred_username`, else `email`, else `sub` | — | `principal.display_name` |
| Username | `preferred_username`, else `sub` | — | `principal.username` |
| Email | `email` | — | `principal.email` |
| Admin | the role list at `OIDC_ROLE_CLAIM` contains `OIDC_ADMIN_ROLE` | `realm_access.roles` / `apim-admin` | `principal.idp_admin` |
| Teams | each value of `OIDC_GROUP_CLAIM` matched against `team.source_group` | `groups` | `membership` rows with `source='idp'` |

- **`OIDC_ROLE_CLAIM` is a dotted path**, because Keycloak's realm roles live at
  `realm_access.roles` rather than at the top level. `groups` is flat for Keycloak's group mapper
  but the same path reader handles both.
- **Group values are matched, not created.** A group with no `team.source_group` maps to nothing and
  is reported: `GET /api/me` carries `unmappedGroups`, and the Teams screen shows them with a
  one-click "create a team from this group". A directory that invents teams would let anybody with
  an IdP group create an owner scope.
- **Matching is case-insensitive and trims**, because directory exports are not careful, and
  Keycloak group paths arrive as `/apim/orders` — the leading segments are stripped, and both the
  full path and the last segment are tried.
- **A user in no mapped group has no teams**, and that is a legitimate state: they can browse the
  catalog, see the dashboard's "start here" panel, and every owner and consumer action is disabled
  with the reason, which is G5's existing rule doing its job rather than a new one.

### 5.6 Sessions, CSRF and the things that stay

- **Idle and absolute lifetime** stay as they are: `SESSION_IDLE_MIN` (60) and
  `SESSION_LIFETIME_HOURS` (8), both now configurable, both already enforced.
- **CSRF stays an `Origin` check** on every mutating cookie-authenticated request, plus
  `SameSite=Lax`. Design §9 asks for exactly this, the API is same-origin, and it is already
  tested. A double-submit token would add a second mechanism protecting the same thing. The two new
  `GET /auth/*` routes are navigations, so nothing changes there.
- **The session cookie gets `Secure` when `PUBLIC_URL` is https**, as it already does, and the new
  `auth_flow` cookie follows the same rule.
- **`GET /api/my/sessions`** lists the caller's own sessions with the provider, when each started,
  when it was last used and a truncated user agent, marking the current one.
  `DELETE /api/my/sessions/:id` and `POST /api/my/sessions/revoke-all` (which spares the current
  one) are the user's own controls; `DELETE /api/users/:id/sessions` is the admin's.

---

## 6. Authorization (G1)

`can(user, teamId) = user.isAdmin || teamId ∈ user.teams` is unchanged, and stays the only
authorization function. Three things around it change.

- **`isAdmin` is computed once, in the directory**: `role = 'admin' || idp_admin`. Nothing else
  reads either column.
- **The admin carve-outs become one function.** There are **seven** today `[P1-24]`: five inline
  `if (!user.isAdmin) throw forbidden(…)` sites — the audit log, the rendered gateway config,
  `skipChain`, instance minting and instance revocation — and two local helpers doing the same
  thing under two names, in `api/trust.ts` and `api/policy.ts`. All seven become
  `requireAdmin(ctx, "…")` in `router.ts`. Behaviour is identical; this is about being able to
  enumerate the carve-outs when somebody asks what an admin can do, and about the two duplicate
  helpers not becoming three.
- **Two self-protection rules**, enforced in the directory rather than in the endpoints:
  the last enabled admin cannot be disabled or demoted, and a principal cannot disable, demote or
  delete itself. The first stops a lockout; the second stops an accident. Both answer `409` with
  the reason, because they are conflicts with the state of the world rather than refusals of
  permission.

Everything that already carries a `capabilities` array keeps carrying it, computed the same way, so
the SPA still renders controls from data.

---

## 7. User and team management (G1)

```
GET    /api/users                     admin   ?q=&provider=&limit=&cursor=
POST   /api/users                     admin   create a local principal
GET    /api/users/:id                 admin   the principal, its teams with provenance, its sessions
PATCH  /api/users/:id                 admin   displayName · email · role · disabled
POST   /api/users/:id/password        admin   set a password, must_change = 1
PUT    /api/users/:id/teams/:teamId   admin   grant local membership
DELETE /api/users/:id/teams/:teamId   admin   revoke local membership
DELETE /api/users/:id/sessions        admin   force sign-out

GET    /api/teams                     session  id · name · members · mine (· sourceGroup, admin)
POST   /api/teams                     admin    name · sourceGroup
GET    /api/teams/:id                 session  members with provenance; admin-only for other teams
PATCH  /api/teams/:id                 admin    name · sourceGroup
DELETE /api/teams/:id                 admin    only when it owns nothing
```

Rules that are not obvious from the shapes:

- **Only a `local` principal can be created, given a password, renamed or have its email set here.**
  A `PATCH` that would edit an OIDC principal's `display_name` is `409` naming the directory as the
  owner of that field — otherwise the next claim re-read would silently undo the edit, which looks
  like the portal losing writes.
- **`role` and `disabled` are editable on any provider.** Both are decisions about this portal, not
  facts about the directory. Disabling an OIDC principal refuses its sessions immediately and
  refuses its next sign-in, which is the local kill switch a deployment needs when the IdP's own
  offboarding is slower than the incident.
- **Demoting an IdP admin is a write that reports success and changes nothing, so it says so**
  `[P1-17]`. `isAdmin` is `role = 'admin' || idp_admin`, so setting `role` to `member` on a
  principal whose token carries `apim-admin` leaves them an admin. The `PATCH` still succeeds — the
  locally authored role is a real fact and it is now `member` — and the response carries the
  **effective** role plus `adminFrom: "idp"`. The screen renders "admin, from the identity
  provider", disables the local control with that as the reason, and points at the two things that
  do work: removing the role in Keycloak, or disabling the principal here.
- **`sourceGroup` is admin-only** `[P1-18]`. Team names are already a discovery surface, but which
  IdP group grants a team is reconnaissance — it tells any signed-in user exactly which group to
  get themselves added to in order to own another team's APIs. The field is absent from the
  response for non-admins rather than blanked.
- **`DELETE /api/teams/:id` requires the team to own nothing** — no resources, products,
  applications or subscriptions — and answers `409` listing what it still owns and how many.
  Cascading a team delete through the resource graph would delete published APIs from a screen
  about people.
- **Membership revocation is not deletion of the person.** A revoked membership is a deleted
  `membership` row; the principal stays, its audit history stays, and its authored objects stay
  owned by the team.
- **There is no user deletion.** `audit.actor`, `revision.created_by` and `release.released_by`
  reference a principal by id, and the audit table is append-only by trigger. `disabled_at` is the
  end state, and the users list can filter on it. Named in the design document rather than left for
  somebody to discover.

- **Ids stop being readable, so one helper makes them readable again** `[P2-03]`. `audit.actor`,
  `revision.created_by` and `release.released_by` show a bare id today, which was legible only
  because the ids happened to be `alice` and `pavel`. New principals carry `usr_…`. One helper
  resolves a set of ids to display names in a single query, and those three surfaces use it — the
  alternative is a UI that got less readable as a result of a feature about users.

Every one of these writes an audit row: `user.create`, `user.role`, `user.disable`, `user.enable`,
`user.password-reset`, `user.team-grant`, `user.team-revoke`, `team.create`, `team.update`,
`team.delete`, `session.revoke`, `auth.login`, `auth.login-failed`, `auth.logout`. The failed-login
row carries the username as presented and no password material, which is the one place a
non-existent username is recorded — deliberately, because "somebody is guessing usernames" is the
signal an operator needs.

---

## 8. The UI (G1)

Everything in v4 §9.4 still holds and is still tested the same way. What is added:

**Sign-in** (`LoginView`) — one card per enabled provider, in `AUTH_PROVIDERS` order. The OIDC card
is a single button that navigates (`window.location`), never a `fetch`. The local card is a
username and password form that shows the server's own refusal. The dev card is the existing three
buttons, under a warning that says what the bypass is. With one provider there is one card and no
chooser, because a control with one option is a question with one answer.

**The forced-change gate** — when `me.mustChangePassword` is true the shell renders only the
change-password card. No sidebar, no navigation, no way around it.

The **boot order matters and is part of the plan** `[P1-14]`. `App` today fetches `/api/me` and
`/api/meta` together and renders a fatal error when either fails. With the gate refusing
`/api/meta`, a user who must change their password would see "the portal could not reach its own
API" instead of the card. So: resolve `/api/me`, branch on `mustChangePassword` **before** any
other response is consulted, and fetch `/api/meta` only past that branch.

**Account** (`/account`, linked from the sidebar footer) — display name, username, email, provider,
role, teams with where each came from, change password (local only, absent for others rather than
disabled — there is nothing here to change), and the session list with per-session revoke and
"sign out everywhere".

**Users** (`/users`, admin) — the directory with a search box and a provider filter. Each row: name,
username, provider chip, role chip, team count, last sign-in, and a disabled chip when disabled.
The empty state on a fresh local deployment names the next action. `/users/:id` is the detail:
role, teams with provenance and a grant control, password reset, sessions, and the two destructive
acts — disable and force-sign-out — behind `DangerZone` with the username typed back.

**Teams** (`/teams`, admin) — teams with their source groups and member counts, the unmapped-group
list with "create a team from this group", and per-team members showing `from group …` or
`granted by … on …`. Delete behind `DangerZone`, disabled with the reason when the team owns
something.

**Glossary** additions, one sentence each: `role`, `admin`, `member`, `identity provider`,
`source group`, `session`, `local account`. The existing `ui/test/hygiene.test.ts` rule that every
`<Term>` in a view resolves is what keeps them honest.

**The hygiene rules will fire on four of the new call sites, and each is a decision** `[P1-25]`.
The rule refuses a `DELETE` whose nearest preceding handler is not an `onConfirm`:

| Call site | Verdict |
|---|---|
| `DELETE /api/my/sessions/:id` | exempt, with the reason — signing one of your own devices out is not destructive, and demanding a typed confirmation for it teaches people to type through confirmations |
| `POST /api/my/sessions/revoke-all` | exempt — not a `DELETE`, and the same reasoning |
| `DELETE /api/users/:id/teams/:teamId` | `DangerZone` — it removes someone's access to everything a team owns |
| `DELETE /api/teams/:id` | `DangerZone`, and disabled with the reason when the team still owns something |

**Sidebar** — `Users` and `Teams` join the `operate` section, admin-only, so a non-admin does not
see them; a non-admin who deep-links gets the screen with every control disabled and one line
naming who can change it, which is the existing rule for `operate`.

---

## 9. Deployment (G2)

### 9.1 Two images

Both from **`oven/bun:1.4.0-alpine`** — pinned exactly, not to a floating minor `[P1-21]`. The
repository pins `1.4.0` everywhere else, including `perf.yml`'s `setup-bun`, and a floating tag in
a Dockerfile is how a reproducible build stops being one. The version now appears in three places,
all named in the deployment document's upgrade section.

Both non-root, both reading everything from the environment.

**`docker/control-plane.Dockerfile`** — two stages. Stage one runs `bun install` in `ui/` and
`bun run build`, producing `ui/dist`. Stage two copies `control-plane/`, `shared/`, `package.json`,
`bunfig.toml`, `tsconfig.json` and the built `ui/dist`, creates `/data` owned by the runtime user,
and:

```
ENV DB_PATH=/data/apim.sqlite  KEK_PATH=/data/kek.key  UI_DIST=/app/ui/dist
ENV INTEGRATIONS_FILE=/etc/apim/integrations.json  TARGETS_FILE=/etc/apim/targets.json
EXPOSE 8080
VOLUME /data
HEALTHCHECK CMD bun -e "…fetch /healthz…"
USER apim
CMD ["bun", "run", "control-plane/src/server.ts"]
```

The two JSON documents are **not** baked in. The repository's copies allow egress to loopback so
the local stack works, and an image carrying that as its default would be a production deployment
with a hole in it. They are mounted at `/etc/apim`, and a missing file is the existing boot failure
that names the variable. The repository copies are available in the image at
`/app/config.sample/`, so a first deployment has something to copy.

**`docker/data-plane.Dockerfile`** — one stage. `data-plane/`, `shared/` and the manifests; no UI,
no `control-plane/`, no SQLite. `GATEWAY_TOKEN_FILE` rather than `GATEWAY_TOKEN` in the documented
path, because a token in an environment variable is visible to every process in the container and
`docker inspect` prints it. `GATEWAY_ARTIFACT_CACHE` and `GATEWAY_CONFIG_CACHE` point into a
per-instance volume — the artifact cache holds compiled validators and certificate material written
`0600` (D22), and two instances sharing one directory would race on file names.

It also sets **both** concurrency values as `ENV`, at the numbers `scripts/seed.ts` writes
`[P1-22]`. This is not tidiness: v3 made the gateway refuse to start unless
`BUN_CONFIG_MAX_HTTP_REQUESTS ≥ MAX_CONCURRENT_REQUESTS`, precisely to catch the pairing an image
that sets neither would inherit — the runtime's default outbound queue against the gateway's
default ceiling. The compose file sets `ulimits.nofile` to four times the ceiling, because each
held request keeps a client socket and an upstream socket.

`.dockerignore` excludes `.git`, `node_modules`, `ui/node_modules`, `ui/dist`, `docs`, `test`,
`ui/test`, `tools`, `existing-ui-for-inspiration` — and `.data` and `*.sqlite*`, which are the two
that matter `[P1-23]`. A developer's `.data/apim.sqlite` holds KEK-encrypted subscription keys and
certificate private keys, and `.data/kek.key` sitting beside it is the key. Copying the build
context wholesale into a published image publishes both. `scripts/` is **not** excluded, because
`scripts/mint-instance.ts` has to run in the image.

### 9.2 The reference deployment

`docker-compose.yml` brings up the control plane, one DEV gateway and the petstore backend, on
named volumes, with `./config` mounted read-only at `/etc/apim`. It defaults to
`AUTH_PROVIDERS=local` with a bootstrap admin from `.env`, because a compose file that comes up in
`dev` mode is a compose file somebody will deploy.

The gateway needs an instance token, and only the control plane can mint one. The compose file does
not pretend otherwise — there is no enrolment secret and no shared bearer:

```
docker compose up -d control-plane
docker compose run --rm control-plane bun run scripts/mint-instance.ts dev dev-1 > .secrets/dev-1
docker compose up -d gateway-dev-1
```

`scripts/mint-instance.ts` is the same mint the Gateways screen performs — capped per target,
audited, printed once — for deployments with no browser. The Gateways screen is the other way, and
the deployment document says both.

**One control plane.** Design §13's single SQLite writer means the control-plane service is not
scalable horizontally, and the compose file says so in a comment where a `deploy.replicas` would
go. The gateway service is, and the document shows how.

### 9.3 GitHub Actions

| Workflow | Trigger | Does |
|---|---|---|
| `ci.yml` | push, pull request | `bun install`, `bun run typecheck`, `bun test`, `bun run test:ui` |
| `images.yml` | push to `main`, tags `v*`, manual | buildx both images for `linux/amd64` and `linux/arm64`, smoke-test the control-plane image, push to GHCR tagged with the branch, the short SHA, and the semver on a tag |
| `perf.yml` | schedule, manual | unchanged |

`ci.yml` runs the performance guardrail that is already inside `bun test`, which is the third of
the three ways the load suite is used regularly. It does **not** run the full load harness: a
loopback load run on shared CI hardware is too noisy to gate a pull request on, and treating it as
a gate teaches people to ignore it — which is what `perf.yml` already says.

The **smoke test** is the part that makes `images.yml` worth having. It runs the built control-plane
image with `AUTH_PROVIDERS=local` and a bootstrap admin, waits for `/healthz`, signs in with the
bootstrap credentials, asserts the forced-password-change gate answers, asserts `GET /api/meta` is
`401` without a cookie (which is what keeps `[P1-01]` closed), and asserts the container's
directory holds **exactly one** principal — which is what would catch a `.dockerignore` regression
that shipped a developer's database `[P1-23]`. Building an image nobody has started proves that the
`COPY` lines are spelled right and nothing else.

Images are built with provenance attestations and an SBOM, and `ci.yml` and `images.yml` both pin
`oven-sh/setup-bun` to the same Bun version the repository is developed against.

---

## 10. The design document (G3)

`docs/design.md`, written for somebody who will read no source. Sections, in the order a reader
needs them:

1. **What this is** — one page: an API management platform in two tiers, why the split, and what
   "the control plane owns desired state, the gateway is a projection" means for someone using it.
2. **Who uses it** — the two hats (owner, consumer), the admin, and the one authorization rule.
3. **The objects** — API, revision, version, route, backend, policy, product, application,
   subscription, key, team, environment, gateway. One paragraph each, in the vocabulary the UI uses,
   with the relationships stated rather than drawn in SQL.
4. **The six journeys** — publish, promote, version, subscribe, call, operate — as processes: who
   starts them, what decisions they contain, what can refuse them and why, and what state they
   leave behind. This is the heart of the document.
5. **Signing in and being allowed** — the three providers, what each is for, how membership and
   roles arrive, and what a user with no team can and cannot do.
6. **Policy** — what a policy is, the closed vocabulary by group, the two-tier merge, per-operation
   overrides, and the ordering that is part of the contract. Functional: what each unit does to a
   request, not how it is compiled.
7. **Validation** — the three states, what "the absence of the unit is not off" means, what is
   always checked, and the rule that a validator a gateway cannot fetch never activates.
8. **Promotion and environments** — the chain, the gate, what is promoted and what is edited in
   place, and why divergence is reported rather than prevented.
9. **Traffic** — what a request meets on its way through a gateway, in order, and what each stage
   can answer. Rate limit and quota arithmetic, streaming, pools and breakers, and the three
   traffic numbers the product refuses to collapse into one.
10. **Trust and secrets** — subscription keys, client identities, backend TLS, the environment trust
    store, the exception ladder, and what is encrypted with what.
11. **Operating it** — the fleet, telemetry, the dashboard and its attention rules, audit,
    retention and every bound with a defined behaviour past it.
12. **Deploying it** — the two images, the one-writer constraint, what scales and what does not,
    backup and restore, and the environment contract by group.
13. **What is not here** — the out-of-scope list with the reason for each, and the deviations from
    this design that the implementation actually made, in one table.

No file names, no function names, no SQL, no TypeScript. Where a mechanism matters to a user it is
described as behaviour: "a revision freezes the first time it is released" rather than a column.
The plans stay where the implementation detail lives, and the document points at them once.

**It opens by saying which document it is** `[P1-26]`. `docs/greenfield-design.md` is the original
architecture proposal the product was built from — a target, written before any of it existed, and
still the source of the section numbers every plan cites. `docs/design.md` describes what the
application actually does today. Two files with "design" in the name is a trap unless each says
what the other is in its first paragraph, so both do, and the README's reading table gives each a
sentence.

---

## 11. The README (G4)

Short. What it keeps: what the application is, in three sentences and a feature table; what it
needs; three ways to run it (local Bun stack, compose, images); the two authentication modes with
the four environment variables each needs; how to run the tests; and a table of where to read more.

What moves rather than goes:

| From the README today | To |
|---|---|
| "Walk it by hand" and the six-journey checklist | [`docs/walkthrough.md`](walkthrough.md) |
| "Call it with curl", validation, SOAP, MCP, A2A tours | [`docs/walkthrough.md`](walkthrough.md) |
| "How it works" — the twenty-odd mechanism bullets | [`docs/design.md`](design.md), as prose in the section each belongs to |
| The configuration table and the six sized-from-traffic values | [`docs/deployment.md`](deployment.md) |
| "What is deliberately not here" and the deviation list | [`docs/design.md`](design.md) §13 |
| The tests-and-performance detail | trimmed to the four commands; the reasoning moves to `docs/deployment.md` |

`docs/deployment.md` is new and holds the environment contract in full, the two images, compose,
what a Kubernetes chart would have to get right, backup and restore, and the upgrade path.

---

## 12. Configuration

Design §11's rule holds: explicit values, no fallback chains, and a missing required value is a
startup failure that names the variable.

| | | |
|---|---|---|
| `AUTH_PROVIDERS` | **required** | ordered subset of `local,oidc,dev`; `dev` may not be combined with `oidc` |
| `SESSION_IDLE_MIN` / `SESSION_LIFETIME_HOURS` | 60 / 8 | already enforced, now configurable |
| `SESSION_PRUNE_AFTER_DAYS` | 30 | how long a revoked or expired session stays readable `[P1-19]` |
| `LOCAL_PASSWORD_MIN_LEN` | 12 | and a 200-character ceiling, so an unbounded body is not hashed |
| `LOCAL_LOCKOUT_THRESHOLD` / `LOCAL_LOCKOUT_MINUTES` | 10 / 15 | per principal |
| `LOCAL_LOGIN_RATE_PER_MIN` | 60 | across all callers, in front of the hash `[P1-05]` |
| `BOOTSTRAP_ADMIN_USERNAME` / `BOOTSTRAP_ADMIN_PASSWORD` | required with `local` and an empty directory | the created admin must change it at first sign-in |
| `OIDC_ISSUER` | required with `oidc` | discovery is `<issuer>/.well-known/openid-configuration`; must pass the egress allowlist |
| `OIDC_CLIENT_ID` | required with `oidc` | |
| `OIDC_CLIENT_SECRET` | optional | absent means a public PKCE client, which is the Keycloak default for this shape |
| `OIDC_REDIRECT_URI` | required with `oidc` | absolute; its path is the callback and must be registered on the client. **Its origin must equal `PUBLIC_URL`'s**, checked at boot `[P1-07]` — a callback that sets the session cookie on a different origin than the SPA is served from completes a whole sign-in and lands the user signed out, with no error anywhere |
| `OIDC_SCOPE` | `openid profile email offline_access` | without `offline_access` there is no refresh token and no claim re-read |
| `OIDC_ROLE_CLAIM` / `OIDC_ADMIN_ROLE` | `realm_access.roles` / `apim-admin` | dotted path |
| `OIDC_GROUP_CLAIM` | `groups` | dotted path; Keycloak group paths are matched whole and by last segment |
| `OIDC_CLAIMS_REFRESH_SEC` | 300 | how stale a session's roles and teams may be |
| `OIDC_AUTO_CREATE` | 1 | 0 means an admin pre-creates the principal and an unknown `sub` is refused |
| `OIDC_END_SESSION` | 0 | 1 redirects sign-out through the IdP, ending every session behind it |
| `OIDC_DISPLAY_NAME` | `Single sign-on` | the sign-in button's label |

`DEV_AUTH` is retired. A configuration that sets it and not `AUTH_PROVIDERS` fails at boot with a
message naming the replacement, because silently reading the old variable is how a bypass survives
an upgrade.

`UI_DEV_ORIGIN` stops being gated on the auth mode `[P2-01]`. Today it is only read when
`DEV_AUTH=1`, which coupled two unrelated things: whether a Vite dev server is running, and how
people sign in. It is now allowed as a second `Origin` whenever it is set — which is also the
honest shape, because a developer running `bun run dev:ui` against a `local`-provider control plane
is a normal thing to want.

---

## 13. Testing

Everything that passes today keeps passing. `test/helpers.ts` gains `authProviders` and keeps
`cp.login("alice")` working through the `dev` provider, so the 605 existing tests are unchanged.

| File | Covers |
|---|---|
| `test/auth-local.test.ts` | bootstrap admin creation and its once-only rule · sign-in · wrong password and unknown username being indistinguishable · policy refusals · lockout and its expiry · disabled · the forced-change gate on every route · change password revoking other sessions but not this one |
| `test/auth-oidc.test.ts` | a stub IdP in process, with a generated RSA key, serving discovery, authorize, token, JWKS and revocation · the full round trip · `state` mismatch, missing cookie, replayed callback · `nonce` mismatch · a signature from the wrong key · an expired `id_token` · JIT creation and `OIDC_AUTO_CREATE=0` · group → team mapping, including a Keycloak path and an unmapped group · role → admin · a claim re-read that removes a group taking effect on the next request · `invalid_grant` ending the session · a 503 from the IdP leaving it alone · concurrent requests refreshing once |
| `test/users.test.ts` | the management surface and its authorization · provenance on membership · an IdP membership survived by a local grant · editing an OIDC principal's directory-owned field refused · last-admin and self-service protections · team delete refused with what it owns |
| `test/sessions.test.ts` | idle and absolute expiry · the caller's own list · revoke one, revoke all sparing the current · admin force-sign-out · live role resolution (an admin's edit taking effect without a new sign-in) |
| `test/migration.test.ts` | extended: a real v4 database upgraded to v5, with the three development principals inserted and existing memberships reading as `local` |
| `ui/test/auth.test.tsx` | a card per provider and none for the ones that are off · the OIDC card navigating rather than fetching · the forced-change gate rendering nothing else · the users list, its provider and role chips, and its empty state's action · membership provenance rendered as a sentence |
| `.github/workflows/images.yml` | the smoke test is a test: it signs in to a built image and asserts the gate |

The stub IdP is the piece that makes G1 testable without a Keycloak. It is a `Bun.serve` in the
test file, so what is exercised is the real discovery fetch, the real token POST, the real JWKS
fetch and the real signature verification — not a mocked client.

---

## 14. Delivery order

Each step leaves the tree green: `bun test`, `bun run test:ui` and `bun run typecheck` all pass
before the next one starts.

1. **The plan is reviewed.** `v5-plan-review.md`, rounds until nothing is found.
2. **`shared/jwt.ts`** — extract the JWKS cache and the signature verification out of
   `data-plane/src/identity.ts`, which keeps its own claim checks. No behaviour change, and the
   existing JWT tests are the proof.
3. **Migration 5 and the directory** — `schema-005.sql`, `principals.ts`, live role and team
   resolution in `sessionUser`, the three development principals, `requireAdmin`, the two
   self-protection rules. `AUTH_PROVIDERS` replaces `DEV_AUTH`. `migration.test.ts` extended.
4. **The local provider** — `auth-local.ts`, the bootstrap admin, the sign-in and password
   endpoints, the forced-change gate. `auth-local.test.ts`.
5. **The OIDC provider** — `shared`-backed verification, `auth-oidc.ts`, `claims.ts`, `/auth/login`,
   `/auth/callback`, the claim re-read, sign-out. `auth-oidc.test.ts` with its stub IdP.
   Two one-line changes are easy to miss and break the whole flow silently `[P2-04]`: `/auth` has
   to join `server.ts`'s non-static prefix list, or `/auth/login` returns `index.html` with a 200
   and the button appears to do nothing; and `ui/vite.config.ts` has to proxy `/auth/*` beside
   `/api/*`, or the same thing happens on `:5173`.
6. **Management and sessions** — `api/users.ts`, the split of `/api/meta`, `sessions.test.ts`,
   `users.test.ts`.
7. **The UI** — `LoginView`, the forced-change gate, `AccountView`, `UsersView`, `TeamsView`, the
   route table, the glossary, the sidebar. `ui/test/auth.test.tsx`, and the existing hygiene rules
   applied to the new views.
8. **Deployment** — the two Dockerfiles, `.dockerignore`, `docker-compose.yml`,
   `scripts/mint-instance.ts`, `ci.yml`, `images.yml`. Both images built and the smoke test run
   locally before the workflow is committed.
9. **`docs/design.md`** — G3.
10. **`README.md`, `docs/deployment.md`, `docs/walkthrough.md`** — G4, and the moves out of the
    README. `scripts/seed.ts` and `scripts/demo.ps1` updated for `AUTH_PROVIDERS`, and `demo.ps1`
    given an act that signs in locally, creates a user, grants a team and shows the grant's
    provenance.

---

## 15. Risks

| Risk | Mitigation |
|---|---|
| **The OIDC path cannot be tested against a real Keycloak here.** The stub IdP implements the protocol the way the specification says, which is not always the way a product does | The stub is built from Keycloak's documented behaviour, including the two places it differs from the specification: refresh-token rotation on every use, and `realm_access.roles` rather than `roles`. The deployment document lists exactly what to configure on the Keycloak client, and the first real sign-in is the acceptance test that cannot be automated here — stated as a gap, not covered by a claim |
| **Splitting `/api/meta` breaks a caller.** The SPA, `demo.ps1` and several tests read it | It is one endpoint and the callers are in this repository. `demo.ps1` already signs in before it reads anything |
| **Live role resolution costs a query per request** (D35) | Two indexed reads on tables with tens of rows, on a control plane that is already doing a session update per request. Measured before step 3 is called done, and the perf guardrail is the backstop |
| **The forced-change gate refuses too much.** A gate that also blocks `/api/auth/logout` traps the user | The allowlist is three routes and it is tested route by route, including that everything else is refused |
| **A published image carries a developer's database or KEK** `[P1-23]` | `.dockerignore` excludes `.data` and `*.sqlite*`, and `images.yml`'s smoke test asserts that a freshly started control-plane container holds exactly one principal — so a regression in the ignore file fails the workflow rather than shipping |
| **An upgraded v4 deployment that switches to OIDC finds its existing APIs unmanageable** `[P1-20]` | Correct and expected: the backfilled `dev` principals hold the team memberships that keep those APIs owned, and nobody can sign in as them once `dev` is not a provider. The fix is one admin granting an OIDC principal the same team, and the deployment document says so under upgrading — because "nobody can edit the APIs after the upgrade" is otherwise a support call |
| **The design document drifts from the product** | It describes behaviour the tests pin, and every claim in it is one a reader can check from the UI. Where something is not implemented it says so in §13 rather than describing an intention |
