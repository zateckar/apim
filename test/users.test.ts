import { beforeEach, describe, expect, test } from "bun:test";
import { resetLoginRate } from "../control-plane/src/auth-local.ts";
import { localByUsername, principalById } from "../control-plane/src/principals.ts";
import { makeCp, type TestCp } from "./helpers.ts";

/**
 * User and team management (v5 plan §7).
 *
 * The world here has both `local` and `dev` enabled: `dev` because it is how the tests become
 * alice, pavel and clara without three password hashes, and `local` because creating an account is
 * only meaningful when there is a directory in this database to create it in. That combination is
 * legal on purpose — `dev` beside `oidc` is what is refused, because a bypass beside a real
 * directory is a way in that looks like it is not there.
 */

function world(overrides: Record<string, unknown> = {}): TestCp {
  return makeCp({ authProviders: ["local", "dev"], ...overrides });
}

async function body<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

interface UserView {
  id: string;
  username: string;
  displayName: string;
  role: string;
  effectiveRole: string;
  adminFrom: string | null;
  disabled: boolean;
  mustChangePassword: boolean;
  hasPassword: boolean | null;
  provider: string;
  teams: number;
}

beforeEach(() => resetLoginRate());

describe("the directory listing", () => {
  test("is admin-only, and says so rather than answering an empty list", async () => {
    const cp = world();
    try {
      const pavel = await cp.login("pavel");
      const refused = await cp.call("GET", "/api/users", { cookie: pavel });
      expect(refused.status).toBe(403);
      // An empty list would be a worse answer than a refusal: it reads as "there are no users".
      expect((await body<{ detail: string }>(refused)).detail).toContain("admin-only");

      const alice = await cp.login("alice");
      const listed = await body<{ items: UserView[]; providers: string[] }>(
        await cp.call("GET", "/api/users", { cookie: alice }),
      );
      expect(listed.items.map((u) => u.username).sort()).toEqual(["alice", "clara", "pavel"]);
      expect(listed.providers).toEqual(["local", "dev"]);
    } finally {
      cp.close();
    }
  });

  test("says where each admin flag came from, and what a person can actually do", async () => {
    const cp = world();
    try {
      const alice = await cp.login("alice");
      const items = (
        await body<{ items: UserView[] }>(await cp.call("GET", "/api/users", { cookie: alice }))
      ).items;
      const admin = items.find((u) => u.username === "alice")!;
      expect(admin.role).toBe("admin");
      expect(admin.effectiveRole).toBe("admin");
      expect(admin.adminFrom).toBe("local");
      // Not a local account, so there is no password here to have or to lack — null rather than
      // false, which would read as "has none, set one".
      expect(admin.hasPassword).toBeNull();
      expect(admin.provider).toBe("dev");
      expect(admin.teams).toBe(2);
    } finally {
      cp.close();
    }
  });

  test("filters on the search term in SQL, so a page is a page", async () => {
    const cp = world();
    try {
      const alice = await cp.login("alice");
      const found = await body<{ items: UserView[] }>(
        await cp.call("GET", "/api/users?q=PAV", { cookie: alice }),
      );
      expect(found.items.map((u) => u.username)).toEqual(["pavel"]);

      const byProvider = await body<{ items: UserView[] }>(
        await cp.call("GET", "/api/users?provider=local", { cookie: alice }),
      );
      expect(byProvider.items).toEqual([]);

      const page = await body<{ items: UserView[]; nextCursor: string | null }>(
        await cp.call("GET", "/api/users?limit=2", { cookie: alice }),
      );
      expect(page.items).toHaveLength(2);
      expect(page.nextCursor).toBeTruthy();
      const rest = await body<{ items: UserView[]; nextCursor: string | null }>(
        await cp.call("GET", `/api/users?limit=2&cursor=${page.nextCursor}`, { cookie: alice }),
      );
      expect(rest.items).toHaveLength(1);
      expect(rest.nextCursor).toBeNull();

      expect((await cp.call("GET", "/api/users?provider=martian", { cookie: alice })).status).toBe(400);
    } finally {
      cp.close();
    }
  });
});

