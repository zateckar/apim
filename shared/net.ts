/** IPv4 CIDR matching, used by the control plane's egress allowlist and the data plane's
 *  trusted-proxy boundary (design sections 5.3 and 8.1). IPv6 literals never match. */
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
  const ipInt = ipv4ToInt(ip);
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
 */
export function effectiveClientIp(
  forwardedFor: string | null,
  peerIp: string,
  trustedProxyCidrs: string[],
): string {
  if (trustedProxyCidrs.length === 0) return peerIp;
  if (!trustedProxyCidrs.some((cidr) => ipInCidr(peerIp, cidr))) return peerIp;
  const chain = (forwardedFor ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  for (let i = chain.length - 1; i >= 0; i--) {
    const candidate = chain[i]!;
    if (ipv4ToInt(candidate) === null) continue;
    if (trustedProxyCidrs.some((cidr) => ipInCidr(candidate, cidr))) continue;
    return candidate;
  }
  // Every hop was a trusted proxy, or the header was absent or unparseable: the peer is all we know.
  return peerIp;
}
