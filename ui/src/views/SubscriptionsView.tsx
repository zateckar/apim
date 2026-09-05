import { useState } from "react";
import type { Session } from "../App";
import {
  api,
  type Application,
  type Subscription,
  type SubscriptionUsage,
} from "../api";
import {
  Card,
  DangerZone,
  EmptyState,
  Field,
  Link,
  Notice,
  Skeleton,
  StatusChip,
  Term,
  useAction,
  useAsync,
} from "../components";
import { ALLOWED, permit } from "../lib/capabilities";
import { subscriptionChip } from "../lib/status";

/**
 * My subscriptions (plan §9.7).
 *
 * Applications live **inside** this screen rather than beside it: "my app, its keys, what it can
 * call" is one question, and v3 answered it across two cards on a screen also holding the owner's
 * products. Splitting owner from consumer is the whole point of §9.1's two hats.
 */
export function SubscriptionsView({ session }: { session: Session }) {
  const applications = useAsync(() => api.get<{ items: Application[] }>("/api/applications"), []);
  const subscriptions = useAsync(() => api.get<{ items: Subscription[] }>("/api/subscriptions"), []);

  if (!applications.data || !subscriptions.data) return <Skeleton rows={6} />;
  const apps = applications.data.items;
  const subs = subscriptions.data.items;

  return (
    <>
      <Notice kind="error">{applications.error ?? subscriptions.error}</Notice>

      {apps.length === 0 ? (
        <EmptyState
          title="No applications yet"
          detail="An application is the thing that calls an API — a service, a job, a mobile app. Keys belong to it, so revoking one stops that caller and nobody else."
          action={<Link to="/catalog">Find an API to subscribe to →</Link>}
        />
      ) : (
        apps.map((application) => (
          <ApplicationCard
            key={application.id}
            application={application}
            subscriptions={subs.filter((row) => row.applicationId === application.id)}
            onChanged={() => {
              applications.reload();
              subscriptions.reload();
            }}
          />
        ))
      )}

      <NewApplication applicationId={session.application} onCreated={applications.reload} />
    </>
  );
}

