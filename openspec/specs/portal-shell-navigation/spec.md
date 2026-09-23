# portal-shell-navigation Specification

## Purpose

Define the shell every screen lives in: the two-column layout, the application-scoped address
space, the sidebar, the topbar, and the rule that a screen cannot exist without a title and a
one-line purpose. See *Portal Route Map* in `openspec/project.md`.

Every address, every title, every purpose and every sidebar entry come from **one table**, and one
registry says which component answers each of them. The shell resolves nothing on its own.

## Requirements

### Requirement: Keep screen state attached to its context

#### Scenario: The displayed context changes

- GIVEN a page with an open dialog, local draft, or completed wizard
- WHEN the address, selected application, or the page's selected environment changes
- THEN the page SHALL start with state for the new context rather than reuse the previous context's draft or result
- AND the notifications popover SHALL close and reload when the application changes
- AND background polling within the same context SHALL NOT reset drafts

#### Scenario: An asynchronous query changes scope

- GIVEN a result for one application, resource, filter or time range
- WHEN a scoped query changes
- THEN its previous result SHALL NOT be presented as the new query's result while loading
- AND a refresh within the same scope MAY retain the existing result until it completes

#### Scenario: How this works is opened

- GIVEN the published UI workflows
- WHEN the guidance renders
- THEN publishing SHALL describe Identify, Define and Route in order
- AND promotion SHALL describe saved configuration, the target backend and deployment progress
- AND new-version guidance SHALL explain the copied settings and product-based access
- AND subscription guidance SHALL explain use of the application selected in the main menu, pending or activating access and later key reveal
- AND the journeys that only an administrator can complete — running the platform, letting somebody
  in — SHALL be shown only to an administrator
- AND the journey count SHALL be derived from the rendered journeys, so a member is not promised a
  journey the page does not show them

### Requirement: Render a two-column shell around every screen

#### Scenario: Any screen is opened

- GIVEN a signed-in user
- WHEN any screen renders
- THEN it SHALL sit beside a neutral branded sidebar, separated from the main column by a subtle border, with both content surfaces following the selected theme and a continuous dark-green brand row and topbar
- AND the main column SHALL carry a topbar, then a page head with an `h1` and the screen's one-line
  purpose, then the screen's content
- AND a detail screen's page head SHALL carry, above the `h1`, one link back to the list it was
  opened from (its *trail*), and a list screen SHALL carry none, because the sidebar already says
  where a list is
- AND the page head SHALL NOT repeat the selected application's name, which the picker already
  shows; it used to appear three times on every screen — picker, breadcrumb and eyebrow
- AND a screen SHALL render no heading of its own repeating that title, because a second heading
  with the same words reads as the page having started over

#### Scenario: The viewport narrows

- GIVEN a viewport at or under `1000px`
- WHEN the shell renders
- THEN the sidebar SHALL narrow and the page head SHALL stack

#### Scenario: The viewport is a phone

- GIVEN a viewport at or under `700px`
- WHEN the shell renders
- THEN the sidebar SHALL become an off-canvas drawer toggled by the labelled menu button in the
  topbar, the main column SHALL take the full width, and two-column form and stat grids SHALL
  collapse to one
- AND selecting a navigation entry SHALL close the drawer
- AND Escape and a backdrop control SHALL close it and restore focus to the menu button
- AND while open, keyboard focus SHALL remain within the drawer and background scrolling SHALL stop
- AND while closed, the drawer's controls SHALL be hidden from keyboard navigation

### Requirement: Route by parsing the address, with no router dependency

#### Scenario: A navigation happens

- GIVEN any in-portal link
- WHEN it is followed
- THEN it SHALL be handled by `history.pushState` and `popstate`, with the default click
  suppressed, so the address bar and the back button both work
- AND modified clicks SHALL retain the browser's native open-in-new-tab behavior
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

#### Scenario: An address names a panel within a screen

- GIVEN `/apis/:resourceId/:tab` — what the control plane writes into an attention row, so that the
  row about a policy that will not compile opens the policy panel
