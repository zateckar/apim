import { useEffect, useState } from "react";
import { Screen, type Session } from "../App";
import { api } from "../api";
import { useAsync, go } from "../components";
import { matchRoute } from "../lib/routes";
import { listAll } from "./client";
import * as I from "./icons";
import {
  Panel,
  ErrorNotice,
  useWork,
  useTicker,
  OperationList,
} from "./common";
import { Publish, Editor } from "./apis";
import { Catalog } from "./catalog";
import { Dashboard } from "./dashboard";
import { Subscriptions, Approvals, Integrations, Kafka } from "./processes";
import { Mailbox, NotificationsBell } from "./notifications";
import { ApplicationPicker } from "./components/ApplicationPicker";
import { ProductsView } from "../views/ProductsView";
import { TrustView } from "../views/TrustView";
import { GatewayView } from "../views/GatewayView";
import { HealthView } from "../views/HealthView";
import { GatewayAdminView } from "../views/GatewayAdminView";

/**
 * The sidebar, in three parts: the tabs that belong to the selected application, and the two
 * groups that do not. Every entry outside the application groups is a route in `lib/routes.ts`,
 * and `portal.test.tsx` fails when a navigable route stops being listed here — a screen leaves the
 * shell deliberately or not at all.
 */
export const APPLICATION_NAV = [
  {
    label: "API",
    items: [
      ["apis", "APIs"],
      ["mcp", "MCP Servers"],
      ["a2a", "A2A Agents"],
      ["products", "Products"],
      ["subscriptions", "Subscriptions"],
      ["approvals", "Approvals"],
    ],
  },
  {
    label: "Kafka",
    items: [
      ["kafka", "Kafka Topics"],
      ["kafka-proxy", "Kafka REST Proxy"],
    ],
  },
  {
    label: "Other",
    items: [
      ["certificates", "Certificates"],
      // Not "Integrations", which read as a development slug for the thing this portal *is*.
      // This screen is the console for the surrounding systems — LeanIX, the directory, FixMe —
      // every one of which is simulated in this phase, which the chrome already says.
      ["integrations", "External systems"],
      // The bell's headlines are a summary; this is the message. Navigable in its own right
      // because "what was that mail about" is a question people arrive with, not one they only
      // ever reach by opening a popover first.
      ["mail", "Mail"],
      ["activity", "Activity"],
    ],
  },
] as const;
export const GLOBAL_NAV = [
  ["discover", "Catalog"],
  ["fixme", "FixMe diagnostics"],
  ["how", "How this works"],
  ["account", "Your account"],
] as const;
export const ADMIN_NAV = [
  ["fleet", "Health Status"],
  ["gateways", "Gateways"],
  ["applications", "Applications"],
  ["users", "People"],
  ["telemetry", "Telemetry"],
  ["policy", "Global policy"],
  ["trust", "Trust"],
  ["audit", "Audit"],
] as const;

/** The sections whose third segment names an API rather than a tab. */
const RESOURCE_SECTIONS = ["apis", "mcp", "a2a", "discover"];

/**
 * Which application, which section and which API an address is asking for.
 *
 * Two shapes reach here. `/:applicationId/apis/:resourceId` is what the shell writes. `/apis/:id`
 * is what everything written before the shell became application-scoped writes — the route table,
 * the "Used by" links on a certificate, an attention row, a colleague's bookmark. Resolving only
 * the first shape left the second rendering the *list* of APIs with the id silently dropped, which
 * looks like the link worked and did not.
 */
export function parsePath(
  path: string,
  applications: Array<{ id: string }>,
): { applicationId: string | null; section: string; resourceId: string | null } {
  const parts = path.split("?")[0]!.split("/").filter(Boolean);
  const known = applications.find((a) => a.id === parts[0]);
  if (known)
    return {
      applicationId: known.id,
      section: parts[1] ?? "dashboard",
      resourceId: parts[2] && parts[2] !== "publish" ? parts[2] : null,
    };
  const section = parts[0] ?? "dashboard";
  return {
    applicationId: null,
    section,
    // `/apis/new` is the publish route, not an API called "new".
    resourceId:
      RESOURCE_SECTIONS.includes(section) && parts[1] && parts[1] !== "new"
        ? parts[1]
        : null,
  };
}

