# data-plane-gateway Specification

## Purpose

Define the gateway: a process that **decides nothing**. It polls the control plane, applies one
complete configuration document, serves traffic from it in a fixed pipeline order, and reports back
what it did. See *The Configuration Document*, *The Gateway Poll Contract* and *Base Path Matching*
in `openspec/project.md`.

## Requirements

### Requirement: Take every decision from one configuration document

The gateway SHALL hold no configuration of its own beyond how to reach the control plane and the
few facts that are about this container rather than about the fleet — see `gateway-settings` for
where that line is drawn and why. Its own bounds arrive in the document like everything else.

#### Scenario: A behaviour is needed that the document does not describe

- GIVEN any routing, policy, subscription, certificate or trust decision
- WHEN a request needs it
- THEN it SHALL come from the active configuration document
- AND the gateway SHALL NOT read it from its own environment, a local file, or a request header

#### Scenario: A bound is needed

- GIVEN any concurrency ceiling, body cap, cache size, telemetry bound, access-log switch or
  timing disclosure
- WHEN the gateway enforces it
- THEN the value SHALL be the document's `settings` block, resolved for this gateway by the control
  plane
- AND the gateway SHALL NOT read it from its own environment, which is a startup failure naming the
  variable — see `gateway-settings`
- AND the block SHALL be complete, so the gateway holds no default of its own to fall back to

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
- AND a cache file written before a setting existed SHALL have that setting filled from the build's
  default on reload, so an upgraded binary starting into an outage does not read a key that is not
  there and get `undefined` where the block is supposed to be complete

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

#### Scenario: The settings block cannot be honoured on this container

- GIVEN a document whose `settings` name a bound this container's runtime will not honour
- WHEN it is received
- THEN it SHALL be refused before any artifact is fetched, reported as `activationBlocked`, and
  whatever is already serving SHALL keep serving
- AND unlike a missing trust boundary this SHALL NOT be fatal without a configuration, because
  correcting the setting centrally makes the next poll succeed — see `gateway-settings`

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

### Requirement: Resolve the caller's address through the trusted-proxy boundary

Stage 2 SHALL decide one address, and `ipAllow`, `rateLimit` and `quota` keyed by IP, the access
log and telemetry SHALL all name that one. `X-Forwarded-For` SHALL be evidence only when the peer
that sent it is trusted.

#### Scenario: A request arrives from a trusted proxy

- GIVEN a peer inside `TRUSTED_PROXY_CIDRS` and an `X-Forwarded-For` header
- WHEN the caller's address is resolved
- THEN the chain SHALL be walked from the **right**, skipping entries that are themselves trusted
  proxies, and the first entry that is not SHALL be the caller
- AND the direction SHALL be right-to-left because a conforming proxy *appends* the address it
  received from, so the rightmost entry is the one our own proxy observed and the only one nobody
  downstream could have written
- AND when every hop is a trusted proxy, or the header is absent or unparseable, the peer SHALL be
  used, because it is all that is known

#### Scenario: A request arrives from an untrusted peer

- GIVEN a peer outside every `TRUSTED_PROXY_CIDRS` entry, or no entry configured at all
- WHEN `X-Forwarded-For` is present
- THEN it SHALL be treated as a claim rather than evidence, and the socket address SHALL be used
- AND the client-certificate headers SHALL NOT be read, for the same reason

#### Scenario: A dual-stack listener reports an IPv4 peer

- GIVEN a socket peer presented as an IPv4-mapped IPv6 address (`::ffff:a.b.c.d`)
- WHEN it is matched against `TRUSTED_PROXY_CIDRS`, `ipAllow`, or the control plane's egress deny
  list
- THEN it SHALL be treated as the IPv4 address it maps, because a dual-stack listener reports
  **every** IPv4 peer in that form and the alternative is a trust boundary that is configured,
  matches nothing, and says nothing
- AND the resolved address SHALL be recorded and keyed in its canonical IPv4 form, so one caller is
  never counted as two spellings of itself
- AND a real IPv6 literal SHALL still match no IPv4 rule

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

### Requirement: Serve only the operations the definition declares

A route publishes a contract, not a backend. Matching the base path decides *which* API a request is
for; it does not decide that the request is one the API offers. Forwarding an unmatched path would
make every published API a blanket proxy for its backend's whole surface, and would forward it
unvalidated as well, since validation has no schema without an operation.

