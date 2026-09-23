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
  CopyButton,
  EmptyState,
  Field,
  Link,
  Notice,
  Segmented,
  Skeleton,
  Term,
  envLabel,
  useAction,
  useAsync,
  usePageTitle,
} from "../components";
import { perPeriod } from "./SubscriptionView";

/**
 * The shell supplies the consumer application (api-subscription-management, "Subscribe from
 * Catalog for the selected application"). Environment and purpose fit in one form.
 * Limits come from the effective policy so consumers see what they are agreeing to.
 */
export function SubscribeWizard({ resourceId, session }: { resourceId: string; session: Session }) {
  const listing = useAsync(() => api.get<MarketListingDetail>(`/api/catalog/${resourceId}`), [resourceId]);
  const application = session.applications.find((app) => app.id === session.application
    && (session.user.isAdmin || session.user.applications.includes(app.id)));
  // "New subscription", not "Subscribe to …": what is subscribed to is a product carrying this
  // resource, never the resource itself (api-subscription-management, "A control that starts a
  // subscription is labelled"). The title names the resource because that is what the reader came from.
  usePageTitle(listing.data ? `New subscription for ${listing.data.title}` : null);

  const [done, setDone] = useState<{ id: string; state: string; warnings: string[]; environment: string } | null>(null);

  if (listing.error) return <Notice kind="error">{listing.error}</Notice>;
  if (!listing.data) return <Skeleton rows={6} />;
  if (!application) {
    return (
      <EmptyState
        title="Select an application in the main menu"
        detail="You need an application you can act for to subscribe. Ask an administrator for membership if none is available."
        action={<Link to="/account">View your account</Link>}
      />
    );
  }
  const api_ = listing.data;

  if (api_.products.length === 0) {
    return (
      <EmptyState
        title={`${api_.title} is not in any product yet`}
        detail="A subscription is to a product, never to a resource directly — so until its owner puts it in one, there is nothing to ask for."
        action={<Link to={`/catalog/${resourceId}`}>Back to the resource →</Link>}
      />
    );
  }

  return (
    <>
      <p className="muted">
        Subscribing as <strong>{application.name}</strong> to a product containing{" "}
        <Link to={`/catalog/${resourceId}`}>{api_.title} {api_.apiVersion}</Link>.
      </p>

      {done ? (
        <Requested
          state={done.state}
          warnings={done.warnings}
          subscriptionId={done.id}
          listing={api_}
          environment={done.environment}
          resourceId={resourceId}
        />
      ) : (
        <SubscriptionForm
          resourceId={resourceId}
          session={session}
          listing={api_}
          application={application}
          onSubscribed={(id, state, warnings, environment) => setDone({ id, state, warnings, environment })}
        />
      )}
    </>
  );
}

