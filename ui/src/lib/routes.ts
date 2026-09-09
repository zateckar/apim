/**
 * Every address the portal answers on, in one table.
 *
 * There used to be two. This file declared the screens and `App.tsx` rendered them from a `switch`,
 * while the branded shell kept a second list of sections, a second map of titles and a ternary
 * ladder of its own — so a screen could be in the table, linked in the sidebar, and still arrive
 * somewhere else, and three separate places had to agree before an address worked. They did not:
 * `/apis/:id/:tab` dropped its tab, and two screens rendered under one title.
 *
 * Now the table is the whole of it. It says what a screen is called, what it is for, where it hangs,
 * who is offered a link to it and which chrome it wants; `screens.tsx` says which component answers
 * each `id`; `portal/Portal.tsx` draws the frame around whatever comes back. Nothing else routes.
 *
 * The rule "every screen has a title and a one-line purpose" is enforced structurally: the shell
 * renders both from here, so a screen cannot exist without them and `routes.test.ts` asserts the
 * property over every route rather than over every component.
 */

/** The sidebar's groups, in the order they are drawn. A group with no title is drawn bare. */
export type NavGroup = "Overview" | "API" | "Kafka" | "Other" | "Global" | "Administration";

export const NAV_GROUPS: ReadonlyArray<{ group: NavGroup; title: string | null }> = [
  { group: "Overview", title: null },
  { group: "API", title: "API" },
  { group: "Kafka", title: "Kafka" },
  { group: "Other", title: "Other" },
  { group: "Global", title: "Global" },
  { group: "Administration", title: "Administration" },
];

export interface RouteDef {
  id: string;
  /**
   * Every address this screen answers on. The first is canonical — the one the sidebar writes and
   * the one a test resolves the route by. The rest are addresses somebody already has: a bookmark,
   * a link written before the shell, an attention row from the control plane. A kept address costs
   * one string here; losing it costs somebody a working link.
   *
   * `:name` captures a segment. Matched longest-literal-first, so `/apis/new` is the wizard and not
   * an API whose id is "new".
   */
  patterns: string[];
  title: string;
  /** One line, under the title, saying what this screen is for and to whom. */
  purpose: string;
  /**
   * `application` screens hang off the selected application and the sidebar writes them as
   * `/:applicationId/…`, because an API, a product and a subscription each belong to exactly one.
   * `global` screens are the same whoever is reading. Both shapes also resolve without the prefix.
   */
  scope: "application" | "global";
  /** Only screens that consume the shell's selected environment offer its switcher. */
  environmentScoped?: boolean;
  /** The sidebar entry. Absent for a screen you arrive at rather than navigate to. */
  nav?: { group: NavGroup; label: string };
  /**
   * The sidebar offers this only to an administrator. It gates the *link*, not the screen: the
   * shell hides authority it cannot exercise, and the control plane refuses what it must on every
   * request. A screen that is open to everybody with an admin-only panel inside it says so itself.
   */
  adminOnly?: boolean;
  /**
   * A screen written before the branded shell, which brings no table styling of its own. The shell
   * wraps it in `.native-legacy` (see `portal.css`) so its tables, buttons and banners inherit the
   * estate's. Not a to-do list: some of these screens are simply plain, and plain is correct.
   */
  plainChrome?: boolean;
}