describe("creating a local account", () => {
  test("creates it with a password its owner must replace", async () => {
    const cp = world();
    try {
      const alice = await cp.login("alice");
      const response = await cp.call("POST", "/api/users", {
        cookie: alice,
        body: {
          username: "dana",
          displayName: "Dana Developer",
          email: "dana@example.test",
          password: "an-adequately-long-one",
        },
      });
      expect(response.status).toBe(201);
      const created = await body<UserView>(response);
      expect(created.provider).toBe("local");
      expect(created.role).toBe("member");
      expect(created.hasPassword).toBe(true);
      // Always, and not a flag the caller may turn off: this password was chosen by somebody who
      // is not the person who will use it, and it travelled here through a form and a request body.
      expect(created.mustChangePassword).toBe(true);

      // And it works, once.
      const signIn = await cp.call("POST", "/api/auth/login", {
        body: { username: "dana", password: "an-adequately-long-one" },
      });
      expect(signIn.status).toBe(200);
      expect((await body<{ mustChangePassword: boolean }>(signIn)).mustChangePassword).toBe(true);
    } finally {
      cp.close();
    }
  });

  test("refuses a duplicate username, a bad one, and a password that breaks the policy", async () => {
    const cp = world();
    try {
      const alice = await cp.login("alice");
      const make = (over: Record<string, unknown>) =>
        cp.call("POST", "/api/users", {
          cookie: alice,
          body: { username: "dana", password: "an-adequately-long-one", ...over },
        });

      expect((await make({})).status).toBe(201);
      const duplicate = await make({});
      expect(duplicate.status).toBe(409);
      expect((await body<{ detail: string }>(duplicate)).detail).toContain("already exists");

      // Two characters is the floor, so "no" is a legitimate username and "n" is not.
      expect((await make({ username: "no" })).status).toBe(201);
      expect((await make({ username: "n" })).status).toBe(400);
      expect((await make({ username: "has spaces" })).status).toBe(400);
      expect((await make({ username: ".leading-dot" })).status).toBe(400);
      expect((await make({ username: "eve", password: "short" })).status).toBe(400);
      expect((await make({ username: "eve", password: "eve" })).status).toBe(400);
      expect((await make({ username: "eve", role: "superuser" })).status).toBe(400);
    } finally {
      cp.close();
    }
  });

  test("is refused outright when this deployment has no local directory", async () => {
    const cp = makeCp();
    try {
      const alice = await cp.login("alice");
      const response = await cp.call("POST", "/api/users", {
        cookie: alice,
        body: { username: "dana", password: "an-adequately-long-one" },
      });
      // Creating an account nobody could ever sign in with is not a service to anybody.
      expect(response.status).toBe(409);
      expect((await body<{ detail: string }>(response)).detail).toContain("local");
    } finally {
      cp.close();
    }
  });
});

