import { describe, expect, test } from "bun:test";
import {
  addressOf,
  matchRoute,
  NAV_GROUPS,
  navigable,
  navigation,
  NOT_FOUND,
  ROUTES,
  switchApplication,
} from "../src/lib/routes.ts";

/**
 * The one table, and the properties that hold over all of it.
 *
 * Every screen has a title and a one-line purpose, and the shell renders both from here — so the
 * property can be asserted once over every route instead of hoped for in thirty files.
 *
 * The rest of this file is about the thing that replaced two resolvers with one: that both address
 * shapes reach the same screen, that no address is claimed by two routes, and that the sidebar is
 * derived from the table rather than declared beside it.
 */

const APPS = [{ id: "application_platform" }];

describe("the route table", () => {
  test("every screen has a title and a purpose", () => {
    for (const route of [...ROUTES, NOT_FOUND]) {
      expect(route.title.length, route.id).toBeGreaterThan(0);
      // A purpose is a sentence about who the screen is for, not a restatement of the title.
      expect(route.purpose.split(/\s+/).length, route.id).toBeGreaterThan(5);
      expect(route.purpose.endsWith("."), route.id).toBe(true);
      expect(route.purpose.toLowerCase(), route.id).not.toBe(route.title.toLowerCase());
    }
  });

  test("ids are unique, and no two screens claim the same address", () => {
    expect(new Set(ROUTES.map((route) => route.id)).size).toBe(ROUTES.length);
    const patterns = ROUTES.flatMap((route) => route.patterns);
    expect(new Set(patterns).size, patterns.join(" ")).toBe(patterns.length);
  });

  test("every address a route declares resolves back to that route", () => {
    // The property that makes a kept address safe to add: writing it in the table is enough, and
    // an address that collides with a more literal pattern fails here rather than in a browser.
    for (const route of ROUTES) {
      for (const pattern of route.patterns) {
        expect(matchRoute(pattern).route.id, `${route.id} ${pattern}`).toBe(route.id);
      }
    }
  });

  test("the longest literal wins, so /apis/new is the wizard and not an API called new", () => {
    expect(matchRoute("/apis/new").route.id).toBe("publish");
    expect(matchRoute("/apis/res_1").route.id).toBe("api");
    expect(matchRoute("/apis/res_1").params.resourceId).toBe("res_1");
    expect(matchRoute("/catalog/res_1/subscribe").route.id).toBe("subscribe");
    expect(matchRoute("/catalog/res_1").route.id).toBe("listing");
    expect(matchRoute("/").route.id).toBe("dashboard");
  });

  test("the workspace answers on every listing's address, and keeps the tab it was given", () => {
    // The tab used to be parsed off and dropped, so every attention row that named a panel —
    // `/apis/:id/policy`, `/apis/:id/routing` — landed the reader on Definition instead.
    expect(matchRoute("/apis/res_1/policy")).toMatchObject({
      route: { id: "api" },
      params: { resourceId: "res_1", tab: "policy" },
    });
    for (const section of ["apis", "mcp", "a2a"]) {
      const match = matchRoute(`/${section}/res_1`);
      expect(match.route.id, section).toBe("api");
      expect(match.params.resourceId, section).toBe("res_1");
      // The section is what the sidebar highlights: the same workspace lights up the list it was
      // opened from rather than always claiming to be under APIs.
      expect(match.section, section).toBe(section);
    }
    // The catalog is the exception, and on purpose: somebody else's API opens there as a read-only
    // listing, so an address that answered with the publisher's editor would contradict the screen.
    expect(matchRoute("/discover/res_1").route).toBe(NOT_FOUND);
  });

  test("an application-scoped address resolves the same with the prefix and without it", () => {
    for (const path of ["/apis", "/apis/res_1", "/subscriptions/sub_1", "/dashboard", ""]) {
      const bare = matchRoute(path, APPS);
      const scoped = matchRoute(`/application_platform${path}`, APPS);
      expect(scoped.route.id, path).toBe(bare.route.id);
      expect(scoped.params, path).toEqual(bare.params);
      expect(scoped.applicationId, path).toBe("application_platform");
      expect(bare.applicationId, path).toBeNull();
    }
  });

  test("a segment that names an application is only stripped when it really is one", () => {
    // Without the list, `/users/usr_1` would lose `users` as though it were an application id.
    expect(matchRoute("/users/usr_1", APPS).route.id).toBe("user");
    expect(matchRoute("/applications/application_platform", APPS).route.id).toBe("application");
    // And an unknown first segment is not silently swallowed either.
    expect(matchRoute("/application_nope/apis", APPS).route).toBe(NOT_FOUND);
  });

  test("a captured segment is decoded", () => {
    expect(matchRoute("/apis/res%201").params.resourceId).toBe("res 1");
  });

  test("an unknown address is a screen, not a blank page", () => {
    expect(matchRoute("/nowhere").route).toBe(NOT_FOUND);
    expect(matchRoute("/apis/a/b/c").route).toBe(NOT_FOUND);
  });

  test("a query string does not change which screen matches", () => {
    expect(matchRoute("/apis?environment=dev").route.id).toBe("apis");
    expect(matchRoute("/fleet?environment=dev").route.id).toBe("fleet");
  });
});