function SubscriptionForm({
  resourceId,
  session,
  listing: api_,
  application,
  onSubscribed,
}: {
  resourceId: string;
  session: Session;
  listing: MarketListingDetail;
  application: Pick<Application, "id" | "name">;
  onSubscribed: (id: string, state: string, warnings: string[], environment: string) => void;
}) {
  const [environment, setEnvironment] = useState(session.environment);
  const [productId, setProductId] = useState("");
  const live = api_.endpoints.filter((endpoint) => endpoint.live).map((endpoint) => endpoint.environment);
  const product = api_.products.find((product) => product.id === productId) ?? api_.products[0]!;

  // The publisher reads this before deciding, and it is the only thing on the approval request that
  // is not a machine-generated id. The server requires 3–500 characters (api-subscription-management,
  // "A subscription is per environment and carries a purpose"); the same bounds are enforced here so
  // the form says what is wrong before the round trip rather than after it.
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
  const trimmed = purpose.trim().length;
  const blocked = !live.includes(environment)
    ? "Choose an environment where this resource is live."
    : trimmed < 3
      ? "Say what you will use it for first."
      : trimmed > 500
        ? "Shorten the purpose to 500 characters."
        : null;

  return (
    <Panel>
      <fieldset className="subscribe-form" disabled={action.busy}>
        {/* A `div`, not `Field`: `Field` is a `<label>`, and a label around a row of buttons makes
            a click on the word "Environment" press the first of them. */}
        <div className="native-field">
          <span className="lbl" aria-hidden="true">Environment</span>
          <Segmented
            label="Environment"
            value={environment}
            onChange={setEnvironment}
            options={session.meta.chain.map((candidate) => ({
              value: candidate,
              label: envLabel(candidate),
              disabled: !live.includes(candidate),
              reason: live.includes(candidate) ? undefined : `Not released in ${envLabel(candidate)}.`,
            }))}
          />
          <span className="hint">A key works only in the environment it was issued for.</span>
        </div>
        {live.length === 0 && (
          <Notice kind="warn">
            This resource is not live in any environment yet, so a subscription to it would have
            nothing to call.
          </Notice>
        )}

        {/* One product is a fact, not a choice (api-subscription-management, "A draft is edited"). */}
        {api_.products.length > 1 ? (
          <Field
            label="Product"
            hint="This resource is in more than one product. The key works for every resource in the one you pick."
          >
            <select value={product.id} onChange={(event) => setProductId(event.target.value)}>
              {api_.products.map((product) => (
                <option key={product.id} value={product.id}>
                  {product.name}
                  {product.summary ? ` — ${product.summary}` : ""}
                </option>
              ))}
            </select>
          </Field>
        ) : (
          <p className="small">
            Through the <Term name="product" /> <strong>{product.name}</strong>, which the key will
            work for as a whole.
          </p>
        )}

        <Field
          label="What will you use it for?"
          hint={`The owner of ${product.name} decides by reading this. Say which system is calling and what it needs — 3 to 500 characters.`}
        >
          <textarea
            rows={3}
            minLength={3}
            maxLength={500}
            value={purpose}
            onChange={(event) => setPurpose(event.target.value)}
          />
        </Field>

        <Notice kind="error">{action.error}</Notice>
        {/* Without the effective policy the limits below would read "None set here", which is a
            claim rather than a gap. Say which it is before somebody agrees to it. */}
        {policy.error && (
          <Notice kind="warn">
            The limits in force here could not be read ({policy.error}), so the rate limit and quota
            below are unknown rather than absent. Subscribing still works; check them on the resource's
            page afterwards.
          </Notice>
        )}

        <details>
          <summary>Limits in {envLabel(environment)}</summary>
          <p className="muted small">These are this resource's limits. Other resources in the product may have different ones.</p>
          <dl className="kv">
            <dt>
              <Term name="rate limit" />
            </dt>
            <dd>
              {policy.loading ? <span className="muted">Loading limits…</span> : policy.error ? <span className="muted">Unknown — limits could not be read.</span> : rateLimit ? (
                <>
                  {rateLimit.calls.toLocaleString()} calls {perPeriod(rateLimit.periodSec)}
                  {rateLimit.per === "instance" && (
                    <span className="muted"> — counted on each gateway instance separately, so the total across instances is higher</span>
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
              {policy.loading ? <span className="muted">Loading limits…</span> : policy.error ? <span className="muted">Unknown — limits could not be read.</span> : quota ? (
                <>
                  {quota.calls.toLocaleString()} calls {perPeriod(quota.periodSec)}, counted across all gateways
                </>
              ) : (
                <span className="muted">None set here.</span>
              )}
            </dd>
          </dl>
        </details>

        <div className="inline subscribe-actions">
          <button
            type="button"
            className="btn primary"
            disabled={action.busy || blocked !== null}
            onClick={async () => {
              await action.run(async () => {
                // No key comes back. The subscription is `pending` or `activating` at this point and
                // the key is revealable only once it is `active`, so the panel below says what is
                // happening rather than showing a secret that does not exist yet.
                const created = await api.post<{ id: string; state: string; warnings?: string[] }>(
                  `/api/catalog/${product.id}/subscribe`,
                  { applicationId: application.id, environment, purpose: purpose.trim() },
                );
                onSubscribed(created.id, created.state, created.warnings ?? [], environment);
              });
            }}
          >
            Subscribe
          </button>
          {blocked && <span className="action-reason">{blocked}</span>}
        </div>
      </fieldset>
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
  const own = state === "activating";

  return (
    <Panel title={own ? "Access approved" : "Request sent"}>
      <Notice kind="info">
        {own
          ? "This is your own application's product, so there was nobody to ask. The gateways are switching the access on now."
          : "The publisher decides. They have the purpose you wrote, and you will be notified either way."}
      </Notice>
      {warnings.map((warning) => (
        <Notice key={warning} kind="warn">
          {warning}
        </Notice>
      ))}
      <p className="muted small">
        The key can be revealed once the subscription is active, on the subscription's own page —
        there is nothing to copy here yet.
      </p>
      {endpoint?.live && endpoint.urls.length > 0 ? <>
        <p className="muted small">Published addresses in {envLabel(environment)}:</p>
        <ul className="url-list">{endpoint.urls.map(entry => <li key={`${entry.gateway}:${entry.url}`}>
          <span className="chip">{entry.network === "intranet" ? "Intranet" : "Internet"}</span>
          <div className="copy-row"><code>{entry.url}</code><CopyButton value={entry.url} what={`the ${entry.network} address`} /></div>
        </li>)}</ul>
      </> : <p className="muted small">No live gateway address is published in {envLabel(environment)} yet.</p>}
      <div className="inline subscribe-actions">
        <Link className="btn primary" to={`/subscriptions/${subscriptionId}`}>Open the subscription</Link>
        <Link className="btn" to={`/catalog/${resourceId}?tab=start`}>How to call it</Link>
        <Link className="btn ghost" to="/catalog">Find another resource</Link>
      </div>
    </Panel>
  );
}
