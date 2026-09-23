import type { DB } from "./db.ts";
import { newId, nowIso } from "./db.ts";
import type { App } from "./router.ts";
import { badRequest, conflict } from "./router.ts";
import { decrypt, encrypt, mintSubscriptionKey } from "./crypto.ts";
import { publishedUrlsFor } from "./api/fleet.ts";
import { writeAudit } from "./audit.ts";
import {
  KAFKA_PROXY_ROLE,
  PLATFORM_APPLICATION_ID,
  PLATFORM_KAFKA_KEY_REF,
  topicApiBlockers,
  type TopicFacts,
} from "../../shared/kafka-proxy.ts";

/**
 * The Kafka REST proxy's facts on the control plane (kafka-rest-proxy): the shared proxy, the
 * platform's own key to it, and what a topic's API is bound to in each stage.
 *
 * Kept apart from the routes in `api/kafka-proxy.ts` because `operations.ts` reads these — the
 * managed unit, the promotion binding — and the routes drive `operations.ts`. One direction each.
 */

/**
 * How a topic's API authenticates to the shared proxy: the platform's own subscription key, in the
 * header the shared proxy's `auth.subscriptionKey` reads. The only unit on it the platform manages.
 */
export const TOPIC_BACKEND_AUTH = {
  type: "api-key",
  credentialRef: PLATFORM_KAFKA_KEY_REF,
  in: "header",
  name: "X-Api-Key",
} as const;

/** The units the platform forces on this resource, or nothing for an ordinary API. */
export function managedUnitsFor(row: { kafka_topic: string | null }): Record<string, unknown> | undefined {
  return row.kafka_topic ? { backendAuth: { ...TOPIC_BACKEND_AUTH } } : undefined;
}

export interface TopicRow {
  id: string;
  application_id: string;
  environment: string;
  name: string;
  partitions: number;
  description: string;
  state: string;
  domain: string | null;
  subdomain: string | null;
  schema_type: string | null;
  schema_json: string | null;
  certificate_id: string | null;
  created_at: string;
}

/** The shared proxy's resource, if an administrator has published it. */
export function sharedProxy(db: DB): { id: string; application_id: string } | null {
  return (
    db
      .query<{ id: string; application_id: string }, [string]>(
        "SELECT id, application_id FROM resource WHERE platform_role = ? AND lifecycle <> 'retired' ORDER BY created_at LIMIT 1",
      )
      .get(KAFKA_PROXY_ROLE) ?? null
  );
}

/** The API generated from a topic, found by the topic's name and its owner — it spans the chain. */
export function topicApiOf(
  db: DB,
  topic: { application_id: string; name: string },
): { id: string } | null {
  return (
    db
      .query<{ id: string }, [string, string]>(
        "SELECT id FROM resource WHERE application_id = ? AND kafka_topic = ? AND lifecycle <> 'retired' ORDER BY created_at LIMIT 1",
      )
      .get(topic.application_id, topic.name) ?? null
  );
}

