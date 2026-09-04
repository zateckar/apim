import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ArtifactRef, ValidationArtifact } from "../../shared/artifact.ts";
import { sha256Hex } from "../../shared/canonical.ts";
import type { ConfigCertificate } from "../../shared/config-doc.ts";

/**
 * The artifact cache of design section 8.7, and the certificate cache that travels the same way.
 *
 * Five rules, each of which is a failure mode somewhere else if it is dropped:
 *
 *  - **Content-addressed, therefore immutable.** A digest never changes meaning, so there is no
 *    invalidation logic, only eviction.
 *  - **Persisted, not ephemeral.** Without it, every restart re-downloads the estate's schemas, and
 *    a control-plane outage during a rolling restart leaves instances unable to validate.
 *  - **Activation is gated on availability.** An instance prefetches every digest a new config
 *    references and activates only when all are present and verified; until then it keeps serving
 *    the previous config. So `gateway_instance.config_digest` reports what is actually running.
 *  - **Digests are verified on read, every time** — not only on download, because a persisted
 *    volume can be corrupted or tampered with. A mismatch evicts and refetches.
 *  - **A route whose artifact is unavailable fails closed**, while every other route serves.
 *    Degrading it to `warning` would break section 5.1's guarantee; refusing to start would turn
 *    one bad schema into a fleet outage.
 *
 * Certificates are keyed `<id>-<thumbprint>`, so a rotation is a new entry and activation waits for
 * it exactly like an artifact (plan `[R2-15]`). They are key material, so they live in their own
 * directory written `0600` — and volume encryption at rest is a deployment requirement this repo
 * states rather than asserts (deviation D22).
 */

export interface ArtifactCacheOptions {
  directory: string;
  cpUrl: string;
  token: string;
  maxBytes: number;
  fetchImpl?: typeof fetch;
  log?: (message: string) => void;
}

export interface CertificateMaterial {
  id: string;
  thumbprint: string;
  certPem: string;
  keyPem: string;
  chainPem?: string;
}

interface Entry {
  bytes: number;
  lastUsedMs: number;
}

export class ArtifactCache {
  private readonly artifacts = new Map<string, ValidationArtifact>();
  private readonly certificates = new Map<string, CertificateMaterial>();
  private readonly entries = new Map<string, Entry>();
  private pinned = new Set<string>();
  /** Digests whose fetch failed; a route referencing one fails closed until it succeeds. */
  readonly unavailable = new Set<string>();

  constructor(private readonly options: ArtifactCacheOptions) {
    mkdirSync(this.artifactDir, { recursive: true });
    mkdirSync(this.certDir, { recursive: true });
    this.warnIfWorldReadable();
    this.indexDisk();
  }

  private get artifactDir(): string {
    return join(this.options.directory, "artifacts");
  }

  private get certDir(): string {
    return join(this.options.directory, "certs");
  }

  private warnIfWorldReadable(): void {
    // Deviation D22: the design puts key material on an encrypted volume. We cannot assert that,
    // so we say so once, loudly, at the moment the directory is created.
    //
    // Windows has no POSIX mode: Node synthesises `0o666` for every directory, so the check would
    // fire on every start and say nothing. ACLs are the equivalent control there and are outside
    // what this process can read portably, so the warning is simply not applicable.
    if (process.platform === "win32") return;
    try {
      const mode = statSync(this.certDir).mode & 0o777;
      if ((mode & 0o077) !== 0) {
        this.options.log?.(
          `[dp] ${this.certDir} is mode ${mode.toString(8)}: it holds backend client private keys. ` +
            "Design section 8.7 requires this volume to be encrypted at rest and readable only by " +
            "this process.",
        );
      }
    } catch {
      // A platform without POSIX modes (Windows) reports something meaningless; say nothing.
    }
  }

