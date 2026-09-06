# request-logs Specification

## Purpose

Define per-request access logs: a **native query interface** over a log index, scoped to what the
caller may read, with a real Elasticsearch implementation and a deterministic mock behind it. The
control plane does not store request logs.

## Requirements

### Requirement: The control plane queries logs; it never stores them

#### Scenario: The Logs tab is opened

- GIVEN a caller with a resource in scope
- WHEN logs are read
- THEN they SHALL be read from the configured provider
- AND the control plane SHALL have no per-request log table of its own
- AND the reason SHALL be that aggregate telemetry answers "how much" and is kept here, while
  "which call, when, and what happened to it" is a different question with a different retention
  story that the estate already runs Elasticsearch for

### Requirement: Two reads, and nothing else

#### Scenario: The endpoints are enumerated

- GIVEN the log surface
- WHEN it is described
- THEN it SHALL consist of `GET /api/logs` and `GET /api/logs/histogram`
- AND there SHALL be no write, and no per-resource route
- AND a resource SHALL be a **filter** on the same two endpoints, which therefore answer both "this
  API's traffic" and "everything I can see"

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

### Requirement: Read logs from where the question is asked

#### Scenario: The Logs panel is opened in a workspace

- GIVEN an API workspace
- WHEN the Logs panel opens
- THEN it SHALL be filtered to that resource and the workspace's environment
- AND it SHALL offer the status, method, path, subscription and duration filters, and a histogram
  above the lines

#### Scenario: A traffic row is followed from the dashboard

- GIVEN a row in the dashboard's traffic table
- WHEN it is activated
- THEN it SHALL open that resource's workspace on the Logs panel, via `?tab=logs`
