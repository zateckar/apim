# kafka-rest-proxy Specification

## Purpose

Define how a Kafka topic is produced to over HTTP: through an ordinary REST API **generated from the
topic's JSON schema**, owned by the topic's application, whose backend is a **shared Kafka proxy**
owned by the portal itself, whose backend in turn is a Confluent REST Proxy (v3).

Both are resources on the ordinary spine — published, configured and promoted through the same
operations as any API, served by the same gateways, subscribed to through the same products. What
this capability adds is who owns each, what the platform derives rather than lets anybody type, and
the one credential only the platform may present.

```
consumer ──(its subscription key)──▶ gateway: the topic's API      validates the record against the schema
                                       │  backendAuth: the portal's key, client certificate: the topic's
                                       ▼
                                     gateway: the shared Kafka proxy  kafkaProduce { clusterId }
                                       │
                                       ▼
                                     Confluent REST Proxy  POST /v3/clusters/{cluster}/topics/{topic}/records
```

The topic's schema, type and certificate are `kafka-workspace`'s; the `kafkaProduce` unit is
`api-policy-controls`'; the simulated Confluent REST Proxy is `integrations-and-mocks`'.

## Requirements

### Requirement: The shared Kafka proxy is the portal's, and only an administrator changes it

#### Scenario: The platform application exists

- GIVEN any database at schema 16 or later
- WHEN it is read
- THEN an application with id `platform`, named "Integration Portal", SHALL exist
- AND it SHALL have no members: `grantMembership` SHALL refuse it, identity-provider group mapping
  SHALL report a group that would resolve to it as unmapped rather than match or provision it, and
  the application directory (`GET /api/applications`) SHALL NOT list it
- AND the reason SHALL be that, under the one authorization rule, an application nobody belongs to
  is one only an administrator can change — which is exactly who should change what every topic's
  API depends on

#### Scenario: An administrator sets the shared proxy up in an environment

- GIVEN an administrator, a Kafka REST Proxy URL and a cluster id (1–255 letters, digits, dots,
  underscores or hyphens, as `kafkaProduce` validates it)
- WHEN `POST /api/kafka/proxy/shared` is called with an `Idempotency-Key` and an environment
- THEN with no shared proxy yet it SHALL publish one in the chain's first environment and SHALL
  refuse any other with `409`
- AND in a later environment it SHALL promote the shared proxy there, and in an environment it is
  already in it SHALL reconfigure its backend and `kafkaProduce.clusterId`, keeping its other units
- AND the resource SHALL be a REST API named `kafka-rest-proxy`, version `v1`, owned by `platform`,
  with `platform_role = 'kafka-proxy'`, visibility `unlisted`, domain IT / Operation, a contract of
  one operation `POST /topics/{topic}` accepting any JSON body, and a policy of the default
  subscription key and `kafkaProduce`
- AND a non-administrator SHALL be refused with `403`

#### Scenario: The platform's own key reaches a stage with the shared proxy

- GIVEN the shared proxy being published or promoted to an environment
- WHEN its operation is queued
- THEN in the same transaction the `platform` application SHALL be given a subscription to the
  shared proxy's product in that environment, `activating` until the fleet has it like any
  own-product subscription
- AND this SHALL NOT go through `createSubscription`, which requires a member of the subscribing
  application

### Requirement: A topic's API is generated from the topic and owned by the topic's owner

#### Scenario: A topic can have an API

- GIVEN a topic
- WHEN whether it can have an API is asked (`topicApiBlockers`)
- THEN it SHALL need to be `ready`, of schema type `json` with a schema, and to name a client
  certificate that is still usable in its environment
- AND each missing condition SHALL be stated as a sentence its owner can act on, in the order they
  would be fixed, and the control plane SHALL refuse with the first

#### Scenario: A topic's owner creates its API

- GIVEN a member of the topic's application, a topic that can have an API, in the chain's first
  environment, with the shared proxy published there
- WHEN `POST /api/kafka/topics/:id/proxy` is called with an `Idempotency-Key`
- THEN a REST API SHALL be published, owned by the topic's application, with `kafka_topic` set to
  the topic's name, named `kafka-` and the topic's name folded to `[a-z0-9-]` (cut to 61 characters
  with a short hash of the whole name when it is longer), version `v1`, listed, in the topic's
  domain and sub-domain
- AND its definition SHALL be OpenAPI 3.1 with one operation, `POST /topics/<topic>`, whose request
  body is the topic's JSON Schema with `$schema` and `$id` removed and `$defs` (or `definitions`)
  moved to `components.schemas` with every `$ref` into them rewritten — because inside an OpenAPI
  document a `#/…` pointer resolves against the document
- AND validation SHALL be at its default, blocking, so a record the topic would not accept is
  refused at the first gateway and never reaches Kafka
- AND its backend SHALL be every published address of the shared proxy in that environment, as a
  `failover` pool, and its client certificate the topic's
- AND the same call in a later environment SHALL promote the API the topic already has, and in the
  first environment with an API already there it SHALL be refused with `409`

