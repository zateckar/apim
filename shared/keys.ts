import { createHash } from "node:crypto";

/**
 * The one definition of "how a subscription key becomes the value in the config document".
 * The control plane hashes on write, the data plane hashes what the caller presented; if these
 * two ever disagreed, every key would silently stop working.
 */
export function hashSubscriptionKey(key: string): string {
  return "sha256:" + createHash("sha256").update(key, "utf8").digest("hex");
}
