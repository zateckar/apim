import type {
  ConfigCertificate,
  ConfigLimits,
  ConfigOperation,
  ConfigReferences,
  ConfigRoute,
  ConfigSubscription,
  GatewayConfig,
} from "../../shared/config-doc.ts";
import { compileOperations, type CompiledOperations } from "../../shared/opmatch.ts";
import { hostKey, pathMatchesBase } from "../../shared/routing.ts";
import type { ArtifactCache, CertificateMaterial } from "./artifacts.ts";
import { TrustSet } from "./trust.ts";

/** An environment with nothing registered still needs every lookup to answer "no". */
const NO_REFERENCES: ConfigReferences = {
  issuers: {},
  tokenProviders: {},
  hmacSchemes: {},
  secretHashes: {},
  secrets: {},
};

/** A route declaring no operations matches none; it never needs its own empty index. */
const NO_OPERATIONS: CompiledOperations<ConfigOperation> = compileOperations<ConfigOperation>([]);

/** Used only when an older cache file is read; a live config always carries its own. */
const FALLBACK_LIMITS: ConfigLimits = {
  xml: {
    maxPrefixBytes: 8192,
    maxDepth: 32,
    maxElements: 100_000,
    maxBytes: 8 * 1024 * 1024,
    contentTypes: ["text/xml", "application/soap+xml"],
  },
  validation: {
    maxBodyBytes: 8 * 1024 * 1024,
    minSampleRate: 0.01,
    maxConcurrent: 8,
    maxIncludeBodyExcerptBytes: 0,
  },
};

/**
 * An immutable projection of one config document. A new config builds a new table and the server
 * swaps it by assignment, so a request that started under the old table finishes under it.
 */
export class RouteTable {
  readonly routes: ConfigRoute[];
  readonly digest: string;
  readonly environment: string;
  /** Design section 5.1's `always` ceilings, distributed rather than configured per gateway. */
  readonly limits: ConfigLimits;
  /** What a policy's `issuerRef`, `credentialRef` and friends resolve to (design section 5.3). */
  readonly references: ConfigReferences;
  /**
   * The environment's trust store, composed once here — which is once per activation, since a new
   * config builds a new table (G4, plan §8.3).
   */
  readonly trust: TrustSet;
  private readonly byKeyHash = new Map<string, ConfigSubscription>();
  private readonly certificatesById = new Map<string, ConfigCertificate>();
  /**
   * Operation templates, split into segments once here — which is once per activation, for the
   * same reason `trust` above is composed once. A template cannot change between two requests, so
   * re-splitting it on each one is work the request path does not owe (perf review, step 11).
   */
  private readonly operationIndexes = new Map<ConfigRoute, CompiledOperations<ConfigOperation>>();
  /**
   * The round-robin cursor is per table, so a config swap restarts the rotation. That is a
   * deliberate non-property: the rotation is a fairness heuristic on one instance, not a
   * distribution guarantee, and carrying it across a swap would mean the table was not immutable.
   */
  private readonly cursors = new Map<string, number>();

  constructor(config: GatewayConfig, options: { trustSystemRoots?: boolean } = {}) {
    this.limits = config.limits ?? FALLBACK_LIMITS;
    this.references = config.references ?? NO_REFERENCES;
    // `?? []` for the same reason as the two lines above: a cache file written by an older build
    // has no anchors, and reading it must mean "none" rather than a crash on activation.
    this.trust = new TrustSet(config.trustAnchors ?? [], { systemRoots: options.trustSystemRoots });
    // Longest base path first, so /petstore/admin wins over /petstore.
    this.routes = [...config.routes].sort((a, b) => b.basePath.length - a.basePath.length);
    this.digest = config.digest;
    this.environment = config.environment;
    for (const subscription of config.subscriptions) {
      for (const hash of subscription.keyHashes) this.byKeyHash.set(hash, subscription);
    }
    for (const certificate of config.certificates ?? []) {
      this.certificatesById.set(certificate.id, certificate);
    }
    for (const route of this.routes) {
      if (route.operations.length > 0) {
        this.operationIndexes.set(route, compileOperations(route.operations));
      }
    }
  }

  /**
   * The compiled operation index for a route this table matched. A route that declares nothing
   * gets the empty index; the caller's "no contract, so forward everything" branch reads
   * `route.operations.length` rather than this, because that is the condition the contract rule
   * is written against.
   */
  operationsFor(route: ConfigRoute): CompiledOperations<ConfigOperation> {
    return this.operationIndexes.get(route) ?? NO_OPERATIONS;
  }

  /** The next position in this route's rotation. Wraps well short of any precision limit. */
  nextCursor(resourceId: string): number {
    const next = ((this.cursors.get(resourceId) ?? 0) + 1) % 1_000_000;
    this.cursors.set(resourceId, next);
    return next;
  }

  /**
   * The client identity this route presents to its backend. The config names an id; the thumbprint
   * comes from the config too, so a rotation is a different cache key and an instance that has not
   * fetched the new material yet returns `null` rather than presenting the old certificate.
   */
  certificateFor(id: string, cache: ArtifactCache): CertificateMaterial | null {
    const declared = this.certificatesById.get(id);
    if (!declared) return null;
    return cache.certificate(declared.id, declared.thumbprint);
  }

  get certificates(): ConfigCertificate[] {
    return [...this.certificatesById.values()];
  }

  /** Exact host wins over the `*` wildcard; among equal hosts, the longest base path wins. */
  match(hostHeader: string | null, path: string): ConfigRoute | null {
    const host = hostKey(hostHeader);
    let wildcard: ConfigRoute | null = null;
    for (const route of this.routes) {
      if (!pathMatchesBase(path, route.basePath)) continue;
      if (route.host === host) return route;
      if (route.host === "*" && !wildcard) wildcard = route;
    }
    return wildcard;
  }

  /**
   * Only active subscriptions reach the config document, so an unknown hash and a revoked key are
   * the same answer — which is the correct one (design section 8.5: revocation fails closed at
   * the next poll).
   */
  subscriptionByKeyHash(hash: string): ConfigSubscription | null {
    return this.byKeyHash.get(hash) ?? null;
  }

  get subscriptionCount(): number {
    return this.byKeyHash.size;
  }
}
