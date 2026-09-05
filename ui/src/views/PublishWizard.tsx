import { useState } from "react";
import type { Session } from "../App";
import { api, type Resource, type ResourceDetail } from "../api";
import { Card, Field, Link, Notice, Stepper, Term, go, useAction } from "../components";

/**
 * Publishing an API, as three questions instead of six screens (plan §9.2, journey 1).
 *
 * The wizard exists because the old path made a person visit four tabs in an order nothing told
 * them, and the failure was silent: an API with a definition and no route is not broken, it is
 * simply never called, and nothing said so. Here every step is validated against the same server
 * rule that would reject it, so the wizard never advances into a refusal — and the last screen
 * names what to do next, because "created" is not an outcome anybody wanted.
 */

const STEPS = ["Definition", "Routing", "Review"];

export function PublishWizard({ session }: { session: Session }) {
  const [step, setStep] = useState(0);
  const [resource, setResource] = useState<ResourceDetail | null>(null);

  // Step 1 — what it is, and its contract.
  const [kind, setKind] = useState(session.meta.kinds[0] ?? "rest");
  const [name, setName] = useState("");
  const [apiVersion, setApiVersion] = useState("v1");
  const [applicationId, setApplicationId] = useState(session.application);
  const [source, setSource] = useState<"url" | "paste">("url");
  const [specUrl, setSpecUrl] = useState("");
  const [pasted, setPasted] = useState("");

  // Step 2 — where it answers, and what it forwards to.
  const [host, setHost] = useState("*");
  const [basePath, setBasePath] = useState("");
  const [backend, setBackend] = useState("");

  const define = useAction();
  const route = useAction();
  const release = useAction();
  const discoverable = kind === "mcp" || kind === "a2a";

  async function createAndImport() {
    const ok = await define.run(async () => {
      const created = await api.post<Resource>("/api/resources", { kind, name, applicationId, apiVersion });
      try {
        await api.post(`/api/resources/${created.id}/revisions`, importBody());
      } catch (err) {
        // The API exists but has no definition. Said plainly rather than left as a half-made thing
        // the person has to discover on the list screen later.
        await api.del(`/api/resources/${created.id}`).catch(() => {});
        throw err;
      }
      const detail = await api.get<ResourceDetail>(`/api/resources/${created.id}`);
      setResource(detail);
      setBasePath(`/${detail.name}/${detail.apiVersion}`);
    });
    if (ok) setStep(1);
  }

  function importBody(): Record<string, unknown> {
    if (source === "paste") return { spec: parse(pasted) };
    return discoverable ? { discoverUrl: specUrl } : { specUrl };
  }

  async function saveRouting() {
    const ok = await route.run(async () => {
      await api.put(`/api/resources/${resource!.id}/routes`, {
        environment: session.environment,
        host,
        basePath,
      });
      await api.put(`/api/resources/${resource!.id}/binding`, {
        environment: session.environment,
        urls: [backend],
      });
    });
    if (ok) setStep(2);
  }

  return (
    <>
      <Stepper steps={STEPS} current={step} />

      {step === 0 && (
        <Card
          title="What are you publishing?"
          hint="An API is one interface at one version. Two versions are two of these, side by side, each with its own route and subscribers."
        >
          <Notice kind="error">{define.error}</Notice>
          <div className="row">
            <div className="field">
              <label htmlFor="pw-kind">Kind</label>
              <select id="pw-kind" value={kind} onChange={(event) => setKind(event.target.value)}>
                {session.meta.kinds.map((candidate) => (
                  <option key={candidate} value={candidate}>
                    {candidate}
                  </option>
                ))}
              </select>
            </div>
            <Field label="Name" value={name} onChange={setName} placeholder="petstore" />
            <Field label="Version" value={apiVersion} onChange={setApiVersion} placeholder="v1" />
            <div className="field">
              <label htmlFor="pw-application">Owning application</label>
              <select id="pw-application" value={applicationId} onChange={(event) => setApplicationId(event.target.value)}>
                {(session.user.applications.length > 0 ? session.user.applications : [session.application]).map((application) => (
                  <option key={application} value={application}>
                    {session.applicationName(application)}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="tabs" style={{ marginTop: 18 }}>
            <button className={source === "url" ? "active" : ""} onClick={() => setSource("url")}>
              {discoverable ? "Ask the endpoint" : "From a URL"}
            </button>
            <button className={source === "paste" ? "active" : ""} onClick={() => setSource("paste")}>
              Paste it
            </button>
          </div>

          {source === "url" ? (
            <Field
              label={discoverable ? (kind === "mcp" ? "MCP endpoint" : "Agent base URL") : "Definition URL"}
              value={specUrl}
              onChange={setSpecUrl}
              placeholder={
                kind === "mcp"
                  ? "http://127.0.0.1:9085/mcp"
                  : kind === "a2a"
                    ? "http://127.0.0.1:9086"
                    : "https://petstore.swagger.io/v2/swagger.json"
              }
            />
          ) : (
            <div className="field">
              <label htmlFor="pw-spec">
                <Term name="definition" />
              </label>
              <textarea
                id="pw-spec"
                value={pasted}
                placeholder='{"swagger":"2.0", …}'
                onChange={(event) => setPasted(event.target.value)}
              />
            </div>
          )}
          <p className="muted small">
            {discoverable
              ? "There is no document to upload for this kind: the portal asks the endpoint what it offers and stores the answer as revision 1."
              : "OpenAPI 3.x, Swagger 2.0 or WSDL. A URL is checked against the egress allowlist before anything is fetched."}
          </p>

          <div className="action">
            <button
              disabled={define.busy || !name || (source === "url" ? !specUrl : !pasted.trim())}
              onClick={createAndImport}
            >
              {define.busy ? "Reading the definition…" : "Next: where it answers"}
            </button>
          </div>
        </Card>
      )}

      {step === 1 && resource && (
        <Card
          title={`Where does ${resource.name} answer in ${session.environment.toUpperCase()}?`}
          hint="A route is what the gateway matches an incoming request against. Routes and backends belong to one environment and a promotion never copies them — a TEST backend guessed from DEV is exactly the mistake that separation prevents."
        >
          <Notice kind="error">{route.error}</Notice>
          <div className="row">
            <Field label="Host (* matches any)" value={host} onChange={setHost} />
            <Field label="Base path" value={basePath} onChange={setBasePath} placeholder="/petstore/v1" />
          </div>
          <Field
            label="Backend URL"
            value={backend}
            onChange={setBackend}
            placeholder="http://127.0.0.1:9080/v2"
          />
          <p className="muted small">
            Callers reach it at <span className="mono">{basePath || "/…"}</span> on a{" "}
            {session.environment.toUpperCase()} <Term name="gateway" />, and the gateway forwards to{" "}
            <span className="mono">{backend || "…"}</span>.
          </p>
          <div className="inline">
            <button className="ghost" onClick={() => setStep(0)}>
              Back
            </button>
            <button disabled={route.busy || !basePath || !backend} onClick={saveRouting}>
              Next: review
            </button>
          </div>
        </Card>
      )}

      {step === 2 && resource && (
        <Review
          resource={resource}
          environment={session.environment}
          host={host}
          basePath={basePath}
          backend={backend}
          action={release}
          onBack={() => setStep(1)}
        />
      )}
    </>
  );
}

function Review({
  resource,
  environment,
  host,
  basePath,
  backend,
  action,
  onBack,
}: {
  resource: ResourceDetail;
  environment: string;
  host: string;
  basePath: string;
  backend: string;
  action: ReturnType<typeof useAction>;
  onBack: () => void;
}) {
  const [published, setPublished] = useState(false);
  const revision = resource.revisions[0];

  if (published) {
    return <Published resource={resource} environment={environment} host={host} basePath={basePath} />;
  }

  return (
    <Card title="Ready to publish" hint="Nothing is live until you press the button below.">
      <Notice kind="error">{action.error}</Notice>
      <dl className="kv">
        <dt>API</dt>
        <dd>
          {resource.name} {resource.apiVersion} ({resource.kind})
        </dd>
        <dt>
          <Term name="revision" />
        </dt>
        <dd>
          revision {revision?.rev ?? 1}, from {revision?.original_format ?? "the definition you gave"}
        </dd>
        <dt>
          <Term name="route" />
        </dt>
        <dd className="mono">
          {host === "*" ? "any host" : host}
          {basePath}
        </dd>
        <dt>
          <Term name="backend" />
        </dt>
        <dd className="mono">{backend}</dd>
        <dt>Environment</dt>
        <dd>{environment.toUpperCase()}</dd>
      </dl>
      <div className="inline">
        <button className="ghost" onClick={onBack}>
          Back
        </button>
        <button
          disabled={action.busy}
          onClick={async () => {
            const ok = await action.run(() =>
              api.post(`/api/resources/${resource.id}/releases`, {
                revision: revision?.rev ?? 1,
                environment,
              }),
            );
            if (ok) setPublished(true);
          }}
        >
          Publish to {environment.toUpperCase()}
        </button>
        <button className="ghost" onClick={() => go(`/apis/${resource.id}`)}>
          Finish later
        </button>
      </div>
    </Card>
  );
}

/**
 * The end of the journey. "Created" is not an outcome anybody wanted, so this names what they can
 * now do (§9.2). Exported so `ui/test` can assert that it still does.
 */
export function Published({
  resource,
  environment,
  host,
  basePath,
}: {
  resource: ResourceDetail;
  environment: string;
  host: string;
  basePath: string;
}) {
  return (
    <Card title={`${resource.name} ${resource.apiVersion} is live in ${environment.toUpperCase()}`}>
      <p>
        Callers reach it at{" "}
        <span className="mono">
          {host === "*" ? "" : host}
          {basePath}
        </span>{" "}
        on a {environment.toUpperCase()} <Term name="gateway" />. The gateways pick it up at their
        next poll, which is seconds away.
      </p>
      <div className="inline">
        <Link to={`/apis/${resource.id}/try`}>Call it now →</Link>
        <Link to={`/apis/${resource.id}/policies`}>Add a policy</Link>
        <Link to="/products">Put it in a product</Link>
        <Link to={`/apis/${resource.id}/publish`}>Promote it onward</Link>
      </div>
      <p className="muted small" style={{ marginTop: 14 }}>
        Nobody can subscribe to it until it is in a <Term name="product" />: a{" "}
        <Term name="subscription" /> is to a product, never to an API directly.
      </p>
    </Card>
  );
}

function parse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
