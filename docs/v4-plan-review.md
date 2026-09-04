# v4 plan review

Goal 0: the plan is reviewed before implementation, every issue is addressed, and the rounds repeat
until one finds nothing. This file is the record. Findings are `[P<round>-<n>]` and are referenced
from [`v4-plan.md`](v4-plan.md) where they changed it.

Rounds are adversarial on purpose: each one re-reads the plan against the design document, against
the code that exists, and — where a claim is about the runtime rather than about our own code —
against a measurement. Three claims in draft 1 were checked by running Bun rather than by reasoning,
and **two of them were wrong**.

---

## Measurements taken during round 1

Probes were written under `.data/` (git-ignored), run, and deleted. What they establish:

| Question | Answer | Where it lands |
|---|---|---|
| Does Bun's `fetch` honour `tls: { ca }`? | Yes | G4 is buildable as designed |
| Does `ca` extend or replace the default trust store? | **Replaces.** With `ca` set to one internal CA, `https://example.com` fails `unable to get local issuer certificate` | §8.3's union with `tls.rootCertificates` is mandatory, not defensive |
| `tls.rootCertificates` in Bun 1.4? | Present, 121 roots | the union is one line |
| What does a custom `ca` cost per request? | 0.057 ms/req vs 0.043 ms/req baseline, **1 handshake for 51 requests** — pooling is preserved | the per-request `ca` design is fine |
| What about `checkServerIdentity`? | **51 handshakes for 51 requests, 0.741 ms/req** — a custom callback defeats connection reuse entirely | `[P1-02]`: this is what `pin` and `skip-hostname` already do today |
| Does Bun's `fetch` send a caller-set `Host` header? | Yes — the server saw `vhost.example` | `[P1-05]`: the playground's host-bound-route risk is not real |
| Can `test/x509.ts` produce a CA or a TLS server certificate? | **No.** It emits no v3 extensions: the generated "CA" parses with `ca = false`, and a leaf has no SAN, so Bun rejects it with `ERR_TLS_CERT_ALTNAME_INVALID` | `[P1-01]` |
| Can a root-level `bun test` render a `ui/src` component? | **No** — `Cannot find module 'react/jsx-dev-runtime'`; react lives in `ui/node_modules`. The same render from inside `ui/` works | `[P1-19]` |
| Is a v3-extension certificate generator hard? | No — a CA with `basicConstraints`/`keyUsage` and a leaf with `subjectAltName` parsed correctly and completed a TLS handshake, in ~40 lines on top of the existing DER helpers | `[P1-01]`'s fix is small |

---

## Round 1 — 28 findings

**[P1-01] The G4 acceptance test cannot be written with the fixtures we have.** `test/x509.ts` says
so itself: "ECDSA P-256 …, no extensions". A trust anchor with no `basicConstraints` fails the
plan's own upload rule (`X509Certificate.ca` is `false`), and a TLS server certificate with no
`subjectAltName` is rejected by Bun before verification is even reached — hostname matching has not
fallen back to CN since Node 17. *Fix:* step 2 of the delivery order extends `test/x509.ts` with
`basicConstraints`, `keyUsage` and `subjectAltName`, and §12 stops claiming the current file is
enough. Probed: the extension encoding works and the resulting chain verifies.

**[P1-02] The performance risk was attributed to the wrong option.** Draft 1 worried that shipping a
CA set would tax every backend call. Measured, `tls.ca` is nearly free and keeps the connection pool.
What destroys the pool is a custom `checkServerIdentity` — and that is what
[`tlsOptionsFor`](../data-plane/src/pipeline.ts) already installs for `pin` and `skip-hostname`
today, so **every request through those two TLS-exception modes pays a full handshake**. *Fix:*
delete the invented risk; record the real one; add a `trust-anchor` and a `tls-exception` scenario to
the load harness so both numbers are published rather than asserted; and say the useful thing in the
Trust screen — retiring a pin in favour of a registered CA removes a handshake per request as well as
an exception.

