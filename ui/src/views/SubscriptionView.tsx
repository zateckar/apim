import {
  api,
  type EffectivePolicyView,
  type MarketListingDetail,
  type Product,
  type Subscription,
  type SubscriptionUsage,
} from "../api";
import { SubscriptionKeys } from "./SubscriptionKeys";
import {
  Panel,
  CopyButton,
  DangerZone,
  EmptyState,
  Link,
  Notice,
  Skeleton,
  StatusChip,
  envLabel,
  useAction,
  useAsync,
  usePageTitle,
} from "../components";
import { ALLOWED } from "../lib/capabilities";
import { formatDateTime } from "../lib/datetime";
import { endpointChip, subscriptionChip } from "../lib/status";
import { listAll } from "../portal/client";
import { KindBadge, type Kind } from "../portal/components/KindBadge";

/**
 * The states that still have something to end, which is what `DELETE /api/subscriptions/:id`
 * accepts: a request can be cancelled, an approved or live one revoked. `revoking` is already on
 * its way out and the three terminal states are over, so for those the control plane returns the
 * row unchanged — a button that reported success and changed nothing.
 */
const ENDABLE = ["pending", "activating", "active"];

/** The states in which calling it is, or is about to be, a thing somebody does. */
const CALLABLE = ["pending", "activating", "active"];

/** How an API asks for its key: the `auth.subscriptionKey` unit, as the gateway will be served it. */
export interface KeyUnit {
  in: "header" | "query";
  name: string;
}

/**
 * A call somebody can paste, against an address the gateway actually publishes.
 *
 * Built here rather than taken from the listing's `example`, because that one is for whichever
 * environment the API happens to be live in first and uses `<gateway-host>` when the route has no
 * host — the one thing the reader cannot guess. The subscription names its environment, and the
 * listing names every published address in it.
 *
 * Double quotes, so `$SUBSCRIPTION_KEY` is expanded by the shell it is pasted into. The key goes
 * where the API's own unit says (api-subscription-management, "Show a consumer how to use the
 * key"), and nowhere at all when the API asks for none — an invented header is worse than none.
 */
export function callExample(
  kind: string,
  url: string,
  key: KeyUnit | null,
  operations: ReadonlyArray<{ method?: string; path?: string }> = [],
): string {
  const base = url.replace(/\/$/, "");
  const query = key?.in === "query" ? `?${key.name}=$SUBSCRIPTION_KEY` : "";
  const header = key?.in === "header" ? ` -H "${key.name}: $SUBSCRIPTION_KEY"` : "";
  if (kind === "mcp") {
    return `curl -X POST "${base}${query}"${header} -H "content-type: application/json" \\\n  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'`;
  }
  if (kind === "a2a") {
    return `curl -X POST "${base}${query}"${header} -H "content-type: application/json" \\\n  -d '{"jsonrpc":"2.0","id":1,"method":"message/send","params":{"message":{"role":"user","kind":"message","parts":[{"kind":"text","text":"hello"}]}}}'`;
  }
  if (kind === "soap") {
    return `curl -X POST "${base}${query}"${header} -H "content-type: text/xml; charset=utf-8" \\\n  --data-binary @request.xml`;
  }
  // A GET with no path parameters works as pasted; anything else needs a body or a value somebody
  // has to fill in, so the base address is the honest fallback.
  const get = operations.find(
    (operation) => operation.method?.toUpperCase() === "GET" && operation.path && !/\{[^}]+\}/.test(operation.path),
  );
  return `curl "${base}${get?.path ?? ""}${query}"${header}`;
}

/** A period exactly, in the largest unit that divides it: `30 days`, `1 hour`, `90 seconds`. */
export function periodLabel(seconds: number): string {
  for (const [size, name] of [[86400, "day"], [3600, "hour"], [60, "minute"]] as const) {
    if (seconds >= size && seconds % size === 0) {
      const n = seconds / size;
      return n === 1 ? `1 ${name}` : `${n.toLocaleString()} ${name}s`;
    }
  }
  return seconds === 1 ? "1 second" : `${seconds.toLocaleString()} seconds`;
}

/** `per minute`, `per 30 days` — the way a limit is read aloud. */
export function perPeriod(seconds: number): string {
  const label = periodLabel(seconds);
  return label.startsWith("1 ") ? `per ${label.slice(2)}` : `per ${label}`;
}

/** How long until a window resets, to the unit a reader plans in. Approximate on purpose. */
function resetsIn(seconds: number): string {
  if (seconds >= 86400) return `${Math.round(seconds / 86400)} days`;
  if (seconds >= 3600) return `${Math.round(seconds / 3600)} h`;
  if (seconds >= 60) return `${Math.round(seconds / 60)} min`;
  return `${seconds} s`;
}

