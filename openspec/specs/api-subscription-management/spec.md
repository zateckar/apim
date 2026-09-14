# api-subscription-management Specification

## Purpose

Define products, subscriptions and keys: how a consumer asks for access, how a publisher grants it,
who may see a key, and what each side of the relationship is allowed to do to the other.

## Requirements

### Requirement: Distinguish configured limits and known subscriptions from missing data

#### Scenario: Limits are reviewed

- GIVEN the subscription wizard's Review step
- WHEN effective policy is loading or unavailable
- THEN each limit SHALL say loading or unknown rather than absent
- AND loaded limits SHALL be described as this API's configured limits in the selected environment, not guarantees about other APIs in the product or gateway activation
- AND quota periods SHALL retain their exact duration, and per-instance rate limits SHALL name replicas

#### Scenario: A subscription request completes

- GIVEN a pending or activating subscription
- WHEN its completion panel renders
- THEN it SHALL show the selected environment's live published gateway addresses, with their networks, when available
- AND it SHALL NOT invent a hostname, scheme or credential header
- AND calling guidance SHALL link to the consumer listing

#### Scenario: Products are displayed before subscriptions load

- GIVEN a product whose subscriber list has not loaded or failed
- WHEN its card renders
- THEN the count SHALL be unavailable and SHALL NOT say nobody subscribes
- AND the API membership picker SHALL read the complete paginated resource list

### Requirement: Subscriptions are to products, never directly to an API

#### Scenario: A consumer wants to call an API

- GIVEN an API in the catalogue
- WHEN a subscription is created
- THEN it SHALL be against a **product** that contains that API
- AND an API not in any product SHALL show, on its listing, that it is not yet sold anywhere

#### Scenario: A product is defined

- GIVEN an owning application
- WHEN it creates a product
- THEN the product SHALL contain only that application's own APIs
- AND the product name SHALL be unique across the estate

#### Scenario: What is in a product is chosen

- GIVEN the owner editing or creating a product
- WHEN the membership control renders
- THEN it SHALL be a list of checkboxes, one per candidate API, with a count of how many are ticked
- AND it SHALL NOT be a `<select multiple>`
- AND the reason SHALL be that removing an API takes it away from every subscriber at the next
  gateway poll, while a multi-select clears its entire selection on any un-modified click, renders
  the selection in a grey that all but disappears when the control is not focused, and offers the
  reader nothing that distinguishes "this product is empty" from "I have just lost what was in it"

#### Scenario: Products are browsed before editing

- GIVEN the application's products
- WHEN the Products page renders
- THEN each product SHALL show links to its current APIs and its subscriptions
- AND its membership editor SHALL start collapsed under "Edit APIs in this product"
- AND collapsing the editor SHALL retain pending edits and indicate unsaved changes in its summary
- AND a Create a product control above the list SHALL reveal the creation form; cancellation or successful creation SHALL close it

#### Scenario: A product is deleted

- GIVEN a product with active subscriptions
- WHEN deletion is attempted
- THEN it SHALL be refused with `409` naming the count
- AND the reason SHALL be stated: their next call would become an unexplained `404`

### Requirement: A subscription is per environment and carries a purpose

#### Scenario: A subscription is created

- GIVEN a product, a consuming application and an environment
- WHEN the subscription is created
- THEN a purpose of 3 to 500 characters SHALL be required
- AND the response SHALL be `201` carrying the id, the product, the application, the environment,
  the state and the purpose
- AND a primary key SHALL be minted, encrypted at rest, and never returned by this call

#### Scenario: The same dialog is reached two ways

- GIVEN the Catalog's Subscribe dialog, which posts with the product in the path, and the direct
  subscriptions endpoint
- WHEN either is used
- THEN both SHALL go through **one** function
- AND the reason SHALL be that two entry points must not drift on which lifecycle states are
  subscribable

#### Scenario: A subscription is wanted for the API already open

- GIVEN an API's workspace with its subscriptions panel showing
- WHEN the reader wants access to that API
- THEN the panel SHALL offer subscribing to it directly, both in its head and from its empty state
- AND the offered products SHALL be the ones containing that API, so the API is never re-chosen
- AND the panel SHALL re-read when the dialog closes, because the request lands as a row in it
- AND the reason SHALL be that the answer to "how do I get a key for this" was a trip to the
  catalogue to search for the thing already on screen — including for the API's own publisher, who
  needs a subscription like anybody else to call it

### Requirement: Approve access, except to your own product

#### Scenario: A consumer subscribes to somebody else's product

- GIVEN a consuming application different from the product's owner
- WHEN the subscription is created
- THEN its state SHALL be `pending`
- AND an approval request SHALL be raised with the publisher, carrying the purpose

#### Scenario: An application subscribes to its own product

- GIVEN a consuming application that owns the product
- WHEN the subscription is created
- THEN its state SHALL be `activating`, with the decision recorded as the requester's own
- AND a notification SHALL be emitted saying own-product access was approved

#### Scenario: A publisher decides

