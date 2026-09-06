import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SCREENS } from "../src/screens.tsx";
import { NOT_FOUND, ROUTES } from "../src/lib/routes.ts";

/**
 * The table and the registry, held to each other.
 *
 * These two lists used to be four: the route table, a `switch` over it in `App.tsx`, the shell's own
 * list of sections and a ternary ladder choosing the component. Nothing checked that they agreed, so
 * they did not — four route ids had no case at all, and the screens behind two others were
 * unreachable from any address. Both failures looked identical from outside: a link that arrives
 * somewhere plausible and wrong.
 *
 * Two lists that must be equal is a property a test can hold. This is that test.
 */

describe("the screen registry", () => {
  test("every route has a screen", () => {
    const orphans = ROUTES.filter((route) => !SCREENS[route.id]).map((route) => route.id);
    expect(orphans).toEqual([]);
  });

  test("every screen has a route", () => {
    const known = new Set([...ROUTES.map((route) => route.id), NOT_FOUND.id]);
    const orphans = Object.keys(SCREENS).filter((id) => !known.has(id));
    expect(orphans).toEqual([]);
  });

  test("an address that matches nothing still has a screen to render", () => {
    // `screenFor` falls back to this one, so a route id that somehow escapes the check above still
    // produces a page that says so rather than a blank frame with a title on it.
    expect(SCREENS[NOT_FOUND.id]).toBeDefined();
  });

  test("nothing else in the interface chooses a screen", () => {
    // The ladder is gone and stays gone. The shell knows the name of no screen at all — it draws the
    // frame and asks the registry what goes inside it — so a screen cannot be reached from the shell
    // without being in the table, which is how the ladder grew a branch at a time in the first place.
    const source = (...path: string[]) =>
      readFileSync(join(import.meta.dir, "..", "src", ...path), "utf8");

    const shell = source("portal", "Portal.tsx");
    expect(shell).not.toContain("switch (");
    for (const screen of ["../views/", "./apis", "./catalog", "./dashboard", "./processes"]) {
      expect(shell, screen).not.toContain(`from "${screen}`);
    }

    const app = source("App.tsx");
    expect(app).not.toContain("switch (");
    // `App.tsx` renders exactly one thing: the shell. Sign-in is the only screen it may name,
    // because it is the one screen that exists when there is no session to draw a shell around.
    expect(app.match(/from "\.\/views\/[A-Za-z]+"/g) ?? []).toEqual(['from "./views/LoginView"']);
  });
});
