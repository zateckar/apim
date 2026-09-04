import { useState } from "react";
import {
  api,
  type DivergenceReport,
  type PlanEntry,
  type PromotionView,
  type ReleasePlan,
  type ResourceDetail,
  type User,
} from "../api";
import {
  Card,
  EmptyState,
  Link,
  Notice,
  Skeleton,
  StatusChip,
  Stepper,
  Term,
  useAction,
  useAsync,
} from "../components";
import { permit } from "../lib/capabilities";

/**
 * Promoting (plan §9.2, journey 2).
 *
 * Three steps, and the middle one is the whole point: **the plan, in words, before anything is
 * applied.** Only the contract travels along the chain; policies, routes, backends and
 * subscriptions belong to each environment — so a promotion has to create some of those for you,
 * and the list of what it will create is exactly what a person needs to see before agreeing.
 *
 * Confirming references the plan that was shown. The job recomputes it and refuses if it moved, so
 * the thing somebody approved is the thing that runs.
 */

const STEPS = ["Revision and target", "The plan", "Confirm"];

export function PromotionPanel({
  resource,
  user,
  onChanged,
}: {
  resource: ResourceDetail;
  user: User;
  onChanged: () => void;
}) {
  const promotion = useAsync(
    () => api.get<PromotionView>(`/api/resources/${resource.id}/promotion`),
    [resource.id, resource.updatedAt],
  );
  const action = useAction();
  const [pending, setPending] = useState<{ plan: ReleasePlan; planId: string; to: string } | null>(null);
  const [done, setDone] = useState<{ to: string; rev: number } | null>(null);
  const [revision, setRevision] = useState<number | "">("");
  const [reason, setReason] = useState("");
  const [breakGlass, setBreakGlass] = useState(false);

  const canPublish = permit("publish", resource.capabilities, { team: resource.teamId });
  const latest = promotion.data?.latestRev ?? null;
  const chosen = revision === "" ? latest : revision;

  if (promotion.error) return <Notice kind="error">{promotion.error}</Notice>;
  if (!promotion.data) return <Skeleton rows={4} />;
  if (resource.revisions.length === 0) {
    return (
      <EmptyState
        title="Nothing to promote"
        detail="This API has no definition yet, so there is no revision to move along the chain."
        action={<Link to={`/apis/${resource.id}/definition`}>Import a definition →</Link>}
      />
    );
  }

  if (done) {
    const next = promotion.data.items.find((item) => item.predecessor === done.to);
    return (
      <Card title={`Revision ${done.rev} is live in ${done.to.toUpperCase()}`}>
        <p className="muted">
          The gateways there pick it up at their next poll. Its <Term name="policy">policies</Term>,{" "}
          <Term name="route" /> and <Term name="backend" /> in {done.to.toUpperCase()} are that
          environment's own — the promotion created what was missing and left what was already there
          alone.
        </p>
        <div className="inline">
          <Link to={`/apis/${resource.id}/try?environment=${done.to}`}>Call it in {done.to.toUpperCase()} →</Link>
          <Link to={`/apis/${resource.id}/policies`}>Review its policies there</Link>
          {next && (
            <button
              onClick={() => {
                setDone(null);
                setPending(null);
              }}
            >
              Promote onward to {next.environment.toUpperCase()}
            </button>
          )}
        </div>
      </Card>
    );
  }

  return (
    <>
      <Card
        title="Promote along the chain"
        hint="Only the contract travels. Everything in the edited-in-place tier — policies, routes, backends, subscriptions — belongs to the environment it is in."
      >
        <Stepper steps={STEPS} current={pending ? 1 : 0} />
        <Notice kind="error">{action.error}</Notice>

        <div className="chain">
          {promotion.data.items.map((item) => (
            <div key={item.environment} className={`chain-step ${item.liveRev ? "live" : ""}`}>
              <h4>{item.environment}</h4>
              <div className="value">
                {item.liveRev ? `revision ${item.liveRev}` : <span className="muted">nothing live</span>}
              </div>
              <div className="muted small">
                {item.releasedAt ? new Date(item.releasedAt).toLocaleDateString() : "—"}
              </div>
              <div className="row wrap" style={{ marginTop: 6 }}>
                {!item.hasRoute && (
                  <StatusChip
                    chip={{ label: "No route", tone: "stop", title: "nothing can be matched here until one is set" }}
                  />
                )}
                {!item.hasBinding && (
                  <StatusChip
                    chip={{ label: "No backend", tone: "stop", title: "nothing to forward to until one is set" }}
                  />
                )}
                {item.predecessor && !item.eligible && (
                  <StatusChip
                    chip={{
                      label: `Needs ${item.predecessor.toUpperCase()}`,
                      tone: "wait",
                      title: `a revision reaches ${item.environment.toUpperCase()} by passing through ${item.predecessor.toUpperCase()} first`,
                    }}
                  />
                )}
              </div>
              <span className="action">
                <button
                  className="small"
                  disabled={!canPublish.enabled || action.busy || chosen === null}
                  title={canPublish.reason ?? undefined}
                  onClick={() =>
                    action.run(async () => {
                      const result = await api.post<{ planId: string; plan: ReleasePlan }>(
                        `/api/resources/${resource.id}/releases?dryRun=1`,
                        {
                          revision: chosen,
                          environment: item.environment,
                          skipChain: breakGlass,
                          reason: reason || undefined,
                        },
                      );
                      setPending({ plan: result.plan, planId: result.planId, to: item.environment });
                    })
                  }
                >
                  {item.predecessor ? `Promote revision ${chosen ?? "—"}` : `Publish revision ${chosen ?? "—"}`}
                </button>
              </span>
            </div>
          ))}
        </div>
        {canPublish.reason && <p className="action-reason">{canPublish.reason}</p>}

        <div className="row wrap" style={{ marginTop: 12 }}>
          <div className="field" style={{ maxWidth: 220 }}>
            <label htmlFor="promote-rev">
              <Term name="revision" /> to move
            </label>
            <select
              id="promote-rev"
              value={revision}
              onChange={(event) =>
                setRevision(event.target.value === "" ? "" : Number(event.target.value))
              }
            >
              <option value="">newest ({latest ?? "—"})</option>
              {resource.revisions.map((rev) => (
                <option key={rev.id} value={rev.rev}>
                  revision {rev.rev}
                </option>
              ))}
            </select>
          </div>
          {user.isAdmin && (
            <div className="field">
              <label className="check-inline">
                <input
                  type="checkbox"
                  checked={breakGlass}
                  onChange={(event) => setBreakGlass(event.target.checked)}
                />
                skip the chain (break glass)
              </label>
              {breakGlass && (
                <input
                  placeholder="reason — required, and recorded in the audit log"
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                />
              )}
            </div>
          )}
        </div>

        <p className="muted small">
          An earlier revision can be promoted again: it passed through the predecessor at some point,
          and that is what makes a rollback work after the chain has moved on.
        </p>
      </Card>

      {pending && chosen !== null && (
        <PlanCard
          resource={resource}
          plan={pending.plan}
          busy={action.busy}
          onCancel={() => setPending(null)}
          onConfirm={async () => {
            const ok = await action.run(() =>
              api.post(`/api/resources/${resource.id}/releases`, {
                revision: chosen,
                environment: pending.to,
                planId: pending.planId,
                skipChain: breakGlass,
                reason: reason || undefined,
              }),
            );
            if (ok) {
              setDone({ to: pending.to, rev: chosen });
              setPending(null);
              setBreakGlass(false);
              setReason("");
              promotion.reload();
              onChanged();
            }
          }}
        />
      )}

      <Divergence resource={resource} />
    </>
  );
}

