# auth-and-access Specification

## Purpose

Define who the portal knows, how they prove it, what a session is worth, and the one authorization
rule that decides everything else. See *The Authorization Rule* and *Environment Variables* in
`openspec/project.md`.

## Requirements

### Requirement: Explain missing application membership accurately

#### Scenario: An account has no memberships

- GIVEN an account without explicit application memberships
- WHEN its account or directory page explains access
- THEN it SHALL say a member needs application membership to subscribe or publish
- AND it SHALL distinguish administrators, who may act for every application

### Requirement: Support three sign-in providers, declared explicitly

`AUTH_PROVIDERS` SHALL be an ordered, comma-separated subset of `local`, `oidc`, `dev`, with no
default.

#### Scenario: The sign-in screen is rendered

- GIVEN `GET /api/auth/providers` is called without a session
- WHEN the portal renders the sign-in screen
- THEN it SHALL offer exactly the configured providers, in the configured order, with the first
  one focused
- AND when `oidc` is configured, its button SHALL be labelled `OIDC_DISPLAY_NAME`, so a deployment
  can say "Škoda ID" rather than "Single sign-on"

#### Scenario: The development bypass is configured beside a real directory

- GIVEN `AUTH_PROVIDERS` contains both `dev` and `oidc`
- WHEN the control plane starts
- THEN startup SHALL fail
- AND the reason SHALL be that the bypass lets anybody become any development user without a
  password, and beside a real identity provider it is a way in that looks like it is not there

#### Scenario: A user signs in through the development bypass

- GIVEN `AUTH_PROVIDERS` includes `dev`
- WHEN `POST /api/auth/dev-login` is called with a `userId` from the fixed development list
- THEN a session SHALL be created for that principal with no credential
- AND the route SHALL be absent when `dev` is not configured

### Requirement: Local sign-in is rate limited, locked out, and constant-cost

The `local` provider SHALL hash passwords with argon2id and SHALL NOT let its cost become a lever.

#### Scenario: A password is stored

- GIVEN a local password is set
- WHEN it is hashed
- THEN argon2id SHALL be used at `memoryCost: 19456` KiB and `timeCost: 2`
- AND the password length SHALL be capped, so an unbounded request body is never hashed
- AND it SHALL be at least `LOCAL_PASSWORD_MIN_LEN` characters

#### Scenario: An unknown username is presented

- GIVEN a username no principal has
- WHEN sign-in is attempted
- THEN a fixed dummy verify SHALL still run, so the response time does not distinguish a real
  username from an invented one
- AND the attempt SHALL be written to the audit log without any password material, not even its
  length, because "somebody is guessing usernames" is a signal an operator needs

#### Scenario: Repeated failures lock the account

- GIVEN a principal has failed sign-in `LOCAL_LOCKOUT_THRESHOLD` times
- WHEN the threshold is reached
- THEN the account SHALL be locked for `LOCAL_LOCKOUT_MINUTES`, and the failure counter reset
- AND a sign-in attempt during the lock SHALL still perform the dummy verify and SHALL be audited
  as a lockout
- AND a successful sign-in SHALL clear both the counter and the lock and record `last_login_at`

#### Scenario: A credential-spray attack is attempted

- GIVEN one password is tried against many usernames
- WHEN the attempts arrive
- THEN a global limit of `LOCAL_LOGIN_RATE_PER_MIN` SHALL apply across all callers, in front of the
  hash
- AND the reason SHALL be that a spray never trips a per-principal counter, and a hash per request
  is otherwise enough to saturate the process's CPU with no credential at all

#### Scenario: The bootstrap admin is created

- GIVEN `BOOTSTRAP_ADMIN_USERNAME` and `BOOTSTRAP_ADMIN_PASSWORD` are both set and no such
  principal exists
- WHEN the control plane starts
- THEN the account SHALL be created with `must_change = 1`
- AND the reason SHALL be that a password passed through the environment is in a compose file, a
  shell history and `docker inspect`, so it cannot be the one the account keeps
- AND setting only one of the two variables SHALL fail startup, saying they go together
- AND a bootstrap password shorter than `LOCAL_PASSWORD_MIN_LEN` SHALL fail startup, because the
  account with every permission is not the one to exempt

#### Scenario: A forced password change is outstanding

- GIVEN a principal has `must_change = 1`
- WHEN they call any route other than reading who they are, changing their password, or signing out
- THEN the request SHALL be refused
- AND the refusal SHALL be a gate, not a suggestion

### Requirement: OIDC claims are re-read on a bounded interval

An OIDC session SHALL NOT be a frozen copy of the claims it was issued with.

#### Scenario: Roles or groups change at the identity provider

- GIVEN a signed-in OIDC user whose claims were last refreshed more than `OIDC_CLAIMS_REFRESH_SEC`
  ago
