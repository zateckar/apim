import type { DB } from "./db.ts";
import { newId, nowIso } from "./db.ts";

/**
 * Append-only by trigger (design section 4). Every mutation writes one row: actor, action,
 * subject, outcome, and enough detail to answer "who changed this, when, and to what".
 */
export function writeAudit(
  db: DB,
  entry: {
    actor: string;
    action: string;
    subject: string;
    outcome: "ok" | "denied" | "failed";
    detail?: unknown;
  },
): void {
  db.run(
    "INSERT INTO audit (id, at, actor, action, subject, outcome, detail) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [
      newId("aud"),
      nowIso(),
      entry.actor,
      entry.action,
      entry.subject,
      entry.outcome,
      entry.detail === undefined ? null : JSON.stringify(entry.detail),
    ],
  );
}
