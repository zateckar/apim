# api-versioning-and-stage Specification

## Purpose

Define versions, revisions, releases and promotion along the chain. Two tiers: **the contract is
promoted, everything else is edited in place**. The data plane never learns that environments have
an order. See *Release States* in `openspec/project.md`.

## Requirements

### Requirement: Keep version and revision previews attached to the chosen source

#### Scenario: A new version is published from the workspace

- GIVEN an API bound to a subset of gateways
- WHEN its new-version dialog publishes
- THEN it SHALL carry the saved gateway selection into the new resource
- AND the dialog SHALL explain that access follows the selected product's subscriptions — as a
  warning when both versions would share one product, so one key opens both, and as a plain
  sentence otherwise
- AND it SHALL offer **Cancel**, and say beside the disabled publish control when the application has
  no active product to put the version in

#### Scenario: A different revision is selected

- GIVEN an open comparison or rollback preview
- WHEN another revision is selected
- THEN the preview SHALL be reset for that revision
- AND a rollback confirmation SHALL NOT reuse the previous revision's plan

#### Scenario: Promotion is opened with an unsaved draft

- GIVEN the workspace's promotion dialog
- WHEN it explains what will be promoted
- THEN it SHALL say that the saved definition and settings are what is copied, and that backends
  already set in the target are kept
- AND when the workspace holds unsaved edits it SHALL warn that they are not promoted, naming the
  tabs that hold them, rather than a general reminder shown whether or not there is anything to save
- AND it SHALL offer **Cancel** beside **Promote**, and a successful promotion SHALL switch to the
  target environment through the unsaved-edits question, never around it

### Requirement: Two versions of an API are two resources

#### Scenario: A new version is created

- GIVEN an existing API
- WHEN a new version is created
- THEN a **new resource** SHALL be created carrying the same name and a different `apiVersion`
- AND both SHALL be able to answer at once, because the version is a segment of the published
  address
- AND the new version SHALL open in its own workspace after creation

#### Scenario: The next version is suggested

- GIVEN a current version
- WHEN the new-version dialog opens
- THEN the next version SHALL be suggested, and the form pre-filled from the current API
- AND the suggestion SHALL be editable, and validated against `API_VERSION_PATTERN`

#### Scenario: The new version's address is shown

- GIVEN the new-version dialog
- WHEN the identifier changes
- THEN the published path SHALL be re-derived from the API's catalog location and that identifier,
  and shown **read-only**
- AND it SHALL NOT be an editable field, because a path somebody may type freely is a path that
  can contradict the catalog it is derived from — the same rule the workspace's Public path obeys
- AND it SHALL still be shown rather than dropped, because the dialog promises that the current
  version keeps serving on its own path and this is the claim that makes that checkable

#### Scenario: The identifier is one the API already has

- GIVEN the new-version dialog
- WHEN an identifier matching an existing version is typed
- THEN the dialog SHALL refuse it **before** the request, with the publish control disabled and the
  reason rendered beside the field rather than in that control's tooltip
- AND the comparison SHALL be case-insensitive, because the version is a segment of the published
  address and two that differ only by case are one version to anybody reading it
- AND the reason SHALL name the version already there and list the ones the API has, so a free
  identifier can be chosen without leaving the dialog
- AND the control plane SHALL refuse it too — the browser check keeps the reader in the dialog they
  can fix it in, and is not what makes the rule

#### Scenario: A new version's definition is chosen

- GIVEN the new-version dialog
- WHEN the source is chosen
- THEN it SHALL offer either cloning the current definition or importing a new one
- AND the new resource SHALL carry the current one's summary, description, tags, documentation link
  and icon across

### Requirement: A revision is immutable; a release points at one

#### Scenario: A definition changes

- GIVEN an edited definition or an edited set of properties
- WHEN it is saved
- THEN a new `revision` SHALL be written with the next `rev`
- AND nothing SHALL be served differently until that revision is released

#### Scenario: A revision is listed

- GIVEN a resource
- WHEN its revisions are listed
- THEN each SHALL show its number, when it was written, by whom, and — per environment — whether it
  is live, was live, or has never been released there
- AND a structural diff against the previous revision SHALL be available
- AND a comparison or rollback that cannot be offered SHALL be shown disabled with its reason drawn
  beside it — the revision was pruned, it is the first, the one before it was pruned, the reader may
  not change this API, it is already live here, it was never released here — rather than in a
  tooltip
- AND an API with no revision yet SHALL offer the way to the definition as its empty state's action

#### Scenario: The newest revision is corrected

- GIVEN the revisions panel's correction form, which replaces the definition of a revision that has
  never been released, keeping its number
- WHEN a definition has been pasted into it
- THEN leaving the workspace SHALL ask first, because the pasted document is an unsaved edit
- AND its submit control SHALL say why it is disabled while nothing has been pasted

