# control-plane-surface Specification

## Purpose

Define the control plane as the thing that **owns every decision**: the router in front of it, the
durable operations behind it, the reconciler that turns intent into a configuration document, and
the audit, job and retention machinery that keeps all of it accountable. The document it produces
is specified in `data-plane-gateway`; this spec is about how it gets built and who is allowed to
ask for it.

## Requirements

### Requirement: Route with a fixed dispatch order and no middleware chain

There SHALL be one router, and authentication, the CSRF origin check and error shaping SHALL
happen once, in one function, in a fixed order.

#### Scenario: A request is dispatched

- GIVEN any HTTP request
- WHEN it is handled
- THEN the route SHALL be matched by exact segment count with `:name` capture, a `requestId` SHALL
  be minted, and the route's declared authentication mode SHALL be applied
- AND a middleware ordering hazard SHALL NOT exist, because there is no middleware chain

#### Scenario: A route declares its authentication mode

- GIVEN a registered route
- WHEN it is added
- THEN it SHALL declare exactly one of `public`, `session` or `instance`
- AND `session` routes SHALL additionally pass the origin check on mutating methods and the
  forced-password-change gate

### Requirement: Every business change is a durable operation

Publishing, configuring, promoting and subscribing SHALL be recorded as `operation` rows and
carried out by a runner, not inside the request.

#### Scenario: A command is accepted

- GIVEN a valid publish, configure or promote request
- WHEN it is accepted
- THEN an `operation` row SHALL be inserted with `state = "queued"`, its application, actor, kind,
  resource, environment and an input snapshot
- AND the response SHALL be `202` carrying `{ id, applicationId, resourceId, environment, kind,
  state }`
- AND one audit row SHALL be written naming the action, the resource and the operation id

#### Scenario: An operation moves through its states

- GIVEN a queued operation
- WHEN the runner processes it
- THEN it SHALL move `queued → applying → waiting-for-gateways → complete`
- AND `waiting-for-gateways` SHALL end only when the environment's fleet has acknowledged the
  current configuration
- AND on completion an `operation.complete` notification SHALL be emitted naming the kind and the
  environment

#### Scenario: A replica is counted towards the fleet's acknowledgement

- GIVEN an environment whose registered replicas have not all acknowledged the current document
- WHEN convergence is evaluated
- THEN a replica that has **never** been seen SHALL count, and hold the operation pending — it is
  freshly minted and expected, and dropping it would complete a publish before the gateway it was
  published to had ever read it
- AND a replica seen within `INSTANCE_ABANDONED_AFTER_SEC` SHALL count, and hold the operation
  pending even while it reads as offline by `INSTANCE_STALE_AFTER_SEC` — reporting complete for a
  gateway nobody has heard from would tell a consumer an API is live that one gateway answers `404`
  for, and a rolling restart passes through this window
- AND a replica silent for longer than `INSTANCE_ABANDONED_AFTER_SEC` SHALL NOT count — it is gone
  rather than restarting, it is serving nobody, and it will fetch the current document if it ever
  returns
- AND a replica whose gateway has since been deleted SHALL NOT count, there being no document this
  environment still builds for it
- AND an environment with no counting replica at all SHALL NOT be treated as converged, because
  that is an environment nobody is serving rather than one that agrees
- AND the reason SHALL be that `waiting-for-gateways`, a subscription's `activating` and a
  withdrawn subscription's `revoking` all end here and none of them has a timeout: a container
  replaced during a redeploy left a row with `revoked_at IS NULL` whose `last_seen_at` never
  advanced, and every one of those three states then waited on it until an administrator revoked
  the dead token by hand

#### Scenario: A command is repeated

- GIVEN a command carrying an `Idempotency-Key`
- WHEN the same key is presented again with the **same** request digest
- THEN the original operation SHALL be returned with `202`, and nothing new SHALL be queued
- AND WHEN the same key is presented with a **different** request digest
- THEN it SHALL be refused with `409` saying the key was already used for a different command

#### Scenario: A command omits the idempotency key

- GIVEN a publish, configure, promote or subscribe request with no `Idempotency-Key` header, or one
  longer than 160 characters
- WHEN it is dispatched
- THEN it SHALL be refused with `400` naming the header and the limit

#### Scenario: Two operations queue for the same resource in the same environment

- GIVEN an earlier operation for the same resource and environment that is neither `complete` nor
  `superseded`
- WHEN the runner reaches the later one
- THEN the later one SHALL wait
- AND ordering SHALL be by insertion, so a promotion cannot overtake the publish it depends on

