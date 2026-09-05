import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { buildConfig } from "../control-plane/src/config-build.ts";
import { runOperations } from "../control-plane/src/operations.ts";
import { makeCp, MINI_SPEC, publishApi, startBackend, type TestCp } from "./helpers.ts";

/**
 * An environment has gateways, plural (v8).
 *
 * The estate this portal is modelled on serves DEV from a managed gateway in the cloud *and* an
 * on-premise one, and an API says which of them it answers on. The point of these tests is that
 * the selection is a fact rather than a label: a gateway that was not chosen is not told about
 * the route, and a gateway that was chosen carries every address it answers on into the URL the
 * portal shows.
 */

let cp: TestCp;
let backend: ReturnType<typeof startBackend>;

beforeEach(() => {
  cp = makeCp();
  backend = startBackend();
});

afterEach(() => {
  backend.stop();
  cp.close();
});

/** `POST /api/publish` with the bits every case here shares, and an idempotency key it demands. */
function publishOn(cookie: string, name: string, gateways?: string[]) {
  return cp.call("POST", "/api/publish", {
    cookie,
    headers: { "idempotency-key": `${name}-${Math.random().toString(36).slice(2)}` },
    body: {
      name,
      kind: "rest",
      applicationId: "application_platform",
      apiVersion: "v1",
      domain: "IT",
      subdomain: "Solution",
      environment: "dev",
      backendUrl: backend.url,
      productName: `${name}-product`,
      ...(gateways === undefined ? {} : { gateways }),
      spec: MINI_SPEC,
    },
  });
}

/** `POST /configure`, which is guarded by both an idempotency key and the resource's ETag. */
async function configure(cookie: string, resourceId: string, body: Record<string, unknown>) {
  const current = await cp.call("GET", `/api/resources/${resourceId}`, { cookie });
  return cp.call("POST", `/api/resources/${resourceId}/configure`, {
    cookie,
    headers: {
      "idempotency-key": `cfg-${Math.random().toString(36).slice(2)}`,
      "if-match": current.headers.get("etag")!,
    },
    body,
  });
}

/** The on-premise gateway the fixtures add beside the seeded one. */
async function addOnPrem(cookie: string, environment = "dev") {
  const response = await cp.call("POST", "/api/gateways", {
    cookie,
    body: {
      environment,
      name: "onprem",
      category: "samb",
      label: "Mladá Boleslav",
      publicUrl: "https://gw-samb.example",
      intranetUrl: "https://apigw.internal.example",
    },
  });
  expect(response.status).toBe(201);
  return response.json() as Promise<Record<string, unknown>>;
}

describe("gateways in an environment", () => {
  test("a second gateway can be added, and starts empty", async () => {
    const alice = await cp.login("alice");
    await publishApi(cp, { backendUrl: backend.url, subscribe: false });

    const created = await addOnPrem(alice);
    // Nothing already published moves onto a gateway that did not exist when it was published.
    expect(created.published).toBe(0);
    expect(created.addresses).toEqual([
      { network: "internet", url: "https://gw-samb.example" },
      { network: "intranet", url: "https://apigw.internal.example" },
    ]);

    const list = await (await cp.call("GET", "/api/gateways", { cookie: alice })).json();
    const dev = (list.items as Array<Record<string, unknown>>).filter((g) => g.environment === "dev");
    expect(dev.map((g) => g.name).sort()).toEqual(["local", "onprem"]);
  });

  test("two gateways with one name in an environment is refused", async () => {
    const alice = await cp.login("alice");
    await addOnPrem(alice);
    const again = await cp.call("POST", "/api/gateways", {
      cookie: alice,
      body: { environment: "dev", name: "onprem" },
    });
    expect(again.status).toBe(409);
    expect((await again.json()).detail).toContain('already has a gateway named "onprem"');
  });

  test("gateway management stays admin-only", async () => {
    const pavel = await cp.login("pavel");
    const list = await cp.call("GET", "/api/gateways", { cookie: pavel });
    expect(list.status).toBe(403);
    const create = await cp.call("POST", "/api/gateways", {
      cookie: pavel,
      body: { environment: "dev", name: "onprem" },
    });
    expect(create.status).toBe(403);
  });
});

