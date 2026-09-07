import { useState } from "react";
import type { Session } from "../App";
import {
  api,
  type Application,
  type EffectivePolicyView,
  type MarketListingDetail,
} from "../api";
import {
  Panel,
  EmptyState,
  TextField,
  Link,
  Notice,
  Skeleton,
  Stepper,
  Term,
  useAction,
  useAsync,
} from "../components";

/**
 * Subscribing, as three questions (plan §9.2, journey 4).
 *
 * The model people get wrong here is which object holds what, so the wizard teaches it by asking in
 * the right order: the **application** is the thing that calls and the thing keys belong to; the
 * **environment** decides which gateway and therefore which key; the **product** is what is actually
 * subscribed to, because a key that worked per API would have to be reissued every time a bundle
 * changed.
 *
 * Step 3 shows the rate limit and quota being agreed to, read from the effective policy rather than
 * from the defaults — a consumer who is refused with a 429 they were never told about has been
 * misled by us.
 */

const STEPS = ["Application", "Environment", "Review"];

export function SubscribeWizard({ resourceId, session }: { resourceId: string; session: Session }) {
  const listing = useAsync(() => api.get<MarketListingDetail>(`/api/catalog/${resourceId}`), [resourceId]);
  const applications = useAsync(() => api.get<{ items: Application[] }>("/api/applications"), []);

  const [step, setStep] = useState(0);
  const [applicationId, setApplicationId] = useState("");
  const [environment, setEnvironment] = useState(session.environment);
  const [productId, setProductId] = useState("");
  const [done, setDone] = useState<{ id: string; state: string; warnings: string[] } | null>(null);

  // Step 1 is a choice between applications; without the list there is no choice to offer, so
  // both failures stop the wizard rather than leaving an empty picker that looks like "you have
  // no applications" — which sends people off to register a duplicate.
  if (listing.error || applications.error) {
    return <Notice kind="error">{listing.error ?? applications.error}</Notice>;
  }
  if (!listing.data || !applications.data) return <Skeleton rows={6} />;
  const api_ = listing.data;

  if (api_.products.length === 0) {
    return (
      <EmptyState
        title={`${api_.title} is not in any product yet`}
        detail="Consumers subscribe to a product, never to an API directly — so until its owner puts it in one, there is nothing to ask for."
        action={<Link to={`/catalog/${resourceId}`}>Back to the API →</Link>}
      />
    );
  }

  const live = api_.endpoints.filter((endpoint) => endpoint.live).map((endpoint) => endpoint.environment);
  const chosenProduct = api_.products.find((product) => product.id === productId) ?? api_.products[0]!;

  return (
    <>
      <div className="object-head">
        <div>
          <h3>
            {api_.icon && <span className="listing-icon">{api_.icon}</span>} {api_.title}{" "}
            <span className="mono muted">{api_.apiVersion}</span>
          </h3>
          <p className="muted small">{api_.summary ?? "No summary."}</p>
        </div>
      </div>

      <Stepper steps={STEPS} current={done ? 2 : step} />

      {done ? (
        <Requested
          state={done.state}
          warnings={done.warnings}
          subscriptionId={done.id}
          listing={api_}
          environment={environment}
          resourceId={resourceId}
        />
      ) : (
        <>
          {step === 0 && (
            <ChooseApplication
              applications={applications.data.items}
              value={applicationId}
              applicationId={session.application}
              onChange={setApplicationId}
              onCreated={applications.reload}
              onNext={() => setStep(1)}
            />
          )}
          {step === 1 && (
            <Panel
              title="Which environment?"
              hint="Keys are per environment, so a DEV key never works in PROD. That is deliberate: a test caller cannot reach production by accident."
            >
              <div className="row wrap">
                {session.meta.chain.map((candidate) => (
                  <button
                    key={candidate}
                    className={candidate === environment ? "chip active" : "chip"}
                    disabled={!live.includes(candidate)}
                    title={
                      live.includes(candidate)
                        ? undefined
                        : `${api_.title} is not published in ${candidate.toUpperCase()}, so there is nothing to call there.`
                    }
                    onClick={() => setEnvironment(candidate)}
                  >
                    {candidate.toUpperCase()}
                  </button>
                ))}
              </div>
              {live.length === 0 && (
                <Notice kind="warn">
                  This API is not live in any environment yet, so a subscription to it would have
                  nothing to call.
                </Notice>
              )}

              {api_.products.length > 1 && (
                <div className="field" style={{ marginTop: 14 }}>
                  <label htmlFor="sw-product">
                    <Term name="product" />
                  </label>
                  <select
                    id="sw-product"
                    value={chosenProduct.id}
                    onChange={(event) => setProductId(event.target.value)}
                  >
                    {api_.products.map((product) => (
                      <option key={product.id} value={product.id}>
                        {product.name}
                        {product.summary ? ` — ${product.summary}` : ""}
                      </option>
                    ))}
                  </select>
                  <p className="muted small">
                    This API is in more than one bundle. The key you get works for every API in the
                    one you pick.
                  </p>
                </div>
              )}

              <div className="inline">
                <button className="ghost" onClick={() => setStep(0)}>
                  Back
                </button>
                <button disabled={!live.includes(environment)} onClick={() => setStep(2)}>
                  Next: review the terms
                </button>
              </div>
            </Panel>
          )}
          {step === 2 && (
            <ReviewTerms
              resourceId={resourceId}
              environment={environment}
              product={chosenProduct}
              application={applications.data.items.find((app) => app.id === applicationId)}
              onBack={() => setStep(1)}
              onSubscribed={(id, state, warnings) => setDone({ id, state, warnings })}
            />
          )}
        </>
      )}
    </>
  );
}

