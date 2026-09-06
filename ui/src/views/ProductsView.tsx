import { useState } from "react";
import type { Session } from "../App";
import { api, type Product, type Resource, type Subscription } from "../api";
import {
  Action,
  Card,
  EmptyState,
  TextField,
  Link,
  Notice,
  Skeleton,
  StatusChip,
  Term,
  useAction,
  useAsync,
} from "../components";
import { permit } from "../lib/capabilities";
import { subscriptionChip } from "../lib/status";

/**
 * My products (plan §9.7).
 *
 * A product is the unit a consumer subscribes to, and the reason it exists is worth restating on
 * the screen: a key issued per API would have to be reissued every time a bundle changed, so the
 * key belongs to the bundle. That makes "what is in this product" the decision an owner is really
 * making here, and "who has subscribed" the consequence they need to see beside it.
 */
export function ProductsView({ session }: { session: Session }) {
  const products = useAsync(() => api.get<{ items: Product[] }>("/api/products"), []);
  const resources = useAsync(() => api.get<{ items: Resource[] }>("/api/resources?application=mine"), []);
  const subscriptions = useAsync(() => api.get<{ items: Subscription[] }>("/api/subscriptions"), []);

  // `resources` feeds the members picker and `subscriptions` the counts; either failing leaves a
  // screen that looks like an owner with no APIs and no subscribers, which is a different story.
  if (products.error || resources.error) {
    return <Notice kind="error">{products.error ?? resources.error}</Notice>;
  }
  if (!products.data || !resources.data) return <Skeleton rows={5} />;
  const shown = products.data.items.filter(product => product.applicationId === session.application);

  return (
    <>
      {subscriptions.error && (
        <Notice kind="warn">
          Subscriber counts are unavailable ({subscriptions.error}); the products below are correct.
        </Notice>
      )}
      {shown.length === 0 ? (
        <EmptyState
          title="No products yet"
          detail="Until an API is in a product, nobody can subscribe to it — a subscription is to a product, never to an API directly."
          action={<a href="#new-product">Create the first one →</a>}
        />
      ) : (
        shown.map((product) => (
          <ProductCard
            key={product.id}
            product={product}
            resources={resources.data!.items.filter(r => r.applicationId === session.application)}
            subscriptions={(subscriptions.data?.items ?? []).filter(
              (row) => row.productId === product.id,
            )}
            onChanged={() => {
              products.reload();
              subscriptions.reload();
            }}
          />
        ))
      )}

      <div id="new-product">
        <NewProduct
          applicationId={session.application}
          resources={resources.data.items.filter(r => r.applicationId === session.application)}
          onCreated={products.reload}
        />
      </div>
    </>
  );
}

function ProductCard({
  product,
  resources,
  subscriptions,
  onChanged,
}: {
  product: Product;
  resources: Resource[];
  subscriptions: Subscription[];
  onChanged: () => void;
}) {
  const canEdit = permit("members", product.capabilities, { application: product.applicationId });
  const [members, setMembers] = useState(product.members.map((member) => member.id));
  const action = useAction();
  const dirty =
    members.length !== product.members.length ||
    members.some((id) => !product.members.some((member) => member.id === id));

  return (
    <Card
      title={product.name}
      hint={`Owned by ${product.applicationId}. ${subscriptions.length} subscription${subscriptions.length === 1 ? "" : "s"}.`}
    >
      <Notice kind="error">{action.error}</Notice>
      <Notice kind="ok">{action.message}</Notice>

      <div className="field">
        <label htmlFor={`members-${product.id}`}>
          <Term name="api">APIs</Term> in this product
        </label>
        <select
          id={`members-${product.id}`}
          multiple
          size={Math.min(6, Math.max(3, resources.length))}
          value={members}
          disabled={!canEdit.enabled}
          onChange={(event) =>
            setMembers(Array.from(event.target.selectedOptions).map((option) => option.value))
          }
        >
          {resources.map((resource) => (
            <option key={resource.id} value={resource.id}>
              {resource.name} {resource.apiVersion}
            </option>
          ))}
        </select>
      </div>
      <p className="muted small">
        Every subscriber's key works for every API in here, immediately. Removing one takes it away
        from every subscriber at the next gateway poll.
      </p>
      <Action
        permission={canEdit}
        busy={action.busy || !dirty}
        onClick={async () => {
          const ok = await action.run(
            () => api.put(`/api/products/${product.id}/members`, { resourceIds: members }),
            "Saved. Subscribers see the change at the next gateway poll.",
          );
          if (ok) onChanged();
        }}
      >
        Save what is in this product
      </Action>

      <h4 style={{ marginTop: 20, marginBottom: 6, fontSize: 13 }}>Who has subscribed</h4>
      {subscriptions.length === 0 ? (
        <p className="muted small">
          Nobody yet. It appears in the <Link to="/catalog">Catalog</Link> for anybody allowed to see
          its APIs.
        </p>
      ) : (
        <>
          <table>
            <thead>
              <tr>
                <th>Application</th>
                <th>Environment</th>
                <th>State</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {subscriptions.map((subscription) => (
                <tr key={subscription.id}>
                  <td>{subscription.applicationName ?? subscription.applicationId}</td>
                  <td>
                    <span className="pill">{subscription.environment}</span>
                  </td>
                  <td>
                    <StatusChip chip={subscriptionChip(subscription.state)} />
                  </td>
                  <td className="right">
                    <Link to={`/subscriptions/${subscription.id}`}>Withdraw it →</Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted small">
            You publish this product, so you can withdraw anybody's access to it — an abusive or
            compromised caller is yours to stop, without finding an administrator first. You cannot
            see or replace their keys: those belong to the application that owns the application.
          </p>
        </>
      )}
    </Card>
  );
}

function NewProduct({
  applicationId,
  resources,
  onCreated,
}: {
  applicationId: string;
  resources: Resource[];
  onCreated: () => void;
}) {
  const [name, setName] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const action = useAction();

  return (
    <Card
      title="Create a product"
      hint="Bundle the APIs a consumer would want together. One subscription, one key, every API in it."
    >
      <Notice kind="error">{action.error}</Notice>
      <div className="row">
        <TextField label="Name" value={name} onChange={setName} placeholder="orders-product" />
        <div className="field">
          <label htmlFor="new-product-members">APIs to include</label>
          <select
            id="new-product-members"
            multiple
            size={Math.min(4, Math.max(2, resources.length))}
            value={selected}
            onChange={(event) =>
              setSelected(Array.from(event.target.selectedOptions).map((option) => option.value))
            }
          >
            {resources.map((resource) => (
              <option key={resource.id} value={resource.id}>
                {resource.name} {resource.apiVersion}
              </option>
            ))}
          </select>
        </div>
        <button
          disabled={action.busy || name.trim().length === 0}
          onClick={async () => {
            const ok = await action.run(() =>
              api.post("/api/products", { name, applicationId, resourceIds: selected }),
            );
            if (ok) {
              setName("");
              setSelected([]);
              onCreated();
            }
          }}
        >
          Create
        </button>
      </div>
    </Card>
  );
}
