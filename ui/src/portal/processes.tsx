import { useState } from "react";
import type { Session } from "../App";
import { api } from "../api";
import {
  DangerZone,
  EmptyState,
  Field,
  Link,
  Modal,
  Notice,
  Panel,
  StatusChip,
  go,
  useAction,
  useAsync,
} from "../components";
import {
  integrationEventChip,
  kafkaGrantChip,
  kafkaTopicChip,
  subscriptionChip,
} from "../lib/status";
import { SubscriptionKeys } from "../views/SubscriptionKeys";
import { DomainPicker } from "./apis";

export function SubscribeDialog({
  session: s,
  resourceId,
  close,
}: {
  session: Session;
  resourceId: string;
  close: () => void;
}) {
  const data = useAsync(
      () => api.get<{ items: any[] }>("/api/products"),
      [resourceId],
    ),
    w = useAction();
  const [productId, setProduct] = useState(""),
    [purpose, setPurpose] = useState(""),
    [result, setResult] = useState<any>(null);
  const products =
    data.data?.items.filter(
      (p) =>
        p.lifecycle === "active" &&
        p.members.some((m: any) => m.id === resourceId),
    ) ?? [];
  return (
    <Modal title="Subscribe to a product" close={close}>
      {result ? (
        <>
          <StatusChip chip={subscriptionChip(result.state)} />
          <p>
            Your request has been recorded. Approval and gateway activation
            progress appear in Subscriptions.
          </p>
          <button className="btn" onClick={close}>
            Done
          </button>
        </>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void w.run(async () =>
              setResult(
                await api.post("/api/subscriptions", {
                  applicationId: s.application,
                  productId: productId || products[0]?.id,
                  environment: s.environment,
                  purpose,
                }),
              ),
            );
          }}
        >
          <p>
            Requesting on behalf of{" "}
            <strong>{s.applicationName(s.application)}</strong> in{" "}
            {s.environment.toUpperCase()}. Access to another application's
            product requires publisher approval through simulated SkoNET.
          </p>
          <Notice kind="error">{data.error ?? w.error}</Notice>
          <Field label="Product">
            <select
              required
              value={productId || products[0]?.id || ""}
              onChange={(e) => setProduct(e.target.value)}
            >
              {!products.length && (
                <option value="">No subscribable product</option>
              )}
              {products.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Purpose">
            <textarea
              required
              minLength={3}
              maxLength={500}
              value={purpose}
              onChange={(e) => setPurpose(e.target.value)}
            />
          </Field>
          <button
            className="btn primary"
            disabled={w.busy || !products.length || !s.application}
          >
            Request subscription
          </button>
        </form>
      )}
    </Modal>
  );
}
/**
 * Whether the signed-in person is on the *consumer* side of this subscription.
 *
 * Only that side has keys. The publisher can see the row and can end the relationship; they cannot
 * read or replace the consumer's credentials, because a rotation of somebody else's key is an
 * outage at a moment of your choosing. The server enforces this — `/reveal` and `/rotate` both
 * check the consuming application — and this is only what stops the button being offered.
 */
function mine(s: Session, row: { applicationId: string }): boolean {
  return s.user.isAdmin || s.user.applications.includes(row.applicationId);
}

/** The product's name if the products call has landed, and its id — never nothing — if it has not. */
function productName(
  products: { data?: { items: any[] } | null },
  row: { productId: string },
): string {
  return products.data?.items.find((p) => p.id === row.productId)?.name ?? row.productId;
}

