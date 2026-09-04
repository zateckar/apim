import { readBackendPool } from "../../../shared/backend.ts";
import { writeAudit } from "../audit.ts";
import { CertificateError, daysUntil, parseCertificate } from "../certificates.ts";
import { encrypt } from "../crypto.ts";
import { newId, nowIso } from "../db.ts";
import { checkEgress, DEFAULT_TLS_EXCEPTION_MAX_DAYS } from "../egress.ts";
import {
  caBundleFor,
  invalidateTrustBundle,
  liveAnchorsFor,
  parseAnchor,
} from "../trust-store.ts";
import {
  badRequest,
  conflict,
  forbidden,
  json,
  notFound,
  readJson,
  requireAdmin,
  requireUser,
  Router,
  type Ctx,
} from "../router.ts";
import { assertCan, environmentOf, getResource, touch } from "./common.ts";

/**
 * Trust, in the two directions it runs (design sections 4.3 and 5.4).
 *
 * **Certificates** are the identity this estate *presents* to a backend. They carry private keys,
 * so they are team-scoped, KEK-encrypted, and never returned in full over this API — the only
 * reader of the key is the instance channel in `api/gateway.ts`.
 *
 * **TLS exceptions** are the identity this estate is willing to *accept* from a backend, relaxed.
 * They live in their own table rather than inside `binding.backend_json` for three reasons the
 * design gives and one this file enforces:
 *
 *  - inside a binding they would be **owner-writable**, and "should we stop verifying this
 *    backend's certificate" is not an owner's decision to make alone;
 *  - they would be **invisible** to "list every unverified backend in prod", which is the question
 *    an auditor actually asks;
 *  - they would be **permanent by default**, because nothing would carry an expiry;
 *  - and the expiry is bounded by `TLS_EXCEPTION_MAX_DAYS`, so "temporary" has a number attached.
 *
 * The instance self-expires on `expiresAt` using its own clock, so an exception cannot outlive its
 * date through a control-plane outage. D25 states the one window that remains: an existing
 * connection keeps its TLS options until it is closed.
 */

const MODES = ["pin", "skip-hostname", "insecure"] as const;
type ExceptionMode = (typeof MODES)[number];

// `requireAdmin` moved to `router.ts` in v5, where all seven admin carve-outs now live.

