import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ForcedPasswordChange } from "../src/views/LoginView.tsx";
import { TeamsView, TeamView } from "../src/views/TeamsView.tsx";
import { AccountView } from "../src/views/AccountView.tsx";
import { GLOSSARY } from "../src/lib/glossary.ts";
import { matchRoute, navigation, ROUTES } from "../src/lib/routes.ts";
import type { Me, User } from "../src/api.ts";

/**
 * The sign-in and identity screens (v5 plan §8).
 *
 * `renderToStaticMarkup` does not run effects, so what is asserted here is the part that does not
 * depend on a fetch: the shape of the refusal, the sentence that explains a provenance, and the
 * route table. Anything that needs a live control plane is asserted in `test/` against the real
 * one instead — D30 rules out pretending a browser was driven.
 */

const member: User = {
  id: "usr_1",
  name: "Clara Consumer",
  roles: ["member"],
  teams: ["team_orders"],
  isAdmin: false,
  provider: "oidc",
  username: "clara",
  email: "clara@example.test",
  adminFrom: null,
};

const admin: User = { ...member, id: "usr_2", name: "Alice Admin", isAdmin: true, adminFrom: "idp" };

function meFor(user: User, over: Partial<Me> = {}): Me {
  return {
    user,
    teams: [
      {
        teamId: "team_orders",
        teamName: "Orders",
        source: "idp",
        grantedBy: null,
        grantedAt: null,
        sourceGroup: "SG-APIM-ORDERS",
      },
    ],
    mustChangePassword: false,
    claimsStale: false,
    unmappedGroups: [],
    ...over,
  };
}

describe("the route table knows about people", () => {
  test("the identity screens exist, with a purpose each", () => {
    for (const id of ["account", "users", "user", "teams", "team"]) {
      const route = ROUTES.find((r) => r.id === id);
      expect(route, id).toBeDefined();
      expect(route!.purpose.length, id).toBeGreaterThan(20);
      expect(route!.title.length, id).toBeGreaterThan(0);
    }
  });

  test("your own account is reachable by everybody; the directory is not", () => {
    const asMember = navigation(false).flatMap((group) => group.items.map((route) => route.id));
    expect(asMember).toContain("account");
    // The sidebar follows capability: a member has no directory to manage, and a link that always
    // answers 403 teaches nothing.
    expect(asMember).not.toContain("users");
    expect(asMember).not.toContain("teams");

    const asAdmin = navigation(true).flatMap((group) => group.items.map((route) => route.id));
    expect(asAdmin).toContain("users");
    expect(asAdmin).toContain("teams");
  });

  test("a person's page and a team's page resolve to the right screen", () => {
    expect(matchRoute("/users/usr_1")).toMatchObject({
      route: { id: "user" },
      params: { userId: "usr_1" },
    });
    expect(matchRoute("/teams/team_orders")).toMatchObject({
      route: { id: "team" },
      params: { teamId: "team_orders" },
    });
    expect(matchRoute("/users").route.id).toBe("users");
    expect(matchRoute("/account").route.id).toBe("account");
  });
});

describe("the vocabulary covers who you are", () => {
  test("every word the identity screens use is defined once", () => {
    for (const key of ["team", "member", "administrator", "principal", "identity provider", "session"]) {
      const entry = GLOSSARY[key];
      expect(entry, key).toBeDefined();
      expect(entry!.group, key).toBe("identity");
      // Say what it is and what it decides — not how it is stored.
      expect(entry!.definition.length, key).toBeGreaterThan(40);
    }
  });
});

describe("the forced password change", () => {
  const html = renderToStaticMarkup(
    <ForcedPasswordChange minLength={12} onChanged={() => {}} onSignOut={() => {}} />,
  );

  test("says whose fault it is that the password has to change", () => {
    // Not "your password has expired": somebody else chose this one, and saying so is the
    // difference between an instruction and an accusation.
    expect(html).toContain("Somebody else set the one you signed in with");
  });

  test("cannot be submitted empty, and offers a way out that is not being stuck", () => {
    expect(html).toContain("disabled");
    expect(html).toContain("Sign out instead");
    // The consequence, before the click rather than after it.
    expect(html).toContain("signs out every other browser");
  });
});