describe("publishing on a subset of an environment's gateways", () => {
  test("by default an API is published on every gateway the environment has", async () => {
    const alice = await cp.login("alice");
    await addOnPrem(alice);
    const pavel = await cp.login("pavel");

    const published = await publishOn(pavel, "everywhere");
    expect(published.status).toBe(202);
    runOperations(cp.app);

    const bound = cp.app.db
      .query<{ name: string }, [string]>(
        `SELECT t.name FROM route_gateway rg JOIN target t ON t.id = rg.target_id
          WHERE rg.resource_id = ? ORDER BY t.name`,
      )
      .all((await published.json()).resourceId as string)
      .map((r) => r.name);
    expect(bound).toEqual(["local", "onprem"]);
  });

  test("an API published on one gateway is invisible to the other", async () => {
    const alice = await cp.login("alice");
    await addOnPrem(alice);
    const pavel = await cp.login("pavel");

    const published = await publishOn(pavel, "cloud-only", ["local"]);
    expect(published.status).toBe(202);
    runOperations(cp.app);

    const targets = cp.app.db
      .query<{ id: string; name: string }, [string]>(
        "SELECT id, name FROM target WHERE environment = ?",
      )
      .all("dev");
    const local = targets.find((t) => t.name === "local")!;
    const onprem = targets.find((t) => t.name === "onprem")!;

    const path = "/it/solution/cloud-only/v1";
    const onLocal = buildConfig(cp.app.db, cp.app.kek, "dev", cp.app.config.integrations, local.id);
    const onOnprem = buildConfig(cp.app.db, cp.app.kek, "dev", cp.app.config.integrations, onprem.id);
    expect(onLocal.routes.map((r) => r.basePath)).toContain(path);
    expect(onOnprem.routes.map((r) => r.basePath)).not.toContain(path);
    // Two gateways serving different route sets are two different documents, and the digest is
    // what a replica compares against — so they must not collide.
    expect(onLocal.digest).not.toBe(onOnprem.digest);
  });

  test("publishing on no gateway at all is refused", async () => {
    const pavel = await cp.login("pavel");
    const response = await publishOn(pavel, "nowhere", []);
    expect(response.status).toBe(400);
    expect((await response.json()).detail).toContain("at least one gateway");
  });

  test("a gateway this environment does not have is refused by name", async () => {
    const pavel = await cp.login("pavel");
    const response = await publishOn(pavel, "elsewhere", ["onprem"]);
    expect(response.status).toBe(400);
    expect((await response.json()).detail).toContain('no gateway named "onprem"');
  });

  test("a configure that says nothing about gateways leaves the API where it is answering", async () => {
    const alice = await cp.login("alice");
    await addOnPrem(alice);
    const pavel = await cp.login("pavel");
    const published = await publishOn(pavel, "stays-put", ["onprem"]);
    expect(published.status).toBe(202);
    const resourceId = (await published.json()).resourceId as string;
    runOperations(cp.app);

    const changed = await configure(pavel, resourceId, {
      environment: "dev",
      description: "a change about something else",
    });
    expect(changed.status).toBe(202);
    runOperations(cp.app);

    const bound = cp.app.db
      .query<{ name: string }, [string]>(
        `SELECT t.name FROM route_gateway rg JOIN target t ON t.id = rg.target_id
          WHERE rg.resource_id = ?`,
      )
      .all(resourceId)
      .map((r) => r.name);
    expect(bound).toEqual(["onprem"]);
  });
});

