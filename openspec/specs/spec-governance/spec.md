# spec-governance Specification

## Purpose

Define the repository rule that OpenSpec documents are maintained as the authoritative behavioural
contract for this system — both planes and the portal — and that a mismatch between code and spec
is a defect rather than a note for later.

## Requirements

### Requirement: Update specs in the same change as implementation

Every code change that alters the behaviour of the system SHALL update the affected OpenSpec files
in the same change set.

#### Scenario: Existing capability changes

- GIVEN a developer changes an existing module in `control-plane/`, `data-plane/`, `shared/` or `ui/`
- WHEN that change affects behaviour, UX, API contracts, validation, configuration, routing, the
  gateway configuration document, or styling semantics
- THEN the corresponding `openspec/specs/*/spec.md` files SHALL be updated in the same change
- AND when the change touches topology, the route map, the endpoint map, a canonical algorithm, a
  constant or an environment variable, `openspec/project.md` SHALL be updated in the same change

#### Scenario: A change spans both planes

- GIVEN a change alters `shared/config-doc.ts`, `shared/policy.ts` or the poll contract
- WHEN it lands
- THEN the specs for **both** the deciding capability and `data-plane-gateway` SHALL be updated,
  because a contract that only one side's spec describes is a contract the other side may drift
  from

### Requirement: Add new specs for new capabilities

New capabilities SHALL NOT be introduced without corresponding OpenSpec coverage.

#### Scenario: New module or feature area

- GIVEN a code change introduces a materially new capability or module
- WHEN no current spec fully covers that behaviour
- THEN a new capability spec SHALL be added under `openspec/specs/<capability>/spec.md`
- AND it SHALL follow the format: `## Purpose`, then `## Requirements`, then
  `### Requirement: <imperative sentence>` each followed by one or more `#### Scenario: <name>`
  written as `GIVEN / WHEN / THEN / AND` bullets using RFC 2119 `SHALL`

#### Scenario: A capability spec is being stretched

- GIVEN a new capability could be described by appending requirements to an existing spec
- WHEN the new behaviour has its own vocabulary, its own screens or its own contract
- THEN a new spec directory SHALL be added rather than the existing spec stretched

### Requirement: Delete requirements when behaviour is deleted

A removed behaviour SHALL leave no requirement behind.

#### Scenario: A feature is withdrawn

- GIVEN a feature, screen, endpoint or policy unit is removed from the code
- WHEN the change lands
- THEN its requirements and scenarios SHALL be deleted from the spec in the same change
- AND a spec left describing behaviour the system no longer has SHALL be treated as drift

### Requirement: Treat spec drift as a bug

Mismatch between implementation and spec SHALL be considered a repository defect.

#### Scenario: Code and spec disagree

- GIVEN current implementation behaviour differs from the documented requirement or scenario
- WHEN the discrepancy is identified
- THEN the change SHALL NOT be considered complete until the implementation or the spec is
  corrected so they align

### Requirement: Verify specs against the real system state

Specs SHALL be maintained against actual code and, when relevant, test or runtime behaviour rather
than intent-only descriptions.

#### Scenario: Behaviour verification

- GIVEN a spec is being created or updated
- WHEN the author validates its accuracy
- THEN they SHALL use the current source as the minimum authority
- AND they SHOULD also use `test/`, `ui/test/`, `e2e/` or a running stack when those are needed to
  confirm the exact current behaviour

### Requirement: Keep OpenSpec as the behavioural source of truth

OpenSpec SHALL describe how the system currently behaves closely enough to drive future
implementation work and brownfield reconstruction.

#### Scenario: Future implementation change

- GIVEN a future change is planned or reviewed
- WHEN engineers consult the repository
- THEN `openspec/` SHALL be the **only** place that states the expected system behaviour
- AND `README.md` SHALL carry the operator's half — running, deploying, sizing, backing up and
  upgrading — and SHALL NOT restate a contract `openspec/` already holds, because a contract stated
  twice is a contract that drifts
- AND design history SHALL live in git rather than in a directory of documents beside the specs,
  because a plan kept alongside a contract is read as though it were one

### Requirement: Carry no vocabulary from a superseded platform

The specs SHALL describe this system's own control plane and gateways, and SHALL NOT carry
concepts from the third-party API-management product this system replaced.

#### Scenario: A superseded concept appears in a spec

- GIVEN a spec mentions a management-plane ARM resource, a policy XML document, a revision
  semantic, a vaulted secret store or a tag-derived application
- WHEN that is noticed
- THEN it SHALL be treated as a porting bug and the spec corrected to describe the control plane's
  own model — `resource`, the native policy vocabulary, `revision` and `release`, the encrypted
  columns behind `KEK_PATH`, and `application` with explicit memberships