#### Scenario: A promotion waits for its source

- GIVEN an operation whose snapshot names a `sourceOperationId`
- WHEN the runner reaches it
- THEN it SHALL proceed only once that source operation is `complete`
- AND GIVEN a snapshot that names only a `sourceEnvironment`, it SHALL proceed only once that
  environment's fleet has applied its current configuration

#### Scenario: The environment cannot take the change

- GIVEN a chosen gateway does not exist in the target environment
- WHEN the runner resolves the snapshot's gateway names
- THEN the operation SHALL fail naming the environment and every missing gateway
- AND GIVEN the environment has no gateway at all, or **any** chosen gateway is paused
- THEN the operation SHALL be held with "deployment will resume automatically"
- AND the reason SHALL be that deploying to the half that is running would leave the API answering
  in one locality and not the other, which is the one state "published on both" must never quietly
  mean

#### Scenario: Gateways are resolved by name, late

- GIVEN a snapshot carrying gateway **names** rather than target ids
- WHEN the runner acts
- THEN the names SHALL be resolved against the environment at execution time, not at request time
- AND the reason SHALL be that a snapshot travels along the promotion chain, "published on
  `managed` and `onprem`" has to still mean something in the next environment, and a gateway could
  have been removed while the operation sat in the queue
- AND an absent gateway list SHALL mean every gateway the environment has today

### Requirement: Report whether the fleet has applied the current configuration

#### Scenario: An environment's convergence is evaluated

- GIVEN an environment with gateways and unrevoked instances
- WHEN convergence is computed
- THEN it SHALL be true only when the built configuration has no errors, at least one instance
  exists, and **every** unrevoked instance reports the digest of **its own gateway's** document and
  was last seen within 120 seconds
- AND each instance SHALL be compared against its own gateway's document rather than the union,
  because two gateways in one environment serve different subsets and comparing both to the union
  would say "behind" forever

### Requirement: Run background work as durable jobs with a lease

Long-running work SHALL happen in a job table, retried with backoff, never inside a request.

#### Scenario: A job is enqueued with a key

- GIVEN a job enqueued with an idempotency key that already exists
- WHEN it is enqueued
- THEN the existing job's id SHALL be returned and no second row created

#### Scenario: Two runners reach the same target

- GIVEN a reconcile job for a target
- WHEN a runner takes it
- THEN it SHALL acquire a 30-second lease on that target inside a transaction
- AND a runner that finds a live lease held by somebody else SHALL fail rather than proceed
- AND the lease SHALL be released in a `finally`, whatever the outcome

#### Scenario: A job fails repeatedly

- GIVEN a job that throws
- WHEN it has been attempted `MAX_ATTEMPTS` (3) times
- THEN it SHALL stop being retried and its failure SHALL be readable at `GET /api/jobs/:id`

#### Scenario: Work is kicked and swept

- GIVEN a release
- WHEN it is created
- THEN the runner SHALL be kicked immediately, and a short interval sweep SHALL also run
- AND the design SHALL be event-driven first, sweep second

### Requirement: Build one complete configuration document per environment

The document SHALL be derived from the database, never assembled incrementally on the wire.

#### Scenario: A document is built

- GIVEN an environment
- WHEN its configuration is built
- THEN the result SHALL carry the document's fields at the top level, plus `digest` and
  `generatedAt`
- AND the digest SHALL be a canonical hash, so an unchanged estate produces an unchanged digest
- AND when an environment holds several gateways, a per-gateway document SHALL be built, because
  each gateway serves a different subset

#### Scenario: A route's effective policy is invalid

- GIVEN a route whose merged global-plus-local policy document does not validate
- WHEN the document is built
- THEN that route SHALL be **omitted** and an entry added to `errors[]` naming the resource and the
  reason
- AND the reason SHALL be that an API that does not answer is visible, and an API answering under a
  document nobody validated is not

#### Scenario: A route names a reference nothing answers to

- GIVEN a route whose policy names a `credentialRef`, `schemeRef`, `issuerRef` or `tokenProviderRef`
  that resolves to neither an application's own credential nor an entry in `INTEGRATIONS_FILE`
- WHEN the document is built
- THEN the reference SHALL be left out of `references`, because the gateway refusing a reference it
  cannot resolve is the correct behaviour
- AND an entry SHALL be added to `errors[]` naming the resource, the reference and the environment
- AND the route SHALL still be served, unlike the invalid-document case above, because the data
  plane's own 503 already names the reference to the caller