function ApplicationCard({
  application,
  subscriptions,
  onChanged,
}: {
  application: Application;
  subscriptions: Subscription[];
  onChanged: () => void;
}) {
  const canDelete = permit("delete", application.capabilities, { application: application.applicationId });
  const action = useAction();

  return (
    <Card
      title={application.name}
      hint={`Owned by ${application.applicationId}. ${subscriptions.length} subscription${subscriptions.length === 1 ? "" : "s"}.`}
    >
      <Notice kind="error">{action.error}</Notice>

      {subscriptions.length === 0 ? (
        <EmptyState
          title="This application cannot call anything yet"
          detail="It has no subscription, so it has no key. Subscribing it to a product is what gives it one."
          action={<Link to="/catalog">Browse the catalog →</Link>}
        />
      ) : (
        <table>
          <thead>
            <tr>
              <th>Product</th>
              <th>Environment</th>
              <th>State</th>
              <th>Key last rotated</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {subscriptions.map((subscription) => (
              <tr key={subscription.id}>
                <td>
                  <Link to={`/subscriptions/${subscription.id}`}>
                    <strong>{subscription.productName ?? subscription.productId}</strong>
                  </Link>
                </td>
                <td>
                  <span className="pill">{subscription.environment}</span>
                </td>
                <td>
                  <StatusChip chip={subscriptionChip(subscription.state)} />
                </td>
                <td className="muted small">
                  {subscription.keyRotatedAt
                    ? new Date(subscription.keyRotatedAt).toLocaleDateString()
                    : "never"}
                </td>
                <td className="right">
                  <Link to={`/subscriptions/${subscription.id}`}>Keys and usage →</Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {/* Deleting an application takes its subscriptions with it, so the name is typed back. */}
      <DangerZone
        what={`Delete ${application.name}`}
        name={application.name}
        consequence="Every subscription it holds stops working at the next gateway poll, and the keys cannot be brought back."
        permission={canDelete}
        busy={action.busy}
        error={action.error}
        onConfirm={async () => {
          const ok = await action.run(() => api.del(`/api/applications/${application.id}`));
          if (ok) onChanged();
        }}
      />
    </Card>
  );
}

function NewApplication({ applicationId, onCreated }: { applicationId: string; onCreated: () => void }) {
  const [name, setName] = useState("");
  const action = useAction();
  return (
    <Card
      title="Register an application"
      hint="One per thing that calls: keys belong to an application, so a separate one per caller is what makes revoking one harmless to the rest."
    >
      <Notice kind="error">{action.error}</Notice>
      <div className="row">
        <Field label="Name" value={name} onChange={setName} placeholder="checkout-service" />
        <button
          disabled={action.busy || name.trim().length === 0}
          onClick={async () => {
            const ok = await action.run(() => api.post("/api/applications", { name, applicationId }));
            if (ok) {
              setName("");
              onCreated();
            }
          }}
        >
          Register
        </button>
      </div>
    </Card>
  );
}

// --------------------------------------------------------------------------- one subscription

/** One application's access to one product: its keys, what it may call, and what it has spent. */
export function SubscriptionView({ subscriptionId }: { subscriptionId: string }) {
  const list = useAsync(() => api.get<{ items: Subscription[] }>("/api/subscriptions"), []);
  const usage = useAsync(
    () => api.get<SubscriptionUsage>(`/api/subscriptions/${subscriptionId}/usage`),
    [subscriptionId],
  );
  const [shown, setShown] = useState<{ label: string; value: string } | null>(null);
  const action = useAction();

  if (list.error) return <Notice kind="error">{list.error}</Notice>;
  if (!list.data) return <Skeleton rows={5} />;
  const subscription = list.data.items.find((row) => row.id === subscriptionId);
  if (!subscription) {
    return (
      <EmptyState
        title="No such subscription"
        detail="It may have been deleted, or you are on neither side of it — neither the application whose application holds the keys nor the application that publishes the product."
        action={<Link to="/subscriptions">Back to my subscriptions →</Link>}
      />
    );
  }

  // A publisher reaches this page from their own product. They may end the relationship and may not
  // reach inside it, so the keys card is absent rather than present-and-refusing: every control on
  // it would 403, and a row of buttons that all fail teaches the opposite of the rule.
  const asPublisher = subscription.viewerIs === "publisher";

  return (
    <>
      <div className="object-head">
        <div>
          <h3>
            {subscription.applicationName} <span className="muted">→</span> {subscription.productName}{" "}
            <StatusChip chip={subscriptionChip(subscription.state)} />
          </h3>
          <p className="muted small">
            In <span className="pill">{subscription.environment}</span> — keys are per{" "}
            <Term name="environment" />, so this one works nowhere else.
          </p>
        </div>
      </div>

      {asPublisher ? (
        <Card title="Keys">
          <p className="muted">
            This subscription's keys belong to the application that owns {subscription.applicationName}.
            You publish {subscription.productName}, which lets you see that they are calling it and
            lets you stop them — it does not let you read or replace their credentials, because a
            rotated key would break their caller at a moment of your choosing.
          </p>
        </Card>
      ) : (
      <Card
        title="Keys"
        hint="Two at once, so a key can be replaced without a moment where neither works: create the second, move your callers, then rotate the first."
      >
        <Notice kind="error">{action.error}</Notice>
        {shown && (
          <>
            <Notice kind="warn">
              {shown.label} — copy it now. It is encrypted at rest and every reveal is audited.
            </Notice>
            <div className="pre">{shown.value}</div>
          </>
        )}
        <div className="inline">
          <button
            className="ghost"
            disabled={action.busy || subscription.state !== "active"}
            onClick={() =>
              action.run(async () => {
                const revealed = await api.post<{ primaryKey: string }>(
                  `/api/subscriptions/${subscription.id}/reveal`,
                );
                setShown({ label: "Primary key", value: revealed.primaryKey });
              })
            }
          >
            Reveal the primary key
          </button>
          <button
            className="ghost"
            disabled={action.busy || subscription.state !== "active"}
            onClick={() =>
              action.run(async () => {
                const rotated = await api.post<{ key: string }>(
                  `/api/subscriptions/${subscription.id}/rotate`,
                  { which: "secondary" },
                );
                setShown({ label: "New secondary key", value: rotated.key });
                list.reload();
              })
            }
          >
            Issue a secondary key
          </button>
          <button
            className="ghost"
            disabled={action.busy || subscription.state !== "active"}
            onClick={() =>
              action.run(async () => {
                const rotated = await api.post<{ key: string }>(
                  `/api/subscriptions/${subscription.id}/rotate`,
                  { which: "primary" },
                );
                setShown({ label: "New primary key", value: rotated.key });
                list.reload();
              })
            }
          >
            Replace the primary key
          </button>
        </div>
      </Card>
      )}

      <Card
        title="What it has spent"
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
      </Card>

      <Card title={asPublisher ? "Withdraw their access" : "Stop using it"}>
        <DangerZone
          what={asPublisher ? "Withdraw this subscription" : "Revoke this subscription"}
          name={subscription.applicationName ?? subscription.id}
          consequence={
            asPublisher
              ? "Their keys stop working at the next gateway poll and cannot be brought back. They are not told, beyond the calls failing — and the audit log records that you did it."
              : "The keys stop working at the next gateway poll and cannot be brought back; subscribing again issues new ones."
          }
          permission={
            subscription.state !== "active"
              ? { enabled: false, reason: "This subscription is already revoked." }
              : (subscription.capabilities ?? []).includes("delete")
                ? ALLOWED
                : {
                    enabled: false,
                    reason:
                      "You are on neither side of this subscription: it is not your application's application, and not your application's product.",
                  }
          }
          busy={action.busy}
          error={action.error}
          onConfirm={async () => {
            const ok = await action.run(() => api.del(`/api/subscriptions/${subscription.id}`));
            if (ok) list.reload();
          }}
        />
      </Card>
    </>
  );
}
