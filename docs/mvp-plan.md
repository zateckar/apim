# MVP implementation plan — Integration Portal

Draft 3 · the smallest system that satisfies the five goals while staying recognisably the
architecture of [`greenfield-design.md`](greenfield-design.md).

Draft 1 → 3 changes and the reasoning behind them are in
[`mvp-plan-review.md`](mvp-plan-review.md) (33 findings over three rounds; round 3 found
nothing). Finding ids appear inline below as `[R1-01]`.

---

## 1. Goals, restated as acceptance criteria

| # | Goal | Acceptance test |
|---|---|---|
| G1 | Control plane with a UI, plus a data plane | Two Bun processes; a browser UI drives every step below |
| G2 | Create / update / remove an API from `https://petstore.swagger.io/v2/swagger.json`, publish it to the data plane, attach a check-header policy and a rate-limit policy | UI + API do all six operations; the data plane starts and stops serving the route as a consequence |
| G3 | Subscribe to the API, generating an API key | `POST /api/subscriptions` returns a key exactly once; the key is stored encrypted |
| G4 | Call the API through the data plane with `curl`; key required; policies enforced | no key → **401**; wrong header → **403**; over the limit → **429**; otherwise **200** with a petstore body |
| G5 | TypeScript/Bun for both planes | No Go, no Node-only APIs; `bun test` is the test runner |

G4's numbers are the contract: 401 (no/invalid key), 403 (failed header precondition), 429
(rate limit, with `Retry-After`), 200 (proxied).

---

## 2. What is in and what is deliberately out

### In scope

- **The one idea (§1)**: the control plane owns desired state; the data plane is a projection
  that polls a config document and is never a source of truth.
- **Resource / revision / release spine (§4, §6.1)**: one `resource` table with a `kind`; a
  revision holds the contract and freezes on first release; a release makes it visible to the
  data plane; policy, route and binding are per-environment and edited in place.
- **Policy as a closed JSON vocabulary (§5)**, one row per unit in `policy_entry`, six units.
- **Pipeline order (§5.2)** — the subset that exists, in the documented order.
- **Rate limit per instance, fixed window (§5.7)**, `429` + `Retry-After` + `X-RateLimit-*`.
- **Config distribution (§8.5)**: single round-trip poll, `ETag`/`304`, fail-static cache
  file, fail-closed on revocation, active `config_digest` reported per instance.
- **Spec normalisation on import, generation on export (§4.1)** for Swagger 2.0 and OpenAPI
  3.x in JSON (D10), `original` kept verbatim, stable `version_digest`.
- **Egress allowlist (§5.3)** on bindings *and* on server-side spec fetches, no redirects.
- **`can()` as one function (§9)**, dev-bypass identity, sessions in SQLite, `Origin` check on
  cookie-authenticated mutations, `If-Match` on resource `PATCH`.
- **Append-only audit (§4)** enforced by SQLite triggers.
- **Jobs table + runner (§10)** with a target lease (§7) for the release/reconcile path.
- **Secrets**: subscription keys encrypted at rest with a KEK (§4); gateway instance tokens
  hashed; the config document carries key **hashes**, never plaintext keys.

### Out of scope (named, with the section it comes from)

Validation (§5.1) and compiled artifacts (§8.7) · quota (§5.7) · WebSocket/SSE (§5.8) ·
`soap`/`kafka`/`kafka-topic`/`kafka-proxy`/`mcp`/`a2a` (§4.4, §8.8–8.10) · the `apim` adapter
and import (§8, §16) · the promotion chain beyond one environment and the per-unit promotion
merge (§6.2, §6.3) · divergence (§6.4) · drift (§7) · approvals, announcements, certificates,
TLS exceptions, service tokens (§4.2, §4.3, §5.4, §9) · OIDC (§9) · OTEL/ELK (§13) · response
cache, retries, circuit breaker, backend pools, `backendAuth` schemes (§5, §5.5) · revision
pruning (§4.1) · Postgres (§13).

**Every out-of-scope item is absent, not stubbed.** In particular there is no `validate` unit,
so nothing in the UI or the config document can read as "validation is on".

### Deviations from the design

