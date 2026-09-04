# Review log — MVP v2 implementation plan

Goal 0: review the plan before implementing, fix everything found, and repeat until a round
finds nothing. Each finding names what is wrong, why it matters, and the resolution written back
into [`v2-plan.md`](v2-plan.md).

The v1 log is [`mvp-plan-review.md`](mvp-plan-review.md); its findings R1-01…R2-07 and I1…I7 all
still stand and are not re-litigated here.

---

## Round 1 — 30 findings against draft 1

### Blocking — the plan as written would ship a defect

**V1-01 · The telemetry flush double-counts every re-sent report.**
§10 says two incompatible things: the report is cleared only for the windows named in
`acceptedWindows`, so a lost *response* means the instance re-sends; and the flush upsert is
`count = count + excluded.count`. Together they inflate every counter by one report per lost
response — and a lost response is the normal outcome of a control-plane restart, which is
exactly when someone will be looking at the dashboard.
*Resolution*: the report is **absolute per `(window, series)`, never a delta**, and the flush
**replaces** rather than adds (`count = excluded.count`, `duration_ms_max = excluded…`, buckets
replaced). A resend is then idempotent by construction, a partially delivered report
self-corrects on the next poll, and the control plane's in-memory aggregate replaces per key too.
Two supporting rules make this sound:
- a request is counted **in the minute it completed**, so a closed window can never reopen
  (a request that starts at 10:04:59 and ends at 10:05:29 counts in 10:05);
- the instance clears a window only when it is both **closed** and acknowledged, so the current
  partial minute is always re-sent and always replaced.

**V1-02 · The `resource` table rebuild would delete every revision, policy, route and release in
the database.**
Three facts compose into data loss. `openDb` sets `PRAGMA foreign_keys = ON`. The migration
runner wraps each migration in `db.transaction()`, and **SQLite silently ignores
`PRAGMA foreign_keys` inside a transaction** — so the `PRAGMA foreign_keys=off` written into
`002_v2.sql` is a no-op. And with foreign keys on, `DROP TABLE resource` deletes its rows first,
cascading through `revision`, `policy_entry`, `route`, `binding`, `release`, `applied` and
`product_member`, all of which declare `ON DELETE CASCADE`. The upgrade would appear to succeed
and leave an empty estate.
*Resolution*: the migration runner grows one flag — `{ version, name, file, foreignKeysOff:
true }` — and for such a migration sets the pragma **before** `BEGIN`, runs
`PRAGMA foreign_key_check` before `COMMIT`, and restores the pragma after. The plan now spells
out the 12-step procedure in that order, and a test upgrades a *seeded v1 database* and asserts
every child row survives with its parent. This is the one migration that can destroy data, so it
gets its own test rather than being covered by "migrations run".

**V1-03 · Nothing said who writes the seeded policy rows, or when.**
The §6.3 merge creates `policy_entry` rows in the target environment. If the API writes them when
the release is requested, a release that then fails leaves policy behind that nobody asked for; if
the job writes them, they arrive with the release. The plan described the merge and never named
the writer — the same class of gap as v1's R2-02.
*Resolution*: the **reconcile job** writes them, inside the same transaction that moves
`release.state`, after the plan digest check. The API layer only computes and persists plans and
enqueues. A failed or `stale` release therefore changes no policy at all.

**V1-04 · `plan_digest` had no defined input, so "refuse if the digest moved" was undefined.**
*Resolution*: `plan_digest = sha256(canonical({ resourceId, revisionId, from, to, create[],
keep[], localOnly[], blockers[] }))` — the decided content of the plan and nothing volatile
(`computedAt`, `computedBy` and the human-readable warnings are excluded). A policy edit in
either environment, a route or binding change, or a different revision therefore moves it; a
second dry run at a later second does not.

**V1-05 · `lifecycle` is one column on `resource`, so the plan's own example is not
implementable.** §8 promised a screen reading "v1 deprecated in prod, v2 active everywhere", but
§4.2 puts `lifecycle` and `sunset_at` on the resource, global across environments. Only `policy`,
`route`, `binding` and `subscription` are per environment (§6.1).
*Resolution*: lifecycle is a property of a **version**, global across the chain. G2's acceptance
criterion and the UI table are corrected to "v1 deprecated (everywhere), v2 active", and the plan
states why per-environment lifecycle is not free: it would add a fifth per-environment tier that
§6.1 does not have.

**V1-06 · `retired` cannot block new subscriptions as written, because subscriptions are to
products.** §4.2's rule is written for an API; the subscription unit is a `product` that may
contain several APIs and several versions. "Refuse if the resource is retired" has no hook.
*Resolution*: the rule is defined at the product: `POST /api/subscriptions` refuses with `409`
when `product.lifecycle = 'retired'`, or when the product has **no non-retired member with a
converged release in that environment** (naming the product and the environment). When some
members are retired it succeeds and the response carries a warning naming them, which the UI
shows. Existing subscriptions are never affected — that is the half of §4.2 that matters.

**V1-07 · The plan reinvents a migration framework that already exists.** `db.ts` already runs
numbered migrations tracked in `schema_version`, with `schema.sql` registered as version 1.
Draft 1 proposed a new `migrate.ts` and renaming the file to `001_baseline.sql`, which is churn
that also risks a fresh database disagreeing with an upgraded one about what version 1 was.
*Resolution*: keep `db.ts` and `schema.sql` exactly as they are; add
`{ version: 2, name: "v2", file: "schema-002.sql", foreignKeysOff: true }` to `MIGRATIONS`. The
only change to the runner is V1-02's flag.

### Correctness and specification gaps

**V1-08 · The fleet view still lags one poll, and the plan does not say so.** v1 recorded this as
`[I3]` and the demo and the UI were built around it. With the report moving into the request body
the lag is unchanged — an instance reports the digest it has *activated*, so the control plane
learns about a new config on the poll *after* the one that delivered it.
*Resolution*: restated in the plan beside the poll contract, and the promotion UI waits rather
than checking once. Also stated: `unchanged: false` responses are not proof of activation, so
`applied` and `gateway_instance.config_digest` remain different facts.

