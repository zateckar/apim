# egress-governance Specification

## Purpose

Define the boundary of what this platform may reach: which backends a gateway may be pointed at, and
which networks nothing may reach at all.

Until v1.4.0 the boundary was an **allowlist** in `INTEGRATIONS_FILE` — every backend host a team
wanted had to be added to a file and the control plane restarted. That is defensible for an estate
with a handful of backends and untenable for a self-service one with many: registering an API became
a ticket, and the list that was supposed to be read as a security decision became a list nobody read
at all.

The boundary is now stated the other way round. Egress is **allowed by default and forbidden by
rule**: an administrator writes deny rules in the portal, and the denied network ranges stay in the
file where nothing clickable can widen them. What was one list doing two jobs is now two controls
with different owners, different change speeds, and different blast radii.

This capability governs the deny rules and the denied ranges. `backend-integration-surface` governs
what a binding *is*; `trust-store` governs what a gateway will accept *from* a backend once it
connects. The portal surfaces all three on `/trust`, because they are the same question — what do we
reach, and what do we believe when we get there — asked from three sides.

**This is not a firewall, and SHALL NOT be described as one.** Rules match the backend URL a person
wrote down. Packet-level guarantees are network egress policy and live outside this platform. See
*The Stated Limit* below.

## Requirements

### Requirement: Allow egress by default and forbid it by rule

The platform SHALL NOT require a host to be registered before it may be used as a backend.

#### Scenario: A backend URL names a host no rule mentions

- GIVEN an owner saves a backend whose host matches no deny rule and resolves outside every denied
  range
- WHEN it is written
- THEN it SHALL be accepted without an administrator having registered it first
- AND no restart SHALL be required of anything

#### Scenario: The inversion is questioned

- GIVEN the design
- WHEN it is reviewed
- THEN the reason SHALL be that an allowlist in a file makes every backend registration a ticket and
  a control-plane restart, which at this estate's size converts a security control into an
  obstruction that is routed around rather than read
- AND the two controls it is replaced by SHALL be stated: denied **ranges**, which no portal action
  can widen, and denied **hosts**, which an administrator states in the portal with a reason
- AND what is knowingly given up SHALL be stated: the control plane will now fetch an owner-supplied
  public URL it has not been told about in advance — a specification import, an MCP or A2A discovery
  document — bounded only by the denied ranges and by never following a redirect

#### Scenario: A retired allowlist is still in the file

- GIVEN an `INTEGRATIONS_FILE` that still declares `egressAllowlist`
- WHEN the control plane starts
- THEN startup SHALL fail, naming the key, saying it is retired, and naming the portal screen that
  replaced it
- AND the reason SHALL be that ignoring it silently would leave an operator believing they are
  protected by a list nothing reads — the one failure mode worse than having no list

### Requirement: Keep the denied ranges in the file, where nothing clickable can widen them

`denyCidrs` SHALL remain in `INTEGRATIONS_FILE`, SHALL be applied after DNS resolution, and SHALL
have no portal surface that edits it.

#### Scenario: A host resolves into a denied range

- GIVEN any owner-supplied URL — a backend, a specification import, an MCP or A2A discovery document
- WHEN it is written
- THEN its hostname SHALL be resolved and every resulting address checked against `denyCidrs`
- AND a match SHALL refuse the write, naming the address and the range it fell inside
- AND the reason SHALL be that a name is not a boundary: `metadata.internal` and a hostname an owner
  controls can point at the same address

#### Scenario: The ranges are chosen

- GIVEN a deployment
- WHEN its denied ranges are set
- THEN `169.254.0.0/16` SHALL be denied, because it is the cloud instance metadata service and
  reaching it from a request the platform makes is the SSRF that matters
- AND loopback SHALL be denied — `127.0.0.0/8` — because a backend on loopback is a process inside
  the control plane's or the gateway's own container
- AND the control plane's own address SHALL be denied, so that no route can be pointed back at the
  portal's API
- AND RFC1918 SHALL **not** be denied wholesale, because this estate's backends are internal: denying
  `10.0.0.0/8`, `172.16.0.0/12` and `192.168.0.0/16` would refuse almost every legitimate backend and
  make the whole control unusable
- AND an estate that wants a narrower internal range denied SHALL say so as a range here, or as a
  deny rule if it is a host rather than a network

#### Scenario: A URL names an IPv6 literal

- GIVEN a URL whose host is an IPv6 literal, such as `http://[::1]:9000`
- WHEN it is checked
- THEN it SHALL be refused outright, saying that an IPv6 literal cannot be checked against the
  denied ranges
