# Review log — MVP implementation plan

Goal 0: review the plan before implementing, fix everything found, and repeat until a round
finds nothing. Each finding names what is wrong, why it matters, and the resolution that was
written back into [`mvp-plan.md`](mvp-plan.md).

---

## Round 1 — 26 findings against draft 1

### Blocking — the plan as written would ship a defect

**R1-01 · SSRF through `POST /api/resources/:id/revisions { specUrl }`.**
The plan applies the §5.3 egress allowlist to `binding` writes but not to the server-side
fetch of a spec URL, which is the same vector with a friendlier name: any user could make the
control plane fetch `http://169.254.169.254/…` or an internal admin endpoint and read the
response back as a "spec".
*Resolution*: the same allowlist and deny-CIDR check gates `specUrl`; `redirect: "manual"`;
`MAX_SPEC_BYTES = 5 MiB` enforced while reading; and, per §5.3, `$ref` values that are remote
or `file://` are rejected at upload so a self-contained document stays self-contained.

**R1-02 · ReDoS through `preconditions[].requireHeader.pattern`.**
§5.6 says regexes are RE2 and therefore cannot backtrack. Bun has no RE2; JS `RegExp` does
backtrack, and the value being tested is caller-controlled, so a published pattern such as
`(a+)+$` turns a header into a CPU denial of service against the data plane — worse under D1
than under Go, because one event loop serves every request.
*Resolution*: recorded as deviation **D8** with three concrete mitigations, all at write time
or bounded at request time: a pattern linter rejecting nested quantifiers, backreferences and
lookaround; `pattern.length ≤ 200`; and the tested header value truncated to 1 KiB before
matching (a longer value is a deny, not a match attempt).

**R1-03 · A revoked gateway-instance token does not fail closed.**
§8.5 says "a revoked subscription key **or instance token** stops working at the next poll",
but the plan's data plane treats every failed poll identically and keeps serving from the
fail-static cache — so revoking an instance changes nothing.
*Resolution*: `401`/`403` from the config poll is decommissioning, not an outage. The instance
drops its route table, answers every proxy request with `503` and a distinct problem type, and
logs loudly. Network errors and 5xx keep the fail-static behaviour unchanged.

**R1-04 · `rateLimit` has no key when no subscription exists.**
`by: "subscription"` is the only allowed value, but `auth.subscriptionKey` is an independent
unit, so a route can carry a rate limit and no authentication. The plan left the counter key
undefined for that case.
*Resolution*: a cross-unit write-time constraint — `rateLimit` requires `auth.subscriptionKey`
on the same route. §5 already says cross-unit constraints are checked when the document is
assembled; this is one of them, and it is rejected with a message naming both units.

**R1-05 · The backend URL join and the base-path match were unspecified.**
"Strip the base path and proxy" hides two bugs: `/petstoreXYZ` matching base path `/petstore`,
and `https://host/v2` + `/pet/1` joining to `https://host/pet/1` if `URL` resolution is used
naively.
*Resolution*: written into the plan as exact rules. Match iff `path === basePath ||
path.startsWith(basePath + "/")`. Join by string concatenation of
`backend.pathname.replace(/\/$/, "")` + the rewritten path (always starts with `/`) + the
original query, never `new URL(path, base)`.

**R1-06 · A route base path can shadow the data plane's own endpoints.**
A publisher who sets base path `/healthz` takes over the liveness endpoint the demo and the
tests depend on.
*Resolution*: `/healthz` and `/readyz` are reserved on the data plane and rejected at
route-write time on the control plane.

**R1-07 · The fleet view would report the wrong digest.**
The plan inferred an instance's digest from its `If-None-Match`, which is the digest it is
*asking about*, not necessarily the one it has activated.
*Resolution*: every poll carries `X-Instance-Digest: <active digest>`; the control plane
records that plus `last_seen_at` on both `200` and `304`, which is what
`/api/targets/:env/health` reports. Consistent with §8.7's "reports the *active* config".

