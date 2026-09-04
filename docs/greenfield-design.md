# Integration Portal — greenfield design

An API Management product: discover, publish, subscribe to and operate HTTP APIs and Kafka
topics across DEV, TEST and PROD, with approvals and governance. Every view in today's SPA
keeps working (§14). Scope limits are stated where the feature they bound is described, and the ones still undecided are collected in §18.

Three constraints drive the design: **few external dependencies**, **keep it simple**,
**lose no user-facing capability**.

Four facts about the estate and the deployment:

- **The data plane always runs behind a TLS-terminating reverse proxy** (F5 or nginx) that
  also does edge rate limiting and HTTP hardening. We build none of that, and do not use
  Envoy or xDS (§8.1).
- **Half the estate is SOAP, half is JSON REST.** All new APIs are REST; SOAP will take years
  to retire. Both are first-class for the life of this system and have different validation
  economics (§5.1).
- **This is an internal platform.** No metering, no billing, no consumer usage analytics.
  Gateways emit OTEL telemetry to the internal ELK, and that is the reporting surface (§13).
  Per-subscription rate limits and quotas are enforced approximately, for enforcement only
  (§5.7). No component needs a shared cache (§8.5).
- **Authorization is flat.** Roles come from the corporate IdP over OIDC. Preauthorized users
  act on behalf of their own application; a few admins can do everything (§9).

Two defaults are safe rather than convenient, and both are downgradeable only by an explicit,
dated, audited act: **request validation blocks** (§5.1) and **backend TLS certificates are
verified** (§5.4).

---

## 1. The one idea

Today the portal is a remote control for Azure APIM's management API. It reads from APIM's
eventually-consistent indexes, so it needs a tag-versioned cache, scheduled re-invalidation
and read-your-writes scaffolding. It has no artifact describing "this API, revision 7", so
promotion is a replay of mutations across three tenants with partial-failure summaries.

Invert it:

> **The portal owns the desired state. A reconciler converges each environment toward it.
> Gateways are projections, never sources of truth.**

Reads come from a local transactional store, so the cache tier and its invalidation taxonomy
stop existing. Promotion becomes "release revision 7 to TEST". Rollback becomes "release
revision 6". Drift — someone edited a gateway directly — becomes a reported, reconcilable
fact.

APIM remains eventually consistent, so the reconciler still needs a settle window and a
last-applied digest (§7). That is confined to one place instead of spread across the read
path.

Because gateways are projections behind one adapter contract, our own gateway is another
adapter (§8).

## 2. Dependency budget

Two runtimes. `node:sqlite` means owning state costs no dependency; Go means a streaming
reverse proxy costs no dependency (§8.2).

### Control plane — Node 24+ / TypeScript

| Layer | What we use | Deps |
|---|---|---|
| Store | `node:sqlite` (one file, WAL) | **0** |
| HTTP server | `node:http` + ~120-line router | **0** |
| Hashing, encryption, cert parsing | `node:crypto`, `node:x509` | **0** |
| Tests | `node:test` | **0** |
| Telemetry | OTLP/HTTP via `fetch` | **0** |
| OpenAPI/AsyncAPI/WSDL in YAML | `yaml` | **1** |
| OIDC + JWT/JWKS verification | `jose` | **1** |
| JSON Schema validation (policy, specs, config) | `ajv` | **1** |
| Postgres store (phase 4, if HA is required) | `pg` | +1 |
| Frontend | React + Vite + TypeScript | 3 (dev-time) |

**Runtime dependencies: three.** No Express, no session middleware, no Redis, no ORM, no
Azure SDK, no App Insights SDK, no logging library, no test framework. Azure ARM, SendGrid,
Elasticsearch and Kafka Admin are reached with `fetch` over their HTTP APIs, as today.

### Data plane — Go

| Layer | What we use | Deps |
|---|---|---|
| HTTP server + streaming reverse proxy | `net/http`, `net/http/httputil` | **0** |
| Backend TLS verification, mTLS, cert parsing | `crypto/tls`, `crypto/x509` | **0** |
| Routing trie, policy pipeline, config poller | stdlib | **0** |
| Tests | `testing`, `net/http/httptest` | **0** |
| JWT + JWKS cache and rotation | `lestrrat-go/jwx` | **1** |
| JSON Schema validation | `santhosh-tekuri/jsonschema` | **1** |
| XSD validation (SOAP) | libxml2 binding, cgo | **1** + a C library |
| OTEL traces/metrics/logs | OpenTelemetry Go SDK | **1** (large transitive tree) |

**Direct dependencies: four.** Notes on the two that cost something:

- **libxml2** is unavoidable: there is no serious pure-Go XSD validator. Each cgo call
  occupies an OS thread for its duration. On the `warning` path that is bounded by the
  validation pool's semaphore (§8.4); on the `blocking` path by in-flight blocking requests,
  which `BLOCKING_BUFFER_BUDGET_BYTES` and the load budget (§13) size.
- **The OTel Go SDK** brings a large transitive tree. A span per request with context
  propagation, batching and export retry is what it does well, and the data plane carries all
  the traffic. The control plane emits OTLP by hand instead, because it emits a handful of
  metrics rather than a span per request.

### Notes on the choices

- **Dropping Express** works because we use almost none of it; the current server hand-rolls
  its security headers already. A router over `node:http` is ~120 lines and removes the
  middleware-ordering hazard — today's ordering of cache-invalidation → audit → auth →
  refresh → CSRF is significant and documented only in comments.
- **`jose` / `jwx`** cover alg allowlisting, `kid` handling, JWKS cache and rotation, clock
  skew, `aud`/`iss`/`azp`, PKCE verifier binding and ID-token/access-token separation.
  Hand-rolling that trades an audited implementation for an unaudited one.
- **`ajv`** validates owner-authored policy JSON, uploaded specs and both config files (§11).
  An `ajv`-compiled OpenAPI meta-schema makes spec structural validation free.
- **`node:sqlite`** must be verified against the exact Node minor before committing,
  including that `backup()` is available (§13). `better-sqlite3` is a drop-in
  one-dependency fallback with the same synchronous API shape.
- **Infrastructure is not a dependency.** The reverse proxy is a deployment fact, not a
  package, and leaning on it is what keeps the data plane a few thousand lines instead of a
  hardened reverse proxy we maintain.

## 3. Shape

Two deployables, two runtimes. One SQLite file. One static bundle.

```
                   Browser (React SPA)
                         │ /api  (same origin)
        ┌────────────────▼─────────────────────────────┐
        │  CONTROL PLANE — Node/TS  (one host, §13)    │
        │  ┌────────┐  ┌───────────┐  ┌─────────────┐  │
        │  │  HTTP  │  │ reconciler│  │ job runner  │  │
        │  │  API   │  │  (loop)   │  │  (queue)    │  │
        │  └───┬────┘  └─────┬─────┘  └──────┬──────┘  │
        │      └─────────────┴───────────────┘         │
        │                  SQLite                      │
        └───────┬───────────────────────┬──────────────┘
                │ adapters (fetch)      │ config + artifact pull
     ┌──────────┼──────────┬────────┐   │ (ETag, fail-static, §8.5/§8.7)
     ▼          ▼          ▼        ▼   │
 Azure APIM  Confluent  SkoNet ·  LDAP  │ ┌──────────────────────────────────────┐
 (ARM, §16)  REST Proxy LeanIX ·  ES    │ │ F5 / nginx ── TLS, SNI, edge rate    │
             + Schema   SendGrid        │ │  limit, HTTP hardening, client-cert  │
             Registry                   │ │               │                      │
             (§8.8)                     └─┤   ┌───────────▼──────────────────┐   │
   (control plane always verifies TLS,     │   │  DATA PLANE — Go  (N×)       │   │
    no exceptions — §5.4)                  │   │  route · auth · rate/quota · │   │
                                           │   │  policy · blocking valid. ·  │   │
                                           │   │  proxy (streaming, §5.8)     │   │
                                           │   │      │ tee (warning mode)    │   │
                                           │   │  ┌───▼──────────────┐        │   │
                                           │   │  │ validation pool  │        │   │
                                           │   │  │ (bounded, async) │        │   │
                                           │   │  └──────────────────┘        │   │
                                           │   │  ┌──────────────────────────┐│   │
                                           │   │  │ persisted volume:        ││   │
                                           │   │  │ config + artifacts +     ││   │
                                           │   │  │ client keys (§8.7)       ││   │
                                           │   │  └──────────────────────────┘│   │
                                           │   └───────────┬──────────────────┘   │
                                           └───────────────┼──────────────────────┘
                                                           ▼  backends
                                                 (verified TLS by default — §5.4)
                                                    OTLP → internal ELK
```

Kafka has no data plane of its own: `kafka-topic` is reconciled from the control plane
straight into Confluent REST Proxy (§8.8).

The reconciler and job runner are the control-plane binary with a flag, so a small deployment
runs one process and a larger one runs three. Nothing in the HTTP API does long work. All
three share one SQLite file and therefore one host (§13); data-plane availability does not
depend on it (§8.5).

## 4. Data model

Twenty-seven tables. **Everything publishable is one `resource` table with a `kind`** — they
share ownership, versioning, release, subscription and approval semantics, where today each
has its own routes, views and edge cases.

```sql
-- identity, all of authorization (§9)
team(id, name, source_group)                  -- synced from IdP groups
membership(team_id, user_id)                  -- membership only; roles come from the IdP
service_token(id, team_id, name, secret_hash, created_at, last_used_at, revoked_at)
session(id, user_id, roles_json, teams_json, created_at, idle_until,
        expires_at, revoked_at)               -- survives restart

-- the publishable thing
resource(id, kind, name, team_id, api_version, lifecycle, sunset_at,
         derived_from, created_at, …)          -- derived_from: a kafka-topic (§8.10)
revision(id, resource_id, rev, model, original, original_format,
         version_digest, artifact_digest, frozen_at, pruned_at,
         created_by, created_at)               -- the CONTRACT only; promoted (§4.1, §6)
artifact(digest, kind, bytes, size_bytes, created_at)  -- content-addressed (§8.7)
policy_entry(resource_id, environment, unit_key, value_json, origin,
             seeded_from_env, seeded_at, updated_by, updated_at)
                                               -- one row per policy per env (§5, §6.3):
                                               -- row exists = policy attached;
                                               -- value_json = its values
route(resource_id, environment, host, base_path)   -- UNIQUE(environment, host, base_path)
binding(resource_id, environment, backend_json)    -- per-env backend pool + client certs
tls_exception(id, resource_id, environment, backend_url, mode, pin_thumbprint,
              pin_ca_ref, reason, created_by, created_at, expires_at,
              revoked_at)                     -- admin-only, dated (§5.4)
announcement(id, resource_id, product_id, severity, title, body, sunset_at,
             created_by, created_at, notified_at)   -- change reaches consumers (§4.2)

-- the consumable thing
product(id, name, team_id, lifecycle, terms)       -- the subscription unit
product_member(product_id, resource_id)
application(id, name, team_id, oauth_client_id, created_at)   -- holds credentials
subscription(id, product_id, application_id, environment, state, role,
             primary_key_enc, secondary_key_enc, key_rotated_at,
             provisioned_json, approval_id)    -- role/provisioned_json: Kafka only (§8.8)

-- promotion
release(id, resource_id, revision_id, environment, state, reason,
        version_digest, plan_id, released_by, released_at)
release_plan(id, computed_at, computed_by, plan_json, plan_digest)
applied(target_id, resource_id, revision_id, applied_digest, compiler_version,
        applied_at)                            -- what the target actually has
approval(id, subject_type, subject_id, state, requested_by, requested_at,
         approver, decided_at, justification, external_ref)

-- targets and fleet
target(id, environment, adapter, config_json, enforce, paused)
                                               -- UNIQUE(environment, adapter): an env may
                                               -- have both an HTTP and a kafka target
gateway_instance(id, target_id, name, token_hash, config_digest, last_seen_at,
                 revoked_at)                   -- standalone data-plane fleet
external_id(target_id, resource_id, revision_id, adapter_key)   -- our id ↔ theirs
certificate(id, team_id, environment, name, cert_pem, chain_pem, key_enc,
            thumbprint, subject, not_after, usage, created_by, created_at)
                                               -- client identities, private keys (§4.3)

-- operations
usage_counter(subscription_id, environment, scope_kind, scope_id, window_kind,
              window_start, count, updated_at)   -- fleet quota aggregate (§5.7)
job(id, kind, state, payload, idempotency_key, attempts, result, created_at)
drift(target_id, resource_id, kind, detail, observed_at, acknowledged_at)
audit(id, at, actor, action, subject, outcome, detail)   -- append-only
```

### Notes on the schema

- **`resource.api_version` vs `revision.rev`.** `api_version` is consumer-visible (it appears
  in `route.base_path` or a version header) and changes when the contract changes. `rev` is
  internal and increments on every edit. A revision freezes on its first release to any
  environment; iterating means a new revision, not a new API version.
- **`route` carries `UNIQUE(environment, host, base_path)`.** Frontend routing is a row with
  a constraint, not an implication of the OpenAPI `servers` block. Without it, two teams can
  collide and routing becomes order-dependent.
- **`revision` holds the contract only** (§4.1). `model` is the normalized representation,
  `original` the byte-for-byte upload kept for provenance, and
  `version_digest = hash(model)`, so reformatting an upload does not churn the digest.
  `release` records that digest.
- **Policy is per environment, per policy, in the same tier as `binding`.** The contract is
  promoted; policy, backends, routes and certificates are edited directly (§6.1). A frozen
  artifact cannot hold a value that is expected to change in PROD.
- **`policy_entry` is one row per policy, not one blob per environment.** The row's existence
  is the policy; `value_json` is its values. This is what makes §6.3's per-policy merge
  expressible. `origin` (`seeded` | `local`) and `seeded_from_env` record where a policy came
  from and whether anyone has since edited it.
- **`artifact` is content-addressed and immutable.** Compiled validation bundles — JSON Schema
  for REST, XSD sets for SOAP, Avro/Protobuf/JSON for Kafka — are derived from `model` at
  release and shipped to the data plane separately from config (§8.7). Immutable means never
  invalidated, only evicted.
- **`applied` carries a separate digest.** `applied_digest = hash(rendered_output,
  compiler_version)`. One digest cannot do both jobs: changing the JSON→APIM-XML compiler
  changes every rendered output while every `version_digest` stays identical, causing either
  missed updates or fleet-wide churn.
- **`product` is the subscription unit; `application` holds the credentials.** A consumer
  registers one application and subscribes it to many products; keys and the OAuth client
  identity live on the application's subscriptions. There is **no plan/tier entity** — tiers
  exist to price and meter differentiated quota, and we do neither (§5.7).
- **`tls_exception` is its own table, admin-written, always with an expiry.** In
  `binding.backend_json` it would be owner-writable, invisible to "list every unverified
  backend", and permanent by default (§5.4).
- **`external_id`** maps our resource and revision to whatever the target calls them (APIM api
  id, revision, product id), so the reconciler does not re-derive identity from names.
- **`target.enforce` / `target.paused`** decide whether the reconciler corrects drift or only
  reports it (§7), per target.
- **`subscription.*_enc` and `certificate.key_enc`** are encrypted with a KEK from Key Vault.
  The portal is the system of record for consumer keys (§16) and backend client identities
  (§4.3), and backups are file copies (§13).
- **`subscription.role` and `provisioned_json` are kind-specific and nullable.** An HTTP
  subscription has neither. A Kafka subscription has `role` (`producer`|`consumer`|`both`),
  which determines the ACL set, and `provisioned_json`, which records the consumer group and
  principal the reconciler created (§8.8).
- **`audit` is append-only by trigger.** SQLite has no grants, so `BEFORE UPDATE` and
  `BEFORE DELETE` triggers `RAISE(ABORT)`. Retention is export to cold storage, then prune by
  a job that is the one thing allowed to drop the trigger, inside a transaction, logged.

`key_rotated_at` is a column; today it is a subsystem with two storage modes because the
portal had nowhere to put it.

### 4.1 Specs are normalized on import, reconstructed on export

Uploaded definitions are parsed into one internal model, and everything downstream reads the
model. This applies equally to OpenAPI and WSDL.

The model carries operations (method, path template, SOAPAction where applicable), parameters
and their locations, request and response schemas, security requirements, declared servers,
and SOAP binding details. From it we derive routing tables, per-operation policy resolution,
the validation artifacts of §8.7, and the search index.

- **One code path.** Routing, validation and policy do not care whether an API arrived as
  OpenAPI 3.0, 3.1, WSDL 1.1 or AsyncAPI. Dialect differences — notably OAS 3.1's move to JSON
  Schema 2020-12 — resolve once, at normalization.
- **Structural diffs between revisions.** "rev 7 adds `GET /orders/{id}` and removes field
  `customerRef`" is computable, which is what makes §4.2's announcements auto-draftable.
- **Export is generation.** `GET /api/revisions/:id/spec?format=openapi-3.1` renders from the
  model. A contract can therefore exist with no upload: a `kafka` variant's OpenAPI is
  generated from a topic schema (§8.10).
- **Compiled artifacts** are a pure function of the model, so their digests are stable and
  cacheable (§8.7).

**Export is not byte-identical to import.** Normalization is lossy for vendor extensions,
`$ref` structure, description formatting, examples and some OAS 3.1 constructs. `original` is
kept verbatim and downloadable beside the regenerated export, and the UI labels which is
which.

**Revision content is pruned; revision history is not.** Keep at most **5 revisions** per
resource and at most **1 year**, whichever is tighter, with three exceptions:

- Never prune a revision **currently released** to any environment, at any age.
- Never prune the **previous released revision** per environment — the rollback target (§6).
- Never prune a revision referenced by an **open release plan or undecided approval**.

Pruning drops `model`, `original` and the derived `artifact` rows, and keeps the `revision`
row as a tombstone (`pruned_at` set; id, `rev`, digests, author and timestamps intact) so
`release` foreign keys and audit trails survive. A pruned revision cannot be released and the
UI reports `pruned`. `artifact` rows are reference-counted and dropped only when nothing
references them, so two revisions with an unchanged schema share one bundle.

The bound is `released revisions per environment + max(5 recent, 1 year)` per resource. A
prune job (§10) runs on a schedule and reports what it removed.

### 4.2 How change reaches consumers

There is no lifecycle state machine. `resource.lifecycle` is a three-value flag —
`active` | `deprecated` | `retired` — with an optional `sunset_at`. `deprecated` is advisory
and shown in the portal; `retired` additionally blocks *new* subscriptions while leaving
existing ones working. No enforced transitions, no approval gates. When lifecycle or
`sunset_at` is set, the gateway emits `Deprecation` and `Sunset` response headers.

`announcement` is the mechanism. A publisher posts one against a resource or product; it
appears on the API page and on every subscriber's dashboard, and a job (§10) emails the
resolved recipient set:

```
subscription → application → team → team.source_group → LDAP/IdP group → member emails
```

A release can auto-generate a draft announcement whose body is the structural diff from §4.1;
the publisher edits and sends. `severity` (`info` | `breaking` | `security`) decides whether
it is an inline notice or an email.

### 4.3 `certificate` is generic client-identity storage

One table for certificates *we present*, with their private keys, used in two places:
`binding`'s backend mTLS client certificate (§5.3) and the API and Kafka playgrounds (§14).
`usage` records which.

- **Private keys are encrypted with the KEK.** A PFX may be uploaded with its passphrase; the
  passphrase is used once to extract and never stored.
- **Owned by a team, scoped to an environment.** `can()` is unchanged: a team's certificates
  are usable only in that team's bindings and playground calls.
- **Distinct from trust anchors.** Inbound client CAs and the reverse proxy's client-CA bundle
  are admin-registered in `INTEGRATIONS_FILE` (§5.3, §5.6) and contain no secrets. This table
  contains secrets.
- **"Renewal as a job" is expiry monitoring and notification**, not issuance. A job watches
  `not_after` and notifies the owning team and admins. Automated issuance needs an ACME or
  internal-CA integration and is out of scope (§18).

### 4.4 One spine, many API variants

`kind` selects which *variant* of an API is being created. The spine is identical across
variants: ownership by team, revisions, releases and rollback, routes, products,
subscriptions, approvals, policy, validation, telemetry, drift, audit. A variant contributes
only its specifics — how its contract is authored, its request shape, and which policy subsets
apply. Adding GraphQL later touches nothing else.

**API variants** — what a publisher picks, and what consumers browse and subscribe to:

| Variant | Contract comes from | Request shape | Validation default | Notes |
|---|---|---|---|---|
| `rest` | uploaded OpenAPI | request/response | `blocking` | the common case |
| `soap` | uploaded WSDL + XSD | request/response | `blocking` | SOAP Fault errors, SOAPAction routing (§5.1) |
| `kafka` | **generated** from a topic's schema | produce (fire-and-forget) | `blocking` | backend is the shared `kafka-proxy` (§8.10) |
| `websocket` | uploaded or declared | long-lived, bidirectional | `disabled` | opaque after upgrade (§5.8) |
| `mcp` | uploaded or declared | tool/resource calls | `blocking` | |
| `a2a` | uploaded or declared | agent messages | `blocking` | |
| `graphql` | *reserved* | single endpoint, query body | — | not designed (§18) |

**Managed resources** — owned and published by teams, not called through the gateway:

| Kind | Served by | Revisions | Release | Rollback | Subscription |
|---|---|---|---|---|---|
| `kafka-topic` | `kafka` adapter, control plane only | ✓ | ✓ (config + schema apply) | — | ACL + consumer group |

**Platform-owned** — infrastructure modelled as a resource, so it gets the same versioning,
release and audit:

| Kind | Owner | Notes |
|---|---|---|
| `kafka-proxy` | APIM team | One per environment. Resolves the caller's Kafka principal from its client certificate, checks cluster ACLs, builds the REST Proxy envelope (§8.9). No consumer subscribes to it. |

- Validation defaults to `blocking` for every request/response variant, including SOAP.
  Downgrading is a per-route, reasoned, audited act (§5.1). `websocket` is `disabled`
  structurally — there is no complete message to validate.
- `kafka` is a consumer-facing variant; `kafka-topic` and `kafka-proxy` are not. The three sit
  at different layers of the same chain (§8.9).
- Rollback exists for every variant except `kafka-topic`: partitions, retention and registered
  schemas move forward only, so `POST /releases` on a topic applies config and the UI says so.

`mcp`, `a2a` and `websocket` have views in today's portal (§14) and are parity work; they ship
in phase 3 with the other variants. `graphql` is reserved with nothing behind it.

The variant set is closed and extended by reviewed work in the codebase, not by configuration:
a variant carries a request shape and a validation model, which is more than a config file
should be able to introduce. Adapters (§8) are compiled in for the same reason.

## 5. Policy: a closed, declarative vocabulary

Owner-authored policy is not a programming language: no expressions, no XML, no
`send-request`, no arbitrary `base-url`, and no URL an owner writes is fetched without passing
the egress allowlist (§5.3). It is JSON validated against a fixed schema.

Policy is **per environment and edited directly** (§6.1) — it lives in `policy_entry` beside
`binding`, not on the frozen revision, so a limit or a CORS origin can change in PROD without
a release.

### A policy and its values are different things

The document reads as one object but is stored and promoted as **a set of independent
policies**:

> Whether a policy is attached is one fact. What its values are is another.

The schema marks certain nodes as **policy units**. A unit is the smallest thing that can
independently exist or be absent. Everything beneath a unit is its values and moves as one
piece — half a `rateLimit` is never merged.

| Unit | Values, not units |
|---|---|
| `auth.subscriptionKey`, `auth.basic`, `auth.jwt`, `auth.introspection`, `auth.mtls` | `jwt.audience`, `mtls.allowedSubjectCns`, … |
| `validate`, `rateLimit`, `quota`, `cors`, `cache`, `retries`, `circuitBreaker`, `ipAllow`, `timeoutMs`, `errorFormat`, `passthrough` | their fields |
| `rewrite`, `transform`, `headers.request`, `headers.response`, `preconditions`, `backendAuth`, `kafka` | their contents, including whole arrays |
| `operations[<op>].<unit>` — a per-operation override is its own unit | its fields |

`auth` is not a unit but each authentication method is: "this route validates JWTs" and "this
route accepts a subscription key" are separately true or false. `preconditions` is a single
unit despite being a list, because the order is semantic (§5.6) and positional merging would
produce a sequence neither environment authored.

The assembled document is validated against the full schema however it was produced —
authored, edited, or merged during a promotion (§6.3). Per-unit assembly can produce
combinations neither environment had, and cross-unit constraints such as §5.8's streaming
exclusions still hold.

### The vocabulary

Every expression-language policy in the current estate is a *named scheme with parameters* —
HMAC request signing, OAuth2 client-credentials with token caching, a static shared secret,
certificate allowlisting, header preconditions. §5.5 and §5.6 are where they land.

```json
{
  "auth": {
    "subscriptionKey": { "in": "header", "name": "X-Api-Key" },
    "basic":  { "credentialRef": "transport-kvasiny", "realm": "…" },
    "jwt":    { "issuerRef": "vwidp-dev", "headerName": "Authorization",
                "scheme": "Bearer", "audience": "…",
                "scopeMap": { "GET /orders": ["orders.read"] } },
    "introspection": { "issuerRef": "azure-ad" },
    "mtls":   { "caRef": "ca-partner-3",
                "allowedIssuers": ["CN=CA Partner 3 Skoda Auto, O=SKODA AUTO a.s., C=CZ"],
                "allowedSubjectCns": ["SAFMEC9"],
                "allowedSans": ["…"],
                "acknowledgeCnOnly": false },
    "forwardCredentials": false
  },

  "preconditions": [                                        // §5.6
    { "requireHeader": { "name": "traceparent",
                         "pattern": "^[0-9a-f]{2}-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$" },
      "deny": { "status": 400,
                "reason": "Bad request - Missing or invalid traceparent http header",
                "body": { "statusCode": 400, "message": "…" } } }
  ],

  "validate":   { "…": "see §5.1" },

  "rewrite":    { "stripBasePath": true, "path": "/{vin}/description",
                  "copyUnmatchedParams": true,
                  "query": { "set": { "v": "2" }, "remove": ["debug"] } },

  "headers": {
    "request":  { "remove": ["Content-Type", "X-SA-user", "X-SA-LDAP-user"],
                  "set":    { "Accept": "application/json",
                              "SubscriptionName": "${subscription.name}",
                              "SubscriptionId":   "${subscription.id}" },
                  "append": { "X-Forwarded-Path": "${route.basePath}" },
                  "skip":   { "X-Trace": "${trace.id}" } },
    "response": { "set": {}, "remove": [] }
  },

  "backendAuth": { "type": "oauth2-client-credentials",     // §5.5
                   "tokenProviderRef": "leanix-pathfinder",
                   "invalidateOnStatus": [401, 403] },

  "transform":  { "request": "none", "response": "soap-to-json" },
  "cors":       { "origins": ["…"], "methods": ["GET"], "maxAgeSec": 600 },
  "timeoutMs":  30000,
  "retries":    { "attempts": 2, "on": ["502", "503", "timeout"],
                  "idempotentOnly": true },
  "circuitBreaker": { "failures": 5, "windowSec": 60, "openSec": 30 },
  "ipAllow":    ["10.0.0.0/8"],

  "cache":      { "ttlSec": 3600, "vary": ["Accept"],
                  "varyBySubscription": false,
                  "mustRevalidate": true,
                  "downstream": "public" | "private" | "none" },

  "passthrough": { "websocket": false, "sse": false,        // §5.8
                   "streamIdleTimeoutSec": 300,
                   "maxConnectionSec": 3600,
                   "maxConcurrentConnections": 50,
                   "maxBytesPerConnection": 0 },
  "errorFormat": "problem+json" | "soap-fault",

  "rateLimit":  { "calls": 100, "periodSec": 60, "per": "instance",
                  "by": "subscription", "scope": "route" | "product",
                  "emitHeaders": true },
  "quota":      { "calls": 100000, "periodSec": 2592000, "per": "fleet",
                  "by": "subscription", "scope": "product" }
}
```

`headers.request` carries the four `exists-action` behaviours by name: `remove` (delete),
`set` (override), `append`, and `skip` (set only if absent). They apply in that fixed order.
Header names are matched case-insensitively.

`auth.forwardCredentials` defaults to false: the subscription key header and the inbound
`Authorization` are stripped before the request reaches the backend unless a route opts in.

`rateLimit` and `quota` are enforced by both adapters, per subscription key. `apim` compiles
them; `standalone` enforces `rateLimit` per instance with no coordination and `quota`
fleet-wide via the config poll (§5.7).

`operations[]` may override `auth`, `validate`, `rateLimit`, `timeoutMs` and `cacheTtlSec` per
operation, since auth and limits routinely differ between `GET /orders` and
`DELETE /orders/{id}`.

`errorFormat` is derived from `kind` by default. A validation rejection on a `soap` route must
be a SOAP Fault with the correct envelope and namespace; older generated stubs choke on an
HTTP 400 carrying a JSON body.

### 5.1 Validation: three states, blocking by default

Per route and per operation:

```json
"validate": {
  "request":  "blocking" | "warning" | "disabled",   // default: blocking
  "response": "blocking" | "warning" | "disabled",   // default: disabled
  "downgradeReason": "…",          // REQUIRED when request != "blocking"

  "always": {
    "contentType": ["application/soap+xml", "text/xml"],
    "maxBodyBytes": 8388608,
    "maxDepth": 32,
    "json": { "maxArrayLength": 10000, "duplicateKeys": "reject" },
    "xml":  { "dtd": "reject", "externalEntities": "reject",
              "entityExpansion": "reject", "maxElements": 100000,
              "soapActionMustMatchBody": true }
  },

  "sample": { "alwaysUnderBytes": 65536, "rate": 0.1,
              "coldStart": 20, "onFailureEscalateSec": 300,
              "key": ["operation", "subscription"] },   // warning mode only

  "async": true,
  "maxConcurrent": 8,
  "onSaturated": "skip",
  "logEvents": { "includeBodyExcerptBytes": 0 }
}
```

**`blocking`** — the default. Validates every request against the revision's schema and
rejects on failure, shaped by `errorFormat`. Deterministic. Buffers the body up to
`maxBodyBytes` before forwarding.

**`warning`** — never rejects. The body is tee'd, the request proceeds immediately, and
validation runs in the bounded async pool (§8.4), contributing zero request latency with CPU
capped by `maxConcurrent`. Sampling applies. This is the mode for large SOAP envelopes.

**`disabled`** — no schema validation. The `always` block still applies.

`blocking` is the enforcing mode, and the only one. `warning` is an observation: sampled,
asynchronous, and it never rejects, so it must not be read as a gateway-enforced control in a
security review or an audit. The `always` block below *is* enforced on every request in all
three states.

Both enabled states emit an OTEL log record correlated to the request span:

```
event      validation.failed
mode       blocking | warning
outcome    rejected | observed
resource · revision · operation · environment · route
application · subscription · consumer team
schema     request | response
errors[]   { path, rule, message }
bodyBytes · durationMs · sampled
```

The payload is not included. `logEvents.includeBodyExcerptBytes` defaults to 0 and its ceiling
is admin config: XSD errors are hard to diagnose without a fragment, and bodies routinely
carry personal data and credentials. Blocking rejections set the span status to error and
increment a counter; warning failures increment a separate counter, because "we rejected
traffic" and "we observed non-conforming traffic" are different signals.

**Sampling exists only in `warning` mode.** A `sample` block with `request: "blocking"` is a
schema error at write time. Sampling plus rejecting would make the same payload succeed or
fail depending on where a counter landed, so callers could not retry and reports could not be
reproduced. Sampling is also not a security control on its own — an adversary sends one
conforming message followed by nine that are not. Against a consistently broken client, ten
percent catches it within a handful of requests.

Four rules shape the sampling:

- **Gate on cost.** `alwaysUnderBytes` validates everything below a threshold, since sampling
  something that costs microseconds saves nothing.
- **Cold-start burst.** The first `coldStart` requests for a newly seen key are always
  validated, then decay to `rate`. Re-armed by a new revision, a new subscription, or a config
  change.
- **Sticky escalation.** A failed sample raises that key to 100% for `onFailureEscalateSec`.
- **Deterministic, not counted.** The decision is `hash(key, request_id) < rate`, so it needs
  no per-instance counter and no eviction table and behaves consistently across the fleet.

**The key is `(operation, subscription)`** — the matched OpenAPI or WSDL operation for the
resolved revision, plus the consuming application's subscription. Keying on URL, query,
headers and client IP does not predict body conformance (that follows the client's code
version, not its metadata), and its cardinality is near-unique per request once `traceparent`
and `User-Agent` are included. `(operation, subscription)` is bounded by operations × active
subscriptions and is the grain at which "whose client broke" is answerable.

**The `always` block is outside the three-state switch.** No setting turns these off:

- **Content-Type allowlist and `maxBodyBytes`**, checked at header time from `Content-Length`
  and enforced while streaming, in every state including `disabled`. Over the cap is `413` (or
  a SOAP Fault), never a validation attempt.
- **`soapActionMustMatchBody`** for `soap`, in every state — SOAPAction spoofing is a routing
  and authorization bypass. Implemented as a hardened, bounded prefix scan of the first 8 KB
  to read the first child element of `Body`. The same scan resolves the operation for
  per-operation SOAP policy.
- **XML parser hardening** — DTDs rejected, external entities rejected, entity expansion and
  element count bounded, depth capped. Parser configuration, applied wherever XML is parsed:
  blocking validation, the warning pool, and `transform`. `disabled` does not weaken it; it
  means nothing parses.
- **JSON depth, array length, duplicate-key policy**, wherever JSON is parsed.

**Blocking is the default for SOAP too**, which means buffering the envelope and running
synchronous XSD validation on the request path. The per-instance memory ceiling is
`maxBodyBytes × in-flight blocking requests`, bounded by `BLOCKING_BUFFER_BUDGET_BYTES` (§11)
and accounted for in the load budget (§13). Owners of large-envelope SOAP APIs will need
`warning`, and that is visible:

- `downgradeReason` is required by schema whenever `request != "blocking"`.
- The downgrade records an `audit` row with actor, route, old and new state.
- `GET /api/validation/downgrades` lists every route in the estate that is not blocking, with
  reason, actor and date.

### 5.2 Pipeline order is part of the contract

A flat JSON object means the engine's order is fixed, and the order is a compatibility
promise:

```
 1  route match                       (host + base_path + method + path template)
 2  trusted-proxy context             (client IP, verified client cert — §8.1)
 3  always-on limits                  (content-type, Content-Length cap)
 4  ipAllow
 5  CORS preflight short-circuit
 6  authenticate                      (subscription key | basic | JWT | introspection | mTLS)
 7  authorize                         (subscription active, product contains resource, scope)
 8  rate limit                        (§5.7 — per-instance counter, 429 + Retry-After)
 9  quota                             (§5.7 — local delta + last fleet aggregate, 403)
10  preconditions                     (ordered deny rules — §5.6)
11  SOAP prefix scan                  (operation resolution + SOAPAction match, bounded)
12  request validation                (BLOCKING only — buffer, validate, reject)
13  rewrite                           (path, query)
14  request headers                   (remove → set → append → skip; credential strip)
15  request body transform
16  cache lookup                      (key = route + method + path + vary)
17  backend select                    (pool, load balance, failover, backend TLS + mTLS)
18  backend auth                      (§5.5 — inject credential; cached token or signature)
19  proxy                             (timeout, retry, circuit breaker, stream)
20  response body transform
21  response headers + CORS headers
22  backend-auth invalidation         (§5.5 — invalidateOnStatus)
23  cache store
24  emit OTEL span + access log (incl. local counter increment)
      └─ WARNING mode: the tee'd body enters the async validation pool here,
         entirely off the request path
      └─ STREAMING (§5.8): a WebSocket route runs 1–14 on the upgrade, then hands the
         connection to a bidirectional copy — 15–23 do not exist for it. An SSE route
         runs 1–19 normally, then streams; 20–23 are skipped on the response side.
```

Two orderings are constraints, not conveniences. Validation and preconditions sit after
authenticate and authorize, so unauthenticated traffic cannot consume validation CPU or
trigger a precondition. Credential stripping (14) precedes backend auth (18), so a route
cannot forward the inbound credential alongside the outbound one.

A `kafka-proxy` route (§8.9) uses this pipeline with three substitutions: step 1 resolves the
target topic, step 7 authorizes against Kafka's ACLs for the calling application's principal,
and step 12 validates against the topic's registered schema.

### 5.3 Three splits keep the server from being pointed anywhere by an author

- **Backends live in `binding`**, per environment, never in policy. `binding` holds a pool:
  one or more backend URLs, a load-balancing rule (`round-robin` | `failover`), health-check
  settings, and an optional client-cert reference for mTLS to the backend. Backend
  server-certificate verification is not in `binding` (§5.4).
- **Bindings are checked against an admin-registered egress allowlist.** Moving the URL to
  another table does not close SSRF — the owner still writes it and the gateway still fetches
  it. `INTEGRATIONS_FILE` carries an allowlist of host patterns, CIDRs, ports and schemes; a
  binding that does not match is rejected at write time; DNS is resolved and pinned per
  request against rebinding; link-local and cloud-metadata ranges are denied; redirects are
  never followed. The same rule makes `POST /api/playground` safe.
- **Issuers and client CAs are admin-registered** (`INTEGRATIONS_FILE`) and referenced by
  name. `issuerRef` resolves to a vetted JWKS URL; `caRef` to a pinned CA plus SAN matching.
- **Uploaded specs must be self-contained.** `$ref` is resolved within the document only;
  remote and `file://` refs are rejected at upload, along with bodies over a configured size.
  This extends to WSDL: `wsdl:import`, `xs:import` and `xs:include` pointing anywhere remote
  are rejected. A remote XSD import is both an SSRF vector and an availability dependency on
  someone else's web server at validation time.

The `apim` adapter compiles this JSON into APIM policy XML. We generate that XML and never
evaluate it, which is why §15 deletes the expression sandbox, the Liquid engine, the policy
executor and the egress guards.

Import does read existing APIM policy XML in order to translate it (§16), so a parser exists:
an offline one-shot translator on the control plane, never on a request path, absent from the
data plane.

The `standalone` adapter interprets the same JSON directly, in the order above.

**Extending the vocabulary is an admin-reviewed change to the codebase**: a new policy unit or
`backendAuth` scheme, written in Go, tested and shipped. `set-variable`, C# interpolation,
`send-request` to an owner-written URL and the `cache-*-value` store have no replacement, in any
form — every use of them in the estate was a named scheme in disguise and is now one (§5.5,
§5.6). The bar is deliberately high: the ~200 KB policy engine this replaces was the source of
every RCE and SSRF finding to date. A handful of exotic Azure policies will need re-expressing
or an extension, and import reports what it cannot map rather than guessing (§16).

### 5.4 Backend TLS: verified by default, exceptions are dated

The data plane verifies the backend server certificate on every request: full chain to the
configured trust store, plus hostname match against the SAN. TLS 1.2 floor, 1.3 preferred;
the cipher policy is fixed and `BACKEND_TLS_MIN_VERSION` can only be raised. No policy field
and no `binding` value disables this.

Verification is relaxed only by an admin-created `tls_exception`, and the options form a
ladder — most requests to "disable TLS validation" are one of the first two rungs:

1. **Register the internal CA.** `INTEGRATIONS_FILE` carries the backend trust bundle
   (`backendCaRefs`). An internal PKI not in the OS store belongs here once, for the estate.
   This is not an exception and should absorb most cases.
2. **Pin a certificate or CA for one backend** — `mode: "pin"` with `pin_thumbprint` or
   `pin_ca_ref`. A self-signed backend becomes verifiable rather than unverified.
3. **Skip hostname verification only** — `mode: "skip-hostname"`. The chain is still verified.
   Covers a certificate issued for the wrong name.
4. **Verify nothing** — `mode: "insecure"`. Last resort, shortest-lived.

Rules:

- **Admin-only.** The one write `can()` does not grant to a resource owner (§9). Its own table
  keeps `can()` unchanged and makes "list every unverified backend in PROD" one query.
- **`expires_at` is mandatory**, bounded by `TLS_EXCEPTION_MAX_DAYS`. There is no
  renew-in-place: extending means a new row with a new reason.
- **`reason` is mandatory**, and surfaced everywhere the exception is.
- **`backend_url` is nullable.** Null means every backend in that binding's pool; a value
  means exactly that one.
- **The data plane self-expires.** The config carries `expires_at` and the instance stops
  honouring the exception at that timestamp even with the control plane unreachable. Without
  it, fail-static config (§8.5) would hold an exception open through a CP outage.
- **Loud while it exists.** Every request through an exception sets a span attribute and
  increments a counter; the dashboard lists active exceptions with a countdown; creation,
  first use, imminent expiry and expiry each produce a log event and an `audit` row. §13
  alerts on the count and the request rate.
- **Never applies to the control plane.** ARM, SendGrid, Elasticsearch, LDAP, Kafka and JWKS
  fetches always verify. Backend mTLS (§5.3) is unrelated and unaffected.

In Go, TLS config lives on `http.Transport` and Transports own the connection pool, so an
exception means a distinct Transport for that backend. Creating, changing or expiring one must
recycle that pool rather than mutate config under live connections (§8.6).

### 5.5 Named backend-auth schemes

Backends that need a credential are the largest driver of expression-language policy in the
estate, and every instance is one of a handful of schemes. The gateway implements the schemes;
policy selects one by name. `backendAuth` is a discriminated union:

| `type` | Parameters | What it replaces |
|---|---|---|
| `none` | — | default |
| `basic` | `credentialRef` | hand-built `Basic` headers from a named value |
| `api-key` | `credentialRef`, `in`, `name` | `set-header` with a `{{secret}}` |
| `oauth2-client-credentials` | `tokenProviderRef`, `scope?`, `invalidateOnStatus?` | `cache-lookup-value` → `send-request` to a token endpoint → parse JSON → `cache-store-value` → `set-header`, plus `cache-remove-value` on 401/403 |
| `hmac-sa-key-lite` | `appIdRef`, `appKeyRef`, `dateHeader`, `serviceShortcutFrom` | the `SaKeyLite` HMAC-SHA256 canonical-string signer |
| `mtls` | `clientCertRef` (in `binding`, §5.3) | backend client certificate |

`oauth2-client-credentials` differs from the policy it replaces in three ways:

- **Single-flight token fetch.** Concurrent requests on a cold or just-expired cache share one
  fetch. The hand-rolled version stampedes: every in-flight request runs its own
  `send-request`, so a popular API bursts its identity provider on every expiry.
- **Fails closed.** A failed token fetch returns 503 with a retry hint. The hand-rolled
  version uses `ignore-error="true"` and forwards with an empty `Authorization`, turning an
  IdP blip into a backend 401.
- **Token cache TTL is `expires_in` minus a skew**, per `(tokenProviderRef, scope)`, per
  instance, in memory — never in a shared cache (§8.5) and never owner-visible.

`tokenProviderRef` resolves through `INTEGRATIONS_FILE` (§11), which holds the token URL, the
client credential reference, the grant type and the scope. An owner names a provider and never
writes a URL the gateway will call.

`hmac-sa-key-lite` builds the canonical string — method, empty content-type/MD5/date lines,
the `x-sa-date` header, then `/{appId}/{serviceShortcut}{operationTemplate}` — and signs it
HMAC-SHA256 with the base64 app key, emitting `SaKeyLite {appId}:{signature}`. Two differences
from the policy it replaces:

- **The signature is computed per request and never cached**, because it covers a
  second-resolution timestamp. The current policy appears to cache it but does not:
  `cache-lookup-value` writes into a variable named `Authorization` while the `choose` tests
  for a variable named `SaKeyLite`, so the branch always runs and the cache is dead code. The
  API works because of that; repairing the cache would break it.
- **`appIdRef`/`appKeyRef` are per-environment credential references**, resolved from
  `binding`'s environment. The current policy embeds `{{credentials-iasprod-…}}` in the
  artifact, so promoting it signs with production credentials in every environment.

There is **no owner-visible key/value cache**. `cache-lookup-value` / `cache-store-value` /
`cache-remove-value` exist in APIM to hold the output of computation the gateway should have
done itself; every use in the estate is a `backendAuth` token or signature.

### 5.6 Preconditions and the template variable set

`choose` / `when` / `return-response` is used in the estate for one job: reject a request that
fails a check, with a specific response. That is a rule table, expressed as an ordered list of
`{ check, deny }` pairs evaluated at step 10:

| Check | Fields | Replaces |
|---|---|---|
| `requireHeader` | `name`, plus one of `pattern` \| `equals` \| `credentialRef` \| `present` | the `traceparent` regex gate, the shared-secret comparison |
| `requireQuery` | `name`, `pattern` \| `equals` \| `present` | — |
| `requireClientCert` | `issuers[]`, `subjectCns[]`, `sans[]` | the `context.Request.Certificate` chain of `\|\|` |
| `requireOperation` | `methods[]` | ad-hoc method gating |

Each carries `deny: { status, reason, headers, body }`, where `body` is a JSON object or
string rendered with the template variables below. That covers the 400 with a JSON
`{statusCode, message}` payload, the 401 with `WWW-Authenticate: Basic realm="…"`, and the
bare 403 on certificate mismatch.

- **Regexes are RE2.** Go's engine has no backtracking, so catastrophic backtracking cannot
  occur and the `TimeSpan.FromMilliseconds(500)` guard in current policies has nothing to bind
  to.
- **Secret comparison is constant-time.** The current shared-secret check is a `!=` on the
  whole `Authorization` header, which is timing-variable and scheme-sensitive; `auth.basic`
  with a `credentialRef` is the intended expression, and `requireHeader.credentialRef` covers
  a non-standard header.
- **`allowedSubjectCns` may be used alone**, with `acknowledgeCnOnly: true`. CN alone is a
  weaker identity check than CN pinned to an issuer, but the security boundary sits elsewhere:
  chain verification and revocation happen at the reverse proxy (§8.1), and the data plane
  requires a successful verify result before it reads any field. CN-only therefore means
  "anyone holding a certificate with CN=X issued by a CA the reverse proxy trusts for client
  authentication". The control that matters is the breadth of the proxy's client-CA bundle:
  narrow to internal partner CAs, CN-only is sound; wide enough to include a public CA set,
  CN-only is broken regardless of what the gateway does. So:

  - The proxy's client-CA bundle is declared in `INTEGRATIONS_FILE` as `clientCaBundle`,
    admin-maintained and informational, so the blast radius is recorded alongside the policy.
  - `acknowledgeCnOnly: true` is required by schema, so CN-only cannot happen by omission.
  - CN-only routes appear in `GET /api/governance/exceptions` (§14).

**Template variables** are substitution only — no arithmetic, no function calls, no
conditionals, no user-defined variables. `${…}` resolves from a closed set:

```
subscription.id · subscription.name
application.id  · application.name
product.id      · product.name
resource.name   · revision.rev · environment
operation.id    · operation.method · operation.template
route.basePath  · path.<param>  · query.<name>
request.id      · trace.id      · client.ip
jwt.sub         · jwt.claim.<name>
cert.subject.cn · cert.issuer    · cert.thumbprint
now.rfc1123     · now.iso8601    · now.epoch
```

`${subscription.name}` and `${subscription.id}` cover the current `context.Subscription.*`
header policies; `${now.rfc1123}` is the `x-sa-date` value; `${path.vin}` is what a
`rewrite.path` template consumes. Anything not on the list is not expressible, and the list
grows only by admin-reviewed extension.

The current subscription-header policy uses `exists-action="append"`, so a client sending its
own `SubscriptionName` gets both values through to the backend, its own first — a spoofing
vector into any backend that trusts the header. Use `set`.

### 5.7 Rate limiting and quota

Two different problems with two different answers.

#### Rate limit — per instance, no coordination

Its job is to stop abuse and runaway clients, not to meter. Each instance keeps an in-memory
fixed-window counter per `(subscription, scope)` and enforces the configured limit locally, in
full. Nothing is reported, allocated or converged, and an instance enforces correctly on its
first request after boot.

With `N` instances the effective fleet ceiling is `calls × N`. A consumer pinned to one
instance sees exactly `calls`; one spread evenly sees up to `calls × N`. The enforced value
lies in `[calls, calls × N]` depending on how F5 distributes traffic, which is the bound abuse
prevention needs. Fleet-exact limiting would require a shared counter on the request path and
is out of scope; if a route needs an exact ceiling, the edge proxy sees every request at one
point and can enforce one there.

- **The UI does the arithmetic**: "100/min per instance × 6 instances ⇒ up to 600/min
  effective" beside the field. If a backend's capacity is the constraint, set
  `calls = capacity / instances`.
- **Instance count is a deployment property**, so scaling the fleet changes the effective
  ceiling. With a fixed `N` behind F5 that is a non-event; it matters before autoscaling.

`per: "instance"` removes weighted allocation, traffic-share reporting, per-instance
allowances, granularity floors, re-convergence after restart, allowance reclaim from dead
instances, and the failure mode where one instance refuses traffic while fleet allowance sits
unused — the 100/min route that starts refusing at 30/min under uneven balancing.

`X-RateLimit-Remaining` is a local number, which is now the actual semantics.

#### Quota — fleet-wide, aggregated on the poll

A per-instance monthly quota is not a quota: 100 000 calls × 6 instances is 600 000. Quota
keeps `per: "fleet"` and aggregates, which the long window makes easy.

Each instance counts locally per `(subscription, scope, window)`. On each config poll it
reports its delta and receives the fleet aggregate back (§8.5). Enforcement is
`aggregate_at_last_poll + own_delta_since >= calls`. Worst-case overshoot before convergence
is the fleet's traffic in one poll interval. No shared datastore, no protocol, one arithmetic
sum on the control plane.

#### Shared behaviour

**Scope.** `scope: "route"` counts per `(subscription, route)`. `scope: "product"` counts per
`(subscription, product)` across every API in that product, which is what APIM product-level
quotas mean and what import must preserve. The counter key carries the scope.

**Responses.** Rate limit exceeded is `429` with `Retry-After`; quota exhausted is `403`,
matching APIM so consumers see no change at cutover. Both are shaped by `errorFormat`. With
`emitHeaders: true` the response carries `X-RateLimit-Limit`, `-Remaining` and `-Reset`.

**Window boundaries** are fixed windows aligned to `periodSec` from a fixed UTC epoch, not
rolling, so "when does my quota reset" is answerable without explaining a sliding window.

**Failure behaviour is permissive:**

- **Instance restart** resets the local rate-limit window (one window of extra allowance) and
  loses the unreported quota delta, which under-counts. Losing a restart's worth of counts
  beats double-counting a consumer into a 403.
- **Control-plane outage** does not affect rate limiting, which needs nothing from the control
  plane. Quota keeps enforcing against the frozen aggregate and drifts permissive (§8.5).

**Streaming routes count differently** (§5.8): a WebSocket route counts upgrades.

**Storage.** Only the quota aggregate is persisted, in `usage_counter`. The control plane
aggregates reports in memory and flushes on a slower cadence (`USAGE_FLUSH_INTERVAL_SEC`) in
one batched transaction, because N instances × active subscriptions × poll rate would
otherwise be a steady write load against the single SQLite writer (§13). RPO on counters is
the flush interval. Rate-limit counters are never persisted or reported.

**Counters serve enforcement, and nothing else.** There is no per-call ledger, no invoice and
no consumer usage report beyond `GET /api/subscriptions/:id/usage`, which answers "how much of
my quota is left" from the same aggregate. Everything a consumer or an owner needs to *analyse*
traffic comes from the OTEL stream in ELK (§13), which is why there is no plan or tier entity
(§4): limits live in policy per route or product, which is where the estate already puts them.

### 5.8 Streaming: WebSocket and SSE

Both are supported, and both mean no buffering and no body validation. WS and SSE are
different shapes and get different treatment.

**SSE is a normal request with a long-lived response.** The whole request side works
unchanged: authentication, authorization, rate limit, quota, preconditions, request
validation, request headers, rewrite. Only the response side degrades — no response
validation, transform or cache.

**WebSocket is a normal request that stops being HTTP.** The upgrade handshake runs the full
request-side pipeline; once the 101 is returned the connection is an opaque bidirectional byte
stream.

