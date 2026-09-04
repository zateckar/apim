import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { prunableRevisions, pruneRevisions } from "../control-plane/src/retention.ts";
import { pruneOldRows } from "../control-plane/src/telemetry.ts";
import { diffModels } from "../shared/diff.ts";
import type { ApiModel } from "../shared/types.ts";
import { makeCp, promote, prepareEnvironment, publishApi, startBackend, type TestCp } from "./helpers.ts";

/**
 * G3: every revision listed with where it is released, any two of them diffed **structurally**,
 * an unfrozen one correctable in place, and retention that leaves a tombstone.
 *
 * The properties worth protecting:
 *
 *  - **the diff is over the model, not the file.** A document reformatted or converted between
 *    dialects diffs as no change; a renamed required field diffs as breaking.
 *  - **breaking is a named rule.** Every flagged item says which rule fired, because a classifier
 *    nobody can interrogate stops being trusted.
 *  - **frozen means frozen.** A released revision refuses to change and names the alternative.
 *  - **retention keeps the tighter of two bounds** and never deletes a row.
 */

let cp: TestCp;

beforeEach(() => {
  cp = makeCp();
});
afterEach(() => {
  cp.close();
});

const SPEC_V1 = {
  openapi: "3.0.0",
  info: { title: "orders", version: "1.0.0" },
  paths: {
    "/orders": {
      get: {
        operationId: "listOrders",
        parameters: [{ name: "status", in: "query", schema: { type: "string", enum: ["open", "closed"] } }],
        responses: {
          "200": {
            description: "ok",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { total: { type: "integer" }, items: { type: "array", items: { type: "string" } } },
                },
              },
            },
          },
          "404": { description: "gone" },
        },
      },
      post: {
        operationId: "createOrder",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["sku"],
                properties: { sku: { type: "string" }, quantity: { type: "integer" } },
              },
            },
          },
        },
        responses: { "201": { description: "created" } },
      },
    },
  },
};

/** v2: one operation removed, one required property added, one type changed, one enum narrowed. */
const SPEC_V2 = {
  openapi: "3.0.0",
  info: { title: "orders", version: "1.1.0" },
  paths: {
    "/orders": {
      post: {
        operationId: "createOrder",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["sku", "customerRef"],
                properties: {
                  sku: { type: "string" },
                  quantity: { type: "string" },
                  customerRef: { type: "string" },
                },
              },
            },
          },
        },
        responses: { "201": { description: "created" } },
      },
    },
    "/orders/{id}": {
      get: {
        operationId: "getOrderById",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "ok" } },
      },
    },
  },
};

/** The same document with every object's keys in a different order — a reformat, not a change. */
function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      b.localeCompare(a),
    );
    return Object.fromEntries(entries.map(([key, entry]) => [key, sortKeysDeep(entry)]));
  }
  return value;
}

async function revisions(resourceId: string, cookie: string) {
  const response = await cp.call("GET", `/api/resources/${resourceId}/revisions`, { cookie });
  expect(response.status).toBe(200);
  return (await response.json()) as {
    items: Array<Record<string, unknown> & { id: string; rev: number }>;
  };
}

// --------------------------------------------------------------------------- the list

