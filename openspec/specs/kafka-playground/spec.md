# kafka-playground Specification

## Purpose

Define the Kafka playground: one read or one write against a topic, from inside the portal, as one
of the application's own grants on it and with the credential the broker would check for that
grant. The broker is simulated in this phase, and every response says so.

## Requirements

### Requirement: The playground is a tab of the topic

#### Scenario: The playground is opened

- GIVEN a topic page (`kafka-workspace`)
- WHEN its Playground tab opens
- THEN it SHALL list the selected application's READ and WRITE grants on the topic in that stage,
  each with its principal, authentication, operation and state, and only an active one SHALL be
  selectable
- AND an application with no such grant SHALL be offered asking for one rather than an empty console
- AND a subscribed row of the topic list SHALL open this tab directly (*Test in Playground*)

### Requirement: Operate only as an active grant, with its credential

#### Scenario: A request names its grant

- GIVEN `POST /api/kafka/topics/:id/playground`
- WHEN it is called
- THEN it SHALL name the grant (`accessId`), which SHALL be the application's own on this topic and
  `active`, refused with `409` otherwise
- AND a write SHALL need a WRITE grant and a read a READ grant, refused with `409` naming the one it
  needs, because the grant is who is asking
- AND the caller SHALL be a member of the application named, the picker being context and not proof
- AND a topic that is not ready SHALL be refused with `409` saying it is unavailable

#### Scenario: An mTLS grant is used

- GIVEN a grant whose authentication is `mtls`
- WHEN the playground is used
- THEN the request SHALL name one of the application's certificates in the topic's stage, not
  expired, whose subject is the grant's DN — compared part by part, in any order and case, by
  `dnMatches` — refused with `409` saying which of those it is not
- AND the portal SHALL offer only the certificates that match, and say when none does with a way to
  the Certificates screen

#### Scenario: An OAuth grant is used

- GIVEN a grant whose authentication is `oauth`
- WHEN the playground is used
- THEN the simulated broker SHALL check the grant by client id, and the portal SHALL ask for no secret

### Requirement: Write one record, bounded

#### Scenario: A record is written

- GIVEN a write
- WHEN it is submitted
- THEN exactly one record SHALL be written, with an optional key of at most 1024 characters, at most
  20 headers, and a value of at most 32768 characters refused by name past that
- AND the request body SHALL be capped at 64 KiB
- AND it SHALL land on the partition asked for, else on the key's hash, else round-robin, at that
  partition's next offset, and the response SHALL say which partition and offset
- AND a partition outside the topic SHALL be refused with `400` naming the range
- AND the portal SHALL ask for an explicit confirmation before a write to Kafka's last stage, PROD,
  where real consumers read

#### Scenario: The topic's stored records accumulate

- GIVEN repeated writes
- WHEN a record is written
- THEN only the newest 100 records per topic SHALL be retained
- AND the reason SHALL be that this is a console's scratch buffer, not a broker

### Requirement: Read without a group, bounded by the server

#### Scenario: Records are read

- GIVEN a read
- WHEN it runs
- THEN it SHALL read one partition or all of them, from a position — the latest N (default 20), the
  earliest, an offset of one partition, or a time — returning at most the maximum asked for and never
  more than 100, each record with its partition, offset, key, headers, value and timestamp
- AND an offset without a partition SHALL be refused with `400`, because an offset is one partition's
- AND there SHALL be no consumer group joined and no cursor moved; the response and the portal SHALL
  name the grant's consumer group as not used by the test
- AND the reason SHALL be that a console read must not be able to disturb a real consumer's position

#### Scenario: An unknown action is requested

- GIVEN an action other than `produce` or `consume`
- WHEN it is submitted
- THEN it SHALL be refused with `400` naming both legal values

### Requirement: Keep a request history in the browser

#### Scenario: A request is sent

- GIVEN a read or a write, answered or refused
- WHEN it completes
- THEN it SHALL be added to a history of at most 25 per topic and stage, newest first, kept in the
  browser only and cleared on request
- AND an entry SHALL hold what was asked and what came back, naming a certificate by its name and
  never holding credential material

### Requirement: Say that every result is simulated

#### Scenario: Any playground response is returned

- GIVEN a read or a write
- WHEN it answers
- THEN the response SHALL be marked simulated
- AND the tab SHALL say so, in words, beside the request

#### Scenario: A playground action is audited

- GIVEN a read or a write
- WHEN it completes
- THEN one audit row SHALL record the action, the topic, the application and the grant
- AND the detail SHALL record that it was simulated