#### Scenario: A path under the base path is not declared

- GIVEN a REST route whose definition declares `GET /pets/{petId}`
- WHEN `GET /pet/1` arrives under the same base path
- THEN it SHALL be refused with `404` in RFC-7807 shape, naming the method and the relative path
- AND the outcome SHALL be `no-operation`, distinct from `no-route`, which means no route matched
  the host and path at all
- AND no backend SHALL be called

#### Scenario: A declared path is called with a method it does not declare

- GIVEN the same route
- WHEN `DELETE /pets/1` arrives and only `GET` is declared for it
- THEN it SHALL be refused the same way, because an operation is a method and a path together

#### Scenario: The definition declares no operations at all

- GIVEN a route whose definition yields no operations
- WHEN any path under its base path arrives
- THEN it SHALL be forwarded, because there is no contract to enforce
- AND this SHALL be the only way to publish a pass-through route

#### Scenario: The variants agree

- GIVEN a SOAP route refusing an undeclared body element, and an MCP or A2A route refusing an
  undeclared method
- WHEN a REST route meets an undeclared path
- THEN it SHALL refuse too, so that "this API declares what it serves" holds for every variant
  rather than three of the four

### Requirement: Forward to the backend by concatenation

#### Scenario: A backend carries a path segment

- GIVEN a backend URL `https://petstore.example/v2` and an inbound path `/pet/1`
- WHEN the target is composed
- THEN it SHALL be `https://petstore.example/v2/pet/1`
- AND URL resolution SHALL NOT be used, which would discard the backend's own path segment

### Requirement: Forward the caller's headers, and override only the ones the gateway owns

A published API is a proxy for its backend, and a header the caller sent is part of the request the
backend is entitled to read: an `Accept-Language`, an `If-None-Match`, a `Prefer`, a correlation
header the consumer's own estate carries. The gateway SHALL therefore forward **every** inbound
header by default, and an API owner SHALL name the exceptions in `headers.request` rather than
naming the inclusions. An allowlist would make a published API silently lossy — a backend feature
would stop working for no reason the consumer can see, and every owner would have to rediscover by
experiment which of their own headers the gateway ate.

The exceptions are what belongs to the hop rather than to the caller, and each one is a header the
gateway itself decides: the hop-by-hop headers, which describe one connection and not the request;
`Host` and `Content-Length`, which describe the target and the body this gateway is about to send;
the credential this route authenticated with, stripped before backend auth runs; and the forwarding
and trace headers the gateway sets about the hop it is making. Those are **overridden**, not merged
— a caller that sends its own `X-Forwarded-For` or `traceparent` is making a claim, and the value
the backend reads is the gateway's.

#### Scenario: A caller sends a header no policy mentions

- GIVEN a route whose `headers.request` unit does not name `X-Tenant-Hint`
- WHEN a request arrives carrying `X-Tenant-Hint: nordics`
- THEN it SHALL reach the backend unchanged
- AND this SHALL hold whether or not the route carries a `headers.request` unit at all

#### Scenario: A caller sends a header the policy also sets

- GIVEN a `headers.request` unit with `set` naming `X-Tenant` and `skip` naming `X-Region`
- WHEN a request arrives carrying both
- THEN the backend SHALL read the policy's value for `X-Tenant`, because `set` is the gateway
  speaking and the caller may not forge it
- AND the backend SHALL read the **caller's** value for `X-Region`, because `skip` supplies a
  default and a default only applies where there is nothing to default

#### Scenario: A caller sends the forwarding and trace headers

- GIVEN an inbound request carrying `X-Forwarded-For`, `X-Forwarded-Proto`, `X-Forwarded-Host` and
  `traceparent` of its own
- WHEN it is forwarded
- THEN the backend SHALL read this gateway's values for all four
- AND `traceparent` SHALL name this hop as the backend's parent while continuing the caller's trace,
  so the caller's trace id survives and its span id does not
- AND `X-Request-Id` SHALL be the caller's when it sent one, because that is the identifier it will
  quote back, and a minted one otherwise

#### Scenario: A hop-by-hop header arrives

- GIVEN an inbound `Connection`, `Keep-Alive`, `TE`, `Trailer`, `Transfer-Encoding`, `Upgrade`,
  `Proxy-Authenticate` or `Proxy-Authorization`
