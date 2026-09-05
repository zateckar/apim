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
