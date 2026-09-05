import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ADMIN_NAV,
  APPLICATION_NAV,
  GLOBAL_NAV,
  Portal,
} from "../src/portal/Portal.tsx";
import { ROUTES } from "../src/lib/routes.ts";
import type { Meta, User } from "../src/api.ts";

/**
 * The portal shell, and the one property that cannot be checked by looking at it (reuse analysis
 * §"Portal reuse"): every screen the route table declares navigable is reachable from the sidebar.
 *
 * The shell was rewritten around the application picker while `lib/routes.ts` kept the screens, so
 * "it renders" and "you can get there" stopped being the same statement — Telemetry, Global policy,
 * Trust and Your account each existed, answered on their address, and were linked from nowhere.
 * A screen may leave the shell, but it has to leave through `COVERED_ELSEWHERE` rather than by
 * being forgotten.
 *
 * `renderToStaticMarkup` runs no effects, so nothing here depends on a control plane; the theme
 * is read from `localStorage` in a lazy initialiser, which does run, and is stubbed for it.
 */

const store = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  },
});

const meta: Meta = {
  environments: [{ environment: "dev", instances: 1, liveInstances: 1 }],
  chain: ["dev", "test", "prod"],
  kinds: ["rest", "soap", "mcp", "a2a"],
  policyUnits: [],
  authProviders: ["oidc"],
  publicUrl: "http://localhost:8080",
  telemetryRetentionHours: 48,
};

const member: User = {
  id: "usr_1",
  name: "Clara Consumer",
  roles: ["member"],
  applications: ["application_platform"],
  isAdmin: false,
};

const admin: User = { ...member, id: "usr_2", name: "Alice Admin", isAdmin: true };

function sessionFor(user: User) {
  return {
    user,
    meta,
    applications: [{ id: "application_platform", name: "Platform", mine: true }],
    application: "application_platform",
    setApplication: () => {},
    applicationName: (id: string) => (id === "application_platform" ? "Platform" : id),
    environment: "dev",
    setEnvironment: () => {},
    reload: () => {},
    me: {
      user,
      applications: [],
      mustChangePassword: false,
      claimsStale: false,
      unmappedGroups: [],
    },
  };
}

function shellFor(user: User): { html: string; hrefs: Set<string> } {
  const html = renderToStaticMarkup(
    <Portal session={sessionFor(user) as never} path="/application_platform/dashboard" />,
  );
  return {
    html,
    hrefs: new Set([...html.matchAll(/href="([^"]*)"/g)].map((match) => match[1]!)),
  };
}

/**
 * The navigable routes the sidebar deliberately does not link, and what stands in for each. An
 * entry here is a decision; a route that is merely missing is a bug this file reports.
 */
const COVERED_ELSEWHERE = [
  {
    id: "home",
    why: "the shell opens on the selected application's Dashboard, which answers the same question about the application rather than about the estate",
  },
  {
    id: "catalog",
    why: "linked as Catalog at /discover, which is the same cross-application Workspace listing",
  },
  {
    id: "apis",
    why: "an application-scoped tab: /:applicationId/apis, because an API belongs to exactly one application",
  },
  {
    id: "products",
    why: "an application-scoped tab: /:applicationId/products",
  },
  {
    id: "subscriptions",
    why: "an application-scoped tab: /:applicationId/subscriptions, scoped to the consuming application",
  },
  {
    id: "fleet",
    why: "linked as Health Status at /health, which renders the same GatewayView for members as well as admins",
  },
];

describe("the portal shell", () => {
  const asAdmin = shellFor(admin);

  test("every navigable route is reachable, or is covered on purpose", () => {
    const missing = ROUTES.filter(
      (route) =>
        route.nav &&
        !asAdmin.hrefs.has(route.pattern) &&
        !COVERED_ELSEWHERE.some((row) => row.id === route.id),
    ).map((route) => `${route.id} (${route.pattern})`);
    expect(missing).toEqual([]);
  });

  test("the coverage exemptions have not gone stale", () => {
    for (const row of COVERED_ELSEWHERE) {
      const route = ROUTES.find((entry) => entry.id === row.id);
      expect(route, row.id).toBeDefined();
      expect(route!.nav, `${row.id} is no longer navigable, so the exemption says nothing`).toBeTruthy();
    }
  });

  test("both global groups render every entry they declare", () => {
    for (const [tab, label] of [...GLOBAL_NAV, ...ADMIN_NAV]) {
      expect(asAdmin.hrefs, tab).toContain(`/${tab}`);
      expect(asAdmin.html, tab).toContain(label);
    }
  });

  test("the application tabs hang off the selected application", () => {
    for (const group of APPLICATION_NAV)
      for (const [tab] of group.items)
        expect(asAdmin.hrefs, tab).toContain(`/application_platform/${tab}`);
  });

  test("the administration group is exactly the route table's gated screens", () => {
    // Two lists that have to agree, held together here rather than by hoping: a screen marked
    // `adminOnly` and then linked in the group every member sees is a 403 with a label on it.
    const gated = ROUTES.filter(
      (route) =>
        route.nav && route.adminOnly && !COVERED_ELSEWHERE.some((row) => row.id === route.id),
    )
      .map((route) => route.pattern)
      .sort();
    expect(ADMIN_NAV.map(([tab]) => `/${tab}`).sort()).toEqual(gated);
  });

  test("nothing gated leaks into the group every member sees", () => {
    for (const [tab] of GLOBAL_NAV) {
      // Some global tabs are the shell's own sections rather than routes; those cannot be gated.
      const route = ROUTES.find((entry) => entry.pattern === `/${tab}`);
      expect(route?.adminOnly ?? false, tab).toBe(false);
    }
  });

  test("a member is offered no administration group and no admin-only screen", () => {
    const asMember = shellFor(member);
    expect(asMember.html).not.toContain("Administration");
    for (const [tab] of ADMIN_NAV) expect(asMember.hrefs, tab).not.toContain(`/${tab}`);
    // The screens that are not admin-only stay: the shell hides authority, not the portal.
    for (const [tab] of GLOBAL_NAV) expect(asMember.hrefs, tab).toContain(`/${tab}`);
  });

  test("the simulated integrations are declared in the chrome, not only inside their screens", () => {
    // Every one of the six is a mock this phase; a shell that looked production-real would be the
    // one dishonest surface in the portal.
    expect(asAdmin.html).toContain("Integrations simulated");
  });
});
