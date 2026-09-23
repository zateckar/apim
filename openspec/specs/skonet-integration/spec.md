# skonet-integration Specification

## Purpose

Define SkoNET as the estate's approval system: where a request for access to somebody else's
product or Kafka topic goes, and how the decision comes back. Simulated in this phase, with the
decision surface real.

## Requirements

### Requirement: Review the access being granted

#### Scenario: Approval history is returned

- GIVEN a subscription or Kafka approval event
- WHEN integration history is read
- THEN it SHALL include the current access state, product or topic name, and environment resolved from the underlying access record

#### Scenario: An approval is reviewed

- GIVEN the selected application
- WHEN Approvals renders
- THEN it SHALL show approvals from every environment, each naming its environment, and SHALL NOT
  narrow itself to the shell's selected environment
- AND it SHALL offer an environment filter — All and each stage of the promotion chain — each option
  carrying how many requests it would show
- AND the review dialog SHALL name the product or topic, the consumer and the environment
- AND cancelled or otherwise resolved access SHALL NOT offer a decision even if its outbox event still says awaiting-decision
- AND the reason SHALL be that a request waiting in PROD was invisible to a publisher whose switcher
  was on DEV, and a queue that hides part of itself is not a queue

### Requirement: An approval request is an outbox event, not a synchronous call

#### Scenario: Access to another application's product is requested

- GIVEN a consumer application and a publisher application
- WHEN a subscription or Kafka access request is created
- THEN a SkoNET event of kind `subscription.request` or `kafka.request` SHALL be emitted against the
  **publisher's** application, carrying the consumer, the publisher and the purpose
- AND the subscription or access row SHALL be `pending` until a decision arrives
- AND the decision SHALL not be waited for inside the request

#### Scenario: A request is dispatched

- GIVEN a queued SkoNET event
- WHEN the outbox processes it
- THEN it SHALL settle in `awaiting-decision`, not `delivered`
- AND it SHALL carry a tracking reference
- AND the reason SHALL be that an approval request is not finished when it is sent

### Requirement: The decision comes back to a real endpoint

#### Scenario: A publisher decides

- GIVEN an event awaiting a decision
- WHEN a member of the publisher's application submits `approved` or `rejected`
- THEN the event SHALL move to that state, and the underlying subscription or Kafka access SHALL
  move with it, in one transaction
- AND anything other than `approved` or `rejected` SHALL be refused with `400` naming both values

#### Scenario: Somebody else tries to decide

- GIVEN a caller who is not a member of the publisher's application and is not an administrator
- WHEN they submit a decision
- THEN it SHALL be refused
- AND the reason SHALL be that granting access was already the publisher's decision, by putting the
  API in the product

#### Scenario: The same decision arrives twice

- GIVEN an event already in the submitted state
- WHEN the decision is submitted again
- THEN it SHALL be accepted idempotently and nothing SHALL change

#### Scenario: A decision arrives for something not awaiting one

- GIVEN an event that is not `awaiting-decision`
- WHEN a decision is submitted
- THEN it SHALL be refused with `409` saying the request is not awaiting a decision

#### Scenario: A decision names an event that is not an approval

- GIVEN an id that is not a SkoNET approval request
- WHEN a decision is submitted
- THEN it SHALL answer `404` saying there is no such approval request

### Requirement: Both sides are told, by email, through the same outbox

#### Scenario: A request is raised

- GIVEN a new approval request
- WHEN it is emitted
- THEN the consumer SHALL receive an "Access requested" message and the publisher an "Approval
  requested" message, both carrying the purpose

#### Scenario: A decision is made

- GIVEN an approval or a rejection
- WHEN it is recorded
- THEN the consumer SHALL be notified either way
- AND the rejection SHALL be distinguishable from the approval in the feed's own vocabulary

### Requirement: Show the pending decisions where the publisher works

#### Scenario: The Approvals section is opened

- GIVEN a member of a publishing application
- WHEN the Approvals section renders
- THEN every request for that application's products and Kafka topics SHALL be listed with what is
  asked for and whether it is a product or a topic, the requesting application, when it was asked,
  the environment, the purpose and the state
- AND the requests awaiting a decision SHALL be listed first and apart from the decided ones, with
  their count
- AND the decision SHALL be offered as *Approve* and *Reject*, with an optional reason recorded
  with it
- AND the screen SHALL say the approvals are simulated
- AND it SHALL say that approved access is provisioned automatically

#### Scenario: There is nothing to decide

- GIVEN no pending requests
- WHEN the section renders
- THEN the empty state SHALL name what the reader can do instead

### Requirement: Never let the transport lose a decision

#### Scenario: The transport fails

- GIVEN a SkoNET event whose dispatch fails
- WHEN the outbox retries
- THEN it SHALL back off and remain visible with its attempt count
- AND the business state SHALL remain `pending` rather than being resolved either way
- AND the decision SHALL never be inferred from a delivery outcome