  private indexDisk(): void {
    for (const [dir, prefix] of [
      [this.artifactDir, "a"],
      [this.certDir, "c"],
    ] as const) {
      let names: string[];
      try {
        names = readdirSync(dir);
      } catch {
        continue;
      }
      for (const name of names) {
        try {
          this.entries.set(`${prefix}:${name}`, {
            bytes: statSync(join(dir, name)).size,
            lastUsedMs: 0,
          });
        } catch {
          // A file that vanished between listing and stat is simply not cached.
        }
      }
    }
  }

  private fileFor(digest: string): string {
    // A digest is `sha256:<hex>`; the colon is not a legal path character on every platform.
    return join(this.artifactDir, digest.replace(":", "_"));
  }

  private certFile(id: string, thumbprint: string): string {
    return join(this.certDir, `${id}-${thumbprint}.json`);
  }

  /**
   * Reads an artifact, verifying its digest **every time**. `null` means unavailable, which is
   * what makes a route fail closed rather than serve unvalidated.
   */
  get(digest: string): ValidationArtifact | null {
    const cached = this.artifacts.get(digest);
    if (cached) {
      this.touch(`a:${digest.replace(":", "_")}`);
      return cached;
    }
    const path = this.fileFor(digest);
    if (!existsSync(path)) return null;
    try {
      const bytes = readFileSync(path, "utf8");
      if (`sha256:${sha256Hex(bytes)}` !== digest) {
        this.options.log?.(`[dp] cached artifact ${digest} failed its digest check; evicting`);
        this.evict(digest);
        return null;
      }
      const artifact = JSON.parse(bytes) as ValidationArtifact;
      this.artifacts.set(digest, artifact);
      this.touch(`a:${digest.replace(":", "_")}`);
      return artifact;
    } catch (err) {
      this.options.log?.(`[dp] cached artifact ${digest} is unreadable (${(err as Error).message}); evicting`);
      this.evict(digest);
      return null;
    }
  }

  certificate(id: string, thumbprint: string): CertificateMaterial | null {
    const key = `${id}-${thumbprint}`;
    const cached = this.certificates.get(key);
    if (cached) return cached;
    const path = this.certFile(id, thumbprint);
    if (!existsSync(path)) return null;
    try {
      const material = JSON.parse(readFileSync(path, "utf8")) as CertificateMaterial;
      if (material.thumbprint !== thumbprint) return null;
      this.certificates.set(key, material);
      return material;
    } catch {
      return null;
    }
  }

  private touch(key: string): void {
    const entry = this.entries.get(key);
    if (entry) entry.lastUsedMs = Date.now();
  }

  private evict(digest: string): void {
    this.artifacts.delete(digest);
    this.entries.delete(`a:${digest.replace(":", "_")}`);
    try {
      unlinkSync(this.fileFor(digest));
    } catch {
      // Already gone is the state we wanted.
    }
  }

  /**
   * Fetches everything a candidate config references. Returns the digests that are still missing —
   * an empty array means the config may be activated.
   */
  async prefetch(
    artifacts: ArtifactRef[],
    certificates: ConfigCertificate[],
  ): Promise<{ missing: string[] }> {
    const missing: string[] = [];
    const wanted = new Set<string>();

    for (const ref of artifacts) {
      wanted.add(`a:${ref.digest.replace(":", "_")}`);
      if (this.get(ref.digest)) {
        this.unavailable.delete(ref.digest);
        continue;
      }
      const ok = await this.download(ref);
      if (ok) this.unavailable.delete(ref.digest);
      else {
        this.unavailable.add(ref.digest);
        missing.push(ref.digest);
      }
    }

    for (const certificate of certificates) {
      wanted.add(`c:${certificate.id}-${certificate.thumbprint}.json`);
      if (this.certificate(certificate.id, certificate.thumbprint)) continue;
      const ok = await this.downloadCertificate(certificate);
      if (!ok) missing.push(`${certificate.id}-${certificate.thumbprint}`);
    }

    // Eviction never removes something the config being activated needs.
    this.pinned = wanted;
    this.enforceCeiling();
    return { missing };
  }