**V1-09 · The poll request body is unbounded.** 2000 series × 15 buckets is roughly 400 KB every
two seconds per instance, and a control-plane outage multiplies it by the number of held windows.
*Resolution*: `TELEMETRY_MAX_WINDOWS_PER_REPORT = 15` with the oldest dropped and counted in a
`droppedWindows` field; `MAX_REPORT_BYTES = 1 MiB` enforced by the control plane with `413`; and
an instance that receives `413` halves the number of windows it sends and logs it. Backpressure
with a defined direction, rather than a size that happens to work.

**V1-10 · An empty `soapAction` is legal in WSDL 1.1, so "a missing SOAPAction is a rejection" is
wrong.** Bindings routinely declare `soapAction=""`, and SOAP 1.2 has no `SOAPAction` header at
all — the action is an optional parameter of the content type.
*Resolution*: the rule is **agreement**, not presence. Resolve the operation from the body's
first `Body` child; the declared action must equal that operation's binding action, where absent
and `""` are the same thing. A body element that resolves to no operation in the model is the
same rejection. One outcome value, `soap-mismatch`, with the log detail distinguishing the two
cases.

**V1-11 · The prefix scan's interaction with the body cap and the streamed proxy was
unspecified** — the two features both want to be the first reader of `req.body`.
*Resolution*: order is fixed: the counting cap transform wraps `req.body` first, so the cap and
`bytesIn` cover every byte; the scan pulls at most `xml.maxPrefixBytes` from the *capped* stream
into a buffer; the upstream body is a new stream that enqueues the buffer and then pipes the
remainder, with `duplex: "half"`. A large envelope therefore still streams.

**V1-12 · `--token` on the command line puts a long-lived credential in the process table.**
Four gateways each needing a different token was the reason, but argv is world-readable on the
machine and lands in shell history.
*Resolution*: per-instance env files — `bun --env-file=.data/env/dev-1 run data-plane/src/server.ts`
— plus `GATEWAY_TOKEN_FILE` for a path-based secret. `--port` and `--name` stay as flags
because neither is a secret; `--token` is dropped. `seed` writes one env file per instance with
restrictive intent and `.gitignore` covers `.data/`.

**V1-13 · `errorFormat` cannot have a measurable cost against a baseline that never rejects.**
It was listed in the per-policy cost group beside `auth` and `ratelimit`, where it would report
noise as a result.
*Resolution*: moved into the rejection group, measured as `reject-429` in `problem+json` versus
`soap-fault` — which is where the difference exists.

**V1-14 · The 30-second latency scenario races the default 30-second `timeoutMs`.** A backend
that answers at exactly the ceiling produces a coin-flip between `200` and `504`, and a flaky row
in a performance report is worse than a missing one.
*Resolution*: the latency scenarios set `timeoutMs` explicitly — `latency-30s` runs with
`timeoutMs = 60000` and asserts `200`, and a separate `timeout-edge` scenario runs a 30 s backend
against `timeoutMs = 5000` and asserts `504` for every request. The edge is tested deliberately
instead of being tripped over.

**V1-15 · The performance guardrail would collide with the running stack.** Fixed ports 8080 /
8081 / 9080 are exactly what a developer has running while they work.
*Resolution*: the guardrail builds its world the way v1's helpers do — a temp SQLite file, the
control plane and the backend on ephemeral ports, the data plane as an in-process `DataPlane` —
and never reads `.env.local`.

**V1-16 · Nothing could reconcile telemetry against the gateway's own view.** "Telemetry counts
equal requests served" was a stated test with no second source to compare against.
*Resolution*: the data plane's `/healthz` reports `requestsTotal` and `telemetry: { series,
droppedSeries, droppedWindows, pendingWindows }`, so the test compares three numbers — client
requests sent, gateway `requestsTotal`, control-plane `sum(count)` — and the report shows the
drop counters rather than assuming they are zero.

**V1-17 · The plan asserted header formats without naming a specification, and applied them only
to successful responses.** `Deprecation: true` is the pre-RFC draft form; RFC 9745 defines the
field as a date, which we cannot emit because we do not record when a version was deprecated.
*Resolution*: `Sunset` follows RFC 8594 (IMF-fixdate) from `sunset_at`; `Deprecation: true`
follows the earlier draft and is recorded as deviation **D17** with that reason. Both are set on
**every** response for a deprecated route, including gateway rejections — a consumer being rate
limited still needs to know the version is going away.

**V1-18 · The shared type changes were not listed**, so they would be discovered one type error at
a time: `RESOURCE_KINDS` gains `soap`, `ReleaseState` gains `stale`, `OriginalFormat` gains
`wsdl-1.1`, `ApiModel` gains `soap`, `ApiOperation` gains `soapAction` / `inputElement` /
`outputElement`, and `PolicyUnitKey` gains `errorFormat`.
*Resolution*: listed as a single step at the head of the build order, because both planes and the
UI compile against them.

**V1-19 · A rollback silently re-runs the merge from the predecessor's *current* policy.**
Rolling PROD back to revision 6 is legal by the "at some point" clause, but §6.3's merge then
seeds PROD with whatever TEST holds *today*, which is not what was live when revision 6 was.
*Resolution*: behaviour kept — it follows from §6.3 and the alternative is snapshotting policy
per release, which the design deliberately does not do — but the plan is now explicit, the
dry-run plan labels the release as a rollback, and the UI states which units the rollback will
create and from where. Visibility, not prevention, matching §6.4's stance.

**V1-20 · `copy-from` appeared in the API surface and was never specified.**
*Resolution*: `POST /api/resources/:id/policy/copy-from { fromEnvironment, environment, units[] }`
overwrites **only** the named units, requires a non-empty unit list, returns the before/after
diff, sets `origin='local'` on everything it writes (it is an explicit act, not a seeding), and
is audited. Without a unit list it is a `400`, because "copy everything" is how an environment
gets silently flattened.

**V1-21 · `api_version` was an unconstrained string used to build a base path.**
*Resolution*: `^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$`, and the base path is still a separate,
explicitly written field — the version only *prefills* it. Two versions may not differ by case
alone, because base paths are matched case-sensitively and hosts are not.

**V1-22 · `job` and `release_plan` rows grow without bound.** v1 already accumulates jobs; v2 adds
an hourly prune job and a plan per dry run, which makes it worse.
*Resolution*: the `prune` job (renamed from `telemetry.prune`, since it now has three subjects)
deletes telemetry past the retention window, `job` rows in a terminal state older than
`JOB_RETENTION_HOURS` (168), and `release_plan` rows older than that which no `release`
references. `audit` is never pruned — dropping its triggers is out of scope (§4).

**V1-23 · A decommissioned instance's telemetry was unspecified.** It cannot report, because its
token is rejected before the body is read.
*Resolution*: it stops reporting; its buffer keeps accumulating to the bound and then drops with
the counter; its already-flushed rows stay for the retention window and the fleet view marks it
`revoked`. Stated so the gap in a chart is explainable.

**V1-24 · Divergence had no defined answer for the first link of the chain.**
*Resolution*: DEV has no predecessor, so every unit classifies as **local addition** and the view
says "no predecessor" rather than showing an empty diff.

**V1-25 · "Error rate" mixed two different failures.** A `429` from the gateway and a `500` from
the backend are both non-`ok`, and collapsing them hides which one is happening.
*Resolution*: every telemetry surface reports three numbers — `ok`, `gatewayRejections` (any
outcome that never reached the backend) and `upstreamErrors` (a 4xx or 5xx the backend produced)
— and `errorRate = 1 - ok/total` is defined in the plan and labelled in the UI.

**V1-26 · `bytesIn` on a rejected request was ambiguous.** A `401` never reads the body.
*Resolution*: `bytesIn` counts bytes actually read from the client, so a rejection before the
proxy step reports 0. Stated, because "requests × average size" would otherwise not reconcile.

**V1-27 · The demo would delete the wrong things and no longer touches the real petstore.**
Deleting previous demo objects "by name" now matches every version of the API, and draft 1 moved
every scenario to the local backend, which quietly drops v1's proof that a real remote spec import
and a real TLS backend work.
*Resolution*: the demo deletes by `(name, apiVersion)`; step 1 still imports the spec from
`https://petstore.swagger.io/v2/swagger.json` and one DEV route still binds to the real backend,
while every other route and every test and load scenario uses the local one.

