# gateway-settings Specification

## Purpose

Define how the fleet's operational bounds — concurrency ceilings, the body cap, cache sizes, the
JWKS refetch floor, the telemetry bounds and the access-log switches — are decided **centrally** by
the control plane and applied by every gateway without a restart.

Until `configVersion` 6 each of these was an environment variable on each gateway container, which
made a fleet's configuration the union of N compose files: two gateways in one environment could
disagree about their own ceiling, drift was invisible until it produced a symptom, and "what is
prod actually running" had no answer short of reading every file. They are now resolved in the
control plane, travel in the configuration document, and are set on one screen.

See *The Configuration Document* and *Gateway Settings* in `openspec/project.md` for the key table,
and `data-plane-gateway` for what each bound does when it is reached.

## Requirements

### Requirement: A setting exists only if a running instance can apply it without restarting

The setting vocabulary SHALL be declared in one place, `shared/gateway-settings.ts`, and the
entry criterion for a key SHALL be that a live process can adopt a new value in place.

#### Scenario: A candidate value must be known before the first poll

- GIVEN a value the process needs in order to reach the control plane at all — its name, its port,
  its token, `GATEWAY_CP_URL`, `POLL_INTERVAL_SEC`, a cache path
- WHEN it is considered for the settings table
- THEN it SHALL remain an environment variable
- AND the reason SHALL be that a setting arriving over the poll cannot configure the poll that
  fetched it — `POLL_INTERVAL_SEC` most of all, because a mistake in it slows down its own
  correction

#### Scenario: A candidate value is a fact about one container rather than the fleet

- GIVEN `BUN_CONFIG_MAX_HTTP_REQUESTS`, `TRUSTED_PROXY_CIDRS`,
  `TRUSTED_PROXY_CLIENT_CERT_HEADERS`, `TRUST_SYSTEM_ROOTS`, `DP_ACCESS_LOG_PATH` or
  `DP_REUSE_PORT`
- WHEN it is considered for the settings table
- THEN it SHALL remain an environment variable
- AND for the trusted-proxy boundary the reason SHALL be that whether a header counts as an
  identity is a fact about the network in front of one container, and getting it wrong centrally
  would be an authorization bypass applied to a whole fleet at once

#### Scenario: A setting is declared

- GIVEN a key in the settings table
- WHEN it is declared
- THEN it SHALL carry the variable it replaced, a kind of `count`, `bytes`, `seconds` or `flag`, a
  default, its bounds, a label and a one-line purpose
- AND the label and the purpose SHALL be declared with the setting rather than on the screen that
  renders them, so there is no second list of settings to keep true
- AND the table SHALL be keyed by the settings block the document carries, so a key with no
  definition or a definition for a key the document does not carry SHALL NOT compile

### Requirement: Resolve three layers, most specific winning, per key

An override SHALL be stored sparsely at `fleet`, `environment` or `gateway` scope, and resolution
SHALL walk them in that order so the most specific layer that sets a key wins for that key alone.

#### Scenario: Nobody has set anything

- GIVEN no stored overrides
- WHEN a gateway's settings are resolved
- THEN every key SHALL take the build's default
- AND the resolved block SHALL contain **every** key, so the document never carries a partial block
  and the gateway never has a default of its own to fall back to

#### Scenario: Layers set different keys

- GIVEN the fleet sets the body cap and one gateway sets the concurrency ceiling
- WHEN that gateway's settings are resolved
- THEN it SHALL receive the fleet's body cap and its own concurrency ceiling
- AND inheritance SHALL be per key rather than per layer: setting one value at a layer SHALL NOT
  detach the others from the layers above it

#### Scenario: Layers set the same key

- GIVEN the fleet, the environment and the gateway all set the body cap
- WHEN it is resolved
- THEN the gateway's value SHALL win, then the environment's, then the fleet's

#### Scenario: An override belongs to a sibling

- GIVEN an override at `environment` scope on `test`, or at `gateway` scope on another gateway
- WHEN a gateway in `dev` resolves its settings
- THEN neither SHALL apply

#### Scenario: A gateway is renamed or deleted

- GIVEN an override at `gateway` scope
- WHEN the gateway is renamed
- THEN the override SHALL follow it, because the scope is keyed by the gateway's id rather than its
  name
- AND WHEN the gateway is deleted THEN its overrides SHALL be deleted with it

### Requirement: Refuse an out-of-range value on write, and clamp one on read

A bound SHALL be enforced twice, and the two SHALL behave differently on purpose.

#### Scenario: An administrator types a value outside the bounds

- GIVEN a value below a setting's minimum or above its maximum
- WHEN it is written
- THEN it SHALL be refused with `<key> (<VARIABLE>): expected <min>–<max>, got <value>`
- AND it SHALL NOT be clamped, because somebody who typed a number has made a decision about
  capacity and quietly serving them a different one is how a gateway ends up not doing what its own
  screen says it does

