# Manual test run — 2026-09-05

A walk through [manual-test-checklist.md](manual-test-checklist.md), in a browser, against a stack
brought up with `scripts/stack.ps1`. Sections 0–18 were attempted. What follows is the record the
checklist asks for: what was done, what was expected, what happened, and — where they differ —
whether the control plane accepted a change that the gateway did not serve.

**How it was driven.** The in-app browser pane's synthetic pointer and keyboard input proved
unreliable at this window size, so most interaction was done by dispatching real DOM events against
the real controls (native value setters plus `input`/`change`, `click()` on the actual buttons,
CodeMirror transactions for the editors). That exercises the same React handlers and the same
endpoints; what it does **not** exercise is hit-testing, focus order and keyboard traversal, so
§18's keyboard bullet is untested. Everything else was observed through the interface.

---

## Summary

The product passes the substance of the checklist. Every gateway-facing claim held: policy rungs,
per-instance rate limiting, blocking-by-default validation and its reasoned downgrade, promotion
and environment independence, mutual TLS with no exception anywhere, round-robin with weights,
the breaker and its half-open recovery, both versions serving at once, SOAP faults, MCP JSON-RPC
errors, the rewritten A2A card, and convergence across an offline gateway and a full restart.

Twelve findings are below. One is a hard upgrade defect. Two are authorisation questions. The rest
are interface and copy problems. Seven checklist bullets describe the product slightly wrong and
should be corrected in the checklist rather than in the code.

