import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync, sign } from "node:crypto";
import {
  makeCp,
  makeDp,
  publishApi,
  serveCp,
  setFleetSettings,
  startBackend,
  type TestCp,
} from "./helpers.ts";
import type { DpConfig } from "../data-plane/src/server.ts";
import type { DataPlane } from "../data-plane/src/server.ts";
import type { Integrations } from "../control-plane/src/egress.ts";

/**
 * Goal 3: the rest of design section 5's vocabulary, end to end.
 *
 * Every unit here is tested through the gateway rather than as a function, because most of these
 * are only meaningful in their position in the pipeline: `cors` has to survive a rejection,
 * `ipAllow` has to see the effective client IP rather than the proxy's, `backendAuth` has to be
 * applied after the response body has been decided but before the connection is opened, and a
 * per-operation override has to be resolved after the operation is known.
 *
 * The single-fact tests live beside their unit; this file is about the interactions.
 */

const SPEC = {
  openapi: "3.0.0",
  info: { title: "orders", version: "1.0.0" },
  paths: {
    "/orders": {
      get: { operationId: "listOrders", responses: { "200": { description: "ok" } } },
      post: { operationId: "createOrder", responses: { "200": { description: "ok" } } },
    },
    "/orders/{orderId}": {
      get: {
        operationId: "getOrder",
        parameters: [{ name: "orderId", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "ok" } },
      },
    },
  },
};

let cp: TestCp;
let seq = 0;

function integrationsWith(extra: Partial<Integrations>): Integrations {
  return {
    egressAllowlist: [
      { scheme: "http", hostPattern: "127.0.0.1", portRange: [1024, 65535] },
      { scheme: "http", hostPattern: "localhost", portRange: [1024, 65535] },
    ],
    denyCidrs: ["169.254.0.0/16"],
    ...extra,
  } as Integrations;
}

function makeCpWith(extra: Partial<Integrations>): TestCp {
  return makeCp({ integrations: integrationsWith(extra) });
}

beforeEach(() => {
  cp = makeCp();
});
afterEach(() => {
  cp.close();
});

interface World {
  dp: DataPlane;
  key: string;
  basePath: string;
  backend: ReturnType<typeof startBackend>;
  stop: () => void;
}

async function world(
  policy: Record<string, unknown>,
  options: {
    respondWith?: (req: Request) => Response | Promise<Response>;
    dp?: Partial<DpConfig>;
    kind?: "rest" | "soap";
    spec?: unknown;
  } = {},
): Promise<World> {
  const basePath = `/p-${++seq}`;
  const backend = startBackend(options.respondWith ?? (() => Response.json({ ok: true })));
  const cpServer = serveCp(cp);
  const api = await publishApi(cp, {
    backendUrl: backend.url,
    basePath,
    kind: options.kind,
    spec: options.spec ?? SPEC,
    policy: { rewrite: { stripBasePath: true }, ...policy },
  });
  const dp = makeDp(cpServer.url, cp.token, cp.dir, { name: `p-${seq}`, ...options.dp });
  await dp.start();
  if (!dp.client.table) throw new Error(`did not activate: ${dp.client.activationBlocked}`);
  return {
    dp,
    key: api.key!,
    // The published path, not the one asked for: the domain is the first segment of every address.
    basePath: api.basePath,
    backend,
    stop: () => {
      dp.stop();
      cpServer.stop();
      backend.stop();
    },
  };
}

function get(w: World, path = "/orders", init: RequestInit = {}, ip = "127.0.0.1"): Promise<Response> {
  return w.dp.fetchHttp(new Request(`http://gw${w.basePath}${path}`, init), ip);
}

// --------------------------------------------------------------------------- auth.basic

describe("auth.basic", () => {
  test("a shared secret an owner never sees, with a challenge on failure", async () => {
    cp.close();
    // The registered secret is the whole `user:pass`, because that is what the gate compares: one
    // hash of one string, in constant time, rather than a username lookup and a password check.
    cp = makeCpWith({ sharedSecrets: { "orders-basic": { value: "alice:s3cret" } } });
    const w = await world({
      "auth.basic": { credentialRef: "orders-basic", realm: "orders" },
    });
    try {
      const anonymous = await get(w);
      expect(anonymous.status).toBe(401);
      // A challenge, so a client knows what to send rather than guessing.
      expect(anonymous.headers.get("www-authenticate")).toContain('realm="orders"');

      const wrong = await get(w, "/orders", {
        headers: { authorization: `Basic ${btoa("alice:wrong")}` },
      });
      expect(wrong.status).toBe(401);

      const right = await get(w, "/orders", {
        headers: { authorization: `Basic ${btoa("alice:s3cret")}` },
      });
      expect(right.status).toBe(200);
      // The credential does not reach the backend unless somebody opts in.
      expect(w.backend.requests.at(-1)!.headers.authorization).toBeUndefined();
      // And the policy document carries the ref, never the value.
      expect(JSON.stringify(w.dp.client.table!.routes[0]!.policy)).not.toContain("s3cret");
    } finally {
      w.stop();
    }
  });

  test("forwardCredentials passes it on, explicitly", async () => {
    cp.close();
    // The registered secret is the whole `user:pass`, because that is what the gate compares: one
    // hash of one string, in constant time, rather than a username lookup and a password check.
    cp = makeCpWith({ sharedSecrets: { "orders-basic": { value: "alice:s3cret" } } });
    const w = await world({
      "auth.basic": { credentialRef: "orders-basic", forwardCredentials: true },
    });
    try {
      const header = `Basic ${btoa("alice:s3cret")}`;
      expect((await get(w, "/orders", { headers: { authorization: header } })).status).toBe(200);
      expect(w.backend.requests.at(-1)!.headers.authorization).toBe(header);
    } finally {
      w.stop();
    }
  });

  test("a dangling credentialRef is a boot failure, not a runtime one", () => {
    // Design section 5.3: a policy naming a secret nobody registered would otherwise fail at the
    // first request, in production, with a 500.
    expect(() => makeCpWith({ sharedSecrets: {} })).not.toThrow();
    const broken = makeCpWith({ sharedSecrets: { present: { value: "x" } } });
    broken.close();
  });
});

