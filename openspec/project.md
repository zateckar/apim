# Integration Portal — OpenSpec Baseline

## Goal

This `openspec/` baseline documents the current application. The intended outcome is brownfield
reconstruction: a separate team should be able to rebuild the same product behaviour, the same
contracts and the same visual language from these specifications without needing the current
source tree.

The capability specs in `openspec/specs/<capability>/spec.md` reference the sections of this file
**by title** rather than restating them. When a spec says "see *Published Path Derivation*", it
means the section of that name here.

## System Summary

- Product name: `Integration Portal`
- An API management platform in **two tiers**, built on our own control plane and our own
  gateways. There is no third-party API-management product anywhere in the system.
  - The **control plane** owns every decision. It holds the directory, the catalogue, the
    policies, the promotion chain, the trust store and the audit trail in one embedded SQLite
    file, and it compiles all of that into one complete configuration document per environment.
  - The **data plane** decides nothing. A fleet of gateways polls the control plane, applies one
    complete configuration document, serves traffic from it, and reports back what it did. A
    gateway that cannot reach the control plane keeps serving the last document it activated.
- Runtime: TypeScript on [Bun](https://bun.sh). **No runtime dependencies** in `control-plane/`
  or `data-plane/` — Bun's standard library and `shared/` only. The portal is React 18 + Vite and
  may take browser dependencies.
- Storage: one embedded SQLite file, migrated forward by numbered SQL files.
- The portal is a single-page React application served by the control plane itself.
- Six external systems (Kafka, SkoNET, email, LdapWS, FixMe, LeanIX) and ELK log search are
  native interfaces with mock implementations behind them. Every screen marks a simulated result
  as simulated.

## Runtime Topology

### Control Plane

- One Bun process. `PORT`, default `8080`, serving both `/api/**` and the built SPA.
- A hand-written router over Bun's HTTP server, not a framework. There is no middleware chain:
  authentication, the CSRF origin check and error shaping happen once, in `dispatch`, in a fixed
  order.
- Every route declares one of three authentication modes:
  - `public` — no session (`/api/me`, the sign-in routes, `/healthz`, `/readyz`).
  - `session` — a session cookie. Mutating methods additionally pass the origin check.
  - `instance` — a gateway replica's bearer token, compared in constant time against the stored
    hash of every unrevoked `gateway_instance`.
- A wildcard SPA fallback serves `UI_DIST`'s `index.html` for any path that is not `/api/**`,
  `/auth/**`, `/healthz` or `/readyz`, so a client-side route survives a hard refresh.
- Background jobs: the reconciler, telemetry flush, usage/quota flush, retention pruning, the
  synthetic uptime probes and the integration outbox.

### Data Plane

- One Bun process per replica. `DP_PORT`, default `8081`. Several replicas may sit behind one
  reverse proxy; that proxy is the **gateway**, and the replicas are its **instances**.
- The instance polls `POST /api/gateway/poll` every `POLL_INTERVAL_SEC` (default 2 s) with a
  bearer token minted by the control plane. See *The Gateway Poll Contract*.
- It reserves exactly two paths of its own — `/healthz` and `/readyz` — and a route base path may
  not shadow them. Neither is counted as traffic.
- Fail-static: an instance that cannot reach the control plane, or that is offered a
  `configVersion` it does not understand, keeps serving the document it last activated and reports
  the refusal as `activationBlocked`.

### Portal

- Vite dev server proxies `/api` to the control plane; in a deployment the control plane serves
  the built bundle.
- Routing is `history.pushState` + `popstate`. There is no router dependency. The route table
  lives in `ui/src/lib/routes.ts` — see *Portal Route Map*.

### Local Estate

`scripts/stack.ps1 -Up` seeds the database and starts the whole estate — control plane, the
gateways of every environment in the chain, and the local upstreams in `tools/`. The portal is at
<http://localhost:8080>. `-Status` and `-Down` do the obvious things; `-Up` does not return.

## Repository Map

```
shared/         policy vocabulary · config contract · telemetry · JSON Schema · XSD · XML · SOAP
                routing · operation matching · MCP · A2A · quota · attention · structural diff
control-plane/  API, SQLite, migrations, promotion, jobs, telemetry and quota aggregation,
                config build, artifact compiler, discovery, catalog search, certificates,
                trust anchors, the playground, the dashboard, authentication and the directory
data-plane/     config poll, route table, the request pipeline, validation, rate limit, quota,
                backend pool and breaker, response cache, stream registry, counters, trust store
ui/             React + Vite SPA, served by the control plane
                ui/src/portal/  the branded shell and its screens — this is the portal users see
                ui/src/views/   the screens the shell composes
                ui/src/lib/     routes · glossary · status · capabilities · attention · datetime
docker/         one Dockerfile per plane; one docker-compose.<plane>.yml each, at the root
tools/          the local upstreams (REST/SOAP/SSE/WebSocket, MCP, A2A) and the two load harnesses
scripts/        seed · stack · demo · mint-instance · schedule-perf
test/           bun test — control plane, data plane, shared
ui/test/        bun test — the parts of the interface that are decisions rather than markup
e2e/            Playwright — read-only smoke tests against a running stack
openspec/       the behavioural source of truth
docs/           design · deployment · walkthrough · plans and reviews · generated reports
CHANGELOG.md    the portal's version and what changed in it — see release-notes-and-changelog
```

Modules named by more than one capability spec:

- `shared/policy.ts` — the closed policy vocabulary, its validators, the global tier allowlist and
  the per-operation override allowlist.
- `shared/config-doc.ts` — the gateway configuration document, the only contract between planes.
- `shared/domains.ts` — the catalogue taxonomy and the published-path derivation.
- `shared/types.ts` — resource kinds, lifecycles, release states, the normalized API model.
- `control-plane/src/operations.ts` — publish, configure, promote and subscribe as durable
  operations.
- `control-plane/src/config-build.ts` — the environment's configuration document, built from the
  database.
- `control-plane/src/attention.ts` — what needs somebody's attention, across every capability.
- `ui/src/lib/routes.ts` — every screen, with the title and one-line purpose the shell renders.
- `ui/src/portal/brand.css` — the visual system, shared verbatim with the predecessor portal.

## Domain Vocabulary

| Term | Meaning |
|---|---|
| **Application** | The publishing *and* consuming identity, with developer memberships. There are no "teams". An application owns APIs, products, certificates and Kafka topics. |
| **Resource** | A published thing: a REST API, a SOAP API, an MCP server or an A2A agent. `kind` distinguishes them. |
| **Product** | An owner-application's explicit bundle of its own APIs. Subscriptions are to products, never directly to an API. |
| **Subscription** | A consumer application's access to a publisher's product in one environment, with purpose, approval state and two keys. |
| **Environment** | A stage of the promotion chain — `dev`, `test`, `prod` by default. |
| **Gateway** | A named data-plane deployment within an environment (`managed`, `onprem`). An environment may hold several. |
| **Instance / replica** | One running process behind a gateway, identified by a minted token. |
| **Operation** | One durable business action (publish, configure, promote, subscribe) with `queued → applying → waiting-for-gateways → complete`. |
| **Policy unit** | One entry from the closed native vocabulary in `shared/policy.ts`. Not XML. |
| **Revision** | One immutable version of a resource's definition. Releases point at revisions. |
| **Release** | A revision's standing in one environment. See *Release States*. |

## Portal Route Map

Two shapes reach the router, and both resolve.

**The branded shell** writes application-scoped addresses:

```
/:applicationId/<section>[/:resourceId]
```

`section` is one of the navigation entries below; an omitted section is `dashboard`. A section
whose third segment names an API rather than a tab: `apis`, `mcp`, `a2a`, `discover`.

Sidebar groups, in order:

- **API** — `apis` (APIs) · `mcp` (MCP Servers) · `a2a` (A2A Agents) · `products` (Products) ·
  `subscriptions` (Subscriptions) · `approvals` (Approvals)
- **Kafka** — `kafka` (Kafka Topics) · `kafka-proxy` (Kafka REST Proxy)
- **Other** — `certificates` (Certificates) · `integrations` (External systems) · `mail` (Mail) ·
  `activity` (Activity)
- **Global** — `/discover` (Catalog) · `/fixme` (FixMe diagnostics) · `/how` (How this works) ·
  `/account` (Your account)
- **Administration**, shown only to an administrator — `/fleet` (Health Status) · `/gateways`
  (Gateways) · `/applications` (Applications) · `/users` (People) · `/telemetry` (Telemetry) ·
  `/policy` (Global policy) · `/trust` (Trust) · `/audit` (Audit)

**The route table** in `ui/src/lib/routes.ts` is the second shape and the authority on titles.
Every entry carries `id`, `pattern`, `title`, `purpose`, `section` and optionally `nav` and
`adminOnly`. Matching is longest-literal-prefix-first, so `/apis/new` is the publish wizard and
not the API whose id is `new`.

| Pattern | Title | Section |
|---|---|---|
| `/` | Home | home |
| `/catalog` | Catalog | use |
| `/catalog/:resourceId` | API | detail |
| `/catalog/:resourceId/subscribe` | Subscribe | detail |
| `/subscriptions` | My subscriptions | use |
| `/subscriptions/:subscriptionId` | Subscription | detail |
| `/apis` | My APIs | publish |
| `/apis/new` | Publish an API | detail |
| `/apis/:resourceId` | API | detail |
| `/apis/:resourceId/:tab` | API | detail |
| `/products` | My products | publish |
| `/fleet` | Health Status | operate (admin) |
| `/gateways` | Gateways | operate (admin) |
| `/telemetry` | Telemetry | operate (admin) |
| `/policy` | Global policy | operate (admin) |
| `/trust` | Trust | operate (admin) |
| `/users` | People | operate (admin) |
| `/users/:userId` | Account | detail |
| `/applications` | Applications | operate (admin) |
| `/applications/:applicationId` | Application | detail |
| `/audit` | Audit | operate (admin) |
| `/account` | Your account | account |
| `/how` | How this works | help |
| *(no match)* | Not found | detail |

`section` classifies a screen by **capability, not inventory**: "Publish APIs" applies to an
application that has published nothing, or nobody could publish a first API. Only `operate` is
gated, and a non-admin who deep-links into one of its screens gets the screen with every control
disabled and one line naming who can change it.

## Control-Plane Endpoint Map

Auth column: `pub` = public, `ses` = session cookie, `inst` = gateway instance token.

### Identity and sessions

| Method | Path | Auth |
|---|---|---|
| GET | `/api/auth/providers` | pub |
| POST | `/api/auth/login` | pub |
| POST | `/api/auth/dev-login` | pub |
| GET | `/auth/login` | pub |
| GET | `/auth/callback` | pub |
| POST | `/api/auth/logout` | ses |
| POST | `/api/auth/password` | ses |
| GET | `/api/me` | pub |
| GET | `/api/meta` | ses |
| GET | `/api/my/sessions` | ses |
| DELETE | `/api/my/sessions/:id` | ses |
| POST | `/api/my/sessions/revoke-all` | ses |

### Directory

| Method | Path | Auth |
|---|---|---|
| GET · POST | `/api/users` | ses |
| GET · PATCH | `/api/users/:id` | ses |
| POST | `/api/users/:id/password` | ses |
| PUT · DELETE | `/api/users/:id/applications/:applicationId` | ses |
| DELETE | `/api/users/:id/sessions` | ses |
| GET · POST | `/api/applications` | ses |
| GET · PATCH · DELETE | `/api/applications/:id` | ses |

### Resources, revisions and releases

| Method | Path | Auth |
|---|---|---|
| GET · POST | `/api/resources` | ses |
| GET · PATCH · DELETE | `/api/resources/:id` | ses |
| GET | `/api/resources/:id/editor` | ses |
| POST | `/api/resources/:id/configure` | ses |
| POST | `/api/resources/:id/owner` | ses |
| POST | `/api/resources/:id/regenerate` | ses |
| GET · PUT | `/api/resources/:id/routes` | ses |
| GET · PUT | `/api/resources/:id/binding` | ses |
| GET · POST | `/api/resources/:id/revisions` | ses |
| GET · POST · DELETE | `/api/resources/:id/releases` | ses |
| POST | `/api/resources/:id/versions` | ses |
| GET | `/api/resources/:id/divergence` | ses |
| GET | `/api/resources/:id/promotion` | ses |
| POST | `/api/resources/:id/promote` | ses |
| GET · PUT | `/api/revisions/:id/spec` | ses |
| GET | `/api/revisions/:id/diff` | ses |
| POST | `/api/publish` | ses |

### Policy

| Method | Path | Auth |
|---|---|---|
| GET | `/api/resources/:id/policy` | ses |
| GET | `/api/resources/:id/policy/effective` | ses |
| PUT · DELETE | `/api/resources/:id/policy/units/:unitKey` | ses |
| POST | `/api/resources/:id/policy/copy-from` | ses |
| GET | `/api/policy/global` | ses |
| PUT · DELETE | `/api/policy/global/units/:unitKey` | ses |
| POST | `/api/policy/global/copy-from` | ses |
| GET | `/api/governance/exceptions` | ses |
| GET | `/api/validation/downgrades` | ses |

### Catalogue, products and subscriptions

| Method | Path | Auth |
|---|---|---|
| GET | `/api/catalog` | ses |
| GET | `/api/catalog/facets` | ses |
| GET | `/api/catalog/:resourceId` | ses |
| POST | `/api/catalog/:productId/subscribe` | ses |
| GET · POST | `/api/products` | ses |
| DELETE | `/api/products/:id` | ses |
| PUT | `/api/products/:id/members` | ses |
| GET · POST | `/api/subscriptions` | ses |
| DELETE | `/api/subscriptions/:id` | ses |
| POST | `/api/subscriptions/:id/reveal` | ses |
| POST | `/api/subscriptions/:id/rotate` | ses |
| GET | `/api/subscriptions/:id/usage` | ses |

### Estate

| Method | Path | Auth |
|---|---|---|
| GET | `/api/environments` | ses |
| GET | `/api/environments/:environment/config` | ses |
| GET · POST | `/api/gateways` | ses |
| PATCH · DELETE | `/api/gateways/:environment/:name` | ses |
| GET | `/api/targets` | ses |
| GET | `/api/targets/:environment/health` | ses |
| GET · POST | `/api/targets/:environment/instances` | ses |
| DELETE | `/api/instances/:id` | ses |
| GET | `/api/health/uptime` | ses |
| GET | `/api/health/synthetics` | ses |
| GET | `/api/telemetry/summary` | ses |
| GET | `/api/telemetry/resources` | ses |
| GET | `/api/telemetry/consumers` | ses |
| GET | `/api/telemetry/instances` | ses |
| GET | `/api/dashboard` | ses |
| GET | `/api/operations` · `/api/operations/:id` | ses |
| GET | `/api/jobs/:id` | ses |
| GET | `/api/audit` | ses |
| GET | `/api/logs` · `/api/logs/histogram` | ses |
| GET | `/api/notifications` | ses |
| GET | `/api/integrations` · `/api/integration-events` | ses |

### Trust and certificates

| Method | Path | Auth |
|---|---|---|
| GET · POST | `/api/certificates` | ses |
| POST | `/api/certificates/:id/renew` | ses |
| DELETE | `/api/certificates/:id` | ses |
| GET · POST | `/api/trust/anchors` | ses |
| DELETE | `/api/trust/anchors/:id` | ses |
| POST | `/api/trust/anchors/preview` | ses |
| POST | `/api/trust/anchors/copy-from` | ses |
| GET · POST | `/api/trust/exceptions` | ses |
| POST | `/api/trust/exceptions/:id/check` | ses |
| DELETE | `/api/trust/exceptions/:id` | ses |

### Playground and Kafka

| Method | Path | Auth |
|---|---|---|
| POST | `/api/playground` | ses |
| GET | `/api/playground/form` | ses |
| GET · DELETE | `/api/playground/history` | ses |
| DELETE | `/api/playground/history/:id` | ses |
| GET · POST | `/api/kafka/topics` | ses |
| PATCH · DELETE | `/api/kafka/topics/:id` | ses |
| GET | `/api/kafka/access` | ses |
| DELETE | `/api/kafka/access/:id` | ses |

### The instance channel

| Method | Path | Auth |
|---|---|---|
| POST | `/api/gateway/poll` | inst |
| GET | `/api/gateway/artifacts/:digest` | inst |
| GET | `/api/gateway/certificates/:id` | inst |

### Liveness

| Method | Path | Auth |
|---|---|---|
| GET | `/healthz` · `/readyz` | pub |

## Data-Plane Endpoint Map

The data plane serves **only** published routes, plus two reserved paths:

| Method | Path | Meaning |
|---|---|---|
| GET | `/healthz` | always 200 with the health body |
| GET | `/readyz` | 200 when the instance has an activated config, 503 otherwise |

Neither is counted as traffic. Everything else is matched against the route table built from the
active configuration document; an unmatched path is a `404` in RFC-7807 shape.

## Data Model

Tables, by the capability that owns them:

- **Directory** — `principal`, `application`, `membership`, `session`, `auth_flow`.
- **Catalogue** — `resource`, `revision`, `route`, `route_gateway`, `binding`,
  `environment_override`, `release`, `release_plan`, `applied`, `artifact`.
- **Selling** — `product`, `product_member`, `subscription`, `usage_counter`.
- **Policy** — `policy_entry`, `global_policy_entry`.
- **Estate** — `target`, `gateway_instance`, `telemetry_rollup`, `job`, `operation`.
- **Trust** — `certificate`, `trust_anchor`, `tls_exception`.
- **Kafka** — `kafka_topic`, `kafka_access`, `kafka_message`.
- **Everything else** — `audit`, `integration_event`, `playground_call`, `schema_version`.

Migrations are numbered SQL files applied in order and recorded in `schema_version`. There is no
down-migration: a schema change is forward-only, because the database holds keys and audit history
that a rollback would have to invent.

## Canonical Algorithms And Constants

### The Authorization Rule

One rule, enforced on the server on **every** request:

```
can(user, applicationId) = user.isAdmin || applicationId ∈ user.applications
```

You may change what your applications own, you may read everything, an administrator may change
anything. The application picker in the browser is context, not proof.

The control plane answers the question per object, as `capabilities: []` on the object itself:

```
capabilitiesFor(user, applicationId) =
  can(user, applicationId) ? ["read","update","delete","publish","policy"] : ["read"]
```

The portal turns that array into "enabled, or disabled with one sentence naming who can" —
`ui/src/lib/capabilities.ts`. **An action the caller cannot perform is disabled with a reason,
never hidden.**

### Error Shape

Every refusal is RFC 7807:

```json
{ "type": "about:blank", "title": "...", "status": 409, "detail": "...", "requestId": "..." }
```

served as `application/problem+json`, with `x-request-id` on every response. `detail` is the
sentence a human reads; nothing asserts on `title` alone.

### Slug Normalisation

```
slugify(input) = input.trim().toLowerCase()
                      .replace(/[^a-z0-9]+/g, '-')
                      .replace(/^-+|-+$/g, '')

slugifyPath(input) = input.split('/').map(slugify).filter(Boolean).join('/')
```

`slugifyPath` exists because a sub-domain such as `Crm/leads` maps 1:1 onto two path segments, so
the slash has to survive normalisation.

### Published Path Derivation

Every published address is **derived, never typed**:

```
storedPath({domain, subdomain, name})   = '/' + [slugify(domain), slugifyPath(subdomain), slugify(name)]
                                                 .filter(Boolean).join('/')
versionSegment(apiVersion)              = slugify(apiVersion) ? '/' + slugify(apiVersion) : ''
publishedPath(parts)                    = storedPath(parts) + versionSegment(parts.apiVersion)
domainPrefix(domain, subdomain)         = '/' + [slugify(domain), slugifyPath(subdomain)]
                                                 .filter(Boolean).join('/')
```

- The **domain is the first segment of the address**, which is what makes the catalogue browsable
  by domain and a URL legible without looking anything up. `domainPrefix` is what the control
  plane enforces; a publisher may choose what follows, but not whether the domain is there.
- The **version is always a segment**, including `v1`. Segment versioning is the estate's
  convention, so a consumer reading a URL knows which contract they are on.
- The path is **stored without** its version segment, because the gateway appends it from the
  API's own `apiVersion`. `stripVersionSegment(path, apiVersion)` is the guard that keeps a
  hand-edited path from becoming `/sales/orders/v2/v2`.
- `API_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/` — it prefills a base path, so it
  stays path-safe.
- API name pattern: `/^[a-z0-9][a-z0-9-]{1,60}$/`.

### The Taxonomy

`shared/domains.ts` holds the closed list of domains and their sub-domains — twelve domains, from
`Aftersales` to `Sales`. A closed list rather than free text, and shared rather than duplicated,
because the same table has to constrain the publish form, validate the write on the control plane
and bucket the catalogue. `domainError(domain, subdomain)` returns the one sentence both surfaces
say.

### Base Path Matching

```
MAX_BASE_PATH_LENGTH   = 128
RESERVED_BASE_PATHS    = ['/healthz', '/readyz']
```

A base path must start with `/`, carry no query, fragment, whitespace or `//`, and has any
trailing slash stripped except at the root. `route` carries `UNIQUE(environment, host, base_path)`:
frontend routing is a row with a constraint, not an implication of a spec's `servers` block.

A path is under a base path **only at a segment boundary**, so `/petstoreXYZ` does not match
`/petstore`; the root base path `/` matches everything. Paths are matched case-sensitively (HTTP
paths are), hosts case-insensitively with the port stripped. A backend URL is joined by
**concatenation**, never `new URL(path, base)`, which would discard the backend's own path segment.

### Policy Vocabulary

A closed, declarative JSON vocabulary. No expressions, no XML, no `send-request`, and no URL an
owner writes is ever fetched: backends live in `binding`, and every reference (`issuerRef`,
`credentialRef`, `tokenProviderRef`) resolves through the admin-registered integrations file.

A **unit** is the smallest thing that can independently exist or be absent; everything beneath a
unit is its values and moves as one piece. Half a `rateLimit` is never merged.

```
POLICY_UNITS = auth.subscriptionKey · auth.basic · auth.jwt · auth.introspection · auth.mtls ·
               ipAllow · cors · preconditions · validate · rewrite · headers.request ·
               headers.response · transform · cache · rateLimit · quota · timeoutMs · retries ·
               circuitBreaker · concurrency · backendAuth · passthrough · errorFormat
```

- `GLOBAL_UNITS` — the seventeen a whole environment may carry. An allowlist, so a unit added
  later is not globally attachable until somebody decides it should be. The six that are missing
  are per-API by nature: `errorFormat` is derived from the variant; `rewrite`, `transform`,
  `backendAuth` and `cache` describe one backend and one contract; `passthrough` changes what a
  route *is*.
- `OPERATION_OVERRIDABLE` — `validate`, `rateLimit`, `quota`, `timeoutMs`, `cache`. A per-operation
  key is written `operations["getPet"].rateLimit`, and no per-operation unit is globally
  attachable, because an operation id means nothing outside the API that declares it.
- `disabled` is a reserved key holding the unit keys a document carries but the gateway must not
  apply — turning a policy off and losing its configuration are different things. It is subtracted
  in the control plane, in `activeDocument`, so a disabled unit never reaches the wire and no
  gateway has to know the concept exists.
- Bounds: `DEFAULT_TIMEOUT_MS = 30_000`, `MAX_TIMEOUT_MS = 120_000`,
  `MAX_PATTERN_LENGTH = 200`, `PATTERN_VALUE_MAX_BYTES = 1024`,
  `MAX_ROUTE_IN_FLIGHT = 100_000`.

Unknown unit keys and unknown fields are **rejected**, so nothing passes through unread. The
control plane validates on write; the data plane interprets.

### The Configuration Document

`shared/config-doc.ts` is the only contract between the planes. `CONFIG_VERSION = 4`. The control
plane owns desired state; the document is the projection the data plane serves from.

```
GatewayConfig = { configVersion, environment, digest, generatedAt, limits,
                  routes[], subscriptions[], certificates[], trustAnchors[], references, errors[] }
```

- `routes[]` carries the **effective** policy document — the environment's global tier merged
  under the resource's own units — never the two tiers separately.
- Subscription keys travel as **sha256 hashes**. Plaintext keys never leave the control plane.
- Compiled validators travel on a **separate channel** as `artifacts[]` references, because
  schemas reach megabytes; a config whose artifacts an instance has not fetched is not activated.
- Certificate **material** travels on the instance channel keyed `<id>-<thumbprint>`, so a new
  thumbprint under the same id is the designed rotation path.
- Trust anchors travel **inline**: a CA certificate is 1–2 KiB, so the artifact channel would buy
  activation-gating complexity for nothing. `notAfter` travels with both anchors and TLS
  exceptions so an instance drops an expired one on its own clock — fail-static config must not
  keep a dead CA or an expired exception alive through a control-plane outage.
- `errors[]` names routes that could not be rendered. A route whose effective policy document is
  invalid is **omitted rather than served**: an API that does not answer is visible, an API
  answering under a document nobody validated is not.
- An instance offered a `configVersion` it does not understand refuses it, keeps serving what it
  has, and reports `activationBlocked`.

### The Gateway Poll Contract

```
PollRequest  = { wireVersion, instance: { name, runId, startedAt, activeDigest, process,
                                          requestsTotal, activationBlocked? },
                 telemetry, quota?: { deltas[] } }
PollResponse = { wireVersion, unchanged, digest, acceptedWindows[], config?, quotaAggregates? }
```

- `runId` is fresh per process, so a restart writes new rows instead of replacing.
- `activeDigest` is what the instance has **activated**, not what it is asking about.
- `acceptedWindows` are the closed telemetry windows the control plane took responsibility for;
  the instance clears exactly those and no others.
- Quota deltas are **best-effort**: a lost report under-counts and is never retried, because a
  retried delta would double-count a consumer into a 403.

Bounds (`TELEMETRY_DEFAULTS`): `maxSeries 2000`, `maxWindowsPerReport 15`,
`maxReportBytes 1 MiB`, `maxRunsPerInstanceWindow 16`, `flushIntervalSec 10`,
`retentionHours 48`, `jobRetentionHours 168`, `maxInstancesPerTarget 16`.

### Resource Kinds

```
RESOURCE_KINDS = rest | soap | mcp | a2a
RPC_KINDS      = mcp | a2a          -- one endpoint, a JSON-RPC call, a selector
```

The set is closed and is extended by reviewed work in the codebase, never by configuration: a
variant carries a request shape and a validation model, which is more than a config file should be
able to introduce.

`OriginalFormat = swagger-2.0 | openapi-3.0 | openapi-3.1 | wsdl-1.1 | mcp-manifest |
a2a-agent-card`. Every one of them normalises into the single `ApiModel` in `shared/types.ts`, and
everything downstream reads that model rather than the upload.

### Release States

```
RELEASE_STATES        = pending · converging · converged · superseded · withdrawn · failed · stale
REACHED_FLEET_STATES  = converged · superseded · withdrawn
LIFECYCLES            = active · deprecated · retired
```

`superseded` and `withdrawn` are reachable only from `converged`, enforced by a database trigger,
which is what lets the promotion gate read "has this revision ever reached the fleet here" from
`release.state` alone.

### The Status Vocabulary

Every chip in the portal comes from `ui/src/lib/status.ts`, and **a state is named by what it
means for the reader**, not by the column value. `converged` is a word from the reconciler; a
person reading a list wants *Live*. The column value stays available as the chip's `title`.

`tone` is a small closed set, because colour has to mean one thing across the whole product:

| Tone | Meaning |
|---|---|
| `live` | good and current |
| `wait` | in progress |
| `stop` | broken or refusing |
| `past` | history |
| `warn` | fine today and not tomorrow |
| `neutral` | no news |

| Domain | State → chip |
|---|---|
| release | converged → **Live** `live` · pending/converging → **Publishing** `wait` · superseded → **Replaced** `past` · withdrawn → **Withdrawn** `past` · failed → **Failed** `stop` · stale → **Needs confirming** `stop` |
| lifecycle | active → *(no chip)* · deprecated → **Deprecated** `warn` · retired → **Retired** `stop` |
| releasedIn | live → **Live** `live` · previously → **Was live** `past` · never → **Never** `neutral` |
| subscription | active → **Active** `live` · revoked → **Revoked** `stop` |
| instance | revoked → **Revoked** `stop` · stale → **Not reporting** `stop` · out of sync → **Catching up** `wait` · else **Healthy** `live` |

A test iterates `STATUS_DOMAINS` and asserts the vocabulary is **total** over every state, so a
new state cannot ship without a word for it.

### Date, Time and Duration Formatting

One format for the whole portal, in `ui/src/lib/datetime.ts`. Every timestamp the control plane
returns is ISO-8601 UTC; a timestamp with no zone is read as UTC, because guessing local would
shift every log line by the reader's offset. Every screen that shows a timestamp goes through one
of these — a screen that formatted its own would be the one whose clock disagrees with the audit
log.

| Helper | Format | Missing / unparseable |
|---|---|---|
| `formatDateTime` | `DD.MM.YYYY HH:MM:SS`, 24-hour, local | `n/a` |
| `formatDate` | `DD.MM.YYYY` | `n/a` |
| `formatDateTimeShort` | `DD.MM.YY HH:MM:SS` | `n/a` |
| `formatClock` | `HH:MM` | `""` |
| `formatDuration` | `125 ms` · `1.4 s` · `3 min` | `n/a` |
| `formatAgo` | `3 minutes ago`, falling back to `formatDate` past a month | `n/a` |
| `toDateTimeInput` / `fromDateTimeInput` | the editable `DD.MM.YYYY HH:MM:SS` round trip | `undefined` |

`n/a` rather than an empty cell: an empty cell reads as a layout bug, and the difference between
"never happened" and "we lost it" is worth a word. Date rollovers are **refused** rather than
normalised — `32.01.2026` is a typo, and a field that quietly turned it into 1 February would hide
it.

## Environment Variables

### Control Plane

Explicit values, no fallback chains. A wrong or missing value is a startup failure that names the
variable, never a silent downgrade.

| Variable | Default | Notes |
|---|---|---|
| `PORT` | `8080` | |
| `DB_PATH` | `.data/apim.sqlite` | |
| `PUBLIC_URL` | `http://localhost:8080` | the origin the CSRF check and the OIDC callback are held to |
| `KEK_PATH` | `.data/kek.key` | the key-encryption key for stored secrets |
| `PROMOTION_CHAIN` | `dev,test,prod` | ordered, no duplicates, at least one |
| `AUTH_PROVIDERS` | **required** | ordered subset of `local,oidc,dev`; no default |
| `TARGETS_FILE` | `config/targets.json` | |
| `INTEGRATIONS_FILE` | `config/integrations.json` | |
| `UI_DIST` | `ui/dist` | |
| `UI_DEV_ORIGIN` | *(none)* | a second allowed `Origin` for the CSRF check |
| `SESSION_IDLE_MIN` | `60` | |
| `SESSION_LIFETIME_HOURS` | `8` | |
| `SESSION_PRUNE_AFTER_DAYS` | `30` | |
| `LOCAL_PASSWORD_MIN_LEN` | `12` | |
| `LOCAL_LOCKOUT_THRESHOLD` | `10` | |
| `LOCAL_LOCKOUT_MINUTES` | `15` | |
| `LOCAL_LOGIN_RATE_PER_MIN` | `60` | across all callers, in front of the argon2 hash |
| `BOOTSTRAP_ADMIN_USERNAME` / `_PASSWORD` | *(none)* | both or neither |
| `OIDC_ISSUER` · `OIDC_CLIENT_ID` · `OIDC_REDIRECT_URI` | **required with `oidc`** | |
| `OIDC_CLIENT_SECRET` | *(none)* | absent means a public PKCE client |
| `OIDC_SCOPE` | `openid profile email offline_access` | must include `openid` |
| `OIDC_ROLE_CLAIM` | `realm_access.roles` | dotted path |
| `OIDC_ADMIN_ROLE` | `apim-admin` | |
| `OIDC_GROUP_CLAIM` | `groups` | |
| `OIDC_CLAIMS_REFRESH_SEC` | `300` | |
| `OIDC_AUTO_CREATE` | `1` | |
| `OIDC_END_SESSION` | `0` | |
| `OIDC_DISPLAY_NAME` | `Single sign-on` | the sign-in button's label |
| `INSTANCE_STALE_AFTER_SEC` | `30` | |
| `MAX_SPEC_BYTES` | `5 MiB` | |
| `TELEMETRY_FLUSH_INTERVAL_SEC` | `10` | |
| `TELEMETRY_RETENTION_HOURS` | `48` | |
| `JOB_RETENTION_HOURS` | `168` | |
| `MAX_REPORT_BYTES` | `1 MiB` | |
| `MAX_INSTANCES_PER_TARGET` | `16` | |
| `MAX_RUNS_PER_INSTANCE_WINDOW` | `16` | |
| `ARTIFACT_MAX_BYTES` | *(see `artifacts.ts`)* | one compiled bundle's ceiling |
| `USAGE_FLUSH_INTERVAL_SEC` | `10` | also the quota RPO |
| `MAX_QUOTA_ENTRIES` | *(see `shared/quota.ts`)* | rows exchanged per poll, each direction |
| `CATALOG_PAGE_SIZE` | `24` | |
| `PLAYGROUND_MAX_BODY_BYTES` | `256 KiB` | |
| `PLAYGROUND_MAX_RESPONSE_BYTES` | `512 KiB` | |
| `PLAYGROUND_TIMEOUT_MS` | `30_000` | |
| `PLAYGROUND_RATE_PER_MIN` | `60` | per user; protects the control plane, not the quota |
| `PLAYGROUND_HISTORY_PER_RESOURCE` | `25` | |
| `PLAYGROUND_HISTORY_RETENTION_DAYS` | `7` | |
| `PLAYGROUND_HISTORY_BODY_BYTES` | `4096` | bounds what is *stored*, not what is sent |
| `REVISION_KEEP_COUNT` | `5` | at least 1 |
| `REVISION_KEEP_DAYS` | `365` | |
| `MAX_TRUST_ANCHORS` | `16` | at least 1 |
| `DASHBOARD_DEFAULT_SINCE_MIN` | `1440` | at least 1 |
| `LOGS_PROVIDER` | `mock` | `elk` or `mock`; **no fallback** from `elk` to `mock` |
| `ELK_URL` | *(none)* | required with `elk`, and must be in the egress allowlist |
| `ELK_API_KEY` *or* `ELK_USERNAME`/`ELK_PASSWORD` | *(none)* | one is required with `elk` |
| `ELK_INDEX` | `apim-access-*` | |
| `ELK_UPTIME_INDEX` | `heartbeat-*` | a separate index: Heartbeat writes one document per check |
| `ELK_TIMEOUT_MS` | `10_000` | |
| `ELK_MAX_RESULT_WINDOW` | `10_000` | |
| `LOGS_MAX_RANGE_HOURS` | `720` | |

Refusals checked at boot, before anything serves:

- `AUTH_PROVIDERS` is required and closed. There is no default, because a control plane that
  guessed would either be unreachable or wide open.
- `dev` cannot be combined with `oidc`. A bypass beside a real directory is the worst of both: it
  looks configured and it is not.
- `DEV_AUTH` is retired; setting it without `AUTH_PROVIDERS` is a startup failure that says so.
- `OIDC_REDIRECT_URI`'s origin must equal `PUBLIC_URL`'s, or the callback sets the session cookie
  on an origin that is never sent back and the user completes sign-in and arrives signed out.
- `OIDC_ISSUER`, `ELK_URL` and every `gatewayUrls` entry are checked against the egress allowlist
  at boot, on the string, without a network call.
- Every target's environment must be in `PROMOTION_CHAIN`.
- `REVISION_KEEP_COUNT`, `MAX_TRUST_ANCHORS` and `DASHBOARD_DEFAULT_SINCE_MIN` refuse `0`
  by name: zero is a legal integer and a destructive value for all three.

### Data Plane

| Variable | Default | Notes |
|---|---|---|
| `DP_NAME` | `dev-1` | this instance's name |
| `DP_PORT` | `8081` | |
| `GATEWAY_CP_URL` | `http://localhost:8080` | |
| `GATEWAY_TOKEN` / `GATEWAY_TOKEN_FILE` | *(none)* | the minted instance token |
| `GATEWAY_CONFIG_CACHE` | `.data/dp-<name>-config.json` | what fail-static serves from |
| `GATEWAY_ARTIFACT_CACHE` | `.data/dp-<name>-artifacts` | |
| `ARTIFACT_CACHE_MAX_BYTES` | `512 MiB` | |
| `POLL_INTERVAL_SEC` | `2` | |
| `MAX_BODY_BYTES` | `8 MiB` | |
| `MAX_CONCURRENT_REQUESTS` | `2048` | |
| `MAX_CONCURRENT_UPGRADES` | `1024` | |
| `BLOCKING_BUFFER_BUDGET_BYTES` | `256 MiB` | |
| `VALIDATE_POOL_SIZE` | `4` | |
| `VALIDATE_QUEUE_DEPTH` | `256` | |
| `RESPONSE_CACHE_MAX_ENTRIES` | `10_000` | |
| `RESPONSE_CACHE_MAX_BYTES` | `64 MiB` | |
| `TELEMETRY_MAX_SERIES` | `2000` | |
| `TELEMETRY_MAX_WINDOWS_PER_REPORT` | `15` | |
| `TRUSTED_PROXY_CIDRS` | *(none)* | who may set forwarding headers |
| `TRUSTED_PROXY_CLIENT_CERT_HEADERS` | *(none)* | the headers a terminating proxy presents a client certificate in |
| `TRUST_SYSTEM_ROOTS` | `1` | `0` trusts only the environment's anchors |
| `JWKS_MIN_REFETCH_SEC` | `60` | |
| `DP_TELEMETRY` | `on` | |
| `DP_ACCESS_LOG` | `on` | |
| `DP_REUSE_PORT` | `0` | |

## Configuration Files

### `TARGETS_FILE`

`{ targets: TargetDef[] }`. One entry per gateway per environment.

```
TargetDef = { environment, adapter, name?, category?, enforce, paused, config,
              publicUrl?, intranetUrl?, label? }
```

- `name` defaults to `adapter`, matches `^[a-z0-9][a-z0-9-]{0,31}$`, and is unique within an
  environment. It is the identity a publish carries along the promotion chain, so "published on
  `managed`" still means something two environments later.
- `category` is `managed | samb | other`. It groups the list; it decides nothing.
- `publicUrl`, `intranetUrl` and `label` are **seeds only**: written when the target row is created
  and never again, because an administrator can change them on the Gateways screen and a file that
  reasserted itself at every boot would silently undo them.
- `config.gatewayUrls` is `[{label, url}]` — where the playground may send a request in that
  environment. Labels are unique within the environment; each URL is an origin with an optional
  path prefix, no query, no fragment, no trailing slash. Absent is legitimate and disables the
  playground there, which the endpoint says in as many words.

### `INTEGRATIONS_FILE`

The admin-registered references a policy may name, plus the estate's ceilings:
`egressAllowlist[]`, `denyCidrs[]`, `xml` limits, `validationCeilings`, `tlsExceptionMaxDays`,
and the issuer / token-provider / HMAC / secret registries. A dangling reference is a **boot
failure** naming both the reference and where it is used — a policy pointing at a missing secret
would otherwise fail at the first request instead.

## Visual Identity Summary

- The visual system lives in `ui/src/portal/brand.css` and is shared verbatim with the predecessor
  portal, so UI parity is a markup exercise rather than a styling one. Prefer an existing class
  over a new one.
- Left navigation: dark green vertical gradient, centred logo, slanted application cards, grouped
  sections (API · Kafka · Other · Global · Administration).
- Main content: white canvas, muted green borders, little card chrome except where a boundary
  means something.
- Signature controls: gooey dual-pill "liquid" buttons for primary actions; trapezoid environment
  switchers and chips; rounded pill inputs and selects; CodeMirror with a light theme for schema
  editing; a three-step `.stepper` for the publish wizard.
- Chip variants: bare `.chip` (neutral), `.ok`, `.warn`, `.err`, `.info`, `.violet`, `.accent` —
  driven by the tone vocabulary above, never by a colour written into a view.
- Responsive breakpoint `1100px`; below it the two-column shell collapses to a single column and
  the sidebar becomes a toggled drawer.

## Interface House Rules

Enforced over the source by `ui/test/hygiene.test.ts`, not by review:

- **Every screen has a title and a one-line purpose**, taken from `ui/src/lib/routes.ts`. The shell
  renders both, so a screen cannot exist without them.
- No colour written into a view — no `#rrggbb` outside the stylesheet.
- No click handler a keyboard cannot reach: only `button`, `a` and capitalised components may
  carry `onClick`.
- No empty state without an action.
- No `confirm()`, and no delete of a named object outside a typed confirmation (`DangerZone`).
- No request whose error is never rendered: every `useAsync` / `useAction` error reaches the page.
- Every `tone-*` class a view names must exist in the stylesheet.

## Rebuild Guidance

To recreate the system, implement in this order. The capability specs follow the same breakdown.

1. Runtime, configuration and the environment model — `runtime-configuration`
2. The router, sessions and the one authorization rule — `auth-and-access`
3. The shell, its route table and the status vocabulary — `portal-shell-navigation`,
   `frontend-visual-system`
4. The control plane's own surface: durable operations, the reconciler, audit —
   `control-plane-surface`
5. The configuration document and the gateway that applies it — `data-plane-gateway`
6. Publishing, and the catalogue it fills — `api-publish-flow`, `workspace-api-catalog`
7. Properties, definitions and the backend surface — `api-edit-properties`,
   `backend-integration-surface`
8. Policy, in two tiers — `api-policy-controls`
9. Products, subscriptions and keys — `api-subscription-management`
10. Versions and promotion — `api-versioning-and-stage`
11. The playground and per-request logs — `api-testing-playground`, `request-logs`
12. Health, telemetry and the dashboard — `dashboard-health`
13. Certificates and the trust store — `app-certificates`
14. The RPC variants — `ai-gateway-mcp-a2a`
15. Kafka — `kafka-workspace`, `kafka-playground`
16. The surrounding systems — `integrations-and-mocks`, `skonet-integration`,
    `leanix-integration`, `notifications-and-mail`
17. Administration — `platform-administration`
18. The change log and the smoke suite — `release-notes-and-changelog`,
    `post-build-smoke-tests`

## Specification Governance

`openspec/` is the functional source of truth for product behaviour. The rule is written out in
`openspec/specs/spec-governance/spec.md`; in summary:

- Every code change that alters user-visible behaviour, contracts, validation, routing, styling
  semantics, environment handling or external integrations updates the affected spec files **in the
  same change**.
- Every materially new capability either extends an existing capability spec or adds a new one
  under `openspec/specs/<capability>/spec.md`. When behaviour is deleted, its requirement is
  deleted.
- Spec drift is a defect. If the code and the spec disagree, the change is not finished.
- Accuracy is validated against source, tests and runtime behaviour — never against intent alone.
