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
  useAction,
  useAsync,
} from "../components";
import {
  integrationEventChip,
  kafkaGrantChip,
  kafkaTopicChip,
  subscriptionChip,
} from "../lib/status";
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
  const [key, setKey] = useState<any>(null),
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
  return (
    <Panel title="Subscriptions">
      <Notice kind="error">{data.error ?? products.error ?? w.error}</Notice>
      {rows.length ? (
        rows.map((r) => (
          <div className="native-row" key={r.id}>
            <div>
              <strong>
                {products.data?.items.find((p) => p.id === r.productId)?.name ??
                  r.productId}
              </strong>
              <small>
                {s.applicationName(r.applicationId)} · {r.purpose}
              </small>
              <StatusChip chip={subscriptionChip(r.state)} />
            </div>
            <div className="native-actions">
              {r.state === "active" &&
                (s.user.isAdmin ||
                  s.user.applications.includes(r.applicationId)) && (
                  <button
                    className="btn"
                    onClick={() =>
                      void w.run(async () =>
                        setKey({
                          id: r.id,
                          ...(await api.post<any>(
                            `/api/subscriptions/${r.id}/reveal`,
                          )),
                        }),
                      )
                    }
                  >
                    Show keys
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
          action={<Link to="/catalog">Find an API to subscribe to →</Link>}
        />
      )}
      {key && (
        <Modal title="Subscription keys" close={() => setKey(null)}>
          <p>Keep these credentials private.</p>
          <Field label="Primary key">
            <input readOnly value={key.primaryKey ?? ""} />
          </Field>
          <Field label="Secondary key">
            <input readOnly value={key.secondaryKey ?? ""} />
          </Field>
          <Notice kind="error">{w.error}</Notice>
          <button
            className="btn"
            disabled={w.busy}
            onClick={() =>
              void w.run(async () => {
                await api.post(`/api/subscriptions/${key.id}/rotate`, {
                  which: "secondary",
                });
                setKey({
                  id: key.id,
                  ...(await api.post<any>(
                    `/api/subscriptions/${key.id}/reveal`,
                  )),
                });
              })
            }
          >
            Rotate secondary key
          </button>
        </Modal>
      )}
      {withdraw && (
        <Modal title="Withdraw access" close={() => setWithdraw(null)}>
          <p>
            Withdraw {s.applicationName(withdraw.applicationId)} access to{" "}
            {products.data?.items.find((p) => p.id === withdraw.productId)
              ?.name ?? withdraw.productId}
            ? Gateway access is removed automatically.
          </p>
          <Notice kind="error">{w.error}</Notice>
          <DangerZone
            what="Withdraw subscription"
            name={
              products.data?.items.find((p) => p.id === withdraw.productId)
                ?.name ?? withdraw.productId
            }
            consequence="This application will lose access to the product."
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