| # | Design says | MVP does | Reason |
|---|---|---|---|
| D1 | Data plane in Go (§8.2) | TypeScript/Bun | G5. Costs §8.2's per-request isolation — acceptable because blocking validation, the CPU-bound step that motivated it, is out of scope |
| D2 | `node:sqlite` (§2) | `bun:sqlite` | G5; same synchronous shape, WAL, `RETURNING` |
| D3 | `ajv` for policy JSON (§2) | ~200-line hand-written validator in `shared/` | Six units; keeps the data plane dependency-free and lets both planes share one definition |
| D4 | OIDC + PKCE (§9) | The `dev` bypass §9 already allows | No IdP available; `can()`, sessions, roles and teams are real |
| D5 | `PROMOTION_CHAIN=dev,test,prod` (§11) | `PROMOTION_CHAIN=dev` | G2 says publish, not promote. Every table keeps its `environment` column, so the chain is additive later |
| D6 | OTEL to ELK (§13) | Structured JSON logs to stdout | No collector; the record carries §13's field set |
| D7 | Two build pipelines, two images (§13) | One Bun workspace, two entry points | Consequence of D1 |
| D8 | Precondition regexes are RE2, so they cannot backtrack (§5.6) | JS `RegExp` + a write-time pattern linter (no nested quantifiers, backreferences or lookaround), `pattern.length ≤ 200`, and the tested value truncated to 1 KiB | `[R1-02]` No RE2 in Bun. Under D1 a backtracking pattern would stall the whole event loop, so the mitigation is mandatory, not advisory |
| D9 | A subscription to another team's product needs a second person's approval (§9) | Any team may subscribe without approval | `[R1-25]` Approvals are out of scope; the `approval` table and the second-person rule land with them |
| D10 | `yaml` is in the dependency budget (§2), so specs may be YAML | JSON documents only, with an error that says so | `[I7]` The `yaml` dependency is out of the MVP; mis-parsing YAML would be worse than refusing it |

---

## 3. Shape

```
                     Browser  (React + Vite SPA, same origin)
                         │ /api
        ┌────────────────▼──────────────────────────────┐
        │ CONTROL PLANE — Bun/TS        :8080           │
        │  router · session · resources · policy        │
        │  releases · subscriptions · job runner        │
        │  GET /api/gateway/config   (ETag, bearer)     │
        │                 bun:sqlite  .data/apim.sqlite │
        └────────────────┬──────────────────────────────┘
                         │ poll: If-None-Match + X-Instance-Digest + bearer
        ┌────────────────▼──────────────────────────────┐
        │ DATA PLANE — Bun/TS           :8081           │
        │  route match · subscription key · rate limit  │
        │  preconditions · rewrite · header rules       │
        │  streaming proxy                              │
        │  fail-static: .data/dp-config.json            │
        └────────────────┬──────────────────────────────┘
                         ▼
              https://petstore.swagger.io/v2   (TLS verified)
```

No reverse proxy in front of the data plane (§8.1 is a deployment fact). The consequence is
written down rather than assumed: `X-Forwarded-For` is ignored and **replaced** unless
`TRUSTED_PROXY_CIDRS` is set `[R1-14]`, and no client-certificate policy exists that a header
could spoof.

### Layout

```
apim/
  package.json                  bun workspace + scripts
  config/targets.json           per (environment, adapter) — §11 TARGETS_FILE
  config/integrations.json      egress allowlist + deny CIDRs — §11 INTEGRATIONS_FILE
  shared/
    types.ts        policy.ts   canonical.ts   config-doc.ts   template.ts
  control-plane/src/
    server.ts  router.ts  db.ts  schema.sql  migrate.ts  crypto.ts  auth.ts
    audit.ts  normalize.ts  config-build.ts  jobs.ts  egress.ts  api/*.ts
  data-plane/src/
    server.ts  config-client.ts  route-table.ts  pipeline.ts  ratelimit.ts
    proxy.ts  problem.ts
  ui/                           Vite + React + TS
  scripts/seed.ts  scripts/demo.ps1  scripts/demo.sh  scripts/dev.ps1
  test/                         bun test — unit + integration
```

---

## 4. Data model (MVP subset of §4)

Names and columns are the design's; tables the MVP does not need are absent, not renamed.

