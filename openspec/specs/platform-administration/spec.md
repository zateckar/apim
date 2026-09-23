# platform-administration Specification

## Purpose

Define the estate's own controls: the directory of people and applications, the gateways and the
replicas behind them, and the audit trail over all of it. These are the screens in the sidebar's
Administration group.

## Requirements

### Requirement: Keep administration actions consistent with their prerequisites

#### Scenario: A member sees an empty application directory

- GIVEN a non-administrator
- WHEN the directory has no applications
- THEN the empty state SHALL direct them to their memberships and SHALL NOT open application creation

#### Scenario: A different unmapped group is selected

- GIVEN an open application creation form
- WHEN another unmapped group is chosen
- THEN the form SHALL show that group's value rather than retain the previous group's draft

#### Scenario: An application is successfully deleted

- GIVEN an allowed deletion
- WHEN it completes
- THEN navigation SHALL open the Applications list as well as changing the address bar

#### Scenario: An administrator views their own account

- GIVEN the role controls
- WHEN they render for the signed-in administrator
- THEN self-demotion SHALL be disabled with its reason
- AND password reset inputs SHALL mask the draft password

#### Scenario: Directory or audit reads fail

- GIVEN an unsuccessful read
- WHEN the page renders
- THEN it SHALL show the failure without claiming the directory or audit is empty

### Requirement: A member at an administration address is either shown the state or sent to their own

The Administration group is offered only to administrators. A member still reaches its addresses
through an old link or a typed address, and what they meet depends on whether the state behind the
screen explains something about their own APIs.

#### Scenario: A member deep-links into Trust, Global policy or Applications

- GIVEN a member who opens Trust, Global policy or Applications
- WHEN it renders
- THEN the current state the control plane lets them read SHALL be shown
- AND every control SHALL be disabled with one sentence saying only a platform administrator can
  change it and that the current state is readable here
- AND the reason SHALL be that these explain why a member's own API behaves as it does — which
  authorities its backend is checked against, which units every API inherits, who owns what

#### Scenario: A member deep-links into any other administration screen

- GIVEN a member who opens Gateways, Gateway settings, External systems, People, one other person's
  account, Telemetry or Audit
- WHEN it renders
- THEN the screen SHALL say it is for administrators, and SHALL link to the open screen that
  answers a member's version of the question: Health Status for the gateway screens, the dashboard
  for traffic, Activity for what changed, and their own account for people
- AND it SHALL NOT render the screen's chrome around a refusal — "0 people", an empty chart and a
  `403` banner read as an estate with nothing in it rather than as a screen that is not theirs

#### Scenario: The Audit log is read

- GIVEN the audit trail
- WHEN it is requested
- THEN it SHALL be administrator-only
- AND it SHALL show who changed what, when, and what happened as a result

### Requirement: Manage people in one directory, whichever provider authenticated them

#### Scenario: The People screen renders

- GIVEN an administrator
- WHEN People renders
- THEN every principal SHALL be listed with the provider that authenticates them, their display
  name, their role, whether they are disabled, their applications, and when they last signed in

#### Scenario: An administrator changes somebody's role or applications

- GIVEN a principal
- WHEN their role or memberships are changed
- THEN it SHALL take effect on that person's next request
- AND it SHALL be audited

#### Scenario: A membership came from the identity provider

- GIVEN a membership whose source is the identity provider's group claim
- WHEN it is revoked locally
- THEN the response SHALL explain that the directory will simply re-add it at the next claims
  refresh
- AND the portal SHALL show that explanation after the removal, rather than discarding the response
- AND the revocation SHALL not require a typed confirmation, because the button beside it grants it
  back

#### Scenario: A membership is removed in the portal

- GIVEN a membership on a person's page or on an application's page
- WHEN Remove is chosen
- THEN one dialog SHALL name the person and the application and say that they can no longer publish
  or change what it owns from their next request, with a single Remove and a Cancel
- AND when the membership came from an identity provider group, the dialog SHALL say before the
  click that it returns at the next claim refresh while they are still in that group
- AND both pages SHALL use the same dialog and the same request, so the two sides of a membership
  cannot describe it differently

#### Scenario: An administrator changes a role

- GIVEN a person's page
- WHEN the role controls render
- THEN only the change that applies SHALL be offered — "Make an administrator" for a member, "Make a
  member" for an administrator
- AND when a demotion leaves the person an administrator because the identity provider grants it,
  the response's explanation SHALL be shown beside the controls

