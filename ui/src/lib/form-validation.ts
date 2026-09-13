import { API_VERSION_PATTERN } from "../../../shared/types";

// frontend-visual-system: use the contract's bounds before sending a request.
export const NAME_PATTERN = "[a-z0-9][a-z0-9\\-]{1,60}";
export const NAME_HINT = "2–61 lowercase letters, digits or hyphens.";
export const VERSION_HINT = "Use v1, v2, v3… Positive integers only; no leading zeroes.";
export function nameError(value: string): string | null {
  return new RegExp(`^${NAME_PATTERN}$`).test(value) ? null : NAME_HINT;
}
export function versionError(value: string): string | null {
  return API_VERSION_PATTERN.test(value) ? null : VERSION_HINT;
}
export function httpUrlError(value: string, optional = false): string | null {
  if (!value.trim() && optional) return null;
  try {
    const url = new URL(value);
    if (["http:", "https:"].includes(url.protocol) && url.hostname && !url.username && !url.password) return null;
  } catch { /* The field supplies the correction below. */ }
  return "Enter a complete HTTP or HTTPS URL, without embedded credentials.";
}
export function integerError(value: number, min: number, max?: number): string | null {
  return Number.isInteger(value) && value >= min && (max === undefined || value <= max)
    ? null : `Enter a whole number ${max === undefined ? `of at least ${min}` : `from ${min} to ${max}`}.`;
}
