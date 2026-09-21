import { useEffect, useState } from "react";
import { api, onSessionLost, type AuthProviders, type Me, type Meta, type User } from "./api";
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
 *
 * A session can also end *after* all of that, and that is the second thing decided here. Both
 * bounds are enforced on the server, an administrator can revoke a session, and an OIDC session
 * dies with the identity provider's own — so the portal has to expect to be signed out mid-use.
 */
export function App() {
  const path = usePath();
  const me = useAsync(() => api.get<Me>("/api/me"), []);

  /**
   * The session went while the portal was open (auth-and-access, "The portal signs the user back
   * in when their session ends"). Every screen polls, so the first one to notice used to render
   * `401 Unauthorized: sign in first` and the rest joined it a tick later, and the only way out
   * was for the reader to guess that a reload would show them a sign-in screen.
   *
   * Signing in again is rendered **instead of** the portal, for the reason the forced password
   * change is: the control plane now refuses everything, so a shell whose every link answers 401
   * is a worse lie than one screen that says what happened. Unmounting is not only honesty — it
   * takes the tickers with it, which is what stops the 401s. The address is untouched, so signing
   * in returns to the screen that was open, and the portal mounts afresh rather than carrying a
   * dead session's data or its refusals across.
   */
  const [expired, setExpired] = useState(false);
  useEffect(() => onSessionLost(() => setExpired(true)), []);

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
  // Ahead of all three gates below. Ahead of the password gate and the sign-in screen because
  // whatever `me` last said about this caller, the session behind it is gone — and ahead of
  // `me.error` because `/api/me` is itself one of the requests that can bring the news: the OIDC
  // claims refresh runs before every route including the public ones, so an identity provider that
  // has ended its own session answers this very call with `session_expired`. "The portal could not
  // reach its own API" would be the wrong sentence for the one failure we know the cause of.
  if (expired) {
    return (
      <LoginView
        expired={{
          name: me.data?.user?.name ?? null,
          // Only a local account's username belongs in the local form. An OIDC principal's is the
          // name they have *there*, and putting it in this box invites them to try a password the
          // portal has never held.
          username: me.data?.user?.provider === "local" ? (me.data.user.username ?? null) : null,
        }}
        onSignedIn={() => {
          setExpired(false);
          me.reload();
        }}
      />
    );
  }
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
