# api-policy-controls Specification

## Purpose

Define policy as a closed, declarative JSON vocabulary in two tiers — the environment's global
tier and the resource's own — and the form that edits it. See *Policy Vocabulary* in
`openspec/project.md`.

## Requirements

### Requirement: Policy is a closed vocabulary, not a language

#### Scenario: A policy document is written

- GIVEN any policy write, on either tier
- WHEN it is validated
- THEN every key SHALL be one of the twenty-three declared unit keys, or an
  `operations["<id>"].<unit>` key
- AND an unknown unit key or an unknown field within a unit SHALL be **rejected**, so nothing
  passes through unread
- AND there SHALL be no expressions, no XML, no request-sending unit, and no URL an owner writes
  that is ever fetched

#### Scenario: A reference is named

- GIVEN a unit naming an `issuerRef`, `credentialRef` or `tokenProviderRef`
- WHEN it is validated
- THEN the reference SHALL resolve through the administrator-registered integrations file
- AND a dangling reference SHALL be a boot failure, naming both the reference and where it is used

#### Scenario: A unit is edited

- GIVEN any unit
- WHEN it is changed
- THEN the whole unit SHALL move as one piece
- AND half a unit SHALL never be merged, because half a `rateLimit` is not a `rateLimit` anyone
  wrote

### Requirement: Merge two tiers by whole unit, with the resource winning

#### Scenario: The effective document is computed

- GIVEN an environment's global units and a resource's own units
- WHEN the effective document is computed
- THEN a unit the resource carries SHALL be the resource's value, and any other globally attachable
  unit SHALL be the environment's
- AND this SHALL be computed by **one function**, so a resource write, a global write, a release
  plan and the configuration build cannot disagree about what an API's policy actually is
- AND the global tier SHALL be the weaker side of every conflict

#### Scenario: A unit is not globally attachable

- GIVEN a global entry for `rewrite`, `transform`, `backendAuth`, `cache`, `passthrough` or
  `errorFormat`
- WHEN the effective document is computed
- THEN it SHALL be excluded
- AND attaching one globally SHALL be refused, because they are per-API by nature: `errorFormat` is
  derived from the variant, four of them describe one backend and one contract, and `passthrough`
  changes what a route *is*

#### Scenario: A per-operation unit is attached globally

- GIVEN a key of the form `operations["getPet"].rateLimit`
- WHEN a global attachment is attempted
- THEN it SHALL be refused, because an operation id means nothing outside the API that declares it

#### Scenario: A per-operation override is written

- GIVEN a per-operation key
- WHEN it is validated
- THEN its unit SHALL be one of `validate`, `rateLimit`, `quota`, `timeoutMs`, `cache`
- AND the named operation SHALL exist in the resource's current operation index

### Requirement: Turning a policy off is not deleting it

#### Scenario: A unit is switched off

- GIVEN a configured unit
- WHEN it is disabled
- THEN its key SHALL be added to the document's reserved `disabled` list, and its configuration
  SHALL be kept
- AND re-enabling it SHALL restore the same values
- AND the reason SHALL be that an operator suppressing a rate limit during an incident wants the
  numbers back afterwards, and deleting the unit is how they get lost

#### Scenario: A disabled unit reaches the gateway

- GIVEN a document with disabled units
- WHEN the configuration document is built
- THEN the reserved key and every unit it names SHALL be subtracted first
- AND no gateway SHALL have to know the concept exists

#### Scenario: A disabled unit is counted or rendered

- GIVEN a screen showing the number of active units, or a cross-check over a document
- WHEN it computes
- THEN it SHALL read the same subtracted document the gateway sees, so "off" cannot mean one thing
  on a screen and another at the gateway

### Requirement: Edit policy as units, not as a document

#### Scenario: The policy panel renders

- GIVEN a resource in an environment
- WHEN the policy panel opens
- THEN every effective unit SHALL be listed with **where it came from** — the resource, or the
  environment's global tier
