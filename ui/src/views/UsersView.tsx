import { useState } from "react";
import {
  api,
  type DirectoryUser,
  type DirectoryUserDetail,
  type ApplicationRow,
  type User,
} from "../api";
import {
  Card,
  DangerZone,
  EmptyState,
  TextField,
  Link,
  Notice,
  Skeleton,
  Term,
  useAction,
  useAsync,
} from "../components";
import { blockedBecause } from "../lib/capabilities";

/**
 * The directory (v5 plan §8).
 *
 * Two things this screen refuses to do, and says so where somebody would look for them:
 *
 *  - **It does not delete people.** The audit log, every revision and every release name an
 *    account, and deleting one would either orphan that history or break the append-only trigger
 *    that keeps it honest. Disabling is the end state, and it takes effect on the person's next
 *    request rather than at their next sign-in.
 *  - **It does not edit what a directory owns.** A display name the next claim re-read would
 *    overwrite is a write that looks lost, so the field is not offered and the row says why.
 */
export function UsersView({ user, canCreate }: { user: User; canCreate: boolean }) {
  const [query, setQuery] = useState("");
  const [provider, setProvider] = useState("");
  const [creating, setCreating] = useState(false);
  const list = useAsync(
    () =>
      api.get<{ items: DirectoryUser[]; providers: string[] }>(
        `/api/users?limit=200${query ? `&q=${encodeURIComponent(query)}` : ""}${
          provider ? `&provider=${provider}` : ""
        }`,
      ),
    [query, provider],
  );

  const rows = list.data?.items ?? [];
  const providers = list.data?.providers ?? [];

  return (
    <>
      <Card
        title="Everybody this portal knows"
        hint="An account arrives here the first time somebody signs in through the identity provider. You do not create those."
      >
        <Notice kind="error">{list.error}</Notice>
        <div className="row">
          <TextField label="Search" value={query} onChange={setQuery} placeholder="name, username or email" />
          <div className="field">
            <label htmlFor="provider-filter">Signs in with</label>
            <select
              id="provider-filter"
              value={provider}
              onChange={(event) => setProvider(event.target.value)}
            >
              <option value="">Any</option>
              {providers.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </div>
          {canCreate && (
            <button className="ghost" onClick={() => setCreating((open) => !open)}>
              {creating ? "Cancel" : "Create a local account"}
            </button>
          )}
        </div>

        {creating && (
          <CreateUser
            onCreated={() => {
              setCreating(false);
              list.reload();
            }}
          />
        )}

        {list.loading && <Skeleton rows={4} />}
        {!list.loading && rows.length === 0 ? (
          <EmptyState
            title="Nobody matches"
            detail="Either the search is too narrow, or nobody has signed in yet. An account appears the first time somebody does."
            action={
              <button className="ghost" onClick={() => { setQuery(""); setProvider(""); }}>
                Clear the filters
              </button>
            }
          />
        ) : (
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Signs in with</th>
                <th>Can act as</th>
                <th>Applications</th>
                <th>Last signed in</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className={row.disabled ? "row-muted" : undefined}>
                  <td>
                    <Link to={`/users/${row.id}`}>
                      <strong>{row.displayName}</strong>
                    </Link>
                    <div className="muted small mono">{row.username}</div>
                    {row.id === user.id && <span className="pill ok">you</span>}
                  </td>
                  <td>
                    <span className="pill muted">{row.provider}</span>
                    {row.disabled && <span className="pill stop">disabled</span>}
                    {row.lockedUntil && <span className="pill warn">locked</span>}
                    {row.mustChangePassword && <span className="pill warn">must change password</span>}
                  </td>
                  <td>
                    {row.effectiveRole === "admin" ? (
                      <Term name="administrator">Administrator</Term>
                    ) : (
                      <Term name="member">Member</Term>
                    )}
                    {row.adminFrom === "idp" && <span className="muted small"> (from the directory)</span>}
                  </td>
                  <td>{row.applications}</td>
                  <td className="muted">
                    {row.lastLoginAt ? new Date(row.lastLoginAt).toLocaleDateString() : "never"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </>
  );
}

function CreateUser({ onCreated }: { onCreated: () => void }) {
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const action = useAction();

  return (
    <div className="subcard">
      <Notice kind="error">{action.error}</Notice>
      <div className="row">
        <TextField label="Username" value={username} onChange={setUsername} placeholder="dana" />
        <TextField label="Name" value={displayName} onChange={setDisplayName} placeholder="Dana Developer" />
        <TextField label="Email" value={email} onChange={setEmail} placeholder="dana@example.com" />
        <TextField label="First password" value={password} onChange={setPassword} />
      </div>
      <p className="muted small">
        They will have to choose a different one the first time they sign in — this one passed
        through you, so it cannot be the one they keep.
      </p>
      <button
        className="primary"
        disabled={action.busy || username.trim().length < 2 || password.length === 0}
        onClick={async () => {
          const ok = await action.run(() =>
            api.post("/api/users", {
              username: username.trim(),
              displayName: displayName.trim() || undefined,
              email: email.trim() || undefined,
              password,
            }),
          );
          if (ok) onCreated();
        }}
      >
        Create the account
      </button>
    </div>
  );
}

/** One account, with everything an administrator can do to it. */
export function UserView({ userId, me }: { userId: string; me: User }) {
  const detail = useAsync(() => api.get<DirectoryUserDetail>(`/api/users/${userId}`), [userId]);
  const applications = useAsync(() => api.get<{ items: ApplicationRow[] }>("/api/applications"), []);
  const action = useAction();

  if (detail.loading) return <Skeleton rows={6} />;
  if (detail.error || !detail.data) return <Notice kind="error">{detail.error}</Notice>;

  const row = detail.data;
  const isSelf = row.id === me.id;
  const managed = row.provider !== "local";
  const reload = () => {
    detail.reload();
    action.setMessage(null);
  };

  const patch = async (payload: Record<string, unknown>, okMessage?: string) => {
    const ok = await action.run(() => api.patch(`/api/users/${row.id}`, payload, "*"), okMessage);
    if (ok) reload();
  };

  return (
    <>
      <Card title={row.displayName}>
        <Notice kind="error">{action.error}</Notice>
        {action.message && <Notice kind="ok">{action.message}</Notice>}
        <dl className="kv">
          <dt>Username</dt>
          <dd className="mono">{row.username}</dd>
          <dt>Signs in with</dt>
          <dd>
            <span className="pill muted">{row.provider}</span>
            {managed && (
              <span className="muted">
                {" "}
                — their name, email and password belong to that directory, so they are not editable
                here.
              </span>
            )}
          </dd>
          {row.email && (
            <>
              <dt>Email</dt>
              <dd>{row.email}</dd>
            </>
          )}
          <dt>First seen</dt>
          <dd className="muted">
            {new Date(row.createdAt).toLocaleString()} · created by {row.createdBy}
          </dd>
          <dt>Last signed in</dt>
          <dd className="muted">
            {row.lastLoginAt ? new Date(row.lastLoginAt).toLocaleString() : "never"}
          </dd>
        </dl>

        {!managed && <EditLocal row={row} onSave={patch} busy={action.busy} />}
      </Card>

      <Card
        title="What they can do"
        hint="Administrator means every application, plus gateways, global policy, the trust store, the audit log and this directory."
      >
        <p>
          Currently{" "}
          <strong>
            {row.effectiveRole === "admin" ? "an administrator" : "a member"}
          </strong>
          {row.adminFrom === "idp" && (
            <span className="muted">
              {" "}
              — granted by their <Term name="identity provider">identity provider</Term>, so it
              cannot be removed here.
            </span>
          )}
          {row.adminFrom === "both" && (
            <span className="muted">
              {" "}
              — granted both here and by their identity provider. Removing it here leaves the
              directory's grant in place.
            </span>
          )}
        </p>
        <div className="row">
          <button
            className="ghost"
            disabled={action.busy || row.role === "admin"}
            onClick={() => patch({ role: "admin" }, "They are an administrator now.")}
          >
            Make an administrator
          </button>
          <button
            className="ghost"
            disabled={action.busy || row.role === "member"}
            title={isSelf ? "You cannot remove your own administrator role" : undefined}
            onClick={() => patch({ role: "member" }, "They are a member now.")}
          >
            Make a member
          </button>
        </div>
        {row.note && <Notice kind="warn">{row.note}</Notice>}
      </Card>

      <Card
        title="Applications"
        hint="An application granted here stays even when the identity provider has never heard of it. One that came from a group comes back at their next claim refresh."
      >
        {row.memberships.length === 0 ? (
          <EmptyState
            title="Not in any application"
            detail="They can read the catalog and subscribe, but cannot publish or change anything."
            action={<Link to="/applications">See the applications →</Link>}
          />
        ) : (
          <table>
            <thead>
              <tr>
                <th>Application</th>
                <th>How</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {row.memberships.map((membership) => (
                <tr key={membership.applicationId}>
                  <td>
                    <Link to={`/applications/${membership.applicationId}`}>{membership.applicationName}</Link>
                  </td>
                  <td className="muted">
                    {membership.source === "idp" ? (
                      <>
                        From the group <span className="mono">{membership.sourceGroup ?? "—"}</span>
                      </>
                    ) : (
                      <>
                        Granted here
                        {membership.grantedByName ? ` by ${membership.grantedByName}` : ""}
                      </>
                    )}
                  </td>
                  <td>
                    <button
                      className="ghost small"
                      disabled={action.busy}
                      onClick={async () => {
                        const ok = await action.run(() =>
                          api.del<{ note: string | null }>(
                            `/api/users/${row.id}/applications/${membership.applicationId}`,
                          ),
                        );
                        if (ok) reload();
                      }}
                    >
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <GrantApplication
          userId={row.id}
          already={row.memberships.map((m) => m.applicationId)}
          applications={applications.data?.items ?? []}
          onGranted={reload}
        />
        <Notice kind="error">{applications.error}</Notice>
      </Card>

      <Card title="Where they are signed in">
        {row.sessions.length === 0 ? (
          <p className="muted">Nowhere right now.</p>
        ) : (
          <>
            <ul className="plain">
              {row.sessions.map((session) => (
                <li key={session.id} className="muted">
                  {session.provider} · started {new Date(session.createdAt).toLocaleString()} · last
                  seen {session.lastSeenAt ? new Date(session.lastSeenAt).toLocaleString() : "—"}
                </li>
              ))}
            </ul>
            <button
              className="ghost"
              disabled={action.busy}
              onClick={async () => {
                const ok = await action.run(() => api.del(`/api/users/${row.id}/sessions`));
                if (ok) reload();
              }}
            >
              Sign them out everywhere ({row.sessions.length})
            </button>
          </>
        )}
      </Card>

      {!managed && <ResetPassword userId={row.id} name={row.displayName} onDone={reload} />}

      <Card
        title="Disable this account"
        hint="Accounts are never deleted here: the audit log, every revision and every release name one, and history that points at nobody is worse than an account nobody uses."
      >
        {row.disabled ? (
          <>
            <p className="muted">
              Disabled. They cannot sign in and every session they had was ended.
            </p>
            <button
              className="ghost"
              disabled={action.busy}
              onClick={() => patch({ disabled: false }, "They can sign in again.")}
            >
              Let them back in
            </button>
          </>
        ) : (
          <DangerZone
            what={`Disable ${row.displayName}`}
            name={row.username}
            consequence="They are signed out of every browser immediately and cannot sign in again, whatever the identity provider says."
            permission={blockedBecause(
              isSelf,
              "You cannot disable your own account — ask another administrator.",
            )}
            busy={action.busy}
            error={action.error}
            onConfirm={() => patch({ disabled: true }, "Disabled, and signed out everywhere.")}
          />
        )}
      </Card>
    </>
  );
}

function EditLocal({
  row,
  onSave,
  busy,
}: {
  row: DirectoryUserDetail;
  onSave: (payload: Record<string, unknown>) => void;
  busy: boolean;
}) {
  const [displayName, setDisplayName] = useState(row.displayName);
  const [email, setEmail] = useState(row.email ?? "");
  const changed = displayName !== row.displayName || email !== (row.email ?? "");
  return (
    <div className="subcard">
      <div className="row">
        <TextField label="Name" value={displayName} onChange={setDisplayName} />
        <TextField label="Email" value={email} onChange={setEmail} />
      </div>
      <button
        className="ghost"
        disabled={busy || !changed}
        onClick={() => onSave({ displayName, email })}
      >
        Save
      </button>
    </div>
  );
}

function GrantApplication({
  userId,
  already,
  applications,
  onGranted,
}: {
  userId: string;
  already: string[];
  applications: ApplicationRow[];
  onGranted: () => void;
}) {
  const available = applications.filter((application) => !already.includes(application.id));
  const [applicationId, setApplicationId] = useState("");
  const action = useAction();
  if (available.length === 0) return null;

  return (
    <div className="row">
      <Notice kind="error">{action.error}</Notice>
      <div className="field">
        <label htmlFor="grant-application">Add to an application</label>
        <select id="grant-application" value={applicationId} onChange={(event) => setApplicationId(event.target.value)}>
          <option value="">Choose one…</option>
          {available.map((application) => (
            <option key={application.id} value={application.id}>
              {application.name}
            </option>
          ))}
        </select>
      </div>
      <button
        className="ghost"
        disabled={!applicationId || action.busy}
        onClick={async () => {
          const ok = await action.run(() => api.put(`/api/users/${userId}/applications/${applicationId}`));
          if (ok) {
            setApplicationId("");
            onGranted();
          }
        }}
      >
        Add
      </button>
    </div>
  );
}

function ResetPassword({
  userId,
  name,
  onDone,
}: {
  userId: string;
  name: string;
  onDone: () => void;
}) {
  const [password, setPassword] = useState("");
  const action = useAction();
  return (
    <Card
      title="Set a password"
      hint="Every session they have is ended, and they must choose a different one at their next sign-in."
    >
      <Notice kind="error">{action.error}</Notice>
      {action.message && <Notice kind="ok">{action.message}</Notice>}
      <div className="row">
        <TextField label={`A new password for ${name}`} value={password} onChange={setPassword} />
        <button
          className="ghost"
          disabled={action.busy || password.length === 0}
          onClick={async () => {
            const ok = await action.run(
              () => api.post(`/api/users/${userId}/password`, { password }),
              "Set. Tell them out of band — this portal will not.",
            );
            if (ok) {
              setPassword("");
              onDone();
            }
          }}
        >
          Set it
        </button>
      </div>
    </Card>
  );
}
