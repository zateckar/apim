import { describe, expect, test } from "bun:test";
import {
  ATTENTION_CODES,
  ATTENTION_LABEL,
  bySeverity,
  labelFor,
  SEVERITY_LABEL,
  severityTone,
  type AttentionRow,
  type AttentionSeverity,
} from "../src/lib/attention.ts";
import { ATTENTION_SEVERITY } from "../../shared/attention.ts";

/**
 * Rendering an attention row (plan §6.3).
 *
 * The control plane writes the sentence; this module supplies the short label and the call to
 * action. So the test is about the *pair*: a code with no label renders as its own identifier, and
 * a code with no action renders a link that says nothing.
 */

const SEVERITIES: AttentionSeverity[] = ["blocker", "warning", "info"];

function row(code: (typeof ATTENTION_CODES)[number], name = "orders v2"): AttentionRow {
  return {
    code,
    severity: ATTENTION_SEVERITY[code],
    subject: { kind: "resource", id: "res_1", name },
    detail: "Something is true about it.",
    href: "/apis/res_1",
  };
}

describe("attention rendering", () => {
  test("every code the control plane can produce has a label and an action", () => {
    for (const code of ATTENTION_CODES) {
      const label = ATTENTION_LABEL[code];
      expect(label, code).toBeDefined();
      expect(label.title.length, code).toBeGreaterThan(0);
      expect(label.action.length, code).toBeGreaterThan(0);
      // "Fix" is not an instruction. Every action starts with a verb and says what it does.
      expect(label.action, code).toMatch(/^[A-Z]/);
      expect(label.title.split(/\s+/).length, code).toBeLessThanOrEqual(4);
    }
  });

  test("a code the UI has not been taught still renders", () => {
    // The row's content is the control plane's sentence; a missing label must not blank it.
    const unknown = labelFor("something-new-tomorrow" as never);
    expect(unknown.title).toBe("something-new-tomorrow");
    expect(unknown.action).toBe("Open");
  });

  test("every severity has a tone and a plain-language name", () => {
    for (const severity of SEVERITIES) {
      expect(["stop", "warn", "neutral"], severity).toContain(severityTone(severity));
      expect(SEVERITY_LABEL[severity].length, severity).toBeGreaterThan(0);
      // "Blocker" is jargon from the evaluator; the badge says what it means.
      expect(SEVERITY_LABEL[severity].toLowerCase(), severity).not.toContain(severity);
    }
  });

  test("blockers come first and empty groups are not rendered", () => {
    // One code per severity, deliberately out of order: an ageing key is a warning, a missing
    // route stops the API answering at all, and no concurrency ceiling is worth knowing and
    // nothing more.
    const groups = bySeverity([
      row("key-ageing"),
      row("no-route"),
      row("no-concurrency-ceiling"),
    ]);
    expect(groups.map((group) => group.severity)).toEqual(["blocker", "warning", "info"]);
    expect(bySeverity([row("no-route")]).map((group) => group.severity)).toEqual(["blocker"]);
    expect(bySeverity([])).toEqual([]);
  });

  test("severity is a property of the code, so one badge colour means one thing", () => {
    // Asserted against the shared table rather than restated: the UI must not be able to disagree
    // with the control plane about how bad something is `[P1-04]`.
    for (const code of ATTENTION_CODES) {
      expect(SEVERITIES, code).toContain(ATTENTION_SEVERITY[code]);
    }
  });
});
