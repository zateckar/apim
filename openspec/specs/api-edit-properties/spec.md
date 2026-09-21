# api-edit-properties Specification

## Purpose

Define the API workspace: the eight panels a publisher works in, what each one may change, and how
an edit becomes a revision. See *Published Path Derivation* and *The Authorization Rule* in
`openspec/project.md`.

## Requirements

### Requirement: Open one workspace with eight panels, in reading order

#### Scenario: The workspace is opened

- GIVEN a resource the caller may see
- WHEN its workspace opens
- THEN it SHALL offer, in this order: **definition**, **properties**, **policies**,
  **subscriptions**, **playground**, **logs**, **revisions**, **history**
- AND the panel SHALL be selected by a segmented control, and the definition SHALL be the default
- AND History SHALL show each operation once, without a second deployment-progress panel repeating its entries

#### Scenario: Another version of the same API is opened

- GIVEN a resource with more than one version
- WHEN the workspace renders
- THEN the version selector SHALL sit in the workspace head beside **New version**, sized to its
  value
- AND it SHALL NOT be a page-wide field under the summary line, because switching version is
  navigation between siblings rather than a property of the API on screen
- AND a resource with one version SHALL show no selector at all

#### Scenario: A link lands on a specific panel

- GIVEN an address carrying `?tab=<name>`, which the portal's own screens write, or
  `/apis/:resourceId/<name>`, which the control plane writes into an attention row
- WHEN the workspace opens
- THEN that panel SHALL be selected, provided the name is one of the eight
- AND a name that is not SHALL be ignored, opening the definition rather than a blank panel
- AND this SHALL be how the dashboard's traffic table opens Logs and an attention row opens Policies

#### Scenario: An attention row names a problem rather than a panel

- GIVEN an attention href of `/apis/:id/policy`, `/apis/:id/routing` or `/apis/:id/publish` — names
  older than this workspace, which say what is wrong rather than which panel fixes it
- WHEN the workspace opens
- THEN `policy` SHALL open **Policies**, and `routing` and `publish` SHALL open **Properties**,
  which is where the route, the gateways and the backend pool are
- AND the translation SHALL happen in the portal rather than by renaming the control plane's hrefs,
  because a stored href is somebody's open tab
- AND an address whose panel segment is parsed off and discarded SHALL be treated as a defect: every
  such row then lands on the definition, and looks as though the link worked

#### Scenario: The environment is switched

- GIVEN the workspace open in one environment
- WHEN the environment switcher changes
- THEN the workspace SHALL reload for the new environment
- AND everything that is per-environment — the backend, the route, the policy, the release — SHALL
  be re-read rather than carried across

#### Scenario: A stage the API has not reached

- GIVEN a resource that exists in some stages of the chain and not others
- WHEN the workspace is open
- THEN the environment switcher SHALL disable the stages it is not in, each saying that a version
  reaches a stage by being promoted into it from the one before
- AND the whole chain SHALL still be drawn, because a chain drawn short misstates how many stages
  the estate has
- AND the **selected** stage SHALL stay operable whatever the answer, so a reader who arrived at a
  stage the API is not in is never looking at a disabled control that is also the current one
- AND the set SHALL be read per resource rather than per environment, so switching stage does not
  re-shape the control doing the switching, and it SHALL follow a promotion without a reload
- AND while the set is unknown — not yet read, or the read failed — every stage SHALL be offered,
  because a switcher that greys out mid-request is worse than one that offers a stage the screen
  then explains it is not in

### Requirement: Load the workspace from one endpoint

#### Scenario: The workspace payload is fetched

- GIVEN a resource id and an environment
- WHEN the workspace loads
- THEN it SHALL read `GET /api/resources/:id/editor?environment=<env>`
- AND the payload SHALL carry the resource — including its `docsUrl` — its current revision, its
  route, its binding, its policy, its release state and the caller's capabilities

### Requirement: Gate every write to the owning application, visibly

#### Scenario: A reader who cannot edit opens the workspace

