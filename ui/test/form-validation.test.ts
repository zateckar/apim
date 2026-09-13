import { describe, expect, test } from "bun:test";
import { NAME_PATTERN, nameError, versionError, httpUrlError, integerError } from "../src/lib/form-validation";

describe("form constraints before submission", () => {
  test("native patterns compile with browser Unicode sets semantics", () => {
    const native = new RegExp(`^(?:${NAME_PATTERN})$`, "v");
    expect(native.test("checkout-api")).toBe(true);
    expect(native.test("bad/name")).toBe(false);
  });
  test("versions accept only the positive integer v series", () => {
    for (const version of ["v1", "v2", "v123", `v${"9".repeat(31)}`]) expect(versionError(version)).toBeNull();
    for (const version of ["", "XXX", "V1", "v0", "v01", "v1.0", "v-2", "2024-01", " v2", `v${"9".repeat(32)}`]) expect(versionError(version)).not.toBeNull();
  });
  test("slugs and URLs explain invalid input", () => {
    expect(nameError("checkout-api")).toBeNull();
    for (const name of ["a", "Checkout", "has spaces", "-leading", "a".repeat(62)]) expect(nameError(name)).not.toBeNull();
    for (const url of ["http://localhost:8080", "https://backend.internal/path"]) expect(httpUrlError(url)).toBeNull();
    for (const url of ["", "backend.internal", "ftp://files.example.com", "https://user:pass@example.com"]) expect(httpUrlError(url)).not.toBeNull();
    expect(httpUrlError("", true)).toBeNull();
  });
  test("integer bounds reject fractions and non-finite values", () => {
    for (const value of [0, 1.5, 101, NaN, Infinity]) expect(integerError(value, 1, 100)).not.toBeNull();
    expect(integerError(1, 1, 100)).toBeNull();
    expect(integerError(100, 1, 100)).toBeNull();
  });
});
