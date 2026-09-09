# Integration Portal

An API management platform in two tiers: a **control plane** where applications publish APIs, attach
policy and promote between environments, and a fleet of **gateways** that carry the traffic. The
control plane owns every decision; a gateway polls, applies one complete configuration document,
and never decides anything — so a control-plane outage is not a traffic outage, and two gateways
showing the same digest are provably running the same rules.

TypeScript on [Bun](https://bun.sh), **no runtime dependencies**, one embedded database file.

| | |
|---|---|
| **Publish** | REST and SOAP from an OpenAPI or WSDL, plus MCP servers and A2A agents published by asking the endpoint what it offers. Every upload is a numbered revision that freezes on first release, and any two are compared structurally — operations, parameters, schemas, tools, skills — with each breaking change naming the rule that fired |
| **Policy** | 23 units in a closed, declarative vocabulary: five ways to authenticate a caller, IP rules, preconditions, CORS, validation, rewriting, header and body transforms, caching, rate limits, quotas, timeouts, retries, circuit breakers, concurrency ceilings, backend credentials and streaming. Per API, per environment, with an estate-wide tier underneath and per-operation overrides on top |
| **Validation** | Requests *and* responses, headers *and* bodies, REST *and* SOAP, compiled once in the control plane and shipped to gateways as content-addressed artifacts. Blocking by default. A validator a gateway cannot fetch is never activated, so a validation gap cannot open silently |
| **Environments** | DEV → TEST → PROD with a promotion gate. The contract travels; routes, backends, policy and keys belong to each environment and are edited in place. The plan is shown in words before anything happens, and what is applied is what was shown |
| **Consume** | A catalog with full-text search and facets, products, applications, subscriptions, two keys per subscription for gapless rotation, fleet-wide quotas, and a playground that calls through the gateway without the browser ever seeing a key |
| **Operate** | A fleet view with per-instance digests, telemetry that reports three numbers and never one, an attention evaluator shared by every screen that names what is wrong and links to the fix, per-environment trust anchors so internal backends are verified rather than exempted, and an append-only audit log |
| **Identity** | Local accounts, OIDC (Keycloak), or both. Application membership arrives from directory groups and is re-read on an interval; every membership shows where it came from. One authorization rule: you may change what your applications own, you may read everything, an administrator may change anything |

## What the product does, precisely

**[`openspec/`](openspec/) is the behavioural source of truth**, and the only one. Start at
[`openspec/project.md`](openspec/project.md) — the system baseline: topology, the route map, the
endpoint map, the data model, the canonical algorithms, every constant, every environment variable,
and a capability index naming each spec in one line. Then read the capability you care about at
`openspec/specs/<capability>/spec.md`.

This README is the operator's half: how to run it, deploy it, size it, back it up and upgrade it.
Everything about *what it does* is in the specs, and if the two ever disagree the specs are right.

> Design history — the original architecture proposal, five implementation plans, five reviews, the
> reuse analysis and the hand-test checklists — lived under `docs/` until v1.2.0 and was removed
> when the specs became the contract. The `plan §…`, `design §…` and `[P1-14]`-style markers in the
> source cite those documents; they are still in git. `git log --diff-filter=D -- docs/` finds the
> commit that removed them, and `git show <commit>^:docs/v5-plan.md` reads one.

---

## What it needs

- [Bun](https://bun.sh) 1.4 to run from source, or Docker to run the images.
- [PowerShell 7](https://github.com/PowerShell/PowerShell) (`pwsh`) for the local stack scripts. It
  is cross-platform; nothing else needs it.
- Nothing else. No database server, no cache, no message broker, no runtime packages.

---

## Run it locally, from source

```bash
bun install
```

```bash
pwsh -File scripts/stack.ps1 -Up -Rebuild
```

That seeds the database, mints a token per gateway, and starts nine processes: four upstreams that
know nothing about this platform, the control plane on `:8080`, and four gateways on `:8081`–`:8084`
across three environments. The portal is at <http://localhost:8080>.

`-Up` **does not return** — background it and confirm with `-Status`. Configuration changes need a
`-Down` / `-Up` cycle; a change to the web interface alone needs only `bun run build:ui`.

```bash
pwsh -File scripts/stack.ps1 -Status
```

```bash
pwsh -File scripts/stack.ps1 -Down
```

The seed writes `AUTH_PROVIDERS=dev` into `.env.local`, so you can sign in as Alice (administrator),
Pavel (publisher) or Clara (consumer) with one click. That bypass is not a default — no deployment
gets it without naming it. `pwsh -File scripts/demo.ps1` walks the journeys as a script, in two acts.

---

## Deploy it

### The two images

| | |
|---|---|
| `docker/control-plane.Dockerfile` | The portal: the API, the database, the job runner, the compilers, and the built web interface |
| `docker/data-plane.Dockerfile` | One gateway: the request pipeline and nothing else |

```
ghcr.io/<owner>/<repo>/control-plane
ghcr.io/<owner>/<repo>/data-plane
```

They share no runtime state, are versioned independently, and both run as a non-root user, read
every setting from the environment and from mounted files, carry a `HEALTHCHECK`, and start with
**no repository checkout**.

Both pin `oven/bun:1.4.2-alpine` exactly rather than to a floating minor. The same version is
pinned in **five** places and they must move together:

```
docker/control-plane.Dockerfile      two FROM lines
docker/data-plane.Dockerfile         one FROM line
.github/workflows/ci.yml             BUN_VERSION
.github/workflows/images.yml         BUN_VERSION
.github/workflows/perf.yml           bun-version
```

A Dockerfile that floated to a minor would make a reproducible build stop being one without anybody
changing a line.

**What the control-plane image deliberately does not set:** `AUTH_PROVIDERS`. It is required, has
no default, and an image that guessed would make that guess for every deployment at once.

**What the gateway image deliberately does not set:** `GATEWAY_CP_URL`, `GATEWAY_TOKEN_FILE`,
`DP_NAME`, `TRUSTED_PROXY_CIDRS`. Each is a deployment decision, and an image that guessed would
make that guess for every deployment at once.

Only one of them stops the process: **the token**. Without `GATEWAY_TOKEN_FILE` or `GATEWAY_TOKEN`
the gateway refuses to start and names both. The other three have code defaults, and those defaults
are the argument for setting them rather than a reason to relax about them — a gateway with no
`GATEWAY_CP_URL` polls `http://localhost:8080` and looks like a network fault, and one with no
`TRUSTED_PROXY_CIDRS` logs and rate-limits on whatever client IP the caller asked for. That is why
`GATEWAY_CP_URL` has no default in [`docker-compose.data-plane.yml`](docker-compose.data-plane.yml):
the refusal an operator needs is the compose file's, before a container exists.

**What the gateway image cannot set at all:** the body cap, the concurrency and buffer ceilings, the
cache sizes, the JWKS floor, the telemetry bounds and the access-log switches. Those are gateway
settings, held by the control plane and delivered in the configuration document, and a container
that still sets one of their old variables refuses to start naming it.

**What the gateway image does set:** `BUN_CONFIG_MAX_HTTP_REQUESTS=16384`. This is the runtime's own
outbound queue, so it can only be a per-container value; the gateway refuses to start, and refuses
to activate a document, unless it is at least the `maxConcurrentRequests` setting. That check exists
precisely to catch the pairing an image setting neither would inherit — the runtime's small default
queue behind the gateway's own ceiling, where one slow backend delays every other route. 16384 is
headroom, not a match, so raising the setting from the portal is an ordinary thing to do; past it,
raise this and restart the container.

**The image ships no configuration as a default.** The repository's own `config/` is copied to
`/app/config.sample/` instead, because its egress allowlist permits loopback so the local stack
works — which is not a default anybody should inherit. Copy them out, edit them, mount them.

### Compose, on a clean machine

There are **two** compose files, one per plane, and the split is the point:

| | |
|---|---|
| [`docker-compose.control-plane.yml`](docker-compose.control-plane.yml) | The portal. Holds state, one writer, one volume worth backing up, does not scale |
| [`docker-compose.data-plane.yml`](docker-compose.data-plane.yml) | One gateway. Holds nothing that is not derived from elsewhere, scales horizontally, disposable |

A single file would imply the two move and scale together, and they do not. In any real deployment
they are on different hosts — the portal beside its backup schedule, the gateways beside the
traffic. Both declare the project name `apim` and a network called `apim`, so passing both to one
`docker compose` merges them into one project on one network.

Both **pull the published image** rather than building one — there is no `build:` section in either
file, because the images are what a deployment consumes and building from a checkout is a different
activity with different inputs. The tag is the minor line, `ghcr.io/…/control-plane:1.2`, so patch
releases arrive without an edit; `APIM_VERSION` pins an exact one. To run your own build, build it
and override `image:` in a `docker-compose.override.yml`.

Each file lists **every** variable its plane reads, in two groups — the ones with no default, which
compose refuses to start without and names, and the ones with one. Nothing is missing and nothing
is surplus: [`test/compose-env.test.ts`](test/compose-env.test.ts) fails when a file names a
variable its plane does not read, or omits one it does.

**On one machine:**

```bash
cp .env.example .env
```

Two values have no default and compose stops before it creates a container without them:
`AUTH_PROVIDERS` (the example ships `local`) and `BOOTSTRAP_ADMIN_PASSWORD`, which you set. Twelve
characters minimum; the control plane refuses to start with a shorter one rather than exempting the
account that has every permission from the policy it enforces. `GATEWAY_CP_URL` is already
`http://control-plane:8080` in the example, which is correct for this case and wrong for the next one.

```bash
docker compose -f docker-compose.control-plane.yml up -d
```

```bash
mkdir -p .secrets && docker compose -f docker-compose.control-plane.yml run --rm --no-deps control-plane bun run scripts/mint-instance.ts dev dev-1 > .secrets/dev-1
```

```bash
chmod 600 .secrets/dev-1
```

```bash
docker compose -f docker-compose.control-plane.yml -f docker-compose.data-plane.yml up -d
```

Then <http://localhost:8080>, sign in as the bootstrap administrator, and choose a password. The one
from `.env` is in a file, in a shell history and in `docker inspect`, so the portal will not let it
be kept.

**On separate hosts:** run the control-plane file on the portal's host, exactly as above through the
mint step. Copy the minted token to the gateway's host, then there:

```bash
GATEWAY_CP_URL=https://portal.example.com DP_NAME=prod-1 docker compose -f docker-compose.data-plane.yml up -d
```

`GATEWAY_CP_URL` has **no default** in the gateway file. A gateway that silently polled a service
name that does not resolve on this host would look like a network fault rather than a missing
setting.

### Three things that are easy to get wrong

**Mint before you bring the gateway up.** `.secrets/dev-1` is mounted as a *file*, and Docker
silently creates an empty *directory* at that path if it does not exist. The gateway then fails to
read its token, and the message blames the token rather than the missing file.

**A second gateway is a copied service block, not `deploy.replicas`.** Replicas would share one
name and one cache directory; each instance needs its own `DP_NAME`, its own volume, its own minted
token and its own published port. And rate limits are per instance, so two of them mean twice the
configured number in total.

**There is deliberately no sample backend service.** `tools/` is excluded from the images, because a
published image should not carry a toy HTTP server — so a service pointing at one could not start.
To exercise the whole product against something, run the local stack from source instead.

---

## Configure it

**The full environment contract is in [`openspec/project.md`](openspec/project.md) §
*Environment Variables*** — every variable for both planes, its default, and what it does — with the
refusals checked at boot listed beside it. It is not repeated here, because a contract stated twice
is a contract that drifts. What follows is the part that needs judgement rather than a lookup.

### Signing in

`AUTH_PROVIDERS` is **required**, ordered, and closed — an ordered subset of `local,oidc,dev`. There
is no default: a deployment that forgets it does not boot, and the error names the variable and its
three legal values. This is the one place a fallback would be catastrophic.

**Local accounts** — usernames and argon2id passwords held by the portal. For deployments with no
directory, for air-gapped environments, and as the way back in when the identity provider is
misconfigured.

```
AUTH_PROVIDERS=local
PUBLIC_URL=https://portal.example.com
BOOTSTRAP_ADMIN_USERNAME=admin
BOOTSTRAP_ADMIN_PASSWORD=<twelve characters or more>
```

The bootstrap administrator is created once, only while the directory is empty, and always with
"must change the password at first sign-in".

**An identity provider** — authorization code + PKCE, owned end to end by the control plane. The
browser never sees a token; it gets the same session cookie local sign-in produces. The identity
token's signature is verified against the issuer's key set, along with the nonce, issuer, audience,
expiry and not-before.

```
AUTH_PROVIDERS=oidc
PUBLIC_URL=https://portal.example.com
OIDC_ISSUER=https://keycloak.example.com/realms/portal
OIDC_CLIENT_ID=integration-portal
OIDC_REDIRECT_URI=https://portal.example.com/auth/callback
```

**Both, which is usually right:** `AUTH_PROVIDERS=oidc,local` — single sign-on for people, plus a
few local administrators for the day the provider is unreachable. The order is the order the buttons
appear in. `OIDC_CLIENT_SECRET` is optional (absent means a public PKCE client, the Keycloak default
for this shape).

### The two claims, and the three shapes they come in

Everything about who somebody is comes from two claims, each named by a dotted path, and each read
in whichever of three shapes the realm happens to issue.

```
["/apim/orders", "/apim/platform"]         a list of group paths
"orders platform"                           one space-separated string
{ "api.developers": ["ORDERS", "EAI"] }     a role → applications map
```

The first two are the same thing written differently. The third is a realm that **scopes its roles
per application**, and it is read in opposite directions for the two questions:

| | Reads | `{ "podp.admin": ["PODP"] }` gives |
|---|---|---|
| `OIDC_GROUP_CLAIM` | the map's **values** — what the person may act on | `PODP` |
| `OIDC_ROLE_CLAIM` | the map's **keys** — what they hold | `podp.admin`, and `PODP.podp.admin` |

Each key is offered bare *and* qualified by every application it applies to, because a realm may
spell its administrator grant either way and there is no way to tell which from inside a token.

**Holding any role for an application is membership of that application.** This product's
applications have members and administrators and nothing in between, so a realm that distinguishes
`api.readers` from `api.developers` for the same application collapses to one membership here. If
that distinction has to survive, it has to survive as two applications.

For a realm of this shape the settings are:

```
OIDC_GROUP_CLAIM=apps_with_role
OIDC_ROLE_CLAIM=roles                # or apps_with_role, if the grant is only in the map
OIDC_ADMIN_ROLE=PODP.ADMIN
```

and each application's source group is the **application name** — `PODP`, `MVIS` — matched
case-insensitively.

**Choose `OIDC_ADMIN_ROLE` carefully.** It names one role that makes somebody an administrator of
the *whole portal*: every application, the gateway fleet, the trust store, the audit log, the
directory. In a realm where each application has its own admin role, that means picking the platform
application's admin role specifically. Naming a role many applications carry would make every one of
their admins a portal administrator.

**If the claim path is wrong, nothing fails.** Everybody signs in, everybody is in no application,
and there is no unmapped group to report because there was no group — which looks exactly like
"these people have not been granted access yet". The portal therefore tells the two apart: a user
whose token carried no groups at all is told so on their account page, in those words, rather than
being left to look like an ungranted user. **Decode a real token before trusting the defaults.**

On the Keycloak side: a client with the standard flow enabled and **PKCE required**; the exact
`OIDC_REDIRECT_URI` registered; a role for administrators matching `OIDC_ADMIN_ROLE` and a mapper
putting it wherever `OIDC_ROLE_CLAIM` points; whatever carries ownership mapped into the claim named
by `OIDC_GROUP_CLAIM`; and `offline_access` in the client's scopes, or there is no refresh token and
roles and memberships stop being re-read. Groups map to applications that already exist and never
create one — unmatched group names are shown to administrators on the Applications screen, so "half
my department can see nothing" has a visible cause and a one-click fix.

### The six values sized from traffic

These are the ones with no correct default, because the right number is a property of your traffic.
Each fails in a way that looks like something else, which is why they are together in one table.

Five of the six are **gateway settings**, not environment variables: they are set on the portal's
Gateway settings screen for the whole fleet, one environment or one gateway, and reach each replica
on its next poll without a restart. Sizing them is still the operator's job; finding them is no
longer a matter of knowing which container to edit.

| | The rule | What a wrong value looks like |
|---|---|---|
| `maxBodyBytes` (setting) | The largest body any route on this gateway must accept | `413` on a legitimate upload |
| `validate.always.maxBodyBytes` (per route, in policy) | That route's largest body, at or below the above | `413` on one API while the others are fine |
| `blockingBufferBudgetBytes` (setting) | At least the route's `maxBodyBytes` × the number of concurrent blocking requests you mean to absorb | `503` on a route that was validating fine yesterday |
| `maxConcurrentRequests` (setting) | At least peak requests-per-second × the worst backend latency you mean to absorb | `503` shed too early when a backend degrades |
| `BUN_CONFIG_MAX_HTTP_REQUESTS` (env, per container) | At least `maxConcurrentRequests` | One slow backend delays every other route |
| `concurrency.maxInFlight` (per route, in policy) | That route's requests-per-second × its p99, plus headroom | One sick backend fills the whole instance |

Four things that are easy to get wrong about these:

**`maxBodyBytes` is per instance, not per route.** Raising it for one large-upload API raises the
ceiling for every API on the gateways the layer you set it on reaches. The per-route number that
should actually differ is the policy's own `validate.always.maxBodyBytes`.

**The one env/setting pair is the one that can bite on a heterogeneous fleet.**
`BUN_CONFIG_MAX_HTTP_REQUESTS` is the runtime's, set per container, and the gateway will not run
with `maxConcurrentRequests` above it. Raise it from the portal past what a particular container
allows and that replica **refuses the whole document**, keeps serving what it already had, and says
why on Health Status — so the mistake is visible and one central edit undoes it, but the replica is
a revision behind until you make it. The image ships 16384 as headroom for exactly this reason.

**`nofile` must be at least four times `maxConcurrentRequests`.** Each held request keeps a client
socket and an upstream socket, and a container's default limit of 1024 is reached long before any
ceiling set on the portal. A stream holds its pair for its whole life, so `maxConcurrentUpgrades`
counts against the same budget. The compose file sets `nofile` to 32768 for this reason — and since
the ceiling is now raised from a browser rather than from that file, check the two against each
other when you raise it.

**A route's `timeoutMs` covers the whole upstream exchange, including streaming the request body
up.** So a large upload from a slow client needs a timeout that covers the transfer, not just the
backend's thinking time. It does *not* bound a passthrough stream — those are bounded by their own
maximum connection seconds, idle timeout and byte ceiling instead.

The measured behaviour behind all six is in `reports/capacity-report.md`.

### The two mounted files

Both are read at startup, and both are mounted rather than baked in, because they are the parts that
differ per deployment. Their shapes are in `openspec/project.md` § *Configuration Files*.

**`TARGETS_FILE`** — one target per environment and adapter: the addresses the portal believes that
environment's gateways answer on. It is what the playground composes a URL from, and what the
Gateways screen groups instances under.

**`INTEGRATIONS_FILE`** — everything a policy refers to *by name*, plus the boundary of what the
platform is allowed to reach: the egress allowlist and denied ranges, registered JWT issuers and
their key sets, registered token providers for backend authentication, registered shared secrets and
HMAC schemes, the ceilings on XML and validation work, and the maximum length of a TLS exception.

This is the file that makes the policy vocabulary safe: an owner can say "require a JWT from the
corporate issuer", and cannot say "fetch this URL" or "trust this key I am pasting in". It is also
what makes the playground and every specification import safe against request forgery.

The repository's copies under `config/` allow egress to loopback so the local stack works. **Do not
deploy those.** The image has them at `/app/config.sample/` to copy out and edit.

---

## Operate it

### Enrolling a gateway

A gateway needs a token proving it is allowed to exist. There are two ways to get one and they mint
the same thing: from the portal (Gateways → the environment's target → mint an instance token, shown
once), or from a shell on the control-plane host, for a deployment with no browser:

```bash
docker compose -f docker-compose.control-plane.yml run --rm --no-deps control-plane bun run scripts/mint-instance.ts dev dev-1 > .secrets/dev-1
```

The token goes to stdout **alone**; everything else goes to stderr, so the redirect above writes a
file containing the token and nothing else. The mint is capped per target, audited, and stored only
as a hash.

There is deliberately **no enrolment secret** and no way for a gateway to enrol itself. That would
be a second credential to protect, with no owner and no revocation story, to save one command.

**Revoking** an instance token stops that gateway at its next poll. This is the one thing that fails
closed: a gateway out of contact with the portal keeps serving its last-good configuration
indefinitely, but a gateway whose token was revoked stops.

### Health, readiness and what each answer means

| | | |
|---|---|---|
| Control plane | `/readyz` | Can this process serve? It reads the schema version out of the database, so it answers what a load balancer is actually asking rather than only "is the socket open" |
| Control plane | `/healthz` | Is the process alive |
| Gateway | `/healthz` | Is it listening, **and** has it activated a configuration — reported as two separate facts |

The gateway's answer is the one worth reading carefully. `configDigest: null` means it has never
successfully applied a configuration: it is listening and it can serve nothing. A gateway that has
lost contact with the portal but is still serving its last-good document reports a digest and is a
*working* gateway — a control-plane outage is not a traffic outage, and the health answer must not
say otherwise.

A gateway that has downloaded a configuration and **refused to activate it** — because it references
a compiled validator it cannot fetch, or because its settings name a ceiling this container's
runtime will not honour — keeps serving the previous one and reports why, and the Gateways screen
shows it as blocked with the reason. `/healthz` also reports the settings actually in force on that
replica, which is how you tell a refusal apart from a change that simply has not arrived yet.

### The access log, and shipping it

Every gateway writes one JSON line per request, for every request, and there is no setting that
thins that — the lines are a compliance record, so the `accessLog` setting switches the log off
entirely rather than sampling it. Size the destination for the whole of your traffic, not a
fraction of it. Switching it off is the one gateway setting behind a typed confirmation, and it is
written to the audit trail named as sensitive.

Unset, the lines go to standard output and the container's log driver collects them. That is the
right answer when something else on the host already ships stdout. Point `DP_ACCESS_LOG_PATH` at a
file on a mounted volume when a shipper — Logstash, Filebeat — tails the file instead:

| | |
|---|---|
| `DP_ACCESS_LOG_PATH` (env, per container) | **One path per instance.** Two gateways writing one file would interleave their buffers and race each other's rotation, so put `DP_NAME` in the path. This is why it stayed a variable rather than becoming a fleet setting |
| `accessLogMaxBytes` (setting) | How large the live file grows before it is rotated. `128 MiB` by default |
| `accessLogKeep` (setting) | How many rotations are kept. `5` by default, so the volume has to hold `(keep + 1) × maxBytes` — about 768 MiB at the defaults, per instance |

**The gateway rotates the file itself, and does not want `logrotate` doing it too.** It renames and
reopens (`access.log` → `access.log.1` → …), which is the mode a tailing shipper handles correctly:
it finishes the renamed inode and then follows the new file. An external rotator truncating in
place loses whatever the shipper had not read yet. If you already run `logrotate` on this host,
exclude this path.

The lines are buffered and flushed by size and by a quarter-second interval, so a gateway at rate
does not make one syscall per request. An orderly shutdown flushes; a `SIGKILL` loses whatever was
still in the buffer. That is the trade, and it is the same one every proxy that does not write
through makes.

`openspec/project.md` § The Access Log Line is the field list and what each one lands in on the ELK
side. Two things about its contents are worth knowing before you build a dashboard on it: **no
request or response header is ever in a line**, so there is no field to map for `Authorization` or
an API key, and credential-shaped query parameters arrive with their values already replaced.
Bodies are absent unless somebody has opened a capture window on that API from the portal's Logs
tab — an hour at most, 8 KiB at most, audited, and visible to every reader of the portal while it
is open.

### Backup and restore

Two things, and losing either is not recoverable:

| | |
|---|---|
| The database | `DB_PATH` — everything anybody has decided |
| The key-encryption key | `KEK_PATH` — without it, the encrypted contents are unrecoverable and the portal will not start |

**Back them up together and store them apart.** A backup of one without the other is not a backup:
the database without the key yields no subscription key, no client identity and no backend
credential; the key without the database is a file of random bytes.

In the control-plane compose file both live on one volume, which is convenient and is why this is
stated so plainly. In anything longer-lived, the key belongs in a secret store and the database in a
backup.

**Restore** is: stop the portal, put both back, start it. The gateways need nothing — they will
poll, be handed the restored configuration, and converge. A control-plane restore is not a fleet
operation, which is the two-plane split paying for itself again.

**Gateways need no backup at all.** Their caches are derived; a gateway with an empty cache and a
reachable portal is fully converged within one poll.

### Upgrading

The database schema is versioned and migrated forward automatically at startup, one version at a
time, and each step is recorded. There is no separate migration command and no manual step.

The two planes speak a versioned document, so a portal and a gateway of adjacent versions
interoperate. That is what makes a rolling gateway upgrade possible.

**The order that works: control plane first, then gateways.** The reverse can leave a new gateway
asking an old portal for a document version it does not know how to produce.

Rolling the gateways one at a time is safe by construction: each is stateless, converges within one
poll, and the fleet's rate limits are per instance, so removing one instance lowers the fleet
ceiling proportionally rather than shifting load into a shared counter.

**Upgrading to 1.3: the gateway's own limits moved into the portal, and the old variables are now a
startup failure.** `MAX_BODY_BYTES`, `MAX_CONCURRENT_REQUESTS`, `MAX_CONCURRENT_UPGRADES`,
`BLOCKING_BUFFER_BUDGET_BYTES`, `VALIDATE_POOL_SIZE`, `VALIDATE_QUEUE_DEPTH`,
`RESPONSE_CACHE_MAX_ENTRIES`, `RESPONSE_CACHE_MAX_BYTES`, `ARTIFACT_CACHE_MAX_BYTES`,
`JWKS_MIN_REFETCH_SEC`, `DP_TELEMETRY`, `TELEMETRY_MAX_SERIES`, `TELEMETRY_MAX_WINDOWS_PER_REPORT`,
`DP_ACCESS_LOG`, `DP_ACCESS_LOG_MAX_BYTES` and `DP_ACCESS_LOG_KEEP` are gateway settings now. A
gateway that still has one of them set refuses to start and names every one it found.

That refusal is deliberate and it is the whole upgrade path, because the two silent alternatives are
both worse: reading the variables would keep a fleet's configuration in as many places as it has
containers, and ignoring them would quietly *lower* the limits of any estate whose compose file had
raised one above the code default — which is most of them, since the shipped file set an 8192
request ceiling.

So, in this order:

1. **Before** rolling any gateway, upgrade the control plane and set the values your compose files
   currently carry on **Administration → Gateway settings**. Fleet-wide is usually right; set an
   environment or a single gateway only where they actually differ today. The screen names the
   variable each setting replaced, so this is a transcription rather than a redesign.
2. Remove those variables from every gateway's environment.
3. Roll the gateways.

A gateway rolled before step 1 comes up on the code defaults, which for most estates is a *lower*
body cap and a lower concurrency ceiling than it had — so do step 1 first, not afterwards.

`BUN_CONFIG_MAX_HTTP_REQUESTS` stays where it is: it is the runtime's, per container. Check it is at
least the `maxConcurrentRequests` you just set, or that gateway will refuse the document and say so
on Health Status.

### What a Kubernetes chart would have to get right

There is no chart here, and that is deliberate: writing one with no cluster to test it against would
ship an untested artifact. The images and the environment contract are what a chart needs, and these
are the five things it must not get wrong.

**1. The control plane is a single writer.** One replica, `Recreate` rather than `RollingUpdate`,
and a `ReadWriteOnce` volume. Two control-plane pods against one volume is data loss, not a
performance improvement. This is the place somebody would otherwise type `replicas: 3`.

**2. The gateway scales, and its rate limits are per instance.** Horizontal scaling multiplies every
configured rate limit by the replica count. That arithmetic is stated in the portal's interface, and
an autoscaler makes the multiplier variable — which is a product decision, not an infrastructure
one.

**3. Each gateway needs its own artifact cache directory and its own instance token.** The cache
cannot be shared: certificate material in it is written `0600` and two pods would race on names and
permissions. So gateways want a `StatefulSet` with per-pod volumes and per-pod token secrets, not a
`Deployment` with one shared secret — or an `emptyDir` and the acceptance that every restart
re-downloads its artifacts.

**4. `nofile` and the two concurrency ceilings must move together.** At least four times the
`maxConcurrentRequests` setting, and `BUN_CONFIG_MAX_HTTP_REQUESTS` at least that setting or the
gateway refuses to start — and refuses to activate a document that raises it past what the pod
allows. A container runtime's default limit is reached long before any of these numbers. The
awkward part for a chart is that the ceiling is now changed from a browser while `nofile` and the
runtime queue are in the manifest, so leave headroom in both rather than matching them exactly.

**5. Readiness must use the right endpoint per plane.** The control plane's `/readyz`; the gateway's
`/healthz`, and a gateway serving its last-good document during a control-plane outage must stay in
the load balancer. A readiness probe that removed it would turn a control-plane outage into the
traffic outage the whole architecture exists to prevent.

Two more, smaller: the key-encryption key belongs in a `Secret` and not on the same volume as the
database, and the two mounted configuration files belong in a `ConfigMap` — except the parts of
`INTEGRATIONS_FILE` that are secrets, which do not.

---

## Tests

```bash
bun test
```

998 tests across 50 files: the shared vocabulary, the JSON Schema and XSD validators, the control
plane, the gateway pipeline, promotion, versioning, telemetry, the fleet, gateway settings and the
three layers they resolve from, SOAP, artifacts,
validation in all three states, backend pools and the breaker, trust anchors, quota, streaming, the
global tier, MCP, A2A, the catalog, the playground, the dashboard, revisions and the structural
diff, the concurrency bulkheads, local and OIDC authentication against a real in-process identity
provider, users, applications and sessions, a migration test that upgrades a real v1 database, and a
performance guardrail (`PERF_GUARD=0` skips it).

```bash
bun run test:ui
```

114 tests across 12 files, over the parts of the interface that are decisions rather than markup:
the attention vocabulary and its ordering, capabilities for owner / other application /
administrator, glossary coverage, status totality, that every route has a title and a purpose, that
the route table and the screen registry cover each other exactly, that a fresh account's primary
controls are enabled or disabled-with-a-reason, and a set of source-level rules — no click handler a
keyboard cannot reach, no colour written into a view, no empty state without an action, no
`confirm()`, no delete of a named object outside a typed confirmation, no request whose error is
never rendered.

```bash
bun run test
```

Both, in that order. `bun run typecheck` type-checks both projects.

```bash
bun run test:e2e
```

Playwright, read-only, against a stack that is already up. It needs a browser once
(`bunx playwright install chromium`) and signs in through `dev` or `local` — never OIDC. Nothing in
it publishes, promotes, subscribes or deletes, because the stack it runs against is usually shared.

### Measuring it

Two harnesses, answering two different questions. Neither is a substitute for the other.

```bash
bun run perf --profile=quick
```

**What the gateway adds.** 27 scenarios, each paired with the identical work sent straight to the
backend, writing `reports/perf-report.md`. The headline number is always the *difference*, because
absolute throughput on one machine measures that machine.

Read it carefully in one respect: every scenario runs a fixed number of workers, so throughput is
roughly concurrency ÷ latency. For a scenario whose backend is deliberately asleep for 30 seconds,
the requests-per-second figure is arithmetic and says nothing about the gateway — the columns that
mean something there are the added p50 and p95. The report prints concurrency and sample counts
beside every rate so this is checkable rather than a trap.

```bash
bun run capacity --profile=standard --cpus=4
```

**What one gateway takes.** Every piece in its own operating-system process, the gateway pinned to a
stated number of cores that nothing else may touch, load generated from processes that are not
allowed near them, and each workload swept up a concurrency ladder until throughput stops rising. It
writes `reports/capacity-report.md`. It deliberately does *not* report CPU per request: that figure
could not be measured on this platform to a standard worth publishing, and the report says why
rather than printing a number it cannot stand behind.

### Continuous integration

| | |
|---|---|
| `.github/workflows/ci.yml` | Type-checks and runs both test suites on every push |
| `.github/workflows/images.yml` | Builds, smoke-tests and publishes both images |
| `.github/workflows/perf.yml` | The performance harness, for when this has a remote |

The images workflow builds for the runner's own architecture first and **loads it locally**, so the
smoke test runs against the image that is about to be published rather than against a rebuild of it.
Only then does it build for both architectures and push, with provenance, a software bill of
materials and an attestation.

The smoke test is what makes the workflow worth having. Building an image nobody has started proves
that the `COPY` lines are spelled right and nothing else. What is checked instead is what a
deployment would otherwise find first: that the portal boots with a configuration a real deployment
would use; that its bootstrap administrator exists and is behind the forced-password-change gate;
that its metadata endpoint answers `401` without a session; that the image shipped **no database of
its own**, checked by counting the accounts in it; that the gateway refuses to start without a token
and names the variable; that with one it starts, listens, and honestly reports that it has activated
no configuration; and that neither runs as root.

---

## Layout

```
shared/         policy vocabulary · config contract · telemetry · JSON Schema · XSD · XML · SOAP
                routing · operation matching · MCP · A2A · quota · attention · structural diff
control-plane/  API, SQLite, migrations, promotion, jobs, telemetry and quota aggregation,
                config build, artifact compiler, discovery, catalog search, certificates,
                trust anchors, the playground, the dashboard, authentication and the directory
data-plane/     config poll, route table, the request pipeline, validation, rate limit, quota,
                backend pool and breaker, response cache, stream registry, counters, trust store
ui/             React + Vite SPA, served by the control plane
                ui/src/App.tsx      signing in, and the session every screen is handed
                ui/src/lib/routes.ts  every address, its title, purpose and sidebar entry
                ui/src/screens.tsx  which component answers which route id
                ui/src/portal/      the branded shell and the screens built for it
                ui/src/views/       the plainer screens the shell embeds
docker/         one Dockerfile per plane; one docker-compose.<plane>.yml each, at the root
tools/          the local upstreams (REST/SOAP/SSE/WebSocket, MCP, A2A) and the two load harnesses
scripts/        seed · stack · demo · mint-instance · schedule-perf
test/           bun test — control plane, data plane, shared
ui/test/        bun test — the parts of the interface that are decisions rather than markup
e2e/            Playwright — read-only smoke tests against a running stack
reports/        generated measurements: perf and capacity
openspec/       the behavioural source of truth
CHANGELOG.md    the portal's version and what changed in it
```
