# api-policy-controls Specification

## Purpose

Define policy as a closed, declarative JSON vocabulary in two tiers — the environment's global
tier and the resource's own — and the form that edits it. See *Policy Vocabulary* in
`openspec/project.md`.

## Requirements

### Requirement: Invalidate a copy preview when its source changes

#### Scenario: A different source environment is selected

- GIVEN a global-policy copy preview
- WHEN the source changes
- THEN the preview SHALL be cleared and applying SHALL require a new preview
- AND the source control SHALL be disabled while previewing or applying

#### Scenario: Policy data cannot be read

- GIVEN a loading or failed global-policy or downgrade read
- WHEN its page renders
- THEN it SHALL NOT claim there are zero policies or that no route is downgraded

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

- GIVEN a unit naming an `issuerRef`, `credentialRef`, `tokenProviderRef` or `schemeRef`
- WHEN it is validated
- THEN a reference that resolves to something carrying a URL — `issuerRef`, `tokenProviderRef` —
  SHALL resolve through the administrator-registered integrations file, and a dangling one SHALL be
  a boot failure naming both the reference and where it is used
- AND a reference that is only a secret — `credentialRef`, `schemeRef` — SHALL resolve through that
  file **or** through the owning application's own credentials, per `app-credentials`
- AND no unit SHALL let an owner name a URL the gateway will call

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

### Requirement: Only an administrator may override a global unit, and nobody may remove one

Attaching a unit to the environment is a decision about the environment, undone in the one place it
was made. Two different rules meet on one API's workspace, and they are not the same rule.

**Removing** a globally attached unit from one API is refused for everybody, an administrator
included: the unit is not stored on that API, so removing it stores nothing and the environment's
value merges back in at the next read.

**Overriding** one — giving it a different value here, or switching it off here — is refused for
everybody except an administrator. Whoever may do it may exempt their own API from an
environment-wide `auth.jwt`, `ipAllow` or `rateLimit`, which is the whole reason one was attached;
the tier and every per-API departure from it therefore belong to the same person. The owning
application keeps every unit the environment does not define, which is almost all of them.

Both have to be enforced on the server rather than assumed, because the workspace edits the
**effective** document: an inherited unit is on the page looking exactly like one the owner wrote,
and the raw-document editor beside the cards has no locks at all.

#### Scenario: A save omits a unit the environment defines

- GIVEN an API workspace whose loaded document carries a globally attached unit
- WHEN a save omits that unit
- THEN the save SHALL be refused, naming the unit and saying that its value is the environment's
- AND the refusal SHALL apply to an administrator as well, because the tier is not a per-API
  setting that an administrator happens to be allowed to change
- AND the reason SHALL be that the alternative is silent: nothing is stored, so the environment's
  value merges straight back in at the next read and the edit appears to have worked

#### Scenario: A save carries a unit at the environment's own value

- GIVEN a save whose document contains a globally attached unit with exactly the environment's
  value — which is what the editor sends whenever it loaded the effective document
- WHEN the configuration is applied
- THEN that unit SHALL NOT be stored as one of the resource's own
- AND the reason SHALL be that storing it freezes this API's copy at today's value and detaches it
  from the tier, so a later change on the global screen reaches every API except the ones somebody
  has saved

#### Scenario: A member of the owning application gives a global unit its own value

- GIVEN a caller who is not an administrator
- WHEN their write would give a globally attached unit a value other than the environment's — a
  unit write, a `configure`, a `publish`, a `promote` or a `copy-from` that lands one here
- THEN it SHALL be refused with `403`, naming the unit, naming the environment, and saying that an
  administrator can grant the exception and that the Global policy screen changes it for every API
- AND the environment's value SHALL still be what reaches the gateway afterwards, because the
  refusal is a refusal rather than an edit that is quietly dropped

#### Scenario: An administrator gives a global unit its own value

- GIVEN an administrator
- WHEN their save gives a globally attached unit a value of its own
- THEN it SHALL be stored as the resource's unit and SHALL win over the environment's, now and
  after the environment's value changes again

#### Scenario: A member switches a globally attached unit off

- GIVEN a caller who is not an administrator
- WHEN their write would add a globally attached unit to the document's reserved `disabled` list
- THEN it SHALL be refused with `403` and the unit SHALL keep reaching the gateway
- AND the reason SHALL be that `disabled` is subtracted from the **merged** document, so naming an
  inherited unit there takes the environment's decision off one API without touching the tier —
  the same act as overriding it, said in a way that used to pass unread

#### Scenario: A member undoes an exception an administrator granted

- GIVEN a resource carrying an administrator's override of a globally attached unit
- WHEN a caller who is not an administrator detaches it, changes its value, or switches it back on
- THEN it SHALL be refused with `403`
- AND the reason SHALL be that an exception is the administrator's to revise, and a caller who
  could revise one could first widen it

#### Scenario: A save leaves every globally attached unit where it is

- GIVEN a resource carrying an administrator's override, and a caller who is not an administrator
- WHEN they save a change to any other part of the document
- THEN it SHALL be applied
- AND the reason SHALL be that the rule is about what a save **moves**, not about what the document
  contains: the editor sends the whole effective document back on every save, so an owner locked
  out whenever any exception existed would be locked out of their own API

#### Scenario: The editor draws an inherited unit

- GIVEN a policy editor showing a unit the environment defines
- WHEN the card renders
- THEN it SHALL be marked as the environment's
- AND for an administrator its fields SHALL stay editable and switching it off SHALL be available,
  because that is the exception only they may grant
- AND for everybody else its fields SHALL be read-only and switching it off SHALL be disabled, each
  saying that only a platform administrator can override it and that the value is readable here
