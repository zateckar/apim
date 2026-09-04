# Integration Portal — how it works

**Which document this is.** This one describes what the application does today: the objects people
work with, the processes they move through, what refuses them and why, and what an operator has to
decide. It is written to be read by somebody who will never open the source, so it contains no file
names, no function names and no code. Where a mechanism matters to a user it is described as
behaviour — "a revision freezes the first time it is released" rather than a column.

**The other one.** [`greenfield-design.md`](greenfield-design.md) is the original architecture
proposal this product was built from: a target, written before any of it existed, and still the
source of the section numbers the plans cite. It describes what was intended. This document
describes what was built. Where the two disagree, this one is right about the product and that one
is right about the intent — and §13 lists every place they disagree on purpose.

The five delivery plans ([v1](mvp-plan.md), [v2](v2-plan.md), [v3](v3-plan.md), [v4](v4-plan.md),
[v5](v5-plan.md)) hold the implementation detail, the decision records and the review that followed
each one. This document points at them once, here, and then stays functional.

---

## Contents

1. [What this is](#1-what-this-is)
2. [Who uses it](#2-who-uses-it)
3. [The objects](#3-the-objects)
4. [The seven journeys](#4-the-seven-journeys)
5. [Signing in and being allowed](#5-signing-in-and-being-allowed)
6. [Policy](#6-policy)
7. [Validation](#7-validation)
8. [Promotion and environments](#8-promotion-and-environments)
9. [Traffic](#9-traffic)
10. [Trust and secrets](#10-trust-and-secrets)
11. [Operating it](#11-operating-it)
12. [Deploying it](#12-deploying-it)
13. [What is not here](#13-what-is-not-here)

---

## 1. What this is

An API management platform: a place where a team publishes an interface it owns, another team finds
it and subscribes to it, and a fleet of gateways sits in front of the traffic applying the rules
both of them agreed to.

It is two programs.

**The control plane** is the portal. It holds every decision anybody has made — which APIs exist,
what their contracts say, where they are routed, which policies are attached in which environment,
who has subscribed to what, which gateways are allowed to exist, which certificate authorities are
trusted, and every change anybody made. It serves the web interface, and it is the only thing a
person ever talks to.

**The gateway** is the data plane. It receives real traffic, applies the rules and forwards to the
backend. There are usually several, in each environment.

### The split, and what it means for you

The control plane owns desired state. **The gateway is a projection: it polls, and it never
decides.** A gateway holds no database, has no admin interface, and cannot be configured by
reaching it directly. Every so often it asks the control plane "what should I be running?", is
given one complete document describing everything it needs, and either applies all of it or keeps
what it had.

Four consequences follow, and they are the reasons for the split:

- **A control-plane outage is not a traffic outage.** A gateway that cannot reach the portal keeps
  serving from the last document it successfully applied, indefinitely. Nothing new can be
  published during the outage, but nothing already published stops.
- **Configuration is atomic and comparable.** The document has a fingerprint — its *digest*. Two
  gateways showing the same digest are running exactly the same rules. "Half the fleet has the new
  rate limit" is a state that cannot occur.
- **Publishing is asynchronous, and the portal says so.** Pressing publish records a decision; the
  gateways pick it up on their next poll. Every screen that shows a published thing also shows
  whether the fleet has caught up.
- **A gateway is cheap and disposable.** It can be started, stopped and multiplied without
  migrating anything, because it holds nothing that is not derived.

The document is the only contract between the two programs. Everything else — the database, the
job runner, the compilers, the web interface — is on one side of it, and the gateway has never
heard of any of it.

### What is not in the traffic path

Deliberately: the portal, the database, the job runner, the web interface, telemetry aggregation,
the audit log. A request arriving at a gateway is answered by that gateway using state it already
has in memory. The one exception is the *playground* (§4.5), where the portal calls a gateway on a
user's behalf — and it goes through the front door like any other caller.

---

## 2. Who uses it

Three kinds of people, and the third is a role rather than a different person.

**The owner** publishes and runs an interface. They upload its definition, decide where it is
routed, point it at a backend, attach policy, promote it up the chain, cut new versions and retire
old ones. Everything an owner does is scoped to the things their team owns.

**The consumer** calls an interface somebody else published. They browse the catalog, register an
application, subscribe to a product, hold a key, try a call from the portal, and watch their own
usage against the quota. A consumer needs no special role: any signed-in person is one.

**The administrator** does the things no team owns — the gateway fleet, estate-wide policy, the
trust store, the audit log, the user directory, and the promotion decisions that need a
platform-level judgement.

Most people wear the first two hats at different moments in the same day, and the portal is built
around that: the sidebar has an owner section and a consumer section, and the dashboard has a block
for each hat you actually wear.

### The one authorization rule

There is one, and everything follows from it:

> **You may change what your teams own. You may read everything. An administrator may change
> anything.**

A *team* is the unit of ownership. Every API, product and application belongs to exactly one team,
and being a member of that team is what allows you to change it. There is no per-object permission,
no role beyond member and administrator, no sharing, no delegation, and no "read-only member" — the
rule above is the whole model, and every screen's enabled or greyed controls are derived from it.

Two consequences are deliberate:

- **Reading is universal.** Anybody signed in can see every API, its contract, its policy and its
  status. Hiding the estate from the people expected to build on it is how catalogs die. What is
  not universally readable is *secrets*: subscription keys are visible only to a member of the team
  that owns the application holding them, and the audit log is admin-only.
- **Nothing you cannot do is hidden.** Controls you are not allowed to use are shown, disabled,
  with the reason beside them — "you are not in the team that owns this" — rather than removed. A
  control that vanishes teaches nothing; a control that explains itself teaches the ownership model
  in one glance.

An administrator's power is stated as an override rather than a separate world: an admin sees the
same screens with the same controls, and the reason text says so.

### A person with no team

This happens, and it is a defined state rather than an accident: somebody signs in whose identity
provider groups map to no team here, or whom an administrator has created but not yet placed.

They can do everything a consumer does *except* the parts that need ownership. Concretely: they can
browse the catalog, read every API and every contract, see the glossary and the guided tours, and
manage their own account and sessions. They cannot publish, and they cannot subscribe — because an
application belongs to a team, so there is nothing for a subscription to hang from.

The portal says this rather than failing at it: the empty states on the owner screens name the
situation ("you are not in a team yet") and point at the person who can fix it.

---

## 3. The objects

The vocabulary below is the vocabulary the interface uses. Every term here is also in the portal's
glossary, and every underlined word in the interface shows the same sentence.

### Publishing

**API** — one published interface, at one version: its definition, where it is routed, which
backend it forwards to, and the policies applied to it. It is the central object; almost every
screen is about one.

**Version** — a separate API that shares a name with its siblings. `petstore v1` and `petstore v2`
are two APIs, with their own routes, their own policies, their own backends and their own
subscribers, grouped under one family name in the interface. A consumer moves between them
deliberately, by calling a different base path. There is no header-based version routing and no
implicit "latest": versions are addresses.

**Revision** — one upload of an API's definition. Revisions are numbered, listed with their author
and a digest of their content, and **freeze the first time they are released**. Before a revision
has been released anywhere, correcting it in place is allowed and changes nothing anybody could
call. After it has been released, it is immutable and a correction is a new revision. This is the
line between "I am still drafting" and "somebody may be depending on this".

**Definition** — the contract a revision carries: an OpenAPI or Swagger document, a WSDL, an MCP
server's declared tools, or an A2A agent's card. The definition is what validation is derived from
and what a diff compares.

**Environment** — one stage of the chain: DEV, TEST, PROD. Each has its own gateways, its own
routes, its own backends, its own policies and its own subscription keys. An environment is a
boundary, not a label: nothing crosses one except by an explicit act.

**Route** — the host and base path an API answers on in one environment, per environment. `*` as a
host means any. Two APIs cannot occupy the same base path in the same environment, and the portal
refuses the second one at the moment it is written rather than at the moment traffic is confused.

**Backend** — the address the gateway forwards to once a request has passed every policy. It is
actually a *pool*: one or more addresses, a rule for spreading traffic across them (round-robin or
failover), and a circuit breaker per member. Backends are per environment and are edited in place —
DEV points at the development instance and PROD at the production one, and promotion does not carry
addresses between them.

**Release** — the act of making one revision the live one in one environment. Only a release that
has fully converged reaches the gateways, which is what makes "published" mean something: a release
that failed, or one that has not yet been applied, is visible as exactly that.

**Lifecycle** — whether a version is *active*, *deprecated* (still served, with a sunset date, and
every response carries a deprecation header) or *retired* (no longer served at all). Lifecycle is a
property of the version, not of an environment.

### Consuming

**Product** — a bundle of APIs that consumers subscribe to as one thing. Subscribing to a product
grants a key that works for every API in it. A product is how an owner decides what is offered
together; an API that is in no product is published but unsubscribable, and the portal says so on
the completion panel the moment it is published.

**Application** — the thing that calls an API: a service, a job, a mobile app. It belongs to a
team. Keys belong to an application, so revoking one stops that caller and nobody else.

**Subscription** — one application's access to one product in one environment. It carries the keys,
and it is the thing rate limits and quotas are counted against. Per environment, so a subscription
that works in DEV grants nothing in PROD.

**Key** — the secret a caller sends to identify its subscription. Every subscription can hold two
at once, which is what makes rotation possible without a moment where neither works: issue the
second, move callers across, retire the first. A key is displayed exactly once, at the moment it is
created, and is stored only as a hash afterwards — the portal cannot show it to you again, and says
so before it disappears.

### Policy and traffic

**Policy** — the set of controls attached to an API in one environment: who may call it, how often,
what is validated, what is cached, how long it may take, what is sent to the backend.

**Policy unit** — one control, attached or not attached. A unit is the smallest thing that can
independently exist, and everything inside it moves as one piece. **There is no half-on**: a unit
that is not attached is not running, and half a rate limit is never merged with the other half of
one. This is what makes the promotion merge and the global tier expressible without ambiguity.

**Global policy** — a unit attached to a whole environment rather than to one API. It applies to
every API in that environment unless that API attaches the same unit itself.

**Effective policy** — what the gateway actually runs for one API here: the environment's global
units, with the API's own units on top wherever both set the same one. Every value on an API's
policy page names where it came from.

### Operating

**Gateway** — a process that receives calls, applies the policy and forwards to the backend. The
portal knows about *targets* (one per environment and protocol family) and *instances* (the actual
processes reporting in against a target). Each instance holds a token; a revoked token stops that
instance at its next poll.

**Config document** — everything one environment's gateways need, rendered from what the portal
holds. A gateway applies all of it or keeps what it had.

**Digest** — a fingerprint of a document. Two gateways showing the same digest are running exactly
the same configuration; the Gateways screen shows every instance's digest against the fleet's
intended one, which is the whole answer to "has my change landed?"

**Trust anchor** — a certificate authority this environment's gateways trust, so an internal
backend with an internally signed certificate can be verified rather than have its check skipped.

**TLS exception** — a dated, admin-created permission to relax certificate checking for one
backend. It always expires. Registering the authority instead removes the need for it, and the
portal says so beside every exception.

**Certificate** — an identity the gateway *presents* to a backend that demands one. Distinct from a
trust anchor, which is what the gateway checks the backend *against*.

**Telemetry** — counts of calls per minute, reported by each gateway: how many were served, how
many the gateway refused, and how many the backend failed. Three numbers, never one (§9.6).

**Attention** — something the platform has noticed and can name, with a severity and a link to the
screen that fixes it (§11.3).

### Identity

**Account** — one person as this portal knows them, whichever directory authenticated them. An
account remembers who signed in, which teams they are in and what they have changed, which is why
an account is *disabled* rather than deleted.

**Team** — the group that owns things, described in §2.

**Member / administrator** — the two roles, described in §2.

**Identity provider** — the directory people sign in through. It owns their name, their credential
and their groups; the portal reads those and maps the groups to teams.

**Session** — one signed-in browser. It ends when you sign out, after a period of inactivity, or at
a fixed age, whichever comes first — and an administrator can end it sooner.

### How they hang together

An **API** belongs to a **team** and has many **revisions**; one revision at a time is **released**
into each **environment**, where the API also has a **route**, a **backend** pool and its own
**policy**. Several APIs are bundled into a **product**. An **application**, also owned by a team,
takes a **subscription** to a product in one environment, which holds up to two **keys**. A
**gateway** in that environment receives the call, checks the key against the subscription, applies
the effective policy, and forwards to the backend.

---

## 4. The seven journeys

These are the processes the product is actually for. The portal names the same seven on its *How
this works* page and walks each one as a guided sequence.

Each is described here as a process: who starts it, what it decides, what can refuse it and why,
and what state it leaves behind.

### 4.1 Publish

**Who** an owner. **Ends with** an API that exists, is routed in one environment, and is not yet
callable by anybody.

1. **Choose what kind of thing this is** — a REST API, a SOAP service, an MCP server or an A2A
   agent. The choice determines what the next step asks for and what the gateway will do with the
   traffic; it cannot be changed afterwards, because it decides what the contract means.
2. **Give it a name and a version.** The name groups versions together; the version is part of the
   address.
3. **Give it a definition.** Paste a document, upload one, or give a URL the portal fetches.
   For MCP and A2A there is no document to paste: the portal *asks the endpoint what it offers* —
   it speaks the protocol once, at publish time, and freezes what it heard. Discovery is the
   import.
4. **Say where it answers** — a host and a base path in this environment.
5. **Say what it forwards to** — one or more backend addresses.
6. **Review, and publish.**

**What can refuse it, and why:**

- *The definition does not parse, or uses a construct outside what can be validated.* Refused at
  upload, naming the construct. The alternative — accepting it and silently not validating those
  operations — creates a validation gap nobody can see.
- *The definition points somewhere else.* Remote references inside an uploaded document are
  refused. A contract that fetches half of itself from a third party at validation time is both a
  request-forgery vector and an availability dependency on somebody else's web server.
- *The backend address is not on the allowlist.* Backends are checked against an administrator's
  registered egress rules at the moment they are written, not at the moment they are called.
- *The base path is taken.* By another API in this environment.
- *The compiled contract is too large.* Every gateway downloads it, so the ceiling is enforced at
  import rather than discovered at poll time.

**What it leaves behind:** an API owned by your team, revision 1 released into DEV, a route, a
backend, and default policy. The completion panel names the address it now answers on, and says the
one thing people otherwise discover a day later: **nobody can subscribe until it is in a product.**

### 4.2 Promote

**Who** an owner, for DEV→TEST; an administrator's judgement is what stands behind a PROD release
(§8.4). **Ends with** the same contract live one stage further along.

1. **Choose the target environment.** The chain is fixed and configured once per deployment; the
   default is DEV → TEST → PROD.
2. **The portal computes a plan and shows it in words, before anything happens.** What will be
   created, what already exists and will be kept, what will be copied, and anything that would
   block it.
3. **Confirm.** What is applied is exactly what was shown — and if the world moved between the
   plan and the confirmation, the promotion refuses rather than applying something different.

**What travels and what does not** is the heart of it, and §8.2 gives the full rule. In short: the
*contract* travels; the *environment's own decisions* do not. Routes, backends, policy and
subscriptions belong to each environment and are edited in place there.

**What can refuse it:**

- *The revision has never reached the previous stage.* You cannot promote to PROD something that
  was never in TEST. The check is "has this revision at some point reached the predecessor" rather
  than "is it there right now", so a rollback still works after the chain has moved on.
- *The target has no route.* An API promoted into an environment where it has no address would be
  released and uncallable. The refusal names the blocker and links to the screen that creates it.
- *The target has no backend.* Same reasoning.

An administrator can bypass the chain, with a reason, which is recorded in the audit log and listed
in the governance report. The bypass exists because incidents exist; the reason requirement exists
because bypasses that need no explanation become the normal path within a quarter.

### 4.3 Version

**Who** an owner. **Ends with** two versions live side by side.

Cutting `v2` creates a new API sharing the family name. You choose what to carry over — the
definition, the policy, the route shape, the backends — and each carried item is a copy, not a
link: changing `v2`'s rate limit later does not touch `v1`.

Both versions appear under one family in the owner's list, each with its own base path and its own
"live in DEV / TEST / PROD" pills. Consumers subscribed to a product containing both can call
either with the same key.

The retirement path is the other half: mark `v1` *deprecated* with a sunset date, and every
response it serves — including its own rejections — carries a deprecation header and the sunset
date, so a consumer's tooling can see it without anybody reading an email. Later, mark it
*retired*, and it stops being served.

### 4.4 Subscribe

**Who** a consumer. **Ends with** a key.

1. **Find it.** The catalog is a search over every published API, MCP server and A2A agent, with
   full-text search, facets by kind, team and environment, and sorting.
2. **Read the listing.** What it is, what it costs you in quota, what it requires of you, and its
   contract.
3. **Subscribe.** You choose the application making the calls — creating one if you have none — and
   the environment.
4. **The key is shown once**, with a ready-made `curl` that already carries the host and the header
   name, and links to the three things you would do next.

**What can refuse it:**

- *The API is in no product.* There is nothing to subscribe to. The listing says so.
- *You are in no team.* An application belongs to a team, so there is nothing to hang the
  subscription from (§2).
- *The product is not available in that environment.*

**What it leaves behind:** a subscription in one environment, one key, a quota counter starting at
zero, and — the moment the gateways next poll — a caller the fleet will recognise.

### 4.5 Call it

**Who** a consumer. **Ends with** a real response, and a record of it.

The playground calls an API you are subscribed to, from the portal, through the gateway.

Three properties make it worth having rather than a toy:

- **The browser never sees a key and never composes a URL.** It posts an operation identifier and a
  subscription identifier. The portal resolves the route, injects the key server-side, and forwards.
- **It goes through the gateway, not around it.** The call meets every policy on the route: it
  spends the subscription's rate limit and quota, it is validated, it appears in telemetry. A
  console that bypassed the gateway would answer a question nobody asked.
- **The form and the send resolve the same route.** An operation the console offers is an operation
  the send accepts, and a refusal shown on the form is the refusal the send would have given.

The request is echoed back so you can see exactly what was sent — **minus the key**. Each call is
recorded in a bounded per-user history, and audited with its outcome and byte counts and **no**
body, header or query string, because a debugging console that logged request bodies would be a
credential store nobody designed.

### 4.6 Operate

**Who** an administrator. **Ends with** a fleet you can make statements about.

This one is continuous rather than a sequence, and §11 describes it in full. The shape of it:

- **The dashboard** answers "is anything wrong, and what do I do about it" in one screen, with a
  block per hat you wear.
- **Gateways** shows every instance: which target it belongs to, when it last reported, what digest
  it is running against what the fleet should be running, and whether anything is blocking it from
  activating.
- **Trust** holds the certificate authorities each environment's gateways trust, the client
  identities they present, and every TLS exception with its expiry.
- **Audit** is the append-only record of who changed what.
- **Users and Teams** is the directory — which is journey seven.

### 4.7 Let somebody in

**Who** an administrator. **Ends with** a person who can do their job.

1. **They get an account.** If they sign in through the identity provider, the account is created
   the first time they arrive — nobody creates it for them. If the deployment uses local accounts,
   an administrator creates one and the person chooses their own password at first sign-in.
2. **Put them in a team.** Membership is what lets somebody publish and change; it is not a label,
   and there is nothing else to grant (§2).
3. **Or let the directory do it.** A team can name the identity-provider group that fills it, and
   everybody arriving with that group is a member for as long as they carry it.

The thing to understand before doing this is that **membership can arrive two ways**, and the
difference is visible on every row (§5.4). A membership granted here survives what the directory
says; one that came from a group is replaced by whatever the group says next.

**What can refuse it:** the last enabled administrator cannot be disabled or demoted, and nobody can
disable or demote themselves (§5.6).

**What it leaves behind:** an account that resolves its teams and its role on every request, so the
change is in effect on the person's next click rather than at their next sign-in.

---

## 5. Signing in and being allowed

### 5.1 Three providers, and which to use

A deployment declares which sign-in methods exist, as an ordered list. There is **no default**: a
deployment that does not declare them does not start, and the error names the setting and its three
legal values. This is the one place a fallback would be catastrophic — a deployment that forgot the
setting must not quietly get a bypass.

**Local** — usernames and passwords held by the portal itself. For deployments with no corporate
directory, for air-gapped test environments, and as the way back in when the identity provider is
misconfigured. A portal that cannot be signed into without an external directory cannot be
evaluated and cannot be recovered.

**OIDC** — a real identity provider (Keycloak is what this was built and tested against). The
provider owns names, credentials, group membership and multi-factor; the portal reads what the
token says and maps it. For any deployment that has a directory, this is the answer.

**Dev** — a development bypass: a short list of fixed identities you can become with one click, no
credential at all. It exists so the product can be run and demonstrated on a laptop. It has to be
named explicitly to exist, it cannot be combined with OIDC, and the sign-in screen shows it behind
a loud warning, because a bypass that looks like a feature is a bypass that reaches production.

Local and OIDC can be enabled together, and the sign-in screen shows both in the order declared.
That combination is the realistic one: single sign-on for people, plus a small number of local
administrators for the day the directory is unreachable.

### 5.2 Signing in locally

Username and password. The password is stored as a memory-hard hash and never logged, never
returned by any endpoint, and never visible to an administrator.

Four protections, and what each is actually for:

- **Every refusal is identical.** Wrong username, wrong password, an account with no password set,
  and a locked-out account all produce the same status, the same message and the same shape. The
  portal's own audit log records which of the four it was; the person at the keyboard learns
  nothing they could use to enumerate accounts.
- **Per-account lockout.** After a threshold of consecutive failures the account is locked for a
  period. This stops one account being ground down.
- **A global rate limit in front of the hashing.** A memory-hard hash is expensive on purpose, which
  means a flood of sign-in attempts is a denial-of-service vector against the portal itself, even
  with every attempt failing. The limiter sits *before* the hash and applies across all callers, so
  a flood is refused cheaply. It will refuse a valid credential during a flood, and that is the
  intended trade: the alternative is the portal falling over.
- **Forced password change.** A password an administrator set is a password an administrator knows.
  Any account created or reset by an administrator must change its password at first sign-in, and
  until it does, the session can do exactly three things: read who it is, change its password, and
  sign out. Everything else refuses with a message naming the reason and linking to the screen.

**The bootstrap administrator** exists so a fresh deployment has a way in. If local sign-in is
enabled and the directory is empty, the portal creates one account from a username and password
given in the environment, marked must-change. Once any local account exists it is never created
again — so it is a way in, not a permanent back door, and the forced change is what makes it safe
to pass a first password through the environment at all.

**There is no password reset by email**, because this product has no mail transport. A forgotten
password is an administrator reset, and the reset forces a change, so the administrator never learns
the password the user ends up with.

### 5.3 Signing in through an identity provider

The portal owns the whole exchange. **The browser never sees a token** — not the identity token,
not the access token, not the refresh token. The browser gets a session cookie, the same one local
sign-in produces, and everything else happens between the portal and the provider.

What happens, in order:

1. **At startup**, the portal reads the provider's discovery document and learns its endpoints and
   its key set. A provider that declares a different issuer than the one configured is refused; an
   endpoint outside the egress allowlist is refused. This happens at boot, so a misconfigured
   provider is a startup failure rather than a sign-in failure discovered by the first user.
2. **The user presses sign in.** The portal generates a one-time value bound to a short-lived
   cookie scoped to the callback path alone, and a proof-of-possession challenge whose secret half
   never leaves the portal. It redirects to the provider.
3. **The provider authenticates the person** — with whatever it requires, including multi-factor —
   and redirects back with a code.
4. **The portal checks the callback before spending the code**: the one-time value must match the
   cookie, must still exist server-side, and must not have expired. A replay finds nothing, because
   the record is deleted before the exchange rather than after it.
5. **The portal exchanges the code** for tokens over its own connection, proving possession of the
   challenge's secret half.
6. **The portal verifies the identity token**: its signature against the provider's published keys,
   plus the issuer, the audience, the expiry, the not-before, and the one-time value it embedded in
   step 2. All six. A token that fails any of them is refused with one message that does not say
   which — the portal's log says which.
7. **The portal resolves the account** and issues its own session.

The signature check is worth naming because it is the common shortcut: the exchange in step 5 was a
connection the portal itself opened over TLS, so it is tempting to trust what came back without
checking. This one checks anyway. The measured cost is nineteen microseconds per sign-in.

### 5.4 How roles and teams arrive

The portal reads two things out of the token: a **role claim**, which decides whether this person is
an administrator here, and a **group claim**, which decides which teams they are in. Both are
configurable paths, because directories disagree about where they put things.

**Groups map to teams by name.** A team can declare the directory group that fills it. The match is
case-insensitive and accepts either the whole group path or its last segment, because Keycloak
group paths look like `/apim/orders` and people configure them both ways.

**Teams are matched, never created.** A group with no matching team maps to nothing, and the
unmatched group names are shown to administrators on the Teams screen — so "half my department
cannot see anything" has a visible cause and a one-click fix, instead of being invisible.

**Some directories scope their roles per application**, and say so in one claim rather than two: a
map from a role to the applications the person holds it for. In that arrangement the *applications*
are what teams are matched on and the *roles* are what the administrator check reads, and the portal
reads the one claim both ways round rather than asking a deployment to duplicate it.

Two consequences of reading it that way, both deliberate:

- **Holding any role for an application is membership of the team that application maps to.** Teams
  here have members and administrators and nothing between, so a directory that tells a reader from
  a developer for the same application cannot say so through this. If that distinction has to
  survive, it survives as two teams.
- **The administrator role names one role, and it means the whole portal** — every team, the fleet,
  the trust store, the audit log, the directory. Where each application has its own admin role, the
  right answer is the platform team's; naming one that many applications carry would make every one
  of their administrators a portal administrator.

**A group claim that carried nothing is reported as itself.** Point the claim at a path the
directory does not use and everybody signs in perfectly well, is in no team, and owns nothing — with
no unmatched group to report, because there was no group. That is indistinguishable from "these
people have not been granted access yet", and it sends an administrator to look in a directory that
is not wrong. So the portal tells the two apart and says which one happened, on the account page of
the person who is stuck.

**Two kinds of membership, and the difference is on the row.** A membership either came from the
directory or was granted here by an administrator. On every re-read, the directory-sourced
memberships are replaced wholesale by what the token now says; locally granted ones are never
touched. A user's teams are the union of both. Every membership displays its provenance — "from
group `/apim/orders`" or "granted by alice on 4 September 2026" — because that is the question an
auditor actually asks, and because two sources of truth about one fact are much worse hidden than
named.

**Administrator is two flags, and the portal distinguishes them.** One is set by the token; one is
authored here. Somebody can be an administrator because the directory says so, because an
administrator here said so, or both — and the user's page says which. Removing a role in the
directory therefore cannot silently leave a locally granted administrator in place without anybody
being able to see it.

### 5.5 Staying signed in, and stopping being signed in

**A session ends three ways**: you sign out, you are idle past the inactivity window, or the session
reaches its maximum age. Whichever comes first.

**Roles and teams are resolved live, on every request.** The session records what they were at
sign-in — that is the audit trail — but nothing is *decided* from that snapshot. An administrator
who removes somebody from a team has removed them as of the next request, with no invalidation
machinery to get wrong and no "sign out and back in again".

**Claims are re-read on a bounded interval.** For an OIDC session, the portal periodically uses the
refresh token to ask the provider for a fresh identity token, and re-derives roles and teams from
it. So a group removed in Keycloak takes effect within that interval without the user signing out.
The re-read is single-flight per session, so a burst of requests produces one call to the provider.

What happens when the re-read fails matters, and the two cases are treated differently:

- **The provider says no** — the refresh token was revoked, the account was disabled or deleted
  there. The session is revoked immediately and the user is signed out. Credential revocation
  always fails closed.
- **The provider cannot be reached** — it is down, or the network is broken. The request is refused
  with a "the sign-in service is unavailable" answer, and the session is *not* destroyed. A
  provider outage must not log out every user in the building, because when it comes back they
  would all sign in at once against a service that is already struggling.

**Sign-out** clears the session and, if the deployment asks for it, hands the browser on to the
provider's own end-session endpoint, so signing out of the portal signs you out of everything
behind that provider. The portal also tells the provider to revoke the refresh token it was
holding, so the claim re-read cannot outlive the session.

**Everybody can see their own sessions** — when each started, when it was last used, and roughly
what browser it is — and can end any of them, or all of the others at once. An administrator can
end somebody else's, which is what "this laptop was stolen" needs.

### 5.6 Managing accounts

An administrator can create local accounts, set display names and email addresses, grant and remove
the administrator role, grant and remove team membership, reset passwords, force sign-outs and
disable accounts.

Two things it deliberately refuses:

**It does not delete people.** The audit log, every revision and every release names the person who
made it, and the audit log is append-only by construction. An account is *disabled* — it cannot
sign in, its sessions end, and it stays visible as the author of what it authored. A directory that
can erase the person who did the thing cannot answer the question the audit log exists for.

**It does not edit a directory-owned field.** For an OIDC account, the display name, the email and
the directory-sourced groups belong to the provider. The portal shows them, marked as coming from
there, and the edit controls are absent with the reason stated. Letting an administrator type a
different name here would produce a value that silently reverts at the next claim re-read.

Two rules protect against locking everybody out, and their order is deliberate:

- **The last enabled administrator cannot be disabled or demoted**, whoever is asking. The message
  names the situation and says what unblocks it: make somebody else an administrator first.
- **You cannot disable or demote yourself** — ask another administrator.

The last-administrator rule is checked *first*, because when the sole administrator is also the
person asking, telling them to "ask another administrator" is advice to go and talk to somebody who
does not exist.

### 5.7 What an unauthenticated caller can learn

Before you have a session, the portal will tell you exactly one thing: which sign-in methods exist
and what to call them (and, if the development bypass is on, who you may become). Everything else —
including the metadata endpoint the interface reads at startup, which carries every gateway address
the playground might use — requires a session.

---

## 6. Policy

### 6.1 What a policy is

A policy is a set of **units** attached to one API in one environment. It is a closed, declarative
vocabulary — not a programming language. There are no expressions, no scripts, no templating engine
evaluated at request time, and no URL an owner writes that the gateway will fetch. Every external
thing a policy refers to — an issuer, a shared secret, a token provider, a client certificate — is
referred to *by name*, and the name resolves through a registry only an administrator can write.

That constraint is the whole security model of the policy layer. An owner can express "require a
JWT from the corporate issuer"; an owner cannot express "fetch this URL", "run this expression", or
"trust this key I am pasting in".

Unknown units and unknown fields are rejected when written. Nothing passes through unread, so a
policy that appears to be configured always is.

### 6.2 The vocabulary

Twenty-three units, in five groups. Each is attached or not attached; there is no third state.

**Identity — who is allowed to call this**

| | |
|---|---|
| Subscription key | Attached means a key is required. Absent means the route is open |
| Basic authentication | Against a registered shared secret, compared in constant time |
| JWT | Verified against a registered issuer's published keys, with that issuer's algorithm allowlist, audience and scopes. Per-operation scope requirements are part of it |
| Token introspection | Asks the registered issuer whether a token is still live, with a cache whose lifetime is exactly how stale a revocation may be |
| Client certificate | Reads the certificate a trusted reverse proxy verified and passed on. The gateway refuses to activate a configuration using this unless a trusted-proxy boundary is configured, because otherwise the headers are attacker-controlled |
| IP allowlist | Address ranges the effective client address must fall inside |
| Preconditions | Ordered deny rules on headers and query parameters, each with the status and body it answers with |

**Shape — what the request and response look like**

| | |
|---|---|
| Validation | Against the API's own definition. §7 |
| CORS | Preflight and response headers, added to the gateway's own rejections too, so a browser sees a 401 rather than an opaque failure |
| Rewrite | Strip the base path, rebuild the path from the matched operation, set or remove query parameters |
| Request headers | Remove, then set, then append — and strip the inbound credential |
| Response headers | The same, on the way out |
| Transform | Body transformation, including SOAP-to-JSON |

**Traffic — how much of it**

| | |
|---|---|
| Rate limit | Calls per short window, per subscription, counted per gateway instance |
| Quota | Calls per long window, per subscription, counted across the fleet |
| Response cache | Keyed on route, method, path and the declared vary headers |

**Backend — what happens on the way to it**

| | |
|---|---|
| Timeout | How long one upstream exchange may take |
| Retries | How many, and against which conditions — each attempt goes to the *next* pool member |
| Circuit breaker | When to stop trying one pool member |
| Concurrency limit | How many requests to this route may be in flight on one instance at once |
| Backend credential | Inject what the backend requires: a registered secret, a token from a registered provider, or a signature |

**Protocol — what this route fundamentally is**

| | |
|---|---|
| Streaming | Turn this route into a byte stream rather than a request/response exchange |
| Error format | What the gateway's own refusals look like — a problem document, a SOAP fault, or a JSON-RPC error — derived from what kind of API this is |

### 6.3 Two tiers, and which one wins

An environment can carry **global** units, attached by an administrator, applying to every API in
it. Seventeen of the twenty-three units may be attached globally. Six may not: rewriting,
transforming, caching and backend credentials each describe one specific contract and one specific
backend; the error format is derived from what kind of API this is; and streaming changes what a
route *is*. None of the six means anything estate-wide.

This is an allowlist rather than an exclusion list, so a unit added later is not globally
attachable until somebody decides it should be.

The merge rule is one sentence: **the API's own unit replaces the global one entirely.** Not merged
field by field — replaced. A rate limit set globally and a rate limit set on the API produce the
API's rate limit, not a blend of the two.

The global tier is deliberately the weaker side of every conflict, and one more property is what
makes it survivable: **every value on an API's policy page names where it came from.** Without that,
"why is this API rate limited to ten a second" stops being answerable from the API's own page, and
that is precisely what makes estate-wide policy hated wherever it exists.

Global units are never promoted. Attaching one in DEV changes nothing in TEST.

### 6.4 Per-operation overrides

Five units — validation, rate limit, quota, timeout and cache — can be overridden for one operation
within an API. That covers the real cases: one expensive report endpoint with a longer timeout, one
write endpoint with a tighter limit, one enormous upload with different validation.

The identity units are deliberately not overridable per operation: route-level authentication has
already run by the time the operation is known, and letting an operation redefine who may call it
would create a rule that appears to be enforced and is not.

### 6.5 Ordering is part of the contract

The stages a request passes through run in a fixed order (§9.1), and that order is a compatibility
promise rather than an implementation detail. Two orderings are constraints:

- **Validation and preconditions run after authentication**, so unauthenticated traffic cannot
  consume validation effort or trigger a precondition's side effects.
- **Inbound credential stripping runs before backend authentication**, so a route cannot forward the
  caller's credential alongside the one it is supposed to inject.

---

## 7. Validation

### 7.1 Where it comes from

Validation is derived from the API's own definition — the OpenAPI document, the WSDL's inline
schemas, an MCP tool's declared input schema, an A2A skill's declared shape. Nobody writes
validation rules; the contract is the rules.

Importing a definition **compiles** every operation's schemas into one bundle, addressed by a
fingerprint of its own content. Compilation happens once, in the portal, at import. A gateway
downloads the bundle by fingerprint and caches it, and never parses a specification.

### 7.2 The three states

| | |
|---|---|
| **Blocking** | An invalid request is refused, naming what failed, before the backend is called |
| **Warning** | The request is forwarded. A sample of traffic is validated afterwards, off the request path, and what fails is counted and reported. Nothing is ever refused |
| **Disabled** | Not looked at |

Requests and responses are configured separately: blocking requests and disabled responses is the
common shape.

### 7.3 The absence of a unit is not "off"

This is the one unit whose absence means something other than "not running". An API with no
validation unit attached validates **at the defaults**, and the default is blocking.

The reasoning is that the alternative is a trap. Every other unit is a control somebody chose to
add; validation is a property the contract already has. An API published with a definition that
says a field is required, which then forwards a request without that field because nobody thought
to attach a unit, is not a configuration — it is a mistake that looks like a configuration.

**Downgrading below blocking requires a reason.** The reason is recorded, audited, shown on the
API's policy page, and listed in the governance report. Downgrades are legitimate — a legacy
backend that has always accepted sloppy input, a specification that is wrong — but they should be
decisions with names on them.

### 7.4 What is always checked

In all three states, one block of checks still runs: the content type, the maximum body size, the
maximum nesting depth, and duplicate keys. These are not contract checks; they are the bounds that
stop a malformed body from being expensive to look at, and there is no state in which they are
skipped.

### 7.5 A validator the gateway cannot fetch never activates

If a configuration references a compiled bundle that a gateway cannot download, **that gateway does
not activate the configuration at all.** It keeps serving the previous one and reports why, and the
Gateways screen shows it as blocked with the reason.

The alternative would be to activate the configuration and skip the validation it could not fetch —
which is a validation gap that opens silently, in production, at a moment nobody was watching. This
is the one place the product prefers "stale but correct" over "current but partial", and it is why
the bundle size ceiling is enforced at import: a bundle too large to fetch is a fleet that cannot
converge, and refusing the import is the only place that can be prevented.

### 7.6 Cost, and why warning mode is bounded

Blocking validation must buffer the body before it can look at it, which costs memory proportional
to the body size times the number of concurrent requests. There is a budget for that, and past it a
request is **shed** with a "try again" answer rather than let through unvalidated. Failing closed
under memory pressure is the only choice consistent with §7.3.

Warning mode's asynchronous work has a bounded concurrency and a bounded queue. Past the queue,
samples are dropped and the drop is counted, so "validation is not keeping up" is a number rather
than a mystery.

---

## 8. Promotion and environments

### 8.1 The chain

Environments are ordered — by default DEV, then TEST, then PROD — and the order is configured once
per deployment. The order is the gate: a release into an environment is allowed only if the same
revision has, *at some point*, reached its predecessor.

"At some point" rather than "is there now" is deliberate. If PROD is on revision 7 and TEST has
moved on to revision 9, rolling PROD back to revision 6 must still be possible; a gate that
demanded the predecessor currently hold revision 6 would forbid exactly the operation an incident
needs.

### 8.2 What is promoted and what is edited in place

**The contract travels. The environment's own decisions do not.**

| Travels with a promotion | Belongs to the environment, edited in place |
|---|---|
| The revision — the definition and everything compiled from it | Routes: the host and base path here |
| | Backends: the addresses here |
| | Policy: rate limits, quotas, timeouts, validation states here |
| | Subscriptions and keys |
| | Trust anchors and TLS exceptions |
| | Global policy |

So a rate limit can be changed in PROD without a release, and a PROD backend address is never
overwritten by a DEV one. Contracts are the opposite: a revision freezes on first release, so "the
thing that is live in PROD" is exactly the thing that was tested in TEST.

Policy does get a small amount of help across the boundary, and its rule is precise: the promotion
merge **creates units the target does not have, never overwrites units it does have, and never
propagates a deletion.** So attaching a new precondition in DEV and promoting brings it along;
tightening an existing rate limit in DEV does not silently retighten PROD's; and removing a unit in
DEV does not remove PROD's.

### 8.3 The plan

A promotion is shown before it happens. The plan is computed from the current state of both
environments and rendered in words: what will be created, what already exists and will be kept,
what will be copied, and any blocker.

Two properties make this more than a confirmation dialog:

- **What is applied is what was shown.** The plan is recorded, and the work recomputes it at the
  moment it runs. If the world moved in between — somebody deleted the target's route while you
  were reading — the promotion refuses rather than applying something you did not see.
- **A blocker is named, with a link.** "TEST has no route for this API" with a link to the screen
  that creates one, rather than a failed job and a stack trace.

### 8.4 The PROD gate

A PROD release needs no second person. The gate is the chain plus the administrator-only,
reasoned, audited bypass. This is a deliberate limitation rather than a claim: multi-party approval
is a workflow feature this product does not have (§13), and a fake approval step nobody enforces is
worse than an honest gate.

### 8.5 Divergence is reported, not prevented

Because policy, routes and backends are per-environment and editable in place, environments drift.
DEV ends up with a precondition PROD has never had; PROD ends up with a rate limit ten times DEV's,
because that is what PROD needs.

The product **reports** that rather than preventing it. Every API page shows what is live where,
with each environment's state beside the others, and the promotion plan names what differs at the
moment somebody actually cares. Preventing divergence would mean forcing PROD's limits to equal
DEV's, and the whole reason environments exist is that they are not the same.

Automatic drift detection between what the portal intends and what a gateway is actually running is
out of scope (§13); the digest comparison on the Gateways screen is the honest subset of it, and it
covers the case that matters — a gateway not running what it was told to.

---

## 9. Traffic

### 9.1 What a request meets, in order

A request arriving at a gateway passes through these stages, in this order. Each can answer, and
if it does, the ones after it do not run.

| | Stage | What it can answer |
|---|---|---|
| 1 | Route match — host, base path, method, path template | 404 if nothing matches |
| 2 | Proxy context — the real client address, the verified client certificate | |
| 3 | Always-on limits — content type, body size | 413, 415 |
| 4 | IP allowlist | 403 |
| 5 | CORS preflight | 204, immediately |
| 6 | Authenticate — key, basic, JWT, introspection, client certificate | 401 |
| 7 | Authorize — is the subscription live, does its product contain this API, does the token carry the scope this operation needs | 403 |
| 8 | Rate limit | 429, with a retry-after |
| 9 | Quota | 403 |
| 10 | Preconditions | whatever the rule declares |
| 11 | Operation resolution — including the SOAP action scan | 400 |
| 12 | Request validation, blocking only | 400, naming what failed |
| 13 | Rewrite — path and query | |
| 14 | Request headers — remove, set, append, strip the inbound credential | |
| 15 | Request body transform | |
| 16 | Cache lookup | the cached response |
| 17 | Backend selection — pool member, load balancing, failover, backend TLS | 503 if every member is open |
| 18 | Backend authentication — inject the credential | |
| 19 | Proxy — with the timeout, the retries and the breaker | 502, 504 |
| 20 | Response body transform | |
| 21 | Response headers, including CORS | |
| 22 | Backend credential invalidation, on the statuses that mean "that token is stale" | |
| 23 | Cache store | |
| 24 | Count it, log it — and hand a sampled body to warning-mode validation, off this path | |

A streaming route (§9.5) runs stages 1–14 on the upgrade and then hands the connection to a byte
copier; stages 15–23 do not exist for it.

### 9.2 Rate limit arithmetic

A rate limit is **per gateway instance**. Two instances in an environment mean a subscription can
make twice the configured number in total.

This is a deliberate trade, and it is stated in the interface next to every rate limit rather than
buried here. Per-instance counting needs no coordination, so it costs nothing per request and
cannot fail; fleet-wide counting needs a shared counter in the traffic path, which is a new
dependency, a new failure mode and a new latency cost on every single call. The portal shows the
arithmetic — the configured number, the instance count, and the product — so the ceiling anybody
actually gets is a number on the screen rather than a surprise.

### 9.3 Quota arithmetic

A quota is **fleet-wide**, over a long window — a day, a month. Each gateway counts locally and
reports its deltas to the portal on the poll it was already making; the portal aggregates and hands
the fleet total back on the next poll. So each instance decides using its own local count plus the
last total it was given.

The consequence is exact and worth stating: **a quota can be exceeded by up to one flush interval's
worth of traffic across the fleet.** That interval is configurable, and it is the recovery-point
objective of the quota system — a lost flush is what a quota can be behind by. Quotas are for
protecting a backend from a runaway consumer and for commercial fair use, and both survive that
window. A quota that must be exact to the request is not what this mechanism is.

### 9.4 Backends are pools

A backend is one or more addresses with a rule for spreading traffic — round-robin or failover —
and a **circuit breaker per member, per gateway instance**.

Per instance is deliberate: one gateway's connectivity fault cannot trip the whole fleet away from a
backend that is fine for everybody else. The cost is that a genuinely dead backend is discovered
independently by each instance.

Retries go to the *next* member rather than retrying the same one, and are only attempted for
methods where a retry is safe. With every member open, the route answers "service unavailable" in
its own error format, and the outcome is recorded distinctly, so "the pool is open" never has to be
inferred from a rise in 503s.

### 9.5 Streaming

Server-sent events and WebSocket upgrades are supported, and the rule is: **streaming is bytes, not
messages.**

A WebSocket upgrade runs the entire request-side pipeline first — key, authorization, limits, quota,
IP rules, preconditions. After the upgrade, bytes are copied and bounded in bytes, seconds and idle
time, never per message. The gateway does not parse frames, does not validate them, and does not
count them.

That is why the exclusion is enforced **when the policy is written** rather than discovered at
runtime: a streaming route may not also validate requests, transform bodies or cache. After the
upgrade there are frames rather than requests, and nothing in the contract describes them, so those
units could not do what their names promise.

Streams also hold their resources for their whole life, so there is a separate ceiling on
concurrent upgrades per instance, on top of each route's own.

### 9.6 Three numbers, never one

Every surface that reports traffic reports three counts, and refuses to collapse them:

- **Served** — the gateway answered, having applied the rules. This *includes* a cache hit, a
  completed stream, and a JSON-RPC error response. The server answered; sometimes the answer was no.
- **Refused by the gateway** — a 401, a 403, a 429. The rules worked.
- **Failed at the backend** — a 502, a 504, a 500 the backend produced. Something is wrong upstream.

A 429 the gateway produced and a 500 the backend produced are opposite signals: the first says the
platform is doing its job, the second says something is broken. Adding them into one "errors" number
destroys the only distinction that tells an operator whether to act.

A caller that hangs up is counted separately again, as its own outcome — abandoned requests must not
inflate the count of backends that were slow.

### 9.7 One slow backend cannot take the others with it

A timeout bounds how long one request waits. It does not bound **how many** are waiting: in-flight
work settles at roughly the arrival rate times the timeout, so a backend that goes from 50ms to 30
seconds turns a comfortable hundred requests a second into three thousand parked requests on a
process that is otherwise idle.

So there are two ceilings — one per route and one per instance — and at a ceiling requests are
**shed** immediately with a retry-after rather than queued. Shedding is the honest answer: a queued
request that will time out anyway has consumed a slot, a socket and the caller's patience for
nothing.

The gateway also refuses to start unless the runtime's own outbound request queue is at least as
wide as its instance ceiling. Left at its default, that queue is shared by every route, has no
fairness and no shedding — so one saturated route would delay every other route on the process,
which is precisely the failure the ceilings exist to prevent.

A route with no concurrency ceiling attached is **warned about** in the policy editor, with the
arithmetic, because the trap is invisible right up until it is not.

### 9.8 A caller that leaves takes its upstream call with it

When a client disconnects, the gateway aborts the request it had in flight to the backend rather
than letting it run out its timeout. The sockets and the concurrency slot come back immediately.
This matters most under exactly the conditions where it is hardest to notice: a slow backend, a
retrying client, and a pile of abandoned upstream work nobody is waiting for.

### 9.9 Protocols other than REST

**SOAP.** The gateway resolves the operation by scanning a bounded prefix of the envelope, and
checks that the declared action agrees with the body — a disagreement is a routing and authorization
bypass, so it is a refusal. Validation is against the WSDL's inline schemas. Every refusal is
returned as a **SOAP fault** carrying the real status, not as a JSON problem document, because a
SOAP client cannot read one.

**MCP.** An MCP server is published by asking it what tools it offers; that answer is frozen as a
revision. Calls are proxied with the protocol's session handling intact. A tool the server never
declared is refused, and arguments the tool's own declared schema rejects are refused before the
server is reached. Refusals are **JSON-RPC errors** with the right codes — a gateway that answered
an MCP client with a problem document would have broken the protocol it claims to speak.

**A2A.** An agent is published by reading its card. The gateway serves that card **rewritten to
point at the gateway** — its address and its security schemes are the gateway's — without requiring
a key, because discovery has to be open. That rewrite is the entire reason publishing an agent
differs from proxying one: an agent that follows this card brings a subscription key and arrives at
every policy on the route.

---

## 10. Trust and secrets

### 10.1 Subscription keys

Generated by the portal, shown once, stored as a hash. The gateway receives the hashes in its
configuration document and compares, so a gateway holds no key it could leak. Two keys per
subscription make rotation possible without a gap. Revoking a key takes effect at the next poll,
which is seconds, and revocation is one of the things the product deliberately makes fail closed.

### 10.2 Client identities the gateway presents

Some backends demand a client certificate. Those identities are registered by an administrator,
encrypted at rest, and fetched by a gateway on demand rather than shipped in the configuration
document to every gateway that does not need them.

### 10.3 Verifying backends

The gateway verifies backend certificates. That statement is worth the two mechanisms it takes to
make true in an organisation whose internal services are signed by an internal authority.

**Trust anchors** are the right answer. An administrator registers the certificate authority that
signed the internal backends, in one environment. Within one poll, every gateway in that
environment verifies those backends — **with no exception, and with nothing turned off.**

Four properties:

- **Per environment, and never promoted.** Registering an authority in DEV changes nothing in TEST
  or PROD. Copying it there is an explicit act with its own plan, because trusting an authority in
  PROD is a PROD decision.
- **Union with the system roots**, so trusting an internal authority does not untrust the public
  ones.
- **Expiry is honoured even out of stale configuration.** An anchor past its own validity is dropped
  by the gateway regardless of what the last-good document says.
- **The portal's own outbound fetches use the same anchors** — importing a specification from an
  internal host, discovering an internal MCP server. So an internal endpoint with an internal
  certificate is importable without anybody turning verification off anywhere.

**TLS exceptions** are the wrong answer, kept because reality intrudes. An exception relaxes
checking for one backend, is administrator-only, requires a reason, **always has an expiry**, is
capped at a maximum length configured by the deployment, appears on the dashboard as something
needing attention while it is live and again as it approaches expiry, and is listed in the
governance report. The interface says, next to every one, that registering the authority removes the
need for it.

One honest limitation: an exception binds on the next connection to that backend rather than
instantly, because the runtime owns its connection pool. The window is one idle timeout, and the
interface says so beside the exception rather than leaving somebody to discover it.

### 10.4 What the gateway is not allowed to be pointed at

Backends are checked against an administrator-registered egress allowlist — host patterns, address
ranges, ports and schemes — **when they are written**, not when they are called. Link-local and
cloud-metadata ranges are denied. Addresses are resolved and pinned per request against rebinding.
Redirects are never followed.

The same rule covers every outbound fetch the portal makes on a user's behalf: importing a
specification from a URL, discovering an MCP server, reading an agent card, and the playground's
call to the gateway. Moving a URL from a policy field to a different field does not make it safe;
the allowlist does.

### 10.5 Instance tokens

Each gateway instance holds a token proving it is allowed to exist. Tokens are minted by an
administrator, delivered as a file rather than a command-line argument, and can be revoked — after
which that instance stops serving at its next poll.

This is the second thing that fails closed. Configuration staleness never fails closed: a gateway
out of contact keeps serving. Credential revocation always does: a gateway whose token was revoked
stops. The distinction is deliberate — the first protects against a control-plane outage becoming a
traffic outage, and the second means "shut that instance down" is a thing an administrator can
actually do.

### 10.6 What is encrypted

Everything the portal holds that would be dangerous in a database backup: subscription key material,
the private halves of client identities, backend credentials, and the refresh tokens held for OIDC
sessions. All encrypted at rest under a key held outside the database, which is one of the two files
a deployment must back up and must not lose (§12.5).

---

## 11. Operating it

### 11.1 The fleet

The portal knows a **target** per environment and protocol family, and the **instances** reporting
in against it. There is a ceiling on instances per target, so a misconfigured deployment loop
announces itself instead of silently multiplying.

The Gateways screen answers three questions: is every instance reporting, is every instance running
the digest it should be, and is anything blocking one from activating. An instance that has stopped
reporting for longer than expected is flagged; an instance running an older digest is flagged; an
instance that has downloaded a configuration but refused to activate it (§7.5) is flagged **with the
reason**.

### 11.2 Telemetry

Counted on each gateway, reported on the poll it was already making, aggregated per minute by the
portal, and pruned after a short window.

It is bounded four ways, so the number of rows the portal can be made to hold is arithmetic rather
than a hope: how many distinct series one gateway may count, how many minutes one report may carry,
how large one report may be, and how many reports one instance may lodge for one minute. Every drop
is counted. Past the series ceiling, new keys fold into an overflow bucket rather than vanishing —
"we stopped counting these" is itself a number.

Retention is short by design: this is an operational signal, not a data warehouse. There is no
metrics or log shipping to an external system (§13), and the report a deployment gets is the one in
the portal.

### 11.3 Attention

**One evaluator decides what needs attention, and every screen reads it.** The dashboard, each API's
page and each subscription's page all ask the same set of rules, so a blocker cannot appear on one
screen and not on another.

Each finding carries three things: a severity — blocker, warning or information — a sentence in
plain words, and a link to the screen that fixes it. The rules cover what people actually get wrong:

*An API with no definition, no route or no backend. A release that failed or has gone stale. A
gateway that cannot activate its configuration. An API with no authentication policy. A route with
no concurrency ceiling. Validation that has been downgraded. A revision uploaded and never released.
A live TLS exception, and one about to expire. A trust anchor or a certificate about to expire. A
quota at 80% and a quota exhausted. A key older than ninety days. A subscription to something that
has been deprecated, or retired. A gateway that has stopped reporting. A failed background job.*

Two design rules keep it from becoming noise:

- **A finding is only raised for an environment the API has begun to occupy.** Otherwise every newly
  published API would immediately announce "no route in PROD", and within a week nobody would read
  the list.
- **Severity is a property of the finding, not of the screen.** The same rule is a blocker
  everywhere or a warning everywhere.

For a brand-new account with nothing yet, the same mechanism produces "start here" findings, so the
dashboard is never a screen that says only "nothing here".

### 11.4 Audit

Every change is recorded: who, what, when, which object, and the outcome. The log is
**append-only** — it is not editable by anybody, including an administrator, by construction rather
than by policy. It is admin-readable.

Sign-ins, sign-outs, failed sign-ins and the reason they failed, role changes, membership changes,
key issuance and revocation, promotions and their reasons, validation downgrades and their reasons,
TLS exceptions and their reasons, and every playground call, are all in it.

What is deliberately *not* in it: no password material, ever, in any form; and for playground
calls, no body, no header and no query string — the outcome and the byte counts, and nothing that
could reconstruct the request.

### 11.5 Every bound has a defined behaviour past it

The product's rule about limits is that a limit with no defined behaviour past it is a bug waiting
for a busy Tuesday. Each of these has one, and it is the same shape everywhere: **refuse, or shed,
and count it.**

| Bound | Past it |
|---|---|
| Request body size, per instance and per route | Refused |
| Compiled contract size | The **import** is refused, because every gateway would download it |
| Blocking-validation memory budget | The request is shed — never forwarded unvalidated |
| Warning-validation queue | The sample is dropped and counted |
| In-flight requests, per route and per instance | Shed, with a retry-after |
| Concurrent streams per instance | The upgrade is refused |
| Telemetry series, per gateway | Folded into an overflow bucket and counted |
| Telemetry report size | The poll is refused, so a gateway cannot grow the portal's memory by reporting more |
| Validation issues in one refusal | The list is cut off, and the answer says it was |
| Instances per target | The registration is refused |
| Playground history per user | The oldest are pruned |
| Sign-in attempts, per account and globally | Locked out, or refused before the hash |

### 11.6 Retention

Telemetry is pruned after a short window. Completed jobs, superseded promotion plans, playground
history, expired sign-in flows, and expired or revoked sessions are all pruned on a schedule, and
each pruning run is itself recorded with what it removed.

**The audit log is never pruned.** Neither is any revision *row* — a revision that authored
something stays listed with its author, its number and its digest for ever, because that is the
history.

What can go is a revision's stored *content*, once nothing plausibly needs it: the newest few
revisions of each API are kept, and so are the two most recent releases in every environment — the
one that is live, and the one a rollback would return to. Anything older than that, and past a
retention age, has its document dropped and is marked as such. A hundred drafts of the same
specification is storage rather than history, and the distinction the product draws is between the
*record* that a revision existed and the *bytes* it carried.

### 11.7 Comparing revisions

Any two revisions of an API can be compared, and the comparison is **structural, not textual**. The
two are normalized to models — operations, parameters, schemas, MCP tools, A2A skills — and compared
as models. A reformatted upload, or one with reordered keys, is therefore correctly reported as no
change.

Every breaking finding names the rule that fired — an operation was removed, a required parameter
was added, a type changed — rather than saying "changed". "This changed" is not a thing anybody can
act on; "you removed an operation somebody may be calling" is.

---

## 12. Deploying it

### 12.1 Two images

One per plane, built and published separately.

**The control-plane image** carries the portal, the web interface, the database engine, the job
runner and the compilers. It needs a persistent volume, its configuration files mounted, and its
environment.

**The gateway image** carries the request pipeline and nothing else. It has never heard of the
database or the web interface, holds no persistent state, and needs only its name, the portal's
address and its token.

They share no runtime state and are versioned independently. A gateway image carrying the portal's
database code and its web interface would be a gateway whose attack surface included both, which is
the reason the split is at the image level and not just at the process level.

Both run as a non-root user, read every setting from the environment and mounted files, carry a
health check, and start with no repository checkout.

### 12.2 What scales and what does not

**The gateway scales horizontally.** Add instances, give each a token, and they converge on the same
configuration. Rate limits are per instance, so the fleet ceiling is the configured number times the
instance count — which the portal states rather than leaving to be discovered (§9.2).

**The control plane is one writer, on one host.** Its store is a single-writer embedded database.
This is a real constraint and the deployment documentation states it in the place where somebody
would otherwise set a replica count. It is also a small one in practice: the portal is not in the
traffic path, and its load is people using a web interface plus one poll per gateway instance per
interval.

### 12.3 Health, and what each answer means

Each plane exposes a health endpoint, and they answer different questions.

The gateway's says whether it is listening **and** whether it has a configuration it can serve. Those
are different states, and a gateway that is up but has never reached its portal reports the second
honestly rather than claiming to be healthy. A gateway that has lost contact but is still serving its
last-good configuration is a *working* gateway, and its health answer says both things.

The control plane's readiness answer reads its own store, and reports the schema version it is on
and the document version it speaks — so a load balancer gets an answer to "can this process serve"
rather than only "is the socket open". Its configuration files are read once at startup, which is
why a missing one is a startup failure rather than a process that comes up unready.

### 12.4 The environment contract

Every setting is explicit. There are no fallback chains, and **a missing required value is a startup
failure that names the variable.** A deployment that half-configures something does not start
half-configured.

By group:

| Group | What it decides |
|---|---|
| **Identity** | Which sign-in methods exist and in what order; the identity provider's address, client and claim paths; the local password rules, lockout and rate limit; the bootstrap administrator; session lifetimes |
| **Topology** | The promotion chain's order; the address of each environment's gateways; the portal's own public address |
| **Integrations** | The egress allowlist, denied ranges, registered issuers, token providers, shared secrets, and the ceilings on XML and validation work |
| **Per gateway** | Its name, its port, and its token — supplied as a file, so a token never appears in a process list |
| **Sized from traffic** | The body-size ceilings, the blocking-validation memory budget, the in-flight ceilings per route and per instance, and the runtime's outbound queue |
| **Retention and telemetry** | Flush intervals, retention windows, series ceilings, and whether per-request logging is on |

The "sized from traffic" group is the one that needs judgement rather than a default, because each
of its values fails in a way that looks like something else — a legitimate upload refused, a route
shedding requests that were fine yesterday, one slow backend delaying every other route.
[`deployment.md`](deployment.md) gives the sizing rule for each and what a wrong value looks like,
which is the part that saves the afternoon.

Two file-borne settings carry the things that are lists rather than values: the egress and
integrations registry, and the per-environment gateway addresses. They are mounted rather than baked
into the image, because they are the parts that differ per deployment.

### 12.5 Backup and restore

Two things must be backed up, and losing either is not recoverable:

- **The database.** Everything anybody has decided.
- **The encryption key.** Without it, the database's encrypted contents — key material, client
  identities, backend credentials — are unrecoverable, and the portal will not start.

They should be backed up together and stored apart. A backup of one without the other is not a
backup.

Restoring is: stop the portal, put both back, start it. The gateways need nothing — they will poll,
be given the restored configuration, and converge. That is the split paying for itself again: a
control-plane restore is not a fleet operation.

### 12.6 Upgrading

The store's schema is versioned and migrated forward automatically at startup, one version at a
time, with each step recorded. The two planes speak a versioned document, so a portal and a gateway
of adjacent versions interoperate — which is what makes a rolling gateway upgrade possible.

The order that works: upgrade the control plane first, then the gateways. The reverse can leave a
new gateway asking an old portal for a document it does not know how to produce.

### 12.7 Continuous integration

Every push type-checks and runs both test suites — the backend's and the interface's. Publishing
builds both images, **starts each one and checks that it works**, and only then pushes, with
provenance and a software bill of materials attached.

The smoke check is the part that earns the workflow. Building an image nobody has started proves
only that the file copies are spelled correctly. What is checked instead is what a deployment would
otherwise find first: that the portal boots with a realistic configuration, that its bootstrap
administrator exists and is behind the forced-change gate, that its metadata endpoint requires a
session, that the image shipped no database of its own, that the gateway refuses to start without a
token **and names the variable**, and that with a token it starts, listens and honestly reports that
it has nothing to serve yet.

---

## 13. What is not here

Named, and **absent rather than stubbed**: nothing in the interface or in the configuration document
reads as configured-and-unimplemented.

| Not here | Why |
|---|---|
| **Kafka** — topics, the Kafka proxy adapter, the whole event chain | A different transport with a different authorization model and a different failure shape. It would double the surface of the product for a use case none of the seven journeys needs |
| **GraphQL** | The whole model is operations resolved from a contract, and GraphQL's operations are in the body. It is a real feature, not a small one |
| **Importing from another API management product** | Only worth building against a real estate to import |
| **Approvals and announcements** | A workflow feature. A PROD release is gated by the chain plus a reasoned, audited bypass (§8.4), and the limitation is stated rather than faked |
| **Drift detection** | Comparing intended state against what a gateway is really running. The digest comparison (§11.1) covers the case that matters; the rest needs the gateway to report its whole state back |
| **Service tokens** | Machine identities are a different lifecycle — no password rotation, no forced change, no sessions. Automation uses a local account today, and pretending one is a machine identity would make the user list dishonest. **This is the next thing.** |
| **Directory sync** | Membership is derived when somebody signs in and at each claim re-read, which covers the person signing in and nobody else. So a user who has never signed in does not exist here, and an administrator cannot pre-assign them to a team |
| **Password reset by email** | There is no mail transport in this product. A forgotten password is an administrator reset, and the reset forces a change |
| **Multi-factor for local sign-in** | If a deployment needs it, it configures the identity provider, which has it. Building a second-rate one beside a working directory is the wrong trade |
| **Metrics and log shipping to external systems** | Telemetry is in the portal, bounded and short-lived (§11.2) |
| **A different database** | One embedded, single-writer store (§12.2) |
| **Automated certificate issuance** | Certificates are registered, not issued |
| **Active backend health checking** | The circuit breaker is passive. There is no health-check setting anywhere, so nothing reads as configured and unimplemented |
| **Header-based version routing** | Versions are addresses (§3) |
| **Per-environment lifecycle** | A version is deprecated everywhere or nowhere |
| **A multi-instance control plane** | §12.2 |
| **Kubernetes manifests** | The images and the environment contract are what a chart would need. Writing one with no cluster to test it against would ship an untested artifact, so the deployment documentation lists what a chart must get right instead |

### Where this differs from the original proposal

Thirty-six numbered deviations from [`greenfield-design.md`](greenfield-design.md) are recorded with
their reasons across the five plans. Most are scope. These are the ones that cost something a reader
should know about:

| | |
|---|---|
| **The gateway is TypeScript, not a separate compiled runtime** | The proposal wanted per-request isolation the runtime cannot provide. What is provided instead is the bounded, shed-rather-than-queue behaviour of §9.7 |
| **XSD validation is a documented subset** | A full XML schema implementation is not available without a native dependency. A WSDL using a construct outside the subset is **refused at import**, so nothing is silently unvalidated, and the subset is enumerated |
| **Warning-mode validation is not isolated from the request path** | The proposal runs it on separate threads; this runtime has one, so it is a bounded queue drained with explicit yields. Depth and saturation are bounded and counted, but a heavy sampled validation does cost the moment it runs on |
| **No WSDL generation on export** | A SOAP API exports its original document plus a generated summary |
| **A PROD release needs no second person** | §8.4 |
| **A global policy tier the proposal does not have** | Added because estate-wide policy is a real requirement, and built to be the weaker side of every conflict (§6.3) |
| **A telemetry store the proposal deliberately does not have** | Bounded the way the proposal bounds quota counters (§11.2) |
| **A TLS exception binds on the next connection** | §10.3 |
| **The playground calls the gateway, not the backend** | The proposal's wording would have the portal call the backend directly, bypassing every policy on the route and answering a question nobody asked (§4.5) |
| **A local identity provider the proposal does not have** | The proposal says nothing about who-is-who is authored here. A portal that cannot be signed into without a directory cannot be evaluated, cannot run air-gapped, and has no way back in when the directory is misconfigured. Local accounts are marked as such everywhere they appear (§5) |
| **Two sources of team membership** | The proposal has one. This has two, and puts the provenance on every row rather than hiding it (§5.4) |
| **Sessions resolve roles live rather than being reissued** | The proposal reissues a session when privileges change, which needs something to notice the change. Resolving live means an administrator's edit takes effect on the next request, with no invalidation machinery to get wrong (§5.5) |
| **The identity token's signature is verified** | The proposal treats the code exchange as sufficient. It is verified anyway; the measured cost is nineteen microseconds (§5.3) |
