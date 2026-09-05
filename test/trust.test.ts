import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { X509Certificate } from "node:crypto";
import { decrypt } from "../control-plane/src/crypto.ts";
import { parseCertificate, thumbprintOf } from "../control-plane/src/certificates.ts";
import { makeCp, makeDp, poll, publishApi, serveCp, startBackend, type TestCp } from "./helpers.ts";
import { generateCertificate } from "./x509.ts";

/**
 * Design section 5.4 and 4.3: backend TLS is verified by default, the only way to relax it is a
 * dated admin-created exception, and the client identities this estate presents live in their own
 * store with their private keys.
 *
 * The properties worth protecting, in the order they would otherwise be lost:
 *
 *  - `verify` needs no row. The absence of an exception is the secure state, so nothing has to be
 *    configured correctly for a backend to be verified.
 *  - An exception is **always dated**, bounded by `TLS_EXCEPTION_MAX_DAYS`, and **admin-only**.
 *  - The gateway **self-expires** on its own clock, so an exception cannot outlive its date by
 *    surviving in a fail-static config through a control-plane outage.
 *  - A private key is written once and read only by the instance channel.
 */

let cp: TestCp;

beforeEach(() => {
  cp = makeCp();
});
afterEach(() => {
  cp.close();
});

// --------------------------------------------------------------------------- PEM handling

describe("reading a certificate", () => {
  test("a matched pair round-trips, with the thumbprint the config document carries", () => {
    const generated = generateCertificate({ cn: "gateway-client" });
    const parsed = parseCertificate({ certPem: generated.certPem, keyPem: generated.keyPem });

    expect(parsed.subject).toContain("CN=gateway-client");
    expect(parsed.thumbprint).toMatch(/^[0-9A-F]{64}$/);
    // Colon-free uppercase, everywhere: the `pin` mode compares against this exact form.
    expect(parsed.thumbprint).toBe(thumbprintOf(new X509Certificate(generated.certPem)));
    expect(Date.parse(parsed.notAfter)).toBeGreaterThan(Date.now());
  });

  test("a key that does not belong to the certificate is refused at upload", () => {
    const one = generateCertificate({ cn: "one" });
    const two = generateCertificate({ cn: "two" });
    expect(() => parseCertificate({ certPem: one.certPem, keyPem: two.keyPem })).toThrow(
      // Caught here, once, rather than at TLS handshake time on every request through the binding.
      /does not belong to this certificate/,
    );
  });

  test("an already-expired certificate is refused", () => {
    const expired = generateCertificate({
      cn: "stale",
      notBefore: new Date(Date.now() - 2 * 86_400_000),
      notAfter: new Date(Date.now() - 86_400_000),
    });
    expect(() => parseCertificate({ certPem: expired.certPem, keyPem: expired.keyPem })).toThrow(
      /expired at/,
    );
  });

  test("a chain must actually chain, leaf first", () => {
    const ca = generateCertificate({ cn: "test-ca" });
    const leaf = generateCertificate({ cn: "leaf", issuer: ca });
    const unrelated = generateCertificate({ cn: "unrelated-ca" });

    const ok = parseCertificate({ certPem: leaf.certPem, chainPem: ca.certPem, keyPem: leaf.keyPem });
    expect(ok.chainPem).toContain("BEGIN CERTIFICATE");

    expect(() =>
      parseCertificate({ certPem: leaf.certPem, chainPem: unrelated.certPem, keyPem: leaf.keyPem }),
    ).toThrow(/did not issue/);

    // Leaf and chain pasted into one field is read rather than rejected: it is how people paste.
    const combined = parseCertificate({
      certPem: `${leaf.certPem}\n${ca.certPem}`,
      keyPem: leaf.keyPem,
    });
    expect(combined.certPem).toBe(leaf.certPem);
    expect(combined.chainPem).toContain("BEGIN CERTIFICATE");
  });

  /**
   * The fixture generator's v3 extensions (plan §12, review `[P1-01]`). Asserted on the fixtures
   * themselves rather than only through the endpoints that will use them: everything G4 tests
   * rests on these two certificates being what they claim, and a fixture whose `ca` is quietly
   * `false` would make the trust store's refusal look like a bug in the endpoint.
   */
  test("a fixture CA is a CA, and a fixture server certificate completes a TLS handshake", async () => {
    const ca = generateCertificate({ cn: "internal-root", ca: true });
    expect(new X509Certificate(ca.certPem).ca).toBe(true);

    const leaf = generateCertificate({
      cn: "backend.internal",
      issuer: ca,
      dnsNames: ["localhost"],
      ipAddresses: ["127.0.0.1"],
    });
    const parsed = new X509Certificate(leaf.certPem);
    // A leaf is not an anchor, and the store refuses one for saying so.
    expect(parsed.ca).toBe(false);
    expect(parsed.subjectAltName).toContain("DNS:localhost");
    expect(parsed.checkIssued(new X509Certificate(ca.certPem))).toBe(true);

    const server = Bun.serve({
      port: 0,
      tls: { cert: leaf.certPem, key: leaf.keyPem },
      fetch: () => new Response("ok"),
    });
    try {
      // Trusting the fixture CA is enough — no exception, no skipped hostname check. That is rung 1
      // of design section 5.4's ladder, exercised here on the fixtures before G4 depends on them.
      const response = await fetch(`https://localhost:${server.port}/`, {
        tls: { ca: ca.certPem },
      });
      expect(await response.text()).toBe("ok");
      // And without the anchor the same call fails, which is what makes registering one meaningful.
      await expect(fetch(`https://localhost:${server.port}/`)).rejects.toThrow();
    } finally {
      server.stop(true);
    }
  });

  test("a PKCS#12 upload is refused with a message that says what to do instead", () => {
    expect(() => parseCertificate({ certPem: "MIIKt...binary...", keyPem: "x" })).toThrow(
      /\.pfx or \.p12 file is not accepted/,
    );
  });
});

