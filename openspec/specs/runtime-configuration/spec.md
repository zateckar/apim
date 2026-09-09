# runtime-configuration Specification

## Purpose

Define how both planes and the portal are configured, what is validated before anything serves,
and what a misconfiguration is allowed to do. The governing rule is that **a wrong or missing
value is a startup failure that names the variable, never a silent downgrade** — see *Environment
Variables* in `openspec/project.md` for the complete tables.

## Requirements

### Requirement: Configuration is explicit, with no fallback chains

Configuration SHALL be read once at boot into a single typed object per plane, and a value that
cannot be resolved SHALL fail startup rather than resolve to a weaker default.

#### Scenario: A required variable is absent

- GIVEN `AUTH_PROVIDERS` is not set
- WHEN the control plane starts
- THEN it SHALL refuse to start
- AND the error SHALL name the variable, list the three legal values `local`, `oidc`, `dev`, and
  explain what each one means
- AND it SHALL NOT default to any provider, because a control plane that guessed would either be
  unreachable or wide open

#### Scenario: A retired variable is still set

- GIVEN `DEV_AUTH` is set and `AUTH_PROVIDERS` is not
- WHEN the control plane starts
- THEN it SHALL refuse to start and say that `DEV_AUTH` is retired and what replaces it
- AND it SHALL NOT interpret the old variable, because reading it silently is how a development
  bypass survives an upgrade into production

#### Scenario: A variable that moved into the configuration document is still set

- GIVEN a gateway container that still sets one of the variables the settings table replaced —
  `MAX_BODY_BYTES`, `MAX_CONCURRENT_REQUESTS`, `DP_ACCESS_LOG` and the rest
- WHEN the data plane starts
- THEN it SHALL refuse to start, naming every one of them and the setting that replaced it, and
  saying where to set them instead
- AND it SHALL NOT read the value, for both reasons: honouring it would keep a fleet's
  configuration in as many places as it has containers, and ignoring it would quietly *lower* the
  limits of an estate whose compose file set one above the code default
- AND the requirements for the settings themselves are in `gateway-settings`

#### Scenario: An integer bound is given a destructive value

- GIVEN `REVISION_KEEP_COUNT`, `MAX_TRUST_ANCHORS` or `DASHBOARD_DEFAULT_SINCE_MIN` is `0`
- WHEN the control plane starts
- THEN it SHALL refuse to start and name the variable
- AND the message SHALL say what the value would mean — no revision kept, no anchor registrable,
  no window to report on

#### Scenario: A non-negative integer is malformed

- GIVEN an integer-valued variable is set to a non-integer or a negative number
- WHEN it is read
- THEN startup SHALL fail with `<NAME>: expected a non-negative integer`

#### Scenario: A boolean is malformed

- GIVEN a boolean-valued variable is set to anything other than `1` or `0`
- WHEN it is read
- THEN startup SHALL fail with `<NAME>: expected 1 or 0, got "<value>"`

### Requirement: Every ceiling has a defined behaviour past it

Each configured bound SHALL have a documented behaviour when it is exceeded, so a limit is
arithmetic rather than a hope.

#### Scenario: A compiled validator bundle exceeds its ceiling

- GIVEN an imported definition compiles to more than `ARTIFACT_MAX_BYTES`
- WHEN the import is processed
- THEN the import SHALL be refused rather than the bundle shipped
- AND the reason SHALL be that every gateway in the environment downloads it, so an unbounded
  bundle is a fleet-wide cost

#### Scenario: A playground request or response exceeds its ceiling

- GIVEN a playground request body exceeds `PLAYGROUND_MAX_BODY_BYTES`
- WHEN the caller sends it
- THEN the request SHALL be refused, and the editor SHALL say so before sending
- AND WHEN a response exceeds `PLAYGROUND_MAX_RESPONSE_BYTES` THEN the body SHALL be truncated and
  the response SHALL state that it was