export function registerTrustRoutes(router: Router): void {
  // ---------------------------------------------------------------- certificates (section 4.3)

  router.add("GET", "/api/certificates", "session", (ctx) => {
    const environment = environmentOf(ctx);
    const rows = ctx.app.db
      .query<
        {
          id: string;
          team_id: string;
          name: string;
          thumbprint: string;
          subject: string;
          issuer: string;
          not_before: string;
          not_after: string;
          usage: string;
          created_by: string;
          created_at: string;
        },
        [string]
      >(
        `SELECT id, team_id, name, thumbprint, subject, issuer, not_before, not_after, usage,
                created_by, created_at
           FROM certificate WHERE environment = ? ORDER BY name`,
      )
      .all(environment);

    const now = Date.now();
    return json({
      environment,
      items: rows.map((row) => ({
        id: row.id,
        teamId: row.team_id,
        name: row.name,
        thumbprint: row.thumbprint,
        subject: row.subject,
        issuer: row.issuer,
        notBefore: row.not_before,
        notAfter: row.not_after,
        usage: row.usage,
        createdBy: row.created_by,
        createdAt: row.created_at,
        // The number the Trust screen sorts by: an expired client certificate is an outage on
        // every request through that binding, and nothing else warns about it.
        expiresInDays: daysUntil(row.not_after, now),
        expired: Date.parse(row.not_after) <= now,
        usedBy: bindingsUsing(ctx, row.id),
      })),
    });
  });

  router.add("POST", "/api/certificates", "session", async (ctx) => {
    const user = requireUser(ctx);
    const body = await readJson<{
      environment?: string;
      teamId?: string;
      name?: string;
      certPem?: string;
      chainPem?: string | null;
      keyPem?: string;
    }>(ctx, 1024 * 1024);

    const environment = body.environment ?? environmentOf(ctx);
    if (!ctx.app.config.promotionChain.includes(environment)) {
      throw badRequest(`unknown environment "${environment}"`);
    }
    const teamId = body.teamId ?? "";
    assertCan(user, teamId, "upload a certificate for this team");
    const name = body.name ?? "";
    if (!/^[a-z0-9][a-z0-9-]{1,60}$/.test(name)) {
      throw badRequest("name: expected 2-61 lowercase letters, digits or hyphens");
    }

    let parsed;
    try {
      parsed = parseCertificate({
        certPem: body.certPem ?? "",
        chainPem: body.chainPem ?? null,
        keyPem: body.keyPem ?? "",
      });
    } catch (err) {
      if (err instanceof CertificateError) throw badRequest(err.message);
      throw err;
    }

    const id = newId("cert");
    const at = nowIso();
    try {
      ctx.app.db.run(
        `INSERT INTO certificate
           (id, team_id, environment, name, cert_pem, chain_pem, key_enc, thumbprint, subject,
            issuer, not_before, not_after, usage, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'backend-mtls', ?, ?)`,
        [
          id,
          teamId,
          environment,
          name,
          parsed.certPem,
          parsed.chainPem,
          encrypt(parsed.keyPem, ctx.app.kek),
          parsed.thumbprint,
          parsed.subject,
          parsed.issuer,
          parsed.notBefore,
          parsed.notAfter,
          user.id,
          at,
        ],
      );
    } catch (err) {
      if (String(err).includes("UNIQUE")) {
        throw conflict(`this team already has a certificate named ${name} in ${environment}`);
      }
      throw err;
    }

    writeAudit(ctx.app.db, {
      actor: user.id,
      action: "certificate.upload",
      subject: `certificate:${id}`,
      outcome: "ok",
      // The thumbprint, never the key: an audit row is not a place to leak one.
      detail: { environment, teamId, name, thumbprint: parsed.thumbprint, notAfter: parsed.notAfter },
    });
    return json(
      {
        id,
        name,
        environment,
        teamId,
        thumbprint: parsed.thumbprint,
        subject: parsed.subject,
        issuer: parsed.issuer,
        notBefore: parsed.notBefore,
        notAfter: parsed.notAfter,
        expiresInDays: daysUntil(parsed.notAfter),
      },
      { status: 201 },
    );
  });

  router.add("DELETE", "/api/certificates/:id", "session", (ctx) => {
    const user = requireUser(ctx);
    const row = ctx.app.db
      .query<{ id: string; team_id: string; name: string; environment: string }, [string]>(
        "SELECT id, team_id, name, environment FROM certificate WHERE id = ?",
      )
      .get(ctx.params.id!);
    if (!row) throw notFound(`no certificate ${ctx.params.id}`);
    assertCan(user, row.team_id, "delete this certificate");

    // Deleting one a binding still names would break that route's next handshake, with nothing on
    // the route to say why. The binding has to be changed first.
    const used = bindingsUsing(ctx, row.id);
    if (used.length > 0) {
      throw conflict(
        `this certificate is the client identity for ${used.length} binding(s) ` +
          `(${used.map((u) => u.resourceName).join(", ")}); change those bindings first`,
      );
    }

    ctx.app.db.run("DELETE FROM certificate WHERE id = ?", [row.id]);
    writeAudit(ctx.app.db, {
      actor: user.id,
      action: "certificate.delete",
      subject: `certificate:${row.id}`,
      outcome: "ok",
      detail: { name: row.name, environment: row.environment },
    });
    return new Response(null, { status: 204 });
  });

  // ---------------------------------------------------------------- trust anchors (section 5.4)

  /**
   * Rung 1 of the TLS ladder, per environment (G4, plan §8). Admin-only, like every other row in
   * this file: design section 9's carve-out is that turning verification off is not a resource
   * owner's decision, and deciding *whose* certificates verify is the same decision seen from the
   * other side.
   */
  router.add("GET", "/api/trust/anchors", "session", (ctx) => {
    requireAdmin(ctx, "the trust store is admin-only (design section 5.4)");
    const environment = environmentOf(ctx);
    const includeRemoved = ctx.url.searchParams.get("includeRemoved") === "1";
    const now = Date.now();

    const rows = ctx.app.db
      .query<AnchorRow, [string]>(
        `SELECT id, environment, name, cert_pem, subject, issuer, thumbprint, not_before, not_after,
                added_by, added_at, removed_at
           FROM trust_anchor WHERE environment = ? ORDER BY removed_at IS NOT NULL, added_at`,
      )
      .all(environment);

    // Where else the same certificate is live, so "copy this to TEST" is a decision made with the
    // answer in front of you rather than by trying it.
    const elsewhere = ctx.app.db
      .query<{ thumbprint: string; environment: string }, [string]>(
        `SELECT DISTINCT thumbprint, environment
           FROM trust_anchor WHERE removed_at IS NULL AND environment <> ?`,
      )
      .all(environment);

    const items = rows
      .map((row) => ({
        ...anchorView(row, now),
        alsoLiveIn: elsewhere
          .filter((other) => other.thumbprint === row.thumbprint)
          .map((other) => other.environment)
          .sort(),
      }))
      .filter((item) => includeRemoved || item.removedAt === null);

    return json({
      environment,
      maxAnchors: ctx.app.config.maxTrustAnchors,
      items,
      // Said here rather than only in the UI, because it is the fact that makes the numbers on
      // this screen make sense: an anchor is not an exception, and it is never counted as one.
      note:
        "A backend whose certificate chains to one of these verifies normally, with no TLS " +
        "exception. Anchors apply to every gateway in this environment at the next poll.",
    });
  });

  /** Parse only. Nothing is stored, so an admin can see what they are about to trust. */
  router.add("POST", "/api/trust/anchors/preview", "session", async (ctx) => {
    requireAdmin(ctx, "the trust store is admin-only (design section 5.4)");
    const body = await readJson<{ pem?: string }>(ctx, 64 * 1024);
    const parsed = parseAnchorOrRefuse(body.pem ?? "");
    return json({
      subject: parsed.subject,
      issuer: parsed.issuer,
      thumbprint: parsed.thumbprint,
      notBefore: parsed.notBefore,
      notAfter: parsed.notAfter,
      expiresInDays: daysUntil(parsed.notAfter),
      ca: parsed.ca,
      selfSigned: parsed.selfSigned,
      keyAlgorithm: parsed.keyAlgorithm,
    });
  });

  router.add("POST", "/api/trust/anchors", "session", async (ctx) => {
    const user = requireAdmin(ctx, "registering a trust anchor is admin-only (design section 5.4)");
    const body = await readJson<{ environment?: string; name?: string; pem?: string }>(ctx, 64 * 1024);
    const environment = environmentIn(ctx, body.environment ?? environmentOf(ctx));
    const name = body.name ?? "";
    if (!/^[a-z0-9][a-z0-9-]{1,60}$/.test(name)) {
      throw badRequest("name: expected 2-61 lowercase letters, digits or hyphens");
    }
    const parsed = parseAnchorOrRefuse(body.pem ?? "");
    assertAnchorRoom(ctx, environment);

    const id = newId("anch");
    const at = nowIso();
    try {
      ctx.app.db.run(
        `INSERT INTO trust_anchor
           (id, environment, name, cert_pem, subject, issuer, thumbprint, not_before, not_after,
            added_by, added_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          environment,
          name,
          parsed.certPem,
          parsed.subject,
          parsed.issuer,
          parsed.thumbprint,
          parsed.notBefore,
          parsed.notAfter,
          user.id,
          at,
        ],
      );
    } catch (err) {
      if (String(err).includes("UNIQUE")) throw duplicateAnchor(ctx, environment, parsed.thumbprint);
      throw err;
    }
    invalidateTrustBundle(ctx.app.db);

    writeAudit(ctx.app.db, {
      actor: user.id,
      action: "trust-anchor.register",
      subject: `environment:${environment}`,
      outcome: "ok",
      detail: {
        anchorId: id,
        name,
        subject: parsed.subject,
        thumbprint: parsed.thumbprint,
        notAfter: parsed.notAfter,
      },
    });
    return json(
      {
        id,
        environment,
        name,
        subject: parsed.subject,
        issuer: parsed.issuer,
        thumbprint: parsed.thumbprint,
        notBefore: parsed.notBefore,
        notAfter: parsed.notAfter,
        expiresInDays: daysUntil(parsed.notAfter),
        selfSigned: parsed.selfSigned,
        keyAlgorithm: parsed.keyAlgorithm,
        // The one guarantee worth restating on the response: nothing is live until the fleet polls.
        effectiveAt: "the next poll of every gateway in this environment",
      },
      { status: 201 },
    );
  });

  router.add("DELETE", "/api/trust/anchors/:id", "session", (ctx) => {
    const user = requireAdmin(ctx, "removing a trust anchor is admin-only");
    const row = ctx.app.db
      .query<{ id: string; environment: string; name: string; thumbprint: string; removed_at: string | null }, [string]>(
        "SELECT id, environment, name, thumbprint, removed_at FROM trust_anchor WHERE id = ?",
      )
      .get(ctx.params.id!);
    if (!row) throw notFound(`no trust anchor ${ctx.params.id}`);

    // Dated, not deleted: "who trusted this, and when did we stop" is the question this table
    // exists to answer six months later.
    if (!row.removed_at) {
      ctx.app.db.run("UPDATE trust_anchor SET removed_at = ? WHERE id = ?", [nowIso(), row.id]);
      invalidateTrustBundle(ctx.app.db);
    }
    writeAudit(ctx.app.db, {
      actor: user.id,
      action: "trust-anchor.remove",
      subject: `environment:${row.environment}`,
      outcome: "ok",
      detail: { anchorId: row.id, name: row.name, thumbprint: row.thumbprint },
    });
    return new Response(null, { status: 204 });
  });

  /**
   * Copying to another environment is an explicit act with a diff and a confirmation, exactly as
   * design section 6.3 has it for policy: `dryRun` unless it is explicitly `false`. Trusting a CA
   * in PROD is a PROD decision, so nothing propagates along the promotion chain on its own.
   */
  router.add("POST", "/api/trust/anchors/copy-from", "session", async (ctx) => {
    const user = requireAdmin(ctx, "copying trust anchors is admin-only");
    const body = await readJson<{
      fromEnvironment?: string;
      environment?: string;
      ids?: string[];
      dryRun?: boolean;
    }>(ctx);
    const from = environmentIn(ctx, body.fromEnvironment ?? "");
    const to = environmentIn(ctx, body.environment ?? "");
    if (from === to) throw badRequest("fromEnvironment and environment must differ");
    const ids = body.ids ?? [];
    if (ids.length === 0) {
      throw badRequest("ids: name the anchors to copy — this is a copy, not a synchronisation");
    }

    const source = ctx.app.db
      .query<AnchorRow, [string]>(
        `SELECT id, environment, name, cert_pem, subject, issuer, thumbprint, not_before, not_after,
                added_by, added_at, removed_at
           FROM trust_anchor WHERE environment = ? AND removed_at IS NULL`,
      )
      .all(from);
    const live = new Set(
      ctx.app.db
        .query<{ thumbprint: string }, [string]>(
          "SELECT thumbprint FROM trust_anchor WHERE environment = ? AND removed_at IS NULL",
        )
        .all(to)
        .map((row) => row.thumbprint),
    );

    const copy: Array<{ id: string; name: string; subject: string; thumbprint: string; notAfter: string }> = [];
    const skipped: Array<{ id: string; reason: string }> = [];
    for (const id of ids) {
      const row = source.find((candidate) => candidate.id === id);
      if (!row) {
        skipped.push({ id, reason: `not a live anchor in ${from}` });
        continue;
      }
      if (live.has(row.thumbprint)) {
        skipped.push({ id, reason: `${to} already trusts this certificate` });
        continue;
      }
      if (Date.parse(row.not_after) <= Date.now()) {
        skipped.push({ id, reason: `expired at ${row.not_after}` });
        continue;
      }
      copy.push({
        id: row.id,
        name: row.name,
        subject: row.subject,
        thumbprint: row.thumbprint,
        notAfter: row.not_after,
      });
    }

    if (body.dryRun !== false) {
      return json({ fromEnvironment: from, environment: to, copy, skipped, applied: false });
    }
    assertAnchorRoom(ctx, to, copy.length);

    const at = nowIso();
    const created: string[] = [];
    const apply = ctx.app.db.transaction(() => {
      for (const entry of copy) {
        const row = source.find((candidate) => candidate.id === entry.id)!;
        const id = newId("anch");
        ctx.app.db.run(
          `INSERT INTO trust_anchor
             (id, environment, name, cert_pem, subject, issuer, thumbprint, not_before, not_after,
              added_by, added_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            id,
            to,
            uniqueAnchorName(ctx, to, row.name),
            row.cert_pem,
            row.subject,
            row.issuer,
            row.thumbprint,
            row.not_before,
            row.not_after,
            user.id,
            at,
          ],
        );
        created.push(id);
      }
    });
    apply();
    invalidateTrustBundle(ctx.app.db);

    writeAudit(ctx.app.db, {
      actor: user.id,
      action: "trust-anchor.copy-from",
      subject: `environment:${to}`,
      outcome: "ok",
      detail: { from, thumbprints: copy.map((entry) => entry.thumbprint), created },
    });
    return json({
      fromEnvironment: from,
      environment: to,
      copy,
      skipped,
      applied: true,
      created,
    });
  });

  // ---------------------------------------------------------------- TLS exceptions (section 5.4)

  router.add("GET", "/api/trust/exceptions", "session", (ctx) => {
    const environment = ctx.url.searchParams.get("environment");
    const includeExpired = ctx.url.searchParams.get("includeExpired") === "1";
    const rows = ctx.app.db
      .query<
        {
          id: string;
          resource_id: string;
          resource_name: string;
          api_version: string;
          environment: string;
          backend_url: string | null;
          mode: string;
          pin_thumbprint: string | null;
          reason: string;
          created_by: string;
          created_at: string;
          expires_at: string;
          revoked_at: string | null;
        },
        []
      >(
        `SELECT e.id, e.resource_id, r.name AS resource_name, r.api_version, e.environment,
                e.backend_url, e.mode, e.pin_thumbprint, e.reason, e.created_by, e.created_at,
                e.expires_at, e.revoked_at
           FROM tls_exception e JOIN resource r ON r.id = e.resource_id
          ORDER BY e.expires_at`,
      )
      .all();

    const now = Date.now();
    const items = rows
      .filter((row) => environment === null || row.environment === environment)
      .map((row) => ({
        id: row.id,
        resourceId: row.resource_id,
        resourceName: `${row.resource_name} ${row.api_version}`,
        environment: row.environment,
        backendUrl: row.backend_url,
        mode: row.mode,
        pinThumbprint: row.pin_thumbprint,
        reason: row.reason,
        createdBy: row.created_by,
        createdAt: row.created_at,
        expiresAt: row.expires_at,
        revokedAt: row.revoked_at,
        live: row.revoked_at === null && Date.parse(row.expires_at) > now,
        expiresInDays: daysUntil(row.expires_at, now),
      }))
      .filter((item) => includeExpired || item.live);

    return json({ items });
  });

  router.add("POST", "/api/trust/exceptions", "session", async (ctx) => {
    // Admin-only, and that is the whole point of the table: an owner may not decide to stop
    // verifying their own backend.
    const user = requireAdmin(ctx, "creating a TLS exception is admin-only (design section 5.4)");
    const body = await readJson<{
      resourceId?: string;
      environment?: string;
      backendUrl?: string | null;
      mode?: string;
      pinThumbprint?: string;
      reason?: string;
      expiresAt?: string;
      days?: number;
    }>(ctx);

    const resource = getResource(ctx, body.resourceId ?? "");
    const environment = body.environment ?? environmentOf(ctx);
    if (!ctx.app.config.promotionChain.includes(environment)) {
      throw badRequest(`unknown environment "${environment}"`);
    }

    const mode = String(body.mode ?? "");
    if (!MODES.includes(mode as ExceptionMode)) {
      throw badRequest(`mode: expected one of ${MODES.join(", ")}`);
    }
    if (mode === "pin") {
      const thumbprint = (body.pinThumbprint ?? "").replace(/:/g, "").toUpperCase();
      if (!/^[0-9A-F]{64}$/.test(thumbprint)) {
        throw badRequest("pinThumbprint: expected a sha256 thumbprint as 64 hex characters");
      }
      body.pinThumbprint = thumbprint;
    } else if (body.pinThumbprint) {
      throw badRequest(`pinThumbprint only applies to mode "pin"`);
    }

    // A reason long enough to be one. This row is what an auditor reads six months later, and
    // "temp" tells them nothing.
    const reason = (body.reason ?? "").trim();
    if (reason.length < 20) {
      throw badRequest(
        "reason: required, and at least 20 characters. It is what the governance report shows " +
          "beside this backend; name the ticket and the plan to remove it",
      );
    }

    const maxDays = ctx.app.config.integrations.tlsExceptionMaxDays ?? DEFAULT_TLS_EXCEPTION_MAX_DAYS;
    const now = Date.now();
    let expiresAt: number;
    if (body.expiresAt) {
      expiresAt = Date.parse(body.expiresAt);
      if (Number.isNaN(expiresAt)) throw badRequest("expiresAt: expected an ISO-8601 date");
    } else if (body.days !== undefined) {
      const days = Number(body.days);
      if (!Number.isInteger(days) || days < 1) throw badRequest("days: expected a positive integer");
      expiresAt = now + days * 86_400_000;
    } else {
      throw badRequest(
        "expiresAt or days is required: an exception with no end date is a permanent decision " +
          "wearing a temporary label (design section 5.4)",
      );
    }
    if (expiresAt <= now) throw badRequest("expiresAt: must be in the future");
    if (expiresAt > now + maxDays * 86_400_000) {
      throw badRequest(
        `expiresAt: at most ${maxDays} days out (TLS_EXCEPTION_MAX_DAYS). Renew it if the ` +
          "underlying problem outlives that; a renewal is a decision, a long expiry is a hope",
      );
    }

    // The URL, when given, must be one this binding actually has — otherwise the exception silently
    // covers nothing and somebody believes their backend is exempted when it is not.
    const backendUrl = body.backendUrl ?? null;
    if (backendUrl !== null) {
      const binding = ctx.app.db
        .query<{ backend_json: string }, [string, string]>(
          "SELECT backend_json FROM binding WHERE resource_id = ? AND environment = ?",
        )
        .get(resource.id, environment);
      const pool = binding ? readBackendPool(JSON.parse(binding.backend_json)).pool : [];
      if (!pool.some((entry) => entry.url === backendUrl)) {
        throw badRequest(
          `backendUrl: ${backendUrl} is not in this resource's ${environment} pool ` +
            `(${pool.map((e) => e.url).join(", ") || "empty"})`,
        );
      }
    }

    const id = newId("tlsx");
    const expires = new Date(expiresAt).toISOString();
    ctx.app.db.run(
      `INSERT INTO tls_exception
         (id, resource_id, environment, backend_url, mode, pin_thumbprint, reason, created_by,
          created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        resource.id,
        environment,
        backendUrl,
        mode,
        body.pinThumbprint ?? null,
        reason,
        user.id,
        nowIso(),
        expires,
      ],
    );
    touch(ctx, resource.id);
    writeAudit(ctx.app.db, {
      actor: user.id,
      action: "tls-exception.create",
      subject: `resource:${resource.id}`,
      outcome: "ok",
      detail: { environment, backendUrl, mode, reason, expiresAt: expires },
    });
    return json({ id, resourceId: resource.id, environment, backendUrl, mode, reason, expiresAt: expires }, { status: 201 });
  });

  router.add("DELETE", "/api/trust/exceptions/:id", "session", (ctx) => {
    const user = requireAdmin(ctx, "revoking a TLS exception is admin-only");
    const row = ctx.app.db
      .query<{ id: string; resource_id: string; revoked_at: string | null }, [string]>(
        "SELECT id, resource_id, revoked_at FROM tls_exception WHERE id = ?",
      )
      .get(ctx.params.id!);
    if (!row) throw notFound(`no TLS exception ${ctx.params.id}`);

    // Revoked, not deleted: the record that verification was once relaxed here, and by whom, is
    // the point of the table.
    if (!row.revoked_at) {
      ctx.app.db.run("UPDATE tls_exception SET revoked_at = ? WHERE id = ?", [nowIso(), row.id]);
      touch(ctx, row.resource_id);
    }
    writeAudit(ctx.app.db, {
      actor: user.id,
      action: "tls-exception.revoke",
      subject: `resource:${row.resource_id}`,
      outcome: "ok",
      detail: { exceptionId: row.id },
    });
    return new Response(null, { status: 204 });
  });

  /**
   * "Can this exception go now?" — a button, not a number `[P3-04]`.
   *
   * Whether a backend's chain verifies through the environment's anchors cannot be known without
   * asking the backend: the anchor set says which issuers are acceptable, and only the handshake
   * says what this host actually presents. So this performs one egress-checked TLS probe with that
   * environment's anchor set and **no exception**, and reports what happened. A computed claim
   * would be a guess wearing a number.
   */
  router.add("POST", "/api/trust/exceptions/:id/check", "session", async (ctx) => {
    requireAdmin(ctx, "probing a backend is admin-only");
    const row = ctx.app.db
      .query<
        { id: string; resource_id: string; environment: string; backend_url: string | null; mode: string },
        [string]
      >(
        "SELECT id, resource_id, environment, backend_url, mode FROM tls_exception WHERE id = ?",
      )
      .get(ctx.params.id!);
    if (!row) throw notFound(`no TLS exception ${ctx.params.id}`);

    const binding = ctx.app.db
      .query<{ backend_json: string }, [string, string]>(
        "SELECT backend_json FROM binding WHERE resource_id = ? AND environment = ?",
      )
      .get(row.resource_id, row.environment);
    const pool = binding ? readBackendPool(JSON.parse(binding.backend_json)).pool : [];
    const urls = row.backend_url ? [row.backend_url] : pool.map((entry) => entry.url);
    if (urls.length === 0) {
      throw conflict(
        `this exception's ${row.environment} binding has no backends, so there is nothing to probe`,
      );
    }

    const anchors = liveAnchorsFor(ctx.app.db, row.environment);
    const bundle = caBundleFor(ctx.app.db, row.environment);
    const backends = await Promise.all(
      urls.map((url) => probeBackend(ctx, url, bundle)),
    );

    return json({
      exceptionId: row.id,
      environment: row.environment,
      mode: row.mode,
      anchors: anchors.length,
      backends,
      // Every backend the exception covers has to verify, or removing it would break the ones that
      // do not — which is exactly the mistake this endpoint exists to prevent.
      wouldVerify: backends.every((backend) => backend.wouldVerify),
    });
  });

  /**
   * "List every backend in this estate we are not fully verifying, and every route that identifies
   * callers by CN alone." One page, because the question is asked about the estate rather than
   * about an API, and answering it per API means never asking it.
   */
  router.add("GET", "/api/governance/exceptions", "session", (ctx) => {
    requireAdmin(ctx, "the governance report is admin-only");
    const now = Date.now();

    const tls = ctx.app.db
      .query<
        {
          id: string;
          resource_id: string;
          resource_name: string;
          api_version: string;
          environment: string;
          backend_url: string | null;
          mode: string;
          reason: string;
          created_by: string;
          expires_at: string;
        },
        []
      >(
        `SELECT e.id, e.resource_id, r.name AS resource_name, r.api_version, e.environment,
                e.backend_url, e.mode, e.reason, e.created_by, e.expires_at
           FROM tls_exception e JOIN resource r ON r.id = e.resource_id
          WHERE e.revoked_at IS NULL
          ORDER BY e.expires_at`,
      )
      .all()
      .filter((row) => Date.parse(row.expires_at) > now);

    const cnOnly = ctx.app.db
      .query<
        {
          resource_id: string;
          resource_name: string;
          api_version: string;
          environment: string;
          value_json: string;
        },
        []
      >(
        `SELECT p.resource_id, r.name AS resource_name, r.api_version, p.environment, p.value_json
           FROM policy_entry p JOIN resource r ON r.id = p.resource_id
          WHERE p.unit_key = 'auth.mtls'
          ORDER BY r.name`,
      )
      .all()
      .filter((row) => {
        try {
          return (JSON.parse(row.value_json) as { acknowledgeCnOnly?: boolean }).acknowledgeCnOnly === true;
        } catch {
          return false;
        }
      });

    return json({
      tlsExceptions: tls.map((row) => ({
        id: row.id,
        resourceId: row.resource_id,
        resourceName: `${row.resource_name} ${row.api_version}`,
        environment: row.environment,
        backendUrl: row.backend_url ?? "every backend in the pool",
        mode: row.mode,
        reason: row.reason,
        createdBy: row.created_by,
        expiresAt: row.expires_at,
        expiresInDays: daysUntil(row.expires_at, now),
      })),
      cnOnlyRoutes: cnOnly.map((row) => ({
        resourceId: row.resource_id,
        resourceName: `${row.resource_name} ${row.api_version}`,
        environment: row.environment,
      })),
      // Informational, from INTEGRATIONS_FILE: CN-only's blast radius is the breadth of the
      // reverse proxy's client-CA bundle, which lives outside this database.
      clientCaBundle: ctx.app.config.integrations.clientCaBundle ?? null,
    });
  });
}