describe("your own account", () => {
  test("says how you sign in, in words rather than a provider id", () => {
    const html = renderToStaticMarkup(<AccountView me={meFor(member)} reload={() => {}} />);
    expect(html).toContain("your organisation&#x27;s identity provider");
    // A team from a group says which group, and what removing it would do — because that is where
    // somebody goes when they wonder why they lost access.
    expect(html).toContain("SG-APIM-ORDERS");
    expect(html).toContain("Removing you from that group removes this team");
  });

  test("a password form appears only for somebody who has a password here", () => {
    const oidc = renderToStaticMarkup(<AccountView me={meFor(member)} reload={() => {}} />);
    expect(oidc).not.toContain("Change your password");

    const local = renderToStaticMarkup(
      <AccountView me={meFor({ ...member, provider: "local" })} reload={() => {}} />,
    );
    expect(local).toContain("Change your password");
  });

  test("somebody in no team is told what that means, not shown an empty box", () => {
    const html = renderToStaticMarkup(
      <AccountView me={meFor({ ...member, teams: [] }, { teams: [] })} reload={() => {}} />,
    );
    expect(html).toContain("You are not in any team");
    expect(html).toContain("cannot publish or change anything");
    // An empty state carries the next action, always.
    expect(html).toMatch(/<a [^>]*href="\/catalog"/);
  });

  test("a deployment that cannot re-read claims says so rather than showing stale teams silently", () => {
    const html = renderToStaticMarkup(
      <AccountView me={meFor(member, { claimsStale: true })} reload={() => {}} />,
    );
    expect(html).toContain("when you signed in");
    expect(html).toContain("sign out and back in");
  });

  test("a group that maps to no team is reported to the person it affects", () => {
    const html = renderToStaticMarkup(
      <AccountView me={meFor(member, { unmappedGroups: ["SG-NOBODY-MAPPED"] })} reload={() => {}} />,
    );
    expect(html).toContain("SG-NOBODY-MAPPED");
    expect(html).toContain("no team here is mapped to");
  });

  test("a token that carried no groups reads as a configuration problem, not a missing team", () => {
    // The two are told apart on purpose. "Your groups match no team" is fixable on the Teams
    // screen; "your token had no groups" is fixable nowhere in the product, and saying the first
    // when the second is true sends somebody to audit a directory that is not wrong.
    const html = renderToStaticMarkup(
      <AccountView me={meFor(member, { teams: [], noGroupsInToken: true })} reload={() => {}} />,
    );
    expect(html).toContain("sent no groups at all");
    expect(html).toContain("which claim carries group membership");
    expect(html).not.toContain("no team here is mapped to");
  });
});

describe("teams", () => {
  test("a member does not see which group grants a team", () => {
    // Team names are already a discovery surface. Which group grants one tells any signed-in user
    // exactly which group to get themselves added to `[P1-18]`.
    const html = renderToStaticMarkup(<TeamsView user={member} unmappedGroups={[]} />);
    expect(html).not.toContain("Granted by the group");
    expect(html).not.toContain("Create a team");

    const asAdmin = renderToStaticMarkup(<TeamsView user={admin} unmappedGroups={[]} />);
    expect(asAdmin).toContain("Granted by the group");
    expect(asAdmin).toContain("Create a team");
  });

  test("an unmapped group is offered to an admin as a team to create, not created for them", () => {
    const html = renderToStaticMarkup(
      <TeamsView user={admin} unmappedGroups={["SG-APIM-BILLING"]} />,
    );
    expect(html).toContain("SG-APIM-BILLING");
    expect(html).toContain("Create a team for it");
    // The rule, said where somebody would otherwise ask why it did not happen automatically.
    expect(html).toContain("never turned into one automatically");
  });
});

describe("a screen that is still loading", () => {
  test("does not claim the team is empty before it has asked", () => {
    // `renderToStaticMarkup` runs no effects, so this is the pre-fetch frame — and that frame is
    // worth an assertion: an empty-state that renders before the request has been made tells the
    // reader a team has nobody in it, and they act on it.
    const html = renderToStaticMarkup(<TeamView teamId="team_orders" user={admin} />);
    expect(html).toContain("skeleton");
    expect(html).not.toContain("Nobody is in this team");
  });
});