**R1-08 · Nothing enforced one live release per resource and environment.**
Two `converged` releases for the same (resource, environment) would put two entries for one
route in the config document, and the winner would be list order.
*Resolution*: `CREATE UNIQUE INDEX ON release(resource_id, environment) WHERE
state = 'converged'`, plus the supersede step already in the release job.

### Correctness and specification gaps

**R1-09 · Rate-limit counting semantics were ambiguous** (count every request, or only
admitted ones?), which changes what `X-RateLimit-Remaining` means.
*Resolution*: every request reaching step 6 increments; reject when the post-increment count
exceeds `calls`; `Remaining = max(0, calls - count)`; `Reset` is the window end in epoch
seconds; `Retry-After = max(1, ceil(windowEnd - now))`.

**R1-10 · The 401/403 boundary was implied, not stated.**
*Resolution*: unknown, absent or revoked key → `401` (revoked keys leave the config document,
so they are indistinguishable from unknown — which is the correct outcome and matches §12's
"revoked subscription gets 401"). A valid key whose product does not contain this resource →
`403`. A precondition denial → the rule's `deny.status`, default `403`.

**R1-11 · A redundant environment check.** The config document is built per environment and
carries only that environment's subscriptions, so the data plane's "environment matches"
comparison can never fail.
*Resolution*: removed from the pipeline; the property is structural and asserted by a
control-plane test instead.

**R1-12 · `rewrite` was half-specified.** `path` templates and `copyUnmatchedParams` were in
the unit but had no defined interaction with the (absent) per-operation matching, so they
could only be implemented as guesswork.
*Resolution*: the MVP `rewrite` unit is `{ stripBasePath?: boolean }` and nothing else. Path
templating arrives with per-operation policy, which needs the operation matcher.

**R1-13 · Base-path normalisation was undefined.**
*Resolution*: must start with `/`, no trailing slash except the single-character root `/`,
no query or fragment, max 128 chars, matched case-sensitively; host is matched
case-insensitively with the port stripped, and `*` matches any host.

**R1-14 · `X-Forwarded-For` handling could be spoofed.** The plan said "set XFF" without
saying what happens to an inbound one when there is no trusted proxy.
*Resolution*: with `TRUSTED_PROXY_CIDRS` empty (the MVP default), an inbound `X-Forwarded-For`
is **replaced**, never appended to, and the inbound `Host` is never forwarded.

**R1-15 · `requireHeader.equals` compared with `===`.** §5.6 explicitly calls out that the
current estate's `!=` on a header is timing-variable.
*Resolution*: `crypto.timingSafeEqual` over equal-length buffers, with a length check first.

**R1-16 · `deny.body` had no content-type rule.**
*Resolution*: object → `application/json`; string → `text/plain; charset=utf-8`; absent →
`application/problem+json` built from `status` and `reason`. `deny.headers` are applied last
and cannot overwrite the status.

**R1-17 · §7's "one lease per target" was dropped silently.** The MVP runs one process, so it
is not load-bearing today, but the rule is cheap and its absence is a trap for the second
process.
*Resolution*: `target.lease_holder` and `target.lease_expires_at`, taken and released in a
transaction by the job runner.

**R1-18 · The UI cannot render the "× instances" rate-limit arithmetic** (§5.7) without
knowing the fleet size, and there was no endpoint for environments or policy-unit metadata.
*Resolution*: `GET /api/meta` returns environments, kinds, the policy-unit catalogue and the
live instance count; `INSTANCE_STALE_AFTER_SEC` (default 30) decides who counts.

**R1-19 · Revealing a subscription key was a `GET`.** A secret in a URL-addressable,
cacheable, history-recorded verb, and exempt from the CSRF `Origin` check.
*Resolution*: `POST /api/subscriptions/:id/reveal`, team-gated, `Origin`-checked, audited,
`Cache-Control: no-store`.

