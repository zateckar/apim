import { describe, expect, test } from "bun:test";
import { canonicalJson, digestOf } from "../shared/canonical.ts";
import { hashSubscriptionKey } from "../shared/keys.ts";
import { ipInCidr } from "../shared/net.ts";
import { lintPattern, validateDocument, validateUnit } from "../shared/policy.ts";
import {
  joinBackend,
  hostKey,
  normalizeBasePath,
  normalizeHost,
  pathMatchesBase,
  stripBasePath,
} from "../shared/routing.ts";
import { render, templateErrorsDeep } from "../shared/template.ts";
import { RateLimiter } from "../data-plane/src/ratelimit.ts";
import { normalizeSpec, toOpenApi31, assertSelfContained } from "../control-plane/src/normalize.ts";
import { MINI_SPEC } from "./helpers.ts";

describe("canonical JSON and digests", () => {
  test("key order does not change the digest", () => {
    expect(digestOf({ a: 1, b: { c: 2, d: 3 } })).toBe(digestOf({ b: { d: 3, c: 2 }, a: 1 }));
  });

  test("undefined is dropped, arrays keep their order", () => {
    expect(canonicalJson({ b: undefined, a: [3, 1, 2] })).toBe('{"a":[3,1,2]}');
  });

  test("a different value is a different digest", () => {
    expect(digestOf({ a: 1 })).not.toBe(digestOf({ a: 2 }));
  });
});

describe("policy validator", () => {
  test("each unit's default value validates", () => {
    expect(validateUnit("auth.subscriptionKey", { in: "header", name: "X-Api-Key" })).toEqual([]);
    expect(validateUnit("rewrite", { stripBasePath: true })).toEqual([]);
    expect(validateUnit("timeoutMs", 5000)).toEqual([]);
    expect(
      validateUnit("rateLimit", {
        calls: 5,
        periodSec: 60,
        per: "instance",
        by: "subscription",
        scope: "route",
      }),
    ).toEqual([]);
  });

  test("an unknown unit key is rejected: the vocabulary is closed", () => {
    expect(validateUnit("sendRequest", {})[0]).toContain("unknown policy unit");
  });

  test("an unknown field inside a unit is rejected", () => {
    const errors = validateUnit("rateLimit", {
      calls: 5,
      periodSec: 60,
      per: "instance",
      by: "subscription",
      scope: "route",
      burst: 10,
    });
    expect(errors.join()).toContain('unknown field "burst"');
  });

  test("calls must be at least 1", () => {
    expect(
      validateUnit("rateLimit", {
        calls: 0,
        periodSec: 60,
        per: "instance",
        by: "subscription",
        scope: "route",
      }).join(),
    ).toContain("rateLimit.calls");
  });

  test("requireHeader takes exactly one of present, equals, pattern or credentialRef", () => {
    const two = validateUnit("preconditions", [
      { requireHeader: { name: "X-A", present: true, equals: "b" }, deny: { status: 403, reason: "no" } },
    ]);
    expect(two.join()).toContain("expected exactly one of present, equals, pattern, credentialRef");

    const none = validateUnit("preconditions", [
      { requireHeader: { name: "X-A" }, deny: { status: 403, reason: "no" } },
    ]);
    expect(none.join()).toContain("expected exactly one of present, equals, pattern, credentialRef");
  });

  test("deny.status must be a 4xx or 5xx", () => {
    expect(
      validateUnit("preconditions", [
        { requireHeader: { name: "X-A", present: true }, deny: { status: 200, reason: "no" } },
      ]).join(),
    ).toContain("between 400 and 599");
  });

  test("an unknown template variable fails at write time, it does not render empty", () => {
    const errors = validateUnit("headers.request", { set: { "X-Who": "${caller.department}" } });
    expect(errors.join()).toContain("unknown template variable");
    expect(validateUnit("headers.request", { set: { "X-Who": "${subscription.name}" } })).toEqual([]);
    // v3 opened the `jwt.claim.` family (design section 5.6): the prefix is known, its tail is data.
    expect(validateUnit("headers.request", { set: { "X-Who": "${jwt.claim.sub}" } })).toEqual([]);
    // Still closed, though — a prefix with nothing after it names no claim.
    expect(validateUnit("headers.request", { set: { "X-Who": "${jwt.claim.}" } }).join()).toContain(
      "unknown template variable",
    );
  });

  test("rateLimit without auth.subscriptionKey is a cross-unit failure", () => {
    const rateLimit = {
      calls: 5,
      periodSec: 60,
      per: "instance",
      by: "subscription",
      scope: "route",
    };
    expect(validateDocument({ rateLimit }).join()).toContain(
      "only auth.subscriptionKey resolves to one",
    );
    expect(
      validateDocument({ rateLimit, "auth.subscriptionKey": { in: "header", name: "X-Api-Key" } }),
    ).toEqual([]);
  });
});

