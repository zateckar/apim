import { timingSafeEqual } from "node:crypto";
import type { CpConfig } from "./config.ts";
import { nowIso } from "./db.ts";
import { badRequest, conflict, tooManyRequests, unauthorized } from "./errors.ts";
import { createPrincipal, localByUsername, type PrincipalRow } from "./principals.ts";
import type { App } from "./router.ts";
import { writeAudit } from "./audit.ts";

/**
 * The local provider (v5 plan §5.3, deviation D32). Usernames and passwords in this database,
 * because a portal that cannot be signed into without an identity provider cannot be evaluated,
 * cannot run in an air-gapped test environment, and has no way back in when the provider is
 * misconfigured.
 *
 * argon2id through `Bun.password`, at OWASP's baseline: `memoryCost: 19456` KiB, `timeCost: 2`.
 * Measured at 17.7 ms per hash and per verify `[P1-03]`, which is the number both the lockout and
 * the rate limit below are argued from.
 */
const ARGON2 = { algorithm: "argon2id", memoryCost: 19456, timeCost: 2 } as const;

/** The password ceiling is not cosmetic: without it an unbounded request body gets hashed. */
const MAX_PASSWORD_LENGTH = 200;

/**
 * Verified against when the username is unknown, so the response time does not answer a question
 * the status code refuses to. Computed once, lazily — hashing at import time would cost every
 * process 18 ms whether or not it has a local provider.
 */
let dummyHash: string | null = null;

async function dummyVerify(password: string): Promise<void> {
  dummyHash ??= await Bun.password.hash("not-a-real-password-just-a-timing-floor", ARGON2);
  await Bun.password.verify(password, dummyHash).catch(() => false);
}

export async function hashPassword(password: string): Promise<string> {
  return Bun.password.hash(password, ARGON2);
}

/**
 * The policy, as one function so the three places a password is set — bootstrap, an admin's reset,
 * a user's own change — cannot disagree. It refuses by naming the rule, because "invalid password"
 * with no reason is how people end up trying the same thing twice.
 */
export function assertPasswordAcceptable(
  config: CpConfig,
  password: string,
  about: { username: string; email?: string | null },
): void {
  if (typeof password !== "string" || password.length === 0) {
    throw badRequest("password: required");
  }
  if (password.length < config.localPasswordMinLen) {
    throw badRequest(
      `password: at least ${config.localPasswordMinLen} characters. Length is what makes a ` +
        "password hard to guess; a short one with punctuation in it is not a substitute.",
    );
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    throw badRequest(`password: at most ${MAX_PASSWORD_LENGTH} characters`);
  }
  const folded = password.toLowerCase();
  if (folded === about.username.trim().toLowerCase()) {
    throw badRequest("password: cannot be your username");
  }
  if (about.email && folded === about.email.trim().toLowerCase()) {
    throw badRequest("password: cannot be your email address");
  }
}

export function assertUsernameAcceptable(username: string): string {
  const value = (username ?? "").trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{1,63}$/.test(value)) {
    throw badRequest(
      "username: 2–64 characters, starting with a letter or digit, then letters, digits, dots, " +
        "hyphens or underscores",
    );
  }
  return value;
}

// --------------------------------------------------------------------------- the rate limit

/**
 * A sliding minute across **all** callers, in front of the hash `[P1-05]`. Two things need it that
 * the per-principal lockout does not cover:
 *
 *  - a spray attack — one password against a thousand usernames — never trips a per-principal
 *    counter, because no single principal fails twice;
 *  - at 17.7 ms a verify, an unauthenticated caller could otherwise saturate this process's CPU
 *    with no credential at all, and the fixed dummy verify above *guarantees* a hash per request.
 *
 * Per process rather than per caller address: behind a reverse proxy the address is the proxy's,
 * and a limit keyed on something the caller controls is not a limit.
 */
const attempts: number[] = [];

export function assertLoginRate(config: CpConfig, nowMs = Date.now()): void {
  const cutoff = nowMs - 60_000;
  while (attempts.length > 0 && attempts[0]! < cutoff) attempts.shift();
  if (attempts.length >= config.localLoginRatePerMin) {
    throw tooManyRequests(
      `too many sign-in attempts across this control plane (LOCAL_LOGIN_RATE_PER_MIN is ` +
        `${config.localLoginRatePerMin} a minute). Try again shortly.`,
      60,
    );
  }
  attempts.push(nowMs);
}

/** Tests need a clean window; nothing else calls this. */
export function resetLoginRate(): void {
  attempts.length = 0;
}

// --------------------------------------------------------------------------- signing in

/**
 * Every failure below is the same 401 with the same sentence. A locked account, a disabled
 * account, a wrong password and a username nobody has ever registered are all "we did not accept
 * that", because telling them apart is user enumeration with extra steps. The difference is
 * recorded in the audit log, which is where an operator can see it and an attacker cannot.
 */
const REFUSED = "that username and password were not accepted";

export interface LoginResult {
  principal: PrincipalRow;
}

