import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { makeCp, publishApi, type TestCp } from "./helpers.ts";
import { generateCertificate } from "./x509.ts";
import { buildConfig } from "../control-plane/src/config-build.ts";

/**
 * Renewing a client certificate in place.
 *
 * The property the endpoint exists for: the id does not change, so every binding that names it
 * keeps working and nothing has to be re-approved — while the *thumbprint* does change, so the
 * configuration document changes and the gateways fetch the new material rather than serving the
 * old one until something restarts.
 *
 * The refusals matter as much: a renewal that quietly swapped the identity a route presents to its
 * backend would be the one change on this screen nobody could see afterwards.
 */
let cp: TestCp;

beforeEach(() => {
  cp = makeCp();
});
afterEach(() => {
  cp.close();
});

async function call(method: string, path: string, user: string, body?: unknown) {
  return cp.call(method, path, { cookie: await cp.login(user), body });
}

const YEAR = 365 * 86_400_000;

/** The identity, and a later certificate for the same one. */
function identity(cn: string, years: number) {
  return generateCertificate({
    cn,
    notBefore: new Date(Date.now() - 3_600_000),
    notAfter: new Date(Date.now() + years * YEAR),
  });
}

async function upload(name: string, cert: { certPem: string; keyPem: string }) {
  const response = await call("POST", "/api/certificates", "pavel", {
    environment: "dev",
    applicationId: "application_platform",
    name,
    certPem: cert.certPem,
    keyPem: cert.keyPem,
  });
  expect(response.status).toBe(201);
  return response.json();
}

function certificateRow(id: string) {
  return cp.app.db
    .query<{ thumbprint: string; not_after: string; subject: string; key_enc: string }, [string]>(
      "SELECT thumbprint, not_after, subject, key_enc FROM certificate WHERE id = ?",
    )
    .get(id)!;
}

