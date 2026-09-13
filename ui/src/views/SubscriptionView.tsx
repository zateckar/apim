import { api, type Subscription, type SubscriptionUsage } from "../api";
import { SubscriptionKeys } from "./SubscriptionKeys";
import {
  Panel,
  DangerZone,
  EmptyState,
  Link,
  Notice,
  Skeleton,
  StatusChip,
  Term,
  useAction,
  useAsync,
} from "../components";
import { ALLOWED } from "../lib/capabilities";
import { subscriptionChip } from "../lib/status";

/**
 * The states that still have something to end, which is what `DELETE /api/subscriptions/:id`
 * accepts: a request can be cancelled, an approved or live one revoked. `revoking` is already on
 * its way out and the three terminal states are over, so for those the control plane returns the
 * row unchanged — a button that reported success and changed nothing.
 */
const ENDABLE = ["pending", "activating", "active"];

/**
 * One subscription, on its own address.
 *
 * The *list* of subscriptions is the shell's own screen; this is the only thing under
 * `ui/src/views/` that `/subscriptions/…` still reaches, because the keys, the entitlements and the
 * spend are all here and none of them are on a list.
 *
 * One application's access to one product: its keys, what it may call, and what it has spent.
 */
export function SubscriptionView({ subscriptionId }: { subscriptionId: string }) {
  const list = useAsync(() => api.get<{ items: Subscription[] }>("/api/subscriptions"), []);
  const usage = useAsync(
    () => api.get<SubscriptionUsage>(`/api/subscriptions/${subscriptionId}/usage`),
    [subscriptionId],
  );
  const action = useAction();

  if (list.error) return <Notice kind="error">{list.error}</Notice>;
  if (!list.data) return <Skeleton rows={5} />;
  const subscription = list.data.items.find((row) => row.id === subscriptionId);
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

  return (
    <>
      <div className="page-toolbar"><Link to="/subscriptions">← Subscriptions</Link></div>
      <div className="object-head subscription-resource-head">
        <div>
          <h3>
            {subscription.applicationName} <span className="muted">→</span> {subscription.productName}{" "}
            <StatusChip chip={subscriptionChip(subscription.state)} />
          </h3>
          <p className="muted small">
            In <span className="pill">{subscription.environment.toUpperCase()}</span> — keys are per{" "}
            <Term name="environment" />, so this one works nowhere else.
          </p>
        </div>
      </div>

      {asPublisher ? (
        <Panel title="Keys">
          <p className="muted">
            This subscription's keys belong to the application that owns {subscription.applicationName}.
            You publish {subscription.productName}, which lets you see that they are calling it and
            lets you stop them — it does not let you read or replace their credentials, because a
            rotated key would break their caller at a moment of your choosing.
          </p>
        </Panel>
      ) : (
      <Panel
        title="Keys"
        hint="Two at once, so a key can be replaced without a moment where neither works: issue the second, move your callers, then rotate the first."
      >
        <SubscriptionKeys subscription={subscription} onChanged={list.reload} />
      </Panel>
      )}

      <Panel
        title="Quota usage"
        hint="Quota is counted across the whole fleet and aggregated on the gateways' poll, so this is the number the gateway is enforcing against."
      >
        {usage.error && <Notice kind="error">{usage.error}</Notice>}
        {!usage.data ? (
          <Skeleton rows={2} />
        ) : usage.data.windows.length === 0 ? (
          <p className="muted">Nothing counted in the current windows.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Window</th>
                <th className="right">Used</th>
                <th className="right">Resets in</th>
              </tr>
            </thead>
            <tbody>
              {usage.data.windows.map((window) => (
                <tr key={`${window.scopeKind}-${window.scopeId}-${window.periodSec}`}>
                  <td>
                    {window.periodSec >= 86400
                      ? `${Math.round(window.periodSec / 86400)} days`
                      : `${window.periodSec} seconds`}{" "}
                    <span className="muted small">{window.scopeKind}</span>
                  </td>
                  <td className="right">{window.used.toLocaleString()}</td>
                  <td className="right">{Math.round(window.resetsInSec / 60)} min</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {usage.data && <p className="muted small">{usage.data.note}</p>}
      </Panel>

      <Panel title={asPublisher ? "Withdraw their access" : pending ? "Withdraw the request" : "Stop using it"}>
        <DangerZone
          what={
            pending
              ? "Cancel this request"
              : asPublisher
                ? "Withdraw this subscription"
                : "Revoke this subscription"
          }
          name={subscription.applicationName ?? subscription.id}
          consequence={
            pending
              ? "The request is withdrawn before the publisher decided it, and cannot be un-cancelled. Asking again means a new request."
              : asPublisher
                ? "Their keys stop working at the next gateway poll and cannot be brought back. They are not told, beyond the calls failing — and the audit log records that you did it."
                : "The keys stop working at the next gateway poll and cannot be brought back; subscribing again issues new ones."
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
