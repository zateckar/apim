import { useState } from "react";
import { api, type AuthProviders, type Me, type Meta, type User } from "./api";
import { Card, Link, Notice, Term, useAsync, usePath } from "./components";
import { matchRoute, navigation, type Match } from "./lib/routes";
import { AccountView } from "./views/AccountView";
import { ForcedPasswordChange, LoginView } from "./views/LoginView";
import { TeamsView, TeamView } from "./views/TeamsView";
import { UsersView, UserView } from "./views/UsersView";
import { HomeView } from "./views/HomeView";
import { HowView } from "./views/HowView";
import { ApisView } from "./views/ApisView";
import { ApiDetailView } from "./views/ApiDetailView";
import { GatewayView } from "./views/GatewayView";
import { GlobalPolicyView } from "./views/GlobalPolicyView";
import { MarketListing } from "./views/MarketListing";
import { MarketView } from "./views/MarketView";
import { ProductsView } from "./views/ProductsView";
import { PublishWizard } from "./views/PublishWizard";
import { SubscribeWizard } from "./views/SubscribeWizard";
import { SubscriptionsView, SubscriptionView } from "./views/SubscriptionsView";
import { TelemetryView } from "./views/TelemetryView";
import { TrustView } from "./views/TrustView";
import { AuditView } from "./views/AuditView";

export interface Team {
  id: string;
  name: string;
  mine: boolean;
}

/**
 * What every screen is given (plan §9.1). Two pieces of it are *context* rather than data:
 *
 *  - `team` — which team a create action belongs to, and what "mine" means in a list. A user in one
 *    team never sees a menu, only a label, because there is no choice to make.
 *  - `environment` — the stage of the chain being shown. One global switcher, because policies,
 *    routes, backends and subscriptions are all per environment and a screen that showed two at
 *    once would have to say which one each control writes to.
 */
export interface Session {
  user: User;
  meta: Meta;
  teams: Team[];
  team: string;
  setTeam: (next: string) => void;
  teamName: (id: string) => string;
  environment: string;
  setEnvironment: (next: string) => void;
  /** Re-reads the signed-in user; the sign-out button and the sign-in forms all use it. */
  reload: () => void;
  /** The whole of `/api/me`, for the screens that are about the caller rather than about an API. */
  me: Me;
}

/**
 * The boot order matters, and this is the one place it is decided `[P1-14]`.
 *
 * `/api/me` first, alone. Until it has answered, nothing else may be asked: an anonymous caller
 * gets a 401 from `/api/meta`, and — more subtly — a caller who has to change their password gets
 * a 403 from *everything except* three paths. Fetching the chain and the team list up front would
 * turn "choose a password" into "the portal could not reach its own API".
 */
export function App() {
  const path = usePath();
  const me = useAsync(() => api.get<Me>("/api/me"), []);

  const signedIn = Boolean(me.data?.user);
  const mustChangePassword = Boolean(me.data?.mustChangePassword);
  const ready = signedIn && !mustChangePassword;

  const meta = useAsync(() => (ready ? api.get<Meta>("/api/meta") : Promise.resolve(null)), [ready]);
  const teams = useAsync(
    () => (ready ? api.get<{ items: Team[] }>("/api/teams") : Promise.resolve(null)),
    [ready, me.data?.user?.id],
  );
  const [environment, setEnvironment] = useState<string | null>(null);
  const [team, setTeam] = useState<string | null>(null);

  if (me.loading) return <div className="main">Loading…</div>;
  if (me.error) {
    return (
      <div className="main">
        <Notice kind="error">{me.error}</Notice>
        <p className="muted">
          The portal could not reach its own API. Reload once the control plane is answering.
        </p>
      </div>
    );
  }
  if (!signedIn) return <LoginView onSignedIn={me.reload} />;
  if (mustChangePassword) return <PasswordGate onChanged={me.reload} />;

  if (meta.loading) return <div className="main">Loading…</div>;
  if (meta.error || !meta.data) {
    // Without `/api/meta` there is no environment chain and no kind list, so every screen below
    // would render half-built. Better to say which call failed than to look merely empty.
    return (
      <div className="main">
        <Notice kind="error">{meta.error}</Notice>
        <p className="muted">
          The portal could not reach its own API. Reload once the control plane is answering.
        </p>
      </div>
    );
  }

  const user = me.data!.user!;
  const chain = meta.data.chain;
  const known = teams.data?.items ?? [];
  const mine = user.teams.length > 0 ? user.teams : known.filter((row) => row.mine).map((row) => row.id);

  const session: Session = {
    user,
    meta: meta.data,
    teams: known,
    team: team && mine.includes(team) ? team : (mine[0] ?? ""),
    setTeam,
    teamName: (id) => known.find((row) => row.id === id)?.name ?? id,
    environment: environment && chain.includes(environment) ? environment : chain[0]!,
    setEnvironment,
    reload: me.reload,
    me: me.data!,
  };

  const match = matchRoute(path);

  return (
    <div className="layout">
      <Sidebar session={session} path={path} mine={mine} />
      <main className="main">
        {/* Which environment, and what that does and does not decide. This sentence is the single
            most common thing a newcomer gets wrong about the model (plan §9.1), so it is on the
            screen rather than in the documentation. */}
        {showsEnvironment(match) && <EnvironmentLine session={session} />}
        {/* Not fatal — the switcher falls back to the ids on the user — but a team list that
            silently failed to load looks like a team you have been removed from. */}
        <Notice kind="error">{teams.error}</Notice>
        <div className="page-head">
          <div>
            <h2>{match.route.title}</h2>
            {/* Rendered from the route table, so a screen cannot exist without a purpose. */}
            <p className="page-purpose">{match.route.purpose}</p>
          </div>
        </div>
        <Screen match={match} session={session} />
      </main>
    </div>
  );
}