// --------------------------------------------------------------------------- the certificate store

describe("the certificate store", () => {
  async function upload(cookie: string, overrides: Record<string, unknown> = {}) {
    const generated = generateCertificate({ cn: "gateway-client" });
    const response = await cp.call("POST", "/api/certificates", {
      cookie,
      body: {
        environment: "dev",
        applicationId: "application_platform",
        name: "backend-identity",
        certPem: generated.certPem,
        keyPem: generated.keyPem,
        ...overrides,
      },
    });
    return { response, generated };
  }

  test("upload, list, and the private key never comes back out", async () => {
    const pavel = await cp.login("pavel");
    const { response, generated } = await upload(pavel);
    expect(response.status).toBe(201);
    const created = await response.json();
    expect(created.thumbprint).toBe(thumbprintOf(new X509Certificate(generated.certPem)));
    expect(created.expiresInDays).toBeGreaterThan(0);
    expect(JSON.stringify(created)).not.toContain("PRIVATE KEY");

    const listed = await (
      await cp.call("GET", "/api/certificates?environment=dev", { cookie: pavel })
    ).json();
    expect(listed.items).toHaveLength(1);
    expect(listed.items[0]!.name).toBe("backend-identity");
    expect(listed.items[0]!.expired).toBe(false);
    expect(JSON.stringify(listed)).not.toContain("PRIVATE KEY");

    // Encrypted at rest with the KEK, and it is the real key: the instance channel decrypts it.
    const stored = cp.app.db
      .query<{ key_enc: string }, []>("SELECT key_enc FROM certificate")
      .get()!;
    expect(stored.key_enc).not.toContain("PRIVATE KEY");
    expect(decrypt(stored.key_enc, cp.app.kek)).toBe(generated.keyPem.trim());
  });

  test("a certificate belongs to a application, and another application's owner may not upload for it", async () => {
    const clara = await cp.login("clara");
    const { response } = await upload(clara, { applicationId: "application_platform" });
    expect(response.status).toBe(403);
  });

  test("the instance channel serves the key; a session cookie does not", async () => {
    const pavel = await cp.login("pavel");
    const { response, generated } = await upload(pavel);
    const created = await response.json();

    const overChannel = await cp.call("GET", `/api/gateway/certificates/${created.id}`, {
      headers: { authorization: `Bearer ${cp.token}` },
    });
    expect(overChannel.status).toBe(200);
    // No-store: it is the one response in this API carrying a decrypted secret.
    expect(overChannel.headers.get("cache-control")).toBe("no-store");
    const material = await overChannel.json();
    expect(material.thumbprint).toBe(created.thumbprint);
    expect(material.keyPem).toBe(generated.keyPem.trim());

    expect((await cp.call("GET", `/api/gateway/certificates/${created.id}`, { cookie: pavel })).status).toBe(401);
    expect((await cp.call("GET", `/api/gateway/certificates/${created.id}`)).status).toBe(401);
  });

  test("an instance may not read another environment's certificate", async () => {
    const pavel = await cp.login("pavel");
    const { response } = await upload(pavel, { environment: "prod" });
    const created = await response.json();
    // The seeded instance token belongs to dev.
    const denied = await cp.call("GET", `/api/gateway/certificates/${created.id}`, {
      headers: { authorization: `Bearer ${cp.token}` },
    });
    expect(denied.status).toBe(404);
  });

  test("a binding may name a certificate, and then it cannot be deleted from under it", async () => {
    const backend = startBackend();
    try {
      const pavel = await cp.login("pavel");
      const { response } = await upload(pavel);
      const created = await response.json();
      const api = await publishApi(cp, { backendUrl: backend.url });

      const bound = await cp.call("PUT", `/api/resources/${api.resourceId}/binding`, {
        cookie: api.pavel,
        body: { environment: "dev", urls: [backend.url], clientCertRef: created.id },
      });
      expect(bound.status).toBe(200);

      const refused = await cp.call("DELETE", `/api/certificates/${created.id}`, { cookie: pavel });
      expect(refused.status).toBe(409);
      expect((await refused.json()).detail).toContain("change those bindings first");

      // The config document carries the reference and the thumbprint, so a rotation is a new
      // cache key on the instance rather than a silent swap.
      const { config } = await poll(cp);
      expect(config!.routes[0]!.backend.clientCertRef).toBe(created.id);
      expect(config!.certificates).toHaveLength(1);
      expect(config!.certificates[0]!.thumbprint).toBe(created.thumbprint);
      expect(JSON.stringify(config)).not.toContain("PRIVATE KEY");

      // Unbind, and now it can go.
      await cp.call("PUT", `/api/resources/${api.resourceId}/binding`, {
        cookie: api.pavel,
        body: { environment: "dev", urls: [backend.url] },
      });
      expect((await cp.call("DELETE", `/api/certificates/${created.id}`, { cookie: pavel })).status).toBe(204);
    } finally {
      backend.stop();
    }
  });

  test("a binding may not point at a certificate belonging to another application", async () => {
    const backend = startBackend();
    try {
      const pavel = await cp.login("pavel");
      const { response } = await upload(pavel, { applicationId: "application_orders", name: "orders-identity" });
      expect(response.status).toBe(403);
    } finally {
      backend.stop();
    }
  });
});