#### Scenario: A revision freezes when its publishing is accepted

- GIVEN a revision
- WHEN a release of it is confirmed, or an operation that will publish it is queued
- THEN it SHALL be frozen at that moment, not when the release or operation is later applied
- AND a correction of a frozen revision SHALL be refused with `409`, saying where it was released
  or that it is queued for publishing, and offering a new revision instead
- AND the reason SHALL be that what somebody confirmed is what gets published: a correction landing
  while the work waits its turn would otherwise ship a definition nobody confirmed

#### Scenario: A revision is released while a correction of it is in flight

- GIVEN a correction that has passed its checks and is still reading its body or fetching its
  `specUrl`
- WHEN the revision is released, queued for publishing, pruned or corrected by someone else in the
  meantime
- THEN the correction SHALL write nothing and answer `409`, naming what happened
- AND the reason SHALL be that the config build reads a released revision's definition on every
  poll, so a correction written after the release would be served under the same `rev` with no
  release at all (`formal/Formal/Revision.lean`)

### Requirement: Promote only along the chain, and only what has already reached the fleet

#### Scenario: A promotion is planned

- GIVEN a revision and a target environment
- WHEN the plan is computed
- THEN it SHALL be permitted if the target is the first link of the chain, or if the revision has
  **at some point** reached the predecessor
- AND "at some point" rather than "currently" SHALL be what makes rollback work
- AND reaching the fleet SHALL be read from `release.state` being `converged`, `superseded` or
  `withdrawn`, which a database trigger makes sufficient

#### Scenario: The chain is not satisfied

- GIVEN a revision that has not reached the predecessor
- WHEN the plan is computed
- THEN a `chain` blocker SHALL be produced naming the predecessor, the target, the whole chain, and
  the furthest point the revision has reached so far — or "nowhere"

#### Scenario: The target lacks what only it can supply

- GIVEN a target environment with no route, no backend binding or no gateway
- WHEN the plan is computed
- THEN a `no-route`, `no-binding` or `no-target` blocker SHALL be produced, each naming the
  environment
- AND route and binding SHALL **not** be seeded from the predecessor
- AND the reason SHALL be that they are in the edited-in-place tier, and a TEST backend guessed from
  DEV is exactly the mistake that tier prevents

### Requirement: Merge policy per unit on promotion, and never propagate a removal

#### Scenario: The predecessor carries a unit the target does not

- GIVEN a unit present in the source environment and absent in the target
- WHEN the plan is computed
- THEN it SHALL be listed under **create**, with the source environment named

#### Scenario: Both environments carry the same unit

- GIVEN a unit present in both
- WHEN the plan is computed
- THEN the target's value SHALL be listed under **keep**, and the source's SHALL not overwrite it

#### Scenario: The target carries a unit the predecessor does not

- GIVEN a unit present only in the target
- WHEN the plan is computed
- THEN it SHALL be listed under **localOnly** and kept
- AND a deletion upstream SHALL never propagate, because it is a local act per environment

#### Scenario: The merge would be invalid

- GIVEN a merged document that fails validation for the resource's kind
- WHEN the plan is computed
- THEN an `invalid-merge` blocker SHALL be produced, quoting the validation errors

#### Scenario: The merged document has no authentication

- GIVEN a merged document with no `auth.subscriptionKey`
- WHEN the plan is computed
- THEN a warning SHALL say this route is open to anyone who can reach the gateway
- AND it SHALL be a warning, not a blocker, because an intentionally public route is a real case

### Requirement: Confirm a promotion against the plan that was shown

#### Scenario: A plan is reviewed and confirmed

- GIVEN a dry-run plan
- WHEN the promotion is confirmed
- THEN the confirmation SHALL name the plan, and a plan SHALL be confirmable once
- AND the dry run SHALL return the plan's digest, covering only its decided content — the resource,
  the revision, the two environments, the created, kept and local-only units, and the blocker codes
  — so a second dry run a minute later matches while a real change does not

#### Scenario: The plan changed between review and apply

- GIVEN a confirmed plan whose inputs changed before it was applied — a policy edit in the
  predecessor, say
- WHEN the release is applied
- THEN the plan SHALL be re-computed and the current one applied, so the release carries the
  environment's validated policy as it is at apply time
- AND a re-computed plan with blockers SHALL be retried rather than applied
- AND the reason SHALL be that a promotion is one business action: asking the publisher to
  re-confirm a plan for an edit they made themselves is a second action nobody wanted

#### Scenario: A release that will never be applied is shown as such

- GIVEN a `stale` release
- WHEN it is shown
- THEN the chip SHALL read *Needs confirming*, with the underlying state and its meaning in the
  tooltip
- AND its reason SHALL say which release overtook it

#### Scenario: A release fails or goes stale

