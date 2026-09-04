# v5 plan review

Goal G0 of every previous version: **implementation starts only after a review round finds
nothing.** This file records the rounds against [`v5-plan.md`](v5-plan.md). Findings are `[P1-nn]`
for round 1, `[P2-nn]` for round 2, and so on, and the ids appear inline in the plan wherever a
finding changed it.

The bar is the one v4's review set: a finding is something that would have produced a wrong
implementation, an unsafe default, an untestable claim, or a number nobody measured. "This could be
phrased better" is not a finding.

---

## Round 1 — 24 findings

Two of the plan's claims were checked by running Bun rather than by reasoning. One was wrong by a
factor of sixteen, in the direction that makes the decision easier.

### Measurements

**`[P1-02]` The `id_token` verification cost was invented.** Draft 1 said an RS256 verify against a
cached JWKS costs 0.31 ms. Measured on the development machine, 2000 iterations after a warm-up:

| | ms/op |
|---|---|
| `crypto.verify` with a pre-imported key | 0.0168 |
| JWK import **plus** verify, every time | 0.0188 |

**0.019 ms**, and importing the key on every call costs 0.002 ms — so the JWKS cache does not even
need to cache the imported key object. The plan's D34 keeps its conclusion and gets the real
number. Recorded because a number in a plan that nobody measured is the thing v4's review found
twice.