- WHEN the request is forwarded
- THEN it SHALL NOT be forwarded, because it describes the caller's connection to this gateway and
  not the connection this gateway is opening
- AND `Host` and `Content-Length` SHALL be dropped for the same reason, the runtime setting both
  from the target and the body actually sent

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

- GIVEN the `responseCacheMaxEntries` or `responseCacheMaxBytes` setting
- WHEN either is reached
- THEN entries SHALL be evicted rather than the bound exceeded
- AND caching SHALL be **off** by default
- AND a bound lowered by a settings change SHALL evict down to it rather than be exceeded until the
  next restart

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

### Requirement: Carry a compressed response through untouched when nothing has to read it

The gateway SHALL decide this on the **request**, by whether it forwards the caller's
`Accept-Encoding`: a body the backend never compressed cannot be forwarded compressed, and a body
the gateway asked for compressed and then had to expand costs twice and buys nothing.

Whether anything has to read the body is known before the backend is called — response validation,
the response transform, the cache unit and the route's `kind` are all resolved by step 14. The one
input that is not is the response's status, so the test SHALL be whether this operation *could*
validate any response rather than whether it will validate this one.

#### Scenario: Nothing on the response side needs the body

- GIVEN a caller that sent an `Accept-Encoding`
- AND a route with response validation disabled, no response transform, no cache unit applying to
  this request, a `kind` that is neither `mcp` nor `a2a`, and no `passthrough.sse`
- WHEN the request is forwarded
- THEN the caller's `Accept-Encoding` SHALL be forwarded unchanged
- AND the response body SHALL NOT be decoded, so the bytes the backend produced are the bytes the
  caller receives
- AND `Content-Encoding` and `Content-Length` SHALL be forwarded as received, because they now
  describe the body actually being sent
- AND `Accept-Encoding` SHALL be added to `Vary` whenever an encoding was carried through, so no
  intermediary serves one caller's encoding to another

#### Scenario: The caller negotiated no encoding

- GIVEN a request with no `Accept-Encoding`
- WHEN it is forwarded
- THEN the response SHALL be delivered decoded, exactly as it was before this requirement existed
- AND the reason SHALL be that the runtime supplies an `Accept-Encoding` of its own when a request
  carries none, so a caller that asked for nothing could otherwise be handed an encoding it never
  agreed to — and by the time that is visible, the chance to decode it has gone

#### Scenario: Something on the response side needs the body

- GIVEN response validation that could apply, a response transform, a cache unit, an `mcp` or `a2a`
  route, or `passthrough.sse`
- WHEN the request is forwarded
- THEN its `Accept-Encoding` SHALL be set to `identity`, so the backend answers in bytes the gateway
  can read
- AND it SHALL be **set** rather than removed, because the runtime supplies an `Accept-Encoding` of
  its own when a request carries none — a removed header means the backend compresses and the
  gateway expands it again, which is both machines paying for an encoding nobody asked for
- AND for `passthrough.sse` the reason SHALL be that compressing an event stream makes the encoder
  buffer, which is the latency the stream exists to avoid

### Requirement: Answer an unexpected failure as the gateway, never as the runtime

The listener SHALL NOT run in the runtime's development mode. That mode answers an uncaught error
with the exception's message, its stack, the source around each frame and the file paths — to
whoever sent the request — and it is the default unless the process says otherwise.

#### Scenario: Something throws where nothing should

- GIVEN a failure the pipeline does not shape into a response of its own
- WHEN it reaches the listener
- THEN the caller SHALL receive `problem+json` with `500` and a generic detail, carrying a request
  id that also appears in the instance's log
- AND the exception's message, stack and source SHALL NOT appear in the response
- AND the failure SHALL NOT be counted as traffic, because it has no route and no subscription to
  attribute

### Requirement: Bound every allocation

#### Scenario: A request body exceeds the cap

- GIVEN a body larger than the `maxBodyBytes` setting or the route's `always` limit
- WHEN it is read
- THEN the request SHALL be refused with `413`, and the body SHALL be cancelled rather than buffered
- AND on the **response** side an over-cap body SHALL still be delivered by replaying the prefix
  followed by the remainder, because the client has already been promised a body

#### Scenario: Concurrency ceilings are reached

