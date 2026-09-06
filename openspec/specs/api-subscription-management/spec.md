# api-subscription-management Specification

## Purpose

Define products, subscriptions and keys: how a consumer asks for access, how a publisher grants it,
who may see a key, and what each side of the relationship is allowed to do to the other.

## Requirements

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

#### Scenario: A rotated key reaches the fleet

- GIVEN a rotation
- WHEN the environment's configuration document is next built
- THEN it SHALL carry the sha256 of each **active** key
- AND plaintext keys SHALL never leave the control plane

### Requirement: Revoking is final

#### Scenario: A subscription is revoked

- GIVEN an active subscription
- WHEN it is revoked
- THEN its keys SHALL stop working once the fleet applies the next configuration
- AND it SHALL NOT be un-revokable — a new subscription is the way back
- AND the chip SHALL say so: "revoked — its keys no longer work, and it cannot be un-revoked"

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
