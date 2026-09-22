import { useState } from "react";
import type { Session } from "../App";
import { api } from "../api";
import {
  EmptyState,
  Field,
  Notice,
  Panel,
  Skeleton,
  StatusChip,
  useAction,
  useAsync,
} from "../components";
import { formatAgo, formatDateTime } from "../lib/datetime";
import { integrationEventChip } from "../lib/status";

/**
 * External systems — the administrator's console for the systems around the portal.
 *
 * The screen this replaced was offered to every member, was scoped to one application, and listed
 * three buttons and a history of raw JSON; the six systems its own purpose line promised were not
 * on it. A member meets each of those systems where it matters to them — an approval, a mail, a
 * FixMe run on Health Status — so this is an administrator's screen, and what it answers is the
 * operator's question: which systems are there, is each real or simulated, and what did each last
 * get asked, and answer (integrations-and-mocks: the external systems screen).
 */

interface System {
  name: string;
  mode: string;
  simulated: boolean;
  direction: "outbound" | "read";
  detail?: string;
}

interface Exchange {
  id: string;
  application_id: string;
  integration: string;
  kind: string;
  subject: string;
  state: Parameters<typeof integrationEventChip>[0];
  attempts: number;
  created_at: string;
  updated_at: string;
  payload: unknown;
  result: unknown;
}

/** What each system is, in the words a reader of this screen uses. Closed, like the list itself. */
const SYSTEMS: Record<string, { label: string; role: string }> = {
  kafka: { label: "Kafka", role: "Creates topics and grants produce and consume access to them." },
  skonet: { label: "SkoNET", role: "Holds each access request until the publisher approves or rejects it." },
  email: { label: "Email", role: "Delivers the messages the portal composes — requests, decisions, finished deployments." },
  ldapws: { label: "LdapWS directory", role: "Looks up the people responsible for an application." },
  fixme: { label: "FixMe", role: "Diagnoses an application's deployment and repairs it. Run from Health Status." },
  leanix: { label: "LeanIX", role: "Supplies each application's business metadata: its id, description and owner." },
  elk: { label: "Log search", role: "Searches the gateways' access logs for the Logs tab of an API." },
};

function systemLabel(name: string): string {
  return SYSTEMS[name]?.label ?? name;
}