describe("changing an account", () => {
  test("will not edit fields the identity provider owns", async () => {
    const cp = world();
    try {
      const alice = await cp.login("alice");
      // pavel is a `dev` principal, so the bypass owns his name — as an OIDC principal's directory
      // would. A PATCH that the next sync overwrites looks like the portal losing writes.
      const response = await cp.call("PATCH", "/api/users/pavel", {
        cookie: alice,
        body: { displayName: "Renamed By Hand" },
      });
      expect(response.status).toBe(409);
      expect((await body<{ detail: string }>(response)).detail).toContain("owns it");
      expect(principalById(cp.app.db, "pavel")!.display_name).toBe("Pavel Publisher");
    } finally {
      cp.close();
    }
  });

  test("edits a local account's name and email", async () => {
    const cp = world();
    try {
      const alice = await cp.login("alice");
      const created = await body<UserView>(
        await cp.call("POST", "/api/users", {
          cookie: alice,
          body: { username: "dana", password: "an-adequately-long-one" },
        }),
      );
      const patched = await cp.call("PATCH", `/api/users/${created.id}`, {
        cookie: alice,
        body: { displayName: "Dana D", email: "dana@example.test" },
      });
      expect(patched.status).toBe(200);
      expect((await body<UserView>(patched)).displayName).toBe("Dana D");

      expect(
        (
          await cp.call("PATCH", `/api/users/${created.id}`, {
            cookie: alice,
            body: { email: "not-an-address" },
          })
        ).status,
      ).toBe(400);
      expect(
        (await cp.call("PATCH", `/api/users/${created.id}`, { cookie: alice, body: {} })).status,
      ).toBe(400);
    } finally {
      cp.close();
    }
  });

  test("promotes and demotes, and refuses to leave nobody in charge", async () => {
    const cp = world();
    try {
      const alice = await cp.login("alice");

      // alice is the only administrator this world has, so demoting her would leave the trust
      // store, the global policy and the audit log unreachable to everybody.
      const sole = await cp.call("PATCH", "/api/users/alice", {
        cookie: alice,
        body: { role: "member" },
      });
      expect(sole.status).toBe(409);
      const problem = await body<{ detail: string; fix: { screen: string } }>(sole);
      expect(problem.detail).toContain("only enabled administrator");
      // The refusal names the thing that unblocks it, rather than telling the only administrator
      // to go and ask another administrator.
      expect(problem.detail).toContain("Make somebody else an administrator first");
      expect(problem.fix.screen).toBe("users");

      // With a second one, the rule changes shape: self-protection, not last-admin.
      expect(
        (await cp.call("PATCH", "/api/users/pavel", { cookie: alice, body: { role: "admin" } }))
          .status,
      ).toBe(200);
      const self = await cp.call("PATCH", "/api/users/alice", {
        cookie: alice,
        body: { role: "member" },
      });
      expect(self.status).toBe(409);
      expect((await body<{ detail: string }>(self)).detail).toContain("your own administrator role");

      // And pavel really is an administrator now, on his existing session — the directory is read
      // live, so this did not need him to sign in again.
      const pavel = await cp.login("pavel");
      expect((await cp.call("GET", "/api/users", { cookie: pavel })).status).toBe(200);
    } finally {
      cp.close();
    }
  });

  test("says when a demotion here changes nothing because the directory says otherwise", async () => {
    const cp = world();
    try {
      const alice = await cp.login("alice");
      await cp.call("PATCH", "/api/users/pavel", { cookie: alice, body: { role: "admin" } });
      // Simulates a token that carried the admin role: `role` and `idp_admin` are separate columns
      // and `isAdmin` is the OR of them.
      cp.app.db.run("UPDATE principal SET idp_admin = 1 WHERE id = 'pavel'");

      const response = await cp.call("PATCH", "/api/users/pavel", {
        cookie: alice,
        body: { role: "member" },
      });
      expect(response.status).toBe(200);
      const result = await body<UserView & { note: string | null }>(response);
      expect(result.role).toBe("member");
      // The write succeeded and the person is still an administrator. Reporting success without
      // saying so is how an admin thinks they have removed access they have not `[P1-17]`.
      expect(result.effectiveRole).toBe("admin");
      expect(result.adminFrom).toBe("idp");
      expect(result.note).toContain("identity provider");
    } finally {
      cp.close();
    }
  });

  test("disabling signs the person out now, not at their next idle timeout", async () => {
    const cp = world();
    try {
      const alice = await cp.login("alice");
      const pavel = await cp.login("pavel");
      expect((await cp.call("GET", "/api/me", { cookie: pavel })).status).toBe(200);

      const response = await cp.call("PATCH", "/api/users/pavel", {
        cookie: alice,
        body: { disabled: true },
      });
      expect(response.status).toBe(200);
      expect((await body<UserView>(response)).disabled).toBe(true);

      // A kill switch with an hour of lag is not one.
      expect(await body<{ user: unknown }>(await cp.call("GET", "/api/me", { cookie: pavel }))).toEqual({
        user: null,
      });
      expect((await cp.call("POST", "/api/auth/dev-login", { body: { userId: "pavel" } })).status).toBe(
        200,
      );
      // ...but the dev bypass recreates him at boot. Re-enabling is the supported path:
      await cp.call("PATCH", "/api/users/pavel", { cookie: alice, body: { disabled: false } });
      expect(principalById(cp.app.db, "pavel")!.disabled_at).toBeNull();
    } finally {
      cp.close();
    }
  });

  test("nobody can disable themselves out of the building", async () => {
    const cp = world();
    try {
      const alice = await cp.login("alice");
      await cp.call("PATCH", "/api/users/pavel", { cookie: alice, body: { role: "admin" } });
      const response = await cp.call("PATCH", "/api/users/alice", {
        cookie: alice,
        body: { disabled: true },
      });
      expect(response.status).toBe(409);
      expect((await body<{ detail: string }>(response)).detail).toContain("your own account");
    } finally {
      cp.close();
    }
  });

  test("re-enabling clears the failure counter and the lock with it", async () => {
    const cp = world();
    try {
      const alice = await cp.login("alice");
      const created = await body<UserView>(
        await cp.call("POST", "/api/users", {
          cookie: alice,
          body: { username: "dana", password: "an-adequately-long-one" },
        }),
      );
      cp.app.db.run(
        "UPDATE principal SET disabled_at = ?, failed_count = 9, locked_until = ? WHERE id = ?",
        [new Date().toISOString(), new Date(Date.now() + 900_000).toISOString(), created.id],
      );
      await cp.call("PATCH", `/api/users/${created.id}`, {
        cookie: alice,
        body: { disabled: false },
      });
      const row = principalById(cp.app.db, created.id)!;
      // Somebody who has just been let back in should not find themselves locked out by the
      // guesses that happened while their account was off.
      expect(row.failed_count).toBe(0);
      expect(row.locked_until).toBeNull();
    } finally {
      cp.close();
    }
  });
});

