import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { inlineSpans, parseChangeLog, type InlineSpan } from "../../shared/changelog.ts";

/**
 * The change log's inline emphasis.
 *
 * `CHANGELOG.md` is Markdown, and the dialog used to render each bullet as one string — so every
 * `**bold**` and `` `code` `` in the file arrived as visible asterisks and backticks. The
 * tokeniser is the decision this file guards: what is a span, what stays literal, and that
 * nothing is invented or dropped in between.
 */

/** The round trip that matters: rendering the spans back must give the bullet as written. */
function rebuilt(spans: InlineSpan[]): string {
  return spans
    .map((span) =>
      span.kind === "strong" ? `**${span.text}**` : span.kind === "code" ? `\`${span.text}\`` : span.text,
    )
    .join("");
}

describe("the change log's inline spans", () => {
  test("a bullet with neither marker is one run of text", () => {
    expect(inlineSpans("An icon on every navigation entry.")).toEqual([
      { kind: "text", text: "An icon on every navigation entry." },
    ]);
  });

  test("bold becomes a strong span, with the words either side kept", () => {
    expect(inlineSpans("**Credentials**, a new screen under Other.")).toEqual([
      { kind: "strong", text: "Credentials" },
      { kind: "text", text: ", a new screen under Other." },
    ]);
  });

  test("code becomes a code span", () => {
    expect(inlineSpans("`egressAllowlist`. A file that declares it fails startup.")).toEqual([
      { kind: "code", text: "egressAllowlist" },
      { kind: "text", text: ". A file that declares it fails startup." },
    ]);
  });

  test("both forms in one bullet, in the order they were written", () => {
    expect(inlineSpans("A **client certificate** is a credential; `/certificates` still opens.")).toEqual([
      { kind: "text", text: "A " },
      { kind: "strong", text: "client certificate" },
      { kind: "text", text: " is a credential; " },
      { kind: "code", text: "/certificates" },
      { kind: "text", text: " still opens." },
    ]);
  });

  test("two bold spans are two spans, not one that swallows the middle", () => {
    expect(inlineSpans("**Added** and **Removed**")).toEqual([
      { kind: "strong", text: "Added" },
      { kind: "text", text: " and " },
      { kind: "strong", text: "Removed" },
    ]);
  });

  test("an unmatched ** stays literal", () => {
    expect(inlineSpans("A rate of 4 ** 2 is not emphasis")).toEqual([
      { kind: "text", text: "A rate of 4 ** 2 is not emphasis" },
    ]);
  });

  test("an unmatched ** after a closed pair stays literal", () => {
    expect(inlineSpans("**Catalog** is one row ** per resource")).toEqual([
      { kind: "strong", text: "Catalog" },
      { kind: "text", text: " is one row ** per resource" },
    ]);
  });

  test("an unmatched backtick stays literal", () => {
    expect(inlineSpans("the ` character")).toEqual([{ kind: "text", text: "the ` character" }]);
  });

  test("a marker inside a code span is part of the code, not a second form", () => {
    expect(inlineSpans("`a ** b` ends it")).toEqual([
      { kind: "code", text: "a ** b" },
      { kind: "text", text: " ends it" },
    ]);
  });

  test("empty markers are punctuation, not empty spans", () => {
    expect(inlineSpans("**** and ``")).toEqual([{ kind: "text", text: "**** and ``" }]);
  });

  test("an empty bullet is no spans at all", () => {
    expect(inlineSpans("")).toEqual([]);
  });

  test("every bullet in CHANGELOG.md survives the round trip unchanged", () => {
    // The load-bearing one. A tokeniser that drops or invents a character would show up here as a
    // line of the dialog that does not say what the file says.
    const source = readFileSync(join(import.meta.dir, "..", "..", "CHANGELOG.md"), "utf8");
    const entries = parseChangeLog(source);
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      for (const text of [entry.summary, ...entry.items.map((item) => item.text)]) {
        expect(rebuilt(inlineSpans(text)), `${entry.version}: ${text}`).toBe(text);
      }
    }
  });

  test("the file's bullets really do use both forms, so the dialog is exercised", () => {
    // Guards the test above from passing vacuously if the convention were ever dropped.
    const source = readFileSync(join(import.meta.dir, "..", "..", "CHANGELOG.md"), "utf8");
    const spans = parseChangeLog(source).flatMap((entry) =>
      entry.items.flatMap((item) => inlineSpans(item.text)),
    );
    expect(spans.filter((span) => span.kind === "strong").length).toBeGreaterThan(0);
    expect(spans.filter((span) => span.kind === "code").length).toBeGreaterThan(0);
  });
});