export const ROUTES: RouteDef[] = [
  // ------------------------------------------------------------------ the selected application
  {
    id: "dashboard",
    environmentScoped: true,
    // `/` is the address the browser opens on and the one the logo returns to. It resolves to the
    // selected application's dashboard rather than to an estate-wide home, because every question
    // this portal answers is asked about one application at a time.
    patterns: ["/dashboard", "/"],
    title: "Dashboard",
    purpose: "What needs your attention in this application, and what you can do next.",
    scope: "application",
    nav: { group: "Overview", label: "Dashboard" },
  },
  {
    id: "apis",
    patterns: ["/apis"],
    title: "APIs",
    purpose:
      "The REST and SOAP APIs this application publishes or subscribes to, and where each version is live.",
    scope: "application",
    nav: { group: "API", label: "APIs" },
  },
  {
    id: "mcp",
    patterns: ["/mcp"],
    title: "MCP Servers",
    purpose:
      "The MCP servers this application publishes or subscribes to, and the tools each one offers.",
    scope: "application",
    nav: { group: "API", label: "MCP Servers" },
  },
  {
    id: "a2a",
    patterns: ["/a2a"],
    title: "A2A Agents",
    purpose:
      "The A2A agents this application publishes or subscribes to, and the skills each one advertises.",
    scope: "application",
    nav: { group: "API", label: "A2A Agents" },
  },
  {
    id: "api",
    environmentScoped: true,
    /**
     * One workspace, four addresses. `apis`, `mcp` and `a2a` are three listings of the same objects
     * and each writes the row it opens under its own section, so the sidebar highlights the list
     * the reader came from. The fourth carries a tab, because the control plane's attention rows
     * link straight to the panel that fixes the problem (`/apis/:id/policy`, `/apis/:id/routing`).
     * That segment used to be parsed off and thrown away, so every one of those rows landed on
     * Definition instead.
     *
     * `/discover/:id` is deliberately **not** here. The catalog opens somebody else's API as the
     * read-only listing at `/catalog/:resourceId` rather than as the publisher's editor, so an
     * address under the catalogue that answered with the editor would contradict the screen.
     */
    patterns: [
      "/apis/:resourceId",
      "/apis/:resourceId/:tab",
      "/mcp/:resourceId",
      "/a2a/:resourceId",
    ],
    title: "API workspace",
    purpose: "One API: its definition, where it is live, and everything set per environment.",
    scope: "application",
  },
  {
    id: "publish",
    // `/apis/new` is what "Publish an API" on How this works has always linked to.
    patterns: ["/publish", "/apis/new"],
    title: "Publish an API",
    purpose: "Import a definition, say where it is routed and what it forwards to, then release it.",
    scope: "application",
  },
  {
    id: "products",
    patterns: ["/products"],
    title: "Products",
    purpose: "The bundles consumers subscribe to, and who has subscribed to them.",
    scope: "application",
    nav: { group: "API", label: "Products" },
    plainChrome: true,
  },
  {
    id: "subscriptions",
    environmentScoped: true,
    patterns: ["/subscriptions"],
    title: "Subscriptions",
    purpose: "The APIs this application may call, in each environment, and their keys.",
    scope: "application",
    nav: { group: "API", label: "Subscriptions" },
  },
  {
    id: "subscription",
    patterns: ["/subscriptions/:subscriptionId"],
    title: "Subscription",
    purpose:
      "This application's access to one product: its keys, what it may call, and what it has spent.",
    scope: "application",
    plainChrome: true,
  },
  {
    id: "approvals",
    environmentScoped: true,
    patterns: ["/approvals"],
    title: "Approvals",
    purpose: "Requests to call what this application publishes, waiting on somebody here.",
    scope: "application",
    nav: { group: "API", label: "Approvals" },
  },
  {
    id: "kafka",
    environmentScoped: true,
    patterns: ["/kafka"],
    title: "Kafka Topics",
    purpose: "The topics this application owns, and who is allowed to produce to or consume them.",
    scope: "application",
    nav: { group: "Kafka", label: "Kafka Topics" },
  },
  {
    id: "kafka-proxy",
    environmentScoped: true,
    patterns: ["/kafka-proxy"],
    title: "Kafka REST Proxy",
    purpose: "Reaching those topics over HTTP, for callers that cannot speak the Kafka protocol.",
    scope: "application",
    nav: { group: "Kafka", label: "Kafka REST Proxy" },
  },
  {
    id: "certificates",
    environmentScoped: true,
    patterns: ["/certificates"],
    title: "Certificates",
    purpose: "The client certificates this application presents, and when each of them expires.",
    scope: "application",
    nav: { group: "Other", label: "Certificates" },
    plainChrome: true,
  },
  {
    id: "integrations",
    environmentScoped: true,
    // Not "Integrations", which reads as a development slug for the thing this portal *is*. This
    // screen is the console for the surrounding systems — LeanIX, the directory, FixMe — every one
    // of which is simulated in this phase, which the chrome already says.
    patterns: ["/integrations"],
    title: "External systems",
    purpose: "The six systems around this portal, what each was asked, and what it answered.",
    scope: "application",
    nav: { group: "Other", label: "External systems" },
  },
  {
    id: "mail",
    // The bell's headlines are a summary; this is the message. Navigable in its own right because
    // "what was that mail about" is a question people arrive with, not one they only ever reach by
    // opening a popover first.
    patterns: ["/mail"],
    title: "Mail",
    purpose: "Every message this portal sent about this application, and what was in it.",
    scope: "application",
    nav: { group: "Other", label: "Mail" },
  },
  {
    id: "activity",
    patterns: ["/activity"],
    title: "Activity",
    purpose: "Changes this application has made, and how far each one has reached the gateways.",
    scope: "application",
    nav: { group: "Other", label: "Activity" },
  },

  // ------------------------------------------------------------------ the same for everybody
  {
    id: "catalog",
    /**
     * There were two catalogues. The shell drew its own cross-application list at `/discover` by
     * filtering `/api/resources` in the browser, while this one asks `/api/catalog` — which is
     * where the ranking, the facet counts, the Kafka topics and the honest `truncated` flag live.
     * Two screens under one title, and only one of them implemented what the spec says a catalogue
     * does. `/discover` is a bookmark now, and it costs one string here to keep it working.
     */
    patterns: ["/catalog", "/discover"],
    title: "Catalog",
    purpose:
      "Every API and Kafka topic you are allowed to see, what it does, and how to start calling it.",
    scope: "global",
    nav: { group: "Global", label: "Catalog" },
    plainChrome: true,
  },
  {
    id: "listing",
    patterns: ["/catalog/:resourceId"],
    title: "API",
    purpose: "What this API does, how to subscribe, and how to call it.",
    scope: "global",
    plainChrome: true,
  },
  {
    id: "subscribe",
    patterns: ["/catalog/:resourceId/subscribe"],
    title: "Subscribe",
    purpose: "Choose the application that will call this API, and in which environment.",
    scope: "global",
    plainChrome: true,
  },
  {
    id: "fixme",
    environmentScoped: true,
    patterns: ["/fixme"],
    title: "FixMe diagnostics",
    purpose: "What the FixMe service reports about the estate, and what it was asked.",
    scope: "global",
    nav: { group: "Global", label: "FixMe diagnostics" },
  },
  {
    id: "how",
    patterns: ["/how"],
    title: "How this works",
    purpose: "The six things you can do here, the two-tier model behind them, and every term defined.",
    scope: "global",
    nav: { group: "Global", label: "How this works" },
    plainChrome: true,
  },
  {
    id: "account",
    patterns: ["/account"],
    title: "Your account",
    purpose: "How you sign in, which applications you are in, and where else you are signed in.",
    scope: "global",
    nav: { group: "Global", label: "Your account" },
    plainChrome: true,
  },

  // ------------------------------------------------------------------ running the estate
  {
    id: "fleet",
    // `/health` is what the shell linked before the route table named this screen `/fleet`, and
    // `/fleet?environment=…` is what every attention row about an instance still writes.
    patterns: ["/fleet", "/health"],
    title: "Health Status",
    purpose:
      "Each environment's gateway: what configuration its replicas are running, and anything one has refused.",
    scope: "global",
    nav: { group: "Administration", label: "Health Status" },
    // The link is gated; the screen is not. Which environment is healthy decides whether a publisher
    // promotes this afternoon, and a screen only admins could read made them ask in chat — so the
    // convergence detail inside it is admin-only and the summary above it is open.
    adminOnly: true,
    plainChrome: true,
  },
  {
    id: "gateways",
    patterns: ["/gateways"],
    title: "Gateways",
    purpose:
      "Add a gateway, publish the hostname consumers call it on, and mint or revoke the replicas behind it.",
    scope: "global",
    nav: { group: "Administration", label: "Gateways" },
    adminOnly: true,
    plainChrome: true,
  },
  {
    id: "gateway-settings",
    patterns: ["/gateway-settings"],
    title: "Gateway settings",
    purpose:
      "The ceilings, caches and counters every gateway enforces — set once for the fleet, an environment or one gateway.",
    scope: "global",
    nav: { group: "Administration", label: "Gateway settings" },
    adminOnly: true,
    plainChrome: true,
  },
  {
    id: "applications",
    patterns: ["/applications"],
    title: "Applications",
    purpose: "Who owns what. Every API, product and subscription belongs to exactly one application.",
    scope: "global",
    nav: { group: "Administration", label: "Applications" },
    adminOnly: true,
    plainChrome: true,
  },
  {
    id: "application",
    patterns: ["/applications/:applicationId"],
    title: "Application",
    purpose: "One application: who is in it, how they got there, and what it owns.",
    scope: "global",
    plainChrome: true,
  },
  {
    id: "users",
    patterns: ["/users"],
    title: "People",
    purpose: "Everybody this portal knows, how they sign in, and what each of them can do.",
    scope: "global",
    nav: { group: "Administration", label: "People" },
    adminOnly: true,
    plainChrome: true,
  },
  {
    id: "user",
    patterns: ["/users/:userId"],
    title: "Account",
    purpose: "One account: how they sign in, which applications they are in, and where they are signed in.",
    scope: "global",
    plainChrome: true,
  },
  {
    id: "telemetry",
    environmentScoped: true,
    patterns: ["/telemetry"],
    title: "Telemetry",
    purpose: "Calls per minute across the estate: served, refused by the gateway, and failed upstream.",
    scope: "global",
    nav: { group: "Administration", label: "Telemetry" },
    adminOnly: true,
    plainChrome: true,
  },
  {
    id: "global-policy",
    environmentScoped: true,
    patterns: ["/policy"],
    title: "Global policy",
    purpose: "Policy units attached to a whole environment, and the APIs that override them.",
    scope: "global",
    nav: { group: "Administration", label: "Global policy" },
    adminOnly: true,
    plainChrome: true,
  },
  {
    id: "trust",
    environmentScoped: true,
    patterns: ["/trust"],
    title: "Trust",
    purpose:
      "The certificate authorities each environment's gateways trust, the identities they present, and every exception that is still open.",
    scope: "global",
    nav: { group: "Administration", label: "Trust" },
    adminOnly: true,
    plainChrome: true,
  },
  {
    id: "audit",
    patterns: ["/audit"],
    title: "Audit",
    purpose: "Who changed what, when, and what happened as a result.",
    scope: "global",
    nav: { group: "Administration", label: "Audit" },
    adminOnly: true,
    plainChrome: true,
  },
];