#### Scenario: One person or one application is opened

- GIVEN a person's page or an application's page
- WHEN it has loaded
- THEN the page title SHALL be the person's display name or the application's name, rather than the
  route's generic "Account" or "Application"
- AND the page SHALL NOT draw its own link back to the list, because the shell's trail already does

#### Scenario: Somebody is signed out

- GIVEN a principal
- WHEN an administrator ends their sessions
- THEN every session SHALL be revoked
- AND it SHALL not require a typed confirmation, because it is a containment action rather than a
  deletion: nothing is lost and they can sign in again

#### Scenario: The last administrator would be removed

- GIVEN exactly one enabled administrator, or an administrator acting on themselves
- WHEN a disable or demote is attempted
- THEN it SHALL be refused with `409`, not `403`
- AND the reason SHALL be that the caller *is* an administrator; there is simply no valid end state
  on the other side

### Requirement: Every owned thing belongs to exactly one application

#### Scenario: The Applications screen renders

- GIVEN an administrator
- WHEN Applications renders
- THEN every application SHALL be listed with its members, its LeanIX metadata when known, and what
  it owns — APIs, products, certificates and Kafka topics
- AND the loaded list SHALL be searchable by name, id and directory group, with a visible result count and a clear-search action when nothing matches
- AND creation SHALL be offered in the section header, and application detail SHALL show ownership counts separately from editable identity fields

#### Scenario: Membership is changed from the application's side

- GIVEN an application's page
- WHEN an administrator opens it
- THEN it SHALL list the members with how each got there, offer to remove each, and offer to add
  somebody by searching the directory by name, username or email — at least two characters, with
  disabled accounts and existing members left out of the results
- AND it SHALL use the same membership endpoints as the person's page
- AND for a member reading their own application, the add and remove controls SHALL be shown
  disabled, with the one sentence saying only a platform administrator can change who is in an
  application

#### Scenario: An application is created

- GIVEN an administrator
- WHEN they create an application
- THEN a LeanIX metadata lookup SHALL be emitted for it
- AND it SHALL be available in the application picker to its members

#### Scenario: An application is deleted

- GIVEN an application that still owns something
- WHEN deletion is attempted
- THEN it SHALL be refused, naming what it owns
- AND a permitted deletion SHALL go through the typed confirmation with the application's name typed
  back

### Requirement: A gateway is a named deployment; its replicas are an operational fact

#### Scenario: The Gateways screen renders

- GIVEN an administrator
- WHEN Gateways renders
- THEN each environment's gateways SHALL be listed with their name, label, public address,
  intranet address, and whether they are enforcing or paused
- AND gateways SHALL be ordered by name
- AND a gateway SHALL have no kind, class or category: its name and its label are what it is, and a
  taxonomy nothing reads is a field an administrator must fill in and cannot be told the meaning of
- AND each gateway SHALL be read, not edited, in place: its addresses (each with a copy button),
  how many APIs are published on it and how many of its replicas are answering; adding a gateway and
  editing one's addresses and locality SHALL each be a dialog opened by a button, because a page an
  administrator came to read was otherwise three editable boxes per gateway
- AND an environment with no gateway SHALL be an empty state whose action adds one

#### Scenario: A gateway's deployments are paused or resumed

- GIVEN a gateway
- WHEN an administrator pauses its deployments
- THEN a dialog SHALL first say that it keeps serving what it has, and that publishes, policy
  changes and promotions in its environment that include it are held until it is resumed and then
  continue on their own
- AND resuming SHALL be one click, because it is the safe direction: held changes go out and
  nothing stops

#### Scenario: A gateway's address is published

- GIVEN a gateway behind a reverse proxy
- WHEN its public address is set
- THEN that address SHALL be what every API URL the portal shows a consumer is built from
- AND a **replica's** address SHALL never be published
- AND the reason SHALL be that a consumer who learned one would be holding a URL that stops working
  the next time the fleet is resized

#### Scenario: A gateway is added or removed

- GIVEN an administrator
- WHEN a gateway is added to an environment
- THEN its name SHALL be unique within that environment and match the gateway name pattern
- AND removing one SHALL be refused while anything is published on it, naming what

#### Scenario: What a gateway enforces is changed

- GIVEN an administrator
- WHEN they change a gateway's concurrency ceilings, body cap, cache sizes, telemetry bounds or
  access log
