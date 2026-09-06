import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * Keyboard and contrast basics (plan §9.4).
 *
 * A `<div onClick>` is invisible to the keyboard and to a screen reader: it looks like a control to
 * a person with a mouse and does not exist to anybody else. The rule is that every clickable thing
 * is a real `button` or `a`, and this test greps for the exceptions rather than trusting review.
 */

const SRC = join(import.meta.dir, "..", "src");

function files(dir: string, extension: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...files(path, extension));
    else if (entry.endsWith(extension)) out.push(path);
  }
  return out;
}

/**
 * The JSX tag an attribute belongs to: the last `<name` before it. Matching the *name* rather than
 * the bare `<` matters — `length < 2` in a `disabled={…}` two lines above would otherwise be read
 * as the opening bracket and report a real `<button>` as an offender.
 */
function owningTag(text: string, at: number): string {
  let tag = "";
  for (const match of text.slice(0, at).matchAll(/<([A-Za-z][A-Za-z0-9.]*)/g)) tag = match[1]!;
  return tag;
}

/**
 * The source with its comments blanked out, keeping every offset and line break so that a reported
 * line number still points at the right line. A rule about what the code *does* should not fire on
 * a comment explaining why it does not do it.
 */
function withoutComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/g, (line, lead: string) => lead + " ".repeat(line.length - lead.length));
}

/**
 * The end of a JSX opening tag that starts at `from`. The naive "first `>`" is wrong the moment an
 * attribute holds an element — `action={<Link>…</Link>}` — so nested braces and quoted strings are
 * skipped over.
 */
function closingOf(text: string, from: number): number {
  let depth = 0;
  let quote = "";
  for (let at = from; at < text.length; at++) {
    const char = text[at]!;
    if (quote) {
      if (char === quote) quote = "";
      continue;
    }
    if (char === '"' || char === "'" || char === "`") quote = char;
    else if (char === "{") depth++;
    else if (char === "}") depth--;
    else if (char === ">" && depth === 0) return at + 1;
  }
  return text.length;
}

/** `button` and `a` are interactive; a capitalised name is a component, which we hold to the rule. */
function isInteractive(tag: string): boolean {
  return tag === "button" || tag === "a" || /^[A-Z]/.test(tag);
}

