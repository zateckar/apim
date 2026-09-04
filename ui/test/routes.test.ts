import { describe, expect, test } from "bun:test";
import { matchRoute, navigation, NOT_FOUND, ROUTES, SECTION_LABEL } from "../src/lib/routes.ts";

/**
 * Every screen has a title and a one-line purpose (plan §9.4).
 *
 * Enforced structurally rather than per component: the shell renders both from this table, so the
 * property can be asserted once over every route instead of hoped for in seventeen files.
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
    // `[P1-26]`: "Publish APIs" is in the navigation for a team that owns nothing, or nobody could
    // ever publish a first API.
    const consumer = navigation(false);
    const sections = consumer.map((group) => group.section);
    expect(sections).toContain("use");
    expect(sections).toContain("publish");
    expect(sections).not.toContain("operate");
    expect(navigation(true).map((group) => group.section)).toContain("operate");
  });

  test("every navigable route is reachable from the navigation", () => {
    const listed = new Set(navigation(true).flatMap((group) => group.items.map((route) => route.id)));
    for (const route of ROUTES) {
      if (route.nav) expect(listed, route.id).toContain(route.id);
    }
  });

  test("every navigation entry matches its own pattern", () => {
    for (const group of navigation(true)) {
      for (const route of group.items) {
        expect(matchRoute(route.pattern).route.id, route.id).toBe(route.id);
      }
    }
  });

  test("only the operate section is gated", () => {
    for (const route of ROUTES) {
      if (route.adminOnly) expect(route.section, route.id).toBe("operate");
    }
  });

  test("a section that is labelled is labelled in words a user would use", () => {
    for (const group of navigation(true)) {
      const label = SECTION_LABEL[group.section as keyof typeof SECTION_LABEL];
      expect(label, group.section).toBe(group.label);
    }
  });
});