**`[P1-03]` The argon2id cost was checked, and sizes the lockout.** `Bun.password.hash` at
`memoryCost: 19456, timeCost: 2` (OWASP's argon2id baseline) produces a 118-character
`$argon2id$v=19$m=19456,t=2,p=1$…` string, and verify takes **17.7 ms**. That is the number the
lockout threshold is argued from, and it is also the number that makes `[P1-14]` a real risk rather
than a theoretical one.

### Security

**`[P1-01]` `GET /api/meta` is public and leaks the gateway fleet's URLs.** Confirmed against the
shipped code: `admin.ts` registers it with `auth: "public"`, and its `environments[].gateways` is
`gatewayUrlsFor(config, environment)` — every gateway URL the playground may use, to any anonymous
caller. It is public only because the sign-in screen needs the development user list. The plan now
splits it: `GET /api/auth/providers` public and tiny, `GET /api/meta` session. The `images.yml`
smoke test asserts the 401, so the split cannot regress silently. **Plan §5.2 rewritten.**

**`[P1-05]` Unauthenticated argon2id is a CPU-exhaustion amplifier.** At 17.7 ms a verify
`[P1-03]`, an attacker posting to `/api/auth/login` with any username saturates the control plane's
CPU with no credential at all — and the per-principal lockout does nothing about it, because the
lockout is per principal and the attacker can vary the username. The dummy-hash-on-unknown-username
rule `[P1-03]` makes it *worse*: it guarantees a hash per request. The plan gains a global sliding
limiter on the endpoint, `LOCAL_LOGIN_RATE_PER_MIN` (default 60), answering `429` with
`Retry-After`. It also bounds the spray attack the per-principal lockout misses. **Plan §5.3 and
§12 amended.**

**`[P1-07]` `OIDC_REDIRECT_URI` may disagree with `PUBLIC_URL`, and the failure is baffling.** The
callback sets the session cookie; a cookie set on a different origin than the SPA is served from is
never sent back, so the user completes a whole sign-in and lands signed out with no error anywhere.
Boot now refuses when the two origins differ, naming both. **Plan §12 amended.**

**`[P1-08]` `return_to` validation of "starts with `/` and not `//`" is not enough.** Some browsers
normalise a leading `/\` to `//`, making `/\evil.test` an off-site redirect. The rule is now: must
start with `/`, must not start with `//` or `/\`, and must contain no control characters. **Plan
§5.4 amended.**

**`[P1-09]` The `auth_flow` cookie was scoped too widely.** Draft 1 set it on `Path=/`, so it
travels on every request in the session for its whole two minutes. It is needed on exactly one
path. Now `Path=/auth/callback`, `HttpOnly`, `SameSite=Lax`, `Max-Age=120`, and cleared on the
callback. **Plan §5.4 amended.**

**`[P1-10]` The refresh token needed a stated encryption story, not an implied one.** Draft 1 said
"KEK-encrypted" in a column comment. Made explicit: the same envelope as subscription keys and
certificate private keys, so a database file taken without the KEK yields no usable IdP credential,
and KEK rotation covers sessions for free. **Plan §4 amended.**

### Correctness

**`[P1-12]` `UNIQUE (provider, username)` breaks OIDC sign-in when a `preferred_username`
changes.** Keycloak's `preferred_username` is mutable and not guaranteed unique across a realm's
lifetime; two principals can legitimately end up wanting the same one, and the claim update would
then violate the index and turn a valid sign-in into a 500. The uniqueness that matters is the local
one — it is what a person types. Now a partial index:
`CREATE UNIQUE INDEX principal_local_username ON principal(username) WHERE provider = 'local'`.
An OIDC principal's `username` is a display convenience whose uniqueness the directory owns.
**Plan §4 amended.**

**`[P1-13]` The claim re-read has to happen in `dispatch`, and the plan did not say where.** It is
an `await` before the handler; `sessionUser` is synchronous and stays so. Left unstated, the
obvious implementation puts it inside `sessionUser`, which would make every route's authentication
path async and touch every call site. Now stated: a separate
`await refreshClaimsIfDue(app, sessionId)` in `dispatch`, before `sessionUser`, skipped for
`/auth/*` and `/api/auth/*` (which would otherwise recurse) and for `instance`-authenticated
routes (which have no session). **Plan §5.4 amended.**

**`[P1-14]` The forced-change gate is evaluated after `/api/meta` in the SPA's boot order, so the
gate would never render.** `App` fetches `/api/me` and `/api/meta` together and renders a fatal
error when either fails. With the gate refusing `/api/meta`, a user who must change their password
sees "the portal could not reach its own API" instead of the change-password card. The order is now
part of the plan: resolve `/api/me`, branch on `mustChangePassword` **before** any other fetch is
consulted, and fetch `/api/meta` only past that branch. **Plan §8 amended.**

**`[P1-15]` Discovery at boot makes the identity provider a startup dependency.** Draft 1 said the
issuer is "checked against the allowlist at boot, loudly" without saying whether that check fetches
anything. Fetching discovery at boot means the control plane will not start while Keycloak is
restarting — an availability coupling nobody asked for, and the opposite of the fail-static
discipline the data plane has. Now: the **issuer URL string** is checked against the egress
allowlist at boot with no network call, and each endpoint from the discovery document is checked
against the allowlist when discovery is first fetched, refusing the sign-in with a named error if
one is not allowed. **Plan §5.4 amended.**

**`[P1-16]` `auth_flow.redirect_uri` is a column with one possible value.** Multi-host redirect
resolution is out of scope (one `OIDC_REDIRECT_URI`, used verbatim), so the column would be dead
from the day it shipped. Dropped, and multi-host named in the out-of-scope list with the reason —
the reference implementation's `resolveRedirectUri` exists because that portal is served on several
domains, which this one is not. **Plan §2 and §4 amended.**

**`[P1-17]` A demoted OIDC admin cannot be demoted, and the plan did not say what happens.**
`isAdmin = role = 'admin' || idp_admin`, so an admin editing `role` to `member` on a principal whose
token says `apim-admin` changes nothing observable — a write that reports success and has no
effect. Now: the `PATCH` succeeds (it sets the locally authored role, which is a real fact), and the
response carries the **effective** role plus `adminFrom: "idp"`, so the UI shows "admin, from the
identity provider" and disables the local control with that as the reason. `disabled_at` is the
kill switch for that case and the screen says so. **Plan §7 amended.**

**`[P1-18]` `sourceGroup` on `GET /api/teams` is directory metadata for every signed-in user.** Team
names are already a discovery surface, but which IdP group grants a team is reconnaissance: it tells
any user which group to get added to in order to own another team's APIs. Now admin-only on that
field; the shape stays the same and the field is absent for others. **Plan §7 amended.**

**`[P1-19]` Nothing prunes `auth_flow` or dead sessions.** Both grow forever: an abandoned sign-in
leaves an `auth_flow` row, and every expired or revoked session stays. Neither is unbounded in a
dangerous way, but "every bound has a defined behaviour past it" is a rule this project keeps.
Added to the existing `prune` job: `auth_flow` rows past `expires_at`, and sessions revoked or
expired more than `SESSION_PRUNE_AFTER_DAYS` (default 30) ago — kept that long because the session
list is a security surface and an operator asked "what signed in last week" is a real question.
**Plan §4 and §12 amended.**

**`[P1-20]` The v4→v5 migration's principal backfill was under-specified.** Draft 1 said the
migration inserts "the three development principals". On an upgraded database the ids in
`membership`, `audit.actor` and `revision.created_by` are whatever that deployment used, and
hard-coding three names would leave a real database with memberships pointing at principals that do
not exist. Now: the migration inserts one `provider='dev'` principal per distinct
`membership.user_id`, which on any v4 database is exactly the set `seedBaseline` authored, so
ownership and history survive intact. A deployment that upgrades and then switches to
`AUTH_PROVIDERS=oidc` keeps those rows — they cannot sign in, and their team memberships are what
keeps existing APIs owned until an admin grants an OIDC principal the same team. Written into the
deployment document, because "nobody can edit the APIs after the upgrade" is otherwise a support
call. **Plan §4 and §14 amended.**

### Deployment

**`[P1-21]` `oven/bun:1.4-alpine` may not be a published tag.** The repository pins `1.4.0`
everywhere else (`perf.yml`'s `setup-bun`), and a floating minor tag in a Dockerfile is how a
reproducible build stops being one. Both images now pin `oven/bun:1.4.0-alpine`, and the version
appears in exactly two places, both listed in the deployment document's upgrade section. **Plan §9.1
amended.**

**`[P1-22]` The data-plane image would refuse to start.** The gateway asserts
`BUN_CONFIG_MAX_HTTP_REQUESTS ≥ MAX_CONCURRENT_REQUESTS` and refuses to boot otherwise — that is
the check v3 added deliberately. An image that sets neither inherits the runtime's default outbound
queue and the gateway's default ceiling, which is exactly the pairing the check exists to catch.
Both are now `ENV` in the image, at the same values `scripts/seed.ts` writes, and the compose file
sets `ulimits.nofile` to four times the ceiling because each held request keeps two sockets.
**Plan §9.1 amended.**

**`[P1-23]` `.dockerignore` had to exclude `.data` and `*.sqlite*`, and the plan should say why.**
A developer's `.data/apim.sqlite` contains KEK-encrypted subscription keys and, beside it,
`.data/kek.key` — the key. Copying the build context wholesale into a published image would publish
both. Called out explicitly, and the smoke test asserts a freshly started control-plane container
has exactly one principal. **Plan §9.1 and §15 amended.**

**`[P1-24]` The plan miscounted the admin carve-outs.** Draft 1 said eleven inline
`if (!user.isAdmin)` sites. There are **seven**, and two of them (`api/trust.ts`, `api/policy.ts`)
are already local helper functions doing the same thing under two names. The consolidation is
therefore smaller and more obviously worth doing: five inline sites and two duplicate helpers
become one `requireAdmin` in `router.ts`. Corrected, because a plan that overstates a refactor
invites somebody to skip it. **Plan §6 amended.**

### Testing and process

**`[P1-11]` "Membership is synced from IdP groups" cannot be claimed.** Membership is derived for
the user who is signing in, from their own token. A user who has never signed in does not exist in
the directory, so an admin cannot pre-assign them to a team, and a group change for a user who is
not signing in is invisible until they do. Design §9's wording implies a directory sync; there is
none. Named as a limitation in the out-of-scope list rather than covered by a claim. **Plan §2
amended.**

**`[P1-25]` The hygiene rules will fail on the new views, and the plan should say which.**
`ui/test/hygiene.test.ts` refuses a `DELETE` call whose nearest handler is not `onConfirm`. Three
of the new call sites are deletes that should *not* demand a typed confirmation — revoking one of
your own sessions, and signing out everywhere — and two that should: revoking a team membership and
deleting a team. The exemption list gets the first two with reasons; the last two go behind
`DangerZone`. Stated now, so it is a decision rather than a test failure somebody silences.
**Plan §8 amended.**

**`[P1-26]` Two design documents with similar names.** `docs/greenfield-design.md` is the original
architecture proposal; `docs/design.md` is the new functional description. A reader who opens the
wrong one will not know it. Both now open with one line saying what they are and what the other
one is, and the README's reading table distinguishes them in a sentence each. **Plan §10 and §11
amended.**

---

## Round 2 — 4 findings

Round 2 re-read the amended plan against the shipped code rather than against draft 1.

**`[P2-01]` `makeCp`'s default has to be `dev` alone, and one existing test contradicts it.**
`test/helpers.ts` passes `devAuth: true`; with `AUTH_PROVIDERS` replacing it, the default becomes
`authProviders: ["dev"]`. Checked every existing test for a dependence on `config.devAuth`: the only
other reader is `uiDevOrigin`, which is what the `Origin` check allows. Decoupled — `UI_DEV_ORIGIN`
is now its own value, allowed when set, rather than gated on the auth mode. That is also more
correct: whether Vite is running is not a fact about how people sign in. **Plan §12 amended.**

**`[P2-02]` `/api/me` is registered `public` and must stay so.** The SPA calls it before there is a
session, and the plan's split of `/api/meta` makes it the only pre-session call besides
`/api/auth/providers`. Confirmed it returns `null` for an anonymous caller rather than 401, which
is what lets the SPA render the sign-in screen without a failed request in the console. Its payload
grows (`mustChangePassword`, `claimsStale`, `unmappedGroups`, `adminFrom`) and must still answer
for an anonymous caller with all of them absent. Pinned by a test.

**`[P2-03]` The audit log and the revision list will start showing opaque ids.** Existing rows carry
`alice`; new local and OIDC principals carry `usr_…`. Both surfaces show the raw value today, which
was readable by accident. One helper resolves a set of principal ids to display names in one query,
and `/api/audit`, the revision list and the release history use it. Small, and the alternative is a
UI that gets less readable as a result of a feature about users. **Plan §7 amended.**

**`[P2-04]` `/auth` must be added to the control plane's non-static prefixes, and the plan says so
in one place only.** `server.ts` routes anything outside `["/api", "/healthz", "/readyz"]` to the
static handler, which serves `index.html` for unknown paths — so `/auth/login` would return the SPA
with a 200 and the sign-in would appear to do nothing. Also needed in the Vite dev proxy, or the
same thing happens on `:5173`. Both listed in the delivery step rather than only in §5.4.
**Plan §14 amended.**

---

## Round 3 — nothing

Round 3 re-read the plan end to end against the four goals and the shipped tree, and looked
specifically for:

- a claim with no acceptance test behind it — none left; the two that had none in draft 1
  (`[P1-11]` directory sync, and the Keycloak-in-production sign-in) are now stated as gaps in §2
  and §15 rather than claimed;
- a number nobody measured — the two that existed are measured (`[P1-02]`, `[P1-03]`);
- a default that is unsafe — `AUTH_PROVIDERS` has none by construction (D36), `OIDC_END_SESSION`
  and `dev` are both off unless asked for, and `[P1-01]`'s split closes the one leak that was
  shipping;
- a step in §14 that cannot leave the tree green — step 2 is a pure extraction with existing tests,
  and steps 3–7 each carry their own suite;
- an out-of-scope item that is stubbed rather than absent — service tokens, SCIM, MFA, mail and
  Kubernetes are all named in §2 with the reason and appear nowhere in the schema, the config or
  the UI.

No findings. **Implementation may start**, in the §14 order.
