import { useState } from "react";
import { api, type ModelDiff, type RevisionDiff, type RevisionList, type RevisionRow } from "../api";
import {
  Card,
  Digest,
  EmptyState,
  Notice,
  Skeleton,
  StatusChip,
  Term,
  useAction,
  useAsync,
} from "../components";
import type { Permission } from "../lib/capabilities";
import { blockedBecause, first } from "../lib/capabilities";
import { releasedInChip } from "../lib/status";

/**
 * Revisions (G3, plan §7).
 *
 * The screen exists to answer three questions an owner has at the moment they are about to change a
 * contract other people depend on:
 *
 *  - **what is running where.** Every revision carries where it is live and where it was, so a
 *    rollback target is visible rather than worked out.
 *  - **what changed, and does it break anybody.** The diff is structural — over the normalized
 *    model, so a reformatted upload is "no change" — and **every breaking item names the rule that
 *    fired**. A classifier nobody can interrogate stops being trusted.
 *  - **can I still fix this.** A revision that has never been released is editable in place; one
 *    that has been is not, and the refusal offers the next revision instead.
 */

const RULE_LABEL: Record<string, string> = {
  "operation-removed": "an operation callers use is gone",
  "mcp-tool-removed": "a tool the agent could call is gone",
  "a2a-skill-removed": "a skill the card advertised is gone",
  "method-changed": "the same operation now answers a different method",
  "path-changed": "the same operation now answers a different path",
  "required-added": "a request that used to be accepted is now refused",
  "type-changed": "a value callers send has a different type",
  "enum-value-removed": "a value callers were allowed to send is no longer accepted",
  "path-parameter-removed": "a path parameter callers fill is gone",
  "response-status-removed": "a response callers relied on is no longer promised",
  "response-property-removed": "a field callers read is no longer returned",
  "response-property-retyped": "a field callers read has a different type",
  "soap-element-changed": "the body element that identifies the operation changed",
};