describe("resetting a password", () => {
  test("sets one, forces a change, and signs every session out", async () => {
    const cp = world();
    try {
      const alice = await cp.login("alice");
      const created = await body<UserView>(
        await cp.call("POST", "/api/users", {
          cookie: alice,
          body: { username: "dana", password: "an-adequately-long-one" },
        }),
      );
      const dana = await cp.call("POST", "/api/auth/login", {
        body: { username: "dana", password: "an-adequately-long-one" },
      });
      const danaCookie = dana.headers.get("set-cookie")!.split(";")[0]!;

      const response = await cp.call("POST", `/api/users/${created.id}/password`, {
        cookie: alice,
        body: { password: "a-brand-new-adequate-one" },
      });
      expect(response.status).toBe(200);
      expect((await body<{ sessionsRevoked: number }>(response)).sessionsRevoked).toBe(1);
      // Every session, including the one the person is sitting in front of: this is the control
      // used when a password is believed to be known by somebody else.
      expect(await body<{ user: unknown }>(await cp.call("GET", "/api/me", { cookie: danaCookie }))).toEqual(
        { user: null },
      );
      expect(principalById(cp.app.db, created.id)!.must_change).toBe(1);
    } finally {
      cp.close();
    }
  });

  test("refuses for somebody who has no password here to set", async () => {
    const cp = world();
    try {
      const alice = await cp.login("alice");
      const response = await cp.call("POST", "/api/users/pavel/password", {
        cookie: alice,
        body: { password: "an-adequately-long-one" },
      });
      expect(response.status).toBe(409);
      expect((await body<{ detail: string }>(response)).detail).toContain("development bypass");
    } finally {
      cp.close();
    }
  });

  test("is admin-only", async () => {
    const cp = world();
    try {
      const pavel = await cp.login("pavel");
      expect(
        (
          await cp.call("POST", "/api/users/clara/password", {
            cookie: pavel,
            body: { password: "an-adequately-long-one" },
          })
        ).status,
      ).toBe(403);
    } finally {
      cp.close();
    }
  });
});

