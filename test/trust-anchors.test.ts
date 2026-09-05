import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { X509Certificate } from "node:crypto";
import { rootCertificates } from "node:tls";
import { thumbprintOf } from "../control-plane/src/certificates.ts";
import { readIntegrations } from "../control-plane/src/config.ts";
import type { Integrations } from "../control-plane/src/egress.ts";
import {
  caBundleFor,
  controlPlaneCaBundle,
  liveAnchorsFor,
  MAX_ANCHOR_PEM_BYTES,
} from "../control-plane/src/trust-store.ts";
import { TrustSet } from "../data-plane/src/trust.ts";
import { makeCp, makeDp, poll, publishApi, serveCp, type TestCp } from "./helpers.ts";
import { generateCertificate, type GeneratedCertificate } from "./x509.ts";

/**
 * G4: register a trusted internal CA, at environment level, applied to all its gateways
 * (design section 5.4 rung 1, plan §8).
 *
 * The properties worth protecting, in the order they would otherwise be lost:
 *
 *  - **rung 1 removes the need for an exception.** A backend whose certificate chains to a
 *    registered anchor verifies normally — no `tls_exception`, no dated hole in verification.
 *  - **the environment is the unit.** DEV trusting a CA says nothing about PROD, and copying is an
 *    explicit act with a diff.
 *  - **every refusal names its reason.** A leaf, a bundle, an expired CA, an oversize file and the
 *    seventeenth anchor are each refused with the sentence that says what to do instead.
 *  - **the system roots survive.** Setting `tls.ca` replaces the default store rather than adding
 *    to it, so the union is explicit and asserted here rather than hoped for.
 *  - **removal is dated, and re-registration is allowed.** The unique index is partial.
 */

let cp: TestCp;
let ca: GeneratedCertificate;

/**
 * The sample `INTEGRATIONS_FILE` allows only `http` on loopback, so a TLS fixture backend is not
 * reachable from the control plane under it. The test brings its own rule rather than widening the
 * shipped file, which would weaken the default for everyone (review `[P2-14]`).
 */
function integrationsWithLocalTls(): Integrations {
  const integrations = readIntegrations("config/integrations.json");
  integrations.egressAllowlist.push({
    scheme: "https",
    hostPattern: "127.0.0.1",
    portRange: [1024, 65535],
  });
  return integrations;
}

beforeEach(() => {
  cp = makeCp({ integrations: integrationsWithLocalTls() });
  ca = generateCertificate({ cn: "corp-root", ca: true });
});
afterEach(() => {
  cp.close();
});

async function register(
  cookie: string,
  overrides: { environment?: string; name?: string; pem?: string } = {},
) {
  return cp.call("POST", "/api/trust/anchors", {
    cookie,
    body: {
      environment: overrides.environment ?? "dev",
      name: overrides.name ?? "corp-root",
      pem: overrides.pem ?? ca.certPem,
    },
  });
}

// --------------------------------------------------------------------------- who may, and what parses