/**
 * Home is the estate view — it asks "what needs attention", which is not a question about one
 * environment — and `How this works` is about the model rather than about a stage of it. Every other
 * screen is showing exactly one environment and says so.
 */
function showsEnvironment(match: Match): boolean {
  // The identity screens are about people, and people are not per environment: an account, a team
  // and a session all mean the same thing in DEV and in PROD. Showing the switcher there would
  // imply a choice that changes nothing.
  return !["home", "how", "not-found", "account", "users", "user", "teams", "team"].includes(
    match.route.id,
  );
}

/**
 * The forced change, rendered instead of the portal rather than inside it. Its own `useAsync` for
 * the minimum length, because `/api/auth/providers` is the one endpoint that answers here — every
 * other read is refused until the password is chosen.
 */
function PasswordGate({ onChanged }: { onChanged: () => void }) {
  const providers = useAsync(() => api.get<AuthProviders>("/api/auth/providers"), []);
  return (
    <>
      <Notice kind="error">{providers.error}</Notice>
      <ForcedPasswordChange
        minLength={providers.data?.passwordMinLength ?? 12}
        onChanged={onChanged}
        onSignOut={async () => {
          await api.post("/api/auth/logout");
          onChanged();
        }}
      />
    </>
  );
}

function Sidebar({ session, path, mine }: { session: Session; path: string; mine: string[] }) {
  const { user } = session;
  return (
    <aside className="sidebar">
      <h1>Integration Portal</h1>
      <div className="sub">{session.meta.chain.join(" → ")}</div>

      <TeamSwitcher session={session} mine={mine} />

      {navigation(user.isAdmin).map((group) => (
        <nav key={group.section}>
          {group.label && <div className="nav-section">{group.label}</div>}
          {group.items.map((route) => (
            <Link
              key={route.id}
              to={route.pattern}
              className={[isActive(path, route.pattern) ? "active" : "", route.adminOnly ? "admin" : ""]
                .filter(Boolean)
                .join(" ")}
            >
              {route.nav}
            </Link>
          ))}
        </nav>
      ))}

      <div className="who">
        <Link to="/account">
          <strong>{user.name}</strong>
        </Link>
        {user.isAdmin ? "administrator" : "member"}
        {user.provider === "dev" && <div className="pill warn">development sign-in</div>}
        <div style={{ marginTop: 10 }}>
          <button
            className="ghost small"
            onClick={async () => {
              // The provider's own sign-out, when the deployment asked for it: `endSessionUrl` is
              // followed here rather than in the control plane, because the local revocation has
              // already happened and this is a browser navigation.
              const result = await api
                .post<{ endSessionUrl: string | null }>("/api/auth/logout")
                .catch(() => ({ endSessionUrl: null }));
              if (result?.endSessionUrl) {
                window.location.href = result.endSessionUrl;
                return;
              }
              session.reload();
            }}
          >
            Sign out
          </button>
        </div>
      </div>
    </aside>
  );
}