**R1-20 · The `Origin` check breaks the Vite dev server.** The SPA on `:5173` proxying to
`:8080` sends `Origin: http://localhost:5173`, which does not match `PUBLIC_URL`.
*Resolution*: the accepted-origin list is `PUBLIC_URL` plus `UI_DEV_ORIGIN`, and the latter is
honoured only when `DEV_AUTH=1`.

**R1-21 · Publishing an API with no authentication unit is silently legal.** Correct per §5
(a unit's presence is the policy), but a publisher can ship an open route by omission.
*Resolution*: the release response carries `warnings[]`, the first of which is "no
authentication policy attached"; the UI shows it on the publish screen and on the API page.
Enforcement stays out — that would be a governance policy the design does not have.

**R1-22 · Fail-static outlives revocation.** During a control-plane outage a revoked
subscription keeps working, because the data plane keeps its last-good config.
*Resolution*: not a defect — it is §8.5's stated trade ("config staleness never fails closed").
Written into the plan and the README as accepted behaviour so it is not mistaken for a bug,
and paired with R1-03, where the *instance's own* revocation does fail closed.

**R1-23 · The demo script was not re-runnable** (unique route constraint) and assumed both
processes were up.
*Resolution*: it preflights `/healthz` on both planes with an actionable message, and starts
by deleting any previous demo objects by name.

**R1-24 · `GET /api/resources/:id` would inline every revision's `model`.** Petstore's model is
tens of kilobytes per revision.
*Resolution*: revision metadata only (id, rev, digest, format, frozen, author, timestamp);
the document is fetched from `GET /api/revisions/:id/spec`.

**R1-25 · Subscribing to another team's product needs an approval** (§9) which is out of
scope, so the MVP would let a consumer self-approve.
*Resolution*: recorded as deviation **D9** — any team may subscribe to any product without
approval in the MVP; the `approval` table and the second-person rule land with the approvals
feature.

**R1-26 · Test gaps.** No test covered: updating an API and re-publishing (G2's "update"),
instance-token revocation (R1-03), `specUrl` SSRF rejection (R1-01), pattern-lint rejection
(R1-02), or that a precondition denial still consumes rate-limit budget.
*Resolution*: all five added to §11 of the plan.

---

## Round 2 — 7 findings against draft 2

**R2-01 · `POST /api/resources/:id/revisions` needs an explicit idempotency rule.** Uploading
the same document twice yields the same `version_digest`; creating a second identical revision
is noise, and the plan did not say which happens.
*Resolution*: if the newest revision has the same `version_digest`, return `200` with that
revision instead of creating one; a genuinely new digest creates rev n+1. This also makes the
demo re-runnable.

**R2-02 · Withdraw and delete leave `applied` rows keyed by `(target_id, resource_id)` but the
plan never said the release job is the only writer.** Two paths (`DELETE …/releases` and
`DELETE /api/resources/:id`) mutating the same projection invite divergence.
*Resolution*: both enqueue the same `reconcile` job kind with `intent: "remove"`; the job is
the only writer of `applied` and `release.state`. The API layer only enqueues.

**R2-03 · Deleting a resource that is still in a product leaves `subscription` rows pointing
at a product whose member list shrank.** Legal, but the consumer's `curl` then gets a bare
`404` with no explanation.
*Resolution*: kept (it is the correct data-model outcome), but the `404` problem document
carries `"detail": "no published route matches this host and path"`, and the UI's product page
shows subscriptions whose product has no published members.

**R2-04 · `GET /api/gateway/config` returns `200` with an empty route list before anything is
published, which is indistinguishable from a misconfigured environment.** Not wrong, but the
data plane should say so.
*Resolution*: `/healthz` on the data plane reports `routes: 0` and the demo's preflight prints
it; no behavioural change.

**R2-05 · The job runner's failure path was unspecified.** A `reconcile` job that throws would
leave `release.state = 'converging'` forever.
*Resolution*: three attempts with backoff, then `release.state = 'failed'` with the reason,
surfaced by `GET /api/resources/:id/releases` and on the publish screen.

**R2-06 · Nothing said what happens to in-flight requests when the route table swaps.**
*Resolution*: the route table is an immutable object replaced by assignment; a request that
started under the old table finishes under it. Stated so it is not re-derived later.

**R2-07 · `POST /api/subscriptions` returns the key once, but a failed HTTP response after the
row is committed loses it irrecoverably.** With `reveal` (R1-19) this is survivable, so it is
only a UX note — recorded so the reveal endpoint is not later removed as redundant.
*Resolution*: no change; noted in the plan next to the reveal endpoint.

---

## Round 3 — no findings

Re-read draft 3 against the five goals, the §5.2 pipeline order, the §8.5 config contract, the
§9 authorization rules, and the deviation list. Checked specifically that every Round 1 and
Round 2 resolution is present in the plan text, that no out-of-scope item is stubbed in a way
that could read as implemented, and that each of G1–G5 maps to at least one test and one
manual `curl`. Nothing further found. **Implementation may start.**

---

## Round 4 — seven findings from building it

Written back into the plan, so the plan still describes what exists.

**I1 · `PORT` collides across the two processes.** Both are started from the repository root and
Bun loads one `.env.local`, so a single `PORT` would send both to the same port.
*Resolution*: the data plane reads `DP_PORT` (default 8081). Plan §10 updated.

**I2 · The body cap missed chunked requests — found by a test that failed.** The plan's step 3
checked `Content-Length` only, so a request with no declared length bypassed `MAX_BODY_BYTES`
entirely. Design §5.1 says the cap is checked at header time *and* enforced while streaming.
*Resolution*: the request body is piped through a counting transform that errors past the cap,
and the proxy failure path distinguishes it, so the answer is `413` and not a misleading `502`.
Both paths are now tested.

**I3 · The fleet view lags one poll.** An instance reports the digest it has *activated*
(`X-Instance-Digest`), so the control plane learns about a new config on the poll *after* the
one that delivered it. This is design §8.7's intent, not a defect — but it means "in sync" is
never instantaneous, a test asserted it too eagerly at first, and the demo and the UI must wait
rather than check once.
*Resolution*: behaviour kept, stated in the plan, the UI and the fleet card; the demo polls
`/api/targets/dev/health` until `inSync`.

**I4 · Upstream `Content-Encoding` and `Content-Length` must be stripped from the response.**
Bun decodes a gzipped upstream body transparently, so forwarding the upstream's framing headers
would hand the client bytes that contradict them.
*Resolution*: both headers are dropped on the response side and `Accept-Encoding` is not
forwarded upstream; the gateway re-frames the response itself.

**I5 · `scripts/demo.sh` dropped.** The plan promised a bash twin of the PowerShell demo. This
machine has no `jq` and only a WSL bash, so it could not be exercised, and an untested script in
the repository is worse than none.
*Resolution*: the PowerShell demo is the tested one; the README carries a shell-agnostic
copy-paste `curl` walkthrough that covers the same four status codes. Plan §11 amended.

**I6 · A test fixture was wrong, not the code.** `a{2,` is a *valid* JavaScript regex — Annex B
treats an unmatched brace as a literal — so the "does not compile" case never fired.
*Resolution*: the fixture is an unterminated group instead. Worth recording because the linter
looked broken for a minute when it was not.

**I7 · YAML specs are not accepted.** The plan said "Swagger 2.0 and OpenAPI 3.x" without saying
in which serialisation; the `yaml` dependency is out of the MVP.
*Resolution*: JSON only, with an error that says so and names the workaround rather than
mis-parsing. Recorded as deviation **D10**.

### Verified after implementation

`bun test` — 83 tests, all passing. `scripts/demo.ps1` against the real
`petstore.swagger.io` — every asserted status code (401, 401, 403, 200, 200/200/200/429/429, 404
after withdraw, 200 after republish) observed. The UI walked in a browser: sign-in, API list,
definition import, the policy editor writing a real change (audited as `policy.set`), the fleet
card reporting `in sync`, and a subscription key revealed with its `curl` line.