/**
 * One subscription, on its own address.
 *
 * The *list* of subscriptions is the shell's own screen; this is the only thing under
 * `ui/src/views/` that `/subscriptions/…` still reaches, because the keys, the entitlements and the
 * spend are all here and none of them are on a list.
 *
 * One application's access to one product: its keys, what it may call and how, and what it has
 * spent. "What it may call" was promised by the route's own purpose line and by the spec and was
 * not on the screen — a reader with a key in hand still had to go and find the address it worked at.
 */
export function SubscriptionView({ subscriptionId }: { subscriptionId: string }) {
  const list = useAsync(() => api.get<{ items: Subscription[] }>("/api/subscriptions"), []);
  const action = useAction();
  const subscription = list.data?.items.find((row) => row.id === subscriptionId);
  usePageTitle(
    subscription ? `${subscription.productName ?? subscription.productId} in ${envLabel(subscription.environment)}` : null,
  );

  if (list.error) return <Notice kind="error">{list.error}</Notice>;
  if (!list.data) return <Skeleton rows={5} />;
  if (!subscription) {
    return (
      <EmptyState
        title="No such subscription"
        detail="It may have been deleted, or you are on neither side of it — neither the application that holds the keys nor the application that publishes the product."
        action={<Link to="/subscriptions">Back to my subscriptions →</Link>}
      />
    );
  }

  // A publisher reaches this page from their own product. They may end the relationship and may not
  // reach inside it, so the keys card is absent rather than present-and-refusing: every control on
  // it would 403, and a row of buttons that all fail teaches the opposite of the rule.
  const asPublisher = subscription.viewerIs === "publisher";
  // A request nobody has decided yet is cancelled, not revoked: nothing was granted, so nothing is
  // being taken away, and the two words mean different things to whoever reads the audit later.
  const pending = subscription.state === "pending";
  const environment = envLabel(subscription.environment);

  return (
    <>
      <div className="object-head subscription-resource-head">
        <dl className="kv">
          <dt>State</dt>
          <dd><StatusChip chip={subscriptionChip(subscription.state)} /></dd>
          <dt>Application</dt>
          <dd>{subscription.applicationName ?? subscription.applicationId}</dd>
          <dt>Product</dt>
          <dd>{subscription.productName ?? subscription.productId}</dd>
          <dt>Environment</dt>
          <dd>{environment} <span className="muted small">— its keys work here and nowhere else</span></dd>
          {subscription.purpose && (
            <>
              <dt>Purpose</dt>
              <dd>{subscription.purpose}</dd>
            </>
          )}
          {subscription.createdAt && (
            <>
              <dt>Requested</dt>
              <dd>{formatDateTime(subscription.createdAt)}</dd>
            </>
          )}
        </dl>
      </div>

      {asPublisher ? (
        <Panel title="Keys">
          <p className="muted">
            The keys belong to {subscription.applicationName}. Publishing {subscription.productName} lets
            you see who calls it and revoke their access, not read or replace their keys — a rotated
            key would break their caller at a moment of your choosing.
          </p>
        </Panel>
      ) : (
        <Panel title="Keys" hint="Two keys, so one can be replaced while your callers use the other.">
          <SubscriptionKeys subscription={subscription} onChanged={list.reload} />
        </Panel>
      )}

      <Entitlements subscription={subscription} consumer={!asPublisher} />

      <Panel title={pending ? "Cancel the request" : "Revoke access"}>
        <DangerZone
          what={pending ? "Cancel this request" : "Revoke this subscription"}
          name={subscription.applicationName ?? subscription.id}
          consequence={
            pending
              ? "The request is withdrawn before the publisher decides, and cannot be restored. Asking again means a new request."
              : asPublisher
                ? "Their keys stop working once the gateways apply the change, and cannot be brought back. They are not told beyond the calls failing; the audit log records that you did it."
                : "The keys stop working once the gateways apply the change, and cannot be brought back. Subscribing again issues new ones."
          }
          permission={
            // Six of the seven states can be ended, one way or another — and the button used to
            // read "already revoked" at all of them, including `pending`, where nothing had been
            // granted to revoke, and `revoking`, where the request is in flight and not yet done.
            !ENDABLE.includes(subscription.state)
              ? {
                  enabled: false,
                  reason:
                    subscription.state === "revoking"
                      ? "This subscription is being revoked — the gateways have not stopped accepting its keys yet."
                      : `This subscription is ${subscriptionChip(subscription.state).label.toLowerCase()}, so there is nothing left to end.`,
                }
              : (subscription.capabilities ?? []).includes("delete")
                ? ALLOWED
                : {
                    enabled: false,
                    reason:
                      "You are on neither side of this subscription: the application holding the keys is not yours, and neither is the product it calls.",
                  }
          }
          busy={action.busy}
          error={action.error}
          onConfirm={async () => {
            const ok = await action.run(() => api.del(`/api/subscriptions/${subscription.id}`));
            if (ok) list.reload();
          }}
        />
      </Panel>
    </>
  );
}

