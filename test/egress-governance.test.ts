import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildConfig } from "../control-plane/src/config-build.ts";
import { readIntegrations } from "../control-plane/src/config.ts";
import { parseDenyRuleDraft, DenyRuleError } from "../control-plane/src/deny-rules.ts";
import { matchingDenyRule, type DenyRule } from "../control-plane/src/egress.ts";
import { denyRule, makeCp, publishApi, startBackend, type TestCp } from "./helpers.ts";

/**
 * Egress governance (`openspec/specs/egress-governance`).
 *
 * The capability replaced an allowlist in `INTEGRATIONS_FILE` that needed a control-plane restart
 * per backend. Two claims carry the whole design and are what this file is about:
 *
 *  - **allowed by default** — a team registers a backend nobody has blocked, with no admin in the
 *    loop and nothing restarted;
 *  - **a rule reaches what is already running** — an administrator writing a rule today takes a
 *    route that has been serving for months out of the environment's configuration document, which
 *    is what every instance serves from. Write-time refusal alone would only govern the next write,
 *    and that is the weaker control the file-based allowlist also had.
 */

let cp: TestCp;

beforeEach(() => {
  cp = makeCp();
});
afterEach(() => {
  cp.close();
});

function rule(over: Partial<DenyRule> = {}): DenyRule {
  return {
    id: "r",
    environment: null,
    scheme: null,
    hostPattern: "blocked.example.com",
    reason: "test",
    ...over,
  };
}

describe("matching", () => {
  test("an exact pattern matches that host and nothing else", () => {
    const rules = [rule({ hostPattern: "backend.example.com" })];
    expect(matchingDenyRule("https://backend.example.com/v1", rules, "dev")).not.toBeNull();
    expect(matchingDenyRule("https://other.example.com/v1", rules, "dev")).toBeNull();
  });

  // The rule that is easy to get wrong, and whose failure mode is a rule that looks like it covers
  // a host it does not.
  test("*.suffix matches subdomains but not the bare suffix", () => {
    const rules = [rule({ hostPattern: "*.example.com" })];
    expect(matchingDenyRule("https://a.example.com/", rules, "dev")).not.toBeNull();
    expect(matchingDenyRule("https://deep.a.example.com/", rules, "dev")).not.toBeNull();
    expect(matchingDenyRule("https://example.com/", rules, "dev")).toBeNull();
  });

  test("matching is case-insensitive", () => {
    const rules = [rule({ hostPattern: "Backend.Example.COM" })];
    expect(matchingDenyRule("https://backend.example.com/", rules, "dev")).not.toBeNull();
  });

  test("a scheme narrows the rule, and no scheme covers both", () => {
    expect(matchingDenyRule("http://h.example/", [rule({ hostPattern: "h.example", scheme: "https" })], "dev")).toBeNull();
    expect(matchingDenyRule("https://h.example/", [rule({ hostPattern: "h.example", scheme: "https" })], "dev")).not.toBeNull();
    expect(matchingDenyRule("http://h.example/", [rule({ hostPattern: "h.example" })], "dev")).not.toBeNull();
  });

  test("a port set narrows the rule, with the scheme's default used when the URL omits one", () => {
    const rules = [rule({ hostPattern: "h.example", ports: [443] })];
    expect(matchingDenyRule("https://h.example/", rules, "dev")).not.toBeNull();
    expect(matchingDenyRule("https://h.example:8443/", rules, "dev")).toBeNull();
  });

  test("no port set covers every port", () => {
    const rules = [rule({ hostPattern: "h.example" })];
    expect(matchingDenyRule("https://h.example:9999/", rules, "dev")).not.toBeNull();
  });

  test("an environment-scoped rule applies to that environment only", () => {
    const rules = [rule({ hostPattern: "h.example", environment: "prod" })];
    expect(matchingDenyRule("https://h.example/", rules, "prod")).not.toBeNull();
    expect(matchingDenyRule("https://h.example/", rules, "dev")).toBeNull();
  });

  // A publish-time fetch belongs to no environment yet, so only the estate's own rules apply.
  test("a fetch with no environment consults estate-wide rules only", () => {
    const scoped = [rule({ hostPattern: "h.example", environment: "dev" })];
    const estate = [rule({ hostPattern: "h.example", environment: null })];
    expect(matchingDenyRule("https://h.example/", scoped, null)).toBeNull();
    expect(matchingDenyRule("https://h.example/", estate, null)).not.toBeNull();
  });
});