**[P1-03] Retention would never free an artifact.** §7.4 keeps `artifact_digest` on the tombstone
(design §4.1 keeps the digests), while D29 counts references as a `COUNT` over
`revision.artifact_digest`. A pruned revision therefore pins its bundle for ever and the prune frees
nothing. *Fix:* the count excludes rows with `pruned_at IS NOT NULL`, and `compileMissingArtifacts`
excludes them too — a tombstone has no `model` to compile.

**[P1-04] Two implementations of "what is missing".** §6.2 puts the next-step evaluation on the
server; §9.4 puts it in `ui/src/lib/nextSteps.ts` and says the server "computes the same list". Two
evaluators over two shapes of input is exactly the drift §1 of the design exists to remove. *Fix:*
one evaluator, `control-plane/src/attention.ts`; `GET /api/resources/:id` gains `attention[]`; the UI
orders, groups and renders and derives nothing.

**[P1-05] A risk that does not exist.** Draft 1 hedged that Bun might ignore a caller-set `Host`, and
designed a refusal path around it. Bun sends it. *Fix:* remove the hedge and the risk row, keep a
test that asserts the header arrives at the gateway.

**[P1-06] The anchor table cannot re-trust a CA that was removed.** `UNIQUE (environment,
thumbprint)` covers removed rows too, so re-registering after a removal fails on a constraint that
says nothing useful. *Fix:* a partial unique index `WHERE removed_at IS NULL`.

**[P1-07] The wire bump strands a gateway silently.** With `CONFIG_VERSION` 4, an instance still on 3
gets `400` on every poll and keeps serving its cached config — for ever, quietly, missing the trust
anchors this release is about. *Fix:* state the mixed-version behaviour; have the control plane
answer a version mismatch with a problem the instance records; surface it in the fleet view and on
the dashboard as `gateway-activation-blocked` with the reason, so "why is DEV-2 not picking this up"
is answerable from a screen.

**[P1-08] The playground's prefilled body has an unverified source.** §5.4 said samples come from
"the compiled artifact index"; nothing establishes what `revision.index_json` holds. *Fix:* generate
from `revision.model`, which demonstrably carries the raw schemas and `components`, and bound the
generator (depth 8, 64 nodes, cycles broken) so a recursive schema cannot hang a request.

**[P1-09] The six journeys are two different lists.** G5 names publish, promote, version, subscribe,
call, operate; §9.2's table lists publish, promote, version, subscribe, attach-a-policy, register-a-CA.
*Fix:* G5's list is the definition; §9.2 shows which flow implements each, with attach-a-policy and
register-a-CA as flows inside operate and publish.

**[P1-10] The first thing an API owner will try is not specified.** "Let me test my own API" — and
§5 requires a subscription without saying what an owner does about it. *Fix:* state the rule (a
subscription is required for everyone, including the owner: there is no other way to be a caller) and
the path out, one click from the playground into the subscribe wizard with the owner's own team
pre-selected. It is also the moment the product/application model is easiest to teach.

**[P1-11] An audit row could carry a request body for ever.** §5.2 says every playground call is
audited without saying what the detail holds, and `audit` is append-only and never pruned (design
§4). *Fix:* the detail carries method, operation, environment, subscription, status, duration and
byte counts. Never a body, never a header value, never a query string.

**[P1-12] Three unrelated things are about to be called "Trust".** The screen already holds client
identities we present (`certificate`) and exceptions to verification (`tls_exception`); v4 adds
authorities we trust. *Fix:* three named sections, each with a one-line purpose, and the register-a-CA
wizard names which of the three it is creating. A user who cannot tell these apart will pick the
wrong one and blame the platform for the outcome.

**[P1-13] The dashboard has no bounds.** Top APIs, attention rows and subscriptions are unbounded;
an admin in a large estate gets a slow, enormous document. Every other endpoint in this system states
its bound. *Fix:* `topApis` ≤ 10, `attention` ≤ 50 per block with a `truncated` count,
`subscriptions` ≤ 50 with a link to the full list.

**[P1-14] Two vocabularies for one window.** The dashboard takes `windowHours`; the telemetry API
takes `sinceMin`. *Fix:* the dashboard takes `sinceMin` like everything else, and the UI's window
buttons map to it.

