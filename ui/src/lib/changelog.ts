// @ts-expect-error Vite's `?raw` import has no TypeScript declaration; it resolves to a string.
import raw from "../../../CHANGELOG.md?raw";
import { currentVersion, parseChangeLog, type ChangeLogEntry } from "../../../shared/changelog";

/**
 * `CHANGELOG.md`, read at build time.
 *
 * Bundled rather than fetched: the Change Log opens instantly, it works with the control plane
 * unreachable, and there is no endpoint whose job is to read a file out of the repository. The
 * cost is that the portal has to be rebuilt to change it, which is true of every other word in
 * the interface as well.
 *
 * Parsed once. The file does not change while the tab is open.
 */
let cached: ChangeLogEntry[] | null = null;

export function changeLog(): ChangeLogEntry[] {
  if (!cached) cached = parseChangeLog(String(raw));
  return cached;
}

/** What this build of the portal is called, taken from the newest entry. */
export function portalVersion(): string {
  return currentVersion(changeLog());
}
