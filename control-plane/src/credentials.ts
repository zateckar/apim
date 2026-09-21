import type { DB } from "./db.ts";
import { decrypt } from "./crypto.ts";
import { parseAppCredentialRef } from "../../shared/policy.ts";

/**
 * The credentials an application keeps for itself (migration v15).
 *
 * `INTEGRATIONS_FILE` still owns every reference that resolves to something with a **URL** in it —
 * a JWT issuer, an OAuth2 token endpoint — because writing one of those is choosing what this
 * estate believes, or where it will send a client secret, and neither is an API owner's decision
 * to make alone. It no longer owns the references that are only secrets. Those are here, per
 * application and per environment, managed in the portal, because "my backend wants a username and
 * a password" cannot be a ticket, a file edit and a control-plane restart on a self-service estate.
 *
 * Three kinds, which is every app-ownable shape the policy vocabulary has:
 *
 * | kind     | principal (clear) | secret (encrypted) | what the gateway is handed              |
 * |----------|-------------------|--------------------|-----------------------------------------|
 * | `basic`  | username          | password           | `user:pass`, hashed or presented        |
 * | `secret` | —                 | the value          | the value, hashed or presented          |
 * | `hmac`   | app id            | app key            | the `SaKeyLite` pair                    |
 *
 * The non-secret half is stored in the clear on purpose: "which account is this" is the question
 * every screen listing credentials has to answer, and answering it must not need the KEK. The
 * secret half is never readable back through the portal API — not by the owner, not by an
 * administrator. The only reader is a configuration build.
 */

export const CREDENTIAL_KINDS = ["basic", "secret", "hmac"] as const;
export type CredentialKind = (typeof CREDENTIAL_KINDS)[number];

/** What each kind calls its two halves, so one screen and one API refuse in the same words. */
export const CREDENTIAL_SHAPE: Record<
  CredentialKind,
  { label: string; principal: string | null; secret: string; used: string }
> = {
  basic: {
    label: "Username and password",
    principal: "Username",
    secret: "Password",
    used: "HTTP Basic, in either direction: checking callers with auth.basic, or presenting to a backend.",
  },
  secret: {
    label: "A single secret value",
    principal: null,
    secret: "Value",
    used: "An API key a backend expects, or a shared secret a required header has to match.",
  },
  hmac: {
    label: "HMAC application id and key",
    principal: "Application id",
    secret: "Application key",
    used: "The SA-Key-Lite signature a backend verifies.",
  },
};

export class CredentialError extends Error {}

const NAME = /^[a-z0-9][a-z0-9-]{1,60}$/;

export interface CredentialRow {
  id: string;
  application_id: string;
  environment: string;
  name: string;
  kind: string;
  principal: string | null;
  note: string | null;
  created_by: string;
  created_at: string;
  rotated_at: string | null;
}

export interface CredentialDraft {
  kind: CredentialKind;
  principal: string | null;
  secret: string;
  note: string | null;
}

/**
 * A submitted credential, or a refusal naming the field.
 *
 * The emptiness check is not pedantry: a credential saved with a blank password is a route that
 * authenticates with nothing and reports no error until a backend rejects every call, and the
 * shape of that failure — 401 from upstream, on a route whose policy looks configured — is the
 * most expensive one on this list to diagnose.
 */
export function parseCredentialDraft(input: {
  kind?: string;
  principal?: string | null;
  secret?: string;
  note?: string | null;
}): CredentialDraft {
  const kind = input.kind ?? "";
  if (!CREDENTIAL_KINDS.includes(kind as CredentialKind)) {
    throw new CredentialError(`kind: expected one of ${CREDENTIAL_KINDS.join(", ")}`);
  }
  const shape = CREDENTIAL_SHAPE[kind as CredentialKind];
  const secret = input.secret ?? "";
  if (secret.length === 0) {
    throw new CredentialError(`secret: expected ${shape.secret.toLowerCase()}, which cannot be empty`);
  }
  if (secret.length > 4096) throw new CredentialError("secret: expected at most 4096 characters");

  let principal: string | null = null;
  if (shape.principal) {
    principal = (input.principal ?? "").trim();
    if (principal.length === 0) {
      throw new CredentialError(`principal: expected ${shape.principal.toLowerCase()}`);
    }
    if (principal.length > 256) throw new CredentialError("principal: expected at most 256 characters");
    // A colon would split the composed `user:pass` in the wrong place, so a credential that looked
    // saved would authenticate as somebody else. Refused here rather than escaped, because there is
    // no username with a colon in it that anybody meant to type.
    if (principal.includes(":")) {
      throw new CredentialError(
        `principal: a colon separates the two halves of this credential, so ${shape.principal.toLowerCase()} cannot contain one`,
      );
    }
  }

  const note = (input.note ?? "").trim();
  if (note.length > 500) throw new CredentialError("note: expected at most 500 characters");
  return { kind: kind as CredentialKind, principal, secret, note: note || null };
}

export function assertCredentialName(name: string): void {
  if (!NAME.test(name)) {
    throw new CredentialError("name: expected 2-61 lowercase letters, digits or hyphens");
  }
}

/**
 * Enough of a credential to show without decrypting anything: which account, what it is for, and
 * when it was last replaced. Never the secret — this shape is what the API returns.
 */