- GIVEN a pending request
- WHEN the publisher approves or rejects it
- THEN the decision, the deciding user and the time SHALL be recorded
- AND the consumer SHALL be notified either way, with the rejection distinguishable from the
  approval

#### Scenario: A retired product is subscribed to

- GIVEN a product whose lifecycle is `retired`
- WHEN a new subscription is attempted
- THEN it SHALL be refused
- AND existing subscriptions to it SHALL keep working
- AND the rule SHALL be defined at the **product**, because the subscription unit is a product and
  not an API

### Requirement: Show a subscription from the reader's own side

#### Scenario: A subscription is listed

- GIVEN a subscription between two applications
- WHEN it is rendered for either of them
- THEN it SHALL carry `viewerIs` — `consumer`, `publisher` or `other`
- AND the reason SHALL be that the same subscription means "our application calls their product" to
  one side and "their application calls our product" to the other, and a list that did not say
  which is which would be a list of opaque rows

#### Scenario: A subscription list is read

- GIVEN any signed-in user
- WHEN they list subscriptions
- THEN they SHALL see the ones their applications hold, and the ones somebody holds against their
  applications' products
- AND never anybody else's
- AND in neither case any key material

#### Scenario: One subscription is opened

- GIVEN a subscription named by its own address
- WHEN it renders
- THEN it SHALL be that subscription's own screen — its keys, what it may call, and what it has
  spent — rather than the list it belongs to
- AND the reason SHALL be that none of those three are on the list, so falling back to the list
  reads as "there is nothing here" to a reader who followed a link to a specific thing

### Requirement: Keys belong to the consumer alone

#### Scenario: A key is revealed

- GIVEN an `active` subscription
- WHEN the consuming application's member calls reveal
- THEN both keys SHALL be returned with `Cache-Control: no-store`
- AND the reveal SHALL be audited
- AND a subscription that is not yet active SHALL be refused with `409` saying keys are available
  only after access is active

#### Scenario: A publisher tries to reach a key

- GIVEN a member of the product's owning application
- WHEN they attempt to reveal or rotate the subscription's keys
- THEN it SHALL be refused
- AND the reason SHALL be that a publisher who could rotate another application's key could break
  their caller silently at a moment of their choosing, and would learn a credential that is not
  theirs

#### Scenario: A publisher ends the relationship

- GIVEN a member of the product's owning application
- WHEN they revoke the subscription
- THEN it SHALL be permitted
- AND their capabilities on the subscription SHALL be exactly `read` and `delete`
- AND the reason SHALL be that an abusive or compromised consumer is the publisher's problem, and
  needing to find an administrator to stop it makes the platform the bottleneck in exactly the
  moment it should not be

### Requirement: Rotate one key at a time

#### Scenario: A key is rotated

- GIVEN an `active` subscription
- WHEN the consumer rotates
- THEN they SHALL name `primary` or `secondary`, and anything else SHALL be refused
- AND a new key SHALL be minted for that slot, the rotation time recorded, and the other slot left
  untouched
- AND the reason SHALL be that two slots are what makes a rotation possible without an outage
- AND rotating a subscription that is not active SHALL be refused with `409`

#### Scenario: A rotation is asked for in the portal

- GIVEN the panel that shows a subscription's keys
- WHEN rotation is offered there
- THEN it SHALL offer **both** slots, because the primary is the key every consumer was issued on
  day one and a portal that can only rotate the secondary can never replace it
- AND it SHALL ask for confirmation before rotating a slot that holds a key, naming what stops
  working
- AND minting a slot that is empty SHALL NOT ask, because nothing stops working
- AND the confirmation SHALL NOT require the object's name to be typed, because nothing is being
  deleted
- AND the panel SHALL state the sequence — rotate the idle slot, move the callers, then rotate the
  other — because doing it in the other order is an outage
- AND the reason SHALL be that rotation is irreversible and stops every caller holding the old key
  at once, and that this is the panel people open in order to *read* a key — so a single unguarded
  click sat beside the value they came for

#### Scenario: The same keys panel is reached two ways

- GIVEN the subscription's own screen and the subscriptions list's keys dialog
- WHEN either shows keys
- THEN both SHALL render the same component
- AND the reason SHALL be that they had drifted: one offered both rotations and the other only the
  secondary, and neither showed an age — so which capabilities a reader got depended on which
  screen they happened to open

#### Scenario: A key is read

- GIVEN the keys panel
- WHEN it is opened
- THEN no key material SHALL be fetched
- AND revealing SHALL be a deliberate action per subscription, because every reveal is audited
  against the reader's name and opening a screen is not asking

#### Scenario: A rotated key reaches the fleet

- GIVEN a rotation
- WHEN the environment's configuration document is next built
- THEN it SHALL carry the sha256 of each **active** key
- AND plaintext keys SHALL never leave the control plane

### Requirement: A key has an age, and it stops working when it is old enough

#### Scenario: Each slot is dated separately