#### What each mode forbids, enforced by schema

Incompatibilities are config errors at write time, not silent no-ops:

| | `websocket: true` | `sse: true` |
|---|---|---|
| `validate.request` | must be `disabled` | any — it is a normal request |
| `validate.response` | must be `disabled` | must be `disabled` |
| `transform.request` | must be `none` | any |
| `transform.response` | must be `none` | must be `none` |
| `cache` | must be off | must be off |
| `retries` | upgrade only | before the first response byte only |
| `timeoutMs` | applies to the upgrade | applies to response headers only |
| `rateLimit` | counts **upgrades** | counts requests |
| `quota` | counts **1 per connection** | counts 1 per request |

A `rateLimit` of 100/min on a WebSocket route permits a hundred *connections* a minute, each
carrying unlimited messages, and a connection consumes one quota call. Message-rate control is
`maxBytesPerConnection` and `maxConcurrentConnections`.

#### WebSocket authentication

The upgrade authenticates once, and nothing re-checks afterwards, which would contradict
§8.5's guarantee that a revoked credential stops working at the next poll. Two mechanisms
close it:

- **`maxConnectionSec`** forces a reconnect on a bounded schedule, so credentials are
  re-verified at that cadence at worst. Default one hour.
- **Active close on revocation.** When a poll reports a subscription revoked or suspended, the
  instance closes that subscription's open connections (WS close 1008, SSE stream end). This is
  the only place a config update reaches backwards into in-flight work.

#### Mechanics

- **No frame parsing.** After upgrade we copy bytes and do not decode WebSocket frames, so
  enforcement is in bytes and seconds — `maxBytesPerConnection`, `streamIdleTimeoutSec`,
  `maxConnectionSec` — never per-message size or count. A route that needs per-message
  validation, size limits, transformation or logging is a request/response route and should be
  modelled as one.
- **Backpressure is inherent**: blocking copies in both directions with fixed buffers, so a
  slow client throttles the backend rather than accumulating in the gateway.
- **SSE requires flush-per-event**, not the default buffered response behaviour. Buffering
  makes SSE appear to work in testing and deliver nothing in production until a buffer fills.
- **Retries stop at the first byte.** A partially streamed response cannot be retried, so
  `retries` and the circuit breaker apply to establishing the stream only.
- **Idle timeout is not request timeout.** `timeoutMs` bounds getting a response;
  `streamIdleTimeoutSec` bounds silence on an established one.
- **Capacity is concurrent connections, not requests per second** (§13). Each open stream holds
  two goroutines, two buffers and one backend connection for its lifetime.
  `MAX_CONCURRENT_UPGRADES` caps it per instance and sheds at the ceiling with 503.
- **Telemetry**: one span per connection, opened at upgrade and closed at teardown, with bytes
  in/out and a close reason, plus an open-connection gauge.

#### Reverse proxy configuration

F5 and nginx both need explicit configuration to allow protocol upgrades and long-lived idle
connections. nginx's default `proxy_read_timeout` severs a healthy SSE stream after a minute,
and F5 profiles carry their own idle timeouts. This belongs in §8.1's contract.

## 6. Promotion

### 6.1 Two tiers: the contract is promoted, everything else is edited in place

> **Contracts are authored in DEV and only move forward along the chain DEV → TEST → PROD.
> Policy, backends, routes and certificates are edited directly in whatever environment they
> belong to.**

| Promoted — authored in DEV only | Edited directly, per environment |
|---|---|
| `revision.model` — the API contract (OpenAPI, WSDL, derived Kafka schema) | `policy_entry` — auth, validation mode, rate limit, quota, CORS, headers, transforms |
| `revision.artifact` — the compiled validators derived from it | `binding` — backend URLs, pools, load balancing, backend client certs |
| | `route` — host and base path |
| | `certificate` — client identities (§4.3) |
| | `tls_exception` — admin, dated (§5.4) |
| | `subscription` — consumers subscribe per environment |

Two consequences:

- **A rate limit, a CORS origin or a validation downgrade can change in PROD without a
  release**, because those live in `policy_entry`.
- **"No direct definition changes in TEST or PROD" needs no separate rule.** It follows from
  two existing mechanisms: a revision freezes on first release (§4), so a released contract is
  immutable; and the promotion gate refuses to release a revision into an environment whose
  predecessor it has not reached. Anyone can create a revision at any time and cannot get it
  anywhere except DEV first.

### 6.2 The promotion gate

`PROMOTION_CHAIN` (§11) declares the order; `dev,test,prod` is the default and is
configuration, not a constant.

```
POST /api/resources/:id/releases  { revision: 7, environment: "test" }
  → 202 { jobId, planId }        # the plan is shown before confirm
```

> A release into environment *E* is permitted only if *E* is the first link in the chain,
> **or** that revision has *at some point* reached `converged` in *E*'s predecessor.

"At some point", not "currently" — that is what makes rollback work. Rolling PROD back to
revision 6 is legal because revision 6 passed through TEST when it was promoted, even though
TEST has since moved to revision 8. A currently-converged test would block every rollback. The
check reads `release`/`applied` history, and a rejection names the predecessor environment and
the revision's furthest point along the chain.

The gate blocks: authoring a revision and releasing it straight to PROD; skipping TEST; and —
because contracts freeze on release — editing a definition that is already live anywhere.

**Break-glass is admin-only and recorded.** `POST …/releases { skipChain: true, reason: "…" }`
requires an admin and a reason, writes both to `release.reason` and `audit`, and appears in
`GET /api/governance/exceptions`. A production incident whose fix is verified in DEV is the
case it exists for.

### 6.3 What a release does

Writes a `release` row and enqueues a reconcile job. No cross-tenant entity copying, no policy
rewriting, no per-step partial-failure summary — the contract describes the target state, and
`policy_entry`, `binding` and `route` supply what differs per environment.

**Policy merges per policy, additively, on every release** — not per document, and not only on
first release. For each policy unit, promoting a revision from *P* into *E* does one of four
things:

| In predecessor *P* | In target *E* | Result in *E* |
|---|---|---|
| present | **absent** | **created, with P's values**, so it works on arrival |
| present | present | **untouched**, values included |
| **absent** | present | **untouched** — removal does not propagate |
| absent | absent | nothing |

Row one is why a new API lands in TEST protected rather than open, and why adding
`circuitBreaker` in DEV reaches TEST on the next promotion without anyone re-typing its
settings. Row two is why a rate limit tuned in TEST survives every subsequent promotion. Units
created by a merge are marked `origin = seeded` with `seeded_from_env`; once anyone edits one
it becomes `local` and is never overwritten again.

- **Removing a policy in DEV does not remove it in TEST or PROD.** "Keep it, do not change it"
  applies to presence as much as values, so a deletion is a local act per environment. A
  promotion never silently drops an authentication method downstream. Deletions therefore have
  to be repeated, and §6.4 lists them as divergence. Making removals propagate is a one-flag
  change (§18).
- **The merge appears in the plan, before confirmation.** `?dryRun=1` lists every unit that
  will be created and the values it arrives with, and lists left-alone units greyed.
- **The merged document is schema-validated in the plan; a conflict fails the plan.**
  Assembling P's units on top of E's can produce something neither had — DEV's
  `passthrough.websocket` beside TEST's `cache`, which §5.8 forbids. That fails the plan naming
  both units, rather than half-applying a release.

Two edge cases: a unit in *E* keyed to an operation the promoted contract no longer has is an
**orphan** — reported in the plan, archived on apply, kept in history, never applied against a
missing operation. And alignment between environments is always an explicit act:
`POST /api/resources/:id/policy/copy-from?environment=test&units=rateLimit,cors` overwrites the
named units after a diff and a confirmation. Nothing reconciles policy across environments on a
schedule or as a side effect of a release, which is what makes editing in place safe.

**The plan is persisted.** `?dryRun=1` computes the diff, stores it as a `release_plan` row
with a `plan_digest`, and returns it. Confirming references that `plan_id`; the job recomputes
the plan and refuses to apply if the digest moved, so the diff a PROD approver signed off on is
the diff that runs. The plan is also where an adapter rejects a release before anything
happens: for a `kafka-topic` it carries Schema Registry's compatibility verdict (§8.8).

`release.state`:

```
pending  → (approval, if the environment requires one)
approved → converging → converged
                      ↘ failed (reason)
                      ↘ stale (plan digest moved — recompute)
```

PROD releases require an `approval` row decided by an admin other than the requester; DEV and
TEST are configured per target. A release stays `pending` until then — the job is enqueued on
approval, not on request. Rollback is a release of an earlier revision, through the same states
and the same gate.

### 6.4 Environment divergence is reported, not prevented

Because policy is edited in place, environments differ by design. What must not happen is
nobody noticing that PROD has run `validate: warning` since an incident while TEST still
blocks.

`GET /api/resources/:id/divergence` diffs policy, `route` and `binding` across the chain, and
material differences surface on the API page and in `GET /api/governance/exceptions`. Per-unit
storage makes the report specific:

| Category | Meaning | Consequence |
|---|---|---|
| **Pending** | unit in the predecessor, absent here | it will be created on the next promotion (§6.3) |
| **Local addition** | unit here, absent in the predecessor | promotion will never remove it |
| **Value drift** | same unit, different values | shown with `origin`, who changed it, and when |
| **Aligned** | same unit, same values | collapsed by default |

Divergence is distinct from §7's drift, and the two are separate in the UI:

- **Drift** = what a gateway has vs. what we declared for it. A gateway problem.
- **Divergence** = what we declared for TEST vs. for PROD. A governance observation.

Neither blocks anything. Divergence in `route.host` and backend URLs is expected and shown
greyed; divergence in an `auth.*` unit, `validate` or `rateLimit` is shown plainly with who
changed it and when. An `auth.*` unit present in DEV and absent in PROD is surfaced as a
warning: PROD is less protected than what was tested, and the additive merge will fix it on the
next promotion but not before.

`release.version_digest` proves the **contract** promoted unchanged, not that the runtime
configuration did. That is the price of being able to fix PROD without a release, and
divergence reporting is the compensating control — by visibility, not enforcement.

## 7. Reconciler

One loop per target — on demand, on release, and on a sweep interval:

1. **Desired** = releases + revisions (the promoted contract) + per-environment policy, routes
   and bindings + products + subscriptions + active TLS exceptions for that environment.
2. **Observed** = the adapter's list of what exists.
3. Apply the diff in dependency order; record `audit` per action, write `applied` rows, set
   `release.state`, and record `drift` for anything observed that nobody declared.

Idempotent and resumable, because progress lives in `job`. Six rules:

- **One lease per target.** Two reconcilers cannot apply the same target. The lease is a row
  with an expiry, taken in a transaction, so it works across hosts and survives the phase-4
  Postgres move (§13).
- **Event-driven first, sweep second.** A full inventory `list` per target every 60s does not
  survive ARM throttling on a real estate. Releases and admin actions kick the loop
  immediately; the full sweep runs on a longer interval (~15 min, configurable) and diffs by
  `applied_digest`.
- **Settle window.** After an apply, the target's observations are ignored for ~60s and
  compared against `applied.applied_digest`. Without it, stale reads look like drift and the
  loop flaps. The `standalone` adapter is strongly consistent and sets the window to zero — the
  field is per adapter.
- **`enforce` vs report.** With `enforce=false` a target only records drift. Enforcement means
  an emergency manual fix in PROD is reverted within a sweep, so it is a per-target decision.
  `paused` stops both.
- **Deletes are conservative, and Kafka topics are never deleted.** A resource is removed only
  after two consecutive passes without it in desired state, and a pass that would delete more
  than a configured number of objects stops and asks. A `kafka-topic` is exempt from
  convergence on delete entirely: absence is reported as drift and never acted on, because the
  failure mode is data loss (§8.8).
- **Backoff on 429.** ARM throttles; the loop widens its interval and reports the degradation
  on `/api/targets/:env/health`.

Drift is acknowledgeable (`drift.acknowledged_at`), so an accepted difference stops appearing
on the dashboard.

Adapters implement one interface — `list`, `apply`, `remove`, `health`, `capabilities`. The
contract is ours: no `;rev=N` matrix suffixes, no OData `$filter` subset, no ARM envelope.
`capabilities` is how the UI knows which policy units an adapter honours.

## 8. Targets and adapters: `apim`, `standalone` (our Go gateway), `kafka`

Three adapters, and an environment may have more than one target — `UNIQUE(environment,
adapter)` on `target`, so DEV can carry an HTTP target and a Kafka target at once, each with
its own `enforce` and `paused`.

**`apim` is the coexistence path**: how the estate is adopted in phase 1 without recreating
anything (§16), and how production keeps serving while the control plane changes underneath.
**`standalone` is the product**, shipping in phase 2. **`kafka` (§8.8)** reconciles topics,
schemas, consumer groups and ACLs through Confluent REST Proxy and has no data plane.

`standalone` is named for what it is: its own Go binary, its own container, N instances behind
F5, deployed and scaled independently of the control plane and able to keep serving without it
(§8.5).

All three implement the same interface, so §12's contract suite holds them to one standard and
the reconciler stays ignorant of what it is converging.

### 8.1 The reverse proxy owns the hard parts

The data plane always runs behind F5 or nginx:

| Owned by F5 / nginx | Owned by our data plane |
|---|---|
| TLS termination, SNI, certificate lifecycle and rotation, chain and revocation checking, private-key custody | API-credential authentication (subscription key, JWT, introspection, client-cert SAN) |
| HTTP hardening: request smuggling, header and body limits, slowloris, hop-by-hop stripping, `Expect: 100-continue` | Routing: host + base path + method + path template |
| Coarse edge limits: connection caps and per-route / per-client-IP rate limiting, as DoS protection | Policy evaluation in the order of §5.2, including per-subscription rate limit and quota (§5.7) |
| HTTP/2 and HTTP/3 on the front side, client-cert verification | Backend selection, pool load balancing, failover, backend TLS verification (§5.4) and mTLS |
| DNS, load balancing across data-plane instances | Proxy semantics: timeout, retry, circuit breaker, streaming (§5.8) |
| Permitting protocol upgrades and long idle timeouts, so WS/SSE survive (§5.8) | Upgrade handling, stream lifetime, idle timeout, revocation close |
| | Validation (§5.1), OTEL emission (§13) |

The asymmetry is deliberate: the proxy owns TLS on the client side, the data plane owns TLS on
the backend side. There is no point at which nobody is verifying. We lean on the proxy tier that
already exists rather than adding a second one — no Envoy, no xDS, no service mesh — and the
consequence is that the data plane must be reachable only through it, which §11's boot self-test
enforces.

Rate limiting splits the same way. The proxy protects the platform — connection caps and
per-IP limits, precise because it sees every request at one point, and blind to who the caller
is. The data plane protects backends from individual consumers — per-subscription limits
enforced per instance (§5.7), impossible at the edge because F5 cannot resolve a subscription
key to a product.

**The proxy↔gateway contract is a trust boundary.** The data plane reads client IP and
verified-client-cert details from headers (`X-Forwarded-For`, `X-Client-Cert-*`), so it must
accept requests only from the proxy and strip those headers from anything else. Enforced two
ways: a network policy, plus a shared secret or mTLS on the proxy→gateway hop, both configured,
neither optional. Getting this wrong turns header-based mTLS identity into header-based
impersonation, so it is a boot self-test check (§11).

### 8.2 Why Go

- **Per-request isolation is free.** Goroutine-per-request means one expensive operation costs
  one request, not the instance. Node's event loop makes a single slow CPU-bound step degrade
  everything on that thread, which would need a hand-rolled `worker_threads` pool.
  Blocking-by-default validation (§5.1) makes that isolation matter more.
- **The proxy is in the standard library.** `net/http/httputil.ReverseProxy` handles streaming,
  hop-by-hop headers and flush semantics.
- **Sizing is predictable.** Roughly 3× Node's per-core proxy throughput and a quarter of the
  memory (§13), with a tighter distribution.
- **Cost of ownership.** Rust is faster and lighter still, and was a serious candidate while
  validation looked like inline hot-path CPU. The remaining gap is a constant factor on a
  workload bounded by explicit budgets, against a decade of maintenance where Go is cheaper.

The cost is two languages and two CI pipelines, contained because the data plane shares no code
with the control plane or the SPA — it consumes a JSON config document over HTTP. §12's adapter
contract suite keeps the two implementations of §5's vocabulary aligned.

### 8.3 Per request

Match route (prefix trie) → derive trusted context → run §5.2's pipeline → proxy → stream
response → emit an OTEL span and access log.

### 8.4 The validation pool

Warning-mode validation runs in a dedicated pool inside the same binary:

- Bounded by a semaphore (`validate.maxConcurrent`, clamped by `VALIDATE_POOL_SIZE`), so
  libxml2's cgo calls occupy at most that many OS threads.
- A bounded queue in front of it. On saturation the sample is dropped and counted
  (`onSaturated: "skip"`); it never queues unboundedly and never backpressures the request path.
- Tee'd bodies are size-capped by `validate.always.maxBodyBytes` before entering the pool.

Blocking-mode validation does not use the pool — it is inline on the request goroutine, and its
ceiling is `BLOCKING_BUFFER_BUDGET_BYTES`, beyond which new blocking-validated requests shed
with the route's `errorFormat`.

The tee → queue → validate boundary is a seam: if SOAP validation CPU becomes the constraint,
that component lifts out into a separately scaled service without touching the proxy path.

### 8.5 Config distribution and usage reporting

