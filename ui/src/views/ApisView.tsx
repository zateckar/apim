import { useState } from "react";
import { api, type Meta, type Resource, type User } from "../api";
import {
  Card,
  EmptyState,
  Field,
  Link,
  Notice,
  Skeleton,
  StatusChip,
  Term,
  useAsync,
} from "../components";
import { lifecycleChip } from "../lib/status";

/**
 * My APIs (plan §9.7).
 *
 * Grouped by **family** — team plus name — because two versions of one API are two rows that share
 * a name, and a flat list of "petstore, petstore, petstore" tells a reader nothing about which one
 * their callers are on. Each row says where that version is live, which is the fact an owner is
 * usually looking for and which v3 made them open the API to find.
 */
export function ApisView({ user, meta }: { user: User; meta: Meta }) {
  const [query, setQuery] = useState("");
  const [mine, setMine] = useState(true);
  const list = useAsync(
    () =>
      api.get<{ items: Resource[] }>(
        `/api/resources?q=${encodeURIComponent(query)}${mine ? "&team=mine" : ""}`,
      ),
    [query, mine],
  );

  if (list.error) return <Notice kind="error">{list.error}</Notice>;
  if (!list.data) return <Skeleton rows={5} />;

  const families = new Map<string, Resource[]>();
  for (const resource of list.data.items) {
    families.set(resource.family, [...(families.get(resource.family) ?? []), resource]);
  }

  return (
    <>
      <div className="spread" style={{ marginBottom: 14 }}>
        <div className="inline">
          <Field label="Search" value={query} onChange={setQuery} placeholder="name contains…" />
          <label className="check-inline" style={{ marginTop: 18 }}>
            <input type="checkbox" checked={mine} onChange={(event) => setMine(event.target.checked)} />
            only my teams'
          </label>
        </div>
        <Link to="/apis/new" className="chip active">
          Publish an API
        </Link>
      </div>

      {families.size === 0 ? (
        <EmptyState
          title={query ? "Nothing matches that" : "Your teams have not published anything yet"}
          detail={
            query
              ? "Try a shorter search, or untick “only my teams’”."
              : "Publishing takes three steps: the definition, where it answers, and a release. Nothing is live until the last one."
          }
          action={<Link to="/apis/new">Publish your first API →</Link>}
        />
      ) : (
        [...families.entries()].map(([family, versions]) => (
          <Card key={family} title={versions[0]!.name} hint={`Owned by ${versions[0]!.teamId}`}>
            <table>
              <thead>
                <tr>
                  <th>
                    <Term name="version" />
                  </th>
                  <th>Kind</th>
                  <th>State</th>
                  <th>Live in</th>
                  <th>Summary</th>
                </tr>
              </thead>
              <tbody>
                {versions.map((resource) => (
                  <tr key={resource.id}>
                    <td>
                      <Link to={`/apis/${resource.id}`}>
                        <strong>{resource.apiVersion}</strong>
                      </Link>
                    </td>
                    <td>
                      <span className={`badge kind-${resource.kind}`}>{resource.kind}</span>
                    </td>
                    <td>
                      <StatusChip chip={lifecycleChip(resource.lifecycle as never)} />
                      {resource.lifecycle === "active" && <span className="muted small">current</span>}
                    </td>
                    <td>
                      {(resource.liveIn ?? []).length === 0 ? (
                        <span className="muted">
                          nowhere —{" "}
                          <Link to={`/apis/${resource.id}/publish`}>publish it</Link>
                        </span>
                      ) : (
                        (resource.liveIn ?? []).map((environment) => (
                          <span key={environment} className="pill ok">
                            {environment}
                          </span>
                        ))
                      )}
                    </td>
                    <td className="muted small">
                      {resource.summary ?? (
                        <Link to={`/apis/${resource.id}/listing`}>Write a summary</Link>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        ))
      )}

      <p className="muted small">
        Implemented kinds: <span className="mono">{meta.kinds.join(", ")}</span>. Every one of them
        is an API with a <Term name="definition" />, a <Term name="route" /> and a{" "}
        <Term name="backend" />; what differs is where the contract came from.
        {user.isAdmin && " You are an administrator, so this list can show every team's."}
      </p>
    </>
  );
}
