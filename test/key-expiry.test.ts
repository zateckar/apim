import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { buildConfig } from "../control-plane/src/config-build.ts";
import { runDueJobs } from "../control-plane/src/jobs.ts";
import { runKeyExpiry } from "../control-plane/src/key-expiry.ts";
import { makeCp, publishApi, startBackend, type TestCp } from "./helpers.ts";

/**
 * A subscription key ages, is complained about, and then stops working.
 *
 * The enforcement is deliberately invisible to the data plane: the gateway has never heard of an
 * expiry and needs no code for one, because a key it was not given is a key it does not know. So
 * what these tests check is that the retired slot leaves the environment's configuration document,
 * and that everything downstream of that follows.
 */
let cp: TestCp;
let backend: Awaited<ReturnType<typeof startBackend>>;

const DAY = 86_400_000;
const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();

beforeEach(async () => {
  backend = await startBackend();
  cp = makeCp();
});
afterEach(async () => {
  cp.close();
  await backend.stop();
});

/** How many keys the environment's document offers for this subscription. */
function keyHashes(subscriptionId: string): string[] {
  const config = buildConfig(cp.app.db, cp.app.kek, "dev", cp.app.config);
  return config.subscriptions.find((s) => s.id === subscriptionId)?.keyHashes ?? [];
}

function ageSlot(id: string, which: "primary" | "secondary", days: number) {
  cp.app.db.run(`UPDATE subscription SET ${which}_key_at = ? WHERE id = ?`, [
    iso(-days * DAY),
    id,
  ]);
}

