# kafka-workspace Specification

## Purpose

Define Kafka topics as published things owned by an application: named by the estate's convention,
sized, carrying a schema of their type, created in TEST and staged to PROD, and consumed through
grants bound to a principal one operation at a time. The broker itself is simulated in this phase,
and every response says so. Trying a grant is `kafka-playground`'s; producing to a topic over HTTP
is `kafka-rest-proxy`'s.

## Requirements

### Requirement: A topic is named by the convention

#### Scenario: A topic is created in the portal

- GIVEN a member of an application creating a topic
- WHEN it is created
- THEN its name SHALL be built, never typed, as
  `{domain}[_{sub-domain}]_{application}_{display name}_{version}` from the slugs of each part
  (`shared/kafka.ts`, `buildTopicName`) — for example `sales_orders_platform-apis_order-created_v1`
- AND the display name SHALL be 2–80 characters with at least one letter or digit, and the version
  SHALL be `v` and a number, defaulting to `v1`
- AND the reason SHALL be that the name is how every consumer, ACL and consumer group refers to the
  topic for its whole life, and free-typed names were where two applications' topics collided
- AND the built name SHALL still match `^[A-Za-z0-9][A-Za-z0-9._-]{1,100}$`, refused with the
  sentence "shorten the display name" past it

#### Scenario: A topic is created by an API client with its own name

- GIVEN a request carrying an explicit `name`
- WHEN it is validated
- THEN the name SHALL be accepted when it matches the pattern above, because a topic that already
  exists on a broker keeps the name it has
- AND its display name SHALL default to the name

#### Scenario: A name is taken

- GIVEN a name another application's topic has, in any stage
- WHEN a topic of that name is created
- THEN it SHALL be refused with `409` naming it as another application's
- AND a name deleted in a stage SHALL NOT be reused there: creating or staging it SHALL be refused
  with `409` saying so and suggesting another version, because the table keeps one row per stage
  and name for good

### Requirement: Kafka has its own stages

#### Scenario: The stages Kafka has are asked for

- GIVEN the promotion chain (`PROMOTION_CHAIN`, `dev,test,prod` by default)
- WHEN anything about Kafka names a stage
- THEN Kafka's stages SHALL be `KAFKA_ENVIRONMENTS`, defaulting to TEST and PROD — the chain's
  stages that have a Kafka cluster — and there SHALL be no DEV topic, grant, connection, shared
  proxy or topic API
- AND the reason SHALL be that there is no DEV cluster: a DEV topic would name something nobody can
  connect to, while an API still starts in DEV
- AND `KAFKA_ENVIRONMENTS`, when set, SHALL name stages of the chain once each in the chain's order,
  refused at boot otherwise, because staging walks it and a list out of order would stage a topic
  out of PROD; unset on a chain with neither TEST nor PROD it SHALL be the whole chain
- AND `/api/meta` SHALL carry them as `kafkaChain`, and every Kafka screen SHALL draw its stages
  from it rather than from the chain
- AND a topic row in a stage outside them — written before Kafka had its own stages — SHALL NOT be
  listed, and SHALL NOT be staged

### Requirement: A topic starts in TEST and is staged to PROD

#### Scenario: A topic is created elsewhere than Kafka's first stage

- GIVEN a create request naming an environment other than Kafka's first stage
- WHEN it is submitted
- THEN a stage Kafka does not have SHALL be refused with `400` saying Kafka has TEST and PROD only,
  and PROD with `400` saying a topic is created in TEST and staged onward from its page
- AND an absent environment SHALL mean TEST

#### Scenario: A topic is staged

- GIVEN a ready topic in one stage, and its owner
- WHEN `POST /api/kafka/topics/:id/stage` is called
- THEN a row SHALL be written in Kafka's next stage with the same name, display name,
  domain, partitions, replication, retention, min.insync.replicas, compatibility, schema,
  description and wiki link, in `provisioning`, created there by the broker integration like any
  topic