describe("what the portal shows", () => {
  test("every address of every gateway an API is on, badged", async () => {
    const alice = await cp.login("alice");
    const api = await publishApi(cp, { backendUrl: backend.url, subscribe: false });
    await addOnPrem(alice);

    // Published before `onprem` existed, so it is on `local` only until somebody says otherwise.
    const { publishedUrlsFor } = await import("../control-plane/src/api/fleet.ts");
    expect(publishedUrlsFor(cp.app.db, api.resourceId, "dev")).toEqual([
      {
        gateway: "local",
        label: "Workstation",
        network: "internet",
        url: `http://127.0.0.1:8081${api.basePath}`,
      },
    ]);

    const pavel = await cp.login("pavel");
    const moved = await configure(pavel, api.resourceId, {
      environment: "dev",
      gateways: ["local", "onprem"],
    });
    expect(moved.status).toBe(202);
    runOperations(cp.app);

    expect(
      publishedUrlsFor(cp.app.db, api.resourceId, "dev").map((u) => `${u.network} ${u.url}`),
      // Grouped by category — managed, then on-premise, then everything else — so the list reads
      // the same way on every screen. The seeded workstation gateway is `other`, so it comes last.
    ).toEqual([
      `internet https://gw-samb.example${api.basePath}`,
      `intranet https://apigw.internal.example${api.basePath}`,
      `internet http://127.0.0.1:8081${api.basePath}`,
    ]);
  });

  test("health reports each gateway separately", async () => {
    const alice = await cp.login("alice");
    await publishApi(cp, { backendUrl: backend.url, subscribe: false });
    await addOnPrem(alice);

    const health = await (
      await cp.call("GET", "/api/targets/dev/health", { cookie: alice })
    ).json();
    const gateways = health.gateways as Array<Record<string, unknown>>;
    expect(gateways.map((g) => g.name).sort()).toEqual(["local", "onprem"]);
    const onprem = gateways.find((g) => g.name === "onprem")!;
    // Nothing published on it and no replica behind it: not in sync, and neither is the
    // environment holding it.
    expect(onprem.routes).toBe(0);
    expect(onprem.replicas).toBe(0);
    expect(onprem.inSync).toBe(false);
    expect(health.inSync).toBe(false);
  });
});

describe("replicas belong to a gateway", () => {
  test("with two gateways, minting a token must say which", async () => {
    const alice = await cp.login("alice");
    await addOnPrem(alice);

    const ambiguous = await cp.call("POST", "/api/targets/dev/instances", {
      cookie: alice,
      body: { name: "dev-3" },
    });
    expect(ambiguous.status).toBe(400);
    expect((await ambiguous.json()).detail).toContain("say which one this replica belongs to");

    const minted = await cp.call("POST", "/api/targets/dev/instances", {
      cookie: alice,
      body: { name: "dev-3", gateway: "onprem" },
    });
    expect(minted.status).toBe(201);
    expect((await minted.json()).gateway).toBe("onprem");

    const instances = await (
      await cp.call("GET", "/api/targets/dev/instances", { cookie: alice })
    ).json();
    const dev3 = (instances.items as Array<Record<string, unknown>>).find((i) => i.name === "dev-3");
    expect(dev3?.gateway).toBe("onprem");
  });

  test("a replica is served its own gateway's config, not the environment's", async () => {
    const alice = await cp.login("alice");
    const api = await publishApi(cp, { backendUrl: backend.url, subscribe: false });
    await addOnPrem(alice);

    const minted = await (
      await cp.call("POST", "/api/targets/dev/instances", {
        cookie: alice,
        body: { name: "onprem-1", gateway: "onprem" },
      })
    ).json();

    const response = await cp.call("POST", "/api/gateway/poll", {
      headers: { authorization: `Bearer ${minted.token}` },
      body: {
        wireVersion: 4,
        instance: { name: "onprem-1", runId: "r", activeDigest: null, requestsTotal: 0, process: {} },
      },
    });
    const payload = await response.json();
    // The API is published on `local`; this replica belongs to `onprem` and is told about nothing.
    expect(payload.config.routes.map((r: { basePath: string }) => r.basePath)).not.toContain(
      api.basePath,
    );
  });
});

describe("removing a gateway", () => {
  test("is refused while an API is still published on it", async () => {
    const alice = await cp.login("alice");
    await publishApi(cp, { backendUrl: backend.url, subscribe: false });

    // Every seeded replica has to be gone before the route count is even reached.
    for (const instance of cp.instances.filter((i) => i.environment === "dev")) {
      await cp.call("DELETE", `/api/instances/${instance.id}`, { cookie: alice });
    }
    const response = await cp.call("DELETE", "/api/gateways/dev/local", { cookie: alice });
    expect(response.status).toBe(409);
    expect((await response.json()).detail).toContain("still serves 1 API");
  });

  test("an empty one goes quietly", async () => {
    const alice = await cp.login("alice");
    await addOnPrem(alice);
    const response = await cp.call("DELETE", "/api/gateways/dev/onprem", { cookie: alice });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ environment: "dev", name: "onprem", removed: true });
  });
});