- AND the reason SHALL be the same one: a route answering 503 to every request because a credential
  is absent is not visible, and the case this exists for is a promotion — credentials are per
  environment and a promotion carries policy but not secrets, so a `backendAuth` that works in one
  stage arrives in the next naming a credential nobody has created there
- AND a reference SHALL resolve by its own shape with no fallback between the two sources, so an
  `app:<application>:<name>` that resolves to nothing SHALL be reported rather than falling through
  to an administrator's entry of the same name

#### Scenario: A disabled policy unit is carried

- GIVEN a document whose reserved `disabled` key names units it also carries
- WHEN the configuration is built
- THEN those units SHALL be subtracted before the document is rendered
- AND no gateway SHALL have to know the concept exists

#### Scenario: Secrets are projected, not copied

- GIVEN subscriptions and registered references
- WHEN the document is built
- THEN subscription keys SHALL travel as sha256 hashes only
- AND a shared secret the gateway only has to **check** SHALL travel as a hash
- AND only a secret the gateway must **present** to a backend SHALL travel in plaintext
- AND only the references this environment's routes actually use SHALL be included, so the blast
  radius of the document is the estate that is actually configured

### Requirement: Compile validators onto a separate channel

#### Scenario: A definition is imported

- GIVEN a definition with schemas
- WHEN it is normalized
- THEN a compiled validator bundle SHALL be produced, stored as an `artifact`, and referenced from
  the route rather than embedded in the document
- AND the reason SHALL be that schemas reach megabytes and the document is polled every two seconds

#### Scenario: One operation's schema cannot be compiled

- GIVEN a document whose operations share one compiler, and an operation whose schema the compiler
  refuses
- WHEN the remaining operations are compiled
- THEN that operation SHALL be marked `unsupported-schema` with the reason, and the import SHALL
  still succeed, because one unsupported keyword must not block the whole API
- AND every **other** operation reaching the same refused schema SHALL be refused in the same way
- AND the compiler SHALL leave nothing behind under that schema's name, because the placeholder it
  uses to terminate a self-referencing schema accepts anything: memoising it before the schema was
  known to compile reported the second operation as validated while it checked nothing, which is
  worse than the honest downgrade the first one got

#### Scenario: An instance has not fetched an artifact

- GIVEN a configuration whose routes reference artifacts an instance does not hold
- WHEN the instance receives it
- THEN it SHALL fetch them from `GET /api/gateway/artifacts/:digest` before activating
- AND it SHALL NOT activate a configuration whose artifacts are missing, reporting
  `activationBlocked` instead

### Requirement: Retain telemetry, jobs, revisions and playground history under stated bounds

#### Scenario: Old rows are pruned

- GIVEN the retention job runs
- WHEN it prunes
- THEN telemetry older than `TELEMETRY_RETENTION_HOURS` and jobs older than `JOB_RETENTION_HOURS`
  SHALL be removed
- AND playground history SHALL be bounded per resource by `PLAYGROUND_HISTORY_PER_RESOURCE` and by
  `PLAYGROUND_HISTORY_RETENTION_DAYS`

#### Scenario: Revisions are pruned

- GIVEN a resource with more revisions than `REVISION_KEEP_COUNT`
- WHEN retention runs
- THEN the newest `REVISION_KEEP_COUNT` SHALL be kept, and anything older than
  `REVISION_KEEP_DAYS` SHALL be eligible
- AND retention SHALL keep the **tighter** of the two bounds
- AND a revision that is currently released anywhere, that is a rollback target, or that a pending
  operation references SHALL never be pruned

### Requirement: Never store what can be derived, and never store per-request logs

#### Scenario: A request log is asked for

- GIVEN a caller opens the Logs tab
- WHEN the control plane serves it
- THEN the lines SHALL come from the configured log provider
- AND the control plane SHALL NOT hold a per-request log table of its own

### Requirement: Expose operations and audit as first-class reading

#### Scenario: A user watches what they started

- GIVEN a user who queued an operation
- WHEN they open Activity, or call `GET /api/operations`
- THEN they SHALL see its kind, resource, environment, state, attempts, error and result
- AND `GET /api/operations/:id` SHALL return the same shape for one operation

#### Scenario: An administrator reads the audit log

- GIVEN an administrator
- WHEN they call `GET /api/audit`
- THEN they SHALL see who changed what, when, and what happened as a result
- AND the log SHALL be readable by administrators only