- WHEN it is matched
- THEN the workspace SHALL open on the named panel
- AND a panel name the workspace does not have SHALL be ignored rather than left blank
- AND a tab segment that is parsed off the address and discarded SHALL be treated as a defect,
  because every such row then lands the reader on the first panel and looks as though it worked

#### Scenario: Nothing matches

- GIVEN an address that matches no pattern
- WHEN it renders
- THEN the *Not found* screen SHALL be shown with its own title and purpose

#### Scenario: A screen is chosen for a matched address

- GIVEN any matched route
- WHEN the shell renders it
- THEN the component SHALL come from **one** registry keyed by route id, and there SHALL be exactly
  one rendering of any address
- AND the registry SHALL cover the table exactly — no route without a screen, and no screen without
  a route — and a test SHALL assert that in both directions
- AND the shell SHALL name no screen itself, neither by importing one nor by branching on the
  address, because a second place that chooses a screen is a second set of behaviour to keep true
  and the one nobody can reach is the one that quietly stops being true

#### Scenario: The root address is opened

- GIVEN `/`
- WHEN it resolves
- THEN it SHALL be the **selected application's** dashboard, for the selected environment
- AND there SHALL be no separate estate-wide home screen
- AND the reason SHALL be that the estate's own health is Health Status, which is a screen in the
  Global group and open to everybody, and two screens answering "how is it going" from different
  scopes is how two numbers come to disagree

### Requirement: Every screen has a title and a one-line purpose

The rule SHALL be enforced structurally rather than by review.

#### Scenario: A screen is rendered

- GIVEN any route
- WHEN the shell renders it
- THEN the title and the one-line purpose SHALL be taken from `ui/src/lib/routes.ts` and rendered
  by the shell
- AND the document title SHALL name that screen followed by Integration Portal
- AND a screen about one object MAY hand the shell that object's name once it has loaded, and the
  shell SHALL then use it as the `h1` and the document title in place of the route's title; until
  it has, the route's title SHALL stand in
- AND the shell SHALL provide a keyboard-visible skip link to the main content
- AND a screen SHALL therefore be unable to exist without them
- AND a test SHALL be able to assert the property over every route rather than over every component

#### Scenario: A workspace is open

- GIVEN an address that names one API, under any of the four listings it can be opened from
- WHEN the head renders
- THEN the title SHALL be the API's name and version once loaded, and *API* until then
- AND the trail SHALL link back to the listing the workspace was opened from — APIs, MCP Servers or
  A2A Agents — the same rule the sidebar's highlight follows
- AND four different APIs SHALL NOT arrive under one generic title, which left a reader with several
  tabs open unable to tell them apart

#### Scenario: A detail address and its list share a section

- GIVEN one subscription's address and the list of subscriptions
- WHEN each head renders
- THEN the detail SHALL be titled *Subscription* and the list *Subscriptions*
- AND the title SHALL come from the matched route and from nowhere else — never from a second map
  keyed by section, which cannot tell the two apart and leaves a reader who saw the plural
  concluding their link had taken them to the wrong place

### Requirement: Scope the shell to one application at a time

#### Scenario: An application is chosen

- GIVEN the application picker
- WHEN a different application is selected
- THEN the choice SHALL be remembered in `localStorage`
- AND a screen that belongs to an application SHALL stay open under the new one, so switching
  applications while comparing two of them does not throw the reader back to a dashboard every time
- AND a screen that is the same for everybody SHALL NOT move, because it is not about the
  application that changed
- AND a screen showing one *object* — an API's workspace, one subscription — SHALL fall back to the
  new application's dashboard, because that object belongs to the application that was selected and
  its id would not resolve under another

#### Scenario: The picker is populated

- GIVEN a signed-in user
- WHEN the picker renders
- THEN it SHALL list the applications they are a member of, and every application for an
  administrator
- AND applications SHALL come from the control plane, never from a hardcoded seed list

#### Scenario: The user is in no application

- GIVEN a signed-in member with no application memberships
- WHEN the picker renders
- THEN in its place the sidebar SHALL say "You are not in an application yet" with a link to their
  account, which explains how membership is granted
