import { listAll } from "../portal/client";
import * as I from "../portal/icons";
import { formatDate } from "../lib/datetime";
import { useState } from "react";
import { api, type ApplicationDetail, type ApplicationRow, type User } from "../api";
import {
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
} from "../components";
import { ALLOWED, permitAdmin } from "../lib/capabilities";

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
        {list.loading && <Skeleton rows={3} />}
        {!list.loading && !list.error && rows.length === 0 ? (
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
                    {application.mine && <span className="pill ok">yours</span>}
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
        <Panel
          title="Groups that could not be provisioned"
          hint="Your identity provider put somebody in these. An application is normally created from a group automatically; these are the ones that could not be."
        >
          <p className="muted">
            A group names an application and provisions one on sign-in, so this list is short by
            design: a group reaches it only when the name it would take is already held by an
            application bound to a <strong>different</strong> group, or when there is no usable name
            in it at all. Map one to an existing application on its own page, or create an
            application for it here.
          </p>
          <ul className="plain">
            {unmappedGroups.map((group) => (
              <li key={group}>
                <span className="mono">{group}</span>{" "}
                <button className="ghost small" onClick={() => setCreating(group)}>
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
        With a group set, anybody the directory puts in it is a member of this application at their next
        sign-in — and stops being one when they are removed from it. Without one, membership is
        granted here and only here.
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
        <button className="ghost" onClick={() => onDone(false)}>
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

  if (detail.loading) return <Skeleton rows={5} />;
  if (detail.error || !detail.data) return <Notice kind="error">{detail.error}</Notice>;

  const application = detail.data;
  const total = Object.values(application.owns).reduce((sum, n) => sum + n, 0);
  const canManage = permitAdmin(user.isAdmin, "change or delete an application");

  return (
    <>
      <div className="page-toolbar"><Link to="/applications">← Applications</Link></div>
      <Panel title={application.name}>
        <Notice kind="error">{action.error}</Notice>
        {action.message && <Notice kind="ok">{action.message}</Notice>}
        <div className="ownership-summary">{Object.entries(application.owns).map(([kind, count]) => <div key={kind}><strong>{count}</strong><span>{kind === "resources" ? "APIs" : kind === "processes" ? "Process records" : kind}</span></div>)}</div>
        <dl className="kv">
          {user.isAdmin && (
            <>
              <dt>Granted by the group</dt>
              <dd className="mono">{application.sourceGroup ?? "—"}</dd>
            </>
          )}
        </dl>
        {user.isAdmin && <EditApplication application={application} onSaved={detail.reload} />}
      </Panel>

      <Panel
        title="Who is in it"
        hint="A membership granted here survives a directory that has never heard of this application. One that came from a group comes back whenever that group still contains the person."
      >
        {application.members.length === 0 ? (
          <EmptyState
            title="Nobody is in this application"
            detail="Nobody can publish or change what it owns until somebody is."
            action={<Link to="/users">Find somebody to add →</Link>}
          />
        ) : (
          <table>
            <thead>
              <tr>
                <th>Person</th>
                <th>How</th>
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
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>

      {user.isAdmin && (
        <Panel title="Delete this application">
          {total > 0 ? (
            <p className="muted">
              It still owns {total} thing(s). Move or withdraw those first — deleting an application must
              not be a way to delete published APIs.
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
        className="ghost"
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
          Changing the group does not move anybody now. It takes effect at each person's next
          sign-in or claim refresh.
        </p>
      )}
    </div>
  );
}
