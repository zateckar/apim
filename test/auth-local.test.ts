import { beforeEach, describe, expect, test } from "bun:test";
import { ensureBootstrapAdmin, resetLoginRate } from "../control-plane/src/auth-local.ts";
import { createPrincipal, principalById } from "../control-plane/src/principals.ts";
import { makeCp, type TestCp } from "./helpers.ts";

/**
 * The local provider (v5 plan §5.3, deviation D32).
 *
 * The property most of this file is about is one you cannot see in a single response: **every way
 * a sign-in can fail answers identically**. A wrong password, a username nobody registered, a
 * locked account and a disabled one are the same status, the same sentence and the same code —
 * because anything else is a user-enumeration oracle, and an oracle is not less of one for being
 * accidental. So the assertions compare refusals to each other rather than to a literal.
 */

const PASSWORD = "correct-horse-battery-staple";
const ADMIN = "root";

/** A control plane whose only sign-in method is a username and a password. */
async function localCp(overrides: Record<string, unknown> = {}): Promise<TestCp> {
  const cp = makeCp({
    authProviders: ["local"],
    bootstrapAdminUsername: ADMIN,
    bootstrapAdminPassword: PASSWORD,
    ...overrides,
  });
  await ensureBootstrapAdmin(cp.app);
  return cp;
}

async function signIn(cp: TestCp, username: string, password: string) {
  const response = await cp.call("POST", "/api/auth/login", { body: { username, password } });
  const raw = response.headers.get("set-cookie");
  return {
    response,
    status: response.status,
    cookie: raw ? raw.split(";")[0]! : null,
    body: (await response.json()) as Record<string, unknown>,
  };
}

/** Status, detail and code together: two refusals are only indistinguishable if all three match. */
async function refusalOf(cp: TestCp, username: string, password: string) {
  const { response, body } = await signIn(cp, username, password);
  return { status: response.status, detail: body.detail, code: body.code };
}

function auditFor(cp: TestCp, action: string): Array<{ subject: string; detail: string | null }> {
  return cp.app.db
    .query<{ subject: string; detail: string | null }, [string]>(
      "SELECT subject, detail FROM audit WHERE action = ? ORDER BY at",
    )
    .all(action);
}

beforeEach(() => {
  // The rate limit is one sliding window per process, on purpose (`[P1-05]`). Every test starts
  // with an empty one, or the fiftieth sign-in in this file would fail for the wrong reason.
  resetLoginRate();
});

describe("the bootstrap administrator", () => {
  test("is created once, as an admin, with a password it is not allowed to keep", async () => {
    const cp = await localCp();
    try {
      const row = cp.app.db
        .query<{ id: string; role: string; must_change: number; created_by: string }, []>(
          "SELECT id, role, must_change, created_by FROM principal WHERE provider = 'local'",
        )
        .get()!;
      expect(row.role).toBe("admin");
      // The password arrived through the environment, so it is in a compose file, a shell history
      // and `docker inspect`. It cannot be the one the account keeps.
      expect(row.must_change).toBe(1);
      expect(row.created_by).toBe("bootstrap");

      // Idempotent across restarts: a second boot must not add a second administrator.
      await ensureBootstrapAdmin(cp.app);
      expect(
        cp.app.db.query("SELECT COUNT(*) AS n FROM principal WHERE provider = 'local'").get(),
      ).toEqual({ n: 1 });
    } finally {
      cp.close();
    }
  });

  test("does not come back once the directory has any local account at all", async () => {
    const cp = await localCp();
    try {
      // Deleting the bootstrap admin and creating your own is a legitimate thing to do. What must
      // not happen is the environment variable resurrecting it at the next restart — which is why
      // the guard counts local principals rather than looking for this username.
      cp.app.db.run("DELETE FROM principal WHERE username = ?", [ADMIN]);
      createPrincipal(cp.app.db, {
        provider: "local",
        subject: "someone",
        username: "someone",
        displayName: "Someone Else",
        role: "admin",
        passwordHash: "not-a-real-hash",
        createdBy: "test",
      });

      await ensureBootstrapAdmin(cp.app);
      const usernames = cp.app.db
        .query<{ username: string }, []>("SELECT username FROM principal WHERE provider = 'local'")
        .all()
        .map((row) => row.username);
      expect(usernames).toEqual(["someone"]);
    } finally {
      cp.close();
    }
  });

  test("is not created at all when the local provider is off", async () => {
    const cp = makeCp({
      authProviders: ["dev"],
      bootstrapAdminUsername: ADMIN,
      bootstrapAdminPassword: PASSWORD,
    });
    try {
      await ensureBootstrapAdmin(cp.app);
      expect(
        cp.app.db.query("SELECT COUNT(*) AS n FROM principal WHERE provider = 'local'").get(),
      ).toEqual({ n: 0 });
    } finally {
      cp.close();
    }
  });
});

