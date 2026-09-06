import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Portal } from "../src/portal/Portal.tsx";
import { nextVersion, versionedPath, editorTab } from "../src/portal/apis.tsx";
import { addressOf, navigable, ROUTES } from "../src/lib/routes.ts";
import { portalVersion } from "../src/lib/changelog.ts";
import { currentVersion, parseChangeLog } from "../../shared/changelog.ts";
import type { Meta, User } from "../src/api.ts";

const SOURCE = await Bun.file(new URL("../../CHANGELOG.md", import.meta.url)).text();

/**
 * The portal shell, and the one property that cannot be checked by looking at it: every screen the
 * route table declares navigable is reachable from the sidebar.
 *
 * The shell was rewritten around the application picker while `lib/routes.ts` kept the screens, so
 * "it renders" and "you can get there" stopped being the same statement — Telemetry, Global policy,
 * Trust and Your account each existed, answered on their address, and were linked from nowhere. The
 * sidebar is drawn from the table now, so that particular drift is gone by construction; what this
 * file checks is that the drawing really happened, and that authority still narrows it.
 *
 * `renderToStaticMarkup` runs no effects, so nothing here depends on a control plane; the theme
 * is read from `localStorage` in a lazy initialiser, which does run, and is stubbed for it.
 */

const store = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  },
});

const meta: Meta = {
  environments: [{ environment: "dev", instances: 1, liveInstances: 1 }],
  chain: ["dev", "test", "prod"],
  kinds: ["rest", "soap", "mcp", "a2a"],
  policyUnits: [],
  authProviders: ["oidc"],
  publicUrl: "http://localhost:8080",
  telemetryRetentionHours: 48,
};

const member: User = {
  id: "usr_1",
  name: "Clara Consumer",
  roles: ["member"],
  applications: ["application_platform"],
  isAdmin: false,
};

const admin: User = { ...member, id: "usr_2", name: "Alice Admin", isAdmin: true };

function sessionFor(user: User) {
  return {
    user,
    meta,
    applications: [{ id: "application_platform", name: "Platform", mine: true }],
    application: "application_platform",
    setApplication: () => {},
    applicationName: (id: string) => (id === "application_platform" ? "Platform" : id),
    environment: "dev",
    setEnvironment: () => {},
    reload: () => {},
    me: {
      user,
      applications: [],
      mustChangePassword: false,
      claimsStale: false,
      unmappedGroups: [],
    },
  };
}

