import { useState } from "react";
import type { Session } from "../App";
import { api, type Product, type Resource, type Subscription } from "../api";
import {
  Action,
  Panel,
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
 *
 * That decision used to be made in a `<select multiple>`, on both the edit and the create form.
 * It is a checkbox list now, and the reason is the sentence the screen itself prints underneath:
 * removing an API takes it away from every subscriber at the next gateway poll. A multi-select
 * clears the whole selection on any un-modified click, shows the selection in a grey that all but
 * disappears when the control is not focused, and offers no way to tell "nothing is in this
 * product" from "I have just lost what was" — so the one control in the portal whose slip is felt
 * by other people's running code was the one that slipped most easily.
 */

/** One row of the members picker, shared by the edit and the create form. */
function MemberPicker({
  id,
  label,
  resources,
  selected,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  resources: Resource[];
  selected: string[];
  disabled?: boolean;
  onChange: (next: string[]) => void;
}) {
  if (resources.length === 0) {
    return (
      <p className="muted">
        This application publishes nothing yet, so there is nothing to bundle. Publish an API first
        and it appears here.
      </p>
    );
  }
  return (
    <div className="pick-list" role="group" aria-labelledby={id}>
      <div className="pick-list-head">
        <strong id={id}>
          <Term name="api">{label}</Term>
        </strong>
        <span className="muted small">
          {selected.length} of {resources.length} selected
        </span>
      </div>
      <div className="pick-list-scroll">
        {resources.map((resource) => {
          const on = selected.includes(resource.id);
          return (
            <label key={resource.id} className="pick-option">
              <input
                type="checkbox"
                checked={on}
                disabled={disabled}
                onChange={() =>
                  onChange(on ? selected.filter((r) => r !== resource.id) : [...selected, resource.id])
                }
              />
              <span className="pick-option-body">
                <span>
                  <strong>{resource.name}</strong>
                  <span className="muted"> {resource.apiVersion}</span>
                </span>
              </span>
            </label>
          );
        })}
      </div>
    </div>
  );
}
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
          action={
            <button
              className="btn sm"
              onClick={() => document.getElementById("new-product-name")?.focus()}
            >
              Create the first one
            </button>
          }
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
    <Panel
      title={product.name}
      // It used to open "Owned by application_platform" — a raw id, and a redundant one: the
      // screen only lists products the selected application owns, so the answer was always the
      // application named in the picker two inches away.
      hint={`${subscriptions.length} subscription${subscriptions.length === 1 ? "" : "s"}.`}
    >
      <Notice kind="error">{action.error}</Notice>
      <Notice kind="ok">{action.message}</Notice>

      <p className="product-members">
        {product.members.length === 0 ? "No APIs in this product." : product.members.map((member) => {
          const resource = resources.find((row) => row.id === member.id);
          return <Link key={member.id} to={`/apis/${member.id}`}>{resource?.name ?? member.id}{resource?.apiVersion ? ` · ${resource.apiVersion}` : ""}</Link>;
        })}
      </p>
      <details className="product-editor">
        <summary>Edit APIs in this product{dirty ? " · Unsaved changes" : ""}</summary>
        <MemberPicker
          id={`members-${product.id}`}
          label="APIs in this product"
          resources={resources}
          selected={members}
          disabled={!canEdit.enabled}
          onChange={setMembers}
        />
        <p className="muted small">
          Removing an API stops every subscriber from calling it at the next gateway poll.
        </p>
        <Action
          permission={canEdit}
          className="primary"
          busy={action.busy || !dirty}
          onClick={async () => {
            const ok = await action.run(
              () => api.put(`/api/products/${product.id}/members`, { resourceIds: members }),
              "Saved. Subscribers see the change at the next gateway poll.",
            );
            if (ok) onChanged();
          }}
        >
          Save APIs
        </Action>
      </details>

      <h4 className="section-sub">Who has subscribed</h4>
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
                    {/* It said "Withdraw it →" and did not withdraw anything: it opens the
                        subscription, where withdrawing is one of several things you can do. A
                        control names what it does. */}
                    <Link to={`/subscriptions/${subscription.id}`}>Open →</Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted small">
            You publish this product, so you can withdraw anybody's access to it — an abusive or
            compromised caller is yours to stop, without finding an administrator first. You cannot
            see or replace their keys: those belong to the application that holds the subscription.
          </p>
        </>
      )}
    </Panel>
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
    <Panel
      title="Create a product"
      hint="Bundle the APIs a consumer would want together. One subscription, one key, every API in it."
    >
      <Notice kind="error">{action.error}</Notice>
      <TextField
        inputId="new-product-name"
        label="Name"
        value={name}
        onChange={setName}
        placeholder="orders-product"
      />
      <MemberPicker
        id="new-product-members"
        label="APIs to include"
        resources={resources}
        selected={selected}
        onChange={setSelected}
      />
      <div className="native-actions">
        <button
          className="btn primary"
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
          Create product
        </button>
      </div>
    </Panel>
  );
}