describe("signing in", () => {
  test("the right password gets a session, and says the password must change", async () => {
    const cp = await localCp();
    try {
      const { status, cookie, body } = await signIn(cp, ADMIN, PASSWORD);
      expect(status).toBe(200);
      expect(cookie).toMatch(/^apim_session=ses_/);
      expect(body.mustChangePassword).toBe(true);
      expect((body.user as { isAdmin: boolean }).isAdmin).toBe(true);

      const me = (await (await cp.call("GET", "/api/me", { cookie: cookie! })).json()) as {
        user: { provider: string; username: string; adminFrom: string };
        mustChangePassword: boolean;
      };
      expect(me.user.provider).toBe("local");
      expect(me.user.username).toBe(ADMIN);
      // Where the admin flag came from, so a screen can explain a demotion that changes nothing.
      expect(me.user.adminFrom).toBe("local");
      expect(me.mustChangePassword).toBe(true);
    } finally {
      cp.close();
    }
  });

  test("the username is matched case-insensitively, because it is typed by a human", async () => {
    const cp = await localCp();
    try {
      expect((await signIn(cp, ADMIN.toUpperCase(), PASSWORD)).status).toBe(200);
    } finally {
      cp.close();
    }
  });

  test("a session cookie is httpOnly and not readable from script", async () => {
    const cp = await localCp();
    try {
      const response = await cp.call("POST", "/api/auth/login", {
        body: { username: ADMIN, password: PASSWORD },
      });
      const cookie = response.headers.get("set-cookie")!;
      expect(cookie).toContain("HttpOnly");
      expect(cookie).toContain("SameSite=Lax");
      expect(cookie).toContain("Path=/");
      // No Secure over plain http, or the browser would drop it and sign-in would silently fail
      // on every local stack.
      expect(cookie).not.toContain("Secure");
    } finally {
      cp.close();
    }
  });

  test("a cross-site sign-in POST is refused", async () => {
    const cp = await localCp();
    try {
      const response = await cp.call("POST", "/api/auth/login", {
        body: { username: ADMIN, password: PASSWORD },
        headers: { origin: "https://phishing.example" },
      });
      expect(response.status).toBe(403);
    } finally {
      cp.close();
    }
  });

  test("the endpoint is refused outright when the local provider is not enabled", async () => {
    const cp = makeCp();
    try {
      const response = await cp.call("POST", "/api/auth/login", {
        body: { username: ADMIN, password: PASSWORD },
      });
      expect(response.status).toBe(400);
      // Named, so an operator reading the failure learns the variable rather than guessing.
      expect(((await response.json()) as { detail: string }).detail).toContain("AUTH_PROVIDERS");
    } finally {
      cp.close();
    }
  });
});

