import { useRef, useState } from "react";
import { DescriptionMarkdown } from "./DescriptionMarkdown";

/**
 * The description editor. A description is Markdown everywhere it is read — the catalog cards, the
 * listing dialog, the detail pages all render it through {@link DescriptionMarkdown} — so the place
 * it is *written* has to say so, or the syntax reads as noise and nobody uses it.
 *
 * Deliberately a textarea with a toolbar rather than a WYSIWYG surface: the predecessor portal
 * carried TipTap plus tiptap-markdown for this one field, and paid for it with a serialization
 * round-trip that had to be defended against with two refs and a forty-line comment. The source is
 * the truth here; the toolbar inserts the syntax and the Preview tab renders it with exactly the
 * component the readers use, so what you see is what the catalog will show. Tables and anything
 * else GFM understands work — they just have to be typed.
 *
 * Controlled: the parent stores `onChange` verbatim into `value`. There is no normalisation on the
 * way through, so there is nothing for a sync effect to fight.
 */

/**
 * A toolbar entry's effect: the current value and selection in, the next value and selection out.
 * Pure, and exported so `ui/test` can assert the syntax each button inserts without a DOM.
 */
export interface Edit {
  value: string;
  start: number;
  end: number;
}

/** Wrap the selection in `left`/`right`, or unwrap it if it is already wrapped. */
export function wrap(edit: Edit, left: string, right = left, placeholder = "text"): Edit {
  const { value, start, end } = edit;
  const selected = value.slice(start, end);
  const before = value.slice(0, start);
  const after = value.slice(end);
  if (before.endsWith(left) && after.startsWith(right)) {
    // Already wrapped — a second press takes it off, which is what a toggle button promises.
    return {
      value: before.slice(0, -left.length) + selected + after.slice(right.length),
      start: start - left.length,
      end: end - left.length,
    };
  }
  const body = selected || placeholder;
  return {
    value: before + left + body + right + after,
    start: start + left.length,
    end: start + left.length + body.length,
  };
}

/** Put `prefix` in front of every line the selection touches, or take it off if all of them have it. */
export function prefixLines(edit: Edit, prefix: string | ((index: number) => string)): Edit {
  const { value, start, end } = edit;
  const from = value.lastIndexOf("\n", start - 1) + 1;
  const toIndex = value.indexOf("\n", end);
  const to = toIndex === -1 ? value.length : toIndex;
  const lines = value.slice(from, to).split("\n");
  const at = (index: number) => (typeof prefix === "string" ? prefix : prefix(index));
  const allPrefixed = lines.every((line, index) => line.startsWith(at(index)));
  const next = lines
    .map((line, index) =>
      allPrefixed ? line.slice(at(index).length) : at(index) + line,
    )
    .join("\n");
  return { value: value.slice(0, from) + next + value.slice(to), start: from, end: from + next.length };
}

/** A fenced block on its own lines, because a code block inside a paragraph is not one. */
export function fence(edit: Edit): Edit {
  const { value, start, end } = edit;
  const body = value.slice(start, end) || "code";
  const lead = start > 0 && !value.slice(0, start).endsWith("\n\n") ? "\n\n" : "";
  const tail = end < value.length && !value.slice(end).startsWith("\n") ? "\n" : "";
  const inserted = `${lead}\`\`\`\n${body}\n\`\`\`${tail}`;
  return {
    value: value.slice(0, start) + inserted + value.slice(end),
    start: start + lead.length + 4,
    end: start + lead.length + 4 + body.length,
  };
}

/**
 * A link skeleton with the href pre-selected. The predecessor asked for the URL through
 * `window.prompt`, which the house rules keep off the screen — and a selected `https://` is one
 * paste away from done anyway.
 */
export function link(edit: Edit): Edit {
  const { value, start, end } = edit;
  const label = value.slice(start, end) || "label";
  const inserted = `[${label}](https://)`;
  return {
    value: value.slice(0, start) + inserted + value.slice(end),
    // Land on the `https://` so typing replaces it rather than appending to it.
    start: start + label.length + 3,
    end: start + label.length + 3 + 8,
  };
}