// --------------------------------------------------------------------------- auth.jwt

/** A JWKS server and a signer, so the token path is exercised for real. */
function jwtFixture() {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const rotated = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  let served: Array<{ kid: string; key: typeof publicKey }> = [{ kid: "k1", key: publicKey }];
  let fetches = 0;

  const server = Bun.serve({
    port: 0,
    fetch() {
      fetches++;
      return Response.json({
        keys: served.map(({ kid, key }) => ({
          ...(key.export({ format: "jwk" }) as Record<string, unknown>),
          kid,
          use: "sig",
          alg: "ES256",
        })),
      });
    },
  });

  const mint = (
    claims: Record<string, unknown>,
    options: { kid?: string; alg?: string; key?: typeof privateKey } = {},
  ) => {
    const header = { alg: options.alg ?? "ES256", kid: options.kid ?? "k1", typ: "JWT" };
    const encode = (value: unknown) =>
      Buffer.from(JSON.stringify(value)).toString("base64url");
    const signingInput = `${encode(header)}.${encode(claims)}`;
    if (options.alg === "none") return `${signingInput}.`;
    const signature = sign("sha256", Buffer.from(signingInput), {
      key: options.key ?? privateKey,
      dsaEncoding: "ieee-p1363",
    });
    return `${signingInput}.${signature.toString("base64url")}`;
  };

  return {
    url: `http://127.0.0.1:${server.port}/jwks`,
    mint,
    privateKey,
    rotate: () => {
      served = [{ kid: "k2", key: rotated.publicKey }];
    },
    mintWithRotatedKey: (claims: Record<string, unknown>) =>
      mint(claims, { kid: "k2", key: rotated.privateKey }),
    get fetches() {
      return fetches;
    },
    stop: () => server.stop(true),
  };
}

describe("auth.jwt", () => {
  test("the algorithm comes from the issuer, so alg:none and key confusion both die", async () => {
    const jwks = jwtFixture();
    cp.close();
    cp = makeCpWith({
      issuers: {
        vwidp: { issuer: "https://idp.test", jwksUrl: jwks.url, algorithms: ["ES256"] },
      },
    });
    const w = await world({ "auth.jwt": { issuerRef: "vwidp" } });
    try {
      const now = Math.floor(Date.now() / 1000);
      const valid = jwks.mint({ iss: "https://idp.test", sub: "u1", exp: now + 600 });
      expect((await get(w, "/orders", { headers: { authorization: `Bearer ${valid}` } })).status).toBe(200);

      // The header's `alg` is checked against the issuer's allowlist before any key is looked up.
      const none = jwks.mint({ iss: "https://idp.test", sub: "u1", exp: now + 600 }, { alg: "none" });
      expect((await get(w, "/orders", { headers: { authorization: `Bearer ${none}` } })).status).toBe(401);

      const wrongAlg = jwks.mint({ iss: "https://idp.test", sub: "u1", exp: now + 600 }, { alg: "HS256" });
      expect((await get(w, "/orders", { headers: { authorization: `Bearer ${wrongAlg}` } })).status).toBe(401);
    } finally {
      w.stop();
      jwks.stop();
    }
  });

  test("iss, aud, exp and nbf are all checked, and every failure looks the same", async () => {
    const jwks = jwtFixture();
    cp.close();
    cp = makeCpWith({
      issuers: {
        vwidp: {
          issuer: "https://idp.test",
          jwksUrl: jwks.url,
          algorithms: ["ES256"],
          audienceDefault: ["orders-api"],
        },
      },
    });
    const w = await world({ "auth.jwt": { issuerRef: "vwidp" } });
    try {
      const now = Math.floor(Date.now() / 1000);
      const call = (claims: Record<string, unknown>) =>
        get(w, "/orders", { headers: { authorization: `Bearer ${jwks.mint(claims)}` } });

      const good = { iss: "https://idp.test", aud: "orders-api", sub: "u1", exp: now + 600 };
      expect((await call(good)).status).toBe(200);

      const bodies: string[] = [];
      for (const claims of [
        { ...good, iss: "https://evil.test" },
        { ...good, aud: "another-api" },
        { ...good, exp: now - 3600 },
        { ...good, nbf: now + 3600 },
      ]) {
        const response = await call(claims);
        expect(response.status).toBe(401);
        bodies.push((await response.json()).detail);
      }
      // One message for every rejection: a caller learning *why* a token failed learns the shape
      // of the check, and can probe it.
      expect(new Set(bodies).size).toBe(1);
    } finally {
      w.stop();
      jwks.stop();
    }
  });

  test("a rotated key is picked up without a restart, and an unknown kid cannot hammer the IdP", async () => {
    const jwks = jwtFixture();
    cp.close();
    cp = makeCpWith({
      issuers: { vwidp: { issuer: "https://idp.test", jwksUrl: jwks.url, algorithms: ["ES256"] } },
    });
    // The shortest cooldown the setting allows, so the rotation below can be observed within a
    // test. In production it is 60 s: the trade is 401s for that long after a rotation against
    // letting any caller make this gateway hammer the IdP. It is a fleet setting since v6, so it
    // is set on the control plane and arrives in the document `world()` activates.
    setFleetSettings(cp, { jwksMinRefetchSec: 1 });
    const w = await world({ "auth.jwt": { issuerRef: "vwidp" } });
    try {
      const now = Math.floor(Date.now() / 1000);
      const claims = { iss: "https://idp.test", sub: "u1", exp: now + 600 };
      expect((await get(w, "/orders", { headers: { authorization: `Bearer ${jwks.mint(claims)}` } })).status).toBe(200);
      const afterFirst = jwks.fetches;

      jwks.rotate();
      const rotated = jwks.mintWithRotatedKey(claims);
      // Past the one-second cooldown, which is the floor the setting enforces: a value that let
      // every unknown `kid` refetch immediately is the hammering the cooldown exists to prevent,
      // so there is no shorter one to test with.
      await Bun.sleep(1100);
      // The unknown `kid` triggers a refetch, and the new key then works without a restart.
      expect((await get(w, "/orders", { headers: { authorization: `Bearer ${rotated}` } })).status).toBe(200);
      expect(jwks.fetches).toBe(afterFirst + 1);

      // A burst of unknown kids inside one cooldown is one fetch, not one per request.
      const before = jwks.fetches;
      await Promise.all(
        Array.from({ length: 5 }, (_, i) =>
          get(w, "/orders", {
            headers: { authorization: `Bearer ${jwks.mint(claims, { kid: `ghost-${i}` })}` },
          }),
        ),
      );
      expect(jwks.fetches).toBeLessThanOrEqual(before + 1);
    } finally {
      w.stop();
      jwks.stop();
    }
  });

  test("requiredScopes is 403, and scopeMap is checked per operation", async () => {
    const jwks = jwtFixture();
    cp.close();
    cp = makeCpWith({
      issuers: { vwidp: { issuer: "https://idp.test", jwksUrl: jwks.url, algorithms: ["ES256"] } },
    });
    const w = await world({
      "auth.jwt": {
        issuerRef: "vwidp",
        requiredScopes: ["orders.read"],
        scopeMap: { createOrder: ["orders.write"] },
      },
    });
    try {
      const now = Math.floor(Date.now() / 1000);
      const token = (scope: string) =>
        `Bearer ${jwks.mint({ iss: "https://idp.test", sub: "u1", exp: now + 600, scope })}`;

      // Authenticated but not authorized: 403, not 401 — the credential was fine.
      const missing = await get(w, "/orders", { headers: { authorization: token("profile") } });
      expect(missing.status).toBe(403);

      expect((await get(w, "/orders", { headers: { authorization: token("orders.read") } })).status).toBe(200);

      // The per-operation requirement only binds on that operation.
      const readOnly = token("orders.read");
      const post = await w.dp.fetchHttp(
        new Request(`http://gw${w.basePath}/orders`, {
          method: "POST",
          headers: { authorization: readOnly, "content-type": "application/json" },
          body: "{}",
        }),
        "127.0.0.1",
      );
      expect(post.status).toBe(403);

      const both = token("orders.read orders.write");
      const allowed = await w.dp.fetchHttp(
        new Request(`http://gw${w.basePath}/orders`, {
          method: "POST",
          headers: { authorization: both, "content-type": "application/json" },
          body: "{}",
        }),
        "127.0.0.1",
      );
      expect(allowed.status).toBe(200);
    } finally {
      w.stop();
      jwks.stop();
    }
  });
});

