# portal-shell-navigation Specification

## Purpose

Define the shell every screen lives in: the two-column layout, the application-scoped address
space, the sidebar, the topbar, and the rule that a screen cannot exist without a title and a
one-line purpose. See *Portal Route Map* in `openspec/project.md`.

## Requirements

### Requirement: Render a two-column shell around every screen

#### Scenario: Any screen is opened

- GIVEN a signed-in user
- WHEN any screen renders
- THEN it SHALL sit inside a dark branded sidebar and a light main column
- AND the main column SHALL carry a topbar, then a page head with an eyebrow and an `h1`, then the
  screen's content

#### Scenario: The viewport narrows

- GIVEN a viewport at or under `1000px`
- WHEN the shell renders
- THEN the sidebar SHALL narrow, the page head SHALL stack, and the breadcrumb SHALL be hidden,
  because the page head already carries the same two facts

#### Scenario: The viewport is a phone

- GIVEN a viewport at or under `700px`
- WHEN the shell renders
- THEN the sidebar SHALL become an off-canvas drawer toggled by the labelled menu button in the
  topbar, the main column SHALL take the full width, and two-column form and stat grids SHALL
  collapse to one
- AND selecting a navigation entry SHALL close the drawer

### Requirement: Route by parsing the address, with no router dependency

#### Scenario: A navigation happens

- GIVEN any in-portal link
- WHEN it is followed
- THEN it SHALL be handled by `history.pushState` and `popstate`, with the default click
  suppressed, so the address bar and the back button both work
- AND no routing library SHALL be introduced

#### Scenario: Two address shapes arrive

- GIVEN `/:applicationId/apis/:resourceId` — what the shell writes — or `/apis/:id` — what a
  bookmark, an attention row or a "Used by" link may carry
- WHEN either is parsed
- THEN both SHALL resolve to the same screen
- AND a shape that resolved only the first SHALL be treated as a defect, because it renders the
  *list* with the id silently dropped, which looks like the link worked and did not

#### Scenario: A segment names something that is not an API

- GIVEN `/subscriptions/:subscriptionId` or `/certificates/:certificateId`, under either shape
- WHEN it is parsed
- THEN the second segment SHALL NOT be read as a resource id
- AND the API workspace SHALL NOT open for something that is not an API
- AND the address SHALL reach that thing's own screen rather than the list it belongs to

#### Scenario: One screen has two addresses

- GIVEN `/apis/new`, which the route table and the *How this works* screen write, and
  `/:applicationId/publish`, which the shell writes
- WHEN either is parsed
- THEN both SHALL resolve to the publish wizard
- AND resolving only the shell's own SHALL be treated as the same defect as a dropped id

#### Scenario: A pattern could match two routes

- GIVEN `/apis/new` and `/apis/:resourceId`
- WHEN the address is matched
- THEN the longest literal prefix SHALL win, so `/apis/new` is the publish wizard and not the API
  whose id is `new`
- AND ordering SHALL be computed from the table rather than maintained by hand, so a table somebody
  appends to keeps working

#### Scenario: Nothing matches

- GIVEN an address that matches no pattern
- WHEN it renders
- THEN the *Not found* screen SHALL be shown with its own title and purpose

#### Scenario: The shell has its own screen for an address

- GIVEN an address the shell answers itself — the dashboard, one application's APIs, the publish
  wizard, the list of subscriptions
- WHEN it is opened
- THEN the shell's screen SHALL render it, and there SHALL be exactly **one** rendering of it
- AND the route table's renderer SHALL be the fallback for everything else, with no case of its own
  for those ids
- AND the reason SHALL be that a second screen on the same address is a second set of behaviour to
  keep true, and the one nobody can reach is the one that quietly stops being true

#### Scenario: The root address is opened

- GIVEN `/`
- WHEN it resolves
- THEN it SHALL be the **selected application's** dashboard, for the selected environment
- AND there SHALL be no separate estate-wide home screen
- AND the reason SHALL be that the estate's own health is Health Status, which is a screen in the
  Administration group and open to everybody, and two screens answering "how is it going" from
  different scopes is how two numbers come to disagree

### Requirement: Every screen has a title and a one-line purpose

The rule SHALL be enforced structurally rather than by review.

#### Scenario: A screen is rendered

- GIVEN any route
- WHEN the shell renders it
- THEN the title and the one-line purpose SHALL be taken from `ui/src/lib/routes.ts` and rendered
  by the shell
- AND a screen SHALL therefore be unable to exist without them
- AND a test SHALL be able to assert the property over every route rather than over every component

#### Scenario: A workspace is open

- GIVEN an address whose third segment names a resource
- WHEN the head renders
- THEN the title SHALL be *API workspace*, and the eyebrow SHALL be the application's display name

#### Scenario: A detail address and its list share a section

- GIVEN one subscription's address and the list of subscriptions
- WHEN each head renders
- THEN the detail SHALL be titled *Subscription* and the list *Subscriptions*
- AND the title SHALL therefore come from the matched route rather than the section, because the
  section alone cannot tell the two apart and a reader who saw the plural would conclude their link
  had taken them to the wrong place