describe("a subscription key that has aged out", () => {
  test("the default policy is 365 to warn and 600 to stop working", () => {
    // Both are what the predecessor estate is being migrated onto, and the gap between them is the
    // runway: rotating means coordinating with the teams that call you.
    expect(cp.app.config.subscriptionKeyWarnDays).toBe(365);
    expect(cp.app.config.subscriptionKeyExpireDays).toBe(600);
  });

  test("a fresh key is in the document, an expired one is not", async () => {
    const api = await publishApi(cp, { backendUrl: backend.url });
    const id = api.subscriptionId!;
    expect(keyHashes(id)).toHaveLength(1);

    // Short of the deadline nothing happens, however loudly the portal is warning.
    ageSlot(id, "primary", 599);
    expect(runKeyExpiry(cp.app).expired).toBe(0);
    expect(keyHashes(id)).toHaveLength(1);

    ageSlot(id, "primary", 601);
    expect(runKeyExpiry(cp.app).expired).toBe(1);
    // The subscription is still in the document with no keys at all, rather than gone from it:
    // the entry is what telemetry, quota and the logs name the caller by, and dropping it would
    // turn a refused call from "this subscription's keys are dead" into an anonymous 401.
    expect(keyHashes(id)).toHaveLength(0);
    expect(
      cp.app.db
        .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM subscription WHERE primary_key_expired_at IS NOT NULL")
        .get()!.n,
    ).toBe(1);
  });

  test("expiring is recorded once, not on every pass", async () => {
    const api = await publishApi(cp, { backendUrl: backend.url });
    ageSlot(api.subscriptionId!, "primary", 900);
    expect(runKeyExpiry(cp.app).expired).toBe(1);
    expect(runKeyExpiry(cp.app).expired).toBe(0);
    expect(runKeyExpiry(cp.app).expired).toBe(0);
    // One audit row, and it names which slot and how old — the two things somebody reconstructing
    // an outage needs and cannot get from the subscription row afterwards.
    const audits = cp.app.db
      .query<{ detail: string }, []>(
        "SELECT detail FROM audit WHERE action='subscription.key-expired'",
      )
      .all();
    expect(audits).toHaveLength(1);
    expect(JSON.parse(audits[0]!.detail).which).toBe("primary");
    expect(JSON.parse(audits[0]!.detail).ageDays).toBeGreaterThanOrEqual(900);
  });

  test("one slot expiring leaves the other working, which is what two slots are for", async () => {
    const api = await publishApi(cp, { backendUrl: backend.url });
    const id = api.subscriptionId!;
    // Rotate to mint a secondary, then age only the primary past the deadline.
    const rotate = await cp.call("POST", `/api/subscriptions/${id}/rotate`, {
      cookie: api.clara,
      body: { which: "secondary" },
    });
    expect(rotate.status).toBe(200);
    expect(keyHashes(id)).toHaveLength(2);

    ageSlot(id, "primary", 700);
    runKeyExpiry(cp.app);
    // The secondary is untouched, so the callers who were moved onto it never notice.
    expect(keyHashes(id)).toHaveLength(1);
    const row = cp.app.db
      .query<{ p: string | null; s: string | null }, [string]>(
        "SELECT primary_key_expired_at AS p, secondary_key_expired_at AS s FROM subscription WHERE id=?",
      )
      .get(id)!;
    expect(row.p).not.toBeNull();
    expect(row.s).toBeNull();
  });

  test("rotating an expired slot brings it back", async () => {
    const api = await publishApi(cp, { backendUrl: backend.url });
    const id = api.subscriptionId!;
    ageSlot(id, "primary", 700);
    runKeyExpiry(cp.app);
    expect(keyHashes(id)).toHaveLength(0);

    // The new key is not the old one, so the mark that retired the old one describes nothing.
    const rotate = await cp.call("POST", `/api/subscriptions/${id}/rotate`, {
      cookie: api.clara,
      body: { which: "primary" },
    });
    expect(rotate.status).toBe(200);
    expect(keyHashes(id)).toHaveLength(1);
    expect(
      cp.app.db
        .query<{ p: string | null }, [string]>(
          "SELECT primary_key_expired_at AS p FROM subscription WHERE id=?",
        )
        .get(id)!.p,
    ).toBeNull();
  });

  test("a subscription that is not active is left alone", async () => {
    const api = await publishApi(cp, { backendUrl: backend.url });
    const id = api.subscriptionId!;
    ageSlot(id, "primary", 900);
    cp.app.db.run("UPDATE subscription SET state='revoked' WHERE id=?", [id]);
    expect(runKeyExpiry(cp.app).expired).toBe(0);
    // Its keys stopped mattering for another reason, and stamping an expiry date on the row would
    // claim they died of old age.
    expect(
      cp.app.db
        .query<{ p: string | null }, [string]>(
          "SELECT primary_key_expired_at AS p FROM subscription WHERE id=?",
        )
        .get(id)!.p,
    ).toBeNull();
  });

  test("the each-slot ages are on the subscription the consumer reads", async () => {
    const api = await publishApi(cp, { backendUrl: backend.url });
    const id = api.subscriptionId!;
    ageSlot(id, "primary", 400);
    // There is no `GET /api/subscriptions/:id` — the detail screen filters the list, which is what
    // this reads too, so the shape asserted here is the one the screen actually receives.
    const list = await (
      await cp.call("GET", "/api/subscriptions", { cookie: api.clara })
    ).json();
    const view = list.items.find((s: { id: string }) => s.id === id);
    const primary = view.keys.find((k: { which: string }) => k.which === "primary");
    const secondary = view.keys.find((k: { which: string }) => k.which === "secondary");
    expect(primary.ageDays).toBe(400);
    expect(primary.status).toBe("ageing");
    // The projected deadline is 600 days after minting, not 600 days from now.
    expect(Date.parse(primary.expiresAt) - Date.parse(primary.mintedAt)).toBe(600 * DAY);
    // Nobody has rotated, so there is no second key — and no age for one that does not exist.
    expect(secondary.status).toBe("absent");
    expect(secondary.ageDays).toBeNull();
  });

  test("the job runs on the ordinary schedule, not only when called by hand", async () => {
    const api = await publishApi(cp, { backendUrl: backend.url });
    ageSlot(api.subscriptionId!, "primary", 900);
    runDueJobs(cp.app);
    expect(keyHashes(api.subscriptionId!)).toHaveLength(0);
  });
});