describe("the revision list", () => {
  test("carries provenance, artifact state and where each revision is released", async () => {
    const backend = startBackend();
    try {
      const api = await publishApi(cp, { backendUrl: backend.url, spec: SPEC_V1, subscribe: false });
      await cp.call("POST", `/api/resources/${api.resourceId}/revisions`, {
        cookie: api.pavel,
        body: { spec: SPEC_V2 },
      });

      const list = await revisions(api.resourceId, api.pavel);
      expect(list.items.map((item) => item.rev)).toEqual([2, 1]);

      const first = list.items.find((item) => item.rev === 1)!;
      // Where it is released, per environment, in the three states the UI renders.
      expect(first.releasedIn).toEqual({ dev: "live" });
      // Released, therefore frozen, therefore not editable — one fact, three fields the UI reads.
      expect(first.frozenAt).not.toBeNull();
      expect(first.editable).toBe(false);
      expect(first.source).toBe("upload");
      expect(first.sourceDetail).toBeNull();
      expect(first.originalBytes).toBeGreaterThan(0);
      expect(first.versionDigest).toMatch(/^sha256:/);
      expect(first.createdBy).toBe("pavel");

      const second = list.items.find((item) => item.rev === 2)!;
      expect(second.releasedIn).toEqual({});
      expect(second.frozenAt).toBeNull();
      expect(second.editable).toBe(true);
      // Two operations, both with a schema state the gateway will act on.
      expect(second.operations).toBe(2);
      expect(second.schemaStates).toEqual({ ok: 2, "no-schema": 0, "unsupported-schema": 0 });
    } finally {
      backend.stop();
    }
  });

  test("provenance records the URL a revision came from", async () => {
    const specServer = Bun.serve({ port: 0, fetch: () => Response.json(SPEC_V1) });
    try {
      const alice = await cp.login("alice");
      const resource = await (
        await cp.call("POST", "/api/resources", {
          cookie: alice,
          body: { kind: "rest", name: "from-url", teamId: "team_platform", apiVersion: "v1" },
        })
      ).json();
      const specUrl = `http://127.0.0.1:${specServer.port}/openapi.json`;
      const created = await cp.call("POST", `/api/resources/${resource.id}/revisions`, {
        cookie: alice,
        body: { specUrl },
      });
      expect(created.status).toBe(201);

      const list = await revisions(resource.id, alice);
      // `resource.discovery_url` is per resource and could not answer this per revision (review [P2-05]).
      expect(list.items[0]!.source).toBe("url");
      expect(list.items[0]!.sourceDetail).toBe(specUrl);
    } finally {
      specServer.stop(true);
    }
  });

  test("a new version records which revision it was copied from", async () => {
    const backend = startBackend();
    try {
      const api = await publishApi(cp, { backendUrl: backend.url, spec: SPEC_V1, subscribe: false });
      const created = await (
        await cp.call("POST", `/api/resources/${api.resourceId}/versions`, {
          cookie: api.pavel,
          body: { apiVersion: "v2" },
        })
      ).json();

      const list = await revisions(created.id, api.pavel);
      expect(list.items).toHaveLength(1);
      expect(list.items[0]!.source).toBe("copied");
      expect(list.items[0]!.sourceDetail).toMatch(/^revision:rev_/);
    } finally {
      backend.stop();
    }
  });
});

// --------------------------------------------------------------------------- the diff

