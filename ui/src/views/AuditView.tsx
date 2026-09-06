import { api } from "../api";
import { Panel, Notice, useAsync } from "../components";

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
        Append-only, enforced by the database itself: an UPDATE or DELETE on this table aborts. What
        is here is what happened.
      </p>
      <Notice kind="error">{audit.error}</Notice>
      <Panel>
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
                <td className="muted">{new Date(row.at).toLocaleTimeString()}</td>
                <td>{row.actor}</td>
                <td className="mono">{row.action}</td>
                <td className="mono muted">{row.subject}</td>
                <td>
                  <span className={`badge ${row.outcome === "ok" ? "ok" : "off"}`}>{row.outcome}</span>
                </td>
                <td className="mono muted" style={{ maxWidth: 380, wordBreak: "break-all" }}>
                  {row.detail}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
    </>
  );
}
