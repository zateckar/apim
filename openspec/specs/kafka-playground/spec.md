# kafka-playground Specification

## Purpose

Define the Kafka console: producing one message to a topic and reading back what is on it, from
inside the portal, gated on the same access grant a real client would need. The broker is simulated
in this phase, and every response says so.

## Requirements

### Requirement: The playground is a panel of the topic, not a screen of its own

#### Scenario: The playground is opened

- GIVEN a topic the caller can see
- WHEN its playground panel opens
- THEN it SHALL offer producing a message and consuming the recent ones for that topic and that
  environment
- AND it SHALL sit beside the topic's other panels rather than in a separate console

### Requirement: Operate only through an active access grant

#### Scenario: The caller has no grant

- GIVEN an application with no `active` access row for the topic
- WHEN the playground is used
- THEN it SHALL be refused with `409` saying an active topic subscription is required
- AND the reason SHALL be that the console is the same relationship a real client would use, not a
  way around it

#### Scenario: The caller is not in the application

- GIVEN a caller who is not a member of the application named in the request
- WHEN the playground is used
- THEN it SHALL be refused
- AND the application picker SHALL be understood as context, not proof

#### Scenario: The topic is not ready

- GIVEN a topic in any state other than ready
- WHEN the playground is used
- THEN it SHALL be refused with `409` saying the topic is unavailable

### Requirement: Produce exactly one message, bounded

#### Scenario: A message is produced

- GIVEN the produce action
- WHEN it is submitted
- THEN exactly one message SHALL be written
- AND its value SHALL be a string of at most 32768 characters, refused by name past that
- AND the request body itself SHALL be capped at 64 KiB

#### Scenario: The topic's stored messages accumulate

- GIVEN repeated produces
- WHEN a message is written
- THEN only the newest 100 messages per topic SHALL be retained
- AND the reason SHALL be that this is a console's scratch buffer, not a broker

### Requirement: Consume without a group, bounded by the server

#### Scenario: Messages are read back

- GIVEN the consume action
- WHEN it runs
- THEN it SHALL return the newest 20 messages for the topic, each with an offset, its value and when
  it was written
- AND there SHALL be no consumer group to name and no cursor a caller can move
- AND the reason SHALL be that a console read must not be able to disturb a real consumer's position

#### Scenario: An unknown action is requested

- GIVEN an action other than `produce` or `consume`
- WHEN it is submitted
- THEN it SHALL be refused with `400` naming both legal values

### Requirement: Say that every result is simulated

#### Scenario: Any playground response is returned

- GIVEN a produce or a consume
- WHEN it answers
- THEN the response SHALL be marked simulated
- AND the panel SHALL say so, in words, beside the results

#### Scenario: A playground action is audited

- GIVEN a produce or a consume
- WHEN it completes
- THEN one audit row SHALL record the action, the topic and the application
- AND the detail SHALL record that it was simulated
