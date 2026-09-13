# app-certificates Specification

## Purpose

Define the certificates an application registers: the client identity this estate **presents** to a
backend. They carry private keys, so they are application-scoped, encrypted at rest, and never
returned in full over the portal's API.

## Requirements

### Requirement: Distinguish an unread certificate list from an empty one

#### Scenario: Certificates are loading or unavailable

- GIVEN a certificate list that has not loaded or has failed
- WHEN the page renders
- THEN it SHALL show loading or the read failure instead of offering to upload the first certificate

### Requirement: Keep certificate upload focused

#### Scenario: Uploading the first certificate

- GIVEN an application with no certificates in the selected environment
- WHEN the upload form is opened
- THEN the empty-state prompt SHALL be replaced by the upload form and its Cancel action
- AND cancelling SHALL restore the empty-state prompt

### Requirement: A certificate belongs to one application and one environment

#### Scenario: A certificate is registered

- GIVEN a member of an application
- WHEN they upload a certificate with its chain and private key
- THEN it SHALL be stored against that application and one environment
- AND the private key SHALL be encrypted with the key-encryption key at `KEK_PATH`
- AND the subject, issuer, thumbprint, `notBefore` and `notAfter` SHALL be derived from the PEM and
  recorded

#### Scenario: A certificate is listed

- GIVEN the Certificates screen
- WHEN it renders
- THEN each row SHALL show the name, environment, subject, issuer, thumbprint, validity window, how
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

A renewal SHALL replace the material under the same id.

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

#### Scenario: The application certificate page is opened

- GIVEN Certificates under a selected application
- WHEN it renders
- THEN it SHALL show only that application's client certificates for the selected environment
- AND environment-wide authorities, TLS exceptions and governance SHALL remain on the Trust page rather than appear as tabs under the application title

#### Scenario: An upload draft is incomplete or duplicates a certificate

- GIVEN the upload form
- WHEN a name violates the 2–61 lowercase-letter, digit or hyphen pattern, duplicates a loaded certificate, or certificate/key material is missing
- THEN Upload SHALL remain disabled and the name field SHALL explain format or duplicate errors
- AND a duplicate SHALL direct the owner toward renewal in place
- AND certificate, chain and private-key editors SHALL have associated labels