describe("pattern linter (deviation D8: no RE2 in Bun)", () => {
  test("a plain pattern is accepted", () => {
    expect(lintPattern("^[0-9a-f]{2}-[0-9a-f]{32}$")).toEqual([]);
  });

  test("nested quantifiers are rejected", () => {
    expect(lintPattern("(a+)+$").join()).toContain("catastrophic backtracking");
    expect(lintPattern("(a|aa)*b").join()).toContain("catastrophic backtracking");
  });

  test("backreferences and lookaround are rejected", () => {
    expect(lintPattern("(a)\\1").join()).toContain("backreferences");
    expect(lintPattern("(?=abc)x").join()).toContain("lookahead");
  });

  test("huge repetition bounds and invalid regexes are rejected", () => {
    expect(lintPattern("a{5000}").join()).toContain("above 1000");
    // `a{2,` is a *valid* JS regex (Annex B treats the brace as a literal), so the fixture for
    // "does not compile" has to be an unterminated group.
    expect(lintPattern("(unclosed").join()).toContain("not a valid regular expression");
  });

  test("over-long patterns are rejected", () => {
    expect(lintPattern("a".repeat(201)).join()).toContain("longer than 200");
  });
});

describe("templates", () => {
  test("render substitutes from the closed set", () => {
    expect(render("hi ${subscription.name} at ${environment}", {
      "subscription.name": "orders-app -> petstore",
      environment: "dev",
    })).toBe("hi orders-app -> petstore at dev");
  });

  test("deep validation reports the path of the offending string", () => {
    expect(templateErrorsDeep({ a: { b: ["${nope}"] } }, "body").join()).toContain("body.a.b[0]");
  });
});

describe("routing rules", () => {
  test("base paths are normalized", () => {
    expect(normalizeBasePath("/petstore/").basePath).toBe("/petstore");
    expect(normalizeBasePath("petstore").errors.join()).toContain('must start with "/"');
    expect(normalizeBasePath("/a b").errors.join()).toContain("whitespace");
    expect(normalizeBasePath("/healthz").errors.join()).toContain("reserved");
    expect(normalizeBasePath("/").basePath).toBe("/");
  });

  test("hosts are normalized and default to the wildcard", () => {
    expect(normalizeHost(undefined).host).toBe("*");
    expect(normalizeHost("API.Example.COM").host).toBe("api.example.com");
    expect(hostKey("api.example.com:8081")).toBe("api.example.com");
    expect(hostKey("[::1]:8081")).toBe("[::1]");
  });

  test("a base path matches only at a segment boundary", () => {
    expect(pathMatchesBase("/petstore", "/petstore")).toBe(true);
    expect(pathMatchesBase("/petstore/pet/1", "/petstore")).toBe(true);
    expect(pathMatchesBase("/petstoreXYZ", "/petstore")).toBe(false);
    expect(pathMatchesBase("/anything", "/")).toBe(true);
  });

  test("stripping the base path always leaves an absolute path", () => {
    expect(stripBasePath("/petstore/pet/1", "/petstore")).toBe("/pet/1");
    expect(stripBasePath("/petstore", "/petstore")).toBe("/");
    expect(stripBasePath("/pet/1", "/")).toBe("/pet/1");
  });

  test("the backend's own path segment survives the join", () => {
    expect(joinBackend("https://petstore.swagger.io/v2", "/pet/1", "?x=1")).toBe(
      "https://petstore.swagger.io/v2/pet/1?x=1",
    );
    expect(joinBackend("https://host/v2/", "/pet", "")).toBe("https://host/v2/pet");
    expect(joinBackend("http://host:8080", "/", "")).toBe("http://host:8080/");
  });
});