export const NOT_FOUND: RouteDef = {
  id: "not-found",
  patterns: ["/404"],
  title: "Not found",
  purpose: "That address does not match anything in the portal.",
  scope: "global",
  plainChrome: true,
};

export interface Match {
  route: RouteDef;
  params: Record<string, string>;
  /** The application the address named, when it named one the reader is allowed to open. */
  applicationId: string | null;
  /**
   * The first segment after the application, or `dashboard` for none. What the sidebar highlights:
   * the workspace for an API opens under APIs, and the same workspace reached from the catalog
   * opens under Catalog, because that is where the reader came from.
   */
  section: string;
}

/** `[pattern, route]`, longest literal prefix first, so `/apis/new` beats `/apis/:resourceId`. */
const ORDERED: Array<[string[], RouteDef]> = ROUTES.flatMap((route) =>
  route.patterns.map((pattern) => [split(pattern), route] as [string[], RouteDef]),
).sort(([a], [b]) => literalScore(b) - literalScore(a));

function literalScore(segments: string[]): number {
  return segments.reduce((score, segment) => score + (segment.startsWith(":") ? 1 : 10), 0);
}

function split(path: string): string[] {
  return path.split("?")[0]!.split("/").filter(Boolean);
}

/**
 * Which screen an address is asking for.
 *
 * Two shapes reach here and both are legitimate. `/:applicationId/apis/:resourceId` is what the
 * sidebar writes. `/apis/:resourceId` is what everything written before the shell became
 * application-scoped writes — an attention row, the "Used by" link on a certificate, a colleague's
 * bookmark. The application prefix is stripped when the first segment names one, and what is left
 * is matched the same way either way, so neither shape can quietly resolve to a different screen
 * than the other.
 */
