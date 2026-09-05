import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalJson, sha256Hex } from "../shared/canonical.ts";
import type { ValidationArtifact } from "../shared/artifact.ts";
import { ArtifactCache } from "../data-plane/src/artifacts.ts";
import { readArtifact, storeArtifact } from "../control-plane/src/artifacts.ts";
import { makeCp, makeDp, publishApi, serveCp, startBackend, type TestCp } from "./helpers.ts";

/**
 * Design section 8.7: compiled validators are content-addressed, travel on their own channel, are
 * verified on every read, and gate activation.
 *
 * The property these tests exist to protect is the chain: the name of a bundle is the hash of the
 * bytes that are served under it, all the way from the compiler to the instance's disk. Every link
 * that breaks it — a different serialisation on write, a corrupted file on disk, a truncated
 * download — has to be caught, because the failure mode of *not* catching it is a gateway
 * validating against something nobody compiled.
 */

const SPEC = {
  openapi: "3.0.0",
  info: { title: "pets", version: "1.0.0" },
  paths: {
    "/pets": {
      post: {
        operationId: "addPet",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["name"],
                properties: { name: { type: "string" }, age: { type: "integer" } },
                additionalProperties: false,
              },
            },
          },
        },
        responses: { "200": { description: "ok" } },
      },
    },
  },
};

let cp: TestCp;

beforeEach(() => {
  cp = makeCp();
});
afterEach(() => {
  cp.close();
});

describe("content addressing", () => {
  test("the digest is over the bytes that are served, not over an equal value", () => {
    // The compiler builds objects in whatever order it happens to; the digest must not depend on
    // that, and the stored bytes must be exactly what was hashed. This is the link that, when it
    // broke, made every download fail its integrity check.
    const bundle: ValidationArtifact = {
      kind: "json-schema",
      defs: { b: { type: "string" }, a: { type: "number" } },
      operations: { op: { state: "no-schema", reason: "none" } },
    };
    const ref = storeArtifact(cp.app.db, bundle);
    const stored = readArtifact(cp.app.db, ref.digest)!;

    expect(`sha256:${sha256Hex(stored.bytes)}`).toBe(ref.digest);
    expect(stored.bytes).toBe(canonicalJson(bundle));
    // Key order in the input cannot change the name.
    const reordered: ValidationArtifact = {
      operations: bundle.operations,
      defs: { a: { type: "number" }, b: { type: "string" } },
      kind: "json-schema",
    } as ValidationArtifact;
    expect(storeArtifact(cp.app.db, reordered).digest).toBe(ref.digest);
  });

  test("two revisions with identical schemas share one stored bundle", async () => {
    const backend = startBackend();
    try {
      const one = await publishApi(cp, { backendUrl: backend.url, spec: SPEC, name: "pets-one" });
      const two = await publishApi(cp, { backendUrl: backend.url, spec: SPEC, name: "pets-two" });
      const digests = cp.app.db
        .query<{ artifact_digest: string }, [string, string]>(
          "SELECT artifact_digest FROM revision WHERE resource_id IN (?, ?)",
        )
        .all(one.resourceId, two.resourceId);
      expect(digests).toHaveLength(2);
      expect(digests[0]!.artifact_digest).toBe(digests[1]!.artifact_digest);
      const rows = cp.app.db
        .query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM artifact WHERE digest = ?")
        .all(digests[0]!.artifact_digest);
      expect(rows[0]!.n).toBe(1);
    } finally {
      backend.stop();
    }
  });
});

