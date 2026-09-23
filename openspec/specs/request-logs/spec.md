# request-logs Specification

## Purpose

Define per-request access logs: a **native query interface** over a log index, scoped to what the
caller may read, with a real Elasticsearch implementation and a deterministic mock behind it. The
control plane does not store request logs.

It also defines the one thing the portal can change about what a log line contains: a **body
capture window**, an hour in which one API's request and response bodies are written into the line
as well. What the gateway actually writes is `data-plane-gateway` § Write one access-log line for
every request, and never sample.

## Requirements

### Requirement: Keep log results tied to their filters

#### Scenario: The query or page changes

- GIVEN displayed log rows and a histogram
- WHEN a time range, filter or result page changes
- THEN the previous query's result SHALL NOT be shown as the new query's result while it loads

### Requirement: The control plane queries logs; it never stores them

#### Scenario: The Logs tab is opened

- GIVEN a caller with a resource in scope
- WHEN logs are read
- THEN they SHALL be read from the configured provider
- AND the control plane SHALL have no per-request log table of its own
- AND the reason SHALL be that aggregate telemetry answers "how much" and is kept here, while
  "which call, when, and what happened to it" is a different question with a different retention
  story that the estate already runs Elasticsearch for

### Requirement: Two reads over the index, and nothing else

#### Scenario: The endpoints are enumerated

- GIVEN the log surface
- WHEN it is described
- THEN reading logs SHALL consist of `GET /api/logs` and `GET /api/logs/histogram`
- AND there SHALL be no write to the index, and no per-resource route
- AND a resource SHALL be a **filter** on the same two endpoints, which therefore answer both "this
  API's traffic" and "everything I can see"
- AND the only write in this capability SHALL be the body capture window below, which changes what
  a future line contains and never touches a line that exists

### Requirement: Authorize by resolving the caller into a list of resource ids

#### Scenario: A query is built

- GIVEN a signed-in caller and an optional `resourceId`
- WHEN the query is built
- THEN the caller SHALL first be turned into the list of resource ids they may read
- AND a caller SHALL therefore be unable to name a resource they may not read
- AND the worst a wrong id can do SHALL be to return nothing

#### Scenario: The caller may read nothing

- GIVEN an empty resolved list
- WHEN the search runs
- THEN it SHALL return no results rather than an error

### Requirement: Validate and bound the query window

#### Scenario: A window is given

- GIVEN `from` and `to`, or `sinceMin` with a default of 60
- WHEN they are read
- THEN each timestamp SHALL be ISO-8601, `from` SHALL be before `to`, and `sinceMin` SHALL be a
  positive integer
- AND a malformed value SHALL be refused with a `400` naming the parameter and the expected shape

#### Scenario: The window is too wide

- GIVEN a range wider than `LOGS_MAX_RANGE_HOURS`
- WHEN it is submitted
- THEN it SHALL be refused, naming the limit in hours, naming the variable, and saying to narrow the
  range

#### Scenario: A filter is given

- GIVEN `status`, `method`, `path`, `subscriptionId` or `minDurationMs`
- WHEN they are read
- THEN `status` SHALL be one of `2xx`, `3xx`, `4xx`, `5xx`; `method` SHALL match an HTTP method
  name; `path` SHALL be a case-insensitive **substring** truncated to 200 characters and never
  interpreted as a pattern; and `minDurationMs` SHALL be a non-negative number

#### Scenario: A histogram is requested

- GIVEN a `buckets` value
- WHEN it is read
- THEN it SHALL be an integer between 4 and 240, defaulting to 48

### Requirement: Answer with this system's vocabulary, not the index's

#### Scenario: A log line is returned

- GIVEN a document in the log index
- WHEN it is returned
- THEN it SHALL carry `at`, `environment`, `gateway`, `instance`, `resourceId`, `resourceName`,
  `operationId`, `method`, `path`, `status`, `durationMs`, `backendMs`, `subscriptionId`,
  `consumerApplicationId`, `clientIp`, `requestId` and `error`
- AND `operationId` SHALL be allowed to be `null`, which is a real answer: a `404` on an unmatched
  path is exactly the line somebody is looking for
- AND `requestId` SHALL be the `x-request-id` the gateway assigned, which is what a consumer quotes
  in a ticket

#### Scenario: A page is returned

- GIVEN a search
- WHEN the response is built
- THEN it SHALL echo the resolved `window` and the `provider` that answered
- AND it SHALL carry a `nextCursor`, or `null` when the page is the last
- AND the window SHALL be echoed so the screen can say what it is showing without re-deriving it,
  and so a bookmarked window is unambiguous when the default changes

### Requirement: Query the real index safely

#### Scenario: The `elk` provider runs a search

- GIVEN `LOGS_PROVIDER=elk`
- WHEN a query runs
- THEN it SHALL be exactly one `_search` per call, with an explicit field map, no scripting, and no
  wildcard a caller can write
- AND it SHALL be bounded by `ELK_MAX_RESULT_WINDOW` and `ELK_TIMEOUT_MS`
- AND it SHALL never write

#### Scenario: The cluster is unreachable

- GIVEN `LOGS_PROVIDER=elk` and a failing cluster
- WHEN a query runs
- THEN the failure SHALL be reported to the caller and rendered on the screen
- AND there SHALL be **no** fallback to the mock provider, because a portal that quietly showed
  invented traffic when the log cluster was unreachable would be worse than one that showed an
  error — the numbers would look like observations