#### Scenario: A topic's API reaches the shared proxy

- GIVEN a topic's API
- WHEN any document it is part of is built
- THEN it SHALL carry `backendAuth` `{ type: "api-key", credentialRef: "platform:kafka-proxy",
  in: "header", name: "X-Api-Key" }`, which the configuration build SHALL resolve to the `platform`
  application's primary key to the shared proxy in that environment
- AND that reference resolving to nothing SHALL be reported like any unresolved reference

#### Scenario: A consumer produces a record

- GIVEN a consumer subscribed to a topic's API and a record that matches the topic's schema
- WHEN it is posted to the topic's API with the consumer's key
- THEN the first gateway SHALL validate it and call the shared proxy with the portal's key and the
  topic's certificate, and the shared proxy's gateway SHALL produce it as
  `{"value":{"type":"JSON","data":<record>}}` to the Kafka REST Proxy, returning its answer
- AND a record that does not match SHALL be refused with `400` by the first gateway
- AND a consumer's own key SHALL be refused by the shared proxy (`403`), because nobody but the
  platform subscribes to it

### Requirement: What the platform derives, nobody writes

#### Scenario: The platform's key is presented only where the platform put it

- GIVEN any publish, configure or promote, by anybody, administrators included — or any write of a
  global policy unit
- WHEN its policy names a `platform:` reference in any `…Ref` field of a unit the platform does not
  manage on that API
- THEN it SHALL be refused with `403` saying only the portal writes one
- AND on a topic's API the managed `backendAuth` SHALL be forced back into every document, whatever
  the request sent, rather than refused — the editor sends the whole effective document on every
  save, and a save about a rate limit should not fail over a unit the owner never touched

#### Scenario: A topic's API's definition, backend or certificate is edited

- GIVEN a topic's API
- WHEN a configure other than the platform's own regeneration sends a definition, a backend URL or
  pool, or a client certificate
- THEN it SHALL be refused with `409` naming the topic, because each is derived from the topic or
  the shared proxy and an edit here would be undone by the next change there
- AND the workspace SHALL say so where each would be edited: the definition read-only with a notice
  linking Kafka Topics, the backend fields disabled with a notice, and the policy panel saying that
  backend authentication is the portal's

#### Scenario: A schema edit regenerates the topic's API

- GIVEN a topic whose API is published in the topic's environment
- WHEN its owner saves a new schema or a new certificate
- THEN a configure SHALL be queued before the topic row changes — a new definition for a new
  schema, a new client certificate for a new certificate — so a schema the compiler refuses leaves
  both as they were
- AND the response SHALL carry that operation, and the portal SHALL say the API is being
  regenerated
- AND taking the schema, the JSON type or the certificate off while the API exists SHALL be refused
  with `409`

#### Scenario: A topic's API is promoted

- GIVEN a topic's API promoted to an environment, from Kafka REST Proxy or from its workspace
- WHEN the promotion is requested
- THEN its backend and certificate SHALL be that environment's — the shared proxy's addresses there,
  and the certificate of that environment's topic of the same name — and anything the request sent
  for them SHALL be ignored
- AND it SHALL be refused with `409`, naming what is missing, when that environment has no topic of
  that name, the topic belongs to another application, the topic cannot have an API, or the shared
  proxy is not published there

### Requirement: The platform's key never expires out from under a topic

#### Scenario: The key-expiry job runs

- GIVEN the `platform` application's subscription to the shared proxy
- WHEN `runKeyExpiry` runs
- THEN it SHALL NOT be marked expired
- AND once its primary key is `SUBSCRIPTION_KEY_WARN_DAYS` old it SHALL be replaced with a fresh
  one, and the rotation audited
- AND the reason SHALL be that nobody holds this key — the gateway is handed its hash and its value
  in the same document — so expiry would only break every topic's API at once, while a rotation
  reaches every gateway in one document with no moment where one half is new and the other old

### Requirement: The Kafka REST Proxy screen

#### Scenario: The screen is opened

- GIVEN the sidebar's Kafka group and a selected environment
- WHEN Kafka REST Proxy opens
- THEN it SHALL show the shared proxy in that environment — published, not set up, or its
  operation in progress — and, to an administrator, a form for its Kafka REST Proxy URL and cluster
  id whose button says what it will do: publish it, promote it here, or save
- AND anybody else SHALL see only the state, and the far end SHALL NOT be returned to them
- AND it SHALL list the selected application's own topics in that environment, each with whether
  it has an HTTP API, its schema type and certificate, and one next step: open the API, create it,
  promote it here, or the first reason there is none with a link to Kafka Topics
- AND it SHALL say that other applications' topic APIs are in the Catalog, and SHALL NOT offer
  creating a topic

#### Scenario: A topic's API is in the Catalog

- GIVEN a topic's API
- WHEN the Catalog lists it
- THEN it SHALL be listed and subscribed to like any API, with a "Kafka topic" chip naming the
  topic it produces to
- AND the shared proxy SHALL NOT be listed to anybody but an administrator, because it is unlisted
  and nobody else owns it