function ChooseApplication({
  applications,
  value,
  applicationId,
  onChange,
  onCreated,
  onNext,
}: {
  applications: Application[];
  value: string;
  applicationId: string;
  onChange: (next: string) => void;
  onCreated: () => void;
  onNext: () => void;
}) {
  const [name, setName] = useState("");
  const action = useAction();

  return (
    <Panel
      title="Which application will call this?"
      hint="An application is the thing that makes the calls — a service, a job, a mobile app. Keys belong to it, so revoking one stops that caller and nobody else."
    >
      <Notice kind="error">{action.error}</Notice>

      {applications.length === 0 ? (
        <EmptyState
          title="You have no applications yet"
          detail="Create one now — it takes a name, and it is the thing your key will belong to."
          action={null}
        />
      ) : (
        <ul className="plain">
          {applications.map((application) => (
            <li key={application.id}>
              <label className="check-inline">
                <input
                  type="radio"
                  name="application"
                  checked={value === application.id}
                  onChange={() => onChange(application.id)}
                />
                <strong>{application.name}</strong>
                <span className="muted small">{application.applicationId}</span>
              </label>
            </li>
          ))}
        </ul>
      )}

      {/* Creating one here rather than sending somebody to another screen and back `[P3-05]`. */}
      <div className="subform">
        <TextField label="…or create one" value={name} onChange={setName} placeholder="checkout-service" />
        <button
          className="ghost"
          disabled={action.busy || name.trim().length === 0}
          onClick={async () => {
            const ok = await action.run(async () => {
              const created = await api.post<Application>("/api/applications", { name, applicationId });
              onChange(created.id);
              setName("");
            });
            if (ok) onCreated();
          }}
        >
          Create application
        </button>
      </div>

      <div className="action" style={{ marginTop: 14 }}>
        <button disabled={!value} onClick={onNext} title={value ? undefined : "Choose an application first."}>
          Next: which environment
        </button>
        {!value && <span className="action-reason">Choose or create the application that will call.</span>}
      </div>
    </Panel>
  );
}