- WHEN they make a request that is not itself an authentication route
- THEN the claims SHALL be re-read before the directory is consulted
- AND the authentication routes SHALL be excluded, which would otherwise recurse

#### Scenario: Claims are mapped into the portal's model

- GIVEN a token with `OIDC_ROLE_CLAIM` (default `realm_access.roles`, a dotted path) and
  `OIDC_GROUP_CLAIM`
- WHEN the session is established
- THEN a principal carrying `OIDC_ADMIN_ROLE` SHALL be an administrator by `idp_admin`, distinct
  from a locally granted `role = admin`
- AND the group claim SHALL produce memberships marked `source = "idp"`, distinguishable from
  memberships granted locally
- AND a screen SHALL be able to say where an admin flag came from — `local`, `idp` or `both` — so a
  local demotion that changes nothing is explicable

### Requirement: Provision an application from the group that names it

A group in the token SHALL be enough to own APIs, products, subscriptions and certificates under.
No administrator SHALL have to create or map an application first.

The identity provider is authoritative for who owns what, so holding the group **is** the grant and
a confirmation step could only ever say yes. An application row still exists — `resource`,
`product`, `subscription`, `certificate` and `membership` all carry `application_id` — but it is
provisioned from the token rather than by hand.

#### Scenario: A group names no application yet

- GIVEN a token whose group claim carries a value no application is bound to
- WHEN the claims are applied, at sign-in or at a claims refresh
- THEN an application SHALL be provisioned for it, with the group stored as its `source_group`
- AND its id SHALL be derived from the group's last path segment, so Keycloak's `/apim/orders`
  provisions `orders`
- AND the creation SHALL be audited against the principal whose token carried the group, because
  nobody decided it and "who caused this to exist" is the question the row answers
- AND applying the same claims again SHALL match the row rather than provision a second one

#### Scenario: An administrator already created the application by hand

- GIVEN an application whose id a group derives, carrying no `source_group`
- WHEN that group is applied
- THEN the existing application SHALL be adopted and bound to the group, not duplicated

#### Scenario: Two groups would take one name

- GIVEN an application already bound to one group
- WHEN a different group derives the same id
- THEN the existing application SHALL be left alone and the second group SHALL be reported as
  unprovisioned
- AND the reason SHALL be that handing it over would give one group's holders another group's APIs

#### Scenario: A group carries no usable name

- GIVEN a group value that yields no id matching `^[a-z0-9][a-z0-9_-]{1,47}$`
- WHEN it is applied
- THEN it SHALL be reported as unprovisioned rather than given an invented name

#### Scenario: The callback origin does not match the portal's

- GIVEN `OIDC_REDIRECT_URI`'s origin differs from `PUBLIC_URL`'s
- WHEN the control plane starts
- THEN startup SHALL fail
- AND the reason SHALL be that the callback is what sets the session cookie, a cookie set on
  another origin is never sent back, and the user would complete sign-in and arrive signed out

### Requirement: A session points at the directory rather than carrying a copy of it

Authorization SHALL be resolved from the directory on every request.

#### Scenario: An administrator changes somebody's role or memberships

- GIVEN a signed-in user
- WHEN an administrator changes their role or their applications
- THEN the change SHALL take effect on that person's **next request**, not at their next sign-in
- AND `roles_json` and `applications_json` on the session SHALL remain as the login-time snapshot,
  kept because "what was this person allowed to do when they signed in" is an audit question, not
  an authorization one

#### Scenario: A principal is disabled

- GIVEN a signed-in principal
- WHEN they are disabled
- THEN their session SHALL stop working on its next request
- AND this SHALL be the local kill switch a deployment needs when the identity provider's own
  offboarding is slower than the incident

### Requirement: Bound sessions by idle time and by absolute lifetime

The two bounds SHALL be distinct and both SHALL be enforced.

#### Scenario: A session is used

- GIVEN a valid session
- WHEN a request is served
- THEN `idle_until` SHALL slide forward by `SESSION_IDLE_MIN` and `last_seen_at` SHALL be recorded,
  in the one write the request was making anyway
- AND `expires_at` SHALL NOT move

#### Scenario: A session passes either bound

- GIVEN `expires_at` or `idle_until` is in the past, or `revoked_at` is set
- WHEN the session is resolved
- THEN it SHALL be treated as absent, and a `session` route SHALL answer `401` with
  `code: "no_session"`

#### Scenario: A user reviews where they are signed in

- GIVEN a signed-in user
- WHEN they call `GET /api/my/sessions`
- THEN every unrevoked, still-valid session SHALL be listed with its provider, creation time, last
  seen time, expiry, a truncated user agent, and which one is the current session