- GIVEN a signed-in user who is not a member of the owning application and is not an administrator
- WHEN the workspace renders
- THEN every editing control SHALL be **disabled with a reason**, not hidden
- AND the reason SHALL name the owning application by its display name
- AND the definition, operations and release state SHALL still be readable

#### Scenario: A per-environment detail is hidden from a non-owner

- GIVEN a non-owner
- WHEN they open a panel carrying the backend pool or the policy
- THEN they SHALL be told those belong to the owning application and are not shown outside it
- AND the reason SHALL be stated rather than the panel left empty

### Requirement: Edit the definition in place, with local validation

#### Scenario: The definition panel renders

- GIVEN a resource with a current revision
- WHEN the definition panel opens
- THEN the definition SHALL be shown in the shared code editor, with syntax highlighting
- AND the editor SHALL have a bounded height and scroll within itself, rather than growing to the
  length of whatever document is in it
- AND what the definition declares SHALL be shown **beside** it on a wide viewport and below it on
  a narrow one, so the two readings of one document can be compared without scrolling past a
  thousand lines to reach the second
- AND for a SOAP resource this SHALL be the WSDL's operations
- AND for an MCP or A2A resource it SHALL be the discovered tools or skills
- AND the reason for the cap SHALL be that an uncapped editor put the operation list off the end of
  a page that took a minute to scroll

#### Scenario: A definition is edited

- GIVEN an edited definition
- WHEN it is checked before saving
- THEN it SHALL be validated locally in the browser, and the errors SHALL be shown against the
  document rather than only after a failed save

#### Scenario: A definition is saved

- GIVEN a valid edited definition
- WHEN it is saved
- THEN a **new revision** SHALL be written rather than the current one mutated
- AND the operation index and the compiled validator artifacts SHALL be rebuilt from it
- AND the revision SHALL not be serving anywhere until it is released

### Requirement: Show the operations the definition declares

#### Scenario: Operations are listed

- GIVEN a normalized model
- WHEN the operations panel renders
- THEN each operation SHALL be shown with its method, path template (or SOAP element, or RPC
  selector), operation id and summary
- AND each SHALL show whether it is validated, and when it is not, whether that is because it has
  no schema or an unsupported one
- AND "not validated" SHALL therefore be visible rather than assumed

### Requirement: Edit the description as Markdown, with a preview

#### Scenario: The properties panel renders the description

- GIVEN the properties panel
- WHEN the description field renders
- THEN it SHALL use the shared Markdown editor: a source textarea with a formatting toolbar and a
  Preview rendered through the same component readers see
- AND the field SHALL NOT be wrapped in a `<label>`, which would forward every toolbar press to the
  textarea as a second activation

### Requirement: Carry exactly one documentation link

#### Scenario: A documentation link is set

- GIVEN the Documentation link field
- WHEN a value is saved
- THEN it SHALL be stored on the resource's own `docs_url` column
- AND it SHALL be validated as an absolute `http` or `https` URL of at most 500 characters, with a
  message showing an example
- AND an empty value SHALL clear it, and an absent value SHALL leave it unchanged

#### Scenario: A documentation link is shown

- GIVEN a resource with a documentation link
- WHEN the workspace and the catalogue listing render
- THEN both SHALL offer it as a single **Open wiki** deep link beside the description
- AND there SHALL be exactly one such link, because the question a consumer has after the
  description is "where do I read more", and two answers to it means one of them is stale

#### Scenario: The link is not routing

- GIVEN a documentation link
- WHEN the configuration document is built
- THEN it SHALL NOT appear in it, because it is catalogue metadata and never reaches a gateway

### Requirement: Edit the backend as a pool

#### Scenario: The backend panel renders

- GIVEN a resource with one backend
- WHEN the panel renders
- THEN it SHALL read as a single field, labelled with the current environment
- AND a second member SHALL appear only when somebody asks for one, with the load-balancing rule
  offered alongside

#### Scenario: A backend URL is saved

- GIVEN an edited pool
- WHEN it is saved
- THEN every URL SHALL be checked against the denied ranges and the deny rules, and a refusal SHALL
  name what matched
