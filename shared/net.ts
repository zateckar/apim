/** IPv4 CIDR matching, used by the control plane's denied egress ranges and the data plane's
 *  trusted-proxy boundary (design sections 5.3 and 8.1). Real IPv6 literals never match — which is
 *  why `checkEgress` refuses an IPv6 literal host outright rather than admitting one past a range
 *  that could never have matched it. */

/**
 * `::ffff:10.89.1.1` is an ordinary IPv4 peer, not an IPv6 one.
 *
 * A dual-stack listener reports **every** IPv4 peer in this form, so treating it as an IPv6 literal
 * turned the whole trusted-proxy boundary off wherever a gateway sat behind a proxy — the operator
 * sets `TRUSTED_PROXY_CIDRS`, it matches nothing, and nothing says so. Found on the alpha
 * deployment: every access-log line named the proxy as the client, for real traffic, and with it
 * went `ipAllow`, `by: "ip"` rate limits and quotas, the client-certificate headers `trustedPeer`
 * gates, and the outbound `X-Forwarded-For` chain.
 *
 * Only the dotted form of RFC 4291 §2.5.5.2 is recognised. The all-hex spelling of the same address
 * (`::ffff:0a59:0101`) would need a full IPv6 parser, and no runtime in this system emits it — an
 * untested branch on a security boundary is worth less than the case it would cover.
 *
 * Out-of-range octets are left alone rather than stripped, so this never invents an address: a
 * caller that writes `::ffff:999.1.1.1` into a header gets a string that still fails to parse.
 */
export function canonicalIp(ip: string): string {
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (!mapped) return ip;
  const dotted = mapped[1]!;
  return dotted.split(".").every((octet) => Number(octet) <= 255) ? dotted : ip;
}

export function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    const n = Number(part);
    if (part === "" || !Number.isInteger(n) || n < 0 || n > 255) return null;
    value = value * 256 + n;
  }
  return value >>> 0;
}

export function ipInCidr(ip: string, cidr: string): boolean {
  const [network, bitsRaw] = cidr.split("/");
  const bits = Number(bitsRaw ?? "32");
  // The address is canonicalised and the CIDR is not: a rule is written by an operator, who writes
  // `10.89.1.0/24`, while the address arrives from a socket in whatever form the listener reports.
  const ipInt = ipv4ToInt(canonicalIp(ip));
  const netInt = ipv4ToInt(network ?? "");
  if (ipInt === null || netInt === null || !Number.isInteger(bits) || bits < 0 || bits > 32) {
    return false;
  }
  if (bits === 0) return true;
  const mask = (0xffffffff << (32 - bits)) >>> 0;
  return (ipInt & mask) === (netInt & mask);
}

/**
 * An IPv6 address as its 16 bytes, or `null` for anything that is not one.
 *
 * Written because `denyCidrs` is IPv4-only and the egress check needs *some* verdict on an `AAAA`
 * answer: discarding those answers let `internal.example` resolve to `::1` and be reached, which is
 * the same hole `checkEgress` refuses an IPv6 literal to avoid. The parser is deliberately small —
 * it exists to answer "is this address inside one of the four ranges nothing may reach", not to be
 * a general IPv6 library.
 *
 * Accepts the `::` compressed form and the embedded-IPv4 tail (`::ffff:10.0.0.1`). A zone index
 * (`fe80::1%eth0`) is not accepted: a resolver does not emit one, and guessing at a form nothing
 * produces would be an untested branch on a security boundary.
 */
export function ipv6ToBytes(ip: string): Uint8Array | null {
  const text = ip.trim().toLowerCase();
  if (text.length === 0 || text.includes("%") || !text.includes(":")) return null;

  // An embedded IPv4 tail contributes the last four bytes; the rest is parsed as groups.
  let head = text;
  const tail: number[] = [];
  const lastColon = text.lastIndexOf(":");
  const maybeV4 = text.slice(lastColon + 1);
  if (maybeV4.includes(".")) {
    const v4 = ipv4ToInt(maybeV4);
    if (v4 === null) return null;
    tail.push((v4 >>> 24) & 0xff, (v4 >>> 16) & 0xff, (v4 >>> 8) & 0xff, v4 & 0xff);
    head = text.slice(0, lastColon + 1) + "0:0";
  }

  const halves = head.split("::");
  if (halves.length > 2) return null;
  const groupsOf = (part: string): number[] | null => {
    if (part === "") return [];
    const out: number[] = [];
    for (const group of part.split(":")) {
      if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
      out.push(Number.parseInt(group, 16));
    }
    return out;
  };
  const left = groupsOf(halves[0] ?? "");
  const right = halves.length === 2 ? groupsOf(halves[1] ?? "") : [];
  if (left === null || right === null) return null;

  const total = left.length + right.length;
  // Without `::` every group has to be written out; with it, at least one has to be elided.
  if (halves.length === 1 ? total !== 8 : total > 7) return null;
  const groups = [...left, ...new Array(8 - total).fill(0), ...right];

  const bytes = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    bytes[i * 2] = (groups[i]! >>> 8) & 0xff;
    bytes[i * 2 + 1] = groups[i]! & 0xff;
  }
  if (tail.length === 4) bytes.set(tail, 12);
  return bytes;
}