- AND they SHALL be able to revoke one (`DELETE /api/my/sessions/:id`) or all of them
  (`POST /api/my/sessions/revoke-all`)
- AND on the account page the controls SHALL say **Revoke**, the word the portal uses for ending a
  session wherever it is offered, and the list SHALL show a loading placeholder until it arrives
  rather than an empty table, which reads as "signed in nowhere"

#### Scenario: A password change signs the user out everywhere else

- GIVEN a user changes their own password
- WHEN the change succeeds
- THEN every other session of that principal SHALL be revoked
- AND the session making the change SHALL be spared, so the user is not signed out by their own
  success

#### Scenario: An administrator forces a sign-out

- GIVEN an administrator calls `DELETE /api/users/:id/sessions`, or disables the principal
- WHEN it succeeds
- THEN **every** session of that principal SHALL be revoked, sparing none

### Requirement: The portal signs the user back in when their session ends

A session that ends while the portal is open SHALL be answered with the sign-in screen, not with a
refusal on whichever screen happened to be polling.

#### Scenario: A request comes back saying there is no session

- GIVEN the portal is open on any screen
- WHEN any request answers `401` carrying `code: "no_session"` or `code: "session_expired"`
- THEN the sign-in screen SHALL be rendered **instead of** the portal, for the reason the forced
  password change is: the control plane now refuses everything, and a shell whose every link
  answers `401` is a worse lie than one screen that says what happened
- AND unmounting the portal SHALL be what stops the refusals, because it takes the shell's ticker
  and every screen's polling with it
- AND the address in the browser SHALL NOT change, so signing in again returns the user to the
  screen they were on

#### Scenario: The sign-in screen is reached this way rather than at a first visit

- GIVEN the sign-in screen is shown because a session ended
- WHEN it is drawn
- THEN it SHALL say that the session ended, name the person it ended for when that is known, and
  say that a part-finished form was not kept
- AND a local account's username SHALL be filled in already, with the caret in the password box
- AND an OIDC principal's username SHALL NOT be filled into the local form, because it is the name
  they have at the identity provider and not one this portal has ever held a password for

#### Scenario: A refusal that is not the session ending

- GIVEN a `401` carrying `code: "bad_credentials"`, a `401` carrying no code, or a `503` carrying
  `code: "auth_backend_unavailable"`
- WHEN the portal receives it
- THEN the session SHALL be left alone and the refusal SHALL be rendered where it happened
- AND the reason SHALL be that a rejected password is an answer to that request, and an identity
  provider outage is not the user being signed out

#### Scenario: The user signs in again

- GIVEN the sign-in screen shown because a session ended
- WHEN the sign-in succeeds
- THEN `GET /api/me` SHALL be re-read and the portal mounted afresh, so that no screen carries data
  or a refusal from the session that ended

### Requirement: The session cookie is HttpOnly, SameSite=Lax, and Secure on HTTPS

#### Scenario: A session is issued

- GIVEN a successful sign-in
- WHEN the cookie is set
- THEN it SHALL be named `apim_session`, with `Path=/`, `HttpOnly` and `SameSite=Lax`
- AND `Secure` SHALL be added when `PUBLIC_URL` is `https://`

### Requirement: Check the origin of every cookie-authenticated write

#### Scenario: A mutating request arrives on a session

- GIVEN a `POST`, `PUT`, `PATCH` or `DELETE` on a `session` route
- WHEN it is dispatched
- THEN its `Origin` — or the origin of its `Referer` when `Origin` is absent — SHALL match
  `PUBLIC_URL` or `UI_DEV_ORIGIN`
- AND a request with neither header SHALL be refused with `403` and a message naming the header and
  showing the expected value
- AND a mismatched origin SHALL be refused with `403` naming the presented origin and the allowed
  ones

### Requirement: Enforce one authorization rule on the server, on every request

`can(user, applicationId) = user.isAdmin || applicationId ∈ user.applications`.

#### Scenario: A member acts on another application's object

- GIVEN a signed-in member of application A
- WHEN they attempt to change a resource, product, subscription, certificate or Kafka topic owned
  by application B
- THEN the request SHALL be refused with `403`
- AND the application picker in the browser SHALL be understood as context, not proof

#### Scenario: Anybody reads anything

- GIVEN any signed-in user
- WHEN they read the catalogue, an API listing, the health of the estate or an application's page
- THEN it SHALL be served
- AND the read SHALL carry `capabilities: ["read"]` when they cannot change it

#### Scenario: The caller can change the object

- GIVEN `can(user, applicationId)` is true
- WHEN the object is serialized
- THEN it SHALL carry `capabilities: ["read","update","delete","publish","policy"]`

#### Scenario: An administrator acts anywhere