- GIVEN the `maxConcurrentRequests`, `maxConcurrentUpgrades`, `validatePoolSize`,
  `validateQueueDepth` or `blockingBufferBudgetBytes` setting
- WHEN one is reached
- THEN the excess SHALL be refused or shed with a stated status, and counted
- AND a validation sample that does not fit SHALL be counted rather than allowed to hold memory
- AND each of these SHALL be held as a number rather than as preallocated capacity, which is what
  makes a settings change a set of assignments instead of a restart

#### Scenario: A compressed response is measured

- GIVEN a gzipped backend response the gateway decoded in order to read it
- WHEN its size is recorded
- THEN a `Content-Length` that describes the compressed bytes while the body has been transparently
  expanded SHALL NOT be trusted
- AND the presence of `Content-Encoding` SHALL be what makes the case detectable

#### Scenario: A compressed response is passed through

- GIVEN a gzipped backend response the gateway did not decode
- WHEN its size is recorded
- THEN the declared `Content-Length` SHALL be trusted, because it describes exactly the bytes being
  forwarded
- AND what is counted SHALL be the bytes on the wire, not what they expand to

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
- THEN counters SHALL be reported per series, bounded by the `telemetryMaxSeries` and
  `telemetryMaxWindowsPerReport` settings, and the whole report by `MAX_REPORT_BYTES`
- AND an outcome SHALL distinguish served, refused by the gateway, and failed upstream
- AND the `telemetry` setting SHALL be able to switch counting off for a gateway, which blanks the
  Telemetry view for it and hands the response body through rather than pulling it through a
  counter

#### Scenario: The gateway's own share is counted separately from the backend's

- GIVEN a finished request with a total duration and, where there was one, a backend duration
- WHEN it is counted
- THEN it SHALL fall into a bucket of the total-latency histogram **and** into a bucket of a second
  histogram over `total − backend`, subtracted per request before bucketing
- AND the reason SHALL be that the p95 of a difference is not the difference of two percentiles, so
  a screen that subtracted an aggregate backend figure from an aggregate total would report a
  number no request experienced
- AND a request with no backend leg — no route matched, the key was refused, the cache answered —
  SHALL attribute its whole duration to the gateway, because that is where the whole duration went
- AND the sum and count of backend durations SHALL be carried beside them, the count being the
  requests that had a backend leg rather than the series total, so an average is not diluted by
  rejections

#### Scenario: A duration is recorded

- GIVEN any measured duration on this path
- WHEN it is written to a counter, a log line or a header
- THEN it SHALL keep three decimal places rather than be rounded to a whole millisecond
- AND the reason SHALL be that the figure the estate is trying to hold below one millisecond cannot
  be reported by a function whose smallest non-zero output is one millisecond

#### Scenario: A report arrives from a gateway built against a shorter histogram

- GIVEN counters from a build whose bucket array was shorter
- WHEN they are folded into a rollup
- THEN the shorter array SHALL be widened at the **low** end with zeroes and folded
- AND nothing SHALL be redistributed into the new buckets, because a request counted under a
  one-millisecond ceiling cannot be known to have been under half of one, and inventing that
  precision would make a fleet mid-upgrade look faster than it is

### Requirement: Tell a caller what this gateway cost it, only when the estate asks

A caller measuring a gateway over a real network cannot separate the pipeline from the wire: time
to first byte contains DNS, TCP, TLS, both crossings and the backend, and on a real deployment the
pipeline is a fraction of a percent of it. The gateway already computes both halves for its own
telemetry, so it SHALL be able to state them in the response — behind a setting, because the
backend's timing is not the caller's business by default.

#### Scenario: The setting is off

- GIVEN the `serverTiming` setting off, which is its default
- WHEN any request is answered — served, refused by the gateway, or failed upstream
- THEN no `Server-Timing` header SHALL be present

#### Scenario: A proxied request is answered

- GIVEN the setting on
- WHEN a request that reached a backend is answered
- THEN the response SHALL carry `Server-Timing: gw;dur=<total − backend>, backend;dur=<backend>`
- AND both figures SHALL be the same measurements the access log and telemetry record for that
  request, so a caller's subtraction and the estate's dashboard cannot disagree

#### Scenario: The gateway wrote the answer itself

