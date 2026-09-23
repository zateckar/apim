# kafka-workspace Specification

## Purpose

Define Kafka topics as catalogue items owned by an application, the access requests that are the
Kafka counterpart of subscribing, and the HTTP proxy that lets a caller produce over HTTP. The
broker itself is simulated in this phase, and every response says so.

## Requirements

### Requirement: Keep topic creation separate from existing topic drafts

#### Scenario: Creation follows inspection

- GIVEN a topic that was inspected or edited
- WHEN Create topic is opened
- THEN the form SHALL start with an empty name, description and taxonomy and three partitions
- AND it SHALL state the owning application and environment

#### Scenario: Access is already being processed

- GIVEN an application with pending, activating or revoking access to the selected topic
- WHEN the topic dialog renders
- THEN it SHALL show that state rather than offer a duplicate access request
- AND access requests SHALL wait for the access list and a valid purpose
- AND topic and access read failures SHALL NOT appear as empty inventories

### Requirement: A topic is a catalogue item owned by an application

#### Scenario: A topic is created

- GIVEN a member of an application
- WHEN they create a topic
- THEN it SHALL carry the owning application, an environment from the promotion chain, a name, a
  partition count, a description, and a domain with an optional sub-domain
- AND a topic SHALL be created only by a member of the owning application, or an administrator

#### Scenario: A topic is validated

- GIVEN a topic being created or changed
- WHEN it is validated
- THEN the name SHALL match `^[A-Za-z0-9][A-Za-z0-9._-]{1,100}$`, described as "2–101 letters,
  numbers, dots, underscores or hyphens"
- AND partitions SHALL be an integer from 1 to 100, defaulting to 3
- AND the environment SHALL be one the promotion chain declares

#### Scenario: A topic is classified

- GIVEN a topic
- WHEN it is saved
- THEN a domain SHALL be **required**, validated against the same taxonomy an API is
- AND there SHALL be no path prefix to derive, because a topic is addressed by name on a broker
- AND the reason the domain is still required SHALL be that an unclassified topic is one nobody
  browsing by domain will ever see

#### Scenario: Topics are counted in the catalogue

- GIVEN domains holding both APIs and topics
- WHEN the catalogue's domain facets are computed
- THEN topics SHALL be counted in the same taxonomy as APIs

### Requirement: The topic list mirrors the API list

#### Scenario: The Kafka Topics section is opened

- GIVEN a selected application
- WHEN the section renders
- THEN topics SHALL be listed with the same shape as APIs: name, environment, domain, state, and
  what may be done to each
- AND every row SHALL carry whether the reader may edit it
- AND the list SHALL be readable by anybody, because reading everything is the one rule
- AND the selected application's own topics SHALL be listed apart from other applications', because
  what may be done differs — an owner edits, anybody else asks for access
- AND a topic's state SHALL be shown only when it is not `ready`, and the selected application's
  own access to it SHALL be shown when it holds any
- AND an empty environment SHALL offer creating a topic from its empty state, with no second
  creation control in the panel head

#### Scenario: A topic is opened

- GIVEN a topic row
- WHEN it is opened
- THEN the topic's owner, environment, description, partition count, domain and proxy setting
  SHALL be shown, with the selected application's access to it
- AND the proxy setting SHALL link to the Kafka REST Proxy section, which is where it is changed
- AND for anybody who is not a member of the owning application the facts SHALL be shown read-only
  with a sentence naming who can change them, rather than as a form of disabled fields

### Requirement: Consuming a topic is requested and approved

#### Scenario: An application asks for access

- GIVEN a topic and a consuming application
- WHEN access is requested
- THEN a purpose of 3 to 500 characters SHALL be required
- AND the state SHALL be `pending` for another application's topic, and `activating` for the
  owner's own
- AND an approval request SHALL be raised with the publisher when it is not their own

#### Scenario: Access is requested twice

- GIVEN an existing request in `pending`, `activating`, `active` or `revoking`
- WHEN the same application asks again for the same topic
- THEN it SHALL be refused with `409` saying the request already exists

#### Scenario: Access is revoked

- GIVEN an active access grant
- WHEN it is revoked
- THEN it SHALL stop applying, and the revocation SHALL be audited
- AND in the portal the row SHALL offer *Revoke* — or *Cancel request* for the requester's own
  pending request — opening a dialog that holds only the typed confirmation, the same shape as a
  subscription's
- AND a request pending on the owner's own topic SHALL link to Approvals instead, because a request
  is decided there with Approve or Reject, not cancelled on the requester's behalf

### Requirement: Delete a topic only when nothing is consuming it

#### Scenario: A topic with live access is deleted

- GIVEN a topic with any access row in `pending`, `activating`, `active` or `revoking`
- WHEN deletion is attempted
- THEN it SHALL be refused with `409` saying to revoke or cancel the topic's subscriptions first

#### Scenario: A topic is deleted

- GIVEN a topic nothing is consuming
- WHEN it is deleted
- THEN it SHALL be marked deleted rather than removed, and the deletion SHALL be audited
- AND the control SHALL sit behind the typed confirmation

### Requirement: Offer an HTTP proxy per topic, off by default

#### Scenario: The proxy is enabled

- GIVEN a topic
- WHEN its owner enables the proxy
- THEN producing a JSON message over HTTP SHALL become available for that topic
- AND it SHALL be off unless somebody turns it on

#### Scenario: The Kafka REST Proxy section is opened

- GIVEN the sidebar's Kafka group
- WHEN the Kafka REST Proxy section opens
- THEN it SHALL list every topic in the selected environment that the selected application owns or
  holds active access to, each with whether its proxy is on
- AND a topic without the proxy enabled SHALL say so rather than be absent
- AND the owner SHALL be able to turn the proxy on and off there, and anybody else SHALL be told
  who can
- AND a topic whose proxy is on and which the application may use SHALL show the HTTP endpoint and
  a produce and a consume command, each with a copy control
- AND a topic whose proxy is on but which the application holds no active access to SHALL say that
  access is needed first, and link to Kafka Topics
- AND the section SHALL NOT offer creating a topic, because that belongs to Kafka Topics

#### Scenario: The proxy's address is given

- GIVEN the simulated broker of this phase
- WHEN the endpoint and commands are composed
- THEN they SHALL name the portal's own Kafka console endpoint at the portal's public origin, with
  the portal session and a matching `Origin` header, because that is what answers
- AND the section SHALL say that the portal answers for the proxy and that a call uses the portal
  sign-in rather than a subscription key
- AND the reason SHALL be that an invented proxy host would be an address that answers nothing

### Requirement: Say that Kafka is simulated

#### Scenario: Any Kafka response is returned

- GIVEN any Kafka endpoint
- WHEN it answers
- THEN the response SHALL be marked simulated
- AND every screen showing it SHALL say so, in words

#### Scenario: A Kafka action is audited

- GIVEN a topic created, changed or deleted
- WHEN it is audited
- THEN the audit detail SHALL record that it was simulated
- AND the reason SHALL be that an audit trail that cannot distinguish a simulated action from a real
  one is an audit trail nobody can use afterwards

### Requirement: Validate topic drafts in the portal

#### Scenario: A draft is edited

- GIVEN a topic creation or editing form
- WHEN its fields are edited
- THEN the portal SHALL reject invalid topic names and loaded duplicates in the environment before creation
- AND partition counts SHALL be integers from 1 to 100 and SHALL NOT decrease on edit
- AND domain and sub-domain controls SHALL state their dependency