- AND remove SHALL be disabled for both, because nobody may take a global unit off one API
- AND the workspace read SHALL name which units are the environment's, because the document alone
  cannot say

#### Scenario: The raw document editor is open beside the cards

- GIVEN the advanced JSON editor, which is the same document with the card-level locks off
- WHEN a caller who is not an administrator opens it on an API with inherited units
- THEN it SHALL say before they type that changing those units, or naming them in `disabled`, is
  refused on save and who can do it
- AND the editor SHALL NOT be treated as the enforcement point, because the control plane refuses
  the write whatever produced it

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
- AND a `disabled` list naming a unit the environment defines SHALL be an override of the global
  tier and SHALL be admin-only, because the list is subtracted from the merged document

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

### Requirement: The gateway's base path is the gateway's, and comes off before the backend is called

The route base path is the address this platform publishes an API at. The backend has its own base,
which is what `binding` holds. Concatenating both would send a backend a path built from the
gateway's naming convention — a domain, a sub-domain, an API name and a version segment — that it
has never served.

#### Scenario: An API carries no `rewrite` unit

- GIVEN a route with base path `/business-support/events/orders/v1` bound to `https://example/v2`
- WHEN `GET /business-support/events/orders/v1/pets` arrives and the policy has no `rewrite` unit
- THEN the backend SHALL be called at `https://example/v2/pets`
- AND the reason SHALL be that an API published without touching policy at all is the common case,
  and it SHALL work

#### Scenario: The base path is deliberately kept

- GIVEN the same route with `rewrite.stripBasePath` set to `false`
- WHEN the same request arrives
- THEN the backend SHALL be called at `https://example/v2/business-support/events/orders/v1/pets`
- AND this SHALL be the only way to get that, because it is useful only when the backend is mounted
  at the very path the gateway publishes

#### Scenario: A path template is rendered

- GIVEN `rewrite.path` set to a template over the matched operation's parameters
- WHEN the request matches that operation
- THEN the rendered path SHALL replace the relative path, and SHALL be appended to the base path
  only when `stripBasePath` is `false`

### Requirement: Edit policy as units, not as a document

#### Scenario: Global policy values are inspected

- GIVEN an attached global unit whose editor is closed
- WHEN the global policy page renders
- THEN its current configuration SHALL be available in a disclosure, keeping the list of units scannable
- AND opening the editor SHALL show a labelled configuration field
- AND the draft SHALL be checked as it is typed — that it parses, and that it has the shape of the
  unit's default — with the reason shown under the field and Save disabled until it passes, so a
  write that would be refused is not sent; everything past that stays the control plane's to refuse
- AND an unsaved draft SHALL be guarded against navigating away, as the per-API editor is
- AND the field SHALL be one unit's JSON rather than the structured form the API workspace draws,
  because that form edits a whole document with add, remove and switch-off controls the global tier
  does not have
- AND a reader who may not change the tier SHALL see the editor controls disabled, with one sentence
  at the top of the page saying so, rather than hidden

#### Scenario: A global unit is detached

- GIVEN an attached global unit
- WHEN an administrator detaches it
- THEN a dialog SHALL ask first, naming the unit and the environment, how many APIs stop receiving
  it, that the ones overriding it keep their own value, and that its configuration is discarded
- AND it SHALL NOT be a typed confirmation, because attaching again undoes it

#### Scenario: The global policy screen chooses its environment

- GIVEN the environment-scoped Global policy route
- WHEN it renders
- THEN it SHALL show the shell's selected environment and SHALL NOT draw an environment picker of
  its own

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
- THEN the available units SHALL be grouped in gateway pipeline order — inbound, upstream,
  outbound — and each SHALL carry a description and a category icon
- AND each available row SHALL be a keyboard-accessible button that adds the unit to the local draft and opens its editor
- AND unavailable choices SHALL retain a visible explanation
- AND a unit already present SHALL remain in the attached list rather than be offered twice

#### Scenario: Header rules are edited

- GIVEN `headers.request` or `headers.response`
- WHEN its form opens
- THEN it SHALL offer a list of rules, each naming its action in the reader's words — remove,
  overwrite, append, set if missing — rather than exposing the document's four maps
- AND every one of the four actions SHALL be reachable from the form, so no part of the unit is
  editable only through the raw document
- AND a rule whose action takes no value SHALL NOT present an empty value control
- AND the order the gateway applies them in SHALL be stated once for the unit rather than implied
  by the order the rows were added
- AND the collapsed row's summary SHALL count every action present, not only two of them

#### Scenario: A unit is detached

- GIVEN an attached resource-level unit
- WHEN it is detached
- THEN the effective value SHALL fall back to the environment's global tier where one exists
- AND detaching SHALL not go through a typed confirmation, because the same click re-attaches it
- AND where the unit it falls back to is one the environment defines, detaching SHALL be
  administrator-only, because that unit is an exception rather than a value of the API's own

#### Scenario: Policy is copied from another environment

- GIVEN a resource live in two environments
- WHEN `copy-from` is used
- THEN the difference SHALL be shown before it is applied, unit by unit
- AND the global tier SHALL never be promoted automatically, so copying it between environments is
  an explicit, diffed act
- AND a copied unit that would depart from what the **target** environment defines globally SHALL
  be subject to the same administrator-only rule, because the two environments' tiers differ and a
  unit inherited in the source arrives here as an override

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
- AND on the Global policy screen each mode SHALL be a status chip in words — Blocking, Warning only,
  Off — with who changed it and when, and the report SHALL be the selected environment's alone
- AND the fleet's validation counters SHALL be read on Telemetry (`dashboard-health`), not here

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
- AND the explanation of *why* some units may not be attached SHALL be a collapsed aside, with the
  count computed from the vocabulary and the allowlist rather than written into the sentence, so it
  cannot go stale when either changes

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