- GIVEN the setting on
- WHEN an answer the gateway produced without a backend is returned
- THEN the header SHALL carry `gw` alone
- AND it SHALL NOT carry `backend;dur=0`, because a zero reads as "the backend answered instantly"
  and the honest statement is that no backend was involved

#### Scenario: A response is streamed

- GIVEN the setting on and a response the gateway does not buffer — an event stream, or a body
  handed straight through
- WHEN the headers are sent
- THEN the header SHALL carry the time to the **first byte**, because a trailer arriving after the
  body is not something every caller can read
- AND that SHALL be the right figure rather than an approximation of one, because everything after
  the first byte is the backend's pace rather than this gateway's
- AND the gateway SHALL NOT delay the first byte in order to report a better number

#### Scenario: A connection is upgraded

- GIVEN the setting on and a WebSocket upgrade
- WHEN the `101` is sent
- THEN it SHALL carry no `Server-Timing`
- AND the reason SHALL be the same one that keeps a stream's duration out of both latency
  attributions: how long the client stayed is neither this gateway's cost nor the backend's, and a
  duration stamped at the `101` would describe a session that has not happened yet

#### Scenario: A JSON-RPC response carries an error

- GIVEN an MCP or A2A response
- WHEN the outcome is counted
- THEN a body that does not parse SHALL simply not be an RPC error
- AND the response SHALL be passed through either way, and whether it matches the contract SHALL be
  a separate check with its own state and counters

### Requirement: Write one access-log line for every request, and never sample

The estate keeps these lines to answer "who called what, when" for compliance. Sampling is
therefore not available at any rate, under any load, and there SHALL be no setting that reduces
the lines below one per request. The `accessLog` setting switches the log off entirely rather than
thinning it, so "we have all of them" and "we have none" are the only two states the estate can be
in — and because the lines are a promise to somebody outside engineering, it is the one setting
whose change is a typed confirmation and a named audit entry (see `gateway-settings`).

#### Scenario: A request is answered, however it was answered

- GIVEN any request the listener accepted — served, refused by the gateway, or failed upstream
- WHEN it finishes
- THEN exactly one line SHALL be written
- AND a request refused before a route matched SHALL be logged with the route fields absent rather
  than not logged, because "a call arrived and was rejected" is the compliance question more often
  than "a call succeeded"

#### Scenario: The line is built

- GIVEN a finished request
- WHEN its line is built
- THEN it SHALL be one JSON object on one line, carrying the timestamp, the request id, the trace
  and span ids, the environment, gateway and instance, the method, path, redacted query and host,
  the status, the backend's status, the outcome and any error, the resource, version, revision,
  operation, subscription and consumer application, the client address, the total duration and the
  backend duration
- AND `outcome` SHALL be the same `Outcome` vocabulary telemetry counts in, so a line and a
  dashboard cell cannot disagree about what happened
- AND every line SHALL be built in **one** place, so a field cannot be present on the served path
  and missing on the refused one

### Requirement: Never write a credential into a line

#### Scenario: Headers are considered

- GIVEN any request
- WHEN its line is built
- THEN **no request or response header SHALL appear in it**, at any time, under any setting
- AND the reason SHALL be that `Authorization` and the subscription-key header are headers: a rule
  that named them would be a rule with a list to keep current, and the list would be wrong the
  first time a scheme was added

#### Scenario: The query string is written down

- GIVEN a request whose query carries a credential-shaped parameter — the route's own key
  parameter, or one of the names a caller put a token in because it was easier
- WHEN the line is built
- THEN the value SHALL be replaced by a marker and the parameter name SHALL remain
- AND the parameter name SHALL be matched whole and case-insensitively, so `sort_key` is not a key

#### Scenario: A captured body contains a credential

- GIVEN a body being captured under an open window
- WHEN it is written down
- THEN the values of credential-shaped JSON members SHALL be replaced by a marker
- AND the scan SHALL work on a fragment, because the body is already truncated and a parser refuses
  a fragment
- AND it SHALL over-match rather than under-match, which is the correct direction for this

### Requirement: Capture bodies only inside an open window, and only the front of them

Bodies SHALL NOT appear in a line by default. A body is the one part of a call that contains
whatever the caller put in it, and the log index is read by more people than the API's backend is.

#### Scenario: No window is open