export function matchRoute(path: string, applications: ReadonlyArray<{ id: string }> = []): Match {
  const parts = split(path);
  const named = applications.find((application) => application.id === parts[0]) ?? null;
  const rest = named ? parts.slice(1) : parts;

  for (const [pattern, route] of ORDERED) {
    if (pattern.length !== rest.length) continue;
    const params: Record<string, string> = {};
    let ok = true;
    for (let i = 0; i < pattern.length; i++) {
      const expected = pattern[i]!;
      const actual = rest[i]!;
      if (expected.startsWith(":")) params[expected.slice(1)] = decodeURIComponent(actual);
      else if (expected !== actual) {
        ok = false;
        break;
      }
    }
    if (ok) return { route, params, applicationId: named?.id ?? null, section: rest[0] ?? "dashboard" };
  }
  return { route: NOT_FOUND, params: {}, applicationId: named?.id ?? null, section: rest[0] ?? "dashboard" };
}

/** The canonical address of a screen — the first pattern, which is the one the sidebar writes. */
export function addressOf(route: RouteDef, applicationId?: string | null): string {
  const canonical = route.patterns[0]!;
  return route.scope === "application" && applicationId
    ? `/${applicationId}${canonical === "/" ? "/dashboard" : canonical}`
    : canonical;
}

