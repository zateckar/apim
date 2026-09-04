import { useState } from "react";
import { api, type TeamDetail, type TeamRow, type User } from "../api";
import {
  Card,
  DangerZone,
  EmptyState,
  Field,
  Link,
  Notice,
  Skeleton,
  Term,
  useAction,
  useAsync,
} from "../components";
import { ALLOWED, permitAdmin } from "../lib/capabilities";

/**
 * Teams (v5 plan §8).
 *
 * A team is the unit of ownership, and until v5 it existed only as a switcher in the sidebar with
 * no screen behind it: no way to see who was in one, no way to create one, and no way to find out
 * that a team's membership was coming from an identity provider group. All three were things
 * somebody had to be told.
 *
 * `sourceGroup` is shown to administrators only `[P1-18]`. Team names are already a discovery
 * surface, but which group grants a team tells any signed-in user exactly which group to get
 * themselves added to in order to own another team's APIs.
 */
export function TeamsView({ user, unmappedGroups }: { user: User; unmappedGroups: string[] }) {
  const list = useAsync(() => api.get<{ items: TeamRow[] }>("/api/teams"), []);
  const [creating, setCreating] = useState<string | null>(null);
  const rows = list.data?.items ?? [];

  return (
    <>
      <Card
        title="Who owns what"
        hint="Every API, product and application belongs to exactly one team. Being in that team is what lets you change them."
      >
        <Notice kind="error">{list.error}</Notice>
        {list.loading && <Skeleton rows={3} />}
        {!list.loading && rows.length === 0 ? (
          <EmptyState
            title="No teams yet"
            detail="Nothing can be published until there is a team to own it."
            action={
              <button className="ghost" onClick={() => setCreating("")}>
                Create the first team
              </button>
            }
          />
        ) : (
          <table>
            <thead>
              <tr>
                <th>Team</th>
                <th>People</th>
                {user.isAdmin && <th>Granted by the group</th>}
              </tr>
            </thead>
            <tbody>
              {rows.map((team) => (
                <tr key={team.id}>
                  <td>
                    <Link to={`/teams/${team.id}`}>
                      <strong>{team.name}</strong>
                    </Link>
                    {team.mine && <span className="pill ok">yours</span>}
                  </td>
                  <td>{team.members}</td>
                  {user.isAdmin && (
                    <td className="muted mono">
                      {team.sourceGroup ?? <span className="muted">granted here only</span>}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {user.isAdmin && creating === null && (
          <button className="ghost" onClick={() => setCreating("")}>
            Create a team
          </button>
        )}
        {creating !== null && (
          <CreateTeam
            sourceGroup={creating}
            onDone={(created) => {
              setCreating(null);
              if (created) list.reload();
            }}
          />
        )}
      </Card>

      {user.isAdmin && unmappedGroups.length > 0 && (
        <Card
          title="Groups nothing here is mapped to"
          hint="Your identity provider put somebody in these. The portal matched them to no team, so they granted nothing."
        >
          <p className="muted">
            A group is <strong>matched</strong> to a team, never turned into one automatically —
            otherwise anybody holding a group in the directory could become the owner of a new
            scope. Map one to an existing team on its own page, or create a team for it here.
          </p>
          <ul className="plain">
            {unmappedGroups.map((group) => (
              <li key={group}>
                <span className="mono">{group}</span>{" "}
                <button className="ghost small" onClick={() => setCreating(group)}>
                  Create a team for it
                </button>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </>
  );
}

function CreateTeam({
  sourceGroup,
  onDone,
}: {
  sourceGroup: string;
  onDone: (created: boolean) => void;
}) {
  const [name, setName] = useState("");
  const [group, setGroup] = useState(sourceGroup);
  const action = useAction();

  return (
    <div className="subcard">
      <Notice kind="error">{action.error}</Notice>
      <div className="row">
        <Field label="Name" value={name} onChange={setName} placeholder="Orders" />
        <Field
          label="Identity provider group (optional)"
          value={group}
          onChange={setGroup}
          placeholder="SG-APIM-ORDERS"
        />
      </div>
      <p className="muted small">
        With a group set, anybody the directory puts in it is a member of this team at their next
        sign-in — and stops being one when they are removed from it. Without one, membership is
        granted here and only here.
      </p>
      <div className="row">
        <button
          className="primary"
          disabled={action.busy || name.trim().length < 2}
          onClick={async () => {
            const ok = await action.run(() =>
              api.post("/api/teams", {
                name: name.trim(),
                sourceGroup: group.trim() || undefined,
              }),
            );
            if (ok) onDone(true);
          }}
        >
          Create it
        </button>
        <button className="ghost" onClick={() => onDone(false)}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/** One team: who is in it, how they got there, and what stands in the way of deleting it. */
export function TeamView({ teamId, user }: { teamId: string; user: User }) {
  const detail = useAsync(() => api.get<TeamDetail>(`/api/teams/${teamId}`), [teamId]);
  const action = useAction();

  if (detail.loading) return <Skeleton rows={5} />;
  if (detail.error || !detail.data) return <Notice kind="error">{detail.error}</Notice>;

  const team = detail.data;
  const total = team.owns.resources + team.owns.products + team.owns.applications;
  const canManage = permitAdmin(user.isAdmin, "change or delete a team");

  return (
    <>
      <Card title={team.name}>
        <Notice kind="error">{action.error}</Notice>
        {action.message && <Notice kind="ok">{action.message}</Notice>}
        <dl className="kv">
          <dt>Owns</dt>
          <dd>
            {team.owns.resources} API(s), {team.owns.products} product(s),{" "}
            {team.owns.applications} application(s)
          </dd>
          {user.isAdmin && (
            <>
              <dt>Granted by the group</dt>
              <dd className="mono">{team.sourceGroup ?? "—"}</dd>
            </>
          )}
        </dl>
        {user.isAdmin && <EditTeam team={team} onSaved={detail.reload} />}
      </Card>

      <Card
        title="Who is in it"
        hint="A membership granted here survives a directory that has never heard of this team. One that came from a group comes back whenever that group still contains the person."
      >
        {team.members.length === 0 ? (
          <EmptyState
            title="Nobody is in this team"
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
              {team.members.map((member) => (
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
                          ? ` on ${new Date(member.grantedAt).toLocaleDateString()}`
                          : ""}
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {user.isAdmin && (
        <Card title="Delete this team">
          {total > 0 ? (
            <p className="muted">
              It still owns {total} thing(s). Move or withdraw those first — deleting a team must
              not be a way to delete published APIs.
            </p>
          ) : (
            <DangerZone
              what={`Delete ${team.name}`}
              name={team.name}
              consequence={`Everybody in it stops being a member. Nothing is published under it, so nothing stops serving.`}
              permission={canManage.enabled ? ALLOWED : canManage}
              busy={action.busy}
              error={action.error}
              onConfirm={async () => {
                const ok = await action.run(() => api.del(`/api/teams/${team.id}`));
                if (ok) window.history.pushState({}, "", "/teams");
              }}
            />
          )}
        </Card>
      )}
    </>
  );
}

function EditTeam({ team, onSaved }: { team: TeamDetail; onSaved: () => void }) {
  const [name, setName] = useState(team.name);
  const [group, setGroup] = useState(team.sourceGroup ?? "");
  const action = useAction();
  const changed = name !== team.name || group !== (team.sourceGroup ?? "");

  return (
    <div className="subcard">
      <Notice kind="error">{action.error}</Notice>
      <div className="row">
        <Field label="Name" value={name} onChange={setName} />
        <Field label="Identity provider group" value={group} onChange={setGroup} />
      </div>
      <button
        className="ghost"
        disabled={action.busy || !changed || name.trim().length < 2}
        onClick={async () => {
          const ok = await action.run(() =>
            api.patch(`/api/teams/${team.id}`, { name: name.trim(), sourceGroup: group.trim() || null }, "*"),
          );
          if (ok) onSaved();
        }}
      >
        Save
      </button>
      {group !== (team.sourceGroup ?? "") && (
        <p className="muted small">
          Changing the group does not move anybody now. It takes effect at each person's next
          sign-in or claim refresh.
        </p>
      )}
    </div>
  );
}
