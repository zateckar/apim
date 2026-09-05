import { describe, expect, test } from "bun:test";
import {
  categoryOf,
  CHANGE_LOG_TYPES,
  CHANGE_LOG_TYPE_CLASSES,
  CHANGE_LOG_TYPE_LABELS,
  currentVersion,
  parseChangeLog,
} from "../shared/changelog.ts";

/**
 * The change log, and the file it is written in.
 *
 * Two things are asserted here and they are different in kind: the parser does what it says, and
 * `CHANGELOG.md` itself obeys the conventions it documents. The second is the one that earns its
 * keep — a bullet filed under a heading nobody parses does not fail loudly, it silently does not
 * appear in the portal, and the person who wrote it never finds out.
 */

const SOURCE = await Bun.file(new URL("../CHANGELOG.md", import.meta.url)).text();

describe("the parser", () => {
  test("reads a version, its date and its bullets", () => {
    const entries = parseChangeLog(`# Title\n\nPreamble.\n\n## 1.2.0 - 03.04.2026\n\n### Added\n\n- A thing.\n- Another thing.\n\n### Fixed\n\n- A broken thing.\n`);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.version).toBe("1.2.0");
    expect(entries[0]!.date).toBe("03.04.2026");
    expect(entries[0]!.items).toEqual([
      { type: "added", text: "A thing." },
      { type: "added", text: "Another thing." },
      { type: "fixed", text: "A broken thing." },
    ]);
  });

  test("the preamble above the first version is not an entry", () => {
    expect(parseChangeLog("# Title\n\n- Not a bullet of anything.\n")).toEqual([]);
  });

  test("prose between the heading and the first category is the entry's summary", () => {
    const [entry] = parseChangeLog("## 1.0.0 - 01.01.2026\n\nWhat this release\nis about.\n\n### Added\n\n- A thing.\n");
    expect(entry!.summary).toBe("What this release is about.");
  });

  test("a bullet folded across lines is one sentence again", () => {
    const [entry] = parseChangeLog("## 1.0.0 - 01.01.2026\n\n### Added\n\n- A sentence that ran\n  past the column width.\n");
    expect(entry!.items[0]!.text).toBe("A sentence that ran past the column width.");
  });

  test("a heading nobody parses swallows nothing, because its bullets are not attributed", () => {
    // The failure this prevents: `### Improvements` parsing as `changed` by accident and the
    // reader being told a fix was a deliberate change, or the whole block vanishing unnoticed.
    const [entry] = parseChangeLog("## 1.0.0 - 01.01.2026\n\n### Improvements\n\n- A thing.\n");
    expect(entry!.items).toEqual([]);
    expect(categoryOf("Improvements")).toBeNull();
    expect(categoryOf("Added:")).toBe("added");
    expect(categoryOf("  RETIRED ")).toBe("removed");
  });

  test("a heading missing its date is not a version", () => {
    expect(parseChangeLog("## 1.0.0\n\n### Added\n\n- A thing.\n")).toEqual([]);
  });

  test("a pre-release suffix survives verbatim", () => {
    expect(parseChangeLog("## 2.0.0-rc.1 - 01.01.2026\n")[0]!.version).toBe("2.0.0-rc.1");
  });

  test("the portal's version is the newest entry, and 0.0.0 when there is none", () => {
    expect(currentVersion(parseChangeLog("## 1.4.0 - 02.02.2026\n## 1.3.0 - 01.01.2026\n"))).toBe("1.4.0");
    expect(currentVersion([])).toBe("0.0.0");
  });

  test("every category has a label and a badge, and nothing else does", () => {
    for (const type of CHANGE_LOG_TYPES) {
      expect(CHANGE_LOG_TYPE_LABELS[type], type).toBeTruthy();
      expect(CHANGE_LOG_TYPE_CLASSES[type], type).toBeTruthy();
    }
    expect(Object.keys(CHANGE_LOG_TYPE_LABELS).sort()).toEqual([...CHANGE_LOG_TYPES].sort());
    expect(Object.keys(CHANGE_LOG_TYPE_CLASSES).sort()).toEqual([...CHANGE_LOG_TYPES].sort());
  });
});

describe("CHANGELOG.md itself", () => {
  const entries = parseChangeLog(SOURCE);

  test("has at least one entry, so the portal has a version to show", () => {
    expect(entries.length).toBeGreaterThan(0);
    expect(currentVersion(entries)).toMatch(/^\d+\.\d+\.\d+/);
  });

  test("every `## ` heading parsed — none was silently skipped for a malformed date", () => {
    const headings = [...SOURCE.matchAll(/^## .*$/gm)].map((match) => match[0]!);
    expect(headings).toHaveLength(entries.length);
  });

  test("every `### ` heading is one the parser knows", () => {
    const unknown = [...SOURCE.matchAll(/^### (.*)$/gm)]
      .map((match) => match[1]!)
      .filter((heading) => categoryOf(heading) === null);
    expect(unknown).toEqual([]);
  });

  test("no entry is empty, and no category heading is stubbed", () => {
    for (const entry of entries) {
      expect(entry.items.length, `v${entry.version} has no bullets`).toBeGreaterThan(0);
      for (const item of entry.items) {
        expect(item.text.toLowerCase(), `v${entry.version}`).not.toBe("(none)");
      }
    }
  });

  test("versions descend, so the newest entry really is the newest", () => {
    const order = entries.map((entry) => entry.version.split("-")[0]!.split(".").map(Number));
    for (let i = 1; i < order.length; i++) {
      const [a, b] = [order[i - 1]!, order[i]!];
      const newer = a[0]! !== b[0]! ? a[0]! > b[0]! : a[1]! !== b[1]! ? a[1]! > b[1]! : a[2]! >= b[2]!;
      expect(newer, `${entries[i - 1]!.version} should be newer than ${entries[i]!.version}`).toBe(true);
    }
  });

  test("dates are DD.MM.YYYY and real", () => {
    for (const entry of entries) {
      const [day, month, year] = entry.date.split(".").map(Number);
      const parsed = new Date(Date.UTC(year!, month! - 1, day!));
      expect(parsed.getUTCDate(), entry.date).toBe(day!);
      expect(parsed.getUTCMonth() + 1, entry.date).toBe(month!);
    }
  });
});
