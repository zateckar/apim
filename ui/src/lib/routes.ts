/**
 * Every screen, with the two sentences it must have (plan §9.4).
 *
 * The rule "every screen has a title and a one-line purpose" is enforced **structurally**: the
 * shell renders the title and purpose from this table, so a screen cannot exist without them and a
 * test can assert the property over every route rather than over every component.
 *
 * `section` classifies a screen by capability, not inventory `[P1-26]`: "Publish APIs" applies to a
 * application that has published nothing, or nobody could publish a first API. Only `operate` is
 * gated, and a non-admin who deep-links into one of its screens gets the screen with every control
 * disabled and one line naming who can change it.
 *
 * The sidebar itself lives in `portal/Portal.tsx` and groups screens around the selected
 * application rather than around these sections — `nav` and `adminOnly` say a screen is navigable
 * and to whom, and `portal.test.tsx` holds the shell to it. This table does not build a second
 * navigation of its own.
 */

export type Section = "home" | "use" | "publish" | "operate" | "help" | "account" | "detail";

export interface RouteDef {
  id: string;
  /** `:name` marks a segment that is captured. Matched left to right, longest first. */
  pattern: string;
  title: string;
  /** One line, under the title, saying what this screen is for and to whom. */
  purpose: string;
  section: Section;
  /** The sidebar label. Absent for a screen you arrive at rather than navigate to. */
  nav?: string;
  adminOnly?: boolean;
}

export const ROUTES: RouteDef[] = [
  {
    id: "home",
    pattern: "/",
    title: "Home",
    purpose: "What needs your attention, and what you can do next.",
    section: "home",
    nav: "Home",
  },

  // ------------------------------------------------------------------ use APIs
  {
    id: "catalog",
    pattern: "/catalog",
    title: "Catalog",
    purpose: "Every API you are allowed to see, with what it does and how to start calling it.",
    section: "use",
    nav: "Catalog",
  },
  {
    id: "listing",
    pattern: "/catalog/:resourceId",
    title: "API",
    purpose: "What this API does, how to subscribe, and how to call it.",
    section: "detail",
  },
  {
    id: "subscribe",
    pattern: "/catalog/:resourceId/subscribe",
    title: "Subscribe",
    purpose: "Choose the application that will call this API, and in which environment.",
    section: "detail",
  },
  {
    id: "subscriptions",
    pattern: "/subscriptions",
    title: "My subscriptions",
    purpose: "Your applications, the APIs they can call, and their keys.",
    section: "use",
    nav: "My subscriptions",
  },
  {
    id: "subscription",
    pattern: "/subscriptions/:subscriptionId",
    title: "Subscription",
    purpose: "This application's access to one product: its keys, what it may call, and what it has spent.",
    section: "detail",
  },

  // ------------------------------------------------------------------ publish APIs
  {
    id: "apis",
    pattern: "/apis",
    title: "My APIs",
    purpose: "The APIs your applications publish, and where each version is live.",
    section: "publish",
    nav: "My APIs",
  },
  {
    id: "api-new",
    pattern: "/apis/new",
    title: "Publish an API",
    purpose: "Import a definition, say where it is routed and what it forwards to, then release it.",
    section: "detail",
  },
  {
    id: "api",
    pattern: "/apis/:resourceId",
    title: "API",
    purpose: "One API: its definition, where it is live, and everything set per environment.",
    section: "detail",
  },
  {
    id: "api-tab",
    pattern: "/apis/:resourceId/:tab",
    title: "API",
    purpose: "One API: its definition, where it is live, and everything set per environment.",
    section: "detail",
  },
  {
    id: "products",
    pattern: "/products",
    title: "My products",
    purpose: "The bundles consumers subscribe to, and who has subscribed to them.",
    section: "publish",
    nav: "My products",
  },

  // ------------------------------------------------------------------ operate
  {
    id: "fleet",
    pattern: "/fleet",
    title: "Gateways",
    purpose: "Every gateway instance, what configuration it is running, and anything it has refused.",
    section: "operate",
    nav: "Gateways",
    adminOnly: true,
  },
  {
    id: "telemetry",
    pattern: "/telemetry",
    title: "Telemetry",
    purpose: "Calls per minute across the estate: served, refused by the gateway, and failed upstream.",
    section: "operate",
    nav: "Telemetry",
    adminOnly: true,
  },
  {
    id: "global-policy",
    pattern: "/policy",
    title: "Global policy",
    purpose: "Policy units attached to a whole environment, and the APIs that override them.",
    section: "operate",
    nav: "Global policy",
    adminOnly: true,
  },
  {
    id: "trust",
    pattern: "/trust",
    title: "Trust",
    purpose:
      "The certificate authorities each environment's gateways trust, the identities they present, and every exception that is still open.",
    section: "operate",
    nav: "Trust",
    adminOnly: true,
  },
  {
    id: "users",
    pattern: "/users",
    title: "People",
    purpose: "Everybody this portal knows, how they sign in, and what each of them can do.",
    section: "operate",
    nav: "People",
    adminOnly: true,
  },
  {
    id: "user",
    pattern: "/users/:userId",
    title: "Account",
    purpose: "One account: how they sign in, which applications they are in, and where they are signed in.",
    section: "detail",
  },
  {
    id: "applications",
    pattern: "/applications",
    title: "Applications",
    purpose: "Who owns what. Every API, product and application belongs to exactly one application.",
    section: "operate",
    nav: "Applications",
    adminOnly: true,
  },
  {
    id: "application",
    pattern: "/applications/:applicationId",
    title: "Application",
    purpose: "One application: who is in it, how they got there, and what it owns.",
    section: "detail",
  },
  {
    id: "audit",
    pattern: "/audit",
    title: "Audit",
    purpose: "Who changed what, when, and what happened as a result.",
    section: "operate",
    nav: "Audit",
    adminOnly: true,
  },

  // ------------------------------------------------------------------ your own account
  {
    id: "account",
    pattern: "/account",
    title: "Your account",
    purpose: "How you sign in, which applications you are in, and where else you are signed in.",
    section: "account",
    nav: "Your account",
  },

  // ------------------------------------------------------------------ help
  {
    id: "how",
    pattern: "/how",
    title: "How this works",
    purpose: "The six things you can do here, the two-tier model behind them, and every term defined.",
    section: "help",
    nav: "How this works",
  },
];