function ReviewTerms({
  resourceId,
  environment,
  product,
  application,
  onBack,
  onSubscribed,
}: {
  resourceId: string;
  environment: string;
  product: { id: string; name: string };
  application: Application | undefined;
  onBack: () => void;
  onSubscribed: (id: string, state: string, warnings: string[]) => void;
}) {
  // The publisher reads this before deciding, and it is the only thing on the approval request that
  // is not a machine-generated id. The server requires 3–500 characters (api-subscription-management,
  // "A subscription is per environment and carries a purpose"); the same bounds are enforced here so
  // the wizard says what is wrong before the round trip rather than after it.
  const [purpose, setPurpose] = useState("");
  const policy = useAsync(
    () =>
      api.get<EffectivePolicyView>(
        `/api/resources/${resourceId}/policy/effective?environment=${environment}`,
      ),
    [resourceId, environment],
  );
  const action = useAction();
  const document = (policy.data?.document ?? {}) as Record<string, unknown>;
  const rateLimit = document.rateLimit as { calls: number; periodSec: number; per?: string } | undefined;
  const quota = document.quota as { calls: number; periodSec: number } | undefined;

  return (
    <Panel title="What you are agreeing to" hint="Read from what the gateway is actually running here, not from a default.">
      <Notice kind="error">{action.error}</Notice>
      {/* Without the effective policy the limits below would read "None set here", which is a
          claim rather than a gap. Say which it is before somebody agrees to it. */}
      {policy.error && (
        <Notice kind="warn">
          The limits in force here could not be read ({policy.error}), so the rate limit and quota
          below are unknown rather than absent. Subscribing still works; check them on the API's
          page afterwards.
        </Notice>
      )}
      <dl className="kv">
        <dt>
          <Term name="application" />
        </dt>
        <dd>{application?.name ?? "—"}</dd>
        <dt>
          <Term name="product" />
        </dt>
        <dd>{product.name}</dd>
        <dt>
          <Term name="environment" />
        </dt>
        <dd>{environment.toUpperCase()}</dd>
        <dt>
          <Term name="rate limit" />
        </dt>
        <dd>
          {rateLimit ? (
            <>
              {rateLimit.calls} calls every {rateLimit.periodSec} seconds
              {rateLimit.per === "instance" && (
                <span className="muted"> — counted per gateway, so the fleet total is higher</span>
              )}
            </>
          ) : (
            <span className="muted">None set here.</span>
          )}
        </dd>
        <dt>
          <Term name="quota" />
        </dt>
        <dd>
          {quota ? (
            <>
              {quota.calls.toLocaleString()} calls per {Math.round(quota.periodSec / 86400)} days,
              counted across the whole fleet
            </>
          ) : (
            <span className="muted">None set here.</span>
          )}
        </dd>
      </dl>

      <div className="field" style={{ marginTop: 14 }}>
        <label htmlFor="sw-purpose">What will you use it for?</label>
        <textarea
          id="sw-purpose"
          rows={3}
          minLength={3}
          maxLength={500}
          value={purpose}
          onChange={(event) => setPurpose(event.target.value)}
        />
        <p className="muted small">
          {product.name} belongs to somebody, and they decide by reading this. Say which system is
          calling and what it needs — 3 to 500 characters.
        </p>
      </div>

      <div className="inline">
        <button className="ghost" onClick={onBack}>
          Back
        </button>
        <button
          disabled={action.busy || !application || purpose.trim().length < 3}
          onClick={async () => {
            await action.run(async () => {
              // No key comes back. The subscription is `pending` or `activating` at this point and
              // the key is revealable only once it is `active`, so the panel below says what is
              // happening rather than showing a secret that does not exist yet.
              const created = await api.post<{ id: string; state: string; warnings?: string[] }>(
                `/api/catalog/${product.id}/subscribe`,
                { applicationId: application!.id, environment, purpose: purpose.trim() },
              );
              onSubscribed(created.id, created.state, created.warnings ?? []);
            });
          }}
        >
          Subscribe
        </button>
        {!application && (
          <span className="action-reason">Go back and choose the application that will call.</span>
        )}
        {application && purpose.trim().length < 3 && (
          <span className="action-reason">Say what you will use it for first.</span>
        )}
      </div>
    </Panel>
  );
}

/**
 * What actually happened, with something to do about it — not a confirmation that nothing follows
 * from.
 *
 * This used to be called `Granted` and showed the key, under "this is the only time the key is
 * shown". It could never have shown one: creating a subscription mints the key, encrypts it and
 * deliberately does not return it, and `/reveal` refuses until the state is `active` — which a
 * subscription one second old never is. So the panel rendered `undefined` beside a warning that it
 * was the reader's only chance to copy it. It now says which of the two waits this is and sends
 * people to the subscription, where revealing the key is one audited click.
 */
/** Exported so `ui/test` can assert the completion panel names what to do next (plan §9.2). */
export function Requested({
  state,
  warnings,
  subscriptionId,
  listing,
  environment,
  resourceId,
}: {
  /** `pending` — waiting on the publisher. `activating` — your own product, so already decided. */
  state: string;
  /** Retired members of the product. The call succeeded; these are still worth reading. */
  warnings: string[];
  subscriptionId: string;
  listing: MarketListingDetail;
  environment: string;
  resourceId: string;
}) {
  const endpoint = listing.endpoints.find((candidate) => candidate.environment === environment);
  const url = endpoint
    ? `https://${endpoint.host === "*" ? "<gateway-host>" : endpoint.host}${endpoint.basePath === "/" ? "" : endpoint.basePath}`
    : "<the API's address>";
  const own = state === "activating";

  return (
    <Panel title={own ? "Access approved" : "Request sent"}>
      <Notice kind="info">
        {own
          ? "This is your own application's product, so there was nobody to ask. Access is activating across the gateways now."
          : "The publisher decides. They have the purpose you wrote, and you will be notified either way."}
      </Notice>
      {warnings.map((warning) => (
        <Notice key={warning} kind="warn">
          {warning}
        </Notice>
      ))}
      <p className="muted small">
        The key is minted and encrypted already, but it is only revealable once the subscription is
        active — so there is nothing to copy from this page. Reveal it on the subscription when it
        is, and every reveal is audited.
      </p>
      <p className="muted small">The call it will make:</p>
      <div className="pre">{`curl "${url}/…" -H "X-Api-Key: <your key>"`}</div>
      <div className="inline" style={{ marginTop: 14 }}>
        <Link to={`/subscriptions/${subscriptionId}`}>Open the subscription and reveal the key →</Link>
        <Link to={`/apis/${resourceId}/try`}>Try it from here instead</Link>
        <Link to="/catalog">Find another API</Link>
      </div>
    </Panel>
  );
}
