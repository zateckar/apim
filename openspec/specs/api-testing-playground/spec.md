# api-testing-playground Specification

## Purpose

Define the playground: a way to call a published API from the portal that cannot be turned into a
request forger, never puts a key in a browser, and is an ordinary gateway call in every other
respect.

## Requirements

### Requirement: The caller names no host

There SHALL be no target URL field.

#### Scenario: A call is composed

- GIVEN a resource, an environment, a gateway label and an operation
- WHEN the target is composed
- THEN it SHALL be built from the environment's configured gateway URLs and the **published route**,
  and from nothing a caller wrote
- AND the composed URL SHALL be egress-checked anyway
- AND there SHALL therefore be no field in which a caller can write a host

#### Scenario: The environment has no configured gateway URL

- GIVEN an environment whose targets declare no `config.gatewayUrls`
- WHEN the playground is opened there
- THEN it SHALL say the playground is not configured for that environment and name `TARGETS_FILE`
- AND it SHALL NOT fall back to any other address

### Requirement: The key never reaches the browser

#### Scenario: A subscription is used

- GIVEN a `subscriptionId` and a key kind
- WHEN the call is made
- THEN the key SHALL be decrypted on the control plane, injected into the header or query parameter
  the **effective policy** names, and never returned, logged or stored
- AND the response and the history row SHALL carry the headers **except** the key header

#### Scenario: The caller supplies headers

- GIVEN caller-supplied headers
- WHEN they are applied
- THEN hop-by-hop headers, and any header a caller must not forge, SHALL be dropped
- AND every dropped header SHALL be **named** in the response rather than silently removed
- AND `Host` SHALL be set from the route rather than from the request, because the route's host is
  what selects the route on the gateway

### Requirement: The call is an ordinary gateway request

#### Scenario: A playground call is made

- GIVEN a composed call
- WHEN it is sent
- THEN it SHALL go to the environment's **gateway**, not to the backend
- AND it SHALL therefore pass through every policy on the route, spend the subscription's rate
  limit and quota, and appear in telemetry attributed to that subscription
- AND the screen SHALL say so, so a consumer is not surprised by their own quota

#### Scenario: Resolution and the gateway could disagree

- GIVEN the route, the key header, the base path and the operation list
- WHEN the playground resolves them
- THEN it SHALL read them from the same function that renders the configuration document
- AND the playground SHALL therefore never disagree with the gateway about any of them

### Requirement: Only operations the definition declares are callable

#### Scenario: The operation list renders

- GIVEN a resource with an operation index
- WHEN the playground renders
- THEN it SHALL offer exactly those operations, with their method, path template and parameters
- AND for an A2A agent it SHALL additionally offer fetching the agent card the **gateway** serves
- AND an arbitrary path SHALL NOT be callable

#### Scenario: A form is built for an operation

- GIVEN an operation with path, query, header and body parameters
- WHEN the form renders
- THEN each declared parameter SHALL get a field, required ones marked, with the declared schema
  driving the control
- AND a request body SHALL be pre-filled from the schema where one exists

### Requirement: Bound what may be sent, read and stored

#### Scenario: The request is too large

- GIVEN a body over `PLAYGROUND_MAX_BODY_BYTES`
- WHEN it is submitted
- THEN it SHALL be refused, and the editor SHALL say so **before** sending

#### Scenario: The response is too large

- GIVEN a response over `PLAYGROUND_MAX_RESPONSE_BYTES`
- WHEN it is read
- THEN the body SHALL be truncated and the response SHALL state that it was

#### Scenario: The call takes too long

- GIVEN a call that exceeds `PLAYGROUND_TIMEOUT_MS`
- WHEN it times out
- THEN the timeout SHALL be reported as such, distinguishable from an error the API returned

#### Scenario: A user calls repeatedly

- GIVEN more than `PLAYGROUND_RATE_PER_MIN` calls from one user in a minute
- WHEN the next is attempted
- THEN it SHALL be refused
- AND the limit SHALL be understood as protecting the control plane, not the consumer's quota

### Requirement: Keep a per-resource history the caller can clear

#### Scenario: A call is recorded

- GIVEN a completed call
- WHEN it is recorded
- THEN the history row SHALL carry the method, the path as sent, the safe headers, the status, the
  duration and a bounded preview of the request body and the response
- AND the stored copy SHALL be bounded by `PLAYGROUND_HISTORY_BODY_BYTES`, which bounds what is
  **stored** and not what was sent

#### Scenario: History is pruned

- GIVEN more than `PLAYGROUND_HISTORY_PER_RESOURCE` entries for a resource, or entries older than
  `PLAYGROUND_HISTORY_RETENTION_DAYS`
- WHEN retention runs
- THEN the excess SHALL be removed

#### Scenario: History is cleared

- GIVEN the caller's own history
- WHEN they clear one entry or all of them
- THEN it SHALL be permitted without a typed confirmation
- AND the reason SHALL be that it removes a record of the caller's own console, not a thing anybody
  depends on

### Requirement: Explain a failure before it looks like the API's fault

#### Scenario: Something about the call is worth knowing

- GIVEN a call with no subscription on a route that requires a key, a deprecated route, a validation
  mode that will reject, or a dropped header
- WHEN the call is composed
- THEN a warning SHALL be returned naming it
- AND the reason SHALL be that these are things the caller should know before reading the response
  as the API's fault