### Requirement: Simulate traffic deterministically when there is no cluster

#### Scenario: The `mock` provider answers

- GIVEN `LOGS_PROVIDER=mock`, the default
- WHEN a query runs
- THEN the results SHALL be deterministic and derived from the resources actually published in the
  environment and their real operations
- AND every screen that reads logs SHALL therefore be exercised end to end before an Elasticsearch
  cluster exists

#### Scenario: A simulated result is rendered

- GIVEN a response marked `simulated`
- WHEN it renders
- THEN the screen SHALL say the results are simulated, in words, beside them
- AND it SHALL say what that means for the reader — these calls were not observed — without naming
  the environment variable that connects a real index, which is an operator's concern and not the
  publisher's

### Requirement: Read logs from where the question is asked

#### Scenario: The Logs panel is opened in a workspace

- GIVEN an API workspace
- WHEN the Logs panel opens
- THEN it SHALL be filtered to that resource and the workspace's environment
- AND it SHALL offer the status, method, path, subscription and duration filters, and a histogram
  above the lines
- AND the window SHALL be chosen by one segmented control of presets — 15 minutes, an hour, six
  hours, a day, a week — with no preset pressed while the window is a custom one, and an explicit
  **Extend to now** for a window that has fallen behind
- AND the duration filter SHALL be one labelled checkbox that names its threshold ("1.0 s or
  more"), rather than a toggle button whose meaning is its colour
- AND the subscription filter SHALL be set from a line's detail ("only this subscription's
  calls") and shown as a removable chip, because a subscription id is nothing anybody types
- AND a failure of the timeline SHALL be shown once, in the timeline, and a failure of the lines
  once, above the lines
- AND while the first page loads the table SHALL show a skeleton rather than an empty state
- AND every status SHALL be the shared HTTP status chip, and every environment its display label

#### Scenario: A body capture window is opened or closed from the panel

- GIVEN the Logs panel
- WHEN a window is opened or closed early
- THEN a failure of either SHALL be shown once, beside the control that failed

#### Scenario: A traffic row is followed from the dashboard

- GIVEN a row in the dashboard's traffic table
- WHEN it is activated
- THEN it SHALL open that resource's workspace on the Logs panel, via `?tab=logs`
- AND a `sinceMin` in the same address SHALL choose the panel's initial window, snapped to the
  nearest preset on a logarithmic scale with a tie going to the wider one, so the lines shown are
  the ones that were counted; without it the window SHALL be the last hour

### Requirement: Open a body capture window per API, per environment, for at most an hour

Bodies are not logged. A window is the deliberate, temporary exception, for the bug that cannot be
reproduced from status codes and timings.

#### Scenario: A window is opened

- GIVEN `POST /api/logs/body-capture` with a resource, an environment, a reason and a number of
  minutes
- WHEN it is accepted
- THEN the window SHALL last at most `MAX_BODY_CAPTURE_MINUTES` (60), defaulting to it
- AND a longer window SHALL be refused rather than clamped, because a second hour is a second
  decision with a second audit row
- AND the reason SHALL be at least 20 characters, for the same reader a TLS exception's reason is
  written for

#### Scenario: The caller is not an owner

- GIVEN a caller who is not a member of the API's owning application and not an administrator
- WHEN they try to open a window
- THEN it SHALL be refused
- AND the rule SHALL be the ordinary one — this changes something the caller's application owns —
  rather than the admin-only carve-out a TLS exception takes, because capture exposes bodies the
  owner's own backend already receives in full

#### Scenario: A window is already open

- GIVEN a live window for this resource in this environment
- WHEN a second is requested
- THEN it SHALL be refused, naming when the open one expires and who opened it
- AND the reason SHALL be that two rows would mean two things to close and one still capturing

#### Scenario: A window is opened or closed

- GIVEN either write
- WHEN it succeeds
- THEN it SHALL be written to the audit log with the actor, the environment, the reason and the
  expiry
- AND the resource SHALL be touched, so the change reaches the fleet on the next poll and a
  concurrent editor sees a changed ETag

#### Scenario: A window is closed early

- GIVEN `DELETE /api/logs/body-capture/:id`
- WHEN it succeeds
- THEN the row SHALL be dated rather than deleted
- AND the reason SHALL be that "whose bodies were captured, when, and who asked" is the question
  the table exists to answer, and a deleted row answers nothing

#### Scenario: Windows are listed

- GIVEN `GET /api/logs/body-capture`
- WHEN it answers
- THEN it SHALL list the live windows, optionally narrowed by environment and resource, with the
  spent ones available behind `includeSpent=1`
- AND every line SHALL carry the reason, who opened it, when it expires and the seconds remaining
- AND the list SHALL be readable by any signed-in caller, not only by the owner, because a record
  private to the person it is a record of is not a record
- AND the response SHALL state the cap in minutes and the cap in bytes, so the screen does not have
  to know them

#### Scenario: The window reaches the fleet

- GIVEN an open window
- WHEN the environment's configuration document is built
- THEN the route SHALL carry `logBodiesUntil` as the expiry **instant**
- AND a spent or revoked window SHALL simply not appear in the document, so nothing has to know
  what "revoked" means downstream