interface AnchorRow {
  id: string;
  environment: string;
  name: string;
  cert_pem: string;
  subject: string;
  issuer: string;
  thumbprint: string;
  not_before: string;
  not_after: string;
  added_by: string;
  added_at: string;
  removed_at: string | null;
}

/**
 * One row, as the Trust screen reads it. `selfSigned` and `keyAlgorithm` are re-derived from the
 * PEM rather than stored: they are properties of the certificate, and a column that can disagree
 * with the bytes it describes is a column that eventually does.
 */
function anchorView(row: AnchorRow, now: number) {
  let selfSigned: boolean | null = null;
  let keyAlgorithm: string | null = null;
  try {
    const parsed = parseAnchor(row.cert_pem, { now: Date.parse(row.not_before) });
    selfSigned = parsed.selfSigned;
    keyAlgorithm = parsed.keyAlgorithm;
  } catch {
    // A stored anchor that no longer parses is not a reason to fail the list. It shows with
    // nulls, and the expiry fields below still say what matters about it.
  }
  return {
    id: row.id,
    environment: row.environment,
    name: row.name,
    subject: row.subject,
    issuer: row.issuer,
    thumbprint: row.thumbprint,
    notBefore: row.not_before,
    notAfter: row.not_after,
    addedBy: row.added_by,
    addedAt: row.added_at,
    removedAt: row.removed_at,
    expiresInDays: daysUntil(row.not_after, now),
    expired: Date.parse(row.not_after) <= now,
    live: row.removed_at === null && Date.parse(row.not_after) > now,
    selfSigned,
    keyAlgorithm,
  };
}