### Editorial

**V1-28 · The layout section contained an unresolved note to self** — `shared/promotion.ts` with
the parenthetical "both planes? no: CP only".
*Resolution*: promotion lives entirely in `control-plane/src/promotion.ts`; nothing about it is
shared with the data plane, which never learns that environments have an order.

**V1-29 · A stray non-ASCII fragment in §14** ("for the imported petstore spec to be真").
*Resolution*: fixed.

**V1-30 · `telemetry_rollup.environment` is derivable from `instance_id`.** Storing it is
denormalisation, which is fine, but unexplained denormalisation invites someone to "fix" it.
*Resolution*: kept, with the reason written down — every dashboard query filters by environment
first, and the alternative is a join to `gateway_instance` and `target` on every read. The
control plane writes it from the instance's target, never from the report.

---

## Round 2 — 9 findings against draft 2

**V2-01 · Replace-semantics telemetry breaks when an instance restarts inside a minute.**
V1-01's fix makes the flush replace per `(instance, window, series)`. A gateway that restarts at
10:05:30 starts a fresh in-memory map, and its first report for window 10:05 carries only the
counts since restart — which *replaces* the pre-restart counts for that minute. The window loses
traffic, silently, and restarts are common (a config change does not restart, but a deploy does).
*Resolution*: the instance identity for telemetry is `(instance_id, run_id)`, where `run_id` is a
per-process random id reported in `instance.startedAt`'s company. It becomes part of the rollup
primary key, so a restart writes new rows rather than replacing old ones, and every read sums
across runs. The fleet view still keys on `instance_id`, so it shows one gateway, not one per
restart.

**V2-02 · The promotion gate reads `release` history, but withdraw rewrites it.** The "at some
point converged" test scans `release` for `state='converged'` — and v1's reconcile sets a
withdrawn release's state to `withdrawn` and a superseded one to `superseded`, destroying the
evidence that it was ever converged. Promotion to PROD would be refused for a revision that
demonstrably passed TEST, and rollback would be refused outright.
*Resolution*: no new table. `superseded` and `withdrawn` are reachable **only** from
`converged` — both v1 `UPDATE`s already carry `AND state = 'converged'` — so
`state IN ('converged','superseded','withdrawn')` is exactly "reached the fleet at some point",
and that is what the gate reads. Because the gate now depends on that invariant, it stops being a
property of two `WHERE` clauses and becomes structural: migration 002 adds a `BEFORE UPDATE`
trigger on `release` that aborts a transition into `superseded` or `withdrawn` from any state
other than `converged`, in the same spirit as the audit triggers. Tested by converging in test,
superseding it, and asserting prod still accepts the revision. `applied` is not usable for this —
it is keyed `(target_id, resource_id)` and the next revision overwrites it.

**V2-03 · Two dry runs racing produce two plans, and the second confirm silently applies the
first plan's decisions.** `planId` is checked for digest equality, not for being the newest plan,
so a stale browser tab can confirm a plan whose digest still matches by coincidence (nothing
relevant changed) but which the user has since re-computed with a different revision.
*Resolution*: `plan_digest` already includes `revisionId`, so a different revision cannot match.
For the remaining case — same revision, same policy, two plans — the confirm is idempotent by
construction and either plan is the same decision, which is now stated rather than left as an
accident. A plan is also single-use: confirming sets `release.plan_id` and a plan already
referenced by a non-`stale` release cannot be confirmed again.

**V2-04 · `PRAGMA foreign_key_check` inside the migration returns rows rather than raising.** The
resolution to V1-02 says "runs `PRAGMA foreign_key_check` before `COMMIT`", but the pragma is a
query: ignoring its result set is the same as not running it.
*Resolution*: the runner reads the rows and throws if there are any, naming the offending table
and rowid, which rolls the transaction back. Stated in the plan as the runner's contract, not as
a SQL line in the migration file.