```sql
schema_version(version PRIMARY KEY, applied_at)

team(id PK, name, source_group)
membership(team_id, user_id, PRIMARY KEY(team_id, user_id))
session(id PK, user_id, roles_json, teams_json, created_at, idle_until, expires_at, revoked_at)

resource(id PK, kind, name, team_id, api_version, lifecycle, sunset_at, derived_from,
         created_at, updated_at)
revision(id PK, resource_id, rev, model, original, original_format, version_digest,
         frozen_at, created_by, created_at, UNIQUE(resource_id, rev))
policy_entry(resource_id, environment, unit_key, value_json, origin, seeded_from_env,
             seeded_at, updated_by, updated_at, PRIMARY KEY(resource_id, environment, unit_key))
route(resource_id, environment, host, base_path,
      PRIMARY KEY(resource_id, environment), UNIQUE(environment, host, base_path))
binding(resource_id, environment, backend_json, PRIMARY KEY(resource_id, environment))

product(id PK, name, team_id, lifecycle, terms)
product_member(product_id, resource_id, PRIMARY KEY(product_id, resource_id))
application(id PK, name, team_id, created_at)
subscription(id PK, product_id, application_id, environment, state,
             primary_key_enc, secondary_key_enc, key_rotated_at, created_at)

release(id PK, resource_id, revision_id, environment, state, reason, version_digest,
        released_by, released_at)
-- at most one live release per resource per environment            [R1-08]
CREATE UNIQUE INDEX release_live ON release(resource_id, environment)
       WHERE state = 'converged';
applied(target_id, resource_id, revision_id, applied_digest, compiler_version, applied_at,
        PRIMARY KEY(target_id, resource_id))

target(id PK, environment, adapter, config_json, enforce, paused,
       lease_holder, lease_expires_at, UNIQUE(environment, adapter))   -- lease: §7 [R1-17]
gateway_instance(id PK, target_id, name, token_hash, config_digest, last_seen_at, revoked_at)

job(id PK, kind, state, payload, idempotency_key UNIQUE, attempts, result,
    created_at, updated_at)
audit(id PK, at, actor, action, subject, outcome, detail)   -- append-only by trigger
```

- `revision` holds the contract only; `version_digest = sha256(canonical(model))`, so a
  reformatted upload does not churn it.
- `route` is one row per (resource, environment) with `UNIQUE(environment, host, base_path)`.
  `host = '*'` means any host, which is what the MVP uses.
- `policy_entry` is one row per unit: the row's existence is the policy, `value_json` its
  values.
- `release.state` ∈ `pending | converging | converged | superseded | withdrawn | failed`.
  Only the single `converged` release per (resource, environment) reaches the config document.
- `applied.applied_digest = sha256(rendered route entry + compiler_version)`;
  `compiler_version = "mvp-1"`.
- `audit` carries `BEFORE UPDATE` / `BEFORE DELETE` triggers that `RAISE(ABORT)`.
- Deletes cascade from `resource` to revision / policy_entry / route / binding / release /
  applied / product_member.

---

## 5. The MVP policy vocabulary (§5)

Six units, one shared TypeScript definition, validated on write and interpreted by the data
plane. Unknown unit keys and unknown fields are rejected — nothing passes through unread.

```ts
"auth.subscriptionKey"  { in: "header"|"query", name: string, forwardCredentials?: boolean }
                        // presence = a key is required. default: header "X-Api-Key", forward=false

"preconditions"         [ { requireHeader: { name, present?: true, equals?: string, pattern?: string },
                            deny: { status: 400..599, reason: string,
                                    headers?: Record<string,string>, body?: object|string } } ]
                        // exactly one of present|equals|pattern; one ordered unit, never merged
                        // element-wise (§5)

"rateLimit"             { calls: int>0, periodSec: int>0, per: "instance",
                          by: "subscription", scope: "route", emitHeaders?: boolean }

"rewrite"               { stripBasePath?: boolean }                          // [R1-12]

"headers.request"       { remove?: string[], set?: Record<string,string>,
                          append?: Record<string,string>, skip?: Record<string,string> }
                        // applied in exactly that order, header names case-insensitive

"timeoutMs"             int 1..120000, default 30000
```

Cross-unit constraints, checked when the document is assembled `[R1-04]`:

- `rateLimit` requires `auth.subscriptionKey` on the same route — `by: "subscription"` has no
  key without it. Rejected naming both units.

`deny.body` and `headers.request.*` values render through the closed §5.6 variable set,
restricted to what the MVP can resolve: `subscription.id`, `subscription.name`,
`application.id`, `application.name`, `product.id`, `product.name`, `resource.name`,
`revision.rev`, `environment`, `route.basePath`, `request.id`, `client.ip`, `now.iso8601`,
`now.rfc1123`, `now.epoch`. `subscription.name` is the composed
`"<application> → <product>"`. An unknown `${…}` is a **write-time error**, never an empty
render (§12).

Matching and comparison rules:

- `equals` uses `crypto.timingSafeEqual` after a length check `[R1-15]`.
- `pattern` obeys D8: linted at write time, `≤ 200` chars, tested against at most the first
  1 KiB of the header value (a longer value denies rather than being matched).
- `deny.body` object → `application/json`; string → `text/plain; charset=utf-8`; absent →
  `application/problem+json` from `status` + `reason`. `deny.headers` apply last and cannot
  change the status `[R1-16]`.

Absent units mean: no key required (the UI says so plainly, and a release with no
`auth.subscriptionKey` returns a warning `[R1-21]`), no preconditions, no rate limit, no
rewrite, no header rules, `timeoutMs = 30000`. The error shape is fixed at
`application/problem+json`; `errorFormat` becomes a unit when `soap` arrives.

---

## 6. Control-plane HTTP API

Same-origin with the SPA. Every resource response carries a `capabilities` array (§9) so the
UI renders buttons from data.

```
GET    /healthz  /readyz

POST   /api/auth/dev-login          { userId }        → session cookie (§9 dev bypass)
POST   /api/auth/logout
GET    /api/me
GET    /api/meta                    environments, kinds, policy-unit catalogue,
                                    live instance count per environment            [R1-18]

GET    /api/resources?q=&kind=&team=mine&limit=&cursor=
POST   /api/resources               { kind, name, teamId, apiVersion }
GET    /api/resources/:id           → routes, binding, releases, revision *metadata*  [R1-24]
PATCH  /api/resources/:id           If-Match: <etag>   { name?, apiVersion?, lifecycle? }
DELETE /api/resources/:id
POST   /api/resources/:id/revisions { specUrl } | { spec, format }
GET    /api/revisions/:id/spec?format=openapi-3.1|original

GET    /api/resources/:id/routes?environment=dev
PUT    /api/resources/:id/routes    { environment, host, basePath }
GET    /api/resources/:id/binding?environment=dev
PUT    /api/resources/:id/binding   { environment, urls: [url] }        → egress allowlist

GET    /api/resources/:id/policy?environment=dev      → assembled document + per-unit origin
PUT    /api/resources/:id/policy/units/:unitKey       { value }
DELETE /api/resources/:id/policy/units/:unitKey

POST   /api/resources/:id/releases  { revision, environment } → 202 { releaseId, jobId, warnings }
GET    /api/resources/:id/releases
DELETE /api/resources/:id/releases?environment=dev            → withdraw (unpublish)

GET/POST /api/products             PUT /api/products/:id/members  { resourceIds }
GET/POST /api/applications

GET    /api/subscriptions?application=&product=
POST   /api/subscriptions           { productId, applicationId, environment }
                                    → 201, primaryKey shown once
POST   /api/subscriptions/:id/reveal   → decrypted keys, team-gated, audited, no-store [R1-19]
POST   /api/subscriptions/:id/rotate   { which: "primary"|"secondary" }
DELETE /api/subscriptions/:id          → state=revoked

GET    /api/targets                GET /api/targets/:environment/health
GET    /api/jobs/:id               GET /api/audit?limit=            (admin only)

GET    /api/gateway/config          Bearer <instance token>, If-None-Match, X-Instance-Digest
```

Rules that apply throughout:

- **AuthZ** is `can(user, action, subject) = user.isAdmin || subject.team_id ∈ user.teams`.
- **CSRF**: a mutating request authenticated by the session cookie must carry `Origin` (or
  `Referer`) matching `PUBLIC_URL` — or `UI_DEV_ORIGIN`, honoured only when `DEV_AUTH=1`
  `[R1-20]`. Bearer-authenticated requests (the gateway poll) are exempt, so scripts send
  `-H "Origin: http://localhost:8080"`, and the demo does.
