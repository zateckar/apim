# dashboard-health Specification

## Purpose

Define the two screens that answer "how is it going": **Health Status**, which says whether the
estate is up, which part of it is not, and offers FixMe's diagnose-and-repair run for the selected
application, and the application **dashboard**, which says what needs attention and how much traffic
there has been. Plus the telemetry both read from.

## Requirements

### Requirement: Keep displayed metrics tied to the selected window

#### Scenario: A time range changes

- GIVEN dashboard, telemetry or synthetic uptime data for one time range
- WHEN another range is selected
- THEN the previous metrics SHALL NOT be labelled as results for the new range

#### Scenario: Rate-limit arithmetic shows no live replicas

- GIVEN an environment reporting zero live replicas
- WHEN its fleet arithmetic renders
- THEN the multiplier SHALL be zero, without substituting one
- AND an unread replica inventory SHALL NOT be presented as zero replicas
- AND the arithmetic SHALL render as a collapsed aside rather than a panel of its own, because it
  is reference that reads the same whether or not anything is wrong, and as a card at the foot of a
  status page it carried the weight of the thing somebody came to read

### Requirement: Probe each component on its own timer

#### Scenario: The Health screen is opened

- GIVEN a caller opening Health Status
- WHEN the snapshot is assembled
- THEN it SHALL be assembled from the **latest result of each probe**, not by running every check on
  demand
- AND the reason SHALL be twofold: an expensive or hung check must not make the screen hang, and a
  screen being watched must not turn into a load generator against a gateway that is already
  struggling
- AND the server SHALL declare the polling interval, because it knows how often its own probes run
  and a browser polling faster would only re-read the same snapshot

#### Scenario: A probe throws

- GIVEN a check that raises an unexpected error
- WHEN it is caught
- THEN the previous answer SHALL be kept
- AND every check SHALL map its **own** failures onto a `down` item with the reason, so the catch is
  only a safety net
- AND the honest thing for a safety net to do SHALL be to leave the last real observation alone
  rather than invent a verdict

#### Scenario: A manual refresh is requested

- GIVEN the Refresh action
- WHEN it is pressed
- THEN a fresh probe round SHALL be requested explicitly
- AND the button SHALL say it is probing while in flight

### Requirement: `disabled` is a third state, and it is not `down`

#### Scenario: A gateway has no address registered

- GIVEN a gateway nobody has given a public address
- WHEN it is probed
- THEN it SHALL be `disabled`, with a message saying so
- AND it SHALL be excluded from the environment's verdict
- AND the reason SHALL be that rolling it into "down" produces a red environment nobody can fix

### Requirement: Roll each environment up into one verdict

#### Scenario: An environment is summarised

- GIVEN an environment's components
- WHEN the rollup is computed
- THEN the verdict SHALL be `healthy`, `degraded`, `down` or `unknown`
- AND the components that are down SHALL be listed by label under the verdict
- AND the count SHALL read "`up`/`probeable` components up", with any disabled components named
  separately

#### Scenario: An environment has nothing to probe

- GIVEN a chain stage with no gateway registered
- WHEN its verdict is computed
- THEN it SHALL be `unknown`, presented as "Not deployed"
- AND `unknown` SHALL be understood as the honest answer rather than a failure to compute

### Requirement: Name components in the estate's own vocabulary

#### Scenario: The component matrix renders

