import { api } from "../api";
import { Panel, Notice, Skeleton, EmptyState, useAsync } from "../components";
import { formatDateTime } from "../lib/datetime";

interface AuditRow {
  id: string;
  at: string;
  actor: string;
  action: string;
  subject: string;
  outcome: string;
  detail: string | null;
}

export function AuditView() {
  const audit = useAsync(() => api.get<{ items: AuditRow[] }>("/api/audit?limit=200"), []);

  return (
    <>
      <p className="muted small">
        The latest 200 events. Open an event's details to inspect the recorded change.
      </p>
      <Notice kind="error">{audit.error}</Notice>
      <Panel flush>
        {audit.loading ? <Skeleton rows={5} /> : !audit.data?.items.length ? (
          <EmptyState title="No audit events yet" detail="Sign-ins and changes to the platform appear here." action={<button className="btn sm" onClick={audit.reload}>Refresh events</button>} />
        ) : (
        <table>
          <thead>
            <tr>
              <th>When</th>
              <th>Actor</th>
              <th>Action</th>
              <th>Subject</th>
              <th>Outcome</th>
              <th>Detail</th>
            </tr>
          </thead>
          <tbody>
            {(audit.data?.items ?? []).map((row) => (
              <tr key={row.id}>
                <td className="muted">{formatDateTime(row.at)}</td>
                <td>{row.actor}</td>
                <td className="mono">{row.action}</td>
                <td className="mono muted">{row.subject}</td>
                <td>
                  <span className={`badge ${row.outcome === "ok" ? "ok" : "off"}`}>{row.outcome}</span>
                </td>
                <td className="audit-detail">
                  {row.detail ? <details><summary>View details</summary><pre>{row.detail}</pre></details> : <span className="muted">—</span>}
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