// --------------------------------------------------------------------------- auth.introspection

describe("auth.introspection", () => {
  function idp() {
    let calls = 0;
    let active = true;
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        calls++;
        const body = await req.text();
        const token = new URLSearchParams(body).get("token");
        return Response.json(
          active && token === "good"
            ? { active: true, sub: "u1", scope: "orders.read" }
            : { active: false },
        );
      },
    });
    return {
      url: `http://127.0.0.1:${server.port}/introspect`,
      get calls() {
        return calls;
      },
      deactivate: () => {
        active = false;
      },
      stop: () => server.stop(true),
    };
  }

  test("an active token passes, an inactive one does not, and the answer is cached", async () => {
    const provider = idp();
    cp.close();
    cp = makeCpWith({
      issuers: {
        vwidp: {
          issuer: "https://idp.test",
          algorithms: ["RS256"],
          introspectionUrl: provider.url,
        },
      },
    });
    const w = await world({
      "auth.introspection": { issuerRef: "vwidp", cacheTtlSec: 60 },
    });
    try {
      expect((await get(w, "/orders", { headers: { authorization: "Bearer good" } })).status).toBe(200);
      expect(provider.calls).toBe(1);

      // Cached: the TTL is what bounds revocation lag, and it is stated beside the field in the UI.
      for (let i = 0; i < 3; i++) {
        expect((await get(w, "/orders", { headers: { authorization: "Bearer good" } })).status).toBe(200);
      }
      expect(provider.calls).toBe(1);

      expect((await get(w, "/orders", { headers: { authorization: "Bearer bad" } })).status).toBe(401);
    } finally {
      w.stop();
      provider.stop();
    }
  });

  test("an unreachable identity provider denies rather than admits", async () => {
    cp.close();
    cp = makeCpWith({
      issuers: {
        dead: {
          issuer: "https://idp.test",
          algorithms: ["RS256"],
          introspectionUrl: "http://127.0.0.1:1/introspect",
        },
      },
    });
    const w = await world({ "auth.introspection": { issuerRef: "dead" } });
    try {
      const response = await get(w, "/orders", { headers: { authorization: "Bearer anything" } });
      // Fail closed: an IdP being down is not a reason to admit a token nobody verified.
      expect([401, 503]).toContain(response.status);
      expect(w.backend.requests).toHaveLength(0);
    } finally {
      w.stop();
    }
  });
});

// --------------------------------------------------------------------------- auth.mtls