**[P1-15] "Referenced by an open release plan" is not computable as written.** The existing prune job
already deletes `release_plan` rows older than `JOB_RETENTION_HOURS` that no release references, so
the protection evaporates while a user still has the dry run open. *Fix:* define the exception as
"referenced by a `release_plan` younger than `JOB_RETENTION_HOURS`, or by a release in `pending` or
`converging`", and say plainly that a stale plan protects nothing.

**[P1-16] `PUT …/spec` can change what kind of thing a resource is.** Nothing in draft 1 stops a WSDL
replacing the OpenAPI of a `rest` resource, which would leave routing, validation and the catalog
describing a contract of a different shape. *Fix:* the replacement's `original_format` must belong to
the resource's kind family, else `400` naming both.

**[P1-17] The playground's rate limit is described as if it protected the consumer.** It protects the
control plane. A user with 60 calls a minute can still spend a subscription's quota. *Fix:* say which
is which, and let the quota warning beside the send button and the history be the control for the
other.

**[P1-18] §8.5 widens what the control plane trusts, quietly.** Unioning every environment's anchors
means a CA registered for PROD backends also verifies a DEV team's spec host. That is the right
call — a CA is an issuer decision, and the control plane has no environment — but it must be said out
loud. *Fix:* state it in the plan, on the Trust screen, and in the governance report.

**[P1-19] The UI tests as planned cannot run.** Probed: a root-level import of a `ui/src` component
fails with `Cannot find module 'react/jsx-dev-runtime'`, because react is installed in
`ui/node_modules`; the same render from inside `ui/` works. *Fix:* UI tests live in `ui/test/` and the
root `test` script runs `bun test` there as a second step. No new dependency, and D30's claim becomes
true instead of aspirational.

**[P1-20] Twelve existing views are not mentioned.** A rebuild that lists only new files is a rebuild
whose scope nobody can check. *Fix:* a table mapping every current view to its v4 destination —
kept, renamed, absorbed or replaced — so "did we finish?" has an answer.

**[P1-21] `startHere` and `attention` are the same idea twice.** *Fix:* `startHere` is the
empty-estate branch of the one evaluator and carries the same row shape, so one component renders
both.

**[P1-22] History outlives what it refers to, and nothing says what happens.** *Fix:* the resource FK
cascades; a revoked or deleted subscription leaves the entry listed with load disabled and the reason
shown, the same rule as an operation that no longer exists.

**[P1-23] `ipAllow` will make the playground look broken.** The request reaches the gateway from the
control plane's address, so a route with an `ipAllow` unit that does not include it rejects every
playground call with a `403` that reads like a bug. *Fix:* detect `ipAllow` in the effective policy,
say so before sending, and name the address to add.

**[P1-24] Where the operation index comes from is unstated.** §5.1 says the operation must belong to
"the revision currently converged in that environment" without naming the query. Rebuilding the whole
config document per playground call would be absurd. *Fix:* resolve the route and the converged
revision directly, read operations from `revision.model`, and read the effective policy from
`policyFor` — the same function the config builder uses, so the key header can never disagree.

**[P1-25] URL composition is written for `rest` only.** `mcp` and `a2a` have no path template, and
A2A's card lives at a fixed sub-path. *Fix:* state composition per kind: `rest` base path + rendered
template; `soap` base path only; `mcp`/`a2a` base path only, with the operation carried in the
JSON-RPC body; plus the A2A card's `GET <basePath>/.well-known/agent-card.json`.

**[P1-26] Navigation that appears only when you already have things.** If the "Publish APIs" section
renders on the strength of owning an API, a team that owns none can never find the way to publish
their first. *Fix:* navigation follows capability (team membership, role), not inventory; the
dashboard's *blocks* follow inventory. The difference is the whole of a first-run experience.

