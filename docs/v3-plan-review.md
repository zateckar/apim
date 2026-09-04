# v3 plan review

Goal 0: review the plan before implementing, address every issue, and repeat until a round finds
nothing. Five rounds ran. Round 1 was self-review during drafting and its findings are folded into
draft 1; rounds 2–4 changed the plan and are recorded here with the change they caused; round 5
found nothing.

Findings are `[Rn-nn]` and appear inline in [`v3-plan.md`](v3-plan.md) at the paragraph they
changed. A finding is **closed** only when the plan says something different, not when the
objection is merely noted.

| Round | Findings | Blocking | Outcome |
|---|---|---|---|
| 1 | 22 | 22 | folded into draft 1 |
| 2 | 40 | 34 | draft 2 |
| 3 | 15 | 13 | draft 3 |
| 4 | 6 | 4 | draft 4 |
| 5 | 0 | — | plan accepted |

---

## Round 1 — drafting

Twenty-two findings, all closed in draft 1. Recorded briefly because the plan refers to them.

| # | Finding | Resolution |
|---|---|---|
| R1-01 | "Blocking by default" is meaningless if the default is *no unit attached* and no unit means no validation. Every other unit's absence means "off"; this one cannot | `validate` is the one unit whose absence means "at the defaults". Stated in §6.2 and shown in the policy editor |
| R1-02 | `rateLimit`/`quota` require an authenticated subscription; with several `auth.*` units it is no longer obvious which satisfies that | Only `auth.subscriptionKey` resolves to a subscription, so the constraint names it explicitly |
| R1-03 | Blocking validation buffers, so a burst of large bodies is an unbounded memory ceiling | `BLOCKING_BUFFER_BUDGET_BYTES`, shed with 503 at the ceiling, its own counter |
| R1-04 | A failed *response* validation is not the caller's fault; `400` would blame the wrong party | `502`, shaped by `errorFormat` |
| R1-05 | Per-operation units as a nested object inside the route document breaks per-unit storage, promotion and the global merge | The unit key is the string `operations["<id>"].<unit>`; storage, merge and divergence need no special case |
| R1-06 | Sampling with `blocking` makes the same payload succeed or fail by luck | A `sample` block with both directions blocking is a schema error |
| R1-07 | A release plan that ignores globals can be valid on paper and invalid in the fleet | The plan's merged document is validated as the **effective** document |
| R1-08 | A global `errorFormat` is wrong for at least one variant by construction | `errorFormat` is not globally attachable |
| R1-09 | Shipping every shared secret to every gateway in plaintext is a bigger blast radius than the feature is worth | Hashes where a hash suffices; plaintext only where the gateway must present the secret to a backend |
| R1-10 | "Validate the effective document of every resource on a global write" may be too slow to do synchronously | Measured against the scale this runs at (hundreds of resources, one query and one pass); exact rather than advisory |
| R1-11 | `retries` on a request whose body has already been streamed cannot work, and a setting that silently does nothing is worse than no setting | Retries apply with no body or a buffered body; otherwise only connection establishment. Stated beside the field |
| R1-12 | `attempts` × `timeoutMs` multiplies the worst case a caller waits | The timeout is the whole-request budget; each attempt gets what remains |
| R1-13 | A JSON-RPC error is a `200` at the HTTP level; counting it as `upstream-error` would make every "no" from a tool look like a gateway fault | Outcome `rpc-error`, separate |
| R1-14 | A document that declares no schemas cannot be validated, and failing closed would make "blocking by default" unusable on real specs | `schemaState: "no-schema"` per operation, passed through, reported in governance |
| R1-15 | An operation whose schema uses an unimplemented keyword is silently unvalidated | `schemaState: "unsupported-schema"`, listed beside downgrades |
| R1-16 | An A2A card served with the origin's `url` sends every consumer straight past the gateway | The card is rewritten: `url` points at the route, `securitySchemes` describe the gateway's |
| R1-17 | Requiring a key to read an agent card breaks discovery; serving it always is an open endpoint | Public when the resource is `listed`, key-protected when `unlisted` |
| R1-18 | User text reaching an FTS5 `MATCH` is a query-syntax injection | Terms are escaped and rebuilt as a quoted-plus-prefix query |
| R1-19 | Unbounded quota entries on the poll turn a 2-second poll into a large payload | `MAX_QUOTA_ENTRIES`, and bounded by the subscriptions the config already carries |
| R1-20 | A per-operation override that *loosens* the route's protection is a bypass wearing a policy's clothes | Overrides are additional checks; both counters are enforced (revised again in R2-04) |
| R1-21 | The boot self-test cannot check a config that has not arrived yet | The check runs at **activation** and refuses to activate, keeping the previous config |
| R1-22 | Turning validation on by default changes the behaviour of every existing test fixture | Accepted deliberately; fixtures declare what they send |

