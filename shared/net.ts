/** IPv4 CIDR matching, used by the control plane's egress allowlist and the data plane's
 *  trusted-proxy boundary (design sections 5.3 and 8.1). Real IPv6 literals never match. */

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