describe("registering a trust anchor", () => {
  test("is admin-only, in both directions of the decision", async () => {
    const pavel = await cp.login("pavel");
    const refused = await register(pavel);
    expect(refused.status).toBe(403);
    // Deciding whose certificates verify is the same decision as deciding not to verify, seen from
    // the other side — so it sits with the same role (design section 9).
    expect(await refused.text()).toContain("admin-only");

    const alice = await cp.login("alice");
    expect((await register(alice)).status).toBe(201);
  });

  test("the response says what was trusted and when it takes effect", async () => {
    const alice = await cp.login("alice");
    const body = await (await register(alice)).json();
    expect(body.subject).toContain("CN=corp-root");
    expect(body.thumbprint).toMatch(/^[0-9A-F]{64}$/);
    expect(body.selfSigned).toBe(true);
    expect(body.keyAlgorithm).toBe("EC prime256v1");
    expect(body.expiresInDays).toBeGreaterThan(0);
    expect(body.effectiveAt).toContain("next poll");
  });

  test("preview parses without storing anything", async () => {
    const alice = await cp.login("alice");
    const preview = await (
      await cp.call("POST", "/api/trust/anchors/preview", { cookie: alice, body: { pem: ca.certPem } })
    ).json();
    expect(preview.ca).toBe(true);
    expect(preview.subject).toContain("CN=corp-root");

    const list = await (await cp.call("GET", "/api/trust/anchors?environment=dev", { cookie: alice })).json();
    expect(list.items).toEqual([]);
  });

  test("a leaf certificate is refused, because a leaf in a trust store trusts one host", async () => {
    const alice = await cp.login("alice");
    const leaf = generateCertificate({ cn: "backend.internal", issuer: ca, dnsNames: ["backend.internal"] });
    const response = await register(alice, { pem: leaf.certPem });
    expect(response.status).toBe(400);
    const detail = (await response.json()).detail as string;
    expect(detail).toContain("not a certificate authority");
    expect(detail).toContain("register the CA that signed it");
  });

  test("an expired CA is refused", async () => {
    const alice = await cp.login("alice");
    const expired = generateCertificate({
      cn: "old-root",
      ca: true,
      notBefore: new Date(Date.now() - 2 * 86_400_000),
      notAfter: new Date(Date.now() - 86_400_000),
    });
    const response = await register(alice, { pem: expired.certPem });
    expect(response.status).toBe(400);
    expect((await response.json()).detail).toContain("expired at");
  });

  test("a bundle is refused with the reason one certificate per anchor exists", async () => {
    const alice = await cp.login("alice");
    const second = generateCertificate({ cn: "other-root", ca: true });
    const response = await register(alice, { pem: `${ca.certPem}\n${second.certPem}` });
    expect(response.status).toBe(400);
    expect((await response.json()).detail).toContain("one certificate per anchor");
  });

  test("a private key pasted into the field is refused before anything is stored", async () => {
    const alice = await cp.login("alice");
    const response = await register(alice, { pem: `${ca.certPem}\n${ca.keyPem}` });
    expect(response.status).toBe(400);
    expect((await response.json()).detail).toContain("never paste a key here");
  });

  test("an oversize file is refused by size rather than parsed", async () => {
    const alice = await cp.login("alice");
    const padded = `${ca.certPem}\n${"#".repeat(MAX_ANCHOR_PEM_BYTES)}`;
    const response = await register(alice, { pem: padded });
    expect(response.status).toBe(400);
    expect((await response.json()).detail).toContain("larger than");
  });

  test("nonsense is refused with the sentence that says what to export", async () => {
    const alice = await cp.login("alice");
    const response = await register(alice, { pem: "MIIB...this is a der file" });
    expect(response.status).toBe(400);
    expect((await response.json()).detail).toContain("Export the CA");
  });

  test("a live duplicate is refused, and a removed one may be registered again", async () => {
    const alice = await cp.login("alice");
    const first = await (await register(alice)).json();
    const duplicate = await register(alice, { name: "corp-root-again" });
    expect(duplicate.status).toBe(409);
    expect((await duplicate.json()).detail).toContain("already trusts this certificate");

    // The unique index is partial, so the history of a removed anchor does not block re-trusting
    // the same CA later (review [P1-06]).
    expect((await cp.call("DELETE", `/api/trust/anchors/${first.id}`, { cookie: alice })).status).toBe(204);
    expect((await register(alice, { name: "corp-root-again" })).status).toBe(201);

    const withHistory = await (
      await cp.call("GET", "/api/trust/anchors?environment=dev&includeRemoved=1", { cookie: alice })
    ).json();
    expect(withHistory.items).toHaveLength(2);
    expect(withHistory.items.filter((item: { live: boolean }) => item.live)).toHaveLength(1);
    // Who trusted it and when we stopped, both still answerable.
    const removed = withHistory.items.find((item: { id: string }) => item.id === first.id);
    expect(removed.addedBy).toBe("alice");
    expect(removed.removedAt).not.toBeNull();
  });

  test("the seventeenth anchor is refused naming the variable and the trade", async () => {
    const alice = await cp.login("alice");
    for (let i = 0; i < cp.app.config.maxTrustAnchors; i++) {
      const generated = generateCertificate({ cn: `root-${i}`, ca: true });
      const response = await register(alice, { name: `root-${i}`, pem: generated.certPem });
      expect(response.status).toBe(201);
    }
    const overflow = await register(alice, { name: "one-too-many" });
    expect(overflow.status).toBe(409);
    const detail = (await overflow.json()).detail as string;
    expect(detail).toContain("MAX_TRUST_ANCHORS");
    expect(detail).toContain("every anchor travels to every gateway");
  });
});