export function parseSchema(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Whether a certificate can be the topic's: its owner's, in its stage, not expired. */
export function certificateUsable(
  db: DB,
  id: string | null,
  topic: { application_id: string; environment: string },
): boolean | null {
  if (!id) return null;
  const cert = db
    .query<{ application_id: string; environment: string; not_after: string }, [string]>(
      "SELECT application_id, environment, not_after FROM certificate WHERE id = ?",
    )
    .get(id);
  return Boolean(
    cert &&
      cert.application_id === topic.application_id &&
      cert.environment === topic.environment &&
      Date.parse(cert.not_after) > Date.now(),
  );
}

export function topicFacts(db: DB, topic: TopicRow): TopicFacts {
  return {
    state: topic.state,
    schemaType: topic.schema_type,
    schema: parseSchema(topic.schema_json),
    certificateId: topic.certificate_id,
    certificateValid: certificateUsable(db, topic.certificate_id, topic),
  };
}

/**
 * The shared proxy's addresses in a stage: every gateway it is published on, once each. A pool
 * rather than one URL, `failover`, so a topic's API keeps producing while one of a stage's gateways
 * restarts — the hop is a call like any backend call and gets the same breaker.
 */
export function sharedProxyUrls(db: DB, environment: string): string[] {
  const shared = sharedProxy(db);
  if (!shared) return [];
  return [...new Set(publishedUrlsFor(db, shared.id, environment).map((entry) => entry.url))];
}

/**
 * What a topic's API is bound to in one stage: that stage's shared proxy, and that stage's topic's
 * certificate. Refused, with the reason a person can act on, when either is missing — a topic's API
 * is only ever where its topic is.
 */
export function topicApiBinding(
  db: DB,
  row: { application_id: string; kafka_topic: string | null },
  environment: string,
): { urls: string[]; rule: "failover"; clientCertRef: string } {
  const name = row.kafka_topic ?? "";
  const label = environment.toUpperCase();
  const topic = db
    .query<TopicRow, [string, string]>(
      "SELECT * FROM kafka_topic WHERE environment = ? AND name = ? AND state <> 'deleted'",
    )
    .get(environment, name);
  if (!topic)
    throw conflict(`${label} has no Kafka topic named ${name}. Create it there first, then promote its API.`);
  if (topic.application_id !== row.application_id)
    throw conflict(`The Kafka topic ${name} in ${label} belongs to another application.`);
  const blockers = topicApiBlockers(topicFacts(db, topic));
  if (blockers.length > 0) throw conflict(`${name} in ${label}: ${blockers[0]}`);
  const urls = sharedProxyUrls(db, environment);
  if (urls.length === 0)
    throw conflict(
      `The shared Kafka proxy is not published in ${label} yet. An administrator publishes it on Kafka REST proxy.`,
    );
  return { urls, rule: "failover", clientCertRef: topic.certificate_id! };
}

/**
 * The platform's own subscription to the shared proxy in one stage — the key every topic's API
 * there presents. Created with the proxy's operation rather than by `createSubscription`, which
 * requires a member of the subscribing application, and the platform has none by design.
 * `activating` until the fleet has it, like any own-product subscription.
 */
export function ensurePlatformSubscription(app: App, resourceId: string, environment: string): void {
  const product = app.db
    .query<{ product_id: string }, [string]>(
      "SELECT product_id FROM product_member WHERE resource_id = ? ORDER BY rowid LIMIT 1",
    )
    .get(resourceId);
  if (!product) throw badRequest("the shared Kafka proxy is in no product");
  const existing = app.db
    .query(
      "SELECT id FROM subscription WHERE product_id = ? AND application_id = ? AND environment = ? AND state IN ('pending','activating','active','revoking')",
    )
    .get(product.product_id, PLATFORM_APPLICATION_ID, environment);
  if (existing) return;
  const id = newId("sub");
  const at = nowIso();
  app.db.run(
    `INSERT INTO subscription
       (id,product_id,application_id,environment,state,primary_key_enc,primary_key_at,created_at,purpose,requested_by,decision_by,decision_at)
     VALUES (?,?,?,?,'activating',?,?,?,?,NULL,NULL,?)`,
    [
      id,
      product.product_id,
      PLATFORM_APPLICATION_ID,
      environment,
      encrypt(mintSubscriptionKey(environment), app.kek),
      at,
      at,
      "The key every Kafka topic's API presents to the shared Kafka proxy.",
      at,
    ],
  );
  writeAudit(app.db, {
    actor: PLATFORM_APPLICATION_ID,
    action: "subscription.create",
    subject: `subscription:${id}`,
    outcome: "ok",
    detail: { productId: product.product_id, applicationId: PLATFORM_APPLICATION_ID, environment, platform: true },
  });
}

/**
 * The value behind `platform:kafka-proxy` in one stage, for the configuration build — or `null`,
 * which the build reports as an unresolved reference like any other.
 */
export function platformKafkaKey(db: DB, kek: Buffer, environment: string): string | null {
  const row = db
    .query<{ primary_key_enc: string }, [string, string, string]>(
      `SELECT s.primary_key_enc
         FROM subscription s
         JOIN product_member pm ON pm.product_id = s.product_id
         JOIN resource r        ON r.id = pm.resource_id
        WHERE r.platform_role = ? AND s.application_id = ? AND s.environment = ?
          AND s.state IN ('activating','active') AND s.primary_key_expired_at IS NULL
        ORDER BY s.created_at LIMIT 1`,
    )
    .get(KAFKA_PROXY_ROLE, PLATFORM_APPLICATION_ID, environment);
  return row ? decrypt(row.primary_key_enc, kek) : null;
}

/**
 * The platform's keys are rotated, never expired (kafka-rest-proxy, "The platform's key never
 * expires out from under a topic").
 *
 * Expiry exists to make a person replace a key they hold. Nobody holds this one — the gateway is
 * handed both the key's hash and the key in the same document — so retiring it would only break
 * every topic's API at once, and a person would have nothing to rotate. It is replaced instead,
 * at the age a consumer would be warned: one document carries the new hash and the new secret, so
 * no gateway ever holds one without the other.
 */
export function rotatePlatformKeys(app: App, warnDays: number, now = Date.now()): number {
  const rows = app.db
    .query<{ id: string; environment: string; primary_key_at: string | null; created_at: string }, [string]>(
      "SELECT id, environment, primary_key_at, created_at FROM subscription WHERE application_id = ? AND state IN ('activating','active')",
    )
    .all(PLATFORM_APPLICATION_ID);
  let rotated = 0;
  for (const row of rows) {
    const minted = Date.parse(row.primary_key_at ?? row.created_at);
    if (Number.isNaN(minted) || now - minted < warnDays * 86_400_000) continue;
    app.db.run(
      "UPDATE subscription SET primary_key_enc = ?, primary_key_at = ?, primary_key_expired_at = NULL WHERE id = ?",
      [encrypt(mintSubscriptionKey(row.environment), app.kek), new Date(now).toISOString(), row.id],
    );
    writeAudit(app.db, {
      actor: PLATFORM_APPLICATION_ID,
      action: "subscription.rotate",
      subject: `subscription:${row.id}`,
      outcome: "ok",
      detail: { environment: row.environment, platform: true },
    });
    rotated++;
  }
  return rotated;
}