/**
 * Where the application picker lands you, so that switching applications while comparing two of
 * them does not throw the reader back to a dashboard every time.
 *
 *  - a list that belongs to an application — APIs, Products, Mail — is the same list under the new
 *    one, so it stays open;
 *  - a screen that is the same for everybody — Trust, the catalog, your account — is not about the
 *    application at all, so the address does not move;
 *  - one *object* — an API's workspace, one subscription — belongs to the application that was
 *    selected, and there is nothing to carry across, so the new application's dashboard is the
 *    honest answer rather than an id that will not resolve.
 */
export function switchApplication(route: RouteDef, path: string, next: string): string {
  if (route.scope !== "application") return path;
  return route.patterns[0]!.includes("/:") ? `/${next}/dashboard` : addressOf(route, next);
}

/** The screens a caller of this authority may be offered a link to. */
export function navigable(isAdmin: boolean): RouteDef[] {
  return ROUTES.filter((route) => route.nav && (!route.adminOnly || isAdmin));
}

/**
 * The sidebar, as data: the groups in order, each with the routes it holds. The shell draws this
 * and adds nothing to it, so a screen leaves the navigation by losing its `nav` and in no other
 * way — there is no second list to forget.
 */
export function navigation(isAdmin: boolean): Array<{ title: string | null; routes: RouteDef[] }> {
  return NAV_GROUPS.map(({ group, title }) => ({
    title,
    routes: navigable(isAdmin).filter((route) => route.nav!.group === group),
  })).filter((entry) => entry.routes.length > 0);
}
