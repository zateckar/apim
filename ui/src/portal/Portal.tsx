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
import { Publish, Editor, Workspace } from "./apis";
import { Subscriptions, Approvals, Integrations, Kafka } from "./processes";
import { ProductsView } from "../views/ProductsView";
import { TrustView } from "../views/TrustView";
import { GatewayView } from "../views/GatewayView";

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
      ["integrations", "Integrations"],
      ["activity", "Activity"],
    ],
  },
] as const;
export const GLOBAL_NAV = [
  ["discover", "Catalog"],
  ["health", "Health Status"],
  ["fixme", "FixMe"],
  ["how", "How this works"],
  ["account", "Your account"],
] as const;
export const ADMIN_NAV = [
  ["applications", "Applications"],
  ["users", "People"],
  ["telemetry", "Telemetry"],
  ["policy", "Global policy"],
  ["trust", "Trust"],
  ["audit", "Audit"],
] as const;

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
  integrations: "Integrations",
  activity: "Activity",
  publish: "Publish an API",
  discover: "Catalog",
  health: "Health Status",
  fixme: "FixMe",
};
export function Portal({
  session: s,
  path,
}: {
  session: Session;
  path: string;
}) {
  const parts = path.split("/").filter(Boolean),
    known = s.applications.find((a) => a.id === parts[0]);
  const section = known ? (parts[1] ?? "dashboard") : (parts[0] ?? "dashboard");
  const resourceId =
    known && parts[2] && parts[2] !== "publish" ? parts[2] : null;
  const authorized =
    known && (s.user.isAdmin || s.user.applications.includes(known.id));
  const applicationId = authorized ? known.id : s.application,
    effective = { ...s, application: applicationId };
  useEffect(() => {
    if (authorized && known.id !== s.application) s.setApplication(known.id);
  }, [known?.id]);
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
  const [navOpen, setNavOpen] = useState(false),
    [bell, setBell] = useState(false);
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
        <div className="app-picker">
          <span className="app-picker-label">APPLICATION</span>
          <select
            aria-label="Application"
            value={applicationId}
            onChange={(e) => {
              s.setApplication(e.target.value);
              localStorage.setItem("portal-application", e.target.value);
              go(
                `/${e.target.value}/${section in titles ? section : "dashboard"}`,
              );
            }}
          >
            {s.applications
              .filter(
                (a) => s.user.isAdmin || s.user.applications.includes(a.id),
              )
              .map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
          </select>
        </div>
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
            <button
              className="btn sm"
              aria-label="Notifications"
              onClick={() => setBell(!bell)}
            >
              <I.Activity /> {active.length}
            </button>
          </div>
        </header>
        {bell && (
          <div className="native-notifications">
            <Panel
              title="Recent changes"
              actions={
                <button className="btn sm" onClick={() => setBell(false)}>
                  Close
                </button>
              }
            >
              <OperationList
                items={(operations.data?.items ?? []).slice(0, 8)}
              />
            </Panel>
          </div>
        )}
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
            />
          ) : section === "publish" || parts[2] === "publish" ? (
            <Publish session={effective} />
          ) : ["apis", "mcp", "a2a", "discover"].includes(section) ? (
            <Workspace session={effective} section={section} tick={tick} />
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
          ) : section === "activity" ? (
            <Panel title="Changes and deployment progress">
              <OperationList items={operations.data?.items ?? []} />
            </Panel>
          ) : section === "health" ? (
            <div className="native-legacy">
              <GatewayView user={s.user} meta={s.meta} />
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
function Dashboard({
  session: s,
  operations,
  tick,
}: {
  session: Session;
  operations: any[];
  tick: number;
}) {
  const resources = useAsync(
    () => listAll(`/api/resources?application=${s.application}`),
    [s.application, tick],
  );
  const subs = useAsync(
    () => api.get<{ items: any[] }>("/api/subscriptions"),
    [s.application, tick],
  );
  return (
    <>
      <div className="native-stats">
        {[
          ["Published APIs", resources.data?.items.length ?? 0],
          [
            "Subscriptions",
            subs.data?.items.filter((x) => x.applicationId === s.application)
              .length ?? 0,
          ],
          [
            "Changes in progress",
            operations.filter(
              (x) => !["complete", "superseded"].includes(x.state),
            ).length,
          ],
        ].map(([label, count]) => (
          <div className="card native-stat" key={label}>
            <span>{label}</span>
            <strong>{count}</strong>
          </div>
        ))}
      </div>
      <ErrorNotice error={resources.error ?? subs.error} />
      <Panel title="Recent activity">
        <OperationList items={operations.slice(0, 8)} />
      </Panel>
      <Panel title="Your application">
        <p>
          Publish APIs, share them through products, and request access to other
          applications. Changes are applied automatically across your gateways.
        </p>
        <button
          className="btn"
          onClick={() => go(`/${s.application}/integrations`)}
        >
          Application metadata and contacts
        </button>
      </Panel>
    </>
  );
}