- GIVEN a subscription with two keys
- WHEN either is minted or rotated
- THEN that slot's minting time SHALL be recorded, and the other slot's SHALL be left alone
- AND the reason SHALL be that one date for the pair answers "when was this subscription last
  touched" and was being read as "how old is this key" — which is exactly wrong after a secondary
  rotation, the move that leaves the primary old being the one that resets the only clock watching
  it

#### Scenario: A key passes the warning age

- GIVEN a key older than `SUBSCRIPTION_KEY_WARN_DAYS` (365 by default)
- WHEN the subscription is read
- THEN the slot SHALL report `ageing`, and the portal SHALL raise the `key-ageing` attention item
- AND the key SHALL keep working, because the gap between warning and expiry is the runway a
  consumer needs to coordinate a rotation with the teams that call them

#### Scenario: A key passes the expiry age

- GIVEN a key older than `SUBSCRIPTION_KEY_EXPIRE_DAYS` (600 by default)
- WHEN the expiry job next runs
- THEN that slot SHALL be marked expired, once, with one audit entry naming the slot and its age
- AND the slot SHALL leave the environment's configuration document, so the gateway refuses the key
  without ever having heard of an expiry
- AND the subscription SHALL remain in the document with its other keys, or with none, rather than
  being dropped from it — the entry is what telemetry, quota and the logs name the caller by, and
  dropping it would turn "this key is dead" into an anonymous `401`
- AND the portal SHALL raise the `key-expired` attention item as a blocker
- AND rotating the slot SHALL clear the mark, because the new key is not the old one
- AND a subscription that is not `active` SHALL be left alone, because its keys stopped mattering
  for another reason and an expiry date would claim they died of old age

#### Scenario: An administrator changes the policy

- GIVEN the two thresholds
- WHEN they are set through `SUBSCRIPTION_KEY_WARN_DAYS` and `SUBSCRIPTION_KEY_EXPIRE_DAYS`
- THEN the warning age SHALL be clamped to no more than the expiry age, because a warning nobody
  can act on before the key dies is not a warning

### Requirement: Revoking is final

#### Scenario: A subscription is revoked

- GIVEN an active subscription
- WHEN it is revoked
- THEN its keys SHALL stop working once the fleet applies the next configuration
- AND it SHALL NOT be un-revokable — a new subscription is the way back
- AND the chip SHALL say so: "revoked — its keys no longer work, and it cannot be un-revoked"

#### Scenario: A request is withdrawn before it is decided

- GIVEN a `pending` subscription
- WHEN the consumer ends it
- THEN it SHALL become `cancelled` rather than `revoking`
- AND the portal SHALL say "cancel this request", not "withdraw access", because nothing was
  granted and so nothing is being taken away

### Requirement: Offer the actions the subscription's state actually has

#### Scenario: A subscription is listed in any state

- GIVEN a subscription in one of the seven states
- WHEN its row is rendered
- THEN the row SHALL offer the actions that state permits, or say what is being waited on
- AND `pending` SHALL offer to cancel the request, `active` its keys and revocation, `activating`
  revocation and a note that the gateways have not started accepting the keys
- AND `revoking` SHALL say the gateways have not stopped accepting the keys yet, and offer nothing,
  because the request is already in flight
- AND the three terminal states SHALL offer to subscribe again and nothing else
- AND the reason SHALL be that the list rendered exactly one button — Revoke — for three states and
  nothing at all for the other four, so a row in a terminal state looked like one the portal had
  forgotten about

#### Scenario: Ending a subscription is offered when there is something to end

- GIVEN a subscription that is `revoking`, `revoked`, `rejected` or `cancelled`
- WHEN its own screen offers to end it
- THEN the control SHALL be disabled, and SHALL say which of those it is
- AND it SHALL NOT say "already revoked" for a state that is not revoked

### Requirement: Show a consumer what they have spent

#### Scenario: Usage is read

- GIVEN an active subscription with a quota unit
- WHEN its usage is read
- THEN it SHALL show what has been used in the current window, against the limit, and when the
  window resets
- AND the figure SHALL be the fleet's aggregate rather than one instance's count
- AND where a rate limit applies, the screen SHALL state that the fleet ceiling is
  `calls × instances` rather than hide it

### Requirement: Show a consumer how to use the key

#### Scenario: A subscription page renders

- GIVEN an active subscription
- WHEN its page renders
- THEN it SHALL show the header name and location the API's policy expects, the published URL per
  environment, and a copyable example
- AND the example SHALL be derived from the API's own `auth.subscriptionKey` unit rather than
  assumed

### Requirement: Offer meaningful creation and subscription choices

#### Scenario: A draft is edited

- GIVEN a product creation or subscription form
- WHEN its fields are edited
- THEN product names SHALL be checked against the name pattern and complete estate product list before creation
- AND a single subscribable product SHALL be stated without a redundant picker
- AND purpose length SHALL gate submission
- AND inline application creation SHALL be offered only to administrators and SHALL check directory name length and duplicates

- AND the subscription application choices SHALL include only applications the user can act for (all for an administrator)
