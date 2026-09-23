import { listAll } from "../portal/client";
import * as I from "../portal/icons";
import { formatDate, formatDateTime } from "../lib/datetime";
import { useState } from "react";
import {
  api,
  type AuthProviders,
  type DirectoryUser,
  type DirectoryUserDetail,
  type ApplicationRow,
  type User,
} from "../api";
import {
  Action,
  Panel,
  DangerZone,
  EmptyState,
  Modal,
  TextField,
  Link,
  Notice,
  Skeleton,
  StatusChip,
  Term,
  useAction,
  useAsync,
  usePageTitle,
} from "../components";
import { blockedBecause } from "../lib/capabilities";
import { accountChips } from "../lib/status";

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
    `${query}:${provider}`,
  );

  const rows = list.data?.items ?? [];
  const providers = list.data?.providers ?? [];

  return (
    <>
      <Panel
        title="Everybody this portal knows"
        hint="Directory accounts appear on first sign-in. Local accounts are created here."
        actions={canCreate && <button className={creating ? "btn" : "btn primary"} onClick={() => setCreating(open => !open)}>{creating ? <I.X /> : <I.Plus />}{creating ? "Cancel" : "Create a local account"}</button>}
      >
        <Notice kind="error">{list.error}</Notice>
        <div className="directory-toolbar">
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
                  {providerName(name)}
                </option>
              ))}
            </select>
          </div>
          <span className="muted small">{rows.length} people</span>
        </div>

        {creating && (
          <CreateUser
            onCreated={() => {
              setCreating(false);
              list.reload();
            }}
          />
        )}

        {/* One state at a time: the empty table used to render under the skeleton and the error. */}
        {list.loading ? (
          <Skeleton rows={4} />
        ) : list.error ? null : rows.length === 0 ? (
          <EmptyState
            title="Nobody matches"
            detail="The search may be too narrow. Directory accounts appear the first time somebody signs in."
            action={
              <button className="btn" onClick={() => { setQuery(""); setProvider(""); }}>
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
                    {row.id === user.id && <span className="chip">You</span>}
                  </td>
                  <td>
                    {/* The provider is a fact, so a neutral chip; what stops somebody signing in
                        is a state, so the tone vocabulary's (lib/status.ts). */}
                    <span className="chip">{providerName(row.provider)}</span>{" "}
                    {accountChips(row).map((chip) => (
                      <StatusChip key={chip.label} chip={chip} />
                    ))}
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
                    {row.lastLoginAt ? formatDate(row.lastLoginAt) : "never"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
    </>
  );
}

/** A sign-in method in words: the ids are `AUTH_PROVIDERS` values, not something a reader says. */
function providerName(provider: string): string {
  if (provider === "local") return "Local account";
  if (provider === "oidc") return "Identity provider";
  if (provider === "dev") return "Development sign-in";
  return provider;
}

function CreateUser({ onCreated }: { onCreated: () => void }) {
  const config = useAsync(() => api.get<AuthProviders>("/api/auth/providers"), []);
  const existing = useAsync(() => listAll<DirectoryUser>("/api/users?provider=local"), []);
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const action = useAction();
  const usernameProblem = /^[a-zA-Z0-9][a-zA-Z0-9._-]{1,63}$/.test(username.trim()) ? null : "Use 2–64 letters, digits, dots, underscores or hyphens; start with a letter or digit.";
  const passwordProblem = password.length < (config.data?.passwordMinLength ?? 12) || password.length > 200 ? `Use ${config.data?.passwordMinLength ?? 12}–200 characters.` : password.toLowerCase() === username.trim().toLowerCase() || (email && password.toLowerCase() === email.trim().toLowerCase()) ? "The password cannot be the username or email address." : null;
  const emailProblem = email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) ? "Enter an email address, or leave this optional field empty." : null;
  const duplicate = existing.data?.items.some(user => user.username.toLowerCase() === username.trim().toLowerCase());
  const invalid = Boolean(usernameProblem || duplicate || passwordProblem || emailProblem || config.loading || config.error || existing.loading || existing.error);

  return (
    <div className="subcard">
      <Notice kind="error">{action.error ?? config.error ?? existing.error}</Notice>
      <div className="row">
        <TextField error={username ? usernameProblem ?? (duplicate ? "A local account with this username already exists." : null) : null} hint="2–64 characters." maxLength={64} label="Username" value={username} onChange={setUsername} placeholder="dana" />
        <TextField label="Name" value={displayName} onChange={setDisplayName} placeholder="Dana Novak" />
        <TextField type="email" error={emailProblem} label="Email (optional)" value={email} onChange={setEmail} placeholder="dana@example.com" />
        <TextField label="First password" type="password" autoComplete="new-password" value={password} onChange={setPassword} maxLength={200} hint={`At least ${config.data?.passwordMinLength ?? 12} characters.`} error={password ? passwordProblem : null} />
      </div>
      <p className="muted small">They choose their own password the first time they sign in.</p>
      <button
        className="btn primary"
        disabled={action.busy || invalid}
        onClick={async () => {
          if (invalid) return;
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
  const [removing, setRemoving] = useState<{ applicationId: string; applicationName: string; fromIdp: boolean } | null>(null);
  // What the control plane said about the last removal. It was typed `{ note }` and then thrown
  // away, so the one sentence explaining that an identity-provider membership comes straight back
  // (platform-administration, "A membership came from the identity provider") was never read.
  const [removalNote, setRemovalNote] = useState<string | null>(null);
  const [roleNote, setRoleNote] = useState<string | null>(null);
  // Its own handle, so a refused disable is drawn once — inside the confirmation — rather than
  // there and again at the top of the page.
  const disabling = useAction();
  // Before the early returns: a hook has to run on every render, and the name is what four open
  // tabs of "Account" could not be told apart by.
  usePageTitle(detail.data?.displayName);

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
    let note: string | null = null;
    const ok = await action.run(async () => {
      // The response says when a demotion changed nothing because the identity provider still
      // grants the role `[P1-17]`; reading it is the difference between "done" and "done, but".
      const result = await api.patch<{ note?: string | null }>(`/api/users/${row.id}`, payload, "*");
      note = result?.note ?? null;
    }, okMessage);
    if (ok) {
      setRoleNote(note);
      reload();
    }
  };

  return (
    <>
      {/* No "← People" link and no name as this panel's title: the shell draws the trail back to
          People and, through `usePageTitle`, the name as the page's own title. Both were here
          twice. */}
      <Panel title="Profile" className="person-profile">
        <Notice kind="error">{action.error}</Notice>
        {action.message && <Notice kind="ok">{action.message}</Notice>}
        <dl className="kv">
          <dt>Username</dt>
          <dd className="mono">{row.username}</dd>
          <dt>Signs in with</dt>
          <dd>
            <span className="chip">{providerName(row.provider)}</span>{" "}
            {accountChips(row).map((chip) => (
              <StatusChip key={chip.label} chip={chip} />
            ))}
            {managed && (
              <span className="muted"> — name, email and password belong to that directory.</span>
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
            {formatDateTime(row.createdAt)} · created by {row.createdBy}
          </dd>
          <dt>Last signed in</dt>
          <dd className="muted">
            {row.lastLoginAt ? formatDateTime(row.lastLoginAt) : "never"}
          </dd>
        </dl>

        {!managed && <EditLocal row={row} onSave={patch} busy={action.busy} />}
      </Panel>

      <Panel
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
        {/* Only the change that applies is offered: an administrator can be made a member and a
            member an administrator. Self-demotion is disabled with its reason on screen, not in a
            tooltip a keyboard never sees (platform-administration, "own account"). */}
        <div className="native-actions">
          {row.role === "admin" ? (
            <Action
              permission={blockedBecause(isSelf, "You cannot remove your own administrator role — ask another administrator.")}
              busy={action.busy}
              onClick={() => void patch({ role: "member" }, "They are a member now.")}
            >
              Make a member
            </Action>
          ) : (
            <button
              className="btn"
              disabled={action.busy}
              onClick={() => void patch({ role: "admin" }, "They are an administrator now.")}
            >
              Make an administrator
            </button>
          )}
        </div>
        <Notice kind="warn">{roleNote ?? row.note}</Notice>
      </Panel>

      <Panel
        title="Applications"
        hint="Granted here, or from an identity provider group. One from a group returns at their next claim refresh while they are still in it."
      >
        <Notice kind="warn">{removalNote}</Notice>
        {row.memberships.length === 0 ? (
          <EmptyState
            title="Not in any application"
            detail="They can read the catalog. A member needs an application to subscribe, publish or change anything; an administrator can act for every application."
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
                  <td className="right">
                    <button
                      className="btn sm"
                      onClick={() =>
                        setRemoving({
                          applicationId: membership.applicationId,
                          applicationName: membership.applicationName,
                          fromIdp: membership.source === "idp",
                        })
                      }
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
          onGranted={() => {
            setRemovalNote(null);
            reload();
          }}
        />
        <Notice kind="error">{applications.error}</Notice>
        {removing && (
          <RemoveMembership
            userId={row.id}
            userName={row.displayName}
            applicationId={removing.applicationId}
            applicationName={removing.applicationName}
            fromIdp={removing.fromIdp}
            close={() => setRemoving(null)}
            onRemoved={(note) => {
              setRemoving(null);
              setRemovalNote(note);
              reload();
            }}
          />
        )}
      </Panel>

      <Panel title="Where they are signed in">
        {row.sessions.length === 0 ? (
          <p className="muted">Nowhere right now.</p>
        ) : (
          <>
            <ul className="plain">
              {row.sessions.map((session) => (
                <li key={session.id} className="muted">
                  {providerName(session.provider)} · started {formatDateTime(session.createdAt)} ·
                  last seen {session.lastSeenAt ? formatDateTime(session.lastSeenAt) : "—"}
                </li>
              ))}
            </ul>
            {/* "Revoke", as on your own account page: the same act had three names. */}
            <button
              className="btn"
              disabled={action.busy}
              onClick={async () => {
                const ok = await action.run(() => api.del(`/api/users/${row.id}/sessions`));
                if (ok) reload();
              }}
            >
              Revoke every session ({row.sessions.length})
            </button>
          </>
        )}
      </Panel>

      {!managed && <ResetPassword userId={row.id} name={row.displayName} onDone={reload} />}

      <Panel
        title="Disable this account"
        hint="Accounts are disabled, never deleted: the audit log and every revision still name them."
      >
        {row.disabled ? (
          <>
            <p className="muted">They cannot sign in, and every session they had was ended.</p>
            <button
              className="btn"
              disabled={action.busy}
              onClick={() => void patch({ disabled: false }, "They can sign in again.")}
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
            busy={disabling.busy}
            error={disabling.error}
            onConfirm={async () => {
              const ok = await disabling.run(() => api.patch(`/api/users/${row.id}`, { disabled: true }, "*"));
              if (ok) {
                action.setMessage("Disabled, and signed out everywhere.");
                detail.reload();
              }
            }}
          />
        )}
      </Panel>
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
        className="btn"
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
    <>
    <Notice kind="error">{action.error}</Notice>
    <div className="row">
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
        className="btn"
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
    </>
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
    <Panel
      title="Set a password"
      hint="Every session they have is ended, and they must choose a different one at their next sign-in."
    >
      <Notice kind="error">{action.error}</Notice>
      {action.message && <Notice kind="ok">{action.message}</Notice>}
      <div className="row">
        <TextField label={`A new password for ${name}`} type="password" autoComplete="new-password" value={password} onChange={setPassword} />
        <button
          className="btn"
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
    </Panel>
  );
}

/**
 * Removing somebody from an application — from their page or from the application's, so it is one
 * component and one request rather than two that could say different things.
 *
 * A dialog that names both sides and asks once, and deliberately **not** a typed confirmation
 * (platform-administration, "A membership came from the identity provider"): nothing is deleted, and
 * the Add control beside the list grants it back. What the dialog adds over the bare button it
 * replaces is the consequence, said before the click, and — for a membership that came from a group
 * — that it will simply come back. After the click, the control plane's own sentence about that is
 * handed to `onRemoved` for the caller to show; it used to be typed and then discarded.
 *
 * The only place that calls this endpoint, which is why `hygiene.test.ts` can exempt it by file.
 */
export function RemoveMembership({
  userId,
  userName,
  applicationId,
  applicationName,
  fromIdp,
  close,
  onRemoved,
}: {
  userId: string;
  userName: string;
  applicationId: string;
  applicationName: string;
  fromIdp: boolean;
  close: () => void;
  onRemoved: (note: string | null) => void;
}) {
  const action = useAction();
  return (
    <Modal title={`Remove ${userName} from ${applicationName}?`} close={close}>
      <p>
        From their next request, {userName} can no longer publish or change what {applicationName} owns.
      </p>
      {fromIdp && (
        <Notice kind="warn">
          This membership came from an identity provider group. If they are still in that group, it
          returns at their next claim refresh — remove them from the group instead.
        </Notice>
      )}
      <Notice kind="error">{action.error}</Notice>
      <div className="native-actions">
        <button
          className="btn danger"
          disabled={action.busy}
          onClick={async () => {
            let note: string | null = null;
            const ok = await action.run(async () => {
              const result = await api.del<{ note: string | null }>(
                `/api/users/${userId}/applications/${applicationId}`,
              );
              note = result?.note ?? null;
            });
            if (ok) onRemoved(note);
          }}
        >
          {action.busy ? "Removing…" : "Remove"}
        </button>
        <button className="btn" onClick={close}>
          Cancel
        </button>
      </div>
    </Modal>
  );
}