Instances poll the control plane with a per-instance bearer token, keyed by `gateway_instance`.
The poll is bidirectional and single round-trip: the request carries the instance's quota deltas
since its last poll, and the response carries config (ETag-cached) plus the fleet quota
aggregates (§5.7). Quota counting therefore adds no channel, no datastore and no protocol. Rate
limiting adds nothing at all, being per instance.

- **Fail-static.** Last-good config is persisted to local disk and served across restarts, for
  an unbounded control-plane outage. Control-plane downtime is never a traffic outage. The one
  thing that does not survive staleness is a TLS exception, which self-expires (§5.4).
- **Fail-closed on revocation only.** A revoked subscription key or instance token stops
  working at the next poll and on an explicit push. Config staleness never fails closed;
  credential revocation always does.
- **Version-pinned, canaryable, rollbackable.** A config carries a digest; instances report the
  digest they are running in `gateway_instance.config_digest`, so `/api/targets/:env/health` can
  answer "is the fleet on revision 7". A target can pin a subset of instances for canary and
  roll back by pinning the previous digest.
- **Quota reporting is best-effort.** A lost report under-counts and is never retried, because a
  retried delta would double-count a consumer into a 403. An instance that stops polling stops
  contributing; nothing was allocated to it, so there is nothing to reclaim.

#### Where each piece of state lives

Every piece of data-plane state has a home, and between them they are the reason the data plane
needs no shared store of its own:

| State | Home |
|---|---|
| Config, routes, policies, products, subscriptions, TLS exceptions | Polled from the control plane with an ETag; in memory plus the fail-static local file |
| Compiled validators | Content-addressed artifacts on the persisted volume (§8.7) |
| Subscription key → application/product | Part of config, in memory — 100k subscriptions ≈ 20 MB |
| JWKS and JWT verify results | Per-instance cache with rotation; a verify costs ~50–100 µs |
| Coarse rate limiting (per route, per IP) | F5/nginx at the edge (§8.1) |
| Per-subscription rate limit | Per-instance in-memory counter, no coordination (§5.7) |
| Quota counters | Local deltas plus the fleet aggregate on this poll; `usage_counter` in SQLite, batched flush (§5.7) |
| Response cache | Per-instance, in memory, bounded, default off |
| Validation sampling decisions | Recomputed from `hash(key, request_id) < rate` — stateless (§5.1) |
| Cold-start burst and sticky escalation | Per-instance and approximate by design (§5.1) |
| Circuit-breaker state | Per-instance, so one instance's connectivity fault cannot trip the fleet |
| Sessions, jobs, reconciler lease | SQLite on the control plane (§9, §10, §7) |

A shared cache tier — Redis or otherwise — would therefore add a dependency and a failure mode
without taking work off any of these. Two rules apply if one is ever introduced. Anything held
in a non-persistent store must be reconstructible, so sessions and job state stay in SQLite.
And any feature depending on it must fail **open** and count the degradation: rate limiting that
fails closed on a cache outage *is* the outage. A shared counter, if genuinely needed, belongs in
the phase-4 Postgres first.

### 8.6 What must still be answered before it ships

- **Backend connection pooling.** Keep-alive and per-backend caps via `http.Transport`, one
  Transport per (backend, TLS config) pair, and pool recycling when a binding or TLS exception
  changes or expires (§5.4).
- **Blocking-mode memory ceiling.** `maxBodyBytes × in-flight blocking requests` is the real
  number; `BLOCKING_BUFFER_BUDGET_BYTES` bounds it, and the shed behaviour at the ceiling needs
  measuring.
- **Cutover** — one API moves from `apim` to `standalone` and back by changing which adapter
  serves its route, with DNS ownership named.

Until `standalone` serves an API's logs, the Logs tab reads the ES adapter, as today.

### 8.7 Compiled artifacts and the schema cache

Blocking validation needs the schema inside the instance, and schemas reach megabytes — a WSDL
with its XSD set, or an OpenAPI document's component schemas. Inlining them in the config
document of §8.5 would make it hundreds of megabytes and re-download all of it on any change,
so they travel separately.

```
config  →  routes, policies, products, subscriptions, tls exceptions
           + artifactRefs: [ { digest, kind, sizeBytes } ]

GET /api/gateway/artifacts/:digest      # per-instance bearer token, gzip
```

`kind` is `json-schema` (REST, dialect already resolved per §4.1), `xsd` (a SOAP revision's
whole self-contained schema set as one bundle), or `kafka-schema` (Avro / Protobuf / JSON Schema
for a topic). All three are compiled from `model` at release, so **the data plane never parses
OpenAPI or WSDL** — it consumes routing tables and compiled validators.

- **Content-addressed, therefore immutable.** A digest never changes meaning, so there is no
  invalidation logic, only eviction. Two revisions with an unchanged schema share one artifact
  and one download.
- **Persisted volume, not ephemeral storage.** The data plane runs in a container, so
  `GATEWAY_ARTIFACT_CACHE` is a mounted volume surviving restarts and image updates. Without it,
  every restart re-downloads the estate's schemas, and a control-plane outage during a rolling
  restart leaves instances unable to validate.
- **Config activation is gated on artifact availability.** An instance prefetches every digest a
  new config references and activates the config only when all are present and verified. Until
  then it keeps serving the previous config, so an instance is never running a config whose
  schemas it does not have. `gateway_instance.config_digest` reports the *active* config.
- **Digests are verified on read**, every time, not only on download, because a persisted volume
  can be corrupted or tampered with. A mismatch evicts and refetches; if it cannot refetch, that
  route fails closed.
- **Eviction is LRU by total size** (`ARTIFACT_CACHE_MAX_BYTES`), and artifacts referenced by
  the active config are pinned. The working set is one bundle per released resource per
  environment — pruned revisions (§4.1) never reach the data plane — so the volume is sized from
  released APIs, not revision history.
- **A route whose artifact is unavailable fails closed** with 503 and a distinct counter, while
  every other route on the instance serves normally. Degrading it to `warning` would break
  §5.1's guarantee; refusing to start would turn one bad schema into a fleet outage.

Backend client certificates (§4.3) travel the same way, for the same fail-static reason. They
are key material, so they live in a separate directory on the volume with restrictive
permissions, and **volume encryption at rest is required**. You cannot have both "the data plane
survives a control-plane outage" and "no secrets on the data plane's disk"; this design takes
the former.

### 8.8 Managing Kafka resources — `kafka-topic`, control plane only

Two different things reach Confluent REST Proxy. **This subsection is management**: topics,
schemas, consumer groups and ACLs, reconciled from the control plane with no data plane
involved. **§8.9 is access**: HTTP produce and consume for callers without a native Kafka
client.

The `kafka` adapter speaks only Confluent REST Proxy and Schema Registry through it — no Kafka
client library, no Zookeeper, no separate admin path, nothing in the Go data plane.
`target.config_json` carries the cluster's REST Proxy endpoint, Schema Registry endpoint and
credential reference per environment. Whatever the REST Proxy exposes is what this system can
manage, which keeps the adapter small and its permissions auditable in one place.

Topics live in the same `resource` table so the terminology and machinery are shared: a topic is
owned by a team, versioned in revisions, released to an environment, subscribed to by an
application, gated by approvals, and reconciled with drift reported. A consumer asking for
access to a topic uses the same screen and approval path as one asking for access to an API.

| Concept | Model |
|---|---|
| Topic | `resource` with `kind=kafka-topic` |
| Topic config — partitions, retention, cleanup policy, min ISR | the revision's `model` |
| Message schema (Avro / Protobuf / JSON Schema) | an `artifact` on the revision, registered in Schema Registry at release |
| Schema compatibility mode | part of the revision `model` |
| Consumer group | provisioned per subscription, recorded in `subscription.provisioned_json` |
| ACLs | **derived**, never authored — computed from (subscription, role, topic) |
| Producer vs consumer access | `subscription.role` |
| Cluster | `target`, one per environment |

Three behaviours differ from HTTP:

- **Schema compatibility is the release gate.** `POST /releases?dryRun=1` on a topic asks Schema
  Registry to check the new schema against the registered history under the topic's
  compatibility mode. An incompatible schema fails the *plan*, before anything is applied, with
  the registry's explanation.
- **ACLs are derived and converged, never written by hand.** The reconciler computes the ACL set
  desired state implies and converges the cluster toward it, so a manually added ACL appears in
  `/api/drift` like any other unmanaged object.
- **Topic deletion is an explicit admin action, never a convergence outcome.** Deleting a topic
  destroys data, so §7's delete guards are not sufficient: a topic absent from desired state is
  reported as drift and stays until an admin confirms a separate destructive action. `enforce`
  does not extend to it, at any value, in any environment. Consumer groups and ACLs *are*
  reconciled and removed normally, both being recreatable.

**Kafka playground** produces a test message to a topic or reads the last N, through the REST
Proxy, using a certificate or credential from `certificate` (§4.3) and gated by `can()`. Like
the HTTP playground, it can only reach a declared resource on a configured target.

Consumer-group offsets, lag and partition state are observed, not desired: they appear on the
topic's page and in the dashboard, and the reconciler never converges them.

### 8.9 Accessing Kafka over HTTP — a three-layer chain

Producing to a topic over HTTP is three APIs, each owned by a different team:

```
consumer
   │  subscription key · rate limit · quota · request validation
   ▼
(3) kind=kafka           OWNED BY THE APPLICATION TEAM              §8.10
   │  contract generated from the topic's schema; a normal published API
   │  sets x-kafka-topic to its one topic; presents its own client certificate
   ▼
(2) kind=kafka-proxy     OWNED BY THE APIM TEAM                     §8.9
   │  one per environment; the special policy lives here and nowhere else
   │  principal ← client-cert DN of the calling API's application
   │  ACL check against the cluster; builds the REST Proxy produce envelope
   ▼
(1) kind=rest            OWNED BY THE KAFKA TEAM
   │  Confluent REST Proxy, published as an ordinary API. No special policy.
   ▼
 Kafka
```

The hops are organisational boundaries: the Kafka team publishes the REST Proxy and controls its
exposure; the APIM team owns the one piece of privileged logic; application teams own their own
contracts and see neither. Every layer is managed through this portal with the same versioning,
release, approval and audit as any other API.

**Two independent authorization layers:**

- **Layer 3 answers "may this consumer call this API?"** — an ordinary subscription, with an
  ordinary key, against a typed contract. Consumers get a real OpenAPI for a real topic, owned
  by the team that owns the data.
- **Layer 2 answers "may this application produce to this topic?"** — evaluated against Kafka's
  own ACLs, keyed on the *publishing application's* certificate DN. The principal is the
  application, never the end consumer.

Neither substitutes for the other. An application that loses its Kafka ACL stops producing even
though its API is still subscribed; a consumer whose subscription is revoked stops immediately
even though the application's ACL is intact.

**Layer 2 is shared, internal and singular.** One `kafka-proxy` resource per environment,
reachable only by callers presenting a registered client certificate. The APIM team owns it,
which is why layer-3 APIs are trivial: the privileged logic exists once, under one owner.

**Layer 1 is a normal published API owned by the Kafka team**, carrying no special policy.
Requests from layer 2 go through the gateway to reach it, which costs a hop and gives the Kafka
team control over their own exposure.

**The control plane does not go through it.** The reconciler (§8.8) reaches the REST Proxy
directly via `target.config_json`, for two reasons: it needs admin operations the published API
may not expose, and routing management traffic through the gateway would make the control plane
depend on a data plane whose configuration the control plane produces — circular at cold start,
which is when management most needs to work.

#### The chain is not collapsed

Folding layers 2 and 3 together is technically possible: with ACL evaluation and envelope
construction compiled into the data plane, a `kafka` API could talk straight to the REST Proxy
presenting its own client certificate.

It is not done, because the hops are ownership boundaries. Collapsing them would put the
privileged ACL path in every published API instead of once per environment, require every
application's client key on every data-plane instance, and take exposure control away from the
Kafka team. What changes instead is the layer-2 *policy*: ~120 lines of C# with an embedded ACL
engine become about fifteen lines of declared config.

#### Layer 2 authorization: the cluster's ACLs are the authority

The calling application's Kafka principal comes from its client certificate DN; the cluster's
ACLs for that principal are queried and evaluated against the requested topic.

> **An application producing over HTTP and the same application producing with a native client
> are evaluated against the same ACLs, by the same rules. There is one grant and it lives in
> Kafka.**

The portal need not have provisioned an ACL for the check to work, so ACLs managed outside this
system still govern HTTP access.

```json
"kafka": {
  "topicFrom":  { "in": "header", "name": "x-kafka-topic" },
  "authorize": {
    "source":         "cluster-acl",
    "principalFrom":  "client-cert-dn",
    "principalPrefix": "User:",
    "operation":      "WRITE",
    "aclCacheTtlSec":  120,
    "onLookupFailure": "deny"
  },
  "produce": { "format": "json", "recordsFrom": "body-as-single-value",
               "keyFrom": "header:X-Message-Key", "maxRecordsPerRequest": 500 },
  "schemaMode": "off"
}
```

`source: "subscription"` is the alternative for a proxy whose topics are fully portal-managed:
authorize against the `subscription`-derived grant instead of querying the cluster, with the
reconciler keeping the proxy principal's ACL set equal to the union of subscriber grants and
nothing more. Correct only while the portal owns every ACL on those topics, which is why
cluster-authoritative is the default.

Four things the gateway owns:

- **The ACL evaluator is compiled in and implements Kafka's semantics**: LITERAL and PREFIXED
  patterns, the `*` wildcard resource name, `ALL` as a superset of `WRITE` and `READ`, host
  matching including specific hosts, and **DENY taking precedence over ALLOW across every
  matching pattern**.
- **Principal derivation canonicalizes the DN** per RFC 4514 — attribute-type case, escaping,
  ordering, multi-valued RDNs — not by replacing `", "` with `","`. `principalFrom` reads the
  verified client certificate from the reverse proxy (§8.1), which is why the trusted-proxy
  boundary is a boot-time hard failure: a DN header accepted from an untrusted peer is an
  authorization bypass.
- **A missing or unverifiable principal is 401**, not a sentinel principal that happens to match
  no ACL.
- **Lookup failure denies** (`onLookupFailure: "deny"`), and the result is cached per
  **principal** — not per principal-and-topic — with `aclCacheTtlSec` bounding revocation lag.
  An ACL removed in the cluster keeps working for up to that long, stated in the UI beside the
  field. ACL changes made through §8.8 push an invalidation and take effect immediately; only
  out-of-band changes wait out the TTL.

#### Topic selection

`topicFrom` may name a header, a path parameter or a query parameter — the topic need not come
from a closed map, because the ACL check is the containment. Two rules are absolute:

- **The topic name is validated against Kafka's legal charset before any other use** —
  `^[a-zA-Z0-9._-]{1,249}$` — and rejected with 400 otherwise, then URL-encoded when building
  the REST Proxy path. A topic name reaching a URL template unvalidated is a path-traversal
  vector into the rest of the REST Proxy API, and a PREFIXED ACL is enough to get a hostile
  value past an ACL check (§16).
- **Authorization precedes routing.** The topic is resolved and authorized at pipeline steps 1
  and 7 (§5.2); the backend path is constructed afterwards from the validated name.

`topics` (a closed map) remains available and is the right choice when a proxy exposes a small
fixed set, since the generated OpenAPI can then name real routes. Where both are present, the
map applies first and the ACL check still runs.

`binding` for a `kafka-proxy` is not owner-written: it references the environment's `kafka`
target, so the backend comes from admin configuration and §5.3's egress rule is satisfied by
construction.

#### The produce envelope is serialized, never concatenated

The REST Proxy body is built by a JSON serializer from a typed structure — records, values,
optional key, optional partition. The current implementation concatenates the client's raw body
into `{"records":[{"value": … }]}`, so a crafted body can close the value early and add sibling
fields: extra records, a message `key`, an explicit `partition`. That is envelope tampering
available to any caller authorized for the topic.

- The client body is **parsed as JSON before it is embedded**, so a malformed body is a 400 from
  us rather than an opaque REST Proxy error or a mangled record.
- `recordsFrom: "body-as-single-value"` reproduces today's behaviour — one record, whole body as
  the value. `"body-as-records"` accepts a caller-supplied array bounded by
  `maxRecordsPerRequest`.
- `keyFrom` and partition selection are declared config, not something a caller can inject.

#### Remaining mechanics

- **Consumer group is pinned by the gateway**, taken from `subscription.provisioned_json` and
  never accepted from the request. Otherwise a consumer could join another tenant's group and
  read its offsets.
- **`schemaMode`**, where `off` is legitimate. The current produce API uses
  `application/vnd.kafka.json.v2+json` — raw JSON, no Schema Registry — so `off` is the parity
  default per route. `"validate"` checks the body against the topic's registered `kafka-schema`
  artifact (§8.7) as a blocking check (§5.1), rejecting a malformed message at the gateway
  instead of letting it poison every downstream consumer. `"validate-and-forward-id"`
  additionally forwards the Schema Registry id so errors surface as our problem responses.
- **Consume needs session affinity.** Confluent's consume flow is stateful — create a consumer
  instance, subscribe, poll, delete — and the instance lives on one REST Proxy node. The gateway
  stays stateless by routing on the `base_uri` the REST Proxy returns at creation, which the
  consumer instance id carries, so affinity is derived from the request. Where that cannot be
  arranged, consume is restricted to a single REST Proxy endpoint. Produce is the primary use
  case for this path; a consumer wanting high sustained throughput uses a native Kafka client
  against the cluster, and this chain exists for the callers who cannot.