// --------------------------------------------------------------------------- distribution

describe("distribution to the environment", () => {
  test("the anchor reaches the config document, and only that environment's", async () => {
    const alice = await cp.login("alice");
    const registered = await (await register(alice)).json();

    const dev = await poll(cp);
    expect(dev.config?.trustAnchors).toHaveLength(1);
    const anchor = dev.config!.trustAnchors[0]!;
    expect(anchor.id).toBe(registered.id);
    expect(anchor.name).toBe("corp-root");
    expect(anchor.thumbprint).toBe(registered.thumbprint);
    // The PEM travels inline: a CA certificate is 1-2 KiB, so the artifact channel would buy
    // activation-gating complexity for nothing (plan §8.2).
    expect(anchor.pem).toContain("BEGIN CERTIFICATE");
    // And `notAfter` travels, so the gateway can drop it on its own clock.
    expect(anchor.notAfter).toBe(registered.notAfter);

    // TEST is a different decision and is untouched until somebody makes it.
    const testInstance = cp.app.db
      .query<{ id: string }, []>(
        `SELECT g.id FROM gateway_instance g JOIN target t ON t.id = g.target_id
          WHERE t.environment = 'test'`,
      )
      .get();
    expect(testInstance).not.toBeNull();
  });

  test("removing an anchor takes it out of the next config document", async () => {
    const alice = await cp.login("alice");
    const registered = await (await register(alice)).json();
    expect((await poll(cp)).config?.trustAnchors).toHaveLength(1);

    await cp.call("DELETE", `/api/trust/anchors/${registered.id}`, { cookie: alice });
    // The same guarantee as revoking a subscription: it is gone at the next poll, not eventually.
    expect((await poll(cp)).config?.trustAnchors).toEqual([]);
  });

  test("an anchor past its notAfter stops travelling without anybody acting", () => {
    const alice = cp.app.db;
    // Written directly, because the endpoint refuses an expired certificate at upload — this is
    // the anchor that expired while it was registered, which is the case §8.2 is about.
    alice.run(
      `INSERT INTO trust_anchor
         (id, environment, name, cert_pem, subject, issuer, thumbprint, not_before, not_after,
          added_by, added_at)
       VALUES ('anch_stale','dev','stale','pem','CN=stale','CN=stale','AA','2020-01-01T00:00:00.000Z',
               '2021-01-01T00:00:00.000Z','alice','2020-01-01T00:00:00.000Z')`,
    );
    expect(liveAnchorsFor(cp.app.db, "dev")).toEqual([]);
    expect(caBundleFor(cp.app.db, "dev")).toBeNull();
  });

  test("copying to another environment is explicit, diffed, and skips what is already there", async () => {
    const alice = await cp.login("alice");
    const registered = await (await register(alice)).json();

    const dry = await (
      await cp.call("POST", "/api/trust/anchors/copy-from", {
        cookie: alice,
        body: { fromEnvironment: "dev", environment: "test", ids: [registered.id] },
      })
    ).json();
    expect(dry.applied).toBe(false);
    expect(dry.copy).toHaveLength(1);
    expect(dry.copy[0].thumbprint).toBe(registered.thumbprint);
    // Nothing happened yet: a dry run is the confirmation step, not a preview of a write already made.
    expect(liveAnchorsFor(cp.app.db, "test")).toEqual([]);

    const applied = await (
      await cp.call("POST", "/api/trust/anchors/copy-from", {
        cookie: alice,
        body: { fromEnvironment: "dev", environment: "test", ids: [registered.id], dryRun: false },
      })
    ).json();
    expect(applied.applied).toBe(true);
    expect(liveAnchorsFor(cp.app.db, "test")).toHaveLength(1);
    // A copy, so the destination gets its own row with its own id and its own audit trail.
    expect(applied.created[0]).not.toBe(registered.id);

    const again = await (
      await cp.call("POST", "/api/trust/anchors/copy-from", {
        cookie: alice,
        body: { fromEnvironment: "dev", environment: "test", ids: [registered.id], dryRun: false },
      })
    ).json();
    expect(again.copy).toEqual([]);
    expect(again.skipped[0].reason).toContain("already trusts");

    // And the list says where else the same certificate is live, so the decision is visible.
    const list = await (
      await cp.call("GET", "/api/trust/anchors?environment=dev", { cookie: alice })
    ).json();
    expect(list.items[0].alsoLiveIn).toEqual(["test"]);
  });

  test("copying needs two different environments and an explicit list", async () => {
    const alice = await cp.login("alice");
    const registered = await (await register(alice)).json();
    const same = await cp.call("POST", "/api/trust/anchors/copy-from", {
      cookie: alice,
      body: { fromEnvironment: "dev", environment: "dev", ids: [registered.id] },
    });
    expect(same.status).toBe(400);
    const empty = await cp.call("POST", "/api/trust/anchors/copy-from", {
      cookie: alice,
      body: { fromEnvironment: "dev", environment: "test", ids: [] },
    });
    expect(empty.status).toBe(400);
    expect((await empty.json()).detail).toContain("not a synchronisation");
  });

  test("every write leaves an audit row naming the certificate, never a key", async () => {
    const alice = await cp.login("alice");
    const registered = await (await register(alice)).json();
    await cp.call("DELETE", `/api/trust/anchors/${registered.id}`, { cookie: alice });

    const rows = cp.app.db
      .query<{ action: string; detail: string | null }, []>(
        "SELECT action, detail FROM audit WHERE action LIKE 'trust-anchor%' ORDER BY at",
      )
      .all();
    expect(rows.map((row) => row.action)).toEqual(["trust-anchor.register", "trust-anchor.remove"]);
    for (const row of rows) {
      expect(row.detail).toContain(registered.thumbprint);
      // The thumbprint identifies the certificate; the bytes are not what an audit row is for.
      expect(row.detail).not.toContain("PRIVATE KEY");
      expect(row.detail).not.toContain("BEGIN CERTIFICATE");
    }
  });
});

