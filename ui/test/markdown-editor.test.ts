import { describe, expect, test } from "bun:test";
import { fence, link, prefixLines, wrap, type Edit } from "../src/portal/components/MarkdownEditor.tsx";

/**
 * The description editor's toolbar, as decisions rather than markup.
 *
 * Each button is a pure function of (text, selection) → (text, selection), so what it inserts and
 * where it leaves the caret can be asserted without a DOM. The caret is half the promise: a button
 * that inserts `****` and leaves the caret after it has not helped anybody.
 */

/** `[` and `]` mark the selection, so the expectations read as what is on the screen. */
function edit(marked: string): Edit {
  const start = marked.indexOf("[");
  const end = marked.indexOf("]") - 1;
  return { value: marked.replace("[", "").replace("]", ""), start, end };
}
function show(result: Edit): string {
  return result.value.slice(0, result.start) + "[" + result.value.slice(result.start, result.end) + "]" + result.value.slice(result.end);
}

describe("wrapping", () => {
  test("puts the markers around the selection and keeps it selected", () => {
    expect(show(wrap(edit("call [this] one"), "**"))).toBe("call **[this]** one");
  });

  test("a second press takes them off again", () => {
    expect(show(wrap(edit("call **[this]** one"), "**"))).toBe("call [this] one");
  });

  test("with nothing selected it drops in a placeholder, selected, so typing replaces it", () => {
    expect(show(wrap(edit("call []one"), "*"))).toBe("call *[text]*one");
    expect(show(wrap(edit("[]"), "`", "`", "code"))).toBe("`[code]`");
  });
});

describe("line prefixes", () => {
  test("prefix every line the selection touches, not just the first", () => {
    expect(prefixLines(edit("one\n[two\nthree]\nfour"), "- ").value).toBe("one\n- two\n- three\nfour");
  });

  test("a caret with no selection still prefixes the line it sits on", () => {
    expect(prefixLines(edit("one\ntw[]o\nthree"), "## ").value).toBe("one\n## two\nthree");
  });

  test("pressing again when every line already has it takes it off", () => {
    expect(prefixLines(edit("[- one\n- two]"), "- ").value).toBe("one\ntwo");
  });

  test("a partly-prefixed selection is completed rather than toggled off", () => {
    expect(prefixLines(edit("[- one\ntwo]"), "- ").value).toBe("- - one\n- two");
  });

  test("a numbered list counts from one down the selection", () => {
    expect(prefixLines(edit("[a\nb\nc]"), (i) => `${i + 1}. `).value).toBe("1. a\n2. b\n3. c");
  });
});

describe("blocks and links", () => {
  test("a code block lands on its own lines with the body selected", () => {
    expect(show(fence(edit("intro\n\n[body]")))).toBe("intro\n\n```\n[body]\n```");
  });

  test("a fence opened mid-paragraph gets the blank line it needs to be one", () => {
    expect(fence(edit("intro[]")).value).toBe("intro\n\n```\ncode\n```");
  });

  test("a link keeps the selected words as the label and selects the href", () => {
    const result = link(edit("see [the docs] for more"));
    expect(result.value).toBe("see [the docs](https://) for more");
    // The caret lands on `https://`, so a paste replaces it instead of appending to it.
    expect(result.value.slice(result.start, result.end)).toBe("https://");
  });

  test("a link with nothing selected still gives both halves to fill in", () => {
    expect(link(edit("[]")).value).toBe("[label](https://)");
  });
});
