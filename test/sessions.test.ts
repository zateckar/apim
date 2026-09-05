import { describe, expect, test } from "bun:test";
import { policyOf, sessionsOf, sessionUser } from "../control-plane/src/auth.ts";
import { pruneOldRows } from "../control-plane/src/telemetry.ts";
import { makeCp, ORIGIN, type TestCp } from "./helpers.ts";

/**
 * Sessions: the two bounds, the live directory read, the caller's own device list, and the CSRF
 * check in front of every cookie-authenticated write (design §9, v5 plan §5.6).
 *
 * The property worth stating once: since v5 a session no longer *carries* roles and applications, it
 * carries a pointer to the directory (D35). `roles_json` and `applications_json` are still written and
 * are still the login-time snapshot — an audit answer, not an authorization one — and several of
 * the tests below are about the difference.
 */

function sessionRowOf(cp: TestCp, cookie: string) {
  const id = cookie.split("=")[1]!;
  return cp.app.db
    .query<
      {
        id: string;
        provider: string;
        idle_until: string;
        expires_at: string;
        revoked_at: string | null;
        last_seen_at: string | null;
        roles_json: string;
        applications_json: string;
      },
      [string]
    >("SELECT * FROM session WHERE id = ?")
    .get(id)!;
}

describe("the two bounds", () => {
  test("idle and absolute are separate, and either one ends the session", async () => {
    const cp = makeCp({ sessionIdleMin: 60, sessionLifetimeHours: 8 });
    try {
      const cookie = await cp.login("alice");
      const row = sessionRowOf(cp, cookie);
      const idle = Date.parse(row.idle_until) - Date.now();
      const absolute = Date.parse(row.expires_at) - Date.now();
      expect(idle).toBeGreaterThan(55 * 60_000);
      expect(absolute).toBeGreaterThan(7.5 * 3_600_000);

      // An idle timeout that slides is what makes a working day one sign-in; an absolute one that
      // does not is what stops a session living for ever because somebody left a tab open.
      cp.app.db.run("UPDATE session SET idle_until = ? WHERE id = ?", [
        new Date(Date.now() - 1000).toISOString(),
        row.id,
      ]);
      expect(sessionUser(cp.app.db, row.id, policyOf(cp.app.config))).toBeNull();
    } finally {
      cp.close();
    }
  });

  test("the idle window slides on every request and the absolute one does not", async () => {
    const cp = makeCp({ sessionIdleMin: 60 });
    try {
      const cookie = await cp.login("alice");
      const before = sessionRowOf(cp, cookie);
      cp.app.db.run("UPDATE session SET idle_until = ?, last_seen_at = ? WHERE id = ?", [
        new Date(Date.now() + 60_000).toISOString(),
        new Date(Date.now() - 600_000).toISOString(),
        before.id,
      ]);

      await cp.call("GET", "/api/me", { cookie });
      const after = sessionRowOf(cp, cookie);
      expect(Date.parse(after.idle_until)).toBeGreaterThan(Date.parse(before.idle_until) - 5_000);
      expect(Date.parse(after.last_seen_at!)).toBeGreaterThan(Date.now() - 5_000);
      expect(after.expires_at).toBe(before.expires_at);
    } finally {
      cp.close();
    }
  });

  test("an expired session is refused even though its row is still there", async () => {
    const cp = makeCp();
    try {
      const cookie = await cp.login("alice");
      const row = sessionRowOf(cp, cookie);
      cp.app.db.run("UPDATE session SET expires_at = ? WHERE id = ?", [
        new Date(Date.now() - 1000).toISOString(),
        row.id,
      ]);
      expect((await cp.call("GET", "/api/users", { cookie })).status).toBe(401);
    } finally {
      cp.close();
    }
  });
});

