import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { assertAuthConfig, loadConfig, type OidcConfig } from "../control-plane/src/config.ts";
import {
  mapGroupsToTeams,
  resetOidcCaches,
  safeReturnTo,
} from "../control-plane/src/auth-oidc.ts";
import { membershipsOf, principalBySubject } from "../control-plane/src/principals.ts";
import { makeCp, ORIGIN, type TestCp } from "./helpers.ts";
import { startStubIdp, type StubIdp } from "./idp-stub.ts";

/**
 * The OIDC provider (v5 plan §5.4), against a real identity provider running in this process.
 *
 * The fixture signs with a real RSA key and enforces PKCE itself, which matters: the argument for
 * verifying the `id_token` (D34) is only worth making if a token that does not verify is actually
 * refused, and that cannot be demonstrated against a stub that says yes to everything.
 */

let idp: StubIdp;
const worlds: TestCp[] = [];

function oidcCp(oidcOverrides: Partial<OidcConfig> = {}, overrides: Record<string, unknown> = {}): TestCp {
  const cp = makeCp({
    authProviders: ["oidc"],
    oidc: idp.oidcConfig(ORIGIN, oidcOverrides),
    ...overrides,
  });
  worlds.push(cp);
  return cp;
}

function team(cp: TestCp, id: string, name: string, sourceGroup: string | null): void {
  cp.app.db.run("INSERT INTO team (id, name, source_group) VALUES (?, ?, ?)", [id, name, sourceGroup]);
}

interface FlowResult {
  location: string;
  flowCookie: string;
  state: string;
  callback: Response;
  session: string | null;
}

/** The whole redirect dance, played the way a browser would play it. */
async function signInThroughIdp(cp: TestCp, options: { returnTo?: string } = {}): Promise<FlowResult> {
  const start = await cp.call(
    "GET",
    options.returnTo ? `/auth/login?return=${encodeURIComponent(options.returnTo)}` : "/auth/login",
  );
  expect(start.status).toBe(302);
  const location = start.headers.get("location")!;
  const flowCookie = (start.headers.getSetCookie()[0] ?? "").split(";")[0]!;
  const { code, state } = idp.authorize(location);
  const callback = await cp.call("GET", `/auth/callback?code=${code}&state=${state}`, {
    cookie: flowCookie,
  });
  const session =
    callback.headers
      .getSetCookie()
      .find((c) => c.startsWith("apim_session="))
      ?.split(";")[0] ?? null;
  return { location, flowCookie, state, callback, session };
}

async function problemOf(response: Response): Promise<{ status: number; code?: string; detail: string }> {
  const body = (await response.json()) as { code?: string; detail: string };
  return { status: response.status, code: body.code, detail: body.detail };
}

beforeEach(() => {
  resetOidcCaches();
  idp = startStubIdp();
});

afterEach(() => {
  for (const cp of worlds.splice(0)) cp.close();
  idp.stop();
});