describe("a draft is validated before it can be saved", () => {
  const ok = { hostPattern: "a.example.com", reason: "x".repeat(20) };

  test("a URL is refused, because a rule matches a host", () => {
    expect(() => parseDenyRuleDraft({ ...ok, hostPattern: "https://a.example.com/v1" })).toThrow(DenyRuleError);
  });

  test("a port inside the pattern is refused, because ports are their own field", () => {
    expect(() => parseDenyRuleDraft({ ...ok, hostPattern: "a.example.com:443" })).toThrow(/port/i);
  });

  // A rule matching everything would take the estate off the air in one click.
  test("a bare wildcard is refused", () => {
    expect(() => parseDenyRuleDraft({ ...ok, hostPattern: "*" })).toThrow(/every host/);
  });

  test("a reason shorter than the minimum is refused, naming it", () => {
    expect(() => parseDenyRuleDraft({ ...ok, reason: "too short" })).toThrow(/at least 20/);
  });

  test("a good draft normalises case and sorts its ports", () => {
    const draft = parseDenyRuleDraft({ ...ok, hostPattern: "A.Example.COM", ports: [8443, 443, 443] });
    expect(draft.hostPattern).toBe("a.example.com");
    expect(draft.ports).toEqual([443, 8443]);
  });
});

describe("the boundary at write time", () => {
  test("a backend nobody has blocked needs no administrator and no restart", async () => {
    const pavel = await cp.login("pavel");
    const resource = await (
      await cp.call("POST", "/api/resources", {
        cookie: pavel,
        body: { kind: "rest", name: "selfservice", applicationId: "application_platform" },
      })
    ).json();
    const response = await cp.call("PUT", `/api/resources/${resource.id}/binding`, {
      cookie: pavel,
      body: { environment: "dev", urls: ["https://anything.example.com/v1"] },
    });
    expect(response.status).toBe(200);
  });

  test("a blocked backend is refused, quoting the rule's reason", async () => {
    denyRule(cp, { hostPattern: "*.blocked.example", reason: "Ticket SEC-1 — not an approved egress target" });
    const pavel = await cp.login("pavel");
    const resource = await (
      await cp.call("POST", "/api/resources", {
        cookie: pavel,
        body: { kind: "rest", name: "blocked", applicationId: "application_platform" },
      })
    ).json();
    const response = await cp.call("PUT", `/api/resources/${resource.id}/binding`, {
      cookie: pavel,
      body: { environment: "dev", urls: ["https://api.blocked.example/v1"] },
    });
    expect(response.status).toBe(400);
    expect((await response.json()).detail).toContain("SEC-1");
  });

  // A pool is exactly as safe as its least-checked member.
  test("one blocked member refuses the whole pool", async () => {
    denyRule(cp, { hostPattern: "bad.example", reason: "Blocked for the purposes of this test case" });
    const pavel = await cp.login("pavel");
    const resource = await (
      await cp.call("POST", "/api/resources", {
        cookie: pavel,
        body: { kind: "rest", name: "mixedpool", applicationId: "application_platform" },
      })
    ).json();
    const response = await cp.call("PUT", `/api/resources/${resource.id}/binding`, {
      cookie: pavel,
      body: {
        environment: "dev",
        pool: [{ url: "https://good.example/v1" }, { url: "https://bad.example/v1" }],
      },
    });
    expect(response.status).toBe(400);
  });
});