**V2-05 · The `soap` prefix scan happens after the rate limit, so an XML bomb still costs a
counter increment but nothing else — while the *content-type* check at step 3 happens before
authentication.** That inverts §5.2, which puts the `always` block (3) before authenticate (6)
deliberately, but also means an unauthenticated caller learns whether a route is SOAP from the
`415`. That is not a leak worth changing — §5.2 is explicit — but the plan should not present
step 3 as "new in v2 for soap" without saying the ordering is deliberate and what it discloses.
*Resolution*: stated. The content-type allowlist stays at step 3 per §5.2, the XML *parse* stays
at step 8 after authorization, and the plan says which one discloses what.

**V2-06 · `bun run perf` writing `docs/perf-report.md` makes a generated file look authored.**
The repository now has one document in `docs/` that is overwritten by a script, beside three that
are written by hand.
*Resolution*: the generated report lives at `docs/perf-report.md` with a header that says it is
generated, by which command, at which timestamp, and that edits will be overwritten; the raw runs
stay in `.data/perf/`. Keeping it in `docs/` is deliberate — a performance report nobody can find
is not a report.

**V2-07 · The plan never says what happens to a `soap` resource's `route.basePath` versus the
WSDL's own endpoint path.** A SOAP client posts to one URL for every operation, so the base path
is the whole route and `rewrite.stripBasePath` interacts with the backend's `soap:address` path
in a way that silently produces 404s from the backend.
*Resolution*: for `soap` routes the plan states the intended shape — base path is a single
endpoint (`/petstore-soap`), `stripBasePath` defaults **on** for `soap`, and the binding URL
carries the backend's full endpoint path (`http://127.0.0.1:9080/soap/petstore`), so the join is
`backendPath + "/"`. A test asserts the composed URL for both `stripBasePath` states.