describe("the sidebar, as the table describes it", () => {
  test("an application screen is addressed under the application; a global one is not", () => {
    const apis = ROUTES.find((route) => route.id === "apis")!;
    const trust = ROUTES.find((route) => route.id === "trust")!;
    expect(addressOf(apis, "application_platform")).toBe("/application_platform/apis");
    expect(addressOf(apis, null)).toBe("/apis");
    expect(addressOf(trust, "application_platform")).toBe("/trust");
    // `/` is the dashboard's kept address, not the one to write into a link.
    const dashboard = ROUTES.find((route) => route.id === "dashboard")!;
    expect(addressOf(dashboard, "application_platform")).toBe("/application_platform/dashboard");
  });

  test("switching application keeps the screen when the screen can be kept", () => {
    const at = (path: string) => matchRoute(path, APPS).route;
    // A list that belongs to an application is the same list under the next one.
    expect(switchApplication(at("/application_platform/apis"), "/application_platform/apis", "orders")).toBe(
      "/orders/apis",
    );
    // A screen that is the same for everybody is not about the application, so it does not move.
    expect(switchApplication(at("/trust"), "/trust", "orders")).toBe("/trust");
    // One object belongs to the application that was selected, and its id will not resolve under
    // another — so the new application's dashboard is the honest answer, not a broken address.
    expect(
      switchApplication(at("/application_platform/apis/res_1"), "/application_platform/apis/res_1", "orders"),
    ).toBe("/orders/dashboard");
    expect(switchApplication(at("/subscriptions/sub_1"), "/subscriptions/sub_1", "orders")).toBe(
      "/orders/dashboard",
    );
  });

  test("gating is the only thing that narrows what a member is offered", () => {
    const gated = new Set(navigable(true).map((route) => route.id));
    for (const route of navigable(false)) expect(gated, route.id).toContain(route.id);
    for (const route of ROUTES) {
      if (route.nav && !route.adminOnly) {
        expect(navigable(false).map((entry) => entry.id), route.id).toContain(route.id);
      }
    }
  });

  test("every gated screen is in the Administration group, and every one of them is gated", () => {
    // Two ways of saying the same thing that used to live in two files. A screen marked admin-only
    // and then listed in the group every member sees is a 403 with a label on it.
    for (const route of ROUTES) {
      if (route.adminOnly) expect(route.nav?.group, route.id).toBe("Administration");
      if (route.nav?.group === "Administration") expect(route.adminOnly, route.id).toBe(true);
    }
  });

  test("navigation is drawn from the table and holds nothing the table does not", () => {
    const groups = navigation(true);
    expect(groups.length).toBeGreaterThan(3);
    // In the declared order, and every entry is a route that carries a nav label.
    const order = NAV_GROUPS.map((group) => group.title);
    expect(groups.map((group) => group.title)).toEqual(
      order.filter((title) => groups.some((group) => group.title === title)),
    );
    const listed = groups.flatMap((group) => group.routes.map((route) => route.id)).sort();
    expect(listed).toEqual(navigable(true).map((route) => route.id).sort());
  });

  test("a member is offered no Administration group at all", () => {
    expect(navigation(false).map((group) => group.title)).not.toContain("Administration");
  });
});