- AND it SHALL NOT render a disabled picker, which says nothing about why it cannot be opened

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
- THEN it SHALL show the brand, the application picker, then an untitled group of the application's
  own record (Dashboard · Mail · Activity), then these groups in order:
  **API** (APIs · MCP Servers · A2A Agents · Products · Subscriptions · Approvals · Credentials),
  **Kafka** (Kafka Topics · Kafka REST Proxy),
  **Global** (Catalog · Health Status · How this works)
- AND **Administration** (External systems · Gateways · Gateway settings · Applications · People ·
  Telemetry · Global policy · Trust · Audit) SHALL be shown only to an administrator
- AND there SHALL be no catch-all group: an "Other" group was where a screen went when nobody had
  decided where it belonged, and every screen in it has a home
- AND FixMe SHALL NOT have an entry of its own: it diagnoses and repairs a deployment, which is the
  second half of Health Status's question, and it is a section of that screen (see
  `integrations-and-mocks`); its old address `/fixme` SHALL resolve to Health Status
- AND the console of surrounding systems SHALL be labelled *External systems* rather than
  *Integrations*, which reads as a development slug for the thing this portal is, and SHALL be an
  administrator's — a member meets each system where it matters to them, not as a list of transports
- AND no two entries SHALL share an icon, because an icon that stands for two screens tells a reader
  scanning the sidebar nothing
- AND every entry SHALL be derived from the route table's own `nav` grouping, with no second list
  of labels beside it; each entry SHALL declare its meaningful outline icon in that same metadata — a screen leaves the navigation by losing its `nav` and in no other way
- AND every screen the table marks admin-only SHALL be in the Administration group and every screen
  in that group SHALL be admin-only, so a gated screen cannot be listed where a member would press
  it and receive a refusal
- AND the gate SHALL be on the **link**: the control plane refuses what it must on every request,
  and a screen that is open to everybody with an admin-only panel inside it says so itself

#### Scenario: The user footer renders

- GIVEN a signed-in user
- WHEN the sidebar footer renders
- THEN it SHALL show their display name, the word *Administrator* or *Member*, and a sign-out
  button
- AND the name SHALL be the link to *Your account*, which SHALL have no sidebar entry of its own —
  an entry beside the name was the same link twice
- AND the word SHALL be *Member* rather than *Developer*, because membership of an application is
  what the authorization rule turns on, and not everybody in an application writes code
- AND signing out SHALL follow the identity provider's end-session URL when the control plane
  returns one, and otherwise reload the portal

### Requirement: The topbar answers four standing questions

#### Scenario: Activity is opened

- GIVEN the selected application's operations
- WHEN Activity renders
- THEN it SHALL offer All changes and In progress filters, each with a count, as one segmented
  control
- AND In progress SHALL use the same state definition as the topbar count, excluding complete and superseded operations
- AND an empty In progress view SHALL offer a return to All changes
- AND each change SHALL say what happened in words — *Published*, *Settings changed*, *Promoted* —
  rather than the operation's `kind`, with its environment, when, its state and any error
- AND the API it changed SHALL link to that API's workspace wherever the API still exists

#### Scenario: The topbar renders

- GIVEN any screen
- WHEN the topbar renders
- THEN it SHALL show a chip saying *External systems simulated*, whose tooltip names them, the
  portal version as a **button**, a light/dark toggle drawn as an icon with an accessible name, a
  link to Activity while deployments are in progress, and the notifications bell
- AND it SHALL NOT show a breadcrumb: `<application> / <screen title>` repeated what the picker and
  the page head were already saying a few centimetres away

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
- THEN the activity count SHALL count operations that are neither `complete` nor `superseded`,
  SHALL say what it counts ("2 changes rolling out") and SHALL be a link to Activity
- AND it SHALL be absent when that count is zero, because a permanent "0" beside the bell read as a
  second, broken notification count
- AND the bell SHALL count **unread** notifications, which is a different question, and SHALL open
  a popover rather than a parallel toast stack

#### Scenario: The theme is toggled

- GIVEN the light/dark toggle
- WHEN it is pressed
- THEN the choice SHALL be applied to the document and remembered in `localStorage`

### Requirement: Offer the environment switcher on every screen that has one

#### Scenario: The page head renders