export function RevisionsPanel({
  resourceId,
  chain,
  canEdit,
  environment,
  canPublish,
  onReleased,
}: {
  resourceId: string;
  chain: string[];
  canEdit: Permission;
  /**
   * The environment a rollback would target. Omitted by the screens that only *read* the history —
   * the catalog listing and the legacy detail view — and set by the workspace, which is the one
   * place a publisher is already choosing an environment.
   */
  environment?: string;
  canPublish?: Permission;
  onReleased?: () => void;
}) {
  const list = useAsync(() => api.get<RevisionList>(`/api/resources/${resourceId}/revisions`), [resourceId]);
  const [compare, setCompare] = useState<{ from: string; to: string } | null>(null);
  const [rollback, setRollback] = useState<RevisionRow | null>(null);

  if (list.error) return <Notice kind="error">{list.error}</Notice>;
  if (!list.data) return <Skeleton rows={5} />;
  const items = list.data.items;

  if (items.length === 0) {
    return (
      <EmptyState
        title="No definition yet"
        detail="A revision is one upload of this API's contract. Until there is one, there is nothing to route, validate or publish."
        action={<span className="muted small">Import a definition on the Definition tab.</span>}
      />
    );
  }

  return (
    <>
      <Card
        title="Revisions"
        hint="One upload of the definition each, newest first. A revision becomes immutable the moment it is released."
      >
        <table>
          <thead>
            <tr>
              <th>Revision</th>
              <th>Where it runs</th>
              <th>Operations</th>
              <th>Came from</th>
              <th>Fingerprint</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {items.map((revision, index) => (
              <tr key={revision.id} className={revision.prunedAt ? "row-dim" : ""}>
                <td>
                  <strong>rev {revision.rev}</strong>
                  <div className="muted small">
                    {new Date(revision.createdAt).toLocaleDateString()} · {revision.createdBy}
                  </div>
                </td>
                <td>
                  {chain.map((environment) => {
                    const state = revision.releasedIn[environment] ?? "never";
                    if (state === "never") return null;
                    return (
                      <span key={environment} style={{ marginRight: 6 }}>
                        <StatusChip chip={releasedInChip(state)} />{" "}
                        <span className="muted small">{environment.toUpperCase()}</span>
                      </span>
                    );
                  })}
                  {Object.keys(revision.releasedIn).length === 0 && (
                    <span className="muted">Never published</span>
                  )}
                </td>
                <td>
                  {revision.operations}
                  {revision.schemaStates["unsupported-schema"] > 0 && (
                    <div className="muted small">
                      {revision.schemaStates["unsupported-schema"]} the gateway cannot validate
                    </div>
                  )}
                  {revision.schemaStates["no-schema"] > 0 && (
                    <div className="muted small">
                      {revision.schemaStates["no-schema"]} declare no schema
                    </div>
                  )}
                </td>
                <td className="muted small">
                  {revision.source}
                  {revision.sourceDetail && <div className="mono small">{revision.sourceDetail}</div>}
                </td>
                <td>
                  <Digest value={revision.versionDigest} />
                </td>
                <td className="right">
                  <Compare
                    revision={revision}
                    previous={items[index + 1] ?? null}
                    onCompare={(from) => setCompare({ from, to: revision.id })}
                  />
                  {environment && canPublish && (
                    <>
                      {" "}
                      <RollBack
                        revision={revision}
                        environment={environment}
                        permission={canPublish}
                        onStart={() => setRollback(revision)}
                      />
                    </>
                  )}
                  {" "}
                  <a
                    className="small"
                    href={`/api/revisions/${revision.id}/spec?format=original`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Download
                  </a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {list.data.nextCursor && (
          <p className="muted small">Older revisions exist; this page shows the most recent.</p>
        )}
      </Card>

      {compare && (
        <DiffCard
          from={compare.from}
          to={compare.to}
          revisions={items}
          onClose={() => setCompare(null)}
        />
      )}

      {rollback && environment && (
        <RollBackCard
          resourceId={resourceId}
          revision={rollback}
          live={items.find((row) => row.releasedIn[environment] === "live") ?? null}
          environment={environment}
          onClose={() => setRollback(null)}
          onDone={() => {
            setRollback(null);
            list.reload();
            onReleased?.();
          }}
        />
      )}

      <Correct
        revisions={items}
        canEdit={canEdit}
        onCorrected={() => {
          list.reload();
          setCompare(null);
        }}
      />
    </>
  );
}

function Compare({
  revision,
  previous,
  onCompare,
}: {
  revision: RevisionRow;
  previous: RevisionRow | null;
  onCompare: (from: string) => void;
}) {
  // A pruned revision is a tombstone: the row survives so releases and audit still resolve, and
  // pretending its diff is empty would be the worse answer (design §4.1).
  const permission = first(
    blockedBecause(!revision.diffable, "This revision's definition was pruned, so it cannot be compared."),
    blockedBecause(
      previous === null,
      "This is the first revision of this API, so there is nothing before it.",
    ),
    blockedBecause(
      previous !== null && !previous.diffable,
      "The revision before this one was pruned, so there is nothing to compare it with.",
    ),
  );
  return (
    <span className="action">
      <button
        className="ghost small"
        disabled={!permission.enabled}
        title={permission.reason ?? undefined}
        onClick={() => previous && onCompare(previous.id)}
      >
        Compare
      </button>
    </span>
  );
}

/**
 * The rollback control on one row.
 *
 * Offered only for a revision that is **frozen** and **not live here**. An unfrozen draft has
 * never been anywhere, so there is nothing to go back to; the live one is already where it is.
 * Both refusals are on the disabled button rather than hidden, so a publisher looking for the
 * rollback learns why this row is not it.
 */
function RollBack({
  revision,
  environment,
  permission,
  onStart,
}: {
  revision: RevisionRow;
  environment: string;
  permission: Permission;
  onStart: () => void;
}) {
  const state = revision.releasedIn[environment] ?? "never";
  const allowed = first(
    permission,
    blockedBecause(
      state === "live",
      `Revision ${revision.rev} is what ${environment.toUpperCase()} is already running.`,
    ),
    blockedBecause(
      revision.frozenAt === null,
      "This revision has never been released, so this would be a first release rather than a rollback — promote it from the Definition tab.",
    ),
    blockedBecause(
      !revision.diffable,
      "This revision's definition was pruned, so there is nothing left to serve.",
    ),
  );
  return (
    <span className="action">
      <button
        className="ghost small"
        disabled={!allowed.enabled}
        title={allowed.reason ?? `Put revision ${revision.rev} back into ${environment.toUpperCase()}`}
        onClick={onStart}
      >
        Roll back
      </button>
    </span>
  );
}

/**
 * Rolling back, through the ordinary release path.
 *
 * The dry run first, because a rollback **is** a release and deserves the same plan in front of
 * it: the same gate, the same warnings, and the same confirmation of the plan the publisher was
 * actually shown. A "just put it back" button that skipped that would be the one change in the
 * estate nobody reviewed — and rolling back to a contract that removed an operation is exactly as
 * breaking as rolling forward to one.
 */
function RollBackCard({
  resourceId,
  revision,
  live,
  environment,
  onClose,
  onDone,
}: {
  resourceId: string;
  revision: RevisionRow;
  live: RevisionRow | null;
  environment: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const [plan, setPlan] = useState<ReleasePlan | null>(null);
  const [done, setDone] = useState(false);
  const dryRun = useAction();
  const confirm = useAction();

  return (
    <Card
      title={`Roll ${environment.toUpperCase()} back to revision ${revision.rev}`}
      hint="A rollback is a release of an older revision. Nothing is deleted, and the revision that was live stays in this list."
    >
      {done ? (
        <>
          <p>
            {environment.toUpperCase()} is being moved back to revision {revision.rev}. The gateways
            apply it on their next poll.
          </p>
          <button className="primary" onClick={onDone}>
            Done
          </button>
        </>
      ) : (
        <>
          <p className="muted small">
            {live
              ? `Revision ${live.rev} is live in ${environment.toUpperCase()} and stays in the history as "was live".`
              : `Nothing is currently live in ${environment.toUpperCase()}.`}
          </p>
          <Notice kind="error">{dryRun.error ?? confirm.error}</Notice>
          {plan && <PlanSummary plan={plan} />}
          <div className="row">
            <button className="ghost" onClick={onClose}>
              Cancel
            </button>
            {plan ? (
              <button
                className="primary"
                disabled={confirm.busy || (plan.blockers ?? []).length > 0}
                onClick={() =>
                  void confirm.run(async () => {
                    await api.post(`/api/resources/${resourceId}/releases`, {
                      revision: revision.rev,
                      environment,
                      // Echoed back, so the control plane can refuse a confirmation whose plan no
                      // longer matches what it would do now — somebody may have released between
                      // the check and the click.
                      planId: plan.planId,
                    });
                    setDone(true);
                  })
                }
              >
                Confirm the rollback
              </button>
            ) : (
              <button
                className="primary"
                disabled={dryRun.busy}
                onClick={() =>
                  void dryRun.run(async () =>
                    setPlan(
                      await api.post<ReleasePlan>(`/api/resources/${resourceId}/releases?dryRun=1`, {
                        revision: revision.rev,
                        environment,
                      }),
                    ),
                  )
                }
              >
                Check what this would do
              </button>
            )}
          </div>
        </>
      )}
    </Card>
  );
}

/** Whatever the release dry run tells us. Only the three fields this card renders are named. */
interface ReleasePlan {
  planId?: string;
  warnings?: string[];
  blockers?: string[];
}

function PlanSummary({ plan }: { plan: ReleasePlan }) {
  const warnings = plan.warnings ?? [];
  const blockers = plan.blockers ?? [];
  if (warnings.length === 0 && blockers.length === 0) {
    return (
      <p className="muted small">
        Nothing stands in the way. Confirming applies exactly the plan shown here.
      </p>
    );
  }
  return (
    <>
      {blockers.length > 0 && (
        <Notice kind="error">
          <ul>
            {blockers.map((blocker) => (
              <li key={blocker}>{blocker}</li>
            ))}
          </ul>
        </Notice>
      )}
      {warnings.length > 0 && (
        <Notice kind="warn">
          <ul>
            {warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </Notice>
      )}
    </>
  );
}

function DiffCard({
  from,
  to,
  revisions,
  onClose,
}: {
  from: string;
  to: string;
  revisions: RevisionRow[];
  onClose: () => void;
}) {
  const [fromId, setFromId] = useState(from);
  const diff = useAsync(
    () => api.get<RevisionDiff>(`/api/revisions/${to}/diff?from=${fromId}`),
    [to, fromId],
  );
  const toRev = revisions.find((revision) => revision.id === to);

  return (
    <Card
      title={`What changed in revision ${toRev?.rev ?? "?"}`}
      hint="Compared over the normalized contract, so a reformatted or converted document shows as no change."
    >
      <div className="row wrap" style={{ marginBottom: 12 }}>
        <div className="field">
          <label htmlFor="diff-from">Compare with</label>
          <select id="diff-from" value={fromId} onChange={(event) => setFromId(event.target.value)}>
            {revisions
              .filter((revision) => revision.id !== to && revision.diffable)
              .map((revision) => (
                <option key={revision.id} value={revision.id}>
                  rev {revision.rev}
                </option>
              ))}
          </select>
        </div>
        <button className="ghost" onClick={onClose}>
          Close
        </button>
      </div>

      {diff.error && <Notice kind="error">{diff.error}</Notice>}
      {!diff.data && !diff.error && <Skeleton rows={4} />}
      {diff.data && <DiffBody diff={diff.data} />}
    </Card>
  );
}

function DiffBody({ diff }: { diff: ModelDiff }) {
  const { summary } = diff;
  if (summary.added + summary.removed + summary.changed === 0 && diff.metadata.length === 0) {
    return (
      <p className="muted">
        No change to the contract. The upload differs as a file — reformatted, reordered or converted
        — but describes the same API.
      </p>
    );
  }

  return (
    <>
      <div className="tiles">
        <div className="tile">
          <span className="value">{summary.added}</span>
          <span className="label">Added</span>
        </div>
        <div className="tile">
          <span className="value">{summary.removed}</span>
          <span className="label">Removed</span>
        </div>
        <div className="tile">
          <span className="value">{summary.changed}</span>
          <span className="label">Changed</span>
        </div>
        <div className="tile">
          <span className="value">{summary.breaking}</span>
          <span className="label">Would break callers</span>
        </div>
      </div>

      {summary.breaking > 0 && (
        <Notice kind="warn">
          {summary.breaking} change{summary.breaking === 1 ? "" : "s"} here would break somebody who
          is calling this API today. Publishing a new <Term name="version" /> beside this one lets
          them move when they are ready.
        </Notice>
      )}

      {diff.metadata.length > 0 && (
        <ul className="plain small muted">
          {diff.metadata.map((entry) => (
            <li key={entry.field}>
              {entry.field}: {entry.was ?? "—"} → {entry.now ?? "—"}
            </li>
          ))}
        </ul>
      )}

      <table>
        <thead>
          <tr>
            <th>Operation</th>
            <th>Change</th>
            <th>Why it matters</th>
          </tr>
        </thead>
        <tbody>
          {diff.operations.map((operation) => (
            <tr key={operation.operationId} className={operation.breaking ? "row-bad" : ""}>
              <td>
                <strong>{operation.operationId}</strong>
                {operation.method && (
                  <div className="mono small muted">
                    {operation.method} {operation.path}
                  </div>
                )}
              </td>
              <td>
                <StatusChip
                  chip={{
                    label: operation.change,
                    tone: operation.breaking ? "stop" : operation.change === "added" ? "live" : "warn",
                    title: operation.breaking ? "breaks callers who use it today" : "safe for callers",
                  }}
                />
              </td>
              <td>
                {/* The rule that fired, in words. A classifier nobody can interrogate stops being
                    trusted, and an over-eager one stops being read. */}
                {operation.rule ? (
                  <span title={operation.rule}>{RULE_LABEL[operation.rule] ?? operation.rule}</span>
                ) : (
                  <span className="muted">Nobody calling this today is affected.</span>
                )}
                {operation.tooLargeToDiff && (
                  <div className="muted small">
                    The schemas were too large to compare, so this is not "no change" — it is
                    unknown.
                  </div>
                )}
                {operation.details && operation.details.length > 0 && (
                  <ul className="plain small muted">
                    {operation.details.slice(0, 8).map((detail, index) => (
                      <li key={`${detail.path}-${index}`}>
                        <span className="mono">{detail.path}</span>: {detail.was ?? "—"} →{" "}
                        {detail.now ?? "—"}
                        {detail.breaking && detail.rule && (
                          <> — {RULE_LABEL[detail.rule] ?? detail.rule}</>
                        )}
                      </li>
                    ))}
                    {operation.details.length > 8 && (
                      <li>{operation.details.length - 8} more not shown.</li>
                    )}
                  </ul>
                )}
              </td>
            </tr>
          ))}
          {diff.skills?.map((skill) => (
            <tr key={skill.id} className={skill.breaking ? "row-bad" : ""}>
              <td>
                <strong>{skill.name ?? skill.id}</strong>
                <div className="muted small">skill</div>
              </td>
              <td>
                <StatusChip
                  chip={{
                    label: skill.change,
                    tone: skill.breaking ? "stop" : skill.change === "added" ? "live" : "warn",
                    title: skill.breaking ? "breaks agents that use it" : "safe",
                  }}
                />
              </td>
              <td>{skill.rule ? (RULE_LABEL[skill.rule] ?? skill.rule) : <span className="muted">—</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

/**
 * Correcting a draft in place (plan §7.3). Only while unfrozen: once a revision has been released,
 * the contract somebody else is running is not something to edit under them — and the refusal from
 * the server says so and offers the next revision, which is why this control is disabled with the
 * same sentence rather than hidden.
 */
function Correct({
  revisions,
  canEdit,
  onCorrected,
}: {
  revisions: RevisionRow[];
  canEdit: Permission;
  onCorrected: () => void;
}) {
  const draft = revisions.find((revision) => revision.editable) ?? null;
  const [spec, setSpec] = useState("");
  const action = useAction();

  const permission = first(
    canEdit,
    blockedBecause(
      draft === null,
      "Every revision of this API has been released, so none can be edited. Upload a new revision instead.",
    ),
  );

  return (
    <Card
      title="Correct the newest revision"
      hint="Replaces the definition of a revision that has never been released, keeping its number. Anything already published is untouched."
    >
      <Notice kind="error">{action.error}</Notice>
      <Notice kind="ok">{action.message}</Notice>
      <div className="field">
        <label htmlFor="correct-spec">Definition</label>
        <textarea
          id="correct-spec"
          value={spec}
          placeholder="Paste the corrected OpenAPI, WSDL, MCP manifest or Agent Card"
          onChange={(event) => setSpec(event.target.value)}
          disabled={!permission.enabled}
        />
      </div>
      <div className="action">
        <button
          disabled={!permission.enabled || action.busy || spec.trim().length === 0}
          title={permission.reason ?? undefined}
          onClick={async () => {
            const ok = await action.run(
              () => api.put(`/api/revisions/${draft!.id}/spec`, { spec: parse(spec) }),
              `Revision ${draft!.rev} now carries the definition you pasted.`,
            );
            if (ok) {
              setSpec("");
              onCorrected();
            }
          }}
        >
          {draft ? `Replace revision ${draft.rev}` : "Replace"}
        </button>
        {permission.reason && <span className="action-reason">{permission.reason}</span>}
      </div>
    </Card>
  );
}

/** A WSDL is XML and an OpenAPI document is JSON or YAML; the server accepts both as a string. */
function parse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
