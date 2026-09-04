# Integration Portal

An API management platform in two tiers: a **control plane** where teams publish APIs, attach
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
| **Identity** | Local accounts, OIDC (Keycloak), or both. Team membership arrives from directory groups and is re-read on an interval; every membership shows where it came from. One authorization rule: you may change what your teams own, you may read everything, an administrator may change anything |

Built from [`docs/greenfield-design.md`](docs/greenfield-design.md) over five versions
([v1](docs/mvp-plan.md) · [v2](docs/v2-plan.md) · [v3](docs/v3-plan.md) · [v4](docs/v4-plan.md) ·
[v5](docs/v5-plan.md)), each with a [review](docs/v5-plan-review.md) of its own.

---

## What it needs

- [Bun](https://bun.sh) 1.4 to run from source, or Docker to run the images.
- [PowerShell 7](https://github.com/PowerShell/PowerShell) (`pwsh`) for the local stack scripts. It
  is cross-platform; nothing else needs it.
- Nothing else. No database server, no cache, no message broker, no runtime packages.

---

## Run it

### Locally, from source

```bash
bun install
```

```bash
pwsh -File scripts/stack.ps1 -Up -Rebuild
```

That seeds the database, mints a token per gateway, and starts nine processes: four upstreams that
know nothing about this platform, the control plane on `:8080`, and four gateways on `:8081`–`:8084`
across three environments. The portal is at <http://localhost:8080>.

```bash
pwsh -File scripts/stack.ps1 -Status
```

```bash
pwsh -File scripts/stack.ps1 -Down
```

The seed writes `AUTH_PROVIDERS=dev` into `.env.local`, so you can sign in as Alice (administrator),
Pavel (publisher) or Clara (consumer) with one click. That bypass is not a default — no deployment
gets it without naming it (see below).

[`docs/walkthrough.md`](docs/walkthrough.md) walks every journey by hand, and
`pwsh -File scripts/demo.ps1` walks them as a script, in two acts.

### In containers

One compose file per plane, because in a real deployment they are on different hosts — the portal
beside its backup schedule, the gateways beside the traffic. On one machine, pass both.

```bash
cp .env.example .env
```

Set `BOOTSTRAP_ADMIN_PASSWORD` — twelve characters minimum, and the portal will make you change it
at first sign-in anyway.

```bash
docker compose -f docker-compose.control-plane.yml up -d
```

```bash
mkdir -p .secrets && docker compose -f docker-compose.control-plane.yml run --rm --no-deps control-plane bun run scripts/mint-instance.ts dev dev-1 > .secrets/dev-1
```

```bash
docker compose -f docker-compose.control-plane.yml -f docker-compose.data-plane.yml up -d
```

Then <http://localhost:8080>. Sign in as the bootstrap administrator and choose a password — the one
from `.env` is in a file, a shell history and `docker inspect`, so the portal will not let it be
kept. [`docs/deployment.md`](docs/deployment.md) is the long version, including why the mint has to
happen before the last step and what changes when the gateway is on its own host.

### From published images

Two images, built and published separately, sharing no runtime state:

```
ghcr.io/<owner>/<repo>/control-plane
ghcr.io/<owner>/<repo>/data-plane
```

Both run as a non-root user, read every setting from the environment and mounted files, carry a
health check, and start with no repository checkout. The full environment contract is in
[`docs/deployment.md`](docs/deployment.md) §3.

---

## Signing in

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

Roles and team membership come from the token's claims and are re-read on a bounded interval, so a
group removed in Keycloak takes effect without a sign-out. Groups are matched to teams that already
exist, never creating one, and unmatched group names are shown to administrators.

Both claims are named by a dotted path and read in whichever shape your realm issues — a list of
group paths, a space-separated string, or a role → applications map, where the values are the teams
and the keys are the roles. **Decode a real token before trusting the defaults**: a claim path that
matches nothing produces users who sign in fine and own nothing, which looks like a permissions
problem and is not. See [`docs/deployment.md`](docs/deployment.md) §5.1.

**Both, which is usually right:** `AUTH_PROVIDERS=oidc,local` — single sign-on for people, plus a
few local administrators for the day the provider is unreachable. The order is the order the buttons
appear in.

`OIDC_CLIENT_SECRET` is optional (absent means a public PKCE client, the Keycloak default for this
shape). Everything else — claim paths, the admin role, the refresh interval, auto-creation, single
logout — has a default and is documented in [`docs/deployment.md`](docs/deployment.md) §3.3.

---

## Tests

```bash
bun test
```

717 tests across 33 files: the shared vocabulary, the JSON Schema and XSD validators, the control
plane, the gateway pipeline, promotion, versioning, telemetry, the fleet, SOAP, artifacts,
validation in all three states, backend pools and the breaker, trust anchors, quota, streaming, the
global tier, MCP, A2A, the catalog, the playground, the dashboard, revisions and the structural
diff, the concurrency bulkheads, local and OIDC authentication against a real in-process identity
provider, users, teams and sessions, a migration test that upgrades a real v1 database, and a
performance guardrail (`PERF_GUARD=0` skips it).

```bash
bun run test:ui
```

85 tests across 9 files, over the parts of the interface that are decisions rather than markup: the
attention vocabulary and its ordering, capabilities for owner / other team / administrator, glossary
coverage, status totality, that every route has a title and a purpose, that a fresh account's primary
controls are enabled or disabled-with-a-reason, and a set of source-level rules — no click handler a
keyboard cannot reach, no colour written into a view, no empty state without an action, no
`confirm()`, no delete of a named object outside a typed confirmation, no request whose error is
never rendered.

```bash
bun run test
```

Both, in that order. `bun run typecheck` type-checks both projects.

```bash
bun run perf --profile=quick
```

```bash
bun run capacity --profile=standard --cpus=4
```

Two harnesses answering two different questions — what the gateway *adds*, and what one gateway
*takes*. Both write generated reports; [`docs/deployment.md`](docs/deployment.md) §13 explains which
one answers which question and how to read them without being trapped by the arithmetic.

---

## Where to read more

| | |
|---|---|
| [`docs/design.md`](docs/design.md) | **What this application does**, functionally: the objects, the roles, the seven journeys, policy, validation, promotion, traffic, trust, and what an operator decides. Written for somebody who will never open the source |
| [`docs/deployment.md`](docs/deployment.md) | The environment contract in full, the two images, compose, the six values sized from traffic, backup and restore, upgrading, and what a Kubernetes chart would have to get right |
| [`docs/walkthrough.md`](docs/walkthrough.md) | Every journey by hand through the interface, and every protocol with `curl` |
| [`docs/greenfield-design.md`](docs/greenfield-design.md) | The **original architecture proposal** this was built from — a target written before any of it existed, and the source of the section numbers the plans cite. `design.md` says where the two differ, and why |
| [`docs/v5-plan.md`](docs/v5-plan.md) and its four predecessors | The implementation detail, the decision records, and a review of each |
| [`docs/perf-report.md`](docs/perf-report.md) · [`docs/capacity-report.md`](docs/capacity-report.md) | Generated measurements |

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
ui/             React + Vite SPA, served by the control plane; src/lib holds the four tables the
                whole interface reads from — routes, glossary, status, capabilities
docker/         one Dockerfile per plane; one docker-compose.<plane>.yml each, at the root
tools/          the local upstreams (REST/SOAP/SSE/WebSocket, MCP, A2A) and the two load harnesses
scripts/        seed · stack · demo · mint-instance · schedule-perf
test/           bun test
docs/           design · deployment · walkthrough · five plans and five reviews · two reports
```