describe("rate limiter", () => {
  test("the calls+1-th request in a window is rejected", () => {
    const limiter = new RateLimiter();
    const now = 1_000_000_000_000;
    expect(limiter.check("k", 3, 60, now).allowed).toBe(true);
    expect(limiter.check("k", 3, 60, now).allowed).toBe(true);
    const third = limiter.check("k", 3, 60, now);
    expect(third.allowed).toBe(true);
    expect(third.remaining).toBe(0);
    const fourth = limiter.check("k", 3, 60, now);
    expect(fourth.allowed).toBe(false);
    expect(fourth.remaining).toBe(0);
    expect(fourth.retryAfter).toBeGreaterThan(0);
  });

  test("windows are fixed and aligned to the UTC epoch", () => {
    const limiter = new RateLimiter();
    const period = 60;
    const inWindow = 1_000_000_020_000;
    const verdict = limiter.check("k", 1, period, inWindow);
    expect(verdict.reset * 1000).toBe(Math.floor(inWindow / 60_000) * 60_000 + 60_000);
    expect(limiter.check("k", 1, period, inWindow).allowed).toBe(false);
    // next window: allowed again
    expect(limiter.check("k", 1, period, inWindow + 60_000).allowed).toBe(true);
  });

  test("keys are independent", () => {
    const limiter = new RateLimiter();
    const now = 1_000_000_000_000;
    limiter.check("a", 1, 60, now);
    expect(limiter.check("b", 1, 60, now).allowed).toBe(true);
  });
});

describe("spec normalization", () => {
  test("Swagger 2.0 yields operations and a server URL", () => {
    const { model, format } = normalizeSpec(JSON.stringify(MINI_SPEC));
    expect(format).toBe("swagger-2.0");
    expect(model.servers).toContain("https://example.test/v2");
    expect(model.operations.map((o) => `${o.method} ${o.path}`).sort()).toEqual([
      "GET /store/inventory",
      "POST /pet",
    ]);
  });

  test("OpenAPI 3.1 normalizes into the same shape", () => {
    const { model, format } = normalizeSpec(
      JSON.stringify({
        openapi: "3.1.0",
        info: { title: "mini", version: "1.0.0" },
        servers: [{ url: "https://example.test/v2" }],
        paths: { "/store/inventory": { get: { operationId: "getInventory", responses: {} } } },
      }),
    );
    expect(format).toBe("openapi-3.1");
    expect(model.servers).toEqual(["https://example.test/v2"]);
    expect(model.operations[0]!.operationId).toBe("getInventory");
  });

  test("a reformatted document has the same version digest", () => {
    const a = normalizeSpec(JSON.stringify(MINI_SPEC));
    // Key order differs and the indentation differs; the normalized model must not notice.
    const { paths, info, ...rest } = MINI_SPEC;
    const reordered = { paths, info, ...rest };
    const b = normalizeSpec(JSON.stringify(reordered, null, 4));
    expect(digestOf(a.model)).toBe(digestOf(b.model));
  });

  test("export regenerates a document that normalizes to the same model", () => {
    const first = normalizeSpec(JSON.stringify(MINI_SPEC));
    const exported = toOpenApi31(first.model);
    const second = normalizeSpec(JSON.stringify(exported));
    expect(second.model.operations).toEqual(first.model.operations);
    expect(second.format).toBe("openapi-3.1");
  });

  test("a remote $ref is rejected: uploaded specs must be self-contained", () => {
    expect(() =>
      assertSelfContained({ paths: { "/a": { $ref: "https://evil.example/schema.json" } } }),
    ).toThrow(/self-contained/);
    expect(() => assertSelfContained({ paths: { "/a": { $ref: "#/definitions/A" } } })).not.toThrow();
  });

  test("a document with no operations is rejected", () => {
    expect(() => normalizeSpec(JSON.stringify({ swagger: "2.0", info: {}, paths: {} }))).toThrow(
      /no operations/,
    );
  });

  test("YAML is refused with an explanation rather than mis-parsed", () => {
    expect(() => normalizeSpec("swagger: '2.0'\ninfo:\n  title: x")).toThrow(/YAML/);
  });
});

describe("key hashing and CIDRs", () => {
  test("the key hash is stable and prefixed", () => {
    expect(hashSubscriptionKey("sk_dev_abc")).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(hashSubscriptionKey("sk_dev_abc")).toBe(hashSubscriptionKey("sk_dev_abc"));
    expect(hashSubscriptionKey("sk_dev_abd")).not.toBe(hashSubscriptionKey("sk_dev_abc"));
  });

  test("CIDR matching covers the ranges the egress deny list uses", () => {
    expect(ipInCidr("169.254.169.254", "169.254.0.0/16")).toBe(true);
    expect(ipInCidr("10.1.2.3", "10.0.0.0/8")).toBe(true);
    expect(ipInCidr("172.32.0.1", "172.16.0.0/12")).toBe(false);
    expect(ipInCidr("8.8.8.8", "10.0.0.0/8")).toBe(false);
    expect(ipInCidr("::1", "10.0.0.0/8")).toBe(false);
  });
});