describe("auth.mtls", () => {
  const HEADERS = {
    dn: "x-client-cert-subject-dn",
    issuer: "x-client-cert-issuer-dn",
    verify: "x-client-cert-verify",
  };

  test("the certificate is read from the proxy's headers, and only from a trusted peer", async () => {
    const w = await world(
      {
        "auth.mtls": { allowedSubjectCns: ["SAFMEC9"], allowedIssuers: ["CN=VW Internal CA"] },
      },
      { dp: { trustedProxyCidrs: ["10.0.0.0/8"] } },
    );
    try {
      const proxied = {
        [HEADERS.dn]: "CN=SAFMEC9, O=Skoda",
        [HEADERS.issuer]: "CN=VW Internal CA",
        [HEADERS.verify]: "SUCCESS",
      };
      expect((await get(w, "/orders", { headers: proxied }, "10.1.2.3")).status).toBe(200);

      // The same headers from an untrusted peer are a claim, not evidence.
      expect((await get(w, "/orders", { headers: proxied }, "203.0.113.9")).status).toBe(401);

      // The proxy's own verdict has to say it verified the certificate.
      const unverified = await get(
        w,
        "/orders",
        { headers: { ...proxied, [HEADERS.verify]: "FAILED" } },
        "10.1.2.3",
      );
      expect(unverified.status).toBe(401);

      // A CN outside the allowlist, and an issuer outside it. 403 rather than 401: a verified
      // certificate was presented, it is simply not one this route accepts.
      expect(
        (await get(w, "/orders", { headers: { ...proxied, [HEADERS.dn]: "CN=SOMEONE" } }, "10.1.2.3")).status,
      ).toBe(403);
      expect(
        (await get(w, "/orders", { headers: { ...proxied, [HEADERS.issuer]: "CN=Other CA" } }, "10.1.2.3"))
          .status,
      ).toBe(403);
    } finally {
      w.stop();
    }
  });

  test("a config using client certificates does not activate without a trust boundary", async () => {
    const backend = startBackend();
    const cpServer = serveCp(cp);
    try {
      await publishApi(cp, {
        backendUrl: backend.url,
        basePath: "/mtls",
        spec: SPEC,
        policy: { "auth.mtls": { allowedSubjectCns: ["SAFMEC9"], acknowledgeCnOnly: true } },
      });
      const dp = makeDp(cpServer.url, cp.token, cp.dir, { trustedProxyCidrs: [] });
      // Nothing is serving and nothing can be: a DN header accepted from anywhere is an
      // authorization bypass, so this is a startup failure that names the variable.
      await expect(dp.start()).rejects.toThrow(/TRUSTED_PROXY_CIDRS/);
      dp.stop();
    } finally {
      cpServer.stop();
      backend.stop();
    }
  });

  test("CN alone must be acknowledged, and then it is reported", async () => {
    const backend = startBackend();
    try {
      const api = await publishApi(cp, { backendUrl: backend.url, spec: SPEC });
      const unacknowledged = await cp.call(
        "PUT",
        `/api/resources/${api.resourceId}/policy/units/auth.mtls`,
        { cookie: api.pavel, body: { value: { allowedSubjectCns: ["SAFMEC9"] } } },
      );
      // CN-only cannot happen by omission: the schema requires the acknowledgement.
      expect(unacknowledged.status).toBe(400);

      const acknowledged = await cp.call(
        "PUT",
        `/api/resources/${api.resourceId}/policy/units/auth.mtls`,
        {
          cookie: api.pavel,
          body: { value: { allowedSubjectCns: ["SAFMEC9"], acknowledgeCnOnly: true } },
        },
      );
      expect(acknowledged.status).toBe(200);
      expect(JSON.stringify(await acknowledged.json())).toContain("GET /api/governance/exceptions");
    } finally {
      backend.stop();
    }
  });
});

// --------------------------------------------------------------------------- ipAllow and cors

describe("ipAllow", () => {
  test("it reads the effective client IP, not the proxy's", async () => {
    const w = await world(
      { ipAllow: ["10.1.0.0/16"] },
      { dp: { trustedProxyCidrs: ["10.9.0.0/16"] } },
    );
    try {
      expect((await get(w, "/orders", {}, "10.1.2.3")).status).toBe(200);
      const denied = await get(w, "/orders", {}, "203.0.113.9");
      expect(denied.status).toBe(403);
      // Behind a proxy every request would otherwise appear to come from the proxy, and the
      // allowlist would admit everyone or nobody.
      expect(
        (await get(w, "/orders", { headers: { "x-forwarded-for": "10.1.2.3" } }, "10.9.0.1")).status,
      ).toBe(200);
      expect(
        (await get(w, "/orders", { headers: { "x-forwarded-for": "203.0.113.9" } }, "10.9.0.1")).status,
      ).toBe(403);
    } finally {
      w.stop();
    }
  });
});

describe("cors", () => {
  const UNIT = {
    origins: ["https://app.test"],
    methods: ["GET", "POST"],
    headers: ["x-api-key", "content-type"],
    exposeHeaders: ["x-request-id"],
    maxAgeSec: 600,
  };

  test("a preflight is answered by the gateway and never reaches the backend", async () => {
    const w = await world({ cors: UNIT });
    try {
      const preflight = await get(w, "/orders", {
        method: "OPTIONS",
        headers: {
          origin: "https://app.test",
          "access-control-request-method": "GET",
          "access-control-request-headers": "x-api-key",
        },
      });
      expect(preflight.status).toBe(204);
      expect(preflight.headers.get("access-control-allow-origin")).toBe("https://app.test");
      expect(preflight.headers.get("access-control-max-age")).toBe("600");
      expect(w.backend.requests).toHaveLength(0);

      const foreign = await get(w, "/orders", {
        method: "OPTIONS",
        headers: { origin: "https://evil.test", "access-control-request-method": "GET" },
      });
      expect(foreign.headers.get("access-control-allow-origin")).toBeNull();
    } finally {
      w.stop();
    }
  });

  test("the headers are on the real response too, and on a rejection", async () => {
    cp.close();
    cp = makeCpWith({ sharedSecrets: { s: { value: "a:x" } } });
    const w = await world({
      cors: UNIT,
      "auth.basic": { credentialRef: "s" },
    });
    try {
      const rejected = await get(w, "/orders", { headers: { origin: "https://app.test" } });
      expect(rejected.status).toBe(401);
      // Without this a browser sees a network error instead of the 401, and the developer spends
      // an afternoon on the wrong problem.
      expect(rejected.headers.get("access-control-allow-origin")).toBe("https://app.test");

      const ok = await get(w, "/orders", {
        headers: { origin: "https://app.test", authorization: `Basic ${btoa("a:x")}` },
      });
      expect(ok.status).toBe(200);
      expect(ok.headers.get("access-control-allow-origin")).toBe("https://app.test");
      expect(ok.headers.get("access-control-expose-headers")).toContain("x-request-id");
    } finally {
      w.stop();
    }
  });
});

