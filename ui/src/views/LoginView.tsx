import { useState } from "react";
import { Api } from "../portal/icons";
import { api, type AuthProviders } from "../api";
import { Panel, Notice, useAction, useAsync } from "../components";

/**
 * Signing in (v5 plan §8).
 *
 * The screen renders what `GET /api/auth/providers` says this deployment has, in the order it says
 * it — so a portal with one sign-in method shows one control and no menu, and a portal with two
 * shows both without either being a second-class citizen. Nothing here is keyed on a "mode": the
 * failure the reference implementation records is exactly that, a gate written as `mode !== 'oidc'`
 * that stopped enforcing the day the mode changed.
 *
 * `/auth/login` is a **link**, not a fetch. It answers a 302 into the identity provider, and a
 * `fetch` that followed that redirect would leave the browser sitting on a page it cannot see.
 *
 * The same screen answers two different situations, which is why `expired` exists. A first visit is
 * a first visit; a session that ended under somebody who was half way through a promotion is an
 * event, and a screen that greets them as a stranger reads as "the portal lost my work" rather than
 * "sign in again". The difference is a banner, the title, and the username already filled in.
 */
export function LoginView({
  onSignedIn,
  expired,
}: {
  onSignedIn: () => void;
  /** Who was signed in until a moment ago, or absent at a cold start. Either field may be unknown. */
  expired?: { name: string | null; username: string | null };
}) {
  const providers = useAsync(() => api.get<AuthProviders>("/api/auth/providers"), []);

  if (providers.loading) return <div className="login">Loading…</div>;
  if (providers.error || !providers.data) {
    return (
      <div className="login">
        <Panel title="Sign in">
          <Notice kind="error">{providers.error}</Notice>
          <p className="muted">
            The portal could not ask its own control plane how to sign in. Reload once it is
            answering.
          </p>
        </Panel>
      </div>
    );
  }

  const config = providers.data;
  if (config.providers.length === 0) {
    return (
      <div className="login">
        <Panel title="Nobody can sign in">
          <p className="muted">
            This deployment has no sign-in method enabled. Set <code>AUTH_PROVIDERS</code> on the
            control plane and restart it.
          </p>
        </Panel>
      </div>
    );
  }

  return (
    <div className="login">
      <div className="signin-brand"><Api size={24} /><strong>Integration Portal</strong></div>
      <Panel
        title={expired ? "Sign in again" : "Sign in"}
        hint={expired ? undefined : "The Integration Portal publishes, governs and serves APIs."}
      >
        {expired && <SessionEnded name={expired.name} />}
        {config.providers.map((provider, index) => (
          <div key={provider} className="signin-method">
            {index > 0 && <div className="signin-or">or</div>}
            {provider === "oidc" && <OidcButton label={config.oidc?.label ?? "Single sign-on"} />}
            {provider === "local" && (
              <LocalForm
                minLength={config.passwordMinLength}
                initialUsername={expired?.username ?? ""}
                onSignedIn={onSignedIn}
              />
            )}
            {provider === "dev" && <DevUsers users={config.devUsers} onSignedIn={onSignedIn} />}
          </div>
        ))}
      </Panel>
    </div>
  );
}

/**
 * What a re-authentication opens with. Its own component because it is the whole difference between
 * the two situations this screen answers, and because `LoginView` around it cannot be rendered
 * without a control plane to ask which sign-in methods a deployment has.
 *
 * Three things, in the order somebody needs them: that the session ended rather than the portal
 * breaking, that signing in returns them to the page they were on, and — before the sign-in rather
 * than after it — that a half-filled form did not survive. Somebody told that retypes it once;
 * somebody who is not goes looking for where it went.
 */
export function SessionEnded({ name }: { name: string | null }) {
  return (
    <Notice kind="warn">
      <strong>Your session has ended.</strong> {name ? `${name}, sign` : "Sign"} in again to come
      back to this page. A form you were part-way through is not kept.
    </Notice>
  );
}

function OidcButton({ label }: { label: string }) {
  // The path the user was heading for, so a link somebody sent them survives the round trip
  // through the identity provider. The control plane refuses anything that is not a path here.
  const target = window.location.pathname + window.location.search;
  const href = `/auth/login?return=${encodeURIComponent(target === "/" ? "/" : target)}`;
  return (
    <a className="button primary wide" href={href}>
      Continue with {label}
    </a>
  );
}