function shellFor(user: User, path = "/application_platform/dashboard") {
  const html = renderToStaticMarkup(<Portal session={sessionFor(user) as never} path={path} />);
  return {
    html,
    hrefs: new Set([...html.matchAll(/href="([^"]*)"/g)].map((match) => match[1]!)),
  };
}

describe("the portal shell", () => {
  const asAdmin = shellFor(admin);

  test("every navigable route is linked, at the address the table gives it", () => {
    const missing = navigable(true)
      .filter((route) => !asAdmin.hrefs.has(addressOf(route, "application_platform")))
      .map((route) => `${route.id} (${addressOf(route, "application_platform")})`);
    expect(missing).toEqual([]);
  });

  test("the sidebar links nothing the table does not declare navigable", () => {
    // The other direction, and the one that used to fail silently: a hand-written entry beside the
    // table is a screen with no title, no purpose and no test holding it to either.
    const declared = new Set(navigable(true).map((route) => addressOf(route, "application_platform")));
    const linked = [...asAdmin.html.matchAll(/class="nav-item[^"]*" href="([^"]*)"/g)].map(
      (match) => match[1]!,
    );
    expect(linked.length).toBeGreaterThan(8);
    for (const href of linked) expect(declared, href).toContain(href);
  });

  test("every group the sidebar draws carries its label", () => {
    for (const route of navigable(true)) expect(asAdmin.html, route.id).toContain(route.nav!.label);
    for (const title of ["API", "Kafka", "Other", "Global", "Administration"]) {
      expect(asAdmin.html, title).toContain(`nav-group-title">${title}`);
    }
  });

  test("an application screen hangs off the selected application; a global one does not", () => {
    for (const route of navigable(true)) {
      const href = addressOf(route, "application_platform");
      if (route.scope === "application") expect(href, route.id).toStartWith("/application_platform/");
      else expect(href, route.id).not.toStartWith("/application_platform/");
    }
  });

  test("a member is offered no administration group and no admin-only screen", () => {
    const asMember = shellFor(member);
    expect(asMember.html).not.toContain("Administration");
    for (const route of ROUTES) {
      if (route.adminOnly) expect(asMember.hrefs, route.id).not.toContain(addressOf(route, null));
    }
    // The screens that are not admin-only stay: the shell hides authority, not the portal.
    for (const route of navigable(false)) {
      expect(asMember.hrefs, route.id).toContain(addressOf(route, "application_platform"));
    }
  });

  test("the title and the purpose both come from the table, on every screen", () => {
    // The house rule is structural: a screen cannot exist without either, because the shell — not
    // the screen — renders them, and it has only the table to read them from.
    for (const [path, id] of [
      ["/application_platform/apis", "apis"],
      ["/application_platform/apis/res_1", "api"],
      ["/subscriptions/sub_1", "subscription"],
      ["/trust", "trust"],
    ] as const) {
      const route = ROUTES.find((entry) => entry.id === id)!;
      const html = shellFor(admin, path).html;
      expect(html, path).toContain(`<h1>${route.title}</h1>`);
      // React escapes text nodes, so a purpose with an apostrophe in it is not a substring as authored.
      expect(html, path).toContain(route.purpose.replaceAll("'", "&#x27;"));
    }
  });

  test("one subscription's screen says Subscription, not Subscriptions", () => {
    // The singular is the whole point: the plural here would mean the id was dropped and the reader
    // is looking at the list of everything instead of the one thing they asked for.
    expect(shellFor(admin, "/subscriptions/sub_1").html).toContain("<h1>Subscription</h1>");
    expect(shellFor(admin, "/application_platform/subscriptions").html).toContain(
      "<h1>Subscriptions</h1>",
    );
  });

  test("the next version identifier follows the series, and gets its own path", () => {
    expect(nextVersion(["v1"])).toBe("v2");
    expect(nextVersion(["v1", "v2", "v10"])).toBe("v11");
    // An API versioned some other way gets a suffix rather than a guess that collides.
    expect(nextVersion(["2024-01"])).toBe("2024-01-next");
    // Both versions serve at once, so the path has to differ.
    expect(versionedPath("/checkout", "v1", "v2")).toBe("/checkout/v2");
    expect(versionedPath("/checkout/v1", "v1", "v2")).toBe("/checkout/v2");
    expect(versionedPath("/checkout/v1/", "v1", "v2")).toBe("/checkout/v2");
  });

  test("a link that names a panel opens that panel", () => {
    // What the control plane writes into an attention row, and what the subscribe wizard writes at
    // the end of it. Every one of these used to be parsed off the address and thrown away.
    expect(editorTab("policy")).toBe("policies");
    expect(editorTab("routing")).toBe("properties");
    expect(editorTab("publish")).toBe("properties");
    expect(editorTab("try")).toBe("playground");
    expect(editorTab("revisions")).toBe("revisions");
    // A panel nobody has is ignored rather than left blank, and so is no panel at all.
    expect(editorTab("nonsense")).toBe("definition");
    expect(editorTab(null)).toBe("definition");
  });

  test("the top bar names the build, and the name comes from the change log", () => {
    // Two things at once: the version chip is on the screen, and `CHANGELOG.md` really is the
    // place it comes from — a `?raw` import that resolved to nothing would render "v0.0.0".
    expect(portalVersion()).toBe(currentVersion(parseChangeLog(SOURCE)));
    expect(portalVersion()).not.toBe("0.0.0");
    expect(asAdmin.html).toContain(`v${portalVersion()}`);
  });

  test("the simulated integrations are declared in the chrome, not only inside their screens", () => {
    // Every one of the six is a mock this phase; a shell that looked production-real would be the
    // one dishonest surface in the portal.
    expect(asAdmin.html).toContain("Integrations simulated");
  });
});
