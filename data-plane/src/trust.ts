import { rootCertificates } from "node:tls";
import type { ConfigTrustAnchor } from "../../shared/config-doc.ts";

/**
 * The CA set this instance verifies backends against (G4, plan §8.3).
 *
 * Composed once per config activation, because that is how often it can change — and it is the
 * union of two things, deliberately:
 *
 *     ca = system roots (unless TRUST_SYSTEM_ROOTS=0) + the environment's registered anchors
 *
 * The union is explicit because **setting `tls.ca` replaces the default store rather than adding
 * to it**. Measured: with `ca` set to one internal CA, `https://example.com` fails with
 * `unable to get local issuer certificate`. So registering an internal CA without this union would
 * quietly break every backend with a public certificate — which is why `TRUST_SYSTEM_ROOTS=0` is a
 * configured choice with a log line rather than something anyone arrives at by accident.
 *
 * Self-expiry is the second property. `notAfter` travels in the config document, and an anchor past
 * it is dropped here, on this instance's clock — the same rule design section 5.4 applies to a TLS
 * exception's `expiresAt`, and for the same reason: fail-static config must not be able to hold a
 * dead CA open through a control-plane outage.
 *
 * What it costs, measured: `tls.ca` keeps Bun's connection pool — 1 handshake for 51 requests, and
 * ~0.014 ms/request over no verification at all. The option that destroys pooling is a custom
 * `checkServerIdentity`, which is what `pin` and `skip-hostname` install; so a registered CA is
 * both stronger and cheaper than the exception it replaces.
 */
export class TrustSet {
  private readonly anchors: ConfigTrustAnchor[];
  private readonly systemRoots: boolean;
  private cached: string | null = null;
  /** When the cached bundle stops being correct: the earliest anchor expiry it still contains. */
  private cachedUntil = 0;

  constructor(anchors: ConfigTrustAnchor[] = [], options: { systemRoots?: boolean } = {}) {
    this.anchors = anchors;
    this.systemRoots = options.systemRoots !== false;
    this.compose(Date.now());
  }

  /** How many anchors are live now — what `/healthz` reports and the fleet view shows. */
  liveCount(now = Date.now()): number {
    return this.anchors.filter((anchor) => Date.parse(anchor.notAfter) > now).length;
  }

  /**
   * The `ca` value for an outbound TLS connection, or `null` when this environment has no anchors —
   * in which case the instance sends exactly what it sent before G4 and the system store applies
   * on its own.
   */
  bundle(now = Date.now()): string | null {
    if (now >= this.cachedUntil) this.compose(now);
    return this.cached;
  }

  private compose(now: number): void {
    const live: string[] = [];
    let earliest = Number.POSITIVE_INFINITY;
    for (const anchor of this.anchors) {
      const notAfter = Date.parse(anchor.notAfter);
      if (!(notAfter > now)) continue;
      live.push(anchor.pem.trim());
      earliest = Math.min(earliest, notAfter);
    }
    this.cached =
      live.length === 0 ? null : [...(this.systemRoots ? rootCertificates : []), ...live].join("\n");
    this.cachedUntil = earliest;
  }
}
