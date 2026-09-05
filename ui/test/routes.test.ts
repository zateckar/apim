import { describe, expect, test } from "bun:test";
import { matchRoute, navigable, NOT_FOUND, ROUTES } from "../src/lib/routes.ts";

/**
 * Every screen has a title and a one-line purpose (plan §9.4).
 *
 * Enforced structurally rather than per component: the shell renders both from this table, so the
 * property can be asserted once over every route instead of hoped for in seventeen files.
 *
 * What this file does *not* assert is that the sidebar links any of it — the table describes the
 * screens, and `portal.test.tsx` holds the shell that renders them to this description.
 */

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

  test("ids and patterns are unique", () => {
    expect(new Set(ROUTES.map((route) => route.id)).size).toBe(ROUTES.length);
    expect(new Set(ROUTES.map((route) => route.pattern)).size).toBe(ROUTES.length);
  });

  test("the longest literal wins, so /apis/new is the wizard and not an API called new", () => {
    expect(matchRoute("/apis/new").route.id).toBe("api-new");
    expect(matchRoute("/apis/res_1").route.id).toBe("api");
    expect(matchRoute("/apis/res_1").params.resourceId).toBe("res_1");
    expect(matchRoute("/apis/res_1/revisions").route.id).toBe("api-tab");
    expect(matchRoute("/apis/res_1/revisions").params).toEqual({ resourceId: "res_1", tab: "revisions" });
    expect(matchRoute("/catalog/res_1/subscribe").route.id).toBe("subscribe");
    expect(matchRoute("/catalog/res_1").route.id).toBe("listing");
    expect(matchRoute("/").route.id).toBe("home");
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
  });

  test("sections follow capability, not inventory", () => {
    // `[P1-26]`: publishing is offered to an application that owns nothing, or nobody could ever
    // publish a first API — so the sections a member is offered do not depend on what they own.
    const sections = new Set(navigable(false).map((route) => route.section));
    expect(sections).toContain("use");
    expect(sections).toContain("publish");
    expect(sections).not.toContain("operate");
    expect(new Set(navigable(true).map((route) => route.section))).toContain("operate");
  });

  test("every navigable route matches its own pattern", () => {
    for (const route of navigable(true)) {
      expect(matchRoute(route.pattern).route.id, route.id).toBe(route.id);
    }
  });

  test("only the operate section is gated", () => {
    for (const route of ROUTES) {
      if (route.adminOnly) expect(route.section, route.id).toBe("operate");
    }
  });

  test("gating is the only thing that narrows what a member is offered", () => {
    const gated = new Set(navigable(true).map((route) => route.id));
    for (const route of navigable(false)) expect(gated, route.id).toContain(route.id);
    for (const route of ROUTES) {
      if (route.nav && !route.adminOnly)
        expect(navigable(false).map((entry) => entry.id), route.id).toContain(route.id);
    }
  });
});
