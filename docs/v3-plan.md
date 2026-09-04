# MVP v3 implementation plan — Integration Portal

Draft 4 · what changes to take the shipped v2 (see [`v2-plan.md`](v2-plan.md)) to seven new goals,
without abandoning the spine of [`greenfield-design.md`](greenfield-design.md).

Drafts 1 → 4 and the reasoning behind every change are in
[`v3-plan-review.md`](v3-plan-review.md) — 83 findings over four rounds; round 5 found nothing.
Finding ids appear inline as `[R1-01]`. v1's (`R…`, `I…`) and v2's (`V…`) findings still hold and
are not repeated.

---

## 1. Goals, restated as acceptance criteria

| # | Goal | Acceptance test |
|---|---|---|
| G1 | Request **and** response validation — headers and bodies, REST and SOAP, from the API's own definition | A `rest` API whose OpenAPI declares `petId: integer` rejects `{"petId":"x"}` with `400` and a body naming the failing JSON pointer, **before** the backend is called. A `soap` API rejects an envelope whose body element violates the WSDL's inline XSD, as a SOAP Fault. A missing required header declared in the spec is `400`. A backend response that violates the declared response schema is `502` when `response: "blocking"`. All three states are asserted, and `warning` never changes a response |
| G2 | A global policy applied to every API in an environment, merged into API-level policy, API-level winning any conflict | An admin attaches `rateLimit` globally in `dev`; an API with no `rateLimit` of its own is rate limited by it, and an API with its own `rateLimit` keeps its own values. Detaching the global unit removes it from the first API and leaves the second untouched. The API's policy screen shows, per unit, whether the value is the API's or the environment's |
| G3 | The rest of the design's policy vocabulary | Every unit in §5's document is attachable, validated on write, interpreted by the gateway, and covered by a test: `auth.basic`, `auth.jwt`, `auth.introspection`, `auth.mtls`, `validate`, `rewrite` (path and query), `headers.response`, `transform`, `cors`, `cache`, `retries`, `circuitBreaker`, `ipAllow`, `quota`, `passthrough` (WebSocket and SSE), `backendAuth`, `preconditions` (four checks), and per-operation overrides |
| G4 | MCP — publish existing MCP servers and subscribe to them like APIs | An existing MCP server is published by URL: the control plane completes an MCP handshake, stores the tool list as the contract, and the gateway serves it at a base path. A consumer subscribes to a product containing it, gets a key, and drives `initialize` / `tools/list` / `tools/call` through the gateway with a subscription key, a rate limit and blocking validation of each tool's `inputSchema`. A rejection is a JSON-RPC error, not `problem+json` |
| G5 | A2A — publish existing A2A endpoints and subscribe to them like APIs | An existing A2A agent is published by URL: the control plane fetches its Agent Card, stores it as the contract, and the gateway serves the card at `<basePath>/.well-known/agent-card.json` **with the URL rewritten to the gateway**, so a consumer discovers the gateway rather than the origin. `message/send` is proxied with validation; `message/stream` streams as SSE |
| G6 | A Catalog — a marketplace over APIs, MCP servers and A2A agents, with search, sorting and a presentation worth reading, where a consumer can inspect and subscribe | `GET /api/catalog?q=pet&kind=mcp&tag=orders&sort=popular` returns ranked cards from a full-text index over the normalized model. The UI shows a browsable marketplace with facets and sort, a detail page per listing (what it does, its operations/tools/skills, which environments it is live in, how to call it), and a subscribe flow that ends with a key |
| G7 | Several backends per API, with load balancing and a circuit breaker | A binding holds a pool. With `round-robin`, N requests spread across the pool; with `failover`, everything goes to the first healthy backend. A backend that fails repeatedly is taken out by the circuit breaker, traffic continues on the rest, and it is probed back in after `openSec`. With every backend open, the route answers `503` in its own error format with outcome `pool-open` |

G1's rejections, G2's precedence, G4's and G5's "like APIs" (same products, subscriptions,
promotion, telemetry), and G7's arithmetic are the contract.

---

## 2. What is in and what is deliberately out

### In scope, on top of v2

- **§5.1 validation in full**, minus the dependency: compiled artifacts on their own channel
  (§8.7), a JSON Schema validator and an XSD validator written here, three states, sampling and a
  bounded pool for `warning`, the `always` block enforced in every state, `downgradeReason`,
  governance reporting.
- **§5's remaining vocabulary**, listed in G3.
- **§5.7 quota**, fleet-wide, aggregated on the poll that already exists.
- **§5.8 streaming**, WebSocket and SSE, with the exclusion table enforced at write time.
- **§5.4 backend TLS**: verified by default, dated admin-only exceptions, self-expiring on the
  gateway.
- **§4.3 certificates**, because `backendAuth: mtls` and `binding.clientCertRef` need somewhere to
  put a private key.
- **§4.4's `mcp` and `a2a` variants**, including discovery from a live endpoint.
- **§14's Discover, properly**: FTS over a projection of the normalized model, presented as a
  marketplace.
