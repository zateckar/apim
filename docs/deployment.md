# Deploying the Integration Portal

Everything an operator has to decide, in the order they have to decide it. The functional half —
what the two planes are, why the split, what fails closed and what does not — is in
[`design.md`](design.md); this file is the contract.

---

## Contents

1. [The two images](#1-the-two-images)
2. [Compose, on a clean machine](#2-compose-on-a-clean-machine)
3. [The environment contract](#3-the-environment-contract)
4. [The six values sized from traffic](#4-the-six-values-sized-from-traffic)
5. [Authentication](#5-authentication)
6. [The two mounted files](#6-the-two-mounted-files)
7. [Enrolling a gateway](#7-enrolling-a-gateway)
8. [Health, readiness and what each answer means](#8-health-readiness-and-what-each-answer-means)
9. [Backup and restore](#9-backup-and-restore)
10. [Upgrading](#10-upgrading)
11. [What a Kubernetes chart would have to get right](#11-what-a-kubernetes-chart-would-have-to-get-right)
12. [Continuous integration](#12-continuous-integration)
13. [Measuring it](#13-measuring-it)

---

## 1. The two images

| | |
|---|---|
| `docker/control-plane.Dockerfile` | The portal: the API, the database, the job runner, the compilers, and the built web interface |
| `docker/data-plane.Dockerfile` | One gateway: the request pipeline and nothing else |

They share no runtime state, are versioned independently, and both:

- run as a non-root user,
- read every setting from the environment and from mounted files,
- carry a `HEALTHCHECK`,
- start with **no repository checkout**.

Both pin `oven/bun:1.4.1-alpine` exactly rather than to a floating minor. The same version is
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
no default, and an image that guessed would make that guess for every deployment at once. See §5.

**What the gateway image deliberately does not set:** `GATEWAY_CP_URL`, `GATEWAY_TOKEN_FILE`,
`DP_NAME`, `MAX_BODY_BYTES`, `TRUSTED_PROXY_CIDRS`. Each is a deployment decision, and the process
refuses to start without it, naming the variable.

**What the gateway image does set, and why both:** `MAX_CONCURRENT_REQUESTS=8192` and
`BUN_CONFIG_MAX_HTTP_REQUESTS=16384`. The gateway refuses to start unless the second is at least
the first, and that check exists precisely to catch the pairing an image setting neither would
inherit — the runtime's small default outbound queue behind the gateway's own ceiling, where one
slow backend delays every other route. Raise them together or not at all.

**The image ships no configuration as a default.** The repository's own `config/` is copied to
`/app/config.sample/` instead, because its egress allowlist permits loopback so the local stack
works — which is not a default anybody should inherit. Copy them out, edit them, mount them (§6).

---

## 2. Compose, on a clean machine

There are **two** compose files, one per plane, and the split is the point:

| | |
|---|---|
| [`docker-compose.control-plane.yml`](../docker-compose.control-plane.yml) | The portal. Holds state, one writer, one volume worth backing up, does not scale |
| [`docker-compose.data-plane.yml`](../docker-compose.data-plane.yml) | One gateway. Holds nothing derived-from-elsewhere, scales horizontally, disposable |

A single file would imply the two move and scale together, and they do not. In any real deployment
they are on different hosts — the portal beside its backup schedule, the gateways beside the
traffic.

Both declare the project name `apim` and a network called `apim`, so passing both to one
`docker compose` merges them into one project on one network.

### On one machine

```bash
cp .env.example .env
```

Set `BOOTSTRAP_ADMIN_PASSWORD`. Twelve characters minimum; the control plane refuses to start with a
shorter one rather than exempting the account that has every permission from the policy it enforces.
`GATEWAY_CP_URL` is already `http://control-plane:8080` in the example, which is correct for this
case and wrong for the next one.

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

### On separate hosts

Run the control-plane file on the portal's host, exactly as above through the mint step. Copy the
minted token to the gateway's host, then there:

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
To exercise the whole product against something, run the local stack from source instead (see
[`walkthrough.md`](walkthrough.md)).

**There is deliberately no `deploy.replicas` on the control plane.** See §11.

---

## 3. The environment contract

One rule, from design §11, and it is the reason this section is a table rather than a discussion:
**explicit values, no fallback chains, and a missing required value is a startup failure that names
the variable.** A deployment that half-configures something does not start half-configured.

### 3.1 Control plane — identity

| | | |
|---|---|---|
| `AUTH_PROVIDERS` | **required** | An ordered subset of `local,oidc,dev`. No default. `dev` may not be combined with `oidc` |
| `SESSION_IDLE_MIN` | 60 | The inactivity window. Slides on every request, so a working day is one sign-in |
| `SESSION_LIFETIME_HOURS` | 8 | The absolute age. Does not slide, so a tab left open does not become a permanent session |
| `SESSION_PRUNE_AFTER_DAYS` | 30 | How long a revoked or expired session stays readable on the account screen |

### 3.2 Control plane — local sign-in (with `local`)

| | | |
|---|---|---|
| `BOOTSTRAP_ADMIN_USERNAME` | `admin` | |
| `BOOTSTRAP_ADMIN_PASSWORD` | **required with `local` and an empty directory** | Created once, always with "must change at first sign-in" |
| `LOCAL_PASSWORD_MIN_LEN` | 12 | There is also a 200-character ceiling, so an unbounded body is never hashed |
| `LOCAL_LOCKOUT_THRESHOLD` | 10 | Consecutive failures, per account |
| `LOCAL_LOCKOUT_MINUTES` | 15 | |
| `LOCAL_LOGIN_RATE_PER_MIN` | 60 | Across **all** callers, in front of the password hash. A memory-hard hash is a denial-of-service vector even with every attempt failing; this limiter is what makes a flood cheap to refuse |

The bootstrap administrator is created only while the local directory holds no account at all — so
deleting it and creating your own does not resurrect it at the next restart, and changing the
username does not create a second one.

### 3.3 Control plane — the identity provider (with `oidc`)

| | | |
|---|---|---|
| `OIDC_ISSUER` | **required** | Discovery is `<issuer>/.well-known/openid-configuration`. Must pass the egress allowlist |
| `OIDC_CLIENT_ID` | **required** | |
| `OIDC_CLIENT_SECRET` | — | Absent means a public PKCE client, which is the Keycloak default for this shape |
| `OIDC_REDIRECT_URI` | **required** | Absolute. Its path is the callback and must be registered on the client. **Its origin must equal `PUBLIC_URL`'s**, checked at boot |
| `OIDC_SCOPE` | `openid profile email offline_access` | Without `offline_access` there is no refresh token and therefore no claim re-read |
| `OIDC_ROLE_CLAIM` | `realm_access.roles` | A dotted path into the token — §5.1 |
| `OIDC_ADMIN_ROLE` | `apim-admin` | The role that makes somebody an administrator here |
| `OIDC_GROUP_CLAIM` | `groups` | A dotted path. Group paths are matched whole *and* by last segment — §5.1 |
| `OIDC_CLAIMS_REFRESH_SEC` | 300 | How stale a session's roles and teams may be |
| `OIDC_AUTO_CREATE` | 1 | `0` means an administrator pre-creates the account and an unknown subject is refused |
| `OIDC_END_SESSION` | 0 | `1` redirects sign-out through the provider, ending every session behind it |
| `OIDC_DISPLAY_NAME` | `Single sign-on` | The sign-in button's label |

The redirect-URI origin check is worth the boot failure it causes. A callback that sets the session
cookie on a different origin than the interface is served from completes an entire successful
sign-in and lands the user signed out, with no error anywhere.

There is one redirect URI, used verbatim. Per-host resolution against an allow-list is deliberately
not implemented: this portal is served on one origin, and an allow-list guarding a decision nobody
makes is a `Host`-header injection surface with no compensating feature.

### 3.4 Control plane — topology and storage

| | | |
|---|---|---|
| `PUBLIC_URL` | **required** | Where browsers reach the portal. It is the allowed `Origin` for every cookie-authenticated write, and what an OIDC redirect URI's origin must equal |
| `PORT` | 8080 | |
| `PROMOTION_CHAIN` | `dev,test,prod` | The stages, in order. The promotion gate reads this |
| `DB_PATH` | `/data/apim.sqlite` in the image | |
| `KEK_PATH` | `/data/kek.key` in the image | The key that encrypts what is in the database |
| `UI_DIST` | `/app/ui/dist` in the image | |
| `TARGETS_FILE` | **required** | One target per (environment, adapter) — §6 |
| `INTEGRATIONS_FILE` | **required** | The egress allowlist and everything referenced by name from policy — §6 |
| `UI_DEV_ORIGIN` | — | A second allowed `Origin`, for running the interface's dev server against this control plane. Not gated on the authentication mode |

### 3.5 Control plane — retention, telemetry and jobs

| | | |
|---|---|---|
| `TELEMETRY_FLUSH_INTERVAL_SEC` | 10 | |
| `TELEMETRY_RETENTION_HOURS` | 48 | |
| `USAGE_FLUSH_INTERVAL_SEC` | — | Quota's recovery-point objective: a lost flush is what a quota can be behind by |
| `MAX_INSTANCES_PER_TARGET` | 16 | A misconfigured deployment loop announces itself instead of multiplying |
| `MAX_REPORT_BYTES` | 1 MiB | One telemetry report's ceiling |
| `ARTIFACT_MAX_BYTES` | — | One compiled contract's ceiling. Past it the **import** is refused, because every gateway downloads it |
| `PLAYGROUND_HISTORY_RETENTION_DAYS` | — | |

### 3.6 Gateway — identity and addressing

| | | |
|---|---|---|
| `DP_NAME` | **required** | This instance's name, unique within its environment |
| `DP_PORT` | 8081 | |
| `GATEWAY_CP_URL` | **required** | Where to poll |
| `GATEWAY_TOKEN_FILE` | **required** (or `GATEWAY_TOKEN`) | **Use the file.** An environment variable is visible to every process in the container and `docker inspect` prints it |
| `POLL_INTERVAL_SEC` | 5 | Also how quickly a revoked key or a revoked instance token takes effect |
| `TRUSTED_PROXY_CIDRS` | empty | Empty means "trust nothing about `X-Forwarded-For`". Correct behind nothing; **wrong behind a load balancer**, where every client address the gateway logs and rate-limits on would be the balancer's |

`TRUSTED_PROXY_CIDRS` is also what the client-certificate policy unit depends on: a gateway refuses
to activate a configuration using it without a trusted-proxy boundary, because otherwise the headers
carrying the verified certificate are attacker-controlled.

### 3.7 Gateway — caches and behaviour

| | | |
|---|---|---|
| `GATEWAY_CONFIG_CACHE` | `/var/lib/apim/config.json` | The last-good document, so a restart during a control-plane outage still serves |
| `GATEWAY_ARTIFACT_CACHE` | `/var/lib/apim/artifacts` | Compiled validators and certificate material. **Per instance, and it must be**: certificate material beside it is written `0600`, so two gateways sharing one directory would race on names and on permissions |
| `ARTIFACT_CACHE_MAX_BYTES` | — | |
| `VALIDATE_POOL_SIZE` | 4 | Warning-mode concurrency |
| `VALIDATE_QUEUE_DEPTH` | 256 | Past it, samples are dropped and counted |
| `MAX_CONCURRENT_UPGRADES` | 1024 | Streams per instance, on top of each route's own ceiling |
| `TELEMETRY_MAX_SERIES` | 2000 | Then new keys fold into an overflow bucket and the drop is counted |
| `DP_TELEMETRY` / `DP_ACCESS_LOG` | on | `off` disables counting / the per-request log line. Both cost measurable throughput |
| `DP_REUSE_PORT` | 0 | `1` puts several gateway processes on one port — Linux only in practice |

---

## 4. The six values sized from traffic

These are the ones with no correct default, because the right number is a property of your traffic.
Each fails in a way that looks like something else, which is why they are together in one table.

| | The rule | What a wrong value looks like |
|---|---|---|
| `MAX_BODY_BYTES` | The largest body any route on this gateway must accept | `413` on a legitimate upload |
| `validate.always.maxBodyBytes` (per route, in policy) | That route's largest body, at or below the above | `413` on one API while the others are fine |
| `BLOCKING_BUFFER_BUDGET_BYTES` | At least the route's `maxBodyBytes` × the number of concurrent blocking requests you mean to absorb | `503` on a route that was validating fine yesterday |
| `MAX_CONCURRENT_REQUESTS` | At least peak requests-per-second × the worst backend latency you mean to absorb | `503` shed too early when a backend degrades |
| `BUN_CONFIG_MAX_HTTP_REQUESTS` | At least `MAX_CONCURRENT_REQUESTS` | One slow backend delays every other route |
| `concurrency.maxInFlight` (per route, in policy) | That route's requests-per-second × its p99, plus headroom | One sick backend fills the whole instance |

Three things that are easy to get wrong about these:

**`MAX_BODY_BYTES` is per instance, not per route.** Raising it for one large-upload API raises the
ceiling for every API on that gateway. The per-route number that should actually differ is the
policy's own `validate.always.maxBodyBytes`.

**`nofile` must be at least four times `MAX_CONCURRENT_REQUESTS`.** Each held request keeps a client
socket and an upstream socket, and a container's default limit of 1024 is reached long before any
ceiling configured here. A stream holds its pair for its whole life, so `MAX_CONCURRENT_UPGRADES`
counts against the same budget. The compose file sets `nofile` to 32768 for this reason.

**A route's `timeoutMs` covers the whole upstream exchange, including streaming the request body
up.** So a large upload from a slow client needs a timeout that covers the transfer, not just the
backend's thinking time. It does *not* bound a passthrough stream — those are bounded by their own
maximum connection seconds, idle timeout and byte ceiling instead.

The measured behaviour behind all six is in [`capacity-report.md`](capacity-report.md): peak
throughput and the knee per workload, what validation costs in each of its three states, what a slow
backend does to holding capacity, and whether one sick route can degrade the others.

---

## 5. Authentication

`AUTH_PROVIDERS` is required, ordered, and closed. There is no default. A deployment that forgets it
does not quietly get the development bypass — it does not boot, and the error names the variable and
its three legal values.

`DEV_AUTH` is retired. A configuration that sets it and not `AUTH_PROVIDERS` fails at boot with a
message naming the replacement, because silently reading the old variable is how a bypass survives
an upgrade.

### Local only

```
AUTH_PROVIDERS=local
BOOTSTRAP_ADMIN_USERNAME=admin
BOOTSTRAP_ADMIN_PASSWORD=<twelve characters or more>
PUBLIC_URL=https://portal.example.com
```

### An identity provider only

```
AUTH_PROVIDERS=oidc
OIDC_ISSUER=https://keycloak.example.com/realms/portal
OIDC_CLIENT_ID=integration-portal
OIDC_REDIRECT_URI=https://portal.example.com/auth/callback
PUBLIC_URL=https://portal.example.com
```

### Both — and this is usually the right answer

```
AUTH_PROVIDERS=oidc,local
```

Single sign-on for people, plus a small number of local administrators for the day the provider is
unreachable or misconfigured. The order is the order the buttons appear in. Keeping `local` on
beside `oidc` keeps a way in exactly when you most need one.

### 5.1 The two claims, and the three shapes they come in

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

**Holding any role for an application is membership of the team that application maps to.** This
product's teams have members and administrators and nothing in between, so a realm that
distinguishes `api.readers` from `api.developers` for the same application collapses to one
membership here. If that distinction has to survive, it has to survive as two teams.

For a realm of this shape the settings are:

```
OIDC_GROUP_CLAIM=apps_with_role
OIDC_ROLE_CLAIM=roles                # or apps_with_role, if the grant is only in the map
OIDC_ADMIN_ROLE=PODP.ADMIN
```

and each team's source group is the **application name** — `PODP`, `MVIS` — matched
case-insensitively.

**Choose `OIDC_ADMIN_ROLE` carefully.** It names one role that makes somebody an administrator of
the *whole portal*: every team, the gateway fleet, the trust store, the audit log, the directory. In
a realm where each application has its own admin role, that means picking the platform team's admin
role specifically. Naming a role many applications carry would make every one of their admins a
portal administrator.

**If the claim path is wrong, nothing fails.** Everybody signs in, everybody is in no team, and
there is no unmapped group to report because there was no group — which looks exactly like "these
people have not been granted access yet". The portal therefore tells the two apart: a user whose
token carried no groups at all is told so on their account page, in those words, rather than being
left to look like an ungranted user.

### 5.2 What to configure on the Keycloak side

- A client with the standard flow enabled and **PKCE required**. A public client needs no secret;
  a confidential one needs `OIDC_CLIENT_SECRET`.
- The exact `OIDC_REDIRECT_URI` registered as a valid redirect URI.
- A role for administrators, named to match `OIDC_ADMIN_ROLE`, and a mapper putting it wherever
  `OIDC_ROLE_CLAIM` points.
- Whatever carries ownership — groups, or per-application roles — mapped into the claim named by
  `OIDC_GROUP_CLAIM`. Then, in the portal, give each team the group or application name that fills
  it. Values are matched whole *and* by last path segment, so `/apim/orders` matches a team whose
  source group is either.
- `offline_access` in the client's scopes, or there is no refresh token and roles and teams stop
  being re-read.

**Groups map to teams that already exist; they never create one.** Unmatched group names are shown
to administrators on the Teams screen, so "half my department can see nothing" has a visible cause
and a one-click fix.

Check it against a real token before rolling out. Decode one from your realm, find the claim that
carries application or group membership, and point `OIDC_GROUP_CLAIM` at that path — not at
`groups` because it is the default.

---

## 6. The two mounted files

Both are read at startup, and both are mounted rather than baked in, because they are the parts that
differ per deployment.

**`TARGETS_FILE`** — one target per environment and adapter: the addresses the portal believes that
environment's gateways answer on. It is what the playground composes a URL from, and what the
Gateways screen groups instances under.

**`INTEGRATIONS_FILE`** — everything a policy refers to *by name*, plus the boundary of what the
platform is allowed to reach:

- the egress allowlist — host patterns, CIDRs, ports and schemes — and the denied ranges,
- registered JWT issuers and their key sets,
- registered token providers for backend authentication,
- registered shared secrets and HMAC schemes,
- the ceilings on XML and validation work,
- the maximum length of a TLS exception.

This is the file that makes the policy vocabulary safe (design §6.1): an owner can say "require a
JWT from the corporate issuer", and cannot say "fetch this URL" or "trust this key I am pasting in".
It is also what makes the playground and every specification import safe against request forgery.

The repository's copies under `config/` allow egress to loopback so the local stack works. **Do not
deploy those.** The image has them at `/app/config.sample/` to copy out and edit.

---

## 7. Enrolling a gateway

A gateway needs a token proving it is allowed to exist. There are two ways to get one and they mint
the same thing:

**From the portal** — Gateways → the environment's target → mint an instance token. Shown once.

**From a shell on the control-plane host, for a deployment with no browser:**

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

---

## 8. Health, readiness and what each answer means

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
a compiled validator it cannot fetch (design §7.5) — keeps serving the previous one and reports why,
and the Gateways screen shows it as blocked with the reason.

---

## 9. Backup and restore

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

---

## 10. Upgrading

The database schema is versioned and migrated forward automatically at startup, one version at a
time, and each step is recorded. There is no separate migration command and no manual step.

The two planes speak a versioned document, so a portal and a gateway of adjacent versions
interoperate. That is what makes a rolling gateway upgrade possible.

**The order that works: control plane first, then gateways.** The reverse can leave a new gateway
asking an old portal for a document version it does not know how to produce.

Rolling the gateways one at a time is safe by construction: each is stateless, converges within one
poll, and the fleet's rate limits are per instance, so removing one instance lowers the fleet
ceiling proportionally rather than shifting load into a shared counter.

---

## 11. What a Kubernetes chart would have to get right

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

**4. `nofile` and the two concurrency ceilings must move together.** At least four times
`MAX_CONCURRENT_REQUESTS`, and `BUN_CONFIG_MAX_HTTP_REQUESTS` at least `MAX_CONCURRENT_REQUESTS` or
the gateway refuses to start. A container runtime's default limit is reached long before any of
these numbers.

**5. Readiness must use the right endpoint per plane.** The control plane's `/readyz`; the gateway's
`/healthz`, and a gateway serving its last-good document during a control-plane outage must stay in
the load balancer. A readiness probe that removed it would turn a control-plane outage into the
traffic outage the whole architecture exists to prevent.

Two more, smaller: the key-encryption key belongs in a `Secret` and not on the same volume as the
database, and the two mounted configuration files belong in a `ConfigMap` — except the parts of
`INTEGRATIONS_FILE` that are secrets, which do not.

---

## 12. Continuous integration

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
deployment would otherwise find first:

- the portal boots with a configuration a real deployment would use — local sign-in, no bypass, its
  own volume, its configuration mounted rather than baked in;
- its bootstrap administrator exists and is behind the forced-password-change gate;
- its metadata endpoint answers `401` without a session — it carries every gateway address the
  playground may use, and it was public until v5;
- the image shipped **no database of its own**, checked by counting the accounts in it. A
  `.dockerignore` regression that shipped a developer's local database would fail here and nowhere
  else — and that database carries every subscription key and certificate the repository has minted;
- the gateway refuses to start without a token **and names the variable**, because a gateway that
  came up unauthenticated and quietly served nothing would look identical to one that is merely
  waiting to converge;
- with a token it starts, listens, and honestly reports that it has activated no configuration;
- neither runs as root.

Both matrix legs run even when one fails: "the gateway image is broken" and "both images are broken"
are different situations, and the run should say which one this is.

---

## 13. Measuring it

Two harnesses, answering two different questions. Neither is a substitute for the other.

```bash
bun run perf --profile=quick
```

**What the gateway adds.** 27 scenarios, each paired with the identical work sent straight to the
backend, writing [`perf-report.md`](perf-report.md). The headline number is always the *difference*,
because absolute throughput on one machine measures that machine.

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
writes [`capacity-report.md`](capacity-report.md).

It deliberately does *not* report CPU per request: that figure could not be measured on this
platform to a standard worth publishing, and the report says why rather than printing a number it
cannot stand behind.

There is also a guardrail inside `bun test` that builds its own world on ephemeral ports, so it
never collides with a running stack. `PERF_GUARD=0` skips it.