const TOOLS: Array<
  | { sep: true }
  | { label: React.ReactNode; title: string; run: (edit: Edit) => Edit }
> = [
  { label: <b>B</b>, title: "Bold", run: (e) => wrap(e, "**") },
  { label: <i>I</i>, title: "Italic", run: (e) => wrap(e, "*") },
  { label: <s>S</s>, title: "Strikethrough", run: (e) => wrap(e, "~~") },
  { sep: true },
  { label: "H2", title: "Heading", run: (e) => prefixLines(e, "## ") },
  { label: "H3", title: "Subheading", run: (e) => prefixLines(e, "### ") },
  { sep: true },
  { label: "•", title: "Bullet list", run: (e) => prefixLines(e, "- ") },
  { label: "1.", title: "Numbered list", run: (e) => prefixLines(e, (i) => `${i + 1}. `) },
  { label: "”", title: "Quote", run: (e) => prefixLines(e, "> ") },
  { sep: true },
  { label: "<>", title: "Inline code", run: (e) => wrap(e, "`", "`", "code") },
  { label: "{ }", title: "Code block", run: fence },
  { label: "Link", title: "Link", run: link },
];

export function MarkdownEditor({
  value,
  onChange,
  disabled,
  rows = 8,
  placeholder,
  ariaLabel,
}: {
  value: string;
  onChange: (markdown: string) => void;
  disabled?: boolean;
  rows?: number;
  placeholder?: string;
  /** The editor is not inside a `<label>` — see `DescriptionField` — so it names itself. */
  ariaLabel?: string;
}) {
  const [mode, setMode] = useState<"write" | "preview">("write");
  const area = useRef<HTMLTextAreaElement | null>(null);

  function apply(run: (edit: Edit) => Edit) {
    const el = area.current;
    if (!el) return;
    const next = run({ value, start: el.selectionStart, end: el.selectionEnd });
    onChange(next.value);
    // React has not re-rendered yet, so the selection has to be restored after it has. Doing it in
    // a microtask rather than an effect keeps the caret handling next to the edit that moved it.
    queueMicrotask(() => {
      el.focus();
      el.setSelectionRange(next.start, next.end);
    });
  }

  return (
    <div className="md-editor">
      <div className="md-editor-toolbar">
        {mode === "write" &&
          TOOLS.map((tool, index) =>
            "sep" in tool ? (
              <span className="md-tb-sep" key={index} />
            ) : (
              <button
                type="button"
                className="md-tb"
                key={index}
                title={tool.title}
                aria-label={tool.title}
                disabled={disabled}
                // Keep the caret in the textarea when the press comes from a mouse; the click
                // handler still fires, so Enter and Space on a focused button work unchanged.
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => apply(tool.run)}
              >
                {tool.label}
              </button>
            ),
          )}
        <span className="md-tb-grow" />
        <button
          type="button"
          className={`md-tb md-source-toggle ${mode === "preview" ? "on" : ""}`}
          title="Render the Markdown the way the catalog will"
          onClick={() => setMode(mode === "write" ? "preview" : "write")}
        >
          Preview
        </button>
      </div>
      {mode === "write" ? (
        <textarea
          ref={area}
          aria-label={ariaLabel}
          className="md-editor-source mono"
          rows={rows}
          value={value}
          placeholder={placeholder}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
        />
      ) : (
        <div className="md-editor-body">
          {value.trim() ? (
            <DescriptionMarkdown source={value} />
          ) : (
            <span className="muted">Nothing to preview yet.</span>
          )}
        </div>
      )}
      {mode === "write" && (
        <div className="md-editor-hint">
          Markdown — headings, lists, links, tables. <b>Preview</b> shows it as the catalog will.
        </div>
      )}
    </div>
  );
}