---

## Round 2 — 40 findings against draft 1

### Blocking

**[R2-01] The concurrency slot is released when the response headers arrive, but blocking
response validation holds the whole body after that.** v2 releases the bulkhead in `finally`
immediately after `await fetch`, which was right when the body streamed straight through. Buffering
a response for validation moves the memory to a place nothing bounds.
→ The slot is held until the response body has been buffered when `validate.response` is
`blocking`, and the buffer is charged against `BLOCKING_BUFFER_BUDGET_BYTES` like the request
buffer. Over budget: the response is **not** validated and the request fails `502` with outcome
`validate-budget`, because passing an unvalidated response through a route configured to block
would be the one thing the setting exists to prevent.

**[R2-02] `validate.always` cannot be a per-operation override.** The body cap and the
content-type allowlist are enforced at step 3, before the operation is known at step 11.
→ `always` is route-level only. A per-operation `validate` may set `request`, `response`,
`sample`, `headers`, `body` and `logEvents`; an `always` block inside an operation override is a
schema error naming this reason.

**[R2-03] MCP and A2A must buffer the body to resolve the operation, whatever the validation
state.** Operation resolution for a single-endpoint RPC protocol reads `method` out of the body.
→ Stated as inherent: `mcp` and `a2a` routes always buffer up to `always.maxBodyBytes` at step 11,
even with `validate.request: "disabled"`, and the ceiling defaults lower for them (256 KiB) because
a JSON-RPC call is not an upload.

**[R2-04] Per-operation `auth.*` overrides have no coherent meaning at step 11.** Route auth has
already run at step 6. An override that *replaces* the route's unit either re-runs authentication
against a different header (having already accepted one) or silently loosens it.
→ `auth.*` is removed from the overridable set. Per-operation authorization is expressed where the
design already puts it: `auth.jwt.scopeMap`, keyed by operation, evaluated at step 11. The
overridable set is `validate`, `rateLimit`, `quota`, `timeoutMs`, `cache`. R1-20's "may only lower
`calls`" schema rule is dropped with it: both the route counter and the operation counter are
enforced, so the stricter binds by arithmetic rather than by a rule.

**[R2-05] The cache key is ambiguous once `rewrite` exists.** Keying on the rewritten path makes
two different inbound paths share an entry when a rewrite collapses them.
→ Key = `routeId | method | inbound path | query | vary values | (subscription id when
`varyBySubscription`)`. The inbound path is what the caller asked for and the rewrite is a pure
function of it.

**[R2-06] CORS headers on rejections.** A `401` without `Access-Control-Allow-Origin` reaches a
browser as an opaque CORS failure, so the consumer sees "CORS error" instead of "your key is
wrong".
→ CORS response headers are added to **every** response the gateway writes, including its own
rejections — the same rule the lifecycle headers already follow.

**[R2-07] `errorFormat: "jsonrpc"` needs an `id` that may not exist yet.** A rejection at step 3 or
6 happens before the body is parsed.
→ `id` is the request's when the body has already been parsed, `null` otherwise. Stated in §9.3.

**[R2-08] The global tier was defined by exclusion, which fails open for every unit added later.**
A global `passthrough.websocket` would turn the estate into a passthrough.
→ Replaced by an explicit allowlist: `auth.subscriptionKey`, `auth.basic`, `auth.jwt`,
`auth.introspection`, `auth.mtls`, `ipAllow`, `cors`, `preconditions`, `rateLimit`, `quota`,
`timeoutMs`, `retries`, `circuitBreaker`, `concurrency`, `headers.request`, `headers.response`,
`validate`. Everything else — `errorFormat`, `rewrite`, `transform`, `cache`, `passthrough`,
`backendAuth`, `operations[…]` — is per-API by nature and rejected on a global write with a message
saying which.

**[R2-09] A plan digest that ignores globals lets an approved plan apply under different rules.**
→ `planDigest()` includes a digest of the target environment's global document. Editing a global
unit therefore makes every open plan stale, which is the honest reading of §6.3.

**[R2-10] The FTS projection has no defined write points, so it will silently rot.**
→ Rebuilt on: resource create, patch and delete; revision create; release reaching `converged`;
product membership change; and at boot when `resource_fts` is empty while `resource` is not.