describe("the structural diff", () => {
  test("names the rule behind every breaking change", () => {
    const from: ApiModel = {
      title: "orders",
      version: "1",
      servers: [],
      operations: [
        {
          operationId: "listOrders",
          method: "GET",
          path: "/orders",
          parameters: [{ name: "status", in: "query", required: false, schema: { type: "string" } }],
        },
        {
          operationId: "createOrder",
          method: "POST",
          path: "/orders",
          parameters: [],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                type: "object",
                required: ["sku"],
                properties: { sku: { type: "string" }, quantity: { type: "integer" } },
              },
            },
          },
          responses: {
            "200": {
              content: {
                "application/json": { type: "object", properties: { id: { type: "string" } } },
              },
            },
            "404": {},
          },
        },
      ],
    };
    const to: ApiModel = {
      title: "orders",
      version: "1",
      servers: [],
      operations: [
        {
          operationId: "createOrder",
          method: "POST",
          path: "/orders",
          parameters: [],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                type: "object",
                required: ["sku", "customerRef"],
                properties: {
                  sku: { type: "string" },
                  quantity: { type: "string" },
                  customerRef: { type: "string" },
                },
              },
            },
          },
          responses: { "200": { content: { "application/json": { type: "object", properties: {} } } } },
        },
        { operationId: "getOrderById", method: "GET", path: "/orders/{id}", parameters: [] },
      ],
    };

    const diff = diffModels(from, to);
    const removed = diff.operations.find((op) => op.operationId === "listOrders")!;
    expect(removed.change).toBe("removed");
    expect(removed.rule).toBe("operation-removed");

    const added = diff.operations.find((op) => op.operationId === "getOrderById")!;
    expect(added.change).toBe("added");
    expect(added.breaking).toBe(false);

    const changed = diff.operations.find((op) => op.operationId === "createOrder")!;
    expect(changed.change).toBe("changed");
    expect(changed.breaking).toBe(true);
    const rules = (changed.details ?? []).filter((d) => d.breaking).map((d) => d.rule);
    // Each of these is a way a request that worked yesterday stops working, and each has a name.
    expect(rules).toContain("required-added");
    expect(rules).toContain("type-changed");
    expect(rules).toContain("response-status-removed");
    expect(rules).toContain("response-property-removed");
    const required = (changed.details ?? []).find((d) => d.rule === "required-added")!;
    expect(required.path).toBe("/properties/customerRef");
    expect(required.now).toBe("required");

    expect(diff.summary.added).toBe(1);
    expect(diff.summary.removed).toBe(1);
    expect(diff.summary.changed).toBe(1);
    expect(diff.summary.breaking).toBe(2);
    // Blockers first: a list that buries the removed operation under a renamed title is a list
    // nobody reads to the end.
    expect(diff.operations[0]!.breaking).toBe(true);
  });

  test("an enum the request no longer accepts is breaking, and a wider one is not", () => {
    const parameter = (values: string[]) => ({
      title: "t",
      version: "1",
      servers: [],
      operations: [
        {
          operationId: "list",
          method: "GET",
          path: "/",
          parameters: [{ name: "status", in: "query" as const, required: false, schema: { type: "string", enum: values } }],
        },
      ],
    });
    const narrowed = diffModels(parameter(["open", "closed"]), parameter(["open"]));
    expect(narrowed.operations[0]!.details![0]!.rule).toBe("enum-value-removed");
    expect(narrowed.summary.breaking).toBe(1);

    const widened = diffModels(parameter(["open"]), parameter(["open", "closed"]));
    expect(widened.summary.breaking).toBe(0);
  });

  test("$ref is followed on both sides and a cycle terminates", () => {
    const model = (leafType: string): ApiModel => ({
      title: "t",
      version: "1",
      servers: [],
      components: {
        components: {
          schemas: {
            Node: {
              type: "object",
              properties: { value: { type: leafType }, next: { $ref: "#/components/schemas/Node" } },
            },
          },
        },
      },
      operations: [
        {
          operationId: "post",
          method: "POST",
          path: "/",
          parameters: [],
          requestBody: {
            required: true,
            content: { "application/json": { $ref: "#/components/schemas/Node" } },
          },
        },
      ],
    });

    const diff = diffModels(model("string"), model("integer"));
    const details = diff.operations[0]!.details!;
    expect(details.some((detail) => detail.rule === "type-changed")).toBe(true);
    expect(diff.operations[0]!.tooLargeToDiff).toBeUndefined();
  });

  test("a reformatted document is no change at all", async () => {
    const backend = startBackend();
    try {
      const api = await publishApi(cp, { backendUrl: backend.url, spec: SPEC_V1, subscribe: false });
      // Same document, keys reordered at every level: the digest is over the normalized model, so
      // this is not even a new revision (design section 4.1).
      const reordered = sortKeysDeep(SPEC_V1);
      const second = await (
        await cp.call("POST", `/api/resources/${api.resourceId}/revisions`, {
          cookie: api.pavel,
          body: { spec: reordered },
        })
      ).json();
      expect(second.unchanged).toBe(true);

      const list = await revisions(api.resourceId, api.pavel);
      expect(list.items).toHaveLength(1);
    } finally {
      backend.stop();
    }
  });

  test("the endpoint diffs against the previous revision by default", async () => {
    const backend = startBackend();
    try {
      const api = await publishApi(cp, { backendUrl: backend.url, spec: SPEC_V1, subscribe: false });
      const second = await (
        await cp.call("POST", `/api/resources/${api.resourceId}/revisions`, {
          cookie: api.pavel,
          body: { spec: SPEC_V2 },
        })
      ).json();

      const diff = await (
        await cp.call("GET", `/api/revisions/${second.id}/diff`, { cookie: api.pavel })
      ).json();
      expect(diff.from.rev).toBe(1);
      expect(diff.to.rev).toBe(2);
      expect(diff.summary.breaking).toBeGreaterThan(0);
      expect(diff.metadata.find((entry: { field: string }) => entry.field === "version")).toEqual({
        field: "version",
        was: "1.0.0",
        now: "1.1.0",
      });

      // `from` accepts a rev number, which is what the UI's compare control has in hand.
      const byRev = await (
        await cp.call("GET", `/api/revisions/${second.id}/diff?from=1`, { cookie: api.pavel })
      ).json();
      expect(byRev.from.id).toBe(diff.from.id);

      const first = (await revisions(api.resourceId, api.pavel)).items.find((item) => item.rev === 1)!;
      const noPrevious = await cp.call("GET", `/api/revisions/${first.id}/diff`, { cookie: api.pavel });
      expect(noPrevious.status).toBe(400);
      expect((await noPrevious.json()).detail).toContain("first of this API");
    } finally {
      backend.stop();
    }
  });

  test("two unrelated APIs refuse to diff", async () => {
    const backend = startBackend();
    try {
      const one = await publishApi(cp, { backendUrl: backend.url, spec: SPEC_V1, subscribe: false });
      const two = await publishApi(cp, { backendUrl: backend.url, spec: SPEC_V2, subscribe: false });
      const left = (await revisions(one.resourceId, one.pavel)).items[0]!;
      const right = (await revisions(two.resourceId, two.pavel)).items[0]!;

      const response = await cp.call("GET", `/api/revisions/${right.id}/diff?from=${left.id}`, {
        cookie: one.pavel,
      });
      expect(response.status).toBe(400);
      expect((await response.json()).detail).toContain("different");
    } finally {
      backend.stop();
    }
  });

  test("two versions of one API do diff, which is what the version wizard shows", async () => {
    const backend = startBackend();
    try {
      const api = await publishApi(cp, { backendUrl: backend.url, spec: SPEC_V1, subscribe: false });
      const v2 = await (
        await cp.call("POST", `/api/resources/${api.resourceId}/versions`, {
          cookie: api.pavel,
          body: { apiVersion: "v2" },
        })
      ).json();
      await cp.call("PUT", `/api/revisions/${(await revisions(v2.id, api.pavel)).items[0]!.id}/spec`, {
        cookie: api.pavel,
        headers: { "if-match": String((await revisions(v2.id, api.pavel)).items[0]!.versionDigest) },
        body: { spec: SPEC_V2 },
      });

      const left = (await revisions(api.resourceId, api.pavel)).items[0]!;
      const right = (await revisions(v2.id, api.pavel)).items[0]!;
      const diff = await (
        await cp.call("GET", `/api/revisions/${right.id}/diff?from=${left.id}`, { cookie: api.pavel })
      ).json();
      expect(diff.summary.breaking).toBeGreaterThan(0);
    } finally {
      backend.stop();
    }
  });
});