describe("interaction hygiene", () => {
  const sources = files(SRC, ".tsx");

  test("there is something to check", () => {
    expect(sources.length).toBeGreaterThan(5);
  });

  test("nothing is clickable that a keyboard cannot reach", () => {
    const offenders: string[] = [];
    for (const file of sources) {
      const text = readFileSync(file, "utf8");
      for (const match of text.matchAll(/\bonClick=/g)) {
        const tag = owningTag(text, match.index!);
        if (!isInteractive(tag)) {
          const line = text.slice(0, match.index!).split("\n").length;
          offenders.push(`${relative(SRC, file)}:${line} <${tag} onClick>`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test("no colour is written into a view — the tone scale is the only vocabulary", () => {
    // A hex literal in a view is a status colour that means something on one screen and nothing on
    // the next. `styles.css` holds the tokens; `lib/status.ts` decides which one applies.
    const offenders: string[] = [];
    for (const file of sources) {
      const text = readFileSync(file, "utf8");
      for (const match of text.matchAll(/#[0-9a-fA-F]{6}\b/g)) {
        const line = text.slice(0, match.index!).split("\n").length;
        offenders.push(`${relative(SRC, file)}:${line} ${match[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("every empty state names the next action", () => {
    // Rendering each list view would need a control plane; what the rule is really about is
    // structural, and holds for every empty state whether or not a test drives it: an
    // `<EmptyState>` without an `action` is a dead end, which is where a first visit ends.
    const offenders: string[] = [];
    for (const file of sources) {
      const text = readFileSync(file, "utf8");
      for (const match of text.matchAll(/<EmptyState\b/g)) {
        const element = text.slice(match.index!, closingOf(text, match.index!));
        if (!/\baction=/.test(element)) {
          const line = text.slice(0, match.index!).split("\n").length;
          offenders.push(`${relative(SRC, file)}:${line} <EmptyState> with no action`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  /**
   * The two boxes the rule above can be walked around, and the reason each is named here.
   *
   * The branded screens used to have an `Empty` of their own that took bare children and carried no
   * action — the same box with the rule switched off, which is why half the interface was never
   * covered. It is gone, and so is the `.notice` banner that duplicated `.banner`. Both come back
   * the same way: somebody writes the class directly instead of reaching for the component. This is
   * the test that notices.
   */
  const ONE_VOCABULARY = [
    { pattern: /className="[^"]*\bempty\b/g, use: "<EmptyState title detail action>" },
    { pattern: /className="[^"]*\bnotice\b/g, use: "<Notice kind>" },
    { pattern: /className="[^"]*\bbanner\b/g, use: "<Notice kind>" },
  ];

  test("the empty state and the banner are components, not classes anybody can write", () => {
    const offenders: string[] = [];
    for (const file of sources) {
      // `components.tsx` is where those two classes are allowed to be written: it is the one place
      // that renders them, and a rule that forbade it there would forbid the components existing.
      if (relative(SRC, file) === "components.tsx") continue;
      const text = withoutComments(readFileSync(file, "utf8"));
      for (const { pattern, use } of ONE_VOCABULARY) {
        for (const match of text.matchAll(pattern)) {
          const line = text.slice(0, match.index!).split("\n").length;
          offenders.push(`${relative(SRC, file)}:${line} writes ${match[0]} — use ${use}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test("nothing destructive happens behind a browser confirm", () => {
    // `confirm()` is a modal that says "Are you sure?" and nothing else: no consequence, no object
    // name, and one stray Return away from a deletion. §9.4 asks for the name typed back instead.
    const offenders: string[] = [];
    for (const file of sources) {
      const text = withoutComments(readFileSync(file, "utf8"));
      for (const match of text.matchAll(/(?<![.\w])confirm\s*\(/g)) {
        const line = text.slice(0, match.index!).split("\n").length;
        offenders.push(`${relative(SRC, file)}:${line} confirm()`);
      }
    }
    expect(offenders).toEqual([]);
  });

  /**
   * The deletes that are *not* the removal of a named object, and why each is exempt from typing
   * the name back. Anything not listed here has to sit inside a `DangerZone`, so a new delete
   * fails this test until somebody has decided which of the two it is.
   */
  const NOT_AN_OBJECT_DELETE = [
    {
      file: "views/PlaygroundPanel.tsx",
      endpoint: "/api/playground/history/",
      why: "one entry of the caller's own console history — it removes a record, not a thing anybody depends on",
    },
    {
      file: "views/GlobalPolicyView.tsx",
      endpoint: "/api/policy/global/units/",
      why: "detaching a global policy unit, which re-attaches with the same click",
    },
    {
      file: "views/AccountView.tsx",
      endpoint: "/api/my/sessions/",
      why: "ending one of the caller's own sessions — the safe direction, and the one control that has to be fast when somebody does not recognise a row",
    },
    {
      file: "views/UsersView.tsx",
      endpoint: "/sessions",
      why: "signing somebody out, which is a containment action rather than a deletion: nothing is lost and they can sign in again",
    },
    {
      file: "views/UsersView.tsx",
      endpoint: "/applications/",
      why: "revoking an application membership, which the button beside it grants back — and which the response itself explains when the directory will simply re-add it",
    },
  ];

  test("every delete of a named object goes through the typed confirmation", () => {
    const offenders: string[] = [];
    for (const file of sources) {
      const name = relative(SRC, file).replaceAll("\\", "/");
      const text = withoutComments(readFileSync(file, "utf8"));
      // The optional type argument is not cosmetic: `api.del<{ note: string }>(…)` was invisible to
      // the original pattern, so a delete could have been added behind one and this rule would have
      // reported nothing at all.
      for (const match of text.matchAll(/\bapi\.del(?:<[^>]*>)?\(\s*`([^`]*)`/g)) {
        const endpoint = match[1]!;
        const exempt = NOT_AN_OBJECT_DELETE.some(
          (row) => row.file === name && endpoint.includes(row.endpoint),
        );
        if (exempt) continue;
        // The handler this call sits in: `onConfirm` is `DangerZone`'s, and nothing else has one.
        const handlers = [...text.slice(0, match.index!).matchAll(/\bon(Click|Confirm)\s*=/g)];
        if (handlers.at(-1)?.[1] !== "Confirm") {
          const line = text.slice(0, match.index!).split("\n").length;
          offenders.push(`${name}:${line} deletes ${endpoint} outside a DangerZone`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test("the exemption list has not gone stale", () => {
    // An entry that no longer matches anything is an exemption nobody is checking.
    for (const row of NOT_AN_OBJECT_DELETE) {
      const text = readFileSync(join(SRC, ...row.file.split("/")), "utf8");
      expect(text, row.file).toContain(row.endpoint);
    }
  });

  test("every request that can fail renders its error where it happened", () => {
    // `useAsync`/`useAction` both carry an `error`. A binding whose error is never read fails
    // silently — a spinner that stops, or a button that does nothing when pressed.
    const offenders: string[] = [];
    for (const file of sources) {
      const text = readFileSync(file, "utf8");
      for (const match of text.matchAll(/\bconst (\w+) = use(?:Action|Async)\b/g)) {
        const name = match[1]!;
        // Either this file renders the error, or it hands the whole handle to a child that does —
        // and that child is held to the same rule by the `.error` read on its own prop name.
        const read =
          new RegExp(`\\b${name}\\.error\\b`).test(text) || new RegExp(`=\\{${name}\\}`).test(text);
        if (!read) {
          const line = text.slice(0, match.index!).split("\n").length;
          offenders.push(`${relative(SRC, file)}:${line} ${name}.error is never rendered`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test("there is one shared component module", () => {
    // `portal/common.tsx` used to be the second one, and which components a screen got was decided
    // by which file it happened to import: `Field` took `children` in one and `value`/`onChange` in
    // the other, `Empty` escaped the rule `EmptyState` is held to, and the same failed request was
    // a pastel box on one screen and a themed banner on the next. A second module comes back by
    // somebody exporting one of these names from somewhere else, which is what this looks for.
    const SHARED = /\bexport function (Notice|EmptyState|Field|TextField|Panel|Modal|Status|DangerZone|Skeleton|Action|useAction|useAsync|OperationList)\b/;
    const offenders: string[] = [];
    for (const file of sources) {
      const name = relative(SRC, file).replaceAll("\\", "/");
      if (name === "components.tsx") continue;
      const match = SHARED.exec(readFileSync(file, "utf8"));
      if (match) offenders.push(`${name} exports ${match[1]}`);
    }
    expect(offenders).toEqual([]);
  });

  test("every tone the views use exists in the stylesheet", () => {
    const css = readFileSync(join(SRC, "styles.css"), "utf8");
    const declared = new Set([...css.matchAll(/\.tone-([a-z]+)\b/g)].map((match) => match[1]!));
    expect(declared.size).toBeGreaterThan(3);
    for (const file of [...sources, ...files(join(SRC, "lib"), ".ts")]) {
      const text = readFileSync(file, "utf8");
      for (const match of text.matchAll(/tone-\$\{[^}]+\}|tone-([a-z]+)/g)) {
        if (match[1]) expect(declared, `${relative(SRC, file)}: ${match[0]}`).toContain(match[1]);
      }
    }
  });
});