describe("renewing a certificate", () => {
  test("keeps the id and the name, and changes the material", async () => {
    const first = identity("orders-client", 1);
    const uploaded = await upload("orders-client", first);
    const before = certificateRow(uploaded.id);

    const second = identity("orders-client", 3);
    const response = await call("POST", `/api/certificates/${uploaded.id}/renew`, "pavel", {
      certPem: second.certPem,
      keyPem: second.keyPem,
    });
    expect(response.status).toBe(200);
    const body = await response.json();

    expect(body.id).toBe(uploaded.id);
    expect(body.name).toBe("orders-client");
    expect(body.previousThumbprint).toBe(before.thumbprint);
    expect(body.thumbprint).not.toBe(before.thumbprint);

    const after = certificateRow(uploaded.id);
    expect(after.thumbprint).toBe(body.thumbprint);
    expect(Date.parse(after.not_after)).toBeGreaterThan(Date.parse(before.not_after));
    // The key is replaced too, and is still encrypted at rest rather than stored as the PEM.
    expect(after.key_enc).not.toBe(before.key_enc);
    expect(after.key_enc).not.toContain("BEGIN");
  });

  test("a binding that names it keeps working, and the gateways see new material", async () => {
    const published = await publishApi(cp, { name: "renew-api", backendUrl: "http://127.0.0.1:9999", subscribe: false });
    const first = identity("renew-client", 1);
    const uploaded = await upload("renew-client", first);

    const bound = await call("PUT", `/api/resources/${published.resourceId}/binding`, "pavel", {
      environment: "dev",
      urls: ["http://127.0.0.1:9999"],
      clientCertRef: uploaded.id,
    });
    expect(bound.status).toBe(200);

    const before = buildConfig(cp.app.db, cp.app.kek, "dev", cp.app.config.integrations);
    const listedBefore = before.certificates.find((c) => c.id === uploaded.id)!;
    expect(listedBefore).toBeDefined();

    const second = identity("renew-client", 3);
    const renewed = await call("POST", `/api/certificates/${uploaded.id}/renew`, "pavel", {
      certPem: second.certPem,
      keyPem: second.keyPem,
    });
    expect(renewed.status).toBe(200);
    // The binding was never touched, and it still names the same certificate.
    expect((await renewed.json()).usedBy.map((u: { resourceId: string }) => u.resourceId)).toContain(
      published.resourceId,
    );

    const after = buildConfig(cp.app.db, cp.app.kek, "dev", cp.app.config.integrations);
    const listedAfter = after.certificates.find((c) => c.id === uploaded.id)!;
    expect(listedAfter.id).toBe(listedBefore.id);
    // A new thumbprint under the same id: a new cache entry the gateway has to fetch before it can
    // activate, which is exactly what makes this a rotation rather than a silent swap.
    expect(listedAfter.thumbprint).not.toBe(listedBefore.thumbprint);
    expect(after.digest).not.toBe(before.digest);
  });

  test("refuses a certificate for a different identity", async () => {
    const uploaded = await upload("subject-client", identity("subject-client", 1));
    const other = identity("somebody-else", 3);
    const response = await call("POST", `/api/certificates/${uploaded.id}/renew`, "pavel", {
      certPem: other.certPem,
      keyPem: other.keyPem,
    });
    expect(response.status).toBe(409);
    const { detail } = await response.json();
    // Both subjects on the screen, and the way out named: this is the message somebody reads at
    // 3 a.m. holding the wrong file.
    expect(detail).toContain("subject-client");
    expect(detail).toContain("somebody-else");
    expect(detail).toContain("new certificate");
  });

  test("refuses the certificate that is already installed", async () => {
    const same = identity("same-client", 1);
    const uploaded = await upload("same-client", same);
    const response = await call("POST", `/api/certificates/${uploaded.id}/renew`, "pavel", {
      certPem: same.certPem,
      keyPem: same.keyPem,
    });
    expect(response.status).toBe(409);
    expect((await response.json()).detail).toContain("nothing would change");
  });

  test("refuses one that does not extend the runway, and one that has already expired", async () => {
    const uploaded = await upload("runway-client", identity("runway-client", 3));

    const shorter = identity("runway-client", 1);
    const short = await call("POST", `/api/certificates/${uploaded.id}/renew`, "pavel", {
      certPem: shorter.certPem,
      keyPem: shorter.keyPem,
    });
    expect(short.status).toBe(409);
    expect((await short.json()).detail).toContain("extend the runway");

    const dead = generateCertificate({
      cn: "runway-client",
      notBefore: new Date(Date.now() - 2 * YEAR),
      notAfter: new Date(Date.now() - YEAR),
    });
    const expired = await call("POST", `/api/certificates/${uploaded.id}/renew`, "pavel", {
      certPem: dead.certPem,
      keyPem: dead.keyPem,
    });
    expect(expired.status).toBe(400);

    // Neither refusal touched the installed material.
    expect(certificateRow(uploaded.id).thumbprint).toBe(uploaded.thumbprint);
  });

  test("only the owning application, or an administrator, may renew", async () => {
    const uploaded = await upload("owned-client", identity("owned-client", 1));
    const next = identity("owned-client", 3);

    const outsider = await call("POST", `/api/certificates/${uploaded.id}/renew`, "clara", {
      certPem: next.certPem,
      keyPem: next.keyPem,
    });
    expect(outsider.status).toBe(403);
    expect(certificateRow(uploaded.id).thumbprint).toBe(uploaded.thumbprint);

    const admin = await call("POST", `/api/certificates/${uploaded.id}/renew`, "alice", {
      certPem: next.certPem,
      keyPem: next.keyPem,
    });
    expect(admin.status).toBe(200);
  });

  test("the audit says which material replaced which, and carries no key", async () => {
    const uploaded = await upload("audited-client", identity("audited-client", 1));
    const next = identity("audited-client", 3);
    await call("POST", `/api/certificates/${uploaded.id}/renew`, "pavel", {
      certPem: next.certPem,
      keyPem: next.keyPem,
    });

    const row = cp.app.db
      .query<{ detail: string }, [string]>(
        "SELECT detail FROM audit WHERE action='certificate.renew' AND subject=?",
      )
      .get(`certificate:${uploaded.id}`)!;
    const detail = JSON.parse(row.detail);
    expect(detail.from.thumbprint).toBe(uploaded.thumbprint);
    expect(detail.to.thumbprint).not.toBe(uploaded.thumbprint);
    expect(row.detail).not.toContain("BEGIN");
  });

  test("a certificate that does not exist is a 404, not a silent create", async () => {
    const next = identity("ghost", 1);
    const response = await call("POST", "/api/certificates/cert_nothing/renew", "pavel", {
      certPem: next.certPem,
      keyPem: next.keyPem,
    });
    expect(response.status).toBe(404);
  });
});

