# Integration Portal

An API management platform in two tiers, built on our own control plane and our own gateways.
There is no Azure API Management anywhere in this system: the control plane owns every decision,
and a fleet of data-plane gateways polls it, applies one complete configuration document, and
never decides anything.

TypeScript on [Bun](https://bun.sh), no runtime dependencies in the two planes, one embedded
SQLite file. React + Vite for the portal.

## `openspec/` is the behavioural source of truth

**Read `openspec/specs/<capability>/spec.md` before changing behaviour, and update it in the same
change.** The specs — not this file, not the code comments, not `docs/` — say what the product
does. `docs/` holds design history and rationale; `openspec/` holds the contract.

- `openspec/project.md` — the system baseline: topology, route map, endpoint map, canonical
  algorithms, constants, environment variables. Capability specs reference its sections by title
  rather than restating them.
- `openspec/specs/<capability>/spec.md` — one file per capability, in OpenSpec format:
  `## Purpose`, then `## Requirements`, then `### Requirement: <imperative sentence>` each
  followed by one or more `#### Scenario: <name>` written as `GIVEN / WHEN / THEN / AND` bullets
  using RFC 2119 `SHALL`.
- `openspec/specs/spec-governance/spec.md` is the rule that binds all of it. Spec drift is a
  defect: if the code and the spec disagree, the change is not finished.

When you add a materially new capability, add a new spec directory rather than stretching an
existing one. When you delete behaviour, delete its requirement.

Provenance note: these specs were ported from an earlier Azure-APIM-backed portal. Anything that
described Azure — ARM, `apisByTags`, APIM revisions, policy XML, Key Vault, tag-derived
applications, gateway ids like `azurews` — was removed rather than translated. If you find an
Azure-shaped concept in a spec, that is a porting bug; fix the spec.

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
                ui/src/portal/  the branded shell and its screens — this is the portal users see
                ui/src/views/   the screens the shell composes
                ui/src/lib/     routes · glossary · status · capabilities · attention
docker/         one Dockerfile per plane; one docker-compose.<plane>.yml each, at the root
tools/          the local upstreams (REST/SOAP/SSE/WebSocket, MCP, A2A) and the two load harnesses
scripts/        seed · stack · demo · mint-instance · schedule-perf
test/           bun test — control plane, data plane, shared
ui/test/        bun test — the parts of the interface that are decisions rather than markup
openspec/       the behavioural source of truth (see above)
docs/           design · deployment · walkthrough · plans and reviews · generated reports
```

## Domain vocabulary

Use these words. They are the ones the specs, the schema and the UI all use.

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

## Commands

```bash
bun install
```

```bash
pwsh -File scripts/stack.ps1 -Up -Rebuild
```

Seeds the database and starts the whole estate; the portal is at <http://localhost:8080>.
`-Status` and `-Down` do the obvious things. **`-Up` does not return** — background it and confirm
with `-Status`; configuration changes need a `-Down` / `-Up` cycle.

```bash
bun test          # control plane, data plane, shared
bun run test:ui   # the interface's decision tables and source-level rules
bun run test      # both, in that order
bun run typecheck # both projects
bun run test:e2e  # Playwright smoke tests against a running stack
```

## House rules

- **No runtime dependencies in `control-plane/` or `data-plane/`.** Bun's standard library and
  `shared/` only. The UI may take browser dependencies.
- **No Azure.** No ARM shapes, no policy XML, no APIM revision semantics, no Key Vault. The six
  external systems (Kafka, SkoNET, email, LdapWS, FixMe, LeanIX) and ELK log search are native
  interfaces with mock implementations behind them; the UI marks simulated results as simulated.
- **One authorization rule.** You may change what your applications own, you may read everything,
  an administrator may change anything. Enforce it on the server on every request; the application
  picker in the browser is context, not proof.
- **Every screen has a title and a one-line purpose**, taken from `ui/src/lib/routes.ts`. The
  shell renders both, so a screen cannot exist without them.
- **No colour written into a view**, no click handler a keyboard cannot reach, no empty state
  without an action, no `confirm()`, no delete of a named object outside a typed confirmation, no
  request whose error is never rendered. `ui/test/hygiene.test.ts` enforces these over the source.
- **The visual system lives in `ui/src/portal/brand.css`** and is shared with the predecessor
  portal. Prefer an existing class over a new one; if you need a new component, check whether the
  stylesheet already has it.
- Match the surrounding code's comment density and idiom. The comments here explain *why* a
  decision was made, usually citing a design section or a review finding; keep that habit.