**All twelve are now fixed** — see [Resolutions](#resolutions) at the end, which also records the
eight product changes made alongside them and the two judgment calls behind them.

---

## Findings

### 1. A pre-schema-006 database cannot boot — raw stack trace, `seed failed`

**Severity: blocking for anyone upgrading.** `schema-006.sql` renames `team` to `application` and
renames the `team_id` columns, but never remaps the well-known development ids. `principals.ts`
changed `TEAM_PLATFORM = "team_platform"` to `APPLICATION_PLATFORM = "application_platform"` in the
same commit. So on an existing database `ensureDevDirectory` inserts id `application_platform` with
name `Platform APIs`: the id is new, so `ON CONFLICT (id)` never fires, and the name is already held
by the surviving `team_platform` row.

```
SQLiteError: UNIQUE constraint failed: application.name
    at ensureDevDirectory (control-plane/src/principals.ts:365:8)
    at createApp (control-plane/src/server.ts:69:3)
Exception: scripts/stack.ps1:140 — seed failed
```

The failure is a raw stack trace, not a sentence. Worked around for this run by moving
`.data/apim.sqlite` aside and seeding fresh; the migration itself is unfixed.

### 2. Telemetry is admin-only in the shell and open to every member on the server

`/telemetry` is in `ADMIN_NAV`, is `adminOnly` in the route table, and is correctly absent from a
member's sidebar. It is not gated anywhere else. Signed in as **Pavel** (member, not an admin), both

- the screen at `/telemetry`, reached by typing the address, and
- `GET /api/telemetry/summary?environment=dev`

answer `200` with the **whole estate's** traffic. With real traffic in the window, the *By consumer*
table showed `Orders → checkout-product`, i.e. another application's consumption volume. Either the
screen is not admin-only and the nav is wrong, or it is and the server is missing a check.

### 3. Any member can read another application's backend URLs and full policy

`GET /api/resources/:id/editor` returns `settings` to a non-owner. Signed in as **Clara** (Orders)
and opening a Platform APIs API, the properties tab rendered the pool — `http://127.0.0.1:9080/v2`
and `:9081/v2` — the routing rule, the public path and the name of the attached client certificate,
all disabled but legible, plus the complete policy document. Read-only visibility of *what an API
does* is defensible; backend addresses are internal topology and worth a deliberate decision.

### 4. `GET /api/subscriptions?environment=…` ignores the parameter

Asking for `dev`, `test` and `prod` each returned the identical four rows spanning two environments.
The portal filters client-side, so the screens are right; any other client that trusts the parameter
is not.

### 5. A topic owner cannot revoke a consumer's Kafka access

Deleting a topic is refused with *"revoke or cancel topic subscriptions first"*, and the message
never says who holds them. The *Topic subscriptions* panel shows only the selected application's own
row, so as the topic's owner Pavel could see and withdraw his own access but not Orders'. The API
(`GET /api/kafka/access?environment=dev`) returns both to him, so this is the interface, not the
server. The topic could only be deleted after Clara withdrew hers herself. This is asymmetric with
product subscriptions, where a publisher can withdraw a consumer's access.

### 6. The workspace's subscriptions tab shows a stale transient state

After withdrawing Orders' subscription, the row read **revoking** and stayed there — through a tab
switch and past the point where the gateway was already rejecting the key and the API reported
`revoked`. Only a full page reload showed the terminal state. The standalone **Subscriptions** screen
does refresh itself; the tab inside the API workspace does not.

### 7. The *New version* dialog states something the default makes false

The dialog says: *"v1 keeps serving on its own path and keeps its own subscriptions — a key for one
does not open the other."* Directly beneath it, **Product** defaults to the family's existing
product. Publishing v2 that way and calling with the v1 key:

```
v1=200  v2-nokey=401  v2-withkey=200
```

The v1 key opens v2, because subscriptions are per product and both versions are in one. The
sentence should be conditional on the product choice made two fields below it.

### 8. On a foreign API, controls are dropped rather than disabled-with-a-reason

§18 promises *"Nothing you cannot do is hidden. Controls are present, disabled, with the reason
beside them."* As Clara on a Platform APIs API: the properties fields are present and disabled
(good), but **no reason is stated anywhere on the screen**, and `Save changes`, `New version` and
`Promote to TEST` are absent rather than disabled. The playground does this properly — it explains
that a subscription is needed and offers the button — so the pattern exists and is not applied here.

Related: that same screen shows *"Deployment progress — No changes yet. Publish an API to get
started."* on somebody else's long-published API.

### 9. `/apis` is not filtered by kind

**MCP Servers** lists only MCP APIs and **A2A Agents** only A2A ones, but **APIs** lists everything,
so `petstore-mcp` and `shelter` each appear under two sidebar entries. The checklist expects the
plain APIs view to exclude them.

### 10. Health Status calls DEV "in sync" while a gateway is behind

With `dev-2` killed and a change applied, the row correctly read `behind` / `stale`. The environment
header above it still read **dev in sync**, and the rate-limit arithmetic below still read *"dev: 2
live gateways"*. Three statements about the same fleet, two of them wrong.

### 11. Grammar, on screens about the central noun

"Being in **a** application is what lets you publish" (Your account, Applications), "Create **a**
application", "deleting **a** application must not be a way to delete published APIs", "A
application granted here stays…", and on a certificate's danger zone "1 binding **name** this
certificate".

### 12. The unvalidatable-operations table repeats each row per environment, with no environment column

Global policy → *Operations that cannot be validated at all* lists `checkout v1 getInventory
no-schema` three times, once per environment, with nothing on the row to tell them apart.

---

## Corrections the checklist needs

These are the checklist describing the product wrongly, not the product misbehaving.

| § | Says | Actually |
|---|---|---|
| 2 | the Operations card lists `getInventory` and `addPet` | it lists method and path — `GET /store/inventory`, `POST /pet` |
| 4, 7 | set the backend timeout to `1`, call, and see the gateway give up | the local petstore answers a `200` in under a millisecond, so nothing times out. Force it: `curl.exe -H "x-sim-delay-ms: 2000" …` → a clean `504 Gateway Timeout` |
| 6 | promote while a DEV edit is in flight; TEST gets what DEV had, not the edit | promotion captures DEV's **accepted** state at the moment promote is submitted, so an edit submitted *before* the promote does travel. Submission order is what decides; `test/native-workflows.test.ts` already proves the case that matters (an edit submitted *after* the promote does not leak in). Also, "switch to TEST and promote" is misleading — promotion into TEST is started from the DEV workspace, and pressing Promote moves you to TEST, so the follow-up edit lands on TEST unless you navigate back |
| 10 | a **Services** card lists the WSDL's services and operations | the card is titled **Operations** and lists the two operations; it does not name `PetstoreService` |
| 11 | the MCP row is absent from the plain APIs view | it is not — see finding 9 |
| 16 | a blocked operation with an explanation | not reproducible this way. A backend outside the egress allowlist is refused synchronously, before an operation exists (*"http://no-such-host.invalid:1234 is not in the egress allowlist"*); an allowlisted backend that is simply down publishes fine, which is correct. The checklist needs a case that actually blocks |
| 17 | create a local account; it must choose a password | not possible on the dev seed. **People** says *"An account arrives here the first time somebody signs in through the identity provider. You do not create those"* and offers no create button. This sequence needs `AUTH_PROVIDERS=local` in `.env.local` and a full `-Down`/`-Up` |

---

## What passed

Recorded briefly, because the list is the point.

**§1 shell.** Sidebar, application picker, the four groups, the *Integrations simulated* chip, three
dashboard counts, DEV/TEST/PROD with DEV selected, no Administration group for Pavel, theme survives
a reload, the sidebar collapses behind ☰ at phone width, and as Alice all six Administration entries
appear and all eleven Global/Administration screens open with a title and a one-line purpose. One
deviation: after sign-in the address stays `/` rather than becoming
`/application_platform/dashboard`; deep links to both shapes work.

**§2 publish.** `Checkout` refused — *"name: 2–61 lowercase letters, digits or hyphens"*. The public
path placeholder becomes `/checkout` as the name is typed. Published, landed on the workspace,
operation complete in about four seconds, listed in Activity. `401` on `:8081` **and** `:8082`,
`404` on `:8083`.

**§3 own-product subscription.** Dialog names the application and the environment; a two-character
purpose is refused; result panel reads **activating**; keys revealed; rotating the secondary changed
the secondary and not the primary; the key returned `404` from the backend, not `401`, exactly as
the checklist warns.

**§4 policies.** Public access → no `401`; back to key → `401` returns. Rate-limit controls appear
with *Calls per gateway*. The advanced JSON and the form controls read the same document in both
directions. A syntax error replaces the form with *"Correct the advanced settings JSON to use these
controls"* and the save reports the parse error. Then, at each rung: `401` without a key, `403` with
the policy's own body — *"Forbidden - missing or invalid X-Request-Origin header"* — and `200` with
both. The fourth call in ten seconds was `429` with `retry-after: 3` and `x-ratelimit-*`; the same
call on `:8082` at the same moment was `200`. `{"name":42}` was rejected `400` before the backend
with both pointers named, with no `validate` unit attached. Downgrading without a reason was refused
(*"required whenever request is not blocking … recorded in the audit log"*); with
`downgradeReason` it saved and the same call returned `200`; the downgrade was listed with its
reason; removing the unit brought the `400` back.

**§5 approval.** `checkout` visible to Clara with Platform APIs named as owner; her request went
**pending**, not activating, with no key revealable. Pavel rejected it with a reason, she requested
again with a different purpose, and both rows persisted — history not overwritten. Approved, the row
went active, her key returned `200`. On the publisher's side the row offered **Revoke** and **no**
Show keys, while his own application's row offered both. Revoking needed the product name typed
back, and Clara's key returned `401` afterwards.

**§6 promotion.** Empty backend refused in the server's words. Promoted, environment switched, `401`
on TEST — the policy travelled — and TEST keys are distinct from DEV keys (`test-with-devkey=401`).
No plan, release, revision, digest or planId anywhere. Changing DEV's backend to `:9081` moved DEV's
`x-backend-instance` and left TEST's alone. PROD promoted and serves; on PROD there is no next
environment and no button.

**§7 client certificates.** Pavel's Certificates screen opens on Client certificates, and the
Certificate authorities tab is read-only for him with the reason stated. A mismatched pair was
refused at upload. The row showed subject, issuer, `7299 days 8/31/2046`, thumbprint and
*Used by: nothing*; the private key is never returned by the API. Attaching it made *Used by* read
`checkout v1 dev`; deletion was refused (*"1 binding name this certificate"*) and wants the name
typed. TEST's list is empty and TEST's properties do not offer it. Then the real one: the mTLS
petstore refused an anonymous client (exit 55) and answered `200` with `x-backend-mtls: verified`
for a client certificate; through the gateway with the CA registered for DEV but no client
certificate, `502`; with `gateway-client` attached, **`200` with `x-backend-mtls: verified` and no
TLS exception anywhere**; detached again, `502` returns. TEST saw none of it.

**§8 pools.** One member reads as one field with **Remove** disabled. Round-robin revealed weight
boxes and the per-instance sentence. Six calls on one gateway alternated `9080`/`9081`; weights 3:1
gave 6:2 over eight; failover sent all four to the first member and the weight boxes disappeared.
The form stops at eight members and the API refuses nine — *"a pool may hold at most 8 backends…
put a load balancer behind one URL"* — and refuses a weight under failover — *"weights only mean
something under round-robin"*. With the breaker and retries attached and `backend-2` killed, ten
calls all succeeded on the survivor; twenty-two seconds after restarting it the rotation was even
again with nobody clicking anything; with both backends down, `502` *"could not reach the backend"*.

**§9 versioning.** On TEST, *New version* is replaced by *"A new version starts in DEV — switch
environment to publish one."* On DEV the identifier is pre-filled `v2`, the path is `/checkout/v2`
and follows the identifier as you type, the carry-over sentence is there, and Product defaults to
the family's product. Publishing lands on a different API with its own id, a Version switcher
appears on both, and the header carries the version. Both paths serve. A third `checkout` at `v2`
is refused *"API name and version already exist"*. v2 promoted to TEST with v1 untouched.

**§10 SOAP.** Published from a pasted WSDL, `GetPet` returned a `GetPetResponse`. A `SOAPAction`
disagreeing with the body, a `petId` of `banana` and a missing key each returned a **SOAP Fault**
carrying the real status — `400`, `400`, `401` — never a JSON problem document. Promoted to TEST and
`401` there.

**§11 MCP.** Import-from-URL discovered the server's own tool set. `initialize` returned `200` with
`mcp-session-id`; `tools/list` returned the three declared tools; an undeclared tool returned
`-32601`; `{"petId":"banana"}` returned `-32602` with the pointer, before the server; no key returned
`401` **as a JSON-RPC error**.

**§12 A2A.** The card is served without a key, its `url` is `http://localhost:8081/shelter` rather
than the origin's `127.0.0.1:9086`, and its security schemes are the gateway's `subscriptionKey`
rather than the agent's own bearer token. `message/send` returned `200` with the key and `401`
without.

**§13 playground.** Operations listed from the definition; a real `200` in 14 ms via dev-1; *What
was sent* shows the headers **without** the key and says so; the call is in *Your calls* and
survives a reload; on an API with no subscription the panel offers *Subscribe an application to try
this* with the reason.

**§14 Kafka.** Topic created and ready, panel titled *· simulated*. Description and a raise to six
partitions both kept across a reopen; lowering refused — *"partitions may only increase, up to
100"*. Enabling the REST proxy made the topic appear under Kafka REST Proxy, which was empty before.
The owner's access activated without approval; produce then consume returned the message at offset
1. Clara's request went pending and appeared in Pavel's Approvals beside the subscription requests;
approving activated it. Deleting was refused while access existed, and succeeded once both were
withdrawn, with the topic name typed back.

**§15 integrations.** Three buttons, each writing an entry with request and response as JSON. LeanIX
returned the application name, `LX-application_platform`, a description and an owner contact; LdapWS
returned the members (emails are `null` — development accounts have none); FixMe returned three
numbered steps and *"Simulated diagnostics completed. No infrastructure was changed."* The **FixMe**
global entry shows the same list filtered to `fixme`. Email entries carry recipient, subject and
body; everything is marked `"simulated": true`. After a full `-Down`/`-Up`, all 61 entries across all
six integration kinds were still there.

**§16 convergence.** With `dev-2` killed, the operation sat at **waiting for gateways** while dev-1
was already serving the change (`x-ratelimit-limit: 201`), and Health Status showed dev-2 `behind`.
Restarting dev-2 flipped the operation to **complete** on its own. A change submitted and then
`-Down`/`-Up` converged by itself, and the database holds exactly one `converged` release per
environment with the rest `superseded` — nothing was submitted twice. Three rapid clicks on
**Publish to DEV** created one API. A submission refused for a bad backend, corrected and
resubmitted, was accepted as a new command.

**§17 administration.** Applications shows both, with each membership's provenance — *"Granted here
by dev-provider on 9/5/2026"* — and refuses to delete an application that still owns things.
Demoting the only administrator is refused: *"Alice Admin is the only enabled administrator left …
Make somebody else an administrator first."* Granting Pavel the Orders membership let him create a
topic there (`202`); removing it made the same call `403` — *"you are not a member of the owning
application and not an admin"* — with no re-login. Telemetry contains the calls made above, split by
API, consumer and gateway. A global `cors` unit attached to DEV was inherited by an API with none of
its own and **overridden** by one that set its own (`Access-Control-Max-Age: 60` and its own
`Allow-Origin` against the global's `600`), then detached cleanly. A TLS exception is refused for a
short reason and for an expiry past the 30-day ceiling, both in the server's words; a valid one
appears in the governance report and is revoked by typing the API name. Audit records
`approval.approved` / `approval.rejected` with the actor and both sides
(`{"applicationId":"application_platform","consumer":"application_orders"}`).

**§18 spot-checks.** Every screen states its purpose. The environment switcher sits above what it
changes. Every delete, revoke and withdraw is folded shut and wants the object's name typed back.
Errors land where the decision was made, in the server's own words — this is the most consistently
good thing in the product. Every simulated result is labelled. No key material appeared in any URL
across 250 requests. The two that did not hold are finding 8 (hidden rather than disabled) and the
untested keyboard traversal.

---

## Resolutions

All twelve are fixed, and the checklist's seven corrections are in
[manual-test-checklist.md](manual-test-checklist.md). The findings above are left as written — they
are the record of what a walk through the product actually found, and rewriting them would lose it.

| # | What changed |
|---|---|
| 1 | `migrations/schema-007.sql` remaps the well-known `team_*` ids to `application_*` before anything else, across all ten referencing tables and `session.applications_json`. It is a no-op on a fresh install, and `test/migration.test.ts` asserts no `team_%` id survives |
| 2 | `requireEstateReader` on all four `/api/telemetry/*` routes. Resolved in favour of *the server was missing a check*: the screen's *By gateway* table names every replica, which is exactly what an administrator may see and a consumer may not |
| 3 | `/editor` returns `{host, basePath, redacted: true}` to a non-owner. Backends and the policy document are the owning application's topology |
| 4 | `environment` is validated against the promotion chain and appended to the query |
| 5 | The panel is now *Topic access*, with both directions: what this application consumes, and who consumes its topics — the second carrying **Revoke**, symmetric with product subscriptions |
| 6 | The workspace tab fetches with the environment and refreshes on the same tick as the standalone screen |
| 7 | The carry-over sentence is conditional on the product chosen below it |
| 8 | Save / New version / Promote are rendered disabled with the reason; *Deployment progress* is only drawn for an owner |
| 9 | `/apis` filters by kind, so nothing appears under two sidebar entries |
| 10 | `healthFor` counts *expected* (unrevoked) against *behind* (stale or on an old digest). `inSync` is false while any replica is behind, and the rate-limit arithmetic reads `/api/environments` live |
| 11 | Fixed, plus *1 binding **names** this certificate* |
| 12 | The query takes the newest revision per resource and orders by name and version |

### And the eight product changes asked for alongside them

- **Subscription key on by default, admin-only to change.** `DEFAULT_POLICY` attaches
  `auth.subscriptionKey` to every new API; `operations.ts` refuses any change to that one unit from
  a non-admin, and the block renders locked with the reason.
- **Backend client certificate is a policy.** The certificate picker lives in the `backendAuth`
  block and writes through the same save. The reference stays on the environment's binding: it is
  environment-scoped material, and moving it into the policy document would have changed the wire
  format for no gain.
- **The whole policy vocabulary is in the UI.** `PolicyForm` is driven by `meta.policyUnits`, so
  every unit the server has is offered, grouped identity / traffic / shape / backend / protocol. An
  unrecognised unit is preserved with a warning rather than dropped.
- **Replicas are administrator-only.** `target.public_url` is the reverse proxy, and it is the only
  address a consumer is shown — in the catalog, the playground's curl line and the portal's URL
  previews. `/api/meta` hands replica URLs to admins only.
- **Gateways is its own screen.** Health Status reports; Gateways adds, edits, pauses and removes,
  mints and revokes instance tokens, and refuses to remove a gateway that still has replicas or
  routes.
- **Circuit breaker and load balancing need a pool.** The routing rule appears at two members; the
  breaker and retries are refused below that, with the reason on the card.
- **Every catalog item is classified.** `shared/domains.ts` carries the taxonomy; the domain is the
  first segment of every published path. `PUT /routes` refuses an unclassified API and an address
  outside its domain, `PATCH` refuses to reclassify one that is already serving, and Kafka topics
  carry a domain too. `test/domains.test.ts` covers it.
- **"Integrations" is now "External systems".** Renamed rather than removed — the screen is the
  working simulated-external-systems console, not a slug.

### Two judgment calls worth stating

- *"circuit breaker and loadbalancing only when there is more than 2 backends"* is implemented as
  **two or more** members, since both are meaningless with one. If a threshold of three was meant,
  it is one constant.
- A gateway is still **one target per environment**, with the locality carried as a `label`. Two
  localities in one environment would mean two targets sharing an environment, which reaches
  `buildConfig`, the poll protocol and route uniqueness. Not attempted here.

---

## Residue left in the dev stack

Not cleaned up, because it costs nothing to reseed: throwaway APIs `badbackend v1` and
`idem-test v1`, a Kafka topic `orders.probe` from the membership probe, and the products and
subscriptions the checklist itself creates. The DEV trust anchor, the `gateway-client` certificate,
the TLS exception and the mTLS backend on `:9099` were all removed.