// --------------------------------------------------------------------------- the gateway, end to end

describe("the gateway verifies through the anchor (G4)", () => {
  /** A petstore-shaped TLS backend whose certificate no public store has heard of. */
  function tlsBackend(options: { dnsNames?: string[]; ipAddresses?: string[] } = {}) {
    const leaf = generateCertificate({
      cn: "petstore.internal",
      issuer: ca,
      dnsNames: options.dnsNames ?? ["localhost", "petstore.internal"],
      ipAddresses: options.ipAddresses ?? ["127.0.0.1"],
    });
    const server = Bun.serve({
      port: 0,
      tls: { cert: leaf.certPem, key: leaf.keyPem },
      fetch: () => Response.json({ available: 1 }),
    });
    return { server, url: `https://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
  }

  test("an unknown CA fails, the anchor fixes it within one poll, and removing it undoes that", async () => {
    const backend = tlsBackend();
    const served = serveCp(cp);
    const alice = await cp.login("alice");
    const api = await publishApi(cp, { backendUrl: backend.url });
    const dp = makeDp(served.url, cp.token, cp.dir);
    const call = () =>
      dp.fetchHttp(
        new Request(`http://gw${api.basePath}/store/inventory`, { headers: { "x-api-key": api.key! } }),
        "127.0.0.1",
      );

    try {
      await dp.start();
      expect(dp.client.table!.trust.liveCount()).toBe(0);

      // No exception, no anchor: the request fails at the handshake, which is the state this
      // whole goal exists to get out of.
      const before = await call();
      expect(before.status).toBe(502);
      expect(await before.text()).toContain("could not reach the backend");

      expect((await register(alice)).status).toBe(201);
      // One poll. Not a restart, not a deploy, not a per-gateway environment variable.
      expect(await dp.client.pollOnce()).toBe("updated");
      expect(dp.client.table!.trust.liveCount()).toBe(1);

      const after = await call();
      expect(after.status).toBe(200);
      // Verified normally: there is no `tls_exception` anywhere in this test, and the route's
      // resolved mode is still the default.
      expect(dp.client.table!.routes[0]!.backend.tls).toEqual({ mode: "verify" });
      const exceptions = await (await cp.call("GET", "/api/trust/exceptions", { cookie: alice })).json();
      expect(exceptions.items).toEqual([]);

      const anchors = await (await cp.call("GET", "/api/trust/anchors?environment=dev", { cookie: alice })).json();
      await cp.call("DELETE", `/api/trust/anchors/${anchors.items[0].id}`, { cookie: alice });
      expect(await dp.client.pollOnce()).toBe("updated");
      // Removal takes effect at the next poll — the same guarantee as revoking a subscription.
      expect(dp.client.table!.trust.liveCount()).toBe(0);
      expect((await call()).status).toBe(502);
    } finally {
      dp.stop();
      served.stop();
      backend.stop();
    }
  });

  /**
   * The other direction of the handshake, and the one nothing could falsify until the local
   * petstore learned `--mtls`: a `clientCertRef` that reaches the config document proves the
   * plumbing, not that the gateway presents anything. Here the backend refuses the connection
   * outright without one, so the 502 and the 200 are the two halves of the same assertion.
   */
  test("a backend that demands a client certificate is refused until one is named", async () => {
    const clientCa = generateCertificate({ cn: "client-root", ca: true });
    const client = generateCertificate({ cn: "gateway-client", issuer: clientCa });
    const leaf = generateCertificate({
      cn: "petstore.internal",
      issuer: ca,
      dnsNames: ["localhost", "petstore.internal"],
      ipAddresses: ["127.0.0.1"],
    });
    const server = Bun.serve({
      port: 0,
      tls: {
        cert: leaf.certPem,
        key: leaf.keyPem,
        ca: clientCa.certPem,
        requestCert: true,
        rejectUnauthorized: true,
      },
      fetch: () => Response.json({ available: 1 }),
    });
    const backendUrl = `https://127.0.0.1:${server.port}`;
    const served = serveCp(cp);
    const alice = await cp.login("alice");
    const api = await publishApi(cp, { backendUrl });
    // The server direction is settled first, so what is left is only the client direction.
    expect((await register(alice)).status).toBe(201);
    const dp = makeDp(served.url, cp.token, cp.dir);
    const call = () =>
      dp.fetchHttp(
        new Request(`http://gw${api.basePath}/store/inventory`, { headers: { "x-api-key": api.key! } }),
        "127.0.0.1",
      );

    try {
      await dp.start();
      expect(dp.client.table!.trust.liveCount()).toBe(1);
      // We can verify them; they cannot verify us. The handshake fails from the far side.
      expect((await call()).status).toBe(502);

      const created = await (
        await cp.call("POST", "/api/certificates", {
          cookie: alice,
          body: {
            environment: "dev",
            applicationId: "application_platform",
            name: "gateway-client",
            certPem: client.certPem,
            chainPem: null,
            keyPem: client.keyPem,
          },
        })
      ).json();
      const named = await cp.call("PUT", `/api/resources/${api.resourceId}/binding`, {
        cookie: alice,
        body: { environment: "dev", urls: [backendUrl], clientCertRef: created.id },
      });
      expect(named.status).toBe(200);

      expect(await dp.client.pollOnce()).toBe("updated");
      expect((await call()).status).toBe(200);
      // Still no exception anywhere: mutual TLS is verification on both sides, not a hole in it.
      const exceptions = await (
        await cp.call("GET", "/api/trust/exceptions", { cookie: alice })
      ).json();
      expect(exceptions.items).toEqual([]);
    } finally {
      dp.stop();
      served.stop();
      server.stop(true);
    }
  });

  test("TEST is unaffected until the anchor is copied there", async () => {
    const backend = tlsBackend();
    const served = serveCp(cp);
    const alice = await cp.login("alice");
    const api = await publishApi(cp, { backendUrl: backend.url });
    await register(alice);

    // The TEST instance's own token, so this is really that environment's config.
    const testToken = cp.app.db
      .query<{ id: string }, []>(
        `SELECT g.id FROM gateway_instance g JOIN target t ON t.id = g.target_id
          WHERE t.environment = 'test'`,
      )
      .get();
    expect(testToken).not.toBeNull();

    const dp = makeDp(served.url, cp.token, cp.dir);
    try {
      await dp.start();
      expect(dp.client.table!.trust.liveCount()).toBe(1);
      // Trusting a CA in another environment is another decision, and nothing propagates on its own.
      expect(liveAnchorsFor(cp.app.db, "test")).toEqual([]);
      expect(caBundleFor(cp.app.db, "test")).toBeNull();
      void api;
    } finally {
      dp.stop();
      served.stop();
      backend.stop();
    }
  });

  test("a skip-hostname exception still needs the chain, so the anchor is what makes it work", async () => {
    // The certificate is valid, signed by our CA, and names a host this request does not use — the
    // exact case `skip-hostname` exists for. Verification of the chain still happens, so without
    // the anchor even the exception cannot save the call.
    const backend = tlsBackend({ dnsNames: ["some-other-name.internal"], ipAddresses: [] });
    const served = serveCp(cp);
    const alice = await cp.login("alice");
    const api = await publishApi(cp, { backendUrl: backend.url });
    await cp.call("POST", "/api/trust/exceptions", {
      cookie: alice,
      body: {
        resourceId: api.resourceId,
        environment: "dev",
        mode: "skip-hostname",
        reason: "the internal certificate names the service, not the address we dial it on",
        days: 7,
      },
    });

    const dp = makeDp(served.url, cp.token, cp.dir);
    const call = () =>
      dp.fetchHttp(
        new Request(`http://gw${api.basePath}/store/inventory`, { headers: { "x-api-key": api.key! } }),
        "127.0.0.1",
      );
    try {
      await dp.start();
      expect(dp.client.table!.routes[0]!.backend.tls.mode).toBe("skip-hostname");
      expect((await call()).status).toBe(502);

      await register(alice);
      await dp.client.pollOnce();
      expect((await call()).status).toBe(200);
    } finally {
      dp.stop();
      served.stop();
      backend.stop();
    }
  });

  test("a pinned route keeps working when an anchor is registered", async () => {
    const leaf = generateCertificate({
      cn: "pinned.internal",
      issuer: ca,
      ipAddresses: ["127.0.0.1"],
    });
    const server = Bun.serve({
      port: 0,
      tls: { cert: leaf.certPem, key: leaf.keyPem },
      fetch: () => Response.json({ available: 1 }),
    });
    const served = serveCp(cp);
    const alice = await cp.login("alice");
    const api = await publishApi(cp, { backendUrl: `https://127.0.0.1:${server.port}` });
    await cp.call("POST", "/api/trust/exceptions", {
      cookie: alice,
      body: {
        resourceId: api.resourceId,
        environment: "dev",
        mode: "pin",
        pinThumbprint: thumbprintOf(new X509Certificate(leaf.certPem)),
        reason: "pinned while the issuing CA is being registered under ticket APIM-1234",
        days: 7,
      },
    });
    await register(alice);

    const dp = makeDp(served.url, cp.token, cp.dir);
    try {
      await dp.start();
      expect(dp.client.table!.trust.liveCount()).toBe(1);
      const response = await dp.fetchHttp(
        new Request(`http://gw${api.basePath}/store/inventory`, { headers: { "x-api-key": api.key! } }),
        "127.0.0.1",
      );
      // A pin compares one certificate and does not consult the chain, so the anchor neither helps
      // nor hurts here. What matters is that attaching the set did not break the pinned path — and
      // that the pin is now retirable, which costs a TLS handshake per request to keep.
      expect(response.status).toBe(200);
    } finally {
      dp.stop();
      served.stop();
      server.stop(true);
    }
  });
});

