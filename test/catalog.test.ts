import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { makeCp, publishApi, startBackend, type TestCp } from "./helpers.ts";
import { indexRowFor, matchExpression } from "../control-plane/src/search.ts";
import { A2A_PROTOCOL_VERSION } from "../shared/a2a.ts";
import { MCP_PROTOCOL_VERSION } from "../shared/mcp.ts";

/**
 * Goal 6: a marketplace over APIs, MCP servers and A2A agents.
 *
 * The catalog is a read model, so almost every test here is about *what a caller can see* and
 * *what order they see it in*. Those are the two things a marketplace gets wrong: showing somebody
 * an API they cannot subscribe to, and burying the one they searched for under something merely
 * busy.
 */

let cp: TestCp;
let backend: ReturnType<typeof startBackend>;
let seq = 0;

const PETS_SPEC = {
  openapi: "3.0.0",
  info: { title: "Pet inventory", version: "1.0.0", description: "Everything about the pets we hold." },
  paths: {
    "/pets": {
      get: { operationId: "listPets", summary: "List every pet in the shelter", responses: { "200": { description: "ok" } } },
      post: { operationId: "addPet", summary: "Register a new pet", responses: { "200": { description: "ok" } } },
    },
  },
};

const ORDERS_SPEC = {
  openapi: "3.0.0",
  info: { title: "Order book", version: "2.0.0", description: "Placing and tracking orders." },
  paths: {
    "/orders": {
      get: { operationId: "listOrders", summary: "List orders", responses: { "200": { description: "ok" } } },
    },
  },
};

beforeEach(() => {
  cp = makeCp();
  backend = startBackend();
});
afterEach(() => {
  backend.stop();
  cp.close();
});

async function catalog(cookie: string, query = ""): Promise<Record<string, unknown>> {
  const response = await cp.call("GET", `/api/catalog${query}`, { cookie });
  if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
  return (await response.json()) as Record<string, unknown>;
}

function ids(payload: Record<string, unknown>): string[] {
  return (payload.items as Array<{ id: string }>).map((item) => item.id);
}

function names(payload: Record<string, unknown>): string[] {
  return (payload.items as Array<{ name: string }>).map((item) => item.name);
}

/** Sets the marketing metadata the way the UI does: read the ETag, then PATCH. */
async function decorate(cookie: string, resourceId: string, body: Record<string, unknown>) {
  const current = await cp.call("GET", `/api/resources/${resourceId}`, { cookie });
  const response = await cp.call("PATCH", `/api/resources/${resourceId}`, {
    cookie,
    headers: { "if-match": current.headers.get("etag")! },
    body,
  });
  if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
  return response.json() as Promise<Record<string, unknown>>;
}

// --------------------------------------------------------------------------- the index

