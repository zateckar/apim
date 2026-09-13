# ai-gateway-mcp-a2a Specification

## Purpose

Define the two RPC variants — an **MCP server** and an **A2A agent** — as published resources. Each
is an API already: it has a contract, an endpoint and callers who need to be authenticated, rate
limited and kept honest. Publishing one means normalizing it into the same `ApiModel` every other
variant uses and letting the rest of the spine work unchanged.

## Requirements

### Requirement: An MCP server and an A2A agent are resource kinds, not a separate product

#### Scenario: A resource kind is chosen

- GIVEN the publish wizard
- WHEN the type is chosen
- THEN `mcp` and `a2a` SHALL be offered beside `rest` and `soap`
- AND everything downstream — subscriptions, products, promotion, policy, telemetry, the catalogue,
  the playground — SHALL work unchanged
- AND the set of kinds SHALL remain closed and extended only by reviewed work in the codebase,
  because a variant carries a request shape and a validation model

#### Scenario: The sidebar is grouped

- GIVEN a selected application
- WHEN the sidebar renders
- THEN **MCP Servers** and **A2A Agents** SHALL each be their own section beside APIs
- AND opening one SHALL list only that kind

### Requirement: Discover the contract rather than asking a publisher to describe it

#### Scenario: An MCP server is published

- GIVEN a discovery URL
- WHEN the definition is imported
- THEN the server's manifest SHALL be normalized into `ApiModel`, carrying the protocol version, the
  server info, the declared capabilities, the tools with their input and output schemas, the
  resources and the prompts

#### Scenario: An A2A agent is published

- GIVEN a discovery URL
- WHEN the definition is imported
- THEN the Agent Card SHALL be fetched and normalized, carrying the protocol version, the name,
  description, version, transport preference, capabilities, default input and output modes, the
  skills, and the origin URL it was fetched from
- AND the pre-0.3 card location SHALL also be tried, because agents in the wild still serve it

#### Scenario: A discovery URL is fetched

- GIVEN any discovery URL
- WHEN it is fetched
- THEN it SHALL be checked against the denied ranges and the deny rules first, exactly as a
  definition import is (`egress-governance`)

### Requirement: Protocol methods are operations like any other

#### Scenario: An MCP server's operations are indexed

- GIVEN a normalized MCP model
- WHEN the operation index is built
- THEN each protocol method — `initialize`, `ping`, `tools/list`, `tools/call`, and the resource,
  prompt, logging and completion methods the server's capabilities declare — SHALL be an operation
  with a fixed schema for its `params`
- AND each tool SHALL additionally be an operation selected by `tools/call:<tool-name>`
- AND a method whose capability the server does not declare SHALL NOT be published

#### Scenario: A publisher rate limits one method differently

- GIVEN the operations index
- WHEN a per-operation policy override is attached
- THEN `tools/list` SHALL be limitable separately from `tools/call`
- AND a malformed `params` SHALL be rejected by validation before it reaches the server

#### Scenario: An operation is resolved from a request

- GIVEN a JSON-RPC body on a single-endpoint route
- WHEN the operation is resolved
- THEN it SHALL be selected by the method, and for a tool call by the method **and** the tool name
- AND resolution SHALL happen after authentication and authorization, because parsing a body is
  work an unauthenticated caller must not be able to cause

### Requirement: The gateway serves the agent card itself, rewritten

#### Scenario: A consumer fetches the agent card

- GIVEN a published A2A agent
- WHEN its card is fetched through the gateway
- THEN the gateway SHALL serve the card with `url` pointing at the **route**, and the security
  schemes describing the **gateway's own**
- AND the origin's schemes SHALL be kept for the record but not advertised
- AND the reason SHALL be that publishing an endpoint means consumers talk to us, and a card still
  pointing at the origin would send every consumer straight past every policy this platform exists
  to apply

#### Scenario: An agent is unlisted

- GIVEN an A2A resource marked `unlisted`
- WHEN the card is requested
- THEN it SHALL be private
- AND this SHALL be the same switch that hides the resource from the catalogue, so it is one
  decision rather than two

### Requirement: Streaming methods need an explicit passthrough

#### Scenario: A streaming method is published

- GIVEN an A2A method that answers with a server-sent-event stream
- WHEN the route is configured
- THEN it SHALL require the `passthrough` unit's streaming mode
- AND a streaming method published without it SHALL be reported rather than silently buffered

### Requirement: An RPC route always requires a subscription

#### Scenario: An MCP or A2A route is published

- GIVEN a new `mcp` or `a2a` resource
- WHEN its default policy is decided
- THEN it SHALL require a subscription key, as every other kind does
- AND removing that requirement SHALL remain an administrator's decision

### Requirement: Derive an RPC route's address the same way as any other

#### Scenario: An MCP or A2A path is derived

- GIVEN a domain, sub-domain, name and version
- WHEN the base path is derived
- THEN it SHALL follow the same `publishedPath` derivation as a REST or SOAP API
- AND the name and version SHALL be validated against the same patterns
- AND the whole resource SHALL answer on **one** endpoint under that base path, because the request
  shape is a JSON-RPC call rather than a path and a method

### Requirement: Show what was discovered, in the workspace and the catalogue

#### Scenario: An MCP workspace is opened

- GIVEN a published MCP server
- WHEN its definition panel renders
- THEN the discovered tools SHALL be summarised with their names, titles, descriptions and argument
  schemas
- AND the summary SHALL reflect the **current** revision's model rather than a re-fetch of the
  origin

#### Scenario: An A2A workspace is opened

- GIVEN a published A2A agent
- WHEN its definition panel renders
- THEN the discovered skills SHALL be summarised with their ids, names, descriptions, tags, examples
  and input and output modes
- AND the card as the gateway will serve it SHALL be inspectable

#### Scenario: An RPC resource is listed in the catalogue

- GIVEN a published MCP server or A2A agent
- WHEN it appears in the catalogue
- THEN it SHALL carry a kind badge distinguishing it from a REST or SOAP API
- AND its listing SHALL show the tools or skills a consumer would be subscribing to

### Requirement: Count an RPC error as an outcome, without judging the contract

#### Scenario: A JSON-RPC response carries an error

- GIVEN a response from an MCP server or A2A agent
- WHEN the outcome is counted
- THEN a body carrying an `error` member SHALL be counted as an RPC error
- AND a body that does not parse SHALL simply not be an RPC error
- AND the response SHALL be passed through either way, with whether it matches the contract left to
  response validation, which has its own state and its own counters
