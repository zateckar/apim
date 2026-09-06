# api-publish-flow Specification

## Purpose

Define how an API becomes a published thing: the three questions the wizard asks, what the control
plane refuses, and what one publish creates. See *Published Path Derivation*, *The Taxonomy* and
*Base Path Matching* in `openspec/project.md`.

## Requirements

### Requirement: Ask the three publishing questions one at a time

The publish form SHALL be a three-step wizard: **Identify**, **Define**, **Route and sell**.

#### Scenario: The wizard opens

- GIVEN a member of an application
- WHEN they open the publish wizard
- THEN a stepper SHALL show all three steps, and the first SHALL be active
- AND steps beyond the furthest reachable one SHALL be **disabled rather than hidden**, so the
  shape of what is being asked is visible from the first screen

#### Scenario: A step is incomplete

- GIVEN a step whose answers are not yet sufficient
- WHEN it renders
- THEN the reason SHALL be shown as a sentence on the screen — "Still needed: …" — and the Next
  action SHALL be disabled
- AND the reason SHALL NOT live only in a disabled button's tooltip, which is a reason nobody can
  read on a phone

#### Scenario: Enter is pressed on a middle step

- GIVEN the wizard on any step but the last
- WHEN the form is submitted
- THEN it SHALL advance to the next step rather than publish
- AND the reason SHALL be that a form that submits from the middle is how somebody publishes an API
  they had not finished describing

#### Scenario: A completed step is revisited

- GIVEN a reachable earlier step
- WHEN the stepper entry or Back is used
- THEN it SHALL be opened with its answers intact
- AND going back SHALL always be allowed, because nothing is submitted until the last step

### Requirement: Ask for the address first

Step one SHALL ask only for what forms the published address.

#### Scenario: Step one is answered

- GIVEN the Identify step
- WHEN it renders
- THEN it SHALL ask for the API name, the type (`REST`, `SOAP`, `MCP`, `A2A`), the version, and the
  domain with its optional sub-domain
- AND a live preview of the resulting published path SHALL be shown
- AND the step SHALL explain that the domain is the first segment of the address and the version
  the last, which is what makes the catalogue browsable and a URL legible without looking anything
  up

#### Scenario: Step one is validated

- GIVEN the Identify step
- WHEN it is checked
- THEN the name SHALL match `^[a-z0-9][a-z0-9-]{1,60}$` — "2–61 lowercase letters, digits or
  hyphens"
- AND the version SHALL match `^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$`
- AND a domain SHALL be required, with no "unclassified" escape, because a catalogue you cannot
  browse by domain is a list and one API without a domain makes the grouping incomplete

### Requirement: Take the definition from a paste, a file or a URL

#### Scenario: Step two is answered

- GIVEN the Define step
- WHEN it renders
- THEN it SHALL offer either "Upload or paste definition" or "Import from URL"
- AND the URL field SHALL be labelled **Discovery URL** for `mcp` and `a2a`, and **Definition URL**
  otherwise
- AND a pasted or uploaded definition SHALL be edited in the shared code editor
- AND the step SHALL also carry the description (as Markdown) and one optional documentation link

#### Scenario: A definition is imported from a URL

- GIVEN an import URL
- WHEN the control plane fetches it
- THEN the URL SHALL be checked against the egress allowlist before any request is made
- AND a refused host SHALL produce a `400` naming the rule

#### Scenario: A definition is normalized

- GIVEN a Swagger 2.0, OpenAPI 3.0/3.1, WSDL 1.1, MCP manifest or A2A agent card
- WHEN it is imported
- THEN it SHALL be normalized into the single `ApiModel`, and everything downstream SHALL read that
  model rather than the upload
- AND the original format SHALL be recorded, so the source document can still be described

#### Scenario: A definition exceeds the cap

- GIVEN an upload larger than `MAX_SPEC_BYTES`
- WHEN it is submitted
- THEN it SHALL be refused

### Requirement: Ask where it forwards and what it is sold in, last

#### Scenario: Step three is answered

- GIVEN the Route and sell step
- WHEN it renders
- THEN it SHALL ask for the backend URL in the first environment of the chain, the product, and
  which of the environment's gateways the API answers on
- AND the published path preview SHALL be shown again, now per selected gateway

#### Scenario: A product is chosen or created

- GIVEN the product field
- WHEN it renders
- THEN it SHALL offer the application's own **active** products, plus "Create a product"
- AND a chosen product SHALL be refused unless it is active and owned by the same application
- AND a new product name SHALL match the same pattern as an API name, and SHALL be refused with
  `409` if the name already exists

#### Scenario: Gateways are chosen

- GIVEN an environment with several gateways
- WHEN the selection is read
- THEN an absent selection SHALL mean **every** gateway the environment has, which is what
  publishing meant before an environment could hold more than one
- AND an explicitly **empty** selection SHALL be refused rather than quietly widened, because
  "published on no gateway" is an API with an address nobody can reach
