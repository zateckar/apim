import { createHash } from "node:crypto";

/**
 * Canonical JSON: object keys sorted, `undefined` dropped. Digests are taken over this form so
 * that a reformatted upload does not churn `revision.version_digest` (design section 4).
 */
export function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  const src = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(src).sort()) {
    if (src[key] === undefined) continue;
    out[key] = canonicalize(src[key]);
  }
  return out;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function sha256Hex(input: string | Uint8Array): string {
  return createHash("sha256").update(input).digest("hex");
}

/** `sha256:<hex>` over the canonical form. */
export function digestOf(value: unknown): string {
  return "sha256:" + sha256Hex(canonicalJson(value));
}