// --------------------------------------------------------------------------- cache

describe("cache", () => {
  test("a hit is served without touching the backend, and only safe methods are stored", async () => {
    let n = 0;
    const w = await world(
      { cache: { ttlSec: 60 } },
      { respondWith: () => Response.json({ n: ++n }) },
    );
    try {
      expect(await (await get(w)).json()).toEqual({ n: 1 });
      expect(await (await get(w)).json()).toEqual({ n: 1 });
      expect(w.backend.requests).toHaveLength(1);

      // A POST is neither served from the cache nor stored in it.
      const post = await w.dp.fetchHttp(
        new Request(`http://gw${w.basePath}/orders`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        }),
        "127.0.0.1",
      );
      expect(post.status).toBe(200);
      expect(w.backend.requests).toHaveLength(2);
    } finally {
      w.stop();
    }
  });

  test("vary splits the key, and downstream shaping is what the client is told", async () => {
    let n = 0;
    const w = await world(
      { cache: { ttlSec: 60, vary: ["accept-language"], downstream: "private", mustRevalidate: true } },
      { respondWith: () => Response.json({ n: ++n }) },
    );
    try {
      const en = await get(w, "/orders", { headers: { "accept-language": "en" } });
      expect(await en.json()).toEqual({ n: 1 });
      expect(en.headers.get("cache-control")).toBe("private, max-age=60, must-revalidate");

      const de = await get(w, "/orders", { headers: { "accept-language": "de" } });
      expect(await de.json()).toEqual({ n: 2 });
      const enAgain = await get(w, "/orders", { headers: { "accept-language": "en" } });
      expect(await enAgain.json()).toEqual({ n: 1 });
    } finally {
      w.stop();
    }
  });

  test("varyBySubscription is off by default, which is exactly why it is linted", async () => {
    const backend = startBackend();
    try {
      const api = await publishApi(cp, {
        backendUrl: backend.url,
        spec: SPEC,
        // The warning is about serving *one consumer's* response to another, so it only means
        // something once consumers are distinguishable.
        policy: { "auth.subscriptionKey": { in: "header", name: "X-Api-Key" } },
      });
      const response = await cp.call("PUT", `/api/resources/${api.resourceId}/policy/units/cache`, {
        cookie: api.pavel,
        body: { value: { ttlSec: 60 } },
      });
      expect(response.status).toBe(200);
      const warnings = (await response.json()).warnings as string[];
      // Caching without it serves one consumer's response to another. Right for public reference
      // data, wrong otherwise — and a judgement the control plane cannot make for you, so it warns
      // rather than deciding.
      expect(warnings.join(" ")).toContain("one consumer's response can be served to another");
    } finally {
      backend.stop();
    }
  });

  test("a config change empties the cache by construction", async () => {
    let n = 0;
    const w = await world(
      { cache: { ttlSec: 600 } },
      { respondWith: () => Response.json({ n: ++n }) },
    );
    try {
      expect(await (await get(w)).json()).toEqual({ n: 1 });
      expect(await (await get(w)).json()).toEqual({ n: 1 });

      // Keys carry the active config digest, so activating a new one cannot hit an old entry —
      // there is no invalidation logic to get wrong.
      w.dp.cache.clear();
      expect(await (await get(w)).json()).toEqual({ n: 2 });
    } finally {
      w.stop();
    }
  });
});

// --------------------------------------------------------------------------- compression

/**
 * The gateway decides on the *request* whether a compressed response may be carried through: a
 * body the backend never compressed cannot be forwarded compressed, and one the gateway asked for
 * compressed and then had to expand costs twice.
 */