describe("the index", () => {
  test("a query is escaped and rebuilt, so FTS5 syntax can never be injected", () => {
    // Every term becomes a quoted word plus its prefix form, and nothing the user typed survives
    // as syntax (plan `[R1-18]`).
    expect(matchExpression("pet inv")).toBe('("pet" OR pet*) AND ("inv" OR inv*)');
    // A quote, a column filter, a NEAR() call and a boolean are all just words. Single letters
    // get no prefix form of their own — `a*` would match most of the estate.
    expect(matchExpression('pets" OR name:x NEAR(a b)')).toBe(
      '("pets" OR pets*) AND ("OR" OR OR*) AND ("name" OR name*) AND "x" AND ' +
        '("NEAR" OR NEAR*) AND "a" AND "b"',
    );
    expect(matchExpression("a")).toBe('"a"');
    expect(matchExpression("   ***   ")).toBeNull();
  });

  test("what is indexed includes the contract, not only the marketing copy", () => {
    const row = indexRowFor({
      id: "res_1",
      name: "pet-inventory",
      summary: "Pets we hold",
      description: null,
      tags_json: '["pets","Shelter"]',
      model: JSON.stringify({
        title: "Pet inventory",
        version: "1.0.0",
        description: "Everything about pets.",
        servers: [],
        operations: [
          { operationId: "listPets", method: "GET", path: "/pets", summary: "List every pet", parameters: [] },
        ],
        mcp: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          serverInfo: { name: "petstore-mcp" },
          capabilities: {},
          tools: [{ name: "getPet", description: "Look one pet up by its id" }],
          resources: [],
          prompts: [],
        },
      }),
    });
    // "the API with the addPet tool" is how people actually search.
    expect(row.operations).toContain("listPets");
    expect(row.operations).toContain("/pets");
    expect(row.operations).toContain("getPet");
    expect(row.operations).toContain("Look one pet up by its id");
    // The model's description fills in when nobody wrote one.
    expect(row.description).toBe("Everything about pets.");
    expect(row.title).toBe("Pet inventory");
  });

  test("an A2A card's skill tags become facets, because they were meant to be", () => {
    const row = indexRowFor({
      id: "res_2",
      name: "shelter-agent",
      summary: null,
      description: null,
      tags_json: '["agents"]',
      model: JSON.stringify({
        title: "Shelter agent",
        version: "1.0.0",
        servers: [],
        operations: [],
        a2a: {
          protocolVersion: A2A_PROTOCOL_VERSION,
          name: "Shelter agent",
          version: "1.0.0",
          originUrl: "http://agent.invalid",
          capabilities: {},
          defaultInputModes: [],
          defaultOutputModes: [],
          skills: [
            { id: "pet-lookup", name: "Pet lookup", description: "Finds a pet", tags: ["pets", "lookup"] },
          ],
        },
      }),
    });
    expect(row.tags.split(" ").sort()).toEqual(["agents", "lookup", "pets"]);
    expect(row.operations).toContain("Pet lookup");
  });
});

// --------------------------------------------------------------------------- listings

describe("what a caller can see", () => {
  test("a published API is visible to everybody; an unpublished one only to its owners", async () => {
    const clara = await cp.login("clara");
    const published = await publishApi(cp, {
      backendUrl: backend.url,
      basePath: `/c-${++seq}`,
      spec: PETS_SPEC,
      name: "pet-inventory",
    });
    // Created but never released: it has a route and a binding and no converged release.
    const draft = await (
      await cp.call("POST", "/api/resources", {
        cookie: published.pavel,
        body: { kind: "rest", name: "secret-draft", teamId: "team_platform", apiVersion: "v1" },
      })
    ).json();

    const asConsumer = await catalog(clara);
    expect(ids(asConsumer)).toContain(published.resourceId);
    expect(ids(asConsumer)).not.toContain(draft.id);

    const asOwner = await catalog(published.pavel);
    expect(ids(asOwner)).toContain(draft.id);
    // Badged, so an owner is never confused about why nobody else can find it.
    const card = (asOwner.items as Array<{ id: string; unpublished: boolean }>).find(
      (item) => item.id === draft.id,
    );
    expect(card!.unpublished).toBe(true);
  });

  test("unlisted is hidden from everybody but its owners, published or not", async () => {
    const clara = await cp.login("clara");
    const api = await publishApi(cp, {
      backendUrl: backend.url,
      basePath: `/c-${++seq}`,
      spec: PETS_SPEC,
      name: "internal-tool",
    });
    expect(ids(await catalog(clara))).toContain(api.resourceId);

    await decorate(api.pavel, api.resourceId, { visibility: "unlisted" });
    expect(ids(await catalog(clara))).not.toContain(api.resourceId);
    expect(ids(await catalog(api.pavel))).toContain(api.resourceId);

    // And the detail page agrees with the list, rather than being a back door into it.
    const detail = await cp.call(`GET`, `/api/catalog/${api.resourceId}`, { cookie: clara });
    expect(detail.status).toBe(404);
    expect((await cp.call("GET", `/api/catalog/${api.resourceId}`, { cookie: api.pavel })).status).toBe(200);
  });

  test("a card carries what a consumer decides from", async () => {
    const api = await publishApi(cp, {
      backendUrl: backend.url,
      basePath: `/c-${++seq}`,
      spec: PETS_SPEC,
      name: "pet-inventory",
    });
    await decorate(api.pavel, api.resourceId, {
      summary: "Everything about the pets we hold",
      tags: ["Pets", "shelter", "pets"],
      icon: "🐾",
    });

    const payload = await catalog(api.clara, "?q=pet-inventory");
    const card = (payload.items as Array<Record<string, unknown>>).find(
      (item) => item.id === api.resourceId,
    )!;
    expect(card.kind).toBe("rest");
    expect(card.title).toBe("Pet inventory");
    expect(card.apiVersion).toBe("v1");
    expect(card.icon).toBe("🐾");
    expect(card.summary).toBe("Everything about the pets we hold");
    // Normalised on write: "Pets" and "pets" are one tag, not two facets that split the results.
    expect(card.tags).toEqual(expect.arrayContaining(["pets", "shelter"]));
    expect((card.tags as string[]).length).toBe(2);
    expect(card.environments).toEqual(["dev"]);
    expect(card.unpublished).toBe(false);
    expect(card.operationCount).toBe(2);
    // Clara subscribed through `publishApi`, so she already holds a key for it `[R2-12]`.
    expect(card.subscriberCount).toBe(1);
    expect(card.subscribed).toBe(true);
    expect((card.products as Array<{ name: string }>)[0]!.name).toBe("pet-inventory-product");
  });

  test("the same card seen by someone who does not subscribe says so", async () => {
    const api = await publishApi(cp, {
      backendUrl: backend.url,
      basePath: `/c-${++seq}`,
      spec: PETS_SPEC,
      name: "pet-inventory",
    });
    const payload = await catalog(api.pavel, "?q=pet-inventory");
    const card = (payload.items as Array<Record<string, unknown>>).find(
      (item) => item.id === api.resourceId,
    )!;
    // One subscriber in the estate, none of them Pavel's.
    expect(card.subscriberCount).toBe(1);
    expect(card.subscribed).toBe(false);
  });
});