#### Scenario: A stored row is out of range or the wrong shape

- GIVEN a row written by an older build whose bounds were wider, or a value of the wrong type
- WHEN settings are resolved for a document
- THEN an out-of-range number SHALL be pulled into range and a wrong-shaped value SHALL fall back
  to the default
- AND resolution SHALL NOT fail, because by the time a row is being read the useful behaviour is a
  working fleet — a stored row must not be able to strand one

#### Scenario: A name that is not a setting is written

- GIVEN a key the table does not define
- WHEN it is written
- THEN the write SHALL be refused, naming the key and listing the settings that exist

#### Scenario: A scope id names nothing

- GIVEN a `fleet` scope with a scope id, an `environment` scope naming an environment outside
  `PROMOTION_CHAIN`, or a `gateway` scope naming no gateway
- WHEN it is written
- THEN the write SHALL be refused
- AND the reason SHALL be that an override on a misspelled environment is a setting an
  administrator can see on a screen and no gateway will ever read, which is worse than an error

### Requirement: Apply one screen's worth of changes as a set, or none of them

A write SHALL be atomic across every key it carries.

#### Scenario: One value in a set is invalid

- GIVEN a write carrying several settings, one of them out of range
- WHEN it is applied
- THEN none of them SHALL be stored
- AND the reason SHALL be that capacity settings are chosen against each other — a buffer budget
  makes sense for a concurrency ceiling — and half of a considered pair applied is a fleet nobody
  configured

#### Scenario: A value is cleared

- GIVEN a setting explicitly set at a layer
- WHEN it is written as `null`
- THEN the override SHALL be deleted and the layer below inherited again

#### Scenario: A write is recorded

- GIVEN any accepted write
- WHEN it completes
- THEN exactly one audit entry SHALL be written, naming the scope, what was set and what was
  cleared, rather than one entry per key, so the trail reads the way the change was made
- AND any setting marked sensitive SHALL be named in the entry as such, so an auditor can find it
  without knowing the settings table

### Requirement: Ship resolved values, never a precedence rule

The configuration document SHALL carry a complete, already-resolved settings block, and the layers
it was resolved from SHALL NOT travel with it.

#### Scenario: A gateway receives a document

- GIVEN a document built for one gateway in one environment
- WHEN it is served
- THEN it SHALL carry `settings` with every key resolved for that gateway
- AND it SHALL NOT carry the overrides, the scopes, or anything the instance would have to combine
- AND the reason SHALL be that a gateway handed a precedence rule to apply is a gateway deciding
  something, which is exactly what the data plane does not do

#### Scenario: Two gateways in one environment differ

- GIVEN two gateways in the same environment with different `gateway`-scope overrides
- WHEN each polls
- THEN each SHALL receive its own resolved block and therefore its own document digest
- AND anything that reports a digest for an environment as a whole SHALL be built per gateway
  instead, because there is no longer one document per environment

#### Scenario: A settings change is made

- GIVEN an accepted write
- WHEN the next poll from an affected replica arrives
- THEN the document's digest SHALL differ, because the digest covers the whole body
- AND convergence SHALL be tracked by that digest through the existing fleet view, and a settings
  change SHALL NOT create an operation or a job of its own

### Requirement: Apply a new settings block to the live process

An instance SHALL adopt a resolved block at activation without restarting and without disturbing
what is in flight.

#### Scenario: A document with changed settings is activated

- GIVEN an instance serving traffic
- WHEN it activates a document whose settings differ
- THEN the concurrency gate, the stream registry, the response cache, the validation pool and
  queue, the blocking-validation budget, the artifact cache, the telemetry bounds and the JWKS
  refetch floor SHALL all take the new values
- AND no request in flight SHALL be disturbed

#### Scenario: A ceiling is lowered below what is currently in use

- GIVEN a cache holding more than a newly lowered bound, or a gate above a newly lowered ceiling
- WHEN the settings are applied
- THEN entries SHALL be evicted and further requests shed until the instance is under the bound
- AND this SHALL NOT be an error, because it is the same behaviour as arriving at that ceiling
  under load

#### Scenario: The access log is switched

- GIVEN a change to the access-log setting
- WHEN it is applied
- THEN the writer SHALL be opened or closed, so the file handle and the flush timer follow the
  switch
- AND the transition SHALL be logged whichever way it went, because a gateway that stopped
  recording what it served should say so once in the log that is about to end

#### Scenario: An instance reports what it is enforcing

- GIVEN any instance
- WHEN its own `GET /healthz` is read
- THEN it SHALL report the settings actually in force on it, as distinct from the digest it has
  activated
- AND the reason SHALL be that the two disagree exactly when an instance has refused a document,
  which is the moment the difference matters
- AND the poll SHALL carry the refusal rather than the block, because the control plane already
  knows what it resolved for that gateway and only needs to be told it was not taken

### Requirement: Refuse a settings block this container cannot honour, without dying