- **Concurrency**: `PATCH /api/resources/:id` requires `If-Match` against the resource ETag;
  a mismatch is `412`.
- **Errors** are `application/problem+json` — `{ type, title, status, detail, requestId }`.
- **Pagination** is `?limit=&cursor=` on list endpoints, as a contract (§14).
- **Revision upload is idempotent** `[R2-01]`: a document whose `version_digest` equals the
  newest revision's returns `200` with that revision; a new digest creates rev n+1.
- **Spec fetches are egress-checked** `[R1-01]`: `specUrl` passes the same allowlist and
  deny-CIDR rules as a binding, `redirect: "manual"`, `MAX_SPEC_BYTES = 5 MiB` enforced while
  reading, and remote or `file://` `$ref`s are rejected so the document stays self-contained
  (§5.3).
- **Base paths are normalised and reserved-checked** `[R1-06] [R1-13]`: must start with `/`,
  no trailing slash except the root `/`, no query or fragment, ≤ 128 chars, matched
  case-sensitively; `/healthz` and `/readyz` are rejected. Hosts match case-insensitively with
  the port stripped; `*` matches any host.

---

## 7. Publish: what a release actually does

1. `POST …/releases { revision, environment }` validates: the revision exists; `route` and
   `binding` rows exist for that environment (otherwise `409` naming what is missing — a route
   with no backend must not reach the fleet); the environment is in `PROMOTION_CHAIN`.
2. Writes `release(state='pending')`, freezes the revision if unfrozen, enqueues a `reconcile`
   job, returns `202 { releaseId, jobId, warnings }` — where `warnings` includes "no
   authentication policy attached" when that unit is absent `[R1-21]`.
3. The job runner takes the target lease `[R1-17]`, marks the release `converging`, marks the
   previous `converged` release for that (resource, environment) `superseded`, renders the
   route entry, writes `applied`, sets `converged`, writes `audit`. Three attempts with
   backoff; then `failed` with the reason, visible on the publish screen `[R2-05]`.
4. The data plane picks it up on its next poll (≤ `POLL_INTERVAL_SEC`). Convergence *on the
   fleet* — what the demo waits for — is `GET /api/targets/dev/health` comparing each
   instance's reported active `config_digest` against the current one.

Withdraw (`DELETE …/releases`) and resource deletion enqueue the **same** `reconcile` job with
`intent: "remove"`; the job is the only writer of `applied` and `release.state`, so there is
one code path for the projection `[R2-02]`.

Policy, route and binding edits need **no release** (§6.1): they are per-environment state and
reach the fleet on the next poll. That is precisely why G2's "publish, then apply policies"
works in that order.

### The config document (wire contract v1)

Served canonically ordered, so the body and the `ETag` digest always agree.

```json
{
  "configVersion": 1,
  "environment": "dev",
  "digest": "sha256:…",
  "generatedAt": "2026-08-31T10:00:00.000Z",
  "routes": [{
    "resourceId": "res_…", "resourceName": "petstore", "revisionId": "rev_…", "rev": 3,
    "host": "*", "basePath": "/petstore",
    "productIds": ["prod_…"],
    "backend": { "urls": ["https://petstore.swagger.io/v2"] },
    "policy": { "auth.subscriptionKey": {…}, "preconditions": [...], "rateLimit": {…},
                "rewrite": {…}, "headers.request": {…}, "timeoutMs": 30000 }
  }],
  "subscriptions": [{
    "id": "sub_…", "keyHashes": ["sha256:…"], "productId": "prod_…",
    "applicationId": "app_…", "applicationName": "orders-app",
    "subscriptionName": "orders-app → petstore-product"
  }]
}
```

- **Key hashes, not keys.** The data plane hashes the presented key and looks it up. §8.5 puts
  "subscription key → application/product" in config without requiring plaintext.
- Only `active` subscriptions for this environment are emitted, so revocation fails closed at
  the next poll (§8.5) and the data plane needs no environment comparison `[R1-11]`.
- `digest` is `sha256` over the canonical document with `digest` and `generatedAt` excluded, so
  re-serialising at a different second is not a config change.
