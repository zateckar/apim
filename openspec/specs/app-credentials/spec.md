# app-credentials Specification

## Purpose

Define the credentials an application keeps for itself: the passwords, keys and shared secrets its
APIs compare against or present to a backend. They are the half of the reference vocabulary that is
**only a secret**, so the owning application manages them in the portal rather than asking an
administrator to edit `INTEGRATIONS_FILE`. The half that resolves to a URL the gateway fetches —
token issuers and OAuth 2 token endpoints — stays in that file. See *Policy Vocabulary* and
`INTEGRATIONS_FILE` in `openspec/project.md`.

This capability also owns the **screen**, which is everything an application holds to prove who it
is in one environment. Client certificates are on it too: `app-certificates` owns what a
certificate is and how it is renewed, this capability owns where its owner finds it.

## Requirements

### Requirement: Split references by whether resolving one reaches a URL

The line is not who is trusted, it is what resolving the reference makes the gateway do. A password
is compared or presented; an issuer is fetched from. Only the second is a decision about what the
estate believes.

#### Scenario: A reference is only a secret

- GIVEN `credentialRef` on `auth.basic`, `backendAuth.basic`, `backendAuth.api-key` or
  `preconditions.requireHeader`, or `schemeRef` on `backendAuth.hmac-sa-key-lite`
- WHEN a policy names one
- THEN it SHALL resolve either to one of the owning application's own credentials or to an
  administrator's entry in the integrations file
- AND the owning application SHALL be able to create, rotate and delete its own without an
  administrator

#### Scenario: A reference resolves to something with a URL behind it

- GIVEN `issuerRef` on `auth.jwt` or `auth.introspection`, or `tokenProviderRef` on
  `backendAuth.oauth2-client-credentials`
- WHEN a policy names one
- THEN it SHALL resolve **only** through the administrator-registered integrations file
- AND an application SHALL NOT be able to register one
- AND the reason SHALL be that both carry an address the gateway itself calls — one to decide whose
  tokens this estate believes, the other to send a client secret to

### Requirement: Name an application's own credential in the reference itself

#### Scenario: A policy names an application credential

- GIVEN an application `app_x` with a credential `backend` in an environment
- WHEN a policy refers to it
- THEN the reference SHALL be the string `app:app_x:backend`
- AND the application id SHALL be part of the reference rather than inferred from the resource that
  names it
- AND the reason SHALL be that the configuration document's `references` is one flat map keyed by
  this string, so two applications each entitled to a credential called `backend` would otherwise
  collide into one entry and one of the two APIs would present the other's secret

#### Scenario: A reference is validated

- GIVEN any policy write
- WHEN a secret-only reference is validated
- THEN `app:<applicationId>:<name>` and a plain integrations-file name SHALL both be accepted
- AND anything else SHALL be refused naming the field

### Requirement: A credential belongs to one application and one environment

#### Scenario: A credential is created

- GIVEN a member of an application, or an administrator
- WHEN they add a credential naming a kind, a name, a secret and — where the kind has one — a
  principal
- THEN it SHALL be stored against that application and that environment
- AND the secret SHALL be encrypted with the key-encryption key at `KEK_PATH`
- AND the principal SHALL be stored in the clear, because "which account is this" is what every
  listing has to answer and answering it SHALL NOT need the key
- AND a name SHALL be 2–61 lowercase letters, digits or hyphens, unique within the application and
  environment

#### Scenario: A kind is chosen

- GIVEN the three kinds
- WHEN one is chosen
- THEN `basic` SHALL hold a username and a password and resolve to `user:pass`
- AND `secret` SHALL hold one opaque value and resolve to it
- AND `hmac` SHALL hold an application id and an application key and resolve to the `SaKeyLite` pair
- AND an `hmac` credential SHALL NOT resolve as a plain secret, because presenting a signing key as
  a bearer value is not what it signs

#### Scenario: A credential is promoted with its API