- **Counting is per request, not per message.** A batch produce of 500 records is one request, so
  `rateLimit` and `quota` (§5.7) undercount by design. `maxRecordsPerRequest` and
  `validate.always.maxBodyBytes` are the message-level bounds, and the UI states the
  relationship.
- Everything else is an ordinary HTTP route reusing §5's pipeline: subscription key or JWT auth,
  preconditions, header rules, rate limit, quota, telemetry, blocking validation.

### 8.10 Layer 3: publishing an API from a topic

The application-owned API is a normal API; what is unusual is how it comes into existence. **The
publisher selects a topic instead of uploading a definition** and the contract is generated.
§4.1 already makes the normalized model primary and uploads incidental, so this is the case
where `original` is a Kafka schema rather than an OpenAPI document.

```
POST /api/resources  { kind: "kafka", derivedFrom: "<kafka-topic resource id>",
                       name: "…", team_id: "…" }
```

`resource.derived_from` records the link. Generation reads the topic's registered schema — Avro,
Protobuf or JSON Schema, from the `kafka-schema` artifact (§8.7) — and produces a model with one
produce operation whose request body is that schema, plus `202`, `400` and `403` responses. From
then on it behaves as any other variant. Its policy carries
`headers.request.set { "x-kafka-topic": "<the topic>" }` as a literal and `backendAuth: mtls`
with the application's certificate, and its `binding` points at the environment's shared
`kafka-proxy`.

- **Blocking validation comes free.** The derived contract *is* the topic's schema, so §5.1's
  default rejects a malformed message at layer 3 — before the shared proxy, before Kafka, with a
  typed error. Today's chain validates nothing and a bad message lands in the topic.
- **Schema evolution propagates.** When a topic's schema changes, a job creates a **new
  unreleased revision** of every derived API and drafts an announcement (§4.2) from the
  structural diff. The publisher reviews and releases; nobody hand-copies a schema.
- **Entitlement is checked at publish time.** Creating a derived API requires the owning team to
  hold a produce grant on the topic — a subscription, or an existing ACL for the application's
  principal. The portal resolves the principal from the application's `certificate` (§4.3,
  `usage: kafka-principal`) and pre-flights the ACL check, so a missing grant is a publish-time
  error naming the absent ACL rather than a 403 in production.
- **Conversion is lossy in known places** and the UI says so. Avro unions, `fixed`, logical
  types, aliases and default semantics do not map cleanly onto JSON Schema; Protobuf `oneof` and
  well-known types likewise. The generated contract is a faithful HTTP contract, not a
  round-trippable Avro definition, and the topic's schema stays authoritative — which is why
  `schemaMode: "validate"` at layer 2 remains a meaningful second check.

`kafka` is a variant on the same spine (§4.4), so it needs no new routes and no new permission
rules. The new surface is the create flow, a "regenerate from topic" action, and a variant badge
in the UI.

## 9. Identity and authorization

The corporate IdP is the source of both identity and roles.

- **One auth mode** for people: OIDC authorization-code + PKCE, BFF-owned, httpOnly cookie, plus
  a `dev` bypass for local work.
- **Two roles, from the IdP.** The OIDC token's group/role claims map to `member` and `admin`.
  `team` and `membership` are synced from IdP groups (`team.source_group`); nothing about
  who-is-who is authored in this product.
- **Authorization is one function:**

  ```
  can(user, action, subject) =
       user.isAdmin
    || subject.team_id ∈ user.teams
  ```

  A member manages the resources, products, applications, certificates and announcements of
  their own teams, and subscribes their own team's applications. Admins can do everything. There
  are no per-environment roles and no role editor. Topics are resources, so Kafka needs no
  permission model of its own.
- **One admin-only carve-out: `tls_exception`** (§5.4). Turning off backend certificate
  verification is not something a resource owner may do to their own resource. It lives in its
  own table so this stays one exception rather than a per-field permission model.
- **Approvals need a second person, not a third role.** A subscription request to another team's
  product is decided by a member of the owning team; a PROD release by an admin. Either way the
  approver must differ from the requester — a check on `approval`, not a permission tier.
- **Service tokens for automation.** `service_token` belongs to a team and acts as that team
  under the same `can()`: same two roles, non-human principal, no admin tokens and therefore no
  TLS exceptions from a pipeline. Bearer token, hashed at rest, scoped to the team, revocable,
  with `last_used_at` so dormant ones are findable.
- **Sessions in SQLite** survive restart, with no memory store and no Redis. `revoked_at` for
  explicit logout and forced revocation, `idle_until` distinct from `expires_at`, and re-issue on
  privilege change so a group removal in the IdP takes effect at the next refresh.
- **Tokens verified with `jose`** (control plane) and `jwx` (data plane) against
  admin-registered issuers (§2, §5.3).
- **CSRF**: `SameSite=Lax` cookie plus an `Origin` check on every mutating request. Same-origin
  API, so there is nothing else to allow. Service tokens are bearer-only and exempt.
- Every resource the API returns carries a `capabilities` array, so the SPA renders buttons from
  data and cannot disagree with the server about permissions.
- **`PATCH` and `PUT` require `If-Match`** against the resource's ETag, so two owners editing at
  once get a conflict instead of silent last-write-wins.

## 10. Async work

One `job` table and one runner cover promotion, reconciliation, notification fan-out (§4.2),
certificate-expiry monitoring (§4.3), revision pruning (§4.1), artifact compilation, key
lifecycle, audit export, TLS-exception expiry notices and FixMe self-heal runs. Jobs are
durable, retried with backoff, and expose `GET /api/jobs/:id`. Every job carries an
`idempotency_key`, so a retried announcement job does not email a consumer twice. Nothing
long-running happens inside a request.

Notification is one job kind with one recipient-resolution path (§4.2), driven by an event table
so the matrix is data rather than code:

| Event | Recipients |
|---|---|
| Approval requested | owning team of the subject (product owner, or admins for a PROD release) |
| Approval decided | requester |
| Announcement published | every subscriber team of the resource or product, by severity |
| Subscription approved / rejected | requesting team |
| Key rotated | subscribing team |
| Certificate within 30 / 7 days of expiry | owning team, then owning team + admins |
| TLS exception created; within 72 h of expiry | admins |
| Quota at 80% / 100% | subscribing team, and owning team at 100% |
| Validation failures in `warning` mode | owning team, as a daily digest, never per event |

The last row is a rule: a per-event notification on a sampled observation gets filtered to trash
and stops being read.

The data plane's validation pool (§8.4) is not this queue. It is in-process, bounded, lossy by
design and holds nothing durable — a dropped sample is a counted statistic, not a lost job.

## 11. Configuration

About thirty values plus two JSON documents, all explicit, **no fallback chains**. The current
`PROD_ADMIN_SUB_KEY` fallback silently escalates a narrow integration to an all-products
credential.

```
Control plane (Node)
  PORT · DB_PATH · PUBLIC_URL
  OIDC_ISSUER · OIDC_CLIENT_ID · OIDC_REDIRECT_URI · OIDC_ROLE_CLAIM
  SESSION_SECRET · KEK_REF
  OTLP_ENDPOINT
  TLS_EXCEPTION_MAX_DAYS        # ceiling on §5.4 expiry; no exception may exceed it
  USAGE_FLUSH_INTERVAL_SEC      # batched usage_counter flush; = quota RPO (§5.7)
  INSTANCE_STALE_AFTER_SEC      # when a silent instance drops out of the fleet view
  REVISION_KEEP_COUNT · REVISION_KEEP_DAYS    # prune bounds, §4.1 (default 5 / 365)
  PROMOTION_CHAIN               # ordered, default dev,test,prod — the §6.2 gate
  TARGETS_FILE           # per (environment, adapter): endpoint + credential ref +
                         #   enforce/paused; kafka targets add the REST Proxy and
                         #   Schema Registry endpoints (§8.8)
  INTEGRATIONS_FILE      # skonet | leanix | ldap | kafka | sendgrid | es
                         #   + registered JWT issuers (discovery URL, audience defaults)
                         #     and client CAs (§5.3)
                         #   + clientCaBundle: the proxy's client trust bundle (§5.6)
                         #   + tokenProviders: token URL + credentialRef + grant + scope,
                         #     referenced by name from backendAuth (§5.5)
                         #   + hmacSchemes: appIdRef + appKeyRef per environment (§5.5)
                         #   + sharedSecrets: credentialRefs for auth.basic and
                         #     requireHeader.credentialRef (§5.6)
                         #   + backendCaRefs: the backend trust bundle (§5.4 rung 1)
                         #   + the backend egress allowlist (§5.3)
                         #   + validation ceilings: max maxBodyBytes, min sample rate,
                         #     max maxConcurrent, max includeBodyExcerptBytes (§5.1)

Data plane (Go)
  GATEWAY_CP_URL · GATEWAY_TOKEN · GATEWAY_CONFIG_CACHE   # fail-static path (§8.5)
  GATEWAY_ARTIFACT_CACHE · ARTIFACT_CACHE_MAX_BYTES       # persisted volume (§8.7)
                                                          #   encrypted at rest: it also
                                                          #   holds client private keys
  TRUSTED_PROXY_CIDRS · TRUSTED_PROXY_SECRET              # the §8.1 trust boundary
  TRUSTED_PROXY_CLIENT_DN_HEADER                          # e.g. X-SSL-Client-DN (§8.9)
  KAFKA_ACL_CACHE_TTL_SEC · KAFKA_ACL_CACHE_MAX_PRINCIPALS
  VALIDATE_POOL_SIZE · VALIDATE_QUEUE_DEPTH               # warning-mode ceiling (§8.4)
  BLOCKING_BUFFER_BUDGET_BYTES                            # blocking-mode ceiling (§8.4)
  MAX_CONCURRENT_UPGRADES                                 # streaming ceiling (§5.8)
  BACKEND_CA_BUNDLE · BACKEND_TLS_MIN_VERSION             # §5.4; version raises only
  USAGE_REPORT_INTERVAL_SEC                               # quota deltas; = poll interval
  OTLP_ENDPOINT
```

Per-route `validate` values are clamped by the admin ceilings in `INTEGRATIONS_FILE`, and the
instance-wide `VALIDATE_POOL_SIZE` is the real bound, so one API's policy cannot commandeer the
whole pool. `includeBodyExcerptBytes` is clamped the same way and defaults to 0, so payload
logging cannot be enabled by a resource owner alone.

The two files hold as many values as the integrations need. This is config centralised,
schema-checked and free of precedence rules, not config made smaller.

Credentials are *references* (Key Vault / file / env) resolved at boot, never
PFX-on-disk-plus-passphrase. `KEK_REF` encrypts subscription keys and certificate private keys
at rest. A boot self-test probes every configured integration and reports a capability matrix; a
missing optional integration degrades that feature and says so. On the data plane the self-test
**refuses to start** if the trusted-proxy boundary is unset while client-cert or client-IP policy
is in use (§8.1).

## 12. Testing

- **Unit + integration (control plane)**: `node:test`, in-process, against a temp SQLite file.
  Because the store is a file, every test gets a pristine isolated world, so the shared-DEV-tenant
  hazard that forces today's `live` suite to run serially disappears.
- **Unit + integration (data plane)**: `testing` + `httptest`, with a fake control plane serving
  config and a fake backend.
- **Store contract**: a suite that runs against SQLite *and* Postgres from phase 1 — leases with
  expiry, `RETURNING`, FTS, transaction isolation, `backup` — so §13's phase-4 move is contained.
- **Adapter contract**: `apim` and `standalone` run the same suite (`list`/`apply`/`remove`/
  `capabilities` semantics), written before `standalone`. It is also what keeps two
  implementations of §5's vocabulary — one Node compiler, one Go interpreter — from diverging.
- **Promotion gate** (§6.2):
  - A revision authored and released to DEV cannot be released to PROD; the rejection names TEST
    and the revision's furthest point in the chain.
  - Releasing to TEST works once the revision is `converged` in DEV, and not before.
  - **Rollback across a moved chain**: revision 6 promoted DEV→TEST→PROD, TEST later moved to
    revision 8, and PROD can still be rolled back to 6. This is the "at some point" clause.
  - A frozen revision cannot be edited; `PUT /api/revisions/:id/spec` on a released revision
    fails, and the error points at creating a new revision.
  - `skipChain` requires an admin *and* a reason, records both, and appears in
    `/api/governance/exceptions`. A non-admin, or an admin with no reason, is rejected.
  - `PROMOTION_CHAIN` with four stages enforces four hops.
- **Policy tier and the per-unit merge** (§5, §6.1, §6.3):
  - Policy is editable in PROD with no release, and the change reaches the fleet through the
    normal config poll.
  - **Unit absent in target → created with the predecessor's values**, marked `origin = seeded`
    with `seeded_from_env`, and it *functions* — asserted by making a request the created unit
    governs, not by reading the row.
  - **Unit present in target → untouched, values included.** Tune `rateLimit.calls` to 50 in TEST
    while DEV says 100, promote three successive revisions, assert 50 every time.
  - **Unit absent in predecessor, present in target → untouched.** Delete `cors` in DEV, promote,
    assert TEST still has it.
  - Editing a `seeded` unit flips it to `local`, and it is never overwritten thereafter.
  - Granularity holds: `auth.jwt` and `auth.mtls` merge independently; `preconditions` merges as
    one ordered whole and never element-wise; `operations[<op>].rateLimit` is its own unit.
  - **The plan lists every unit that will be created, with its values**, and lists left-alone
    units. A confirmation applies exactly the listed set.
  - **A merge producing a schema-invalid document fails the plan**, naming both conflicting units
    — DEV `passthrough.websocket` against TEST `cache` is the fixture. Nothing is applied.
  - A unit keyed to an operation the promoted contract removed is reported as an orphan and
    archived on apply, not applied.
  - `copy-from` with a unit list overwrites only those units, after a diff and confirmation.
  - Divergence (§6.4) classifies into pending / local addition / value drift / aligned, and flags
    an `auth.*` unit present upstream but absent in PROD as a warning.
- **Reconciler**: a fake adapter returning stale reads on purpose, to prove the settle window
  prevents flapping, that delete guards hold, and that a plan whose digest moved is refused.
- **Validation** (§5.1):
  - Default with no `validate` block is `blocking`, and a non-conforming body is rejected.
  - XXE, DTD, billion-laughs and oversize-entity payloads are rejected in **all three states**,
    including `disabled`.
  - Content-type and size caps apply in all three states; over the cap is `413`, never a
    validation attempt.
  - SOAPAction that disagrees with the body is rejected by the bounded prefix scan, in all three
    states.
  - `request: "blocking"` plus a `sample` block fails config validation. `request` other than
    `"blocking"` without `downgradeReason` fails config validation.
  - Sampling is deterministic: the same `(key, request_id)` yields the same decision on every
    instance.
  - Cold-start burst fires for a new key; sticky escalation raises the rate to 100% after a
    failure and decays after the window.
  - Warning-mode failure never changes the response — asserted by comparing status, headers and
    body against the same request with validation `disabled`.
  - Both enabled states emit a `validation.failed` log event with the documented fields; the
    event contains no body bytes when `includeBodyExcerptBytes` is 0, and at most the clamped
    ceiling when it is not.
  - Pool saturation drops samples and increments the drop counter without adding request
    latency, asserted against a latency budget. Blocking-mode budget exhaustion sheds with the
    route's `errorFormat`.
  - SOAP validation rejection returns a well-formed SOAP Fault, not JSON.
- **Policy parity** (§5.5, §5.6) — one test per policy shape found in the estate:
  - `hmac-sa-key-lite` produces a signature byte-identical to the current policy's output for a
    fixed method, path, operation template, date and key. The fixture is captured from the live
    policy before cutover, and the signature is recomputed per request — asserted by two requests
    a second apart yielding different values.
  - `oauth2-client-credentials`: N concurrent cold-cache requests trigger exactly one token
    fetch; the token is reused until `expires_in` minus skew; a 401 from the backend invalidates
    and the next request refetches; a failed token fetch returns 503 and never forwards with an
    empty `Authorization`.
  - Credential stripping: with `forwardCredentials: false` the backend sees neither the
    subscription key header nor the inbound `Authorization`, and does see the injected backend
    credential.
  - Header actions: `remove` → `set` → `append` → `skip` apply in that order and are
    case-insensitive; a client-supplied `SubscriptionName` is overridden, not appended to.
  - `requireHeader` with a pattern returns the configured status, reason, headers and rendered
    JSON body; the `WWW-Authenticate` challenge shape is asserted verbatim.
  - `requireClientCert` rejects on issuer mismatch, on CN mismatch, and on a missing or
    unverified certificate.
  - `allowedSubjectCns` without `caRef`/`allowedIssuers` **and** without
    `acknowledgeCnOnly: true` fails config validation; with the acknowledgement it is accepted
    and appears in `/api/governance/exceptions`. A certificate the proxy did not verify is
    rejected regardless of CN.
  - Template rendering: every variable in the §5.6 list resolves; an unknown `${…}` fails config
    validation rather than rendering empty.
  - `rewrite.path` with `copyUnmatchedParams` preserves unmatched query parameters and
    substitutes `${path.<param>}` from the matched operation template.
  - Response cache honours `vary`, `varyBySubscription`, `mustRevalidate` and the `downstream`
    Cache-Control shaping.