// --------------------------------------------------------------------------- search and sort

describe("search, facets and sort", () => {
  async function estate() {
    const pets = await publishApi(cp, {
      backendUrl: backend.url,
      basePath: `/c-${++seq}`,
      spec: PETS_SPEC,
      name: "pet-inventory",
    });
    const orders = await publishApi(cp, {
      backendUrl: backend.url,
      basePath: `/c-${++seq}`,
      spec: ORDERS_SPEC,
      name: "order-book",
      subscribe: false,
    });
    await decorate(pets.pavel, pets.resourceId, { tags: ["pets", "shelter"], summary: "Pets we hold" });
    await decorate(orders.pavel, orders.resourceId, { tags: ["orders"], summary: "Orders we take" });
    return { pets, orders };
  }

  test("a name match outranks a mention buried in an operation summary", async () => {
    const { pets, orders } = await estate();
    // "orders" is the other API's name and appears in this one's operation summaries.
    const payload = await catalog(pets.pavel, "?q=order");
    expect(ids(payload)[0]).toBe(orders.resourceId);
    expect(ids(payload)).toContain(orders.resourceId);
    void pets;
  });

  test("search-as-you-type finds a listing from a prefix", async () => {
    const { pets } = await estate();
    expect(ids(await catalog(pets.pavel, "?q=inv"))).toContain(pets.resourceId);
    expect(ids(await catalog(pets.pavel, "?q=pet%20inv"))).toContain(pets.resourceId);
  });

  test("an operation name is searchable, which is how people actually look", async () => {
    const { pets } = await estate();
    const payload = await catalog(pets.pavel, "?q=addPet");
    expect(ids(payload)).toEqual([pets.resourceId]);
  });

  test("a query that matches nothing returns nothing rather than everything", async () => {
    const { pets } = await estate();
    const payload = await catalog(pets.pavel, "?q=zzzznotathing");
    expect(payload.items).toEqual([]);
    expect(payload.total).toBe(0);

    // And punctuation alone is a query, not an absent one.
    const punctuation = await catalog(pets.pavel, "?q=%2A%2A%2A");
    expect(punctuation.items).toEqual([]);
  });

  test("tag and kind filter, and the facets say what there is to filter by", async () => {
    const { pets, orders } = await estate();
    expect(ids(await catalog(pets.pavel, "?tag=pets"))).toEqual([pets.resourceId]);
    expect(ids(await catalog(pets.pavel, "?tag=orders"))).toEqual([orders.resourceId]);
    expect(ids(await catalog(pets.pavel, "?tag=pets&q=inventory"))).toEqual([pets.resourceId]);
    expect(ids(await catalog(pets.pavel, "?kind=soap"))).toEqual([]);

    const facets = (await (
      await cp.call("GET", "/api/catalog/facets", { cookie: pets.pavel })
    ).json()) as {
      kinds: Array<{ value: string; count: number }>;
      tags: Array<{ value: string; count: number }>;
      environments: Array<{ value: string; count: number }>;
    };
    expect(facets.kinds).toEqual([{ value: "rest", count: 2 }]);
    expect(facets.tags.map((entry) => entry.value).sort()).toEqual(["orders", "pets", "shelter"]);
    expect(facets.environments).toEqual([{ value: "dev", count: 2 }]);
  });

  test("the environment facet counts what the caller can see, not what exists", async () => {
    const clara = await cp.login("clara");
    const { pets, orders } = await estate();
    const facetsFor = async (cookie: string) =>
      (await (await cp.call("GET", "/api/catalog/facets", { cookie })).json()) as {
        environments: Array<{ value: string; count: number }>;
        total: number;
        truncated: boolean;
      };

    expect((await facetsFor(clara)).environments).toEqual([{ value: "dev", count: 2 }]);

    // Hiding one from the catalog has to take its release out of the count too. Counted straight
    // off `release`, the number would stay at 2 and then contradict `?environment=dev`, which
    // returns one — and would tell a consumer how much they are not being shown.
    await decorate(pets.pavel, pets.resourceId, { visibility: "unlisted" });
    expect((await facetsFor(clara)).environments).toEqual([{ value: "dev", count: 1 }]);
    expect(ids(await catalog(clara, "?environment=dev"))).toEqual([orders.resourceId]);

    // Its owner still sees both, and nothing here is truncated.
    const owner = await facetsFor(pets.pavel);
    expect(owner.environments).toEqual([{ value: "dev", count: 2 }]);
    expect(owner.truncated).toBe(false);
  });

  test("an unknown sort or kind is refused rather than ignored", async () => {
    const cookie = await cp.login("pavel");
    expect((await cp.call("GET", "/api/catalog?sort=whatever", { cookie })).status).toBe(400);
    expect((await cp.call("GET", "/api/catalog?kind=grpc", { cookie })).status).toBe(400);
    expect((await cp.call("GET", "/api/catalog?environment=mars", { cookie })).status).toBe(400);
  });

  test("sort=name and sort=newest order by what they say", async () => {
    const { pets, orders } = await estate();
    expect(names(await catalog(pets.pavel, "?sort=name"))).toEqual(["order-book", "pet-inventory"]);
    // `pets` was created first, so newest-first puts `orders` in front.
    const newest = ids(await catalog(pets.pavel, "?sort=newest"));
    expect(newest.indexOf(orders.resourceId)).toBeLessThan(newest.indexOf(pets.resourceId));
  });

  test("sort=popular is subscribers first, whatever the alphabet says", async () => {
    const { pets, orders } = await estate();
    // `pets` has one subscriber from `publishApi`; `orders` has none.
    expect(ids(await catalog(pets.pavel, "?sort=popular"))[0]).toBe(pets.resourceId);
    void orders;
  });

  test("truncation is reported from the rows ranked, not the rows returned", async () => {
    const { pets } = await estate();
    expect((await catalog(pets.pavel, "?sort=name")).truncated).toBe(false);

    // 2000 resources — `RANK_CEILING` exactly — owned by a team nobody is in and released
    // nowhere, so every one of them is fetched as a candidate and then filtered out again. They
    // sort before the real estate, so they fill the window and push it out entirely.
    const now = new Date().toISOString();
    const fill = cp.app.db.transaction(() => {
      cp.app.db.run("INSERT INTO team (id, name) VALUES ('team_nobody', 'nobody')");
      for (let i = 0; i < 2000; i++) {
        cp.app.db.run(
          `INSERT INTO resource (id, kind, name, team_id, api_version, lifecycle, created_at, updated_at)
           VALUES (?, 'rest', ?, 'team_nobody', 'v1', 'active', ?, ?)`,
          [`res_fill${i}`, `aaa-${String(i).padStart(4, "0")}`, now, now],
        );
      }
    });
    fill();

    const crowded = await catalog(pets.pavel, "?sort=name");
    // The regression: the flag used to be read off the surviving count, so a search that ranked
    // its full 2000 and could show none of them reported nothing wrong.
    expect(crowded.items).toEqual([]);
    expect(crowded.total).toBe(0);
    expect(crowded.truncated).toBe(true);
  });

  test("paging is a cursor, and the total is the whole result set", async () => {
    const { pets } = await estate();
    const first = await catalog(pets.pavel, "?sort=name&limit=1");
    expect(first.items).toHaveLength(1);
    expect(first.total).toBe(2);
    expect(first.cursor).toBeTruthy();
    const second = await catalog(pets.pavel, `?sort=name&limit=1&cursor=${first.cursor}`);
    expect(names(second)).toEqual(["pet-inventory"]);
    expect(second.cursor).toBeTruthy();
    const third = await catalog(pets.pavel, `?sort=name&limit=1&cursor=${second.cursor}`);
    expect(third.items).toEqual([]);
  });
});