- AND the reason SHALL be that `denyCidrs` is IPv4-only by construction, so admitting one would be
  admitting an address no range can match — `[::1]` would walk straight past a denied `127.0.0.0/8`
- AND a **name** that resolves to both families SHALL remain legitimate, because each family is
  judged by the rule that can see it — see the scenario below

#### Scenario: A name resolves to an IPv6 address

- GIVEN a hostname whose `AAAA` record is an internal address, with an `A` record that is public or
  with no `A` record at all
- WHEN it is checked
- THEN its IPv6 answers SHALL be checked as well as its IPv4 ones, and SHALL NOT be discarded
- AND an answer inside `::1/128`, `::/128`, `fc00::/7`, `fe80::/10` or `fec0::/10` SHALL refuse the
  write, naming the address and the range
- AND an IPv4-mapped answer (`::ffff:a.b.c.d`, in either spelling) SHALL be treated as the IPv4
  address it is and checked against `denyCidrs`
- AND an answer in none of those ranges SHALL be allowed, so an ordinary dual-stack backend is
  unaffected
- AND an answer neither family parses SHALL refuse the write, because admitting an address nothing
  checked is the failure this control exists to prevent
- AND the reason SHALL be that `denyCidrs` being IPv4-only makes an `AAAA` answer *uncheckable
  against that list*, which is a reason to judge it another way rather than to admit it: discarding
  those answers left the same hole the IPv6-literal refusal above closes, one hop behind a name
- AND the IPv6 ranges SHALL be named in the platform rather than configured, because they are
  internal by definition rather than by one estate's topology

#### Scenario: The repository's own copy differs from the deployable one

- GIVEN `config/integrations.json` in the repository
- WHEN it is read
- THEN it SHALL permit loopback, because the local stack's backends, MCP server and A2A agent are
  published on `127.0.0.1`
- AND it SHALL say in the file that it is the local copy and SHALL NOT be deployed
- AND the image SHALL carry it at `/app/config.sample/` as a **sample to edit** rather than as a
  default it mounts, so that inheriting the local stack's permissiveness takes a deliberate act
- AND the sample SHALL name loopback as the line to add before deploying

#### Scenario: The control plane's own address is derived

- GIVEN `PUBLIC_URL`
- WHEN the denied set is composed at boot
- THEN that origin's host SHALL be denied without an operator having to write it down
- AND the address gateways reach the control plane on SHALL be stated as a deny **rule** where it
  differs — `GATEWAY_CP_URL` is set on each gateway and is not knowable from the control plane
- AND the default estate SHALL ship that rule rather than leave it to be remembered

### Requirement: Make a deny rule an administrator object with a reason and a dated removal

#### Scenario: A rule is created

- GIVEN an administrator
- WHEN a deny rule is created
- THEN it SHALL carry a host pattern, an optional scheme, an optional port set, an optional
  environment, a reason, who created it and when
- AND it SHALL be an administrator action, disabled with a reason for anybody else
- AND it SHALL be audited

#### Scenario: A rule is given no reason worth reading

- GIVEN a reason shorter than 20 characters
- WHEN the rule is saved
- THEN it SHALL be refused, naming the minimum
- AND the reason SHALL be the same one a TLS exception carries: a control whose justification is
  `x` is a control nobody can review later

#### Scenario: A rule's scope is chosen

- GIVEN a rule
- WHEN its environment is left empty
- THEN it SHALL apply to every environment
- AND the reason SHALL be that "nothing may ever proxy to the domain controllers" is an estate-wide
  sentence, while "not from dev" is an environment one, and both are real

#### Scenario: A host is matched

- GIVEN a rule's host pattern
- WHEN a backend URL is checked
- THEN an exact host SHALL match that host only
- AND a `*.suffix` pattern SHALL match any host under that suffix and SHALL NOT match the bare
  suffix itself
- AND matching SHALL be case-insensitive and SHALL NOT resolve DNS
- AND the reason SHALL be that `denyCidrs` already owns the resolved-address question, and a rule
  whose verdict can be read off the screen is one that can be explained in a refusal

#### Scenario: A port is matched

- GIVEN a rule declaring `ports` or a `portRange`
- WHEN a backend URL is checked
- THEN the URL's port SHALL be compared, with the scheme's default port used when the URL omits one
- AND a rule declaring neither SHALL match every port

#### Scenario: A rule is removed

- GIVEN a live rule
- WHEN it is removed
- THEN the removal SHALL be dated rather than destructive, and SHALL be audited
- AND routes it was blocking SHALL be served again at the next configuration build
- AND the reason SHALL be that "who blocked this, and when did we stop" outlives the rule itself

