import { writeAudit } from "../audit.ts";
import {
  assertCredentialName,
  CredentialError,
  credentialsUsing,
  credentialUsageIndex,
  describeCredential,
  parseCredentialDraft,
  type CredentialRow,
} from "../credentials.ts";
import { encrypt } from "../crypto.ts";
import { newId, nowIso } from "../db.ts";
import {
  badRequest,
  conflict,
  json,
  notFound,
  readJson,
  requireUser,
  Router,
} from "../router.ts";
import { assertCan, environmentOf } from "./common.ts";

/**
 * The credentials an application keeps for itself, per environment (migration v15).
 *
 * Shaped like `/api/certificates`, which is the other thing an application owns that holds a
 * secret, and for the same reasons: readable by anybody (the one authorization rule says you may
 * read everything), writable only by the owning application or an administrator, and the secret
 * itself never comes back out. There is no reveal endpoint and there will not be one — this is
 * somewhere to *put* a credential the gateway needs, not a vault to look one up in. Somebody who
 * has lost the password rotates it; somebody who wants to read it out of the portal is describing
 * a different product.
 *
 * Deleting one that a policy still names is refused, exactly as deleting a bound certificate is.
 * The data plane answers 503 for a reference it cannot resolve, so the alternative is a route that
 * keeps serving until its next configuration build and then starts refusing every call, with
 * nothing on the route to say why.
 */

function credentialById(ctx: { app: { db: import("../db.ts").DB } }, id: string): CredentialRow {
  const row = ctx.app.db
    .query<CredentialRow, [string]>(
      `SELECT id, application_id, environment, name, kind, principal, note, created_by, created_at,
              rotated_at
         FROM app_credential WHERE id = ?`,
    )
    .get(id);
  if (!row) throw notFound(`no credential ${id}`);
  return row;
}

/** Every refusal from the parser is a 400 naming the field, like every other write on this API. */
function orRefuse<T>(run: () => T): T {
  try {
    return run();
  } catch (err) {
    if (err instanceof CredentialError) throw badRequest(err.message);
    throw err;
  }
}

