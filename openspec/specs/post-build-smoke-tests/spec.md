# post-build-smoke-tests Specification

## Purpose

Define the Playwright smoke suite in `e2e/`: a **read-only** pass over a running stack that opens
every screen in a real browser and asserts that nothing threw. Behaviour that has to change
something belongs in `test/`, against a control plane the test owns.

## Requirements

### Requirement: The suite runs against a stack that is already up

#### Scenario: The suite starts

- GIVEN a running estate
- WHEN the suite runs
- THEN it SHALL point at `E2E_BASE_URL`, defaulting to `http://localhost:8080`
- AND it SHALL NOT start a server of its own
- AND the reason SHALL be that `scripts/stack.ps1` already defines the estate

#### Scenario: The browser is not installed

- GIVEN a machine that has never run the suite
- WHEN it is run
- THEN the documented one-time browser install SHALL be required
- AND `CLAUDE.md` SHALL name both that command and the environment variables

### Requirement: The suite is read-only

#### Scenario: A test is written

- GIVEN any spec in `e2e/`
- WHEN it runs
- THEN it SHALL navigate and assert only
- AND nothing in it SHALL publish, promote, subscribe, rotate, revoke or delete
- AND the reason SHALL be that the stack it runs against is usually shared

#### Scenario: An editor is exercised

- GIVEN a spec that types into a form to prove the editor works
- WHEN it finishes
- THEN it SHALL leave the estate exactly as it found it, because no save is ever pressed

### Requirement: Sign in without the identity provider

#### Scenario: Global setup runs

- GIVEN the configured providers
- WHEN setup signs in
- THEN it SHALL use the development bypass or the local directory, whichever is configured
- AND `E2E_USER` and `E2E_PASSWORD` SHALL supply the local credential
- AND an estate configured for OIDC only SHALL be refused with a message saying so, rather than
  hanging on a provider's login page

#### Scenario: The session is reused

- GIVEN a successful sign-in
- WHEN the specs run
- THEN the saved storage state SHALL be reused, so each spec does not sign in again
- AND setup SHALL verify the state by loading the portal in a real browser and confirming who it is

### Requirement: Fail on a thrown render, not only on a missing element

#### Scenario: A React tree throws during a fetch or a render

- GIVEN a page that leaves an empty panel behind
- WHEN the spec finishes
- THEN the collected page errors and console errors SHALL be asserted empty
- AND the reason SHALL be that nothing else the suite asserts would catch it, and a screenshot of an
  empty panel does not say why

#### Scenario: A subresource fails to load

- GIVEN Chromium reporting a missing favicon or an optional asset as a console error
- WHEN errors are collected
- THEN those SHALL be excluded
- AND the reason SHALL be that including them fired on every page while catching nothing, and a
  request the portal *made* and could not handle surfaces as a rendered error the specs assert on
  directly

### Requirement: Open every screen

#### Scenario: The shell is exercised

- GIVEN the portal
- WHEN the shell spec runs
- THEN the sidebar SHALL be visible, and each navigable section SHALL be opened and asserted to
  render its title

#### Scenario: The API workspace is exercised

- GIVEN an API workspace
- WHEN the spec runs
- THEN **every** panel SHALL be clicked in turn, asserted active, and the content asserted non-empty
- AND the reason SHALL be that each panel is lazily rendered, so a broken import or a fetch that
  throws on one is invisible until somebody clicks it

#### Scenario: An address is written somewhere other than the sidebar

- GIVEN an address a screen links to rather than the sidebar — the publish wizard's route-table
  address, one subscription's own address
- WHEN the suite runs
- THEN it SHALL open each and assert the **title of the screen it expected to arrive at**
- AND the reason SHALL be that the failure mode looks like success: the link is there, the route
  exists, and the reader lands on a list with their id dropped, which reads as "there is nothing
  here" rather than as a broken link

#### Scenario: A user's first application publishes nothing

- GIVEN membership ordering that puts a consuming application first
- WHEN a spec needs an application that publishes
- THEN it SHALL intersect the user's applications with the estate's publishers and take the first
  match
- AND it SHALL skip with a stated reason only when there is genuinely nothing to look at
- AND taking `applications[0]` SHALL be treated as a defect, because it skips the spec on an estate
  with plenty to see

### Requirement: Assert what the portal actually renders

#### Scenario: A screen's title is asserted

- GIVEN any screen
- WHEN it is asserted
- THEN the title SHALL be read from the shell's page head, which renders it from the route table

#### Scenario: The catalogue is asserted

- GIVEN the Catalog screen
- WHEN a listing is opened
- THEN it SHALL be the read-only listing, not the publisher's workspace

#### Scenario: The estate's health is asserted

- GIVEN Health Status
- WHEN it renders
- THEN a verdict per environment SHALL be present, and the component matrix SHALL be non-empty

#### Scenario: The notification surfaces are asserted

- GIVEN the bell and the Mail screen
- WHEN they are opened
- THEN both SHALL render without error, and the bell's popover SHALL close on Escape

### Requirement: Keep the suite alongside the other two

#### Scenario: The test layers are described

- GIVEN the repository
- WHEN the test commands are listed
- THEN `bun test` SHALL cover the two planes and `shared/`, `bun run test:ui` the interface's
  decisions, and `bun run test:e2e` this suite
- AND the suite's output SHALL be written under the repository's own data directory rather than
  beside the source