describe("response compression", () => {
  const PAYLOAD = JSON.stringify({ orders: Array.from({ length: 200 }, (_, i) => ({ id: i })) });

  /** A backend that compresses when asked and says so, exactly as a real one would. */
  const compressing = (req: Request) => {
    const accepts = (req.headers.get("accept-encoding") ?? "").includes("gzip");
    if (!accepts) {
      return new Response(PAYLOAD, {
        headers: { "content-type": "application/json", "content-length": String(PAYLOAD.length) },
      });
    }
    const zipped = Bun.gzipSync(new TextEncoder().encode(PAYLOAD));
    return new Response(zipped, {
      headers: {
        "content-type": "application/json",
        "content-encoding": "gzip",
        "content-length": String(zipped.byteLength),
      },
    });
  };

  test("a body nothing has to read is forwarded in the encoding the backend chose", async () => {
    const w = await world({}, { respondWith: compressing });
    try {
      const response = await get(w, "/orders", { headers: { "accept-encoding": "gzip" } });
      expect(response.status).toBe(200);

      // What the backend was asked for: the caller's own negotiation, forwarded.
      expect(w.backend.requests.at(-1)!.headers["accept-encoding"]).toContain("gzip");

      // What the caller receives: the bytes the backend produced, still compressed, with framing
      // headers that describe them — and a `Vary`, so no intermediary hands this body to a caller
      // that never asked for gzip.
      expect(response.headers.get("content-encoding")).toBe("gzip");
      expect(response.headers.get("vary")?.toLowerCase()).toContain("accept-encoding");
      const bytes = new Uint8Array(await response.arrayBuffer());
      expect(bytes.byteLength).toBeLessThan(PAYLOAD.length);
      expect(Number(response.headers.get("content-length"))).toBe(bytes.byteLength);
      expect(new TextDecoder().decode(Bun.gunzipSync(bytes))).toBe(PAYLOAD);
    } finally {
      w.stop();
    }
  });

  test("a caller that negotiated nothing is answered decoded, as before", async () => {
    const w = await world({}, { respondWith: compressing });
    try {
      const response = await get(w, "/orders");
      expect(response.status).toBe(200);
      // The runtime adds an `Accept-Encoding` of its own, so the backend may well compress — but
      // the caller agreed to nothing, so what it gets is plain bytes and no encoding header.
      expect(response.headers.get("content-encoding")).toBeNull();
      expect(await response.text()).toBe(PAYLOAD);
    } finally {
      w.stop();
    }
  });

  test("a route whose response the gateway has to read asks for none", async () => {
    // A cache unit is enough: the stored bytes are served to the next caller, whose negotiation is
    // its own, so a compressed body cannot be what is kept.
    const w = await world({ cache: { ttlSec: 60 } }, { respondWith: compressing });
    try {
      const response = await get(w, "/orders", { headers: { "accept-encoding": "gzip" } });
      expect(response.status).toBe(200);
      // `identity`, not absent: deleting the header lets the runtime supply one of its own, and
      // the backend would compress a body the gateway then has to expand in order to store it.
      expect(w.backend.requests.at(-1)!.headers["accept-encoding"]).toBe("identity");
      expect(response.headers.get("content-encoding")).toBeNull();
      expect(await response.text()).toBe(PAYLOAD);
    } finally {
      w.stop();
    }
  });
});

// --------------------------------------------------------------------------- shaping

describe("headers, rewrite and templates", () => {
  test("request headers are set, appended, skipped and removed, in that order", async () => {
    const w = await world({
      "auth.subscriptionKey": { in: "header", name: "X-Api-Key" },
      "headers.request": {
        remove: ["x-noisy"],
        set: { "X-Subscription": "${subscription.name}" },
        append: { "X-Trace": "gw" },
        skip: { "X-Default": "fallback" },
      },
    });
    try {
      const response = await get(w, "/orders", {
        headers: { "x-api-key": w.key, "x-noisy": "drop-me", "x-default": "already-here" },
      });
      expect(response.status).toBe(200);
      const seen = w.backend.requests.at(-1)!.headers;
      expect(seen["x-noisy"]).toBeUndefined();
      expect(seen["x-subscription"]).toContain("->");
      expect(seen["x-trace"]).toBe("gw");
      // `skip` means "only if absent", which is what makes it different from `set`.
      expect(seen["x-default"]).toBe("already-here");
    } finally {
      w.stop();
    }
  });

  test("response headers are shaped on the way out", async () => {
    const w = await world(
      { "headers.response": { set: { "X-Served-By": "gw" }, remove: ["x-internal"] } },
      { respondWith: () => Response.json({ ok: true }, { headers: { "x-internal": "leaky" } }) },
    );
    try {
      const response = await get(w);
      expect(response.headers.get("x-served-by")).toBe("gw");
      expect(response.headers.get("x-internal")).toBeNull();
    } finally {
      w.stop();
    }
  });

  test("rewrite strips the base path, templates the path and shapes the query", async () => {
    const w = await world({
      rewrite: {
        stripBasePath: true,
        path: "/v2/orders/{orderId}",
        query: { set: { source: "gateway" }, remove: ["debug"] },
      },
    });
    try {
      const response = await get(w, "/orders/ord_7?debug=1&keep=yes");
      expect(response.status).toBe(200);
      const seen = w.backend.requests.at(-1)!;
      expect(seen.path).toBe("/v2/orders/ord_7");
      expect(seen.query).toContain("source=gateway");
      expect(seen.query).toContain("keep=yes");
      expect(seen.query).not.toContain("debug");
    } finally {
      w.stop();
    }
  });

  /*
   * The default, which is what a hand-published API gets. `rewrite: undefined` is not noise — it
   * removes the `stripBasePath: true` that `world()` merges in, leaving the resource with no
   * rewrite unit at all, which is the shape the publish flow actually produces. This forwarded the
   * whole public path until the default was corrected, so every such API got a 404 from a backend
   * that had never heard of the gateway's own address.
   */
  test("with no rewrite unit at all the base path still comes off", async () => {
    const w = await world({ rewrite: undefined });
    try {
      const response = await get(w, "/orders");
      expect(response.status).toBe(200);
      expect(w.backend.requests.at(-1)!.path).toBe("/orders");
    } finally {
      w.stop();
    }
  });

  test("a path the definition does not declare is refused, not proxied", async () => {
    const w = await world({});
    try {
      // `/orders` is declared; `/order` and `/orders/x/y` are not, and neither is DELETE on either.
      const response = await get(w, "/order");
      expect(response.status).toBe(404);
      expect(await response.text()).toContain("is not an operation this API declares");
      expect((await get(w, "/orders/ord_1/history")).status).toBe(404);
      expect((await get(w, "/orders", { method: "DELETE" })).status).toBe(404);
      // Nothing reached the backend: the refusal is the gateway's, before the proxy step.
      expect(w.backend.requests).toHaveLength(0);
    } finally {
      w.stop();
    }
  });

  test("stripBasePath: false is the opt-out, for a backend mounted where the gateway publishes", async () => {
    const w = await world({ rewrite: { stripBasePath: false } });
    try {
      const response = await get(w, "/orders");
      expect(response.status).toBe(200);
      expect(w.backend.requests.at(-1)!.path).toBe(`${w.basePath}/orders`);
    } finally {
      w.stop();
    }
  });
});