export interface Match {
  route: RouteDef;
  params: Record<string, string>;
}

/**
 * Longest literal prefix wins, so `/apis/new` is the publish wizard and not the API whose id is
 * "new". Sorting rather than ordering by hand: a table somebody appends to should keep working.
 */
const ORDERED = [...ROUTES].sort((a, b) => literalScore(b.pattern) - literalScore(a.pattern));

function literalScore(pattern: string): number {
  return pattern
    .split("/")
    .filter(Boolean)
    .reduce((score, segment) => score + (segment.startsWith(":") ? 1 : 10), 0);
}

export function matchRoute(path: string): Match {
  const parts = split(path);
  for (const route of ORDERED) {
    const pattern = split(route.pattern);
    if (pattern.length !== parts.length) continue;
    const params: Record<string, string> = {};
    let ok = true;
    for (let i = 0; i < pattern.length; i++) {
      const expected = pattern[i]!;
      const actual = parts[i]!;
      if (expected.startsWith(":")) params[expected.slice(1)] = decodeURIComponent(actual);
      else if (expected !== actual) {
        ok = false;
        break;
      }
    }
    if (ok) return { route, params };
  }
  return { route: NOT_FOUND, params: {} };
}

export const NOT_FOUND: RouteDef = {
  id: "not-found",
  pattern: "/404",
  title: "Not found",
  purpose: "That address does not match anything in the portal.",
  section: "detail",
};

function split(path: string): string[] {
  return path.split("?")[0]!.split("/").filter(Boolean);
}

/** The screens a caller of this authority may be offered a link to. */
export function navigable(isAdmin: boolean): RouteDef[] {
  return ROUTES.filter((route) => route.nav && (!route.adminOnly || isAdmin));
}