export function registerCredentialRoutes(router: Router): void {
  router.add("GET", "/api/credentials", "session", (ctx) => {
    const environment = environmentOf(ctx);
    const rows = ctx.app.db
      .query<CredentialRow, [string]>(
        `SELECT id, application_id, environment, name, kind, principal, note, created_by, created_at,
                rotated_at
           FROM app_credential WHERE environment = ? ORDER BY application_id, name`,
      )
      .all(environment);
    // One pass over the environment's policy rows for the whole listing, rather than one per
    // credential: the rows are the same rows every time, and re-reading them per credential made
    // the screen's cost the product of the two counts.
    const usage = credentialUsageIndex(ctx.app.db, environment);
    return json({
      environment,
      items: rows.map((row) => {
        const described = describeCredential(row);
        return {
          ...described,
          // The answer to "can I delete this", computed once here rather than guessed in the
          // browser from a policy document it would have to fetch per API.
          usedBy: usage.get(described.ref) ?? [],
        };
      }),
      /**
       * The *names* an administrator registered in `INTEGRATIONS_FILE`, so the policy editor can
       * offer them from a picker instead of asking somebody to type one from memory. Names only —
       * no value, no URL, nothing the file holds beyond the key. They are already legible to
       * anybody who can read a policy document, and the alternative was a free-text box in which a
       * typo resolves to nothing and fails at the first request.
       */
      registered: {
        secrets: Object.keys(ctx.app.config.integrations.sharedSecrets ?? {}).sort(),
        hmacSchemes: Object.keys(ctx.app.config.integrations.hmacSchemes ?? {}).sort(),
        issuers: Object.keys(ctx.app.config.integrations.issuers ?? {}).sort(),
        tokenProviders: Object.keys(ctx.app.config.integrations.tokenProviders ?? {}).sort(),
      },
    });
  });

  router.add("POST", "/api/credentials", "session", async (ctx) => {
    const user = requireUser(ctx);
    const body = await readJson<{
      environment?: string;
      applicationId?: string;
      name?: string;
      kind?: string;
      principal?: string | null;
      secret?: string;
      note?: string | null;
    }>(ctx, 64 * 1024);

    const environment = body.environment ?? environmentOf(ctx);
    if (!ctx.app.config.promotionChain.includes(environment)) {
      throw badRequest(`unknown environment "${environment}"`);
    }
    const applicationId = body.applicationId ?? "";
    assertCan(user, applicationId, "add a credential for this application");
    const name = body.name ?? "";
    orRefuse(() => assertCredentialName(name));
    const draft = orRefuse(() => parseCredentialDraft(body));

    const id = newId("cred");
    const at = nowIso();
    try {
      ctx.app.db.run(
        `INSERT INTO app_credential
           (id, application_id, environment, name, kind, secret_enc, principal, note, created_by,
            created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          applicationId,
          environment,
          name,
          draft.kind,
          encrypt(draft.secret, ctx.app.kek),
          draft.principal,
          draft.note,
          user.id,
          at,
        ],
      );
    } catch (err) {
      if (String(err).includes("UNIQUE")) {
        throw conflict(`this application already has a credential named ${name} in ${environment}`);
      }
      throw err;
    }

    writeAudit(ctx.app.db, {
      actor: user.id,
      action: "credential.create",
      subject: `credential:${id}`,
      outcome: "ok",
      // The kind and the account, never the secret. An audit row is not a place to leak one.
      detail: { environment, applicationId, name, kind: draft.kind, principal: draft.principal },
    });
    return json(describeCredential(credentialById(ctx, id)), { status: 201 });
  });

  /**
   * Replace the secret in place: same id, same name, same reference, so every policy that names it
   * keeps working and nothing has to be re-saved.
   *
   * The principal may move with it — a service account rotated by being replaced is the ordinary
   * case at this estate — but the *kind* may not. Changing a `basic` credential into an `hmac` one
   * would silently change what every route naming it presents to its backend, which is a decision
   * to be made one route at a time, by deleting this and adding the other.
   */
  router.add("POST", "/api/credentials/:id/rotate", "session", async (ctx) => {
    const user = requireUser(ctx);
    const row = credentialById(ctx, ctx.params.id!);
    assertCan(user, row.application_id, "rotate this credential");

    const body = await readJson<{ principal?: string | null; secret?: string; note?: string | null }>(
      ctx,
      64 * 1024,
    );
    const draft = orRefuse(() =>
      parseCredentialDraft({
        kind: row.kind,
        // Unchanged unless the caller sends one, so rotating a password does not require restating
        // the username it belongs to.
        principal: body.principal ?? row.principal,
        secret: body.secret,
        note: body.note ?? row.note,
      }),
    );

    const at = nowIso();
    ctx.app.db.run(
      "UPDATE app_credential SET secret_enc = ?, principal = ?, note = ?, rotated_at = ? WHERE id = ?",
      [encrypt(draft.secret, ctx.app.kek), draft.principal, draft.note, at, row.id],
    );
    const used = credentialsUsing(ctx.app.db, row.environment, describeCredential(row).ref);
    writeAudit(ctx.app.db, {
      actor: user.id,
      action: "credential.rotate",
      subject: `credential:${row.id}`,
      outcome: "ok",
      detail: {
        environment: row.environment,
        applicationId: row.application_id,
        name: row.name,
        principal: draft.principal,
        routes: used.length,
      },
    });
    return json({
      ...describeCredential({ ...row, principal: draft.principal, note: draft.note, rotated_at: at }),
      /** Every route that begins presenting the new secret at the next configuration build. */
      usedBy: used,
    });
  });

  router.add("DELETE", "/api/credentials/:id", "session", (ctx) => {
    const user = requireUser(ctx);
    const row = credentialById(ctx, ctx.params.id!);
    assertCan(user, row.application_id, "delete this credential");

    const ref = describeCredential(row).ref;
    const used = credentialsUsing(ctx.app.db, row.environment, ref);
    if (used.length > 0) {
      throw conflict(
        `${row.name} is named by the policy of ${used.length} route(s) ` +
          // The unit as well as the resource: "change those policies first" is an instruction
          // nobody can follow from a resource name alone — a workspace has eight panels.
          `(${used.map((entry) => `${entry.resourceName} · ${entry.unitKey}`).join(", ")}); ` +
          "change those policies first. " +
          "A gateway refuses a request whose credential it cannot resolve, so deleting this now " +
          "would take those routes down at their next configuration build.",
      );
    }

    ctx.app.db.run("DELETE FROM app_credential WHERE id = ?", [row.id]);
    writeAudit(ctx.app.db, {
      actor: user.id,
      action: "credential.delete",
      subject: `credential:${row.id}`,
      outcome: "ok",
      detail: { environment: row.environment, applicationId: row.application_id, name: row.name },
    });
    return new Response(null, { status: 204 });
  });
}