- The document is rebuilt per poll from SQLite: no cache, therefore no invalidation (§1), and
  `304` keeps the transfer at zero.

---

## 8. Data plane

### Boot and poll

1. Load `.data/dp-config.json` if present → serve immediately from last-good config (§8.5).
2. Poll `GATEWAY_CP_URL/api/gateway/config` every `POLL_INTERVAL_SEC` (default 2s) with
   `Authorization: Bearer $GATEWAY_TOKEN`, `If-None-Match: <digest>` and
   `X-Instance-Digest: <active digest>` `[R1-07]`.
   - `304` → nothing to do.
   - `200` → validate `configVersion`, build a new immutable route table, swap it by
     assignment (in-flight requests finish under the old one `[R2-06]`), write the cache file.
   - `401`/`403` → **this instance is revoked**: drop the route table, answer every proxy
     request `503` with a distinct problem type, log loudly `[R1-03]`.
   - Network error or 5xx → keep serving, log, retry with backoff. A revoked *subscription*
     therefore keeps working during a control-plane outage — §8.5's stated trade, recorded so
     it is not read as a bug `[R1-22]`.
3. `GET /healthz` → `{ ok, configDigest, routes, lastPollAt, stale, decommissioned }`. Tests
   and the demo wait on this instead of sleeping `[R2-04]`.

### Request pipeline (§5.2, MVP subset, in this order)

| # | Step | Failure |
|---|---|---|
| 1 | route match — host (exact, else `*`) + longest base path; `path === basePath \|\| path.startsWith(basePath + "/")` `[R1-05]`; any method | `404` "no published route matches this host and path" `[R2-03]` |
| 2 | trusted-proxy context — `X-Forwarded-For` honoured only from `TRUSTED_PROXY_CIDRS`, otherwise replaced `[R1-14]` | — |
| 3 | always-on limit — `Content-Length` > `MAX_BODY_BYTES` (8 MiB), **and** the body counted while streaming for a request that declares no length `[I2]` | `413` |
| 4 | authenticate — `auth.subscriptionKey`: read header/query, `sha256`, look up | `401` `[R1-10]` |
| 5 | authorize — `route.productIds` contains the subscription's product | `403` |
| 6 | rate limit — fixed window on `(subscriptionId, resourceId)` | `429` + `Retry-After` |
| 7 | preconditions — ordered `requireHeader` rules | the rule's `deny.status`, default `403` |
| 8 | rewrite — `stripBasePath`; query preserved verbatim | — |
| 9 | request headers — `remove → set → append → skip`; strip the key header and `Authorization` unless `forwardCredentials`; strip hop-by-hop; never forward inbound `Host`; set `X-Forwarded-For/-Proto/-Host` | — |
| 10 | proxy — `fetch`, `AbortSignal.timeout(timeoutMs)`, `redirect: "manual"`, body streamed with `duplex: "half"` for methods that carry one | `504` timeout, `502` connect/TLS |
| 11 | response — status/headers/body through, hop-by-hop stripped, upstream `Content-Encoding`/`Content-Length` dropped because Bun already decoded the body `[I4]`, `X-RateLimit-*` when `emitHeaders` | — |
| 12 | access log — one JSON line with §13's field set | — |

Two orderings are constraints, not conveniences (§5.2): rate limit precedes preconditions, so
a precondition-denied request **has already consumed rate-limit budget**; and credential
stripping precedes the proxy, so the backend never sees the subscription key.

**Backend URL join** `[R1-05]`: `backend.origin + backend.pathname.replace(/\/$/, "") +
rewrittenPath + originalQuery`, by concatenation — never `new URL(path, base)`, which would
discard the backend's own path segment.

### Rate limit (§5.7)

In-memory `Map` keyed `subId|resourceId`, fixed windows aligned to `periodSec` from the UTC
epoch (`windowStart = floor(now/period)*period`). Every request reaching step 6 increments;
reject when the post-increment count exceeds `calls` `[R1-09]`. `Retry-After =
max(1, ceil(windowEnd - now))`; with `emitHeaders`, `X-RateLimit-Limit`, `-Remaining =
max(0, calls - count)` and `-Reset` (epoch seconds). Per instance, no coordination, nothing
persisted; a sweep drops stale windows so the map cannot grow without bound. The MVP runs one
instance, so the effective ceiling equals the configured one — and the UI states the
`calls × instances` arithmetic anyway, from `/api/meta` `[R1-18]`.