- AND its schema SHALL start as that stage's version 1
- AND the certificate SHALL NOT be carried, because a certificate belongs to one stage, and grants
  SHALL NOT be carried, because each stage's access is asked for and approved on its own
- AND staging SHALL be refused with `409` for a topic that is not ready, at the last stage, or
  already in the next stage, and with `403` for anybody but the owner or an administrator
- AND the stage and the audit SHALL be recorded as `kafka.stage`

### Requirement: A topic is sized

#### Scenario: A topic is sized at creation

- GIVEN a topic being created
- WHEN its size is chosen
- THEN it SHALL be one of S (8 partitions, 2 replicas, 1 day), M (16, 2, 3 days) or L (32, 2, 5
  days), defaulting to S, or custom numbers
- AND partitions SHALL be 1–100, replication 1–3, retention 1–7 days or the broker's default, and
  min.insync.replicas 1–3 or the broker's default
- AND min.insync.replicas SHALL NOT exceed the replication factor, refused with the reason that no
  write could ever succeed

#### Scenario: A topic's size is changed

- GIVEN a topic's owner
- WHEN its properties are saved
- THEN partitions SHALL only increase, because a broker cannot take a partition away
- AND replication SHALL be refused as fixed at creation, because changing it is a reassignment, not a
  setting
- AND retention and min.insync.replicas MAY change within their limits, or return to the broker's
  default

### Requirement: A topic carries a schema of its type

#### Scenario: A schema is set

- GIVEN a topic being created or changed by its owner
- WHEN its schema is set
- THEN the type SHALL be one of `json`, `avro` or `protobuf`
- AND the definition SHALL be text of that type, at most 256 KiB, checked by `schemaCheck` in
  `shared/kafka.ts`: JSON against the gateway's own schema compiler (the one `kafka-rest-proxy`'s
  generated API is compiled with), Avro for the shape a registry would refuse, Protobuf for balanced
  braces and at least one message, enum or service — a missing `syntax` line warned about, not
  refused
- AND a JSON definition SHALL be stored as JSON and an Avro or Protobuf one as the text written
- AND a new type with no new definition SHALL clear the old definition, because it was another
  language's
- AND the compatibility SHALL be one of `BACKWARD`, `FORWARD`, `FULL`, `NONE`, or empty for the
  registry's default
- AND the API SHALL still accept a topic with no schema, while the portal's wizard SHALL require one

#### Scenario: A schema changes

- GIVEN a topic's definition or type changes
- WHEN it is saved
- THEN its schema version SHALL be the next number, the way a registry numbers a subject's versions,
  and the response SHALL say which
- AND saving the same definition again SHALL NOT be a new version
- AND the subject SHALL be `<name>-value`, which the schema card SHALL name under its Save
- AND the schema itself SHALL NOT be written to the audit detail, only the version it became

#### Scenario: A schema edit on a topic with an HTTP API

- GIVEN a topic whose API (`kafka-rest-proxy`) is published in its stage
- WHEN its schema or certificate changes
- THEN the API SHALL be regenerated as described in `kafka-rest-proxy`
- AND a change to a non-JSON type, or taking the schema or certificate off, SHALL be refused with
  `409` while the API exists

### Requirement: A topic's classification is fixed

#### Scenario: A topic is classified

- GIVEN a topic being created
- WHEN it is saved
- THEN a domain SHALL be **required**, validated against the same taxonomy an API is, with an
  optional sub-domain
- AND topics SHALL be counted in the catalogue's domain facets in the same taxonomy as APIs

#### Scenario: A topic is reclassified

- GIVEN an existing topic
- WHEN a change to its domain or sub-domain is submitted
- THEN it SHALL be refused with `400`, because the name carries the domain, and a moved topic would
  keep a name that says the wrong thing on every consumer's configuration

### Requirement: The topic list shows each topic's versions and stages

#### Scenario: The Kafka Topics section is opened

