# workspace-api-catalog Specification

## Purpose

Define the two lists of APIs: **My APIs**, the ones an application publishes, and the **Catalog**,
the marketplace over everything a caller is allowed to see. The catalogue is a read model over what
already exists and deliberately not a second source of truth.

## Requirements

### Requirement: List an application's own published things

#### Scenario: The APIs section is opened

- GIVEN a selected application
- WHEN the APIs, MCP Servers or A2A Agents section renders
- THEN it SHALL list that application's resources of that kind, with the name, the kind, the
  version, the lifecycle chip and where each version is live
- AND the list SHALL be scoped to the selected application, not to the whole estate

#### Scenario: The application publishes nothing yet

- GIVEN an application with no resources
- WHEN the list renders
- THEN an empty state SHALL be shown naming the next action — publishing a first API
- AND the section SHALL still be present, because sections follow capability rather than inventory

#### Scenario: A row is opened

- GIVEN a row in the application's own list
- WHEN the name is activated
- THEN the API **workspace** SHALL open — the publisher's editor
- AND a row in the cross-application Catalog SHALL instead open the read-only listing

### Requirement: Decide catalogue visibility by three rules

#### Scenario: A resource has reached a fleet

- GIVEN a resource with at least one converged release
- WHEN the catalogue is read by anybody
- THEN it SHALL be visible

#### Scenario: A resource has not been released yet

- GIVEN a resource with no converged release
- WHEN the catalogue is read
- THEN it SHALL be visible only to people who own it, badged as unpublished
- AND the reason SHALL be that a publisher otherwise cannot see their own work until they release it

#### Scenario: A resource is unlisted

- GIVEN a resource marked `unlisted`
- WHEN the catalogue is read
- THEN it SHALL be visible only to people who own it, whatever its release state
- AND the same switch SHALL make an A2A agent's card private, so it is one decision rather than two

### Requirement: Answer "where is this live" from releases, never from typed text

#### Scenario: A listing shows its environments

- GIVEN a listing
- WHEN its environments are rendered
- THEN they SHALL be derived from `release`, not from any field a publisher types
- AND the reason SHALL be that a listing which could disagree with the thing it lists would be
  worse than no listing

### Requirement: Group the catalogue by domain

#### Scenario: The Catalog screen renders

- GIVEN the catalogue
- WHEN it is grouped
- THEN it SHALL be grouped by **domain**, not by application
- AND the domain list SHALL be presented in taxonomy order with "Other" last, rather than ordered by
  count
- AND the reason SHALL be that the domain list is a fixed structure the estate is filed into: a
  domain that happens to be empty today still belongs in it, and one that reorders itself as APIs
  are published is not a structure

#### Scenario: Facet counts are computed

- GIVEN the facets endpoint
- WHEN counts are produced for kinds, tags, applications, environments and domains
- THEN each SHALL be counted over the **visible** set, so every facet answers the same question as
  the filter it drives
- AND a count over the whole table SHALL NOT be used, which would count an unlisted resource for a
  caller who cannot see it — both a small leak and a number the filter then contradicts

#### Scenario: Kafka topics are counted beside APIs

- GIVEN domains that hold both APIs and Kafka topics
- WHEN domain facets render
- THEN topics SHALL be counted in the same taxonomy
- AND the reason SHALL be that a domain reading "11 APIs" while holding four topics is describing
  half an estate

### Requirement: Search, filter and sort the catalogue

#### Scenario: A search is run

- GIVEN a query
- WHEN it is ranked
- THEN results SHALL be ranked by relevance by default, with `name`, `newest` and `popular` also
  offered
- AND filtering SHALL be available by kind, domain, tag, application and environment

#### Scenario: The result set is very large

- GIVEN more candidates than the ranking ceiling of 2000
- WHEN the search runs
- THEN the response SHALL report `truncated: true`
- AND truncation SHALL be reported from the **candidate** query rather than from the surviving
  count, because filters run after the ceiling and a search that fetched 2000 rows and kept 40 has
  still lost everything past the 2000th

#### Scenario: Results are paged

- GIVEN more results than `CATALOG_PAGE_SIZE`
- WHEN a page is returned
- THEN it SHALL carry `items`, `total`, `truncated` and a cursor for the next page

### Requirement: Show a consumer what they need before subscribing

#### Scenario: A listing is opened from the catalogue

- GIVEN a visible resource
- WHEN its listing opens
- THEN it SHALL show what the API does, its description as rendered Markdown, its documentation
  link when it has one, its operations, its published URL per environment and gateway, its
  lifecycle, and the products it is sold in
- AND it SHALL offer the subscribe action, or the reason it is unavailable
- AND it SHALL NOT expose the publisher's editing controls

### Requirement: Reassign an API's owning application

#### Scenario: An owner is changed

- GIVEN an administrator, or a member of the current owning application
- WHEN they change the API's owner
- THEN the change SHALL apply to the resource across every environment, because ownership is not a
  per-environment fact
- AND it SHALL be audited with both applications named
- AND everything the resource owns — its products' membership, its certificates' usability — SHALL
  be re-evaluated against the new owner

### Requirement: Delete only what the caller owns, and say what is attached

#### Scenario: A deletion is attempted

- GIVEN a resource
- WHEN deletion is requested
- THEN it SHALL be permitted only for a member of the owning application or an administrator
- AND it SHALL go through the typed confirmation, with the resource's name typed back
- AND the confirmation SHALL name what will stop working — the live environments, the products it
  is in and the subscriptions through them

### Requirement: Keep the workspace and the catalogue in one vocabulary

#### Scenario: The same API appears in both lists

- GIVEN an API in the owner's list and in the catalogue
- WHEN both render
- THEN the kind badge, lifecycle chip, version and environment chips SHALL be identical, drawn from
  the same status vocabulary
- AND the two screens SHALL differ only in what they let the reader do
