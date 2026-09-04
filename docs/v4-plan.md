# MVP v4 implementation plan — Integration Portal

Draft 5 · what changes to take the shipped v3 (see [`v3-plan.md`](v3-plan.md)) to five new goals,
without abandoning the spine of [`greenfield-design.md`](greenfield-design.md).

Review rounds and the findings that changed this document live in
[`v4-plan-review.md`](v4-plan-review.md). Finding ids appear inline as `[P1-01]`. v1's (`R…`, `I…`),
v2's (`V…`) and v3's (`R…`) findings still hold and are not repeated. **Implementation starts only
after a review round finds nothing** — that is goal 0, and it is why this file exists before any
code. Three claims in draft 1 were checked by running Bun rather than by reasoning; two were wrong,
and the measurements are recorded in the review.

---

## 1. Goals, restated as acceptance criteria

| # | Goal | Acceptance test |
|---|---|---|
| G0 | The plan is reviewed before implementation | [`v4-plan-review.md`](v4-plan-review.md) records every round; the last round finds nothing and closes every open point. No step of §13 begins before that |
| G1 | **Playground** — call a subscribed API from the portal, with history, routed through the control plane | A consumer with an active subscription picks an operation, sends it, and sees status, headers, timing and body. The **browser never sends or receives a key**: it posts a `subscriptionId`, the control plane resolves and injects the key. The call arrives at the gateway as an ordinary request — it consumes rate limit and quota and appears in telemetry. It is replayable from a server-side history that contains no key. A subscription the caller is not entitled to is `403`; there is no field in which a caller can name a host |
| G2 | **Dashboard** | `GET /api/dashboard` answers for whichever hats the caller wears: as an owner, traffic and its error split for their teams' APIs plus a ranked "needs attention" list; as a consumer, their applications' subscriptions, usage against quota and key age; for everyone, one health line per environment. Every number is reproducible from an existing endpoint, every attention row links to the screen that fixes it, and a user with neither APIs nor subscriptions gets a "start here" panel instead of empty tiles |
| G3 | **Revisions** | Every revision is listed with author, digest, frozen state and where it is released. Any two diff **structurally** — operations, parameters, schemas, MCP tools, A2A skills — with breaking changes flagged. An unfrozen revision can be corrected in place; a frozen one refuses with the reason and the alternative. Retention runs as a job with design §4.1's three exceptions and its *tighter-of* bound, leaves a tombstone, and drops artifacts nothing references |
| G4 | **Register a trusted internal CA per environment** | An admin uploads a CA certificate to DEV. Within one poll every DEV gateway trusts it, and a backend whose certificate chains to it verifies with **no TLS exception**. TEST and PROD are unaffected until the anchor is copied there. A non-CA, expired or malformed PEM is refused at upload with the reason. Removal takes effect within one poll. The control plane's own outbound fetches trust the same anchors |
| G5 | **A UI a user can work without help** | Six journeys — **publish, promote, version, subscribe, call, operate** — are completable by someone who has never seen the portal, without documentation. Every screen states its purpose in one line; every action the caller cannot perform is shown **disabled with the reason**, never hidden; every empty state carries the next action; every domain word is a glossary term with a one-sentence definition; publish, promote, new version and subscribe are wizards ending in a review step and a confirmation that says what happened and what to do next |

G1's "no key in the browser", G2's reproducibility, G3's retention bound, G4's "one poll, no
exception" and G5's disabled-with-reason rule are the contract.

---

## 2. What is in and what is deliberately out

### In scope, on top of v3

- **`POST /api/playground`** (design §14) with a server-composed target, server-side key resolution,
  the §5.3 egress rule, a bounded server-side history, and an audit row per call.
- **`GET /api/dashboard`** (design §14) over stores that already exist: `telemetry_rollup`,
  `usage_counter`, `release`, `job`, `gateway_instance`, `tls_exception`, `certificate`, `revision`.
- **Revision management** (design §4.1, §14): the list, `GET /api/revisions/:id/diff`,
  `PUT /api/revisions/:id/spec` on an unfrozen revision, and retention with tombstones and
  reference-counted artifacts.
- **A per-environment trust store** (design §5.4 rung 1): `trust_anchor`, admin-only, distributed to
  every gateway in that environment in the config document, self-expiring on the gateway's clock,
  and honoured by the control plane's own outbound fetches.
- **A UI rebuilt around two hats** (owner, consumer) with guided flows, a shared glossary, one
  attention vocabulary, capability-driven controls and one status vocabulary.

### Out of scope (named, with the section it comes from)

Everything v3 named stays out and stays **absent rather than stubbed**: `kafka` / `kafka-topic` /
`kafka-proxy` (§8.8–§8.10) · `graphql` (§4.4) · the `apim` adapter and import (§8, §16) · approvals
and announcements (§4.2, §6.3) · drift (§7) · OIDC (§9) · service tokens (§9) · OTEL/ELK (§13) ·
Postgres (§13) · automated certificate issuance (§4.3) · active backend health checks (§18.13).

New to the list:

- **Streaming from the playground** (§5.8) — a `passthrough` route is listed with the reason it
  cannot be exercised here and the `curl`/`websocat` line that can. Proxying a live stream through
  the control plane into a browser is a second streaming implementation on the wrong tier.
- **Sharing playground history between users** — history is the caller's own. A request body is test
  data somebody typed, and design §5.1 already treats bodies as carrying personal data.