- GIVEN a selected application
- WHEN `/:application/kafka` renders
- THEN it SHALL list one row per topic family and owner — every version of one topic — with its
  schema badge (JSON, AVRO, PROTO or NO SCHEMA), display name, name, and "N partitions · N replicas
  · N consumers", where consumers are the applications holding a live READ
- AND each row SHALL carry the version picker and one chevron per Kafka stage — TEST and PROD — each enabled
  when the chosen version is in that stage and opening the topic there
- AND the list SHALL NOT be scoped by the shell's environment switcher, because each row says which
  stages it is in
- AND a toggle SHALL show either the topics the application publishes or the ones it holds a live
  grant on without owning, each with its count, and a search SHALL narrow either by title, name,
  owner or domain
- AND a subscribed row SHALL say whose it is, offer only the versions the application holds a live
  grant on, and offer *Test in Playground*; an owned row SHALL offer deleting the version in the
  stage it opens on
- AND the page head SHALL offer Refresh, *Subscribe to Topic* and *Create Topic*
- AND a topic's state SHALL be shown only when it is not `ready`

#### Scenario: The list cannot be read

- GIVEN the topics or the grants cannot be read
- WHEN the list renders
- THEN the failure SHALL be shown, and SHALL NOT appear as an empty list

### Requirement: A topic is created by a wizard

#### Scenario: The wizard is opened

- GIVEN a member of an application
- WHEN `/:application/kafka/new` opens
- THEN it SHALL walk three steps — Schema, Topic, Review — each reachable only when the ones before
  it are answered, with what is still needed said in a sentence
- AND the Schema step SHALL offer the type, the compatibility, uploading a file, pasting into an
  editor, a chip saying whether the text is valid, and a blank template of the chosen type
- AND the Topic step SHALL offer the display name, the version, the domain and sub-domain, the
  resulting name as it will be built, the size, a Markdown description and a wiki link
- AND a name that already exists, or was deleted, SHALL be refused on the Topic step rather than by
  the server
- AND the Review step SHALL state everything that will be created and that it is created in TEST
- AND leaving a started wizard SHALL ask first, and creating SHALL open the new topic

### Requirement: A topic is one page, per stage

#### Scenario: A topic is opened

- GIVEN a topic name
- WHEN `/:application/kafka/:topic` opens
- THEN it SHALL show the row of the stage the shell's switcher names, the switcher offering Kafka's
  stages only — TEST and PROD, not DEV — and enabling only the ones the topic is in
- AND arriving with the shell on a stage Kafka does not have SHALL say so, with a control to open the
  topic where it is
- AND the head SHALL carry the owner, badge, domain and state, the name with a copy control, the
  version with the family's other versions to switch to, the wiki link, and — for the owner — the
  HTTP proxy and *Stage to <next>*, disabled with its reason when staging is not possible
- AND a stage the topic is not in SHALL say where it is, with a control to open it there
- AND anybody who is not a member of the owning application SHALL see everything read-only, with a
  sentence naming the owner

#### Scenario: The Schema & Properties tab

- GIVEN a topic page
- WHEN its first tab renders
- THEN it SHALL show the schema (type, compatibility, definition, validity, version), the properties
  (partitions, replication, retention, min.insync.replicas) and the details (Markdown description,
  wiki link), each with its own Save for the owner
- AND an unsaved edit SHALL be guarded against navigation

### Requirement: Access is granted to a principal, one operation at a time

#### Scenario: An application asks for access

- GIVEN a ready topic in a stage and a consuming application
- WHEN `POST /api/kafka/topics/:id/subscribe` is called
- THEN it SHALL name an authentication — `mtls` or `oauth` — and a principal: a certificate's DN
  that includes its CN, or an OAuth client id
- AND it SHALL name one or more operations of `read`, `write`, `describe` and `delete`, and a
  purpose of 3 to 500 characters
- AND one grant row SHALL be written per operation, sharing one request id, and a READ SHALL get a
  consumer group of its own, `<topic>_<APPLICATION>_<six characters>`