// --------------------------------------------------------------------------- detail and subscribe

describe("the listing page", () => {
  test("carries the operations, the endpoints and a call that would work", async () => {
    const api = await publishApi(cp, {
      backendUrl: backend.url,
      basePath: "/pets-v1",
      spec: PETS_SPEC,
      name: "pet-inventory",
      policy: {
        rewrite: { stripBasePath: true },
        "auth.subscriptionKey": { in: "header", name: "x-api-key" },
      },
    });
    const detail = (await (
      await cp.call("GET", `/api/catalog/${api.resourceId}`, { cookie: api.clara })
    ).json()) as Record<string, unknown>;

    expect(detail.description).toBe("Everything about the pets we hold.");
    const operations = detail.operations as Array<{ id: string; method: string; path: string }>;
    expect(operations.map((op) => op.id).sort()).toEqual(["addPet", "listPets"]);
    expect(operations.find((op) => op.id === "listPets")!.method).toBe("GET");

    const endpoints = detail.endpoints as Array<{
      environment: string;
      host: string;
      basePath: string;
      live: boolean;
    }>;
    expect(endpoints).toEqual([{ environment: "dev", host: "*", basePath: "/pets-v1", live: true }]);

    // The example carries the header this route actually requires. One that named the wrong
    // header would fail in a way that looks like the platform is broken.
    const example = detail.example as { environment: string; text: string };
    expect(example.environment).toBe("dev");
    expect(example.text).toContain("/pets-v1/pets");
    expect(example.text).toContain("-H 'x-api-key: $SUBSCRIPTION_KEY'");

    // And it is the operation that can actually be pasted. `addPet` is declared first in this
    // document, and a POST with no body is exactly what blocking validation refuses — so an
    // example built from "the first operation" would be a call the page promises works and which
    // returns 400.
    expect(example.text).toContain("curl -X GET");
    expect(example.text).not.toContain("addPet");

    expect(detail.versions).toEqual([
      { id: api.resourceId, api_version: "v1", lifecycle: "active" },
    ]);
  });

  test("an MCP listing shows tools with their input schemas, not REST paths", async () => {
    const pavel = await cp.login("pavel");
    const created = await (
      await cp.call("POST", "/api/resources", {
        cookie: pavel,
        body: { kind: "mcp", name: "petstore-mcp", teamId: "team_platform", apiVersion: "v1" },
      })
    ).json();
    await cp.call("POST", `/api/resources/${created.id}/revisions`, {
      cookie: pavel,
      body: {
        spec: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          serverInfo: { name: "petstore-mcp", version: "1.0.0" },
          capabilities: { tools: {} },
          tools: [
            {
              name: "getPet",
              description: "Look one pet up by its id",
              inputSchema: { type: "object", required: ["petId"], properties: { petId: { type: "integer" } } },
            },
          ],
        },
      },
    });

    const detail = (await (
      await cp.call("GET", `/api/catalog/${created.id}`, { cookie: pavel })
    ).json()) as Record<string, unknown>;
    expect(detail.kind).toBe("mcp");
    // The count a consumer cares about is tools, not the protocol methods that come with every
    // MCP server.
    expect(detail.operationCount).toBe(1);
    const tools = detail.operations as Array<{ id: string; inputSchema: Record<string, unknown> }>;
    expect(tools).toHaveLength(1);
    expect(tools[0]!.id).toBe("tools/call:getPet");
    expect(tools[0]!.inputSchema).toEqual({
      type: "object",
      required: ["petId"],
      properties: { petId: { type: "integer" } },
    });
    expect((detail.mcp as { protocolVersion: string }).protocolVersion).toBe(MCP_PROTOCOL_VERSION);
    // Searchable by the tool's name, which is the only name an MCP server has.
    expect(ids(await catalog(pavel, "?q=getPet"))).toContain(created.id);
  });

  test("subscribing from the catalog ends with a key", async () => {
    const api = await publishApi(cp, {
      backendUrl: backend.url,
      basePath: `/c-${++seq}`,
      spec: PETS_SPEC,
      name: "pet-inventory",
      subscribe: false,
    });
    const clara = await cp.login("clara");
    const application = await (
      await cp.call("POST", "/api/applications", {
        cookie: clara,
        body: { name: "shelter-app", teamId: "team_orders" },
      })
    ).json();

    const response = await cp.call("POST", `/api/catalog/${api.productId}/subscribe`, {
      cookie: clara,
      body: { applicationId: application.id, environment: "dev" },
    });
    expect(response.status).toBe(201);
    const subscription = await response.json();
    expect(subscription.primaryKey).toMatch(/^sk_dev_/);
    // Shown once, never again in a list.
    expect(response.headers.get("cache-control")).toBe("no-store");

    // And the card now says so, for this caller.
    const payload = await catalog(clara, "?q=pet-inventory");
    const card = (payload.items as Array<Record<string, unknown>>).find(
      (item) => item.id === api.resourceId,
    )!;
    expect(card.subscribed).toBe(true);
    expect(card.subscriberCount).toBe(1);
  });

  test("subscribing to somebody else's application is refused through this door too", async () => {
    const api = await publishApi(cp, {
      backendUrl: backend.url,
      basePath: `/c-${++seq}`,
      spec: PETS_SPEC,
      name: "pet-inventory",
      subscribe: false,
    });
    const clara = await cp.login("clara");
    const application = await (
      await cp.call("POST", "/api/applications", {
        cookie: clara,
        body: { name: "shelter-app", teamId: "team_orders" },
      })
    ).json();
    // Pavel is not in team_orders, so he may not subscribe Clara's application.
    const response = await cp.call("POST", `/api/catalog/${api.productId}/subscribe`, {
      cookie: api.pavel,
      body: { applicationId: application.id, environment: "dev" },
    });
    expect(response.status).toBe(403);
  });

  test("usage answers 'am I about to be cut off' from the aggregate", async () => {
    const api = await publishApi(cp, {
      backendUrl: backend.url,
      basePath: `/c-${++seq}`,
      spec: PETS_SPEC,
      name: "pet-inventory",
    });
    // One instance reports having spent part of a quota window.
    const windowStart = new Date(Math.floor(Date.now() / 3_600_000) * 3_600_000).toISOString();
    cp.app.quota.accept("dev", [
      {
        subscriptionId: api.subscriptionId!,
        scopeKind: "route",
        scopeId: api.resourceId,
        periodSec: 3600,
        windowStart,
        count: 40,
      },
    ]);
    cp.app.quota.flush();

    const usage = (await (
      await cp.call("GET", `/api/subscriptions/${api.subscriptionId}/usage`, { cookie: api.clara })
    ).json()) as Record<string, unknown>;
    const windows = usage.windows as Array<{ used: number; resetsInSec: number; scopeKind: string }>;
    expect(windows).toHaveLength(1);
    expect(windows[0]!.used).toBe(40);
    expect(windows[0]!.scopeKind).toBe("route");
    expect(windows[0]!.resetsInSec).toBeGreaterThan(0);
    expect(usage.note).toContain("not billing records");

    // Somebody else's subscription is not found rather than forbidden: whether it exists is not
    // their business either.
    expect(
      (await cp.call("GET", `/api/subscriptions/${api.subscriptionId}/usage`, { cookie: api.pavel }))
        .status,
    ).toBe(404);
  });
});