describe("what a refusal reveals", () => {
  test("four different failures are the same 401, word for word", async () => {
    const cp = await localCp();
    try {
      // A local account with no password: created, and deliberately not usable yet.
      createPrincipal(cp.app.db, {
        provider: "local",
        subject: "nopassword",
        username: "nopassword",
        displayName: "No Password",
        createdBy: "test",
      });
      // A disabled one, with a password that is otherwise correct.
      const disabled = createPrincipal(cp.app.db, {
        provider: "local",
        subject: "disabled",
        username: "disabled",
        displayName: "Disabled",
        passwordHash: await Bun.password.hash(PASSWORD, {
          algorithm: "argon2id",
          memoryCost: 19456,
          timeCost: 2,
        }),
        createdBy: "test",
      });
      cp.app.db.run("UPDATE principal SET disabled_at = ? WHERE id = ?", [
        new Date().toISOString(),
        disabled.id,
      ]);

      const refusals = [
        await refusalOf(cp, "nobody-has-this-name", PASSWORD),
        await refusalOf(cp, ADMIN, "the-wrong-password-entirely"),
        await refusalOf(cp, "nopassword", PASSWORD),
        await refusalOf(cp, "disabled", PASSWORD),
      ];
      expect(refusals[0]!.status).toBe(401);
      // The point of the test: every one of them is indistinguishable from the first.
      for (const refusal of refusals) expect(refusal).toEqual(refusals[0]!);
    } finally {
      cp.close();
    }
  });

  test("the audit log records the difference the response refuses to", async () => {
    const cp = await localCp();
    try {
      await refusalOf(cp, "nobody-has-this-name", PASSWORD);
      await refusalOf(cp, ADMIN, "the-wrong-password-entirely");

      const rows = auditFor(cp, "auth.login-failed");
      expect(rows).toHaveLength(2);
      const whys = rows.map((row) => (JSON.parse(row.detail!) as { why: string }).why);
      // "Somebody is guessing usernames" is a signal an operator needs and an attacker must not
      // get. This is where it lives.
      expect(whys).toEqual(["no such local account", "wrong password"]);

      // Never any password material, not even its length — including in the failure that had a
      // real password in the request body.
      const serialised = JSON.stringify(rows);
      expect(serialised).not.toContain(PASSWORD);
      expect(serialised).not.toContain("the-wrong-password-entirely");
      // The presented username is recorded, and bounded, so a megabyte of junk cannot be stored
      // by anybody who can reach the endpoint.
      expect(rows[0]!.subject).toBe("local:nobody-has-this-name");
    } finally {
      cp.close();
    }
  });

  test("an absurd username is truncated rather than stored whole", async () => {
    const cp = await localCp();
    try {
      await refusalOf(cp, "z".repeat(5000), PASSWORD);
      expect(auditFor(cp, "auth.login-failed")[0]!.subject.length).toBeLessThanOrEqual(70);
    } finally {
      cp.close();
    }
  });
});

describe("lockout and rate limiting", () => {
  test("enough wrong guesses locks the account, and the right password stops working", async () => {
    const cp = await localCp({ localLockoutThreshold: 3, localLockoutMinutes: 15 });
    try {
      for (let i = 0; i < 3; i++) await refusalOf(cp, ADMIN, `guess-${i}`);

      const row = principalById(cp.app.db, cp.app.db.query<{ id: string }, []>(
        "SELECT id FROM principal WHERE username = 'root'",
      ).get()!.id)!;
      expect(row.locked_until).not.toBeNull();
      expect(Date.parse(row.locked_until!)).toBeGreaterThan(Date.now());

      // And it is a real lock, not a counter: the correct password is refused too, with the same
      // sentence as everything else.
      const locked = await refusalOf(cp, ADMIN, PASSWORD);
      expect(locked.status).toBe(401);
      expect(auditFor(cp, "auth.login-failed").at(-1)).toBeDefined();
      expect(
        JSON.parse(auditFor(cp, "auth.login-failed").at(-1)!.detail!).why,
      ).toBe("locked out");
    } finally {
      cp.close();
    }
  });

  test("a lock that has expired lets the right password through again", async () => {
    const cp = await localCp({ localLockoutThreshold: 2 });
    try {
      for (let i = 0; i < 2; i++) await refusalOf(cp, ADMIN, `guess-${i}`);
      expect((await refusalOf(cp, ADMIN, PASSWORD)).status).toBe(401);

      cp.app.db.run("UPDATE principal SET locked_until = ? WHERE username = ?", [
        new Date(Date.now() - 1000).toISOString(),
        ADMIN,
      ]);
      expect((await signIn(cp, ADMIN, PASSWORD)).status).toBe(200);
    } finally {
      cp.close();
    }
  });

  test("a username spray is stopped by the global limit, which no per-account lock would catch", async () => {
    // One password against many usernames never fails any single account twice, so the lockout
    // above never fires. The limit in front of the hash is what covers it — and it is also what
    // stops an unauthenticated caller spending 18 ms of CPU per request with no credential at all.
    const cp = await localCp({ localLoginRatePerMin: 4 });
    try {
      for (let i = 0; i < 4; i++) {
        expect((await refusalOf(cp, `victim-${i}`, PASSWORD)).status).toBe(401);
      }
      const { response, body } = await signIn(cp, "victim-5", PASSWORD);
      expect(response.status).toBe(429);
      expect(body.retryAfterSec).toBe(60);
      expect(body.detail).toContain("LOCAL_LOGIN_RATE_PER_MIN");

      // It is in front of the hash, so it also refuses a valid credential. That is the intent: a
      // control plane under a spray has nothing to spend on distinguishing them.
      expect((await signIn(cp, ADMIN, PASSWORD)).status).toBe(429);
    } finally {
      cp.close();
    }
  });
});