function PlanCard({
  resource,
  plan,
  busy,
  onConfirm,
  onCancel,
}: {
  resource: ResourceDetail;
  plan: ReleasePlan;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const blocked = plan.blockers.length > 0;
  return (
    <Card
      title={`What promoting revision ${plan.rev} into ${plan.to.toUpperCase()} would do`}
      hint="Nothing has been applied. Confirming applies exactly what is listed here, and refuses if it has changed since."
    >
      <Stepper steps={STEPS} current={blocked ? 1 : 2} />

      {plan.isRollback && (
        <Notice kind="warn">
          This is a rollback. The policy merge still seeds from <strong>{plan.from}</strong> as it is
          today, not as it was when revision {plan.rev} was current.
        </Notice>
      )}
      {blocked && (
        <Notice kind="error">
          This cannot go ahead yet:
          <ul>
            {plan.blockers.map((blocker) => (
              <li key={blocker.code}>{blocker.detail}</li>
            ))}
          </ul>
        </Notice>
      )}
      {plan.warnings.map((warning) => (
        <Notice key={warning} kind="warn">
          {warning}
        </Notice>
      ))}

      <div className="cols">
        <div>
          <h4>Will be created in {plan.to.toUpperCase()}</h4>
          <p className="hint">Set upstream and missing here, so it arrives working.</p>
          <UnitList entries={plan.policy.create} showValue />
        </div>
        <div>
          <h4>Left exactly as it is</h4>
          <p className="hint">Already set here. A promotion never overwrites a local value.</p>
          <UnitList entries={plan.policy.keep} />
        </div>
        <div>
          <h4>Only here</h4>
          <p className="hint">Not set upstream. Removing something upstream never propagates.</p>
          <UnitList entries={plan.policy.localOnly} />
        </div>
      </div>

      <div className="inline">
        <button className="ghost" disabled={busy} onClick={onCancel}>
          Back
        </button>
        <span className="action">
          <button
            disabled={busy || blocked}
            title={blocked ? "Clear the blockers above first." : undefined}
            onClick={onConfirm}
          >
            Confirm and promote into {plan.to.toUpperCase()}
          </button>
          {blocked && <span className="action-reason">Clear the blockers above first.</span>}
        </span>
      </div>
      <p className="muted small">
        {resource.name} {resource.apiVersion} · revision {plan.rev} · {plan.from ?? "—"} →{" "}
        {plan.to}
      </p>
    </Card>
  );
}

function UnitList({ entries, showValue }: { entries: PlanEntry[]; showValue?: boolean }) {
  if (entries.length === 0) return <p className="muted small">Nothing.</p>;
  return (
    <ul className="units">
      {entries.map((entry) => (
        <li key={entry.unit}>
          <code>{entry.unit}</code>
          {entry.from && <span className="muted"> from {entry.from}</span>}
          {entry.reason && <span className="muted"> — {entry.reason}</span>}
          {showValue && entry.value !== undefined && <pre>{JSON.stringify(entry.value, null, 2)}</pre>}
        </li>
      ))}
    </ul>
  );
}

/**
 * Environments differ by design, because policy is edited in place. Nothing here blocks anything —
 * it is the compensating control that makes the design honest (design §6.4).
 */
function Divergence({ resource }: { resource: ResourceDetail }) {
  const divergence = useAsync(
    () => api.get<DivergenceReport>(`/api/resources/${resource.id}/divergence`),
    [resource.id, resource.updatedAt],
  );

  return (
    <Card
      title="How the environments differ"
      hint="Expected, not a fault: policy is edited where it runs. This is here so a difference is something you know about rather than something you discover."
    >
      <Notice kind="error">{divergence.error}</Notice>
      {divergence.data?.environments.map((environment) => (
        <div key={environment.environment} className="diverge">
          <h4>
            {environment.environment.toUpperCase()}{" "}
            <span className="muted small">
              {environment.predecessor
                ? `compared with ${environment.predecessor.toUpperCase()}`
                : "first in the chain"}
            </span>
          </h4>
          {environment.units.length === 0 ? (
            <p className="muted small">No policy of its own here.</p>
          ) : (
            <ul className="units">
              {environment.units.map((unit) => (
                <li key={unit.unit}>
                  <code>{unit.unit}</code>{" "}
                  <StatusChip
                    chip={{
                      label: LABEL[unit.category] ?? unit.category,
                      tone: unit.category === "aligned" ? "live" : "warn",
                      title: EXPLAIN[unit.category] ?? unit.category,
                    }}
                  />
                  {unit.warning && <Notice kind="warn">{unit.warning}</Notice>}
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}
    </Card>
  );
}

const LABEL: Record<string, string> = {
  pending: "Not here yet",
  "local-addition": "Only here",
  "value-drift": "Different value",
  aligned: "Same",
};

const EXPLAIN: Record<string, string> = {
  pending: "set in the previous environment and not here — a promotion would create it",
  "local-addition": "set here and not in the previous environment",
  "value-drift": "set in both, with different values",
  aligned: "set in both, with the same value",
};