**[R2-11] The catalog would list things nobody can call.**
→ A listing appears when it has at least one `converged` release in any environment, or the caller
`can()` see it — the latter badged "not published". `unlisted` is excluded for everyone else.

**[R2-13] Serving the A2A card before authentication adds an unauthenticated endpoint.**
→ It runs after steps 1–5, so `ipAllow` and CORS still apply, and it reads only config. Stated.

**[R2-15] Certificates are keyed by id, so a rotation is invisible to the activation gate.**
→ The cache key is `<id>-<thumbprint>` and the config carries the thumbprint, so a rotated
certificate is a new cache entry and activation waits for it exactly like an artifact.

**[R2-16] Three ceilings now shed 503 and one outcome cannot explain which.**
→ Distinct outcomes: `route-saturated`, `instance-saturated`, `validate-budget`, `pool-open`,
`upgrade-saturated`.

**[R2-17] The global document validated standalone fails a constraint only a resource can
satisfy.** A global `rateLimit` with the auth unit attached per resource is legitimate.
→ `validateDocument(doc, { tier: "global" })` relaxes the cross-unit constraints a resource may
satisfy; the per-resource effective validation is the real gate, and it already runs on both
writes.

**[R2-18] Warning-mode response validation tees a body of unknown size.**
→ The response tee is bounded by `always.maxBodyBytes`; past it the sample is dropped and counted,
which is what `onSaturated` already means for the pool.

**[R2-19] `transform.response` and response validation are listed as one step with no order.**
Validating after a transform would validate something the contract never described.
→ Response validation runs **before** the response transform. The declared schema describes what
the backend sends, not what we hand on.

**[R2-23] `ipAllow` and `${client.ip}` read the socket peer, which is the proxy.** Behind F5 every
request appears to come from the proxy, so an allowlist either admits everyone or nobody.
→ Step 2 resolves an **effective client IP**: the socket peer when the peer is untrusted, else the
rightmost untrusted address in `X-Forwarded-For`. `ipAllow`, `${client.ip}`, telemetry and the
access log all read that one value.

**[R2-24] Header and query validation must not reject undeclared names.** Every request carries
`User-Agent`, `Accept` and a dozen others no spec declares.
→ Only declared parameters are checked, for presence when `required` and against their schema when
present. Undeclared headers and query parameters are allowed. Stated, because the opposite reading
would break every real request.

**[R2-27] The operation index has no bound.**
→ `MAX_OPERATIONS_PER_ROUTE = 1000`, enforced at import with a message; the index carries id,
method, template, element/selector and a schema-state flag only.

**[R2-31] Any instance could fetch any artifact.** Schemas are not secrets, but unbounded is
unbounded.
→ The artifact endpoint checks the digest is referenced by a converged release in **that
instance's** environment.

**[R2-32] The certificate endpoint returns private keys.**
→ Scoped to certificates referenced by a `binding.clientCertRef` in the instance's environment, and
audited on every read.

**[R2-33] Twenty-four units × bespoke forms is a UI project, not a feature.**
→ The policy editor renders every unit from `UNIT_CATALOGUE`: title, description, default, and a
JSON editor validated against the same validator the API uses. Eight units that people actually
tune — `auth.subscriptionKey`, `rateLimit`, `quota`, `validate`, `cors`, `retries`,
`circuitBreaker`, `passthrough` — get real controls on top.

**[R2-37] The outcome vocabulary is fixed on both planes and is about to be short.**
→ Added: `validation-rejected`, `validation-unavailable`, `validate-budget`, `quota-exceeded`,
`pool-open`, `rpc-error`, `cache-hit`, `upgrade-rejected`, `upgrade-saturated`, `stream-closed`.

**[R2-38] `GET /api/subscriptions/:id/usage` is named in §14 and missing from the plan.**
→ Added: quota consumed, window reset, recent rate-limit rejections, from the aggregate.

**[R2-40] `discoverUrl` is a server-side fetch of an owner-supplied URL.**
→ Same treatment as `specUrl`: `checkEgress`, no redirects, bounded by `MAX_SPEC_BYTES`, 20-second
timeout.

### Non-blocking, recorded

- **[R2-12]** Subscriber count is defined as distinct applications with an active subscription to
  any product containing the resource.
- **[R2-14]** `Mcp-Session-Id` and `MCP-Protocol-Version` need no allowlist — the proxy already
  copies every non-hop-by-hop header both ways. The plan's claim about a "response allowlist" was
  wrong and is removed.
- **[R2-20]** `backendAuth` invalidation on 401/403 does not retry. Invalidate, return the
  backend's answer; the next request gets a fresh token.
