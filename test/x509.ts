import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";

/**
 * A minimal X.509 generator, for tests only.
 *
 * Certificates are needed to test the certificate store, and the alternatives are both bad: a
 * checked-in PEM fixture expires one day and takes the suite down with it on a date nobody chose,
 * and shelling out to `openssl` assumes a binary that is not on every machine this runs on. So the
 * fixtures are generated, with whatever validity the test asks for — including an expired one,
 * which is a case the store has to reject and could not otherwise be exercised.
 *
 * ECDSA P-256 with `ecdsa-with-SHA256`. That is enough for `X509Certificate` to parse, for
 * `checkPrivateKey` to match a key, and for `checkIssued` to verify a chain — which is everything
 * `control-plane/src/certificates.ts` asks of a certificate.
 *
 * v4 adds the three X.509 v3 extensions the trust store needs (review `[P1-01]`). Without them the
 * fixtures cannot express the two things G4 is about: a certificate authority is one whose
 * `basicConstraints` says CA — `X509Certificate.ca` is `false` otherwise, and the upload refuses it
 * — and a TLS server certificate needs a `subjectAltName`, because hostname verification has not
 * fallen back to the common name since Node 17 and Bun rejects such a certificate with
 * `ERR_TLS_CERT_ALTNAME_INVALID` before the chain is ever considered.
 */

// --------------------------------------------------------------------------- DER

function len(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  let value = n;
  while (value > 0) {
    bytes.unshift(value & 0xff);
    value >>= 8;
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function tlv(tag: number, content: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), len(content.length), content]);
}

const seq = (...parts: Buffer[]) => tlv(0x30, Buffer.concat(parts));
const set = (...parts: Buffer[]) => tlv(0x31, Buffer.concat(parts));

function integer(value: number): Buffer {
  const bytes: number[] = [];
  let v = value;
  do {
    bytes.unshift(v & 0xff);
    v = Math.floor(v / 256);
  } while (v > 0);
  // A leading high bit would read as negative.
  if (bytes[0]! & 0x80) bytes.unshift(0x00);
  return tlv(0x02, Buffer.from(bytes));
}

function oid(dotted: string): Buffer {
  const parts = dotted.split(".").map(Number);
  const bytes: number[] = [parts[0]! * 40 + parts[1]!];
  for (const part of parts.slice(2)) {
    const chunk: number[] = [part & 0x7f];
    let rest = part >>> 7;
    while (rest > 0) {
      chunk.unshift((rest & 0x7f) | 0x80);
      rest >>>= 7;
    }
    bytes.push(...chunk);
  }
  return tlv(0x06, Buffer.from(bytes));
}

function utf8(value: string): Buffer {
  return tlv(0x0c, Buffer.from(value, "utf8"));
}

function time(at: Date): Buffer {
  // `YYYYMMDDHHMMSSZ` — no separators and no `T`, which is where ISO-8601 and X.509 differ.
  const iso = at.toISOString().replace(/[-:T]/g, "").replace(/\.\d{3}/, "");
  // UTCTime cannot express a year past 2049, so anything further out is a GeneralizedTime. Both
  // are legal; picking by year is what the specification requires.
  return at.getUTCFullYear() < 2050 ? tlv(0x17, Buffer.from(iso.slice(2))) : tlv(0x18, Buffer.from(iso));
}

/** `CN=<name>,O=<org>` as an X.501 Name. */
function name(cn: string, org: string): Buffer {
  return seq(
    set(seq(oid("2.5.4.10"), utf8(org))),
    set(seq(oid("2.5.4.3"), utf8(cn))),
  );
}

const ECDSA_WITH_SHA256 = seq(oid("1.2.840.10045.4.3.2"));

const bool = (value: boolean) => tlv(0x01, Buffer.from([value ? 0xff : 0x00]));

/** `Extension ::= SEQUENCE { extnID OID, critical BOOLEAN DEFAULT FALSE, extnValue OCTET STRING }` */
function extension(id: string, critical: boolean, value: Buffer): Buffer {
  const parts = critical ? [oid(id), bool(true), tlv(0x04, value)] : [oid(id), tlv(0x04, value)];
  return seq(...parts);
}

/** `BasicConstraints ::= SEQUENCE { cA BOOLEAN DEFAULT FALSE }`, critical, as a CA must be. */
const BASIC_CONSTRAINTS_CA = extension("2.5.29.19", true, seq(bool(true)));

/**
 * `KeyUsage ::= BIT STRING`. The first content byte is the count of unused trailing bits, and the
 * bits are numbered from the most significant: keyCertSign is `0x04`, cRLSign `0x02`,
 * digitalSignature `0x80`. A CA that does not assert keyCertSign is refused by some verifiers, so
 * the fixtures assert what they are for.
 */