/** `subscription.request` → "Subscription request". The kinds are the outbox's, not a vocabulary. */
function describeKind(kind: string): string {
  const words = kind.replace(/[.\-_]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const PAGE = 50;

export function ExternalSystemsView({ session: s }: { session: Session }) {
  const systems = useAsync(() => api.get<{ items: System[] }>("/api/integrations"), []);
  const exchanges = useAsync(() => api.get<{ items: Exchange[] }>("/api/integration-events"), []);
  const [filter, setFilter] = useState("all");
  const [shown, setShown] = useState(PAGE);
  const all = exchanges.data?.items ?? [];
  const rows = filter === "all" ? all : all.filter((event) => event.integration === filter);

  return (
    <>
      <Panel title="Systems" flush>
        <Notice kind="error">{systems.error}</Notice>
        {systems.loading && !systems.data ? (
          <Skeleton rows={4} />
        ) : (
          <table>
            <thead>
              <tr>
                <th scope="col">System</th>
                <th scope="col">What the portal uses it for</th>
                <th scope="col">Connection</th>
                <th scope="col">Last exchange</th>
              </tr>
            </thead>
            <tbody>
              {(systems.data?.items ?? []).map((system) => {
                const last = all.find((event) => event.integration === system.name);
                const retrying = all.filter(
                  (event) => event.integration === system.name && event.state === "retrying",
                ).length;
                return (
                  <tr key={system.name}>
                    <th scope="row">{systemLabel(system.name)}</th>
                    <td>
                      {SYSTEMS[system.name]?.role ?? "—"}
                      {system.detail && <div className="muted small">{system.detail}</div>}
                    </td>
                    <td>
                      <span className={`chip ${system.simulated ? "neutral" : "ok"}`}>
                        {system.simulated ? "Simulated" : "Connected"}
                      </span>
                    </td>
                    <td>
                      {system.direction === "read" ? (
                        <span className="muted">Read on demand, not recorded here</span>
                      ) : last ? (
                        <>
                          <StatusChip chip={integrationEventChip(last.state)} />{" "}
                          <span className="muted small" title={formatDateTime(last.updated_at)}>
                            {formatAgo(last.updated_at)}
                          </span>
                          {retrying > 0 && (
                            <div className="small">{retrying} retrying now</div>
                          )}
                        </>
                      ) : (
                        <span className="muted">Nothing asked yet</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Panel>

      <AskPanel session={s} onAsked={exchanges.reload} />

      <Panel
        title="Recent exchanges"
        hint="The latest 500 requests the portal made, newest first. Open one to see what was sent and what came back."
        actions={
          <Field label="System">
            <select
              value={filter}
              onChange={(event) => {
                setFilter(event.target.value);
                setShown(PAGE);
              }}
            >
              <option value="all">All systems</option>
              {Object.entries(SYSTEMS)
                .filter(([name]) => name !== "elk")
                .map(([name, system]) => (
                  <option key={name} value={name}>
                    {system.label}
                  </option>
                ))}
            </select>
          </Field>
        }
      >
        <Notice kind="error">{exchanges.error}</Notice>
        {exchanges.loading && !exchanges.data ? (
          <Skeleton rows={4} />
        ) : rows.length === 0 ? (
          !exchanges.error && (
            <EmptyState
              title={filter === "all" ? "Nothing has been asked yet" : `Nothing asked of ${systemLabel(filter)} yet`}
              detail="Requests appear here as the portal makes them: a subscription asks SkoNET, a decision sends email, a new application asks LeanIX."
              action={
                filter === "all" ? (
                  <button type="button" className="btn" onClick={exchanges.reload}>
                    Check again
                  </button>
                ) : (
                  <button type="button" className="btn" onClick={() => setFilter("all")}>
                    Show every system
                  </button>
                )
              }
            />
          )
        ) : (
          <>
            <div className="native-list">
              {rows.slice(0, shown).map((event) => (
                <details className="native-event" key={event.id}>
                  <summary>
                    <strong>{systemLabel(event.integration)}</strong> · {describeKind(event.kind)}
                    {" · "}
                    <span className="muted">{s.applicationName(event.application_id)}</span>{" "}
                    <StatusChip chip={integrationEventChip(event.state)} />{" "}
                    <span className="muted small" title={formatDateTime(event.created_at)}>
                      {formatAgo(event.created_at)}
                    </span>
                  </summary>
                  <div className="native-form-grid">
                    <div>
                      <h4>Sent</h4>
                      <pre>{JSON.stringify(event.payload, null, 2)}</pre>
                    </div>
                    <div>
                      <h4>Answered</h4>
                      <pre>
                        {event.result === null
                          ? "No answer yet."
                          : JSON.stringify(event.result, null, 2)}
                      </pre>
                    </div>
                  </div>
                  {event.attempts > 1 && (
                    <p className="muted small">Delivered on attempt {event.attempts}.</p>
                  )}
                </details>
              ))}
            </div>
            {rows.length > shown && (
              <button type="button" className="btn" onClick={() => setShown(shown + PAGE)}>
                Show {Math.min(PAGE, rows.length - shown)} more of {rows.length - shown}
              </button>
            )}
          </>
        )}
      </Panel>
    </>
  );
}

/**
 * The two lookups an administrator may want to repeat by hand: LeanIX's metadata and the
 * directory's contacts, both of which the portal otherwise asks for on its own when an application
 * is created or requests access.
 */
function AskPanel({ session: s, onAsked }: { session: Session; onAsked: () => void }) {
  const [application, setApplication] = useState(s.application);
  const ask = useAction();
  const target = application || s.applications[0]?.id || "";
  return (
    <Panel
      title="Ask again"
      hint="The portal asks these on its own when an application is created or requests access. Ask again when an answer is out of date."
    >
      <div className="native-actions">
        <Field label="Application">
          <select value={target} onChange={(event) => setApplication(event.target.value)}>
            {s.applications.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.name}
              </option>
            ))}
          </select>
        </Field>
        {(["leanix", "ldapws"] as const).map((system) => (
          <button
            key={system}
            type="button"
            className="btn"
            disabled={ask.busy || !target}
            onClick={() =>
              void ask.run(async () => {
                await api.post(`/api/applications/${encodeURIComponent(target)}/integrations/${system}`, {});
                onAsked();
              }, `${systemLabel(system)} was asked about ${s.applicationName(target)}. Its answer appears below.`)
            }
          >
            {system === "leanix" ? "Refresh LeanIX metadata" : "Look up contacts"}
          </button>
        ))}
      </div>
      <Notice kind="error">{ask.error}</Notice>
      <Notice kind="ok">{ask.message}</Notice>
    </Panel>
  );
}