#### Scenario: Too many rules are registered

- GIVEN more than `MAX_EGRESS_DENY_RULES` live rules
- WHEN another is created
- THEN it SHALL be refused, naming the constant
- AND the reason SHALL be that every rule is evaluated against every pool member on every write and
  every configuration build

### Requirement: Enforce a rule when a backend is written and again when the fleet is configured

A rule SHALL take effect on what is **already running**, not only on what is written next.

#### Scenario: A backend matching a rule is written

- GIVEN a pool member whose URL matches a live rule for that environment
- WHEN it is saved
- THEN it SHALL be refused, and the refusal SHALL name the pattern that matched and quote the rule's
  reason
- AND the refusal SHALL be the same whether the binding was set through the binding endpoint or
  through the native `configure` and `promote` commands, because a caller SHALL NOT reach through
  one door a state the other refuses

#### Scenario: A rule is created while a route it matches is live

- GIVEN a serving route whose backend matches a rule created afterwards
- WHEN the environment's configuration document is next built
- THEN the route SHALL be **omitted** from the document, with the rule and its reason in the
  document's `errors[]`
- AND every instance SHALL stop serving it within one poll interval
- AND the same entry SHALL raise an attention row for the owning application, so the team sees why
  their route stopped in the place they already look

#### Scenario: The control plane is about to fetch an owner-supplied URL

- GIVEN a specification import, or an MCP or A2A discovery document
- WHEN the control plane is about to fetch it
- THEN the deny rules SHALL apply as they do to a backend, and the refusal SHALL name what matched
- AND only **estate-wide** rules SHALL be consulted, because a fetch made while publishing is not
  yet an act in any one environment, and an environment-scoped rule is a statement about that
  environment's gateways
- AND the reason SHALL be that this is one boundary with two enforcement surfaces, not two lists: an
  administrator who has said the estate does not reach a host has not said it only about proxying

#### Scenario: The enforcement point is questioned

- GIVEN the design
- WHEN it is reviewed
- THEN the reason for enforcing at configuration build SHALL be that the document is already the only
  thing a gateway serves from, and a route omitted from it is a route no instance can serve
- AND `CONFIG_VERSION` SHALL NOT be raised for this, because nothing new travels: no gateway upgrade
  is required and no instance reports `activationBlocked`
- AND the data plane SHALL be unchanged, which keeps "the data plane never decides anything" true of
  this control as it is of every other

### Requirement: Show what a rule would block before it is saved

#### Scenario: A rule is being composed

- GIVEN a draft host pattern, scheme, ports and environment
- WHEN the administrator asks what it would do
- THEN every live route whose backend the draft would block SHALL be listed with its API, its
  application and its environment, before anything is written
- AND the count SHALL be stated plainly, including when it is zero
- AND the reason SHALL be that a rule saved here takes routes out of service across the fleet within
  seconds, and the registration flows on this screen already refuse to act on material nobody has
  been shown — an anchor is previewed before it is registered, a copy shows its difference before it
  is applied

#### Scenario: The dry run cannot be computed

- GIVEN a failing or loading dry run
- WHEN the form renders
- THEN it SHALL show the failure or the loading state rather than report that nothing would be
  blocked
- AND saving SHALL remain possible, because a dry run is an aid and not a gate

### Requirement: List every blocked route and every rule in one place

#### Scenario: The governance report is read

- GIVEN an administrator
- WHEN they read the governance report
- THEN every live deny rule SHALL be listed with its pattern, scope, reason, who created it and when
- AND every route currently blocked by one SHALL be listed with its API, application, environment and
  the rule that blocks it
- AND this SHALL sit beside the report's existing answer to "list every unverified backend in prod",
  because both are asked about the estate rather than about an API
- AND the report SHALL be administrator-only

#### Scenario: A rule blocks nothing

- GIVEN a live rule matching no current route
- WHEN the report renders
- THEN it SHALL still be listed, marked as blocking nothing
- AND the reason SHALL be that a rule blocking nothing today is still the estate's stated position,
  and is exactly what a rule written ahead of an incident looks like

### Requirement: State the limit rather than imply a guarantee

#### Scenario: The control's reach is described

- GIVEN any screen, refusal or document describing this control
- WHEN it explains what a rule does
- THEN it SHALL say that rules match the backend URL as written
- AND it SHALL NOT claim that traffic to a blocked host is prevented at the network, because a
  hostname no rule matches may resolve to the same address as one that does
- AND the residual case SHALL be named: `denyCidrs` catches it only when the address falls inside a
  denied range, and everything beyond that is network egress policy outside this platform
