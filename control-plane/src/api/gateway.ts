import { canonicalJson } from "../../../shared/canonical.ts";
import { CONFIG_VERSION } from "../../../shared/config-doc.ts";
import type { PollRequest, PollResponse } from "../../../shared/telemetry.ts";
import { readArtifact } from "../artifacts.ts";
import { buildConfig } from "../config-build.ts";
import { decrypt } from "../crypto.ts";
import { nowIso } from "../db.ts";
import {
  badRequest,
  HttpError,
  json,
  notFound,
  requireAdmin,
  Router,
  type Ctx,
} from "../router.ts";

/**
 * The instance protocol (design section 8.5, deviation D11).
 *
 * Section 8.5 describes the poll as bidirectional and single round-trip: the request carries the
 * instance's report, the response carries config. v1 implemented only the downward half and used
 * `GET` with `ETag`/`304`. v2 carries telemetry up on the same request — no new channel, no new
 * protocol — and answers "nothing changed" with an explicit field, because `304` is defined for
 * conditional `GET` and reusing it on a `POST` would be a lie about the status code.
 *
 * The instance still reports the digest it has *activated*, not the one it is asking about, so
 * the fleet view lags exactly one poll. That is design section 8.7's intent, not a defect.
 */
async function readReport(ctx: Ctx): Promise<PollRequest> {
  const declared = Number(ctx.req.headers.get("content-length") ?? "0");
  const max = ctx.app.config.maxReportBytes;
  if (Number.isFinite(declared) && declared > max) {
    throw new HttpError(413, "Payload Too Large", `poll report larger than ${max} bytes`);
  }
  const text = await ctx.req.text();
  if (Buffer.byteLength(text, "utf8") > max) {
    throw new HttpError(413, "Payload Too Large", `poll report larger than ${max} bytes`);
  }
  try {
    return JSON.parse(text) as PollRequest;
  } catch (err) {
    throw badRequest(`poll body is not valid JSON: ${(err as Error).message}`);
  }
}

/**
 * Whether this instance's own environment currently references the digest.
 *
 * Asked of `buildConfig` rather than re-derived from `release` (plan `[R2-31]`, `[R4-03]`). A
 * second query that means to say the same thing as the config builder is a second source of truth,
 * and the two would drift the first time a route stopped being rendered for a reason the query did
 * not know about — an invalid effective policy, a missing binding, a lifecycle. Then an instance
 * could fetch a bundle for a route it will never be told about. Building the config is more work
 * than a join; it happens once per digest per instance per config change, which is rare by
 * construction because the digest is content-addressed.
 */
function artifactReachableFrom(ctx: Ctx, digest: string): boolean {
  const config = buildConfig(
    ctx.app.db,
    ctx.app.kek,
    ctx.instance!.environment,
    ctx.app.config.integrations,
  );
  return config.routes.some((route) => route.artifacts.some((ref) => ref.digest === digest));
}

/**
 * Merge a reason into the instance's process gauges without disturbing them. `last_seen_at` is
 * touched too: the instance *is* polling, and calling it stale would name the wrong problem.
 */
function recordActivationBlocked(ctx: Ctx, instanceId: string, reason: string): void {
  const row = ctx.app.db
    .query<{ process_json: string | null }, [string]>(
      "SELECT process_json FROM gateway_instance WHERE id = ?",
    )
    .get(instanceId);
  let process: Record<string, unknown> = {};
  try {
    process = row?.process_json ? (JSON.parse(row.process_json) as Record<string, unknown>) : {};
  } catch {
    process = {};
  }
  ctx.app.db.run("UPDATE gateway_instance SET last_seen_at = ?, process_json = ? WHERE id = ?", [
    nowIso(),
    JSON.stringify({ ...process, activationBlocked: reason, observedAt: nowIso() }),
    instanceId,
  ]);
}