describe("starting a sign-in", () => {
  test("redirects to the authorization endpoint with PKCE, state and a nonce", async () => {
    const cp = oidcCp();
    const start = await cp.call("GET", "/auth/login");
    expect(start.status).toBe(302);

    const url = new URL(start.headers.get("location")!);
    expect(url.origin).toBe(idp.issuer);
    expect(url.pathname).toBe("/authorize");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe(idp.clientId);
    expect(url.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/auth/callback`);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBeTruthy();
    expect(url.searchParams.get("state")).toBeTruthy();
    expect(url.searchParams.get("nonce")).toBeTruthy();

    // The verifier and the nonce stay server-side, in `auth_flow`. Neither is in the cookie, and
    // neither is anywhere a browser extension could read it.
    const cookie = start.headers.getSetCookie()[0]!;
    const stateValue = url.searchParams.get("state")!;
    expect(cookie).toContain(`apim_authflow=${stateValue}`);
    expect(cookie).toContain("HttpOnly");
    // Needed on exactly one request, so it is scoped to exactly one path `[P1-09]`.
    expect(cookie).toContain("Path=/auth/callback");
    expect(cookie).toContain("Max-Age=120");

    const flow = cp.app.db
      .query<{ code_verifier: string; nonce: string }, [string]>(
        "SELECT code_verifier, nonce FROM auth_flow WHERE state = ?",
      )
      .get(stateValue)!;
    expect(flow.code_verifier).toBeTruthy();
    expect(cookie).not.toContain(flow.code_verifier);
    expect(flow.nonce).toBe(url.searchParams.get("nonce")!);
  });

  test("a discovery document that declares a different issuer is refused", async () => {
    idp.stop();
    idp = startStubIdp({ declaredIssuer: "https://someone-elses-issuer.example" });
    const cp = oidcCp();
    const problem = await problemOf(await cp.call("GET", "/auth/login"));
    expect(problem.status).toBe(502);
    // Every `iss` check downstream would otherwise be against a value nobody configured.
    expect(problem.detail).toContain("someone-elses-issuer.example");
  });

  test("an endpoint the document names outside the egress allowlist is refused", async () => {
    // The issuer being allowed says nothing about where its document points the token exchange.
    idp.stop();
    idp = startStubIdp({ discoveryExtras: { token_endpoint: "https://metadata.example.internal/token" } });
    const cp = oidcCp();
    const problem = await problemOf(await cp.call("GET", "/auth/login"));
    expect(problem.status).toBe(502);
    expect(problem.detail).toContain("token_endpoint");
    expect(problem.detail).toContain("egress allowlist");
  });

  test("the identity provider is not contacted at boot", async () => {
    // A control plane that would not start while Keycloak restarts is an availability coupling
    // nobody asked for `[P1-15]`: the issuer string is checked, the network is not touched.
    const { assertIssuerAllowed } = await import("../control-plane/src/config.ts");
    const cp = oidcCp();
    idp.stop();
    await assertIssuerAllowed(cp.app.config);
    // And it still starts. Restarted below so `afterEach` has something to stop.
    idp = startStubIdp();
  });
});

describe("the callback", () => {
  test("a full sign-in creates the principal, the session and the mapped memberships", async () => {
    const cp = oidcCp();
    team(cp, "team_platform", "Platform APIs", "SG-APIM-PLATFORM");
    idp.claims.groups = ["SG-APIM-PLATFORM"];

    const { callback, session } = await signInThroughIdp(cp);
    expect(callback.status).toBe(302);
    expect(callback.headers.get("location")).toBe("/");
    expect(session).toMatch(/^apim_session=ses_/);

    const row = principalBySubject(cp.app.db, "oidc", "keycloak-subject-1")!;
    expect(row.username).toBe("pavel");
    expect(row.email).toBe("pavel@example.test");
    expect(row.created_by).toBe("oidc-auto-create");
    // `role` is what an admin authored here; `idp_admin` is what the token said. They are separate
    // columns so a local grant and a directory grant cannot overwrite each other.
    expect(row.role).toBe("member");
    expect(row.idp_admin).toBe(1);

    const memberships = membershipsOf(cp.app.db, row.id);
    expect(memberships.map((m) => [m.teamId, m.source])).toEqual([["team_platform", "idp"]]);

    const me = (await (await cp.call("GET", "/api/me", { cookie: session! })).json()) as {
      user: { isAdmin: boolean; provider: string; adminFrom: string };
      unmappedGroups: string[];
    };
    expect(me.user.isAdmin).toBe(true);
    expect(me.user.provider).toBe("oidc");
    expect(me.user.adminFrom).toBe("idp");
    expect(me.unmappedGroups).toEqual([]);

    // The flow row is gone, so the code cannot be exchanged twice.
    expect(cp.app.db.query("SELECT COUNT(*) AS n FROM auth_flow").get()).toEqual({ n: 0 });
    // The access token is not stored at all `[P1-06]`; only the refresh token, encrypted.
    const stored = cp.app.db
      .query<{ refresh_token_enc: string | null }, []>("SELECT refresh_token_enc FROM session")
      .get()!;
    expect(stored.refresh_token_enc).toBeTruthy();
    expect(stored.refresh_token_enc).not.toContain(idp.refreshTokens.at(-1)!);
  });

  test("the token exchange really carries the PKCE verifier", async () => {
    const cp = oidcCp();
    await signInThroughIdp(cp);
    const exchange = idp.tokenRequests.find((r) => r.grant_type === "authorization_code")!;
    expect(exchange.code_verifier).toBeTruthy();
    expect(exchange.redirect_uri).toBe(`${ORIGIN}/auth/callback`);
    // The stub hashes it and compares; a wrong verifier answers `invalid_grant`, so reaching a
    // session at all is the assertion.
    expect(exchange.client_id).toBe(idp.clientId);
  });

  test("a callback that did not start in this browser is refused", async () => {
    const cp = oidcCp();
    const start = await cp.call("GET", "/auth/login");
    const { code, state } = idp.authorize(start.headers.get("location")!);

    // The attack: somebody completes their own sign-in and feeds the victim the resulting code.
    // Without the victim's browser holding the matching state cookie there is nothing to bind to.
    const noCookie = await problemOf(
      await cp.call("GET", `/auth/callback?code=${code}&state=${state}`),
    );
    expect(noCookie.status).toBe(400);
    expect(noCookie.code).toBe("state_mismatch");

    const wrongCookie = await problemOf(
      await cp.call("GET", `/auth/callback?code=${code}&state=${state}`, {
        cookie: "apim_authflow=some-other-flow",
      }),
    );
    expect(wrongCookie.code).toBe("state_mismatch");
  });

  test("a replayed callback cannot exchange the same code twice", async () => {
    const cp = oidcCp();
    const start = await cp.call("GET", "/auth/login");
    const flowCookie = (start.headers.getSetCookie()[0] ?? "").split(";")[0]!;
    const { code, state } = idp.authorize(start.headers.get("location")!);
    const path = `/auth/callback?code=${code}&state=${state}`;

    expect((await cp.call("GET", path, { cookie: flowCookie })).status).toBe(302);
    // The flow row is deleted *before* the exchange, so the second attempt never reaches the
    // identity provider at all.
    const replay = await problemOf(await cp.call("GET", path, { cookie: flowCookie }));
    expect(replay.code).toBe("state_mismatch");
    expect(idp.tokenRequests.filter((r) => r.grant_type === "authorization_code")).toHaveLength(1);
  });

  test("an expired flow is refused rather than exchanged late", async () => {
    const cp = oidcCp();
    const start = await cp.call("GET", "/auth/login");
    const flowCookie = (start.headers.getSetCookie()[0] ?? "").split(";")[0]!;
    const { code, state } = idp.authorize(start.headers.get("location")!);
    cp.app.db.run("UPDATE auth_flow SET expires_at = ? WHERE state = ?", [
      new Date(Date.now() - 1000).toISOString(),
      state,
    ]);
    const problem = await problemOf(
      await cp.call("GET", `/auth/callback?code=${code}&state=${state}`, { cookie: flowCookie }),
    );
    expect(problem.code).toBe("state_mismatch");
  });

  test("the identity provider's own error is passed through in its own words", async () => {
    const cp = oidcCp();
    const problem = await problemOf(
      await cp.call(
        "GET",
        "/auth/callback?error=invalid_redirect_uri&error_description=Invalid%20parameter",
      ),
    );
    expect(problem.status).toBe(400);
    expect(problem.code).toBe("idp_error");
    // Most "the callback is broken" reports are a mis-registered redirect URI, and the provider
    // has already said so. Swallowing that sends the operator looking in the wrong place.
    expect(problem.detail).toContain("invalid_redirect_uri");
    expect(problem.detail).toContain("Invalid parameter");
  });

  test("a token response with no id_token has no identity in it", async () => {
    const cp = oidcCp();
    idp.omitIdToken = true;
    const start = await cp.call("GET", "/auth/login");
    const flowCookie = (start.headers.getSetCookie()[0] ?? "").split(";")[0]!;
    const { code, state } = idp.authorize(start.headers.get("location")!);
    const problem = await problemOf(
      await cp.call("GET", `/auth/callback?code=${code}&state=${state}`, { cookie: flowCookie }),
    );
    expect(problem.code).toBe("no_id_token");
  });

  test("a `return` outside this origin is dropped", async () => {
    const cp = oidcCp();
    const { callback } = await signInThroughIdp(cp, { returnTo: "https://evil.test/steal" });
    expect(callback.headers.get("location")).toBe("/");

    const inside = await signInThroughIdp(cp, { returnTo: "/catalog/api_1" });
    expect(inside.callback.headers.get("location")).toBe("/catalog/api_1");
  });
});

describe("the open-redirect guard", () => {
  test("only a path on this origin survives", () => {
    expect(safeReturnTo("/catalog")).toBe("/catalog");
    expect(safeReturnTo("/a/b?c=d#e")).toBe("/a/b?c=d#e");
    expect(safeReturnTo(null)).toBe("/");
    expect(safeReturnTo("")).toBe("/");
    expect(safeReturnTo("https://evil.test")).toBe("/");
    expect(safeReturnTo("//evil.test")).toBe("/");
    // Not theoretical: some browsers normalise a leading `/\` to `//` `[P1-08]`.
    expect(safeReturnTo("/\\evil.test")).toBe("/");
    // A control character in a Location header is header injection.
    expect(safeReturnTo("/ok\r\nSet-Cookie: apim_session=stolen")).toBe("/");
    expect(safeReturnTo("/ok ")).toBe("/");
  });
});

describe("verifying the id_token", () => {
  /** Every rejection below must be indistinguishable to the browser: it can do nothing with the
   *  difference, and the difference is in the log. */
  async function refusalWith(cp: TestCp, mutate: () => void) {
    const start = await cp.call("GET", "/auth/login");
    const flowCookie = (start.headers.getSetCookie()[0] ?? "").split(";")[0]!;
    const { code, state } = idp.authorize(start.headers.get("location")!);
    mutate();
    return problemOf(
      await cp.call("GET", `/auth/callback?code=${code}&state=${state}`, { cookie: flowCookie }),
    );
  }

  test("a signature from a key the JWKS does not carry is refused", async () => {
    const cp = oidcCp();
    const problem = await refusalWith(cp, () => {
      idp.signWithWrongKey = true;
    });
    expect(problem.status).toBe(401);
    expect(problem.code).toBe("id_token_rejected");
    expect(cp.app.db.query("SELECT COUNT(*) AS n FROM session").get()).toEqual({ n: 0 });
  });

  test("a token for another audience is refused", async () => {
    const cp = oidcCp();
    const problem = await refusalWith(cp, () => {
      idp.claims.aud = "some-other-client";
    });
    expect(problem.code).toBe("id_token_rejected");
  });

  test("a token from another issuer is refused", async () => {
    const cp = oidcCp();
    const problem = await refusalWith(cp, () => {
      idp.claims.iss = "https://not-this-issuer.example";
    });
    expect(problem.code).toBe("id_token_rejected");
  });

  test("an expired token is refused", async () => {
    const cp = oidcCp();
    const problem = await refusalWith(cp, () => {
      idp.claims.exp = Math.floor(Date.now() / 1000) - 3600;
    });
    expect(problem.code).toBe("id_token_rejected");
  });

  test("a token whose nonce is not the one this sign-in sent is refused", async () => {
    const cp = oidcCp();
    const problem = await refusalWith(cp, () => {
      idp.claims.nonce = "a-nonce-from-some-other-sign-in";
    });
    expect(problem.code).toBe("id_token_rejected");
  });

  test("a token with no sub is refused", async () => {
    const cp = oidcCp();
    const problem = await refusalWith(cp, () => {
      idp.claims.sub = "";
    });
    expect(problem.code).toBe("id_token_rejected");
  });
});

describe("claims become roles and teams", () => {
  test("groups map to teams by source_group, by full path or last segment", async () => {
    const cp = oidcCp();
    team(cp, "team_platform", "Platform APIs", "SG-APIM-PLATFORM");
    team(cp, "team_orders", "Orders", "orders");
    team(cp, "team_unmapped", "No Group", null);

    // Keycloak's group mapper emits full paths; directory exports are not careful about case.
    const mapped = mapGroupsToTeams(cp.app.db, [
      "sg-apim-platform",
      "/company/apim/orders",
      "  ",
      "SG-SOMETHING-ELSE",
    ]);
    expect(mapped.teamIds.sort()).toEqual(["team_orders", "team_platform"]);
    // Matched, never created: a directory that invented teams would let anybody holding a group
    // become the owner of a new scope.
    expect(mapped.unmapped).toEqual(["SG-SOMETHING-ELSE"]);
    expect(cp.app.db.query("SELECT COUNT(*) AS n FROM team").get()).toEqual({ n: 3 });
  });

  test("an unmapped group is reported to the user rather than swallowed", async () => {
    const cp = oidcCp();
    team(cp, "team_platform", "Platform APIs", "SG-APIM-PLATFORM");
    idp.claims.groups = ["SG-APIM-PLATFORM", "SG-NOBODY-MAPPED"];
    const { session } = await signInThroughIdp(cp);
    const me = (await (await cp.call("GET", "/api/me", { cookie: session! })).json()) as {
      unmappedGroups: string[];
    };
    expect(me.unmappedGroups).toEqual(["SG-NOBODY-MAPPED"]);
  });

  test("a locally granted membership survives a sync that has never heard of the team", async () => {
    const cp = oidcCp({ claimsRefreshSec: 0 });
    team(cp, "team_platform", "Platform APIs", "SG-APIM-PLATFORM");
    team(cp, "team_local", "Granted Here", null);
    idp.claims.groups = ["SG-APIM-PLATFORM"];
    const { session } = await signInThroughIdp(cp);

    const row = principalBySubject(cp.app.db, "oidc", "keycloak-subject-1")!;
    cp.app.db.run(
      "INSERT INTO membership (team_id, user_id, source, granted_by, granted_at) VALUES (?, ?, 'local', 'admin', ?)",
      ["team_local", row.id, new Date().toISOString()],
    );

    // The directory now says the platform group is gone. The IdP-derived row goes with it; the
    // locally granted one is a decision somebody made here and is not the sync's to undo (D33).
    idp.claims.groups = [];
    expect((await cp.call("GET", "/api/me", { cookie: session! })).status).toBe(200);

    const after = membershipsOf(cp.app.db, row.id);
    expect(after.map((m) => [m.teamId, m.source])).toEqual([["team_local", "local"]]);
  });

  test("losing the admin role in the directory takes effect at the next re-read", async () => {
    const cp = oidcCp({ claimsRefreshSec: 0 });
    const { session } = await signInThroughIdp(cp);
    const meBefore = (await (await cp.call("GET", "/api/me", { cookie: session! })).json()) as {
      user: { isAdmin: boolean };
    };
    expect(meBefore.user.isAdmin).toBe(true);

    idp.claims.realm_access = { roles: ["default-roles"] };
    const meAfter = (await (await cp.call("GET", "/api/me", { cookie: session! })).json()) as {
      user: { isAdmin: boolean; adminFrom: string | null };
    };
    expect(meAfter.user.isAdmin).toBe(false);
    expect(meAfter.user.adminFrom).toBeNull();
  });

  test("an admin role granted here outlives an identity provider that never said so", async () => {
    const cp = oidcCp({ claimsRefreshSec: 0 });
    idp.claims.realm_access = { roles: ["default-roles"] };
    const { session } = await signInThroughIdp(cp);
    const row = principalBySubject(cp.app.db, "oidc", "keycloak-subject-1")!;
    cp.app.db.run("UPDATE principal SET role = 'admin' WHERE id = ?", [row.id]);

    // Two columns, one OR: the claim re-read writes `idp_admin` and never touches `role`, so this
    // grant is not silently wiped by the next refresh.
    const me = (await (await cp.call("GET", "/api/me", { cookie: session! })).json()) as {
      user: { isAdmin: boolean; adminFrom: string };
    };
    expect(me.user.isAdmin).toBe(true);
    expect(me.user.adminFrom).toBe("local");
  });
});

describe("who is allowed to arrive", () => {
  test("auto-create off refuses by naming the subject an admin has to pre-create", async () => {
    const cp = oidcCp({ autoCreate: false });
    const start = await cp.call("GET", "/auth/login");
    const flowCookie = (start.headers.getSetCookie()[0] ?? "").split(";")[0]!;
    const { code, state } = idp.authorize(start.headers.get("location")!);
    const problem = await problemOf(
      await cp.call("GET", `/auth/callback?code=${code}&state=${state}`, { cookie: flowCookie }),
    );
    expect(problem.status).toBe(403);
    expect(problem.code).toBe("no_such_principal");
    expect(problem.detail).toContain("keycloak-subject-1");
  });

  test("a principal disabled here cannot sign in, however healthy the directory is", async () => {
    const cp = oidcCp();
    await signInThroughIdp(cp);
    const row = principalBySubject(cp.app.db, "oidc", "keycloak-subject-1")!;
    cp.app.db.run("UPDATE principal SET disabled_at = ? WHERE id = ?", [
      new Date().toISOString(),
      row.id,
    ]);

    const second = await signInThroughIdp(cp);
    expect(second.callback.status).toBe(403);
    expect(second.session).toBeNull();
    // The local kill switch is worth having precisely because a deployment's own offboarding is
    // sometimes faster than the directory's, so it is recorded as a refusal rather than a slip.
    const audit = cp.app.db
      .query<{ detail: string }, []>(
        "SELECT detail FROM audit WHERE action = 'auth.login-failed' ORDER BY at DESC",
      )
      .get()!;
    expect(JSON.parse(audit.detail).why).toBe("account disabled here");
  });
});

describe("re-reading the claims", () => {
  test("a dead refresh token ends the session and says so in a code the SPA knows", async () => {
    const cp = oidcCp({ claimsRefreshSec: 0 });
    const { session } = await signInThroughIdp(cp);
    idp.tokenFailure = { status: 400, body: { error: "invalid_grant" } };

    const problem = await problemOf(await cp.call("GET", "/api/me", { cookie: session! }));
    expect(problem.status).toBe(401);
    expect(problem.code).toBe("session_expired");

    const row = cp.app.db
      .query<{ revoked_at: string | null }, []>("SELECT revoked_at FROM session")
      .get()!;
    expect(row.revoked_at).not.toBeNull();
  });

  test("a provider outage does not sign the estate out", async () => {
    const cp = oidcCp({ claimsRefreshSec: 0 });
    const { session } = await signInThroughIdp(cp);
    idp.tokenFailure = { status: 503, body: { error: "temporarily_unavailable" } };

    const problem = await problemOf(await cp.call("GET", "/api/me", { cookie: session! }));
    expect(problem.status).toBe(503);
    expect(problem.code).toBe("auth_backend_unavailable");

    // The session is untouched, so the moment the provider is back the user carries on. Conflating
    // this with the 4xx above is how a provider hiccup becomes a fleet-wide sign-out.
    const row = cp.app.db
      .query<{ revoked_at: string | null }, []>("SELECT revoked_at FROM session")
      .get()!;
    expect(row.revoked_at).toBeNull();

    idp.tokenFailure = null;
    expect((await cp.call("GET", "/api/me", { cookie: session! })).status).toBe(200);
  });

  test("concurrent requests on one session refresh once, not once each", async () => {
    // Keycloak rotates the refresh token on every use, so two racing refreshes would leave the
    // loser holding a token the provider has already invalidated — and it would then destroy a
    // session that is perfectly alive.
    const cp = oidcCp({ claimsRefreshSec: 0 });
    const { session } = await signInThroughIdp(cp);
    const before = idp.tokenRequests.filter((r) => r.grant_type === "refresh_token").length;

    const responses = await Promise.all([
      cp.call("GET", "/api/me", { cookie: session! }),
      cp.call("GET", "/api/me", { cookie: session! }),
      cp.call("GET", "/api/me", { cookie: session! }),
    ]);
    for (const response of responses) expect(response.status).toBe(200);
    const after = idp.tokenRequests.filter((r) => r.grant_type === "refresh_token").length;
    expect(after - before).toBe(1);
  });

  test("the rotated refresh token replaces the one that was used", async () => {
    const cp = oidcCp({ claimsRefreshSec: 0 });
    const { session } = await signInThroughIdp(cp);
    const used = idp.refreshTokens.at(-1)!;
    await cp.call("GET", "/api/me", { cookie: session! });

    const sent = idp.tokenRequests.filter((r) => r.grant_type === "refresh_token").at(-1)!;
    expect(sent.refresh_token).toBe(used);
    // The next refresh must present the new one, or the second re-read would fail with a token
    // the provider retired a moment ago.
    expect(idp.refreshTokens.at(-1)).not.toBe(used);
    await cp.call("GET", "/api/me", { cookie: session! });
    expect(idp.tokenRequests.filter((r) => r.grant_type === "refresh_token").at(-1)!.refresh_token)
      .not.toBe(used);
  });

  test("a refresh that returns no id_token is noted rather than treated as confirmation", async () => {
    const cp = oidcCp({ claimsRefreshSec: 0 });
    const { session } = await signInThroughIdp(cp);
    idp.omitIdToken = true;
    // Nothing to re-read, so the roles stay as they were and the session stays alive. Pretending
    // the claims were confirmed would be the dishonest option.
    expect((await cp.call("GET", "/api/me", { cookie: session! })).status).toBe(200);
    const row = cp.app.db
      .query<{ claims_refreshed_at: string | null; revoked_at: string | null }, []>(
        "SELECT claims_refreshed_at, revoked_at FROM session",
      )
      .get()!;
    expect(row.claims_refreshed_at).not.toBeNull();
    expect(row.revoked_at).toBeNull();
  });

  test("a refresh is not attempted before it is due", async () => {
    const cp = oidcCp({ claimsRefreshSec: 3600 });
    const { session } = await signInThroughIdp(cp);
    await cp.call("GET", "/api/me", { cookie: session! });
    await cp.call("GET", "/api/me", { cookie: session! });
    expect(idp.tokenRequests.filter((r) => r.grant_type === "refresh_token")).toHaveLength(0);
  });
});

describe("signing out", () => {
  test("revokes locally, hands the refresh token back, and clears the cookie", async () => {
    idp.stop();
    idp = startStubIdp({ revocation: true, endSession: true });
    const cp = oidcCp({ endSession: true });
    const { session } = await signInThroughIdp(cp);
    const issued = idp.refreshTokens.at(-1)!;

    const response = await cp.call("POST", "/api/auth/logout", { cookie: session! });
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    expect((await cp.call("GET", "/api/my/sessions", { cookie: session! })).status).toBe(401);

    // The refresh token is the one long-lived credential this session held, so it is handed back
    // rather than merely forgotten.
    expect(idp.revocations).toEqual([issued]);
    // And single logout, when a deployment has asked for it. The SPA follows this; the control
    // plane does not, because the local revocation has already happened.
    const body = (await response.json()) as { endSessionUrl: string | null };
    expect(body.endSessionUrl).toContain("/logout");
    expect(body.endSessionUrl).toContain(encodeURIComponent(ORIGIN));
  });

  test("single logout is off unless the deployment asked for it", async () => {
    idp.stop();
    idp = startStubIdp({ endSession: true });
    const cp = oidcCp();
    const { session } = await signInThroughIdp(cp);
    const body = (await (
      await cp.call("POST", "/api/auth/logout", { cookie: session! })
    ).json()) as { endSessionUrl: string | null };
    // Redirecting to the provider signs the user out of every application it fronts, which is a
    // deployment decision and not a default.
    expect(body.endSessionUrl).toBeNull();
  });

  test("an identity provider that is down cannot leave somebody signed in here", async () => {
    const cp = oidcCp();
    const { session } = await signInThroughIdp(cp);
    idp.stop();

    const response = await cp.call("POST", "/api/auth/logout", { cookie: session! });
    expect(response.status).toBe(200);
    const row = cp.app.db
      .query<{ revoked_at: string | null }, []>("SELECT revoked_at FROM session")
      .get()!;
    expect(row.revoked_at).not.toBeNull();

    idp = startStubIdp();
  });
});

describe("configuration that has to fail at boot", () => {
  test("the development bypass cannot be combined with a real identity provider", () => {
    expect(() =>
      assertAuthConfig(
        loadConfig({ authProviders: ["dev", "oidc"], oidc: idp.oidcConfig(ORIGIN) }),
      ),
    ).toThrow(/cannot be combined/);
  });

  test("a redirect URI on another origin is refused, because the cookie would never come back", () => {
    const config = loadConfig({
      authProviders: ["oidc"],
      publicUrl: ORIGIN,
      oidc: idp.oidcConfig(ORIGIN, { redirectUri: "https://portal.example/auth/callback" }),
    });
    expect(() => assertAuthConfig(config)).toThrow(/must equal PUBLIC_URL/);
  });

  test("a scope without openid is refused", () => {
    const config = loadConfig({
      authProviders: ["oidc"],
      publicUrl: ORIGIN,
      oidc: idp.oidcConfig(ORIGIN, { scope: "profile email" }),
    });
    expect(() => assertAuthConfig(config)).toThrow(/openid/);
  });

  test("the retired DEV_AUTH variable is a startup failure, not a silent downgrade", () => {
    const previous = process.env.DEV_AUTH;
    process.env.DEV_AUTH = "1";
    try {
      const config = loadConfig({ authProviders: ["dev"] });
      expect(() => assertAuthConfig(config)).toThrow(/DEV_AUTH is retired/);
    } finally {
      if (previous === undefined) delete process.env.DEV_AUTH;
      else process.env.DEV_AUTH = previous;
    }
  });

  test("no AUTH_PROVIDERS at all is a startup failure that names the three legal values", () => {
    const previous = process.env.AUTH_PROVIDERS;
    delete process.env.AUTH_PROVIDERS;
    try {
      expect(() => loadConfig()).toThrow(/AUTH_PROVIDERS is required/);
    } finally {
      if (previous !== undefined) process.env.AUTH_PROVIDERS = previous;
    }
  });

  test("the OIDC endpoints are refused when the provider is not enabled", async () => {
    const cp = makeCp();
    expect((await cp.call("GET", "/auth/login")).status).toBe(400);
    expect((await cp.call("GET", "/auth/callback?code=x&state=y")).status).toBe(400);
  });
});