function LocalForm({
  minLength,
  initialUsername,
  onSignedIn,
}: {
  minLength: number;
  /** Filled in when this is a re-authentication: the same person, proving it a second time. */
  initialUsername: string;
  onSignedIn: () => void;
}) {
  const [username, setUsername] = useState(initialUsername);
  const [password, setPassword] = useState("");
  const action = useAction();
  const ready = username.trim().length > 0 && password.length > 0;

  const submit = async () => {
    const ok = await action.run(() =>
      api.post("/api/auth/login", { username: username.trim(), password }),
    );
    if (ok) onSignedIn();
  };

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (ready && !action.busy) void submit();
      }}
    >
      <Notice kind="error">{action.error}</Notice>
      <div className="field">
        <label htmlFor="login-username">Username</label>
        <input
          id="login-username"
          name="username"
          autoComplete="username"
          autoFocus={initialUsername === ""}
          value={username}
          onChange={(event) => setUsername(event.target.value)}
        />
      </div>
      <div className="field">
        <label htmlFor="login-password">Password</label>
        <input
          id="login-password"
          name="password"
          type="password"
          autoComplete="current-password"
          // The caret goes where the typing has to happen: the username box on a first visit, this
          // one when the name is already there because the session just ended.
          autoFocus={initialUsername !== ""}
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
      </div>
      <button className="primary wide" type="submit" disabled={!ready || action.busy}>
        {action.busy ? "Signing in…" : "Sign in"}
      </button>
      <p className="muted small">
        Passwords here are at least {minLength} characters. If you have forgotten yours, an
        administrator can set a new one — there is no email reset in this portal.
      </p>
    </form>
  );
}

/**
 * The development bypass. It is loud on purpose: this screen is the one place somebody could
 * mistake a bypassed deployment for a configured one, and a portal that hands out an administrator
 * session to anybody who asks should say so where they ask.
 */
function DevUsers({
  users,
  onSignedIn,
}: {
  users: AuthProviders["devUsers"];
  onSignedIn: () => void;
}) {
  const action = useAction();
  return (
    <div>
      <Notice kind="warn">
        <strong>Development sign-in.</strong> Anybody who can reach this portal can become any of
        these users without a password. Never in a deployment that holds anything real.
      </Notice>
      <Notice kind="error">{action.error}</Notice>
      {users.map((user) => (
        <button
          key={user.id}
          className="ghost wide dev-user"
          disabled={action.busy}
          onClick={async () => {
            const ok = await action.run(() => api.post("/api/auth/dev-login", { userId: user.id }));
            if (ok) onSignedIn();
          }}
        >
          <strong>{user.name}</strong>
          <span className="muted">
            {" "}
            — {user.role} · {user.applications.join(", ") || "no applications"}
          </span>
        </button>
      ))}
    </div>
  );
}

/**
 * The forced password change (plan §5.3). Rendered **instead of** the portal, not beside it: the
 * control plane refuses everything but this, so a shell with a sidebar full of links that all
 * answer 403 would be a worse lie than a screen with one thing on it.
 */
export function ForcedPasswordChange({
  minLength,
  onChanged,
  onSignOut,
}: {
  minLength: number;
  onChanged: () => void;
  onSignOut: () => void;
}) {
  const [password, setPassword] = useState("");
  const [again, setAgain] = useState("");
  const action = useAction();
  const matches = password.length > 0 && password === again;
  const long = password.length >= minLength;

  return (
    <div className="login">
      <Panel
        title="Choose a password"
        hint="Somebody else set the one you signed in with, so it cannot be the one you keep."
      >
        <Notice kind="error">{action.error}</Notice>
        <form
          onSubmit={async (event) => {
            event.preventDefault();
            if (!matches || !long || action.busy) return;
            const ok = await action.run(() => api.post("/api/auth/password", { newPassword: password }));
            if (ok) onChanged();
          }}
        >
          <div className="field">
            <label htmlFor="new-password">New password</label>
            <input
              id="new-password"
              type="password"
              autoComplete="new-password"
              autoFocus
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="new-password-again">And again</label>
            <input
              id="new-password-again"
              type="password"
              autoComplete="new-password"
              value={again}
              onChange={(event) => setAgain(event.target.value)}
            />
          </div>
          {/* Said before the request, not after it: the rule is knowable up front, so refusing at
              the server is a round trip that teaches nothing. */}
          {password.length > 0 && !long && (
            <p className="muted small">At least {minLength} characters. Length is what makes it hard to guess.</p>
          )}
          {again.length > 0 && !matches && <p className="muted small">The two do not match.</p>}
          <button className="primary wide" type="submit" disabled={!matches || !long || action.busy}>
            {action.busy ? "Saving…" : "Set my password"}
          </button>
        </form>
        <p className="muted small">
          Changing it signs out every other browser you are signed in on — this one stays.{" "}
          <button className="linklike" onClick={onSignOut}>
            Sign out instead
          </button>
          .
        </p>
      </Panel>
    </div>
  );
}