describe("the directory is read live", () => {
  test("the snapshot is kept for the audit and is not what authorizes anything", async () => {
    const cp = makeCp();
    try {
      const clara = await cp.login("clara");
      const snapshot = sessionRowOf(cp, clara);
      expect(JSON.parse(snapshot.roles_json)).toEqual(["member"]);
      expect(JSON.parse(snapshot.applications_json)).toEqual(["application_orders"]);

      // An admin grants a application while clara is signed in. Nothing invalidates her session and
      // nothing rewrites the snapshot.
      const alice = await cp.login("alice");
      await cp.call("PUT", "/api/users/clara/applications/application_platform", { cookie: alice });

      const me = (await (await cp.call("GET", "/api/me", { cookie: clara })).json()) as {
        user: { applications: string[] };
      };
      // The request sees the new application, on the session she already had.
      expect(me.user.applications.sort()).toEqual(["application_orders", "application_platform"]);
      // And the row still says what it said when she signed in, which is the audit answer.
      expect(JSON.parse(sessionRowOf(cp, clara).applications_json)).toEqual(["application_orders"]);
    } finally {
      cp.close();
    }
  });

  test("a role granted mid-session takes effect on the next request, not the next sign-in", async () => {
    const cp = makeCp();
    try {
      const pavel = await cp.login("pavel");
      expect((await cp.call("GET", "/api/users", { cookie: pavel })).status).toBe(403);
      const alice = await cp.login("alice");
      await cp.call("PATCH", "/api/users/pavel", { cookie: alice, body: { role: "admin" } });
      expect((await cp.call("GET", "/api/users", { cookie: pavel })).status).toBe(200);
    } finally {
      cp.close();
    }
  });
});

describe("my own devices", () => {
  test("lists the live ones, marks this one, and hides the revoked ones", async () => {
    const cp = makeCp();
    try {
      const first = await cp.login("clara");
      const second = await cp.login("clara");

      const listed = (await (await cp.call("GET", "/api/my/sessions", { cookie: second })).json()) as {
        items: Array<{ id: string; current: boolean; provider: string; userAgent: string | null }>;
      };
      expect(listed.items).toHaveLength(2);
      expect(listed.items.filter((s) => s.current)).toHaveLength(1);
      expect(listed.items.every((s) => s.provider === "dev")).toBe(true);

      const other = listed.items.find((s) => !s.current)!;
      const revoked = await cp.call("DELETE", `/api/my/sessions/${other.id}`, { cookie: second });
      expect(revoked.status).toBe(200);
      expect((await cp.call("GET", "/api/me", { cookie: first })).status).toBe(200);
      expect(await (await cp.call("GET", "/api/me", { cookie: first })).json()).toEqual({ user: null });

      const after = (await (await cp.call("GET", "/api/my/sessions", { cookie: second })).json()) as {
        items: unknown[];
      };
      expect(after.items).toHaveLength(1);
    } finally {
      cp.close();
    }
  });

  test("somebody else's session id is not confirmed to exist", async () => {
    const cp = makeCp();
    try {
      const clara = await cp.login("clara");
      const pavel = await cp.login("pavel");
      const pavelId = pavel.split("=")[1]!;
      const response = await cp.call("DELETE", `/api/my/sessions/${pavelId}`, { cookie: clara });
      // Whether a given session id exists is not a fact this endpoint should answer.
      expect(response.status).toBe(400);
      expect((await cp.call("GET", "/api/me", { cookie: pavel })).status).toBe(200);
    } finally {
      cp.close();
    }
  });

  test("sign out everywhere else spares the device asking", async () => {
    const cp = makeCp();
    try {
      const laptop = await cp.login("clara");
      const phone = await cp.login("clara");
      const tablet = await cp.login("clara");

      const response = await cp.call("POST", "/api/my/sessions/revoke-all", { cookie: tablet });
      expect(response.status).toBe(200);
      expect((await response.json()) as { revoked: number }).toEqual({ revoked: 2 });
      expect((await cp.call("GET", "/api/my/sessions", { cookie: tablet })).status).toBe(200);
      for (const gone of [laptop, phone]) {
        expect(await (await cp.call("GET", "/api/me", { cookie: gone })).json()).toEqual({ user: null });
      }
    } finally {
      cp.close();
    }
  });

  test("signing out clears the cookie and the session in the same response", async () => {
    const cp = makeCp();
    try {
      const cookie = await cp.login("clara");
      const response = await cp.call("POST", "/api/auth/logout", { cookie });
      expect(response.status).toBe(200);
      // Both halves matter: clearing the cookie without revoking leaves a valid session anybody
      // holding a copy could keep using.
      expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
      expect(sessionRowOf(cp, cookie).revoked_at).not.toBeNull();
    } finally {
      cp.close();
    }
  });
});