export function Subscriptions({
  session: s,
  tick,
  resourceId,
}: {
  session: Session;
  tick: number;
  resourceId?: string;
}) {
  const data = useAsync(
      () =>
        api.get<{ items: any[] }>(
          `/api/subscriptions?environment=${encodeURIComponent(s.environment)}`,
        ),
      [s.application, s.environment, tick],
    ),
    products = useAsync(
      () => api.get<{ items: any[] }>("/api/products"),
      [resourceId, tick],
    ),
    w = useAction();
  const [keyId, setKeyId] = useState<string | null>(null),
    [withdraw, setWithdraw] = useState<any>(null);
  const rows = (data.data?.items ?? []).filter(
    (r) =>
      r.environment === s.environment &&
      (resourceId
        ? products.data?.items.some(
            (p) =>
              p.id === r.productId &&
              p.members.some((m: any) => m.id === resourceId),
          )
        : r.applicationId === s.application),
  );
  const keyRow = rows.find((r) => r.id === keyId);
  return (
    // The heading says how many and where, not "Subscriptions" again under an `<h1>Subscriptions`.
    // Where matters more here than anywhere else in the portal: a subscription is to a product in
    // one environment and its keys work only there, so a list that did not name the environment
    // was the empty state's own warning going unheeded by the populated case.
    <Panel title={`${rows.length} in ${s.environment.toUpperCase()}`}>
      <Notice kind="error">{data.error ?? products.error ?? w.error}</Notice>
      {rows.length ? (
        rows.map((r) => (
          <div className="native-row" key={r.id}>
            <div>
              {/* The subscription's own screen — its keys, its history, the product behind it —
                  was reachable from the publisher's Products screen and from nowhere on the
                  consumer's own list. */}
              <Link to={`/subscriptions/${r.id}`}>
                <strong>{productName(products, r)}</strong>
              </Link>
              <small>
                {s.applicationName(r.applicationId)} · {r.purpose}
              </small>
              <StatusChip chip={subscriptionChip(r.state)} />
            </div>
            {/* What you can do to a subscription depends on which of the seven states it is in,
                and the list used to render exactly one button — Revoke — for three of them and
                nothing at all for the other four. A row in a terminal state looked like a row the
                portal had forgotten about. Every state now either offers its own action or says
                what is being waited on. */}
            <div className="native-actions">
              {r.state === "revoking" && (
                <small>Withdrawn — waiting for the gateways to stop accepting the keys.</small>
              )}
              {r.state === "activating" && (
                <small>Approved — waiting for the gateways to start accepting the keys.</small>
              )}
              {r.state === "pending" && <small>Waiting on the publisher's decision.</small>}
              {["revoked", "rejected", "cancelled"].includes(r.state) &&
                mine(s, r) && (
                  <button className="btn" onClick={() => go("/catalog")}>
                    Subscribe again
                  </button>
                )}
              {r.state === "active" && mine(s, r) && (
                <button className="btn" onClick={() => setKeyId(r.id)}>
                  Keys
                </button>
              )}
              {["pending", "active", "activating"].includes(r.state) && (
                <button
                  className="btn"
                  disabled={w.busy}
                  onClick={() => setWithdraw(r)}
                >
                  {r.state === "pending" ? "Cancel request" : "Revoke"}
                </button>
              )}
            </div>
          </div>
        ))
      ) : (
        <EmptyState
          title={`No subscriptions in ${s.environment.toUpperCase()}`}
          detail="A subscription is to a product in one environment, and its keys work only there — so an application subscribed in DEV has nothing here until it subscribes in this one too."
          action={
            <button className="btn sm" onClick={() => go("/catalog")}>
              Find an API to subscribe to
            </button>
          }
        />
      )}
      {keyRow && (
        // The same panel the subscription's own screen shows. It used to be a second, smaller
        // implementation: it revealed both keys the moment you opened it, showed neither one's age,
        // and could rotate only the secondary — so the primary, the key everyone was actually
        // issued on day one, could not be replaced from the screen most people open.
        //
        // The row is looked up by id rather than held, so a rotation's reload refreshes the ages
        // under the reader without remounting the panel and throwing away the key it just minted.
        <Modal title="Subscription keys" close={() => setKeyId(null)}>
          <SubscriptionKeys subscription={keyRow} onChanged={data.reload} />
        </Modal>
      )}
      {withdraw && (
        // A request nobody has decided yet is not access being withdrawn, and the dialog said it
        // was: "Withdraw access", "This application will lose access to the product" — of a
        // subscription whose keys have never worked. The three words that differ follow the state.
        <Modal
          title={withdraw.state === "pending" ? "Cancel this request" : "Withdraw access"}
          close={() => setWithdraw(null)}
        >
          <p>
            {withdraw.state === "pending" ? (
              <>
                Withdraw {s.applicationName(withdraw.applicationId)}'s request for{" "}
                {productName(products, withdraw)}? The publisher will no longer see it. Asking again
                means a new request.
              </>
            ) : (
              <>
                Withdraw {s.applicationName(withdraw.applicationId)} access to{" "}
                {productName(products, withdraw)}? Gateway access is removed automatically.
              </>
            )}
          </p>
          <Notice kind="error">{w.error}</Notice>
          <DangerZone
            what={withdraw.state === "pending" ? "Cancel this request" : "Withdraw subscription"}
            name={productName(products, withdraw)}
            consequence={
              withdraw.state === "pending"
                ? "The request is withdrawn before it was decided, and cannot be un-cancelled."
                : "This application will lose access to the product, at the next gateway poll, and cannot be un-revoked."
            }
            permission={{ enabled: true, reason: "" }}
            busy={w.busy}
            error={w.error}
            onConfirm={() =>
              w.run(async () => {
                await api.del(`/api/subscriptions/${withdraw.id}`);
                setWithdraw(null);
                data.reload();
              })
            }
          />
        </Modal>
      )}
    </Panel>
  );
}
export function Approvals({
  session: s,
  tick,
}: {
  session: Session;
  tick: number;
}) {
  const data = useAsync(
      () =>
        api.get<{ items: any[] }>(
          `/api/integration-events?applicationId=${s.application}`,
        ),
      [s.application, tick],
    ),
    w = useAction();
  const [selected, setSelected] = useState<any>(null),
    [reason, setReason] = useState("");
  const rows = data.data?.items.filter((e) => e.integration === "skonet") ?? [];
  return (
    <Panel title="SkoNET approvals · simulated">
      <p>
        Decide requests for products and Kafka topics owned by this application.
        Approved access is provisioned automatically.
      </p>
      <Notice kind="error">{data.error ?? w.error}</Notice>
      {rows.length ? (
        rows.map((e) => (
          <div className="native-row" key={e.id}>
            <div>
              <strong>
                {e.kind} · {s.applicationName(e.payload.consumer)}
              </strong>
              <p>{e.payload.purpose}</p>
              <StatusChip chip={integrationEventChip(e.state)} />
            </div>
            {e.state === "awaiting-decision" && (
              <button
                className="btn primary"
                onClick={() => {
                  setSelected(e);
                  setReason("");
                }}
              >
                Review request
              </button>
            )}
          </div>
        ))
      ) : (
        <EmptyState
          title="No approval requests"
          detail="Requests to call what this application publishes arrive here. Nobody can ask for access to an API that is in no product, so an empty list on a busy estate is usually a product that was never assembled."
          action={<Link to={`/${s.application}/products`}>Check your products →</Link>}
        />
      )}
      {selected && (
        <Modal title="Review access request" close={() => setSelected(null)}>
          <p>{selected.payload.purpose}</p>
          <Field label="Decision reason">
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </Field>
          <Notice kind="error">{w.error}</Notice>
          <div className="native-actions">
            {["approved", "rejected"].map((decision) => (
              <button
                key={decision}
                className={`btn ${decision === "approved" ? "primary" : ""}`}
                disabled={w.busy}
                onClick={() =>
                  void w.run(async () => {
                    await api.post(
                      `/api/integration-events/${selected.id}/decision`,
                      { decision, reason },
                    );
                    setSelected(null);
                    data.reload();
                  })
                }
              >
                {decision === "approved" ? "Approve" : "Reject"}
              </button>
            ))}
          </div>
        </Modal>
      )}
    </Panel>
  );
}
export function Integrations({
  session: s,
  tick,
  fixme,
}: {
  session: Session;
  tick: number;
  fixme?: boolean;
}) {
  const data = useAsync(
      () =>
        api.get<{ items: any[] }>(
          `/api/integration-events?applicationId=${s.application}`,
        ),
      [s.application, tick],
    ),
    w = useAction();
  return (
    <>
      <Panel title={fixme ? "FixMe diagnostics" : "Application integrations"}>
        <p>
          External services are simulated. Requests, responses, email
          notifications and approval decisions are persisted.
        </p>
        <Notice kind="error">{data.error ?? w.error}</Notice>
        <div className="native-actions">
          {(fixme ? ["fixme"] : ["leanix", "ldapws", "fixme"]).map((name) => (
            <button
              className="btn"
              key={name}
              disabled={w.busy || !s.application}
              onClick={() =>
                void w.run(async () => {
                  await api.post(
                    `/api/applications/${s.application}/integrations/${name}`,
                    { environment: s.environment },
                  );
                  data.reload();
                })
              }
            >
              {name === "leanix"
                ? "Refresh LeanIX metadata"
                : name === "ldapws"
                  ? "Look up application contacts"
                  : "Run FixMe diagnostics"}
            </button>
          ))}
        </div>
      </Panel>
      <Panel title="Integration activity and mock mailbox">
        {data.data?.items
          .filter((e) => !fixme || e.integration === "fixme")
          .map((e) => (
            <details className="native-event" key={e.id}>
              <summary>
                <strong>
                  {e.integration} · {e.kind}
                </strong>{" "}
                <StatusChip chip={integrationEventChip(e.state)} />
              </summary>
              <pre>
                {JSON.stringify(
                  { request: e.payload, response: e.result, error: e.error },
                  null,
                  2,
                )}
              </pre>
            </details>
          ))}
      </Panel>
    </>
  );
}
export function Kafka({
  session: s,
  tick,
  proxyOnly,
}: {
  session: Session;
  tick: number;
  proxyOnly: boolean;
}) {
  const topics = useAsync(
      () => api.get<{ items: any[] }>("/api/kafka/topics"),
      [tick, s.application],
    ),
    access = useAsync(
      () => api.get<{ items: any[] }>("/api/kafka/access"),
      [tick, s.application],
    ),
    w = useAction();
  const [create, setCreate] = useState(false),
    [name, setName] = useState(""),
    [selected, setSelected] = useState<any>(null),
    [purpose, setPurpose] = useState(""),
    [value, setValue] = useState(""),
    [messages, setMessages] = useState<any[]>([]);
  // The owner's fields, held apart from `selected` so an edit in progress is not overwritten by
  // the three-second refresh underneath it.
  const [draft, setDraft] = useState({ partitions: 3, description: "" });
  const [taxonomy, setTaxonomy] = useState({ domain: "", subdomain: "" });
  const rows =
    topics.data?.items.filter(
      (t) =>
        t.environment === s.environment &&
        t.state !== "deleted" &&
        (!proxyOnly || t.proxy_enabled),
    ) ?? [];
  return (
    <>
      <Panel
        title={
          proxyOnly
            ? "Kafka REST Proxy · simulated"
            : "Kafka topics · simulated"
        }
        actions={
          <button className="btn primary" onClick={() => setCreate(true)}>
            Create topic
          </button>
        }
      >
        <Notice kind="error">{topics.error ?? access.error ?? w.error}</Notice>
        {rows.length ? (
          rows.map((t) => (
            <div className="native-row" key={t.id}>
              <div>
                <strong>{t.name}</strong>
                <small>
                  {s.applicationName(t.applicationId)} · {t.partitions}{" "}
                  partitions ·{" "}
                  {t.domain
                    ? `${t.domain}${t.subdomain ? ` / ${t.subdomain}` : ""}`
                    : "no domain yet"}
                </small>
                <StatusChip chip={kafkaTopicChip(t.state)} />
              </div>
              <button
                className="btn"
                onClick={() => {
                  setSelected(t);
                  setMessages([]);
                  setPurpose("");
                  setDraft({
                    partitions: t.partitions,
                    description: t.description ?? "",
                  });
                  setTaxonomy({
                    domain: t.domain ?? "",
                    subdomain: t.subdomain ?? "",
                  });
                }}
              >
                Open topic
              </button>
            </div>
          ))
        ) : (
          <EmptyState
            title={`No topics in ${s.environment.toUpperCase()}`}
            detail="A topic belongs to one application and one environment, and carries a domain so it is filed beside that application's APIs in the catalogue."
            action={
              <button className="btn sm" onClick={() => setCreate(true)}>
                Create a topic
              </button>
            }
          />
        )}
      </Panel>
      {/* Both sides of the relationship, because both are entitled to see it and a topic cannot be
          deleted until every grant is withdrawn. Showing only this application's own grants left a
          topic's owner told to "revoke topic subscriptions first" with no way to find, let alone
          revoke, the one holding it up (finding 5). The server already returned both. */}
      <Panel title="Topic access">
        {(() => {
          const granted = (access.data?.items ?? []).filter(
            (a) => a.environment === s.environment,
          );
          const held = granted.filter((a) => a.application_id === s.application);
          const against = granted.filter(
            (a) =>
              a.publisher === s.application && a.application_id !== s.application,
          );
          const row = (a: any, mine: boolean) => (
            <div className="native-row" key={a.id}>
              <div>
                <strong>{a.topicName}</strong>
                <small>
                  {mine
                    ? a.purpose
                    : `${s.applicationName(a.application_id)} · ${a.purpose}`}
                </small>
                <StatusChip chip={kafkaGrantChip(a.state)} />
              </div>
              {["active", "pending", "activating"].includes(a.state) && (
                <DangerZone
                  what={mine ? "Withdraw topic access" : "Revoke this access"}
                  name={a.topicName}
                  consequence={
                    mine
                      ? "This application will lose access to the topic."
                      : `${s.applicationName(a.application_id)} will lose access to your topic at the next convergence.`
                  }
                  permission={{ enabled: true, reason: "" }}
                  busy={w.busy}
                  error={w.error}
                  onConfirm={() =>
                    w.run(async () => {
                      await api.del(`/api/kafka/access/${a.id}`);
                      access.reload();
                    })
                  }
                />
              )}
            </div>
          );
          return (
            <>
              <h4>What this application consumes</h4>
              {held.length ? (
                held.map((a) => row(a, true))
              ) : (
                <EmptyState
                  title={`No topic access in ${s.environment.toUpperCase()}`}
                  detail="Producing to or consuming another application's topic is a grant its owner approves, in one environment at a time."
                  action={<Link to="/catalog">Find a topic in the catalogue →</Link>}
                />
              )}
              <h4>Who consumes this application's topics</h4>
              {/* Not an empty state: nobody holding a grant is the normal, healthy answer for a
                  topic nobody has asked for, and there is nothing for the owner to do about it. */}
              {against.length ? (
                against.map((a) => row(a, false))
              ) : (
                <p className="muted">Nobody else holds access to your topics here.</p>
              )}
            </>
          );
        })()}
      </Panel>
      {create && (
        <Modal title="Create Kafka topic" close={() => setCreate(false)}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void w.run(async () => {
                await api.post("/api/kafka/topics", {
                  applicationId: s.application,
                  environment: s.environment,
                  name,
                  partitions: draft.partitions,
                  description: draft.description,
                  domain: taxonomy.domain,
                  subdomain: taxonomy.subdomain || null,
                });
                setCreate(false);
                setName("");
                setDraft({ partitions: 3, description: "" });
                setTaxonomy({ domain: "", subdomain: "" });
                topics.reload();
              });
            }}
          >
            <Field label="Topic name">
              <input
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </Field>
            {/* A topic is a catalog item, so it is classified like every other one: this is how
                somebody browsing the estate by domain finds it. */}
            <DomainPicker
              domain={taxonomy.domain}
              subdomain={taxonomy.subdomain}
              onChange={setTaxonomy}
            />
            <Field label="Partitions">
              <input
                type="number"
                min={1}
                max={100}
                required
                value={draft.partitions}
                onChange={(e) =>
                  setDraft({ ...draft, partitions: Number(e.target.value) })
                }
              />
            </Field>
            <Field label="Description">
              <textarea
                value={draft.description}
                onChange={(e) =>
                  setDraft({ ...draft, description: e.target.value })
                }
              />
            </Field>
            <Notice kind="error">{w.error}</Notice>
            <button className="btn primary" disabled={w.busy}>
              Create topic
            </button>
          </form>
        </Modal>
      )}
      {selected && (
        <Modal title={selected.name} close={() => setSelected(null)}>
          <Notice kind="error">{w.error}</Notice>
          <p>Kafka broker and REST proxy transport are simulated.</p>
          {selected.canEdit && (
            <>
              <Field label="Description">
                <textarea
                  value={draft.description}
                  onChange={(e) =>
                    setDraft({ ...draft, description: e.target.value })
                  }
                />
              </Field>
              <Field label="Partitions (a topic may only gain partitions)">
                <input
                  type="number"
                  min={selected.partitions}
                  max={100}
                  value={draft.partitions}
                  onChange={(e) =>
                    setDraft({ ...draft, partitions: Number(e.target.value) })
                  }
                />
              </Field>
              {/* A topic has no path, so moving it between domains moves only where it is found. */}
              <DomainPicker
                domain={taxonomy.domain}
                subdomain={taxonomy.subdomain}
                onChange={setTaxonomy}
              />
              <div className="native-actions">
                <button
                  className="btn primary"
                  disabled={w.busy || !taxonomy.domain}
                  onClick={() =>
                    void w.run(async () => {
                      await api.patch(`/api/kafka/topics/${selected.id}`, {
                        description: draft.description,
                        partitions: draft.partitions,
                        domain: taxonomy.domain,
                        subdomain: taxonomy.subdomain || null,
                      });
                      setSelected({
                        ...selected,
                        ...draft,
                        domain: taxonomy.domain,
                        subdomain: taxonomy.subdomain || null,
                      });
                      topics.reload();
                    })
                  }
                >
                  Save topic
                </button>
                <button
                  className="btn"
                  disabled={w.busy}
                  onClick={() =>
                    void w.run(async () => {
                      await api.patch(`/api/kafka/topics/${selected.id}`, {
                        proxyEnabled: !selected.proxy_enabled,
                      });
                      setSelected({
                        ...selected,
                        proxy_enabled: !selected.proxy_enabled,
                      });
                      topics.reload();
                    })
                  }
                >
                  {selected.proxy_enabled ? "Disable" : "Enable"} REST proxy
                </button>
              </div>
              <DangerZone
                what="Delete this topic"
                name={selected.name}
                consequence="The simulated topic and its messages go with it. Every application's access has to be withdrawn first."
                permission={{ enabled: true, reason: "" }}
                busy={w.busy}
                error={w.error}
                onConfirm={() =>
                  w.run(async () => {
                    await api.del(`/api/kafka/topics/${selected.id}`);
                    setSelected(null);
                    topics.reload();
                  })
                }
              />
            </>
          )}
          {access.data?.items.some(
            (a) =>
              a.topic_id === selected.id &&
              a.application_id === s.application &&
              a.state === "active",
          ) ? (
            <>
              <Field label="Message">
                <textarea
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                />
              </Field>
              <div className="native-actions">
                {["produce", "consume"].map((action) => (
                  <button
                    className="btn"
                    key={action}
                    disabled={w.busy}
                    onClick={() =>
                      void w.run(async () =>
                        setMessages(
                          (
                            await api.post<any>(
                              `/api/kafka/topics/${selected.id}/playground`,
                              { applicationId: s.application, action, value },
                            )
                          ).items,
                        ),
                      )
                    }
                  >
                    {action}
                  </button>
                ))}
              </div>
              <pre>{JSON.stringify(messages, null, 2)}</pre>
            </>
          ) : (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void w.run(async () => {
                  await api.post(`/api/kafka/topics/${selected.id}/subscribe`, {
                    applicationId: s.application,
                    purpose,
                  });
                  setSelected(null);
                  access.reload();
                });
              }}
            >
              <Field label="Access request purpose">
                <textarea
                  required
                  minLength={3}
                  maxLength={500}
                  value={purpose}
                  onChange={(e) => setPurpose(e.target.value)}
                />
              </Field>
              <button
                className="btn primary"
                disabled={w.busy || selected.state !== "ready"}
              >
                Request access
              </button>
            </form>
          )}
        </Modal>
      )}
    </>
  );
}