function parseAnchorOrRefuse(pem: string) {
  try {
    return parseAnchor(pem);
  } catch (err) {
    if (err instanceof CertificateError) throw badRequest(err.message);
    throw err;
  }
}

function environmentIn(ctx: Ctx, value: string): string {
  if (!ctx.app.config.promotionChain.includes(value)) {
    throw badRequest(
      `unknown environment "${value}" (PROMOTION_CHAIN is ${ctx.app.config.promotionChain.join(",")})`,
    );
  }
  return value;
}

/**
 * The document carries every live anchor to every gateway in the environment, so the count is a
 * bound on the document rather than a preference. Past it the upload is refused naming the
 * variable, as design section 11 requires of every ceiling.
 */
function assertAnchorRoom(ctx: Ctx, environment: string, adding = 1): void {
  const live = (
    ctx.app.db
      .query<{ n: number }, [string]>(
        "SELECT COUNT(*) AS n FROM trust_anchor WHERE environment = ? AND removed_at IS NULL",
      )
      .get(environment) ?? { n: 0 }
  ).n;
  const max = ctx.app.config.maxTrustAnchors;
  if (live + adding > max) {
    throw conflict(
      `${environment} already trusts ${live} certificate authorities and MAX_TRUST_ANCHORS is ` +
        `${max}. Remove one that is no longer needed, or raise the limit knowing that every ` +
        "anchor travels to every gateway in the environment",
    );
  }
}