- **Announcement drafts from the revision diff** (§4.2) — the diff ships; announcements do not.
- **A browser end-to-end harness** (§12's Playwright) — see D30.

### Deviations from the design

D1–D25 stand. New ones:

| # | Design says | v4 does | Reason |
|---|---|---|---|
| D26 | The backend trust bundle is admin config: `backendCaRefs` in `INTEGRATIONS_FILE`, `BACKEND_CA_BUNDLE` per gateway (§5.4 rung 1, §11) | A per-environment `trust_anchor` table, administered in the portal, travelling in the config document to every gateway in that environment | G4 asks for environment level applied to all its gateways. A bundle configured per gateway process cannot be administered from the portal, drifts between instances of one environment, and needs a deploy to change — and §1 says the portal owns desired state. Measured: a per-request `ca` keeps Bun's connection pool and costs ~0.014 ms/request, so the dynamic route is affordable `[P1-02]` |
| D27 | No playground history exists in the design (§14 names only the call) | A bounded server-side `playground_call` table: 25 entries per (user, resource), capped request and response previews, pruned after `PLAYGROUND_HISTORY_RETENTION_DAYS` | The goal asks for history. Browser storage (what the current portal does) is per-device, invisible to audit and one XSS away from being readable; SQLite is where every other fact here lives. It is a user's scratchpad, not a call ledger — §5.7's "no per-call ledger" is about metering |
| D28 | Analysis comes from OTEL in ELK (§13) | The dashboard reads the `telemetry_rollup` store D15 introduced | The consequence of D15/D16, restated because the dashboard is where a user first meets it: numbers are bounded by `TELEMETRY_RETENTION_HOURS`, and the UI says so |
| D29 | Artifacts are reference-counted and dropped when nothing references them (§4.1) | The count is a `COUNT` over `revision.artifact_digest` **excluding tombstones**, as v3 `[R3-02]` chose, not a reference table | One column already carries the reference; a second table would be a second source of truth. Excluding tombstones is what makes the count able to reach zero `[P1-03]` |
| D30 | E2E is Playwright against the real binaries (§12) | UI behaviour is tested as pure modules and `react-dom/server` renders **inside the `ui` workspace**, plus the scripted `demo.ps1` walkthrough | Playwright is a heavy dev dependency and a browser download; the repo has none. Probed: a root-level test cannot import a `ui/src` component (react lives in `ui/node_modules`) but the same render works from inside `ui/`, so `bun test` runs twice `[P1-19]`. Stated as a gap rather than covered by a claim |
| D31 | "`POST /api/playground` — server-side call through a declared, allowlisted binding" (§14) | The call goes to the **environment's gateway**, not to the binding, and the URL is composed by the control plane from `TARGETS_FILE` plus the route | Calling the binding would bypass every policy on the route and answer a question nobody asked. Calling the gateway is what "try it" means, and §5.3's rule still holds: the caller names no host, and the composed URL is egress-checked anyway |

---

## 3. Shape

Nothing moves. One new outbound call from the control plane — to the gateway, on behalf of a
signed-in user — and one new block in the config document.

```
                        Browser (React SPA)
                               │ /api          (never to a gateway, never a key)
        ┌──────────────────────▼───────────────────────────────────────┐
        │ CONTROL PLANE — Bun/TS                            :8080      │
        │  resources · revisions (+DIFF, +RETENTION) · policy          │
        │  promotion · catalog · telemetry · quota · certificates      │
        │  TRUST ANCHORS (per environment)   DASHBOARD   PLAYGROUND ───┼──┐
        │  POST /api/gateway/poll   config (+trustAnchors) ⇄ telemetry │  │
        │                             bun:sqlite .data/apim.sqlite     │  │
        └───┬──────────────┬──────────────┬──────────────┬─────────────┘  │
        ┌───▼────┐    ┌────▼───┐    ┌─────▼──┐    ┌──────▼─┐              │
        │ DP 8081│    │ DP 8082│    │ DP 8083│    │ DP 8084│◄─────────────┘
        │ dev-1  │    │ dev-2  │    │ test-1 │    │ prod-1 │   a playground call is an
        └───┬────┘    └────┬───┘    └─────┬──┘    └──────┬─┘   ordinary gateway request
            └──────────────┴──────┬───────┴──────────────┘     (key, limits, quota, telemetry)
                                  ▼
                           backends (verified against system roots + the
                           environment's registered trust anchors — G4)
```

### Layout — what is added

```
shared/
  diff.ts             structural diff over two ApiModels, with breaking-change classification
  attention.ts        the closed attention vocabulary both planes and the UI speak     [P1-04]
control-plane/src/
  schema-004.sql      migration 4
  attention.ts        the one evaluator: resource/subscription/fleet state → attention rows
  playground.ts       target composition, key resolution, forward, history
  dashboard.ts        the aggregate, per hat
  retention.ts        revision pruning and artifact reference counting, called by the `prune` job
  trust-store.ts      anchors → PEM set, for the config document and for CP outbound fetches
  api/playground.ts  api/dashboard.ts
data-plane/src/
  trust.ts            the CA set for the active config, composed once per activation
ui/src/
  lib/glossary.ts     every domain term, one sentence each, one source of truth
  lib/attention.ts    ordering, grouping and copy for the server's attention rows
  lib/status.ts       one status vocabulary (chips) for lists, detail and dashboard
  lib/capabilities.ts capability + reason → enabled/disabled control state
  components/         Wizard, Stepper, Term, EmptyState, Drawer, Toast, KeyValueRows, CodeBlock
  views/              HomeView · PlaygroundPanel · RevisionsPanel (+ the rebuilt views of §9.7)
ui/test/              the UI suite: pure modules + renderToStaticMarkup                 [P1-19]
test/
  playground.test.ts  dashboard.test.ts  revisions.test.ts  trust-anchors.test.ts
  x509.ts             extended with v3 extensions (basicConstraints, keyUsage, SAN)     [P1-01]
```

---

## 4. Data model changes — `schema-004.sql`

`db.ts` gains `{ version: 4, name: "v4", file: "schema-004.sql" }`. No table is rebuilt, so no
`foreignKeysOff` and no repeat of `[V1-02]`.

```sql
-- G4 §5.4 rung 1 — the environment's trust store. Admin-only, one row per certificate.
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
  removed_at  TEXT
);
-- Partial, so removing an anchor and registering the same CA again is allowed; a *live*
-- duplicate is not (review [P1-06]).
CREATE UNIQUE INDEX trust_anchor_live_unique ON trust_anchor(environment, thumbprint)
  WHERE removed_at IS NULL;
CREATE INDEX trust_anchor_live ON trust_anchor(environment, removed_at, not_after);

-- G1 — the caller's own request history. No key, ever; body and response are capped (D27).
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
  response_preview      TEXT,
  response_encoding     TEXT,           -- 'utf-8' | 'base64'
  response_truncated    INTEGER NOT NULL DEFAULT 0,
  error                 TEXT,
  created_at            TEXT NOT NULL
);
CREATE INDEX playground_by_user ON playground_call(user_id, resource_id, created_at DESC);

-- G3 §4.1 — a pruned revision keeps its row as a tombstone: id, rev, digests, author and
-- timestamps intact, so release foreign keys and audit trails survive.
ALTER TABLE revision ADD COLUMN pruned_at TEXT;

-- G3 — provenance per revision. `resource.discovery_url` is per resource, so it cannot say how
-- THIS revision came to exist; the list in section 7.1 promised something the schema could not
-- answer (review [P2-05]). Written by every creation path; existing rows read as 'upload'.
ALTER TABLE revision ADD COLUMN source        TEXT NOT NULL DEFAULT 'upload';
                                              -- 'upload' | 'url' | 'discovery' | 'copied' | 'corrected'
ALTER TABLE revision ADD COLUMN source_detail TEXT;   -- the URL, or the revision copied from
```

Decisions, not commentary:

- **`trust_anchor` is per environment**, and copying to another is an explicit act (§8.4) exactly
  like `policy/global/copy-from`. Trusting a CA in PROD is a PROD decision.
- **`removed_at` rather than a delete**, so "who trusted this, and when did we stop" survives. A
  removed anchor stops travelling in the config document at the next build.
- **`playground_call.user_id` is the scope**, not the team: a request body is the caller's own test
  data. A team-mate sees the API's traffic in telemetry, not what somebody typed into a form.
- **The response body is stored as a preview, not a body.** `PLAYGROUND_HISTORY_BODY_BYTES` (4 KiB)
  bounds it and `response_truncated` says so — the discipline of `includeBodyExcerptBytes` in §5.1.
- **No `pruned_at` backfill.** Every existing revision is unpruned, which is what NULL says.

---

## 5. The playground (G1)

### 5.1 What the caller may say, and what they may not

```
POST /api/playground
{
  "resourceId": "res_…",  "environment": "dev",
  "subscriptionId": "sub_…" | null,   "keyKind": "primary" | "secondary",
  "gatewayLabel": "dev-1",
  "operationId": "getInventory",        // must exist in the revision converged in that environment
  "pathParams": { "petId": "1" },
  "query":   [ { "name": "status", "value": "available", "enabled": true } ],
  "headers": [ { "name": "Accept",  "value": "application/json", "enabled": true } ],
  "body": "…"
}
```

There is **no target URL field and no host field**. The control plane composes the target from
admin configuration and the published route:

| Kind | Composition `[P1-25]` |
|---|---|
| `rest` | gateway URL + `route.base_path` + the operation's template with `pathParams` substituted and each segment percent-encoded + enabled query rows, encoded |
| `soap` | gateway URL + `route.base_path`; the operation is carried by the envelope and `SOAPAction` |
| `mcp`, `a2a` | gateway URL + `route.base_path`; the operation is carried in the JSON-RPC body. Plus one fixed extra target for A2A: `GET <base_path>/.well-known/agent-card.json` |

Resolution reads the route row for `(resource, environment)`, the revision of the **converged**
release there, that revision's `model` for the operation set, and `policyFor` for the effective
policy — the same function the config builder uses, so the playground can never disagree with the
gateway about the key header `[P1-24]`. The config document is not rebuilt for a playground call.

- `operationId` must exist in that revision; the method comes from the operation, never from the
  request `[P1-04]`. An unknown operation is `400` naming it.
- No converged release in that environment is `409` — "this API is not published in TEST yet" — with
  the promotion screen named.
- **Published is not the same as served** `[P3-02]`. v3 omits a route from the config document when
  its effective policy document is invalid and records it in the target's health as `configErrors[]`.
  The playground applies the same check and refuses first — "this API is published but not currently
  served: <reason>", linking to the policy screen — rather than sending a request the gateway has
  never heard of and showing a `404` that reads as a platform fault.
- `gatewayLabel` omitted means the environment's first configured gateway, and the response says
  which was used `[P3-08]`.
- The composed URL passes `checkEgress` even though no part of it came from the caller: one line,
  and design §5.3 names it as what makes this endpoint safe.
- `route.host` is honoured by sending it as the `Host` header. Probed: Bun's `fetch` sends a
  caller-set `Host` verbatim `[P1-05]`.
- A route whose effective policy carries `passthrough.websocket` or `passthrough.sse` is listed and
  refused with the reason and a copyable `curl`/`websocat` line (§2).
- A route whose effective policy carries `ipAllow` is flagged **before** sending, naming the control
  plane's egress address, because otherwise the gateway's correct `403` reads as a platform bug
  `[P1-23]`.

### 5.2 The key never touches the browser

**When a subscription is required is decided by the route, not by who is asking** `[P2-02]`: a
subscription is required **exactly when the effective policy carries an `auth.subscriptionKey` unit**.
Without that unit the route accepts anonymous traffic, the call is sent without a key, and the console
says so plainly — a route that needs no key is worth seeing.

- `subscriptionId` must be **active**, in that environment, for an application whose team the caller
  is in — `can()` unchanged, checked against `application.team_id`. Anything else is `403`.
- The subscription's product must contain the resource, else `409` saying so — otherwise the gateway
  answers `403` and the reason looks like a platform fault.
- The key is decrypted per call, injected into the header or query parameter named by the effective
  `auth.subscriptionKey` unit (default header `X-Api-Key`), and never returned, logged or stored.
- `keyKind: "secondary"` on a subscription with no secondary key is `400` naming the rotate screen,
  never a silent fall back to the primary: "test the secondary before I rotate" is the only reason
  that control exists `[P3-01]`. `keyKind` is ignored when `subscriptionId` is null.
- Caller-supplied headers are filtered — `host`, `content-length`, `connection`,
  `transfer-encoding`, `upgrade`, hop-by-hop headers and the key header — and the response **names
  what was dropped** rather than dropping it silently.
- **The owner path**, on a key-protected route: owning the API is not being a caller, so the owner
  needs a subscription like anyone else. When the caller's teams hold none to a product containing
  this API in this environment, the console shows one control — "Subscribe an application to try
  this" — opening the subscribe wizard with the owning team preselected `[P1-10]`. It is the cheapest
  moment to teach the product/application model.
- Every call writes an `audit` row: actor, resource, environment, subscription, operation, gateway
  label, status, duration, bytes in and out. **Never a body, a header value or a query string** —
  `audit` is append-only and never pruned (design §4) `[P1-11]`.

**What comes back** `[P2-13]`: the response's status and status text, its headers, the elapsed time,
its body (or base64 with `responseEncoding`), the truncation flag, the names of the caller headers
that were dropped, and the path that was called. Never the injected key, and never the header set as
it was sent to the gateway — that set contains the key.

### 5.3 Limits, and what a call costs

| Bound | Value | Behaviour past it |
|---|---|---|
| `PLAYGROUND_MAX_BODY_BYTES` | 256 KiB | `413`; the editor says so before sending |
| `PLAYGROUND_TIMEOUT_MS` | 30 000 | recorded as an outcome on the history entry, not an error banner |
| `PLAYGROUND_MAX_RESPONSE_BYTES` | 512 KiB | body truncated, flagged in the response and the history |
| `PLAYGROUND_RATE_PER_MIN` | 60 per user | `429` with `Retry-After`, in memory on the control plane |
| `PLAYGROUND_HISTORY_PER_RESOURCE` | 25 per (user, resource) | oldest dropped on write |
| `PLAYGROUND_HISTORY_RETENTION_DAYS` | 7 | the hourly `prune` job deletes past it (§7.4) |
| `PLAYGROUND_HISTORY_BODY_BYTES` | 4 KiB | bounds the **stored** request body as well as the stored response preview; over it the entry is flagged and the load action warns that the body was shortened `[P3-03]` |

What we send and what we keep are different questions: the in-flight request cap stays 256 KiB, the
stored copy is 4 KiB.

`PLAYGROUND_RATE_PER_MIN` **protects the control plane, not the consumer's quota** `[P1-17]`. A
playground call is a real call: it consumes the subscription's rate limit and quota and appears in
telemetry attributed to that subscription. The UI states this beside the send button and shows the
quota remaining, because a consumer who exhausts their own quota from a test console and cannot see
why has been misled by us.

Redirects are never followed (`redirect: "manual"`), the response is returned verbatim, and a body
that is not valid UTF-8 comes back base64 rather than mangled.

### 5.4 Per variant

| Kind | What the console offers |
|---|---|
| `rest` | operation list, path parameters, query rows, header rows, and a body prefilled from the request schema — generated from `revision.model`, bounded to depth 8 and 64 nodes with cycles broken, so a recursive schema cannot hang the request `[P1-08]` |
| `soap` | operation list from the WSDL, a prefilled envelope, and `SOAPAction` set automatically and shown read-only — getting it wrong is design §5.1's routing bypass, not something to leave to typing |
| `mcp` | method list (`initialize`, `tools/list`, `tools/call:<tool>`), a JSON-RPC envelope prefilled from the tool's `inputSchema`, and the `Mcp-Session-Id` from the previous response carried forward |
| `a2a` | method list from the card, a prefilled `message/send`, and one click to fetch the agent card the gateway serves (rewritten to the gateway, which is the thing worth seeing) |

### 5.5 History

```
GET    /api/playground/history?resourceId=&limit=
DELETE /api/playground/history/:id
DELETE /api/playground/history?resourceId=
```

- Newest first, **per (user, resource) across environments**, each row carrying an environment chip —
  the same request against DEV and TEST is the comparison a user wants, so mixing them is right and
  labelling them is required `[P1-28]`.
- There is no replay endpoint: replay is the UI loading the entry into the form and the user pressing
  send, so a replay is an ordinary call with an ordinary audit row.
- An entry whose operation no longer exists in the current revision, or whose subscription has been
  revoked or deleted, stays listed with the load action **disabled and the reason shown** `[P1-22]`.
- De-duplication: a send identical to the newest entry replaces it rather than adding a row, so
  hammering send does not evict the history.

---

## 6. The dashboard (G2)

### 6.1 One endpoint, blocks per hat

```
GET /api/dashboard?environment=all|dev|test|prod&sinceMin=60|360|1440
```

`sinceMin`, because that is what `/api/telemetry/*` already takes — one vocabulary `[P1-14]`. It is
an integer between 1 and `TELEMETRY_RETENTION_HOURS × 60`; larger is `400` naming the ceiling, never
a silent clamp (design §11) `[P2-11]`.

```jsonc
{
  "generatedAt": "…", "environment": "all", "sinceMin": 1440,
  "trendAvailable": true,          // false when 2 x sinceMin exceeds retention — exactly when
                                   // `previous` is null. One meaning, one field  [P2-11]
  "hats": ["owner", "consumer"],   // what this user's data shows; navigation does NOT follow it
  "owner": {
    "apis": { "total": 12, "byLifecycle": {…}, "liveByEnvironment": {…} },
    "traffic": { "ok": 0, "gatewayRejections": 0, "upstreamErrors": 0, "errorRate": 0,
                 "p50": 0, "p95": 0, "series": [ … ], "previous": { … } | null },
    "topApis": [ … ],                    // ≤ 10, by call count
    "attention": [ … ], "attentionTruncated": 0   // ≤ 50
  },
  "consumer": {
    "applications": [ … ],
    "subscriptions": [ … ],              // ≤ 50, then a link to the full list
    "attention": [ … ], "attentionTruncated": 0
  },
  "platform": {
    "environments": [ { "environment": "dev", "instances": 2, "live": 2, "inSync": true,
                        "configDigest": "sha256:…", "activeTlsExceptions": 1,
                        "trustAnchors": 2, "expiringAnchors": 0, "configErrors": 0 } ],
    "attention": [ … ], "attentionTruncated": 0,   // the estate's own rows, same shape
    "admin": { "failedJobs": 0, "staleReleases": 0, "downgrades": 3 } | null
  },
  "startHere": [ … ] | null      // the empty-estate branch of the same evaluator  [P1-21]
}
```

- **Three numbers, never one** — v2's `[V1-25]` rule: `ok`, `gatewayRejections`, `upstreamErrors`,
  with `errorRate` defined beside them.
- **`previous` is null rather than wrong.** The trend needs twice the window in retention; when it is
  not there the field is null and the UI omits the delta and says why.
- **Every list is bounded** `[P1-13]`, with a truncation count and a link to the full screen.
- **Team scoping** is v2's rule unchanged: owner blocks cover resources whose `team_id` the caller is
  in; consumer blocks cover applications whose `team_id` the caller is in; an admin sees the estate
  and the UI labels it "all teams". The no-route `''` telemetry bucket stays admin-only.
- **`platform.admin` is null for non-admins**, so the block is absent rather than empty. Its
  `attention` rows are not admin-only, though: "the gateway serving my API refused its
  configuration" is an owner's question before it is an operator's, so the `gateway-*` codes are
  shown to everyone and only `job-failed` — which carries an internal message and needs an operator
  — is admin-only.
- **`startHere` is present exactly when the caller has no owned resource and no subscription** and
  carries the same row shape as `attention`, so one component renders both `[P1-21]`.
- **`hats` describes data, not navigation.** A team that owns nothing still sees "Publish APIs" in
  the nav, or it could never publish its first API `[P1-26]`.

### 6.2 Where each number comes from

| Block | Source | Note |
|---|---|---|
| traffic, series, top APIs, p50/p95 | `telemetry_rollup` | through the one function `/api/telemetry/*` already uses, so the two screens cannot disagree |
| quota used / resets | `usage_counter` + the effective `quota` unit | a subscription with no quota shows "no quota", never `0 / 0` |
| key age | `subscription.key_rotated_at ?? created_at` | |
| lifecycle, sunset | `resource` | a deprecated API a consumer subscribes to is their attention row |
| environments, digests, in-sync | `gateway_instance` + the target health summary | the same numbers `/api/targets/:env/health` returns |
| attention | `control-plane/src/attention.ts` | the one evaluator (§6.3), also called by `GET /api/resources/:id` |

### 6.3 Attention: one evaluator, one vocabulary

`shared/attention.ts` defines the closed code list and the row shape; `control-plane/src/attention.ts`
is the only place that decides whether a row applies `[P1-04]`. It is called by the dashboard and by
`GET /api/resources/:id`, which gains an `attention[]` block, so the API page's banner and the
dashboard's list are the same rows.

**It is a fixed set of SQL queries that return only candidate rows, never a load-everything loop**
`[P2-03]`: resources with no `route` / no `binding` / no converged release (anti-joins), releases in
`failed` or `stale`, resources whose effective document has no `auth.*` unit (an anti-join over
`policy_entry` plus the global tier), subscriptions past a quota fraction, instances stale or
activation-blocked, anchors and certificates inside their expiry window, jobs in `failed`. Each query
is `LIMIT`ed; the merged result is ordered by severity and truncated to the endpoint's bound. A team
with five hundred APIs costs the same shape of work as a team with five.

```ts
interface AttentionRow {
  code: AttentionCode;
  // A property of the CODE, from one map in `shared/attention.ts`, so one badge colour cannot mean
  // two things on two screens
  severity: "blocker" | "warning" | "info";
  subject: {
    // `certificate` and `anchor` are their own kinds rather than being folded into `environment`:
    // otherwise a row saying "something in DEV expires on Friday" cannot link to what expires.
    // `portal` is the subject of the three `start-here-*` rows, which are about no thing at all
    kind: "resource" | "subscription" | "environment" | "instance" | "job" | "certificate" | "anchor" | "portal";
    id: string;
    name: string;
  };
  environment?: string;   // absent when the fact is not per environment
  detail: string;      // one sentence, plain language, no jargon without a glossary term
  href: string;        // the screen that fixes it
}
```

A per-environment gap — `no-route`, `no-binding` — is reported **only for an environment the API
has begun to occupy**, meaning one where the other half of the pair or a release already exists.
Otherwise every new API would carry "no route in PROD" from the minute it was created, and a list
that is mostly noise is a list nobody reads.

`no-definition` · `no-route` · `no-binding` · `never-released` · `release-failed` · `release-stale` ·
`no-auth-policy` · `no-concurrency-ceiling` · `validation-downgraded` · `unreleased-revision` ·
`tls-exception-active` · `tls-exception-expiring` · `trust-anchor-expiring` · `certificate-expiring` ·
`quota-80` · `quota-exhausted` · `key-older-than-90-days` · `subscribed-api-deprecated` ·
`subscribed-api-retired` · `gateway-stale` · `gateway-activation-blocked` · `config-error` ·
`job-failed` · `start-here-subscribe` · `start-here-publish` · `start-here-operate`.

**`blocker` means the thing does not work**, not that we would like it tidied. The three
`start-here-*` codes are produced **only** into `startHere`, never into an `attention[]` block, so
"publish your first API" can never appear on a team that has fifty `[P2-09]`.

---

## 7. Revisions (G3)

### 7.1 The list

`GET /api/resources/:id/revisions?limit=&cursor=` — rev, digest, author, created, `frozen_at`,
`pruned_at`, original format, `source` and `source_detail` (§4, `[P2-05]`), artifact state (counts of
`ok` / `no-schema` / `unsupported-schema`), size of `original`, and **where it is released**: per
environment, `live` | `previously live` | `never`.

### 7.2 The diff

`GET /api/revisions/:id/diff?from=<revisionId|rev>` — structural, from the normalized model
(design §4.1), never a text diff of the upload:

```jsonc
{ "from": { "id": "rev_…", "rev": 6 }, "to": { "id": "rev_…", "rev": 7 },
  "summary": { "added": 1, "removed": 1, "changed": 3, "breaking": 2 },
  "operations": [
    { "operationId": "getOrderById", "change": "added" },
    { "operationId": "listOrders", "change": "removed", "breaking": true, "rule": "operation-removed" },
    { "operationId": "createOrder", "change": "changed", "breaking": true,
      "details": [ { "kind": "request-schema", "path": "/properties/customerRef",
                     "was": "optional", "now": "required", "rule": "required-added" } ] } ],
  "metadata": [ { "field": "title", "was": "Orders", "now": "Orders API" } ] }
```

- **Breaking is an enumerated list of rules, not a feeling**: an operation
  removed; a required request parameter or property added; a parameter or property type changed; an
  enum value removed from a request; a response property removed or retyped; a response status
  removed; for `soap` a body element or its type changed; for `mcp` a tool removed or its
  `inputSchema` tightened; for `a2a` a skill or method removed. Every flagged item carries the `rule`
  that fired, and the UI shows it — a classifier nobody can interrogate stops being trusted.
- Schemas are compared structurally over the resolved shape, bounded to depth 32 and 2 000 nodes;
  past that the operation reports `too-large-to-diff` rather than timing out.
- The diff is a pure function of two models, so it needs no storage.
- A tombstone has no model: a diff naming one says which side is pruned.

### 7.3 Correcting an unfrozen revision

`PUT /api/revisions/:id/spec` (design §14), `If-Match` on the revision's `version_digest`, `can()` on
the owning resource — the owning team or an admin, like every other write on a resource `[P2-08]`:

- Only while `frozen_at IS NULL`. A frozen revision answers `409`: "revision 7 was released to DEV on
  … and cannot change; create revision 8 instead", with that action attached.
- The replacement's `original_format` must belong to the resource's kind family (`rest`:
  swagger-2.0 / openapi-3.x; `soap`: wsdl-1.1; `mcp`: mcp-manifest; `a2a`: a2a-agent-card) — else
  `400` naming both, because a WSDL replacing an OpenAPI would leave routing, validation and the
  catalog describing a different shape of contract `[P1-16]`.
- Same normalizer, same egress check, same size cap; recompiles the artifact, re-indexes the catalog,
  sets `source = 'corrected'`, and writes an audit row naming the digest it replaced.
- The rev number does not change: this is a correction to a draft, not a new contract. An identical
  digest is a no-op `200`, matching v1's `[R2-01]`.

### 7.4 Retention

**Inside the existing `prune` job, not a new one** `[P2-04]`. `prune` already deletes by age
(telemetry, jobs, plans) under an hourly idempotency key, and design §10 lists revision pruning as
part of the same job. It gains two subjects — revisions and playground history — and its result line
enumerates what each removed. It reads `REVISION_KEEP_COUNT` (5) and `REVISION_KEEP_DAYS` (365).

**The bound is the tighter of the two** `[P1-27]`, as design §4.1 states it: a revision survives on
age only if it is *also* within the newest `REVISION_KEEP_COUNT`. On top of that, three exceptions
keep a revision at any age:

1. **currently released** to any environment (`release.state = 'converged'`);
2. the **previous released** revision per environment — the rollback target (§6);
3. referenced by a **release_plan younger than `JOB_RETENTION_HOURS`**, or by a release in `pending`
   or `converging`. A plan the prune job has already deleted protects nothing, and saying so is
   better than implying a guarantee the schedule removes `[P1-15]`.

Everything else is pruned: `model`, `original` and `index_json` are emptied and `pruned_at` is set;
the row stays. Then artifacts whose digest no **unpruned** revision references are deleted (D29,
`[P1-03]`), and `compileMissingArtifacts` skips tombstones so the backfill cannot try to compile a
revision whose model is gone. The reference query reads
`artifact_digest IS NOT NULL AND artifact_digest <> '' AND pruned_at IS NULL`: v3 writes `''`
deliberately for a revision that declares no schemas, and treating that sentinel as a reference would
keep a phantom for ever `[P2-12]`.

A pruned revision cannot be released (`409` naming the tombstone), cannot be diffed, and exports
nothing. The UI shows the row greyed: "content pruned on … · history kept". The job's result line
says what it removed, and the numbers appear on the admin dashboard.

---

## 8. The environment trust store (G4)

### 8.1 The API

```
GET    /api/trust/anchors?environment=dev          list, with days-until-expiry
POST   /api/trust/anchors/preview  { pem }         parse only — nothing is stored
POST   /api/trust/anchors          { environment, name, pem }
DELETE /api/trust/anchors/:id                      sets removed_at
POST   /api/trust/anchors/copy-from { fromEnvironment, environment, ids[] }
POST   /api/trust/exceptions/:id/check             would this backend verify without the exception?
```

Admin-only, all of them, like `tls_exception`: design §9's one carve-out is that turning off
verification is not a resource owner's decision, and deciding *whose* certificates verify is the same
decision from the other side.

Upload rules, each a refusal with the reason rather than a silent acceptance:

- parses as exactly one PEM certificate — a bundle is refused with "upload one certificate per
  anchor, so each can be removed on its own";
- `basicConstraints` says CA (`X509Certificate.ca`). Bun will happily use a leaf as an anchor, which
  is precisely why we refuse it: a leaf in a trust store trusts one host and hides that it did;
- not expired, `≤ 16 KiB`, and not the `MAX_TRUST_ANCHORS + 1`-th live anchor in that environment;
- no live anchor with the same thumbprint in that environment.

`preview` returns subject, issuer, validity, thumbprint, key algorithm, `ca`, and whether it is
self-signed, so an admin sees what they are about to trust before they trust it.

### 8.2 Distribution

The config document (wire v4) grows:

```ts
trustAnchors: Array<{ id: string; name: string; thumbprint: string; notAfter: string; pem: string }>
```

Inline, not on the artifact channel: a CA certificate is 1–2 KiB and sixteen are ~32 KiB. The
artifact channel exists because schemas reach megabytes (§8.7); using it here would buy
activation-gating complexity and a second failure mode for nothing.

Consequences, each tested:

- **Fail-static for free.** The cached config carries the anchors, so a gateway restarted during a
  control-plane outage still verifies the same backends.
- **Self-expiry, like a TLS exception.** `buildConfig` omits an anchor past `not_after`, and the
  gateway independently drops one whose `notAfter` has passed, so a stale config cannot keep an
  expired CA alive.
- **Removal takes effect at the next poll** — the same guarantee as revoking a subscription.
- An anchor expiring changes the config digest with nobody having acted; that is a config change
  like any other and the fleet converges on it.
- **Anchors are public certificates**, so they land in the existing fail-static config cache with no
  permission change. Design §8.7's encryption requirement is about `certs/`, which holds private key
  material; nothing here does `[P2-10]`.

### 8.3 The gateway side

`data-plane/src/trust.ts` composes the CA set once per config activation:

```
ca = [ ...tls.rootCertificates,        // the system store, unless TRUST_SYSTEM_ROOTS=0
       ...config.trustAnchors.filter(live).map(a => a.pem) ].join("\n")
```

**Setting `ca` replaces the default store rather than adding to it** — measured: with `ca` set to one
internal CA, `https://example.com` fails `unable to get local issuer certificate`. The system roots
are therefore unioned in explicitly, and `TRUST_SYSTEM_ROOTS=0` is available for an estate that wants
only its own PKI: a configured choice with a startup log line, not an accident.

`tlsOptionsFor` ([pipeline.ts:1752](../data-plane/src/pipeline.ts)) gains the set:

| Mode | `ca` applies | Why |
|---|---|---|
| `verify` (default) | ✔ | the point of G4 |
| `skip-hostname` | ✔ | only the name check is relaxed — the chain is still verified, so the anchor is what makes the exception work at all (tested) |
| `pin` | ✔ | attached, though `pin` also sets `rejectUnauthorized: false`, so the pin rather than the chain is what verifies. It is attached so that retiring the pin is one edit rather than a migration |
| `insecure` | — | nothing is verified; adding a CA would be theatre |

The set is attached only when the environment has at least one live anchor, so an estate with none
sends exactly what it sends today. It is one `ca` value: the anchors, the system roots and the client
identity's own chain, because setting `ca` replaces the store and anything left out is not trusted.

**What this costs, measured twice** `[P1-02]`: in isolation, `tls.ca` keeps Bun's connection pool — 1
handshake for 51 requests, 0.057 ms/request against 0.043 ms with no verification at all — while a
custom `checkServerIdentity` destroyed it (51 handshakes for 51 requests, 0.741 ms/request). Through
the gateway, the `trust-anchor` and `tls-exception-pin` perf scenarios land within a run's own drift
of each other **and of the plain-HTTP baseline**, so the handshake tax did not reproduce on the real
path. Both readings are published (§12), and the conclusion is narrower than draft 5's: the trust
store is affordable, and the argument for retiring a pin is **correctness, not speed** — a pin trusts
one certificate and breaks when the backend rotates it, an anchor trusts the issuer and keeps
verifying. That is what the Trust screen says.

A route that verifies against an anchor reports `backend_tls: verified` like any other. An anchor is
not an exception and is never counted as one.

### 8.4 Copy, expiry and visibility

- `copy-from` is the explicit act §6.3 uses for policy: a diff, a confirmation, an audit row. There
  is no automatic propagation along the chain.
- Expiry is surfaced three ways: a countdown on the Trust screen, a `trust-anchor-expiring` attention
  row at 30 days, and a line in `GET /api/governance/exceptions` — worded so that an anchor is not
  read as an exception: it is listed because its expiry breaks backends.
- The Trust screen is **three named sections, not one list** `[P1-12]`:
  **Certificate authorities we trust** (anchors — "backends whose certificate chains to one of these
  verify"), **Client identities we present** (`certificate` — "what the gateway shows a backend that
  asks for mTLS"), **Exceptions to verification** (`tls_exception` — "dated, admin-only, and each one
  is a request we are not verifying"). The register-a-CA wizard names which it is creating.
- The screen's reason to prefer an anchor over a pin is that an anchor survives a rotation and
  carries no expiry date somebody has to renew — not a speed claim (§8.3).
- **"Can this exception go now?" is a button, not a number** `[P3-04]`. Whether a backend's chain
  verifies through an anchor cannot be known without asking the backend, so the screen shows the
  honest fact — how many exceptions are active in that environment — and
  `POST /api/trust/exceptions/:id/check` performs a one-off, admin-only, egress-checked TLS probe of
  that backend with the environment's anchor set and reports whether it would verify without the
  exception. A computed claim or a button that goes and finds out; not a number we invented.

### 8.5 The control plane's own fetches

`trust-store.ts` assembles the union of live anchors across environments and passes it as `tls.ca` on
the control plane's outbound `fetch` calls: spec import, MCP/A2A discovery, the playground forward,
and any introspection or JWKS read made from here. The set is cached and rebuilt on write.

- **The union, not the per-environment set, and this is a widening** `[P1-18]`: a CA registered for
  PROD backends will also verify a DEV team's spec host. It is the right call — a CA is an issuer
  decision and the control plane has no environment of its own — and it is stated on the Trust screen
  and in the governance report rather than left to be discovered.
- Design §5.4's "never applies to the control plane" is about *exceptions* — pinning, skipping,
  insecure — and those remain unavailable here. Registering a CA is rung 1, which the design says
  should absorb most cases.

---

## 9. The UI (G5)

### 9.1 The two hats, and the shape that follows

Every user is an **owner** (their teams publish APIs), a **consumer** (their teams hold applications
and subscriptions), or both. v4 groups navigation by what a person came to do:

```
Integration Portal            ┌───────────────────────────────────────────────┐
  ▸ Home                      │  Team: Platform Team ▾        Environment: DEV │
  USE APIS                    ├───────────────────────────────────────────────┤
  ▸ Catalog                   │  Page title                                    │
  ▸ My subscriptions          │  One line saying what this screen is for.      │
  PUBLISH APIS                │                                                │
  ▸ My APIs                   │                                                │
  ▸ My products               │                                                │
  OPERATE            (admin)  │                                                │
  ▸ Gateways                  │                                                │
  ▸ Telemetry                 │                                                │
  ▸ Global policy             │                                                │
  ▸ Trust                     │                                                │
  ▸ Audit                     │                                                │
  ─────────────               │                                                │
  ? How this works            └───────────────────────────────────────────────┘
  Alice · admin · sign out
```

- **Sections follow capability, never inventory** `[P1-26]`: any team member sees "Publish APIs"
  whether or not that team owns anything yet, because otherwise nobody could publish a first API.
  `OPERATE` renders for admins; a non-admin who deep-links to `/trust` gets the screen with every
  control disabled and one line naming who can change it.
- **The team switcher is the context.** It decides which team a create action belongs to and what
  "mine" means. A user in one team sees a label, not a menu.
- **The environment switcher stays global** and gains the sentence that removes this model's most
  common confusion: "You are looking at DEV. Policies, routes, backends and subscriptions are set per
  environment. The API definition is not — it is promoted."

### 9.2 The six journeys

| Journey (G5) | Flow | Ends with |
|---|---|---|
| **publish** | wizard: 1 Definition (upload, URL, or discover MCP/A2A) → 2 Routing (host, base path, backend pool) → 3 Review | "petstore v1 is live in DEV at `http://…/petstore/v1`" + Try it · Add a policy · Add to a product · Promote to TEST |
| **promote** | wizard: 1 Revision and target → 2 The plan in words (creates / keeps / blockers / warnings) → 3 Confirm | "revision 7 is live in TEST" + Divergence · Promote to PROD |
| **version** | wizard: 1 Version identifier → 2 What to copy (policy, routes) → 3 Review | the new version's page, both base paths shown |
| **subscribe** | wizard: 1 Application (or create one) → 2 Environment → 3 Review terms | the key, once, with copy · a ready `curl` · Try it in the playground |
| **call** | the playground panel (§5) on the API page, in both owner and consumer mode | a response, and an entry in history |
| **operate** | the admin surfaces, each with its own guided act: attach a global policy unit, register a CA, mint or revoke a gateway instance, read the governance report | the change, plus what it will do at the next poll |

Each wizard validates every step against the same server rules that would reject it, so a wizard
never advances into a refusal.

**How "completable without documentation" is checked** `[P3-06]`, given that D30 rules out browser
automation — three things, and they are the definition of done for G5:

1. `demo.ps1` walks all six journeys through the API in the order the UI presents them, so the
   sequence itself is exercised and any step that cannot be reached from the previous one fails.
2. `ui/test` asserts, per journey, that the wizard's steps exist, that each step's primary control is
   enabled or disabled-with-a-reason for a fresh account, and that the completion panel names the
   next action.
3. The README carries the manual walkthrough checklist. Claiming more than this would be the same
   dishonesty D30 exists to avoid.

### 9.3 The API page

One page, two modes, one vocabulary — a consumer arriving from the Catalog gets the same chrome, so
the two never look like different products.

```
petstore  v1   [ Live in DEV · TEST ]  [ deprecated ]        Team: Platform   ⋯
Overview | Definition | Revisions | Routing | Policies | Publish | Subscribers | Try it | Listing
```

- **Overview** is new and is the default: what this API is, where it is live, which revision each
  environment runs, its attention rows from §6.3, and the three traffic numbers for the selected
  environment.
- **Revisions** is §7: the list, a compare control, the diff with the rule that fired shown beside
  each breaking change, downloads of `original` and the generated document, and edit-in-place for an
  unfrozen draft.
- **Publish** merges today's Publish and Promotion tabs: one chain view, one action per environment,
  the plan behind the promote button.
- **Try it** is §5, in both modes.
- Consumer mode: Overview · Operations · Getting started · Try it · Versions.

### 9.4 Rules the whole UI obeys, and how each is tested

| Rule | Test (`ui/test`) |
|---|---|
| Every screen has a title and a one-line purpose | a render test over every route asserts both |
| An action the caller cannot perform is **disabled with a reason**, never hidden | `capabilities.ts` maps `capabilities[] → { enabled, reason }`; a unit test covers every action for owner / other team / admin |
| Every domain term is a `<Term>` with a one-sentence definition | `glossary.test.ts` asserts the required vocabulary is defined and that every `<Term>` used in the views resolves |
| Every empty state names the next action | a render test over the list views with empty data asserts a link or button |
| Errors render inline with the remedy | the API's `problem+json` `detail` is shown beside the field; a test asserts the 409-naming-what-is-missing responses reach the form, not a toast |
| One status vocabulary | `status.ts` is the only producer of a chip label; a test asserts totality over `ReleaseState` × `Lifecycle` |
| Nothing destructive without a typed confirmation | delete flows require the object's name typed back |
| Keyboard and contrast basics | every interactive element is a real `button`/`a` with a visible focus ring; a test greps the views for `onClick` on a non-interactive element |

### 9.5 First run

`startHere` (§6.1) renders three paths on Home, each linking into the matching wizard: **I want to
call an API** → Catalog → subscribe → playground; **I want to publish an API** → the publish wizard;
**I run the platform** (admin) → gateways, trust, global policy.

**How this works** is one page — not a video tour (D30) — carrying the six journeys, the two-tier
model (contracts are promoted; policy, routes, backends and subscriptions are edited per
environment), and the glossary rendered from `glossary.ts`, so the page cannot drift from the
tooltips.

### 9.6 Visual system

No new dependencies (design §2). `styles.css` grows a token layer — colour, spacing, radius,
typography scale — a dark branded sidebar, restrained tables, one chip vocabulary, three button tiers
with red reserved for destructive, a wizard stepper, a right-hand drawer for detail panels, and
skeleton loaders instead of layout jumps. Charts stay inline SVG (v2's rule).

### 9.7 What happens to every view that exists today `[P1-20]`

| Today | v4 |
|---|---|
| `App.tsx` | rebuilt shell: team switcher, capability-based sections, environment line, `How this works` |
| `ApisView` | **My APIs** — grouped by family, per-environment state chips, publish wizard entry |
| `ApiDetailView` | the API page of §9.3; its Definition/Routing/Policies/Publish panels are kept and re-chromed, Versions folds into the header switcher, Promotion merges into Publish |
| `PromotionPanel` | absorbed into the Publish tab and the promote wizard |
| `PolicyEditor` | kept, plus the effective-document origin badges and the arithmetic notes |
| `CatalogView` (products, applications, subscriptions) | split: **My products** (owner) and **My subscriptions** (consumer). Applications live inside My subscriptions — "my app, its keys, what it can call" is one screen — and can be created inline from the subscribe wizard `[P3-05]` |
| `MarketView` / `MarketListing` | **Catalog** and the consumer-mode API page; subscribe becomes the wizard |
| `TelemetryView` | kept, reachable from the dashboard's numbers |
| `GatewayView` | kept under Operate, plus activation-blocked reasons |
| `GlobalPolicyView` | kept under Operate |
| `TrustView` | the three sections of §8.4 plus anchors |
| `AuditView` | kept under Operate, with a filter by subject |
| — | new: `HomeView`, `PlaygroundPanel`, `RevisionsPanel`, the wizard components |

---

## 10. Wire contract v4

`CONFIG_VERSION = 4`. A gateway speaking 3 is refused, keeps serving from its cache, and **says so** —
the part draft 1 left out `[P1-07]`:

```ts
interface GatewayConfig {
  …v3 fields…,
  /** G4: the environment's trust store, live anchors only, PEM inline (§8.2). */
  trustAnchors: Array<{ id: string; name: string; thumbprint: string; notAfter: string; pem: string }>;
}
```

- The control plane answers a mismatched `wireVersion` with `problem+json` carrying
  `expected` and `received`, as it does today.
- **The control plane records the block itself**, on the instance row, before it refuses. As built
  this replaces the draft's "the instance reports it on the next poll": every poll the old instance
  makes is refused, so a report that travels on the poll can never arrive. The instance also keeps
  its own copy — read from `expected`/`received` rather than from prose — and `/healthz` shows it.
- `activationBlocked` stays the string field v3 already has rather than becoming an object: the
  fleet view, `/healthz` and three existing tests read it as text, and the message names both
  versions, which is what the reason code would have been for.
- **It is testable because the poll client's wire version is an option** (`DpConfig.wireVersion`,
  defaulting to `CONFIG_VERSION`) `[P3-07]`; after the bump nothing in the tree would otherwise
  send a 3. The test drives both halves: the control plane refuses `wireVersion: 3` naming both
  versions and writes the reason down, and the instance given that refusal keeps serving and says
  why.
- The fleet view and the dashboard render it as `gateway-activation-blocked`, so an instance stuck on
  an old build is visible in one place rather than looking merely slow to converge. Without this, a
  mixed-version fleet silently keeps serving stale config — including without the trust anchors this
  release is about.

Nothing else on the wire changes: the playground is a control-plane concern, the dashboard reads
existing stores, and revisions never reached the gateway.

---

## 11. Configuration

New control-plane values (design §11: explicit, no fallback chains):

```
PLAYGROUND_MAX_BODY_BYTES=262144       PLAYGROUND_MAX_RESPONSE_BYTES=524288
PLAYGROUND_TIMEOUT_MS=30000            PLAYGROUND_RATE_PER_MIN=60
PLAYGROUND_HISTORY_PER_RESOURCE=25     PLAYGROUND_HISTORY_RETENTION_DAYS=7
PLAYGROUND_HISTORY_BODY_BYTES=4096
REVISION_KEEP_COUNT=5                  REVISION_KEEP_DAYS=365
MAX_TRUST_ANCHORS=16                   DASHBOARD_DEFAULT_SINCE_MIN=1440
```

New data-plane value:

```
TRUST_SYSTEM_ROOTS=1     # 0 trusts only the environment's registered anchors (§8.3)
```

`TARGETS_FILE` gains, per target, the gateway URLs the playground may use:

```jsonc
{ "environment": "dev", "adapter": "standalone", "enforce": true, "paused": false,
  "config": { "gatewayUrls": [ { "label": "dev-1", "url": "http://127.0.0.1:8081" },
                               { "label": "dev-2", "url": "http://127.0.0.1:8082" } ] } }
```

- Each URL is egress-checked **at boot**; a failure names the target and the rule, because a
  playground that can reach nothing should say so at startup, not at the first click.
- An environment with no `gatewayUrls` disables the playground there with exactly that sentence and
  names `TARGETS_FILE`. Absent, not broken.
- **`/api/meta`'s environment entries gain `gateways: [{ label, url }]`** so the console can offer the
  picker and a copyable `curl` `[P2-07]`. These are admin configuration, not secrets. The `curl`
  carries `-H "X-Api-Key: $KEY"` as a placeholder: the UI has no key and must not look as though it
  has one — a key comes from the reveal action, which is audited.
- In a real deployment this is the F5 vhost, not an instance. Two entries exist locally because
  design §5.7's `calls × instances` is worth being able to demonstrate by hand.

---

## 12. Testing

| File | Covers |
|---|---|
| `test/x509.ts` (extended) | `basicConstraints`, `keyUsage` and `subjectAltName`, so a fixture CA parses with `ca = true` and a fixture server certificate completes a Bun TLS handshake `[P1-01]` |
| `playground.test.ts` | composition per kind from route + operation (never a caller URL); another team's subscription is `403`; a product that does not contain the resource is `409`; a route with a converged release but a `configError` refuses before sending `[P3-02]`; `keyKind: "secondary"` with no secondary key is `400` `[P3-01]`; a route with no `auth.subscriptionKey` is callable with no subscription `[P2-02]`; the key appears in no response, history row or audit detail; the header name comes from the effective policy; blocked headers are dropped **and named**; in-flight and stored body caps differ `[P3-03]`; a timeout is an outcome; non-UTF-8 comes back base64; `Host` reaches the gateway for a host-bound route; history cap, de-duplication, retention, per-user isolation, environment chips; an orphaned operation and a revoked subscription disable load with a reason; a `passthrough` route is refused with the reason; an `ipAllow` route is flagged before sending; SOAP envelope and `SOAPAction` prefill; MCP session carry-forward; an omitted `gatewayLabel` uses the first and says so |
| `dashboard.test.ts` | numbers equal the telemetry endpoints for the same window; `previous` is null when retention cannot cover it; every list is bounded and reports truncation; team scoping for both hats; `platform.admin` absent for non-admins; `startHere` exactly for an empty estate and in the same row shape; every attention code renders a valid href; quota shows "no quota" rather than 0/0 |
| `revisions.test.ts` | list shows released-where per environment; the diff classifies every enumerated breaking rule and names it; a reformatted document diffs as no change; the size bound reports `too-large-to-diff`; `PUT …/spec` works unfrozen, `409`s frozen, refuses a foreign format, no-ops on an identical digest, recompiles the artifact and re-indexes; retention applies the **tighter-of** bound and all three exceptions, tombstones the rest, drops only unreferenced artifacts, and leaves the backfill job alone; a pruned revision cannot be released or diffed |
| `trust-anchors.test.ts` | a backend signed by a fixture CA fails; the anchor is registered; within one poll the same call succeeds — end to end, gateway included; a leaf, an expired certificate, a bundle, an oversize PEM and the 17th anchor are each refused with their reason; a removed anchor can be registered again `[P1-06]`; TEST is unaffected until `copy-from`; removal takes effect at the next poll; an anchor past `not_after` is dropped by the gateway even from fail-static config; the composed CA set contains the system roots (asserted against `tls.rootCertificates`, not by calling the internet); `pin` and `skip-hostname` still chain-verify through an anchor; `POST /api/trust/exceptions/:id/check` reports "would verify" once the anchor is registered and "would not" before `[P3-04]`; the control plane imports a spec from a TLS host signed by an anchor — with the test's own integrations config allowing `https` on `127.0.0.1`, which the sample file does not `[P2-14]` |
| `ui/test/*` | `attention` ordering and copy; `capabilities` for owner / other team / admin; glossary coverage; `status` totality; every route renders a title and purpose; empty states carry an action; no `onClick` on a non-interactive element `[P1-19]`; per journey, the wizard's steps exist, each step's primary control is enabled or disabled-with-reason for a fresh account, and the completion panel names the next action `[P3-06]` |
| `migration.test.ts` (extended) | a real v3 database upgrades to v4 with every row intact; `pruned_at` is NULL everywhere; the config document gains `trustAnchors: []`; a wire-3 instance is refused and reports `activationBlocked` |
| `perf` matrix | two scenarios added: `trust-anchor` (verify with an anchor set) and `tls-exception-pin` (the `checkServerIdentity` path), same backend and same policy, so the pair is published rather than asserted — including when it says the two are indistinguishable, which is what it said `[P1-02]`. They need a TLS backend, so `tools/backend` gains `--tls`: a certificate generated from the extended `test/x509.ts`, its CA PEM written where a harness or a person can register it `[P2-06]` |

Existing suites keep passing unchanged. `demo.ps1` grows a v4 act: register a CA, publish, promote,
subscribe, call it from the playground, and read the call back out of telemetry and history.

`bun test` becomes two invocations — the root suite and the `ui` suite — wired into one script.

---

## 13. Delivery order

Each step leaves the tree green, and none begins before G0 is met.

| Step | Ships | Done when |
|---|---|---|
| 1 | `schema-004.sql`, config plumbing, `CONFIG_VERSION` 4 + the mismatch report, `shared/attention.ts`, `test/x509.ts` extensions | a v3 database upgrades; a wire-3 instance reports `activationBlocked`; existing suites pass |
| 2 | G4 control plane: `trust_anchor` CRUD, preview, copy-from, config document, CP outbound trust | `trust-anchors.test.ts` minus the gateway half |
| 3 | G4 gateway: `data-plane/src/trust.ts`, `tlsOptionsFor`, self-expiry, `tools/backend --tls`, the two perf scenarios | `trust-anchors.test.ts` whole; the perf report carries both numbers |
| 4 | G3: revision list and provenance, `shared/diff.ts`, the diff endpoint, `PUT …/spec`, retention inside `prune` | `revisions.test.ts` |
| 5 | G1: `playground.ts`, endpoints, history, audit, limits | `playground.test.ts` |
| 6 | G2: `control-plane/src/attention.ts`, `dashboard.ts`, the endpoint, `attention[]` on the resource | `dashboard.test.ts` |
| 7 | G5 foundation: tokens and components, glossary, status, capabilities, attention rendering, the shell and navigation, `ui/test` wiring | the `ui` suite runs and its foundation half passes |
| 8 | G5 screens: Home, Catalog, My subscriptions, My APIs, My products, the API page and its tabs, Playground, Revisions, Trust, the four wizards | the `ui` suite whole; the six journeys walked by hand |
| 9 | `demo.ps1` v4 act, README, a full `bun test` (both suites) and `bun run perf --profile=quick` | green, and the demo re-runnable |

---

## 14. Risks

| Risk | Mitigation |
|---|---|
| `ca` replaces the system trust store rather than extending it, so registering an internal CA breaks every public-CA backend | Measured, and the union with `tls.rootCertificates` is explicit in §8.3; a test asserts the composed set contains the system roots; `TRUST_SYSTEM_ROOTS=0` is the only way to lose them |
| The plan claims a performance benefit for anchors that the real path does not deliver | Both scenarios ship (§12) and the report prints the delta it measured rather than the one draft 5 predicted; §8.3 records that the handshake tax did not reproduce through the gateway, and the Trust screen argues correctness instead |
| The playground becomes an SSRF surface | The caller names no host: the target is composed from `TARGETS_FILE` and the route, egress-checked anyway, redirects unfollowed, every call audited |
| Playground history accumulates personal data | Capped preview, 7-day retention, per-user scope, deletable by its owner, pruned by the existing job; never in audit |
| A mixed-version fleet silently serves stale config | §10: the refusal is reported, surfaced as `gateway-activation-blocked`, and visible on the dashboard |
| Dashboard numbers quietly disagree with the telemetry screen | One aggregation function serves both, asserted equal |
| The diff calls something breaking that is not, and people stop trusting it | The rules are enumerated in §7.2, tested one by one, and the UI names the rule that fired |
| Retention deletes something that was needed | The tighter-of bound plus three exceptions, a tombstone rather than a row delete, artifacts dropped only at zero references, and a job result line that says what went |
| A UI rebuild breaks flows v3 shipped | The API surface changes only by addition; the rebuild is view-layer; §9.7 accounts for every existing view; the `ui` suite plus the demo walk every journey |
| G5 is unbounded | §9.4's rules are the definition of done, each with a test. Anything beyond them is a later plan |
