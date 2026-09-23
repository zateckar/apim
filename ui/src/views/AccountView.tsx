import { formatDate, formatDateTime } from "../lib/datetime";
import { useState } from "react";
import { api, type AuthProviders, type Me, type SessionView } from "../api";
import { Panel, EmptyState, Link, Notice, Skeleton, Term, TextField, useAction, useAsync } from "../components";

/**
 * Your own account (v5 plan §8).
 *
 * Three questions, in the order somebody asks them: who does this portal think I am, what am I
 * allowed to do and why, and where else am I signed in. The third is the one nothing else answers —
 * a session list a person can act on is the only self-service control this portal has against a
 * browser left signed in somewhere else.
 */
export function AccountView({ me, reload }: { me: Me; reload: () => void }) {
  const user = me.user!;
  const sessions = useAsync(() => api.get<{ items: SessionView[] }>("/api/my/sessions"), []);

  return (
    <>
      <Panel title="Who you are here" className="account-profile">
        <dl className="kv">
          <dt>Name</dt>
          <dd>{user.name}</dd>
          <dt>Signs in with</dt>
          <dd>{providerLabel(user.provider)}</dd>
          {user.username && (
            <>
              <dt>Username</dt>
              <dd className="mono">{user.username}</dd>
            </>
          )}
          {user.email && (
            <>
              <dt>Email</dt>
              <dd>{user.email}</dd>
            </>
          )}
          <dt>Can act as</dt>
          <dd>
            {user.isAdmin ? <Term name="administrator">Administrator</Term> : <Term name="member">Member</Term>}
            {user.isAdmin && user.adminFrom === "idp" && (
              <span className="muted"> — granted by your {""}
                <Term name="identity provider">identity provider</Term>, not in this portal
              </span>
            )}
          </dd>
        </dl>
      </Panel>

      <Panel
        title="Your applications"
        hint="Membership is what lets you publish and change what an application owns."
      >
        {me.claimsStale && (
          <Notice kind="warn">
            These are the applications your identity provider reported when you signed in. A change
            made there since shows after you sign out and back in.
          </Notice>
        )}
        {(me.applications ?? []).length === 0 ? (
          <EmptyState
            title="You are not in any application"
            detail={user.isAdmin ? "As an administrator, you can act for every application without explicit membership." : "You can read the catalog. An administrator must add you to an application before you can subscribe, publish or change what it owns."}
            action={<Link to="/catalog">Browse the catalog →</Link>}
          />
        ) : (
          <table>
            <thead>
              <tr>
                <th>Application</th>
                <th>How you got it</th>
              </tr>
            </thead>
            <tbody>
              {(me.applications ?? []).map((application) => (
                <tr key={application.applicationId}>
                  <td>
                    <Link to={`/${application.applicationId}/dashboard`}><strong>{application.applicationName}</strong> →</Link>
                  </td>
                  <td className="muted">
                    {application.source === "idp" ? (
                      <>
                        From the group <span className="mono">{application.sourceGroup ?? "—"}</span> in your{" "}
                        <Term name="identity provider">identity provider</Term>. Removing you from
                        that group removes this application.
                      </>
                    ) : (
                      <>
                        Granted in this portal
                        {application.grantedByName ? <> by {application.grantedByName}</> : null}
                        {application.grantedAt ? <> on {formatDate(application.grantedAt)}</> : null}.
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {(me.unmappedGroups ?? []).length > 0 && (
          <Notice kind="warn">
            Your identity provider also put you in{" "}
            {me.unmappedGroups!.map((group) => (
              <span key={group} className="mono">
                {group}{" "}
              </span>
            ))}
            , which no application here is mapped to. An administrator can map it on the{" "}
            <Link to="/applications">Applications</Link> screen.
          </Notice>
        )}
        {me.noGroupsInToken && (
          <Notice kind="warn">
            Your <Term name="identity provider">identity provider</Term> sent no groups at all, so
            there is nothing to map to an <Term name="application">application</Term>. No screen here
            can fix that: whoever set the portal up needs to check which claim carries group
            membership in your realm.
          </Notice>
        )}
      </Panel>

      {user.provider === "local" && <ChangePassword onChanged={reload} />}

      <Panel
        title="Where you are signed in"
        hint="One row per browser. Revoke any you do not recognise, then change your password."
      >
        <Notice kind="error">{sessions.error}</Notice>
        {/* A skeleton until the list arrives. The table used to render straight away with no rows,
            which for a moment said "signed in nowhere" — including not here. */}
        {sessions.data ? (
          <SessionList
            items={sessions.data.items}
            onChanged={() => {
              sessions.reload();
              reload();
            }}
          />
        ) : (
          !sessions.error && <Skeleton rows={2} />
        )}
      </Panel>
    </>
  );
}

function providerLabel(provider: string | undefined): string {
  if (provider === "oidc") return "your organisation's identity provider";
  if (provider === "local") return "a username and password held by this portal";
  if (provider === "dev") return "the development bypass — no password at all";
  return "an unknown method";
}

function SessionList({ items, onChanged }: { items: SessionView[]; onChanged: () => void }) {
  const action = useAction();
  const others = items.filter((session) => !session.current);

  return (
    <>
      <Notice kind="error">{action.error}</Notice>
      <table>
        <thead>
          <tr>
            <th>Browser</th>
            <th>Started</th>
            <th>Last seen</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {items.map((session) => (
            <tr key={session.id}>
              <td>
                {shortAgent(session.userAgent)}{" "}
                {session.current && <span className="chip">This browser</span>}
              </td>
              <td className="muted">{formatDateTime(session.createdAt)}</td>
              <td className="muted">
                {session.lastSeenAt ? formatDateTime(session.lastSeenAt) : "—"}
              </td>
              <td className="right">
                {/* "Revoke", the word the portal uses for ending a session or a credential; it said
                    "End it" here and "Sign them out" on a person's page for the same act. */}
                {!session.current && (
                  <button
                    className="btn sm"
                    disabled={action.busy}
                    onClick={async () => {
                      const ok = await action.run(() => api.del(`/api/my/sessions/${session.id}`));
                      if (ok) onChanged();
                    }}
                  >
                    Revoke
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {others.length > 0 && (
        <div className="native-actions">
          <button
            className="btn"
            disabled={action.busy}
            onClick={async () => {
              const ok = await action.run(() => api.post("/api/my/sessions/revoke-all"));
              if (ok) onChanged();
            }}
          >
            Revoke every other session ({others.length})
          </button>
        </div>
      )}
    </>
  );
}

/**
 * The user agent, shortened to the part a person recognises. Not parsed properly on purpose: every
 * browser lies about this string, and the only job here is to let somebody tell one row from
 * another.
 */
function shortAgent(agent: string | null): string {
  if (!agent) return "Unknown browser";
  for (const [needle, label] of [
    ["Edg/", "Edge"],
    ["Firefox/", "Firefox"],
    ["Chrome/", "Chrome"],
    ["Safari/", "Safari"],
    ["curl/", "curl"],
  ] as const) {
    if (agent.includes(needle)) {
      const platform = /\(([^)]*)\)/.exec(agent)?.[1]?.split(";")[0]?.trim();
      return platform ? `${label} on ${platform}` : label;
    }
  }
  return agent.slice(0, 40);
}

function ChangePassword({ onChanged }: { onChanged: () => void }) {
  const config = useAsync(() => api.get<AuthProviders>("/api/auth/providers"), []);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const action = useAction();
  const minLength = config.data?.passwordMinLength ?? 12;
  const ready = !config.loading && !config.error && current.length > 0 && next.length >= minLength && next.length <= 200 && next === again;

  return (
    <Panel
      title="Change your password"
      hint="Every other browser you are signed in on is signed out. This one stays."
    >
      <Notice kind="error">{action.error ?? config.error}</Notice>
      {action.message && <Notice kind="ok">{action.message}</Notice>}
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          if (!ready || action.busy) return;
          const ok = await action.run(
            () => api.post("/api/auth/password", { currentPassword: current, newPassword: next }),
            "Password changed.",
          );
          if (ok) {
            setCurrent("");
            setNext("");
            setAgain("");
            onChanged();
          }
        }}
      >
        {/* The shared field, so the length rule and the mismatch are each the field's own error
            line rather than a loose paragraph under it — one of which was muted and read as a hint. */}
        <TextField
          inputId="current-password"
          label="Current password"
          type="password"
          autoComplete="current-password"
          value={current}
          onChange={setCurrent}
        />
        <TextField
          inputId="account-new-password"
          label="New password"
          type="password"
          autoComplete="new-password"
          maxLength={200}
          value={next}
          onChange={setNext}
          hint={`Use ${minLength}–200 characters.`}
          error={next.length > 0 && next.length < minLength ? `Use ${minLength}–200 characters.` : null}
        />
        <TextField
          inputId="account-new-password-again"
          label="And again"
          type="password"
          autoComplete="new-password"
          value={again}
          onChange={setAgain}
          error={again.length > 0 && next !== again ? "The two do not match." : null}
        />
        <button className="btn primary" type="submit" disabled={!ready || action.busy}>
          {action.busy ? "Saving…" : "Change password"}
        </button>
      </form>
    </Panel>
  );
}
