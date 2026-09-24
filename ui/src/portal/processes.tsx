import { useState } from "react";
import * as I from "./icons";
import type { Session } from "../App";
import { api } from "../api";
import {
  DangerZone,
  TextField,
  EmptyState,
  Field,
  Link,
  Modal,
  Notice,
  Panel,
  OperationList,
  Segmented,
  StatusChip,
  Skeleton,
  envLabel,
  useAction,
  useAsync,
} from "../components";
import { ALLOWED } from "../lib/capabilities";
import { formatDateTime } from "../lib/datetime";
import {
  integrationEventChip,
  kafkaGrantChip,
  operationChip,
  topicApiChip,
  subscriptionChip,
} from "../lib/status";
import { SubscriptionKeys } from "../views/SubscriptionKeys";
import { command } from "./client";
import type { OperationState } from "../../../shared/types";

export function Activity({ items, loading = false }: { items: any[]; loading?: boolean }) {
  const [scope, setScope] = useState<"all" | "active">("all");
  // The same definition as the topbar's count (portal-shell-navigation, "Activity is opened").
  const active = items.filter(item => !["complete", "superseded"].includes(item.state));
  // No title of its own: the page head already says "Activity", and a panel head reading "Changes
  // and deployment progress" above a filter reading "All changes" said it twice more.
  return <Panel className="activity-page" actions={
    <Segmented
      label="Activity filter"
      value={scope}
      onChange={setScope}
      options={[
        { value: "all", label: `All changes · ${items.length}` },
        { value: "active", label: `In progress · ${active.length}` },
      ]}
    />
  }>
    {/* The shell's first read of the operations is still in flight: "No changes yet" here would be
        a claim about the application, made before anything had been asked. */}
    {loading ? <Skeleton rows={4} /> : scope === "active" && active.length === 0
      ? <EmptyState title="No changes in progress" detail="Every change has reached the gateways." action={<button className="btn sm" onClick={() => setScope("all")}>Show all changes</button>} />
      : <OperationList items={scope === "active" ? active : items} />}
  </Panel>;
}

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
          <p>Your request is recorded. Its progress appears in Subscriptions.</p>
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
            For <strong>{s.applicationName(s.application)}</strong> in {envLabel(s.environment)}.
            Another application's product needs its publisher's approval (simulated SkoNET).
          </p>
          <Notice kind="error">{data.error ?? w.error}</Notice>
          {/* "No subscribable product" while the list was still on its way was the empty answer
              given before the question had been asked. */}
          {!data.data && !data.error ? <Skeleton rows={1} /> : products.length === 1 ? <p>Product: <strong>{products[0].name}</strong></p> : <Field label="Product">
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
          </Field>}
          <Field label="Purpose" hint="3–500 characters: what your application will use this product for.">
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
            disabled={w.busy || !products.length || !s.application || purpose.trim().length < 3 || purpose.trim().length > 500}
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
    [withdraw, setWithdraw] = useState<any>(null),
    [subscribing, setSubscribing] = useState(false);
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
  if (data.error || products.error) return <Notice kind="error">{data.error ?? products.error}</Notice>;
  if (!data.data || !products.data) return <Skeleton rows={4} />;
  return (
    // The heading says how many and where, not "Subscriptions" again under an `<h1>Subscriptions`.
    // Where matters more here than anywhere else in the portal: a subscription is to a product in
    // one environment and its keys work only there, so a list that did not name the environment
    // was the empty state's own warning going unheeded by the populated case.
    <Panel
      className="subscription-list"
      title={`${rows.length} in ${envLabel(s.environment)}`}
      // Only when there is a list to head. An empty list is an `EmptyState`, and an empty state
      // carries the action by the house rule — so offering it here as well put two controls doing
      // one thing on the same screen, one of them three centimetres above the other.
      actions={
        rows.length === 0 ? undefined : resourceId ? (
          // On an API's own workspace the question is never "which API" — it is already open — so
          // the answer to "how do I get a key for this" should not be a trip to the catalogue and
          // a search for the thing you are looking at. Owning an API is not the same as being one
          // of its callers, so a publisher testing their own route needs this too `[P1-10]`.
          //
          // Named for what is created, not for what it is against: a subscription is held against
          // a product, and "Subscribe to this API" said the one thing the whole model denies.
          <button className="btn primary" onClick={() => setSubscribing(true)}>
            <I.Key /> New subscription
          </button>
        ) : (
          <Link className="btn" to="/catalog"><I.Search /> Find a product</Link>
        )
      }
    >
      {rows.length ? (
        /* One line per subscription, not a card each. A subscription is four short facts — which
           product, whose, what state, what for — and the list was giving each of them a line of
           its own at sixteen pixels, so three subscriptions filled a screen and the API workspace's
           own tab was mostly white space with two buttons in the corner (the estate's own
           screenshot). The facts are unchanged; they read across rather than down. */
        rows.map((r) => (
          <div className="native-row subscription-row" key={r.id}>
            <div>
              <div className="subscription-head">
                {/* The subscription's own screen — its keys, its history, the product behind it —
                    was reachable from the publisher's Products screen and from nowhere on the
                    consumer's own list. */}
                <Link to={`/subscriptions/${r.id}`}>
                  <strong>{productName(products, r)}</strong>
                </Link>
                <StatusChip chip={subscriptionChip(r.state)} />
                {/* Whose, only where it can be somebody else's. The Subscriptions screen lists the
                    selected application's own, so the name there was the picker's, repeated. */}
                {resourceId && <span className="muted small">{s.applicationName(r.applicationId)}</span>}
              </div>
              {/* The purpose is the one field of arbitrary length, so it is the one that is
                  clipped — with the whole of it on hover and in the row's own screen. */}
              <small className="subscription-purpose" title={r.purpose}>
                {r.purpose}
              </small>
              {/* What is being waited on, where the buttons for a row that has none would be.
                  Three of the seven states offer no action and used to render nothing at all,
                  which read as a row the portal had forgotten about. */}
              {r.state === "revoking" && (
                <small>Revoked — waiting for the gateways to stop accepting the keys.</small>
              )}
              {r.state === "activating" && (
                <small>Approved — waiting for the gateways to start accepting the keys.</small>
              )}
              {r.state === "pending" && <small>Waiting on the publisher's decision.</small>}
            </div>
            <div className="native-actions">
              {["revoked", "rejected", "cancelled"].includes(r.state) &&
                mine(s, r) && (
                  // A link, because it goes somewhere: a button that navigated could not be opened
                  // in a new tab, and read to a screen reader as an action on this row.
                  <Link className="btn sm" to="/catalog">
                    Subscribe again
                  </Link>
                )}
              {r.state === "active" && mine(s, r) && (
                <button className="btn sm" onClick={() => setKeyId(r.id)}>
                  <I.Key /> Keys
                </button>
              )}
              {["pending", "active", "activating"].includes(r.state) && (
                <button
                  className="btn sm"
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
          title={`No subscriptions in ${envLabel(s.environment)}`}
          // The rule is the same in every stage, so it is stated without naming one — the title
          // already says which stage is empty, and "DEV" in the sentence read as nonsense in DEV.
          detail="A subscription is to a product in one environment, and its keys work only there."
          action={
            resourceId ? (
              <button className="btn primary sm" onClick={() => setSubscribing(true)}>
                New subscription
              </button>
            ) : (
              <Link className="btn sm" to="/catalog">
                Find a product to subscribe to
              </Link>
            )
          }
        />
      )}
      {subscribing && resourceId && (
        <SubscribeDialog
          session={s}
          resourceId={resourceId}
          close={() => {
            setSubscribing(false);
            // The request lands as a `pending` row in this very list, so it reloads on the way out.
            data.reload();
          }}
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
        // A request nobody has decided yet is not access being taken away, and the dialog said it
        // was — of a subscription whose keys had never worked. The words follow the state
        // (api-subscription-management, "A request is withdrawn before it is decided"). The error is
        // the confirmation's own, drawn once inside it rather than again above it.
        <Modal
          title={withdraw.state === "pending" ? "Cancel this request" : "Revoke access"}
          close={() => setWithdraw(null)}
        >
          <DangerZone
            open
            what={withdraw.state === "pending" ? "Cancel this request" : "Revoke subscription"}
            name={productName(products, withdraw)}
            consequence={
              withdraw.state === "pending"
                ? `${s.applicationName(withdraw.applicationId)}'s request is withdrawn before the publisher decides. Asking again means a new request.`
                : `${s.applicationName(withdraw.applicationId)}'s keys stop working once the gateways apply the change. A revoked subscription cannot be restored.`
            }
            permission={ALLOWED}
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

// ------------------------------------------------------------------------------------ Approvals

/** A SkoNET request whose decision is still open — the outbox event *and* the access row agree. */
export function awaitingDecision(event: { state: string; approval: { state: string } }): boolean {
  return event.state === "awaiting-decision" && event.approval.state === "pending";
}

/**
 * The environment filter's options, each with how many requests it holds.
 *
 * Approvals is not environment-scoped any more (routes.ts): a request waiting in PROD was invisible
 * to a publisher whose switcher was on DEV. So the environment is the reader's filter on this
 * screen rather than the shell's, and every option says how many requests it would show — a filter
 * that hides part of a queue has to say how much it is hiding.
 */
export function approvalFilterOptions(
  rows: Array<{ approval: { environment: string } }>,
  chain: string[],
): Array<{ value: string; label: string }> {
  return [
    { value: "all", label: `All · ${rows.length}` },
    ...chain.map((environment) => ({
      value: environment,
      label: `${envLabel(environment)} · ${rows.filter((row) => row.approval.environment === environment).length}`,
    })),
  ];
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
          `/api/integration-events?applicationId=${encodeURIComponent(s.application)}`,
        ),
      [s.application, tick],
    ),
    w = useAction();
  const [environment, setEnvironment] = useState("all");
  const [selected, setSelected] = useState<any>(null),
    [reason, setReason] = useState("");
  // An event whose access row has gone (`approval: null`) has nothing to decide and nothing to name.
  const all = data.data?.items.filter((e) => e.integration === "skonet" && e.approval) ?? [];
  const shown = environment === "all" ? all : all.filter((e) => e.approval.environment === environment);
  const awaiting = shown.filter(awaitingDecision);
  const decided = shown.filter((e) => !awaitingDecision(e));
  if (data.error) return <Notice kind="error">{data.error}</Notice>;
  if (!data.data) return <Skeleton rows={4} />;
  const row = (e: any) => {
    const open = awaitingDecision(e);
    return (
      <div className={open ? "native-row is-awaiting" : "native-row"} key={e.id}>
        <div>
          <div className="approval-head">
            <strong>{e.approval.name}</strong>
            <span className="chip">{e.kind === "kafka.request" ? "Kafka topic" : "Product"}</span>
            <span className="chip">{envLabel(e.approval.environment)}</span>
            <StatusChip chip={open ? integrationEventChip(e.state) : e.kind === "kafka.request" ? kafkaGrantChip(e.approval.state) : subscriptionChip(e.approval.state)} />
          </div>
          <small>
            {s.applicationName(e.payload.consumer)} · asked {formatDateTime(e.created_at)}
          </small>
          <p>{e.payload.purpose}</p>
        </div>
        {open && (
          // `btn sm`, not the primary it was: one primary per section, and a queue of five requests
          // was five of them. What marks a row as waiting is the row (`is-awaiting`), not its button.
          <button
            className="btn sm"
            onClick={() => {
              setSelected(e);
              setReason("");
            }}
          >
            Review <I.ChevRight />
          </button>
        )}
      </div>
    );
  };
  return (
    <Panel
      className="approval-list"
      title="Access requests"
      hint="Simulated SkoNET. Approved access is set up automatically."
      actions={
        all.length === 0 ? undefined : (
          <Segmented
            label="Environment filter"
            value={environment}
            onChange={setEnvironment}
            options={approvalFilterOptions(all, s.meta.chain)}
          />
        )
      }
    >
      {all.length === 0 ? (
        <EmptyState
          title="No access requests"
          detail="Requests to use what this application publishes arrive here. Nobody can ask for an API that is in no product."
          action={<Link className="btn sm" to={`/${s.application}/products`}>Open Products</Link>}
        />
      ) : (
        <>
          {/* Waiting first and apart. The list was one run in outbox order, so the requests that
              needed somebody were interleaved with every decision ever made. */}
          <h4>Awaiting a decision · {awaiting.length}</h4>
          {awaiting.length ? (
            awaiting.map(row)
          ) : (
            <p className="muted">
              Nothing {environment === "all" ? "" : `in ${envLabel(environment)} `}is waiting on a decision.
            </p>
          )}
          {decided.length > 0 && (
            <>
              <h4>Decided</h4>
              {decided.map(row)}
            </>
          )}
        </>
      )}
      {selected && all.some(entry => entry.id === selected.id && awaitingDecision(entry)) && (
        <Modal title="Review access request" close={() => setSelected(null)}>
          <div className="kv-list">
            <div className="kv">
              <span className="k">{selected.kind === "kafka.request" ? "Kafka topic" : "Product"}</span>
              <span className="v">{selected.approval.name}</span>
            </div>
            <div className="kv">
              <span className="k">Requested by</span>
              <span className="v">{s.applicationName(selected.payload.consumer)}</span>
            </div>
            <div className="kv">
              <span className="k">Environment</span>
              <span className="v">{envLabel(selected.approval.environment)}</span>
            </div>
            {/* Who the broker will bind the ACL to, and everything approving grants: a Kafka request
                is one decision for all of its operations (kafka-workspace). */}
            {selected.kind === "kafka.request" && selected.approval.principal && (
              <>
                <div className="kv">
                  <span className="k">Principal</span>
                  <span className="v mono">{selected.approval.principal} · {selected.approval.authType === "mtls" ? "mTLS" : "OAuth"}</span>
                </div>
                <div className="kv">
                  <span className="k">Operations</span>
                  <span className="v">{(selected.approval.operations ?? []).map((op: string) => op.toUpperCase()).join(", ")}</span>
                </div>
              </>
            )}
          </div>
          <p>{selected.payload.purpose}</p>
          <Field label="Reason (optional)" hint="Recorded with the decision.">
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </Field>
          <Notice kind="error">{w.error}</Notice>
          <div className="native-actions">
            {(["approved", "rejected"] as const).map((decision) => (
              <button
                key={decision}
                className={decision === "approved" ? "btn primary" : "btn"}
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

// ----------------------------------------------------------------------------- Kafka REST Proxy

interface SharedStage {
  environment: string;
  published: boolean;
  urls: string[];
  operation: { id: string; state: string; error: string | null } | null;
  keyReady: boolean;
  /** An administrator's only: the Kafka REST Proxy the shared proxy calls, and the cluster. */
  backendUrl?: string | null;
  clusterId?: string | null;
}
interface ProxyTopic {
  id: string;
  name: string;
  environment: string;
  applicationId: string;
  applicationName: string;
  schemaType: string | null;
  certificateName: string | null;
  canEdit: boolean;
  apiResourceId: string | null;
  published: boolean;
  blockers: string[];
}
interface ProxyStatus {
  sharedResourceId: string | null;
  environments: SharedStage[];
  topics: ProxyTopic[];
}

/**
 * What the shared-proxy button does in this environment, said on the button: publish it where the
 * chain starts, promote it one stage on, or point the one that is here somewhere else. `null` when
 * nothing can be done here yet, with the reason in `blocked`.
 */
export function sharedProxyAction(
  status: { sharedResourceId: string | null; environments: Array<Pick<SharedStage, "environment" | "published">> },
  environment: string,
): { label: string; blocked: string | null } {
  const index = status.environments.findIndex((e) => e.environment === environment);
  const here = status.environments[index];
  const first = status.environments[0]?.environment ?? environment;
  if (!status.sharedResourceId)
    return index === 0
      ? { label: "Publish the shared proxy", blocked: null }
      : { label: "Publish the shared proxy", blocked: `It starts in ${envLabel(first)}; set it up there first.` };
  if (here?.published) return { label: "Save", blocked: null };
  const previous = status.environments[index - 1];
  return previous?.published
    ? { label: `Promote to ${envLabel(environment)}`, blocked: null }
    : { label: `Promote to ${envLabel(environment)}`, blocked: `Set it up in ${envLabel(previous?.environment ?? first)} first.` };
}

/**
 * What a topic's row offers on this screen (kafka-rest-proxy, "The Kafka REST Proxy screen"). One
 * decision, named, so the rules are tested rather than read out of JSX: open the API it has, create
 * one, promote the one it has into this stage — or why none of those is possible yet.
 */
export function topicApiAction(
  topic: Pick<ProxyTopic, "published" | "apiResourceId" | "blockers" | "canEdit">,
  stage: { published: boolean; first: boolean } | undefined,
): { kind: "open" | "create" | "promote" | "none"; reason: string | null } {
  if (topic.published) return { kind: "open", reason: null };
  if (topic.blockers.length > 0) return { kind: "none", reason: topic.blockers[0]! };
  if (!stage?.published)
    return { kind: "none", reason: "The shared Kafka proxy is not published here yet. An administrator sets it up above." };
  if (!topic.canEdit) return { kind: "none", reason: "Only the topic's owner can give it an API." };
  if (topic.apiResourceId) return { kind: "promote", reason: null };
  return stage.first
    ? { kind: "create", reason: null }
    : { kind: "none", reason: "A topic's API starts where Kafka's stages do: create it there, then promote it here." };
}

/**
 * The Kafka REST Proxy screen (kafka-rest-proxy): a topic's records produced over HTTP, through an
 * API generated from the topic's schema.
 *
 * Two things, in the order they depend on each other. The shared proxy — the portal's own API, in
 * front of the Kafka REST Proxy — which an administrator sets up per environment and everybody else
 * can only see the state of. Then this application's topics, each with its API or the first reason
 * it cannot have one. A consumer never comes here: a topic's API is in the Catalog, and is
 * subscribed to like any other.
 */
export function KafkaProxy({ session: s, tick }: { session: Session; tick: number }) {
  const status = useAsync(() => api.get<ProxyStatus>("/api/kafka/proxy"), [tick]),
    w = useAction();
  // The administrator's two fields, held apart from the refresh underneath them.
  const [draft, setDraft] = useState<{ backendUrl: string; clusterId: string } | null>(null);
  if (status.error) return <Notice kind="error">{status.error}</Notice>;
  if (!status.data) return <Skeleton rows={4} />;
  const data = status.data;
  // The shared proxy and every topic's API exist only where a Kafka cluster does.
  if (!s.meta.kafkaChain.includes(s.environment))
    return (
      <Panel>
        <EmptyState
          title={`Kafka has no ${envLabel(s.environment)}`}
          detail={`Topics, the shared proxy and their HTTP APIs live in ${s.meta.kafkaChain.map(envLabel).join(" and ")}.`}
          action={
            <button type="button" className="btn primary" onClick={() => s.setEnvironment(s.meta.kafkaChain[0]!)}>
              Open {envLabel(s.meta.kafkaChain[0])}
            </button>
          }
        />
      </Panel>
    );
  const index = data.environments.findIndex((e) => e.environment === s.environment);
  const here = data.environments[index];
  const form = draft ?? { backendUrl: here?.backendUrl ?? "", clusterId: here?.clusterId ?? "" };
  const action = sharedProxyAction(data, s.environment);
  const busyOperation = here?.operation && !["complete", "superseded"].includes(here.operation.state) ? here.operation : null;
  const topics = data.topics.filter((t) => t.environment === s.environment && t.applicationId === s.application);
  const kafka = `/${s.application}/kafka`;

  const run = (fn: () => Promise<unknown>) =>
    void w.run(async () => {
      await fn();
      setDraft(null);
      status.reload();
    });

  return (
    <>
      <Panel
        title={`Shared Kafka proxy in ${envLabel(s.environment)}`}
        hint="The portal's own API in front of the Kafka REST Proxy. Every topic's API calls it with the portal's key; no application subscribes to it."
        actions={
          <StatusChip
            chip={
              busyOperation
                ? operationChip(busyOperation.state as OperationState)
                : here?.published
                  ? { label: "Published", tone: "live", title: "the shared proxy answers in this environment" }
                  : { label: "Not set up", tone: "neutral", title: "no topic here can have an HTTP API until an administrator publishes it" }
            }
          />
        }
      >
        {here?.operation?.error && <Notice kind="warn">{here.operation.error}</Notice>}
        {s.user.isAdmin ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              run(() => command("/api/kafka/proxy/shared", { environment: s.environment, ...form }));
            }}
          >
            <TextField
              label="Kafka REST Proxy URL"
              type="url"
              required
              value={form.backendUrl}
              onChange={(backendUrl) => setDraft({ ...form, backendUrl })}
              placeholder="https://kafka-rest.example:8082"
              hint="The Confluent REST Proxy (v3) this environment produces through."
            />
            <TextField
              label="Cluster id"
              required
              pattern="[A-Za-z0-9._\-]{1,255}"
              value={form.clusterId}
              onChange={(clusterId) => setDraft({ ...form, clusterId })}
              hint="The Kafka cluster's id, as GET /v3/clusters on that proxy reports it."
            />
            {action.blocked && <p className="hint">{action.blocked}</p>}
            <Notice kind="error">{w.error}</Notice>
            <div className="native-actions">
              <button className="btn primary" disabled={w.busy || Boolean(action.blocked) || !form.backendUrl || !form.clusterId}>
                {action.label}
              </button>
              {data.sharedResourceId && (
                <Link className="btn" to={`/${s.application}/apis/${data.sharedResourceId}`}>Open its API</Link>
              )}
            </div>
          </form>
        ) : (
          <p className="muted">
            {here?.published
              ? `Answering on ${here.urls.length} gateway address${here.urls.length === 1 ? "" : "es"} in ${envLabel(s.environment)}.`
              : `Not set up in ${envLabel(s.environment)} yet. An administrator sets it up here; until then no topic can have an HTTP API.`}
          </p>
        )}
      </Panel>
      <Panel
        className="kafka-proxy"
        title={`Topics owned by ${s.applicationName(s.application)} in ${envLabel(s.environment)}`}
        hint="A JSON topic with a schema and a client certificate can have an HTTP API, generated from its schema and owned by this application."
      >
        {topics.length === 0 ? (
          <EmptyState
            title={`${s.applicationName(s.application)} owns no topics in ${envLabel(s.environment)}`}
            detail="A topic's HTTP API is made from the topic, so the topic comes first."
            action={<Link className="btn sm" to={kafka}>Open Kafka Topics</Link>}
          />
        ) : (
          topics.map((t) => {
            const next = topicApiAction(t, here ? { published: here.published, first: index === 0 } : undefined);
            return (
              <div className="native-row" key={t.id}>
                <div>
                  <div className="approval-head">
                    <strong>{t.name}</strong>
                    <StatusChip chip={topicApiChip(t.published, t.blockers[0])} />
                  </div>
                  <small>
                    {t.schemaType ? `${t.schemaType.toUpperCase()} schema` : "No schema recorded"}
                    {" · "}
                    {t.certificateName ? `certificate ${t.certificateName}` : "no client certificate"}
                  </small>
                  {next.reason && <small>{next.reason}</small>}
                </div>
                <div className="native-actions">
                  {next.kind === "open" && (
                    <Link className="btn sm" to={`/${t.applicationId}/apis/${t.apiResourceId}`}>Open API <I.ChevRight /></Link>
                  )}
                  {(next.kind === "create" || next.kind === "promote") && (
                    <button
                      className="btn sm primary"
                      disabled={w.busy}
                      onClick={() => run(() => command(`/api/kafka/topics/${t.id}/proxy`, {}))}
                    >
                      {next.kind === "create" ? "Create HTTP API" : `Promote its API to ${envLabel(s.environment)}`}
                    </button>
                  )}
                  {next.kind === "none" && t.canEdit && t.blockers.length > 0 && (
                    <Link className="btn sm" to={kafka}>Edit topic</Link>
                  )}
                </div>
              </div>
            );
          })
        )}
        {!s.user.isAdmin && <Notice kind="error">{w.error}</Notice>}
        <p className="muted small">
          Other applications' topic APIs are in the <Link to="/catalog">Catalog</Link>, where they are subscribed to like any API.
        </p>
      </Panel>
    </>
  );
}
