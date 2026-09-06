# integrations-and-mocks Specification

## Purpose

Define the surrounding systems this portal talks to — Kafka, SkoNET, email, LdapWS, FixMe and
LeanIX — as **native interfaces with mock implementations behind them**, delivered through one
durable outbox. Plus the rule that a simulated result is always labelled as one.

## Requirements

### Requirement: There are exactly six outbound systems, plus log search

#### Scenario: The External systems screen is opened

- GIVEN any signed-in user
- WHEN the screen renders
- THEN it SHALL list `kafka`, `skonet`, `email`, `ldapws`, `fixme` and `leanix` as outbound
  integrations, and log search as a **read** integration
- AND each SHALL carry its own mode and whether it is simulated

#### Scenario: Log search is real while the six are not

- GIVEN `LOGS_PROVIDER=elk`
- WHEN the list is served
- THEN log search SHALL report the `elk` mode and the index it reads, while the six report `mock`
- AND the screen SHALL be able to say so rather than labelling everything with one word
- AND the reason SHALL be that an estate can point at a real cluster while the business
  integrations are still simulated

### Requirement: Deliver through one durable outbox

#### Scenario: A business decision needs to reach another system

- GIVEN any decision that must be communicated
- WHEN it is made
- THEN one `integration_event` SHALL be written inside the same transaction as the decision
- AND the reason SHALL be that a transport failure must not be able to roll back a business
  decision

#### Scenario: The same event is emitted twice

- GIVEN an emit with the same integration, kind and subject as an existing event
- WHEN it is emitted
- THEN the existing event's id SHALL be returned and no second row created
- AND callers SHALL therefore be able to emit freely without tracking what they have already sent

#### Scenario: A delivery fails

- GIVEN an event whose transport fails
- WHEN the runner retries
- THEN it SHALL back off exponentially, capped at five minutes
- AND the event SHALL stay `retrying` with its attempt count visible
- AND state and results SHALL survive both a process restart and a browser restart

#### Scenario: The outbox is drained

- GIVEN queued and retrying events
- WHEN the runner sweeps
- THEN it SHALL take them oldest first, in bounded batches
- AND each SHALL be processed in its own transaction

### Requirement: Each system has a defined simulated behaviour

#### Scenario: An email is delivered

- GIVEN an `email` event
- WHEN it is processed
- THEN the recipients, the subject and the body SHALL be recorded on the result
- AND the outbox SHALL therefore be readable as the estate's mailbox

#### Scenario: An approval is requested

- GIVEN a `skonet` event
- WHEN it is processed
- THEN it SHALL settle in `awaiting-decision` with a tracking reference rather than `delivered`
- AND the reason SHALL be that an approval request is not finished when it is sent

#### Scenario: A directory lookup is made

- GIVEN an `ldapws` event
- WHEN it is processed
- THEN the contacts SHALL be resolved from the application's own memberships

#### Scenario: A self-heal run is made

- GIVEN a `fixme` event
- WHEN it is processed
- THEN it SHALL settle as `completed` with its steps and a summary
- AND the summary SHALL state plainly that no infrastructure was changed

#### Scenario: Kafka provisioning completes

- GIVEN a `kafka` event of kind `topic.create`, `access.grant` or `access.revoke`
- WHEN it is processed
- THEN the corresponding topic or access row SHALL move out of its transitional state
- AND the transition SHALL be guarded on the state it is moving **from**, so a repeated delivery
  changes nothing

### Requirement: Approval fans out to five events, once

#### Scenario: Access is requested from another application

- GIVEN a consumer application and a publisher application
- WHEN an approval is requested
- THEN five events SHALL be emitted: the approval request to SkoNET against the publisher, a
  "requested" email to the consumer, an "approval needed" email to the publisher, a contacts lookup
  for the consumer, and a metadata lookup for the publisher
- AND each SHALL be idempotent on its own subject, so the same request emitted twice produces
  nothing new

### Requirement: Read integration history scoped to what the caller may see

#### Scenario: The history is read

- GIVEN a signed-in user
- WHEN they read integration events
- THEN they SHALL see events for their own applications, or all of them if they are an administrator
- AND naming an application they may not read SHALL be refused
- AND the list SHALL be bounded, newest first

### Requirement: Mark every simulated result, everywhere

#### Scenario: A simulated result is produced

- GIVEN any mocked integration
- WHEN it produces a result
- THEN the result SHALL carry `simulated: true`
- AND every endpoint that returns it SHALL carry the same marker
- AND every screen that renders it SHALL say so, in words
- AND the topbar SHALL carry a standing chip while any surrounding system is simulated

#### Scenario: A simulated action is audited

- GIVEN an audited action carried out through a mocked system
- WHEN the audit row is written
- THEN its detail SHALL record that it was simulated
- AND the reason SHALL be that an audit trail which cannot distinguish a simulated action from a
  real one is an audit trail nobody can use afterwards

### Requirement: A mock is not a fallback

#### Scenario: A real implementation is configured and fails

- GIVEN an integration configured against a real system
- WHEN it fails
- THEN the failure SHALL be reported
- AND the portal SHALL NOT quietly produce a simulated result instead
- AND the reason SHALL be that a simulated result presented as an observation is worse than an error