- GIVEN an administrator
- WHEN they act on any object
- THEN it SHALL be permitted, and audited with their identity

#### Scenario: An action inside an owned object is an administrator's

- GIVEN `can(user, applicationId)` is true but the caller is not an administrator
- WHEN their write would change whether the API requires a subscription key, or would move a policy
  unit the environment defines globally — see `api-policy-controls`
- THEN it SHALL be refused, naming what only an administrator can do
- AND the reason SHALL be that these decide what the platform *enforces* rather than what one
  application owns, so the `policy` capability is not the whole answer for them
- AND the set of such carve-outs SHALL be small enough to enumerate, because a permission model
  nobody can state is one nobody can rely on

### Requirement: Refuse an action visibly, never by hiding it

The portal SHALL disable an action the caller cannot perform and state why.

#### Scenario: A control the caller cannot use is rendered

- GIVEN an object whose `capabilities` do not include the action's capability
- WHEN the control is rendered
- THEN it SHALL be disabled with one sentence naming who *can* — "Only a member of the Orders
  application, or an administrator, can …"
- AND the sentence SHALL name the application's **display name**, because "the Orders application"
  is a group somebody can go and find and `application_orders` is not
- AND the control SHALL NOT be hidden, because a hidden button teaches the reader that the feature
  does not exist

#### Scenario: A non-admin deep-links into an administration screen

- GIVEN a member opens `/trust`, `/gateways`, `/policy` or any other `operate` screen
- WHEN it renders
- THEN the screen SHALL be shown with every control disabled and one line saying only a platform
  administrator can change it, and that the current state is readable here

#### Scenario: A control is blocked by state rather than by permission

- GIVEN a frozen revision, or an API with no definition yet
- WHEN the control is rendered
- THEN it SHALL use the same shape as a permission refusal, so a screen never has two ways of
  saying "not now"
- AND when both a permission reason and a state reason apply, the **first** SHALL be shown

### Requirement: The last enabled administrator cannot be removed

#### Scenario: The last admin is disabled or demoted

- GIVEN exactly one enabled administrator
- WHEN a request would disable or demote them
- THEN it SHALL be refused with `409`
- AND the reason SHALL be that a deployment would otherwise lock itself out of its own trust store,
  global policy and audit log with one click

#### Scenario: A principal acts on themselves

- GIVEN any administrator, including one of several
- WHEN they attempt to disable or demote themselves
- THEN it SHALL be refused with `409`
- AND the status SHALL be `409` rather than `403`, because the caller *is* an administrator; there
  is simply no valid end state on the other side

### Requirement: Gateway instances authenticate with a minted bearer token

#### Scenario: An instance polls

- GIVEN a route declared `instance`
- WHEN it is called
- THEN the `Authorization: Bearer` token SHALL be compared in **constant time** against the stored
  hash of every unrevoked `gateway_instance`
- AND a missing token SHALL answer `401` saying a gateway instance bearer token is required
- AND an unknown or revoked token SHALL answer `401` saying so

#### Scenario: An instance token is revoked

- GIVEN an administrator revokes an instance
- WHEN that instance next polls
- THEN it SHALL be refused, and it SHALL stop serving at that poll

### Requirement: Audit every mutation

#### Scenario: A change is made

- GIVEN any mutating action
- WHEN it completes
- THEN one `audit` row SHALL be appended with actor, action, subject, outcome
  (`ok | denied | failed`) and enough detail to answer "who changed this, when, and to what"
- AND the table SHALL be append-only, enforced by a database trigger
- AND no audit detail SHALL contain a key, a password, or private key material

### Requirement: Shape every refusal as a problem document

#### Scenario: Any request fails

- GIVEN a refusal at any layer
- WHEN the response is written
- THEN it SHALL be `application/problem+json` carrying `type`, `title`, `status`, `detail` and
  `requestId`
- AND `x-request-id` SHALL be set on every response, successful or not
- AND `detail` SHALL be the sentence a human reads

#### Scenario: An unexpected error escapes a handler

- GIVEN an error that is not a declared refusal
- WHEN it reaches the dispatcher
- THEN it SHALL be logged with the method and path, and answered as `500` with the same problem
  shape
- AND no internal host, connection string or stack trace SHALL appear in the body

#### Scenario: A path exists but the method does not

- GIVEN a path that matches a route pattern under a different method
- WHEN it is called
- THEN the answer SHALL be `405 Method Not Allowed` naming the method, not `404`

### Requirement: Validate password length before saving

#### Scenario: A draft is edited

- GIVEN an account password-change form
- WHEN its fields are edited
- THEN it SHALL read the configured minimum from the public authentication-provider metadata and enforce it with the 200-character maximum before submission
- AND it SHALL keep confirmation matching and render metadata-loading errors