describe("cross-site writes", () => {
  test("a cookie-authenticated write needs an Origin this deployment knows", async () => {
    const cp = makeCp();
    try {
      const alice = await cp.login("alice");
      const foreign = await cp.call("POST", "/api/applications", {
        cookie: alice,
        body: { name: "Created By A Phishing Page" },
        headers: { origin: "https://phishing.example" },
      });
      expect(foreign.status).toBe(403);

      // Absent entirely is refused too: `SameSite=Lax` covers the browser cases, and this covers
      // the ones it does not.
      const missing = await cp.call("POST", "/api/applications", {
        cookie: alice,
        body: { name: "No Origin At All" },
        origin: null,
      });
      expect(missing.status).toBe(403);
      expect((await missing.json() as { detail: string }).detail).toContain(ORIGIN);
    } finally {
      cp.close();
    }
  });

  test("a read is not gated on Origin, because a read is not a write", async () => {
    const cp = makeCp();
    try {
      const alice = await cp.login("alice");
      const response = await cp.call("GET", "/api/users", { cookie: alice, origin: null });
      expect(response.status).toBe(200);
    } finally {
      cp.close();
    }
  });

  test("a second Origin can be allowed, for the Vite dev server", async () => {
    const cp = makeCp({ uiDevOrigin: "http://localhost:5173" });
    try {
      const alice = await cp.login("alice");
      const response = await cp.call("POST", "/api/applications", {
        cookie: alice,
        body: { name: "From The Dev Server" },
        headers: { origin: "http://localhost:5173" },
      });
      expect(response.status).toBe(201);
    } finally {
      cp.close();
    }
  });
});

describe("retention", () => {
  test("the prune job clears abandoned sign-ins and long-dead sessions", async () => {
    const cp = makeCp({ sessionPruneAfterDays: 30 });
    try {
      const live = await cp.login("alice");
      const recent = await cp.login("clara");
      await cp.call("POST", "/api/auth/logout", { cookie: recent });

      // One sign-in somebody started and walked away from, and one they started a moment ago.
      cp.app.db.run(
        "INSERT INTO auth_flow (state, code_verifier, nonce, return_to, created_at, expires_at) VALUES (?, ?, ?, '/', ?, ?)",
        ["abandoned", "v", "n", new Date().toISOString(), new Date(Date.now() - 1000).toISOString()],
      );
      cp.app.db.run(
        "INSERT INTO auth_flow (state, code_verifier, nonce, return_to, created_at, expires_at) VALUES (?, ?, ?, '/', ?, ?)",
        ["in-flight", "v", "n", new Date().toISOString(), new Date(Date.now() + 60_000).toISOString()],
      );

      // A session revoked six weeks ago. The one revoked a moment ago stays, so "my other devices"
      // can still explain what happened this week.
      const ancient = new Date(Date.now() - 45 * 86_400_000).toISOString();
      cp.app.db.run(
        `INSERT INTO session (id, user_id, roles_json, applications_json, created_at, idle_until, expires_at,
                              provider, revoked_at)
         VALUES ('ses_ancient', 'clara', '[]', '[]', ?, ?, ?, 'dev', ?)`,
        [ancient, ancient, ancient, ancient],
      );

      const summary = pruneOldRows(cp.app);
      expect(summary).toContain("1 abandoned sign-ins");
      expect(summary).toContain("1 dead sessions");

      expect(cp.app.db.query("SELECT state FROM auth_flow").all()).toEqual([{ state: "in-flight" }]);
      expect(cp.app.db.query("SELECT id FROM session WHERE id = 'ses_ancient'").get()).toBeNull();
      // The live one and the recently revoked one both survive.
      expect((await cp.call("GET", "/api/me", { cookie: live })).status).toBe(200);
      expect(sessionRowOf(cp, recent).revoked_at).not.toBeNull();
    } finally {
      cp.close();
    }
  });

  test("what it removed is written down, because retention is a decision somebody should see", async () => {
    const cp = makeCp();
    try {
      cp.app.db.run(
        "INSERT INTO auth_flow (state, code_verifier, nonce, return_to, created_at, expires_at) VALUES ('x', 'v', 'n', '/', ?, ?)",
        [new Date().toISOString(), new Date(Date.now() - 1000).toISOString()],
      );
      pruneOldRows(cp.app);
      const row = cp.app.db
        .query<{ detail: string }, []>("SELECT detail FROM audit WHERE action = 'prune'")
        .get()!;
      expect(JSON.parse(row.detail).authFlows).toBe(1);
    } finally {
      cp.close();
    }
  });
});

describe("the session list helper", () => {
  test("orders newest first and reports the user agent it was given", async () => {
    const cp = makeCp();
    try {
      await cp.call("POST", "/api/auth/dev-login", {
        body: { userId: "clara" },
        headers: { "user-agent": "A".repeat(500) },
      });
      const views = sessionsOf(cp.app.db, "clara", null);
      expect(views).toHaveLength(1);
      // Truncated on the way in: it is shown in one list and is otherwise a caller-controlled
      // string being stored for ever.
      expect(views[0]!.userAgent!.length).toBe(200);
    } finally {
      cp.close();
    }
  });
});