- AND the same reader SHALL be used as on publish, so a pool cannot mean one thing in the wizard
  and another here

### Requirement: Lay the properties panel out as sections, not as nested cards

#### Scenario: The properties panel renders

- GIVEN the properties panel
- WHEN it renders
- THEN it SHALL be three headed sections — catalog information, backends for this environment, and
  the published address — rather than three cards inside the workspace's own card
- AND each coherent set of fields SHALL sit on one tinted group surface, and a group SHALL NOT be
  nested inside another group
- AND the reason SHALL be that the tint used to appear on the domain pair alone, which made the one
  group that carried it look arbitrary rather than meaningful

#### Scenario: The public path is shown

- GIVEN a base path derived from the domain, the sub-domain and the API's name
- WHEN it renders
- THEN it SHALL be read-only **and look read-only**, and SHALL sit in the same group as the two
  controls that decide it
- AND its hint SHALL say what it is built from, so a reader who wants to change it knows where to go

#### Scenario: The gateways are chosen

- GIVEN an environment served by one or more gateways
- WHEN the gateway control renders
- THEN each gateway SHALL list the **final** addresses an API answers on — the gateway's published
  hostname with the base path appended — and one line per address, since a gateway reachable from
  inside and outside the network has two names
- AND there SHALL be exactly one list: the bare origins and the addresses-with-path SHALL NOT be
  drawn as two controls, which printed every URL twice, differing only in the part worth reading
- AND an environment with a single gateway SHALL state it and its addresses rather than offer a
  checkbox that cannot be unticked
- AND an environment with no gateway SHALL say so and name who adds one

### Requirement: Change the taxonomy without breaking the address

#### Scenario: The domain is changed

- GIVEN a resource with a base path under its current domain's prefix
- WHEN the domain or sub-domain is changed
- THEN the base path SHALL be re-derived, or the save SHALL be refused with a message naming the
  new prefix
- AND a path that ends up outside the domain's prefix SHALL never be stored

#### Scenario: A version segment would be doubled

- GIVEN a stored path and an API version
- WHEN the path is written
- THEN a trailing version segment SHALL be stripped
- AND the reason SHALL be that `/sales/orders/v2/v2` is not a cosmetic problem: it is an address
  nothing serves

### Requirement: Save properties as a durable configure operation

#### Scenario: Properties are saved

- GIVEN edited properties
- WHEN Save is pressed
- THEN a `configure` operation SHALL be queued with an `Idempotency-Key`, and `202` returned
- AND the workspace SHALL say that saving deploys rather than claiming the change is live
- AND the saved values SHALL be reflected locally straight away, so the form does not appear to
  have lost them

#### Scenario: A deployment is in progress

- GIVEN one or more operations this API has not finished deploying
- WHEN the workspace renders
- THEN the progress table SHALL appear on the History panel and on no other panel
- AND every other panel SHALL carry at most one sentence saying how many changes are still reaching
  the gateways, linking to History
- AND completion SHALL be announced through the notification feed (`operation.complete`) rather
  than by a table the reader has to be looking at
- AND the reason SHALL be that a rollout table under the definition editor, the playground and the
  log search is a table about something else on every screen but the one named after it

#### Scenario: Nothing changed

- GIVEN a save with no differences
- WHEN it is submitted
- THEN it SHALL be accepted idempotently rather than producing a second identical revision

### Requirement: Show the history of a resource, and roll back from it

#### Scenario: The history panel renders

- GIVEN a resource
- WHEN the history panel opens
- THEN it SHALL list what changed, by whom and when, drawn from the audit trail and the operation
  log
- AND every timestamp SHALL be formatted by the shared helpers, in `DD.MM.YYYY HH:MM:SS`

#### Scenario: A previous revision is restored

- GIVEN a revision that was previously live in this environment
- WHEN a rollback is requested
- THEN it SHALL be released again as a new release rather than the history rewritten
- AND the revision list SHALL mark which revisions are rollback targets — live, was live, or never
  released here