export function describeCredential(row: CredentialRow): {
  id: string;
  applicationId: string;
  environment: string;
  name: string;
  kind: string;
  principal: string | null;
  note: string | null;
  ref: string;
  createdBy: string;
  createdAt: string;
  rotatedAt: string | null;
} {
  return {
    id: row.id,
    applicationId: row.application_id,
    environment: row.environment,
    name: row.name,
    kind: row.kind,
    principal: row.principal,
    note: row.note,
    // The string a policy carries, composed here rather than in the browser: the portal offers it
    // from a picker, and a reference typed by hand is a reference that resolves to nothing.
    ref: `app:${row.application_id}:${row.name}`,
    createdBy: row.created_by,
    createdAt: row.created_at,
    rotatedAt: row.rotated_at,
  };
}

/**
 * Every `credentialRef` and `schemeRef` anywhere inside a stored unit value.
 *
 * A walk rather than a list of paths, because the paths differ per unit — `auth.basic` carries one
 * at the top, `preconditions` carries one per rule inside an array — and a list would have to be
 * kept in step with the vocabulary by hand. The two key names are the whole of the closed
 * vocabulary's secret-reference surface (`shared/policy.ts`), so the walk cannot over-collect.
 */
function refsIn(value: unknown, into: Set<string>): void {
  if (Array.isArray(value)) {
    for (const entry of value) refsIn(entry, into);
    return;
  }
  if (typeof value !== "object" || value === null) return;
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if ((key === "credentialRef" || key === "schemeRef") && typeof entry === "string") into.add(entry);
    else refsIn(entry, into);
  }
}

/**
 * Which routes in an environment name this credential — the question `DELETE` has to answer before
 * it agrees, and the one a rotation reports afterwards.
 *
 * The environment's global tier is read too, and reported as such. An administrator can attach
 * `auth.basic` globally, and a global unit naming a credential is exactly the case where "nothing
 * uses this" would be most confidently wrong.
 */
export function credentialsUsing(
  db: DB,
  environment: string,
  ref: string,
): Array<{ resourceId: string | null; resourceName: string; unitKey: string }> {
  const out: Array<{ resourceId: string | null; resourceName: string; unitKey: string }> = [];

  for (const row of db
    .query<
      { resource_id: string; name: string; api_version: string; unit_key: string; value_json: string },
      [string]
    >(
      `SELECT p.resource_id, r.name, r.api_version, p.unit_key, p.value_json
         FROM policy_entry p JOIN resource r ON r.id = p.resource_id
        WHERE p.environment = ? ORDER BY r.name, p.unit_key`,
    )
    .all(environment)) {
    const found = new Set<string>();
    try {
      refsIn(JSON.parse(row.value_json), found);
    } catch {
      // A stored value that does not parse is somebody else's defect; it is not a use of this
      // credential, and it must not stop a delete that is otherwise safe.
      continue;
    }
    if (found.has(ref)) {
      out.push({
        resourceId: row.resource_id,
        resourceName: `${row.name} ${row.api_version}`,
        unitKey: row.unit_key,
      });
    }
  }

  for (const row of db
    .query<{ unit_key: string; value_json: string }, [string]>(
      "SELECT unit_key, value_json FROM global_policy_entry WHERE environment = ? ORDER BY unit_key",
    )
    .all(environment)) {
    const found = new Set<string>();
    try {
      refsIn(JSON.parse(row.value_json), found);
    } catch {
      continue;
    }
    if (found.has(ref)) {
      out.push({
        resourceId: null,
        resourceName: `${environment.toUpperCase()} global policy`,
        unitKey: row.unit_key,
      });
    }
  }

  return out;
}

/**
 * Resolves the application-owned half of a configuration build's references.
 *
 * One query per reference, cached for the build: an environment names a handful of credentials and
 * the alternative — loading every row and decrypting it — would decrypt secrets no route asked for.
 * Nothing here is reachable from a request path; a build runs on promotion and on the poll's
 * cache miss.
 */
export interface CredentialVault {
  /** The value behind a purely-secret reference, or `null` when nothing answers to it. */
  secret(ref: string): string | null;
  /** The `SaKeyLite` pair behind a scheme reference, or `null`. */
  hmac(ref: string): { appId: string; appKey: string } | null;
}

export function credentialVault(db: DB, kek: Buffer, environment: string): CredentialVault {
  const cache = new Map<string, { kind: string; principal: string | null; secret: string } | null>();

  const load = (ref: string) => {
    if (cache.has(ref)) return cache.get(ref)!;
    const parsed = parseAppCredentialRef(ref);
    if (!parsed) {
      cache.set(ref, null);
      return null;
    }
    const row = db
      .query<{ kind: string; principal: string | null; secret_enc: string }, [string, string, string]>(
        `SELECT kind, principal, secret_enc FROM app_credential
          WHERE application_id = ? AND environment = ? AND name = ?`,
      )
      .get(parsed.applicationId, environment, parsed.name);
    const entry = row
      ? { kind: row.kind, principal: row.principal, secret: decrypt(row.secret_enc, kek) }
      : null;
    cache.set(ref, entry);
    return entry;
  };

  return {
    secret(ref) {
      const entry = load(ref);
      if (!entry) return null;
      // `basic` composes; `secret` is the value itself. An `hmac` credential is deliberately not
      // usable as a plain secret: presenting an app key as a bearer value is not what it signs.
      if (entry.kind === "basic") return `${entry.principal ?? ""}:${entry.secret}`;
      if (entry.kind === "secret") return entry.secret;
      return null;
    },
    hmac(ref) {
      const entry = load(ref);
      if (!entry || entry.kind !== "hmac") return null;
      return { appId: entry.principal ?? "", appKey: entry.secret };
    },
  };
}

/** A vault that answers nothing, for a build with no database behind it. */
export const EMPTY_VAULT: CredentialVault = { secret: () => null, hmac: () => null };