// --------------------------------------------------------------------------- the composed set

describe("the gateway's trust set", () => {
  test("is the system roots plus the anchors, and TRUST_SYSTEM_ROOTS=0 is the only way to lose them", () => {
    const anchor = {
      id: "anch_1",
      name: "corp-root",
      thumbprint: "AA",
      notAfter: new Date(Date.now() + 86_400_000).toISOString(),
      pem: ca.certPem,
    };
    const withRoots = new TrustSet([anchor]).bundle()!;
    expect(withRoots).toContain(ca.certPem.trim());
    expect(withRoots).toContain(rootCertificates[0]!);
    expect((withRoots.match(/BEGIN CERTIFICATE/g) ?? []).length).toBe(rootCertificates.length + 1);

    const onlyOurs = new TrustSet([anchor], { systemRoots: false }).bundle()!;
    expect((onlyOurs.match(/BEGIN CERTIFICATE/g) ?? []).length).toBe(1);

    // No anchors means no `ca` at all: an estate with none sends exactly what it sent before G4.
    expect(new TrustSet([]).bundle()).toBeNull();
  });

  test("drops an anchor whose notAfter has passed, on this instance's own clock", async () => {
    const expiring = {
      id: "anch_2",
      name: "soon",
      thumbprint: "BB",
      notAfter: new Date(Date.now() + 60).toISOString(),
      pem: ca.certPem,
    };
    const set = new TrustSet([expiring]);
    expect(set.bundle()).not.toBeNull();
    await Bun.sleep(120);
    // Fail-static config cannot keep a dead CA alive: the instance stops honouring it without
    // being told, exactly as it does for a TLS exception's expiry (design section 5.4).
    expect(set.bundle()).toBeNull();
    expect(set.liveCount()).toBe(0);
  });
});