#### Scenario: Stored playground history is larger than its ceiling

- GIVEN a call is recorded in history
- WHEN the stored request body or response preview exceeds `PLAYGROUND_HISTORY_BODY_BYTES`
- THEN only the stored copy SHALL be bounded, and what was actually sent SHALL be unaffected

### Requirement: Validate the promotion chain and the targets against each other

The environment model SHALL be internally consistent at boot.

#### Scenario: The chain is empty or repeats an environment

- GIVEN `PROMOTION_CHAIN` is empty, or names an environment twice
- WHEN the control plane starts
- THEN startup SHALL fail, saying the chain must be an order

#### Scenario: A target names an environment outside the chain

- GIVEN `TARGETS_FILE` declares a target whose `environment` is not in `PROMOTION_CHAIN`
- WHEN the control plane starts
- THEN startup SHALL fail, naming the target, the environment and the chain
- AND the reason SHALL be that a target nothing can be released to is a misconfiguration

### Requirement: Parse the targets file at boot, not at first use

`TARGETS_FILE` SHALL be fully validated at startup.

#### Scenario: A gateway name is malformed or duplicated

- GIVEN a target's `name` does not match `^[a-z0-9][a-z0-9-]{0,31}$`, or two targets in one
  environment share a name
- WHEN the file is parsed
- THEN startup SHALL fail, naming the file, the environment and the offending name
- AND the message SHALL show the expected shape with an example

#### Scenario: A gateway category is unknown

- GIVEN a target declares a `category` outside `managed | samb | other`
- WHEN the file is parsed
- THEN startup SHALL fail, naming the gateway and listing the legal categories

#### Scenario: Public and intranet URLs are seeds only

- GIVEN a target row already exists for `<environment>/<name>`
- WHEN the control plane restarts with a changed `publicUrl`, `intranetUrl` or `label` in the file
- THEN the stored row SHALL NOT be overwritten
- AND the reason SHALL be that an administrator can change these on the Gateways screen, and a
  file that reasserted itself at every boot would silently undo them

#### Scenario: Playground gateway URLs are validated

- GIVEN a target declares `config.gatewayUrls`
- WHEN the file is parsed
- THEN every entry SHALL have a non-empty `label` unique within the environment, and an absolute
  `http`/`https` URL with no query string and no fragment
- AND any trailing slash SHALL be stripped, because the route's base path is appended
- AND an absent `gatewayUrls` SHALL be legitimate, disabling the playground in that environment,
  which the playground endpoint SHALL say in as many words and name `TARGETS_FILE`

### Requirement: Check every outbound host against the egress allowlist at boot

Any host the control plane will itself fetch SHALL be checked against the allowlist at startup, on
the configured string, without a network call.

#### Scenario: The identity provider is not allowlisted

- GIVEN `AUTH_PROVIDERS` includes `oidc` and `OIDC_ISSUER`'s host is not in the egress allowlist
- WHEN the control plane starts
- THEN startup SHALL fail, quoting the allowlist error and naming `INTEGRATIONS_FILE`
- AND no discovery request SHALL be made during this check, because fetching here would make the
  control plane refuse to start while the identity provider restarts

#### Scenario: The log cluster is not allowlisted

- GIVEN `LOGS_PROVIDER=elk` and `ELK_URL`'s host is not allowlisted
- WHEN the control plane starts
- THEN startup SHALL fail naming `ELK_URL` and the integrations file

#### Scenario: A playground gateway URL is not allowlisted

- GIVEN a `config.gatewayUrls` entry names a host the allowlist refuses
- WHEN the control plane starts
- THEN startup SHALL fail, listing every refused entry with its environment and label
- AND the reason SHALL be that a playground that can reach nothing should say so at startup, not
  at the first click

### Requirement: Refuse a dangling integration reference at boot

`INTEGRATIONS_FILE` SHALL be validated as a whole, including references from policy.

#### Scenario: A registered reference does not resolve