- **Rate limit and quota** (§5.7):
  - Rate limit, single instance: the `C+1`-th call in a window is 429 with `Retry-After`; the
    window resets on the fixed boundary. SOAP Fault on a `soap` route.
  - Rate limit, fleet of N: each instance independently admits up to `C`, so the fleet admits up
    to `C × N` — asserted as the *documented* behaviour, so it is not later "fixed" into a
    coordinated scheme by accident.
  - Rate limit needs no control plane: an instance with `GATEWAY_CP_URL` unreachable still
    enforces correctly from fail-static config, including across a restart.
  - Quota: deltas from several instances aggregate to the fleet count; enforcement uses
    `aggregate + local delta`; exhaustion is 403.
  - Quota: a restarted instance's unreported delta is lost and the counter under-counts rather
    than over-counts. A dropped report is never retried — asserted by dropping one and observing
    an under-count, not a double-count.
  - Quota during a control-plane outage keeps enforcing against the frozen aggregate.
  - `scope: "product"` counts across every API in the product; `scope: "route"` counts per route.
    Both windows align to `periodSec` from a fixed UTC epoch.
- **Streaming** (§5.8):
  - Declaring `websocket: true` alongside `validate.request: "blocking"`, any `transform`, or a
    `cache` block fails config validation. Same for `sse: true` with response transform, response
    validation or cache.
  - WebSocket: the upgrade runs auth, authorize and rate limit; a bad key never gets a 101. Bytes
    flow both ways after; a slow reader backpressures the writer rather than buffering without
    bound.
  - Revoking a subscription closes its open WebSocket and SSE connections at the next poll.
  - `maxConnectionSec` closes and forces reconnect; `streamIdleTimeoutSec` closes a silent stream
    but not a slow-but-alive one; `maxBytesPerConnection` closes on budget.
  - SSE events reach the client individually rather than in a buffered batch — asserted on event
    timing.
  - A stream that fails after the first byte is not retried.
  - `MAX_CONCURRENT_UPGRADES` sheds with 503, and the open-connection gauge is accurate across
    abrupt client disconnects (no leaked goroutines, asserted by count).
  - Rate limit on a WS route counts upgrades, not messages; quota counts one per connection.
- **Backend TLS** (§5.4):
  - Default: a backend with a self-signed certificate fails, and the failure is a gateway error
    with a distinct code, not a generic 502.
  - A CA in `BACKEND_CA_BUNDLE` makes the same backend succeed with no exception row.
  - `mode: "pin"` accepts the pinned certificate and rejects any other, including a
    validly-signed one.
  - `mode: "skip-hostname"` accepts a SAN mismatch but still rejects an untrusted chain.
  - `mode: "insecure"` accepts both, and the request carries the span attribute and increments
    the counter.
  - An exception past `expires_at` is not honoured, **including when the control plane is
    unreachable and the config is served from the fail-static cache** — tested with a clock skip.
  - Creating an exception without `expires_at`, without `reason`, or beyond
    `TLS_EXCEPTION_MAX_DAYS` is rejected. A non-admin member of the owning team is rejected.
  - Control-plane outbound calls (ARM, ES, SendGrid, JWKS) never honour an exception.
  - Changing or expiring an exception recycles that backend's connection pool rather than reusing
    sockets established under the old TLS config.
- **Normalization and export** (§4.1):
  - OpenAPI 3.0, OpenAPI 3.1 and WSDL 1.1 fixtures normalize into the model, and the routing
    table, per-operation policy resolution and compiled artifacts derived from each are asserted.
  - OAS 3.1's JSON Schema 2020-12 dialect and 3.0's subset both produce validators that accept
    and reject the same payloads for equivalent schemas.
  - Re-uploading a semantically identical but reformatted document yields the **same**
    `version_digest`.
  - Export regenerates a valid document a third-party validator accepts, and the test asserts it
    is *not* compared byte-for-byte against the input, so that assertion is not added later.
  - `original` is retrievable verbatim for every non-pruned revision.
- **Revision retention** (§4.1): pruning respects all three exceptions — currently released at
  any age, previous released per environment, referenced by an open plan or undecided approval. A
  pruned revision keeps its row, reports `pruned`, and cannot be released. Shared artifacts are
  reference-counted and survive until the last referrer goes.
- **Artifact cache** (§8.7):
  - A config referencing an unfetched digest does **not** activate until the artifact is present;
    the instance keeps serving the previous config and reports the previous `config_digest`.
  - Artifacts survive a container restart on the mounted volume; a cold instance with a warm
    volume and an unreachable control plane serves and validates correctly.
  - A corrupted cached artifact is detected on read by digest mismatch, evicted and refetched;
    with the control plane down, that route fails closed with 503 while other routes keep serving.
  - Eviction never removes an artifact pinned by the active config.
- **Kafka** (§8.8), against a REST Proxy test double:
  - A topic revision applies partitions, retention and cleanup policy; a schema is registered in
    Schema Registry at release.
  - An incompatible schema fails `?dryRun=1` with the registry's reason and **nothing is
    applied** — asserted by inspecting the double, not the response.
  - A subscription provisions the consumer group and the ACL set implied by its `role`; revoking
    it removes them.
  - An ACL added out of band appears in `/api/drift` and is removed on the next enforcing pass.
  - **A topic missing from desired state is reported as drift and never deleted**, with
    `enforce=true`, in every environment.
  - Consumer-group lag and offsets are read as observed state and never converged.
- **`kafka-proxy`** (§8.9). The first four are regression tests for §16 findings:
  - **Topic charset.** `../`, `?`, `/`, `#`, whitespace, over-249-character and empty topic names
    are rejected with 400 **before** any ACL lookup or URL construction, including a traversal
    payload prefixed with a string a PREFIXED ACL would admit.
  - **Envelope integrity.** A body crafted to close the JSON value and append siblings produces
    exactly one record with the whole body as its value — asserted by inspecting what the REST
    Proxy double received. A non-JSON body is 400.
  - **ACL semantics**, against fixtures: LITERAL exact, LITERAL `*` wildcard, PREFIXED match and
    non-match, `ALL` admitting where `WRITE` is asked, host-scoped ACLs, and **`DENY` on `ALL`
    overriding an `ALLOW WRITE`**.
  - **Principal derivation.** DNs differing only by attribute-type case, inter-RDN spacing,
    escaping or attribute order canonicalize to the same principal. A DN header from an untrusted
    peer is rejected. A missing or unverifiable principal is **401**.
  - ACL lookup failure denies. The cache is keyed per principal; a portal-initiated ACL change
    invalidates immediately, an out-of-band one waits out `aclCacheTtlSec`.
  - With `source: "cluster-acl"`, a caller with no ACL on a topic gets 403 even when the portal
    has a subscription row for it, and vice versa.
  - With `source: "subscription"`, the proxy principal's ACL set equals the union of current
    subscriber grants, and revoking the last subscriber of a topic shrinks it on the next pass.
  - With a closed `topics` map, a topic outside it gets 404 — including one that exists on the
    cluster and that the caller is entitled to — asserted for header, path and query channels.
  - The consumer group is taken from `provisioned_json`; a request supplying its own group name is
    rejected.
  - With `schemaMode: "validate"`, a message failing the topic's registered schema is rejected and
    **nothing is produced**, asserted against the double. With `off`, no Schema Registry call is
    made.
  - Consume polls follow the `base_uri` from consumer-instance creation, so a fleet of N instances
    does not scatter polls across REST Proxy nodes.
  - A batch of `maxRecordsPerRequest + 1` records is rejected; `rateLimit` counts the batch as one
    request.
- **The three-layer chain** (§8.9), end to end against doubles for the REST Proxy and the ACL API:
  - A consumer with a valid subscription but whose *application* has no produce ACL gets 403 from
    layer 2, and nothing is produced.
  - An application with a valid ACL but whose consumer's subscription is revoked gets 401 at layer
    3, and layer 2 is never called.
  - The principal layer 2 evaluates is the calling application's certificate DN, **not** any
    identity the end consumer supplied — asserted by having the consumer present a client
    certificate of its own and confirming it is ignored.
  - A layer-3 API cannot cause layer 2 to target a topic other than its own: the `x-kafka-topic`
    value is a policy literal, and a client-supplied header of the same name is overridden.
- **Derived APIs** (§8.10):
  - Creating one from a topic generates a model whose request body is the topic's schema;
    `GET …/spec?format=openapi-3.1` returns a document a third-party validator accepts.
  - Blocking validation on the derived API rejects a message the topic's schema forbids, and the
    shared proxy is never called.
  - Creating one without a produce grant for the application's principal fails at publish time,
    naming the missing ACL.
  - A topic schema change produces a new **unreleased** revision of each derived API plus a draft
    announcement; the live revision keeps serving until someone releases.
  - Avro constructs known to be lossy (unions, `fixed`, logical types) convert to documented JSON
    Schema equivalents, asserted against fixtures.
- **Data-plane boundary**: spoofed `X-Client-Cert-*` from a non-trusted peer is rejected; the
  gateway refuses to start with client-cert policy and no trusted proxy configured.
- **Fail-static**: kill the control plane, restart a gateway instance, assert traffic continues on
  cached config *and* cached artifacts.
- **E2E**: Playwright against the real binaries, one control-plane binary and DB file per worker.

## 13. Deployment and operations

**Data plane**: N stateless Go instances behind F5/nginx, horizontally scalable, fail-static
(§8.5). This tier carries traffic, and its availability does not depend on the control plane or on
SQLite.

**Control plane**: one Node process, one file, one bundle — and, because there is one SQLite
writer, **one host**. Availability is restart time, not redundancy, which is acceptable only
because control-plane downtime means "no publishing, no promotion, no new subscriptions" and never
"no traffic". Phase 4 raises it to a multi-instance control plane on Postgres if the target
requires it, and the store contract suite (§12) is what keeps that move contained. The deployment
is single-region; a second region serving traffic simultaneously is not in scope. Two things
follow:

- The DB lives on **local or managed block storage**. SQLite on SMB/NFS (including Azure Files) is
  a known corruption path, which rules out the default persistent storage on some Azure hosting.
- **Numbered migration scripts** run at boot, tracked in a `schema_version` table. SQLite's
  `ALTER TABLE` is limited and twenty-seven tables will change.

**All control-plane writes go through one serialized writer queue**, with `busy_timeout` set. The
HTTP API, reconciler and job runner otherwise contend on the single writer and produce
`SQLITE_BUSY`.

### Load budget

The phase-2 gate. Ballpark Go proxy throughput, plaintext on the client side, keep-alive, small
bodies — to be confirmed on real hardware:

| Peak aggregate | Instances | Per instance |
|---|---|---|
| 500 req/s | 2 (redundancy floor) | 1 core / 256 MB |
| 5,000 req/s | 2 | 1 core / 256 MB |
| 50,000 req/s | 6 | 1 core / 256 MB |

At the low end the floor is redundancy, not throughput.

**Streaming is a separate budget** (§5.8): concurrent connections, not requests per second. Each
open WS or SSE stream holds two goroutines, two buffers and one backend connection for its
lifetime, so an instance serving 5 000 req/s and one holding 5 000 open streams are different
machines. Size from expected concurrent streams × buffer size, plus file-descriptor limits on both
the instance and the reverse proxy, and cap with `MAX_CONCURRENT_UPGRADES`. A fleet holding
long-lived connections also drains slowly on deploy: rolling restarts either wait out
`maxConnectionSec` or force reconnects, and that decision needs making once.

**Validation is sized separately and is the dominant variable**, because blocking is the default
(§5.1):

- *Blocking*: `maxBodyBytes × in-flight blocking requests` for memory, and measured p50/p99 schema
  cost × request rate for CPU. Large-envelope SOAP APIs at high rate will force either more
  instances or a downgrade to `warning`, and that trade needs a measurement.
- *Warning*: `VALIDATE_POOL_SIZE` cores at most, regardless of traffic. Size from measured p50 XSD
  cost × expected sample rate.

For the record behind §8.2: Node would need roughly 3× the cores and 4–8× the memory for the same
traffic — a few tens to a few hundred euros a month at internal-platform scale, which is why the
decision was made on isolation and maintenance grounds.

### Backup and restore

Backup is `sqlite.backup()` on a schedule; RPO is that interval, and the backup contains encrypted
subscription keys and encrypted certificate private keys (§4.3), so it is handled as a secret.
Revision pruning (§4.1) bounds backup duration.

Restore is copying a file back — and then **targets come up `paused`**, because an older snapshot
plus an enforcing reconciler means deleting whatever was created since. Review `/api/drift`, then
resume. A restored snapshot may resurrect a TLS exception that had since expired or been revoked;
the data plane's self-expiry (§5.4) is the backstop, and `/api/tls-exceptions` should be reviewed
alongside `/api/drift`.

Software promotion is one artifact per deployable for all environments, with per-environment
settings. Two runtimes means two build pipelines and two container images; the Go image is a
static binary plus libxml2.

### Observability

**OTEL, landing in the internal ELK.** The control plane emits OTLP over HTTP with `fetch`; the
data plane uses the OTel Go SDK for a span per request with propagation and batching. Data-plane
access logs are OTEL log records, batched, bounded buffer, drop counted and alerted. Every span
carries the validation mode and `validated: true|false` (§5.1), and
`backend_tls: verified | pinned | skip-hostname | insecure` (§5.4).

Plus `/healthz`, `/readyz`, per-route counters and latency histograms at `/metrics`, an
append-only `audit` table, and `/api/drift`.

Nine signals get alerts, because they fail silently:

- validation rejections (blocking) — a spike is usually a consumer that just deployed
- validation failures observed (warning) — the same signal without the protection
- validation-sample drops and blocking-budget sheds
- access-log buffer drops
- config-poll staleness per instance — also quota-aggregate staleness (§5.7)
- rate-limit and quota rejections per subscription — a step change is either a consumer that
  changed behaviour or a limit set on the wrong assumption about instance count
- active TLS exceptions, and any within 72 h of expiry
- requests served through a TLS exception, by rate
- artifact-fetch failures and routes failing closed on a missing artifact (§8.7)

There is no separate analytics pipeline and no usage-accounting store, because there is no
metering (§5.7).

## 14. Feature parity

Every current view keeps working. List endpoints are paginated (`?limit=&cursor=`) as a contract,
not per-route.

| Today's view | New surface |
|---|---|
| Discover | `GET /api/resources?kind=&q=` — FTS over a projection of the normalized model (§4.1), no cache tier |
| Workspace | `GET /api/resources?team=mine` |
| Publish | `POST /api/resources` + `POST /api/resources/:id/revisions` (spec upload) |
| Edit (properties, definition, versions/stage) | `PATCH /api/resources/:id`, `PUT /api/revisions/:id/spec` (unfrozen revisions only), `POST /api/resources/:id/releases` — gated by the promotion chain (§6.2) |
| Policies | `GET/PUT /api/resources/:id/policy?environment=` — the assembled document (§5); `PUT/DELETE …/policy/units/:unitKey` for one policy at a time; `POST …/policy/copy-from?units=` to align deliberately |
| *(divergence)* | `GET /api/resources/:id/divergence` — per-unit classification across the promotion chain (§6.4) |
| *(routing)* | `GET/PUT /api/resources/:id/routes` — host + base path per environment, uniqueness enforced |
| *(products)* | `GET/POST /api/products`, `PUT /api/products/:id/members` |
| *(applications)* | `GET/POST /api/applications` — credential holder, per consumer team |
| Subscriptions | `GET/POST /api/subscriptions`, `POST /api/subscriptions/:id/rotate` |
| *(approvals)* | `GET/POST /api/approvals` — gating releases and subscriptions (§6, §9) |
| *(release status)* | `GET /api/resources/:id/releases` — `state` per environment; `?dryRun=1` returns a plan |
| *(validation health)* | `GET /api/resources/:id/validation` — rejections and observed failures per operation and subscription (§5.1) |
| *(usage)* | `GET /api/subscriptions/:id/usage` — quota consumed, window reset, recent rate-limit rejections (§5.7) |
| *(governance)* | `GET /api/governance/exceptions` — validation downgrades, CN-only mTLS routes, JWT without audience, active TLS exceptions, `skipChain` releases |
| *(validation governance)* | `GET /api/validation/downgrades` — every route not `blocking`, with reason, actor and date |
| *(TLS exceptions)* | `GET/POST/DELETE /api/tls-exceptions` — admin-only, dated, with countdown and usage rate (§5.4) |
| Playground | `POST /api/playground` — server-side call through a declared, allowlisted binding |
| Gateways · FleetCard | `GET /api/targets`, `/api/targets/:env/health` (incl. fleet config digests), `/api/drift` |
| Dashboard · AppDashboard | `GET /api/dashboard` — aggregates over the store + observed health, incl. active exceptions |
| Certificates | `GET/POST /api/certificates` — client identities with KEK-encrypted keys; expiry monitoring as a job (§4.3) |
| *(announcements)* | `GET/POST /api/resources/:id/announcements` — auto-drafted from the structural diff, emailed to subscriber teams (§4.2) |
| *(spec export)* | `GET /api/revisions/:id/spec?format=openapi-3.1\|wsdl\|original` (§4.1) |
| *(revision diff)* | `GET /api/revisions/:id/diff?from=` — structural, from the normalized model |
| *(Kafka sub-resources)* | `GET /api/resources/:id/consumer-groups`, `/schemas`, `/acls` — observed and derived state for a topic (§8.8) |
| Logs | `GET /api/resources/:id/logs` — ES adapter; `standalone` access logs via the same ES index |
| Kafka · KafkaEdit | `kind=kafka-topic` — topic, schema, consumer-group and ACL management, control plane only (§8.8) |
| KafkaProxy · KafkaProxyEdit | `kind=kafka-proxy` — the shared internal producer, one per environment, admin-owned (§8.9) |
| KafkaPublish | `POST /api/resources { derivedFrom: <topic> }` — publish an API from a topic (§8.10); plus `POST /api/resources/:id/regenerate` |
| *(playground, Kafka)* | `POST /api/playground` on a topic — produce a test message or read the last N (§8.8) |
| McpServers · McpEdit · A2aAgents · A2aEdit | same resource routes, `kind=mcp` / `a2a` — variants on the one spine (§4.4) |
| FixMe · FixMePanel | `GET /api/jobs?kind=selfheal`, `POST /api/jobs` |
| AdminCacheInvalidation | **removed** — there is no cache to invalidate; `POST /api/reconcile` replaces it |
| *(automation)* | `GET/POST /api/service-tokens`; the same API serves pipelines (§9) |