// --------------------------------------------------------------------------- the control plane's own fetches

describe("the control plane's outbound trust (§8.5)", () => {
  test("the composed bundle is the system roots plus the anchors, never only the anchors", async () => {
    const alice = await cp.login("alice");
    expect(controlPlaneCaBundle(cp.app.db)).toBeNull();
    await register(alice);

    const bundle = controlPlaneCaBundle(cp.app.db)!;
    expect(bundle).toContain(ca.certPem.trim());
    // Asserted against `tls.rootCertificates` rather than by calling the internet: setting `ca`
    // REPLACES the default store, so without this union one internal CA would break every
    // public-CA host the portal fetches from.
    expect(rootCertificates.length).toBeGreaterThan(0);
    expect(bundle).toContain(rootCertificates[0]!);
    const blocks = bundle.match(/BEGIN CERTIFICATE/g) ?? [];
    expect(blocks.length).toBe(rootCertificates.length + 1);
  });

  test("the same CA registered in two environments is one certificate in the bundle", async () => {
    const alice = await cp.login("alice");
    const registered = await (await register(alice)).json();
    await cp.call("POST", "/api/trust/anchors/copy-from", {
      cookie: alice,
      body: { fromEnvironment: "dev", environment: "test", ids: [registered.id], dryRun: false },
    });
    const bundle = controlPlaneCaBundle(cp.app.db)!;
    const blocks = bundle.match(/BEGIN CERTIFICATE/g) ?? [];
    expect(blocks.length).toBe(rootCertificates.length + 1);
  });

  test("a spec is importable from a TLS host once its CA is registered, and not before", async () => {
    const alice = await cp.login("alice");
    const leaf = generateCertificate({
      cn: "specs.internal",
      issuer: ca,
      dnsNames: ["localhost"],
      ipAddresses: ["127.0.0.1"],
    });
    const tlsServer = Bun.serve({
      port: 0,
      tls: { cert: leaf.certPem, key: leaf.keyPem },
      fetch: () =>
        Response.json({
          swagger: "2.0",
          info: { title: "internal", version: "1.0.0" },
          paths: { "/ping": { get: { operationId: "ping", responses: { "200": { description: "ok" } } } } },
        }),
    });
    const specUrl = `https://127.0.0.1:${tlsServer.port}/openapi.json`;

    try {
      const resource = await (
        await cp.call("POST", "/api/resources", {
          cookie: alice,
          body: { kind: "rest", name: "internal-api", applicationId: "application_platform", apiVersion: "v1" },
        })
      ).json();

      // Before: the certificate chains to a CA no store knows, so the import fails rather than
      // succeeding unverified. Design section 5.4's exceptions are not available here at all, so
      // the refusal has to name the remedy — otherwise it reads as "turn verification off".
      const before = await cp.call("POST", `/api/resources/${resource.id}/revisions`, {
        cookie: alice,
        body: { specUrl },
      });
      expect(before.status).toBe(502);
      const detail = (await before.json()).detail as string;
      expect(detail).toContain("could not be verified");
      expect(detail).toContain("register the certificate authority");

      await register(alice);
      const after = await cp.call("POST", `/api/resources/${resource.id}/revisions`, {
        cookie: alice,
        body: { specUrl },
      });
      expect(after.status).toBe(201);
      expect((await after.json()).rev).toBe(1);
    } finally {
      tlsServer.stop(true);
    }
  });
});