**[P1-27] Retention reads the design's bound the loose way round.** Design §4.1: "at most 5 revisions
per resource and at most 1 year, **whichever is tighter**". Draft 1 keeps anything in the newest five
**or** newer than a year, which is the union — more revisions than the design allows. *Fix:* keep a
revision only when it is among the newest `REVISION_KEEP_COUNT` **and** younger than
`REVISION_KEEP_DAYS`, plus the three exceptions, which are the only widening the design permits.

**[P1-28] History mixes environments without saying so.** `GET /api/playground/history?resourceId=`
returns calls from every environment. That is right — the same request against DEV and TEST is the
comparison a user wants — but each entry must carry and display its environment, or the list lies by
omission. *Fix:* state it; the row shows an environment chip.

---

## Round 2 — 14 findings, against draft 2

Round 1's fixes are all present. These are what draft 2 introduced or still leaves unanswered.

**[P2-01] Three citations point at the wrong findings.** §5.2 and §7.2 carry
`[P1-06 of v1's spirit]`, `[P1-07 of v1's spirit]` and `[P1-11 of v3's spirit]` — invented references
to findings that say something else. A reference nobody can follow is worse than none: it makes the
document look reviewed where it was not. *Fix:* delete them; cite only real findings.

**[P2-02] The playground gate contradicts itself.** §5.1 accepts `subscriptionId: null` and §5.1 says
a route with no `auth.subscriptionKey` is called without a key — while §5.2 says "a subscription is
required for everyone, including the API's own team". Both cannot hold. *Fix:* state the rule by
what the route requires: a subscription is required **exactly when the effective policy carries an
`auth.subscriptionKey` unit**. Without that unit the route accepts anonymous traffic and any
signed-in user who can see the API may call it. The owner path of `[P1-10]` then applies only to
key-protected routes, which is where it belongs.

**[P2-03] The attention evaluator has no cost bound.** §6.3 describes it as evaluating resources and
subscriptions; a team with 500 APIs turns one dashboard request into 500 model loads. *Fix:* define
it as a fixed set of **SQL queries that return only candidate rows** — resources with no route, no
binding, no converged release; releases in `failed`/`stale`; policy documents missing an auth unit
(a `policy_entry` anti-join); subscriptions past a quota fraction — never "load everything and
iterate". Each query is `LIMIT`ed, and the endpoint's ≤ 50 bound is applied after merging.

**[P2-04] Two jobs that mean the same thing.** §7.4 adds a `retention` job kind while `prune` already
exists and already deletes by age (telemetry, jobs, plans), and design §10 lists revision pruning as
part of the same prune job. *Fix:* fold revision retention and playground-history retention into
`prune`; its result line enumerates each subject and what it removed. One hourly key, one job, one
test file to extend.

**[P2-05] The revision list promises a `source` the schema cannot produce.** §7.1 lists
`upload | url | discovery | copied`, but `revision` has no such column and `resource.discovery_url`
is per resource, not per revision — a resource discovered once and then uploaded to would report
every revision as discovered. *Fix:* migration 4 adds `revision.source TEXT` and
`revision.source_detail TEXT`, written by every creation path (upload, `specUrl`, discovery,
version-copy, in-place correction), defaulting to `'upload'` for existing rows.

**[P2-06] The two perf scenarios have no TLS backend to run against.** `tools/backend` serves plain
HTTP; the measurements in `[P1-02]` were taken against a throwaway server. *Fix:* `tools/backend`
gains `--tls`, generating its certificate from the extended `test/x509.ts` and printing the CA PEM so
the harness can register it as an anchor. Without it, step 3 cannot produce the numbers §12 promises.

**[P2-07] The UI cannot build the playground's gateway picker.** Nothing exposes the labels from
`TARGETS_FILE`. *Fix:* `/api/meta`'s environment entries gain
`gateways: [{ label, url }]` — admin configuration, not a secret — which also lets the console show a
copyable `curl`. That `curl` carries `-H "X-Api-Key: $KEY"` as a **placeholder**: the UI has no key
and must not appear to have one; the reveal action (audited) is where a key comes from.

**[P2-08] `PUT /api/revisions/:id/spec` has no stated authorization.** *Fix:* `can()` on the owning
resource — the owning team or an admin — like every other write on a resource, and audited with the
digest it replaced.