- GIVEN a snapshot
- WHEN the matrix renders
- THEN components SHALL be grouped as **Gateways** (the fleet and each gateway's published address),
  **Platform** (the control plane and its database), **External systems** (the log index and the six
  surrounding systems), and **Other** for anything a group did not claim
- AND an "Other" group SHALL exist so a probe added later shows up somewhere rather than vanishing
- AND each row SHALL show its status, its label, its latency or its failure message, and how long
  ago it was checked
- AND the status SHALL be written *Up*, *Down* or *Not configured*, the last in the hero's own words
  for `disabled`, rather than the column value in capitals
- AND the groups SHALL be **sections of one panel** — a heading and a rule each, not a panel nested
  in a panel: they are one subject — every probe the control plane ran — and four cards in a page
  of cards read as four subjects

#### Scenario: A component was not really contacted

- GIVEN a simulated probe
- WHEN it renders
- THEN it SHALL be tagged as simulated
- AND it SHALL never be counted as evidence

#### Scenario: Latency is shown

- GIVEN a component that answered
- WHEN its latency renders
- THEN it SHALL be toned: at or above one second is a failure signal, at or above 300 ms is a
  warning, below that is fine
- AND the reason SHALL be that a gateway answering in over a second is not down, and is not fine

### Requirement: Open Health Status to everybody, and gate only the error text

#### Scenario: A non-administrator opens Health Status

- GIVEN any signed-in user
- WHEN they open Health Status
- THEN the hero verdicts, the uptime strips and the component matrix SHALL be shown
- AND the reason SHALL be that which environment is healthy is what decides whether a publisher
  promotes this afternoon, and a screen only administrators can read makes them ask in chat

#### Scenario: The page's links are offered

- GIVEN Health Status
- WHEN its toolbar renders
- THEN *Traffic & errors* (Telemetry) and *Manage gateways* (Gateways) SHALL be offered to an
  administrator only, as links drawn as buttons, beside Refresh
- AND a member SHALL be offered Refresh alone, because both destinations are administrators' screens
  and a link that ends in "this screen is for administrators" is not somewhere to go

#### Scenario: A failed check quotes an internal host

- GIVEN a `down` component whose error text names an internal address
- WHEN it is served
- THEN that text SHALL be shown only to an administrator
- AND the gate SHALL be applied on the **server**

#### Scenario: The convergence detail is read

- GIVEN Health Status
- WHEN it renders below the matrix
- THEN what configuration each gateway's replicas are running, and anything one has refused, SHALL
  be shown to administrators only
- AND the replicas SHALL be listed under the gateway they belong to, each gateway a section of its
  environment's panel with its sync state, whether it is paused, its routes and its digest, because a
  disagreement between replicas lives in one gateway rather than in the environment
- AND a replica's state SHALL be the chip `platform-administration` defines

### Requirement: Show availability over a window, and say when it is simulated

#### Scenario: The uptime panel renders

- GIVEN a chosen environment and a range of `1h`, `6h`, `24h` or `48h`
- WHEN the panel renders
- THEN each monitor SHALL show an availability strip, its availability percentage, and its average
  and peak response time over the window
- AND a bucket with no data SHALL say "no data" rather than a count, because the difference between
  "nobody checked" and "every check passed" is the one thing a grey mark has to convey
- AND a failed bucket's error text SHALL be shown only to administrators
- AND the environment and the range SHALL each be one segmented control, the portal's shared one,
  with the environment written as its label (`DEV`) and the range as `1 h`, `6 h`, `24 h`, `48 h`
- AND every stage of the chain SHALL be offered, one with no gateway disabled with the reason written
  under the control, so an estate with two gateways does not read as an estate with two environments

#### Scenario: The history is generated rather than observed

- GIVEN the mock provider
- WHEN the uptime panel renders
- THEN it SHALL say the strips are simulated, that nothing was checked, and that the history is
  generated from the registered gateways
- AND to an administrator only it SHALL name `LOGS_PROVIDER=elk` with `ELK_URL` as what reads the
  real uptime index, because the fix is a variable on the control plane's host and a member told to
  set it has been handed somebody else's task
- AND the uptime index SHALL be separate from the access index, because a heartbeat writes one
  document per check and mixing them would make every request-count aggregation wrong

#### Scenario: The environment has no gateway

- GIVEN an estate with nothing registered
- WHEN the uptime panel renders
- THEN it SHALL say so rather than showing an empty chart
- AND an administrator SHALL be offered *Add a gateway*; a member SHALL be told that an
  administrator adds one, with no action they cannot take

### Requirement: Serve the application dashboard from one endpoint

#### Scenario: The dashboard is loaded

- GIVEN an application and an environment
- WHEN the dashboard loads
- THEN **one** endpoint SHALL answer, with a block per role the reader has
- AND the reason SHALL be that five endpoints a screen fans out to are five chances for two numbers
  on one page to disagree about what "now" means

#### Scenario: Traffic is summarised

- GIVEN a window
- WHEN traffic is summarised
- THEN it SHALL be **three** numbers — served, refused by the gateway, and failed upstream — with
  the error rate defined beside them
- AND a single "errors" figure SHALL NOT be used, because a gateway `429` and a backend `500` are
  different signals and one figure hides which is happening

#### Scenario: A trend is shown

- GIVEN a window whose preceding window is not fully inside retention
- WHEN the trend is computed
- THEN the previous figure SHALL be `null` rather than wrong, the response SHALL say the trend is
  unavailable, and the screen SHALL omit the delta

#### Scenario: A list is long

- GIVEN attention rows, top APIs or subscriptions
- WHEN they are returned
- THEN each list SHALL be bounded — at most 50 attention rows per block, 10 top APIs, 50
  subscriptions — with a truncation count beside it

#### Scenario: The reader's roles are described

- GIVEN an application that owns nothing
- WHEN the dashboard renders
- THEN the blocks SHALL describe the **data** the reader has, and the navigation SHALL still offer
  publishing
- AND the reason SHALL be that an application which owns nothing still needs the screen that
  publishes its first API

### Requirement: Make traffic drillable

#### Scenario: A traffic row is followed

- GIVEN the dashboard's per-API traffic table
- WHEN a row is activated
- THEN it SHALL open that API's workspace on the Logs panel, filtered to the same environment and
  window
- AND the row SHALL be a link whose address carries both, as
  `/{application}/apis/{resourceId}?tab=logs&sinceMin={window}`, so the window survives a new tab
  and a copied address as well as a click

#### Scenario: The window is changed

- GIVEN the dashboard's window control
- WHEN it changes
- THEN every figure, trend and list on the page SHALL be recomputed against the same window
- AND `DASHBOARD_DEFAULT_SINCE_MIN` SHALL be the default: until a reader chooses a window the
  request SHALL name none, and the control SHALL show the window the response reports
- AND a chosen window SHALL be remembered in the browser as a display preference
- AND the time-range control SHALL sit above the dashboard figures, since it governs the whole page rather than only the traffic table

#### Scenario: Attention is listed on the dashboard

- GIVEN attention rows for the reader, or a first-run *Start here* list
- WHEN the dashboard renders them
- THEN both SHALL use the portal's one attention list, grouped by severity with each row's call to
  action, rather than a second rendering of the same rows

### Requirement: Aggregate telemetry on the control plane, bounded

#### Scenario: Instances report

- GIVEN telemetry arriving on the gateway poll
- WHEN it is accepted
- THEN it SHALL be flushed into rollups on `TELEMETRY_FLUSH_INTERVAL_SEC`
- AND only the windows the control plane names in `acceptedWindows` SHALL be considered taken over

#### Scenario: Telemetry is queried

- GIVEN a telemetry query
- WHEN it runs
- THEN it SHALL be bounded by a stated maximum number of scanned rows, and truncation SHALL be
  reported rather than silent
- AND rows older than `TELEMETRY_RETENTION_HOURS` SHALL have been pruned

#### Scenario: The estate's telemetry is read

- GIVEN an administrator
- WHEN they open Telemetry
- THEN calls per minute across the estate SHALL be shown, split into served, refused by the gateway
  and failed upstream, with breakdowns by resource, by consumer and by instance
- AND the window SHALL be chosen with the shared segmented control above everything it governs, and
  a window with no traffic SHALL say so with an action rather than draw an empty chart
- AND the chart's time labels SHALL be in the reader's local time, as every other time in the portal
  is, rather than cut out of the UTC timestamp
- AND the per-instance breakdown SHALL be titled **By replica** and give each replica's gateway,
  grouped by gateway, because it counts replicas and was titled as though it counted gateways; a
  replica whose gateway the fleet read cannot place SHALL be listed last with no gateway rather
  than a guessed one
- AND a query that reached its scan bound SHALL say that its figures cover part of the window

#### Scenario: Validation at the gateways is read

- GIVEN replicas reporting validation counters on their poll
- WHEN Telemetry renders
- THEN it SHALL sum them across the environment's replicas: refused in blocking mode, passed with a
  warning, not sampled, shed at the blocking validation budget and without a compiled schema
- AND it SHALL say that these are counts since each replica's last report rather than figures for the
  selected window, because every other number on the page is governed by the window
- AND a shed or schema-less request SHALL be raised as an error naming where to act — Gateway
  settings for the budget, Health Status for a replica's activation
- AND the reason it lives here rather than on Global policy SHALL be that it is a reading of the
  fleet at run time, and among the global tier's controls it read as one of them

#### Scenario: Latency is shown

- GIVEN a set of rollup rows
- WHEN their latency is summarised
- THEN the total the caller waited and the share spent inside the gateway SHALL both be offered,
  each as its own percentile over its own histogram rather than one subtracted from the other
- AND the gateway's share SHALL be shown beside the total wherever the total is — the dashboard's
  latency figure, the Telemetry totals, and every breakdown row — so "is it us or the backend" is
  answered on the screen rather than by exporting the numbers
- AND a percentile SHALL be labelled approximate, because it is interpolated inside a bucket
- AND the screen SHALL say that the smallest bucket is 0.25 ms, so a gateway faster than that reads
  as a floor rather than as a measurement
- AND where a figure is computed over only the requests that carried a backend duration, the count
  it was computed over SHALL be stated rather than the series total

### Requirement: Diagnose and repair a deployment from Health Status

#### Scenario: Health Status renders its FixMe section

- GIVEN any signed-in user on Health Status
- WHEN the page renders
- THEN below the verdicts, the uptime strips and the component matrix it SHALL carry a *Diagnose and
  repair* section for the selected application, as `integrations-and-mocks` defines it
- AND the section SHALL sit above the administrators' convergence detail, because it is the part of
  the page a member acts on
- AND every result SHALL be marked simulated while the surrounding systems are mocked

#### Scenario: A member runs FixMe

- GIVEN a member of the selected application
- WHEN they start a run
- THEN it SHALL be accepted, under the one authorization rule — a member may change what their
  application owns, and its deployment is that
- AND a caller who is not a member of the application SHALL be refused by the control plane
- AND a reader in no application SHALL be told so, with a link to their account, rather than offered
  a control that would be refused

### Requirement: Keep dashboard and telemetry context consistent with the shell

#### Scenario: A person belongs to several applications

- GIVEN a selected application in the portal
- WHEN its dashboard is loaded
- THEN the request SHALL include `applicationId` and the owner and consumer blocks SHALL be scoped to that application
- AND platform attention SHALL remain available to administrators
- AND an unknown application SHALL return 404, and a non-administrator requesting an application outside their memberships SHALL receive 403
- AND omitting `applicationId` SHALL retain the existing caller-wide aggregation for API clients

#### Scenario: The Telemetry environment changes

- GIVEN Telemetry is open
- WHEN the shell environment changes
- THEN its summary and all breakdowns SHALL query that environment
- AND the page SHALL have no independent environment picker that could disagree with the shell