  private async download(ref: ArtifactRef): Promise<boolean> {
    const doFetch = this.options.fetchImpl ?? fetch;
    try {
      const response = await doFetch(
        `${this.options.cpUrl}/api/gateway/artifacts/${encodeURIComponent(ref.digest)}`,
        {
          headers: { authorization: `Bearer ${this.options.token}` },
          signal: AbortSignal.timeout(30_000),
        },
      );
      if (!response.ok) {
        this.options.log?.(`[dp] artifact ${ref.digest} returned HTTP ${response.status}`);
        return false;
      }
      const bytes = await response.text();
      if (`sha256:${sha256Hex(bytes)}` !== ref.digest) {
        this.options.log?.(`[dp] artifact ${ref.digest} did not match its digest on download`);
        return false;
      }
      writeFileSync(this.fileFor(ref.digest), bytes);
      this.entries.set(`a:${ref.digest.replace(":", "_")}`, {
        bytes: Buffer.byteLength(bytes, "utf8"),
        lastUsedMs: Date.now(),
      });
      this.artifacts.set(ref.digest, JSON.parse(bytes) as ValidationArtifact);
      return true;
    } catch (err) {
      this.options.log?.(`[dp] artifact ${ref.digest} could not be fetched: ${(err as Error).message}`);
      return false;
    }
  }

  private async downloadCertificate(certificate: ConfigCertificate): Promise<boolean> {
    const doFetch = this.options.fetchImpl ?? fetch;
    try {
      const response = await doFetch(
        `${this.options.cpUrl}/api/gateway/certificates/${encodeURIComponent(certificate.id)}`,
        {
          headers: { authorization: `Bearer ${this.options.token}` },
          signal: AbortSignal.timeout(30_000),
        },
      );
      if (!response.ok) return false;
      const material = (await response.json()) as CertificateMaterial;
      if (material.thumbprint !== certificate.thumbprint) {
        this.options.log?.(
          `[dp] certificate ${certificate.id} arrived with thumbprint ${material.thumbprint}, ` +
            `expected ${certificate.thumbprint}`,
        );
        return false;
      }
      const path = this.certFile(certificate.id, certificate.thumbprint);
      writeFileSync(path, JSON.stringify(material), { mode: 0o600 });
      this.certificates.set(`${certificate.id}-${certificate.thumbprint}`, material);
      this.entries.set(`c:${certificate.id}-${certificate.thumbprint}.json`, {
        bytes: statSync(path).size,
        lastUsedMs: Date.now(),
      });
      return true;
    } catch (err) {
      this.options.log?.(`[dp] certificate ${certificate.id}: ${(err as Error).message}`);
      return false;
    }
  }

  /** LRU by total size, with the active config's entries pinned. */
  private enforceCeiling(): void {
    let total = 0;
    for (const entry of this.entries.values()) total += entry.bytes;
    if (total <= this.options.maxBytes) return;

    const candidates = [...this.entries.entries()]
      .filter(([key]) => !this.pinned.has(key))
      .sort((a, b) => a[1].lastUsedMs - b[1].lastUsedMs);

    for (const [key, entry] of candidates) {
      if (total <= this.options.maxBytes) break;
      const [prefix, name] = [key.slice(0, 1), key.slice(2)];
      try {
        unlinkSync(join(prefix === "a" ? this.artifactDir : this.certDir, name));
      } catch {
        // Already gone.
      }
      this.entries.delete(key);
      if (prefix === "a") this.artifacts.delete(`sha256:${name.slice("sha256_".length)}`);
      else this.certificates.delete(name.replace(/\.json$/, ""));
      total -= entry.bytes;
    }
  }

  stats(): { artifacts: number; certificates: number; bytes: number; unavailable: number } {
    let bytes = 0;
    for (const entry of this.entries.values()) bytes += entry.bytes;
    return {
      artifacts: this.artifacts.size,
      certificates: this.certificates.size,
      bytes,
      unavailable: this.unavailable.size,
    };
  }
}
