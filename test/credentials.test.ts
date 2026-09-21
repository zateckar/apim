import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { decrypt } from "../control-plane/src/crypto.ts";
import { credentialVault } from "../control-plane/src/credentials.ts";
import { validateDocument } from "../shared/policy.ts";
import {
  makeCp,
  makeDp,
  publishApi,
  serveCp,
  startBackend,
  type TestCp,
} from "./helpers.ts";
import type { DataPlane } from "../data-plane/src/server.ts";

/**
 * `app-credentials`: the secrets an application keeps for itself.
 *
 * The properties worth protecting, in the order they would otherwise be lost:
 *
 *  - **A secret written here is never readable again.** Not by the owner, not by an administrator,
 *    not through any endpoint. The only reader is a configuration build.
 *  - **Two applications may each have a credential called `backend`.** The reference carries the
 *    application id for exactly this reason: a flat `references.secrets` keyed by the reference
 *    string would otherwise collide them, and one API would present the other's password. This is
 *    the test that would have caught that, and it is the reason the reference looks the way it does.
 *  - **A policy naming a credential pins it in place.** Deleting one under a live route is refused,
 *    because the gateway answers 503 for a reference it cannot resolve.
 *  - **An issuer is still an administrator's.** The two references that resolve to a URL the
 *    gateway fetches cannot be satisfied by an application's own store.
 */

let cp: TestCp;

beforeEach(() => {
  cp = makeCp();
});
afterEach(() => {
  cp.close();
});

async function add(
  cookie: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return cp.call("POST", "/api/credentials", {
    cookie,
    body: { environment: "dev", applicationId: "application_platform", ...body },
  });
}

// --------------------------------------------------------------------------- the store

describe("keeping a credential", () => {
  test("create, list, and the secret never comes back out", async () => {
    const pavel = await cp.login("pavel");
    const created = await add(pavel, {
      name: "orders-backend",
      kind: "basic",
      principal: "alice",
      secret: "s3cret",
      note: "the orders service account",
    });
    expect(created.status).toBe(201);
    const row = await created.json();
    // The reference is composed by the server, so nothing has to type one.
    expect(row.ref).toBe("app:application_platform:orders-backend");
    expect(row.principal).toBe("alice");
    expect(JSON.stringify(row)).not.toContain("s3cret");

    const listed = await (
      await cp.call("GET", "/api/credentials?environment=dev", { cookie: pavel })
    ).json();
    expect(listed.items).toHaveLength(1);
    expect(listed.items[0]!.usedBy).toEqual([]);
    expect(JSON.stringify(listed)).not.toContain("s3cret");

    // Encrypted at rest with the KEK, and it is the real secret: a build decrypts it.
    const stored = cp.app.db
      .query<{ secret_enc: string }, []>("SELECT secret_enc FROM app_credential")
      .get()!;
    expect(stored.secret_enc).not.toContain("s3cret");
    expect(decrypt(stored.secret_enc, cp.app.kek)).toBe("s3cret");
  });

  test("only the owning application, or an administrator, may add one", async () => {
    const clara = await cp.login("clara");
    const refused = await add(clara, { name: "not-mine", kind: "secret", secret: "x" });
    expect(refused.status).toBe(403);
  });

  test("a blank secret is refused, because a credential that authenticates with nothing looks configured", async () => {
    const pavel = await cp.login("pavel");
    const refused = await add(pavel, { name: "empty", kind: "basic", principal: "alice", secret: "" });
    expect(refused.status).toBe(400);
    expect((await refused.json()).detail).toContain("secret");
  });

  test("a colon in the username is refused rather than escaped", async () => {
    const pavel = await cp.login("pavel");
    // `user:pass` is composed with a colon, so a username carrying one would authenticate as
    // somebody else while looking saved.
    const refused = await add(pavel, {
      name: "colonised",
      kind: "basic",
      principal: "ali:ce",
      secret: "s3cret",
    });
    expect(refused.status).toBe(400);
    expect((await refused.json()).detail).toContain("colon");
  });

  test("two credentials of one name in one environment is a conflict, in two environments is not", async () => {
    const pavel = await cp.login("pavel");
    expect((await add(pavel, { name: "backend", kind: "secret", secret: "a" })).status).toBe(201);
    expect((await add(pavel, { name: "backend", kind: "secret", secret: "b" })).status).toBe(409);
    expect(
      (await add(pavel, { environment: "test", name: "backend", kind: "secret", secret: "c" })).status,
    ).toBe(201);
  });

  test("rotation replaces the secret under the same reference", async () => {
    const pavel = await cp.login("pavel");
    const row = await (
      await add(pavel, { name: "rotating", kind: "basic", principal: "alice", secret: "old" })
    ).json();

    const rotated = await cp.call("POST", `/api/credentials/${row.id}/rotate`, {
      cookie: pavel,
      body: { secret: "new" },
    });
    expect(rotated.status).toBe(200);
    const after = await rotated.json();
    expect(after.ref).toBe(row.ref);
    // The username is not restated to change the password.
    expect(after.principal).toBe("alice");
    expect(after.rotatedAt).not.toBeNull();

    const stored = cp.app.db
      .query<{ secret_enc: string }, [string]>("SELECT secret_enc FROM app_credential WHERE id = ?")
      .get(row.id)!;
    expect(decrypt(stored.secret_enc, cp.app.kek)).toBe("new");
  });
});

// --------------------------------------------------------------------------- resolution