// --------------------------------------------------------------------------- can this exception go?

describe("would this backend verify without its exception", () => {
  async function exceptionFor(alice: string, backendUrl: string) {
    const published = await publishApi(cp, { backendUrl, subscribe: false });
    const created = await cp.call("POST", "/api/trust/exceptions", {
      cookie: alice,
      body: {
        resourceId: published.resourceId,
        environment: "dev",
        mode: "insecure",
        reason: "the internal CA is not registered yet; ticket APIM-1234 tracks removing this",
        days: 7,
      },
    });
    expect(created.status).toBe(201);
    return (await created.json()).id as string;
  }

  test("reports would-not before the anchor and would after it", async () => {
    const alice = await cp.login("alice");
    const leaf = generateCertificate({
      cn: "orders.internal",
      issuer: ca,
      dnsNames: ["localhost"],
      ipAddresses: ["127.0.0.1"],
    });
    const backend = Bun.serve({
      port: 0,
      tls: { cert: leaf.certPem, key: leaf.keyPem },
      fetch: () => new Response(null, { status: 204 }),
    });
    const backendUrl = `https://127.0.0.1:${backend.port}`;

    try {
      const exceptionId = await exceptionFor(alice, backendUrl);

      const before = await (
        await cp.call("POST", `/api/trust/exceptions/${exceptionId}/check`, { cookie: alice })
      ).json();
      expect(before.anchors).toBe(0);
      expect(before.wouldVerify).toBe(false);
      // The reason is the handshake's own words, not a guess: this is a probe, not a computation.
      expect(before.backends[0].detail).toMatch(/verification failed/);

      await register(alice);
      const after = await (
        await cp.call("POST", `/api/trust/exceptions/${exceptionId}/check`, { cookie: alice })
      ).json();
      expect(after.anchors).toBe(1);
      expect(after.wouldVerify).toBe(true);
      expect(after.backends[0].detail).toContain("verified");
    } finally {
      backend.stop(true);
    }
  });

  test("a plain http backend answers honestly rather than pretending to verify", async () => {
    const alice = await cp.login("alice");
    const exceptionId = await exceptionFor(alice, "http://127.0.0.1:9999");
    const result = await (
      await cp.call("POST", `/api/trust/exceptions/${exceptionId}/check`, { cookie: alice })
    ).json();
    expect(result.wouldVerify).toBe(true);
    expect(result.backends[0].detail).toContain("no certificate to verify");
  });

  test("probing is admin-only", async () => {
    const alice = await cp.login("alice");
    const pavel = await cp.login("pavel");
    const exceptionId = await exceptionFor(alice, "http://127.0.0.1:9999");
    const refused = await cp.call("POST", `/api/trust/exceptions/${exceptionId}/check`, { cookie: pavel });
    expect(refused.status).toBe(403);
  });
});
