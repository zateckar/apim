# MVP v2 implementation plan — Integration Portal

Draft 5 · what changes to take the shipped MVP (see [`mvp-plan.md`](mvp-plan.md)) to six new
goals, without abandoning the spine of [`greenfield-design.md`](greenfield-design.md).

Drafts 1 → 5 and the reasoning behind every change are in
[`v2-plan-review.md`](v2-plan-review.md) — 47 findings over four rounds; round 5 found nothing.
Finding ids appear inline as `[V1-01]`. v1's findings (`R1-…`, `R2-…`, `I…`) still hold and are
not repeated.

---

## 1. Goals, restated as acceptance criteria

| # | Goal | Acceptance test |
|---|---|---|
| G1 | DEV, TEST, PROD with promotion DEV→TEST→PROD | A revision released to `dev` cannot go straight to `prod`; the rejection names `test`. Promoted to `test`, then `prod`, it serves on each environment's gateway. Rollback to an earlier revision in `prod` works after `test` has moved on |
| G2 | API versioning — multiple versions online at once | `petstore v1` on `/petstore/v1` and `petstore v2` on `/petstore/v2` both answer `200` in the same environment, from different revisions, with independent policy; `v1` marked `deprecated` answers with `Deprecation` and `Sunset` headers |
| G3 | Multiple gateways | Four data-plane processes (2×dev, 1×test, 1×prod), each with its own instance token; the fleet view shows all four with their active digests; revoking one takes only that one out |
| G4 | Collect gateway telemetry and show it in the control plane | Traffic through any gateway appears in the control plane within one flush interval: counts, outcome and status breakdown, approximate p50/p95, bytes, top consumers, per instance and per API |
| G5 | SOAP — XML | A WSDL is imported as a `soap` resource, published, and called through the gateway with a real SOAP envelope; a policy rejection comes back as a **SOAP Fault**, not JSON; a SOAPAction that disagrees with the body is rejected |
| G6 | Local petstore endpoint with simulated latency; load testing; a suite used regularly; a performance report | `bun run backend` serves REST + SOAP petstore with controllable latency (to 30 s), status and body sizes; `bun run perf` runs the scenario matrix and writes [`perf-report.md`](perf-report.md); `bun test` runs a fast guardrail on every run |

G1's ordering, G2's two live versions, G4's numbers and G5's fault body are the contract. G6's
report must separate **gateway overhead** from backend latency, or it measures nothing.

---

## 2. What is in and what is deliberately out

### In scope, on top of v1

- **Three environments and the §6.2 promotion gate**, with the §6.3 per-unit additive policy
  merge, a persisted single-use dry-run plan, `skipChain` break-glass, and rollback across a
  moved chain.
- **§6.4 divergence** as a read-only report — the compensating control the design names for
  editing policy in place.
- **Versioning by resource**: `api_version` becomes part of an API's identity, so two versions
  are two rows, two routes and two release histories inside one product.
- **§4.2 lifecycle**: `active | deprecated | retired` with `sunset_at`, `Deprecation` and
  `Sunset` response headers, and `retired` blocking *new* subscriptions.
- **A fleet**: many `gateway_instance` rows per target, minted and revoked through the API and
  the UI, each process independently configured from its own env file.
- **Telemetry on the §8.5 poll** — the poll becomes bidirectional, as the design always said it
  was — aggregated in memory on the control plane, flushed in batches, bounded, retained for a
  fixed window, pruned by a job, and displayed.
- **`soap`**: WSDL 1.1 import into the same model, SOAPAction agreement, the §5.1 `always` block
  for XML (DTD and entity refusal, depth and element caps, bounded prefix scan), and the
  `errorFormat` policy unit v1 promised.
- **A local backend simulator and a load harness**, with a report that is regenerated rather
  than hand-written.

### Out of scope (named, with the section it comes from)

Schema validation (§5.1) and compiled artifacts (§8.7) · quota (§5.7) · WebSocket/SSE (§5.8) ·
`kafka`/`kafka-topic`/`kafka-proxy`/`mcp`/`a2a`/`graphql` (§4.4, §8.8–8.10) · the `apim` adapter
and import (§8, §16) · approvals, announcements, certificates, TLS exceptions, service tokens
(§4.2, §4.3, §5.4, §9) · drift (§7) · OIDC (§9) · OTEL/ELK (§13) · response cache, retries,
circuit breaker, backend pools, `backendAuth` (§5, §5.5) · revision pruning (§4.1) · Postgres
(§13) · per-operation policy (§5) · header-based version routing (D14) · per-environment
lifecycle (`[V1-05]` — §6.1 has four per-environment tiers and lifecycle is not one of them).

**Every out-of-scope item stays absent, not stubbed.** There is still no `validate` unit, so
nothing can read as "validation is on" — including for `soap`, where the design's default is
`blocking` and we do none. The `soap` API page says so in words (D12).

### Deviations from the design

D1–D10 from v1 stand unchanged. New ones:

| # | Design says | v2 does | Reason |
|---|---|---|---|
| D5′ | (v1) `PROMOTION_CHAIN=dev` | `PROMOTION_CHAIN=dev,test,prod` | G1. D5 is retired |
| D9′ | (v1) no approvals, so a consumer self-subscribes | unchanged, **and** a PROD release needs no second person | §6.3 requires an `approval` row for PROD decided by an admin other than the requester. Approvals stay out of scope, so the gate is the chain plus `skipChain`, and the plan, the UI and the README say plainly that PROD is one click for a team member |
| D11 | The config poll is a `GET` with `ETag`/`304` (v1's reading of §8.5) | `POST /api/gateway/poll`, one round trip, carrying the instance's telemetry up and config-or-`unchanged` down | §8.5 says the poll *is* bidirectional and single round-trip; v1 implemented only the downward half. `304` is defined for conditional GET, so "nothing changed" is an explicit field rather than a reused status code |
| D12 | Blocking XSD validation for `soap` (§5.1, §4.4) | No schema validation at all; the `always` block **is** implemented | No libxml2 and no XSD engine in the dependency budget. The security-critical half of §5.1 — parser hardening, size caps, SOAPAction/body agreement — needs no schema and is in |
| D13 | Export is generation for every variant (§4.1) | `rest` exports generated OpenAPI 3.1 as in v1; `soap` exports the **original** WSDL plus a generated JSON summary of the model | Generating WSDL and XSD from the model is a compiler, not a feature of this MVP. The UI labels which document is which, as §4.1 requires |
| D14 | `api_version` "appears in `route.base_path` **or** a version header" (§4) | Base path only | Header selection needs two routes to share one base path, relaxing `UNIQUE(environment, host, base_path)` — the constraint §4 calls load-bearing against order-dependent routing |
| D15 | No usage-accounting store; analysis comes from OTEL in ELK (§13) | A bounded `telemetry_rollup` table in SQLite | G4 asks for it in the control plane and there is no ELK here. Bounded the way §5.7 bounds `usage_counter`: pre-aggregated on the instance, flushed in batches, per-minute grain, retained for `TELEMETRY_RETENTION_HOURS`, pruned by a job. It is **not** a per-call ledger and there is still no metering |
| D16 | Data-plane telemetry is OTEL spans and log records (§13) | Counters aggregated on the instance and reported on the poll | Same reason as D15. The access log stays one JSON line per request on stdout, which is where a real deployment attaches a collector |
| D17 | "the gateway emits `Deprecation` and `Sunset` headers" (§4.2), format unstated | `Sunset` is an RFC 8594 IMF-fixdate from `sunset_at`; `Deprecation` is the pre-RFC draft's `Deprecation: true` | `[V1-17]` RFC 9745 defines `Deprecation` as a date, and we do not record *when* a version was deprecated — only that it is. Emitting a wrong date would be worse than the widely deployed boolean form |

---

## 3. Shape

```
                       Browser (React SPA)
                              │ /api
        ┌─────────────────────▼───────────────────────────────────┐
        │ CONTROL PLANE — Bun/TS                       :8080      │
        │  resources · versions · policy · promotion + plans      │
        │  fleet + instance tokens · telemetry aggregator         │
        │  POST /api/gateway/poll   (config down ⇄ telemetry up)  │
        │                        bun:sqlite .data/apim.sqlite     │
        └───┬─────────────┬─────────────┬─────────────┬───────────┘
            │ dev         │ dev         │ test        │ prod
        ┌───▼────┐   ┌────▼───┐   ┌─────▼──┐   ┌──────▼─┐
        │ DP 8081│   │ DP 8082│   │ DP 8083│   │ DP 8084│    4 gateways,
        │ dev-1  │   │ dev-2  │   │ test-1 │   │ prod-1 │    one token each
        └───┬────┘   └────┬───┘   └─────┬──┘   └──────┬─┘
            └─────────────┴───────┬─────┴─────────────┘
                                  ▼
                 tools/backend  :9080   REST + SOAP petstore,
                 simulated latency (to 30 s), sizes, statuses
                                  ▲
                 tools/loadgen ───┘  and ──→ the gateways
                                     (direct vs through: the only honest overhead number)
```

`https://petstore.swagger.io/v2` stays the demo's *import* source and one DEV route still binds
to it, so v2 keeps proving that a remote spec fetch and a real TLS backend work `[V1-27]`.
Everything else — every test, every load scenario, every other route — uses the local backend, so
results are reproducible and nobody's public service is hammered.

### Layout — what is added

```
shared/
  xml.ts              hardened, bounded XML reader + SOAP envelope scan
  soap.ts             fault rendering, SOAPAction agreement rules, content types
  telemetry.ts        report envelope, outcome vocabulary, bucket boundaries, percentiles
control-plane/src/
  schema-002.sql      migration 2 (db.ts already runs numbered migrations)  [V1-07]
  normalize-wsdl.ts   WSDL 1.1 → ApiModel
  promotion.ts        gate, plan, merge, divergence — control plane only     [V1-28]
  telemetry.ts        in-memory aggregate + batched flush + prune job
  api/promotion.ts  api/telemetry.ts  api/fleet.ts
data-plane/src/
  telemetry.ts        per-instance counters, per-minute windows, bounded series
  soap.ts             prefix scan, action agreement, fault responses
tools/
  backend/            the petstore simulator (REST + SOAP), seeded, scriptable
  loadgen/            scenario runner, percentile maths, report writer
docs/perf-report.md   GENERATED by `bun run perf` — header says so              [V2-06]
scripts/
  stack.ps1           up / down / status for CP + 4 DPs + backend
  demo.ps1            v2 walkthrough (promotion, two versions, SOAP, telemetry)
  perf.ps1            wrapper for `bun run perf`
  schedule-perf.ps1   registers a daily Windows scheduled task (opt-in)
```

---

## 4. Data model changes

`db.ts` already runs numbered migrations tracked in `schema_version`, with `schema.sql` as
version 1 `[V1-07]`. v2 adds one entry:

```ts
{ version: 2, name: "v2", file: "schema-002.sql", foreignKeysOff: true }
```

### The runner grows one flag, because one migration can destroy the database `[V1-02] [V2-04]`

`openDb` sets `PRAGMA foreign_keys = ON`, and **SQLite ignores that pragma inside a
transaction** — so writing `PRAGMA foreign_keys=off` into a migration file does nothing. With
foreign keys on, `DROP TABLE resource` first deletes its rows, cascading through `revision`,
`policy_entry`, `route`, `binding`, `release`, `applied` and `product_member`. The upgrade would
report success and leave an empty estate.

A migration marked `foreignKeysOff` therefore runs in this exact order, in the runner and not in
the SQL file:

```
PRAGMA foreign_keys = OFF;         -- outside the transaction, or it is a no-op
BEGIN;
  … the 12-step rebuild …
  PRAGMA foreign_key_check;        -- a QUERY: the runner reads the rows and throws if any,
                                   -- naming table and rowid, which rolls the transaction back
  INSERT INTO schema_version …
COMMIT;
PRAGMA foreign_keys = ON;
```

A test upgrades a **seeded v1 database** and asserts every child row survives with its parent.
This is the only migration that can lose data, so it gets its own test rather than being covered
by "migrations run".

### schema-002.sql

```sql
-- G2: an API's identity includes its consumer-visible version. SQLite cannot drop an inline
-- UNIQUE, so this is the 12-step rebuild: create resource_new with
--   UNIQUE(team_id, name, api_version), copy, drop, rename.
-- api_version matches ^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$, checked in the API layer.   [V1-21]

-- G1: the gate reads release history, so history must survive.  [V2-02]
-- `superseded` and `withdrawn` are reachable only from `converged`, which makes
-- state IN ('converged','superseded','withdrawn') mean "reached the fleet at some point".
CREATE TRIGGER release_state_history BEFORE UPDATE ON release
WHEN new.state IN ('superseded','withdrawn') AND old.state <> 'converged'
BEGIN SELECT RAISE(ABORT, 'a release reaches superseded/withdrawn only from converged'); END;

-- G1: the promotion plan is persisted and single-use.
CREATE TABLE release_plan (
  id           TEXT PRIMARY KEY,
  resource_id  TEXT NOT NULL REFERENCES resource(id) ON DELETE CASCADE,
  revision_id  TEXT NOT NULL REFERENCES revision(id) ON DELETE CASCADE,
  environment  TEXT NOT NULL,
  plan_json    TEXT NOT NULL,
  plan_digest  TEXT NOT NULL,
  computed_by  TEXT NOT NULL,
  computed_at  TEXT NOT NULL
);
ALTER TABLE release ADD COLUMN plan_id TEXT REFERENCES release_plan(id);

-- G4: pre-aggregated, per minute, per instance run. Not a ledger (D15).
CREATE TABLE telemetry_rollup (
  environment      TEXT    NOT NULL,   -- denormalised from the instance's target  [V1-30]
  instance_id      TEXT    NOT NULL REFERENCES gateway_instance(id) ON DELETE CASCADE,
  run_id           TEXT    NOT NULL,   -- per-process, so a restart never replaces  [V2-01]
  window_start     TEXT    NOT NULL,   -- UTC minute, ISO8601
  resource_id      TEXT    NOT NULL,   -- '' when no route matched
  subscription_id  TEXT    NOT NULL,   -- '' when unauthenticated
  outcome          TEXT    NOT NULL,
  status           INTEGER NOT NULL,
  count            INTEGER NOT NULL,
  duration_ms_sum  INTEGER NOT NULL,
  duration_ms_max  INTEGER NOT NULL,
  bytes_in         INTEGER NOT NULL,
  bytes_out        INTEGER NOT NULL,
  buckets_json     TEXT    NOT NULL,
  PRIMARY KEY (environment, instance_id, run_id, window_start,
               resource_id, subscription_id, outcome, status)
);
CREATE INDEX telemetry_by_window   ON telemetry_rollup(environment, window_start);
CREATE INDEX telemetry_by_resource ON telemetry_rollup(resource_id, window_start);

-- G3: an instance is a long-lived credential, so it gets a credential's columns.
ALTER TABLE gateway_instance ADD COLUMN created_at   TEXT;
ALTER TABLE gateway_instance ADD COLUMN created_by   TEXT;
ALTER TABLE gateway_instance ADD COLUMN last_ip      TEXT;
-- last known values, not a series [V4-01]: the instance.process block plus the report's
-- droppedSeries / droppedWindows / foldedRuns and when they were observed. Diagnostics about
-- telemetry are not themselves telemetry, so they do not get a rollup.
ALTER TABLE gateway_instance ADD COLUMN process_json TEXT;
```

Decisions, not commentary:

- **`resource_id` and `subscription_id` use `''`, never `NULL`.** SQLite permits NULLs in a
  PRIMARY KEY and treats every NULL as distinct, which would defeat the upsert and add one row
  per flush. The empty string is a real value and conflicts correctly.
- **No foreign key from `telemetry_rollup` to `resource`**, because `''` has no referent. Unknown
  ids are filtered at flush time against `resource` and `subscription` and folded into `''` with
  a counter — an authenticated instance may report a resource deleted a second ago, and one such
  row must not fail a whole batch.
- **`environment` is denormalised on purpose** `[V1-30]`: every dashboard query filters by it
  first, and the alternative is joining `gateway_instance` → `target` on every read. It is
  written from the instance's target, never from the report.
- `release.state` gains `stale` (§6.3: the plan digest moved).
- Existing `gateway_instance` rows get `NULL` for the new columns; every reader tolerates it.

---

## 5. Policy vocabulary v2

Six units from v1, unchanged, plus one — and later a second, added after the plan was written
(see [the review](v2-plan-review.md), round 8):

```ts
"errorFormat"   { shape: "problem+json" | "soap-fault", soapVersion?: "1.1" | "1.2" }
"concurrency"   { maxInFlight: number, per: "instance", retryAfterSec?: number }
```

- **Defaults are resolved at config-build time, not at request time** `[V3-03]`. The config
  builder already joins the revision for `rev`, so it resolves `rest → problem+json` and
  `soap → soap-fault` with the WSDL's SOAP version, and emits an explicit `errorFormat` into
  every route's policy document. The data plane never computes a default, and the wire contract
  carries no implicit values. The policy *unit* stays optional and overrides the default.
- `validateDocument` now takes the resource's kind — `validateDocument(doc, { kind })` — because
  `errorFormat` is the first unit whose legality depends on the variant: `soap-fault` on a `rest`
  route is a write-time error. The UI catalogue entry carries `appliesToKinds`.
- Every rejection the data plane produces goes through one `respond(route, status, title,
  detail)` that consults `errorFormat`. There is no second place that writes a response body.

`concurrency` is a bulkhead: the most upstream calls a route may have in flight on one instance,
shed with 503 and `Retry-After` at the ceiling rather than queued. Per instance like `rateLimit`,
so the fleet ceiling is `maxInFlight × instances`. It exists because `timeoutMs` bounds how long
one request waits and nothing bounded how many were waiting — see
[`capacity-report.md`](capacity-report.md), where flooding one route whose backend takes two
seconds moved an unrelated route's median latency by three orders of magnitude.

The XML `always` block (§5.1) is **not** policy. It is behaviour of a `soap` route with ceilings
admin-set in `INTEGRATIONS_FILE`:

```json
"xml": { "maxPrefixBytes": 8192, "maxDepth": 32, "maxElements": 100000,
         "maxBytes": 8388608, "contentTypes": ["text/xml", "application/soap+xml"] }
```

Those ceilings **travel in the config document** (`limits.xml`) rather than being read from the
file by each gateway `[I6-config]`: one definition of "too deep", distributed on the channel
everything else uses, instead of two that can drift apart.

DTDs, `<!ENTITY>`, external entities and processing instructions other than the XML declaration
are refused outright — not expanded safely, refused — and no configuration turns that off.

---

## 6. Control-plane HTTP API — what is added

```
# promotion (§6.2, §6.3)
GET    /api/resources/:id/promotion              chain state per environment: live revision,
                                                 furthest point reached, blockers
POST   /api/resources/:id/releases?dryRun=1      → 200 { planId, planDigest, plan }
POST   /api/resources/:id/releases               { revision, environment, planId?,
                                                   skipChain?, reason? } → 202
GET    /api/resources/:id/divergence             §6.4 pending / local / drift / aligned
POST   /api/resources/:id/policy/copy-from       { fromEnvironment, environment, units[] }

# versioning (G2)
POST   /api/resources/:id/versions               { apiVersion, copyPolicyFrom?, createRoutes? }
GET    /api/resources?team=<teamId>&name=<name>  every version of one API          [V4-02]

# catalog, completing a gap v1 left: a product could be created and never removed  [I5]
DELETE /api/products/:id                         409 while it has active subscriptions
DELETE /api/applications/:id                     409 while it has active subscriptions

# fleet (G3)
GET    /api/environments                         chain + target + instance summary
POST   /api/targets/:environment/instances       { name } → 201 { id, token } shown once
DELETE /api/instances/:id                        revoke → that instance fails closed
GET    /api/environments/:environment/config     the projection, admin only          [V2-08]

# telemetry (G4)
GET    /api/telemetry/summary?environment=&sinceMin=    totals, per-minute series, outcomes
GET    /api/telemetry/resources?environment=&sinceMin=  per API and version
GET    /api/telemetry/consumers?environment=&sinceMin=  per subscription
GET    /api/telemetry/instances?environment=&sinceMin=  per instance + last process report

# the instance protocol (D11) — replaces GET /api/gateway/config
POST   /api/gateway/poll                                Bearer <instance token>
```

Rules carried over unchanged: `can()`, the `Origin` check on cookie-authenticated mutations
(bearer-authenticated polls exempt), `If-Match` on resource `PATCH`, `problem+json` errors,
`?limit=&cursor=` pagination, and an egress check on every URL an author writes.

New rules:

- **Telemetry reads are team-scoped**: only rows whose `resource_id` belongs to a team the caller
  is in, unless the caller is an admin. The `''` (no-route) bucket is **admin-only** — it is the
  estate's 404 traffic and belongs to nobody.
- **Minting an instance token is admin-only**, the token is shown exactly once, and a target may
  hold at most `MAX_INSTANCES_PER_TARGET` (16) unrevoked instances `[V2-09]` — which is also what
  makes the telemetry row bound statable. Revoking is admin-only and takes effect at that
  instance's next poll.
- **`skipChain` requires an admin *and* a non-empty `reason`**, both written to `release.reason`
  and `audit`.
- **`copy-from` requires a non-empty `units` list** `[V1-20]`, overwrites only those units,
  returns the before/after diff, sets `origin='local'` on everything it writes — it is an
  explicit act, not seeding — and is audited. No unit list is a `400`, because "copy everything"
  is how an environment gets silently flattened.
- **`GET /api/environments/:environment/config` stays admin-only** `[V2-08]`: it is every
  subscription's key hash and every route's policy in one document. The Gateways view reads its
  digest and route count from `GET /api/targets/:env/health`, which is summary data.

---

## 7. Promotion (G1)

### The gate

`PROMOTION_CHAIN=dev,test,prod`. A release of revision *R* into environment *E* is permitted iff

- *E* is the first link of the chain, **or**
- *R* has **at some point** reached the fleet in *E*'s predecessor, **or**
- the caller is an admin and passed `skipChain` with a reason.

"At some point" is what makes rollback work, and it is read as
`release.state IN ('converged','superseded','withdrawn')` for that revision and that
environment `[V2-02]`. Those two terminal states are reachable only from `converged`, and
migration 002 adds a trigger that enforces it, so the gate does not depend on two `WHERE`
clauses staying correct. `applied` cannot answer this: it is keyed `(target_id, resource_id)` and
the next revision overwrites it.

The test is: promote rev 6 dev→test→prod, move test to rev 8, roll prod back to rev 6 — allowed.
A rejection names the predecessor and the revision's furthest point along the chain.

The gate also refuses with `409`, naming exactly what is missing:

- no `route` row for *E* — a contract with no front door;
- no `binding` row for *E* — a route with no backend must not reach the fleet;
- *E* is not in `PROMOTION_CHAIN`.

Route and binding are **not** seeded from the predecessor. §6.1 puts them in the edited-in-place
tier, and a TEST backend URL guessed from DEV is exactly the mistake that tier exists to prevent.
The dry-run plan reports their absence as a blocker, linked to the screen that fixes it.

### The plan, and the merge

`POST …/releases?dryRun=1` computes and persists a `release_plan`:

```json
{ "planId": "plan_…", "planDigest": "sha256:…", "isRollback": true,
  "resource": { "id": "res_…", "name": "petstore", "apiVersion": "v1" },
  "from": "test", "to": "prod", "revision": 6,
  "blockers": [ { "code": "no-binding", "detail": "prod has no backend binding" } ],
  "policy": {
    "create":    [ { "unit": "auth.subscriptionKey", "value": {…}, "from": "test" } ],
    "keep":      [ { "unit": "rateLimit", "value": {…}, "reason": "present in prod" } ],
    "localOnly": [ { "unit": "headers.request", "reason": "absent in test, kept" } ] },
  "warnings": [ "no authentication policy attached in prod after this release" ] }
```

The merge is §6.3's table, per unit, on **every** release from a predecessor, not only the first:

| In predecessor | In target | Result |
|---|---|---|
| present | absent | **created with the predecessor's values**, `origin='seeded'`, `seeded_from_env` |
| present | present | untouched |
| absent | present | untouched — removal never propagates |

Editing a `seeded` unit flips it to `local`, and it is never overwritten again. The merged
document is validated before the plan is returned; a merge that produces an invalid document
fails the plan naming both units rather than half-applying a release.

- **`plan_digest` is `sha256(canonical({ resourceId, revisionId, from, to, create[], keep[],
  localOnly[], blockers[] }))`** `[V1-04]` — the decided content and nothing volatile, so a second
  dry run a minute later matches while a policy, route, binding or revision change does not.
- **The reconcile job writes the seeded policy rows** `[V1-03]`, inside the same transaction that
  moves `release.state`, after re-computing the plan and comparing digests. The API layer only
  persists plans and enqueues. A release that fails or goes `stale` therefore changes no policy
  at all.
- **A plan is single-use** `[V2-03]`: confirming sets `release.plan_id`, and a plan already
  referenced by a release that is not `stale` cannot be confirmed again.
- Releasing without `planId` is allowed **only for the first link** of the chain, where there is
  no predecessor and therefore no merge.
- **A rollback re-runs the merge against the predecessor's policy as it is today** `[V1-19]`, not
  as it was when that revision was current. That follows from §6.3 — the design deliberately does
  not snapshot policy per release — so the plan carries `isRollback: true` and the UI states which
  units the rollback will create and from where. Visibility, not prevention, matching §6.4.

### Divergence (§6.4)

`GET /api/resources/:id/divergence` diffs `policy_entry`, `route` and `binding` along the chain
and classifies each unit as **pending** (in the predecessor, absent here — the next promotion
creates it), **local addition**, **value drift** (with `origin`, who and when) or **aligned**.
DEV has no predecessor, so everything there is a local addition and the view says "no
predecessor" rather than showing an empty diff `[V1-24]`. Route host and backend URL differences
are expected and shown greyed; an `auth.*` unit present upstream and absent in PROD is a warning.
Nothing is blocked and nothing reconciles on a schedule — that is what makes editing in place
safe.

---

## 8. Versioning (G2)

**A consumer-visible version is a resource.** `UNIQUE(team_id, name)` becomes
`UNIQUE(team_id, name, api_version)`; a *family* is `(team_id, name)` and its members are the
`api_version` values. Nothing else moves: each version has its own revisions, routes, bindings,
policy, releases and lifecycle, and one product can contain several versions, so one subscription
key calls all of them.

- `POST /api/resources/:id/versions { apiVersion }` creates the sibling and copies the source's
  newest revision as the new resource's rev 1 (unfrozen — it is a new contract line).
  `copyPolicyFrom: "dev"` copies that environment's policy units as `local`.
  `createRoutes: true` creates, **for each environment where the source has a route**, a route
  for the new version at the *proposed* base path `/<name>/<apiVersion>` with the same host —
  never a copy of the source's base path, which would violate
  `UNIQUE(environment, host, base_path)` on arrival — and skips, naming them, any environment
  where that base path is already taken `[V4-03]`.
- `api_version` matches `^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$` `[V1-21]`, and two versions may not
  differ by case alone. It only *prefills* the base path; the route is still an explicit row.
- Routing needs no new mechanism: `/petstore/v1` and `/petstore/v2` are two rows and the existing
  longest-base-path match resolves them. `UNIQUE(environment, host, base_path)` still holds.
- **Lifecycle is a property of the version and is global across the chain** `[V1-05]` — §6.1's
  per-environment tier is `policy`, `route`, `binding`, `subscription`, and lifecycle is not one
  of them. So the UI reads "v1 deprecated, v2 active", never "deprecated in prod only".
  - `deprecated` is advisory: the gateway emits `Deprecation: true` and, when `sunset_at` is set,
    `Sunset: <IMF-fixdate>` (D17) on **every** response for that route, including rejections
    `[V1-17]` — a consumer being rate limited still needs to know the version is going away.
  - `retired` blocks **new** subscriptions, and because the subscription unit is a *product*, the
    rule is defined there `[V1-06]`: `POST /api/subscriptions` refuses with `409` when
    `product.lifecycle = 'retired'`, or when the product has no non-retired member with a
    converged release in that environment, naming the product and the environment. When only
    *some* members are retired it succeeds with a warning naming them. Existing subscriptions are
    never affected — that is the half of §4.2 that matters.
- The API list groups by family and shows each version's per-environment published state, so
  "v1 deprecated and live in prod, v2 active and live in dev" is one screen.

---

## 9. Multiple gateways (G3)

One `standalone` target per environment (`config/targets.json` gains `test` and `prod`), and up
to `MAX_INSTANCES_PER_TARGET` instances per target.

- Tokens are minted through `POST /api/targets/:env/instances` and shown once. `seed` mints the
  four the demo uses.
- **Each process is configured by its own env file, and a token never appears in argv**
  `[V1-12]`: `seed` writes `.data/env/<name>` and `stack.ps1` starts each gateway with
  `bun --env-file=.data/env/dev-1 run data-plane/src/server.ts`. `GATEWAY_TOKEN_FILE` is also
  accepted for a path-based secret. `--port` and `--name` remain flags because neither is a
  secret; there is no `--token` flag.
- Each instance keeps its own fail-static cache (`GATEWAY_CONFIG_CACHE`, default
  `.data/dp-<name>-config.json`); four processes sharing one file would interleave writes.
- `scripts/stack.ps1 -Up` starts the backend, the control plane and all four gateways, waits on
  every `/healthz`, and prints the table; `-Down` stops them; `-Status` prints digests and sync
  state.
- **Rate limiting is per instance (§5.7), and with two DEV gateways that becomes visible**: a
  consumer spread across both sees up to `calls × 2`. The UI already states the arithmetic from
  `/api/meta`; v2 makes it true, and the load harness measures it deliberately rather than
  tripping over it. There is no load balancer in front, so a `curl` at one port is deterministic.

Revoking an instance makes that process fail closed at its next poll — `503` with a distinct
problem type — while the other three are untouched. That is the G3 test.

**The fleet view lags one poll, by design** `[V1-08]` (v1's `[I3]`): an instance reports the
digest it has *activated*, so the control plane learns about a new config on the poll after the
one that delivered it. `unchanged: false` is delivery, not activation; `applied` and
`gateway_instance.config_digest` stay different facts. The UI and the demo wait rather than
checking once.

---

## 10. Telemetry (G4)

### Transport — the poll becomes bidirectional (D11)

```
POST /api/gateway/poll        Authorization: Bearer <instance token>
{
  "wireVersion": 2,
  "instance": { "name": "dev-1", "runId": "run_…", "startedAt": "…",
                "activeDigest": "sha256:…" | null,
                "process": { "rssBytes": 0, "cpuUserMs": 0, "cpuSystemMs": 0, "uptimeSec": 0 } },
  "telemetry": {
    "droppedSeries": 0, "droppedWindows": 0,
    "windows": [ { "windowStart": "2026-08-31T10:05:00.000Z", "series": [
      { "resourceId": "res_…", "subscriptionId": "sub_…", "outcome": "ok", "status": 200,
        "count": 12, "durationMsSum": 480, "durationMsMax": 91,
        "bytesIn": 0, "bytesOut": 143000, "buckets": [/* 15 ints */] } ] } ]
  }
}

200 { "wireVersion": 2, "unchanged": true,  "digest": "sha256:…", "acceptedWindows": [ … ] }
200 { "wireVersion": 2, "unchanged": false, "config": { …GatewayConfig… },
      "acceptedWindows": [ … ] }
401 | 403   this instance is revoked → drop the route table, fail closed
413         the report was too large → the instance halves its window batch and retries
```

**The report is absolute per `(window, series)`, never a delta, and the flush replaces rather
than adds** `[V1-01]`. That single decision makes a resend idempotent, so a lost response — the
normal outcome of a control-plane restart — cannot inflate the numbers. Two rules make it sound:

- a request is counted **in the minute it completed**, so a closed window never reopens (a
  request from 10:04:59 finishing at 10:05:29 counts in 10:05);
- the instance clears a window only when it is both **closed** and named in `acceptedWindows`, so
  the current partial minute is always re-sent and always replaced.

A restart would otherwise replace a minute's pre-restart counts with the post-restart ones, so
telemetry is keyed by `(instance_id, run_id)` where `run_id` is a fresh per-process id
`[V2-01]`. Reads sum across runs; the fleet view still keys on `instance_id`, so one gateway is
one row however often it restarted.

Everything else about the poll is unchanged: bearer token, 2 s interval, fail-static cache,
revocation fails closed, staleness never does. An instance that does not understand
`wireVersion` keeps its previous config and says so.

### Grain, and its bounds

The instance aggregates in memory keyed
`(utcMinute, resourceId, subscriptionId, outcome, status)` with count, summed and max duration,
bytes in and out, and 15 latency buckets
(`1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000, ∞` ms).

| Bound | Value | Behaviour past it |
|---|---|---|
| `TELEMETRY_MAX_SERIES` | 2000 | new keys fold into one `overflow` series; `droppedSeries` counts them |
| `TELEMETRY_MAX_WINDOWS_PER_REPORT` | 15 | oldest windows dropped, counted in `droppedWindows` `[V1-09]` |
| `MAX_REPORT_BYTES` (control plane) | 1 MiB | `413`; the instance halves its window batch and logs `[V1-09]` |
| `MAX_RUNS_PER_INSTANCE_WINDOW` | 16 | further runs fold into run id `overflow` `[V3-01]` |

Silent truncation would read as "that traffic did not happen", so every drop counter is reported
on `/healthz` and shown in the UI.

- `outcome` is a closed vocabulary, one value per pipeline exit, so "what did each policy
  actually do" is answerable: `ok`, `upstream-error`, `no-route`, `no-config`, `decommissioned`,
  `no-key`, `bad-key`, `not-in-product`, `rate-limited`, `precondition`, `content-type`,
  `soap-mismatch`, `body-too-large`, `backend-timeout`, `backend-unreachable`.
- **`bytesIn` counts bytes actually read from the client** `[V1-26]`, so a rejection before the
  proxy reports 0 and "requests × average size" is not expected to reconcile.
- `bytesOut` is counted by a pass-through transform on the response body, because the upstream
  `Content-Length` is stripped (v1 `[I4]`) and could not be trusted anyway. Its cost is one of
  the things the load report measures (`telemetry-off/on`).
- A **decommissioned** instance stops reporting `[V1-23]`: its buffer accumulates to the bound and
  then drops with the counter, its already-flushed rows stay for the retention window, and the
  fleet view marks it revoked — so the gap in a chart is explainable.

### Aggregation, storage and retention

The control plane accumulates reports **in memory** and flushes every
`TELEMETRY_FLUSH_INTERVAL_SEC` (default 10) in one batched transaction — §5.7's rule for
`usage_counter`, for the same reason: four instances × active subscriptions × 0.5 polls/s against
a single SQLite writer is otherwise a steady write load.

- The upsert **replaces** every measure for its key, and the in-memory aggregate replaces too.
- Ids are stored **as reported**, including ones whose resource has since been deleted `[I4]`.
  There is no foreign key here, so a dangling id cannot fail a batch, and keeping it means a
  deleted API's traffic stays attributed to that API rather than being relabelled as having
  matched no route. Such rows become admin-only, because team scoping resolves through
  `resource.team_id`.
- `environment` is written from the instance's target. An instance cannot report traffic for an
  environment it does not belong to.
- The **`prune` job** `[V1-22]` runs hourly (idempotency key = the hour) and has three subjects:
  `telemetry_rollup` past `TELEMETRY_RETENTION_HOURS` (48); `job` rows in a terminal state past
  `JOB_RETENTION_HOURS` (168); and `release_plan` rows past the same age that no `release`
  references. `audit` is never pruned — dropping its triggers is out of scope (§4).
- Row bound, statable because every factor is bounded:
  `instances (≤16 per target) × runs (≤17) × series (≤2000) × minutes (2880)`.

### What the control plane shows

One **Telemetry** view, environment-switched, over a selectable window (15 min / 1 h / 6 h / 24 h):

- Totals as **three numbers, not one** `[V1-25]`: `ok`, `gatewayRejections` (outcomes that never
  reached the backend) and `upstreamErrors` (a 4xx or 5xx the backend produced), with
  `errorRate = 1 - ok/total` defined and labelled. A `429` we produced and a `500` the backend
  produced are different signals and are never summed into one "errors" figure.
- A per-minute request series stacked by outcome — where a rate-limit or precondition change
  shows up as a shape change within a minute.
- Per API and per version: count, the three numbers, p50/p95, last seen.
- Per consumer (subscription → application → team): count, rejections, share.
- Per instance: count, share, RSS, CPU, uptime, active digest, in-sync, last seen, drop counters.
- Percentiles are interpolated linearly inside the containing bucket and are labelled
  **approximate**, with a footnote naming the grain and the retention. Claiming an exact p99 from
  15 buckets would be a lie.

---

## 11. SOAP (G5)

### The XML reader

`shared/xml.ts` is a hand-written, deliberately restrictive reader, not a general parser — the
same call as v1's D8 pattern linter: refuse what we do not understand.

- Refuses `<!DOCTYPE`, `<!ENTITY`, external entities and any processing instruction other than
  the XML declaration, in every mode. Not "expanded safely" — refused, with a distinct error.
- Bounds input length, depth (`maxDepth`) and element count (`maxElements`) before and during
  parsing.
- Supports exactly what a WSDL and a SOAP envelope need: elements, attributes, namespaces, text,
  CDATA, comments (skipped), the five predefined entities, and numeric character references
  bounded to the BMP.
- Two entry points: `parseDocument(text, limits)` for the control plane's WSDL import, and
  `scanEnvelope(prefix, limits)` for the data plane's bounded scan, which returns
  `{ soapVersion, bodyChildQName }` and never builds a tree.

### Import (control plane)

`normalize-wsdl.ts` maps WSDL 1.1 onto the same `ApiModel` the REST path uses:

```ts
model.soap = { version: "1.1" | "1.2", service, port, endpoint, targetNamespace }
model.operations[] += { soapAction: string, inputElement: "{ns}Name", outputElement, style }
```

- Scope: WSDL 1.1, `document/literal` (`rpc/literal` rejected with a message that says so), one
  `service` and `port`, and **self-contained**: `wsdl:import` and `xsd:import`/`xsd:include` with
  a location are rejected exactly as a remote `$ref` is (§5.3). An uploaded contract must not
  depend on someone else's web server.
- `version_digest` is computed over the same canonical model, so a reformatted WSDL does not
  churn it — v1's property, now covering a second dialect.
- Export: `?format=original` returns the WSDL verbatim, `?format=model` the JSON summary (D13).
- `binding` prefills from `soap:address location`; the egress allowlist applies as always.

### Routing shape for a SOAP route `[V2-07]`

A SOAP client posts every operation to one URL, so the route is a single endpoint and the join
must be stated or it produces backend 404s that look like gateway bugs:

- base path is one endpoint — `/petstore-soap`;
- `rewrite.stripBasePath` defaults **on** for `soap`;
- the binding URL carries the backend's full endpoint path —
  `http://127.0.0.1:9080/soap/petstore`;
- so the composed URL is `backendPath + "/"` and a test asserts it for both `stripBasePath`
  states.

### Request path (data plane)

Two additions, in their §5.2 positions:

- **Step 3, content type** — a `soap` route accepts only the configured content types; anything
  else is `415` shaped by `errorFormat`. This sits *before* authentication because §5.2 puts the
  `always` block at 3 and authenticate at 6. The consequence is deliberate and worth naming
  `[V2-05]`: an unauthenticated caller can learn from the `415` that a route is SOAP. That is the
  design's ordering and the disclosure is not worth inverting it for.
- **Step 8, SOAP prefix scan** — after preconditions, before rewrite, so unauthenticated traffic
  never makes the gateway parse XML. It reads at most `xml.maxPrefixBytes` (8 KiB), resolves the
  first child element of `Body`, and:
  - records the resolved operation on the access log (not in the rollup key — that would multiply
    cardinality);
  - checks **agreement, not presence** `[V1-10]`: the declared action must equal that operation's
    binding action, where absent and `""` are the same thing — `soapAction=""` is legal in WSDL
    1.1 and SOAP 1.2 has no `SOAPAction` header at all, only an optional content-type parameter.
    A body element that resolves to no operation is the same rejection. One outcome,
    `soap-mismatch`, with the log detail distinguishing the two cases. `400`.

**Stream composition is fixed** `[V1-11]`, because the cap and the scan both want to read
`req.body` first:

1. the counting cap transform wraps `req.body`, so the cap and `bytesIn` cover every byte;
2. the scan pulls at most `maxPrefixBytes` from the *capped* stream into a buffer;
3. the upstream body is a new stream that enqueues the buffer and then pipes the remainder, with
   `duplex: "half"`.

A large envelope therefore still streams instead of being buffered whole.

### Errors

`errorFormat: soap-fault` renders every gateway rejection as a fault:

```xml
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>
  <soap:Fault>
    <faultcode>soap:Client</faultcode>
    <faultstring>rate limit of 3 calls per 10s exceeded for this subscription</faultstring>
    <detail><apim:error xmlns:apim="urn:apim:error"><apim:status>429</apim:status>
      <apim:requestId>…</apim:requestId></apim:error></detail>
  </soap:Fault>
</soap:Body></soap:Envelope>
```

- `faultcode` is `soap:Client` for 4xx and `soap:Server` for 5xx (1.2: `env:Sender` /
  `env:Receiver`).
- **The HTTP status is kept** — `401`, `403`, `429`, `413`, `415`, `504` — rather than collapsed
  to `500`. A consumer that reads status codes keeps working and `Retry-After` still means
  something on a 429. Stated because SOAP 1.1 conventionally uses 500 for faults, so this is a
  deliberate departure.
- The fault renders through the same closed template variable set, so a precondition's
  `deny.body` may be XML and an unknown `${…}` is still a write-time error.

---

## 12. Data-plane pipeline v2

| # | Step | New in v2 | Failure |
|---|---|---|---|
| 1 | route match — host, longest base path | versions are just more routes | `404` `no-route` |
| 2 | trusted-proxy context | — | — |
| 3 | always-on limits — `Content-Length` and streamed cap | content-type allowlist on `soap` | `413` / `415` |
| 4 | authenticate — subscription key | — | `401` |
| 5 | authorize — product contains resource | — | `403` |
| 6 | rate limit | — | `429` + `Retry-After` |
| 7 | preconditions | — | rule's status |
| 8 | **SOAP prefix scan + action agreement** | ✔ | `400` `soap-mismatch` |
| 9 | rewrite | — | — |
| 10 | request headers | — | — |
| 11 | proxy | — | `504` / `502` |
| 12 | response — hop-by-hop, framing, rate headers | **`Deprecation`/`Sunset`**, byte counting | — |
| 13 | access log + **telemetry counter** | ✔ | — |

Unchanged constraints: the rate limit precedes preconditions, so a precondition denial has
already consumed budget; credential stripping precedes the proxy. New constraint: the SOAP
*parse* runs after authorization (§5.2's step 11 after 7), so unauthenticated traffic cannot make
the gateway parse XML — while the content-type *check* stays at step 3 where §5.2 puts it.

Every exit — including `404`, `413` and `503` — increments exactly one telemetry series, so the
counts reconcile: client requests sent = `/healthz`'s `requestsTotal` = control-plane
`sum(count)`. `/healthz` reports `requestsTotal` and
`telemetry: { series, droppedSeries, droppedWindows, pendingWindows }` precisely so a test has a
second source to compare against `[V1-16]`.

That identity holds **after a flush and read as an admin** `[V4-04]`, and both qualifiers are
load-bearing: the current partial minute has not been flushed yet, and a non-admin cannot see the
`''` no-route bucket. The aggregator therefore exposes `flushNow()`, and the tests call it rather
than sleeping — v1's `[R2-04]` discipline of waiting on a fact, never on a duration.

`/healthz` stays unauthenticated `[V4-05]`. §8.1 puts a reverse proxy in front of the gateway and
does not publish that path through it; the endpoint carries no request content, no consumer
identity and no key material — only counters and the digest v1 already published. Adding a second
authentication mechanism to the data plane for a counter would be the worse trade. Recorded as a
decision rather than left as an oversight.

### Wire contract v2

`CONFIG_VERSION = 2`. `ConfigRoute` gains:

```ts
apiVersion: string;                 // consumer-visible (G2)
lifecycle: "active" | "deprecated" | "retired";
sunsetAt: string | null;            // → Sunset (RFC 8594); lifecycle → Deprecation (D17)
kind: "rest" | "soap";
errorFormat: { shape: "problem+json" | "soap-fault"; soapVersion?: "1.1" | "1.2" };
soap?: { version: "1.1" | "1.2";
         operations: Array<{ soapAction: string; element: string }> };  // routing, not schemas
```

Only the operation index travels, never the XSD set — §8.7's split between routing tables and
compiled artifacts, honoured without building the artifact channel. Shared types change with it
`[V1-18]`: `RESOURCE_KINDS` gains `soap`, `ReleaseState` gains `stale`, `OriginalFormat` gains
`wsdl-1.1`, `ApiModel` gains `soap`, `ApiOperation` gains `soapAction` / `inputElement` /
`outputElement`, and `PolicyUnitKey` gains `errorFormat`.

---

## 13. UI

Additions, no new dependencies:

| View | Adds |
|---|---|
| Global | An **environment switcher** in the header; every environment-scoped screen reads it |
| APIs | Grouped by family; a version chip per row; per-environment published state |
| API → Versions | The family's versions, lifecycle, where each is live; "new version" |
| API → Definition | WSDL upload for `soap`; operations with their SOAPAction; original vs generated labelled (D13); "no schema validation" stated plainly (D12) |
| API → Routing / Binding | Per environment, driven by the switcher |
| API → Policies | Per environment; the `origin` badge now means something (`seeded from dev`); `errorFormat` editor on `soap` |
| API → Promotion | The chain as three columns with what is live in each; **Promote** opens the dry-run plan (create / keep / local-only / blockers / warnings, and `isRollback` when it is one) and confirms with `planId`; rollback; `skipChain` behind an admin-only disclosure with a required reason |
| API → Divergence | §6.4's four categories, `auth.*`-absent-in-prod highlighted |
| Gateways | All environments; instances with digest, in-sync, RSS/CPU/uptime, last seen, drop counters; mint (token shown once) and revoke |
| Telemetry | §10's dashboard |
| Catalog | Subscriptions are per environment; a `retired` product refuses new subscriptions with the reason, and a partly retired one warns |

Charts are inline SVG built from the series endpoints — a sparkline and a stacked bar are twenty
lines each, and a charting dependency is not worth it here.

---

## 14. The backend simulator and the load harness (G6)

### `tools/backend` — `bun run backend` (:9080)

A local petstore that never leaves the machine.

- **REST**: `GET /v2/pet/{id}`, `POST /v2/pet`, `GET /v2/pet/findByStatus`,
  `GET /v2/store/inventory` and `GET /v2/echo` — the operations the imported petstore spec
  declares, so the same contract works against both backends.
- **SOAP**: `POST /soap/petstore` implementing `GetPet` and `AddPet` for the WSDL fixture, with a
  real SOAP Fault for an unknown pet.
- **Simulation**, per request or by profile:
  - `X-Sim-Delay-Ms: 5000`, or `X-Sim-Delay-Dist: exp:200 | p95:2000`, to a **30 s** ceiling;
  - `X-Sim-Status: 500`, `X-Sim-Fail-Rate: 0.05`;
  - `X-Sim-Body-Bytes: 1048576` for the response size; request bodies are read and counted;
  - `X-Sim-Chunk-Delay-Ms` for a slow trickle, exercising the streaming path.
  - `config/backend-profiles.json` maps path prefixes to defaults, so scenarios need not send
    headers for everything.
- **Deterministic**: a seeded PRNG (`--seed`), so a run reproduces. `GET /__stats` reports
  requests, in-flight and bytes, so the harness can assert the backend saw what was sent.

### `tools/loadgen` — `bun run perf`

- A scenario is `{ name, target: "direct" | "gateway", url, method, headers, bodyBytes,
  concurrency, durationSec, backendProfile }`, and every gateway scenario is paired with an
  identical direct-to-backend scenario in the same run. **The reported number is the
  difference**; absolute throughput on a laptop measures the laptop.
- Per scenario it records completed, rps, p50/p90/p95/p99 (exact — the harness retains its own
  samples even though the dashboard cannot), status and outcome distribution, bytes, errors, and
  the gateway's RSS/CPU delta read from `/healthz`.
- **Three rules keep the per-policy table honest** `[I7]`, all learned from a run that reported
  host socket churn as policy cost:
  - one full run is discarded as warm-up, because whatever is measured first pays for JIT and
    connection establishment;
  - every policy scenario is paired with its own baseline run **seconds** before it, not with the
    single baseline at the top of the matrix minutes earlier;
  - `baseline-again` repeats the first scenario last, and the report prints the gap between the
    two and says to read any per-policy figure smaller than it as noise.
- The matrix, all against the local backend:

  | Group | What it isolates |
  |---|---|
  | `baseline` | route match and proxy only, no policy |
  | `auth`, `precondition`, `ratelimit`, `headers`, `rewrite` | one unit at a time against `baseline` — **the per-policy cost table** |
  | `all-policies` | the stack together, to show whether the costs are additive |
  | `reject-401/403/429/413`, and `reject-429` as `problem+json` vs `soap-fault` | rejection paths, which should be cheaper than a proxied call — and the only place `errorFormat` has a measurable cost `[V1-13]` |
  | `body-1mib-up`, `body-1mib-down`, `chunked` | size and streaming |
  | `latency-100ms / 2s / 10s / 30s` | backend latency under concurrency, each with an explicit `timeoutMs` above the simulated delay `[V1-14]` |
  | `timeout-edge` | a 30 s backend against `timeoutMs = 5000`, asserting `504` every time |
  | `soap-small`, `soap-8kib-envelope` | the prefix scan's cost |
  | `fleet-2` | round-robin across the two DEV gateways: `calls × instances` made visible |
  | `telemetry-off/on` | the cost of counting, measured rather than assumed |

- **Two tiers of execution**:
  - `bun test` runs `test/perf.guard.test.ts` — about 15 s, a small fixed load, asserting only
    *relative* and *structural* properties: zero errors, gateway p95 within a generous multiple
    of direct p95, and telemetry counts equal to requests sent. It builds its own world the way
    v1's helpers do — temp SQLite, control plane and backend on **ephemeral ports**, the data
    plane in-process — so it cannot collide with a running stack `[V1-15]`. `PERF_GUARD=0` skips
    it, and it skips itself on fewer than four cores.
  - `bun run perf [--profile quick|full]` runs the matrix (quick ≈ 3 min, full ≈ 20 min) and
    writes `docs/perf-report.md`, `.data/perf/<iso>.json` and a line in `.data/perf/history.jsonl`.
- **The report** is generated, and its header says so, by which command and when `[V2-06]`. It
  carries: machine facts (OS, cores, RAM, Bun version, seed); one row per scenario; the
  per-policy cost table with deltas; the latency and size curves; the fleet-arithmetic result;
  a **delta against the previous run** from `history.jsonl`; and a "what this does not measure"
  section — single machine, loopback, the harness competing for the same cores, no TLS, no
  reverse proxy in front.
- **Regularly** means three things, all documented: the guardrail in `bun test`;
  `scripts/schedule-perf.ps1`, which registers a daily Windows scheduled task running the quick
  profile (opt-in, prints what it will register before doing it); and `.github/workflows/perf.yml`
  for when this has a remote.

---

## 15. Configuration

```
Control plane   … v1 values unchanged …
                PROMOTION_CHAIN=dev,test,prod
                TELEMETRY_FLUSH_INTERVAL_SEC=10   TELEMETRY_RETENTION_HOURS=48
                MAX_REPORT_BYTES=1048576          MAX_INSTANCES_PER_TARGET=16
                MAX_RUNS_PER_INSTANCE_WINDOW=16   JOB_RETENTION_HOURS=168
Data plane      DP_PORT / --port      DP_NAME / --name      GATEWAY_TOKEN | GATEWAY_TOKEN_FILE
                GATEWAY_CONFIG_CACHE=.data/dp-<name>-config.json
                TELEMETRY_MAX_SERIES=2000   TELEMETRY_MAX_WINDOWS_PER_REPORT=15
Backend         BACKEND_PORT=9080  BACKEND_SEED=1  BACKEND_PROFILES=config/backend-profiles.json
```

Secrets never reach argv `[V1-12]`: each gateway is started with
`bun --env-file=.data/env/<name>`, and `.data/` is git-ignored.

`config/targets.json` gains `test` and `prod` standalone targets. `config/integrations.json`
gains the `xml` ceilings and keeps the egress allowlist, which already admits the local backend
on `127.0.0.1:9080`.

---

## 16. Tests

**Shared** — WSDL normalisation and digest stability across reformatting · the XML reader refuses
DTD, `<!ENTITY>`, external entities, a billion-laughs payload, and depth and element overruns ·
`scanEnvelope` finds the body child in namespaced 1.1 and 1.2 envelopes and refuses a truncated
one · SOAPAction agreement including the empty-action and 1.2-no-header cases · `errorFormat`
validated against `kind` · promotion-gate arithmetic including the "at some point" clause · the
merge table, all four rows · bucket boundaries and percentile interpolation.

**Migration** — a **seeded v1 database** upgrades to v2 with every child row intact `[V1-02]`;
`foreign_key_check` failure rolls back; the `release_state_history` trigger rejects
`pending → withdrawn`.

**Control plane** — the gate rejects dev→prod naming test; test then prod succeed; rollback works
after the chain moved `[V2-02]`; `skipChain` needs admin *and* reason; a plan whose digest moved
is refused and the release goes `stale`; a plan cannot be confirmed twice `[V2-03]` · seeded units
are created with the predecessor's values and **function** — asserted by making a request the
created unit governs, not by reading a row · editing a seeded unit flips it to local and survives
the next promotion · release with no route or binding → `409` naming which · two versions live
simultaneously in one environment with different revisions and different policy · a retired
product refuses a new subscription and leaves existing ones working `[V1-06]` · minting respects
`MAX_INSTANCES_PER_TARGET`; revoking affects only that instance · telemetry: a report is
accepted, flushed and appears in the summary; **a re-sent window does not double-count**
`[V1-01]`; a restart writes a new `run_id` rather than replacing `[V2-01]`; an unknown resource
folds to `''`; an oversize report is `413`; the prune job removes telemetry, jobs and plans ·
telemetry reads are team-scoped and the no-route bucket is admin-only.

**Data plane** — everything v1 asserts, plus: `Deprecation` and `Sunset` on every response for a
deprecated route, **including a 429** `[V1-17]` · a `soap` route rejects `application/json` with
`415` as a fault · an action that disagrees with the body is `400` before the backend is reached ·
a valid SOAP call proxies with the envelope untouched · a rate-limit rejection on a `soap` route
is a fault with status `429` and `Retry-After` · an envelope larger than the prefix still streams
`[V1-11]` · the composed backend URL is right for both `stripBasePath` states `[V2-07]` ·
telemetry counts equal `requestsTotal` equal requests sent — after `flushNow()` and read as an
admin `[V4-04]` — one series per exit, `bytesOut` matches what the client received, and the map
folds into `overflow` past the bound.

**Integration / E2E** — `scripts/demo.ps1`: create petstore v1 → publish dev → promote test →
promote prod through the plan → create v2 → both online in dev → subscribe per environment →
`curl` both versions → check-header and rate-limit policies enforced on the right one → import
the SOAP API → `curl` a call and a fault → revoke one gateway and watch only it stop → read
telemetry back and assert the counts the script itself generated. It deletes previous demo
objects by `(name, apiVersion)` `[V1-27]`, so it stays re-runnable now that names repeat.

**Performance** — the guardrail in `bun test`, the matrix behind `bun run perf`.

---

## 17. Build order

0. **Shared types first** `[V1-18]` — both planes and the UI compile against them.
1. **Migration 2 and the runner flag**, with the seeded-upgrade test, plus
   `PROMOTION_CHAIN=dev,test,prod` and the three targets in `targets.json` `[V3-02]` — every
   later step then has three environments to work in, even though promotion logic lands at step 5.
2. **Wire v2**: `CONFIG_VERSION = 2`, the poll envelope, `POST /api/gateway/poll`, both planes,
   with v1's config-poll tests rewritten to the new contract. Nothing else can be tested until
   this holds.
3. **Fleet** (G3): mint and revoke, per-instance env files, `stack.ps1`, four gateways up.
4. **Telemetry** (G4): data-plane counters → report → aggregator → flush → prune → API → view.
   Before promotion, because it is how the rest of the work is observed.
5. **Promotion** (G1): gate, plan, merge, divergence, UI.
6. **Versioning** (G2): the `resource` rebuild's API surface, versions endpoint, lifecycle
   headers, UI.
7. **SOAP** (G5): XML reader → WSDL import → `errorFormat` → pipeline steps → fault rendering.
8. **Backend simulator** (G6), then the load harness, then the first report.
9. Demo script, README, then a full `bun test` and `bun run perf --profile quick`.

---

## 18. Risks

| Risk | Mitigation |
|---|---|
| The `resource` rebuild loses data | The runner's `foreignKeysOff` flag, the pragma outside the transaction, `foreign_key_check` read and thrown on, and a test that upgrades a seeded v1 database `[V1-02]` |
| Telemetry numbers that are quietly wrong | Absolute-replace semantics, completion-minute attribution, `run_id` per process, and a test that re-sends a window and asserts the count did not move `[V1-01] [V2-01]` |
| Four gateways, a backend and a load generator on one laptop measure the laptop | Every headline number is a difference against direct-to-backend in the same run; absolutes are labelled machine-specific; the report names the contention |
| The load guardrail makes `bun test` flaky | Relative and structural assertions only, generous budget, ephemeral ports, skips on small machines, switchable off |
| The hand-written XML reader has a hole | It refuses rather than interprets: no DTD, no entities, no PIs, hard caps before parsing, and the data plane never parses more than 8 KiB |
| Telemetry becomes a write-load problem | Pre-aggregated on the instance, batched flush, per-minute grain, four bounds with counted drops, pruned on a schedule — the §5.7 shape |
| Promotion plans go stale under concurrent edits | The digest is recomputed by the job and a moved digest is a refusal, not a surprise apply; plans are single-use |
| 30 s simulated latency exhausts sockets or stalls the event loop | Bounded concurrency per scenario, an explicit `timeoutMs` per latency scenario, and `timeout-edge` testing the boundary deliberately |
| Six goals is a lot of surface | The build order makes each goal independently demonstrable; if time runs out the last item degrades to the quick perf profile without invalidating anything above it |
