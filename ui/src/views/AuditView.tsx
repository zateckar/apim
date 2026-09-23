import { api } from "../api";
import { useState } from "react";
import { Refresh } from "../portal/icons";
import { Panel, Link, Notice, Skeleton, EmptyState, StatusChip, TextField, useAsync } from "../components";
import { formatDateTime } from "../lib/datetime";
import { auditOutcomeChip } from "../lib/status";

interface AuditRow {
  id: string;
  at: string;
  actor: string;
  /** The principal's display name, or the stored id when nobody by that id exists any more. */
  actorName?: string;
  action: string;
  subject: string;
  /** The subject's name for the kinds that have one; `null` when it is gone or never had one. */
  subjectName?: string | null;
  outcome: string;
  detail: string | null;
}

/** How many the control plane is asked for, and what the search is stated to cover. */
const LOADED = 200;
/** How many rows are drawn at a time. Two hundred rows of a wide table is a page nobody scans. */
export const PAGE = 50;

/**
 * Where a subject can be looked at, from the `kind:id` the audit row stores. Only the kinds with a
 * screen of their own get a link; the rest are named or shown as stored, because a link to a place
 * that cannot show the thing is worse than none.
 */
export function subjectHref(subject: string): string | null {
  const at = subject.indexOf(":");
  if (at <= 0) return null;
  const kind = subject.slice(0, at);
  const id = encodeURIComponent(subject.slice(at + 1));
  switch (kind) {
    case "resource":
      return `/apis/${id}`;
    case "application":
      return `/applications/${id}`;
    case "user":
      return `/users/${id}`;
    default:
      return null;
  }
}

/** The loaded rows a search keeps: names as well as the ids, since the names are what is shown. */
export function matchAudit(rows: AuditRow[], query: string): AuditRow[] {
  const wanted = query.trim().toLowerCase();
  if (!wanted) return rows;
  return rows.filter((row) =>
    [row.actor, row.actorName, row.action, row.subject, row.subjectName, row.outcome]
      .filter(Boolean)
      .join(" ")
      .toLowerCase()
      .includes(wanted),
  );
}

export function AuditView() {
  const audit = useAsync(() => api.get<{ items: AuditRow[] }>(`/api/audit?limit=${LOADED}`), []);
  const [query, setQuery] = useState("");
  const [shown, setShown] = useState(PAGE);
  const loaded = audit.data?.items ?? [];
  const rows = matchAudit(loaded, query);
  const visible = rows.slice(0, shown);

  return (
    <>
      <div className="directory-toolbar audit-toolbar">
        <TextField
          label="Search recent events"
          value={query}
          onChange={(next) => {
            setQuery(next);
            // A new search starts at its own first page, not wherever the last one was scrolled to.
            setShown(PAGE);
          }}
          placeholder="Actor, action, subject or outcome"
        />
        <span className="muted small">
          {query.trim() ? `${rows.length} matching of ` : ""}the latest {loaded.length} events · search covers at most {LOADED}
        </span>
        <button type="button" className="btn" onClick={audit.reload}><Refresh /> Refresh events</button>
      </div>
      {/* The failure is said once, here; the table is not drawn under it, so nothing claims the
          audit is empty when it could not be read (`platform-administration`, *Directory or audit
          reads fail*). */}
      <Notice kind="error">{audit.error}</Notice>
      {!audit.error && (
        <Panel>
          {audit.loading && !audit.data ? <Skeleton rows={5} /> : loaded.length === 0 ? (
            <EmptyState title="No audit events yet" detail="Sign-ins and changes to the platform appear here." action={<button type="button" className="btn sm" onClick={audit.reload}>Refresh events</button>} />
          ) : rows.length === 0 ? <EmptyState title="No matching events" detail={`Search covers the latest ${LOADED} events loaded here.`} action={<button type="button" className="btn" onClick={() => setQuery("")}>Clear search</button>} /> : (
            <>
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
                  {visible.map((row) => (
                    <AuditLine key={row.id} row={row} />
                  ))}
                </tbody>
              </table>
              <div className="native-actions">
                <span className="muted small">
                  Showing {visible.length} of {rows.length}
                </span>
                {visible.length < rows.length && (
                  <button type="button" className="btn sm" onClick={() => setShown(shown + PAGE)}>
                    Show {Math.min(PAGE, rows.length - visible.length)} more
                  </button>
                )}
              </div>
            </>
          )}
        </Panel>
      )}
    </>
  );
}

/**
 * One event. The name is what a person reads and the id is what they search the logs for, so both
 * are here — the name first, the id beneath it in the monospace secondary line `[P2-03]`.
 */
function AuditLine({ row }: { row: AuditRow }) {
  const actorNamed = row.actorName && row.actorName !== row.actor;
  const subjectLink = subjectHref(row.subject);
  const subjectLabel = row.subjectName ?? row.subject;
  return (
    <tr>
      <td className="muted">{formatDateTime(row.at)}</td>
      <td>
        {actorNamed ? (
          <>
            <Link to={`/users/${encodeURIComponent(row.actor)}`}>{row.actorName}</Link>
            <div className="mono small muted">{row.actor}</div>
          </>
        ) : (
          <span className="mono">{row.actor}</span>
        )}
      </td>
      <td className="mono">{row.action}</td>
      <td>
        {row.subjectName ? (
          <>
            {subjectLink ? <Link to={subjectLink}>{subjectLabel}</Link> : subjectLabel}
            <div className="mono small muted">{row.subject}</div>
          </>
        ) : (
          <span className="mono muted">{row.subject}</span>
        )}
      </td>
      <td>
        <StatusChip chip={auditOutcomeChip(row.outcome)} />
      </td>
      <td className="audit-detail">
        {row.detail ? <details><summary>View details</summary><pre>{row.detail}</pre></details> : <span className="muted">—</span>}
      </td>
    </tr>
  );
}