- **§5.3's backend pool**, load balancing and failover, with a per-instance circuit breaker
  (§5's `circuitBreaker`) and `retries`.
- **A global policy tier**, which the design does not have — see D18.

### Out of scope (named, with the section it comes from)

`kafka` / `kafka-topic` / `kafka-proxy` (§8.8–§8.10) and the whole Kafka chain · `graphql` (§4.4)
· the `apim` adapter and import (§8, §16) · approvals and announcements (§4.2, §6.3) · drift (§7)
· OIDC (§9) · service tokens (§9) · OTEL/ELK (§13) · revision pruning (§4.1) · Postgres (§13) ·
automated certificate issuance (§4.3) · active health checking of backends (§18.13 — the circuit
breaker is passive, and no `healthCheck` field is introduced, so nothing reads as configured and
unimplemented).

**Every out-of-scope item stays absent, not stubbed** — the rule v2 set and this plan keeps.

### Deviations from the design

D1–D17 stand. New ones:

| # | Design says | v3 does | Reason |
|---|---|---|---|
| D12′ | Blocking XSD validation for `soap` via libxml2 (§2, §5.1) | XSD validation **is** implemented, by a validator written here over a documented subset of XSD 1.0 | D12 is retired. libxml2 is not available to Bun without a native dependency, and the design's own budget calls it "**1** + a C library". A subset validator with an enumerated exclusion list is honest; "no validation for half the estate" is not. §6.1 lists exactly what it does and does not check, and a WSDL using an unsupported construct is **rejected at import**, so nothing is silently unvalidated |
| D18 | Policy is per resource and per environment (§5, §6.1); there is no environment-wide tier | A `global_policy_entry` tier per environment, admin-only, merged **under** the resource's own units | G2. The design has no such concept, so this is an addition rather than a reinterpretation. It is deliberately the weaker side of every conflict, it is never promoted, only an allowlisted set of units may be attached to it, and the API's policy screen names the origin of every unit — otherwise "why is this API rate limited" stops being answerable from the API's own page |
| D19 | Warning-mode validation runs in a pool of OS threads, bounded by a semaphore, with per-request isolation (§8.2, §8.4) | A bounded queue drained on the event loop with explicit yields between items | D1 already accepted a TypeScript data plane; this is its consequence. Queue depth and concurrency are bounded and saturation is counted exactly as §8.4 requires, but the work is not isolated from the request path the way a goroutine is. `VALIDATE_POOL_SIZE` therefore also bounds how much of a tick validation may take, and the capacity harness measures the cost |
| D20 | `auth.forwardCredentials` is a field of `auth` (§5) | A field of each `auth.*` unit | `auth` is not a policy unit; each method is. A field on a non-unit has no home in `policy_entry` |
| D21 | `transform: { request, response }` with `soap-to-json` (§5) | `response` accepts `none` and `soap-to-json`; `request` accepts `none` only | Turning JSON into a SOAP envelope requires generating XML from the XSD — a writer, not a reader. The schema rejects any other value with a message that says so |
| D22 | Backend client certificates and compiled artifacts reach the gateway on a persisted, encrypted volume (§8.7) | Both are fetched over the instance-token channel and cached in `GATEWAY_ARTIFACT_CACHE`; key material is written `0600` into a separate directory | Volume encryption is a deployment fact this repo cannot assert. The gateway logs a warning at boot when the cache directory is world-readable |
| D23 | A `kafka` policy unit exists (§5, §8.9) | Absent | Nothing in this repo talks to Kafka. Introducing the unit would be a stub |
| D24 | A PFX may be uploaded with its passphrase (§4.3) | PEM only — certificate, optional chain, PKCS#8 private key | A PKCS#12 parser is a dependency or a week. The upload form says PEM `[R2-21]` |
| D25 | Creating, changing or expiring a TLS exception recycles that backend's connection pool (§5.4) | The TLS options are passed per request; a change binds on the next new connection | Bun's `fetch` owns its connection pool and does not expose recycling. The window is one idle timeout and is stated in the UI beside the exception `[R2-22]` |

---

## 3. Shape

Nothing moves. Two new channels between the planes, both on the existing instance token:

```
                        Browser (React SPA)
                               │ /api
        ┌──────────────────────▼───────────────────────────────────────┐
        │ CONTROL PLANE — Bun/TS                            :8080      │
        │  resources · versions · policy (+ GLOBAL tier) · promotion   │
        │  artifact compiler · catalog + FTS · quota aggregate         │
        │  certificates · tls exceptions · fleet · telemetry           │
        │  POST /api/gateway/poll        config + quota ⇄ telemetry    │
        │  GET  /api/gateway/artifacts/:digest    compiled validators  │
        │  GET  /api/gateway/certificates/:id     client identities    │
        │                             bun:sqlite .data/apim.sqlite     │
        └───┬──────────────┬──────────────┬──────────────┬─────────────┘
        ┌───▼────┐    ┌────▼───┐    ┌─────▼──┐    ┌──────▼─┐
        │ DP 8081│    │ DP 8082│    │ DP 8083│    │ DP 8084│
        │ dev-1  │    │ dev-2  │    │ test-1 │    │ prod-1 │
        └───┬────┘    └────┬───┘    └─────┬──┘    └──────┬─┘
            └──────────────┴──────┬───────┴──────────────┘
                    ┌─────────────┼──────────────┐
                    ▼             ▼              ▼
             tools/backend   tools/mcp      tools/a2a
             :9080 REST+SOAP :9085 MCP      :9086 A2A agent
             +SSE +WS        server         (agent card, JSON-RPC, SSE)
             --instance=N
```

`tools/backend` grows `--instance=N`, so three copies on three ports answer with a
distinguishing header — which is what makes a round-robin assertion possible `[R4-06]`.

### Layout — what is added

```
shared/
  jsonschema.ts     JSON Schema (2020-12 subset + OAS 3.0 dialect) compiler and validator
  xsd.ts            XSD 1.0 subset compiler and validator, on shared/xml.ts
  json-reader.ts    bounded JSON reader: depth, array length, duplicate keys (§5.1 `always`)
  jsonrpc.ts        JSON-RPC 2.0 envelope, error shapes, batch rules
  mcp.ts            MCP manifest → ApiModel, method table, tool selector
  a2a.ts            Agent Card → ApiModel, method table, card rewriting
  quota.ts          fixed-window maths shared by both planes
  backend.ts        pool shape, selection rules, breaker states
  opmatch.ts        path-template matching and ${path.*} extraction
control-plane/src/
  schema-003.sql    migration 3
  artifacts.ts      model → compiled validation bundle, content-addressed
  normalize-mcp.ts  normalize-a2a.ts  discovery.ts
  globals.ts        the global policy tier and the effective-document merge
  search.ts         FTS5 projection and indexing
  quota.ts          fleet aggregate, batched flush
  certificates.ts   PEM parsing, KEK encryption, expiry
  api/market.ts     the Catalog API
  api/policy.ts     global policy + effective policy + governance
  api/trust.ts      certificates + tls exceptions
data-plane/src/
  artifacts.ts      artifact + certificate cache, digest-verified, fail-static
  validate.ts       request/response validation, sampling, the bounded pool
  backend.ts        pool selection, circuit breaker, retries
  identity.ts       auth.basic | jwt | introspection | mtls
  backend-auth.ts   the named schemes of §5.5
  cache.ts          the per-instance response cache
  quota.ts          local counters and the fleet aggregate
  stream.ts         WebSocket and SSE passthrough, and the stream registry
  rpc.ts            MCP and A2A operation resolution
tools/
  mcp/server.ts     a real-enough MCP server to publish
  a2a/agent.ts      a real-enough A2A agent to publish
ui/src/views/
  MarketView.tsx  MarketListing.tsx  GlobalPolicyView.tsx  TrustView.tsx
docs/v3-plan.md  docs/v3-plan-review.md
```

---

## 4. Data model changes — `schema-003.sql`

`db.ts` gains one entry: `{ version: 3, name: "v3", file: "schema-003.sql" }`. No table is
rebuilt, so no `foreignKeysOff` and no repeat of `[V1-02]`.

```sql
-- G1 §8.7 — compiled validators, content-addressed and immutable
CREATE TABLE artifact (
  digest      TEXT PRIMARY KEY,           -- sha256 of `bytes`
  kind        TEXT NOT NULL,              -- 'json-schema' | 'xsd-set'
  bytes       TEXT NOT NULL,              -- the compiled bundle, JSON
  size_bytes  INTEGER NOT NULL,
  created_at  TEXT NOT NULL
);
-- One bundle per revision; two revisions with an unchanged schema share one row (§4.1). Pruning
-- is out of scope, so the reference count is a COUNT over this column rather than a table [R3-02].
ALTER TABLE revision ADD COLUMN artifact_digest TEXT;

-- G2 D18 — the environment-wide tier, admin-only, never promoted
CREATE TABLE global_policy_entry (
  environment TEXT NOT NULL,
  unit_key    TEXT NOT NULL,
  value_json  TEXT NOT NULL,
  updated_by  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (environment, unit_key)
);

-- G3 §4.3 — client identities we present, with their private keys
CREATE TABLE certificate (
  id          TEXT PRIMARY KEY,
  team_id     TEXT NOT NULL REFERENCES team(id),
  environment TEXT NOT NULL,
  name        TEXT NOT NULL,
  cert_pem    TEXT NOT NULL,
  chain_pem   TEXT,
  key_enc     TEXT NOT NULL,              -- KEK-encrypted PKCS#8 PEM
  thumbprint  TEXT NOT NULL,              -- sha256 of the DER, uppercase hex
  subject     TEXT NOT NULL,
  issuer      TEXT NOT NULL,
  not_before  TEXT NOT NULL,
  not_after   TEXT NOT NULL,
  usage       TEXT NOT NULL,              -- 'backend-mtls'
  created_by  TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  UNIQUE (team_id, environment, name)
);

-- G3 §5.4 — admin-only, always dated, self-expiring on the gateway
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

-- G3 §5.7 — the fleet quota aggregate. Enforcement only; not a ledger (D15 still holds)
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

-- G6 — marketing metadata and the search projection
ALTER TABLE resource ADD COLUMN summary       TEXT;
ALTER TABLE resource ADD COLUMN description   TEXT;
ALTER TABLE resource ADD COLUMN tags_json     TEXT NOT NULL DEFAULT '[]';
ALTER TABLE resource ADD COLUMN docs_url      TEXT;
ALTER TABLE resource ADD COLUMN icon          TEXT;          -- one emoji or short glyph
ALTER TABLE resource ADD COLUMN visibility    TEXT NOT NULL DEFAULT 'listed';  -- listed|unlisted
ALTER TABLE resource ADD COLUMN discovery_url TEXT;          -- G4/G5: what regenerate re-fetches
ALTER TABLE product  ADD COLUMN summary       TEXT;
ALTER TABLE product  ADD COLUMN description   TEXT;
ALTER TABLE product  ADD COLUMN tags_json     TEXT NOT NULL DEFAULT '[]';

CREATE VIRTUAL TABLE resource_fts USING fts5(
  resource_id UNINDEXED, name, title, summary, description, tags, operations,
  tokenize = 'unicode61 remove_diacritics 2'
);
```

### Notes

- **`artifact.bytes` is the compiled bundle, not the source schema.** A JSON Schema bundle is
  `{ dialect, defs, operations: { <id>: { parameters, request, responses } } }` with every `$ref`
  already resolved into `defs` and every `pattern` already linted. An XSD bundle is
  `{ elements, complexTypes, simpleTypes, namespaces }`. The gateway compiles neither OpenAPI nor
  WSDL — §8.7's rule, kept.
- **Artifacts are compiled when the revision is created**, not at release, so attaching `validate`
  to an API that was released months ago works, and so compilation happens once per contract rather
  than once per environment it reaches. Migration 3 enqueues one idempotent `compile-artifacts`
  job that backfills every existing revision `[R3-01]`.
- **`artifact_digest` may be NULL.** A revision whose document declares no schemas anywhere
  produces no bundle, and a route with no bundle has nothing to validate against: each operation
  reports `no-schema` rather than failing closed `[R1-14]`.
- **`usage_counter` has `period_sec` in its key.** Two policies on one subscription with different
  windows are different counters; without it they collide on `window_start`.
- **`resource_fts` is maintained by `search.ts`** on resource create/patch/delete, revision create,
  release reaching `converged`, and product-membership change, and is rebuilt at boot when it is
  empty while `resource` is not `[R2-10]`. Triggers cannot do it: the projection includes the
  operation list, which lives inside `revision.model` as JSON.

---

## 5. The policy vocabulary, completed (G3)

`shared/policy.ts` grows from eight units to the set below. It stays one file, one closed list,
one validator used by both planes.

| Unit | Values | Step (§13) | Global? |
|---|---|---|---|
| `auth.subscriptionKey` | `in`, `name`, `forwardCredentials` | 6 | ✓ |
| `auth.basic` | `credentialRef`, `realm`, `forwardCredentials` | 6 | ✓ |
| `auth.jwt` | `issuerRef`, `headerName`, `scheme`, `audience[]`, `requiredScopes[]`, `scopeMap`, `clockSkewSec`, `forwardCredentials` | 6, 11 | ✓ |
| `auth.introspection` | `issuerRef`, `cacheTtlSec`, `requiredScopes[]`, `forwardCredentials` | 6 | ✓ |
| `auth.mtls` | `allowedIssuers[]`, `allowedSubjectCns[]`, `allowedSans[]`, `acknowledgeCnOnly` | 6 | ✓ |
| `ipAllow` | CIDR list | 4 | ✓ |
| `cors` | `origins[]`, `methods[]`, `headers[]`, `exposeHeaders[]`, `credentials`, `maxAgeSec` | 5, 21 | ✓ |
| `preconditions` | ordered `{check, deny}`; `requireHeader`, `requireQuery`, `requireClientCert`, `requireOperation` | 10 | ✓ |
| `validate` | §6 | 3, 12, 20 | ✓ |
| `rewrite` | `stripBasePath`, `path`, `copyUnmatchedParams`, `query.set`, `query.remove` | 13 | — |
| `headers.request` | `remove`, `set`, `append`, `skip` | 14 | ✓ |
| `headers.response` | `remove`, `set`, `append`, `skip` | 21 | ✓ |
| `transform` | `request: "none"`, `response: "none" \| "soap-to-json"` | 20 | — |
| `cache` | `ttlSec`, `vary[]`, `varyBySubscription`, `mustRevalidate`, `downstream`, `maxBodyBytes` | 16, 23 | — |
| `rateLimit` | `calls`, `periodSec`, `per`, `by`, `scope: route\|product`, `emitHeaders` | 8 | ✓ |
| `quota` | `calls`, `periodSec`, `per: "fleet"`, `by`, `scope`, `emitHeaders` | 9 | ✓ |
| `timeoutMs` | integer | 19 | ✓ |
| `retries` | `attempts`, `on[]`, `idempotentOnly` | 19 | ✓ |
| `circuitBreaker` | `failures`, `windowSec`, `openSec`, `halfOpenProbes` | 17, 19 | ✓ |
| `concurrency` | `maxInFlight`, `per`, `retryAfterSec` | 19 | ✓ |
| `backendAuth` | `none \| basic \| api-key \| oauth2-client-credentials \| hmac-sa-key-lite \| mtls` | 18, 22 | — |
| `passthrough` | `websocket`, `sse`, `streamIdleTimeoutSec`, `maxConnectionSec`, `maxConcurrentConnections`, `maxBytesPerConnection` | 1–14 then copy | — |
| `errorFormat` | `shape: problem+json \| soap-fault \| jsonrpc`, `soapVersion` | every rejection | — |
| `operations["<id>"].<unit>` | its own unit, for `validate`, `rateLimit`, `quota`, `timeoutMs`, `cache` | as the base unit | — |

The **Global?** column is an allowlist, not an exclusion list, so a unit added later is not
globally attachable until somebody decides it should be `[R2-08]`. The six that are not are per-API
by nature: `errorFormat` is derived from the variant, `rewrite` and `transform` and `backendAuth`
and `cache` describe one backend and one contract, `passthrough` changes what a route *is*, and an
operation id means nothing outside the API that declares it.

### 5.1 Per-operation units

A per-operation override is its own unit (§5), so the unit key is a string, not an enum member:

```
operations["getInventory"].rateLimit
operations["tools/call:search"].validate
```

Validated by shape: `operations["<id>"].<base>` where `<id>` matches `^[A-Za-z0-9._:/{}-]{1,120}$`
and `<base>` is one of the five overridable units. The key is stored verbatim in
`policy_entry.unit_key`, so promotion, divergence and the global merge treat it like any other unit
with no special case `[R1-05]`. `PolicyDocument` gains an index signature for these keys `[R3-06]`.

`auth.*` is **not** overridable per operation `[R2-04]`. Route authentication has already run at
step 6 by the time the operation is known at step 11, so an override could only re-authenticate
against a different credential or silently loosen the route. Per-operation authorization is
expressed where the design already puts it: `auth.jwt.scopeMap`, keyed by operation id or by the
design's `"GET /orders"` form `[R3-14]`, evaluated at step 11.

`rateLimit` and `quota` overrides are **additional** counters, not replacements: both the route
counter and the operation counter are enforced, so the stricter binds by arithmetic and no schema
rule is needed to prevent an override loosening a route `[R2-04]`.

### 5.2 Cross-unit constraints, on every assembled document

1. `rateLimit`/`quota` count `by: "subscription"`, and only `auth.subscriptionKey` resolves to one,
   so that unit must be present in the **effective** document `[R1-02]`.
2. `errorFormat.shape: "soap-fault"` only on `soap`; `"jsonrpc"` only on `mcp` and `a2a`.
3. §5.8's exclusion table: `passthrough.websocket` forbids `validate.request != "disabled"`, any
   `transform`, and `cache`; `passthrough.sse` forbids `validate.response != "disabled"`,
   `transform.response`, and `cache`.
4. `validate.request != "blocking"` requires `downgradeReason`.
5. A `sample` block with both directions `blocking` is a schema error `[R1-06]`.
6. `auth.mtls`, `preconditions.requireClientCert` and any `${cert.*}` variable require a gateway
   configured with a trusted proxy. The control plane **warns** (it cannot see the fleet's
   configuration); the gateway **refuses to activate** such a config without `TRUSTED_PROXY_CIDRS`
   `[R1-21]`.
7. `cache` with `auth.subscriptionKey` and `varyBySubscription: false` is a **warning** — right for
   public reference data, wrong for anything else.
8. `backendAuth: "mtls"` requires `binding.clientCertRef` in that environment: an error on the
   policy write when the binding exists, a blocker on the release plan otherwise.
9. `validateDocument(doc, { tier: "global" })` relaxes constraint 1, because a global `rateLimit`
   with per-resource auth is legitimate; the per-resource effective validation is the real gate
   `[R2-17]`.

### 5.3 Where the values that are not URLs come from

`INTEGRATIONS_FILE` grows the reference maps §5.5 and §5.6 name, so no owner writes a URL or a
secret into policy:

```jsonc
{
  "egressAllowlist": [...], "denyCidrs": [...], "xml": {...},
  "issuers": {
    "vwidp-dev": { "issuer": "https://idp.test/", "jwksUrl": "https://idp.test/keys",
                   "algorithms": ["RS256","ES256"], "audienceDefault": ["portal"],
                   "introspectionUrl": "https://idp.test/introspect",
                   "credentialRef": "vwidp-client" }
  },
  "tokenProviders": {
    "leanix": { "tokenUrl": "https://…/token", "credentialRef": "leanix-client",
                "grant": "client_credentials", "scope": "read", "skewSec": 30 }
  },
  "hmacSchemes": { "ias": { "appIdRef": "ias-app-id", "appKeyRef": "ias-app-key" } },
  "sharedSecrets": { "transport-kvasiny": { "value": "…" } },
  "clientCaBundle": { "description": "…", "issuers": ["CN=…"] },
  "validationCeilings": {
    "maxBodyBytes": 8388608, "minSampleRate": 0.01, "maxConcurrent": 8,
    "maxIncludeBodyExcerptBytes": 0
  },
  "tlsExceptionMaxDays": 30
}
```

Each map is validated at boot and a dangling `credentialRef` is a startup failure naming both the
ref and where it is used `[R3-08]`.

`sharedSecrets` reach the gateway as **hashes where a hash suffices** (`auth.basic`,
`requireHeader.credentialRef`) and as plaintext only where the gateway must present them to a
backend (`backendAuth`) `[R1-09]`.

---

## 6. Validation (G1)

### 6.1 What is validated, and what is not

| | REST | SOAP | MCP | A2A |
|---|---|---|---|---|
| Operation resolution | method + path template | body element + SOAPAction | JSON-RPC `method` (+ `params.name`) | JSON-RPC `method` |
| Path / query / header params | schema, `required` | — | — | — |
| Request body | JSON Schema per content type | XSD of the body element | tool `inputSchema` | method params schema |
| Response body | JSON Schema per status | XSD of the output element | result schema | result schema |
| Response headers | schema where declared | — | — | — |

**Only declared parameters are checked** `[R2-24]`. An undeclared header or query parameter is
allowed — OpenAPI does not forbid them, and the opposite reading would reject every real request
for carrying a `User-Agent`.

**The JSON Schema subset** (`shared/jsonschema.ts`) implements `type` (string and array form),
`enum`, `const`, `properties`, `patternProperties`, `additionalProperties`, `propertyNames`,
`required`, `minProperties`/`maxProperties`, `items`, `prefixItems`, `minItems`/`maxItems`,
`uniqueItems`, `contains`/`minContains`/`maxContains`, `minimum`, `maximum`,
`exclusiveMinimum`/`exclusiveMaximum` (2020-12 numeric **and** OAS 3.0 boolean forms),
`multipleOf`, `minLength`/`maxLength` (code points), `pattern`, `allOf`, `anyOf`, `oneOf`, `not`,
`if`/`then`/`else`, `nullable` (OAS 3.0), internal `$ref`, and `format` for `date`, `date-time`,
`time`, `duration`, `email`, `uuid`, `uri`, `hostname`, `ipv4`, `ipv6`, `byte`, `int32`, `int64`.

Not implemented and **rejected at compile time**: `$dynamicRef`/`$dynamicAnchor`,
`unevaluatedProperties`/`unevaluatedItems`, `$vocabulary`, `dependentSchemas`/`dependentRequired`,
`contentMediaType` decoding, remote `$ref` (already refused at upload by §5.3). An operation whose
schema uses one is reported at import, the API can still be published, and that operation reports
`unsupported-schema`, is **not** validated, and appears in `GET /api/validation/downgrades` beside
real downgrades — an unvalidated operation is an unvalidated operation however it got there
`[R1-15]`.

Every `pattern` in a compiled schema passes `lintPattern` (deviation D8) at compile time, and the
value being matched is length-bounded at validation time. The compiler rejects a schema it cannot
lint rather than shipping a backtracking regex to the request path.

**The XSD subset** (`shared/xsd.ts`) implements global and local `element` (`type`, inline
`complexType`/`simpleType`, `minOccurs`, `maxOccurs`, `nillable`, `default`, `fixed`),
`complexType` with `sequence`, `all`, `choice`, nested `group` and particle occurrence bounds,
`attribute` with `use` and `fixed`, `simpleType` `restriction` of the built-ins with the facets
`enumeration`, `pattern`, `length`, `minLength`, `maxLength`, `minInclusive`, `maxInclusive`,
`minExclusive`, `maxExclusive`, `whiteSpace`, plus `list` and `union`,
`complexContent`/`extension`, `simpleContent`/`extension`, `xs:any`/`xs:anyAttribute` as skip, and
the built-ins `string`, `normalizedString`, `token`, `boolean`, `decimal`, `float`, `double`,
`integer` and its bounded relatives, `date`, `dateTime`, `time`, `duration`, `gYear`…`gDay`,
`base64Binary`, `hexBinary`, `anyURI`, `QName`, `NCName`, `NMTOKEN`, `ID`/`IDREF` (as `NCName`,
without identity checking).

Not implemented and **rejected at import**, naming the construct: `xs:key`/`keyref`/`unique`,
`substitutionGroup`, `xs:redefine`, `xs:notation`, `abstract`, `xsi:type` overriding, group
reference cycles beyond depth 32, and any `import`/`include` with a `schemaLocation` (already
refused). Rejecting at import is the difference between a validator with a subset and a validator
that lies.

### 6.2 The `validate` unit

```json
"validate": {
  "request":  "blocking" | "warning" | "disabled",
  "response": "blocking" | "warning" | "disabled",
  "downgradeReason": "…",
  "headers": true,
  "body": true,
  "always": {
    "contentType": ["application/json"],
    "maxBodyBytes": 1048576,
    "maxDepth": 32,
    "json": { "maxArrayLength": 10000, "duplicateKeys": "reject" },
    "xml":  { "maxElements": 100000 }
  },
  "sample": { "alwaysUnderBytes": 65536, "rate": 0.1, "coldStart": 20,
              "onFailureEscalateSec": 300, "key": ["operation", "subscription"] },
  "maxConcurrent": 8,
  "onSaturated": "skip",
  "logEvents": { "includeBodyExcerptBytes": 0 }
}
```

Defaults are resolved once at config-build time and written explicitly into every route, so the
data plane computes no defaults `[V3-03]`:

- `request: "blocking"`, `response: "disabled"` for `rest`, `soap`, `mcp`, `a2a`.
- `request: "disabled"` when `passthrough.websocket` is on — structurally, there is no complete
  message.
- A route with **no `validate` unit attached still validates**, at the defaults. That is what
  "blocking by default" means, and it is why `validate` is the one unit whose absence is not "off"
  `[R1-01]`. The policy editor says so in words.
- Every `always` value is clamped to `INTEGRATIONS_FILE.validationCeilings` and to the gateway's
  `MAX_BODY_BYTES`, whichever is tighter; the `413` names the ceiling that bound `[R4-04]`.
- `always` is **route-level only** — it is enforced at step 3, before the operation is known, so an
  `always` block inside a per-operation override is a schema error saying why `[R2-02]`.

### 6.3 The `always` block, in every state

Enforced at step 3 for the header-time checks and while streaming for the rest, in `blocking`,
`warning` **and** `disabled`:

- Content-type allowlist and `maxBodyBytes` → `415`/`413`, never a validation attempt. The
  content-type check applies only when the request has a body, so a `GET` is never `415` `[R3-15]`.
- JSON: depth, array length, duplicate keys — `shared/json-reader.ts`, a bounded reader that
  refuses rather than repairs. `JSON.parse` accepts duplicate keys silently and bounds no depth, so
  the reader is not optional.
- XML: the existing `shared/xml.ts`, which already refuses DTDs and entities.
- SOAPAction/body agreement for `soap`, already implemented.

### 6.4 Three states

**`blocking`** buffers the body up to `maxBodyBytes`, validates, rejects with the route's
`errorFormat`. The buffer is charged against `BLOCKING_BUFFER_BUDGET_BYTES`; over budget the
request is shed with `503`, outcome `validate-budget` — never validated half-way and never let
through unvalidated `[R1-03]`.

**`warning`** tees the body, forwards immediately, queues the sample. Nothing about the response
changes — asserted by comparing status, headers and body against the same request with validation
`disabled`.

**`disabled`** does no schema work. The `always` block still applies.

**Response validation** mirrors it with three differences that have to be stated:

- `blocking` **buffers the response**, so such a route is not a streaming route. The schema refuses
  `response: "blocking"` with `passthrough.sse`, and the concurrency slot is held until the body is
  buffered, charged against the same budget `[R2-01]`.
- A response that fails is `502` shaped by `errorFormat` — the fault is the backend's `[R1-04]`.
  Over budget is also `502`, outcome `validate-budget`: passing an unvalidated response through a
  route configured to block is the one thing the setting exists to prevent.
- Response validation runs **before** `transform.response` `[R2-19]`. The declared schema describes
  what the backend sends, not what we hand on. In `warning` mode the response tee is bounded by
  `always.maxBodyBytes`; past it the sample is dropped and counted `[R2-18]`.

At most 20 errors are reported with a `truncated` count, and the validator stops collecting there
rather than collecting everything and slicing `[R3-07]`.

### 6.5 Sampling and the pool

Deterministic — `sha256(key, requestId) < rate` — with cold-start burst and sticky escalation, as
§5.1 describes. The key is `(operation, subscription)`.

The pool is a bounded queue (`VALIDATE_QUEUE_DEPTH`) drained by at most `VALIDATE_POOL_SIZE`
concurrent drains, each yielding to the event loop between items (D19). On saturation the sample is
dropped and counted; it never queues without bound and never backpressures the request path.

### 6.6 Artifacts on their own channel (§8.7)

- Compiled by `artifacts.ts` **when the revision is created** `[R3-01]`, content-addressed, so two
  revisions with an unchanged schema share one row and one download.
- `ConfigRoute.artifacts: [{ digest, kind, sizeBytes }]`. Schemas never enter the config document.
- `GET /api/gateway/artifacts/:digest` — instance token, gzip, `cache-control: immutable`. Fetchable
  exactly when the digest is in the artifact set of the config **that instance's environment
  currently renders**, checked against `buildConfig`'s own set rather than re-derived from `release`
  `[R2-31] [R4-03]`.
- The gateway **prefetches every digest a new config references and activates only when all are
  present and verified**; until then it keeps serving the previous config and reports the previous
  digest — §8.7, and the reason `gateway_instance.config_digest` means something.
- Digests are verified on read, every time. A mismatch evicts and refetches; if it cannot refetch,
  **that route fails closed with 503**, outcome `validation-unavailable`, while every other route
  serves.
- Cached under `GATEWAY_ARTIFACT_CACHE`, LRU by total size (`ARTIFACT_CACHE_MAX_BYTES`), with the
  active config's digests pinned.
- Certificates travel the same channel, cached as `<id>-<thumbprint>` so a rotation is a new entry
  and activation waits for it exactly like an artifact `[R2-15]`. Key material is written `0600`
  into `certs/` (D22). The endpoint is scoped to certificates a `binding.clientCertRef` in that
  environment names, and every read is audited `[R2-32]`.

### 6.7 Reporting

- `validation.failed` log records with §5.1's fields, correlated to the request id.
- Counters, never one: `validation-rejected`, `validation-observed`, `validation-sample-dropped`,
  `validation-unavailable`, `validate-budget`.
- Reported on the poll inside the existing telemetry block, so
  `GET /api/resources/:id/validation` shows rejections and observed failures per operation and per
  subscription.
- `GET /api/validation/downgrades` — every route not effectively `blocking`, with `origin`
  (`resource` or `global`), reason, actor and date; a global downgrade is listed once at the top
  with the number of routes it covers `[R4-01]`; plus every operation reporting `no-schema` or
  `unsupported-schema`.
- `GET /api/governance/exceptions` — downgrades, CN-only mTLS routes, JWT without an audience,
  active TLS exceptions, `skipChain` releases.

---

## 7. The global policy tier (G2)

### 7.1 The merge

```
effective(resource, environment) =
    for each unit key in (global ∪ resource):
        resource has it  → the resource's value      (API wins, whole unit)
        otherwise        → the global value
```

Whole units, never field-wise. Attaching `rateLimit` globally and `rateLimit` on an API gives the
API's numbers, not a blend — the same rule §5 states for promotion, for the same reason: half a
`rateLimit` is never a `rateLimit` anyone wrote.

### 7.2 Where it applies and where it does not

- **Applies** at config build, to every published route in that environment, and to the release
  plan's merged document, so a plan cannot be valid on paper and invalid in the fleet `[R1-07]`.
- **Restricted** to the allowlist in §5's table `[R2-08]`.
- **Never promoted.** `POST /api/policy/global/copy-from?environment=dev&units=…` is the explicit,
  diffed, confirmed act — the same shape as §6.3's `copy-from`.
- **Changes make open release plans stale.** `planDigest()` includes a digest of the target
  environment's global document, so a plan approved under one set of globals cannot apply under
  another `[R2-09]`.
- **Divergence keeps reporting resource units only.** The global policy screen shows every
  environment's global document side by side, which is the same question at the tier where it
  belongs `[R3-10]`.

### 7.3 Validation on write

A global write re-validates the effective document of **every** resource in that environment and
rejects naming the first that would become invalid. A resource write validates its own effective
document. Both call one function, `effectiveDocument()`, in `globals.ts` `[R1-10]`.

If an invalid effective document reaches config build anyway — a restored backup, a hand-edited
database — `buildRoutes` **omits that route** and records it in the target's health as
`configErrors[]`. An API that does not answer is visible; an API answering under a document nobody
validated is not `[R4-02]`.

### 7.4 Visibility

- `GET /api/resources/:id/policy?environment=` gains `origin: "resource" | "global"` per unit and a
  `global` block listing the environment units this resource overrides.
- `GET /api/policy/global?environment=` returns the document, the affected resource count, and per
  unit how many resources override it.
- The policy editor shows global units greyed with an "environment default" badge and an "override
  here" button.

---

## 8. Backends, load balancing and the circuit breaker (G7)

### 8.1 `binding.backend_json`

```json
{
  "pool": [{ "url": "https://a.internal", "weight": 1 }, { "url": "https://b.internal" }],
  "rule": "round-robin" | "failover",
  "clientCertRef": "cert_…"
}
```

Migration is at read time, not in SQL: a v2 `{"urls":[…]}` reads as
`{pool: urls.map(url => ({url})), rule: "failover"}`. The first v3 write stores the new shape. Every
URL passes `checkEgress` at write time. The pool is capped at 8 entries.

### 8.2 Selection

- `failover` — the pool in order, first healthy wins. "Primary first" is this rule with the primary
  first in the list.
- `round-robin` — a per-instance cursor per resource, skipping unhealthy backends, weighted by
  `weight` (1–10, expanded into the rotation).
- Health is the circuit breaker's state and nothing else; closed and half-open count as healthy.

### 8.3 The circuit breaker

Per instance, per `(resourceId, backendUrl)` — never fleet-wide, so one instance's connectivity
fault cannot trip the fleet (§8.5).

```
closed    --failures ≥ N within windowSec-->  open
open      --after openSec-->                  half-open
half-open --one success-->                    closed
half-open --one failure-->                    open (openSec restarts)
```

A failure is a connection error, a timeout, or a `5xx` named in `retries.on`. A `4xx` is never a
failure: a backend rejecting bad requests is working. `halfOpenProbes` bounds how many requests may
probe at once (default 1).

### 8.4 Retries

`retries: { attempts, on: ["502","503","504","timeout","connect"], idempotentOnly }`.

- An attempt goes to the **next** backend in the pool, not the same one, unless the pool has one
  entry.
- `idempotentOnly: true` (the default) restricts retries to `GET`, `HEAD`, `PUT`, `DELETE`,
  `OPTIONS`, `TRACE`.
- **A request whose body was streamed cannot be retried** — the bytes are gone. Retries apply with
  no body, or with a body that was buffered, which blocking validation already does. Otherwise only
  a failure to *establish* the connection is retried. Stated in the policy editor, because the
  alternative is a setting that silently does nothing `[R1-11]`.
- A response that has begun streaming is never retried (§5.8).
- `timeoutMs` is the **whole-request** budget: each attempt gets what remains, so `attempts` does
  not multiply the worst case a caller waits `[R1-12]`.

### 8.5 Errors

Pool exhausted is `503` with `Retry-After` from the shortest remaining `openSec`, shaped by
`errorFormat`, outcome `pool-open` — distinct from `backend-unreachable`, so "the breaker is doing
its job" and "the network is broken" are different lines on the dashboard `[R2-16]`.

### 8.6 Backend TLS (§5.4)

`ConfigRoute.backend.tls` carries the resolved mode for that environment: `verify` (the default and
the only one needing no row), or the exception's `pin` / `skip-hostname` / `insecure` with
`expiresAt`. The gateway **self-expires**: past `expiresAt` it verifies, even with the control plane
unreachable and the config served from the fail-static cache. Every request through an exception
sets a span attribute and increments a counter. D25 states the connection-pool window.

---

## 9. MCP (G4)

### 9.1 Publishing

```
POST /api/resources { kind: "mcp", name, teamId }
POST /api/resources/:id/revisions { discoverUrl: "https://mcp.internal/mcp" }
        or                        { spec: <manifest JSON> }
```

`discoverUrl` gets the same treatment as `specUrl`: `checkEgress`, no redirects, bounded by
`MAX_SPEC_BYTES`, 20-second timeout `[R2-40]`. Then the control plane speaks MCP over Streamable
HTTP:

```
POST  initialize                → protocolVersion, serverInfo, capabilities
POST  notifications/initialized
POST  tools/list                → tools[]      (paged via nextCursor)
POST  resources/list            → resources[]  (when the capability is present)
POST  prompts/list              → prompts[]    (when the capability is present)
```

The combined result is stored as `revision.original` (`original_format: "mcp-manifest"`) and
normalized:

- one operation per tool — `operationId = "tools/call:<name>"`, `selector = <name>`, request schema
  = the tool's `inputSchema` under `params.arguments`;
- one operation per protocol method the server supports, with fixed params schemas from
  `shared/mcp.ts`;
- `model.mcp = { protocolVersion, serverInfo, capabilities, tools, resources, prompts }` — what the
  catalog renders and what `regenerate` diffs against.

`POST /api/resources/:id/regenerate` re-runs discovery and creates a **new unreleased revision**
when the manifest changed, as §8.10 does for a Kafka schema change.

### 9.2 Serving

An `mcp` route is one base path taking `POST` (JSON-RPC) and, with `passthrough.sse`, `GET` (the
server→client stream) and `DELETE` (session teardown).

- Step 11 becomes **RPC resolution**: the body is buffered up to `always.maxBodyBytes` — always,
  even with `validate.request: "disabled"`, because a single-endpoint RPC protocol keeps its
  operation inside the body `[R2-03]`; the default cap for `mcp` and `a2a` is 256 KiB, because a
  JSON-RPC call is not an upload. It is parsed by the bounded reader, a batch is refused (the
  current MCP revision removed batching), and `method` — plus `params.name` for `tools/call` — is
  resolved to an operation.
- An unknown method or tool is JSON-RPC `-32601` and never reaches the server.
- Step 12 validates `params` against that operation's schema; per-operation policy therefore works
  per tool.
- `Mcp-Session-Id` and `MCP-Protocol-Version` need no special handling: the proxy already copies
  every non-hop-by-hop header both ways `[R2-14]`.
- A JSON-RPC *error* from the server is `200` at the HTTP level and is recorded with outcome
  `rpc-error`, not `upstream-error`, so a tool saying "no" does not read as the gateway failing
  `[R1-13]`.

### 9.3 Errors

`errorFormat.shape: "jsonrpc"` renders every gateway rejection as

```json
{"jsonrpc":"2.0","id":null,"error":{"code":-32001,"message":"…",
 "data":{"status":401,"requestId":"…","detail":"…"}}}
```

with the HTTP status **also** set correctly, because an MCP client reads the status and the edge
proxy reads nothing else. The specification allows a non-200 carrying an error body `[R4-05]`.
`id` is the request's when the body has already been parsed and `null` otherwise `[R2-07]`. Codes:
`401→-32001`, `403→-32002`, `429→-32003`, `503→-32004`, `400 (validation)→-32602`,
`404 (method)→-32601`, other `5xx→-32000`.

---

## 10. A2A (G5)

### 10.1 Publishing

`POST /api/resources/:id/revisions { discoverUrl: "https://agent.internal" }` fetches
`<discoverUrl>/.well-known/agent-card.json`, falling back to the legacy `/.well-known/agent.json`,
stores it as `original` (`original_format: "a2a-agent-card"`), and normalizes:

- `model.a2a = { protocolVersion, name, description, version, capabilities, skills,
  defaultInputModes, defaultOutputModes, securitySchemes, preferredTransport, originUrl }`;
- operations = the A2A JSON-RPC methods the card's capabilities imply: `message/send`,
  `message/stream`, `tasks/get`, `tasks/cancel`, `tasks/resubscribe`,
  `tasks/pushNotificationConfig/{set,get,list,delete}`, `agent/getAuthenticatedExtendedCard`, with
  fixed params schemas from `shared/a2a.ts`;
- skills become catalog facets and tags.

### 10.2 Serving

- `GET <basePath>/.well-known/agent-card.json` is answered **by the gateway** from the config, with
  `url` rewritten to this route's public URL and `securitySchemes` replaced by the gateway's own
  (`apiKey` in the configured header when `auth.subscriptionKey` is attached). Publishing an A2A
  endpoint means consumers talk to us, so the card must not point past us `[R1-16]`. It is served
  under the route's base path only, and the catalog shows the exact URL `[R2-35]`.
- The card is public when the resource is `listed` and requires the key when `unlisted` `[R1-17]`.
  It is served after steps 1–5, so `ipAllow` and CORS still apply, and it reads only config
  `[R2-13]`.
- `POST <basePath>` is JSON-RPC, resolved and validated exactly like MCP.
- `message/stream` and `tasks/resubscribe` require `passthrough.sse`; without it the gateway answers
  `-32004 "streaming is not enabled for this route"` rather than proxying a stream it would then
  buffer.

---

## 11. The Catalog (G6)

### 11.1 The index

`search.ts` maintains one FTS5 row per resource: `name`, `title` (from the model), `summary`,
`description`, `tags`, and `operations` — operation ids, paths, summaries, MCP tool names and
descriptions, A2A skill names and descriptions. Ranking is `bm25()` with column weights
`name×8, title×6, tags×4, summary×3, description×2, operations×1`, then a popularity boost.

The user's words are escaped and rebuilt as a quoted-plus-prefix query (`"pet" OR pet*`), so FTS5
syntax is never injected `[R1-18]`.

### 11.2 The API

```
GET  /api/catalog?q=&kind=&tag=&team=&environment=&sort=relevance|name|newest|popular&limit=&cursor=
GET  /api/catalog/facets
GET  /api/catalog/:resourceId
POST /api/catalog/:productId/subscribe { applicationId, environment }
```

A listing appears when it has at least one `converged` release in any environment, or the caller
`can()` see it — the latter badged "not published". `unlisted` is excluded for everyone else
`[R2-11]`.

A card carries id, kind, name, apiVersion, icon, summary, tags, team, lifecycle, the environments it
is live in, operation/tool/skill count, subscriber count (distinct applications with an active
subscription to any product containing it `[R2-12]`), whether the caller already subscribes, and the
products through which it can be subscribed. `sort=popular` is subscriber count then requests in the
retained telemetry window `[R2-39]`.

A detail response adds the description, the operation/tool/skill list with summaries, the version
family, a ready-to-paste `curl` or JSON-RPC example built from the live route and the key header,
the product's terms, and the recent-traffic sparkline the telemetry rollup already has.

`GET /api/subscriptions/:id/usage` — quota consumed, window reset, recent rate-limit rejections,
from the aggregate `[R2-38]`.

### 11.3 The UI

`MarketView` — a search field that filters as you type, facet chips for kind and tag, a sort
control, and a responsive grid of cards: icon, name and version, kind badge, one-line summary, tags,
environment pips, subscriber count. Empty and no-result states say what to do next.

`MarketListing` — a header (icon, name, version switcher, kind, lifecycle, owning team, Subscribe),
then tabs: **Overview** (description, what it is for, environments and base URLs), **Operations**
(REST paths / SOAP operations / MCP tools with their input schemas / A2A skills), **Getting
started** (subscribe, then the copy-pasteable call), **Versions**.

Subscribe is a dialog: choose an application (or create one), choose an environment, confirm → the
key shown once with a copy button and a reminder that it is revealable later.

Navigation becomes **Catalog · APIs · Products · Telemetry · Gateways · Policy** (admin) **· Trust**
(admin) **· Audit** (admin). v2's "Catalog" item, which was products and subscriptions, becomes
**Products**.

The policy editor renders every unit from `UNIT_CATALOGUE` — title, description, default and a JSON
editor validated by the same validator the API uses — with real controls on the eight units people
actually tune: `auth.subscriptionKey`, `rateLimit`, `quota`, `validate`, `cors`, `retries`,
`circuitBreaker`, `passthrough` `[R2-33]`.

---

## 12. Wire contract changes

`CONFIG_VERSION` → 3. An instance speaking 2 is refused with a message naming both versions and
keeps serving from its cache — the existing behaviour.

```ts
interface ConfigRoute {
  …v2 fields…,
  policy: PolicyDocument,            // the EFFECTIVE document (global merged under the resource's)
  operations: ConfigOperation[],     // routing and selection only, never schemas
  artifacts: ArtifactRef[],
  backend: { pool: BackendEntry[]; rule: "round-robin" | "failover"; clientCertRef?: string;
             tls: { mode: "verify" | "pin" | "skip-hostname" | "insecure";
                    pinThumbprint?: string; expiresAt?: string; exceptionId?: string } },
  mcp?: { protocolVersion: string },
  a2a?: { cardPath: string; cardPublic: boolean; card: AgentCardProjection },
}
interface ConfigOperation {
  id: string; method: string; template: string;   // REST
  element?: string; soapAction?: string;          // SOAP
  selector?: string;                              // MCP tool / A2A method
  schemaState: "ok" | "no-schema" | "unsupported-schema";
}
interface GatewayConfig {
  …v2 fields…,
  certificates: Array<{ id: string; thumbprint: string; notAfter: string }>,
}
```

`MAX_OPERATIONS_PER_ROUTE = 1000`, enforced at import `[R2-27]`.

The poll request grows `quota: { deltas: QuotaDelta[] }` and a `validation` counter block inside the
existing telemetry object; the response grows `quotaAggregates: QuotaAggregate[]` for this
environment, bounded by `MAX_QUOTA_ENTRIES` and by the subscriptions the config already carries
`[R1-19]`.

---

## 13. Pipeline order (§5.2), as implemented

```
 1  route match                    host + base path
 2  trusted-proxy context          EFFECTIVE client IP, verified client-cert headers   [R2-23]
 3  always-on limits               content-type (only with a body), Content-Length cap
 4  ipAllow
 5  CORS preflight short-circuit   only when a `cors` unit is attached                  [R3-12]
      └─ A2A: the agent card is served here when it is public                           [R2-13]
 6  authenticate                   subscriptionKey | basic | jwt | introspection | mtls
 7  authorize                      subscription active, product contains resource
 8  rate limit                     per instance, fixed window
 9  quota                          fleet aggregate + local delta
10  preconditions                  ordered deny rules
11  operation resolution           REST template · SOAP body element · JSON-RPC method
      └─ per-operation validate/rateLimit/quota/timeoutMs/cache resolved here
      └─ auth.jwt.scopeMap checked here                                                 [R2-04]
12  request validation             blocking: buffer, validate, reject
13  rewrite                        path template, query set/remove, strip base path
14  request headers                remove → set → append → skip; credential strip
15  request transform              (none — D21)
16  cache lookup                   key: routeId | method | inbound path+query | vary
                                   | subscription (when varyBySubscription)             [R2-05]
                                   under the active config digest, so activation empties it [R3-11]
17  backend select                 pool, rule, breaker, TLS mode
18  backend auth                   inject the named scheme's credential
19  proxy                          whole-request timeout, retries across the pool, breaker, stream
20  response validation, THEN response transform                                        [R2-19]
21  response headers + CORS headers (on every response, including rejections)           [R2-06]
22  backend-auth invalidation      invalidateOnStatus — invalidate, never retry         [R2-20]
23  cache store
24  telemetry + access log
      └─ WARNING: the tee'd body enters the bounded pool here
      └─ WEBSOCKET: 1–14 on the upgrade, then a bidirectional copy; 15–23 do not exist
      └─ SSE: 1–19 normally, then stream; 20–23 skipped on the response side
```

Step 11 sits after authorization and the limits and before validation — where §5.2 puts the SOAP
scan, and for the same reason: unauthenticated traffic must not be able to make the gateway parse a
body.

---

## 14. Configuration

New control-plane values:

```
TLS_EXCEPTION_MAX_DAYS        ceiling on §5.4 expiry (also in INTEGRATIONS_FILE)
USAGE_FLUSH_INTERVAL_SEC      batched usage_counter flush = quota RPO
MAX_QUOTA_ENTRIES             per poll, up and down
ARTIFACT_MAX_BYTES            one compiled bundle's ceiling
CATALOG_PAGE_SIZE
```

New data-plane values:

```
GATEWAY_ARTIFACT_CACHE        persisted directory; artifacts/ and certs/ inside it
ARTIFACT_CACHE_MAX_BYTES
BLOCKING_BUFFER_BUDGET_BYTES  the ceiling under blocking validation (§8.4)
VALIDATE_POOL_SIZE · VALIDATE_QUEUE_DEPTH
MAX_CONCURRENT_UPGRADES       instance-wide streaming ceiling (§5.8)
RESPONSE_CACHE_MAX_BYTES · RESPONSE_CACHE_MAX_ENTRIES
TRUSTED_PROXY_CLIENT_CERT_HEADERS
```

The §11 self-test cannot run at boot for a config that has not arrived, so it runs at
**activation**: a config using `auth.mtls`, `requireClientCert` or `${cert.*}` while
`TRUSTED_PROXY_CIDRS` is empty is **not activated**, the previous config keeps serving, and the
refusal is reported on `/healthz` and in the poll `[R1-21]`. When it happens at startup there is no
previous config, so it is a startup failure — which is what §11 asks for.

---

## 15. Testing

| File | Covers |
|---|---|
| `jsonschema.test.ts` | the subset keyword by keyword, the compile-time rejection list, pattern linting, error truncation |
| `xsd.test.ts` | particles, facets, attributes, nillable, `simpleContent`, and the import-time rejection list |
| `validation.test.ts` | G1 end to end: REST body/headers/query/path, SOAP body, response validation, all three states, warning never changes a response, `always` in every state, `413`/`415`, `downgradeReason`, sampling determinism, cold start, escalation, pool saturation, blocking budget shed |
| `artifacts.test.ts` | compile → content address → fetch → verify → activate; a config referencing a missing digest does not activate; corruption detected on read; eviction never drops a pinned bundle; cold instance + warm cache + dead control plane still validates; scope check on the endpoint |
| `global-policy.test.ts` | G2: precedence per unit, detach, effective validation on both writes, the allowlist, promotion plan sees globals and goes stale, origin reporting, `copy-from` |
| `policies.test.ts` | G3: basic, jwt (JWKS rotation, alg allowlist, audience, scopeMap), introspection (cache, failure), mtls (headers, CN-only acknowledgement), ipAllow, cors (preflight, actual, on rejections), cache (vary, varyBySubscription, downstream shaping, config swap empties), headers.response, transform soap-to-json, rewrite path/query, preconditions' four checks, backendAuth's five schemes incl. single-flight and fail-closed, per-operation overrides |
| `quota.test.ts` | aggregate + local delta, 403, windows aligned to the UNIX epoch, product scope, lost report under-counts, control-plane outage keeps enforcing |
| `streaming.test.ts` | §5.8: the exclusion table at write time, WS upgrade runs 1–14, bytes both ways, revocation closes, `maxConnectionSec`, idle timeout, byte budget, SSE flush-per-event, no retry after the first byte, both upgrade ceilings |
| `backends.test.ts` | G7: round robin spreads, failover pins, breaker opens/half-opens/closes, retries move to the next backend, no retry once streamed, whole-request timeout budget, `pool-open`, per-instance isolation |
| `trust.test.ts` | §5.4: the exception ladder resolves to the right `tls` options, mandatory expiry and reason, `TLS_EXCEPTION_MAX_DAYS`, admin-only, self-expiry with a clock skip, certificates PEM round trip and scoping |
| `mcp.test.ts` | G4: discovery, manifest → model, tool resolution, per-tool validation and policy, JSON-RPC error shape, session header round trip, regenerate creates an unreleased revision |
| `a2a.test.ts` | G5: card discovery, card served rewritten, JSON-RPC methods, streaming gated on `passthrough.sse`, skills in the model, public/unlisted card rule |
| `catalog.test.ts` | G6: FTS ranking and prefix search, query escaping, facets, sort orders, `unlisted` hidden, detail payload, subscribe flow, index maintained on write and rebuilt at boot |
| `migration.test.ts` | extended: a real v2 database upgrades to v3 with every row intact, artifacts backfilled, FTS built |

Existing suites keep passing except where a default legitimately changed — and exactly one did:
**validation is on by default**, so every existing fixture now runs through the validator. That is
the point of the goal, and the fixtures' specs are extended to declare what they actually send
`[R1-22]`.

---

## 16. Delivery order

Each step leaves the tree green.

| Step | Ships | Done when |
|---|---|---|
| 1 | `schema-003.sql`, migration test, config plumbing, `CONFIG_VERSION` 3 | a v2 database upgrades; existing suites pass |
| 2 | `shared/jsonschema.ts`, `shared/xsd.ts`, `shared/json-reader.ts`, `shared/opmatch.ts` + suites | the validator suites pass with nothing else changed |
| 3 | Model carries schemas; `artifacts.ts`; the artifact and certificate channels; the gateway cache | `artifacts.test.ts` |
| 4 | The `validate` unit, three states, the `always` block, sampling, the pool, reporting | `validation.test.ts` |
| 5 | Backend pools, selection, breaker, retries, TLS modes, certificates, exceptions | `backends.test.ts`, `trust.test.ts` |
| 6 | The rest of the vocabulary: identity, cors, cache, transform, headers.response, rewrite, backendAuth, quota, per-operation | `policies.test.ts`, `quota.test.ts` |
| 7 | `passthrough`: WebSocket and SSE, the stream registry | `streaming.test.ts` |
| 8 | The global tier | `global-policy.test.ts` |
| 9 | `mcp` and `a2a`, `tools/mcp`, `tools/a2a` | `mcp.test.ts`, `a2a.test.ts` |
| 10 | The Catalog: index, API, UI | `catalog.test.ts` |
| 11 | The rest of the UI: policy editor, global policy, trust, validation health | the demo walkthrough |
| 12 | README, `stack.ps1`, `demo.ps1`, harness updates | `bun test` green, demo re-runnable |
