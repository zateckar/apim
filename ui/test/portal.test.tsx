import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Portal } from "../src/portal/Portal.tsx";
import {
  definitionChanged,
  editorTab,
  nextVersion,
  prettyDefinition,
  versionedPath,
  versionRefusal,
} from "../src/portal/apis.tsx";
import { addressOf, matchRoute, navigable, ROUTES } from "../src/lib/routes.ts";
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
    for (const title of ["API", "Kafka", "Global", "Administration"]) {
      expect(asAdmin.html, title).toContain(`nav-group-title">${title}`);
    }
    // "Other" was where a screen went when nobody had decided where it belonged.
    expect(asAdmin.html).not.toContain(`nav-group-title">Other`);
  });

  test("no two sidebar entries share an icon", () => {
    // Six used to share three glyphs, so the icon told a reader scanning the sidebar nothing.
    const icons = navigable(true).map((route) => route.nav!.icon);
    expect(icons.filter((icon, index) => icons.indexOf(icon) !== index)).toEqual([]);
  });

  test("your own name at the foot of the sidebar is the way to your account", () => {
    expect(asAdmin.hrefs).toContain("/account");
    expect(shellFor(member).html).toContain("Member");
    expect(shellFor(member).html).not.toContain("Developer");
  });

  test("Health Status is offered to everybody; External systems only to an administrator", () => {
    const asMember = shellFor(member);
    expect(asMember.hrefs).toContain("/fleet");
    expect(asMember.hrefs).not.toContain("/integrations");
    expect(asAdmin.hrefs).toContain("/integrations");
    // FixMe's old address lands on the screen it became a section of.
    expect(matchRoute("/fixme").route.id).toBe("fleet");
  });

  test("a detail screen links back to the list it was opened from", () => {
    expect(shellFor(admin, "/application_platform/apis/res_1").html).toContain('class="page-trail"');
    expect(shellFor(admin, "/subscriptions/sub_1").html).toContain('href="/application_platform/subscriptions"');
    // A list has no trail: the sidebar already says where it is.
    expect(shellFor(admin, "/application_platform/apis").html).not.toContain('class="page-trail"');
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
    // A legacy identifier starts the numeric series without renaming the existing version.
    expect(nextVersion(["2024-01"])).toBe("v1");
    expect(nextVersion(["v9999999999999999999999999999999", "v1"])).toBe("v2");
    // Both versions serve at once, so the path has to differ.
    expect(versionedPath("/checkout", "v1", "v2")).toBe("/checkout/v2");
    expect(versionedPath("/checkout/v1", "v1", "v2")).toBe("/checkout/v2");
    expect(versionedPath("/checkout/v1/", "v1", "v2")).toBe("/checkout/v2");
  });

  test("a version identifier the API already has is refused before the request", () => {
    // The dialog used to post it and let the control plane answer `API name and version already
    // exist` — after the dialog had closed, on the way to a resource that was never created.
    const existing = ["v1", "v2"];
    expect(versionRefusal("Orders", "v3", existing)).toBeNull();
    expect(versionRefusal("Orders", "v2", existing)).toContain(
      "Orders already has a version called v2",
    );
    // The reason names the versions that are taken, so the next identifier can be chosen here
    // rather than by dismissing the dialog and reading the list behind it.
    expect(versionRefusal("Orders", "v2", existing)).toContain("v1, v2");
    // Case-insensitively, and around whitespace: the version is a segment of the published
    // address, so `V2` and `v2` are one version to anybody reading it.
    expect(versionRefusal("Orders", "V2", existing)).not.toBeNull();
    expect(versionRefusal("Orders", "  v2  ", existing)).not.toBeNull();
    expect(versionRefusal("Orders", "V2", ["v1", "V2"])).toContain("called V2");
    // An empty box is the `required` attribute's business, not a duplicate — and a first version
    // has nothing to collide with.
    expect(versionRefusal("Orders", "", existing)).toBeNull();
    expect(versionRefusal("Orders", "   ", existing)).toBeNull();
    expect(versionRefusal("Orders", "v1", [])).toBeNull();
    // And the identifier the dialog prefills is one the guard accepts, so it never opens refused.
    expect(versionRefusal("Orders", nextVersion(existing), existing)).toBeNull();
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
    expect(asAdmin.html).toContain("External systems simulated");
  });
});

/**
 * The definition the workspace opens on, and what counts as having edited it.
 *
 * A normalised OpenAPI document is stored minified, so the editor used to open on one very long
 * line. Indenting it is only safe if the save path stops treating whitespace as a change — which
 * it did, so an indent-on-open would have cut a new revision on every save.
 */
describe("the definition a publisher reads", () => {
  const minified = '{"openapi":"3.0.0","info":{"title":"checkout","version":"1.0.0"}}';

  test("stored JSON is indented for reading", () => {
    const pretty = prettyDefinition(minified, "rest");
    expect(pretty.split("\n").length).toBeGreaterThan(4);
    expect(JSON.parse(pretty)).toEqual(JSON.parse(minified));
  });

  test("YAML is left exactly as its author wrote it", () => {
    // Re-emitting YAML restyles quoting, key order and block scalars. A viewer does not do that.
    const yaml = "openapi: 3.0.0\ninfo:\n  title: checkout\n";
    expect(prettyDefinition(yaml, "rest")).toBe(yaml);
  });

  test("a WSDL and an unparseable document are untouched, so a broken one can still be repaired", () => {
    const wsdl = "<definitions><service/></definitions>";
    expect(prettyDefinition(wsdl, "soap")).toBe(wsdl);
    expect(prettyDefinition("{ not json", "rest")).toBe("{ not json");
  });

  test("indenting is not editing: only a change to the document counts", () => {
    expect(definitionChanged(prettyDefinition(minified, "rest"), minified, "rest")).toBe(false);
    const edited = JSON.stringify({ ...JSON.parse(minified), paths: {} }, null, 2);
    expect(definitionChanged(edited, minified, "rest")).toBe(true);
  });

  test("a WSDL compares as text, because there is nothing here that parses it", () => {
    expect(definitionChanged("<a/>", " <a/> ", "soap")).toBe(false);
    expect(definitionChanged("<a/>", "<b/>", "soap")).toBe(true);
  });
});
