# workspace-api-catalog Specification

## Purpose

Define the two lists of APIs: **My APIs**, the ones an application publishes, and the **Catalog**,
the marketplace over everything a caller is allowed to see. The catalogue is a read model over what
already exists and deliberately not a second source of truth.

They are two lists because they answer two questions, and each is exactly one screen.

## Requirements

### Requirement: Keep catalog filters and calling guidance truthful

#### Scenario: Filters are cleared

- GIVEN an empty filtered result
- WHEN Clear filters is used
- THEN search text, kind, tag, publisher and environment SHALL all be cleared, and the sort SHALL
  return to best match
- AND a failed search SHALL NOT be described as no matches

#### Scenario: A calling example is unavailable

- GIVEN a listing with no environment where it is live at a published gateway address, and no
  example from the control plane
- WHEN Getting started renders
- THEN it SHALL direct the reader to addresses and release status in Overview rather than infer that no route exists

### Requirement: Keep the catalogue's question in its address

#### Scenario: A search or filter is changed

- GIVEN the Catalog
- WHEN the search text, type, tag, publisher, environment or sort changes
- THEN the address SHALL carry it as `?q=`, `?kind=`, `?tag=`, `?publisher=`, `?environment=` and
  `?sort=`, each only when it differs from the default, so an unfiltered catalogue is `/catalog`
- AND the address SHALL be replaced rather than pushed, so Back leaves the catalogue instead of
  stepping through every prefix of a query
- AND the reason SHALL be that the state lived in memory only: a reload, Back from a listing, or a
  link sent to a colleague all landed on an empty search

#### Scenario: A catalogue address is opened

- GIVEN an address carrying those parameters
- WHEN the Catalog opens
- THEN it SHALL open with them applied
- AND a type, environment or sort the portal does not know SHALL be dropped rather than sent, so a
  mistyped bookmark opens the catalogue instead of an error

### Requirement: List what an application publishes and what it may call

#### Scenario: The APIs section is opened

- GIVEN a selected application
- WHEN the APIs, MCP Servers or A2A Agents section renders
- THEN it SHALL list that application's resources of that kind, with the name, the kind, the
  version, the lifecycle chip and where each version is live
- AND it SHALL also list the resources of that kind that the application reaches through a
  subscription in the `active` or `activating` state
- AND the four states that are neither SHALL contribute nothing, because a rejected request is not
  access to an API
- AND the list SHALL be scoped to the selected application, not to the whole estate

#### Scenario: A subscribed row is told from an owned one

- GIVEN a row for a resource the selected application does not publish
- WHEN it renders
- THEN it SHALL carry a `subscribed` tag naming the publishing application, the products the access
  comes through and the environments it covers
- AND it SHALL offer none of the owner's actions, because they are never this reader's to take and
  two permanently disabled buttons on every such row are furniture rather than an explanation
- AND only the versions a subscription actually reaches SHALL be offered in its version picker
- AND the reason SHALL be that an application's own APIs and the ones it calls are both "the APIs we
  work with", and a list holding only the first put half of a team's daily estate on another screen,
  filed under the product that sells it

#### Scenario: The list holds both kinds

- GIVEN a list with at least one owned row and at least one subscribed row
- WHEN it renders
- THEN a filter SHALL be offered over all, published-here and subscribed, each with its count, as
  the shared segmented control
- AND the filter SHALL NOT be offered when the list is entirely one of them, because a control that
  cannot change what is shown is a control that operates nothing

#### Scenario: The owner's list is laid out

- GIVEN any number of rows in an application's own list
- WHEN they render
- THEN they SHALL be one flat list ordered by name, and SHALL NOT be grouped or folded by domain
- AND each row's domain SHALL be on the row, and SHALL remain searchable
- AND each row SHALL carry at most one line of description, as text rather than rendered Markdown,
  so a row's height does not depend on what somebody wrote in it
- AND the reason SHALL be that this reader owns these APIs and knows their names: grouping is how
  the estate-wide **Catalog** is browsed by somebody who does not, and a group header the height of
  a row bought nothing here but a screenful of four APIs

#### Scenario: The application has nothing yet

