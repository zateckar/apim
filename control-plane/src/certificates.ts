import { X509Certificate, createPrivateKey } from "node:crypto";

/**
 * Design section 4.3: the client identities this gateway **presents** to a backend, private key
 * included. Distinct from trust anchors, which are admin-registered in `INTEGRATIONS_FILE`, contain
 * no secrets, and say whom we are willing to *believe*.
 *
 * PEM only (deviation D24): certificate, optional chain, PKCS#8 private key. A PKCS#12 parser is
 * either a dependency or a week of work, and the upload form says PEM rather than accepting a `.pfx`
 * and failing obscurely.
 *
 * Three checks happen here and nowhere else, because each is a class of outage that is trivially
 * cheap to catch at upload and expensive to diagnose at 3am from a TLS handshake failure:
 *
 *  - **the key matches the certificate.** A mismatched pair produces
 *    `SSL_ERROR_..._KEY_VALUES_MISMATCH` at connection time, on the gateway, per request.
 *  - **the certificate is not already expired.** Uploading one that is is always a mistake.
 *  - **the chain, if given, actually chains.** Each certificate must be issued by the next.
 *
 * `X509Certificate` and `createPrivateKey` are Node built-ins, so this stays dependency-free.
 */

export interface ParsedCertificate {
  certPem: string;
  chainPem: string | null;
  keyPem: string;
  /** sha256 over the DER, uppercase hex, colon-free — what the config document carries. */
  thumbprint: string;
  subject: string;
  issuer: string;
  notBefore: string;
  notAfter: string;
}

export class CertificateError extends Error {}

const PEM_BLOCK = /-----BEGIN ([A-Z0-9 ]+)-----[\s\S]*?-----END \1-----/g;

/** Every PEM block of a given label, in order. Anything else in the file is ignored. */
export function pemBlocks(input: string, label: string): string[] {
  const out: string[] = [];
  for (const match of input.matchAll(PEM_BLOCK)) {
    if (match[1] === label) out.push(match[0]);
  }
  return out;
}

function looksLikePrivateKey(input: string): boolean {
  return /-----BEGIN (?:[A-Z0-9 ]*)PRIVATE KEY-----/.test(input);
}

export function parseCertificate(input: {
  certPem: string;
  chainPem?: string | null;
  keyPem: string;
  now?: number;
}): ParsedCertificate {
  const certificates = pemBlocks(input.certPem, "CERTIFICATE");
  if (certificates.length === 0) {
    throw new CertificateError(
      "certPem: expected a PEM certificate block (-----BEGIN CERTIFICATE-----). A .pfx or .p12 " +
        "file is not accepted; export the certificate and key as PEM first (deviation D24)",
    );
  }

  // A leaf plus its chain pasted into one field is the most common way this is submitted, so it is
  // read rather than rejected: the first block is the identity, the rest is the chain.
  const leafPem = certificates[0]!;
  const trailing = certificates.slice(1);
  const chainCertificates = [...trailing, ...pemBlocks(input.chainPem ?? "", "CERTIFICATE")];

  if (!looksLikePrivateKey(input.keyPem)) {
    throw new CertificateError(
      "keyPem: expected a PEM private key block. An encrypted key is not accepted — this control " +
        "plane holds no passphrase to decrypt it with; decrypt it first",
    );
  }
  if (/ENCRYPTED/.test(input.keyPem)) {
    throw new CertificateError("keyPem: the key is passphrase-encrypted; upload a decrypted PKCS#8 key");
  }

  let leaf: X509Certificate;
  try {
    leaf = new X509Certificate(leafPem);
  } catch (err) {
    throw new CertificateError(`certPem: could not be parsed (${(err as Error).message})`);
  }

  let key;
  try {
    key = createPrivateKey(input.keyPem);
  } catch (err) {
    throw new CertificateError(`keyPem: could not be parsed (${(err as Error).message})`);
  }
  if (!leaf.checkPrivateKey(key)) {
    throw new CertificateError(
      "the private key does not belong to this certificate. Mismatched pairs fail at TLS " +
        "handshake time, on every request, with an error that names neither file",
    );
  }

  const notBefore = new Date(leaf.validFrom).toISOString();
  const notAfter = new Date(leaf.validTo).toISOString();
  const at = input.now ?? Date.now();
  if (Date.parse(notAfter) <= at) {
    throw new CertificateError(`this certificate expired at ${notAfter}`);
  }

  // Each certificate must be issued by the next one along, or the chain is not a chain and a
  // backend will reject the handshake for a reason that looks like a network fault.
  let previous = leaf;
  for (const [index, pem] of chainCertificates.entries()) {
    let next: X509Certificate;
    try {
      next = new X509Certificate(pem);
    } catch (err) {
      throw new CertificateError(`chainPem[${index}]: could not be parsed (${(err as Error).message})`);
    }
    if (!previous.checkIssued(next)) {
      throw new CertificateError(
        `chainPem[${index}] (${next.subject}) did not issue ${previous.subject}: the chain must be ` +
          "ordered leaf-first, each certificate issued by the next",
      );
    }
    previous = next;
  }

  return {
    certPem: leafPem,
    chainPem: chainCertificates.length > 0 ? chainCertificates.join("\n") : null,
    keyPem: input.keyPem.trim(),
    thumbprint: thumbprintOf(leaf),
    subject: leaf.subject.replace(/\n/g, ", "),
    issuer: leaf.issuer.replace(/\n/g, ", "),
    notBefore,
    notAfter,
  };
}

/**
 * `fingerprint256` is colon-separated lowercase; the config document and the `pin` TLS mode both
 * carry the colon-free uppercase form, so the conversion happens once, here.
 */
export function thumbprintOf(certificate: X509Certificate): string {
  return certificate.fingerprint256.replace(/:/g, "").toUpperCase();
}

/** How long until this certificate stops working, for the expiry warning on the Trust screen. */
export function daysUntil(notAfter: string, now = Date.now()): number {
  return Math.floor((Date.parse(notAfter) - now) / 86_400_000);
}
