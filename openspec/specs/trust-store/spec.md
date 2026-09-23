# trust-store Specification

## Purpose

Define the other direction of trust: what each environment's gateways are willing to **accept** from
a backend. Two things live here — the certificate authorities an environment trusts, and the dated
exceptions that relax verification for one backend.

The portal puts these on `/trust` beside the client identities the estate presents
(`app-certificates`) and the rules for what it may reach at all (`egress-governance`). They share a
screen because they are one question asked from several sides; they are separate capabilities
because they are separate contracts, and the governance report is where all of them are asked about
the estate rather than about an API.

## Requirements

### Requirement: Keep trust previews tied to the material and source reviewed

#### Scenario: A certificate preview is pending

- GIVEN a PEM preview or registration in flight
- WHEN the form renders
- THEN the PEM input SHALL be disabled until the request finishes so the displayed preview describes the submitted material

#### Scenario: Copy selection changes

- GIVEN a source environment or authority selection
- WHEN it changes
- THEN the previous plan SHALL be cleared
- AND source and authority controls SHALL be disabled during a preview or copy
- AND loading a different source SHALL NOT show the previous source's authorities

#### Scenario: Governance is unavailable

- GIVEN a loading or failed governance read
- WHEN the report renders
- THEN it SHALL show loading or the failure rather than claim there are no exceptions

### Requirement: Trust anchors are an environment decision, not a per-process one

#### Scenario: An anchor is registered

- GIVEN an administrator and a CA certificate
- WHEN it is registered for an environment
- THEN it SHALL be stored with a name unique within that environment, its thumbprint, its subject
  and its `notAfter`
- AND it SHALL be an administrator action, disabled with a reason for anybody else

#### Scenario: Anchors reach the fleet

- GIVEN an environment's live anchors
- WHEN the configuration document is built
- THEN every one of them SHALL travel **inline** in the document
- AND the reason SHALL be that a CA certificate is 1–2 KiB, so the artifact channel — which exists
  because schemas reach megabytes — would buy activation-gating complexity for nothing

#### Scenario: Too many anchors are registered

- GIVEN more than `MAX_TRUST_ANCHORS` live anchors in one environment
- WHEN another is uploaded
- THEN it SHALL be refused, naming the variable
- AND the reason SHALL be that the document carries every one of them to every gateway, so the count
  is a bound on the document rather than a preference

#### Scenario: An anchor expires

- GIVEN an anchor whose `notAfter` passes
- WHEN a gateway composes its trust set
- THEN the anchor SHALL be dropped on the gateway's **own clock**
- AND the reason SHALL be that fail-static configuration must not keep a dead CA alive through a
  control-plane outage

#### Scenario: An anchor is previewed before it is registered

- GIVEN an uploaded PEM
- WHEN it is previewed
- THEN its subject, issuer, thumbprint, key algorithm and validity window SHALL be shown
- AND registering SHALL be a second, deliberate step

#### Scenario: Anchors are copied between environments

- GIVEN two environments
- WHEN anchors are copied from one to the other
- THEN the difference SHALL be shown before it is applied
- AND the copy SHALL be an explicit act rather than something promotion does

### Requirement: Anchors apply to every mode that verifies anything

#### Scenario: A backend connection is verified

- GIVEN a TLS mode of `verify`, `pin` or `skip-hostname`
- WHEN the connection is made
- THEN the environment's anchors SHALL apply — the chain is still checked before the pin is compared
  or the name check relaxed

#### Scenario: Nothing is verified

- GIVEN a TLS mode of `insecure`
- WHEN the connection is made
- THEN the anchors SHALL NOT apply
- AND the reason SHALL be that nothing is verified in that mode and adding a CA would be theatre

#### Scenario: The system roots are excluded

- GIVEN `TRUST_SYSTEM_ROOTS=0` on a gateway
- WHEN its trust set is composed at activation
- THEN only the environment's registered anchors SHALL be trusted

### Requirement: A TLS exception is its own object, dated and administrator-owned

#### Scenario: Verification is relaxed for a backend

