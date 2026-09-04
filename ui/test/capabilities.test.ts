import { describe, expect, test } from "bun:test";
import {
  ACTIONS,
  ALLOWED,
  blockedBecause,
  first,
  permit,
  permitAdmin,
  type Action,
} from "../src/lib/capabilities.ts";

/**
 * "You cannot do this, and here is why" (plan §9.4).
 *
 * Every action, for an owner, for another team, and for an administrator — because the failure this
 * catches is not a wrong boolean, it is a reason that does not name anybody. A disabled button with
 * "Forbidden" beside it teaches less than a hidden one.
 */

const ALL = Object.keys(ACTIONS) as Action[];

/** What the control plane grants a member of the owning team, and an admin. */
const OWNER = ["read", "update", "delete", "publish", "policy"];
const OTHER_TEAM = ["read"];

describe("capabilities", () => {
  test("every action is allowed for the owning team", () => {
    for (const action of ALL) {
      expect(permit(action, OWNER), action).toEqual(ALLOWED);
    }
  });

  test("every action is refused for another team, and names who can do it", () => {
    for (const action of ALL) {
      const permission = permit(action, OTHER_TEAM, { team: "Orders" });
      expect(permission.enabled, action).toBe(false);
      expect(permission.reason, action).toContain("the Orders team");
      expect(permission.reason, action).toContain(ACTIONS[action].verb);
      // A sentence, so it can sit beside the control and be read as one.
      expect(permission.reason!.endsWith("."), action).toBe(true);
    }
  });

  test("without a team name the sentence still points somewhere", () => {
    const permission = permit("edit", OTHER_TEAM);
    expect(permission.reason).toContain("the owning team");
    expect(permission.reason).toContain("administrator");
  });

  test("a missing capabilities array refuses rather than throwing", () => {
    for (const action of ALL) {
      expect(permit(action, undefined).enabled, action).toBe(false);
    }
  });

  test("admin-only controls say so, and say the screen still shows the state", () => {
    expect(permitAdmin(true, "register a certificate authority")).toEqual(ALLOWED);
    const refused = permitAdmin(false, "register a certificate authority");
    expect(refused.enabled).toBe(false);
    expect(refused.reason).toContain("platform administrator");
    // `[P1-26]`: the screen is not hidden, so the sentence must say what the reader can still do.
    expect(refused.reason).toContain("see the current state");
  });

  test("state blocks a control in the same shape permission does", () => {
    expect(blockedBecause(false, "unused")).toEqual(ALLOWED);
    const blocked = blockedBecause(true, "This revision is released, so it can no longer be edited.");
    expect(blocked.enabled).toBe(false);
    expect(blocked.reason).toContain("released");
  });

  test("the first reason that applies is the one shown", () => {
    const state = blockedBecause(true, "This revision is released.");
    const permission = permit("edit", OTHER_TEAM, { team: "Orders" });
    expect(first(permission, state).reason).toContain("the Orders team");
    expect(first(state, permission).reason).toContain("released");
    expect(first(ALLOWED, ALLOWED)).toEqual(ALLOWED);
  });

  test("every action names a capability the control plane actually grants", () => {
    const granted = new Set(OWNER);
    for (const action of ALL) {
      expect(granted, action).toContain(ACTIONS[action].capability);
    }
  });
});