- AND a globally inherited unit SHALL be shown as such, with the option to override it here
- AND each unit SHALL be edited through a structured form rather than a free-text document

#### Scenario: A unit is added

- GIVEN the add-unit picker
- WHEN it opens
- THEN the units SHALL be grouped by what they do — authentication, access, limits, transport,
  backend, response — and each SHALL carry a one-line description
- AND a unit already present SHALL be shown as such rather than offered twice

#### Scenario: A unit is detached

- GIVEN an attached resource-level unit
- WHEN it is detached
- THEN the effective value SHALL fall back to the environment's global tier where one exists
- AND detaching SHALL not go through a typed confirmation, because the same click re-attaches it

#### Scenario: Policy is copied from another environment

- GIVEN a resource live in two environments
- WHEN `copy-from` is used
- THEN the difference SHALL be shown before it is applied, unit by unit
- AND the global tier SHALL never be promoted automatically, so copying it between environments is
  an explicit, diffed act

### Requirement: Validate a policy document against the resource's kind

#### Scenario: A unit does not apply to the kind

- GIVEN an MCP or A2A resource
- WHEN a unit that only makes sense for a path-and-method API is attached
- THEN the write SHALL be refused, naming the unit and the kind

#### Scenario: A bound is exceeded

- GIVEN `timeoutMs` above `MAX_TIMEOUT_MS`, a pattern longer than `MAX_PATTERN_LENGTH`, or a
  pattern value above `PATTERN_VALUE_MAX_BYTES`
- WHEN it is validated
- THEN it SHALL be refused, naming the bound
- AND a per-route `validate` value above the environment's ceilings SHALL be clamped to them

### Requirement: Never serve a route whose policy does not validate

#### Scenario: An effective document is invalid at build time

- GIVEN a route whose merged document fails validation
- WHEN the configuration document is built
- THEN the route SHALL be omitted and an entry added to `errors[]` naming the resource and the
  reason
- AND the error SHALL be visible on the estate's screens rather than only in a log

### Requirement: Report the exceptions somebody has to decide about

#### Scenario: Validation is downgraded

- GIVEN a `validate` unit whose `request` mode is set and is not blocking
- WHEN the downgrades report is read
- THEN that resource and environment SHALL be listed with the mode, who set it, when, and any
  recorded reason
- AND the reason SHALL be stated plainly: a non-blocking mode observes and never rejects, so an
  invalid request reaches the backend
- AND the same fact SHALL appear as an attention row for the owning application

#### Scenario: The governance report is read

- GIVEN an administrator
- WHEN they open the governance exceptions report
- THEN every unexpired, unrevoked TLS exception SHALL be listed with its resource, environment,
  backend, mode, reason, who created it and when it expires, ordered by expiry
- AND the report SHALL be administrator-only

### Requirement: Attach policy to a whole environment, and say what it affects

#### Scenario: A global unit is written

- GIVEN an administrator attaching a unit to an environment
- WHEN it is saved
- THEN it SHALL be refused unless the unit is globally attachable
- AND the screen SHALL list every resource in that environment the change reaches, because a global
  write with an unnamed blast radius is a write nobody can review

#### Scenario: A resource overrides a global unit

- GIVEN a global unit and a resource that carries the same unit
- WHEN the global policy screen renders
- THEN the resources overriding each global unit SHALL be listed
- AND the reason SHALL be that a global policy whose overrides are invisible is a policy nobody can
  reason about

### Requirement: Do not lose an unsaved policy edit

#### Scenario: The reader navigates away mid-edit

- GIVEN unsaved policy changes
- WHEN the reader navigates away
- THEN they SHALL be warned first
- AND the warning SHALL NOT use `confirm()`

#### Scenario: The panel is open in the background

- GIVEN the policy panel open
- WHEN time passes
- THEN it SHALL NOT silently refresh underneath the editor, which would discard what is being typed
