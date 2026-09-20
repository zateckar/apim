/**
 * One date format for the whole portal: `DD.MM.YYYY HH:MM:SS`, 24-hour, in the reader's local
 * time. Every timestamp the control plane returns is ISO-8601 UTC, and every timestamp a screen
 * shows goes through one of these — a screen that formatted its own would be the one screen whose
 * clock disagrees with the audit log.
 *
 * `n/a` rather than an empty cell for a missing or unparseable value: an empty cell reads as a
 * layout bug, and the difference between "never happened" and "we lost it" is worth a word.
 */

function parse(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  // A timestamp with no zone is UTC — that is what the control plane and the log index both
  // write. Guessing local here would shift every log line by the reader's offset.
  const zoned = /[zZ]$|[+-]\d{2}:?\d{2}$/.test(iso) ? iso : `${iso}Z`;
  const date = new Date(zoned);
  return Number.isNaN(date.getTime()) ? null : date;
}

const pad = (n: number) => String(n).padStart(2, "0");

export function formatDateTime(iso: string | null | undefined): string {
  const date = parse(iso);
  if (!date) return "n/a";
  return (
    `${pad(date.getDate())}.${pad(date.getMonth() + 1)}.${date.getFullYear()} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

export function formatDate(iso: string | null | undefined): string {
  const date = parse(iso);
  if (!date) return "n/a";
  return `${pad(date.getDate())}.${pad(date.getMonth() + 1)}.${date.getFullYear()}`;
}

/** Two-digit year, for a tooltip or an axis label where the full form does not fit. */
export function formatDateTimeShort(iso: string | null | undefined): string {
  const date = parse(iso);
  if (!date) return "n/a";
  return (
    `${pad(date.getDate())}.${pad(date.getMonth() + 1)}.${String(date.getFullYear()).slice(-2)} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

/** `HH:MM` only — a chart axis has room for the time and nothing else. */
export function formatClock(iso: string | null | undefined): string {
  const date = parse(iso);
  if (!date) return "";
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * `0.34 ms`, `125 ms`, `1.4 s`.
 *
 * This used to round everything to whole milliseconds, on the reasoning that a sub-millisecond
 * figure is noise at this scale. That is true of a job's duration and false of the one number this
 * platform is judged on: a gateway answering in 0.34 ms rendered as `0 ms`, which reads as "no
 * data" and is the opposite of the truth. Below a millisecond the fraction *is* the measurement, so
 * it is shown; at or above one it is the noise it always was, so it is not.
 */
export function formatDuration(ms: number | null | undefined): string {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return "n/a";
  if (ms < 1) return `${ms.toFixed(2)} ms`;
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.round(ms / 60_000)} min`;
}

/** "3 minutes ago". For a list where the exact instant is one hover away in the `title`. */
export function formatAgo(iso: string | null | undefined): string {
  const date = parse(iso);
  if (!date) return "n/a";
  const seconds = Math.round((Date.now() - date.getTime()) / 1000);
  if (seconds < 0) return "just now";
  const units: Array<[number, string]> = [
    [60, "second"],
    [3600, "minute"],
    [86400, "hour"],
    [2592000, "day"],
  ];
  let previous = 1;
  for (const [bound, name] of units) {
    if (seconds < bound) {
      const value = Math.floor(seconds / previous);
      return value <= 1 ? `${value} ${name} ago` : `${value} ${name}s ago`;
    }
    previous = bound;
  }
  return formatDate(iso);
}

/** Epoch millis into the editable `DD.MM.YYYY HH:MM:SS` an operator types back. */
export function toDateTimeInput(ms: number): string {
  const date = new Date(ms);
  return (
    `${pad(date.getDate())}.${pad(date.getMonth() + 1)}.${date.getFullYear()} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

/**
 * The inverse. Seconds are optional and a comma may stand in for the space, because both are
 * things people type. Rollovers are refused rather than silently normalised — `32.01.2026` is a
 * typo, and a field that quietly turned it into the first of February would hide it.
 */
export function fromDateTimeInput(value: string): number | undefined {
  const match = /^\s*(\d{1,2})\.(\d{1,2})\.(\d{4})[\s,]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*$/.exec(value);
  if (!match) return undefined;
  const [, dd, mm, yyyy, hh, mi, ss] = match;
  const date = new Date(Number(yyyy), Number(mm) - 1, Number(dd), Number(hh), Number(mi), Number(ss ?? "0"));
  const echoes =
    date.getFullYear() === Number(yyyy) &&
    date.getMonth() === Number(mm) - 1 &&
    date.getDate() === Number(dd) &&
    date.getHours() === Number(hh) &&
    date.getMinutes() === Number(mi) &&
    date.getSeconds() === Number(ss ?? "0");
  return echoes ? date.getTime() : undefined;
}