- GIVEN an application with no resources and no subscription reaching one
- WHEN the list renders
- THEN an empty state SHALL be shown naming the next action — publishing a first API
- AND the section SHALL still be present, because sections follow capability rather than inventory
- AND the empty-state publish action SHALL preserve the resource kind on MCP Servers and A2A Agents, matching the page-head action
- AND it SHALL be a link, because it goes somewhere

#### Scenario: A row is opened

- GIVEN a row in the application's own list
- WHEN the name is activated
- THEN the API **workspace** SHALL open — the publisher's editor
- AND a subscribed row SHALL instead open the read-only listing at `/catalog/:resourceId`, because
  the editor would open — everyone may read everything — and then refuse every control on it
- AND a card in the cross-application Catalog SHALL open that same read-only listing

### Requirement: Offer the catalogue as one screen

#### Scenario: A reader looks for an API somebody else publishes

- GIVEN any signed-in user
- WHEN they open Catalog
- THEN there SHALL be exactly one catalogue screen, and it SHALL be the one backed by the search
  endpoint — so the ranking, the facet counts, the Kafka topics and the truncation flag this
  capability requires are what the reader actually gets
- AND a second catalogue that filtered the resource list in the browser SHALL NOT exist beside it,
  because two screens under one title are two answers to one question and only one of them can
  satisfy the requirements below

#### Scenario: An older catalogue address is opened

- GIVEN `/discover`, the address the shell's own cross-application list answered on
- WHEN it is opened
- THEN it SHALL resolve to the one catalogue
- AND the reason SHALL be that a kept address costs one entry in the route table and losing it costs
  somebody a working link

#### Scenario: The owner's own list is rendered

- GIVEN the APIs, MCP Servers or A2A Agents section
- WHEN it renders
- THEN the component that draws it SHALL NOT also draw the estate-wide list
- AND it SHALL keep what only an owner needs — the version picker, the environment chevrons,
  the transfer and the delete — because those never applied to somebody else's API anyway

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

#### Scenario: A listing's environments are ordered

- GIVEN a listing live in more than one environment
- WHEN its environments are returned
- THEN they SHALL be ordered by the configured promotion chain, so the row reads dev → test → prod
- AND an environment that is not in the chain SHALL still appear, after those that are, rather than
  be dropped — which would understate where the API is live
- AND the reason SHALL be that the row of environments answers "how far along the chain has this
  got"; in the order the rows happen to come back it read `dev · prod · test` and left the reader
  to work out that the middle pill is the last stage
- AND the same ordering SHALL apply to the environment facets, which already used it

### Requirement: Group the catalogue by domain

#### Scenario: The Catalog screen renders

- GIVEN the catalogue
- WHEN it is grouped
- THEN it SHALL be grouped by **domain**, not by application
- AND domains containing visible resources SHALL be presented first, in taxonomy order with "Other" last
- AND empty domains SHALL remain available, in taxonomy order, under a collapsed "Domains with no resources" disclosure with its count
- AND the reason SHALL be that browsing starts with resources somebody can use while retaining the full taxonomy

#### Scenario: A domain is drawn open or folded

- GIVEN the browse view, which reads up to 200 resources by name in one request
- WHEN that read holds every visible resource
- THEN every domain with resources SHALL start open, drawn from that read without a request of its own
- AND when it does not, the domains SHALL start folded and each SHALL read its own resources when opened
- AND either way the reader SHALL be able to fold and unfold each one
- AND the reason SHALL be that every domain started folded, so the first thing the catalogue asked
  of a visitor was to open each domain in turn to find out what was in it

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

#### Scenario: The catalog is scanned

- GIVEN a reader browsing or filtering the Catalog
- WHEN a result is rendered
- THEN the result SHALL present its name, kind, version, publisher, short summary and live environments
  in one compact row
- AND it SHALL identify whether the resource is available to subscribe to or already subscribed
- AND it SHALL offer one clear action to open the read-only listing, where the full contract and
  subscription action live
- AND the default browse view SHALL keep the domain grouping while a search, filter or explicit sort
  SHALL show one directly scannable result list
- AND publisher and tag filters SHALL be tucked behind one secondary filter disclosure so the common
  search and kind controls remain easy to find
- AND type and environment SHALL each be one segmented control with an "All" choice, and the
  environments SHALL be written `DEV`, `TEST`, `PROD`