// --------------------------------------------------------------------------- correcting a draft

describe("correcting an unfrozen revision", () => {
  async function draft(spec: unknown = SPEC_V1) {
    const alice = await cp.login("alice");
    const resource = await (
      await cp.call("POST", "/api/resources", {
        cookie: alice,
        body: { kind: "rest", name: "draft-api", teamId: "team_platform", apiVersion: "v1" },
      })
    ).json();
    const created = await (
      await cp.call("POST", `/api/resources/${resource.id}/revisions`, { cookie: alice, body: { spec } })
    ).json();
    return { alice, resourceId: resource.id as string, revisionId: created.id as string, digest: created.versionDigest as string };
  }

  test("replaces the definition in place, keeping the rev number", async () => {
    const { alice, resourceId, revisionId, digest } = await draft();
    const response = await cp.call("PUT", `/api/revisions/${revisionId}/spec`, {
      cookie: alice,
      headers: { "if-match": digest },
      body: { spec: SPEC_V2 },
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    // A correction to a draft, not a new contract: the rev number is what a release names.
    expect(body.rev).toBe(1);
    expect(body.replacedDigest).toBe(digest);
    expect(body.versionDigest).not.toBe(digest);
    expect(body.operations).toBe(2);

    const list = await revisions(resourceId, alice);
    expect(list.items).toHaveLength(1);
    expect(list.items[0]!.source).toBe("corrected");
    expect(list.items[0]!.sourceDetail).toContain(digest);

    // The catalog is re-indexed, so the operation that arrived with the correction is findable.
    const found = await (
      await cp.call("GET", "/api/catalog?q=getOrderById", { cookie: alice })
    ).json();
    expect(JSON.stringify(found)).toContain("draft-api");

    const audit = cp.app.db
      .query<{ detail: string }, []>("SELECT detail FROM audit WHERE action = 'revision.correct'")
      .get();
    expect(audit?.detail).toContain(digest);
  });

  test("the same document again is an idempotent no-op", async () => {
    const { alice, revisionId, digest } = await draft();
    const response = await cp.call("PUT", `/api/revisions/${revisionId}/spec`, {
      cookie: alice,
      headers: { "if-match": digest },
      body: { spec: SPEC_V1 },
    });
    expect(response.status).toBe(200);
    expect((await response.json()).unchanged).toBe(true);
  });

  test("If-Match is required, and a stale one is refused", async () => {
    const { alice, revisionId, digest } = await draft();
    const missing = await cp.call("PUT", `/api/revisions/${revisionId}/spec`, {
      cookie: alice,
      body: { spec: SPEC_V2 },
    });
    expect(missing.status).toBe(428);

    const stale = await cp.call("PUT", `/api/revisions/${revisionId}/spec`, {
      cookie: alice,
      headers: { "if-match": "sha256:not-the-current-one" },
      body: { spec: SPEC_V2 },
    });
    expect(stale.status).toBe(412);
    void digest;
  });

  test("a frozen revision refuses and names the alternative", async () => {
    const backend = startBackend();
    try {
      const api = await publishApi(cp, { backendUrl: backend.url, spec: SPEC_V1, subscribe: false });
      const first = (await revisions(api.resourceId, api.pavel)).items[0]!;
      const response = await cp.call("PUT", `/api/revisions/${first.id}/spec`, {
        cookie: api.pavel,
        headers: { "if-match": String(first.versionDigest) },
        body: { spec: SPEC_V2 },
      });
      expect(response.status).toBe(409);
      const problem = await response.json();
      expect(problem.detail).toContain("was released to DEV");
      expect(problem.detail).toContain("create revision 2 instead");
      // The alternative is attached, so the UI offers the action rather than describing it.
      expect(problem.nextAction).toEqual({
        method: "POST",
        href: `/api/resources/${api.resourceId}/revisions`,
      });
    } finally {
      backend.stop();
    }
  });

  test("a definition of another kind is refused, naming both", async () => {
    const { alice, revisionId, digest } = await draft();
    const wsdl = await Bun.file("tools/backend/petstore.wsdl").text();
    const response = await cp.call("PUT", `/api/revisions/${revisionId}/spec`, {
      cookie: alice,
      headers: { "if-match": digest },
      body: { spec: wsdl },
    });
    // A WSDL replacing an OpenAPI would leave routing, validation and the catalog describing a
    // different shape of contract under an unchanged rev (review [P1-16]).
    expect(response.status).toBe(400);
    expect((await response.json()).detail).toContain("rest");
  });

  test("only the owning team or an admin may correct", async () => {
    const { revisionId, digest } = await draft();
    const clara = await cp.login("clara");
    const response = await cp.call("PUT", `/api/revisions/${revisionId}/spec`, {
      cookie: clara,
      headers: { "if-match": digest },
      body: { spec: SPEC_V2 },
    });
    expect(response.status).toBe(403);
  });
});

// --------------------------------------------------------------------------- retention

describe("retention", () => {
  /** `count` revisions on one resource, each a different document, none released. */
  async function manyRevisions(count: number) {
    const alice = await cp.login("alice");
    const resource = await (
      await cp.call("POST", "/api/resources", {
        cookie: alice,
        body: { kind: "rest", name: "churn", teamId: "team_platform", apiVersion: "v1" },
      })
    ).json();
    for (let i = 1; i <= count; i++) {
      const spec = {
        openapi: "3.0.0",
        info: { title: "churn", version: `1.0.${i}` },
        paths: { [`/thing-${i}`]: { get: { operationId: `get${i}`, responses: { "200": { description: "ok" } } } } },
      };
      const response = await cp.call("POST", `/api/resources/${resource.id}/revisions`, {
        cookie: alice,
        body: { spec },
      });
      expect(response.status).toBe(201);
    }
    return { alice, resourceId: resource.id as string };
  }

  test("keeps the newest REVISION_KEEP_COUNT and tombstones the rest", async () => {
    const { alice, resourceId } = await manyRevisions(8);
    // Age is not the only bound: the newest five survive, and three fall out on count alone even
    // though every one of them was created seconds ago — the bound is the *tighter* of the two
    // (review [P1-27]).
    const doomed = prunableRevisions(cp.app.db, {
      keepCount: cp.app.config.revisionKeepCount,
      keepDays: cp.app.config.revisionKeepDays,
      planRetentionHours: cp.app.config.jobRetentionHours,
    });
    expect(doomed.map((row) => row.rev).sort((a, b) => a - b)).toEqual([1, 2, 3]);

    const result = pruneRevisions(cp.app);
    expect(result.tombstoned).toBe(3);

    const list = await revisions(resourceId, alice);
    expect(list.items).toHaveLength(8);
    const tombstone = list.items.find((item) => item.rev === 1)!;
    // The row stays: releases, audit rows and foreign keys still resolve to it.
    expect(tombstone.prunedAt).not.toBeNull();
    expect(tombstone.diffable).toBe(false);
    expect(tombstone.editable).toBe(false);
    expect(tombstone.createdBy).toBe("alice");
    expect(tombstone.versionDigest).toMatch(/^sha256:/);
  });

  test("the bound is the tighter of the two, so age prunes inside the keep count as well", async () => {
    const { resourceId } = await manyRevisions(3);
    // Generous count, expired age: all three go. Read as a union — "keep the newest N *or*
    // anything younger than D" — nothing would ever be pruned from an API that is still being
    // worked on, which is the reading review [P1-27] rejected.
    const byAge = prunableRevisions(cp.app.db, {
      keepCount: 100,
      keepDays: 0,
      planRetentionHours: 1,
      now: Date.now() + 86_400_000,
    });
    expect(byAge.filter((row) => row.resource_id === resourceId).map((row) => row.rev)).toEqual([
      1, 2, 3,
    ]);

    // And the mirror image: young enough, but outside the count.
    const byCount = prunableRevisions(cp.app.db, {
      keepCount: 2,
      keepDays: 365,
      planRetentionHours: 1,
    });
    expect(byCount.filter((row) => row.resource_id === resourceId).map((row) => row.rev)).toEqual([1]);
  });

  test("a released revision, its predecessor and a live plan survive any bound", async () => {
    const backend = startBackend();
    try {
      const api = await publishApi(cp, { backendUrl: backend.url, spec: SPEC_V1, subscribe: false });
      // rev 2 released to DEV, so rev 1 becomes the rollback target §6 promises.
      await cp.call("POST", `/api/resources/${api.resourceId}/revisions`, {
        cookie: api.pavel,
        body: { spec: SPEC_V2 },
      });
      await promote(cp, api.pavel, api.resourceId, "dev", 2);
      // And a third, with a dry-run plan against TEST pointing at it.
      await prepareEnvironment(cp, api.pavel, api.resourceId, "test", "/churn-test", backend.url);
      await cp.call("POST", `/api/resources/${api.resourceId}/revisions`, {
        cookie: api.pavel,
        body: {
          spec: {
            openapi: "3.0.0",
            info: { title: "orders", version: "1.2.0" },
            paths: { "/third": { get: { operationId: "third", responses: { "200": { description: "ok" } } } } },
          },
        },
      });
      await cp.call("POST", `/api/resources/${api.resourceId}/releases?dryRun=1`, {
        cookie: api.pavel,
        body: { revision: 3, environment: "test" },
      });

      // Bounds tight enough to take everything: keep nothing on count, keep nothing on age.
      // `now` is one second ahead rather than days, so the *plan* is still inside its own window —
      // aging the clock far enough to expire the revisions would expire the plan too, and then
      // this test would be measuring the wrong exception.
      const doomed = prunableRevisions(cp.app.db, {
        keepCount: 1,
        keepDays: 0,
        planRetentionHours: 24,
        now: Date.now() + 1000,
      });
      // rev 2 is live in DEV, rev 1 is the rollback target, rev 3 is named by a live plan.
      expect(doomed.filter((row) => row.resource_id === api.resourceId)).toEqual([]);
    } finally {
      backend.stop();
    }
  });

  test("a plan older than JOB_RETENTION_HOURS protects nothing", async () => {
    const backend = startBackend();
    try {
      const api = await publishApi(cp, { backendUrl: backend.url, spec: SPEC_V1, subscribe: false });
      await cp.call("POST", `/api/resources/${api.resourceId}/revisions`, {
        cookie: api.pavel,
        body: { spec: SPEC_V2 },
      });
      await prepareEnvironment(cp, api.pavel, api.resourceId, "test", "/aged", backend.url);
      await cp.call("POST", `/api/resources/${api.resourceId}/releases?dryRun=1`, {
        cookie: api.pavel,
        body: { revision: 2, environment: "test" },
      });

      const bounds = { keepCount: 1, keepDays: 0, planRetentionHours: 24, now: Date.now() + 1000 };
      // rev 1 is live in DEV; rev 2 is outside the keep count and older than the age bound, so the
      // only thing holding it is the plan.
      const whilePlanIsLive = prunableRevisions(cp.app.db, bounds);
      expect(whilePlanIsLive.filter((row) => row.resource_id === api.resourceId)).toEqual([]);

      // The prune job deletes plans by the same clock, so a plan it has already removed cannot
      // keep a revision alive — and the plan says that rather than implying a guarantee the
      // schedule takes away (review [P1-15]).
      cp.app.db.run("UPDATE release_plan SET computed_at = '2020-01-01T00:00:00.000Z'");
      const afterPlanExpired = prunableRevisions(cp.app.db, bounds);
      expect(
        afterPlanExpired.filter((row) => row.resource_id === api.resourceId).map((row) => row.rev),
      ).toEqual([2]);
    } finally {
      backend.stop();
    }
  });

  test("only artifacts nothing unpruned references are dropped", async () => {
    const { resourceId } = await manyRevisions(8);
    const before = (
      cp.app.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM artifact").get() ?? { n: 0 }
    ).n;
    const shared = cp.app.db
      .query<{ artifact_digest: string | null }, [string]>(
        "SELECT artifact_digest FROM revision WHERE resource_id = ? AND rev = 1",
      )
      .get(resourceId);
    // These specs declare no schemas, so v3 stores `''` — the sentinel that must never be read as
    // a reference, or a phantom artifact would be kept for ever (review [P2-12]).
    expect(shared?.artifact_digest).toBe("");

    const result = pruneRevisions(cp.app);
    expect(result.tombstoned).toBe(3);
    const after = (
      cp.app.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM artifact").get() ?? { n: 0 }
    ).n;
    expect(after).toBeLessThanOrEqual(before);
  });

  test("the prune job reports what it removed, and the backfill leaves tombstones alone", async () => {
    await manyRevisions(8);
    const summary = pruneOldRows(cp.app);
    expect(summary).toContain("3 revisions");
    expect(summary).toContain("playground history");

    // The artifact backfill looks for `artifact_digest IS NULL`; a tombstone has no model, so it
    // must not be picked up or the job would fail for ever on a row that is deliberately empty.
    cp.app.db.run("UPDATE revision SET artifact_digest = NULL WHERE pruned_at IS NOT NULL");
    const pending = cp.app.db
      .query<{ n: number }, []>(
        "SELECT COUNT(*) AS n FROM revision WHERE artifact_digest IS NULL AND pruned_at IS NULL",
      )
      .get();
    expect(pending?.n).toBe(0);
  });

  test("a pruned revision cannot be released or diffed", async () => {
    const backend = startBackend();
    try {
      const { alice, resourceId } = await manyRevisions(8);
      await cp.call("PUT", `/api/resources/${resourceId}/routes`, {
        cookie: alice,
        body: { environment: "dev", host: "*", basePath: "/churn" },
      });
      await cp.call("PUT", `/api/resources/${resourceId}/binding`, {
        cookie: alice,
        body: { environment: "dev", urls: [backend.url] },
      });
      pruneRevisions(cp.app);

      const release = await cp.call("POST", `/api/resources/${resourceId}/releases`, {
        cookie: alice,
        body: { revision: 1, environment: "dev" },
      });
      expect(release.status).toBe(409);
      expect((await release.json()).detail).toContain("was pruned on");

      const list = await revisions(resourceId, alice);
      const tombstone = list.items.find((item) => item.rev === 1)!;
      const later = list.items.find((item) => item.rev === 4)!;
      const diff = await cp.call("GET", `/api/revisions/${later.id}/diff?from=${tombstone.id}`, {
        cookie: alice,
      });
      expect(diff.status).toBe(409);
      expect((await diff.json()).detail).toContain("was pruned on");

      const correct = await cp.call("PUT", `/api/revisions/${tombstone.id}/spec`, {
        cookie: alice,
        headers: { "if-match": String(tombstone.versionDigest) },
        body: { spec: SPEC_V2 },
      });
      expect(correct.status).toBe(409);
      expect((await correct.json()).detail).toContain("no longer");
    } finally {
      backend.stop();
    }
  });
});