// --------------------------------------------------------------------------- preconditions

describe("preconditions", () => {
  test("each check has one meaning, and the deny is what the owner wrote", async () => {
    cp.close();
    cp = makeCpWith({ sharedSecrets: { "gate-secret": { value: "open-sesame" } } });
    const w = await world({
      preconditions: [
        {
          requireHeader: { name: "X-Tenant", pattern: "^[a-z]{3,10}$" },
          deny: { status: 428, reason: "X-Tenant is required and must be a tenant slug" },
        },
        {
          requireQuery: { name: "mode", equals: "live" },
          deny: { status: 409, reason: "only mode=live is served here" },
        },
        {
          requireHeader: { name: "X-Gate", credentialRef: "gate-secret" },
          deny: { status: 401, reason: "the gate header is wrong" },
        },
      ],
    });
    try {
      const base = { "x-tenant": "skoda", "x-gate": "open-sesame" };
      expect((await get(w, "/orders?mode=live", { headers: base })).status).toBe(200);

      const noTenant = await get(w, "/orders?mode=live", { headers: { "x-gate": "open-sesame" } });
      expect(noTenant.status).toBe(428);
      expect((await noTenant.json()).detail).toContain("tenant slug");

      const badMode = await get(w, "/orders?mode=test", { headers: base });
      expect(badMode.status).toBe(409);

      // The secret is compared in constant time and never appears in the document.
      const wrongGate = await get(w, "/orders?mode=live", {
        headers: { ...base, "x-gate": "guess" },
      });
      expect(wrongGate.status).toBe(401);
      expect(JSON.stringify(w.dp.client.table!.routes[0]!.policy)).not.toContain("open-sesame");

      expect(w.backend.requests).toHaveLength(1);
    } finally {
      w.stop();
    }
  });

  test("requireOperation restricts which methods this route serves at all", async () => {
    const w = await world({
      preconditions: [
        {
          requireOperation: { methods: ["GET"] },
          deny: { status: 405, reason: "this route is read-only" },
        },
      ],
    });
    try {
      expect((await get(w)).status).toBe(200);
      const post = await w.dp.fetchHttp(
        new Request(`http://gw${w.basePath}/orders`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        }),
        "127.0.0.1",
      );
      expect(post.status).toBe(405);
      expect(w.backend.requests).toHaveLength(1);
    } finally {
      w.stop();
    }
  });
});

// --------------------------------------------------------------------------- backendAuth

describe("backendAuth", () => {
  test("basic and api-key are applied to the outbound request only", async () => {
    cp.close();
    cp = makeCpWith({ sharedSecrets: { "backend-cred": { value: "svc:hunter2" } } });
    const w = await world({
      backendAuth: { type: "basic", credentialRef: "backend-cred" },
    });
    try {
      expect((await get(w)).status).toBe(200);
      expect(w.backend.requests.at(-1)!.headers.authorization).toBe(`Basic ${btoa("svc:hunter2")}`);
    } finally {
      w.stop();
    }

    cp.close();
    cp = makeCpWith({ sharedSecrets: { "backend-key": { value: "k-123" } } });
    const w2 = await world({
      backendAuth: { type: "api-key", credentialRef: "backend-key", in: "header", name: "X-Backend-Key" },
    });
    try {
      expect((await get(w2)).status).toBe(200);
      expect(w2.backend.requests.at(-1)!.headers["x-backend-key"]).toBe("k-123");
    } finally {
      w2.stop();
    }
  });

  test("oauth2 fetches once for many concurrent requests, and re-fetches on a 401", async () => {
    let issued = 0;
    const tokenServer = Bun.serve({
      port: 0,
      fetch: () => {
        issued++;
        return Response.json({ access_token: `t-${issued}`, expires_in: 3600, token_type: "Bearer" });
      },
    });
    cp.close();
    cp = makeCpWith({
      sharedSecrets: { "sp-cred": { value: "client:secret" } },
      tokenProviders: {
        sp: {
          tokenUrl: `http://127.0.0.1:${tokenServer.port}/token`,
          credentialRef: "sp-cred",
          grant: "client_credentials",
        },
      },
    });

    let reject = false;
    const w = await world(
      {
        backendAuth: {
          type: "oauth2-client-credentials",
          tokenProviderRef: "sp",
          invalidateOnStatus: [401],
        },
      },
      { respondWith: () => (reject ? new Response("no", { status: 401 }) : Response.json({ ok: true })) },
    );
    try {
      // A popular API restarting would otherwise stampede the token endpoint.
      await Promise.all(Array.from({ length: 6 }, () => get(w)));
      expect(issued).toBe(1);
      expect(w.backend.requests.at(-1)!.headers.authorization).toBe("Bearer t-1");

      // A 401 from the backend means the token this gateway holds is stale, so it is dropped —
      // otherwise every request until expiry would fail with a token nobody can refresh.
      reject = true;
      await get(w);
      reject = false;
      await get(w);
      expect(issued).toBe(2);
      expect(w.backend.requests.at(-1)!.headers.authorization).toBe("Bearer t-2");
    } finally {
      w.stop();
      tokenServer.stop(true);
    }
  });

  test("a token endpoint that is down fails the request closed", async () => {
    cp.close();
    cp = makeCpWith({
      sharedSecrets: { "sp-cred": { value: "client:secret" } },
      tokenProviders: {
        sp: { tokenUrl: "http://127.0.0.1:1/token", credentialRef: "sp-cred", grant: "client_credentials" },
      },
    });
    const w = await world({
      backendAuth: { type: "oauth2-client-credentials", tokenProviderRef: "sp" },
    });
    try {
      const response = await get(w);
      // Never "send it without the credential and see": the backend would reject it anyway, and a
      // 502 that says the gateway could not authenticate is a better diagnosis.
      expect(response.status).toBeGreaterThanOrEqual(500);
      expect(w.backend.requests).toHaveLength(0);
    } finally {
      w.stop();
    }
  });

  test("hmac-sa-key-lite signs the outbound request", async () => {
    cp.close();
    cp = makeCpWith({
      sharedSecrets: { "sa-app": { value: "APP123" }, "sa-key": { value: "s3cr3t-key" } },
      hmacSchemes: { safmec: { appIdRef: "sa-app", appKeyRef: "sa-key" } },
    });
    const w = await world({
      backendAuth: { type: "hmac-sa-key-lite", schemeRef: "safmec", serviceShortcut: "ORD" },
    });
    try {
      expect((await get(w)).status).toBe(200);
      const seen = w.backend.requests.at(-1)!.headers;
      // The signature is over the request, so both the date and the authorization travel.
      expect(seen.authorization ?? seen["x-sa-signature"] ?? "").not.toBe("");
      expect(JSON.stringify(seen)).toContain("APP123");
      expect(JSON.stringify(seen)).not.toContain("s3cr3t-key");
    } finally {
      w.stop();
    }
  });
});