- AND the rows SHALL be `activating` for the owner's own request and `pending` otherwise, with one
  approval raised with the owner for the whole request
- AND the reason SHALL be that a broker binds an ACL to a principal and grants READ and WRITE
  separately, so one row per application said nothing a broker would enforce

#### Scenario: Access is requested twice

- GIVEN a live grant (`pending`, `activating`, `active` or `revoking`) for the same topic,
  application, principal and operation
- WHEN it is asked for again
- THEN it SHALL be refused with `409` naming the operations already requested or granted

#### Scenario: A request is decided

- GIVEN a pending request
- WHEN its owner approves or rejects it
- THEN every pending row of the request SHALL be decided together, and each approved row granted by
  the broker integration
- AND Approvals SHALL show the principal, its authentication and every operation being decided

#### Scenario: Access is taken away

- GIVEN a grant
- WHEN `DELETE /api/kafka/access/:id` is called by either side
- THEN a pending request SHALL be cancelled whole, every operation asked for with it
- AND a granted operation SHALL be revoked on its own, so a consumer can drop WRITE and keep READ
- AND in the portal it SHALL sit behind the typed confirmation, and a request pending on the owner's
  topic SHALL link to Approvals instead

#### Scenario: A grant written before principals existed

- GIVEN a grant row from before this version
- WHEN it is shown
- THEN it SHALL be a principal-less READ, said as "granted before principals" rather than given an
  invented principal

### Requirement: The Subscriptions tab shows who may do what

#### Scenario: The Subscriptions tab

- GIVEN a topic page
- WHEN the Subscriptions tab renders
- THEN it SHALL head with how many grants the selected application holds here and a *New
  subscription* control
- AND it SHALL list them in three sections: Read (principal, consumer group with a copy control,
  authentication, state), Write (principal, authentication, state), and Delete / Describe
  (principal, authentication, permission, state) — the last saying, when empty, that these are
  added with new Read and Write subscriptions
- AND the owner SHALL also see every other application's grants on the topic, because a topic
  cannot be deleted while anybody holds it

#### Scenario: The connection is shown

- GIVEN a topic page's Subscriptions tab
- WHEN `GET /api/kafka/connection?environment=` answers
- THEN it SHALL show the stage's public bootstrap host on the mTLS port and on the OAuth port, from
  `KAFKA_BOOTSTRAP_<ENV>`, `KAFKA_MTLS_PORT` (9400) and `KAFKA_OAUTH_PORT` (9800)
- AND a stage with no host SHALL say "not configured" and name the variable that sets it, rather than
  show an address that would not answer

### Requirement: Delete a topic only when nothing is consuming it or producing through it

#### Scenario: A topic with live access is deleted

- GIVEN a topic with any grant in `pending`, `activating`, `active` or `revoking`
- WHEN deletion is attempted
- THEN it SHALL be refused with `409` saying to revoke or cancel the topic's subscriptions first

#### Scenario: A topic with an HTTP API is deleted

- GIVEN a topic whose API (`kafka-rest-proxy`) is published in the topic's stage
- WHEN deletion is attempted
- THEN it SHALL be refused with `409` saying to retire the API first

#### Scenario: A topic is deleted

- GIVEN a topic nothing is consuming, in one stage
- WHEN it is deleted
- THEN that stage's row SHALL be marked deleted rather than removed, and the deletion SHALL be audited
- AND the control SHALL sit behind the typed confirmation and name the stage

### Requirement: Say that Kafka is simulated

#### Scenario: Any Kafka response is returned

- GIVEN any Kafka endpoint
- WHEN it answers
- THEN the response SHALL be marked simulated
- AND the shell SHALL say, on every screen, that the external systems are simulated

#### Scenario: A Kafka action is audited

- GIVEN a topic created, changed, staged or deleted, or a grant requested or revoked
- WHEN it is audited
- THEN the audit detail SHALL record that it was simulated
- AND the reason SHALL be that an audit trail that cannot distinguish a simulated action from a real
  one is an audit trail nobody can use afterwards
