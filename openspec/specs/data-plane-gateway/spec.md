# data-plane-gateway Specification

## Purpose

Define the gateway: a process that **decides nothing**. It polls the control plane, applies one
complete configuration document, serves traffic from it in a fixed pipeline order, and reports back
what it did. See *The Configuration Document*, *The Gateway Poll Contract* and *Base Path Matching*
in `openspec/project.md`.

## Requirements

### Requirement: Take every decision from one configuration document

The gateway SHALL hold no configuration of its own beyond how to reach the control plane and how
to bound itself.

#### Scenario: A behaviour is needed that the document does not describe

- GIVEN any routing, policy, subscription, certificate or trust decision
- WHEN a request needs it
- THEN it SHALL come from the active configuration document
- AND the gateway SHALL NOT read it from its own environment, a local file, or a request header

### Requirement: Poll bidirectionally, in a single round trip

#### Scenario: An instance polls

- GIVEN an instance with a minted token
- WHEN it polls `POST /api/gateway/poll` every `POLL_INTERVAL_SEC`
- THEN the request SHALL carry its name, a per-process `runId`, `startedAt`, the digest it has
  **activated**, its process stats, its total request count, its telemetry report and any quota
  deltas
- AND the response SHALL carry either `unchanged: true` or a configuration document, plus the
  telemetry windows the control plane accepted and the fleet's quota aggregates

#### Scenario: A process restarts

- GIVEN an instance that restarts
- WHEN it polls again
- THEN it SHALL present a fresh `runId`, so the restart writes new rows instead of replacing the
  previous run's

#### Scenario: Telemetry windows are acknowledged

- GIVEN a poll that reported closed telemetry windows
- WHEN the response names `acceptedWindows`
- THEN the instance SHALL clear exactly those windows and no others

### Requirement: Fail static on a control-plane outage

Control-plane downtime SHALL never be a traffic outage.

#### Scenario: The control plane is unreachable

- GIVEN an instance with an activated configuration
- WHEN the poll fails, for any duration
- THEN the instance SHALL keep serving the configuration it last activated
- AND the last good configuration SHALL be persisted to `GATEWAY_CONFIG_CACHE` and reloaded across
  restarts

#### Scenario: A time-bounded permission would outlive the outage

- GIVEN an active TLS exception or trust anchor carrying `expiresAt` / `notAfter`
- WHEN that time passes while the control plane is unreachable
- THEN the instance SHALL stop honouring it on **its own clock**
- AND the reason SHALL be that fail-static configuration must not hold an exception open, or keep a
  dead CA alive, through a control-plane outage

### Requirement: Fail closed on revocation

#### Scenario: This instance's token is revoked

- GIVEN a poll that answers `401` or `403`
- WHEN the instance receives it
- THEN it SHALL stop serving
- AND this SHALL be distinguished from a revoked **subscription**, which simply leaves the
  configuration document

### Requirement: Gate activation on availability

A configuration SHALL NOT be activated unless everything it needs is already held.

#### Scenario: A referenced artifact is missing

- GIVEN a configuration whose routes reference compiled validators this instance does not hold
- WHEN it is received
- THEN the instance SHALL fetch them from `GET /api/gateway/artifacts/:digest`
- AND until they are all present the configuration SHALL NOT be activated, and
  `activationBlocked` SHALL be reported on the next poll
- AND the reason SHALL be that activating it would mean either serving unvalidated traffic or
  failing every route that needs one

#### Scenario: A referenced client certificate is missing

- GIVEN a route whose backend names a `clientCertRef`
- WHEN the certificate material is not held
- THEN it SHALL be fetched from `GET /api/gateway/certificates/:id`, keyed `<id>-<thumbprint>`
- AND a new thumbprint under the same id SHALL be the designed rotation path, fetched as a new key

#### Scenario: A client-certificate policy has no trust boundary

- GIVEN a configuration containing a policy that reads a client identity out of a header
- WHEN `TRUSTED_PROXY_CIDRS` names no network
- THEN the configuration SHALL be refused rather than activated
- AND the reason SHALL be that reading an identity from a header with no trust boundary in front is
  an authorization bypass

#### Scenario: The wire version is not understood

- GIVEN a configuration whose `configVersion` this instance does not speak
- WHEN it is received
- THEN the instance SHALL refuse it, keep serving what it has, and report the refusal as
  `activationBlocked`
- AND a mixed-version fleet SHALL keep serving and say so

### Requirement: Serve exactly two paths of its own

#### Scenario: Liveness and readiness are probed

- GIVEN `GET /healthz`
- WHEN it is called
- THEN it SHALL always answer `200` with the health body
- AND `GET /readyz` SHALL answer `200` only when a configuration has been activated, and `503`
  otherwise
- AND neither SHALL be counted as traffic, so a monitoring probe never appears in telemetry

#### Scenario: A published route would shadow a reserved path

- GIVEN a base path of `/healthz` or `/readyz`
- WHEN it is written on the control plane
- THEN it SHALL be rejected at route-write time

### Requirement: Apply the pipeline in a fixed order