/** `::ffff:a.b.c.d` in either spelling, as its dotted IPv4 — an ordinary IPv4 host, not an IPv6 one. */
export function mappedIpv4(bytes: Uint8Array): string | null {
  for (let i = 0; i < 10; i++) if (bytes[i] !== 0) return null;
  if (bytes[10] !== 0xff || bytes[11] !== 0xff) return null;
  return `${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`;
}

/**
 * The IPv6 ranges nothing may reach, named rather than configured.
 *
 * `denyCidrs` is the operator's IPv4 list and has no IPv6 equivalent, so these are stated here: they
 * are the ranges that are internal *by definition* rather than by one estate's topology, which is
 * what makes them safe to hard-code. Returns the range that matched, for the sentence the refusal
 * carries.
 */
export function internalIpv6Range(bytes: Uint8Array): string | null {
  const zeroes = bytes.every((byte) => byte === 0);
  if (zeroes) return "::/128 (unspecified)";
  if (bytes.slice(0, 15).every((byte) => byte === 0) && bytes[15] === 1) return "::1/128 (loopback)";
  if ((bytes[0]! & 0xfe) === 0xfc) return "fc00::/7 (unique local)";
  if (bytes[0] === 0xfe && (bytes[1]! & 0xc0) === 0x80) return "fe80::/10 (link local)";
  if (bytes[0] === 0xfe && (bytes[1]! & 0xc0) === 0xc0) return "fec0::/10 (site local)";
  return null;
}

/**
 * Which address a policy should treat as the caller (design section 8.1, plan `[R2-23]`).
 *
 * Behind a reverse proxy every request arrives from the proxy, so an `ipAllow` list matched against
 * the socket peer admits everyone or nobody. `X-Forwarded-For` is what carries the real one — but
 * it is a header, so it is only evidence when the peer that sent it is trusted.
 *
 * The rule is to walk the chain **from the right**, skipping addresses that are themselves trusted
 * proxies, and take the first one that is not. Right-to-left because a conforming proxy *appends*
 * the address it received from: the rightmost entry is the one our own trusted proxy observed and
 * therefore the only one nobody downstream could have written. Taking the leftmost instead is the
 * classic spoof — a client sends `X-Forwarded-For: 10.0.0.1` and picks its own address.
 *
 * With an untrusted peer the header is a claim rather than evidence, and the socket address is used.
 *
 * Every address this returns is canonicalised. `ipInCidr` would match either spelling anyway, so
 * this is about the value that gets logged, counted and used as a rate-limit key: one caller must
 * not appear as two addresses because the listener happened to be dual-stack.
 */
export function effectiveClientIp(
  forwardedFor: string | null,
  peerIp: string,
  trustedProxyCidrs: string[],
): string {
  const peer = canonicalIp(peerIp);
  if (trustedProxyCidrs.length === 0) return peer;
  if (!trustedProxyCidrs.some((cidr) => ipInCidr(peer, cidr))) return peer;
  const chain = (forwardedFor ?? "")
    .split(",")
    .map((entry) => canonicalIp(entry.trim()))
    .filter(Boolean);
  for (let i = chain.length - 1; i >= 0; i--) {
    const candidate = chain[i]!;
    if (ipv4ToInt(candidate) === null) continue;
    if (trustedProxyCidrs.some((cidr) => ipInCidr(candidate, cidr))) continue;
    return candidate;
  }
  // Every hop was a trusted proxy, or the header was absent or unparseable: the peer is all we know.
  return peer;
}