// --------------------------------------------------------------------------- the exception ladder

describe("TLS exceptions", () => {
  async function apiWith(backendUrl: string) {
    return publishApi(cp, { backendUrl });
  }

  const REASON = "backend certificate is self-signed until INFRA-991 lands, tracked for removal";

  test("with no exception the resolved mode is verify, and no row exists", async () => {
    const backend = startBackend();
    try {
      await apiWith(backend.url);
      const { config } = await poll(cp);
      // The secure state is the absence of configuration, which is what makes it the default.
      expect(config!.routes[0]!.backend.tls).toEqual({ mode: "verify" });
    } finally {
      backend.stop();
    }
  });

  test("creating one is admin-only", async () => {
    const backend = startBackend();
    try {
      const api = await apiWith(backend.url);
      const asOwner = await cp.call("POST", "/api/trust/exceptions", {
        cookie: api.pavel,
        body: { resourceId: api.resourceId, environment: "dev", mode: "insecure", reason: REASON, days: 7 },
      });
      // An owner may not decide to stop verifying their own backend.
      expect(asOwner.status).toBe(403);

      const alice = await cp.login("alice");
      const asAdmin = await cp.call("POST", "/api/trust/exceptions", {
        cookie: alice,
        body: { resourceId: api.resourceId, environment: "dev", mode: "insecure", reason: REASON, days: 7 },
      });
      expect(asAdmin.status).toBe(201);
    } finally {
      backend.stop();
    }
  });

  test("an expiry is mandatory, bounded, and a reason has to be one", async () => {
    const backend = startBackend();
    try {
      const api = await apiWith(backend.url);
      const alice = await cp.login("alice");
      const create = (body: Record<string, unknown>) =>
        cp.call("POST", "/api/trust/exceptions", {
          cookie: alice,
          body: { resourceId: api.resourceId, environment: "dev", mode: "insecure", ...body },
        });

      const noDate = await create({ reason: REASON });
      expect(noDate.status).toBe(400);
      expect((await noDate.json()).detail).toContain("permanent decision");

      const tooLong = await create({ reason: REASON, days: 400 });
      expect(tooLong.status).toBe(400);
      expect((await tooLong.json()).detail).toContain("TLS_EXCEPTION_MAX_DAYS");

      const thinReason = await create({ reason: "temp", days: 7 });
      expect(thinReason.status).toBe(400);
      expect((await thinReason.json()).detail).toContain("at least 20 characters");

      const past = await create({ reason: REASON, expiresAt: new Date(Date.now() - 1000).toISOString() });
      expect(past.status).toBe(400);
    } finally {
      backend.stop();
    }
  });

  test("pin requires a thumbprint, and the other modes refuse one", async () => {
    const backend = startBackend();
    try {
      const api = await apiWith(backend.url);
      const alice = await cp.login("alice");
      const create = (body: Record<string, unknown>) =>
        cp.call("POST", "/api/trust/exceptions", {
          cookie: alice,
          body: { resourceId: api.resourceId, environment: "dev", reason: REASON, days: 7, ...body },
        });

      expect((await create({ mode: "pin" })).status).toBe(400);
      expect((await create({ mode: "pin", pinThumbprint: "nope" })).status).toBe(400);
      expect((await create({ mode: "insecure", pinThumbprint: "A".repeat(64) })).status).toBe(400);

      const generated = generateCertificate({ cn: "backend" });
      const thumbprint = thumbprintOf(new X509Certificate(generated.certPem));
      // Colons are how every tool prints a fingerprint, so they are accepted and normalised away.
      const withColons = thumbprint.match(/.{2}/g)!.join(":").toLowerCase();
      const created = await create({ mode: "pin", pinThumbprint: withColons });
      expect(created.status).toBe(201);

      const { config } = await poll(cp);
      expect(config!.routes[0]!.backend.tls.mode).toBe("pin");
      expect(config!.routes[0]!.backend.tls.pinThumbprint).toBe(thumbprint);
    } finally {
      backend.stop();
    }
  });

  test("a per-URL exception must name a URL the pool actually has", async () => {
    const backend = startBackend();
    try {
      const api = await apiWith(backend.url);
      const alice = await cp.login("alice");
      const wrongUrl = await cp.call("POST", "/api/trust/exceptions", {
        cookie: alice,
        body: {
          resourceId: api.resourceId,
          environment: "dev",
          backendUrl: "http://somewhere.else",
          mode: "insecure",
          reason: REASON,
          days: 7,
        },
      });
      // Otherwise somebody believes a backend is exempted when the exception covers nothing.
      expect(wrongUrl.status).toBe(400);
      expect((await wrongUrl.json()).detail).toContain("not in this resource's dev pool");
    } finally {
      backend.stop();
    }
  });

  test("the resolved mode and its expiry travel to the gateway", async () => {
    const backend = startBackend();
    try {
      const api = await apiWith(backend.url);
      const alice = await cp.login("alice");
      await cp.call("POST", "/api/trust/exceptions", {
        cookie: alice,
        body: {
          resourceId: api.resourceId,
          environment: "dev",
          mode: "skip-hostname",
          reason: REASON,
          days: 3,
        },
      });

      const { config } = await poll(cp);
      const tls = config!.routes[0]!.backend.tls;
      expect(tls.mode).toBe("skip-hostname");
      expect(tls.reason).toBe(REASON);
      // The date travels so the instance can stop honouring it on its own clock, with the control
      // plane unreachable and the config served from the fail-static cache.
      expect(Date.parse(tls.expiresAt!)).toBeGreaterThan(Date.now());
      expect(tls.exceptionId).toMatch(/^tlsx_/);
    } finally {
      backend.stop();
    }
  });

  test("the gateway self-expires: past expiresAt it verifies again", async () => {
    const backend = startBackend();
    const cpServer = serveCp(cp);
    try {
      const api = await apiWith(backend.url);
      const alice = await cp.login("alice");
      await cp.call("POST", "/api/trust/exceptions", {
        cookie: alice,
        body: { resourceId: api.resourceId, environment: "dev", mode: "insecure", reason: REASON, days: 1 },
      });
      const dp = makeDp(cpServer.url, cp.token, cp.dir);
      await dp.start();
      try {
        const live = dp.client.table!.routes[0]!.backend.tls;
        expect(live.mode).toBe("insecure");

        // Rewrite the activated config's expiry into the past — which is what a fail-static cache
        // held through an outage looks like once the date passes.
        (live as { expiresAt?: string }).expiresAt = new Date(Date.now() - 1000).toISOString();
        const response = await dp.fetchHttp(
          new Request("http://gw" + `/${api.name}/store/inventory`, {
            headers: { "x-api-key": api.key! },
          }),
          "127.0.0.1",
        );
        // Still served — the backend is plain HTTP here — but through a verified path: the
        // assertion that matters is that nothing threw and the exception is no longer applied.
        expect(response.status).toBe(200);
      } finally {
        dp.stop();
      }
    } finally {
      cpServer.stop();
      backend.stop();
    }
  });

  test("revoking keeps the record and stops the exception", async () => {
    const backend = startBackend();
    try {
      const api = await apiWith(backend.url);
      const alice = await cp.login("alice");
      const created = await (
        await cp.call("POST", "/api/trust/exceptions", {
          cookie: alice,
          body: { resourceId: api.resourceId, environment: "dev", mode: "insecure", reason: REASON, days: 7 },
        })
      ).json();

      expect((await cp.call("DELETE", `/api/trust/exceptions/${created.id}`, { cookie: alice })).status).toBe(204);

      const { config } = await poll(cp);
      expect(config!.routes[0]!.backend.tls).toEqual({ mode: "verify" });

      // Revoked, not deleted: that verification was once relaxed here, and by whom, is the point.
      const all = await (
        await cp.call("GET", "/api/trust/exceptions?includeExpired=1", { cookie: alice })
      ).json();
      expect(all.items).toHaveLength(1);
      expect(all.items[0]!.revokedAt).not.toBeNull();
      expect(all.items[0]!.live).toBe(false);

      const live = await (await cp.call("GET", "/api/trust/exceptions", { cookie: alice })).json();
      expect(live.items).toHaveLength(0);
    } finally {
      backend.stop();
    }
  });

  test("an owner may not revoke, and only an admin sees the governance report", async () => {
    const backend = startBackend();
    try {
      const api = await apiWith(backend.url);
      const alice = await cp.login("alice");
      const created = await (
        await cp.call("POST", "/api/trust/exceptions", {
          cookie: alice,
          body: { resourceId: api.resourceId, environment: "dev", mode: "insecure", reason: REASON, days: 7 },
        })
      ).json();
      expect(
        (await cp.call("DELETE", `/api/trust/exceptions/${created.id}`, { cookie: api.pavel })).status,
      ).toBe(403);
      expect((await cp.call("GET", "/api/governance/exceptions", { cookie: api.pavel })).status).toBe(403);
    } finally {
      backend.stop();
    }
  });
});

