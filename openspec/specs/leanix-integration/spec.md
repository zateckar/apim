# leanix-integration Specification

## Purpose

Define LeanIX as the source of an application's **business metadata** — its LeanIX id, its
description and its owner contact. LeanIX owns those values; this portal only quotes them.
Simulated in this phase.

## Requirements

### Requirement: Quote LeanIX, never copy it

#### Scenario: An application's metadata is read

- GIVEN an application
- WHEN its business metadata is needed
- THEN it SHALL be read from the delivered LeanIX outbox event, not from a table of its own
- AND the reason SHALL be that LeanIX owns these values and a second copy would be a second thing to
  keep in step

#### Scenario: The lookup has not answered yet

- GIVEN an application LeanIX has not been asked about, or one whose result cannot be parsed
- WHEN the metadata is read
- THEN there SHALL simply be no entry
- AND every screen showing the id SHALL degrade to showing nothing
- AND the id SHALL be a convenience for a human eye, never something a decision rests on

### Requirement: Ask once, per application

#### Scenario: The estate is started

- GIVEN the control plane booting
- WHEN it initialises
- THEN a metadata lookup SHALL be emitted for every application

#### Scenario: An application is created

- GIVEN a new application
- WHEN it is created
- THEN a metadata lookup SHALL be emitted for it

#### Scenario: The lookup is emitted repeatedly

- GIVEN an application that has already been looked up
- WHEN a lookup is emitted again
- THEN the existing outbox event SHALL be returned and no second one created
- AND the outbox SHALL retry the transport on its own if the lookup failed

#### Scenario: An approval is raised

- GIVEN an approval request against a publisher
- WHEN it is emitted
- THEN a metadata lookup for the publisher SHALL be emitted alongside it, idempotently

### Requirement: Show the LeanIX id where it identifies an application

#### Scenario: An application card renders in the picker

- GIVEN an application with a known LeanIX id
- WHEN the card renders
- THEN the application's name SHALL be the primary line and the LeanIX id a monospace subline
- AND an application without one SHALL render its name alone, with no placeholder

#### Scenario: An application's page renders

- GIVEN an application
- WHEN its page renders
- THEN the LeanIX description and owner contact SHALL be shown when they are known
- AND they SHALL be marked as coming from LeanIX rather than presented as the portal's own fields
- AND they SHALL be read-only here, because this portal does not own them

### Requirement: Mark every LeanIX result as simulated

#### Scenario: A metadata result is produced

- GIVEN the mocked LeanIX implementation
- WHEN it answers
- THEN the result SHALL carry `simulated: true` and derive its values from the application's own
  name and id
- AND every screen that shows them SHALL say they are simulated

### Requirement: LeanIX is never on the path of a decision

#### Scenario: LeanIX is unavailable

- GIVEN a failing LeanIX lookup
- WHEN a publish, a subscription, an approval or a promotion is attempted
- THEN none of them SHALL be blocked
- AND the only consequence SHALL be that a screen shows an application's name without its business
  metadata
