import { X509Certificate } from "node:crypto";
import { rootCertificates } from "node:tls";
import type { ConfigTrustAnchor } from "../../shared/config-doc.ts";
import { CertificateError, pemBlocks, thumbprintOf } from "./certificates.ts";
import type { DB } from "./db.ts";

/**
 * The environment's trust store (design section 5.4 rung 1, plan §8).
 *
 * Rung 1 of the design's TLS ladder is "register the internal CA", and it is the rung that should
 * absorb most cases: a backend whose certificate chains to a registered anchor verifies normally,
 * with no `tls_exception` and therefore no dated hole in verification. Deviation D26 moves the
 * store from per-gateway process config into this table, so the portal owns it like every other
 * piece of desired state and one gateway in an environment cannot drift from its neighbour.
 *
 * Two readers:
 *  - `liveAnchorsFor` — what travels in the config document, per environment;
 *  - `controlPlaneCaBundle` — the union across environments, for the control plane's own outbound
 *    fetches (§8.5). The union is a widening and is stated as one: a CA registered for PROD will
 *    also verify a DEV application's spec host, because the control plane has no environment of its own.
 *
 * An anchor holds no secret — it is the public certificate of an issuer — which is what lets it
 * travel inline in the config document and sit in the fail-static cache unencrypted `[P2-10]`.
 */

/** A CA certificate is 1–2 KiB. This is generous, and it bounds the config document. */
export const MAX_ANCHOR_PEM_BYTES = 16 * 1024;

export interface ParsedAnchor {
  certPem: string;
  subject: string;
  issuer: string;
  thumbprint: string;
  notBefore: string;
  notAfter: string;
  /** Always true for a stored anchor: a non-CA is refused. Reported by `preview` all the same. */
  ca: boolean;
  selfSigned: boolean;
  /** `EC P-256`, `RSA 4096` — what an admin recognises the certificate by. */
  keyAlgorithm: string;
}

/**
 * Every refusal here is a message rather than a silent acceptance, and each one is a mistake that
 * would otherwise be discovered as a TLS failure on somebody else's request:
 *
 *  - **a bundle** would make the whole file one row, so removing one issuer means re-uploading the
 *    rest and nobody can see what is trusted;
 *  - **a leaf** in a trust store trusts exactly one host and hides that it did. Bun will happily
 *    use one as an anchor, which is why refusing it has to be deliberate;
 *  - **an expired CA** verifies nothing, so registering one is always a mistake in progress;
 *  - **a private key** in this field is a secret pasted into a store that is not for secrets, and
 *    it travels to every gateway in the environment.
 */
export function parseAnchor(pem: string, options: { now?: number } = {}): ParsedAnchor {
  const input = pem ?? "";
  if (Buffer.byteLength(input, "utf8") > MAX_ANCHOR_PEM_BYTES) {
    throw new CertificateError(
      `pem: larger than ${MAX_ANCHOR_PEM_BYTES} bytes. A CA certificate is 1–2 KiB; this looks ` +
        "like a bundle or the wrong file",
    );
  }
  if (/-----BEGIN (?:[A-Z0-9 ]*)PRIVATE KEY-----/.test(input)) {
    throw new CertificateError(
      "pem: this contains a private key. A trust anchor is the public certificate of an issuer " +
        "and travels to every gateway in the environment; never paste a key here",
    );
  }

  const blocks = pemBlocks(input, "CERTIFICATE");
  if (blocks.length === 0) {
    throw new CertificateError(
      "pem: expected a PEM certificate block (-----BEGIN CERTIFICATE-----). Export the CA " +
        "certificate as PEM; a .pfx, .p12 or DER file is not accepted",
    );
  }
  if (blocks.length > 1) {
    throw new CertificateError(
      `pem: this file holds ${blocks.length} certificates. Upload one certificate per anchor, so ` +
        "each can be removed on its own and the Trust screen can say what is trusted",
    );
  }

  let certificate: X509Certificate;
  try {
    certificate = new X509Certificate(blocks[0]!);
  } catch (err) {
    throw new CertificateError(`pem: could not be parsed (${(err as Error).message})`);
  }

  if (!certificate.ca) {
    throw new CertificateError(
      `pem: ${certificate.subject.replace(/\n/g, ", ")} is not a certificate authority — its ` +
        "basicConstraints do not say CA. Registering a server's own certificate would trust that " +
        "one host while looking like a policy about an issuer; register the CA that signed it",
    );
  }

  const notBefore = new Date(certificate.validFrom).toISOString();
  const notAfter = new Date(certificate.validTo).toISOString();
  const at = options.now ?? Date.now();
  if (Date.parse(notAfter) <= at) {
    throw new CertificateError(`pem: this certificate authority expired at ${notAfter}`);
  }

  return {
    certPem: blocks[0]!,
    subject: certificate.subject.replace(/\n/g, ", "),
    issuer: certificate.issuer.replace(/\n/g, ", "),
    thumbprint: thumbprintOf(certificate),
    notBefore,
    notAfter,
    ca: true,
    selfSigned: isSelfSigned(certificate),
    keyAlgorithm: describeKey(certificate),
  };
}