---

## 9. UI

React + Vite + TypeScript (§2's dev-time dependencies). Same origin: the control plane serves
`ui/dist`; `bun run dev:ui` runs Vite on 5173 proxying `/api` to 8080. One stylesheet, no
component library, no state-management dependency.

| View | Does |
|---|---|
| Login | Dev user picker (admin / publisher / consumer) → `POST /api/auth/dev-login` |
| APIs | List + search; create (name, kind, team) |
| API → Definition | Import by URL (petstore prefilled) or paste; revision list with digests; download `original` or generated OpenAPI 3.1; rename; delete |
| API → Routing | Host + base path; backend URL prefilled from the spec's servers; allowlist errors inline |
| API → Policies | `auth.subscriptionKey` toggle + header name; check-header rule builder (name, present/equals/pattern, deny status/reason/body); rate limit (calls, periodSec) with the "× instances" note; `rewrite.stripBasePath`; per-unit `origin` badge; attach/detach per unit |
| API → Publish | Publish revision N to dev; release history and `failed` reasons; withdraw; live fleet-sync indicator; the "no authentication policy attached" warning |
| Products / Applications | Create; add APIs to a product; one-click "create a product for this API" so the design's product-as-subscription-unit does not make the demo tedious |
| Subscriptions | Subscribe an application to a product; key shown once with copy; reveal (audited), rotate, revoke; a ready-to-paste `curl` line |
| Gateway | Target, instances, active config digest, last poll, in-sync flag |
| Audit | Recent audit rows (admin) |

Fallback if the Vite/React install fails on this machine: the same views as a zero-dependency
SPA served from `control-plane/public`. The API contract does not change, so it is a swap of
one directory.

---

## 10. Configuration (§11) — no fallback chains; a missing required value is a startup failure

```
Control plane   PORT=8080  DB_PATH=.data/apim.sqlite  PUBLIC_URL=http://localhost:8080
                KEK_PATH=.data/kek.key       (32 random bytes, created on first run)
                PROMOTION_CHAIN=dev          TARGETS_FILE=config/targets.json
                INTEGRATIONS_FILE=config/integrations.json
                DEV_AUTH=1                   (the §9 bypass; the server refuses to start without it)
                UI_DEV_ORIGIN=http://localhost:5173   (honoured only when DEV_AUTH=1)
                UI_DIST=ui/dist              INSTANCE_STALE_AFTER_SEC=30
                MAX_SPEC_BYTES=5242880
Data plane      DP_PORT=8081   # not PORT: both processes load one .env.local  [I1]
                GATEWAY_CP_URL=http://localhost:8080  GATEWAY_TOKEN=…
                GATEWAY_CONFIG_CACHE=.data/dp-config.json
                POLL_INTERVAL_SEC=2  MAX_BODY_BYTES=8388608  TRUSTED_PROXY_CIDRS=
```

`config/integrations.json` holds the egress allowlist and nothing secret:

```json
{ "egressAllowlist": [
    { "scheme": "https", "hostPattern": "petstore.swagger.io", "ports": [443] },
    { "scheme": "http",  "hostPattern": "127.0.0.1", "ports": [1024, 65535] },
    { "scheme": "http",  "hostPattern": "localhost", "ports": [1024, 65535] } ],
  "denyCidrs": ["169.254.0.0/16", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"] }
```

`scripts/seed.ts` creates two teams, three dev users with memberships, the
`(dev, standalone)` target and one `gateway_instance`, printing its token once and writing
`.env.local` (which Bun loads automatically when both processes are started from the repo
root).

---

## 11. Tests (`bun test`)

**Unit** — canonical JSON and digest stability (a reformatted spec yields an identical
`version_digest`) · every policy unit's happy path · unknown unit key, unknown field, two of
`present|equals|pattern`, `calls: 0`, and `rateLimit` without `auth.subscriptionKey` all
rejected `[R1-04]` · pattern linter rejects `(a+)+`, backreferences and lookaround `[R1-02]` ·
normaliser over Swagger 2.0 (committed petstore fixture) and OpenAPI 3.1, including server-URL
extraction and export re-normalising to the same model · rate-limit window maths at the
boundary, `Retry-After` and `Remaining` `[R1-09]` · egress allowlist admits petstore, denies
`169.254.169.254`, wrong scheme and wrong port · template render resolves every allowed
variable and fails on an unknown one · base-path normalisation and the reserved names
`[R1-06] [R1-13]` · backend URL join keeps the backend's own path segment `[R1-05]`.

**Control plane** (in-process, a temp SQLite file and an ephemeral port per test) — create →
revision → route → binding → policy → release, and the config document contains the route,
the right policy and one subscription key hash · unreleased edits stay invisible until
released · publishing revision 2 changes `rev` and the digest (G2's "update") `[R1-26]` ·
withdraw removes the route; deleting the resource removes the route · `ETag`/`If-None-Match`
→ `304`; a policy edit changes the digest with **no** release · bad, absent or revoked
instance token → `401` `[R1-03]` · a revoked subscription leaves the config document ·
`can()`: another team's member cannot edit or publish, an admin can · `If-Match` mismatch →
`412`; a cookie-auth mutation with no `Origin` → `403` · audit is append-only (an `UPDATE`
throws) and every mutation writes a row · release without a route or binding → `409` ·
`specUrl` pointing at a denied CIDR → `400`, and nothing is fetched `[R1-01]` · re-uploading
the same document returns the same revision `[R2-01]`.

**Data plane** (in-process control-plane fixture + a local fake backend) — no key → 401 ·
unknown key → 401 · a key revoked and re-polled → 401 · valid key, missing or mismatched
header → **403** with the configured reason and body · valid key + header → **200**, and the
fake backend asserts base path stripped, query preserved, no `X-Api-Key`, no `Authorization`,
`X-Forwarded-For` replaced · `calls+1` requests → **429** with `Retry-After` and
`X-RateLimit-*`, and the next window admits again · a precondition-denied request still
consumed rate-limit budget `[R1-26]` · unknown host/path → 404 · over-cap `Content-Length` →
413 · backend timeout → 504, dead backend → 502 · fail-static: stop the control plane,
restart the data plane with only the cache file, traffic still flows · instance token revoked
→ every request 503 `[R1-03]` · a POST body streams through intact.

**E2E** — `scripts/demo.ps1` runs the G2–G4 walkthrough for real against petstore, asserting
401 / 403 / 429 / 200 and printing each. It preflights `/healthz` on both planes with an
actionable message and deletes any previous demo objects first, so it is re-runnable `[R1-23]`.
The bash twin is dropped `[I5]`: it could not be exercised on this machine, and the README's
shell-agnostic `curl` walkthrough covers the same ground.

---

## 12. Build order

1. `shared/` (types, canonical, policy validator + linter, template) + unit tests.
2. Control plane: db, migrations, audit triggers, crypto, router, auth/sessions, resources +
   revisions + normaliser, routes/bindings/policy, products/applications/subscriptions,
   releases + job runner + lease, `GET /api/gateway/config`, targets/health, audit — tests
   alongside.
3. Data plane: config client, route table, pipeline, rate limit, proxy, problem responses,
   `/healthz` — tests alongside.
4. `scripts/seed.ts`, then the demo script; run it against petstore for real.
5. UI, then a browser smoke pass over the whole flow.
6. README (run instructions, the curl walkthrough, the deviation list) and a final full
   `bun test` + demo run.

## 13. Risks

| Risk | Mitigation |
|---|---|
| petstore is flaky or rate-limits us | Tests use a local fake backend; only the demo hits petstore, and it reports the upstream status rather than pretending |
| Bun streaming-body quirks (`duplex: "half"`, GET-with-body) | Explicit test; a body is attached only for methods that can carry one |
| Vite/React install fails | Zero-dependency SPA fallback (§9), same API |
| The poll interval makes the demo look flaky | Demo and tests wait on `/healthz` `configDigest`, never on a sleep |
| Windows: `curl` resolving to a PowerShell alias | Scripts call `curl.exe` explicitly |
| SQLite writer contention | One process, WAL, `busy_timeout`, one serialised writer path (§13) |
