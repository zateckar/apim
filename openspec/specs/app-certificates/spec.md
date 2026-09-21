# app-certificates Specification

## Purpose

Define the certificates an application registers: the client identity this estate **presents** to a
backend. They carry private keys, so they are application-scoped, encrypted at rest, and never
returned in full over the portal's API.

A certificate is one of the things an application holds to prove who it is, so its owner manages it
alongside the others — see `app-credentials`, which owns the screen. This capability owns what a
certificate *is*: the material, the derived identity, the expiry, and the rules for renewing and
deleting one.

## Requirements

### Requirement: A certificate is managed beside the application's other credentials

An application SHALL NOT have a separate Certificates screen. A certificate differs from a password
by having an expiry date, which is a column; every other question about it — which environment,
which application, who may change it, what still names it — is the question the credential list
already answers, and asking it on two screens made "where do I put the thing my backend
authenticates me with" depend on what kind of thing it was.

#### Scenario: Certificates are listed

- GIVEN an application's Credentials screen in an environment
- WHEN it renders
- THEN that application's client certificates SHALL appear in the same list as its passwords, keys
  and HMAC pairs, each row saying which kind it is
- AND a certificate row SHALL additionally carry its remaining validity and the date it expires
- AND certificates SHALL be ordered before the rest, soonest expiry first, because an expired one
  is an outage and nothing else on the screen can become one by the passage of time

#### Scenario: A certificate is added

- GIVEN the add dialog on Credentials
- WHEN the kind chosen is a client certificate
- THEN the dialog SHALL ask for the PEM material instead of a secret, under the same name field
- AND the name SHALL be checked against everything the application already holds in that
  environment, not only against its certificates

#### Scenario: The old certificates address is opened

- GIVEN a link to an application's `/certificates`
- WHEN it is followed
- THEN it SHALL open Credentials rather than report an unknown address

#### Scenario: An administrator reads the estate's certificates

- GIVEN the Trust screen's client-certificate section
- WHEN it renders
- THEN it SHALL list every application's certificates in the environment, each naming its owner
- AND it SHALL render them with the same component the owner sees, so a certificate does not
  describe itself one way to its owner and another way to an auditor
- AND it SHALL NOT offer to add one, because choosing an owner from an estate-wide list is how a
  certificate ends up under the wrong application
- AND environment-wide authorities, TLS exceptions and governance SHALL remain on Trust

### Requirement: Distinguish an unread certificate list from an empty one

#### Scenario: Certificates are loading or unavailable

- GIVEN a certificate list that has not loaded or has failed
- WHEN the page renders
- THEN it SHALL show loading or the read failure instead of offering to add the first certificate

### Requirement: A certificate belongs to one application and one environment

#### Scenario: A certificate is registered

- GIVEN a member of an application
- WHEN they upload a certificate with its chain and private key
- THEN it SHALL be stored against that application and one environment
- AND the private key SHALL be encrypted with the key-encryption key at `KEK_PATH`
- AND the subject, issuer, thumbprint, `notBefore` and `notAfter` SHALL be derived from the PEM and
  recorded

#### Scenario: A certificate row is drawn

- GIVEN a certificate in a credential list
- WHEN it renders
- THEN the row SHALL show the name, subject, issuer, thumbprint, when it expires, how
  many days are left, and which bindings name it as their client identity
- AND `selfSigned` and the key algorithm SHALL be **re-derived from the PEM** rather than stored
- AND the reason SHALL be that they are properties of the certificate, and a column that can
  disagree with the bytes it describes is a column that eventually does

#### Scenario: The private key is requested

- GIVEN any portal endpoint
- WHEN a certificate is returned
- THEN the private key SHALL never be included
- AND the only reader of the key SHALL be the gateway instance channel

### Requirement: Renew a certificate in place

A renewal SHALL replace the material under the same id. The portal SHALL call it **rotating**, the
one word the credential list uses for replacing material in place, so that an owner holding a
password and a certificate for the same backend does not have to learn two words for the same act.

#### Scenario: A certificate is renewed

- GIVEN an existing certificate and a new one for the same subject
- WHEN it is renewed
- THEN the certificate, chain, encrypted key, thumbprint, issuer and validity window SHALL be
  replaced under the same id
- AND every binding that names it SHALL keep working without being edited
- AND the response SHALL carry the new thumbprint, the previous thumbprint, the new validity window,
  the days remaining and what uses it

#### Scenario: The material is delivered to the fleet

- GIVEN a renewal
- WHEN the gateways next fetch it
- THEN it SHALL be fetched keyed `<id>-<thumbprint>`
- AND a new thumbprint under the same id SHALL therefore be the designed rotation path rather than a
  special case

#### Scenario: The uploaded certificate is the same one

- GIVEN a renewal whose thumbprint equals the current one
- WHEN it is submitted
- THEN it SHALL be refused with `409` saying nothing would change

#### Scenario: The subject differs

- GIVEN a renewal whose subject differs from the current certificate's
- WHEN it is submitted
- THEN it SHALL be refused with `409`, naming **both** subjects
- AND the message SHALL say to upload it as a new certificate instead
- AND the reason SHALL be that a subject change is a substitution every binding would silently adopt

#### Scenario: The renewal is already expired, or expires no later

- GIVEN a renewal whose `notAfter` is in the past
- WHEN it is submitted
- THEN it SHALL be refused with `400`
- AND GIVEN a renewal whose `notAfter` is at or before the current one's
- THEN it SHALL be refused with `409`, saying the point is to extend the runway

#### Scenario: A renewal is audited

- GIVEN a completed renewal
- WHEN it is recorded
- THEN one audit row SHALL name the certificate, the previous thumbprint and the new one
- AND it SHALL never contain key material

### Requirement: Warn before a certificate expires

#### Scenario: A certificate is approaching expiry

- GIVEN a certificate whose `notAfter` is near
- WHEN attention is computed
- THEN a row SHALL be raised for the owning application naming the certificate, the days remaining
  and what would stop working
- AND it SHALL link to the screen where it can be renewed

#### Scenario: A certificate has expired

- GIVEN an expired certificate
- WHEN a binding names it
- THEN the binding SHALL be reported as broken rather than the failure left to the first request

### Requirement: Refuse to use a certificate that is not the API's own

#### Scenario: A binding names a certificate

- GIVEN a `clientCertRef`
- WHEN the binding is saved
- THEN the certificate SHALL exist, be in the same environment, be unexpired, belong to the API's
  own application, and be one the caller may use
- AND each of those failures SHALL be named separately

### Requirement: Delete a certificate only when nothing depends on it

#### Scenario: A certificate is deleted

- GIVEN a certificate no binding names
- WHEN deletion is requested
- THEN it SHALL go through the typed confirmation with the certificate's name typed back

#### Scenario: A certificate is still in use

- GIVEN a certificate one or more bindings name
- WHEN deletion is requested
- THEN it SHALL be refused, listing what uses it
- AND the reason SHALL be that the alternative is a route that stops authenticating to its backend
  with no visible cause

#### Scenario: An added certificate is incomplete or duplicates a name

- GIVEN the add dialog with the certificate kind chosen
- WHEN a name violates the 2–61 lowercase-letter, digit or hyphen pattern, duplicates something the
  application already holds in that environment, or certificate/key material is missing
- THEN the submit action SHALL remain disabled and the name field SHALL explain format or duplicate errors
- AND a duplicate SHALL direct the owner toward rotating in place
- AND certificate, chain and private-key editors SHALL have associated labels