- AND an environment with no gateway at all SHALL be refused with a message saying an administrator
  adds one on the Gateways screen

### Requirement: Derive the base path from the taxonomy, and refuse one outside it

#### Scenario: No base path is given

- GIVEN a domain, an optional sub-domain, a name and a version
- WHEN the base path is derived
- THEN it SHALL be `publishedPath({domain, subdomain, name, apiVersion})`
- AND the stored path SHALL NOT carry the version segment, which the gateway appends from the API's
  own `apiVersion`

#### Scenario: An explicit base path is given

- GIVEN a base path the publisher supplied
- WHEN it is validated
- THEN it SHALL be normalized, and it SHALL be under the domain's prefix — equal to it, or starting
  with it followed by `/`
- AND otherwise it SHALL be refused with a message naming the path, the prefix and the domain
- AND the reason SHALL be that two APIs in different domains could otherwise answer on the same URL
  and the catalogue's grouping would stop being a fact about the estate

#### Scenario: The address is already taken

- GIVEN an existing route with the same environment, host and base path
- WHEN a publish is attempted
- THEN it SHALL be refused, because `route` carries `UNIQUE(environment, host, base_path)`

### Requirement: Publish only into the first environment of the chain

#### Scenario: A new API is published

- GIVEN any publish
- WHEN the target environment is decided
- THEN it SHALL be the first environment of `PROMOTION_CHAIN`, and the wizard SHALL say so on its
  final action
- AND reaching any later environment SHALL be a promotion, never a second publish

### Requirement: Refuse a duplicate API within an application

#### Scenario: The same name and version already exist

- GIVEN an application that already publishes `<name>` at `<version>`
- WHEN the same pair is published again
- THEN it SHALL be refused with `409` saying the API name and version already exist

### Requirement: Validate the backend before accepting it

#### Scenario: A backend URL is given

- GIVEN a backend URL
- WHEN it is validated
- THEN it SHALL be checked against the egress allowlist
- AND an absent backend SHALL be refused with "backendUrl is required for `<ENVIRONMENT>`"

#### Scenario: A single URL and a pool are both accepted

- GIVEN `backendUrl`, or `pool` with a `rule`
- WHEN either is read
- THEN both SHALL land on the same reader, so a pool cannot mean one thing on publish and another
  on the properties form
- AND a single `backendUrl` SHALL become a one-member pool with the `failover` rule

#### Scenario: A client certificate is named

- GIVEN a `clientCertRef`
- WHEN it is validated
- THEN the certificate SHALL exist, belong to the same environment, be unexpired, belong to the
  API's own application, and be one the caller may use
- AND otherwise the publish SHALL be refused, naming which of those failed

### Requirement: Require a subscription key by default, and let only an administrator remove it

#### Scenario: An API is published with no policy

- GIVEN a publish that carries no policy document
- WHEN the policy is decided
- THEN it SHALL be `{"auth.subscriptionKey": {"in": "header", "name": "X-Api-Key"}}`

#### Scenario: A non-administrator changes the subscription-key unit

- GIVEN a member who is not an administrator
- WHEN their document carries an `auth.subscriptionKey` value different from the current one
- THEN it SHALL be refused, saying only an administrator can change whether this API requires a
  subscription key
- AND the reason SHALL be that an open route is the one policy change whose blast radius is the
  whole internet, and the owner is exactly the person with a reason to want it

#### Scenario: A non-administrator saves something unrelated

- GIVEN a member saving a description, a backend or a gateway selection
- WHEN the document does **not** carry the `auth.subscriptionKey` key at all
- THEN the save SHALL succeed, keeping whatever the unit was
- AND absence SHALL NOT be read as an attempt to remove it

### Requirement: Publish as one durable operation, all or nothing

#### Scenario: A publish is accepted

- GIVEN a valid publish request with an `Idempotency-Key`
- WHEN it is accepted
- THEN in one transaction it SHALL create the resource, its first revision, its route, its gateway
  bindings, its backend binding, its policy and — when asked — its product
- AND an `operation` SHALL be queued and `202` returned
- AND the caller SHALL be returned to the API's workspace, where deployment progress is visible

#### Scenario: Any part fails

- GIVEN a publish where any step is refused
- WHEN it fails
- THEN nothing SHALL be written, because the whole publish is one transaction
- AND the refusal SHALL name what failed in the `detail` of a problem document

#### Scenario: The publish is retried

- GIVEN the same `Idempotency-Key` and the same request
- WHEN it arrives again
- THEN the original operation SHALL be returned and nothing duplicated

### Requirement: Preview exactly what a consumer will call

#### Scenario: The preview renders

- GIVEN the chosen gateways and the derived path
- WHEN the preview renders
- THEN it SHALL show the published URL per gateway, composed from the gateway's public hostname and
  the derived path
- AND it SHALL be derived by the **same function** the control plane validates against, so what the
  preview says is what the gateway will answer on
