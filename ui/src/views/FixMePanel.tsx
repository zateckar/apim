import { useEffect, useState } from "react";
import type { Session } from "../App";
import { api } from "../api";
import {
  EmptyState,
  Link,
  Notice,
  Panel,
  Segmented,
  Skeleton,
  StatusChip,
  envLabel,
  useAction,
  useAsync,
} from "../components";
import { formatDateTime } from "../lib/datetime";
import { integrationEventChip } from "../lib/status";

/**
 * FixMe, as a section of Health Status.
 *
 * FixMe diagnoses one application's deployment in one environment and repairs what it finds, then
 * verifies the repair. It had a sidebar entry and a screen of its own, which made it read as a
 * separate product — but "is this environment healthy, and if not, can it be made so" is one
 * question, and the reader asking it is already here. The run is the application's (the control
 * plane checks membership), so the section names the application it will run for.
 *
 * Simulated in this phase: the steps are recorded and nothing outside the portal changes, and the
 * section says so in its own words rather than leaving it to the chip in the top bar.
 */

interface FixMeEvent {
  id: string;
  integration: string;
  kind: string;
  state: Parameters<typeof integrationEventChip>[0];
  created_at: string;
  updated_at: string;
  attempts: number;
  payload: { environment?: string } | null;
  result: {
    simulated?: boolean;
    reference?: string;
    summary?: string;
    steps?: Array<{ name: string; state: string }>;
  } | null;
}

/** A run still in the outbox. While one is, the section re-reads every few seconds on its own. */
const PENDING = new Set(["queued", "retrying"]);

export function FixMePanel({ session: s }: { session: Session }) {
  const [environment, setEnvironment] = useState(s.environment);
  const application = s.application;
  const runs = useAsync(
    () =>
      application
        ? api.get<{ items: FixMeEvent[] }>(
            `/api/integration-events?applicationId=${encodeURIComponent(application)}`,
          )
        : Promise.resolve({ items: [] as FixMeEvent[] }),
    [application],
    application,
  );
  const run = useAction();
  const items = (runs.data?.items ?? []).filter((event) => event.integration === "fixme");
  const pending = items.some((event) => PENDING.has(event.state));

  useEffect(() => {
    if (!pending) return;
    const id = setTimeout(runs.reload, 2000);
    return () => clearTimeout(id);
  }, [pending, runs.data]);

  if (!application) {
    return (
      <Panel title="Diagnose and repair">
        <EmptyState
          title="You are not in an application yet"
          detail="FixMe runs for one application's deployment, and you can run it for the applications you are a member of."
          action={<Link to="/account">See your applications →</Link>}
        />
      </Panel>
    );
  }

  const name = s.applicationName(application);
  return (
    <Panel
      title="Diagnose and repair"
      hint={`FixMe inspects ${name}'s deployment in one environment, repairs what it finds and checks that the repair held. Simulated in this phase: every step is recorded and nothing outside the portal is changed.`}
    >
      <div className="native-actions fixme-run">
        <Segmented
          label="Environment to diagnose"
          value={environment}
          onChange={setEnvironment}
          options={s.meta.chain.map((stage) => ({ value: stage, label: envLabel(stage) }))}
        />
        <button
          type="button"
          className="btn primary"
          disabled={run.busy}
          onClick={() =>
            void run.run(async () => {
              await api.post(`/api/applications/${encodeURIComponent(application)}/integrations/fixme`, {
                environment,
              });
              runs.reload();
            })
          }
        >
          {run.busy ? "Starting…" : `Diagnose ${name} in ${envLabel(environment)}`}
        </button>
      </div>
      <Notice kind="error">{run.error}</Notice>
      <Notice kind="error">{runs.error}</Notice>

      <h4>Earlier runs for {name}</h4>
      {runs.loading && !runs.data ? (
        <Skeleton rows={2} />
      ) : items.length === 0 ? (
        // A sentence rather than an empty state: the action it would offer is the button above.
        !runs.error && <p className="muted">No run yet. Each run's steps and outcome are kept here.</p>
      ) : (
          <table>
            <thead>
              <tr>
                <th scope="col">Started</th>
                <th scope="col">Environment</th>
                <th scope="col">State</th>
                <th scope="col">What it did</th>
              </tr>
            </thead>
            <tbody>
              {items.map((event) => (
                <tr key={event.id}>
                  <td>{formatDateTime(event.created_at)}</td>
                  <td>{envLabel(event.payload?.environment)}</td>
                  <td>
                    <StatusChip chip={integrationEventChip(event.state)} />
                    {event.state === "retrying" && (
                      <span className="muted small"> attempt {event.attempts}</span>
                    )}
                  </td>
                  <td>
                    {event.result?.steps ? (
                      <ol className="fixme-steps">
                        {event.result.steps.map((step) => (
                          <li key={step.name}>
                            {step.name}
                            {step.state !== "complete" && <span className="muted"> — {step.state}</span>}
                          </li>
                        ))}
                      </ol>
                    ) : (
                      <span className="muted">Waiting for FixMe to pick it up.</span>
                    )}
                    {event.result?.summary && <p className="muted small">{event.result.summary}</p>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
      )}
    </Panel>
  );
}
