import { integerError } from "../lib/form-validation";
import { useState } from "react";
import * as I from "./icons";
import type { Session } from "../App";
import { api } from "../api";
import {
  Action,
  CopyButton,
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
  kafkaProxyChip,
  kafkaTopicChip,
  subscriptionChip,
} from "../lib/status";
import { SubscriptionKeys } from "../views/SubscriptionKeys";
import { DomainPicker } from "./apis";

export function Activity({ items }: { items: any[] }) {
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
    {scope === "active" && active.length === 0
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

// ---------------------------------------------------------------------------------------- Kafka

/** Access that is live or on its way — the states in which asking again is refused with `409`. */
const LIVE_GRANT = ["pending", "activating", "active", "revoking"];

/** This application's own grant on a topic, if it holds one that is not finished. */
function grantFor(access: any[], topicId: string, applicationId: string) {
  return access.find((a) => a.topic_id === topicId && a.application_id === applicationId && LIVE_GRANT.includes(a.state));
}

function domainOf(t: { domain: string | null; subdomain: string | null }): string {
  return t.domain ? `${t.domain}${t.subdomain ? ` / ${t.subdomain}` : ""}` : "no domain yet";
}

export function Kafka({
  session: s,
  tick,
}: {
  session: Session;
  tick: number;
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
    // `null` until the console has been asked, so "nothing on the topic" is an answer and not the
    // absence of one.
    [messages, setMessages] = useState<any[] | null>(null),
    [revoke, setRevoke] = useState<any>(null);
  // The owner's fields, held apart from `selected` so an edit in progress is not overwritten by
  // the refresh underneath it.
  const [draft, setDraft] = useState({ partitions: 3, description: "" });
  const [taxonomy, setTaxonomy] = useState({ domain: "", subdomain: "" });
  const rows =
    topics.data?.items.filter(
      (t) => t.environment === s.environment && t.state !== "deleted",
    ) ?? [];
  // The application's own topics apart from everybody else's, because what may be done differs:
  // an owner edits, anybody else asks for access (kafka-workspace, "The topic list mirrors the API
  // list"). One run sorted by name made the reader work out which rows were theirs from a caption.
  const own = rows.filter((t) => t.applicationId === s.application);
  const others = rows.filter((t) => t.applicationId !== s.application);
  const grants = access.data?.items ?? [];
  const topicNameProblem = !/^[A-Za-z0-9][A-Za-z0-9._-]{1,100}$/.test(name) ? "Use 2–101 letters, digits, dots, underscores or hyphens." : topics.data?.items.some(topic => topic.environment === s.environment && topic.name === name) ? "This topic name already exists in this environment." : null;
  const partitionProblem = integerError(draft.partitions, selected && !create ? selected.partitions : 1, 100);
  const createBlocked = Boolean(topicNameProblem || partitionProblem || !taxonomy.domain || topics.loading || topics.error);
  function startCreating() {
    setSelected(null);
    setName("");
    setDraft({ partitions: 3, description: "" });
    setTaxonomy({ domain: "", subdomain: "" });
    setCreate(true);
  }
  function openTopic(t: any) {
    setSelected(t);
    setMessages(null);
    setPurpose("");
    setValue("");
    setDraft({ partitions: t.partitions, description: t.description ?? "" });
    setTaxonomy({ domain: t.domain ?? "", subdomain: t.subdomain ?? "" });
  }
  const currentAccess = selected ? grantFor(grants, selected.id, s.application) : undefined;
  if (topics.error || access.error) return <Notice kind="error">{topics.error ?? access.error}</Notice>;
  if (!topics.data || !access.data) return <Skeleton rows={4} />;
  const canCreate = { enabled: Boolean(s.application), reason: s.application ? null : "Choose an application first." };
  const topicRow = (t: any) => {
    const grant = grantFor(grants, t.id, s.application);
    return (
      <div className="native-row" key={t.id}>
        <div>
          <strong>{t.name}</strong>
          <small>
            {t.applicationId !== s.application && `${s.applicationName(t.applicationId)} · `}
            {t.partitions} partitions · {domainOf(t)}
          </small>
          {/* Only when it is news: a ready topic is the normal case, and a "Ready" chip on every row
              was a column of the same word (the rule `lifecycleChip` keeps for an active API). */}
          {t.state !== "ready" && <StatusChip chip={kafkaTopicChip(t.state)} />}
          {grant && (
            <small>
              Access for {s.applicationName(s.application)}: <StatusChip chip={kafkaGrantChip(grant.state)} />
            </small>
          )}
        </div>
        <button className="btn sm" onClick={() => openTopic(t)}>
          Open <I.ChevRight />
        </button>
      </div>
    );
  };
  return (
    <>
      <Panel
        className="kafka-topics"
        title={`Topics in ${envLabel(s.environment)}`}
        hint="Simulated broker: topics and their messages exist only in this portal."
        // As on Subscriptions: an empty list's action is its empty state's, not the head's as well.
        actions={
          rows.length === 0 ? undefined : (
            <Action permission={canCreate} className="primary" onClick={startCreating}>
              <I.Plus /> Create topic
            </Action>
          )
        }
      >
        {rows.length === 0 ? (
          <EmptyState
            title={`No topics in ${envLabel(s.environment)}`}
            detail="A topic belongs to one application and one environment, and carries a domain so it is found beside that application's APIs in the catalogue."
            action={
              <Action permission={canCreate} className="sm" onClick={startCreating}>
                Create topic
              </Action>
            }
          />
        ) : (
          <>
            <h4>Owned by {s.applicationName(s.application)}</h4>
            {own.length ? own.map(topicRow) : (
              <p className="muted">{s.applicationName(s.application)} owns no topics in {envLabel(s.environment)}.</p>
            )}
            {others.length > 0 && (
              <>
                <h4>Other applications' topics</h4>
                {others.map(topicRow)}
              </>
            )}
          </>
        )}
      </Panel>
      {/* Both sides of the relationship, because both are entitled to see it and a topic cannot be
          deleted until every grant is withdrawn. Showing only this application's own grants left a
          topic's owner told to "revoke topic subscriptions first" with no way to find, let alone
          revoke, the one holding it up (finding 5). The server already returned both. */}
      <Panel title="Topic access" className="kafka-access">
        {(() => {
          const granted = grants.filter((a) => a.environment === s.environment);
          const held = granted.filter((a) => a.application_id === s.application);
          const against = granted.filter(
            (a) =>
              a.publisher === s.application && a.application_id !== s.application,
          );
          const row = (a: any, mineRow: boolean) => (
            <div className="native-row" key={a.id}>
              <div>
                <strong>{a.topicName}</strong>
                <small>
                  {mineRow
                    ? a.purpose
                    : `${s.applicationName(a.application_id)} · ${a.purpose}`}
                </small>
                <StatusChip chip={kafkaGrantChip(a.state)} />
              </div>
              {/* A request waiting on the owner is decided in Approvals, with Approve and Reject —
                  not cancelled from here on the requester's behalf. */}
              {!mineRow && a.state === "pending" ? (
                <Link className="btn sm" to={`/${s.application}/approvals`}>Review</Link>
              ) : ["active", "pending", "activating"].includes(a.state) && (
                // The same shape as a subscription's: a row button, then a dialog holding only the
                // typed confirmation. It was an open-able danger zone inside every row, so a list of
                // five grants was five collapsed confirmation forms.
                <button className="btn sm" disabled={w.busy} onClick={() => setRevoke({ ...a, mine: mineRow })}>
                  {a.state === "pending" ? "Cancel request" : "Revoke"}
                </button>
              )}
            </div>
          );
          return (
            <>
              <h4>Topics {s.applicationName(s.application)} can use</h4>
              {/* Not empty states: the topics above are where access is asked for, and nobody using
                  your topics is the normal, healthy answer for a topic nobody has asked for. */}
              {held.length ? (
                held.map((a) => row(a, true))
              ) : (
                <p className="muted">No access in {envLabel(s.environment)} yet. Open a topic above to request it.</p>
              )}
              <h4>Who else uses {s.applicationName(s.application)}'s topics</h4>
              {against.length ? (
                against.map((a) => row(a, false))
              ) : (
                <p className="muted">Nobody else holds access to your topics here.</p>
              )}
            </>
          );
        })()}
      </Panel>
      {revoke && (
        <Modal
          title={revoke.state === "pending" ? "Cancel this request" : "Revoke topic access"}
          close={() => setRevoke(null)}
        >
          <DangerZone
            open
            what={revoke.state === "pending" ? "Cancel this request" : "Revoke access"}
            name={revoke.topicName}
            consequence={
              revoke.state === "pending"
                ? "The request is withdrawn before the owner decides. Asking again means a new request."
                : revoke.mine
                  ? `${s.applicationName(s.application)} loses access to the topic. Revoked access cannot be restored.`
                  : `${s.applicationName(revoke.application_id)} loses access to your topic. Revoked access cannot be restored.`
            }
            permission={ALLOWED}
            busy={w.busy}
            error={w.error}
            onConfirm={() =>
              w.run(async () => {
                await api.del(`/api/kafka/access/${revoke.id}`);
                setRevoke(null);
                access.reload();
              })
            }
          />
        </Modal>
      )}
      {create && (
        <Modal title="Create Kafka topic" close={() => setCreate(false)}>
          <p>Owned by {s.applicationName(s.application)} in {envLabel(s.environment)}.</p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (createBlocked) return;
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
            <TextField label="Topic name" value={name} onChange={setName} required maxLength={101}
              hint="2–101 letters, digits, dots, underscores or hyphens; unique in this environment." error={name ? topicNameProblem : null} />
            {/* A topic is a catalog item, so it is classified like every other one: this is how
                somebody browsing the estate by domain finds it. */}
            <DomainPicker
              domain={taxonomy.domain}
              subdomain={taxonomy.subdomain}
              onChange={setTaxonomy}
            />
            <Field label="Partitions" hint="Whole numbers from 1 to 100. Partitions can only increase later.">
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
            {partitionProblem && <p className="field-error">{partitionProblem}</p>}
            {!taxonomy.domain && <p className="hint">Choose a domain before creating the topic.</p>}
            <button className="btn primary" disabled={w.busy || createBlocked}>
              Create topic
            </button>
          </form>
        </Modal>
      )}
      {selected && (
        <Modal title={selected.name} close={() => setSelected(null)}>
          <p className="muted">
            Owned by {s.applicationName(selected.applicationId)} in {envLabel(selected.environment)}. Simulated broker.
          </p>
          {selected.canEdit ? (
            <>
              <Field label="Description">
                <textarea
                  value={draft.description}
                  onChange={(e) =>
                    setDraft({ ...draft, description: e.target.value })
                  }
                />
              </Field>
              <Field label="Partitions" hint="A topic may only gain partitions.">
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
              {partitionProblem && <p className="field-error">{partitionProblem}</p>}
              <div className="native-actions">
                <button
                  className="btn primary"
                  disabled={w.busy || !taxonomy.domain || Boolean(partitionProblem)}
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
              </div>
            </>
          ) : (
            // The facts, read-only, and who can change them. A form of disabled fields would be
            // three boxes nobody can type in, to say what one sentence says.
            <>
              <div className="kv-list">
                <div className="kv"><span className="k">Description</span><span className="v">{selected.description || "—"}</span></div>
                <div className="kv"><span className="k">Partitions</span><span className="v">{selected.partitions}</span></div>
                <div className="kv"><span className="k">Domain</span><span className="v">{domainOf(selected)}</span></div>
              </div>
              <p className="muted">Only members of {s.applicationName(selected.applicationId)} can change this topic.</p>
            </>
          )}
          {/* The proxy's switch lives on its own screen, beside the endpoint it turns on; this says
              which way it is set, as the spec's "a topic is opened" asks. */}
          <p>
            <StatusChip chip={kafkaProxyChip(Boolean(selected.proxy_enabled))} />{" "}
            <Link to={`/${s.application}/kafka-proxy`}>Kafka REST Proxy</Link>
          </p>
          <Notice kind="error">{w.error}</Notice>
          <h4>Access for {s.applicationName(s.application)}</h4>
          {currentAccess?.state === "active" ? (
            <>
              <Field label="Message">
                <textarea
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                />
              </Field>
              <div className="native-actions">
                {(["produce", "consume"] as const).map((action) => (
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
                    {action === "produce" ? "Produce" : "Consume"}
                  </button>
                ))}
              </div>
              {messages && (
                messages.length ? (
                  <>
                    <p className="muted small">The newest {messages.length} messages on the topic. Simulated.</p>
                    <table className="tbl">
                      <thead><tr><th>Offset</th><th>Written</th><th>Value</th></tr></thead>
                      <tbody>
                        {messages.map((message) => (
                          <tr key={message.offset}>
                            <td className="num">{message.offset}</td>
                            <td>{formatDateTime(message.createdAt)}</td>
                            <td className="mono">{message.value}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </>
                ) : (
                  <p className="muted small">No messages on this topic yet. Simulated.</p>
                )
              )}
            </>
          ) : currentAccess ? (
            <p>
              <StatusChip chip={kafkaGrantChip(currentAccess.state)} /> A request is already in progress; wait for it to finish before asking again.
            </p>
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
              <Field label="Purpose" hint="3–500 characters: what this application will produce or consume.">
                <textarea
                  required
                  minLength={3}
                  maxLength={500}
                  value={purpose}
                  onChange={(e) => setPurpose(e.target.value)}
                />
              </Field>
              {selected.state !== "ready" && <p className="hint">The topic is still being created; access can be requested once it is ready.</p>}
              <button
                className="btn primary"
                disabled={w.busy || selected.state !== "ready" || !s.application || access.loading || Boolean(access.error) || purpose.trim().length < 3}
              >
                Request access
              </button>
            </form>
          )}
          {selected.canEdit && (
            <DangerZone
              what="Delete this topic"
              name={selected.name}
              consequence="The topic and its messages go with it. Every application's access has to be revoked first."
              permission={ALLOWED}
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
          )}
        </Modal>
      )}
    </>
  );
}

/**
 * The HTTP call a topic's proxy answers, as a command somebody can paste.
 *
 * In this phase the broker and its proxy are simulated, and what answers is the portal's own Kafka
 * console endpoint (kafka-playground) — so that is the address given, and the command carries what
 * that endpoint actually checks: the portal session, and an `Origin` matching the portal, because
 * the control plane refuses a cross-origin write. An invented proxy host would have been a URL that
 * answered nothing.
 */
export function proxyCall(
  portalUrl: string,
  topicId: string,
  applicationId: string,
  action: "produce" | "consume",
): { endpoint: string; curl: string } {
  const origin = new URL(portalUrl).origin;
  const endpoint = `${origin}/api/kafka/topics/${encodeURIComponent(topicId)}/playground`;
  const body = JSON.stringify(
    action === "produce" ? { applicationId, action, value: "hello" } : { applicationId, action },
  );
  const curl = `curl -X POST '${endpoint}' -H 'Content-Type: application/json' -H 'Origin: ${origin}' -b 'apim_session=<your portal session>' -d '${body}'`;
  return { endpoint, curl };
}

/**
 * The Kafka REST Proxy screen: every topic this application can reach, with its proxy state.
 *
 * It used to be the topics screen again, filtered to `proxy_enabled` — so a topic whose proxy was
 * off vanished instead of saying so (kafka-workspace, "The Kafka REST Proxy section is opened"),
 * and the screen offered "Create topic" beside no topics. What belongs here is what differs: the
 * switch, the address, and the command that uses it.
 */
export function KafkaProxy({ session: s, tick }: { session: Session; tick: number }) {
  const topics = useAsync(
      () => api.get<{ items: any[] }>("/api/kafka/topics"),
      [tick, s.application],
    ),
    access = useAsync(
      () => api.get<{ items: any[] }>("/api/kafka/access"),
      [tick, s.application],
    ),
    w = useAction();
  if (topics.error || access.error) return <Notice kind="error">{topics.error ?? access.error}</Notice>;
  if (!topics.data || !access.data) return <Skeleton rows={4} />;
  const grants = access.data.items;
  // What this application owns, and what it has been granted: the two ways a topic is one it can
  // produce to. Anybody else's topic is on Kafka Topics, where access is asked for.
  const rows = topics.data.items.filter((t) => {
    if (t.environment !== s.environment || t.state === "deleted") return false;
    return t.applicationId === s.application || grantFor(grants, t.id, s.application)?.state === "active";
  });
  const kafka = `/${s.application}/kafka`;
  return (
    <Panel
      className="kafka-proxy"
      title={`Topics in ${envLabel(s.environment)}`}
      hint="Simulated: the portal answers for the proxy, and a call uses your portal sign-in rather than a subscription key."
    >
      <Notice kind="error">{w.error}</Notice>
      {rows.length === 0 ? (
        <EmptyState
          title={`No topics to reach in ${envLabel(s.environment)}`}
          detail="Topics this application owns, or has been granted access to, are listed here with their proxy."
          action={<Link className="btn sm" to={kafka}>Open Kafka Topics</Link>}
        />
      ) : (
        rows.map((t) => {
          const on = Boolean(t.proxy_enabled);
          const owner = s.applicationName(t.applicationId);
          const usable = grantFor(grants, t.id, s.application)?.state === "active";
          const produce = proxyCall(s.meta.publicUrl, t.id, s.application, "produce");
          const consume = proxyCall(s.meta.publicUrl, t.id, s.application, "consume");
          return (
            <div className="native-row" key={t.id}>
              <div>
                <div className="approval-head">
                  <strong>{t.name}</strong>
                  <StatusChip chip={kafkaProxyChip(on)} />
                </div>
                <small>{t.applicationId === s.application ? `Owned by ${owner}` : `${owner}'s topic`}</small>
                {!on ? (
                  <small>
                    {t.canEdit ? "Turn the proxy on to produce to and read this topic over HTTP." : `Only members of ${owner} can turn the proxy on.`}
                  </small>
                ) : !usable ? (
                  // The proxy is the same relationship a client would use, not a way around it: the
                  // call is refused without an active grant (kafka-playground).
                  <small>
                    Calls need {s.applicationName(s.application)}'s own access to the topic. <Link to={kafka}>Request it on Kafka Topics</Link>
                  </small>
                ) : (
                  <>
                    <h4>Endpoint</h4>
                    <div className="copy-row">
                      <code>{produce.endpoint}</code>
                      <CopyButton value={produce.endpoint} what={`${t.name} endpoint`} />
                    </div>
                    <h4>Produce a message</h4>
                    <div className="copy-row">
                      <code>{produce.curl}</code>
                      <CopyButton value={produce.curl} what={`produce command for ${t.name}`} />
                    </div>
                    <h4>Read the newest messages</h4>
                    <div className="copy-row">
                      <code>{consume.curl}</code>
                      <CopyButton value={consume.curl} what={`consume command for ${t.name}`} />
                    </div>
                  </>
                )}
              </div>
              {/* The owner's switch; nobody else gets a disabled one, because the sentence above
                  already says who can, and that is all a greyed button would have said. */}
              {t.canEdit && (
                <div className="native-actions">
                  <button
                    className="btn sm"
                    disabled={w.busy}
                    onClick={() =>
                      void w.run(async () => {
                        await api.patch(`/api/kafka/topics/${t.id}`, { proxyEnabled: !on });
                        topics.reload();
                      })
                    }
                  >
                    {on ? "Turn off" : "Turn on"}
                  </button>
                </div>
              )}
            </div>
          );
        })
      )}
    </Panel>
  );
}
