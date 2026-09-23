import { Fragment, useEffect, useRef, useState } from "react";
import type { Session } from "../App";
import { api } from "../api";
import {
  LeaveDialog,
  Link,
  Notice,
  PageTitleProvider,
  Segmented,
  envLabel,
  go,
  useAction,
  useAsync,
  useTicker,
  whenLeaving,
} from "../components";
import { addressOf, matchRoute, navigation, parentOf, switchApplication, type RouteDef } from "../lib/routes";
import { screenFor } from "../screens";
import * as I from "./icons";
import { NotificationsBell } from "./notifications";
import { ApplicationPicker } from "./components/ApplicationPicker";
import { ChangeLog } from "./components/ChangeLog";
import { portalVersion } from "../lib/changelog";

/**
 * The frame around every screen, and nothing else.
 *
 * The shell used to route as well as draw: its own path parser, its own map of titles, its own list
 * of sidebar entries and a ternary ladder choosing the component. All four have moved into
 * `lib/routes.ts` and `screens.tsx`, because four lists that had to agree is four lists that could
 * disagree — and did. What is left here is the chrome: which application, which environment, what
 * is in flight, what changed since you were last here, and where the one screen goes.
 */
export function Portal({ session: s, path }: { session: Session; path: string }) {
  const match = matchRoute(path, s.applications);
  const { route, section, applicationId: named } = match;

  // An address may name an application the reader is not in. The picker's selection stands in then,
  // rather than the screen rendering somebody else's estate — the control plane would refuse it
  // anyway, and a 403 is a worse answer than the application you were already looking at.
  const authorized = named !== null && (s.user.isAdmin || s.user.applications.includes(named));
  const applicationId = authorized ? named : s.application;
  const effective: Session = { ...s, application: applicationId };

  useEffect(() => {
    if (authorized && named !== s.application) {
      s.setApplication(named!);
      localStorage.setItem("portal-application", named!);
    }
  }, [named]);

  // The one clock, and what decides how fast it runs. A change still reaching the gateways is worth
  // watching every few seconds; an estate with nothing in flight is not, and the shell's tick is the
  // dependency almost every screen's query hangs off (see `useTicker`).
  const [converging, setConverging] = useState(false);
  const tick = useTicker(converging);
  const operations = useAsync(
    () =>
      api.get<{ items: any[] }>(
        `/api/operations?applicationId=${encodeURIComponent(applicationId)}`,
      ),
    [applicationId, tick],
    applicationId,
  );
  /**
   * Which environments the resource on screen is actually in.
   *
   * The switcher is the shell's, so the shell asks — one read keyed by the resource, not by the
   * environment, so switching stage does not re-shape the control doing the switching. `tick`
   * refreshes it, which is how a stage a promotion has just reached becomes selectable without a
   * reload. Every other screen answers `null`, and `null` means "offer the whole chain".
   */
  const resourceId = route.id === "api" ? (match.params.resourceId ?? null) : null;
  const reach = useAsync(
    () =>
      resourceId
        ? api.get<{ environments: string[] }>(
            `/api/resources/${encodeURIComponent(resourceId)}/environments`,
          )
        : Promise.resolve(null),
    [resourceId, tick],
    resourceId ?? "",
  );
  const reachable = reach.data?.environments ?? null;
  const [theme, setTheme] = useState(() => localStorage.getItem("portal-theme") ?? "light");
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("portal-theme", theme);
  }, [theme]);
  const [navOpen, setNavOpen] = useState(false);
  const [changes, setChanges] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  const sidebar = useRef<HTMLElement>(null);
  // The object a detail screen is about, once it has loaded it (see `usePageTitle`).
  const [objectTitle, setObjectTitle] = useState<string | null>(null);
  const title = objectTitle ?? route.title;
  const parent = parentOf(match, applicationId);
  useEffect(() => {
    document.title = `${title} · Integration Portal`;
  }, [title]);
  useEffect(() => setNavOpen(false), [path]);
  useEffect(() => {
    if (!navOpen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    sidebar.current?.querySelector<HTMLElement>("button, a")?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") { setNavOpen(false); menuButton.current?.focus(); }
      if (event.key !== "Tab") return;
      const controls = Array.from(sidebar.current?.querySelectorAll<HTMLElement>("a[href], button:not(:disabled), input") ?? []);
      const first = controls[0], last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener("keydown", onKey);
    return () => { document.body.style.overflow = previousOverflow; document.removeEventListener("keydown", onKey); };
  }, [navOpen]);

  const items = operations.data?.items ?? [];
  const active = items.filter((o) => !["complete", "superseded"].includes(o.state));
  useEffect(() => setConverging(active.length > 0), [active.length]);
  const signout = useAction();

  /** A sidebar entry. Highlighted by section, so an API's workspace lights up the list it came from. */
  function navItem(entry: RouteDef) {
    const url = addressOf(entry, applicationId);
    const Icon = I[entry.nav!.icon];
    const first = entry.patterns[0]!.split("/").filter(Boolean)[0] ?? "dashboard";
    return (
      <a
        key={entry.id}
        className={`nav-item ${section === first ? "active" : ""}`}
        href={url}
        aria-current={section === first ? "page" : undefined}
        onClick={(event) => {
          if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
          event.preventDefault();
          setNavOpen(false);
          go(url);
        }}
      >
        <span className="nav-icon" aria-hidden="true"><Icon size={18} /></span>
        {entry.nav!.label}
      </a>
    );
  }

  return (
    <div className={`native-portal ${navOpen ? "nav-open" : ""}`}>
      <a className="skip-link" href="#main-content">Skip to content</a>
      {navOpen && <button className="nav-backdrop" aria-label="Close navigation" onClick={() => { setNavOpen(false); menuButton.current?.focus(); }} />}
      <aside className="sidebar" id="portal-navigation" ref={sidebar}>
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
          onChange={(next) =>
            whenLeaving(() => {
              s.setApplication(next);
              localStorage.setItem("portal-application", next);
              go(switchApplication(route, path, next));
            })
          }
        />
        <nav aria-label="Application navigation">
          {navigation(s.user.isAdmin).map((group, index) => (
            <div className="nav-section" key={group.title ?? `group-${index}`}>
              {group.title && <div className="nav-group-title">{group.title}</div>}
              {group.routes.map(navItem)}
            </div>
          ))}
        </nav>
        <div className="user">
          {/* The name is the way to your account, as it is in every other product; the sidebar
              entry that used to sit above it was the same link twice. "Member", not "Developer":
              membership of an application is what the authorization rule actually turns on. */}
          <Link to="/account" className="info" ariaLabel={`Your account — ${s.user.name}`}>
            <strong>{s.user.name}</strong>
            <small>{s.user.isAdmin ? "Administrator" : "Member"}</small>
          </Link>
          <button
            className="btn sm"
            disabled={signout.busy}
            onClick={() =>
              void signout.run(async () => {
                const r = await api.post<{ endSessionUrl?: string }>("/api/auth/logout");
                if (r.endSessionUrl) location.href = r.endSessionUrl;
                else s.reload();
              })
            }
          >
            Sign out
          </button>
        </div>
        <Notice kind="error">{signout.error}</Notice>
      </aside>
      <div className="native-main">
        <header className="topbar">
          <button
            className="btn sm mobile-menu"
            ref={menuButton}
            aria-label="Toggle navigation"
            aria-expanded={navOpen}
            aria-controls="portal-navigation"
            onClick={() => setNavOpen(!navOpen)}
          >
            <I.Menu />
          </button>
          {/* No breadcrumb here. It said "<application> / <title>", which the picker and the page
              head were already saying a few centimetres away — three copies of the application
              name on every screen, and a title drawn twice. The page head's trail is the one place
              that says where this screen hangs. */}
          <span className="topbar-spacer" />
          <div className="native-actions">
            <span
              className="chip neutral"
              title="Kafka, SkoNET, email, the directory, FixMe and LeanIX are simulated in this phase. What they return is recorded, and nothing outside the portal is changed."
            >
              External systems simulated
            </span>
            {/* The version is a button because it answers a question: what changed since the last
                time I was here. A chip that only states a number leaves that question unanswered
                and the answer in a file nobody using the portal can open. */}
            <button
              className="btn ghost sm topbar-version"
              aria-label={`Portal version ${portalVersion()} — what changed`}
              onClick={() => setChanges(true)}
            >
              v{portalVersion()}
            </button>
            <button
              className="btn ghost sm icon-only"
              aria-label={`Switch to ${theme === "light" ? "dark" : "light"} theme`}
              title={`Switch to ${theme === "light" ? "dark" : "light"} theme`}
              onClick={() => setTheme(theme === "light" ? "dark" : "light")}
            >
              {theme === "light" ? <I.Moon /> : <I.Sun />}
            </button>
            {/* Deployments in flight, which is a different question from "what happened that I
                have not seen" — that one is the bell's, and it counts unread rather than active.
                A link, because it goes somewhere; and absent at zero, because a permanent "0"
                beside the bell read as a second, broken notification count. */}
            {active.length > 0 && (
              <Link to={`/${applicationId}/activity`} className="btn ghost sm has-activity">
                <I.Activity /> {active.length === 1 ? "1 change rolling out" : `${active.length} changes rolling out`}
              </Link>
            )}
            <NotificationsBell key={applicationId} applicationId={applicationId} tick={tick} />
          </div>
        </header>
        {changes && <ChangeLog close={() => setChanges(false)} />}
        <LeaveDialog />
        <main className="native-content" id="main-content" tabIndex={-1}>
          <div className="native-page-head">
            <div>
              {/* The trail: one link back to the list a detail screen was opened from. A list
                  screen has none — the sidebar already says where it is. */}
              {parent && (
                <nav className="page-trail" aria-label="Breadcrumb">
                  <Link to={parent.address}>
                    <I.ChevLeft size={14} /> {parent.route.title}
                  </Link>
                </nav>
              )}
              <h1>{title}</h1>
              {/* Every screen has a one-line purpose, and it comes from the same table as the
                  title — so a screen cannot be added without one. */}
              <p className="native-page-purpose">{route.purpose}</p>
            </div>
            <div className="native-actions">
              {route.environmentScoped && (
                <Segmented
                  label="Environment"
                  value={s.environment}
                  onChange={(next) => whenLeaving(() => s.setEnvironment(next))}
                  options={s.meta.chain.map((environment) => {
                    // Disabled with the reason, never hidden: a chain drawn short would misstate
                    // how many stages the estate has. Unknown — no resource on screen, or the read
                    // has not landed — offers everything, because a switcher that greys out while
                    // a request is in flight is worse than one that occasionally offers a stage
                    // the screen then explains it is not in. The selected stage always stays
                    // operable, so arriving at one the API is not in is never a dead control.
                    const absent =
                      reachable !== null &&
                      environment !== s.environment &&
                      !reachable.includes(environment);
                    return {
                      value: environment,
                      label: envLabel(environment),
                      disabled: absent,
                      reason: absent
                        ? `Not in ${envLabel(environment)} yet — promote it there from the stage before.`
                        : undefined,
                    };
                  })}
                />
              )}
              {["apis", "mcp", "a2a", "dashboard"].includes(section) && route.id !== "api" && applicationId && (
                <Link
                  className="btn primary"
                  to={
                    `/${applicationId}/publish` +
                    (section === "mcp" || section === "a2a" ? `?kind=${section}` : "")
                  }
                >
                  <I.Plus />
                  {/* The link already carries the section into the wizard as `?kind=`; saying
                      "Publish API" while doing so put the wrong noun on two of the three screens
                      it appears on. The dashboard is the general case and keeps the general word. */}
                  {section === "mcp"
                    ? "Publish MCP server"
                    : section === "a2a"
                      ? "Publish A2A agent"
                      : "Publish API"}
                </Link>
              )}
            </div>
          </div>
          {/* Where the read of which stages this API is in failed. It degrades to the safe answer —
              every stage offered — so this is a line, not a banner. */}
          {reach.error && (
            <p className="hint">Every stage is offered: which ones this API is in could not be read — {reach.error}</p>
          )}
          <Notice kind="error">{operations.error}</Notice>
          {/* Screens written before this shell bring no table styling of their own; `.native-legacy`
              lends them the estate's. Which ones need it is declared in the route table. */}
          <PageTitleProvider value={setObjectTitle}>
            <Fragment key={`${path}:${applicationId}:${route.environmentScoped ? s.environment : ""}`}>
            {route.plainChrome ? (
              <div className="native-legacy">
                {screenFor({ match, session: effective, operations: items, operationsLoading: operations.loading && !operations.data, tick })}
              </div>
            ) : (
              screenFor({ match, session: effective, operations: items, operationsLoading: operations.loading && !operations.data, tick })
            )}
            </Fragment>
          </PageTitleProvider>
        </main>
      </div>
    </div>
  );
}