/** `/apis` is active on `/apis/abc/policies`; `/` is active only on itself. */
function isActive(path: string, pattern: string): boolean {
  if (pattern === "/") return path === "/";
  return path === pattern || path.startsWith(`${pattern}/`);
}

/** One team is a label, not a menu: a control with one option is a question with one answer. */
function TeamSwitcher({ session, mine }: { session: Session; mine: string[] }) {
  if (mine.length === 0) return null;
  if (mine.length === 1) {
    return (
      <div className="teamswitch">
        <label>Team</label>
        <strong className="team-name">{session.teamName(mine[0]!)}</strong>
      </div>
    );
  }
  return (
    <div className="teamswitch">
      <label htmlFor="team-switch">Team</label>
      <select
        id="team-switch"
        value={session.team}
        onChange={(event) => session.setTeam(event.target.value)}
      >
        {mine.map((id) => (
          <option key={id} value={id}>
            {session.teamName(id)}
          </option>
        ))}
      </select>
    </div>
  );
}

function EnvironmentLine({ session }: { session: Session }) {
  return (
    <div className="envline">
      <div className="envpicker">
        {session.meta.chain.map((environment) => (
          <button
            key={environment}
            className={environment === session.environment ? "env active" : "env"}
            onClick={() => session.setEnvironment(environment)}
          >
            {environment.toUpperCase()}
          </button>
        ))}
      </div>
      <p className="says">
        You are looking at <strong>{session.environment.toUpperCase()}</strong>.{" "}
        <Term name="policy">Policies</Term>, <Term name="route">routes</Term>,{" "}
        <Term name="backend">backends</Term> and <Term name="subscription">subscriptions</Term> are
        set per <Term name="environment">environment</Term>. The API{" "}
        <Term name="definition">definition</Term> is not — it is{" "}
        <Term name="promote">promoted</Term>.
      </p>
    </div>
  );
}

function Screen({ match, session }: { match: Match; session: Session }) {
  const { user, meta } = session;
  const { params } = match;

  switch (match.route.id) {
    case "home":
      return <HomeView session={session} />;
    case "how":
      return <HowView />;

    case "catalog":
      return <MarketView user={user} meta={meta} />;
    case "listing":
      return <MarketListing resourceId={params.resourceId!} user={user} meta={meta} />;
    case "subscribe":
      return <SubscribeWizard resourceId={params.resourceId!} session={session} />;
    case "subscriptions":
      return <SubscriptionsView session={session} />;
    case "subscription":
      return <SubscriptionView subscriptionId={params.subscriptionId!} />;

    case "apis":
      return <ApisView user={user} meta={meta} />;
    case "api-new":
      return <PublishWizard session={session} />;
    case "api":
    case "api-tab":
      return (
        <ApiDetailView
          resourceId={params.resourceId!}
          tab={params.tab ?? "overview"}
          user={user}
          meta={meta}
          environment={session.environment}
          onEnvironment={session.setEnvironment}
        />
      );
    case "products":
      return <ProductsView session={session} />;

    case "fleet":
      return <GatewayView meta={meta} user={user} />;
    case "telemetry":
      return <TelemetryView meta={meta} />;
    case "global-policy":
      return (
        <GlobalPolicyView
          meta={meta}
          user={user}
          environment={session.environment}
          onEnvironment={session.setEnvironment}
        />
      );
    case "trust":
      return <TrustView meta={meta} user={user} environment={session.environment} />;
    case "audit":
      return <AuditView />;

    case "account":
      return <AccountView me={session.me} reload={session.reload} />;
    case "users":
      return <UsersView user={user} canCreate={meta.authProviders.includes("local")} />;
    case "user":
      return <UserView userId={params.userId!} me={user} />;
    case "teams":
      return <TeamsView user={user} unmappedGroups={session.me.unmappedGroups ?? []} />;
    case "team":
      return <TeamView teamId={params.teamId!} user={user} />;

    default:
      return <NotFound />;
  }
}

function NotFound() {
  return (
    <Card>
      <p className="muted">
        Nothing in the portal answers to that address. <Link to="/">Go back to Home</Link>, or read{" "}
        <Link to="/how">How this works</Link>.
      </p>
    </Card>
  );
}