describe("membership", () => {
  test("granting and revoking records who did it and when", async () => {
    const cp = world();
    try {
      const alice = await cp.login("alice");
      const granted = await cp.call("PUT", "/api/users/clara/teams/team_platform", { cookie: alice });
      expect(granted.status).toBe(200);
      const memberships = (
        await body<{ memberships: Array<{ teamId: string; source: string; grantedBy: string }> }>(
          granted,
        )
      ).memberships;
      const platform = memberships.find((m) => m.teamId === "team_platform")!;
      expect(platform.source).toBe("local");
      expect(platform.grantedBy).toBe("alice");

      // And it is real authorization, not a label.
      const clara = await cp.login("clara");
      const teams = await body<{ items: Array<{ id: string; mine: boolean }> }>(
        await cp.call("GET", "/api/teams", { cookie: clara }),
      );
      expect(teams.items.find((t) => t.id === "team_platform")!.mine).toBe(true);

      const revoked = await cp.call("DELETE", "/api/users/clara/teams/team_platform", {
        cookie: alice,
      });
      expect(revoked.status).toBe(200);
      expect(
        (await body<{ memberships: unknown[] }>(revoked)).memberships.map((m) => (m as { teamId: string }).teamId),
      ).toEqual(["team_orders"]);
    } finally {
      cp.close();
    }
  });

  test("revoking a membership somebody does not have is a 404, not a silent success", async () => {
    const cp = world();
    try {
      const alice = await cp.login("alice");
      expect(
        (await cp.call("DELETE", "/api/users/clara/teams/team_platform", { cookie: alice })).status,
      ).toBe(404);
      expect((await cp.call("PUT", "/api/users/clara/teams/team_nope", { cookie: alice })).status).toBe(
        404,
      );
      expect((await cp.call("PUT", "/api/users/nobody/teams/team_orders", { cookie: alice })).status).toBe(
        404,
      );
    } finally {
      cp.close();
    }
  });

  test("is admin-only in both directions", async () => {
    const cp = world();
    try {
      const pavel = await cp.login("pavel");
      expect((await cp.call("PUT", "/api/users/pavel/teams/team_orders", { cookie: pavel })).status).toBe(
        403,
      );
      expect(
        (await cp.call("DELETE", "/api/users/pavel/teams/team_platform", { cookie: pavel })).status,
      ).toBe(403);
    } finally {
      cp.close();
    }
  });
});