### Requirement: Scope the shell to one application at a time

#### Scenario: An application is chosen

- GIVEN the application picker
- WHEN a different application is selected
- THEN the choice SHALL be remembered in `localStorage`
- AND the address SHALL move to the **same section** under the new application, so switching
  applications while comparing two of them does not throw the reader back to a dashboard every time
- AND a section that does not exist under the new application SHALL fall back to the dashboard

#### Scenario: The picker is populated

- GIVEN a signed-in user
- WHEN the picker renders
- THEN it SHALL list the applications they are a member of, and every application for an
  administrator
- AND applications SHALL come from the control plane, never from a hardcoded seed list

#### Scenario: An address names an application the user is not in

- GIVEN a member who opens `/{someone-elses-application}/apis`
- WHEN the shell resolves it
- THEN the shell SHALL fall back to the user's own selected application rather than adopting the
  named one
- AND an administrator SHALL be able to open any application's address

### Requirement: Group the sidebar by what a person is doing

#### Scenario: The sidebar renders

- GIVEN a signed-in user
- WHEN the sidebar renders
- THEN it SHALL show the brand, the application picker, then Dashboard, then these groups in order:
  **API** (APIs · MCP Servers · A2A Agents · Products · Subscriptions · Approvals),
  **Kafka** (Kafka Topics · Kafka REST Proxy),
  **Other** (Certificates · External systems · Mail · Activity),
  **Global** (Catalog · FixMe diagnostics · How this works · Your account)
- AND **Administration** (Health Status · Gateways · Applications · People · Telemetry ·
  Global policy · Trust · Audit) SHALL be shown only to an administrator
- AND the group of surrounding systems SHALL be labelled *External systems* rather than
  *Integrations*, which reads as a development slug for the thing this portal is

#### Scenario: The user footer renders

- GIVEN a signed-in user
- WHEN the sidebar footer renders
- THEN it SHALL show their display name, the word *Administrator* or *Developer*, and a sign-out
  button
- AND signing out SHALL follow the identity provider's end-session URL when the control plane
  returns one, and otherwise reload the portal

### Requirement: The topbar answers four standing questions

#### Scenario: The topbar renders

- GIVEN any screen
- WHEN the topbar renders
- THEN it SHALL show a breadcrumb of `<application> / <screen title>`, a chip saying the
  surrounding systems are simulated, the portal version as a **button**, a light/dark toggle, a
  count of deployments in progress, and the notifications bell

#### Scenario: The version is pressed

- GIVEN the version button
- WHEN it is pressed
- THEN the change log SHALL open
- AND the version SHALL be a button rather than a chip, because a chip that only states a number
  leaves "what changed since I was last here" unanswered and the answer in a file nobody using the
  portal can open

#### Scenario: Two counts are shown

- GIVEN work in flight and unread notifications
- WHEN the topbar renders
- THEN the activity count SHALL count operations that are neither `complete` nor `superseded` and
  SHALL link to Activity
- AND the bell SHALL count **unread** notifications, which is a different question, and SHALL open
  a popover rather than a parallel toast stack

#### Scenario: The theme is toggled

- GIVEN the light/dark toggle
- WHEN it is pressed
- THEN the choice SHALL be applied to the document and remembered in `localStorage`

### Requirement: Offer the environment switcher on every screen that has one

#### Scenario: The page head renders

- GIVEN the promotion chain
- WHEN the page head renders
- THEN a labelled segmented control SHALL offer every environment in chain order, with the current
  one marked active
- AND changing it SHALL change what the screen below shows, without navigating

#### Scenario: A publishing screen is open

- GIVEN the APIs, MCP Servers, A2A Agents or Dashboard section, with no resource open
- WHEN the page head renders
- THEN a primary **Publish API** action SHALL be offered
- AND from MCP Servers or A2A Agents it SHALL carry the kind, so the wizard opens on the right one

### Requirement: Reach the catalogue from anywhere

#### Scenario: A consumer looks for an API

- GIVEN any signed-in user
- WHEN they open Catalog from the Global group
- THEN they SHALL see every API they are allowed to see, across applications, grouped by domain
- AND opening one SHALL show a read-only listing with what it does and how to subscribe — never the
  publisher's editor

### Requirement: Refuse to lose an unsaved edit

#### Scenario: A user navigates away from a dirty editor

- GIVEN unsaved changes in a definition or a policy editor
- WHEN the user navigates away
- THEN they SHALL be warned before the change is lost
- AND the warning SHALL NOT use `confirm()`

### Requirement: Keep one live ticker for the whole shell

#### Scenario: Something changes without an operation

- GIVEN a subscription moving from revoking to revoked, which adds no operation row
- WHEN the workspace is open
- THEN it SHALL refresh from the shell's live ticker rather than from the operation count
- AND a transient state SHALL NOT persist until a full reload
