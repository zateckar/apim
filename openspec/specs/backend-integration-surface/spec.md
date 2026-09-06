# backend-integration-surface Specification

## Purpose

Define everything between a route and the system behind it: the backend pool and its selection
rule, the circuit breaker, the named backend-auth schemes, and the client identity the gateway
presents. Backends live in `binding`, per environment, **never in policy**.

## Requirements

### Requirement: Backends live in the binding, not in policy

#### Scenario: A backend is configured

- GIVEN an API in an environment
- WHEN its backend is set
- THEN it SHALL be stored on the environment's `binding` row as a pool with a rule
- AND no policy unit SHALL name a URL the gateway will call
- AND the reason SHALL be that a URL an owner can write into policy is a URL the gateway can be
  made to fetch

#### Scenario: A backend URL is written

- GIVEN any pool member
- WHEN it is saved
- THEN it SHALL pass the egress allowlist at **write** time, and the refusal SHALL name the rule

#### Scenario: A pool exceeds its bounds

- GIVEN more than `MAX_POOL_SIZE` (8) members, or a weight outside 1–`MAX_WEIGHT` (10)
- WHEN it is saved
- THEN it SHALL be refused, naming the bound

### Requirement: One reader for both shapes a binding may have

#### Scenario: An older binding is read

- GIVEN a binding stored as a plain list of URLs
- WHEN it is read
- THEN it SHALL be read as an ordered **failover** pool, which changes no behaviour for the first
  entry
- AND the migration SHALL happen at read time rather than in SQL, so an unreleased environment does
  not need a data migration to keep serving
- AND the next write SHALL store the current shape

### Requirement: Select a backend by a stated rule

#### Scenario: The rule is `failover`

- GIVEN a pool and the `failover` rule
- WHEN a request selects a backend
- THEN the pool SHALL be tried in the order written, first healthy first
- AND "primary first" SHALL be this rule with the primary first in the list

#### Scenario: The rule is `round-robin`

- GIVEN a pool and the `round-robin` rule
- WHEN requests select backends
- THEN a per-instance cursor SHALL rotate through the pool
- AND a weight SHALL be applied by expanding an entry into the rotation that many times

#### Scenario: Every backend is unhealthy

- GIVEN a pool whose members are all open at the breaker
- WHEN selection runs
- THEN unhealthy backends SHALL be moved to the **back** rather than removed
- AND the reason SHALL be that a pool whose every member is open still needs an order to report and
  one to probe with

### Requirement: Break a failing backend per instance, and report it

#### Scenario: A backend keeps failing

- GIVEN a `circuitBreaker` unit and a backend that exceeds its failure threshold
- WHEN the breaker opens
- THEN that backend SHALL stop being selected until the breaker's probe interval elapses
- AND the breaker SHALL be per instance per backend, with no coordination between instances

#### Scenario: The breaker's state is read

- GIVEN an open breaker
- WHEN the estate's screens render
- THEN the open backend SHALL be visible with the reason and when it will next be probed

### Requirement: Retry and time out on stated terms

#### Scenario: A request is retried

- GIVEN a `retries` unit
- WHEN a backend attempt fails
- THEN the retry SHALL be bounded by the unit's count, and SHALL move on to the next backend in the
  selection order rather than hammering the same one
- AND a request whose method is not safe to repeat SHALL not be retried after the backend has
  received it

#### Scenario: A request times out

- GIVEN a `timeoutMs` unit, defaulting to `DEFAULT_TIMEOUT_MS` and capped at `MAX_TIMEOUT_MS`
- WHEN the backend does not answer in time
- THEN the request SHALL be failed with the timeout reported as such, distinguishable from an error
  the backend returned

### Requirement: Implement backend credentials as named schemes

Policy SHALL select a scheme by name; the gateway SHALL implement it; every reference SHALL resolve
through the administrator-registered integrations file.

#### Scenario: A backend needs a token

- GIVEN a `backendAuth` unit naming a `tokenProviderRef`
- WHEN a token is needed
- THEN the gateway SHALL fetch it from the registered token URL with the registered credential
- AND no owner SHALL write the URL the gateway calls or the secret it stores

#### Scenario: Many requests need a token at once

- GIVEN a cold or just-expired token cache
- WHEN concurrent requests arrive
- THEN they SHALL share **one** fetch
- AND the reason SHALL be that a per-request fetch bursts the identity provider on every expiry

#### Scenario: The token fetch fails

- GIVEN a failing token provider
- WHEN a request needs a token
- THEN the request SHALL be failed with `503`
- AND the gateway SHALL NOT forward with an empty credential, which turns an identity-provider blip
  into a backend `401` that looks like the consumer's fault

#### Scenario: A signature covers a timestamp

- GIVEN an HMAC scheme whose canonical string includes a second-resolution timestamp
- WHEN the signature is computed
- THEN it SHALL be computed per request and never cached

#### Scenario: A shared secret only has to be checked

- GIVEN a `credentialRef` the gateway compares rather than presents
- WHEN the configuration document is built
- THEN only the sha256 of the secret SHALL travel
- AND plaintext SHALL travel only for a secret the gateway must **present** to a backend

### Requirement: Strip the inbound credential before adding the outbound one

#### Scenario: A route has both an inbound auth unit and a backend-auth unit

- GIVEN a request carrying a subscription key or a bearer token
- WHEN the backend request is composed
- THEN the inbound credential SHALL have been stripped by the request-header stage, which runs
  before backend auth
- AND a route SHALL therefore be unable to forward the inbound credential alongside the outbound one

### Requirement: Present a client certificate the owning application registered

#### Scenario: A binding names a client certificate

- GIVEN a `clientCertRef`
- WHEN it is validated on write
- THEN the certificate SHALL exist, belong to the same environment, be unexpired, belong to the
  API's own application, and be one the caller may use
- AND each failure SHALL be named

#### Scenario: The certificate is delivered to the gateway

- GIVEN a route whose backend names a client certificate
- WHEN the configuration document is built
- THEN the document SHALL carry the certificate's id, name, thumbprint and expiry
- AND the **material** SHALL be fetched separately over the instance channel, keyed
  `<id>-<thumbprint>`

### Requirement: Verify the backend's own certificate by default

#### Scenario: No exception exists

- GIVEN a backend over HTTPS
- WHEN the connection is made
- THEN the chain SHALL be verified against the environment's trust anchors, and — unless the system
  roots are excluded — the system roots, and the hostname SHALL be checked

#### Scenario: An exception is in force

- GIVEN a dated, administrator-created TLS exception
- WHEN the configuration document is built
- THEN the route's TLS mode SHALL carry the exception's id, reason and expiry
- AND the exception SHALL expire on the gateway's own clock

### Requirement: Show the backend surface where somebody edits it

#### Scenario: The workspace shows the backend

- GIVEN an API in an environment
- WHEN the properties panel renders
- THEN one backend SHALL read as a single field labelled with the environment, and a second member
  SHALL appear only when asked for
- AND the load-balancing rule, the client certificate and any TLS exception SHALL be shown beside
  the pool, with the exception's expiry stated