describe("resolving a reference", () => {
  test("each kind resolves to the shape its consumer needs, and an hmac key is not a plain secret", async () => {
    const pavel = await cp.login("pavel");
    await add(pavel, { name: "pair", kind: "basic", principal: "alice", secret: "s3cret" });
    await add(pavel, { name: "apikey", kind: "secret", secret: "k-123" });
    await add(pavel, { name: "signer", kind: "hmac", principal: "app-42", secret: "key-99" });

    const vault = credentialVault(cp.app.db, cp.app.kek, "dev");
    expect(vault.secret("app:application_platform:pair")).toBe("alice:s3cret");
    expect(vault.secret("app:application_platform:apikey")).toBe("k-123");
    expect(vault.hmac("app:application_platform:signer")).toEqual({
      appId: "app-42",
      appKey: "key-99",
    });
    // Presenting a signing key as a bearer value is not what it signs, so it does not answer here.
    expect(vault.secret("app:application_platform:signer")).toBeNull();
    // Nor does a credential in another environment, or a name nothing answers to.
    expect(vault.secret("app:application_platform:missing")).toBeNull();
    expect(credentialVault(cp.app.db, cp.app.kek, "prod").secret("app:application_platform:pair")).toBeNull();
    // A plain integrations-file name is not this vault's business; it says so rather than guessing.
    expect(vault.secret("orders-basic")).toBeNull();
  });

  test("two applications may each have a credential called backend, and they do not collide", async () => {
    const pavel = await cp.login("pavel");
    const clara = await cp.login("clara");
    await add(pavel, { name: "backend", kind: "secret", secret: "platform-secret" });
    await add(clara, {
      applicationId: "application_orders",
      name: "backend",
      kind: "secret",
      secret: "orders-secret",
    });

    const vault = credentialVault(cp.app.db, cp.app.kek, "dev");
    expect(vault.secret("app:application_platform:backend")).toBe("platform-secret");
    expect(vault.secret("app:application_orders:backend")).toBe("orders-secret");
  });

  test("a secret-only reference accepts both forms; an issuer accepts only the administrator's", () => {
    expect(
      validateDocument(
        { "auth.basic": { credentialRef: "app:application_platform:pair", realm: "api" } },
        { kind: "rest" },
      ),
    ).toEqual([]);
    expect(
      validateDocument({ "auth.basic": { credentialRef: "orders-basic", realm: "api" } }, { kind: "rest" }),
    ).toEqual([]);

    // An issuer resolves to a JWKS URL the gateway fetches, so an application cannot register one
    // and the reference form that would name one is refused before it is ever looked up.
    const refused = validateDocument(
      {
        "auth.jwt": {
          issuerRef: "app:application_platform:pretend-issuer",
          headerName: "Authorization",
          scheme: "Bearer",
          audience: [],
        },
      },
        { kind: "rest" },
      );
    expect(refused.join(" ")).toContain("auth.jwt.issuerRef");
    expect(refused.join(" ")).toContain("INTEGRATIONS_FILE");
  });
});

// --------------------------------------------------------------------------- end to end

describe("a route using an application's own credential", () => {
  test("the gateway checks against it, and the document carries the reference rather than the value", async () => {
    const pavel = await cp.login("pavel");
    await add(pavel, { name: "orders-basic", kind: "basic", principal: "alice", secret: "s3cret" });

    const backend = startBackend(() => Response.json({ ok: true }));
    const cpServer = serveCp(cp);
    let dp: DataPlane | null = null;
    try {
      const api = await publishApi(cp, {
        backendUrl: backend.url,
        policy: {
          rewrite: { stripBasePath: true },
          "auth.basic": {
            credentialRef: "app:application_platform:orders-basic",
            realm: "orders",
          },
        },
      });
      dp = makeDp(cpServer.url, cp.token, cp.dir, { name: "cred-e2e" });
      await dp.start();
      if (!dp.client.table) throw new Error(`did not activate: ${dp.client.activationBlocked}`);

      const call = (authorization?: string) =>
        dp!.fetchHttp(
          new Request(`http://gw${api.basePath}/pet`, {
            headers: authorization ? { authorization } : {},
          }),
          "127.0.0.1",
        );

      expect((await call()).status).toBe(401);
      expect((await call(`Basic ${btoa("alice:wrong")}`)).status).toBe(401);
      expect((await call(`Basic ${btoa("alice:s3cret")}`)).status).toBe(200);

      // The policy carries the name; the document carries a hash; neither carries the password.
      const table = JSON.stringify(dp.client.table);
      expect(table).toContain("app:application_platform:orders-basic");
      expect(table).not.toContain("s3cret");

      // And it cannot be deleted from under the route that depends on it.
      const id = cp.app.db
        .query<{ id: string }, []>("SELECT id FROM app_credential")
        .get()!.id;
      const refused = await cp.call("DELETE", `/api/credentials/${id}`, { cookie: pavel });
      expect(refused.status).toBe(409);
      const detail = (await refused.json()).detail as string;
      expect(detail).toContain("auth.basic");
      expect(detail).toContain("change those policies first");
    } finally {
      dp?.stop();
      cpServer.stop();
      backend.stop();
    }
  });

  test("a credential nothing names can be deleted", async () => {
    const pavel = await cp.login("pavel");
    const row = await (await add(pavel, { name: "unused", kind: "secret", secret: "x" })).json();
    expect((await cp.call("DELETE", `/api/credentials/${row.id}`, { cookie: pavel })).status).toBe(204);
    const listed = await (
      await cp.call("GET", "/api/credentials?environment=dev", { cookie: pavel })
    ).json();
    expect(listed.items).toEqual([]);
  });
});