A central setting can name a number one container's runtime will not honour. That SHALL block
activation rather than be applied, and SHALL be correctable centrally.

#### Scenario: The concurrency ceiling exceeds the runtime's outbound queue

- GIVEN a document whose `maxConcurrentRequests` is above this container's
  `BUN_CONFIG_MAX_HTTP_REQUESTS`
- WHEN it is received
- THEN the document SHALL NOT be activated, whatever is already serving SHALL keep serving, and the
  reason SHALL be reported as `activationBlocked` on the next poll
- AND the reason SHALL name both numbers and say that the runtime's shared outbound queue would be
  reached before the gateway's own ceiling, so a slow backend would be queued rather than shed
- AND it SHALL be checked before any artifact is fetched, because downloading artifacts for a
  document that is not going to serve is work done for nothing

#### Scenario: The refusal is corrected

- GIVEN an instance blocked this way, including one that has never activated anything
- WHEN the setting is lowered centrally
- THEN the next poll SHALL activate normally
- AND the instance SHALL NOT exit, because unlike a missing trust boundary this resolves itself
  from the control plane — an instance with nothing to serve waits rather than fails

#### Scenario: The same pairing is checked at boot

- GIVEN a starting settings block at startup
- WHEN `BUN_CONFIG_MAX_HTTP_REQUESTS` is unset, malformed, or below `maxConcurrentRequests`
- THEN startup SHALL fail naming the variable, the setting and the pairing

### Requirement: Carry settings through a control-plane outage

The cached configuration SHALL preserve settings, and a settings problem SHALL NOT cost the
fail-static guarantee.

#### Scenario: An instance restarts while the control plane is unreachable

- GIVEN a cached document carrying settings
- WHEN the instance restarts and loads it
- THEN those settings SHALL be applied along with the routes
- AND the reason SHALL be that reverting to the build's defaults would mean, for an estate that had
  raised its body cap, `413`s on requests that worked before the restart

#### Scenario: The cached settings cannot be honoured here

- GIVEN a cached document whose settings this container cannot honour
- WHEN it is loaded
- THEN the cached routes SHALL still be served, on the defaults, and the reason SHALL be recorded
- AND the reason SHALL be that fail-static exists to keep traffic flowing without the control
  plane, and refusing to serve anything because one ceiling is unreachable here would trade the
  outage this survives for one it does not

### Requirement: Refuse to start when a retired variable is still set

A variable that moved into the settings table SHALL be a startup failure on a gateway, not a
warning and not a value that is read.

#### Scenario: A container still sets a moved variable

- GIVEN any of the variables the settings table replaced is set and non-empty
- WHEN the gateway starts
- THEN it SHALL refuse to start, naming every one of them and the setting that replaced it
- AND the message SHALL say to set them on the portal's gateway settings — fleet-wide, per
  environment, or on that gateway alone — and remove them from the container
- AND the value SHALL NOT be read, because honouring it would keep a fleet's configuration in N
  places and ignoring it would quietly *lower* an estate whose compose file set a limit above the
  code default

### Requirement: Set the fleet's settings on one screen

The portal SHALL offer an administrator one place to read and change every setting, at every layer.

#### Scenario: The settings table is laid out

- GIVEN the selected layer's settings
- WHEN the table renders
- THEN it SHALL distinguish the setting, its effective value and the override at this layer in three stable columns
- AND Save changes SHALL be the primary action for the pending set
- AND on narrow screens the table SHALL scroll within its panel without widening the page

#### Scenario: The Gateway settings screen renders

- GIVEN any signed-in user
- WHEN Gateway settings renders
- THEN each setting SHALL be shown with its label, its one-line purpose, the variable it replaced,
  the value in force for the selected layer, and the layer that value came from
- AND a member SHALL be able to read all of it, with the change refused by the control plane, as
  every administration screen behaves

#### Scenario: A layer is chosen

- GIVEN the fleet, each environment and each gateway
- WHEN one is selected
- THEN that layer's own overrides SHALL be editable, an empty field SHALL mean "inherit", and one
  line SHALL say which gateways the layer reaches
- AND changing the selected layer SHALL discard unsaved edits rather than carry them onto a
  different set of gateways

#### Scenario: A sensitive setting is changed

- GIVEN a setting marked sensitive — the access log
- WHEN it is switched off
- THEN it SHALL require the layer's name typed back, and the confirmation SHALL state what stops
  being recorded and for which gateways
- AND switching it back on SHALL be a plain button, because that is the safe direction

#### Scenario: A change is saved

- GIVEN saved settings
- WHEN the screen reports the outcome
- THEN it SHALL say that the values reach each replica on its next poll without a restart, and that
  a replica which cannot honour one refuses the whole document and says so on Health Status
- AND the screen SHALL NOT report convergence itself, because Health Status already answers that
  per replica by digest and a second, weaker copy of that answer is the two-places-to-look problem
  this capability exists to end