- **[R2-21]** PFX upload needs a PKCS#12 parser. **D24**: PEM only, and the UI says so.
- **[R2-22]** Bun's `fetch` owns its connection pool and it cannot be force-recycled, so a changed
  or expired TLS exception binds on the next new connection rather than immediately. **D25**, with
  the window stated (one idle timeout).
- **[R2-25]** Response header validation applies only where the contract declares response headers.
- **[R2-26]** Pipeline numbering matches §5.2's 24 steps.
- **[R2-28]** Path-template matching: static segments beat parameters, longer templates beat
  shorter, and the match yields `${path.<param>}`.
- **[R2-29]** Quota windows are fixed and aligned to `periodSec` from the UNIX epoch.
- **[R2-30]** `stack.ps1` and `demo.ps1` grow the MCP and A2A processes.
- **[R2-34]** An operation with no request schema passes blocking validation. It cannot do
  otherwise; governance is the compensating control.
- **[R2-35]** The agent card is served under the route's base path only, and the catalog shows the
  exact URL.
- **[R2-36]** `ConfigRoute.backend` changes shape; `CONFIG_VERSION` 3 covers it.
- **[R2-39]** `sort=popular` = subscriber count, then requests in the retained telemetry window.

---

## Round 3 — 15 findings against draft 2

### Blocking

**[R3-01] Artifacts compiled "at release" leave every already-released revision unvalidatable.**
Attaching `validate` to a live API does not create a release, so nothing would ever compile its
schemas — and every revision released before v3 has none.
→ Artifacts are compiled **when the revision is created**, and `release` only references what the
revision already has. A `compile-artifacts` job, enqueued once by migration 3 and idempotent per
revision, backfills every existing revision. This is also cheaper: compilation happens once per
contract rather than once per environment it reaches.

**[R3-02] `revision_artifact` is a reference-count table with nothing to count.** Revision pruning
is out of scope, so no artifact is ever dropped.
→ Dropped from the schema. `revision.artifact_digest` is the reference, and the count is
`SELECT COUNT(*) FROM revision WHERE artifact_digest = ?` on the day pruning arrives.

**[R3-03] The quota aggregate cannot be a query per poll.** Four instances × a 2-second poll ×
active subscriptions is a steady read and write load against the single SQLite writer that §13
warns about.
→ The aggregate lives in memory in the control plane, is answered from memory on the poll, and is
flushed to `usage_counter` in one batched transaction every `USAGE_FLUSH_INTERVAL_SEC` — the same
shape as `TelemetryAggregator`, which already exists and already solved this.

**[R3-04] `server.upgrade()` has to be called from Bun's `fetch` handler, and the pipeline is a
deep async call that returns a `Response`.**
→ The pipeline gains one outcome besides a `Response`: `{ upgrade: true, context }`. The top-level
handler calls `server.upgrade(req, { data: context })` and only then returns. Steps 1–14 run first,
so a rejected upgrade never becomes a 101. If Bun turns out to refuse an upgrade after an `await`,
the fallback is to resolve the route and the subscription synchronously from the in-memory table —
which is all steps 1–10 actually need — and that is noted as the contingency rather than
discovered during implementation.

**[R3-05] Revocation must close open WebSocket and SSE connections, and nothing tracks them.**
→ A stream registry keyed by subscription id, with the connection's close function. The config
poll diffs active subscriptions and closes what is gone (WS 1008, SSE end), which is §5.8's "the
only place a config update reaches backwards into in-flight work".

**[R3-06] `PolicyDocument` is a closed interface and per-operation keys are dynamic.**
→ It gains an index signature for `operations["…"].…` keys, typed as the union of the five
overridable unit value types. The closed list stays closed for route-level units.

**[R3-07] A validation rejection body can be enormous.** A 10,000-element array failing per element
produces 10,000 errors.
→ At most 20 errors are reported, with a `truncated` count, and the validator stops collecting at
that point rather than collecting and slicing.

**[R3-08] `readIntegrations` accepts anything for the four new maps.** §11 says a wrong value is a
startup failure that names the variable.
→ Each map is validated at boot: issuers need a `jwksUrl` or an `introspectionUrl` and an
`algorithms` allowlist; token providers need a `tokenUrl` and a `credentialRef`; hmac schemes need
both refs; every referenced `credentialRef` must resolve. A dangling reference is a boot failure
naming both the ref and where it is used.

**[R3-09] Two ceilings called `maxConcurrentConnections` and `MAX_CONCURRENT_UPGRADES`.**
→ Kept as two, because they bound different things (a route and an instance), with distinct
outcomes `upgrade-rejected` and `upgrade-saturated` — the same shape as `concurrency` versus
`MAX_CONCURRENT_REQUESTS`, which v2 already established.