export function registerGatewayRoutes(router: Router): void {
  router.add("POST", "/api/gateway/poll", "instance", async (ctx: Ctx) => {
    const instance = ctx.instance!;
    const body = await readReport(ctx);

    if (body.wireVersion !== CONFIG_VERSION) {
      // Recorded before it is refused. The instance cannot report its own block — every poll it
      // makes is rejected — so if the control plane did not write it here, a gateway on an old
      // build would be invisible: still serving stale config, and looking merely slow to converge
      // in the fleet view (plan §10, `[P1-07]`).
      recordActivationBlocked(
        ctx,
        instance.id,
        `the instance speaks wire version ${body.wireVersion}; this control plane speaks ` +
          `${CONFIG_VERSION}. It is serving the last config it accepted and will activate nothing ` +
          "new until it is upgraded",
      );
      throw badRequest(
        `wireVersion ${body.wireVersion} is not supported (this control plane speaks ${CONFIG_VERSION})`,
        { expected: CONFIG_VERSION, received: body.wireVersion ?? null },
      );
    }
    const runId = body.instance?.runId;
    if (typeof runId !== "string" || runId.length === 0) {
      throw badRequest("instance.runId is required: it is what keeps a restart from replacing a window");
    }

    // The environment comes from the instance's target, never from the report: an instance
    // cannot report traffic for an environment it does not belong to.
    const environment = instance.environment;
    const accepted = ctx.app.telemetry.accept(
      environment,
      instance.id,
      runId,
      body.telemetry ?? { droppedSeries: 0, droppedWindows: 0, windows: [] },
      Date.now(),
    );

    // Design section 5.7: the deltas ride the poll that already exists. Taken before the config is
    // built, so a slow build cannot lose a report that has already arrived.
    ctx.app.quota.accept(environment, body.quota?.deltas);

    ctx.app.db.run(
      `UPDATE gateway_instance
          SET last_seen_at = ?, config_digest = ?, last_ip = ?, process_json = ?
        WHERE id = ?`,
      [
        nowIso(),
        body.instance?.activeDigest ?? null,
        ctx.req.headers.get("x-forwarded-for") ?? null,
        JSON.stringify({
          ...(body.instance?.process ?? {}),
          requestsTotal: body.instance?.requestsTotal ?? 0,
          droppedSeries: body.telemetry?.droppedSeries ?? 0,
          droppedWindows: body.telemetry?.droppedWindows ?? 0,
          startedAt: body.instance?.startedAt ?? null,
          // Why this instance is not on the digest below. Shown in the fleet view rather than
          // leaving an instance looking merely slow to converge (plan `[R1-21]`).
          activationBlocked: body.instance?.activationBlocked ?? null,
          // Validation counters are per instance and not windowed, so they are held on the
          // instance row beside the process gauges rather than rolled up per minute.
          validation: body.telemetry?.validation ?? null,
          runId,
          observedAt: nowIso(),
        }),
        instance.id,
      ],
    );

    const config = buildConfig(ctx.app.db, ctx.app.kek, environment, ctx.app.config.integrations);
    const unchanged = body.instance?.activeDigest === config.digest;
    const quotaAggregates = ctx.app.quota.aggregatesFor(environment);
    const response: PollResponse = {
      wireVersion: CONFIG_VERSION,
      unchanged,
      digest: config.digest,
      acceptedWindows: accepted,
      ...(unchanged ? {} : { config }),
      // Sent even when nothing changed: an idle instance still needs the fleet's counts, because
      // the other instances have been counting.
      ...(quotaAggregates.length > 0 ? { quotaAggregates } : {}),
    };
    // Canonical body, so the bytes served and the digest inside them always agree.
    return new Response(canonicalJson(response), {
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
    });
  });

  /**
   * The compiled-validator channel (design section 8.7). A second channel rather than more bytes in
   * the config document, because bundles are large, change rarely and are shared across
   * environments — putting them inline would mean every instance re-downloading every schema on
   * every revision of anything.
   *
   * Content-addressed, so the response is immutable and may be cached forever. Scoped to instances
   * that could reach the digest through their own environment's config: an instance token is a
   * fleet credential, and without the check any instance could enumerate every contract in the
   * estate (plan `[R2-16]`).
   */
  router.add("GET", "/api/gateway/artifacts/:digest", "instance", (ctx) => {
    const digest = ctx.params.digest!;
    if (!artifactReachableFrom(ctx, digest)) {
      // Not 403: whether the digest exists at all is exactly what an instance outside its scope
      // must not learn.
      throw notFound(`no artifact ${digest} is referenced by this instance's environment`);
    }
    const stored = readArtifact(ctx.app.db, digest);
    if (!stored) throw notFound(`no artifact ${digest}`);
    return new Response(stored.bytes, {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "content-length": String(Buffer.byteLength(stored.bytes, "utf8")),
        // The name *is* the content: it can never mean anything else.
        "cache-control": "public, max-age=31536000, immutable",
        etag: `"${digest}"`,
      },
    });
  });

  /**
   * The certificate channel: the client identity a route presents to its backend, private key
   * included. It travels the same way as an artifact and is gated the same way, and it is the one
   * response in this API that carries a decrypted secret — so it is `no-store`, and the instance
   * writes it `0600` into a directory design section 8.7 requires to be encrypted at rest
   * (deviation D22).
   */
  router.add("GET", "/api/gateway/certificates/:id", "instance", (ctx) => {
    const row = ctx.app.db
      .query<
        {
          id: string;
          environment: string;
          thumbprint: string;
          cert_pem: string;
          chain_pem: string | null;
          key_enc: string;
          not_after: string;
        },
        [string]
      >(
        `SELECT id, environment, thumbprint, cert_pem, chain_pem, key_enc, not_after
           FROM certificate WHERE id = ?`,
      )
      .get(ctx.params.id!);
    if (!row || row.environment !== ctx.instance!.environment) {
      throw notFound(`no certificate ${ctx.params.id} in ${ctx.instance!.environment}`);
    }
    // An expired identity is not served at all. Presenting it would fail the TLS handshake anyway,
    // but failing here names the reason once instead of once per request.
    if (Date.parse(row.not_after) <= Date.now()) {
      throw new HttpError(
        409,
        "Conflict",
        `certificate ${row.id} expired at ${row.not_after}; upload a replacement`,
      );
    }
    return json(
      {
        id: row.id,
        thumbprint: row.thumbprint,
        certPem: row.cert_pem,
        keyPem: decrypt(row.key_enc, ctx.app.kek),
        ...(row.chain_pem ? { chainPem: row.chain_pem } : {}),
      },
      { headers: { "cache-control": "no-store" } },
    );
  });

  /**
   * The projection, for humans. Admin-only: it is every subscription's key hash and every
   * route's policy in one document (review V2-08). The fleet view reads summary data from
   * `/api/targets/:environment/health` instead.
   */
  router.add("GET", "/api/environments/:environment/config", "session", (ctx) => {
    requireAdmin(ctx, "the rendered gateway config is admin-only");
    const environment = ctx.params.environment!;
    if (!ctx.app.config.promotionChain.includes(environment)) {
      throw notFound(`unknown environment "${environment}"`);
    }
    return json(buildConfig(ctx.app.db, ctx.app.kek, environment, ctx.app.config.integrations), {
      headers: { "cache-control": "no-store" },
    });
  });

  router.add("GET", "/healthz", "public", () => json({ ok: true, service: "control-plane" }));

  router.add("GET", "/readyz", "public", (ctx) => {
    const version = ctx.app.db
      .query<{ v: number }, []>("SELECT MAX(version) AS v FROM schema_version")
      .get();
    return json({ ok: true, schemaVersion: version?.v ?? 0, wireVersion: CONFIG_VERSION });
  });
}