describe("a rule reaches routes that are already running", () => {
  test("a route serving today stops being served once its backend is blocked", async () => {
    const backend = startBackend();
    try {
      const api = await publishApi(cp, { backendUrl: backend.url });

      const before = buildConfig(cp.app.db, cp.app.kek, "dev", cp.app.config);
      expect(before.routes.some((route) => route.resourceId === api.resourceId)).toBe(true);

      // The rule arrives after the route has been converged and served.
      denyRule(cp, {
        hostPattern: "127.0.0.1",
        reason: "Loopback backends are not permitted in this estate any more",
      });

      const after = buildConfig(cp.app.db, cp.app.kek, "dev", cp.app.config);
      expect(after.routes.some((route) => route.resourceId === api.resourceId)).toBe(false);
      // Omitted *with a reason*, in the block the gateway already reads and the dashboard already
      // renders — so the team sees why their route stopped where they already look.
      const error = after.errors.find((entry) => entry.resourceId === api.resourceId);
      expect(error?.detail).toContain("blocked by the deny rule");
      expect(error?.detail).toContain("not permitted in this estate");
    } finally {
      backend.stop();
    }
  });

  test("removing the rule puts the route back at the next build", async () => {
    const backend = startBackend();
    try {
      const api = await publishApi(cp, { backendUrl: backend.url });
      denyRule(cp, { hostPattern: "127.0.0.1", reason: "Temporarily blocked for this test case" });
      expect(
        buildConfig(cp.app.db, cp.app.kek, "dev", cp.app.config).routes.some(
          (route) => route.resourceId === api.resourceId,
        ),
      ).toBe(false);

      const alice = await cp.login("alice");
      const list = await (await cp.call("GET", "/api/trust/deny-rules", { cookie: alice })).json();
      const created = list.items.find((item: { hostPattern: string }) => item.hostPattern === "127.0.0.1");
      expect((await cp.call("DELETE", `/api/trust/deny-rules/${created.id}`, { cookie: alice })).status).toBe(204);

      expect(
        buildConfig(cp.app.db, cp.app.kek, "dev", cp.app.config).routes.some(
          (route) => route.resourceId === api.resourceId,
        ),
      ).toBe(true);
    } finally {
      backend.stop();
    }
  });

  test("a rule scoped to another environment leaves this one serving", async () => {
    const backend = startBackend();
    try {
      const api = await publishApi(cp, { backendUrl: backend.url });
      denyRule(cp, {
        hostPattern: "127.0.0.1",
        environment: "prod",
        reason: "Loopback is refused in production, but dev is where the fixtures live",
      });
      const config = buildConfig(cp.app.db, cp.app.kek, "dev", cp.app.config);
      expect(config.routes.some((route) => route.resourceId === api.resourceId)).toBe(true);
    } finally {
      backend.stop();
    }
  });

  // Nothing new travels for this control: a route omitted from the document is a route no instance
  // can serve, so no gateway needs an upgrade and none reports `activationBlocked`.
  test("blocking a route does not change the document's version", async () => {
    const backend = startBackend();
    try {
      await publishApi(cp, { backendUrl: backend.url });
      const before = buildConfig(cp.app.db, cp.app.kek, "dev", cp.app.config).configVersion;
      denyRule(cp, { hostPattern: "127.0.0.1", reason: "Blocked to check the wire version is untouched" });
      expect(buildConfig(cp.app.db, cp.app.kek, "dev", cp.app.config).configVersion).toBe(before);
    } finally {
      backend.stop();
    }
  });
});