- GIVEN a policy names an `issuerRef`, `credentialRef` or `tokenProviderRef` that the integrations
  file does not define
- WHEN the control plane starts
- THEN startup SHALL fail, naming both the reference and where it is used
- AND the reason SHALL be that a policy pointing at a missing secret would otherwise fail at the
  first request instead

#### Scenario: An older integrations file omits the ceilings

- GIVEN the file has no `xml`, `validationCeilings` or `tlsExceptionMaxDays`
- WHEN it is read
- THEN the documented defaults SHALL be merged in
- AND the file SHALL remain valid, because the ceilings are administrator configuration with safe
  defaults rather than required keys

### Requirement: Log provision never silently falls back

`LOGS_PROVIDER` SHALL be honoured exactly.

#### Scenario: The provider is `elk` and the cluster is unreachable

- GIVEN `LOGS_PROVIDER=elk`
- WHEN a log query fails
- THEN the failure SHALL be reported to the caller
- AND the control plane SHALL NOT fall back to the mock provider, because a portal that quietly
  invented traffic when the log cluster was down would present fiction as observation

#### Scenario: The provider is `elk` with no credential

- GIVEN `LOGS_PROVIDER=elk` with neither `ELK_API_KEY` nor `ELK_USERNAME` set
- WHEN the control plane starts
- THEN startup SHALL fail, saying an unauthenticated log cluster is not assumed

#### Scenario: The provider is `mock`

- GIVEN `LOGS_PROVIDER` is unset or `mock`
- WHEN a log query is served
- THEN the results SHALL be deterministic and derived from the estate
- AND the response SHALL be marked `simulated`, and every screen showing them SHALL say so

### Requirement: Serve the portal and the API from one process

The control plane SHALL serve the built SPA alongside `/api/**`.

#### Scenario: A client-side route is loaded directly

- GIVEN a user opens `/{applicationId}/apis/{resourceId}` in a fresh tab
- WHEN the request reaches the control plane
- THEN `UI_DIST`'s `index.html` SHALL be served, so a client-side route survives a hard refresh
- AND paths under `/api/`, `/auth/`, `/healthz` and `/readyz` SHALL NOT be served by that fallback

#### Scenario: A development portal runs on its own origin

- GIVEN `UI_DEV_ORIGIN` names the Vite dev server
- WHEN a mutating request arrives with that `Origin`
- THEN the CSRF origin check SHALL accept it
- AND this SHALL NOT be gated on how people sign in, because whether a dev server is running is
  not a fact about authentication

### Requirement: Bound every request body

The control plane SHALL cap what it will read.

#### Scenario: A JSON body exceeds the cap

- GIVEN a request body larger than the route's cap (1 MiB by default)
- WHEN it is read
- THEN the request SHALL be refused with a `400` whose `detail` states the cap in bytes

#### Scenario: A body is not valid JSON

- GIVEN a non-empty body that does not parse
- WHEN it is read
- THEN the request SHALL be refused with `body is not valid JSON: <parser message>`
- AND an empty body SHALL be read as `{}`

### Requirement: Two planes are configured independently

The data plane SHALL take from its own environment only what is true of this container — how to
reach the control plane, who this instance is, where its files are, and what the network in front
of it is — and hold no copy of the control plane's configuration.

#### Scenario: An instance is given its identity

- GIVEN `GATEWAY_TOKEN` or `GATEWAY_TOKEN_FILE` and `GATEWAY_CP_URL`
- WHEN the instance starts
- THEN it SHALL poll the control plane with that bearer token
- AND everything else it serves SHALL come from the configuration document, not from its own
  environment — including its own bounds, which are the document's `settings` block since
  `configVersion` 6

#### Scenario: The instance has never reached the control plane

- GIVEN no cached configuration at `GATEWAY_CONFIG_CACHE`
- WHEN `/readyz` is called
- THEN it SHALL answer `503`
- AND `/healthz` SHALL still answer `200` with the health body