const titles: Record<string, string> = {
  dashboard: "Dashboard",
  apis: "APIs",
  products: "Products",
  subscriptions: "Subscriptions",
  mcp: "MCP Servers",
  a2a: "A2A Agents",
  kafka: "Kafka Topics",
  "kafka-proxy": "Kafka REST Proxy",
  certificates: "Certificates",
  approvals: "Approvals",
  integrations: "External systems",
  mail: "Mail",
  activity: "Activity",
  publish: "Publish an API",
  discover: "Catalog",
  // `/fleet` is the address in the route table and in every attention row; `/health` is what the
  // shell used to link. Both resolve here, because a bookmark is not a reason to lose a screen.
  fleet: "Health Status",
  health: "Health Status",
  gateways: "Gateways",
  fixme: "FixMe diagnostics",
};
export function Portal({
  session: s,
  path,
}: {
  session: Session;
  path: string;
}) {
  const parts = path.split("/").filter(Boolean);
  const { applicationId: named, section, resourceId } = parsePath(
    path,
    s.applications,
  );
  const authorized =
    named !== null && (s.user.isAdmin || s.user.applications.includes(named));
  const applicationId = authorized ? named : s.application,
    effective = { ...s, application: applicationId };
  useEffect(() => {
    if (authorized && named !== s.application) s.setApplication(named!);
  }, [named]);
  const tick = useTicker();
  const operations = useAsync(
    () =>
      api.get<{ items: any[] }>(
        `/api/operations?applicationId=${encodeURIComponent(applicationId)}`,
      ),
    [applicationId, tick],
  );
  const [theme, setTheme] = useState(
    () => localStorage.getItem("portal-theme") ?? "light",
  );
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("portal-theme", theme);
  }, [theme]);
  const [navOpen, setNavOpen] = useState(false);
  const title = resourceId
    ? "API workspace"
    : (titles[section] ?? matchRoute(path).route.title);
  const link = (tab: string) => `/${applicationId}/${tab}`;
  const active = (operations.data?.items ?? []).filter(
    (o) => !["complete", "superseded"].includes(o.state),
  );
  const signout = useWork();
  function nav(tab: string, label: string, url: string) {
    return (
      <a
        key={tab}
        className={`nav-item ${section === tab ? "active" : ""}`}
        href={url}
        onClick={(e) => {
          e.preventDefault();
          setNavOpen(false);
          go(url);
        }}
      >
        <I.Api />
        {label}
      </a>
    );
  }
  return (
    <div className={`native-portal ${navOpen ? "nav-open" : ""}`}>
      <aside className="sidebar">
        <div className="brand">
          <div className="logo">
            <I.Api size={22} />
          </div>
          <div className="name">Integration Portal</div>
        </div>
        <ApplicationPicker
          applications={s.applications.filter(
            (a) => s.user.isAdmin || s.user.applications.includes(a.id),
          )}
          value={applicationId}
          onChange={(next) => {
            s.setApplication(next);
            localStorage.setItem("portal-application", next);
            // The same tab under the new application, so switching applications while comparing
            // two of them does not throw the reader back to a dashboard every time.
            go(`/${next}/${section in titles ? section : "dashboard"}`);
          }}
        />
        <nav aria-label="Application navigation">
          {nav("dashboard", "Dashboard", link("dashboard"))}
          {APPLICATION_NAV.map((group) => (
            <div className="nav-section" key={group.label}>
              <div className="nav-group-title">{group.label}</div>
              {group.items.map(([tab, label]) => nav(tab, label, link(tab)))}
            </div>
          ))}
          <div className="nav-section">
            <div className="nav-group-title">Global</div>
            {GLOBAL_NAV.map(([tab, label]) => nav(tab, label, `/${tab}`))}
          </div>
          {s.user.isAdmin && (
            <div className="nav-section">
              <div className="nav-group-title">Administration</div>
              {ADMIN_NAV.map(([tab, label]) => nav(tab, label, `/${tab}`))}
            </div>
          )}
        </nav>
        <div className="user">
          <div className="info">
            <strong>{s.user.name}</strong>
            <small>{s.user.isAdmin ? "Administrator" : "Developer"}</small>
          </div>
          <button
            className="btn sm"
            disabled={signout.busy}
            onClick={() =>
              void signout.run(async () => {
                const r = await api.post<{ endSessionUrl?: string }>(
                  "/api/auth/logout",
                );
                if (r.endSessionUrl) location.href = r.endSessionUrl;
                else s.reload();
              })
            }
          >
            Sign out
          </button>
        </div>
        <ErrorNotice error={signout.error} />
      </aside>
      <div className="native-main">
        <header className="topbar">
          <button
            className="btn sm mobile-menu"
            aria-label="Toggle navigation"
            onClick={() => setNavOpen(!navOpen)}
          >
            ☰
          </button>
          <div className="breadcrumbs">
            <span>{s.applicationName(applicationId)}</span>
            <span>/</span>
            <strong>{title}</strong>
          </div>
          <div className="native-actions">
            <span className="chip neutral">Integrations simulated</span>
            <button
              className="btn sm"
              aria-label="Toggle theme"
              onClick={() => setTheme(theme === "light" ? "dark" : "light")}
            >
              {theme === "light" ? "Dark" : "Light"}
            </button>
            {/* Deployments in flight, which is a different question from "what happened that I
                have not seen" — that one is the bell's, and it counts unread rather than active. */}
            <button
              className="btn sm"
              aria-label={`${active.length} changes in progress`}
              onClick={() => go(link("activity"))}
            >
              <I.Activity /> {active.length}
            </button>
            <NotificationsBell applicationId={applicationId} tick={tick} />
          </div>
        </header>
        <main className="native-content">
          <div className="native-page-head">
            <div>
              <div className="eyebrow">{s.applicationName(applicationId)}</div>
              <h1>{title}</h1>
            </div>
            <div className="native-actions">
              <div className="seg" role="group" aria-label="Environment">
                {s.meta.chain.map((environment) => (
                  <button
                    className={s.environment === environment ? "active" : ""}
                    key={environment}
                    onClick={() => s.setEnvironment(environment)}
                  >
                    {environment.toUpperCase()}
                  </button>
                ))}
              </div>
              {["apis", "mcp", "a2a", "dashboard"].includes(section) &&
                !resourceId && (
                  <button
                    className="btn primary"
                    disabled={!applicationId}
                    onClick={() =>
                      go(
                        link("publish") +
                          (section === "mcp" || section === "a2a"
                            ? `?kind=${section}`
                            : ""),
                      )
                    }
                  >
                    <I.Plus />
                    Publish API
                  </button>
                )}
            </div>
          </div>
          <ErrorNotice error={operations.error} />
          {resourceId ? (
            <Editor
              key={`${resourceId}:${s.environment}`}
              id={resourceId}
              session={effective}
              operations={operations.data?.items ?? []}
              // The live ticker, not the operation *count*: a subscription moving from `revoking`
              // to `revoked` adds no operation, so the workspace's subscriptions tab sat on a
              // transient state until a full reload (finding 6).
              tick={tick}
            />
          ) : section === "publish" || parts[2] === "publish" ? (
            <Publish session={effective} />
          ) : ["apis", "mcp", "a2a", "discover"].includes(section) ? (
            <Catalog session={effective} section={section} tick={tick} />
          ) : section === "dashboard" ? (
            <Dashboard
              session={effective}
              operations={operations.data?.items ?? []}
              tick={tick}
            />
          ) : section === "subscriptions" ? (
            <Subscriptions session={effective} tick={tick} />
          ) : section === "approvals" ? (
            <Approvals session={effective} tick={tick} />
          ) : section === "products" ? (
            <div className="native-legacy">
              <ProductsView key={applicationId} session={effective} />
            </div>
          ) : section === "certificates" ? (
            <div className="native-legacy">
              <TrustView
                key={applicationId}
                applicationId={applicationId}
                meta={s.meta}
                user={s.user}
                environment={s.environment}
              />
            </div>
          ) : section === "kafka" || section === "kafka-proxy" ? (
            <Kafka
              session={effective}
              tick={tick}
              proxyOnly={section === "kafka-proxy"}
            />
          ) : section === "integrations" || section === "fixme" ? (
            <Integrations
              session={effective}
              tick={tick}
              fixme={section === "fixme"}
            />
          ) : section === "mail" ? (
            <Mailbox session={effective} tick={tick} />
          ) : section === "activity" ? (
            <Panel title="Changes and deployment progress">
              <OperationList items={operations.data?.items ?? []} />
            </Panel>
          ) : section === "health" || section === "fleet" ? (
            <div className="native-legacy">
              {/* Open to everybody. Which environment is healthy is what decides whether a
                  publisher promotes this afternoon, and a screen only admins could read made
                  them ask in chat. The convergence detail below it stays admin-only. */}
              <HealthView user={s.user} />
              {s.user.isAdmin && <GatewayView user={s.user} meta={s.meta} />}
            </div>
          ) : section === "gateways" ? (
            <div className="native-legacy">
              {s.user.isAdmin ? (
                <GatewayAdminView />
              ) : (
                <Panel title="Gateways">
                  <p>
                    Adding a gateway, publishing its hostname and minting a
                    replica's token are administrator actions. What each gateway
                    is currently serving is on Health Status, which is open to
                    everybody.
                  </p>
                </Panel>
              )}
            </div>
          ) : (
            <div className="native-legacy">
              <Screen match={matchRoute(path)} session={effective} />
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