describe("the forced password change", () => {
  test("gates everything except reading who you are, changing it, and signing out", async () => {
    const cp = await localCp();
    try {
      const { cookie } = await signIn(cp, ADMIN, PASSWORD);

      // An ordinary route — and this admin really is an admin, so it is the gate refusing, not
      // authorization.
      const blocked = await cp.call("GET", "/api/users", { cookie: cookie! });
      expect(blocked.status).toBe(403);
      const problem = (await blocked.json()) as { code: string; fix: { screen: string } };
      expect(problem.code).toBe("password_change_required");
      // The refusal carries the screen that fixes it, so the UI can send the user there.
      expect(problem.fix.screen).toBe("account");

      // The allowlist is three exact paths and it is tested path by path, because "everything
      // under /api/auth" would have quietly re-opened every future endpoint added there.
      expect((await cp.call("GET", "/api/my/sessions", { cookie: cookie! })).status).toBe(403);

      // The three that must work, or the gate would be a lockout with no way out of it.
      expect((await cp.call("GET", "/api/me", { cookie: cookie! })).status).toBe(200);
      const changed = await cp.call("POST", "/api/auth/password", {
        cookie: cookie!,
        body: { newPassword: "a-completely-different-one" },
      });
      expect(changed.status).toBe(200);
      const second = await signIn(cp, ADMIN, "a-completely-different-one");
      cp.app.db.run("UPDATE principal SET must_change = 1 WHERE username = ?", [ADMIN]);
      expect((await cp.call("POST", "/api/auth/logout", { cookie: second.cookie! })).status).toBe(200);
      cp.app.db.run("UPDATE principal SET must_change = 0 WHERE username = ?", [ADMIN]);

      // And it lifts.
      expect((await cp.call("GET", "/api/users", { cookie: cookie! })).status).toBe(200);
    } finally {
      cp.close();
    }
  });

  test("does not ask for a current password the user was never given", async () => {
    const cp = await localCp();
    try {
      const { cookie } = await signIn(cp, ADMIN, PASSWORD);
      // No `currentPassword` at all: an admin has just set this one, so the user does not know it.
      const response = await cp.call("POST", "/api/auth/password", {
        cookie: cookie!,
        body: { newPassword: "a-completely-different-one" },
      });
      expect(response.status).toBe(200);
      expect((await signIn(cp, ADMIN, "a-completely-different-one")).status).toBe(200);
      // The old one is gone, not merely superseded.
      expect((await refusalOf(cp, ADMIN, PASSWORD)).status).toBe(401);
    } finally {
      cp.close();
    }
  });

  test("asks for it every other time, so a stolen cookie is not an account takeover", async () => {
    const cp = await localCp();
    try {
      const { cookie } = await signIn(cp, ADMIN, PASSWORD);
      await cp.call("POST", "/api/auth/password", {
        cookie: cookie!,
        body: { newPassword: "the-first-replacement" },
      });

      const without = await cp.call("POST", "/api/auth/password", {
        cookie: cookie!,
        body: { newPassword: "the-second-replacement" },
      });
      expect(without.status).toBe(401);

      const wrong = await cp.call("POST", "/api/auth/password", {
        cookie: cookie!,
        body: { currentPassword: "not-it", newPassword: "the-second-replacement" },
      });
      expect(wrong.status).toBe(401);

      const right = await cp.call("POST", "/api/auth/password", {
        cookie: cookie!,
        body: { currentPassword: "the-first-replacement", newPassword: "the-second-replacement" },
      });
      expect(right.status).toBe(200);
    } finally {
      cp.close();
    }
  });

  test("a change signs out every other session and spares the one making it", async () => {
    const cp = await localCp();
    try {
      const first = await signIn(cp, ADMIN, PASSWORD);
      const second = await signIn(cp, ADMIN, PASSWORD);

      const response = await cp.call("POST", "/api/auth/password", {
        cookie: second.cookie!,
        body: { newPassword: "a-completely-different-one" },
      });
      expect(((await response.json()) as { otherSessionsRevoked: number }).otherSessionsRevoked).toBe(1);

      // The one that made the change still works — being signed out by your own success is how a
      // security control turns into an annoyance people route around.
      expect((await cp.call("GET", "/api/me", { cookie: second.cookie! })).status).toBe(200);
      const stale = (await (
        await cp.call("GET", "/api/me", { cookie: first.cookie! })
      ).json()) as { user: unknown };
      expect(stale.user).toBeNull();
    } finally {
      cp.close();
    }
  });
});