- AND a card SHALL say "Subscribed", "Available to subscribe" or "Not in a product" as a status
  chip, and a card only its owners can see SHALL say "Not published" the same way

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

#### Scenario: A resource listing is opened from the catalogue

- GIVEN a visible resource
- WHEN its listing opens
- THEN it SHALL show what the resource does, its description as rendered Markdown, its documentation
  link when it has one, its operations, its published URL per environment and gateway, its
  lifecycle, and the products it is sold in
- AND it SHALL offer the subscribe action, or the reason it is unavailable
- AND it SHALL NOT expose the publisher's editing controls
- AND an empty or whitespace-only description SHALL show "No description provided." rather than an empty panel

#### Scenario: A listing has no contract to show

- GIVEN a resource whose owner has not imported a definition
- WHEN the operations tab opens
- THEN it SHALL be an empty state naming the next step, not a card containing one sentence

#### Scenario: A listing panel explains itself

- GIVEN a panel on the listing whose hint explains how the platform works
- WHEN the hint is written
- THEN it SHALL be short enough not to outweigh the answer beneath it, and SHALL lead with the part
  the reader acts on
- AND the reason SHALL be that "where it is live" carried three lines about release convergence
  above a list that is usually one line long, with the part a caller needs — which of two names
  they can reach — at the end of it

#### Scenario: A listing is named

- GIVEN a listing that has loaded
- WHEN the page head renders
- THEN its title SHALL be the resource's name and version, and the header beneath it SHALL carry
  the kind, the lifecycle, the publisher and the summary without repeating the name
- AND the shell's trail SHALL be the only link back to the Catalog

#### Scenario: A listing tab is chosen or linked to

- GIVEN a listing's tabs — Overview, Operations (Tools, Skills), Getting started, Try it, Versions
- WHEN one is chosen
- THEN the address SHALL carry it as `?tab=overview|operations|start|try|versions`, replaced rather
  than pushed, and a listing opened with one SHALL open on that tab
- AND an unknown tab SHALL open Overview
- AND Versions SHALL be offered only when the resource has more than one version, because a table
  with one row offers nothing to choose between
- AND the tabs SHALL be a keyboard-operable tab list, the same control the API workspace uses

#### Scenario: The reader already has access

- GIVEN a listing reached through a product the reader's own applications subscribe to
- WHEN the header renders
- THEN it SHALL say where, as "Subscribed in DEV, TEST" for active subscriptions and "Requested in
  PROD" for ones not yet active, naming the applications in the chip's title
- AND only the reader's own applications SHALL count, not every application an administrator may act for
- AND the reason SHALL be that it said "You subscribe", which named neither the application nor the
  environment — and a key works in one environment only

#### Scenario: The subscribe action is offered

- GIVEN a listing
- WHEN its primary action renders
- THEN it SHALL be a link named **New subscription** to the subscription form
- AND when the resource is in no product it SHALL be a disabled button with the reason written
  beside it

#### Scenario: An address or a call is copied

- GIVEN a published gateway address in Where it is live, or the call in Getting started
- WHEN it renders
- THEN it SHALL have a copy button beside it
- AND the Getting started call SHALL be built from a published address in an environment where the
  resource is live, with the key placed as that environment's effective `auth.subscriptionKey` unit
  says, or no key when there is none — the same construction as the subscription's own page
- AND when the resource is live in more than one such environment, the reader SHALL choose which
  one with the environment control
- AND the control plane's own example SHALL be shown only when no environment has a published
  address, saying that the host has to be substituted

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
  is in and the subscriptions through them — and SHALL be drawn open, with **Cancel** beside it
- AND the row's delete and change-owner controls SHALL open their dialogs even for a reader who may
  not use them, and the dialog SHALL say why its own control is disabled, because an icon has no
  room for a visible reason and a tooltip is one a keyboard and a touch screen never see

### Requirement: Keep the workspace and the catalogue in one vocabulary

#### Scenario: The same API appears in both lists

- GIVEN an API in the owner's list and in the catalogue
- WHEN both render
- THEN the kind badge, lifecycle chip, version and environment chips SHALL be identical, drawn from
  the same status vocabulary
- AND the two screens SHALL differ only in what they let the reader do
