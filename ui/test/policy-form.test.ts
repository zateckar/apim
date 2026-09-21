import { describe, expect, test } from "bun:test";
import { headerRulesOf, headerUnitOf, summarize } from "../src/portal/PolicyForm.tsx";

/**
 * The policy form's two pure decisions: what a stored unit reads as, and what a collapsed row says.
 *
 * Both are worth asserting without a DOM because both used to be wrong in the same way — they
 * knew about `set` and `remove` and not about `append` and `skip`, so a unit doing three things
 * read as doing none and two of the four actions could only be edited through the raw JSON.
 */

describe("reading a header unit as a list of rules", () => {
  test("all four actions come back, in the order the gateway applies them", () => {
    const rules = headerRulesOf({
      skip: { "X-Default": "d" },
      append: { "X-Trace": "t" },
      set: { "X-Sub": "${subscription.name}" },
      remove: ["X-Internal"],
    });
    // The stored key order is whatever JSON.stringify happened to produce; the list is the
    // pipeline's order, because that is the thing the screen is claiming to show.
    expect(rules.map((rule) => rule.action)).toEqual(["remove", "set", "append", "skip"]);
    expect(rules[0]).toEqual({ action: "remove", name: "X-Internal", value: "" });
    expect(rules[3]).toEqual({ action: "skip", name: "X-Default", value: "d" });
  });

  test("an absent or empty unit is no rules rather than a crash", () => {
    expect(headerRulesOf(undefined)).toEqual([]);
    expect(headerRulesOf({})).toEqual([]);
  });

  test("a rule with no header name is dropped on the way back, and an untouched unit round-trips", () => {
    const stored = { remove: ["X-Internal"], set: { "X-Sub": "s" } };
    expect(headerUnitOf(headerRulesOf(stored))).toEqual(stored);

    // A row somebody is still filling in is not an instruction to the gateway.
    expect(
      headerUnitOf([
        { action: "set", name: "", value: "half-typed" },
        { action: "append", name: "X-Trace", value: "t" },
      ]),
    ).toEqual({ append: { "X-Trace": "t" } });
  });

  test("an action with nothing in it is omitted rather than written as an empty map", () => {
    // `{ set: {} }` and no `set` at all mean the same thing to the gateway and different things to
    // the workspace's Save, which compares documents to decide whether to cut a revision.
    expect(headerUnitOf([])).toEqual({});
    expect(headerUnitOf([{ action: "remove", name: "X-Internal", value: "" }])).toEqual({
      remove: ["X-Internal"],
    });
  });
});

describe("the collapsed row's summary", () => {
  test("counts every action that is present", () => {
    expect(
      summarize("headers.request", {
        remove: ["A", "B"],
        set: { C: "1" },
        append: { D: "2" },
        skip: { E: "3" },
      }),
    ).toBe("2 removed · 1 overwritten · 1 appended · 1 set if missing");
  });

  test("names only the actions in use, and says so when there are none", () => {
    expect(summarize("headers.response", { append: { "X-Trace": "t" } })).toBe("1 appended");
    // It used to read "0 sets · 0 removals" here, which counted two of the four and said nothing
    // about the unit being empty.
    expect(summarize("headers.response", {})).toBe("no rules");
  });
});