interface CallTarget {
  member: { id: string; name: string };
  listing: MarketListingDetail | null;
  /** The effective policy document in the subscription's environment; `null` when it could not be read. */
  document: Record<string, unknown> | null;
  failed: string | null;
}

/**
 * What the subscription reaches, how to call each of it, and what has been spent against it. One
 * component because the three questions are answered from the same reads: the product's members,
 * each member's listing for its addresses, and each member's effective policy for its key and its
 * limits.
 */
function Entitlements({ subscription, consumer }: { subscription: Subscription; consumer: boolean }) {
  const environment = envLabel(subscription.environment);
  const products = useAsync(() => listAll<Product>("/api/products"), []);
  const product = products.data?.items.find((entry) => entry.id === subscription.productId) ?? null;
  const members = product?.members ?? [];
  const targets = useAsync(
    () =>
      Promise.all(
        members.map(async (member): Promise<CallTarget> => {
          // Each API on its own: one that cannot be read must not hide the others.
          const [listing, policy] = await Promise.allSettled([
            api.get<MarketListingDetail>(`/api/catalog/${member.id}`),
            api.get<EffectivePolicyView>(
              `/api/resources/${member.id}/policy/effective?environment=${encodeURIComponent(subscription.environment)}`,
            ),
          ]);
          return {
            member,
            listing: listing.status === "fulfilled" ? listing.value : null,
            document: policy.status === "fulfilled" ? policy.value.document : null,
            failed:
              listing.status === "rejected"
                ? String((listing.reason as Error)?.message ?? listing.reason)
                : null,
          };
        }),
      ),
    [product?.id, members.map((member) => member.id).join(","), subscription.environment],
  );
  // The usage endpoint answers the consumer only; a publisher would read a 404 as "no such thing".
  const usage = useAsync(
    () =>
      consumer
        ? api.get<SubscriptionUsage>(`/api/subscriptions/${subscription.id}/usage`)
        : Promise.resolve(null),
    [subscription.id, consumer],
  );
  const callable = CALLABLE.includes(subscription.state);

  return (
    <>
      <Panel
        title="What it may call"
        hint={
          consumer && callable
            ? `The APIs in ${subscription.productName}, at their addresses in ${environment}. Set SUBSCRIPTION_KEY to one of the keys above before running an example.`
            : `The APIs in ${subscription.productName}, at their addresses in ${environment}.`
        }
      >
        <Notice kind="error">{products.error}</Notice>
        <Notice kind="error">{targets.error}</Notice>
        {products.loading || (product && targets.loading && !targets.data) ? (
          <Skeleton rows={3} />
        ) : !product ? (
          !products.error && (
            <p className="muted">The product is no longer listed, so what it contains cannot be shown.</p>
          )
        ) : members.length === 0 ? (
          <p className="muted">
            {subscription.productName} holds no APIs at the moment, so this subscription reaches nothing.
          </p>
        ) : (
          (targets.data ?? []).map((target) => (
            <CallTargetBlock
              key={target.member.id}
              target={target}
              environment={subscription.environment}
              showCall={consumer && callable}
            />
          ))
        )}
      </Panel>

      {consumer && (
        <Panel title="Quota usage" hint={`Counted across every gateway in ${environment} — the number the gateway enforces. Not a billing record.`}>
          <Notice kind="error">{usage.error}</Notice>
          {!usage.data ? (
            !usage.error && <Skeleton rows={2} />
          ) : usage.data.windows.length === 0 ? (
            <p className="muted">Nothing used in the current quota windows.</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Counted for</th>
                  <th>Window</th>
                  <th className="right">Used</th>
                  <th className="right">Resets in</th>
                </tr>
              </thead>
              <tbody>
                {usage.data.windows.map((window) => {
                  const limit = limitFor(window, targets.data ?? []);
                  return (
                    <tr key={`${window.scopeKind}-${window.scopeId}-${window.periodSec}`}>
                      <td>{scopeLabel(window, members)}</td>
                      <td>{periodLabel(window.periodSec)}</td>
                      <td className="right">
                        {window.used.toLocaleString()}
                        {limit !== null && <span className="muted"> of {limit.toLocaleString()}</span>}
                      </td>
                      <td className="right">{resetsIn(window.resetsInSec)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          <RateLimits targets={targets.data ?? []} />
        </Panel>
      )}
    </>
  );
}

function CallTargetBlock({
  target,
  environment,
  showCall,
}: {
  target: CallTarget;
  environment: string;
  showCall: boolean;
}) {
  const { member, listing, document } = target;
  const endpoint = listing?.endpoints.find((entry) => entry.environment === environment);
  const key = (document?.["auth.subscriptionKey"] as KeyUnit | undefined) ?? null;
  const url = endpoint?.urls[0]?.url;
  return (
    <section className="call-target">
      <h4>
        <Link to={`/catalog/${member.id}`}>{listing?.title ?? member.name}</Link>
        {listing && <span className="mono muted">{listing.apiVersion}</span>}
        {listing && <KindBadge kind={listing.kind as Kind} />}
        {listing && <StatusChip chip={endpointChip(Boolean(endpoint?.live))} />}
      </h4>
      {target.failed ? (
        <p className="muted">Its listing could not be read: {target.failed}</p>
      ) : !endpoint?.live ? (
        <p className="muted">Not released in {envLabel(environment)} yet, so there is nothing to call there.</p>
      ) : endpoint.urls.length === 0 ? (
        <p className="muted">No gateway in {envLabel(environment)} publishes an address for it yet.</p>
      ) : (
        <>
          <ul className="url-list">
            {endpoint.urls.map((entry) => (
              <li key={`${entry.gateway}:${entry.url}`}>
                <span className="chip">{entry.network === "intranet" ? "Intranet" : "Internet"}</span>
                <div className="copy-row">
                  <code>{entry.url}</code>
                  <CopyButton value={entry.url} what={`the ${entry.network} address`} />
                </div>
              </li>
            ))}
          </ul>
          {showCall && (
            <>
              <p className="small">
                {document === null ? (
                  <span className="muted">Where it expects the key could not be read. Its listing shows how to call it.</span>
                ) : key === null ? (
                  <>It asks for no subscription key in {envLabel(environment)}.</>
                ) : key.in === "header" ? (
                  <>Send the key in the <code>{key.name}</code> header.</>
                ) : (
                  <>Send the key as the <code>{key.name}</code> query parameter.</>
                )}
              </p>
              {document !== null && url && (
                <CallExample text={callExample(listing!.kind, url, key, listing!.operations)} />
              )}
            </>
          )}
        </>
      )}
    </section>
  );
}

/** A copyable block of shell. Exported for the listing's Getting started, which shows the same thing. */
export function CallExample({ text }: { text: string }) {
  return (
    <div className="copy-row copy-block">
      <pre className="pre">{text}</pre>
      <CopyButton value={text} what="the example call" />
    </div>
  );
}

/** The limit a quota window is counted against, when the API's own policy says so. */
function limitFor(window: SubscriptionUsage["windows"][number], targets: CallTarget[]): number | null {
  const quotaOf = (target: CallTarget) =>
    target.document?.quota as { calls: number; periodSec: number; scope?: string } | undefined;
  if (window.scopeKind === "route") {
    const quota = quotaOf(targets.find((target) => target.member.id === window.scopeId) ?? ({} as CallTarget));
    return quota && quota.scope !== "product" && quota.periodSec === window.periodSec ? quota.calls : null;
  }
  if (window.scopeKind === "product") {
    const quota = targets.map(quotaOf).find((unit) => unit?.scope === "product" && unit.periodSec === window.periodSec);
    return quota?.calls ?? null;
  }
  // A per-operation limit is an override inside the policy, not the document's own `quota`.
  return null;
}

/** What a quota window is counted for, by name rather than by id. */
function scopeLabel(window: SubscriptionUsage["windows"][number], members: Array<{ id: string; name: string }>): string {
  const name = (id: string) => members.find((member) => member.id === id)?.name ?? id;
  if (window.scopeKind === "product") return "The whole product";
  if (window.scopeKind === "operation") {
    const [resourceId, ...operation] = window.scopeId.split(":");
    return `${name(resourceId!)} · ${operation.join(":")}`;
  }
  return name(window.scopeId);
}

/**
 * Rate limits are counted on each gateway instance separately, so the ceiling a consumer can reach
 * is the limit times the instances serving it. The spec requires that said rather than hidden
 * (api-subscription-management, "Usage is read"); a reader who load-tests against one instance and
 * then meets the real one should not be surprised in either direction.
 */
function RateLimits({ targets }: { targets: CallTarget[] }) {
  const limited = targets
    .map((target) => ({
      target,
      unit: target.document?.rateLimit as { calls: number; periodSec: number } | undefined,
    }))
    .filter((entry) => entry.unit);
  if (limited.length === 0) return null;
  return (
    <>
      <h4>Rate limits</h4>
      <ul className="plain">
        {limited.map(({ target, unit }) => (
          <li key={target.member.id}>
            <strong>{target.listing?.title ?? target.member.name}</strong>: {unit!.calls.toLocaleString()} calls{" "}
            {perPeriod(unit!.periodSec)} on each gateway instance, so the total across instances is that many times higher.
          </li>
        ))}
      </ul>
    </>
  );
}