**[P2-09] `start-here-*` codes sit in the same enum as real attention rows.** Nothing says they may
not appear in `attention[]`, so a UI could render "publish your first API" as a blocker on a team
that has fifty. *Fix:* state that the three `start-here-*` codes are produced **only** into
`startHere`, and that `startHere` is non-null only for an empty estate.

**[P2-10] The fail-static cache now holds certificates, and the plan does not say what kind.** §8.7
of the design requires the artifact volume to be encrypted because it holds *private keys*. Trust
anchors are public certificates. *Fix:* say so: anchors travel in the config document and land in the
existing config cache with no permission change, unlike `certs/`, which holds key material.

**[P2-11] `sinceMin` has no validation rule and duplicates `windowComplete`.** *Fix:* accept an
integer between 1 and `TELEMETRY_RETENTION_HOURS × 60`; anything larger is `400` naming the ceiling
(never a silent clamp — design §11's rule). `windowComplete` then describes the *trend*: it is false
when twice the window exceeds retention, which is exactly when `previous` is null. One meaning, one
field — drop the other.

**[P2-12] Artifact deletion would trip over v3's sentinel.** A revision with no schemas carries
`artifact_digest = ''` (v3 writes it deliberately). A `DELETE FROM artifact WHERE digest NOT IN
(SELECT artifact_digest …)` including `''` rows is harmless, but the inverse — treating `''` as a
reference — would keep a phantom. *Fix:* the reference query filters
`artifact_digest IS NOT NULL AND artifact_digest <> ''`, and the deletion never considers `''`.

**[P2-13] What the playground returns is not specified.** With headers being injected, filtered and
echoed, "the response" needs a shape. *Fix:* the response carries the **response** status, headers,
timing, body (or base64), the truncation flag, the list of caller headers that were dropped, and the
target's path — never the injected key, never the composed absolute URL's credentials, and never the
request headers as sent to the backend (which include the key).

**[P2-14] The trust test needs a scheme the sample egress allowlist does not permit.** `config/
integrations.json` allows `http` on `localhost`/`127.0.0.1` only, so a control-plane spec import from
a TLS test server would be refused before TLS is ever exercised. *Fix:* the test builds its own
integrations config with `https` on `127.0.0.1` (the helpers already construct config per test), and
§12 says so rather than leaving it to be discovered at step 2.

---

## Round 3 — 8 findings, against draft 3

**[P3-01] `keyKind: "secondary"` on a subscription that has none.** `subscription.secondary_key_enc`
is nullable and often null. Draft 3 does not say what happens. Falling back to the primary — what the
current portal does — sends a key the user did not choose and makes "test my secondary key before I
rotate" silently untestable, which is the only reason that control exists. *Fix:* `400`, "this
subscription has no secondary key", with the rotate screen named. And `keyKind` is ignored when
`subscriptionId` is null.

**[P3-02] A converged release is not the same as a served route.** v3 `[R4-02]` omits a route from the
config document when its effective policy document is invalid, recording it in the target's health as
`configErrors[]`. The playground composes its URL from the release, so on such a route it would send a
request the gateway has never heard of and show a `404` that reads as a platform fault. *Fix:* resolve
against the same check the config builder applies, and when the route is omitted say so before
sending — "this API is published but not currently served: <reason>" — linking to the policy screen.
The dashboard already surfaces `config-error`; this is the same fact at the point of use.

**[P3-03] The stored request body has no cap.** §4 caps the stored *response* with
`PLAYGROUND_HISTORY_BODY_BYTES`, and §5.3 caps the request at 256 KiB *in flight* — so history can
hold 25 × 256 KiB per user per resource of somebody's test data, indefinitely by the standards of a
scratchpad. *Fix:* the same `PLAYGROUND_HISTORY_BODY_BYTES` bounds the stored request body; over it,
the body is stored truncated and flagged, and the load action warns that the body was shortened. The
in-flight cap stays 256 KiB — what we send and what we keep are different questions.

**[P3-04] "How many exceptions this anchor could retire" is not computable.** Draft 3's Trust screen
promises it. Whether a backend's chain verifies through an anchor cannot be known without talking to
the backend. *Fix:* show the honest fact — the count of active exceptions in that environment — and
add the action that answers the real question: `POST /api/trust/exceptions/:id/check`, an admin-only,
egress-checked, one-off TLS probe of that backend with the environment's anchor set, reporting whether
it would verify without the exception. A claim we can compute, or a button that goes and finds out;
not a number we invented.

**[P3-05] Applications have no home in the new navigation.** §9.7 splits today's `CatalogView` into My
products and My subscriptions and never says where applications — the credential holder every
subscription hangs off — live. *Fix:* applications live inside **My subscriptions**, which is where a
consumer thinks about them ("my app, its keys, what it can call"), with creation available inline from
the subscribe wizard.

**[P3-06] G5's headline acceptance has no check at all.** "Six journeys completable without
documentation" is the goal; §9.4's rules are testable but they are not the journeys. *Fix:* three
things, stated as the definition of done: `demo.ps1` walks all six through the API in the order the UI
presents them; `ui/test` asserts, per journey, that the wizard's steps exist and that each step's
primary control is enabled or disabled-with-reason for a fresh account; and the README carries the
manual walkthrough checklist, because D30 means no browser automation and pretending otherwise would
be the same dishonesty D30 exists to avoid.

**[P3-07] The wire-mismatch test cannot be written as described.** After the bump both planes speak 4,
so nothing in the tree sends a 3. *Fix:* the poll client reads its wire version from an exported
constant the test can override, and the test drives both halves: the control plane refuses a poll
carrying `wireVersion: 3` with a problem naming both versions, and the instance, given that response,
keeps serving, records `activationBlocked: { reason: "wire-version" }` and reports it on `/healthz`.

**[P3-08] `gatewayLabel` has no default.** A caller omitting it gets an unspecified outcome. *Fix:*
omitted means the environment's first configured gateway, and the response echoes which was used —
which the history row already stores.

---

## Round 4 — 2 findings, against draft 4

A full read-through of draft 4, looking for internal contradiction rather than new design questions.
Both findings are small, and both are the kind that make a reader stop trusting the document.

**[P4-01] A cross-reference to a section that does not exist.** §3's layout points at "the rebuilt
views of §9.8"; the view-migration table is §9.7. *Fix:* corrected.

**[P4-02] `retention.ts` still reads as its own job.** Round 2 folded revision retention into `prune`
`[P2-04]`, but §3 still described the module as "revision pruning (design §4.1)", which invites the
reader to look for a second job kind. *Fix:* the module stays — it is where the logic lives — and §3
now says it is called by the `prune` job.

---

## Round 5 — nothing found

Draft 5 was re-read end to end against three things: the design document (§4.1, §5.3, §5.4, §8.5,
§8.7, §9, §10, §11, §14), the code the plan touches
(`config-build.ts`, `jobs.ts`, `telemetry.ts` prune, `router.ts`, `egress.ts`, `artifacts.ts`,
`pipeline.ts`'s `tlsOptionsFor`, `schema-003.sql`), and the measurements in this file.

Checked and found consistent:

- every finding from rounds 1–4 is addressed in the text, and each fix is stated where the decision
  lives rather than only in a list;
- every new endpoint states its authorization, its bounds and its failure shape;
- every new bound has a defined behaviour past it (design §11's rule) and a test in §12;
- every deviation D26–D31 names what the design says, what we do and why, and none of them
  contradicts an earlier deviation;
- the wire bump, the migration, the job changes and the config additions each have a stated
  backward-compatibility story;
- nothing in the plan claims a capability the runtime does not have: the three claims that could not
  be settled by reading were measured, and the two that were wrong were corrected.

Two things are deliberately left as stated limits rather than solved, and both are recorded in the
plan: journey-level UX acceptance is manual (D30), and the trend on the dashboard is bounded by
telemetry retention (D28).

**Goal 0 is met. Implementation may start at step 1 of §13.**
