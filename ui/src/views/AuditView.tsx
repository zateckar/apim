import { api } from "../api";
import { useState } from "react";
import { Refresh } from "../portal/icons";
import { Panel, Notice, Skeleton, EmptyState, TextField, useAsync } from "../components";
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
  const [query, setQuery] = useState("");
  const rows = (audit.data?.items ?? []).filter(row => `${row.actor} ${row.action} ${row.subject} ${row.outcome}`.toLowerCase().includes(query.trim().toLowerCase()));

  return (
    <>
      <div className="directory-toolbar audit-toolbar">
        <TextField label="Search recent events" value={query} onChange={setQuery} placeholder="Actor, action, subject or outcome" />
        <span className="muted small">{rows.length} of the latest {audit.data?.items.length ?? 0} events · up to 200</span>
        <button className="btn" onClick={audit.reload}><Refresh /> Refresh events</button>
      </div>
      <Notice kind="error">{audit.error}</Notice>
      <Panel flush>
        {audit.error ? <p className="muted">Audit events could not be loaded. Retry with Refresh events.</p> : audit.loading ? <Skeleton rows={5} /> : !audit.data?.items.length ? (
          <EmptyState title="No audit events yet" detail="Sign-ins and changes to the platform appear here." action={<button className="btn sm" onClick={audit.reload}>Refresh events</button>} />
        ) : rows.length === 0 ? <EmptyState title="No matching events" detail="Search covers the latest 200 events loaded here." action={<button className="btn" onClick={() => setQuery("")}>Clear search</button>} /> : (
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
            {rows.map((row) => (
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
