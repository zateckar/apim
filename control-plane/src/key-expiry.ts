import { nowIso } from "./db.ts";
import { writeAudit } from "./audit.ts";
import { emitIntegration } from "./integrations.ts";
import type { App } from "./router.ts";
import { rotatePlatformKeys } from "./kafka-proxy.ts";

/**
 * Subscription keys age, and past a point they stop working.
 *
 * Two thresholds, and they are different kinds of thing. `SUBSCRIPTION_KEY_WARN_DAYS` is when the
 * portal starts saying so — the attention list, the subscription screen, the owner's mail. It
 * changes nothing. `SUBSCRIPTION_KEY_EXPIRE_DAYS` is when the key is retired: the slot is marked
 * here, `buildSubscriptions` then leaves its hash out of the environment's configuration document,
 * and the gateway — which has never heard of an expiry and needs no new code for this — simply
 * does not know the key and answers `401`.
 *
 * Marking rather than filtering at build time is the whole design. It keeps the configuration
 * document a function of the database instead of a function of the database and the wall clock, so
 * two builds a second apart cannot disagree and set the fleet re-polling; it leaves a date to show
 * the consumer and to write into the audit log; and it means the expiry is an event that happened
 * at a knowable moment rather than a property that quietly became true. `tls_exception` goes the
 * other way — it stores `expires_at` and filters on `now` while building — and that is right for an
 * exception granted with an end date agreed up front. It is not right for a fleet-wide policy an
 * administrator may shorten, because the stored date would go on meaning the old number.
 *
 * The deadline itself is deliberately not stored anywhere. It is the slot's minting date plus the
 * policy as it reads *when this job runs*, so lowering `SUBSCRIPTION_KEY_EXPIRE_DAYS` applies to
 * the keys that already exist. That is what a deadline means; a stored `expires_at` would apply
 * the new number only to keys minted afterwards and leave the estate holding two answers.
 *
 * Nothing is destroyed. `primary_key_enc` is NOT NULL and stays populated: a slot whose material
 * had been thrown away could not be described to the person who has to replace it, and rotating
 * the slot clears the mark.
 */
export interface KeyExpiryResult {
  expired: number;
  warned: number;
}

interface AgingRow {
  id: string;
  application_id: string;
  environment: string;
  product_name: string;
  application_name: string;
  primary_key_at: string | null;
  secondary_key_at: string | null;
  secondary_key_enc: string | null;
  primary_key_expired_at: string | null;
  secondary_key_expired_at: string | null;
  created_at: string;
}

const DAY_MS = 86_400_000;

/** Days since a slot's current key was minted, falling back to when the subscription was made. */
export function keyAgeDays(mintedAt: string | null, createdAt: string, now: number): number {
  const at = Date.parse(mintedAt ?? createdAt);
  if (Number.isNaN(at)) return 0;
  return Math.max(0, (now - at) / DAY_MS);
}

export function runKeyExpiry(app: App, now = Date.now()): KeyExpiryResult {
  const { expireDays, warnDays } = {
    expireDays: app.config.subscriptionKeyExpireDays,
    warnDays: app.config.subscriptionKeyWarnDays,
  };
  // Only `active` subscriptions. A revoked or rejected one has no working key to retire, and
  // marking it would put an expiry date on a row whose keys stopped mattering for another reason.
  const rows = app.db
    .query<AgingRow, []>(
      `SELECT s.id, s.application_id, s.environment, s.created_at,
              s.primary_key_at, s.secondary_key_at, s.secondary_key_enc,
              s.primary_key_expired_at, s.secondary_key_expired_at,
              a.name AS application_name, p.name AS product_name
         FROM subscription s
         JOIN application a ON a.id = s.application_id
         JOIN product p     ON p.id = s.product_id
        WHERE s.state = 'active' AND s.application_id <> 'platform'`,
    )
    .all();

  // The platform's own keys are rotated rather than retired; see `rotatePlatformKeys`.
  rotatePlatformKeys(app, warnDays, now);

  let expired = 0;
  let warned = 0;
  const stamp = nowIso();

  for (const row of rows) {
    const slots: Array<{ which: "primary" | "secondary"; age: number; alreadyExpired: boolean }> = [
      {
        which: "primary",
        age: keyAgeDays(row.primary_key_at, row.created_at, now),
        alreadyExpired: row.primary_key_expired_at !== null,
      },
    ];
    // A subscription has a second key only once somebody has rotated. An absent slot cannot age.
    if (row.secondary_key_enc) {
      slots.push({
        which: "secondary",
        age: keyAgeDays(row.secondary_key_at, row.created_at, now),
        alreadyExpired: row.secondary_key_expired_at !== null,
      });
    }

    for (const slot of slots) {
      if (slot.alreadyExpired || slot.age < expireDays) {
        if (!slot.alreadyExpired && slot.age >= warnDays) warned++;
        continue;
      }
      const column = slot.which === "primary" ? "primary_key_expired_at" : "secondary_key_expired_at";
      app.db.run(`UPDATE subscription SET ${column} = ? WHERE id = ?`, [stamp, row.id]);
      expired++;
      writeAudit(app.db, {
        actor: "key-expiry",
        action: "subscription.key-expired",
        subject: `subscription:${row.id}`,
        outcome: "ok",
        detail: {
          which: slot.which,
          ageDays: Math.floor(slot.age),
          expireDays,
          environment: row.environment,
        },
      });
      // The consumer owns the key, so the consumer is told. They are the only ones who can rotate
      // it, and by the time this fires their callers are already being refused.
      emitIntegration(app, row.application_id, "email", "subscription.key-expired", row.id, {
        subject: `${slot.which} key for ${row.product_name} in ${row.environment.toUpperCase()} has expired`,
      });
    }
  }

  return { expired, warned };
}