The order SHALL be part of the contract, because several orderings are constraints rather than
conveniences.

#### Scenario: A request is served

- GIVEN an inbound request
- WHEN it is processed
- THEN the stages SHALL run in this order:
  1. route match · 2. trusted-proxy context · 3. always-on limits · 4. `ipAllow` ·
  5. CORS preflight · 6. authenticate · 7. authorize · 8. rate limit · 9. quota ·
  10. preconditions · 11. operation resolution · 12. request validation · 13. `rewrite` ·
  14. request headers · 15. request transform · 16. cache lookup · 17. backend select ·
  18. backend auth · 19. proxy (timeout, retries, breaker) · 20. response validation, then
  response transform · 21. response headers + CORS · 22. backend-auth invalidation ·
  23. cache store · 24. telemetry and access log

#### Scenario: An orderings constraint is questioned

- GIVEN the pipeline order
- WHEN it is changed
- THEN these four SHALL be preserved:
  - validation and preconditions SHALL sit **after** authenticate and authorize, so unauthenticated
    traffic cannot consume validation CPU or trigger a precondition
  - operation resolution SHALL sit after authorization for the same reason: parsing a body is work,
    and work an unauthenticated caller can cause is a lever
  - credential stripping (request headers) SHALL precede backend auth, so a route cannot forward the
    inbound credential alongside the outbound one
  - response validation SHALL precede the response transform, because the declared schema describes
    what the backend sends, not what is handed on

### Requirement: Match routes by host and base path at a segment boundary

#### Scenario: A path is matched

- GIVEN a base path `/petstore`
- WHEN `/petstoreXYZ` arrives
- THEN it SHALL NOT match
- AND `/petstore` and `/petstore/pet/1` SHALL match
- AND the root base path `/` SHALL match everything

#### Scenario: A host is compared

- GIVEN a route host
- WHEN a request's `Host` header is compared
- THEN the comparison SHALL be case-insensitive with any port stripped, and `*` SHALL match any
  host
- AND paths SHALL be compared case-sensitively, because HTTP paths are

#### Scenario: Nothing matches

- GIVEN a request that matches no route
- WHEN it is answered
- THEN it SHALL be a `404` in RFC-7807 shape

### Requirement: Forward to the backend by concatenation

#### Scenario: A backend carries a path segment

- GIVEN a backend URL `https://petstore.example/v2` and an inbound path `/pet/1`
- WHEN the target is composed
- THEN it SHALL be `https://petstore.example/v2/pet/1`
- AND URL resolution SHALL NOT be used, which would discard the backend's own path segment

### Requirement: Rate limit per instance, and say so

#### Scenario: A limit is enforced

- GIVEN a `rateLimit` unit of `calls` per `periodSec`
- WHEN requests arrive
- THEN windows SHALL be **fixed**, aligned to `periodSec` from the UTC epoch, so "when does my
  limit reset" is answerable without explaining a sliding window
- AND the `calls + 1`-th request in a window SHALL be rejected with the limit, the remaining count,
  the reset time and a `Retry-After` of at least one second
- AND the counter SHALL be per instance, uncoordinated, unpersisted and unreported, so an instance
  enforces correctly on its first request after boot
- AND the fleet ceiling SHALL therefore be `calls × instances`, which the portal states rather than
  hides

#### Scenario: Windows accumulate

- GIVEN windows keyed per `(subscription, route)`
- WHEN they age past an hour
- THEN they SHALL be swept, so the map is bounded

### Requirement: Meter quota across the fleet, drifting permissive

#### Scenario: Quota is enforced

- GIVEN a `quota` unit
- WHEN a request arrives
- THEN enforcement SHALL be `aggregate_at_last_poll + own_delta_since >= calls`
- AND the worst-case overshoot before convergence SHALL be the fleet's traffic in one poll interval

#### Scenario: Counts are lost

- GIVEN an instance that restarts, or a poll whose quota report is lost
- WHEN counts are reconciled
- THEN the unreported delta SHALL be dropped and never retried
- AND the reason SHALL be that losing a restart's worth of counts beats double-counting a consumer
  into a `403`

#### Scenario: The control plane is unreachable

- GIVEN a quota unit and a failing poll
- WHEN requests continue
- THEN enforcement SHALL continue against the frozen aggregate and SHALL drift permissive

#### Scenario: More live windows exist than the bound

- GIVEN more than `MAX_QUOTA_ENTRIES` live counters
- WHEN a new one is needed
- THEN the oldest SHALL be evicted rather than the map grown

### Requirement: Cache responses under the active configuration digest

#### Scenario: A configuration is activated

- GIVEN a populated response cache
- WHEN a new configuration is activated
- THEN the cache SHALL be empty by construction, because entries are keyed under the digest
- AND there SHALL be no invalidation logic

#### Scenario: A cache unit does not vary by subscription

- GIVEN a `cache` unit with `varyBySubscription` off
- WHEN the configuration is validated
- THEN it SHALL be linted loudly, because caching without it serves one consumer's response to
  another
- AND it SHALL still be permitted, because it is right for public reference data and the control
  plane cannot make that judgement