- GIVEN a policy promoted from one environment to the next
- WHEN it names an application credential
- THEN the reference SHALL travel and the secret SHALL NOT
- AND the destination environment SHALL resolve it against its own credential of that name
- AND the reason SHALL be that a test backend and a production backend do not share a password

### Requirement: A stored secret is never readable again

#### Scenario: A credential is read back

- GIVEN any portal endpoint
- WHEN a credential is returned
- THEN the name, kind, principal, note, reference, author, creation date and rotation date SHALL be
  returned and the secret SHALL NOT
- AND there SHALL be no endpoint that reveals it, to an owner or to an administrator
- AND the only reader SHALL be a configuration build

#### Scenario: A credential is audited

- GIVEN a create, a rotation or a deletion
- WHEN it is recorded
- THEN the audit row SHALL name the application, environment, credential name, kind and principal
- AND it SHALL never contain the secret

### Requirement: Rotate a credential in place

#### Scenario: A credential is rotated

- GIVEN an existing credential and a new secret
- WHEN it is rotated
- THEN the secret SHALL be replaced under the same id, name and reference
- AND every policy that names it SHALL keep working without being edited
- AND the new secret SHALL reach the gateways at the next configuration build
- AND `rotatedAt` SHALL be recorded, and the response SHALL name every route that uses it

#### Scenario: A rotation changes the kind

- GIVEN a rotation carrying a different kind
- WHEN it is submitted
- THEN the kind SHALL NOT change
- AND the reason SHALL be that every route naming the credential would silently begin presenting a
  different shape to its backend

### Requirement: Delete a credential only when no policy names it

#### Scenario: A credential is deleted

- GIVEN a credential no policy names
- WHEN deletion is requested
- THEN it SHALL go through the typed confirmation with the credential's name typed back

#### Scenario: A credential is still named

- GIVEN a credential named by a resource policy or by the environment's global tier
- WHEN deletion is requested
- THEN it SHALL be refused with `409`, listing what names it and the unit key in each
- AND the reason SHALL be that a gateway refuses a request whose credential it cannot resolve, so
  the alternative is a route that keeps serving until its next configuration build and then answers
  503 with nothing on the route to say why

### Requirement: Choose a reference, never type one

#### Scenario: A policy unit with a reference is edited

- GIVEN a unit carrying `credentialRef`, `schemeRef`, `issuerRef` or `tokenProviderRef`
- WHEN its form renders
- THEN the reference SHALL be chosen from a list rather than typed into a free-text box
- AND the application's own credentials and the administrator-registered names SHALL be two labelled
  groups, because only one of them is something the reader can add to
- AND only the kinds that can answer that field SHALL be offered
- AND the reason SHALL be that a typo in a reference is not a validation error: it saves cleanly and
  answers 503 at the first request

#### Scenario: The document names a reference that no longer resolves

- GIVEN a stored reference matching neither list
- WHEN the form renders
- THEN it SHALL be kept as the selected value, marked as not found, and warned about
- AND it SHALL NOT be silently reset, because that is somebody's policy being changed while they
  were looking at another tab

#### Scenario: The application has no credential of the kind a field needs

- GIVEN a credential field with nothing to offer
- WHEN it renders
- THEN it SHALL say so and link to the screen where one is added

#### Scenario: The estate has no issuer or token endpoint registered

- GIVEN an issuer or token-endpoint field with nothing to offer
- WHEN it renders
- THEN it SHALL say that registering one is an administrator's decision, rather than leaving an
  empty control with no explanation

### Requirement: Show what an application holds, per environment

#### Scenario: The Credentials screen renders

- GIVEN a selected application and environment
- WHEN the screen opens
- THEN each credential SHALL show its name, kind, principal, note, reference, whether it has been
  rotated and when, and every route that names it
- AND the list SHALL hold everything the application has to prove who it is in that environment —
  its passwords, single secrets, HMAC pairs and client certificates — rather than splitting them
  across screens by what kind of secret they are
- AND the screen SHALL state that a token issuer and a token endpoint are administrator-registered
  and why, rather than leaving their absence unexplained
