import { listAll } from "../portal/client";
import * as I from "../portal/icons";
import { formatDate } from "../lib/datetime";
import { useState } from "react";
import { api, type ApplicationDetail, type ApplicationRow, type DirectoryUser, type User } from "../api";
import {
  Action,
  Panel,
  DangerZone,
  EmptyState,
  TextField,
  Link,
  go,
  Notice,
  Skeleton,
  Term,
  useAction,
  useAsync,
  usePageTitle,
} from "../components";
import { ALLOWED, permitAdmin } from "../lib/capabilities";
import { RemoveMembership } from "./UsersView";

/**
 * Applications (v5 plan §8).
 *
 * An application is the unit of ownership, and until v5 it existed only as a switcher in the sidebar with
 * no screen behind it: no way to see who was in one, no way to create one, and no way to find out
 * that an application's membership was coming from an identity provider group. All three were things
 * somebody had to be told.
 *
 * `sourceGroup` is shown to administrators only `[P1-18]`. Application names are already a discovery
 * surface, but which group grants an application tells any signed-in user exactly which group to get
 * themselves added to in order to own another application's APIs.
 */
export function ApplicationsView({ user, unmappedGroups }: { user: User; unmappedGroups: string[] }) {
  const list = useAsync(() => listAll<ApplicationRow>("/api/applications"), []);
  const [creating, setCreating] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const rows = (list.data?.items ?? []).filter(row => `${row.name} ${row.id} ${row.sourceGroup ?? ""}`.toLowerCase().includes(query.trim().toLowerCase()));

  return (
    <>
      <Panel
        title="Who owns what"
        hint="Applications own resources and grant their members permission to manage them."
        actions={user.isAdmin && creating === null && <button className="btn primary" onClick={() => setCreating("")}><I.Plus /> Create an application</button>}
      >
        <Notice kind="error">{list.error}</Notice>
        <div className="directory-toolbar"><TextField label="Find an application" value={query} onChange={setQuery} placeholder="Name, ID or directory group" /><span className="muted small">{rows.length} applications</span></div>
        {user.isAdmin && creating !== null && (
          <CreateApplication
            key={creating}
            sourceGroup={creating}
            taken={(list.data?.items ?? []).map(application => application.name)}
            onDone={(created) => {
              setCreating(null);
              if (created) list.reload();
            }}
          />
        )}
        {/* Loading, failed, empty and listed are four states, and each is drawn alone: the empty
            table used to render under the skeleton, and under the error. */}
        {list.loading ? (
          <Skeleton rows={3} />
        ) : list.error ? null : rows.length === 0 ? (
          <EmptyState
            title={query ? "No matching applications" : "No applications yet"}
            detail={query ? "Try another name, ID or directory group." : "Nothing can be published until there is an application to own it."}
            action={
              query || user.isAdmin ? <button className="btn" onClick={() => query ? setQuery("") : setCreating("")}>
                {query ? "Clear search" : "Create the first application"}
              </button> : <Link to="/account">View your memberships</Link>
            }
          />
        ) : (
          <table>
            <thead>
              <tr>
                <th>Application</th>
                <th>People</th>
                {user.isAdmin && <th>Granted by the group</th>}
              </tr>
            </thead>
            <tbody>
              {rows.map((application) => (
                <tr key={application.id}>
                  <td>
                    <Link to={`/applications/${application.id}`}>
                      <strong>{application.name}</strong>
                    </Link>
                    {application.mine && <span className="chip">Yours</span>}
                  </td>
                  <td>{application.members}</td>
                  {user.isAdmin && (
                    <td className="muted mono">
                      {application.sourceGroup ?? <span className="muted">granted here only</span>}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}


      </Panel>

      {user.isAdmin && unmappedGroups.length > 0 && (
        <Panel title="Groups that could not be provisioned">
          <p className="muted">
            A group names an application and provisions one on sign-in. These could not: the name each would take
            is already held by an application bound to a <strong>different</strong> group, or there
            is no usable name in it. Map one on an application's page, or create one for it here.
          </p>
          <ul className="plain">
            {unmappedGroups.map((group) => (
              <li key={group}>
                <span className="mono">{group}</span>{" "}
                <button className="btn sm" onClick={() => setCreating(group)}>
                  Create an application for it
                </button>
              </li>
            ))}
          </ul>
        </Panel>
      )}
    </>
  );
}

function CreateApplication({
  taken,
  sourceGroup,
  onDone,
}: {
  taken: string[];
  sourceGroup: string;
  onDone: (created: boolean) => void;
}) {
  const [name, setName] = useState("");
  const [group, setGroup] = useState(sourceGroup);
  const action = useAction();
  const problem = name.trim().length < 2 || name.trim().length > 80 ? "Use 2–80 characters." : taken.some(existing => existing.toLowerCase() === name.trim().toLowerCase()) ? "An application with this name already exists." : null;

  return (
    <div className="subcard">
      <Notice kind="error">{action.error}</Notice>
      <div className="row">
        <TextField label="Name" hint="2–80 characters; unique in the application directory." error={name ? problem : null} maxLength={80} value={name} onChange={setName} placeholder="Orders" />
        <TextField
          label="Identity provider group (optional)"
          value={group}
          onChange={setGroup}
          placeholder="SG-APIM-ORDERS"
        />
      </div>
      <p className="muted small">
        With a group, its members join at their next sign-in and leave when removed from it. Without
        one, membership is granted here only.
      </p>
      <div className="row">
        <button
          className="btn primary"
          disabled={action.busy || Boolean(problem)}
          onClick={async () => {
            if (problem) return;
            const ok = await action.run(() =>
              api.post("/api/applications", {
                name: name.trim(),
                sourceGroup: group.trim() || undefined,
              }),
            );
            if (ok) onDone(true);
          }}
        >
          Create application
        </button>
        <button className="btn" onClick={() => onDone(false)}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/** One application: who is in it, how they got there, and what stands in the way of deleting it. */
export function ApplicationView({ applicationId, user }: { applicationId: string; user: User }) {
  const detail = useAsync(() => api.get<ApplicationDetail>(`/api/applications/${applicationId}`), [applicationId]);
  const action = useAction();
  const [removing, setRemoving] = useState<ApplicationDetail["members"][number] | null>(null);
  const [removalNote, setRemovalNote] = useState<string | null>(null);
  // The application's name as the page title, before the early returns because a hook runs on every
  // render. "Application" over every one of them could not tell two open tabs apart.
  usePageTitle(detail.data?.name);

  if (detail.loading) return <Skeleton rows={5} />;
  if (detail.error || !detail.data) return <Notice kind="error">{detail.error}</Notice>;

  const application = detail.data;
  const total = Object.values(application.owns).reduce((sum, n) => sum + n, 0);
  const canManage = permitAdmin(user.isAdmin, "change or delete an application");
  const canChangeMembers = permitAdmin(user.isAdmin, "change who is in an application");

  return (
    <>
      {/* No "← Applications" link and no name in this panel's title: the shell draws the trail and
          the page title. */}
      <Panel title="What it owns">
        <div className="ownership-summary">{Object.entries(application.owns).map(([kind, count]) => <div key={kind}><strong>{count}</strong><span>{kind === "resources" ? "APIs" : kind === "processes" ? "Process records" : kind}</span></div>)}</div>
        {user.isAdmin && (
          <dl className="kv">
            <dt>Granted by the group</dt>
            <dd className="mono">{application.sourceGroup ?? "—"}</dd>
          </dl>
        )}
        {user.isAdmin && <EditApplication application={application} onSaved={detail.reload} />}
      </Panel>

      {/* Membership is managed here as well as on each person's page. It could only be changed
          from the person's side, so an administrator looking at an application with nobody in it
          was sent to the People list to find somebody and add them from there. Same endpoints,
          same removal dialog (`RemoveMembership`), so the two sides cannot disagree. */}
      <Panel
        title="Who is in it"
        hint="Granted here, or from an identity provider group. One from a group returns while the person is still in that group."
      >
        <Notice kind="warn">{removalNote}</Notice>
        {application.members.length === 0 ? (
          <EmptyState
            title="Nobody is in this application"
            detail="Nobody can publish or change what it owns until somebody is."
            action={user.isAdmin ? <button className="btn" onClick={() => document.getElementById("add-member-search")?.focus()}>Add somebody</button> : <Link to="/account">View your memberships</Link>}
          />
        ) : (
          <table>
            <thead>
              <tr>
                <th>Person</th>
                <th>How</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {application.members.map((member) => (
                <tr key={member.userId}>
                  <td>
                    {user.isAdmin ? (
                      <Link to={`/users/${member.userId}`}>{member.displayName}</Link>
                    ) : (
                      member.displayName
                    )}
                  </td>
                  <td className="muted">
                    {member.source === "idp" ? (
                      <>
                        From a group in the{" "}
                        <Term name="identity provider">identity provider</Term>
                      </>
                    ) : (
                      <>
                        Granted here
                        {member.grantedByName ? ` by ${member.grantedByName}` : ""}
                        {member.grantedAt
                          ? ` on ${formatDate(member.grantedAt)}`
                          : ""}
                      </>
                    )}
                  </td>
                  <td className="right">
                    {/* Disabled rather than absent for a member: the reason is drawn once, beside
                        the Add control below, rather than on every row. */}
                    <button
                      className="btn sm"
                      disabled={!canChangeMembers.enabled}
                      title={canChangeMembers.reason ?? undefined}
                      onClick={() => setRemoving(member)}
                    >
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <AddMember
          applicationId={application.id}
          members={application.members.map((member) => member.userId)}
          permission={canChangeMembers}
          onAdded={() => {
            setRemovalNote(null);
            detail.reload();
          }}
        />
        {removing && (
          <RemoveMembership
            userId={removing.userId}
            userName={removing.displayName}
            applicationId={application.id}
            applicationName={application.name}
            fromIdp={removing.source === "idp"}
            close={() => setRemoving(null)}
            onRemoved={(note) => {
              setRemoving(null);
              setRemovalNote(note);
              detail.reload();
            }}
          />
        )}
      </Panel>

      {user.isAdmin && (
        <Panel title="Delete this application">
          {total > 0 ? (
            <p className="muted">
              It still owns {total} {total === 1 ? "thing" : "things"}. Move or withdraw those first —
              deleting an application is not a way to delete published APIs.
            </p>
          ) : (
            <DangerZone
              what={`Delete ${application.name}`}
              name={application.name}
              consequence={`Everybody in it stops being a member. Nothing is published under it, so nothing stops serving.`}
              permission={canManage.enabled ? ALLOWED : canManage}
              busy={action.busy}
              error={action.error}
              onConfirm={async () => {
                const ok = await action.run(() => api.del(`/api/applications/${application.id}`));
                if (ok) go("/applications");
              }}
            />
          )}
        </Panel>
      )}
    </>
  );
}

/**
 * Finding somebody to add, from the application's side. A search rather than a list of everybody,
 * because the directory is every account that ever signed in; at least two characters, because one
 * matches half of it.
 */
function AddMember({
  applicationId,
  members,
  permission,
  onAdded,
}: {
  applicationId: string;
  members: string[];
  permission: ReturnType<typeof permitAdmin>;
  onAdded: () => void;
}) {
  const [query, setQuery] = useState("");
  const term = query.trim();
  const searching = permission.enabled && term.length >= 2;
  const found = useAsync(
    () =>
      searching
        ? api.get<{ items: DirectoryUser[] }>(`/api/users?limit=10&q=${encodeURIComponent(term)}`)
        : Promise.resolve(null),
    [term, searching],
    `${term}:${searching}`,
  );
  const action = useAction();
  const candidates = (found.data?.items ?? []).filter(
    (person) => !members.includes(person.id) && !person.disabled,
  );

  if (!permission.enabled) {
    return (
      <div className="native-actions">
        <Action permission={permission} onClick={() => {}}>
          Add somebody
        </Action>
      </div>
    );
  }
  return (
    <div className="subcard">
      <TextField
        inputId="add-member-search"
        label="Add somebody"
        value={query}
        onChange={setQuery}
        placeholder="Name, username or email"
        hint="Type at least two characters."
      />
      <Notice kind="error">{found.error ?? action.error}</Notice>
      {searching &&
        (found.loading ? (
          <Skeleton rows={2} />
        ) : candidates.length === 0 ? (
          <p className="muted small">Nobody else matches “{term}”.</p>
        ) : (
          <div className="native-list">
            {candidates.map((person) => (
              <div className="native-row" key={person.id}>
                <div>
                  <strong>{person.displayName}</strong>
                  <small className="mono">{person.username}</small>
                </div>
                <button
                  className="btn sm"
                  disabled={action.busy}
                  onClick={async () => {
                    const ok = await action.run(() =>
                      api.put(`/api/users/${person.id}/applications/${applicationId}`),
                    );
                    if (ok) {
                      setQuery("");
                      onAdded();
                    }
                  }}
                >
                  Add
                </button>
              </div>
            ))}
          </div>
        ))}
    </div>
  );
}
function EditApplication({ application, onSaved }: { application: ApplicationDetail; onSaved: () => void }) {
  const [name, setName] = useState(application.name);
  const [group, setGroup] = useState(application.sourceGroup ?? "");
  const action = useAction();
  const changed = name !== application.name || group !== (application.sourceGroup ?? "");

  return (
    <div className="subcard">
      <Notice kind="error">{action.error}</Notice>
      <div className="row">
        <TextField label="Name" value={name} onChange={setName} />
        <TextField label="Identity provider group" value={group} onChange={setGroup} />
      </div>
      <button
        className="btn primary"
        disabled={action.busy || !changed || name.trim().length < 2}
        onClick={async () => {
          const ok = await action.run(() =>
            api.patch(`/api/applications/${application.id}`, { name: name.trim(), sourceGroup: group.trim() || null }, "*"),
          );
          if (ok) onSaved();
        }}
      >
        Save
      </button>
      {group !== (application.sourceGroup ?? "") && (
        <p className="muted small">
          Nobody moves now; it applies at each person's next sign-in or claim refresh.
        </p>
      )}
    </div>
  );
}