export async function verifyLocalLogin(
  app: App,
  username: string,
  password: string,
): Promise<LoginResult> {
  assertLoginRate(app.config);

  const presented = typeof password === "string" ? password : "";
  if (presented.length > MAX_PASSWORD_LENGTH) throw unauthorized(REFUSED, { code: "bad_credentials" });

  const row = localByUsername(app.db, username ?? "");
  if (!row) {
    await dummyVerify(presented);
    audit(app, username, "no such local account");
    throw unauthorized(REFUSED, { code: "bad_credentials" });
  }

  if (row.locked_until && Date.parse(row.locked_until) > Date.now()) {
    await dummyVerify(presented);
    audit(app, username, "locked out");
    throw unauthorized(REFUSED, { code: "bad_credentials" });
  }
  if (row.disabled_at) {
    await dummyVerify(presented);
    audit(app, username, "account disabled");
    throw unauthorized(REFUSED, { code: "bad_credentials" });
  }
  if (!row.password_hash) {
    await dummyVerify(presented);
    audit(app, username, "account has no password set");
    throw unauthorized(REFUSED, { code: "bad_credentials" });
  }

  const ok = await Bun.password.verify(presented, row.password_hash).catch(() => false);
  if (!ok) {
    recordFailure(app, row);
    audit(app, username, "wrong password");
    throw unauthorized(REFUSED, { code: "bad_credentials" });
  }

  app.db.run(
    "UPDATE principal SET failed_count = 0, locked_until = NULL, last_login_at = ? WHERE id = ?",
    [nowIso(), row.id],
  );
  return { principal: { ...row, failed_count: 0, locked_until: null } };
}

function recordFailure(app: App, row: PrincipalRow): void {
  const count = row.failed_count + 1;
  const locked =
    count >= app.config.localLockoutThreshold
      ? new Date(Date.now() + app.config.localLockoutMinutes * 60_000).toISOString()
      : null;
  app.db.run("UPDATE principal SET failed_count = ?, locked_until = ? WHERE id = ?", [
    locked ? 0 : count,
    locked,
    row.id,
  ]);
}

/**
 * The one place a username nobody has registered is written down, and deliberately: "somebody is
 * guessing usernames" is a signal an operator needs, and it cannot be reconstructed from the
 * successful sign-ins. No password material, ever — not even its length.
 */
function audit(app: App, username: string, why: string): void {
  writeAudit(app.db, {
    actor: "anonymous",
    action: "auth.login-failed",
    subject: `local:${(username ?? "").slice(0, 64)}`,
    outcome: "denied",
    detail: { provider: "local", why },
  });
}

// --------------------------------------------------------------------------- changing a password

export async function setPassword(
  app: App,
  row: PrincipalRow,
  password: string,
  options: { mustChange: boolean },
): Promise<void> {
  if (row.provider !== "local") {
    throw conflict(
      `${row.display_name} signs in through ${
        row.provider === "oidc" ? "the identity provider" : "the development bypass"
      }, so there is no password here to set. ` +
        "Passwords exist only for local accounts.",
    );
  }
  assertPasswordAcceptable(app.config, password, { username: row.username, email: row.email });
  app.db.run(
    `UPDATE principal
        SET password_hash = ?, must_change = ?, failed_count = 0, locked_until = NULL
      WHERE id = ?`,
    [await hashPassword(password), options.mustChange ? 1 : 0, row.id],
  );
}

/** Constant-time, because the current-password check on a change is a credential check too. */
export async function verifyCurrentPassword(row: PrincipalRow, password: string): Promise<boolean> {
  if (!row.password_hash) return false;
  if (typeof password !== "string" || password.length > MAX_PASSWORD_LENGTH) return false;
  return Bun.password.verify(password, row.password_hash).catch(() => false);
}

/** Used where two supplied strings are compared rather than a string against a hash. */
export function sameString(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

// --------------------------------------------------------------------------- the bootstrap admin

/**
 * The account that exists so somebody can sign in for the first time. Created at boot when the
 * `local` provider is enabled and **the directory holds no local principal at all** — not "no
 * principal with this username", so deleting the bootstrap admin does not resurrect it and
 * changing the environment variable does not create a second one.
 *
 * It is created with `must_change = 1`, so the password that was passed through the environment —
 * and is therefore in a compose file, a shell history and `docker inspect` — cannot be the one the
 * account keeps.
 */
export async function ensureBootstrapAdmin(app: App): Promise<void> {
  if (!app.config.authProviders.includes("local")) return;
  const username = app.config.bootstrapAdminUsername;
  const password = app.config.bootstrapAdminPassword;
  if (!username || !password) return;

  const existing = app.db
    .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM principal WHERE provider = 'local'")
    .get()!.n;
  if (existing > 0) return;

  const clean = assertUsernameAcceptable(username);
  assertPasswordAcceptable(app.config, password, { username: clean });
  const row = createPrincipal(app.db, {
    provider: "local",
    subject: clean,
    username: clean,
    displayName: clean,
    role: "admin",
    passwordHash: await hashPassword(password),
    mustChange: true,
    createdBy: "bootstrap",
  });
  writeAudit(app.db, {
    actor: "bootstrap",
    action: "user.create",
    subject: `user:${row.id}`,
    outcome: "ok",
    detail: { provider: "local", username: clean, role: "admin", reason: "empty local directory" },
  });
  console.log(
    `[cp] created the bootstrap administrator "${clean}". It must change its password at first ` +
      "sign-in, because the one it was given came through the environment.",
  );
}
