import { useState } from "react";
import { api, type Meta, type ResourceDetail } from "../api";
import { Card, Field, Link, Notice, Stepper, Term, go, useAction } from "../components";
import type { Permission } from "../lib/capabilities";

/**
 * Publishing a new version (plan §9.2, journey 3).
 *
 * The decision this wizard exists to make explicit: a new **version** is a new API beside the old
 * one, with its own route, its own policies and its own subscribers — not an edit. Callers move
 * across when they are ready, which is what makes a breaking change survivable. A new
 * **revision** is the other thing, and the two are named apart everywhere so nobody picks the wrong
 * one by reading quickly.
 */

const STEPS = ["The new version", "What to carry over", "Review"];

export function VersionWizard({
  resource,
  meta,
  canPublish,
}: {
  resource: ResourceDetail;
  meta: Meta;
  canPublish: Permission;
}) {
  const [step, setStep] = useState(0);
  const [apiVersion, setApiVersion] = useState(nextVersion(resource.apiVersion));
  const [copyPolicyFrom, setCopyPolicyFrom] = useState(meta.chain[0] ?? "");
  const [createRoutes, setCreateRoutes] = useState(true);
  const [deprecateOld, setDeprecateOld] = useState(false);
  const action = useAction();

  const taken = resource.versions.some(
    (version) => version.apiVersion.toLowerCase() === apiVersion.trim().toLowerCase(),
  );

  return (
    <>
      <Stepper steps={STEPS} current={step} />

      {step === 0 && (
        <Card
          title={`A new version of ${resource.name}`}
          hint="It starts from this version's newest revision as its own revision 1, unfrozen. Both versions serve at the same time, on different base paths, until you retire the old one."
        >
          <Field label="Version identifier" value={apiVersion} onChange={setApiVersion} placeholder="v2" />
          {taken && (
            <Notice kind="error">
              {resource.name} already has a version called {apiVersion.trim()}. Versions of one API
              cannot differ by case alone.
            </Notice>
          )}
          <p className="muted small">
            Existing versions: {resource.versions.map((version) => version.apiVersion).join(", ")}.
          </p>
          <div className="action">
            <button disabled={taken || apiVersion.trim().length === 0} onClick={() => setStep(1)}>
              Next: what to carry over
            </button>
          </div>
        </Card>
      )}

      {step === 1 && (
        <Card
          title="What should the new version start with?"
          hint="Nothing here is permanent — everything can be changed afterwards on the new version's own pages."
        >
          <div className="field">
            <label htmlFor="vw-policy">
              Copy <Term name="policy">policies</Term> from
            </label>
            <select
              id="vw-policy"
              value={copyPolicyFrom}
              onChange={(event) => setCopyPolicyFrom(event.target.value)}
            >
              <option value="">nothing — start with no policy</option>
              {meta.chain.map((environment) => (
                <option key={environment} value={environment}>
                  what {resource.apiVersion} runs in {environment.toUpperCase()}
                </option>
              ))}
            </select>
            <p className="muted small">
              Copied into the same environment on the new version. A rate limit that suits{" "}
              {resource.apiVersion} usually suits its successor, and starting from nothing means an
              open route.
            </p>
          </div>

          <label className="check-inline">
            <input
              type="checkbox"
              checked={createRoutes}
              onChange={(event) => setCreateRoutes(event.target.checked)}
            />
            create <Term name="route">routes</Term> at{" "}
            <span className="mono">
              /{resource.name}/{apiVersion.trim() || "…"}
            </span>
          </label>
          <p className="muted small">
            Two versions cannot share a <Term name="base path" />, so the new one needs its own. Leave
            this on unless you intend to route it somewhere unusual.
          </p>

          <label className="check-inline">
            <input
              type="checkbox"
              checked={deprecateOld}
              onChange={(event) => setDeprecateOld(event.target.checked)}
            />
            mark {resource.apiVersion} deprecated
          </label>
          <p className="muted small">
            Deprecated keeps serving and warns every caller on every response. Do this once the new
            version is live and you want people to move.
          </p>

          <div className="inline">
            <button className="ghost" onClick={() => setStep(0)}>
              Back
            </button>
            <button onClick={() => setStep(2)}>Next: review</button>
          </div>
        </Card>
      )}

      {step === 2 && (
        <Card title="Ready" hint="Nothing exists until you press the button below.">
          <Notice kind="error">{action.error}</Notice>
          <dl className="kv">
            <dt>New version</dt>
            <dd>
              {resource.name} {apiVersion.trim()}, beside {resource.apiVersion}
            </dd>
            <dt>Definition</dt>
            <dd>a copy of revision {resource.revisions[0]?.rev ?? 1}, unfrozen so you can correct it</dd>
            <dt>Policies</dt>
            <dd>
              {copyPolicyFrom
                ? `copied from what ${resource.apiVersion} runs in ${copyPolicyFrom.toUpperCase()}`
                : "none — you will set them yourself"}
            </dd>
            <dt>Routes</dt>
            <dd>
              {createRoutes ? (
                <span className="mono">
                  /{resource.name}/{apiVersion.trim()}
                </span>
              ) : (
                "none — you will set them yourself"
              )}
            </dd>
            <dt>{resource.apiVersion}</dt>
            <dd>{deprecateOld ? "marked deprecated" : "left exactly as it is"}</dd>
          </dl>
          <div className="inline">
            <button className="ghost" onClick={() => setStep(1)}>
              Back
            </button>
            <span className="action">
              <button
                disabled={!canPublish.enabled || action.busy}
                title={canPublish.reason ?? undefined}
                onClick={async () => {
                  await action.run(async () => {
                    const created = await api.post<{ id: string }>(
                      `/api/resources/${resource.id}/versions`,
                      {
                        apiVersion: apiVersion.trim(),
                        copyPolicyFrom: copyPolicyFrom || undefined,
                        createRoutes,
                      },
                    );
                    if (deprecateOld) {
                      await api.patch(
                        `/api/resources/${resource.id}`,
                        { lifecycle: "deprecated" },
                        resource.etag,
                      );
                    }
                    go(`/apis/${created.id}`);
                  });
                }}
              >
                Create {resource.name} {apiVersion.trim()}
              </button>
              {canPublish.reason && <span className="action-reason">{canPublish.reason}</span>}
            </span>
            <Link to={`/apis/${resource.id}`}>Cancel</Link>
          </div>
        </Card>
      )}
    </>
  );
}

/** `v1` → `v2`, `2024-01-01` → itself: a guess worth offering, never one worth insisting on. */
function nextVersion(current: string): string {
  const match = /^v(\d+)$/i.exec(current.trim());
  return match ? `v${Number(match[1]) + 1}` : "";
}