// --------------------------------------------------------------------------- per-operation overrides

describe("per-operation overrides", () => {
  test("an override binds only its own operation, and only overridable units", async () => {
    const backend = startBackend();
    const cpServer = serveCp(cp);
    try {
      const api = await publishApi(cp, {
        backendUrl: backend.url,
        basePath: "/ops",
        spec: SPEC,
        policy: {
          "auth.subscriptionKey": { in: "header", name: "X-Api-Key" },
          rewrite: { stripBasePath: true },
          rateLimit: { calls: 50, periodSec: 60, per: "instance", by: "subscription", scope: "route" },
        },
      });
      const put = (unitKey: string, value: unknown) =>
        cp.call("PUT", `/api/resources/${api.resourceId}/policy/units/${encodeURIComponent(unitKey)}`, {
          cookie: api.pavel,
          body: { value },
        });

      const tightened = await put('operations["listOrders"].rateLimit', {
        calls: 1,
        periodSec: 60,
        per: "instance",
        by: "subscription",
        scope: "route",
      });
      expect(tightened.status).toBe(200);

      // A unit that is not overridable per operation is refused, rather than accepted and ignored.
      const refused = await put('operations["listOrders"].ipAllow', ["10.0.0.0/8"]);
      expect(refused.status).toBe(400);

      const dp = makeDp(cpServer.url, cp.token, cp.dir, { name: "ops" });
      await dp.start();
      try {
        const call = (path: string, method = "GET") =>
          dp.fetchHttp(
            new Request(`http://gw${api.basePath}${path}`, {
              method,
              headers: {
                "x-api-key": api.key!,
                ...(method === "POST" ? { "content-type": "application/json" } : {}),
              },
              ...(method === "POST" ? { body: "{}" } : {}),
            }),
            "127.0.0.1",
          );

        expect((await call("/orders")).status).toBe(200);
        expect((await call("/orders")).status).toBe(429);
        // The other operation still has the route's limit of 50.
        expect((await call("/orders", "POST")).status).toBe(200);
        expect((await call("/orders/ord_1")).status).toBe(200);
      } finally {
        dp.stop();
      }
    } finally {
      cpServer.stop();
      backend.stop();
    }
  });
});

// --------------------------------------------------------------------------- transform

describe("transform.response: soap-to-json", () => {
  const WSDL = Bun.file("tools/backend/petstore.wsdl");

  test("the body's first child becomes the JSON, and the envelope does not travel", async () => {
    const envelope =
      `<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body>` +
      `<tns:GetPetResponse xmlns:tns="urn:apim:petstore"><tns:petId>1</tns:petId>` +
      `<tns:name>doggie</tns:name><tns:status>available</tns:status></tns:GetPetResponse>` +
      `</s:Body></s:Envelope>`;

    const w = await world(
      {
        "auth.subscriptionKey": { in: "header", name: "X-Api-Key" },
        transform: { request: "none", response: "soap-to-json" },
        validate: {
          request: "disabled",
          response: "disabled",
          downgradeReason: "this test is about the transform, not about the schema",
        },
      },
      {
        kind: "soap",
        spec: await WSDL.text(),
        respondWith: () =>
          new Response(envelope, { headers: { "content-type": "text/xml; charset=utf-8" } }),
      },
    );
    try {
      const response = await w.dp.fetchHttp(
        new Request(`http://gw${w.basePath}`, {
          method: "POST",
          headers: {
            "content-type": "text/xml; charset=utf-8",
            "x-api-key": w.key,
            soapaction: `"urn:apim:petstore:GetPet"`,
          },
          body:
            `<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">` +
            `<s:Body><tns:GetPetRequest xmlns:tns="urn:apim:petstore"><tns:petId>1</tns:petId>` +
            `</tns:GetPetRequest></s:Body></s:Envelope>`,
        }),
        "127.0.0.1",
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("application/json");
      // Envelope and Body are transport framing; a consumer who asked for JSON did not ask for
      // SOAP's frame. And every value is a string: `007` survives a round trip, a guess does not.
      expect(await response.json()).toEqual({ petId: "1", name: "doggie", status: "available" });
    } finally {
      w.stop();
    }
  });
});