- GIVEN a route marked `environmentScoped` in the route table and the promotion chain
- WHEN the page head renders
- THEN a labelled segmented control SHALL offer every environment in chain order, with the current
  one marked active
- AND changing it SHALL change what the screen below shows, without navigating
- AND the active environment SHALL be exposed as pressed to assistive technology
- AND an environment the object on screen is not in SHALL be disabled rather than hidden, with the
  reason written as a line under the control and not only as a tooltip, which a keyboard and a
  touch screen never see
- AND every environment switcher in the portal — the shell's and any a screen draws for itself —
  SHALL be the same control and SHALL write environments the same way (`DEV`, `TEST`, `PROD`)
- AND pages that show all environments, an object's fixed environment, or no environmental data
  SHALL omit the shell switcher, rather than offer a control that does not change the page

#### Scenario: A publishing screen is open

- GIVEN the APIs, MCP Servers, A2A Agents or Dashboard section, with no resource open
- WHEN the page head renders
- THEN a primary **Publish API** action SHALL be offered, as a link, because it goes somewhere
- AND from MCP Servers or A2A Agents it SHALL carry the kind, so the wizard opens on the right one,
  and SHALL say *Publish MCP server* or *Publish A2A agent*

### Requirement: Reach the catalogue from anywhere

#### Scenario: A consumer looks for a resource

- GIVEN any signed-in user
- WHEN they open Catalog from the Global group
- THEN they SHALL see every REST or SOAP API, MCP server and A2A agent they are allowed to see,
  across applications, browsable by domain and searchable across domains
- AND Kafka topics SHALL be represented in the domain counts and linked to Kafka
- AND opening one resource SHALL show a read-only listing with what it does and how to subscribe — never the
  publisher's editor
- AND the Global group SHALL offer **one** Catalog entry: the shell used to draw a second
  cross-application list of its own, and two entries under one label is a choice the reader cannot
  make
- AND the address that second list answered on SHALL still resolve, to the one catalogue

### Requirement: Refuse to lose an unsaved edit

#### Scenario: A user navigates away from a dirty editor

- GIVEN unsaved changes in a definition, a policy, properties or any other workspace form
- WHEN the user follows a link, uses the back button, switches environment or switches application
- THEN the shell SHALL ask, in its own dialog, whether to stay or discard the changes, naming what
  would be lost, before anything is lost
- AND a reload or a closed tab SHALL raise the browser's own leave-page prompt
- AND the warning SHALL NOT use `confirm()`

### Requirement: Keep one live ticker for the whole shell

There SHALL be exactly one background clock in the shell. A screen or a widget SHALL NOT run a
second interval of its own for the same purpose.

#### Scenario: Something changes without an operation

- GIVEN a subscription moving from revoking to revoked, which adds no operation row
- WHEN the workspace is open
- THEN it SHALL refresh from the shell's live ticker rather than from the operation count
- AND a transient state SHALL NOT persist until a full reload

#### Scenario: Nothing is in flight

- GIVEN a portal with no operation still reaching the gateways
- WHEN the ticker runs
- THEN its interval SHALL be the idle one, which SHALL be at least an order of magnitude longer
  than the busy one
- AND the queries that hang off the tick — operations, notifications, resources, products,
  subscriptions — SHALL therefore be issued at that slower cadence rather than every few seconds,
  because a hundred idle portals otherwise poll the control plane continuously for answers that
  have not changed

#### Scenario: An operation is still reaching the gateways

- GIVEN at least one operation that is neither complete nor superseded
- WHEN the ticker runs
- THEN its interval SHALL be the busy one, so a promotion converging is watched as it happens
- AND it SHALL return to the idle interval when the last one finishes

#### Scenario: The tab is hidden

- GIVEN a portal in a background tab
- WHEN the ticker runs
- THEN it SHALL stop entirely, because a hidden tab is nobody watching
- AND on becoming visible it SHALL refresh **once** immediately rather than replay the ticks it
  slept through

#### Scenario: A selected application is reloaded

- GIVEN an authorized application was selected through the picker or an application-prefixed address
- WHEN the browser reloads a global page
- THEN the picker SHALL restore that application from local storage
- AND a stored application outside the current user's permitted choices SHALL fall back to an allowed application
