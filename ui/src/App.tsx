import { useState } from "react";
import { api, type AuthProviders, type Me, type Meta, type User } from "./api";
import { Notice, useAsync, usePath } from "./components";
import { Portal } from "./portal/Portal";
import { ForcedPasswordChange, LoginView } from "./views/LoginView";

/**
 * Signing in, and the session every screen is handed. Nothing here routes and nothing here draws a
 * screen: `lib/routes.ts` says what the addresses are, `screens.tsx` says which component answers
 * one, and `portal/Portal.tsx` draws the frame. This file decides only whether there is anybody to
 * draw it for.
 */

export interface Application {
  id: string;
  name: string;
  mine: boolean;
  /** Quoted from LeanIX, `null` until that lookup has answered. Decoration, never a decision. */
  leanixId?: string | null;
}

/**
 * What every screen is given. Two pieces of it are *context* rather than data:
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
  const [application, setApplication] = useState<string | null>(() => localStorage.getItem("portal-application"));

  if (me.loading) return <div className="main">Loading…</div>;
  if (me.error) return <Unreachable error={me.error} />;
  if (!signedIn) return <LoginView onSignedIn={me.reload} />;
  if (mustChangePassword) return <PasswordGate onChanged={me.reload} />;

  if (meta.loading) return <div className="main">Loading…</div>;
  // Without `/api/meta` there is no environment chain and no kind list, so every screen below would
  // render half-built. Better to say which call failed than to look merely empty.
  if (meta.error || !meta.data) return <Unreachable error={meta.error} />;

  if (applications.loading) return <div className="main">Loading applications…</div>;
  if (applications.error) {
    return (
      <div className="main">
        <Notice kind="error">{applications.error}</Notice>
      </div>
    );
  }

  const user = me.data!.user!;
  const chain = meta.data.chain;
  const known = applications.data?.items ?? [];
  const mine = user.isAdmin
    ? known.map((row) => row.id)
    : user.applications.length > 0
      ? user.applications
      : known.filter((row) => row.mine).map((row) => row.id);

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

  return <Portal session={session} path={path} />;
}

/** The portal could not reach its own API. Says which call failed, rather than looking empty. */
function Unreachable({ error }: { error: string | null }) {
  return (
    <div className="main">
      <Notice kind="error">{error}</Notice>
      <p className="muted">
        The portal could not reach its own API. Reload once the control plane is answering.
      </p>
    </div>
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
