import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { runOperations } from "../control-plane/src/operations.ts";
import { makeCp, MINI_SPEC, type TestCp } from "./helpers.ts";

/**
 * The documentation link — one external page per API, the wiki entry usually. It is catalog
 * metadata, not routing: no gateway ever sees it, but three write paths reach the column (publish,
 * configure, PATCH) and one read path renders it as a clickable link, so the rule that it is an
 * absolute http(s) URL has to hold on all three.
 */
let cp: TestCp;

beforeEach(() => {
  cp = makeCp();
});
afterEach(() => {
  cp.close();
});

async function call(method: string, path: string, user: string, body?: unknown, headers: Record<string, string> = {}) {
  return cp.call(method, path, { cookie: await cp.login(user), body, headers });
}

async function publish(name: string, docsUrl?: string | null) {
  const response = await call(
    "POST",
    "/api/publish",
    "pavel",
    {
      applicationId: "application_platform",
      name,
      productName: `${name}-product`,
      backendUrl: "http://127.0.0.1:9999",
      domain: "IT",
      subdomain: "Solution",
      description: "The one we publish.",
      ...(docsUrl === undefined ? {} : { docsUrl }),
      spec: MINI_SPEC,
    },
    { "idempotency-key": `${name}-${Math.random()}` },
  );
  return response;
}

function resourceIdOf(name: string): string {
  return cp.app.db
    .query<{ id: string }, [string]>("SELECT id FROM resource WHERE name=?")
    .get(name)!.id;
}

async function workspace(resourceId: string, user = "pavel") {
  const response = await call("GET", `/api/resources/${resourceId}/editor?environment=dev`, user);
  expect(response.status).toBe(200);
  return response.json();
}

describe("the documentation link", () => {
  test("is set when the API is published and comes back on the workspace", async () => {
    const response = await publish("docs-api", "https://wiki.example/teams/platform/docs-api");
    expect(response.status).toBe(202);
    const d = await workspace(resourceIdOf("docs-api"));
    expect(d.resource.docsUrl).toBe("https://wiki.example/teams/platform/docs-api");
  });

  test("the workspace is told which of the definition's operations are validated", async () => {
    // Not about the link: this is the file that already reads the workspace payload. Every
    // operation of the definition in force comes back with its schemaState, so "not validated" is
    // on the screen rather than assumed (api-edit-properties).
    expect((await publish("checked-api")).status).toBe(202);
    runOperations(cp.app);
    const d = await workspace(resourceIdOf("checked-api"));
    const inventory = d.validation.find((op: { id: string }) => op.id === "getInventory");
    expect(inventory).toMatchObject({ method: "GET", template: "/store/inventory", schemaState: "no-schema" });
    expect(d.validation).toHaveLength(8);
  });

  test("is null rather than empty when nobody set one", async () => {
    expect((await publish("plain-api")).status).toBe(202);
    const d = await workspace(resourceIdOf("plain-api"));
    expect(d.resource.docsUrl).toBeNull();
  });

  test("a configure save replaces it, and an empty string takes it off", async () => {
    await publish("moving-api", "https://wiki.example/old");
    const id = resourceIdOf("moving-api");

    let d = await workspace(id);
    const moved = await call(
      "POST",
      `/api/resources/${id}/configure`,
      "pavel",
      { environment: "dev", docsUrl: "  https://wiki.example/new  ", domain: "IT", subdomain: "Solution" },
      { "idempotency-key": "docs-move", "if-match": d.resource.etag },
    );
    expect(moved.status).toBe(202);
    d = await workspace(id);
    // Trimmed on the way in: a link with a trailing space is the same link.
    expect(d.resource.docsUrl).toBe("https://wiki.example/new");

    const cleared = await call(
      "POST",
      `/api/resources/${id}/configure`,
      "pavel",
      { environment: "dev", docsUrl: "", domain: "IT", subdomain: "Solution" },
      { "idempotency-key": "docs-clear", "if-match": d.resource.etag },
    );
    expect(cleared.status).toBe(202);
    expect((await workspace(id)).resource.docsUrl).toBeNull();
  });

  test("a save from a tab that does not carry the field leaves the link alone", async () => {
    await publish("policy-api", "https://wiki.example/keep-me");
    const id = resourceIdOf("policy-api");
    const d = await workspace(id);
    // What the definition and policy tabs send: no `docsUrl` key at all. Absent has to mean "this
    // form does not know about the field", or every policy edit would quietly delete the link.
    const saved = await call(
      "POST",
      `/api/resources/${id}/configure`,
      "pavel",
      { environment: "dev", description: "Changed on the policy tab.", domain: "IT", subdomain: "Solution" },
      { "idempotency-key": "docs-untouched", "if-match": d.resource.etag },
    );
    expect(saved.status).toBe(202);
    expect((await workspace(id)).resource.docsUrl).toBe("https://wiki.example/keep-me");
  });

  test("refuses anything that is not an absolute http(s) URL", async () => {
    await publish("guarded-api");
    const id = resourceIdOf("guarded-api");
    for (const bad of ["javascript:alert(1)", "wiki/page", "data:text/html,x", "ftp://files.example/x"]) {
      const d = await workspace(id);
      const response = await call(
        "POST",
        `/api/resources/${id}/configure`,
        "pavel",
        { environment: "dev", docsUrl: bad, domain: "IT", subdomain: "Solution" },
        { "idempotency-key": `bad-${bad}`, "if-match": d.resource.etag },
      );
      expect(response.status).toBe(400);
      expect((await response.json()).detail).toContain("docsUrl");
      expect((await workspace(id)).resource.docsUrl).toBeNull();
    }
  });

  test("PATCH is held to the same rule as the configure command", async () => {
    await publish("patched-api");
    const id = resourceIdOf("patched-api");
    let d = await workspace(id);

    const bad = await call(
      "PATCH",
      `/api/resources/${id}`,
      "pavel",
      { docsUrl: "javascript:alert(1)" },
      { "if-match": d.resource.etag },
    );
    expect(bad.status).toBe(400);

    d = await workspace(id);
    const good = await call(
      "PATCH",
      `/api/resources/${id}`,
      "pavel",
      { docsUrl: "https://wiki.example/patched" },
      { "if-match": d.resource.etag },
    );
    expect(good.status).toBe(200);
    expect((await good.json()).docsUrl).toBe("https://wiki.example/patched");
  });

  test("a new version inherits the card its predecessor had", async () => {
    await publish("carried-api", "https://wiki.example/carried");
    const id = resourceIdOf("carried-api");
    let d = await workspace(id);
    await call(
      "PATCH",
      `/api/resources/${id}`,
      "pavel",
      { summary: "A card subtitle.", tags: ["billing"] },
      { "if-match": d.resource.etag },
    );

    const created = await call("POST", `/api/resources/${id}/versions`, "pavel", { apiVersion: "v2" });
    expect(created.status).toBe(201);
    const v2 = await created.json();
    // v2 of a documented API arriving blank reads as a different, undocumented product.
    expect(v2.docsUrl).toBe("https://wiki.example/carried");
    expect(v2.description).toBe("The one we publish.");
    expect(v2.summary).toBe("A card subtitle.");
    expect(v2.tags).toEqual(["billing"]);
  });
});
