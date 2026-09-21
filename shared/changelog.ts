/**
 * `CHANGELOG.md`, parsed.
 *
 * The file at the repository root is the source; this module is the only thing that reads it, and
 * the portal's Change Log renders whatever comes out. The point of keeping a hand-written file
 * rather than deriving the list from git is that a commit subject answers "what did we change" and
 * a changelog entry answers "what can you now see or do" — the two are not the same sentence, and
 * only a person can write the second one.
 *
 * The **version of the portal is the newest heading in the file**. There is deliberately no second
 * copy in a `package.json` for it to disagree with: a release that forgot its changelog entry would
 * otherwise ship a version number nobody can look up.
 *
 * The format is documented in `CHANGELOG.md` itself and enforced by `test/changelog.test.ts`, so a
 * malformed entry fails the build rather than quietly vanishing from the modal.
 */

export const CHANGE_LOG_TYPES = ["added", "changed", "fixed", "deprecated", "removed"] as const;
export type ChangeLogType = (typeof CHANGE_LOG_TYPES)[number];

export const CHANGE_LOG_TYPE_LABELS: Record<ChangeLogType, string> = {
  added: "New",
  changed: "Changed",
  fixed: "Fixed",
  deprecated: "Deprecated",
  removed: "Removed",
};

/**
 * The badge each category wears, as the stylesheet already names them. Here rather than in the
 * component so the vocabulary and its rendering stay in one file — the same reason the policy unit
 * catalogue and the attention codes live in `shared/`.
 */
export const CHANGE_LOG_TYPE_CLASSES: Record<ChangeLogType, string> = {
  added: "tag-new",
  changed: "tag-changed",
  fixed: "tag-fixed",
  deprecated: "tag-deprecated",
  removed: "tag-removed",
};

export interface ChangeLogItem {
  type: ChangeLogType;
  text: string;
}

export interface ChangeLogEntry {
  /** `1.2.0`, or `1.2.0-rc.1` — pre-release suffixes are kept verbatim. */
  version: string;
  /** `DD.MM.YYYY`, exactly as written. */
  date: string;
  /** The prose between the version heading and the first category, if there is any. */
  summary: string;
  items: ChangeLogItem[];
}

/**
 * `## <version> - <DD.MM.YYYY>`. Both halves are required — a heading missing its date is a
 * mistake, and silently accepting it produces an entry the modal cannot sort.
 */
const VERSION_HEADING = /^##[ \t]+(\d[\dA-Za-z.-]*) - (\d{2}\.\d{2}\.\d{4})$/;
const CATEGORY_HEADING = /^###[ \t]+(\S.*)$/;
const BULLET = /^[-*][ \t]+(\S.*)$/;

/**
 * The category headings that are accepted, and what each means. Closed on purpose: an entry filed
 * under `### Improvements` would parse into nothing and disappear from the modal without a word,
 * which is exactly the failure a changelog cannot afford.
 */
const ALIASES: Record<string, ChangeLogType> = {
  added: "added",
  new: "added",
  changed: "changed",
  fixed: "fixed",
  deprecated: "deprecated",
  removed: "removed",
  retired: "removed",
};

/** `Added:` and `added` are the same heading; anything else is not a heading we know. */
export function categoryOf(heading: string): ChangeLogType | null {
  const key = heading.trim().toLowerCase().replace(/:+$/, "").trimEnd();
  return ALIASES[key] ?? null;
}

export function parseChangeLog(source: string): ChangeLogEntry[] {
  const entries: ChangeLogEntry[] = [];
  let current: ChangeLogEntry | null = null;
  let type: ChangeLogType | null = null;
  let summary: string[] = [];
  let inSummary = false;

  function flush() {
    if (current && summary.length > 0) current.summary = summary.join(" ").replace(/\s+/g, " ").trim();
    summary = [];
    inSummary = false;
  }

  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trimEnd();

    const version = VERSION_HEADING.exec(line);
    if (version) {
      flush();
      current = { version: version[1]!, date: version[2]!, summary: "", items: [] };
      entries.push(current);
      type = null;
      inSummary = true;
      continue;
    }
    // Everything above the first version heading is the file's own preamble, not an entry.
    if (!current) continue;

    const category = CATEGORY_HEADING.exec(line);
    if (category) {
      flush();
      type = categoryOf(category[1]!);
      continue;
    }

    const bullet = BULLET.exec(line);
    if (bullet && type) {
      current.items.push({ type, text: bullet[1]!.trim() });
      continue;
    }

    // An indented line under a bullet is that bullet wrapped, not a new one — the file is written
    // to a column width and a sentence should survive being folded.
    if (/^\s+\S/.test(rawLine) && type && current.items.length > 0) {
      const last = current.items[current.items.length - 1]!;
      last.text = `${last.text} ${rawLine.trim()}`.replace(/\s+/g, " ");
      continue;
    }

    if (inSummary && line.trim()) summary.push(line.trim());
  }
  flush();
  return entries;
}

/** The version this build of the portal is, which is the newest entry in the file. */
export function currentVersion(entries: ChangeLogEntry[]): string {
  return entries[0]?.version ?? "0.0.0";
}

/** One run of a bullet: plain text, a `**bold**` span, or a `` `code` `` span. */
export type InlineSpan = { kind: "text" | "strong" | "code"; text: string };

/**
 * A bullet's text, split into the two inline forms the file actually uses.
 *
 * Here rather than in the component for the same reason `CHANGE_LOG_TYPE_CLASSES` is: `**` and
 * `` ` `` are part of the format this module defines, and a renderer that guessed at them
 * separately would be a second opinion about what a bullet says. The component turns a span into
 * an element and decides nothing else.
 *
 * Deliberately **two** markers and no more. Every bullet in `CHANGELOG.md` uses only these; links
 * appear solely in the preamble, which `parseChangeLog` never reaches. A fuller Markdown reader
 * here would be an inline parser nobody exercises, and going through `dangerouslySetInnerHTML`
 * would put an HTML sink in the portal for two characters' worth of emphasis.
 *
 * The matching is flat and leftmost-first: a marker with no partner stays literal, and a span is
 * never re-scanned, so `` `a ** b` `` is one code span rather than a broken bold.
 */
export function inlineSpans(source: string): InlineSpan[] {
  // Code before bold in the alternation, so at a position where both could start the backtick
  // wins; `+?` on the bold body so `**a** and **b**` is two spans rather than one.
  const inline = /`([^`]+)`|\*\*([\s\S]+?)\*\*/g;
  const spans: InlineSpan[] = [];
  let at = 0;
  for (let match = inline.exec(source); match; match = inline.exec(source)) {
    if (match.index > at) spans.push({ kind: "text", text: source.slice(at, match.index) });
    spans.push(
      match[1] === undefined
        ? { kind: "strong", text: match[2]! }
        : { kind: "code", text: match[1] },
    );
    at = match.index + match[0].length;
  }
  if (at < source.length) spans.push({ kind: "text", text: source.slice(at) });
  return spans;
}
