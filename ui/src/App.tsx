import { Portal } from './portal/Portal';
import { useState } from "react";
import { api, type AuthProviders, type Me, type Meta, type User } from "./api";
import { Card, Link, Notice, useAsync, usePath } from "./components";
import { type Match } from "./lib/routes";
import { AccountView } from "./views/AccountView";
import { ForcedPasswordChange, LoginView } from "./views/LoginView";
import { ApplicationsView, ApplicationView } from "./views/ApplicationsView";
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

export interface Application {
  id: string;
  name: string;
  mine: boolean;
}

/**
 * What every screen is given (plan §9.1). Two pieces of it are *context* rather than data:
 *
 *  - `application` — which application a create action belongs to, and what "mine" means in a list. A user in one
 *    application never sees a menu, only a label, because there is no choice to make.
 *  - `environment` — the stage of the chain being shown. One global switcher, because policies,
 *    routes, backends and subscriptions are all per environment and a screen that showed two at
 *    once would have to say which one each control writes to.
 */
export interface Session {
  user: User;
  meta: Meta;
  applications: Application[];
  application: string;
  setApplication: (next: string) => void;
  applicationName: (id: string) => string;
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
 * a 403 from *everything except* three paths. Fetching the chain and the application list up front would
 * turn "choose a password" into "the portal could not reach its own API".
 */
export function App() {
  const path = usePath();
  const me = useAsync(() => api.get<Me>("/api/me"), []);

  const signedIn = Boolean(me.data?.user);
  const mustChangePassword = Boolean(me.data?.mustChangePassword);
  const ready = signedIn && !mustChangePassword;

  const meta = useAsync(() => (ready ? api.get<Meta>("/api/meta") : Promise.resolve(null)), [ready]);
  const applications = useAsync(
    () => (ready ? api.get<{ items: Application[] }>("/api/applications") : Promise.resolve(null)),
    [ready, me.data?.user?.id],
  );
  const [environment, setEnvironment] = useState<string | null>(null);
  const [application, setApplication] = useState<string | null>(null);

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

  if (applications.loading) return <div className="main">Loading applications…</div>;
  if (applications.error) return <div className="main"><Notice kind="error">{applications.error}</Notice></div>;
  const user = me.data!.user!;
  const chain = meta.data.chain;
  const known = applications.data?.items ?? [];
  const mine = user.isAdmin ? known.map(row => row.id) : user.applications.length > 0 ? user.applications : known.filter((row) => row.mine).map((row) => row.id);

  const session: Session = {
    user,
    meta: meta.data,
    applications: known,
    application: application && mine.includes(application) ? application : (mine[0] ?? ""),
    setApplication,
    applicationName: (id) => known.find((row) => row.id === id)?.name ?? id,
    environment: environment && chain.includes(environment) ? environment : chain[0]!,
    setEnvironment,
    reload: me.reload,
    me: me.data!,
  };

  return <Portal session={session} path={path}/>;
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


export function Screen({ match, session }: { match: Match; session: Session }) {
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
    case "applications":
      return <ApplicationsView user={user} unmappedGroups={session.me.unmappedGroups ?? []} />;
    case "application":
      return <ApplicationView applicationId={params.applicationId!} user={user} />;

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