/**
 * A root, or an intermediate. Both are registrable — an estate that only hands out its issuing CA
 * has to be able to trust it — so this is reported rather than enforced.
 */
function isSelfSigned(certificate: X509Certificate): boolean {
  if (certificate.subject !== certificate.issuer) return false;
  try {
    return certificate.verify(certificate.publicKey);
  } catch {
    return false;
  }
}

function describeKey(certificate: X509Certificate): string {
  const key = certificate.publicKey;
  const details = key.asymmetricKeyDetails ?? {};
  if (key.asymmetricKeyType === "ec") return `EC ${details.namedCurve ?? "unknown curve"}`;
  if (key.asymmetricKeyType === "rsa") return `RSA ${details.modulusLength ?? "?"}`;
  return key.asymmetricKeyType ?? "unknown";
}

/**
 * Live means: not removed, and not expired **on the reader's clock**. Expiry is filtered here as
 * well as on the gateway, so an anchor cannot be kept alive by a config document that was built
 * before it lapsed (§8.2).
 */
export function liveAnchorsFor(db: DB, environment: string, now = new Date()): ConfigTrustAnchor[] {
  return db
    .query<
      { id: string; name: string; thumbprint: string; not_after: string; cert_pem: string },
      [string, string]
    >(
      `SELECT id, name, thumbprint, not_after, cert_pem
         FROM trust_anchor
        WHERE environment = ? AND removed_at IS NULL AND not_after > ?
        ORDER BY added_at, id`,
    )
    .all(environment, now.toISOString())
    .map((row) => ({
      id: row.id,
      name: row.name,
      thumbprint: row.thumbprint,
      notAfter: row.not_after,
      pem: row.cert_pem,
    }));
}

/**
 * One environment's bundle, composed the way its gateways compose theirs (§8.3): the system roots
 * plus that environment's live anchors. `null` when it has none, which means "send what we send
 * today" rather than "trust nothing".
 *
 * Used by the exception probe, which has to ask the question exactly as the gateway would.
 */
export function caBundleFor(db: DB, environment: string, now = new Date()): string | null {
  const anchors = liveAnchorsFor(db, environment, now);
  if (anchors.length === 0) return null;
  return [...rootCertificates, ...anchors.map((anchor) => anchor.pem.trim())].join("\n");
}

/**
 * The control plane's own trust bundle: the system roots **plus** every live anchor in the estate.
 *
 * The system roots are unioned in explicitly because setting `tls.ca` *replaces* the default store
 * rather than adding to it — measured, and the reason the same union appears on the gateway
 * (§8.3). Without it, registering one internal CA would break every fetch to a public-CA host.
 *
 * Cached per database, because this is built for outbound calls that happen on request paths, and
 * invalidated on write. The cache also expires at the earliest anchor's `notAfter`, so an anchor
 * lapsing takes effect without anybody having to write anything.
 */
const BUNDLE_CACHE = new WeakMap<DB, { bundle: string | null; expiresAt: number }>();
const BUNDLE_TTL_MS = 30_000;

export function invalidateTrustBundle(db: DB): void {
  BUNDLE_CACHE.delete(db);
}

/** `null` when the estate has no anchors: then the platform sends exactly what it sends today. */
export function controlPlaneCaBundle(db: DB, now = Date.now()): string | null {
  const cached = BUNDLE_CACHE.get(db);
  if (cached && cached.expiresAt > now) return cached.bundle;

  const rows = db
    .query<{ cert_pem: string; thumbprint: string; not_after: string }, [string]>(
      `SELECT cert_pem, thumbprint, not_after
         FROM trust_anchor
        WHERE removed_at IS NULL AND not_after > ?
        ORDER BY added_at, id`,
    )
    .all(new Date(now).toISOString());

  const seen = new Set<string>();
  const pems: string[] = [];
  let earliest = Number.POSITIVE_INFINITY;
  for (const row of rows) {
    // The same CA registered in DEV and PROD is one certificate to a TLS stack.
    if (seen.has(row.thumbprint)) continue;
    seen.add(row.thumbprint);
    pems.push(row.cert_pem.trim());
    earliest = Math.min(earliest, Date.parse(row.not_after));
  }

  const bundle = pems.length === 0 ? null : [...rootCertificates, ...pems].join("\n");
  BUNDLE_CACHE.set(db, { bundle, expiresAt: Math.min(now + BUNDLE_TTL_MS, earliest) });
  return bundle;
}

/**
 * `fetch`, with the estate's anchors. Every outbound call the control plane makes on behalf of a
 * user goes through this: spec import, MCP and A2A discovery, the playground forward, and the
 * exception probe.
 *
 * Design section 5.4's "TLS exceptions never apply to the control plane" is untouched — pinning,
 * skipping a hostname and `insecure` remain unavailable here. Registering a CA is rung 1, which
 * the design says should absorb most cases, and it *strengthens* verification rather than relaxing
 * it: without it an internal host is simply unreachable from the portal.
 */
export function trustedFetch(db: DB): typeof fetch {
  return ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const bundle = controlPlaneCaBundle(db);
    if (!bundle) return fetch(input, init);
    return fetch(input, { ...init, tls: { ca: bundle } } as RequestInit);
  }) as typeof fetch;
}