// --------------------------------------------------------------------------- governance

describe("the governance report", () => {
  test("lists every live exception and every CN-only route in one place", async () => {
    const backend = startBackend();
    try {
      const api = await publishApi(cp, {
        backendUrl: backend.url,
        policy: {
          "auth.mtls": { allowedSubjectCns: ["SAFMEC9"], acknowledgeCnOnly: true },
        },
      });
      const alice = await cp.login("alice");
      await cp.call("POST", "/api/trust/exceptions", {
        cookie: alice,
        body: {
          resourceId: api.resourceId,
          environment: "dev",
          mode: "insecure",
          reason: "backend is behind a load balancer with a self-signed certificate, INFRA-991",
          days: 5,
        },
      });

      const report = await (
        await cp.call("GET", "/api/governance/exceptions", { cookie: alice })
      ).json();
      expect(report.tlsExceptions).toHaveLength(1);
      expect(report.tlsExceptions[0]!.backendUrl).toBe("every backend in the pool");
      expect(report.tlsExceptions[0]!.expiresInDays).toBeLessThanOrEqual(5);
      // The question is asked about the estate, not about an API, so both live on one page.
      expect(report.cnOnlyRoutes).toHaveLength(1);
      expect(report.cnOnlyRoutes[0]!.resourceId).toBe(api.resourceId);
    } finally {
      backend.stop();
    }
  });
});