**[R3-10] `divergence` says nothing about the global tier, so an API can look aligned across
environments while the environments differ.**
→ Divergence keeps reporting resource units only — that is what it is — and the global policy
screen gains a side-by-side view of every environment's global document, which is the same question
at the tier where it belongs.

**[R3-11] The response cache is not invalidated when the config changes.** A new revision or a new
backend must not keep serving the old body.
→ The cache is keyed under the active config digest, so activating a config empties it by
construction. No invalidation logic, which is the same trick §8.7 uses for artifacts.

**[R3-12] `cors` at step 5 short-circuits `OPTIONS` even for routes with no `cors` unit.**
→ The short-circuit happens only when a `cors` unit is attached. Without one, `OPTIONS` is an
ordinary request and goes to the backend, which may well handle it.

**[R3-13] `quota.emitHeaders` has no defined headers.** The design defines `X-RateLimit-*` for rate
limiting and nothing for quota.
→ `X-Quota-Limit`, `X-Quota-Remaining`, `X-Quota-Reset`, recorded as an extension rather than
implied.

### Non-blocking

- **[R3-14]** `auth.jwt.scopeMap` keys accept both an operation id and the design's
  `"GET /orders"` form; the second is resolved against the operation's method and template.
- **[R3-15]** The `always.contentType` allowlist applies only when a request actually has a body,
  so a `GET` is never `415`.

---

## Round 4 — 6 findings against draft 3

**[R4-01] `validate` is globally attachable, so an admin can downgrade the whole estate in one
write and the per-API governance report would show nothing.**
→ `GET /api/validation/downgrades` reports the **effective** state per route with an `origin` of
`resource` or `global`, and a global downgrade is listed once at the top with the count of routes
it covers. An audit row records it as `policy.global.set` with the old and new state.

**[R4-02] Nothing says what happens when a route's effective document is invalid at config-build
time.** It can happen: a global unit is attached, then a resource's own unit is deleted.
→ It cannot happen through the API, because both writes validate the effective document. If it
happens anyway — a restored backup, a hand-edited database — `buildRoutes` **omits that route** and
records it in the target's health as `configErrors[]`. Omitting is the safe direction: an API that
does not answer is visible; an API answering under a document nobody validated is not.

**[R4-03] The artifact endpoint's scope check ("referenced by a converged release in this
environment") makes prefetch fail for a config the instance is about to activate.** The release is
converged by then, so the ordering works — but only because reconcile marks the release converged
before the config is built. That is an accident of the current order, not a stated rule.
→ Stated as a rule with a test: an artifact is fetchable exactly when it is referenced by the
config the instance's environment currently renders. The check is written against
`buildConfig`'s own artifact set, not re-derived from `release`.

**[R4-04] `MAX_BODY_BYTES` is per instance and `always.maxBodyBytes` is per route, and the plan
says "the tighter" without saying which error.**
→ The route value is the one reported (`413` naming the route's limit) when it is the binding one;
the instance value is reported when it is. Both are `413` with outcome `body-too-large`, and the
detail names which ceiling bound.

### Non-blocking

- **[R4-05]** An MCP client must tolerate a non-200 HTTP status carrying a JSON-RPC error body.
  The specification allows it and the gateway needs the status for the edge; noted in §9.3 rather
  than changed.
- **[R4-06]** `tools/backend` needs an `--instance` flag so a pool of three has three
  distinguishable members; already in the plan's §3, restated in the test plan.

---

## Round 5 — clean

Re-read draft 4 end to end against: the seven goals; §§4, 4.1, 4.4, 5, 5.1–5.8, 6.1–6.4, 8.1,
8.4, 8.5, 8.7, 9, 10, 11, 13, 14 of the design; the v1 and v2 deviation lists; and the shipped
code's own invariants (per-unit policy storage, the promotion gate's "at some point", the
bidirectional poll, fail-static, per-instance counters, the closed variant set).

No finding. The plan is accepted for implementation in the twelve steps of §16.

Two things are deliberately left as risks rather than resolved on paper, because they can only be
settled by running code, and both have a stated contingency:

1. **`server.upgrade()` after an `await`** — R3-04's contingency is a synchronous fast path.
2. **Bun's `fetch` connection pool and TLS options** — D25 states the window; if measurement shows
   a longer one, the mitigation is a per-backend `Connection: close` while an exception is active,
   which costs keep-alive only on the exceptional path.
