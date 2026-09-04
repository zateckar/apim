import {
  ATTENTION_CODES,
  type AttentionCode,
  type AttentionRow,
  type AttentionSeverity,
} from "../../../shared/attention.ts";
import type { Tone } from "./status.ts";

/**
 * Rendering an attention row (plan §6.3, §9.4).
 *
 * The control plane decides *whether* a row applies and writes the sentence; this file decides how
 * it reads on screen. Two things live here and nowhere else:
 *
 *  - the **short label** per code, for the chip and the row heading. The control plane's `detail`
 *    is a sentence about one object ("orders v2 has no route in DEV"); a list needs a three-word
 *    handle for the *kind* of problem, and inventing one per screen would give the same problem
 *    three names.
 *  - the **call to action** per code: what the link at the end of the row says. "Fix" is not an
 *    instruction; "Set a route" is.
 */

export const ATTENTION_LABEL: Record<AttentionCode, { title: string; action: string }> = {
  "no-definition": { title: "No definition", action: "Import a definition" },
  "no-route": { title: "No route", action: "Set a route" },
  "no-binding": { title: "No backend", action: "Set a backend" },
  "never-released": { title: "Never published", action: "Publish it" },
  "release-failed": { title: "Publishing failed", action: "See what happened" },
  "release-stale": { title: "Plan out of date", action: "Review and confirm" },
  "config-error": { title: "Not being served", action: "Fix the policy" },
  "no-auth-policy": { title: "Open to anyone", action: "Add authentication" },
  "no-concurrency-ceiling": { title: "No concurrency limit", action: "Add a limit" },
  "validation-downgraded": { title: "Validation downgraded", action: "Review validation" },
  "unreleased-revision": { title: "Unpublished revision", action: "See revisions" },
  "tls-exception-active": { title: "Certificate not verified", action: "Register the authority" },
  "tls-exception-expiring": { title: "Exception expiring", action: "Review the exception" },
  "trust-anchor-expiring": { title: "Authority expiring", action: "Register the replacement" },
  "certificate-expiring": { title: "Certificate expiring", action: "Upload the replacement" },
  "quota-80": { title: "Quota nearly spent", action: "See usage" },
  "quota-exhausted": { title: "Quota spent", action: "See usage" },
  "key-older-than-90-days": { title: "Key is old", action: "Rotate the key" },
  "subscribed-api-deprecated": { title: "API deprecated", action: "See the API" },
  "subscribed-api-retired": { title: "API retired", action: "See the API" },
  "gateway-stale": { title: "Gateway not reporting", action: "See the fleet" },
  "gateway-activation-blocked": { title: "Configuration refused", action: "See the fleet" },
  "job-failed": { title: "Background job failed", action: "See jobs" },
  "start-here-publish": { title: "Publish an API", action: "Start" },
  "start-here-subscribe": { title: "Call an API", action: "Browse the catalog" },
  "start-here-operate": { title: "Check the estate", action: "Open the fleet" },
};

const TONES: Record<AttentionSeverity, Tone> = {
  blocker: "stop",
  warning: "warn",
  info: "neutral",
};

export function severityTone(severity: AttentionSeverity): Tone {
  return TONES[severity];
}

/** What the badge says. "Blocker" is jargon; "Not working" is what it means. */
export const SEVERITY_LABEL: Record<AttentionSeverity, string> = {
  blocker: "Not working",
  warning: "Needs a look",
  info: "Worth knowing",
};

export function labelFor(code: AttentionCode): { title: string; action: string } {
  // A code the UI has not been taught still renders: the control plane's sentence is the content,
  // and a missing label must not blank the row.
  return ATTENTION_LABEL[code] ?? { title: code, action: "Open" };
}

/** Blockers first, and inside a severity the server's order, which is already the code order. */
export function bySeverity(rows: AttentionRow[]): Array<{ severity: AttentionSeverity; rows: AttentionRow[] }> {
  const order: AttentionSeverity[] = ["blocker", "warning", "info"];
  return order
    .map((severity) => ({ severity, rows: rows.filter((row) => row.severity === severity) }))
    .filter((group) => group.rows.length > 0);
}

export { ATTENTION_CODES };
export type { AttentionCode, AttentionRow, AttentionSeverity };