function duplicateAnchor(ctx: Ctx, environment: string, thumbprint: string) {
  const existing = ctx.app.db
    .query<{ name: string }, [string, string]>(
      "SELECT name FROM trust_anchor WHERE environment = ? AND thumbprint = ? AND removed_at IS NULL",
    )
    .get(environment, thumbprint);
  return conflict(
    `${environment} already trusts this certificate as "${existing?.name ?? "an existing anchor"}". ` +
      "Registering it twice would mean two rows to remove and one still trusting it",
  );
}

/** `corp-root`, `corp-root-2`, … — the name is per environment and only has to be unique there. */
function uniqueAnchorName(ctx: Ctx, environment: string, wanted: string): string {
  const taken = new Set(
    ctx.app.db
      .query<{ name: string }, [string]>("SELECT name FROM trust_anchor WHERE environment = ?")
      .all(environment)
      .map((row) => row.name),
  );
  if (!taken.has(wanted)) return wanted;
  for (let suffix = 2; suffix < 100; suffix++) {
    const candidate = `${wanted}-${suffix}`.slice(0, 61);
    if (!taken.has(candidate)) return candidate;
  }
  return `${wanted}-${Date.now()}`.slice(0, 61);
}

/**
 * One TLS handshake, verified the way the gateway's default `verify` mode would verify it: the
 * system roots plus this environment's anchors, hostname check on, redirects unfollowed. Any HTTP
 * answer at all means the handshake completed, which is the whole question — a 404 from a backend
 * that verified is a "yes".
 */