describe("the artifact channel", () => {
  test("compile, fetch, verify, activate — and the route then validates", async () => {
    const backend = startBackend();
    const cpServer = serveCp(cp);
    const api = await publishApi(cp, { backendUrl: backend.url, spec: SPEC, basePath: "/pets" });
    const dp = makeDp(cpServer.url, cp.token, cp.dir);
    try {
      await dp.start();
      expect(dp.client.activationBlocked).toBeNull();
      expect(dp.client.table).not.toBeNull();
      // The bundle is on the instance's disk, not only in its memory.
      expect(dp.artifacts.stats().artifacts).toBeGreaterThan(0);

      const conforming = await dp.fetchHttp(
        new Request("http://gw/it/solution/pets/pets", {
          method: "POST",
          headers: { "content-type": "application/json", "x-api-key": api.key! },
          body: JSON.stringify({ name: "rex", age: 3 }),
        }),
        "127.0.0.1",
      );
      expect(conforming.status).toBe(200);

      const violating = await dp.fetchHttp(
        new Request("http://gw/it/solution/pets/pets", {
          method: "POST",
          headers: { "content-type": "application/json", "x-api-key": api.key! },
          body: JSON.stringify({ age: 3 }),
        }),
        "127.0.0.1",
      );
      expect(violating.status).toBe(400);
      expect(backend.requests).toHaveLength(1);
    } finally {
      dp.stop();
      cpServer.stop();
      backend.stop();
    }
  });

  test("a config whose bundle cannot be fetched does not activate", async () => {
    const backend = startBackend();
    const cpServer = serveCp(cp);
    await publishApi(cp, { backendUrl: backend.url, spec: SPEC, basePath: "/pets" });
    // The digest is referenced by the config and no longer exists to be served: exactly the
    // situation an instance must refuse to activate into.
    cp.app.db.run("DELETE FROM artifact");
    const dp = makeDp(cpServer.url, cp.token, cp.dir);
    try {
      await dp.start();
      expect(dp.client.table).toBeNull();
      expect(dp.client.activationBlocked).toContain("could not be fetched");
      const health = dp.health();
      expect(health.ok).toBe(false);
      expect(health.activationBlocked).toContain("could not be fetched");
    } finally {
      dp.stop();
      cpServer.stop();
      backend.stop();
    }
  });

  test("the previous config keeps serving when a new one's bundle is missing", async () => {
    const backend = startBackend();
    const cpServer = serveCp(cp);
    const api = await publishApi(cp, { backendUrl: backend.url, spec: SPEC, basePath: "/pets" });
    const dp = makeDp(cpServer.url, cp.token, cp.dir);
    try {
      await dp.start();
      const firstDigest = dp.client.table!.digest;

      // A new revision with a different schema, whose bundle then vanishes.
      const changed = structuredClone(SPEC);
      changed.paths["/pets"].post.operationId = "addPetV2";
      await cp.call(`POST`, `/api/resources/${api.resourceId}/revisions`, {
        cookie: api.pavel,
        body: { spec: changed },
      });
      await cp.call("POST", `/api/resources/${api.resourceId}/releases`, {
        cookie: api.pavel,
        body: { revision: 2, environment: "dev" },
      });
      cp.app.db.run("DELETE FROM artifact WHERE digest NOT IN (SELECT artifact_digest FROM revision WHERE rev = 1)");

      expect(await dp.client.pollOnce()).toBe("blocked");
      // Still serving, still the old digest, and the reason is reported rather than inferred.
      expect(dp.client.table!.digest).toBe(firstDigest);
      expect(dp.client.activationBlocked).toContain("could not be fetched");

      const response = await dp.fetchHttp(
        new Request("http://gw/it/solution/pets/pets", {
          method: "POST",
          headers: { "content-type": "application/json", "x-api-key": api.key! },
          body: JSON.stringify({ name: "rex" }),
        }),
        "127.0.0.1",
      );
      expect(response.status).toBe(200);
    } finally {
      dp.stop();
      cpServer.stop();
      backend.stop();
    }
  });

  test("an instance may not fetch a bundle its own environment does not reference", async () => {
    const backend = startBackend();
    try {
      await publishApi(cp, { backendUrl: backend.url, spec: SPEC });
      // Stored, but released nowhere: no environment's config can name it.
      const orphan = storeArtifact(cp.app.db, {
        kind: "json-schema",
        defs: { secret: { type: "string" } },
        operations: {},
      });
      const response = await cp.call(
        "GET",
        `/api/gateway/artifacts/${encodeURIComponent(orphan.digest)}`,
        { headers: { authorization: `Bearer ${cp.token}` } },
      );
      // 404, not 403: whether the digest exists at all is what must not leak.
      expect(response.status).toBe(404);

      const reachable = cp.app.db
        .query<{ artifact_digest: string }, []>(
          "SELECT artifact_digest FROM revision WHERE artifact_digest IS NOT NULL AND artifact_digest != '' LIMIT 1",
        )
        .get()!;
      const ok = await cp.call(
        "GET",
        `/api/gateway/artifacts/${encodeURIComponent(reachable.artifact_digest)}`,
        { headers: { authorization: `Bearer ${cp.token}` } },
      );
      expect(ok.status).toBe(200);
      expect(ok.headers.get("cache-control")).toContain("immutable");
      expect(`sha256:${sha256Hex(await ok.text())}`).toBe(reachable.artifact_digest);
    } finally {
      backend.stop();
    }
  });

  test("the channel is closed to a session cookie and to no credential at all", async () => {
    const backend = startBackend();
    try {
      await publishApi(cp, { backendUrl: backend.url, spec: SPEC });
      const digest = cp.app.db
        .query<{ artifact_digest: string }, []>(
          "SELECT artifact_digest FROM revision WHERE artifact_digest != '' LIMIT 1",
        )
        .get()!.artifact_digest;
      const path = `/api/gateway/artifacts/${encodeURIComponent(digest)}`;

      expect((await cp.call("GET", path)).status).toBe(401);
      const alice = await cp.login("alice");
      expect((await cp.call("GET", path, { cookie: alice })).status).toBe(401);
    } finally {
      backend.stop();
    }
  });
});