describe("the password policy", () => {
  test("refuses by naming the rule rather than saying no", async () => {
    const cp = await localCp({ localPasswordMinLen: 12 });
    try {
      const { cookie } = await signIn(cp, ADMIN, PASSWORD);
      const short = await cp.call("POST", "/api/auth/password", {
        cookie: cookie!,
        body: { newPassword: "short" },
      });
      expect(short.status).toBe(400);
      expect(((await short.json()) as { detail: string }).detail).toContain("12");

      // Length is the rule, and the message says why — so nobody tries the same thing with a
      // punctuation mark on the end.
      const asUsername = await cp.call("POST", "/api/auth/password", {
        cookie: cookie!,
        body: { newPassword: ADMIN },
      });
      expect(asUsername.status).toBe(400);
    } finally {
      cp.close();
    }
  });

  test("bounds the password, so an unbounded body cannot be handed to argon2", async () => {
    const cp = await localCp();
    try {
      const { cookie } = await signIn(cp, ADMIN, PASSWORD);
      const response = await cp.call("POST", "/api/auth/password", {
        cookie: cookie!,
        body: { newPassword: "x".repeat(5000) },
      });
      expect(response.status).toBe(400);
      expect(((await response.json()) as { detail: string }).detail).toContain("200");
    } finally {
      cp.close();
    }
  });

  test("a boot with a bootstrap password under the minimum is a startup failure", async () => {
    // Not a warning and not a silent trim: the bootstrap admin is the account with every
    // permission, so it is not the one to exempt from the policy it enforces.
    const { assertAuthConfig, loadConfig } = await import("../control-plane/src/config.ts");
    const config = loadConfig({
      authProviders: ["local"],
      bootstrapAdminUsername: ADMIN,
      bootstrapAdminPassword: "short",
      localPasswordMinLen: 12,
    });
    expect(() => assertAuthConfig(config)).toThrow(/BOOTSTRAP_ADMIN_PASSWORD/);
  });

  test("a bootstrap username without a password is a startup failure too", async () => {
    const { assertAuthConfig, loadConfig } = await import("../control-plane/src/config.ts");
    const config = loadConfig({
      authProviders: ["local"],
      bootstrapAdminUsername: ADMIN,
      bootstrapAdminPassword: null,
    });
    expect(() => assertAuthConfig(config)).toThrow(/go together/);
  });
});

describe("disabling somebody who is signed in", () => {
  test("stops their next request, not their next sign-in", async () => {
    const cp = await localCp();
    try {
      const { cookie } = await signIn(cp, ADMIN, PASSWORD);
      await cp.call("POST", "/api/auth/password", {
        cookie: cookie!,
        body: { newPassword: "a-completely-different-one" },
      });
      expect((await cp.call("GET", "/api/users", { cookie: cookie! })).status).toBe(200);

      // The directory is resolved live on every request (D35), which is what makes this the local
      // kill switch rather than an eventual one.
      cp.app.db.run("UPDATE principal SET disabled_at = ? WHERE username = ?", [
        new Date().toISOString(),
        ADMIN,
      ]);
      expect((await cp.call("GET", "/api/users", { cookie: cookie! })).status).toBe(401);
    } finally {
      cp.close();
    }
  });
});

describe("what an anonymous caller may know", () => {
  test("the sign-in screen's endpoint carries providers and nothing else", async () => {
    const cp = await localCp();
    try {
      const response = await cp.call("GET", "/api/auth/providers");
      expect(response.status).toBe(200);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body.providers).toEqual(["local"]);
      // The development user list is empty unless the bypass is actually on: an endpoint that
      // advertises accounts a deployment does not have is a support call.
      expect(body.devUsers).toEqual([]);
      expect(body.passwordMinLength).toBe(12);
      // And it is the whole surface. No gateway URLs, no environments, no user.
      expect(Object.keys(body).sort()).toEqual([
        "devUsers",
        "oidc",
        "passwordMinLength",
        "providers",
      ]);
    } finally {
      cp.close();
    }
  });

  test("/api/meta now needs a session, because it names every gateway URL", async () => {
    // Until v5 this was public, so that the sign-in screen could read the development user list
    // off it — and it carries the playground's gateway URLs for every environment `[P1-01]`. The
    // two are separate now, and this assertion is what keeps them separate.
    const cp = await localCp();
    try {
      expect((await cp.call("GET", "/api/meta")).status).toBe(401);
    } finally {
      cp.close();
    }
  });

  test("/api/me answers anonymously rather than refusing", async () => {
    const cp = await localCp();
    try {
      const response = await cp.call("GET", "/api/me");
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ user: null });
    } finally {
      cp.close();
    }
  });
});