async function probeBackend(
  ctx: Ctx,
  url: string,
  bundle: string | null,
): Promise<{ url: string; wouldVerify: boolean; detail: string }> {
  const errors = await checkEgress(url, ctx.app.config.integrations, "backendUrl");
  if (errors.length > 0) return { url, wouldVerify: false, detail: errors.join("; ") };
  if (new URL(url).protocol !== "https:") {
    return {
      url,
      wouldVerify: true,
      detail: "this backend is plain http, so there is no certificate to verify and the exception changes nothing",
    };
  }

  try {
    const response = await fetch(url, {
      method: "HEAD",
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
      ...(bundle ? { tls: { ca: bundle } } : {}),
    } as RequestInit);
    return {
      url,
      wouldVerify: true,
      detail: `the handshake completed and the certificate verified (HTTP ${response.status})`,
    };
  } catch (err) {
    const message = (err as Error).message;
    // A backend that is simply down is not a verification failure, and saying it is would send
    // somebody to renew a certificate that is fine.
    const reachable = !/ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|timed out|timeout/i.test(message);
    return {
      url,
      wouldVerify: false,
      detail: reachable
        ? `verification failed: ${message}`
        : `could not reach this backend, so verification could not be tested: ${message}`,
    };
  }
}

/** Which bindings name this certificate as their client identity. */
function bindingsUsing(ctx: Ctx, certificateId: string) {
  const rows = ctx.app.db
    .query<
      { resource_id: string; resource_name: string; api_version: string; environment: string; backend_json: string },
      []
    >(
      `SELECT b.resource_id, r.name AS resource_name, r.api_version, b.environment, b.backend_json
         FROM binding b JOIN resource r ON r.id = b.resource_id`,
    )
    .all();
  return rows
    .filter((row) => {
      try {
        return readBackendPool(JSON.parse(row.backend_json)).clientCertRef === certificateId;
      } catch {
        return false;
      }
    })
    .map((row) => ({
      resourceId: row.resource_id,
      resourceName: `${row.resource_name} ${row.api_version}`,
      environment: row.environment,
    }));
}