- GIVEN a release that does not complete
- WHEN it ends
- THEN **no policy SHALL have changed**, because the seeded units are written inside the same
  transaction that moves `release.state`

### Requirement: Roll back by releasing an earlier revision again

#### Scenario: A rollback is planned

- GIVEN an environment whose live revision is newer than the one being released
- WHEN the plan is computed
- THEN it SHALL be marked as a rollback

#### Scenario: A rollback would seed policy

- GIVEN a rollback whose merge would create units from the predecessor
- WHEN the plan is computed
- THEN a warning SHALL say the merge seeds policy from the predecessor **as it is today**, not as it
  was when that revision was current
- AND the warning SHALL be shown before the rollback is confirmed

#### Scenario: History is not rewritten

- GIVEN a rollback
- WHEN it completes
- THEN it SHALL be a new release pointing at the older revision
- AND the superseded release SHALL remain readable, because a rollback that erased its own cause is
  a rollback nobody can explain

### Requirement: Never let an earlier release overtake one that reached the fleet after it

#### Scenario: An earlier release's retry comes due after a later one went live

- GIVEN a release whose reconcile failed and is waiting to retry — a paused environment, a missing
  route
- AND a release of the same API into the same environment, confirmed after it, that has since
  reached the fleet (`converged`, `superseded` or `withdrawn`)
- WHEN the earlier release's retry runs
- THEN it SHALL be marked `stale`, with a reason naming the release that overtook it
- AND nothing SHALL be published and no policy SHALL be seeded, so the environment keeps serving
  what it served
- AND it SHALL NOT be retried again
- AND the reason SHALL be that converging it would supersede the later release and roll the
  environment back with nobody having asked; a rollback is a new release of the older revision

#### Scenario: A release's apply runs again after it already reached the fleet

- GIVEN a release that is `converged`, `superseded` or `withdrawn`
- WHEN its reconcile runs again — a job re-queued because the process stopped between committing
  the apply and marking the job done
- THEN nothing SHALL be written: the release SHALL keep its state and the environment SHALL keep
  serving what it served
- AND in particular a superseded or withdrawn release SHALL NOT be converged again, and none of the
  three SHALL become `stale`, because the promotion gate would then read a revision that reached the
  fleet as one that never did

#### Scenario: A withdrawal overtakes a release still waiting to apply

- GIVEN a release whose reconcile failed and is waiting to retry
- WHEN the API is withdrawn from that environment
- THEN that release SHALL be marked `stale` in the same transaction as the withdrawal, with a reason
  saying it was withdrawn before it was applied
- AND when its retry runs, nothing SHALL be written, so the API SHALL stay withdrawn
- AND the reason SHALL be that the withdrawal is the later act; publishing the API again when an
  earlier confirmation's backoff expires would undo it with nobody having asked

#### Scenario: Only a pending release is applied

- GIVEN a release that is not `pending`
- WHEN its reconcile runs
- THEN nothing SHALL be written

#### Scenario: What "confirmed after" means

- GIVEN two releases of one API into one environment
- WHEN their order is decided
- THEN it SHALL be the order the release rows were inserted, which is shared by releases confirmed
  through promotion and releases the operation spine writes
- AND it SHALL NOT be the release timestamps, which can be equal

### Requirement: Show the difference between two environments

#### Scenario: Divergence is read

- GIVEN a resource live in more than one environment
- WHEN divergence is read
- THEN it SHALL report which revision each environment serves, and how their per-environment state —
  route, binding, policy units, gateways — differs
- AND the reader SHALL be able to see this before deciding to promote

### Requirement: Delete forward-first

#### Scenario: A resource is deleted while a later environment still serves it

- GIVEN a resource live in a later environment of the chain
- WHEN deletion from an earlier one is attempted
- THEN it SHALL be refused, naming the environment that still serves it
- AND the reason SHALL be that deleting the source of a promotion chain leaves a downstream
  environment serving something nothing can explain

### Requirement: Promotion is invisible to the gateway

#### Scenario: A gateway receives a promoted configuration

- GIVEN a promotion into an environment
- WHEN that environment's configuration document is built
- THEN it SHALL contain the routes, policies and subscriptions of that environment and nothing about
  the chain
- AND the data plane SHALL never learn that environments have an order

### Requirement: Use positive integer version identifiers

#### Scenario: A version is written

- GIVEN a new resource, a publish, a version clone or an explicit version edit
- WHEN its apiVersion is validated
- THEN it SHALL match `^v[1-9][0-9]{0,30}$`: v1, v2 and so on, at most 32 characters
- AND dates, arbitrary words, v0, leading zeroes, uppercase V and decimal versions SHALL be refused by both the portal and control plane
- AND versions stored before this rule SHALL remain readable and SHALL NOT be renamed automatically
- AND the next-version suggestion SHALL choose a free valid identifier without losing precision for large numbers