describe("the instance-side cache", () => {
  function cacheFor(dir: string) {
    return new ArtifactCache({
      directory: dir,
      cpUrl: "http://127.0.0.1:1",
      token: "unused",
      maxBytes: 1024 * 1024,
    });
  }

  test("a corrupted file is detected on read and evicted, not served", () => {
    const dir = join(cp.dir, "cache-corrupt");
    const cache = cacheFor(dir);
    const bundle: ValidationArtifact = { kind: "json-schema", defs: {}, operations: {} };
    const bytes = canonicalJson(bundle);
    const digest = `sha256:${sha256Hex(bytes)}`;
    const file = join(dir, "artifacts", digest.replace(":", "_"));
    writeFileSync(file, bytes);
    expect(cache.get(digest)).not.toBeNull();

    // Same name, different bytes — a tampered or half-written volume.
    const second = cacheFor(join(cp.dir, "cache-corrupt-2"));
    const file2 = join(cp.dir, "cache-corrupt-2", "artifacts", digest.replace(":", "_"));
    writeFileSync(file2, canonicalJson({ kind: "json-schema", defs: { evil: true }, operations: {} }));
    expect(second.get(digest)).toBeNull();
    // Evicted rather than left to be re-read and re-rejected on every request.
    expect(readdirSync(join(cp.dir, "cache-corrupt-2", "artifacts"))).toHaveLength(0);
  });

  test("a download whose bytes do not match the digest is refused", async () => {
    const dir = join(cp.dir, "cache-liar");
    const cache = new ArtifactCache({
      directory: dir,
      cpUrl: "http://cp.test",
      token: "t",
      maxBytes: 1024 * 1024,
      // A control plane that answers with bytes that are not what was asked for — a proxy serving
      // a cached error page, a truncated response, or a tampered one.
      fetchImpl: (async () =>
        new Response(`{"kind":"json-schema","defs":{},"operations":{}}`)) as unknown as typeof fetch,
    });
    const { missing } = await cache.prefetch(
      [{ digest: "sha256:" + "0".repeat(64), kind: "json-schema", sizeBytes: 10 }],
      [],
    );
    expect(missing).toHaveLength(1);
    expect(cache.unavailable.size).toBe(1);
    expect(readdirSync(join(dir, "artifacts"))).toHaveLength(0);
  });

  test("eviction never drops what the active config pinned", async () => {
    const dir = join(cp.dir, "cache-evict");
    const bundles = [1, 2, 3].map((n) => ({
      kind: "json-schema" as const,
      defs: { pad: { type: "string", description: "x".repeat(2000 * n) } },
      operations: {},
    }));
    const byDigest = new Map<string, string>(
      bundles.map((b) => [`sha256:${sha256Hex(canonicalJson(b))}`, canonicalJson(b)]),
    );

    const cache = new ArtifactCache({
      directory: dir,
      cpUrl: "http://cp.test",
      token: "t",
      // Room for roughly one bundle, so eviction must run.
      maxBytes: 4000,
      fetchImpl: (async (input: unknown) => {
        const digest = decodeURIComponent(String(input).split("/").pop()!);
        const body = byDigest.get(digest);
        return body ? new Response(body) : new Response("no", { status: 404 });
      }) as unknown as typeof fetch,
    });

    const refs = [...byDigest.keys()].map((digest) => ({
      digest,
      kind: "json-schema" as const,
      sizeBytes: byDigest.get(digest)!.length,
    }));
    // All three are referenced by the config being activated, so all three are pinned — the
    // ceiling may not evict something the running config needs.
    const { missing } = await cache.prefetch(refs, []);
    expect(missing).toEqual([]);
    for (const digest of byDigest.keys()) expect(cache.get(digest)).not.toBeNull();

    // Now only the last one is referenced; the other two become evictable.
    await cache.prefetch(refs.slice(2), []);
    expect(cache.get(refs[2]!.digest)).not.toBeNull();
  });

  test("a cold instance with a warm cache and a dead control plane still validates", async () => {
    const backend = startBackend();
    const cpServer = serveCp(cp);
    const api = await publishApi(cp, { backendUrl: backend.url, spec: SPEC, basePath: "/pets" });
    const warm = makeDp(cpServer.url, cp.token, cp.dir, { name: "warm" });
    await warm.start();
    expect(warm.client.table).not.toBeNull();
    warm.stop();
    cpServer.stop();

    // Same cache paths, control plane gone: fail-static config plus the persisted bundle.
    const cold = makeDp("http://127.0.0.1:1", cp.token, cp.dir, { name: "warm" });
    try {
      await cold.start();
      expect(cold.client.table).not.toBeNull();
      expect(cold.client.fromCache).toBe(true);

      const violating = await cold.fetchHttp(
        new Request("http://gw/it/solution/pets/pets", {
          method: "POST",
          headers: { "content-type": "application/json", "x-api-key": api.key! },
          body: JSON.stringify({ age: 3 }),
        }),
        "127.0.0.1",
      );
      // Still enforcing: the whole point of persisting the bundle rather than caching it in memory.
      expect(violating.status).toBe(400);
      expect(backend.requests).toHaveLength(0);
    } finally {
      cold.stop();
      backend.stop();
    }
  });
});