#### Scenario: A cache key is built

- GIVEN a cacheable request
- WHEN the key is composed
- THEN it SHALL contain the configuration digest, the route id, the method and the inbound path and
  query **before** any rewrite
- AND the subscription SHALL be included only when `varyBySubscription` is on, plus each declared
  `vary` header

#### Scenario: The cache exceeds its bounds

- GIVEN `RESPONSE_CACHE_MAX_ENTRIES` or `RESPONSE_CACHE_MAX_BYTES`
- WHEN either is reached
- THEN entries SHALL be evicted rather than the bound exceeded
- AND caching SHALL be **off** by default

### Requirement: Verify backend TLS by default

#### Scenario: No exception exists

- GIVEN a route with no TLS exception
- WHEN it connects to its backend
- THEN the certificate chain SHALL be verified, and the hostname checked

#### Scenario: An exception relaxes verification

- GIVEN a `pin`, `skip-hostname` or `insecure` mode carried in the document
- WHEN it is applied
- THEN it SHALL have come from an administrator-created, dated `tls_exception` and SHALL carry
  `expiresAt`
- AND the environment's trust anchors SHALL apply to `verify`, `pin` and `skip-hostname` — the chain
  is still checked before the pin is compared or the name check relaxed
- AND they SHALL NOT apply to `insecure`, where nothing is verified and adding a CA would be theatre

#### Scenario: System roots are excluded

- GIVEN `TRUST_SYSTEM_ROOTS=0`
- WHEN the trust set is composed at activation
- THEN only the environment's registered anchors SHALL be trusted

### Requirement: Announce deprecation and CORS on every response, including refusals

#### Scenario: A deprecated route refuses a request

- GIVEN a route whose lifecycle is `deprecated`
- WHEN any response is written, including a rate-limit rejection
- THEN the deprecation headers SHALL be present
- AND the reason SHALL be that a consumer being rate limited still needs to know the version is
  going away

#### Scenario: A CORS-enabled route refuses a request

- GIVEN a `cors` unit and a `401`
- WHEN the response is written
- THEN the CORS headers SHALL be present
- AND the reason SHALL be that a `401` without them reaches a browser as an opaque CORS failure, so
  the consumer sees "CORS error" instead of "your key is wrong"

### Requirement: Bound every allocation

#### Scenario: A request body exceeds the cap

- GIVEN a body larger than `MAX_BODY_BYTES` or the route's `always` limit
- WHEN it is read
- THEN the request SHALL be refused with `413`, and the body SHALL be cancelled rather than buffered
- AND on the **response** side an over-cap body SHALL still be delivered by replaying the prefix
  followed by the remainder, because the client has already been promised a body

#### Scenario: Concurrency ceilings are reached

- GIVEN `MAX_CONCURRENT_REQUESTS`, `MAX_CONCURRENT_UPGRADES`, `VALIDATE_POOL_SIZE`,
  `VALIDATE_QUEUE_DEPTH` or `BLOCKING_BUFFER_BUDGET_BYTES`
- WHEN one is reached
- THEN the excess SHALL be refused or shed with a stated status, and counted
- AND a validation sample that does not fit SHALL be counted rather than allowed to hold memory

#### Scenario: A compressed response is measured

- GIVEN a gzipped backend response
- WHEN its size is recorded
- THEN a `Content-Length` that describes the compressed bytes while the body has been transparently
  expanded SHALL NOT be trusted
- AND the presence of `Content-Encoding` SHALL be what makes the case detectable

### Requirement: Validate against compiled artifacts, in the declared mode

#### Scenario: A route validates in enforcing mode

- GIVEN a `validate` unit in enforcing mode and a body that does not match the schema
- WHEN the request arrives
- THEN it SHALL be refused, with the failure described in the problem document
- AND the excerpt included SHALL be bounded by `maxIncludeBodyExcerptBytes`

#### Scenario: A route validates in warning mode

- GIVEN a `validate` unit in warning mode
- WHEN the request arrives
- THEN the request SHALL proceed immediately with one copy of the body while another goes to the
  validation pool
- AND the sample SHALL be bounded by the same cap as everything else

#### Scenario: An operation has no schema

- GIVEN an operation whose `schemaState` is `no-schema` or `unsupported-schema`
- WHEN validation would run
- THEN it SHALL be skipped and counted as such, so "not validated" is visible rather than assumed

### Requirement: Count what happened, in bounded series

#### Scenario: Telemetry is reported

- GIVEN traffic
- WHEN a window closes
- THEN counters SHALL be reported per series, bounded by `TELEMETRY_MAX_SERIES` and
  `TELEMETRY_MAX_WINDOWS_PER_REPORT`, and the whole report by `MAX_REPORT_BYTES`
- AND an outcome SHALL distinguish served, refused by the gateway, and failed upstream

#### Scenario: A JSON-RPC response carries an error

- GIVEN an MCP or A2A response
- WHEN the outcome is counted
- THEN a body that does not parse SHALL simply not be an RPC error
- AND the response SHALL be passed through either way, and whether it matches the contract SHALL be
  a separate check with its own state and counters