describe("teams", () => {
  test("everybody sees the list; only an admin sees which group grants each one", async () => {
    const cp = world();
    try {
      const pavel = await cp.login("pavel");
      const mine = await body<{ items: Array<Record<string, unknown>> }>(
        await cp.call("GET", "/api/teams", { cookie: pavel }),
      );
      const platform = mine.items.find((t) => t.id === "team_platform")!;
      expect(platform.mine).toBe(true);
      expect(platform.members).toBe(2);
      // Absent, not blanked `[P1-18]`: which identity provider group grants a team tells any
      // signed-in user exactly which group to get themselves added to.
      expect("sourceGroup" in platform).toBe(false);

      const alice = await cp.login("alice");
      const asAdmin = await body<{ items: Array<Record<string, unknown>> }>(
        await cp.call("GET", "/api/teams", { cookie: alice }),
      );
      expect(asAdmin.items.find((t) => t.id === "team_platform")!.sourceGroup).toBe("SG-APIM-PLATFORM");
    } finally {
      cp.close();
    }
  });

  test("a member may read their own team's roster and not another team's", async () => {
    const cp = world();
    try {
      const clara = await cp.login("clara");
      const own = await cp.call("GET", "/api/teams/team_orders", { cookie: clara });
      expect(own.status).toBe(200);
      const roster = await body<{
        members: Array<{ userId: string; displayName: string; source: string }>;
        owns: { resources: number };
      }>(own);
      // Ids stop being readable the moment somebody is not called `alice` `[P2-03]`.
      expect(roster.members.map((m) => m.displayName).sort()).toEqual(["Alice Admin", "Clara Consumer"]);
      expect(roster.owns.resources).toBe(0);

      expect((await cp.call("GET", "/api/teams/team_platform", { cookie: clara })).status).toBe(403);
    } finally {
      cp.close();
    }
  });

  test("creating one refuses a duplicate name and a group another team already claims", async () => {
    const cp = world();
    try {
      const alice = await cp.login("alice");
      const created = await cp.call("POST", "/api/teams", {
        cookie: alice,
        body: { id: "team_billing", name: "Billing", sourceGroup: "SG-APIM-BILLING" },
      });
      expect(created.status).toBe(201);

      expect(
        (await cp.call("POST", "/api/teams", { cookie: alice, body: { name: "billing" } })).status,
      ).toBe(409);

      // One group maps to one team, or a user's team set would depend on which row a query
      // happened to return first.
      const clash = await cp.call("POST", "/api/teams", {
        cookie: alice,
        body: { name: "Billing Ops", sourceGroup: "sg-apim-billing" },
      });
      expect(clash.status).toBe(409);
      expect((await body<{ detail: string }>(clash)).detail).toContain("one team");

      expect((await cp.call("POST", "/api/teams", { cookie: alice, body: { name: "x" } })).status).toBe(
        400,
      );
      expect(
        (await cp.call("POST", "/api/teams", { cookie: alice, body: { name: "Ok", id: "Bad Id" } }))
          .status,
      ).toBe(400);

      const pavel = await cp.login("pavel");
      expect((await cp.call("POST", "/api/teams", { cookie: pavel, body: { name: "Sneaky" } })).status).toBe(
        403,
      );
    } finally {
      cp.close();
    }
  });

  test("renaming and remapping keep the one-group-one-team rule", async () => {
    const cp = world();
    try {
      const alice = await cp.login("alice");
      expect(
        (
          await cp.call("PATCH", "/api/teams/team_orders", {
            cookie: alice,
            body: { name: "Orders and Fulfilment" },
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await cp.call("PATCH", "/api/teams/team_orders", {
            cookie: alice,
            body: { sourceGroup: "SG-APIM-PLATFORM" },
          })
        ).status,
      ).toBe(409);
      // Re-asserting a team's own group is not a clash with itself.
      expect(
        (
          await cp.call("PATCH", "/api/teams/team_orders", {
            cookie: alice,
            body: { sourceGroup: "SG-APIM-ORDERS" },
          })
        ).status,
      ).toBe(200);
      // Unmapping is a legitimate end state: the team exists, the directory no longer grants it.
      expect(
        (
          await cp.call("PATCH", "/api/teams/team_orders", {
            cookie: alice,
            body: { sourceGroup: null },
          })
        ).status,
      ).toBe(200);
    } finally {
      cp.close();
    }
  });

  test("deleting one is refused while it still owns anything, with the counts", async () => {
    const cp = world();
    try {
      const pavel = await cp.login("pavel");
      await cp.call("POST", "/api/resources", {
        cookie: pavel,
        body: { kind: "rest", name: "orders-api", teamId: "team_platform", apiVersion: "v1" },
      });

      const alice = await cp.login("alice");
      const refused = await cp.call("DELETE", "/api/teams/team_platform", { cookie: alice });
      expect(refused.status).toBe(409);
      const problem = await body<{ detail: string; owns: { resources: number } }>(refused);
      // Cascading a team delete through the resource graph would delete published APIs from a
      // screen about people.
      expect(problem.owns.resources).toBe(1);
      expect(problem.detail).toContain("must not be a way to delete published APIs");

      const empty = await cp.call("DELETE", "/api/teams/team_orders", { cookie: alice });
      expect(empty.status).toBe(200);
      expect((await body<{ membersRemoved: number }>(empty)).membersRemoved).toBe(2);
      expect(cp.app.db.query("SELECT COUNT(*) AS n FROM membership WHERE team_id = 'team_orders'").get()).toEqual(
        { n: 0 },
      );
    } finally {
      cp.close();
    }
  });
});

describe("reading one account", () => {
  test("carries the teams with their provenance and the live sessions", async () => {
    const cp = world();
    try {
      const alice = await cp.login("alice");
      await cp.login("clara");
      await cp.login("clara");

      const view = await body<{
        username: string;
        memberships: Array<{ teamId: string; source: string; grantedByName: string | null }>;
        sessions: Array<{ provider: string; current: boolean }>;
      }>(await cp.call("GET", "/api/users/clara", { cookie: alice }));

      expect(view.username).toBe("clara");
      expect(view.memberships.map((m) => m.teamId)).toEqual(["team_orders"]);
      expect(view.sessions).toHaveLength(2);
      expect(view.sessions[0]!.provider).toBe("dev");
      // Nobody's session is "current" when an admin is looking at somebody else's list.
      expect(view.sessions.every((s) => !s.current)).toBe(true);
    } finally {
      cp.close();
    }
  });

  test("signing somebody out is one call and is recorded against the admin who did it", async () => {
    const cp = world();
    try {
      const alice = await cp.login("alice");
      const clara = await cp.login("clara");
      const response = await cp.call("DELETE", "/api/users/clara/sessions", { cookie: alice });
      expect(response.status).toBe(200);
      expect((await body<{ revoked: number }>(response)).revoked).toBe(1);
      expect(await body<{ user: unknown }>(await cp.call("GET", "/api/me", { cookie: clara }))).toEqual({
        user: null,
      });

      const audit = cp.app.db
        .query<{ actor: string; subject: string }, []>(
          "SELECT actor, subject FROM audit WHERE action = 'session.revoke'",
        )
        .get()!;
      expect(audit.actor).toBe("alice");
      expect(audit.subject).toBe("user:clara");
    } finally {
      cp.close();
    }
  });

  test("an unknown id is a 404 rather than an empty account", async () => {
    const cp = world();
    try {
      const alice = await cp.login("alice");
      expect((await cp.call("GET", "/api/users/nobody", { cookie: alice })).status).toBe(404);
    } finally {
      cp.close();
    }
  });
});

describe("what the audit log keeps", () => {
  test("every management action names the admin, the subject and what changed", async () => {
    const cp = world();
    try {
      const alice = await cp.login("alice");
      const created = await body<UserView>(
        await cp.call("POST", "/api/users", {
          cookie: alice,
          body: { username: "dana", password: "an-adequately-long-one", role: "admin" },
        }),
      );
      await cp.call("PATCH", `/api/users/${created.id}`, {
        cookie: alice,
        body: { displayName: "Dana D" },
      });
      await cp.call("PUT", `/api/users/${created.id}/teams/team_orders`, { cookie: alice });

      const rows = cp.app.db
        .query<{ action: string; actor: string; subject: string; detail: string }, []>(
          // `auth.login` is written by `cp.login` and is alice's too; this is about what she did
          // to somebody else's account.
          "SELECT action, actor, subject, detail FROM audit WHERE actor = 'alice' AND action LIKE 'user.%' ORDER BY at",
        )
        .all();
      expect(rows.map((r) => r.action)).toEqual(["user.create", "user.update", "user.team-grant"]);
      for (const row of rows) expect(row.subject).toBe(`user:${created.id}`);
      // The password never appears, in any of them.
      expect(JSON.stringify(rows)).not.toContain("an-adequately-long-one");
      expect(JSON.parse(rows[1]!.detail).displayName).toBe("Dana D");

      // And the log reads back with names rather than ids.
      const feed = await body<{ items: Array<{ actorName: string }> }>(
        await cp.call("GET", "/api/audit", { cookie: alice }),
      );
      expect(feed.items.some((row) => row.actorName === "Alice Admin")).toBe(true);
    } finally {
      cp.close();
    }
  });
});

describe("the local directory and the dev bypass together", () => {
  test("a local account and a dev account may share a username without colliding", async () => {
    const cp = world();
    try {
      const alice = await cp.login("alice");
      const response = await cp.call("POST", "/api/users", {
        cookie: alice,
        body: { username: "alice", password: "an-adequately-long-one" },
      });
      // `UNIQUE (provider, subject)`, not unique username: `alice` from the bypass and `alice` in
      // the local directory are two people with two ids, and collapsing them would let one
      // directory take over an account in the other.
      expect(response.status).toBe(201);
      const created = await body<UserView>(response);
      expect(created.id).not.toBe("alice");
      expect(localByUsername(cp.app.db, "alice")!.id).toBe(created.id);
      expect(principalById(cp.app.db, "alice")!.provider).toBe("dev");
    } finally {
      cp.close();
    }
  });
});