const KEY_USAGE_CERT_SIGN = extension("2.5.29.15", true, tlv(0x03, Buffer.from([1, 0x06])));
const KEY_USAGE_DIGITAL_SIGNATURE = extension("2.5.29.15", true, tlv(0x03, Buffer.from([7, 0x80])));

/**
 * `SubjectAltName ::= GeneralNames` — `dNSName` is `[2]`, `iPAddress` is `[7]` and four bytes.
 * Required, not decorative: hostname verification has not fallen back to the common name since
 * Node 17, so a server certificate without a SAN is refused with `ERR_TLS_CERT_ALTNAME_INVALID`
 * before its chain is ever considered.
 */
function subjectAltName(dnsNames: string[], ipAddresses: string[]): Buffer {
  const names = [
    ...dnsNames.map((name) => tlv(0x82, Buffer.from(name, "ascii"))),
    ...ipAddresses.map((address) => {
      const octets = address.split(".").map(Number);
      if (octets.length !== 4 || octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
        throw new Error(`x509 fixture: "${address}" is not an IPv4 address`);
      }
      return tlv(0x87, Buffer.from(octets));
    }),
  ];
  return extension("2.5.29.17", false, seq(...names));
}

function pem(label: string, der: Buffer): string {
  const body = der.toString("base64").replace(/(.{64})/g, "$1\n").trimEnd();
  return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----`;
}

// --------------------------------------------------------------------------- certificates

export interface GeneratedCertificate {
  certPem: string;
  keyPem: string;
  publicKey: KeyObject;
  privateKey: KeyObject;
  cn: string;
}

export interface CertificateOptions {
  cn: string;
  org?: string;
  notBefore?: Date;
  notAfter?: Date;
  serial?: number;
  /** Omit for self-signed. */
  issuer?: GeneratedCertificate;
  /**
   * Emit `basicConstraints: CA:TRUE` and `keyUsage: keyCertSign`. Without it `X509Certificate.ca`
   * is `false` and the trust store refuses the upload — which is the behaviour G4 wants and the
   * reason this flag has to be explicit rather than inferred from "has no issuer".
   */
  ca?: boolean;
  /** A server certificate needs at least one of these to survive hostname verification. */
  dnsNames?: string[];
  ipAddresses?: string[];
}

export function generateCertificate(options: CertificateOptions): GeneratedCertificate {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const org = options.org ?? "apim-test";
  const notBefore = options.notBefore ?? new Date(Date.now() - 3_600_000);
  // Far enough out that this fixture cannot start failing on a Tuesday in some future year.
  const notAfter = options.notAfter ?? new Date(Date.now() + 20 * 365 * 86_400_000);

  const subject = name(options.cn, org);
  const issuerName = options.issuer ? name(options.issuer.cn, org) : subject;
  const spki = publicKey.export({ type: "spki", format: "der" });

  const dnsNames = options.dnsNames ?? [];
  const ipAddresses = options.ipAddresses ?? [];
  const extensions: Buffer[] = [];
  if (options.ca) extensions.push(BASIC_CONSTRAINTS_CA, KEY_USAGE_CERT_SIGN);
  else if (dnsNames.length > 0 || ipAddresses.length > 0) extensions.push(KEY_USAGE_DIGITAL_SIGNATURE);
  if (dnsNames.length > 0 || ipAddresses.length > 0) {
    extensions.push(subjectAltName(dnsNames, ipAddresses));
  }

  const tbs = seq(
    // [0] EXPLICIT version, v3
    tlv(0xa0, integer(2)),
    integer(options.serial ?? 1),
    ECDSA_WITH_SHA256,
    issuerName,
    seq(time(notBefore), time(notAfter)),
    subject,
    spki,
    // [3] EXPLICIT Extensions, and only when there are any: an empty SEQUENCE here is invalid DER.
    ...(extensions.length > 0 ? [tlv(0xa3, seq(...extensions))] : []),
  );

  const signingKey = options.issuer ? options.issuer.privateKey : privateKey;
  const signature = sign("sha256", tbs, { key: signingKey, dsaEncoding: "der" });
  // BIT STRING: one leading byte for the count of unused bits, which for a signature is zero.
  const certificate = seq(tbs, ECDSA_WITH_SHA256, tlv(0x03, Buffer.concat([Buffer.from([0]), signature])));

  return {
    certPem: pem("CERTIFICATE", certificate),
    keyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKey,
    privateKey,
    cn: options.cn,
  };
}