describe("the administrator's screen", () => {
  test("the rules are admin-only", async () => {
    const pavel = await cp.login("pavel");
    expect((await cp.call("GET", "/api/trust/deny-rules", { cookie: pavel })).status).toBe(403);
    expect(
      (
        await cp.call("POST", "/api/trust/deny-rules", {
          cookie: pavel,
          body: { hostPattern: "a.example", reason: "x".repeat(20) },
        })
      ).status,
    ).toBe(403);
  });

  test("the dry run names the routes a rule would take out, before anything is written", async () => {
    const backend = startBackend();
    try {
      const api = await publishApi(cp, { backendUrl: backend.url });
      const alice = await cp.login("alice");
      const preview = await (
        await cp.call("POST", "/api/trust/deny-rules/preview", {
          cookie: alice,
          body: { hostPattern: "127.0.0.1" },
        })
      ).json();
      expect(preview.count).toBeGreaterThan(0);
      expect(preview.blocking.some((row: { resourceId: string }) => row.resourceId === api.resourceId)).toBe(true);

      // And nothing was created by asking. (The estate always has schema-013's shipped rule for
      // the control plane's own service name, so "empty" is not the assertion.)
      const list = await (await cp.call("GET", "/api/trust/deny-rules", { cookie: alice })).json();
      expect(list.items.some((item: { hostPattern: string }) => item.hostPattern === "127.0.0.1")).toBe(false);
    } finally {
      backend.stop();
    }
  });

  test("a second live rule for the same host and scope is refused", async () => {
    const alice = await cp.login("alice");
    const body = { hostPattern: "dup.example", reason: "The first rule, with a long enough reason" };
    expect((await cp.call("POST", "/api/trust/deny-rules", { cookie: alice, body })).status).toBe(201);
    const again = await cp.call("POST", "/api/trust/deny-rules", {
      cookie: alice,
      body: { ...body, reason: "The second rule, with its own long enough reason" },
    });
    expect(again.status).toBe(409);
  });

  test("the platform's rule for the portal's own address is listed and cannot be removed", async () => {
    const alice = await cp.login("alice");
    const list = await (await cp.call("GET", "/api/trust/deny-rules", { cookie: alice })).json();
    expect(list.platformRules).toHaveLength(1);
    expect(list.platformRules[0].hostPattern).toBe("localhost");
    const refused = await cp.call(`DELETE`, `/api/trust/deny-rules/${list.platformRules[0].id}`, {
      cookie: alice,
    });
    expect(refused.status).toBe(403);
  });

  test("creating and removing a rule is audited, with the blast radius on the line", async () => {
    const alice = await cp.login("alice");
    const created = await (
      await cp.call("POST", "/api/trust/deny-rules", {
        cookie: alice,
        body: { hostPattern: "audited.example", reason: "Audited for the purposes of this test" },
      })
    ).json();
    await cp.call("DELETE", `/api/trust/deny-rules/${created.id}`, { cookie: alice });

    const audit = cp.app.db
      .query<{ action: string; detail: string }, []>(
        "SELECT action, detail FROM audit WHERE action LIKE 'egress-deny-rule.%' ORDER BY at",
      )
      .all();
    expect(audit.map((row) => row.action)).toEqual([
      "egress-deny-rule.create",
      "egress-deny-rule.remove",
    ]);
    expect(JSON.parse(audit[0]!.detail).blocked).toBe(0);
  });

  test("the estate's bound on live rules is enforced, naming the variable", async () => {
    // Two, because schema-013 ships one: the bound counts every live rule, including the estate's
    // own, which is the honest count and the one an administrator sees on the screen.
    const small = makeCp({ maxEgressDenyRules: 2 });
    try {
      const alice = await small.login("alice");
      const first = await small.call("POST", "/api/trust/deny-rules", {
        cookie: alice,
        body: { hostPattern: "one.example", reason: "The only rule this estate has room for" },
      });
      expect(first.status).toBe(201);
      const second = await small.call("POST", "/api/trust/deny-rules", {
        cookie: alice,
        body: { hostPattern: "two.example", reason: "One rule too many for this estate's bound" },
      });
      expect(second.status).toBe(409);
      expect((await second.json()).detail).toContain("MAX_EGRESS_DENY_RULES");
    } finally {
      small.close();
    }
  });

  test("the governance report answers the question about the estate rather than about an API", async () => {
    const backend = startBackend();
    try {
      const api = await publishApi(cp, { backendUrl: backend.url });
      denyRule(cp, { hostPattern: "127.0.0.1", reason: "Blocked so the report has something to say" });
      const alice = await cp.login("alice");
      const report = await (
        await cp.call("GET", "/api/governance/exceptions", { cookie: alice })
      ).json();
      const row = report.blockedRoutes.find((entry: { resourceId: string }) => entry.resourceId === api.resourceId);
      expect(row.hostPattern).toBe("127.0.0.1");
      expect(row.reason).toContain("something to say");
    } finally {
      backend.stop();
    }
  });
});

describe("the retired allowlist", () => {
  // Ignoring the key would leave an operator believing they are protected by a list nothing reads,
  // which is the one failure mode worse than having no list at all.
  test("an integrations file still declaring egressAllowlist is a boot failure that says so", () => {
    const dir = mkdtempSync(join(tmpdir(), "apim-integrations-"));
    try {
      const path = join(dir, "integrations.json");
      writeFileSync(path, JSON.stringify({ egressAllowlist: [], denyCidrs: [] }));
      expect(() => readIntegrations(path)).toThrow(/retired/);
      expect(() => readIntegrations(path)).toThrow(/Blocked backends/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a file without it parses", () => {
    const dir = mkdtempSync(join(tmpdir(), "apim-integrations-"));
    try {
      const path = join(dir, "integrations.json");
      writeFileSync(path, JSON.stringify({ denyCidrs: ["169.254.0.0/16"] }));
      expect(readIntegrations(path).denyCidrs).toEqual(["169.254.0.0/16"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