**V2-08 · `GET /api/environments/:environment/config` is admin-only, but the fleet view needs it
for every user who can see a gateway.** The Gateways view is `session`-authed in v1.
*Resolution*: the endpoint stays admin-only (it contains every subscription's key hash and every
route's policy — the estate in one document). The fleet view instead reads the digest and route
count from `/api/targets/:env/health`, which is already team-agnostic summary data.

**V2-09 · Nothing bounds how many instances a target may have.** `POST /api/targets/:env/instances`
is admin-only, but an unbounded fleet means an unbounded number of rollup rows per window and per
series.
*Resolution*: `MAX_INSTANCES_PER_TARGET` (default 16), enforced at mint with a `409`. It also
makes the telemetry row bound arithmetic statable: `instances × series × minutes × retention`.

---

## Round 3 — 3 findings against draft 3

**V3-01 · `run_id` in the rollup primary key defeats V1-22's prune arithmetic and the row bound.**
V2-01 added `run_id` to the key; a gateway crash-looping every few seconds would create a new run
per restart and multiply rows per window without limit.
*Resolution*: `run_id` stays in the key, and the flush **folds** every run past
`MAX_RUNS_PER_INSTANCE_WINDOW` (16) for a given `(instance, window)` into the single run id
`overflow`, counting the folds. Folding rather than rejecting, because a rejection would make a
crash-looping instance retry forever; the fleet view already shows the restarts, and this keeps
the storage bound `instances × 17 × series × minutes × retention`.

**V3-02 · The build order puts telemetry (step 4) before promotion (step 5), but the telemetry
view is environment-scoped and there is only one environment until step 5.**
*Resolution*: `PROMOTION_CHAIN=dev,test,prod` and the three targets land in step 1 with the
schema, so every later step has three environments to work with. Promotion *logic* stays at
step 5; having the environments exist is a configuration change, not a feature.

**V3-03 · The plan says a `soap` route's `errorFormat` defaults from the WSDL's SOAP version, but
policy is assembled without the model.** `assembleDocument` reads `policy_entry` rows only; the
config builder would have to load the revision's model to compute the default, which it does not
do today for anything.
*Resolution*: the default is resolved **once, at config build time**, where the revision is
already joined for `rev` — `errorFormat` is emitted into every route's policy document with an
explicit `shape` and `soapVersion`, so the data plane never computes a default and the wire
contract carries no implicit values. The policy *unit* remains optional and overrides it.

---

## Round 4 — 5 findings against draft 4

This round was the checklist pass: every earlier resolution traced into the plan text, every goal
traced to a test and a demo step, every new table traced to a bound and a prune path. All of that
held. What it turned up instead were four under-specified interfaces and one disclosure question.

**V4-01 · `gateway_instance.process_json` is described as "rss/cpu/uptime, last report" but the
UI promises drop counters per instance.** `droppedSeries`, `droppedWindows` and the fold counters
arrive in the poll envelope and were being thrown away, so the Gateways view could not render
what §13 says it renders.
*Resolution*: `process_json` holds the last `instance.process` block **and** the report's
`droppedSeries` / `droppedWindows` / `foldedRuns` with the timestamp they were observed. It is a
last-known-value column, not a series — the counters are diagnostics, not telemetry, and giving
them their own rollup would be the tail wagging the dog.

**V4-02 · `GET /api/resources?family=<teamId>/<name>` packs two identifiers into one parameter
with a separator that is legal inside neither but validated in neither.**
*Resolution*: two parameters — `?team=<teamId>&name=<name>` — which also composes with the
existing `?q=`, `?kind=` and `?team=mine` filters instead of fighting them.

**V4-03 · `copyRoute` on "create a new version" is ambiguous, and the obvious reading is
guaranteed to fail.** Copying the source version's `route` rows copies its `base_path`, which
violates `UNIQUE(environment, host, base_path)` immediately — the new version would be
unpublishable until someone edited it.
*Resolution*: the flag is renamed `createRoutes` and defined: for each environment where the
source has a route, create one for the new version with the **proposed** base path
(`/<name>/<apiVersion>`) and the same host, and skip any environment where that base path is
already taken, reporting which. Nothing is copied verbatim.

**V4-04 · "client requests sent = `requestsTotal` = `sum(count)`" is only true after a flush, and
only for an admin.** The current partial minute has not been flushed, and a non-admin cannot see
the `''` no-route bucket, so the identity the plan states as a test would fail for two reasons
that have nothing to do with a bug.
*Resolution*: the identity is stated with its two qualifiers, and the tests **force a flush**
(the aggregator exposes `flushNow()`) rather than sleeping, and read as an admin. This is the same
discipline as v1's `[R2-04]`: wait on a fact, never on a duration.

**V4-05 · `/healthz` on the data plane is unauthenticated and v2 adds operational detail to it.**
v1 already publishes the active digest, route and subscription counts there; v2 adds
`requestsTotal` and the telemetry counters. Nobody had decided whether that endpoint is a
liveness probe or an operator console.
*Resolution*: no change, with the boundary written down — the same call as v1's `[R1-22]`. §8.1
puts a reverse proxy in front of the gateway and `/healthz` is not published through it; the
endpoint carries no request content, no consumer identity and no key material, only counters. The
plan and the README now say that, so it is a decision rather than an oversight. Introducing a
second authentication mechanism on the data plane for a counter would be a worse trade.

---

## Round 5 — no findings

Re-read draft 5 end to end against the six goals, the §5.2 pipeline order, the §6.2/§6.3
promotion rules, the §8.5 poll contract, the §4 data model and the v1 deviation list. Checked
specifically that:

- every Round 1–4 resolution is present in the plan text, not just in this log;
- each of G1–G6 maps to at least one automated test and one step of the demo or the perf run;
- no out-of-scope item is stubbed in a way that could read as implemented — in particular that
  `soap` ships with no schema validation and the UI says so (D12, D13);
- every new stored table has a defined bound and a prune path (`telemetry_rollup`, `release_plan`,
  `job`), and no new table was added that the plan does not bound;
- every new credential (instance tokens) has a mint path, a revoke path, a fail-closed test, a
  cap per target, and never appears in argv (V1-12);
- the two wire contracts that change (`CONFIG_VERSION`, the poll envelope) are versioned, and an
  instance that does not understand the version keeps serving its previous config;
- every counter the UI claims to show has a defined home, and every number the plan calls a
  measurement is one the harness takes;
- every headline performance number is a difference against direct-to-backend in the same run.

Nothing further found. **Implementation may start.**

---

## Round 6 — nine findings from building it

Written back into the plan, so the plan still describes what exists.

**I1 · A self-closing tag popped the tree builder's parent.** `scan` emitted a synthetic end
event for `<x/>`, and `parseDocument` popped its stack on every end event — so the first
self-closing element inside `<types>` closed `<types>`, and the petstore WSDL parsed as a
document with two children and no `<service>`. Found by a test, and it would have been almost
invisible in review.
*Resolution*: a self-closing element emits one start event with `selfClosing: true` and **no**
end event, so a consumer that maintains a stack cannot pop something it never pushed. Written
into the `ScanHandlers` contract rather than left as a caller's problem.

**I2 · An unfinalized prepared statement kept the database file open.** `db.prepare(...)` in the
migration runner and in the telemetry flush created statements nothing ever finalized, and on
Windows that made the SQLite file undeletable — every test's temp-directory cleanup failed with
`EBUSY`, which looked like 32 unrelated test failures.
*Resolution*: `db.query(...)` throughout, which is cached and owned by the `Database`. Worth
recording because the symptom (mass test failures in `afterEach`) pointed nowhere near the cause.

**I3 · Telemetry counted responses only when their body was read.** Bytes out are known only once
the body has streamed, so the record was written at stream completion — which meant a response
whose body a client never read was never counted at all, and the identity the plan promises
(requests sent = `requestsTotal` = the control plane's sum) failed by exactly those requests.
*Resolution*: the request is counted as soon as its status is decided, and `record()` returns a
handle the streaming layer uses to add bytes afterwards. A consequence worth stating: `durationMs`
now measures the gateway's own work, not time spent streaming a body to a slow client.

**I4 · Folding a deleted API's telemetry into the no-route bucket reported nonsense.** The demo
made it obvious: `(no route matched)` showed ten requests of which three were `ok`, which cannot
happen. Requests that plainly matched a route were being relabelled as having matched none.
*Resolution*: the fold is removed. There is deliberately no foreign key on
`telemetry_rollup.resource_id` (V1-30 note), so a dangling id cannot fail a batch, and keeping it
means the traffic stays attributed to the API it belonged to — shown as `(deleted)` and, because
team scoping resolves through `resource.team_id`, visible to admins only.

**I5 · Products and applications could be created but never deleted.** A plain gap in the API
surface, and the reason the demo was not re-runnable: its cleanup could remove APIs but not the
product holding them.
*Resolution*: `DELETE /api/products/:id` and `DELETE /api/applications/:id`, team-gated, both
refusing with `409` while active subscriptions exist and naming the count. Cascading instead
would silently turn every consumer's next call into an unexplained 404, which is the outcome
`[R2-03]` already worried about.

**I6 · The demo revoked a real gateway and left the fleet degraded**, so a second run failed two
checks — the same class of defect as v1's `[R1-23]`.
*Resolution*: the revocation step mints its own throwaway instance, starts a gateway for it on a
spare port with its token in an env file, shows it serving, revokes it, shows the `503`, and stops
it. Verified by running the demo twice in a row.

**I7 · A loopback load run drifts by more than any policy costs.** Measured against a `baseline`
taken minutes earlier, `precondition` looked like +1.5 ms — but a `baseline-again` scenario at the
end of the same run showed the *baseline itself* had moved by 2.9 ms. The per-policy table was
reporting host socket churn as policy cost.
*Resolution*: three changes, all in the plan's methodology. Each policy scenario is paired with
its own baseline run **seconds** before it, not minutes; one full run is discarded as warm-up,
because whatever is measured first pays for JIT and connection establishment; and the report
prints the drift between the first and last baseline and says to read anything smaller than it as
noise. The per-policy costs settled at 0.04–0.46 ms p50, and `all-policies` became consistent with
its parts, which it had not been before.

**I8 · `.env.local` fights the seed that writes it.** Bun loads it into every process it starts,
including `scripts/seed.ts`, so a v1 file pinning `PROMOTION_CHAIN=dev` made the seed refuse the
v2 targets file. (It does not affect `bun test`, which Bun excludes from `.env.local`, so the
tests passed while the stack would not start.)
*Resolution*: `stack.ps1 -Rebuild` removes `.env.local` before seeding, and the load harness sets
its chain explicitly rather than inheriting one — a run that depends on ambient configuration is
not comparable to another machine's.

**I9 · The SOAP load scenarios measured the wrong thing.** They sent the padded JSON body every
other scenario uses, which the prefix scan rejected, so `soap-small` was timing a 500 path at
full speed and reporting it as throughput.
*Resolution*: a scenario may carry a verbatim body; the SOAP ones send a real envelope. The
status column in the report is what caught it, which is why it is in the report.

### Two things the plan said that the implementation changed

- **The XML ceilings travel in the config document**, rather than being read from
  `INTEGRATIONS_FILE` by each gateway as plan section 5 implied. They are still admin-set in that
  file; distributing them means one definition of "too deep" instead of two that can drift, and it
  is the same channel everything else uses.
- **`telemetry_rollup` has no unknown-id fold and no `droppedUnknown` counter** (see I4).

---

## Round 7 — two findings from reading the report

Both came from one question about the report: *why are `latency-30s` and `body-1mib` so slow?*
The honest answer was "they are not, and the report is the reason you had to ask".

**R1 · The report printed `rps` for every scenario without printing the concurrency that
determines it.** Every scenario runs a fixed number of workers, so `rps ≈ concurrency / latency`.
For a scenario whose backend is deliberately asleep for 30 seconds that column is pure
arithmetic — 8 workers ÷ 30 s = 0.27, and the same scenario at concurrency 800 would report 27
and mean exactly as little — but sitting in the same column as `baseline`'s 10,000 it reads as a
throughput collapse. The report invited a wrong conclusion.
*Resolution*: `conc` and `n` (sample count) columns beside `rps`; a paragraph under the results
table naming Little's Law and saying which rows may be read as capacity and which may not; a
**Payload throughput** section giving the size scenarios in MiB/s, which is their real unit; and a
`+p50` column in the latency table, because the gateway's cost on top of a sleeping backend
(0.14–1.11 ms) is the only thing those rows can actually tell you. The sample-count note also
makes visible that `latency-30s` collects exactly 8 requests in the quick profile, so its
percentiles are the maximum by another name.

**R2 · The plan's matrix listed `telemetry-off/on` — "the cost of counting, measured rather than
assumed" — and the harness never implemented it.** Round 5 explicitly verified that "nothing in
the plan claims a measurement the harness does not take", and that verification was wrong. It
mattered precisely here: byte counting is per-byte work on the response path, so it is a real
slice of the 1 MiB overhead, and without the scenario any account of that overhead was a guess.
*Resolution*: implemented rather than struck from the plan, because it is also a genuine
operational choice. `DP_TELEMETRY=off` stops the gateway counting and hands the response body
through instead of pulling it through a counting transform; the pipeline decides that from the
absence of a `record` callback, so there is one switch and not two. The load harness starts a
third gateway with it off and reports the pair. Measured on a 1 MiB response: **0.89 ms p50**,
about 17% of the request — and the trade is stated, since that instance then shows nothing in the
Telemetry view. Covered by a test asserting the body still arrives intact, `requestsTotal` stays
zero, and `/healthz` reports `telemetry.enabled: false`.

### Verified after implementation

`bun test` — **165 tests across 11 files, all passing**, including the performance guardrail and a
migration test that upgrades a real v1 database captured from the running system.
`bunx tsc --noEmit` — clean. `scripts/demo.ps1` — **34 checks, all passing, twice in a row**
against four gateways, three environments and the real `petstore.swagger.io`.
`bun run perf --profile=quick` — 21 scenarios, report written to
[`perf-report.md`](perf-report.md). The UI was walked in a browser: the telemetry dashboard, the
fleet across three environments, the promotion chain with its dry-run plan, and the divergence
report.

---

## Round 8 — findings from measuring capacity rather than overhead

Round 7 fixed a report that invited a wrong reading. This round came from the next question:
*how will this handle real traffic, at various concurrencies, and where are its limits?* — which
the existing harness could not answer at all, because it runs the load generator, the control
plane, the backend and every gateway inside one Bun process. That is the right shape for measuring
a **difference** and the wrong shape for measuring a **limit**: an absolute number needs the thing
under test alone on cores nothing else may touch. A second harness, `tools/capacity`, does that —
separate processes, an explicit CPU budget applied with a Windows affinity mask and read back
after it is set, and each workload swept up a concurrency ladder.

**R1 · The gateway had no bound on in-flight upstream work, and one slow backend could take the
whole instance.** `timeoutMs` bounds how long a request waits; nothing bounded how many were
waiting. Requests arrive at whatever rate callers choose and leave only when the backend answers
or the timeout expires, so in-flight work settles at roughly `arrival rate × timeout` — at 500 rps
against a hung backend with a 30 s timeout, 15,000 parked requests, each holding two sockets and
its buffers, on a process measured comfortable at about a thousand. The CPU is nearly idle
throughout, which is what makes it easy to miss.
*Resolution*: a `concurrency` policy unit — `{ maxInFlight, per: "instance", retryAfterSec }` — as
a per-route bulkhead, plus `MAX_CONCURRENT_REQUESTS` as the per-instance backstop for routes with
no unit attached. **Shed at the ceiling, never queue**: queueing an overload defers it, and a
request that waits in a queue and *then* waits for a timeout is worse than one refused at once.
Design §8.4 makes the same call for the validation pool and §5.8 for streams. Two new telemetry
outcomes, `route-saturated` and `instance-saturated`, because which ceiling fired is the whole
diagnosis. The slot is taken immediately before the upstream call and released when it answers, so
a request the gateway rejects never consumes one — verified by a test that sends a hundred
unauthenticated requests at a route with `maxInFlight: 1` and asserts nothing was ever held.

**R2 · The real mechanism was underneath the gateway, in the runtime.** Bun keeps its own ceiling
on concurrent outbound HTTP requests per process, across every origin, and it applies whether or
not anyone sets it. Left at its default it is a single FIFO queue shared by every route, with no
per-route fairness and no shed. Measured, out of process: flooding one route whose backend takes
two seconds pushed an *unrelated* healthy route's median latency from **0.56 ms to 1,990 ms** —
the healthy route inherited the sick backend's latency exactly. Raising the ceiling alone restored
it to 0.56 ms.
*Resolution*: the data plane refuses to start unless `BUN_CONFIG_MAX_HTTP_REQUESTS` is set and is
at least `MAX_CONCURRENT_REQUESTS`, with a message that names the variable and says why — design
§11's rule that a missing required value is a startup failure, applied to a value the process can
observe but cannot set. `scripts/seed.ts` writes it into every gateway env file; `stack.ps1`
reseeds when it finds an env file that predates it. This also invalidated the first capacity run's
slow-backend numbers, which had been measuring that queue rather than the gateway.

**R3 · The CPU column could not be measured to a publishable standard, and has been withdrawn.**
It began with a cell reading 0% for a rung serving 44,000 requests. Four attempts followed, and
each was wrong in an instructive way, so the sequence is recorded rather than tidied:

1. *"Bun's `process.cpuUsage()` under-reports by ~3× on Windows; use `Get-Process` instead."*
   **Wrong, and this document asserted it as fact.** Measured over one clean 24-second window the
   two agree to **0.1%**. The original comparison used intervals that were not the same interval.
2. *"Utilisation is skewed by a wall-clock window that doesn't match the measured one; divide by
   the gateway's own request count instead."* Right in principle — a per-request figure cancels
   window alignment — but it did not fix the numbers, which should have been the clue.
3. *"The pairing is skewed because `pwsh` blocks."* True, and worse than it looked: the spawn takes
   200 ms idle and up to 1.7 s under load, and the reading is taken at an unknown moment inside
   it, so CPU and request count were captured up to 1.5 s apart by a margin that varied with load.
   Reordering the two reads merely inverted the skew.
4. *"Take both counters from one `/healthz` response, so there is no window to misalign."* Sound,
   and it removed that failure mode — but exposed the real one underneath: Bun's counter, over the
   3-to-6-second windows a ladder rung uses, **frequently does not advance at all**. Roughly one
   sample in three returned a delta of 15–16 ms — one Windows scheduler tick — for a rung that had
   served thirty thousand requests. The ratios were bimodal and self-contradictory: `reject-401`,
   which does strictly less work than `typical`, came out more expensive than it.

The column is therefore gone from the report, with the evidence stated there, rather than shipped
with a caveat. Throughput, latency, memory, isolation and process scaling never depended on it.
Two smaller defects from the same hunt did get fixed and kept: a missing sample used to be
indistinguishable from an idle process, and every unmeasured cell now prints `—`; and a
`ForEach-Object` emitting `"cpu": null` was being summed as zero, which passed every check while
meaning "unknown".

**R4 · The gateway logged every request with no way to turn it off.** `quiet` existed but was
reachable only from code, so a gateway started as a process always logged. Added `DP_ACCESS_LOG`,
and the report measures what it costs instead of assuming.

**R5 · The petstore simulator's `__reset` corrupted its own counter.** It zeroed `inFlight` while
the reset request was itself in flight, so the `finally` left it at −1 and `maxInFlight` never rose
above 0 again. Found while using that counter to test whether the gateway's upstream pool was the
bottleneck — the counter said 1 when the true answer was 256.

**R6 · Two harness limits, stated rather than hidden.** Above about 1,024 concurrent held requests
the local backend begins refusing connections on the *direct* path too, so ladders stop there and
the report says the gateway's own socket ceiling is beyond what this harness can reach. And four
gateway processes can offer more work than one single-threaded simulator will accept, so the
process-scaling phase is also swept with `reject-401`, which never calls a backend and therefore
cannot be limited by one.

### Verified after this round

`bun test` — **182 tests across 12 files, all passing**, including 16 new ones for the bulkheads,
the startup check and the unit's validation. `bunx tsc --noEmit` — clean. `scripts/demo.ps1` —
**34 checks, all passing**, after the walkthrough's throwaway gateway was taught the new variable.
`bun run capacity --profile=standard --cpus=4` — seven phases, report written to
[`capacity-report.md`](capacity-report.md).

---

## Round 9 — resource management, after the capacity work

Three items, prompted by asking what was worth fixing before more features. All three are in the
same area: what a request is allowed to hold, and for how long.

**R1 · An abandoned request kept its upstream call, its two sockets and its bulkhead slot.** The
proxy passed only `AbortSignal.timeout(timeoutMs)`, so a client that gave up after five seconds
still cost a full timeout of upstream work. That was tolerable while nothing was rationed; it stops
being tolerable the moment ceilings are enforced, because the request is then holding one of a
bounded number of slots on behalf of nobody.
*Resolution*: `AbortSignal.any([req.signal, deadline])`. Verified first that Bun surfaces client
disconnects at all — it does, within about 5 ms. The two causes are then told apart by *which
signal fired* rather than by inspecting an error, because both arrive as an `AbortError`: a caller
that left is not a backend that was slow. A new outcome, `client-gone`, with status 499 — nginx's
convention for "client closed request", which by definition never reaches a client and exists so
the outcome has something to be recorded against. Folding it into `backend-timeout` would have put
504s in the Telemetry view for requests nobody was waiting for.

**R2 · A correction: `xml.maxBytes` is not a request-body limit.** Round 8's work led to advice
that a 40 MB SOAP request would be refused twice, by `MAX_BODY_BYTES` and again by the XML ceiling.
Wrong. `maxBytes` bounds a *parsed document*: the WSDL at import time, and the bounded
`maxPrefixBytes` envelope prefix the gateway scans for routing. The gateway never parses a whole
SOAP body — there is no XSD validation (D12) — so a SOAP request is bounded by `MAX_BODY_BYTES`
like any other. The config file now says so, because its own comment ("the `always` block for the
soap variant") is what made the misreading easy.

**R3 · The bulkhead nothing attached.** `concurrency` shipped validated, tested, documented — and
no route had it, so the isolation property it exists for was available and unused. A default
ceiling was considered and rejected: any value low enough to protect a quiet route would silently
shed a legitimately busy one, and the control plane cannot know which is which.
*Resolution*: `lintDocument`, an advisory pass that never blocks a write, returned on the policy
**read** as well as the write — a warning shown only after somebody happens to save is a warning
nobody sees — and rendered in the policy editor. It states the arithmetic rather than the rule:
"with a timeout of 30000 ms … at 200 calls a second that is 6000 requests held at once on every
instance, each holding two sockets". A second warning fires when a route has a ceiling but no
subscription key, since an open route's ceiling is anyone's to consume.

**R4 · Configuration sized from the stated traffic rather than from the defaults.** `MAX_BODY_BYTES`
8 MiB → 48 MiB, `MAX_CONCURRENT_REQUESTS` 2048 → 8192, `BUN_CONFIG_MAX_HTTP_REQUESTS` 8192 → 16384,
each with the rule it was derived from written beside it in the seed. The README carries the four
rules as a table, plus the two traps that are not environment variables: `MAX_BODY_BYTES` is per
instance and not per route, so raising it for one upload API raises it for all of them; and
`nofile` must exceed four times the instance ceiling, since a container's default 1024 is reached
long before any ceiling configured here.

### Verified after this round

`bun test` — **188 tests across 12 files, all passing**, including six new ones for the disconnect
path and the lint. `bunx tsc --noEmit` clean for both the root and the UI; `bun run build:ui`
clean. `scripts/demo.ps1` — **34 checks, all passing** against the resized configuration, with the
gateways confirming `max: 8192` on `/healthz`. The lint was checked against the running control
plane rather than only in a unit test, and appears on `petstore v1` as intended.

**R5 · The counting transform, which cost more than everything it measured.** Byte counting pulled
every response body through a transform stream — one allocated per request — and phase 6 of the
capacity report put the price at **119% of throughput** on small responses. The counters themselves
are a map lookup and some addition; it was the stream wrapper around them.
*Resolution*: take the byte count from `Content-Length` and hand the body through untouched. The
trap is compression, and it was checked rather than reasoned about: the runtime decompresses
transparently and leaves `Content-Encoding` in place while `Content-Length` still describes the
compressed bytes — measured at 83 against a 50,000-byte body. So the header is trusted only when no
encoding header is present; chunked responses, which declare nothing, still fall back to counting
while streaming. Telemetry now costs **19%** rather than 119%, measured within one run so the two
ratios are comparable. One semantic change, stated in the code and the report: this counts bytes
the backend produced rather than bytes delivered, so a client that disconnects halfway has its
whole response counted — which for a dashboard is the more useful of the two, and telemetry here is
explicitly not a per-call ledger (D15). Covered by a test that drives a plain, a gzipped and a
chunked response through one gateway and asserts the total is three times the decoded size and
never the compressed one.

The gain was larger than the phase that motivated it suggested, because the transform was on the
path of *every* proxied response and not only of the telemetry: peak throughput on a normal
published API went from **11,592 to 26,205 rps**, and with no policy attached from 12,475 to
26,072 — after which the cost of the policy pipeline is no longer distinguishable from run-to-run
noise, having previously looked like 7%. A bottleneck in the measurement path had been sitting
underneath every number in the report.

**R6 · The phase measuring that cost was itself ordered wrongly.** With three runs per
configuration taken three-at-a-time, whichever configuration went first inherited a machine still
settling from the four-process teardown in the phase before: it carried a 52% spread while the
others sat inside 13%, which made the row it produced worthless even though the spread column
reported it honestly.
*Resolution*: round-robin the configurations and discard a full pass first, so a drifting machine
moves every row together instead of penalising whichever one happened to be first. Spreads fell to
1–3%. The corrected measurement also changed the answer: telemetry's remaining cost is **not
distinguishable from noise** (28,338 rps with it against 28,309 without), where the grouped ordering
had put it at 19%. The access log, which that noise had been hiding, costs about 6%.

**R7 · The harness filled the disk, and then became the limit it was supposed to measure.** Two
consequences of the same change, both worth recording.

*The disk.* Each gateway process had its stdout — the access log, one JSON line per request —
redirected to a file inside the run's temp directory. At the rates this harness drives that is
about 4 GB per sweep, and `stop()` never runs for a sweep that is killed or that dies. Eighteen and
a half gigabytes of orphaned worlds later, a run failed at phase 5 with "not enough space on the
disk". Fixed twice over: stdout is discarded (stderr is still captured, so failures stay
diagnosable), and every run sweeps away `apim-capacity-*` directories older than an hour before it
starts, because a killed run cannot clean up after itself. The measurement consequence is stated in
the report: the access-log rows are now the cost of formatting and writing a line to a discarded
sink, a lower bound on what it costs against a real log driver.

*The limit.* The `Content-Length` fix made the gateway roughly two and a half times faster, and the
load generators did not get faster. Driving four gateway processes now needs several hundred
thousand requests a second offered, which six generator processes on twelve logical CPUs cannot
produce — and when they fail they fail by refusing to connect, which arrives as a plausible-looking
low throughput number rather than as an error. The scaling table now marks any row where more than
1% of requests failed to connect, or came back `502` from the single-threaded simulator, and gives
it no ratio; the narrative claims are computed only from clean rows, and the `DP_REUSE_PORT`
comparison declines to draw a conclusion when either side of it is marked. On this machine that
leaves fleet scaling measurable to two processes (**69,895 → 119,762 rps**, 1.71x) and no further.
The marked rows are left in the table rather than dropped: a table that quietly showed only what
worked would not say where the measurement ends.
