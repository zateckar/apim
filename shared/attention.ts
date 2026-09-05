/**
 * "What needs attention", as a closed vocabulary (plan §6.3).
 *
 * The list of codes lives here, beside the wire contract, for the same reason the policy unit
 * catalogue does: the control plane decides *whether* a row applies and the UI decides how to
 * render it, and neither may invent a case the other has not heard of. A row is a fact plus the
 * screen that fixes it — never a metric, and never a suggestion without an action.
 *
 * Severity is a property of the **code**, not of the row, so one badge colour cannot mean two
 * things on two screens `[P1-04]`:
 *
 *  - `blocker` — the thing does not work. Nobody can call it, or it is refusing traffic now.
 *  - `warning` — it works and somebody should look: a credential ageing out, a control missing.
 *  - `info`    — worth knowing, costs nothing to ignore today.
 */

export const ATTENTION_CODES = [
  // an API that cannot serve traffic yet
  "no-definition",
  "no-route",
  "no-binding",
  "never-released",
  "release-failed",
  "release-stale",
  "config-error",
  // an API that serves traffic without a control somebody would expect
  "no-auth-policy",
  "no-concurrency-ceiling",
  "validation-downgraded",
  "unreleased-revision",
  "tls-exception-active",
  "tls-exception-expiring",
  "trust-anchor-expiring",
  "certificate-expiring",
  // a subscription's own health
  "quota-80",
  "quota-exhausted",
  "key-older-than-90-days",
  "subscribed-api-deprecated",
  "subscribed-api-retired",
  // the estate
  "gateway-stale",
  "gateway-activation-blocked",
  "job-failed",
  // the empty-estate branch of the same evaluator, and the only three that never appear in an
  // `attention[]` block: "publish your first API" on an application that has fifty is nonsense `[P2-09]`
  "start-here-publish",
  "start-here-subscribe",
  "start-here-operate",
] as const;

export type AttentionCode = (typeof ATTENTION_CODES)[number];
export type AttentionSeverity = "blocker" | "warning" | "info";

export const ATTENTION_SEVERITY: Record<AttentionCode, AttentionSeverity> = {
  "no-definition": "blocker",
  "no-route": "blocker",
  "no-binding": "blocker",
  "never-released": "warning",
  "release-failed": "blocker",
  "release-stale": "blocker",
  "config-error": "blocker",
  "no-auth-policy": "warning",
  "no-concurrency-ceiling": "info",
  "validation-downgraded": "warning",
  "unreleased-revision": "info",
  "tls-exception-active": "warning",
  "tls-exception-expiring": "warning",
  "trust-anchor-expiring": "warning",
  "certificate-expiring": "warning",
  "quota-80": "warning",
  "quota-exhausted": "blocker",
  "key-older-than-90-days": "info",
  "subscribed-api-deprecated": "warning",
  "subscribed-api-retired": "blocker",
  "gateway-stale": "warning",
  "gateway-activation-blocked": "blocker",
  "job-failed": "warning",
  "start-here-publish": "info",
  "start-here-subscribe": "info",
  "start-here-operate": "info",
};

/**
 * Produced only into `startHere`, never into an `attention[]` block. Exported so the assertion is
 * one line in the evaluator and one line in the test, rather than a rule written twice.
 */
export const START_HERE_CODES: readonly AttentionCode[] = [
  "start-here-publish",
  "start-here-subscribe",
  "start-here-operate",
];

/**
 * `certificate` and `anchor` are their own kinds rather than being folded into `environment`: a
 * row that says "something in DEV expires on Friday" cannot be linked to the thing that expires.
 */
export type AttentionSubjectKind =
  | "resource"
  | "subscription"
  | "environment"
  | "instance"
  | "job"
  | "certificate"
  | "anchor"
  /** The three `start-here-*` rows, whose subject is the portal itself and not a thing in it. */
  | "portal";

export interface AttentionSubject {
  kind: AttentionSubjectKind;
  id: string;
  /** What a human calls it: "orders v2", "checkout-app → orders-product", "dev-1". */
  name: string;
}

export interface AttentionRow {
  code: AttentionCode;
  severity: AttentionSeverity;
  subject: AttentionSubject;
  /** Absent when the fact is not per environment — an API with no definition anywhere. */
  environment?: string;
  /** One sentence, plain language, no jargon that is not a glossary term. */
  detail: string;
  /** The screen that fixes it. */
  href: string;
}

const RANK: Record<AttentionSeverity, number> = { blocker: 0, warning: 1, info: 2 };

/**
 * Severity first, then the code's position in `ATTENTION_CODES`, then the subject name — so two
 * calls with the same rows produce the same order and a truncated list drops the least urgent.
 */
export function sortAttention(rows: AttentionRow[]): AttentionRow[] {
  const order = new Map(ATTENTION_CODES.map((code, index) => [code, index]));
  return [...rows].sort(
    (a, b) =>
      RANK[a.severity] - RANK[b.severity] ||
      (order.get(a.code) ?? 0) - (order.get(b.code) ?? 0) ||
      a.subject.name.localeCompare(b.subject.name) ||
      (a.environment ?? "").localeCompare(b.environment ?? ""),
  );
}