The SPA keeps React, `pushState` navigation, one stylesheet and its component library. Two
simplifications reach the client: `?environment=` disappears from most calls (environment belongs
to releases, routes, bindings and subscriptions, where it is part of the path), and permission
logic moves out of the client into `capabilities`.

## 15. What this removes

These subsystems cease to exist:

- Response cache, tag taxonomy, per-env version counters, invalidation derivation, scheduled
  reheals, propagation-retry loops
- ARM envelope, `;rev=N` handling, OData `$filter` engine, ARM error emulation
- Policy XML parser, expression sandbox, Liquid engine, policy executor, egress guards (~200 KB,
  and the source of every RCE/SSRF finding to date) — we generate APIM XML from JSON and never
  read it back
- `express`, `express-session`, MemoryStore, CSRF double-submit, three auth modes
- Cross-instance rate-limit **coordination** entirely: gossip, membership, convergence maths,
  allocation. Rate limits are per instance by design (§5.7). Quota keeps a fleet count, but it is
  one sum on the control plane over deltas arriving on a poll that already existed
- Any consumer-facing metering, billing or usage-analytics pipeline — quota counters exist for
  enforcement only (§5.7)
- **Any need for Redis, Memcached or a shared cache tier** — every piece of state has a home
  (§8.5)
- TLS termination, certificate lifecycle and client-side HTTP hardening in application code —
  owned by F5/nginx (§8.1)
- **Undated, invisible, owner-settable "skip TLS verification" flags** — replaced by an admin-only
  table with mandatory expiry and reason (§5.4)
- A second permission model beside the IdP: no role editor, no per-environment role matrix, no
  group-name string munging duplicated in two codebases
- Key-metadata storage modes; ~100 environment variables and their fallback chains
- The shared-DEV-tenant test constraint

## 16. Migration and adoption

Phase 1 is import-only.

- **Adopt, don't recreate.** A per-target `import` run reads existing state and writes `resource`,
  `revision` (rev 1, frozen), `policy_entry` (per environment, per unit — the tenants already hold
  independent policies, so import captures each where it is and marks every unit
  `origin = local`), `route`, `binding`, `product`, `product_member`, `application`,
  `subscription` and `external_id` rows, then a `release` row marked `converged` with a matching
  `applied` row. Imported revisions are recorded as having reached every environment they are live
  in, so the §6.2 gate does not retroactively block a rollback of something already in PROD.
  Without import, everything in the estate is drift on day one. The `kafka` target imports the
  same way: existing topics, configs, registered schemas, consumer groups and ACLs become
  resources, revisions, artifacts and subscriptions, with ACLs reconstructed as derived state so
  anything unexplained shows up as drift rather than being adopted silently.
- **Normalization runs at import** and is the first real test of §4.1. Every existing OpenAPI and
  WSDL document is parsed into the model, and anything that fails to normalize is reported per API
  rather than skipped. Expect a tail of documents that were never valid but that APIM tolerated.
- **Backend client certificates import into `certificate`** (§4.3), with private keys encrypted
  under the KEK. Any certificate already inside its expiry warning window is a finding.
- **Keys are imported, never regenerated.** Regenerating breaks every consumer. This is the step
  that makes the portal the system of record for consumer keys, which is why they are encrypted at
  rest (§4) and why backups are handled as secrets (§13).
- **Route collisions surface at import.** `UNIQUE(environment, host, base_path)` will reject some
  existing state, because APIM permitted it. Import reports the collisions and they are resolved
  before enforce.
- **Remote schema imports surface at import.** WSDLs with remote `xs:import` are rejected by §5.3,
  and half the estate is SOAP, so expect a batch. Bundling each schema set is bounded work and
  removes a live availability dependency on someone else's web server.
- **Backend trust surfaces at import.** Every imported backend is probed for chain and hostname
  validity against `BACKEND_CA_BUNDLE`, and the report is the starting worklist for §5.4: most
  entries fixed by adding an internal CA once, a few by pinning, the residue by dated exceptions.
- **Validation defaults surface the same way.** Imported APIs start `blocking`. Any API whose
  schema set will not validate its own live traffic is a finding to fix or consciously downgrade
  with a reason, and report-only mode is when to find that out.
- **Policy translation is a per-API review.** Import reads each APIM policy document and maps it
  onto §5's vocabulary; anything it cannot map is reported, not guessed at. Translating the
  estate's expression policies produced this list:

  | Found in | Finding | Disposition |
  |---|---|---|
  | `SaKeyLite` signer | The signature cache never hits — `cache-lookup-value` writes variable `Authorization`, the `choose` tests variable `SaKeyLite`. The API works because of it, since the signature covers a timestamp. | Reimplement the intent: sign per request, no cache (§5.5) |
  | `SaKeyLite` signer | PROD credentials (`{{credentials-iasprod-…}}`) embedded in the policy artifact, so promoting it to another environment signs with production keys | Per-environment `appIdRef`/`appKeyRef` |
  | LeanIX token flow | No single-flight: every concurrent request on a cold cache fetches its own token | Single-flight in the scheme |
  | LeanIX token flow | `send-request ignore-error="true"` forwards with an empty `Authorization` when the IdP is unreachable | Fail closed with 503 |
  | Subscription headers | `exists-action="append"` lets a client inject a first `SubscriptionName` value — a spoofing vector into any backend that trusts it | `set` (override) |
  | Shared-secret gate | `!=` on the full `Authorization` header: not constant-time, and scheme-sensitive | `auth.basic` with `credentialRef` |
  | Partner cert gates | `VerifyNoRevocation()` validates the chain *without* revocation despite how the name reads — no revocation is checked today | Decide explicitly; revocation is the proxy's job (§8.1) |
  | Partner cert gates | Identity is CN equality (`SAFMEC9`), sound only because the issuer DN is pinned alongside it | Preserved; CN-only requires `acknowledgeCnOnly` (§5.6) |
  | `validate-jwt` (vwidp) | No `audience` — any token from that issuer is accepted | Flag per API; set an audience or record why not |
  | `traceparent` gate | .NET regex with a 500 ms backtracking timeout | RE2, no backtracking, timeout unnecessary |

  The Kafka produce API (§8.9) is the largest single translation. **Two of these are exploitable
  today and should be fixed in the current policy regardless of this programme's timeline.**

  | Found in | Finding | Severity | Disposition |
  |---|---|---|---|
  | `rewrite-uri "/topics/" + topicName` | The `x-kafka-topic` header reaches a URL template with **no charset validation**. A PREFIXED ACL on e.g. `orders` admits `orders/../../v3/clusters/<id>/acls`, which passes the ACL check and then redirects the call elsewhere in the REST Proxy API — path traversal into cluster administration | **exploitable** | Validate `^[a-zA-Z0-9._-]{1,249}$` before use, URL-encode on build (§8.9) |
  | `set-body` string concatenation | The client body is concatenated into `{"records":[{"value": …}]}`, so a crafted body can close the value and add siblings — extra records, a message `key`, an explicit `partition` | **exploitable** | Serialize from a typed structure (§8.9) |
  | ACL evaluator | Only `operation == "WRITE"` is considered, so a **`DENY` on `ALL` is ignored** while an `ALLOW WRITE` elsewhere still admits the caller. Kafka treats `ALL` as a superset and DENY as precedent | **security** | Compiled evaluator with Kafka's real semantics (§8.9) |
  | `clientDN` fallback | Falls back to the `X-SSL-Client-DN` header, which is the *primary* path when TLS terminates at F5. Anything that can reach the gateway directly can assert any DN | **security** | §8.1's trusted-proxy boundary, enforced as a boot failure |
  | ACL evaluator | `LITERAL` with `resource_name = "*"` is not treated as a wildcard, and `ALL` is not accepted for allow. Both fail *closed*, so entitled callers get 403 | functional | Same compiled evaluator |
  | ACL evaluator | Only `host == "*"` matches; host-scoped ACLs are ignored (fails closed) | functional | Same |
  | `clientDN` normalization | `Subject.Replace(", ", ",")` plus `Ordinal` comparison is not DN canonicalization — attribute-type case, escaping, ordering and multi-valued RDNs all break it | correctness | RFC 4514 canonicalization in `principalFrom` |
  | `"DN not found"` sentinel | A missing principal becomes a string that matches no ACL, so the caller gets 403 where 401 is the truth | diagnostics | 401 on missing or unverifiable principal |
  | ACL cache key | Keyed `acl:{DN}:{topic}` but the cached value is the principal's *whole* ACL list, so one principal is cached once per topic touched | efficiency | Cache per principal (§8.9) |
  | ACL cache TTL | 120 s means an ACL revoked in the cluster keeps working for up to two minutes | accepted; state it | `aclCacheTtlSec`, surfaced in the UI; portal-initiated changes push an invalidation |
  | `{{kafka-admin-subscription-key}}` | A shared key granting produce to **any** topic is forwarded on every call; the ACL check is the only constraint | design | Target credential held by the data plane, never a published-API key |
  | `backendBase` = `{{gw-base-url}}/…` | The ACL lookup and produce leave the gateway and re-enter through F5 as calls to the Kafka team's published API | **not a defect** | Keep — the hop is the ownership boundary (§8.9). Only the reconciler goes direct, to avoid a cold-start circular dependency |
  | Body shape | Single record only; no key, no batch, no schema validation | feature | `recordsFrom`, `keyFrom`, `maxRecordsPerRequest`, `schemaMode` |

  Rate limits and quotas import as policy fields, with one behaviour change per API: APIM enforces
  a rate limit roughly fleet-wide, `standalone` enforces it per instance (§5.7), so the effective
  ceiling multiplies by instance count. It is a loosening, so nothing breaks at cutover and no
  consumer sees a new 429 — but the import report states the new effective number per API, and the
  choice is to keep it, divide the configured value by instance count, or move that limit to the
  edge. Quota is unaffected.
- **Dual-run per environment.** Import, then run with `enforce=false` and read `/api/drift` until
  it is quiet — the acceptance test for the reconciler against real data. Then flip
  `enforce=true`, one environment at a time.
- **Then dual-run the data plane.** Point `standalone` at an imported API, compare responses
  against `apim` for that route, and cut over per API by changing which adapter owns the route.
  Reverting is the same switch. Start with `rest`, where blocking validation is cheap and
  behaviour is easiest to compare; move `soap` once its validation cost is measured.
- **The off switch is `paused`.** If the reconciler misbehaves, pause the target: the gateway keeps
  serving traffic, since the reconciler only writes configuration.
- **The old portal stays readable** until PROD has run enforcing for a full release cycle.

## 17. Delivery phases

Two independent axes. Phases deliver *capability* — software that behaves identically everywhere,
one artifact per deployable with per-environment settings (§13). Environments are adopted one at a
time on a separate axis (§17.2), running the same sequence each time. DEV, TEST and PROD differ
only in `target.enforce`, `target.paused`, whether releases into them need an approval, and how
much care the cutover gets — all settings. No phase below names an environment.

### 17.1 Capability phases

| Phase | Ships | Done when |
|---|---|---|
| 1 | Store + store contract tests, HTTP API, OIDC auth, service tokens, spec normalization and export (§4.1), `apim` adapter, import (incl. backend-trust and schema-import reports), reconciler in report-only mode | Drift is quiet against imported real state in the first adopted environment; every API round-trips through the model; route collisions, remote schema imports and untrusted backends triaged |
| 2 | `standalone` gateway in Go behind F5/nginx (routing, §5.2 pipeline, named backend-auth schemes, blocking validation, verified backend TLS + `tls_exception`, rate limit + quota, bidirectional fail-static config + artifact cache); releases, the promotion gate and per-unit policy merge (§6), approvals, products, applications, subscriptions, jobs; SPA on the new API | A promotion is one release row that passes the chain gate, and one real `rest` API — rate-limited, with a backend-auth scheme — is served by `standalone` with response parity against `apim`, inside the §13 load budget |
| 3 | `warning` mode with sampling and the async pool; the remaining variants — `soap`, `kafka` (§8.10), `websocket` (§5.8), `mcp`, `a2a`; `kafka` adapter (§8.8) then `kafka-proxy` (§8.9); certificates, announcements, divergence reporting, logs, dashboard | Feature parity table (§14) fully served across every variant; topics/schemas/groups/ACLs reconciled with drift quiet; one application publishing to a topic through the full three-layer chain |
| 4 | Postgres store + multi-instance control plane, if HA is required | Control-plane HA target met; the single-host limit in §13 lifted |

Blocking validation and verified backend TLS ship in phase 2 because they are the defaults.
Sampled `warning` mode lands in phase 3 because `rest` cutover needs none of it, and shipping the
blocking path first means the sampling machinery is built against measured XSD costs. Phase 4 is a
decision, not a commitment.

### 17.2 Environment rollout

Each environment runs the same four steps, independently — described in full in §16. It is the
same software with `enforce` flipped at a different time.

1. **Import** the environment's existing state and triage what the import reports.
2. **Report-only** — `enforce=false`, read `/api/drift` until it is quiet.
3. **Enforce** — flip `enforce=true`.
4. **Cut over** APIs to `standalone`, per API, reversible by the same switch.

The order across environments is DEV → TEST → PROD, for confidence rather than capability: each
environment's report-only period is evidence for the next. PROD's cutover is done in agreed
tranches, and the old portal stays readable until PROD has run enforcing for a full release cycle.

The two axes cross: the same environment can be at step 2 for one phase's capabilities and step 4
for another's. A DEV target can be enforcing HTTP resources while its Kafka target has not been
imported, because targets are per (environment, adapter) and carry their own `enforce` and
`paused`.

## 18. Open points

### Needs a number, not a decision

1. **Load budget confirmation** (§13) — the throughput and memory figures are ballpark and are the
   phase-2 gate.
2. **Blocking-validation ceiling** (§8.6) — `BLOCKING_BUFFER_BUDGET_BYTES` and the shed behaviour
   need measured XSD cost on real payloads.
3. **Streaming connection budget** (§13) — concurrent streams per instance, file-descriptor
   limits, and the rolling-restart drain policy.
4. **Artifact volume sizing** (§8.7) — one bundle per released resource per environment, measurable
   as soon as import runs in phase 1.
5. **`node:sqlite` verification** (§2) — confirm against the exact Node minor, including that
   `backup()` is present.

### Still undefined

6. **Kafka ACL cache TTL** (§8.9). The current 120 s carries forward as the default, and
   portal-initiated changes invalidate immediately, so the exposure is out-of-band ACL removals.
   Whether two minutes is acceptable for PROD topics needs deciding explicitly.
7. **`schemaMode` per topic** (§8.9). Parity is `off`. With derived APIs validating at layer 3
   (§8.10) the layer-2 check is a second line, so the question is which topics warrant both, and
   who tells producers before they start getting 400s.
8. **Whether policy deletions should propagate** (§6.3). They do not today, which is the safe
   default but means a deletion has to be repeated per environment. The answer probably differs
   for `auth.*` units versus `cors`.
9. **Policy-unit granularity is a compatibility promise** (§5). The unit table is the boundary at
   which promotion, divergence and audit operate, so splitting a unit later — `headers.request`
   into per-header units, say — changes merge behaviour for existing APIs. Worth settling before
   phase 2.
10. **GraphQL as a variant** (§4.4). Reserved, not designed. Open questions: whether a single POST
    endpoint can carry per-operation policy, what `blocking` validation means against a schema
    rather than a request body, how depth and complexity limits fit the closed vocabulary, and
    whether persisted queries become the unit subscriptions and rate limits attach to.
11. **`websocket` as a variant vs. a flag** (§4.4, §5.8). It is a variant because that is how users
    think about it, but the mechanics are `passthrough` on an otherwise ordinary route. A REST API
    that also offers an SSE endpoint would strain the framing.
12. **Search** (§14). "FTS over a projection of the model" — which fields the projection contains
    (title, description, operation list, tags) and how they are weighted is unspecified.
13. **Backend health checks.** `binding` carries health-check settings (§5.3); active vs passive,
    thresholds, and interaction with the circuit breaker are unspecified.
14. **`gateway_instance` bootstrap.** Per-instance tokens are pre-provisioned (§4, §11). How a new
    instance obtains one in a container or autoscaled deployment is undefined — probably a
    bootstrap token that mints per-instance credentials on first poll.
15. **Idempotent creates for automation.** Service tokens drive CI (§9); `POST /api/resources` and
    friends need an idempotency key or a declarative upsert, or every pipeline re-run creates
    duplicates.
16. **Schema Registry subject naming and compatibility defaults** (§8.8) — subject strategy
    (`TopicNameStrategy` or otherwise) and the default compatibility mode for a new topic.
17. **One data-plane fleet per environment** is assumed by `target` and `gateway_instance` (§4) but
    never stated as a constraint.
18. **Automated certificate issuance** (§4.3). The store holds certificates and warns before they
    expire; obtaining and installing a new one is a human step. An ACME or internal-CA endpoint
    would change that.