- GIVEN a backend whose certificate cannot yet be verified
- WHEN an exception is created
- THEN it SHALL live in its own table, carry a mode, a reason, who created it and an expiry
- AND it SHALL NOT live inside the binding

#### Scenario: The reasons it is not in the binding are questioned

- GIVEN the design
- WHEN it is reviewed
- THEN all four SHALL hold: inside a binding it would be **owner-writable**, and "should we stop
  verifying this backend's certificate" is not an owner's decision to make alone; it would be
  **invisible** to "list every unverified backend in prod", which is the question an auditor actually
  asks; it would be **permanent by default**, because nothing would carry an expiry; and its expiry
  is bounded by the configured maximum, so "temporary" has a number attached

#### Scenario: An exception is given too long a life

- GIVEN an expiry further out than the configured maximum days
- WHEN it is created
- THEN it SHALL be refused, naming the limit

#### Scenario: An exception expires

- GIVEN an exception whose expiry passes
- WHEN a gateway serves the route
- THEN it SHALL stop honouring the exception on **its own clock**
- AND an exception SHALL therefore be unable to outlive its date through a control-plane outage
- AND the one remaining window SHALL be stated: an existing connection keeps its TLS options until
  it is closed

#### Scenario: An exception is revoked

- GIVEN a live exception
- WHEN it is revoked
- THEN it SHALL stop applying at the fleet's next configuration
- AND the revocation SHALL be audited

### Requirement: Check whether an exception is still needed

#### Scenario: A backend is re-checked

- GIVEN an open exception
- WHEN the check action is used
- THEN one TLS handshake SHALL be attempted the way the gateway's default `verify` mode would
  attempt it: the system roots plus this environment's anchors, hostname check on, redirects
  unfollowed
- AND **any** HTTP answer at all SHALL count as success, because a `404` from a backend that
  verified is a "yes"
- AND the result SHALL say plainly whether the exception can now be removed

#### Scenario: The check is offered on the Trust screen

- GIVEN a live exception in the TLS exceptions list
- WHEN an administrator reads its row
- THEN a **Re-check** action SHALL run the check above and show, under the row, whether the
  exception is still needed and what each covered backend answered
- AND it SHALL sit before **Revoke**, because asking is the cheap way to find out what revoking would
  break
- AND for anybody else both actions SHALL be disabled with the reason, not hidden

#### Scenario: An exception or an authority is removed from the Trust screen

- GIVEN a live exception or a registered authority
- WHEN an administrator revokes the exception or deletes the authority
- THEN a dialog SHALL open on the typed confirmation, asking for the API's or the authority's name
  and saying what stops verifying and when
- AND the confirmation SHALL NOT be drawn inline in the table row

#### Scenario: Trust states are read

- GIVEN the exceptions list, the authorities list or the governance report
- WHEN they render
- THEN a mode SHALL read as what is still checked — Pinned, No hostname check, Not verified — and an
  expiry as the days left, Expired or Revoked, each as a status chip
- AND environments SHALL be written as the shell writes them, in capitals

### Requirement: List every open exception in one place

#### Scenario: The governance report is read

- GIVEN an administrator
- WHEN they read the governance exceptions report
- THEN every unexpired, unrevoked exception SHALL be listed with its resource, environment, backend,
  mode, reason, who created it and when it expires, ordered by expiry
- AND the report SHALL be administrator-only
- AND this SHALL be the answer to "list every unverified backend in prod"

#### Scenario: An exception is nearing its expiry

- GIVEN an exception due to expire
- WHEN attention is computed
- THEN a row SHALL be raised naming the resource, the environment and the date
- AND the reason SHALL be that an exception expiring unnoticed is a route that starts failing for a
  cause nobody connected to a decision made weeks earlier

### Requirement: Validate trust drafts before saving

#### Scenario: A draft is edited

- GIVEN an authority registration or TLS exception form
- WHEN its fields are edited
- THEN authority names SHALL use the documented lowercase name pattern
- AND exceptions SHALL require an API, a reason of at least 20 characters, a positive integer lifetime, and a valid SHA-256 thumbprint when pin mode is selected
- AND optional backend URL syntax SHALL be checked locally; the control plane SHALL enforce the configured maximum lifetime