- THEN they SHALL do it on the Gateway settings screen, for the fleet, one environment or that one
  gateway, and never by editing a container's environment
- AND the full requirements for that screen and its resolution are in `gateway-settings`

### Requirement: Mint an instance token once, show it once, and cap how many there are

#### Scenario: A replica's token is minted

- GIVEN an administrator and a gateway
- WHEN they mint an instance token
- THEN the token SHALL be shown **once** and stored only as a hash
- AND minting SHALL be administrator-only
- AND the portal SHALL name the replica and mint in a dialog, and show the token in that dialog
  with a copy button and a sentence saying it will not be shown again; closing the dialog SHALL be
  the point after which it is gone, rather than a banner that stays on the page for anybody who
  walks past
- AND when the gateway is at its ceiling the mint button SHALL be disabled with the reason beside it

#### Scenario: Too many instances are minted

- GIVEN a gateway that already has `MAX_INSTANCES_PER_TARGET` instances
- WHEN another is minted
- THEN it SHALL be refused, naming the bound
- AND the reason SHALL be that the telemetry row count stays arithmetic rather than a hope

#### Scenario: A token is revoked

- GIVEN an instance
- WHEN it is revoked
- THEN that instance SHALL stop serving at its next poll
- AND the revocation SHALL be audited
- AND in the portal it SHALL be a *Revoke…* button that opens a dialog holding the typed
  confirmation, open, with the replica's name to type back, because a revoked token cannot be
  un-revoked

#### Scenario: An instance's state is read

- GIVEN registered instances
- WHEN Health Status renders their detail
- THEN each SHALL show which configuration digest it has activated, when it was last seen, its
  process stats, and anything it has refused to activate — including a settings block its container
  cannot honour
- AND its chip, on Health Status and on Gateways alike, SHALL be **Revoked**, **Not reporting**,
  **Refused config**, **Catching up** or **Healthy**, worst first, with the underlying reason in the
  tooltip
- AND **Refused config** SHALL be distinct from **Catching up**, because a replica that refused its
  document keeps serving the last one and will not converge on its own, and "catching up" tells an
  administrator to wait for something that is not coming
- AND an instance not seen within `INSTANCE_STALE_AFTER_SEC` SHALL be stale

### Requirement: Inspect what a gateway would be served

#### Scenario: An environment's configuration is read

- GIVEN an administrator
- WHEN they read an environment's configuration document
- THEN it SHALL be the same document the gateways receive, including its digest
- AND any routes that could not be rendered SHALL be listed with the reason
- AND no plaintext subscription key SHALL appear in it

### Requirement: The estate's screens follow capability, not inventory

#### Scenario: An estate has nothing configured yet

- GIVEN a fresh deployment
- WHEN the administration screens render
- THEN each SHALL be present with an empty state naming the next action — registering a gateway,
  minting a replica, adding a trust anchor
- AND no administration screen SHALL disappear because it has nothing in it yet

### Requirement: Make audit events easy to scan

#### Scenario: The audit table renders

- GIVEN recorded audit events
- WHEN Audit is opened
- THEN it SHALL load the latest 200 events with date and time, actor, action, subject and outcome
- AND it SHALL draw them 50 at a time, saying how many of the loaded or matching events are shown,
  with a Show more action while any remain
- AND the actor and the subject SHALL be shown by name where the control plane can name them — a
  person, an API, an application, a product — linked to their screen where they have one, with the
  stored id beneath in monospace; a subject with no name SHALL be shown as stored
- AND the outcome SHALL be a status chip in words: Succeeded, Refused, Failed
- AND each nonempty detail SHALL be available through a View details disclosure rather than expanded JSON in every row
- AND loading SHALL show a skeleton, and an empty audit SHALL offer Refresh events
- AND a search control SHALL filter the loaded events by actor, action, subject and outcome — names as well as ids — state that it searches at most the latest 200 events, and offer Clear search when nothing matches
- AND Refresh events SHALL remain available above a populated table

### Requirement: Check directory and gateway drafts before submission

#### Scenario: A draft is edited

- GIVEN an application, local account, gateway or replica creation form
- WHEN its fields are edited
- THEN the portal SHALL check its known name format and loaded duplicates in the correct scope; gateway names are per environment and active replica names per gateway
- AND complete name lists SHALL be used for directory creation checks
- AND local account passwords SHALL be masked and validated against the advertised minimum length and the 200-character maximum
- AND optional email and gateway URL fields SHALL show syntax errors before saving
