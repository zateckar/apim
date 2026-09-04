import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Subscription keys and (later) certificate private keys are encrypted at rest with a KEK
 * (design section 4). In production the KEK is a Key Vault reference; the MVP keeps it in a file
 * and says so loudly on first creation.
 */
export function loadOrCreateKek(path: string): Buffer {
  if (existsSync(path)) {
    const kek = Buffer.from(readFileSync(path, "utf8").trim(), "base64");
    if (kek.length !== 32) throw new Error(`KEK at ${path} is not 32 bytes`);
    return kek;
  }
  mkdirSync(dirname(path), { recursive: true });
  const kek = randomBytes(32);
  writeFileSync(path, kek.toString("base64"), { mode: 0o600 });
  if (process.env.NODE_ENV !== "test") {
    console.warn(
      `[crypto] generated a development KEK at ${path}. Anything encrypted with it is lost if the file is.`,
    );
  }
  return kek;
}

/** AES-256-GCM; the stored form is base64(iv | tag | ciphertext). */
export function encrypt(plaintext: string, kek: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", kek, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64");
}

export function decrypt(stored: string, kek: Buffer): string {
  const raw = Buffer.from(stored, "base64");
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const decipher = createDecipheriv("aes-256-gcm", kek, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
}

/** `sk_dev_<32 url-safe chars>` — the value a consumer puts in X-Api-Key. */
export function mintSubscriptionKey(environment: string): string {
  return `sk_${environment}_${randomBytes(24).toString("base64url")}`;
}

/** The config document carries hashes, never keys (design section 8.5 needs only the mapping). */
export { hashSubscriptionKey as hashKey } from "../../shared/keys.ts";

/** Per-instance bearer token for the config poll, hashed at rest. */
export function mintInstanceToken(): string {
  return `gwt_${randomBytes(32).toString("base64url")}`;
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
