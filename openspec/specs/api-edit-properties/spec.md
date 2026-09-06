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
- AND for a SOAP resource the WSDL's services and ports SHALL be summarised beside it
- AND for an MCP or A2A resource the discovered tools or skills SHALL be summarised beside it

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
- THEN every URL SHALL be checked against the egress allowlist, and a refusal SHALL name the rule
- AND the same reader SHALL be used as on publish, so a pool cannot mean one thing in the wizard
  and another here

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
- AND the workspace SHALL show the deployment progress rather than claiming the change is live
- AND the saved values SHALL be reflected locally straight away, so the form does not appear to
  have lost them

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