- GIVEN a route whose configuration carries no `logBodiesUntil`
- WHEN a request is logged
- THEN neither body SHALL appear in the line
- AND no body SHALL be buffered for logging, so the default costs nothing

#### Scenario: A window is open

- GIVEN a route whose `logBodiesUntil` is in the future by the instance's own clock
- WHEN a request is logged
- THEN the request and response bodies SHALL appear, each truncated to `MAX_LOGGED_BODY_BYTES`
  (8 KiB) and each marked when there was more of it
- AND the prefix SHALL be taken without preventing the body from being forwarded in full

#### Scenario: The window's instant passes

- GIVEN an open window whose instant has been reached
- WHEN the next request arrives
- THEN capture SHALL stop, on the instance's own clock
- AND it SHALL stop even if the control plane has been unreachable since the window was opened,
  which is what makes a temporary window actually temporary

#### Scenario: A response could be passed through compressed

- GIVEN an open capture window on a route that would otherwise qualify for compressed pass-through
- WHEN the request is forwarded
- THEN pass-through SHALL be suppressed, because a captured body has to be readable
- AND the window closing SHALL restore it without any other change

### Requirement: Always record the reason a request failed below HTTP

#### Scenario: The backend connection or handshake fails

- GIVEN a TCP failure, a TLS failure, a timeout or any other transport error reaching the backend
- WHEN the gateway answers `502`, `504` or any other `5xx` of its own
- THEN the line SHALL carry the reason — the error's name, its message, its cause and the backend
  origin — in the response-body field
- AND this SHALL happen **regardless of whether a capture window is open**, because a reason the
  gateway generated is not the caller's data and is the only record of what went wrong
- AND the same SHALL apply to every `5xx` the gateway itself produces

### Requirement: Correlate with W3C Trace Context

#### Scenario: The caller sends a `traceparent`

- GIVEN a request carrying a well-formed `traceparent` — version `00`, a non-zero trace id and a
  non-zero parent span id
- WHEN it is handled
- THEN the trace id SHALL be continued, a fresh span id SHALL be minted for this hop, and the
  caller's span id SHALL be recorded as the parent
- AND a `tracestate` SHALL be carried onward only on a continued trace, bounded to 512 bytes
- AND the header sent to the backend SHALL name this gateway's span, not the caller's

#### Scenario: The caller sends nothing, or something malformed

- GIVEN no `traceparent`, or one this gateway cannot parse
- WHEN it is handled
- THEN a new trace SHALL be started with a fresh trace id and span id and no parent
- AND a malformed header SHALL be replaced rather than propagated, so a bad hop cannot poison the
  trace downstream

### Requirement: Write the log where a shipper can read it, and rotate it

#### Scenario: `DP_ACCESS_LOG_PATH` is unset

- GIVEN the default
- WHEN lines are written
- THEN they SHALL go to standard output, which is what the container's own log driver collects

#### Scenario: `DP_ACCESS_LOG_PATH` names a file

- GIVEN a path
- WHEN lines are written
- THEN they SHALL be appended to that file, buffered and flushed by size and by an interval, so a
  gateway at rate does not make one syscall per request
- AND the buffer SHALL be flushed on an orderly shutdown
- AND the trade SHALL be stated: a process killed with `SIGKILL` loses what has not been flushed

#### Scenario: The gateway is asked to stop

- GIVEN buffered lines that no flush interval has reached yet
- WHEN the gateway receives `SIGTERM`
- THEN they SHALL reach the file before the process exits — a stop signal is an orderly shutdown,
  not the `SIGKILL` case above
- AND the gateway SHALL therefore handle the signal itself rather than leaving it to the default
  disposition, which PID 1 does not have; see `runtime-configuration`
- AND the reason SHALL be that a container restart is the most common way this process ever ends,
  so the unflushed tail of a compliance log would otherwise be lost on every deploy

#### Scenario: The file reaches its rotation size

- GIVEN a live log file at the `accessLogMaxBytes` setting
- WHEN it is rotated
- THEN the file SHALL be **renamed** and a new one opened, keeping `accessLogKeep` generations
- AND it SHALL NOT be truncated in place, because a tailing shipper loses whatever it had not read
- AND a failed rotation SHALL reopen the file anyway, so a rotation problem never becomes a logging
  outage
- AND one path SHALL serve one instance: two gateways sharing a path would interleave their buffers
  and race each other's rotation
