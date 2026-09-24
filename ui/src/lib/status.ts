import {
  INTEGRATION_EVENT_STATES,
  KAFKA_GRANT_STATES,
  KAFKA_TOPIC_STATES,
  LIFECYCLES,
  OPERATION_STATES,
  RELEASE_STATES,
  SUBSCRIPTION_STATES,
  type IntegrationEventState,
  type KafkaGrantState,
  type KafkaTopicState,
  type Lifecycle,
  type OperationState,
  type ReleaseState,
  type SubscriptionState,
} from "../../../shared/types.ts";

/**
 * One status vocabulary (plan §9.4).
 *
 * Every chip in the portal comes from here. The rule that makes it worth a module: **a state is
 * named by what it means for the reader**, not by the column value. "converged" is a word from the
 * reconciler; a person reading a list wants "Live". The column value stays available as the chip's
 * title, so nobody debugging is left guessing what it maps to.
 *
 * `tone` is a small closed set because colour has to mean one thing across the whole product:
 * `live` is good and current, `wait` is in progress, `stop` is broken or refusing, `past` is
 * history, `warn` is fine today and not tomorrow.
 */

export type Tone = "live" | "wait" | "stop" | "past" | "warn" | "neutral";

export interface Chip {
  label: string;
  tone: Tone;
  /** The long form: the underlying state, and what it means. Rendered as the chip's tooltip. */
  title: string;
}

export function releaseChip(state: ReleaseState): Chip {
  switch (state) {
    case "converged":
      return { label: "Live", tone: "live", title: "converged — every gateway in this environment is serving this revision" };
    case "pending":
      return { label: "Publishing", tone: "wait", title: "pending — accepted, waiting for the reconciler to apply it" };
    case "converging":
      return { label: "Publishing", tone: "wait", title: "converging — applied here, waiting for the gateways to pick it up" };
    case "superseded":
      return { label: "Replaced", tone: "past", title: "superseded — a later revision took its place, and this one can be rolled back to" };
    case "withdrawn":
      return { label: "Withdrawn", tone: "past", title: "withdrawn — it was live here and was taken out of service" };
    case "failed":
      return { label: "Failed", tone: "stop", title: "failed — publishing did not complete, and nothing changed" };
    case "stale":
      return { label: "Needs confirming", tone: "stop", title: "stale — a release confirmed later reached this environment first, so nothing was published; release this revision again to roll back to it" };
  }
}

export function lifecycleChip(lifecycle: Lifecycle): Chip | null {
  switch (lifecycle) {
    case "active":
      // No chip: "active" is the absence of news, and a chip on every row means nothing.
      return null;
    case "deprecated":
      return { label: "Deprecated", tone: "warn", title: "still served, but a newer version exists and this one will stop" };
    case "retired":
      return { label: "Retired", tone: "stop", title: "no longer served — calls to it fail" };
  }
}

/** Where a revision stands in one environment, as the revision list reports it. */
export function releasedInChip(state: "live" | "previously" | "never"): Chip {
  switch (state) {
    case "live":
      return { label: "Live", tone: "live", title: "this revision is the one being served here" };
    case "previously":
      return { label: "Was live", tone: "past", title: "this revision was live here, so it is a rollback target" };
    case "never":
      return { label: "Never", tone: "neutral", title: "this revision has never been released here" };
  }
}

/**
 * What a durable operation is doing, for the reader watching their own change go out.
 *
 * The question behind every one of these is "is it out there yet, and if not is it stuck". So the
 * three that are still moving are `wait` and say what is being waited on, `blocked` is `stop`
 * because it has given up and needs a person, and only `complete` is `live`.
 *
 * Deliberately not "Publishing": an operation is a publish, a configure, a promote **or** a
 * subscribe, and three quarters of those are not publishing anything.
 */
export function operationChip(state: OperationState): Chip {
  switch (state) {
    case "queued":
      return { label: "Queued", tone: "wait", title: "queued — accepted, waiting its turn behind this API's earlier changes" };
    case "applying":
      return { label: "Applying", tone: "wait", title: "applying — the control plane is writing the change now" };
    case "retrying":
      return { label: "Retrying", tone: "wait", title: "retrying — an attempt failed and it is being tried again, further apart each time" };
    case "blocked":
      return { label: "Blocked", tone: "stop", title: "blocked — five attempts failed, so it stopped trying; the error is on the row" };
    case "waiting-for-gateways":
      return { label: "Rolling out", tone: "wait", title: "waiting-for-gateways — applied here, waiting for every gateway in the environment to pick it up" };
    case "complete":
      return { label: "Done", tone: "live", title: "complete — every gateway in the environment has the change" };
    case "superseded":
      return { label: "Replaced", tone: "past", title: "superseded — a later change to the same API overtook this one" };
  }
}

/**
 * A consumer's access to a product.
 *
 * Only `active` is `live`, because only `active` means the keys work — and that is the whole
 * question. `pending` used to render as **Revoked**: the old two-branch version treated everything
 * that was not `active` as revoked, so a request nobody had decided yet looked like one that had
 * been taken away.
 */
export function subscriptionChip(state: SubscriptionState): Chip {
  switch (state) {
    case "pending":
      return { label: "Awaiting approval", tone: "wait", title: "pending — the publisher has not decided yet, and the keys do not work until they do" };
    case "activating":
      return { label: "Activating", tone: "wait", title: "activating — approved, waiting for the gateways to start accepting the keys" };
    case "active":
      return { label: "Active", tone: "live", title: "active — its keys work" };
    case "revoking":
      return { label: "Revoking", tone: "wait", title: "revoking — withdrawn here, waiting for the gateways to stop accepting the keys" };
    case "revoked":
      return { label: "Revoked", tone: "stop", title: "revoked — its keys no longer work, and it cannot be un-revoked" };
    case "rejected":
      return { label: "Rejected", tone: "stop", title: "rejected — the publisher declined the request; asking again means a new request" };
    case "cancelled":
      return { label: "Cancelled", tone: "past", title: "cancelled — the consumer withdrew the request before it was decided" };
  }
}

/**
 * One of a subscription's two keys, by its age.
 *
 * The chip says the age rather than the word "ok", because the age is the number somebody is
 * deciding on and "ok" is a number they would then have to go and find. The deadline is in the
 * title, where the reader looks once they care.
 *
 * `null` for a slot nobody has minted yet: there is no key, so there is nothing to be old.
 */
export function subscriptionKeyChip(key: {
  which: string;
  status: "absent" | "ok" | "ageing" | "expired";
  ageDays: number | null;
  mintedAt: string | null;
  expiresAt: string | null;
  expiredAt: string | null;
}): Chip | null {
  const minted = key.mintedAt ? `minted ${key.mintedAt.slice(0, 10)}` : "minted before this was recorded";
  switch (key.status) {
    case "absent":
      return null;
    case "expired":
      return {
        label: "Expired",
        tone: "stop",
        title: `expired — retired on ${key.expiredAt?.slice(0, 10) ?? "an unrecorded date"}, and the gateway no longer accepts it. Rotating this slot mints a replacement.`,
      };
    case "ageing":
      return {
        label: `${key.ageDays} days`,
        tone: "warn",
        title: `${minted}, and stops working on ${key.expiresAt?.slice(0, 10) ?? "an unknown date"} — soon enough to plan the rotation with the teams that call you.`,
      };
    case "ok":
      return {
        label: key.ageDays === null ? "In use" : `${key.ageDays} days`,
        tone: "live",
        title: `${minted}${key.expiresAt ? `, and stops working on ${key.expiresAt.slice(0, 10)}` : ""}.`,
      };
  }
}

/** A simulated Kafka topic. `ready` is the broker having confirmed it, not the row existing. */
export function kafkaTopicChip(state: KafkaTopicState): Chip {
  switch (state) {
    case "provisioning":
      return { label: "Creating", tone: "wait", title: "provisioning — the simulated broker has not confirmed the topic yet" };
    case "ready":
      return { label: "Ready", tone: "live", title: "ready — the topic exists and can be produced to and consumed from" };
    case "deleted":
      return { label: "Deleted", tone: "past", title: "deleted — the topic and its simulated messages are gone" };
  }
}

/**
 * One application's access to one topic. The same seven steps as a subscription, and the same
 * tones — but the words are about access rather than keys, because a grant has no keys.
 */
export function kafkaGrantChip(state: KafkaGrantState): Chip {
  switch (state) {
    case "pending":
      return { label: "Awaiting approval", tone: "wait", title: "pending — the topic's owner has not decided yet" };
    case "activating":
      return { label: "Activating", tone: "wait", title: "activating — approved, waiting for the simulated broker to apply the access" };
    case "active":
      return { label: "Active", tone: "live", title: "active — the principal holds this operation on the topic" };
    case "revoking":
      return { label: "Revoking", tone: "wait", title: "revoking — withdrawn here, waiting for the simulated broker to remove the access" };
    case "revoked":
      return { label: "Revoked", tone: "stop", title: "revoked — the access is gone, and it cannot be un-revoked" };
    case "rejected":
      return { label: "Rejected", tone: "stop", title: "rejected — the topic's owner declined the request; asking again means a new request" };
    case "cancelled":
      return { label: "Cancelled", tone: "past", title: "cancelled — the requester withdrew it before the owner decided" };
  }
}

/**
 * One call to one of the six simulated external systems.
 *
 * `awaiting-decision` is the only one that is about a person rather than a machine, and it is the
 * one the Approvals screen is filtering for — so it says what is being waited on and who by.
 */
export function integrationEventChip(state: IntegrationEventState): Chip {
  switch (state) {
    case "queued":
      return { label: "Queued", tone: "wait", title: "queued — waiting for the simulated external system to be called" };
    case "retrying":
      return { label: "Retrying", tone: "wait", title: "retrying — the call failed and is being tried again, further apart each time" };
    case "delivered":
      return { label: "Delivered", tone: "live", title: "delivered — the simulated external system accepted it" };
    case "completed":
      return { label: "Completed", tone: "live", title: "completed — the simulated diagnostics ran every step to the end" };
    case "awaiting-decision":
      return { label: "Awaiting decision", tone: "wait", title: "awaiting-decision — simulated SkoNET is holding this for the publisher to approve or reject" };
    case "approved":
      return { label: "Approved", tone: "live", title: "approved — the publisher granted the access, and provisioning followed" };
    case "rejected":
      return { label: "Rejected", tone: "stop", title: "rejected — the publisher declined, and nothing was provisioned" };
  }
}

export function instanceChip(instance: { revoked: boolean; stale: boolean; inSync?: boolean }): Chip {
  if (instance.revoked) {
    return { label: "Revoked", tone: "stop", title: "this instance's token was revoked; it stops at its next poll" };
  }
  if (instance.stale) {
    return { label: "Not reporting", tone: "stop", title: "no poll recently — it is stopped, or it cannot reach the portal" };
  }
  if (instance.inSync === false) {
    return { label: "Catching up", tone: "wait", title: "reporting, but not yet on the current configuration" };
  }
  return { label: "Healthy", tone: "live", title: "reporting, and on the current configuration" };
}

/** Everything a test iterates to assert the vocabulary is total. */
export const STATUS_DOMAINS = {
  release: RELEASE_STATES,
  lifecycle: LIFECYCLES,
  releasedIn: ["live", "previously", "never"] as const,
  subscription: SUBSCRIPTION_STATES,
  operation: OPERATION_STATES,
  kafkaTopic: KAFKA_TOPIC_STATES,
  kafkaGrant: KAFKA_GRANT_STATES,
  integrationEvent: INTEGRATION_EVENT_STATES,
};


// ==================================================================== phase-2: workspace
// Chips for the workspace screens. Add below this line only; the anchor keeps parallel additions apart.

/**
 * An HTTP status, as the workspace's three readers of one draw it: the log table, the playground's
 * answer and the playground's history.
 *
 * Each of them picked its own tones, so a 302 was grey in the logs and amber in the playground
 * beside it, and the history built its chip objects inline. One function, and the redirect is
 * `neutral` everywhere — it is neither a success nor a refusal, and amber taught the reader to go
 * looking for a problem that was not there. `null` is a call that got no answer at all.
 */
export function httpStatusChip(
  status: number | null,
  detail: { statusText?: string | null; durationMs?: number | null; error?: string | null } = {},
): Chip {
  if (status === null || detail.error) {
    return {
      label: "No response",
      tone: "stop",
      title: `no response — ${detail.error ?? "the call did not get an answer"}`,
    };
  }
  const took = typeof detail.durationMs === "number" ? ` in ${Math.round(detail.durationMs)} ms` : "";
  const text = `${status}${detail.statusText ? ` ${detail.statusText}` : ""}${took}`;
  if (status >= 500) return { label: String(status), tone: "stop", title: `${text} — the backend or the gateway failed` };
  if (status >= 400) return { label: String(status), tone: "warn", title: `${text} — the request was refused` };
  if (status >= 300) return { label: String(status), tone: "neutral", title: `${text} — redirected elsewhere` };
  return { label: String(status), tone: "live", title: `${text} — succeeded` };
}

/**
 * One operation's change between two revisions. The word is the change; the tone is whether it
 * breaks somebody calling today, which is the only thing the reader of a diff is deciding about.
 */
export function diffChangeChip(change: string, breaking: boolean): Chip {
  const label = change.charAt(0).toUpperCase() + change.slice(1);
  if (breaking) return { label, tone: "stop", title: `${change} — breaks callers who use it today` };
  if (change === "added") return { label, tone: "live", title: "added — new, so nobody depends on it yet" };
  return { label, tone: "warn", title: `${change} — safe for the callers there are today` };
}

/** A definition check's severity. `error` is what publishing would refuse; the rest are advice. */
export function diagnosticChip(severity: "error" | "warning" | "info"): Chip {
  if (severity === "error") return { label: "Error", tone: "stop", title: "error — publishing refuses a definition with this" };
  if (severity === "warning") return { label: "Warning", tone: "warn", title: "warning — accepted, but likely to surprise a caller" };
  return { label: "Info", tone: "neutral", title: "info — worth knowing, and nothing to fix" };
}

/**
 * A gateway an API can be placed on, when it is not simply available. Paused is the one state worth
 * a chip: a change to an API on a paused gateway is held rather than refused (control-plane-surface,
 * The environment cannot take the change), which a publisher otherwise reads as a stuck deployment.
 */
export function localityChip(locality: { paused: boolean }): Chip | null {
  if (!locality.paused) return null;
  return {
    label: "Paused",
    tone: "warn",
    title: "paused — deployments to this gateway wait until an administrator resumes it",
  };
}
// end phase-2: workspace



// ==================================================================== phase-2: catalog
// Chips for the catalog screens. Add below this line only; the anchor keeps parallel additions apart.

/**
 * Visible to the reader only because they may change it. The card used to say this with a raw
 * `badge warn` and a separate admin-only sentence under the list; the chip's title carries it now,
 * on every row it applies to and for every owner rather than only for administrators.
 */
export function unpublishedChip(): Chip {
  return {
    label: "Not published",
    tone: "warn",
    title: "not released in any environment yet — you see it because you can change it, and nobody else does until it is released",
  };
}

/**
 * Whether a catalogue card can be asked for, from the reader's side (workspace-api-catalog, "The
 * catalog is scanned": a row says whether it is available or already subscribed).
 *
 * Three answers, because "not in a product" is the one a consumer otherwise discovers only after
 * opening the listing: there is nothing to subscribe to until its owner puts it in one.
 */
export function catalogAccessChip(card: { subscribed: boolean; products: ReadonlyArray<unknown> }): Chip {
  if (card.subscribed) {
    return { label: "Subscribed", tone: "live", title: "one of your applications holds an active subscription that reaches this" };
  }
  if (card.products.length > 0) {
    return { label: "Available to subscribe", tone: "neutral", title: "it is in at least one product, so any application can ask for access" };
  }
  return { label: "Not in a product", tone: "neutral", title: "nothing to subscribe to yet — its owner has not added it to a product" };
}

/**
 * One listing, and the reader's own access to it, named by where it works.
 *
 * It said "You subscribe", which is neither a sentence nor an answer: *which* application, and in
 * which environment — a key is per environment, so "subscribed" without one is half a fact. The
 * caller passes environments already written the way a reader sees them (`envLabel`), because this
 * module has no business importing a component.
 */
export function listingAccessChip(
  state: "active" | "waiting",
  environments: ReadonlyArray<string>,
  applications: ReadonlyArray<string>,
): Chip {
  const where = environments.join(", ");
  const who = applications.join(", ");
  return state === "active"
    ? { label: `Subscribed in ${where}`, tone: "live", title: `${who} can call this in ${where} with the keys on its subscription` }
    : { label: `Requested in ${where}`, tone: "wait", title: `${who} asked for access in ${where}; the keys work once it is approved and active` };
}

/**
 * One environment on a listing's "Where it is live". A route with nothing released behind it is the
 * state a caller trips on — the address exists and every call to it fails — so it is a chip of its
 * own rather than the absence of the Live one.
 */
export function endpointChip(live: boolean): Chip {
  return live
    ? { label: "Live", tone: "live", title: "released here — calls to these addresses reach it" }
    : { label: "Not released", tone: "neutral", title: "a route exists here but nothing has been released behind it, so calls to it fail" };
}
// end phase-2: catalog



// ==================================================================== phase-2: processes
// Chips for the processes screens. Add below this line only; the anchor keeps parallel additions apart.

/**
 * What an operation did, as a reader says it: "Published", not `publish`.
 *
 * Activity, the dashboard and an API's history all printed the column value, so a list of changes
 * read `publish · DEV`, `configure · DEV` — the verbs of the endpoint that queued them. `configure`
 * is the one that needed more than a tense: it is a policy, route or backend edited in place, which
 * nobody calls "configuring". A kind the portal has no word for yet is still shown, spaced out and
 * capitalised, rather than dropped (the rule notifications-and-mail keeps for an unknown outbox kind).
 */
export function operationKindLabel(kind: string): string {
  switch (kind) {
    case "publish":
      return "Published";
    case "configure":
      return "Settings changed";
    case "promote":
      return "Promoted";
    default: {
      const words = kind.replace(/[._-]+/g, " ").trim();
      return words ? words[0]!.toUpperCase() + words.slice(1) : "Change";
    }
  }
}

/**
 * Whether one message has left the outbox (notifications-and-mail, "A message has not been sent
 * yet"). The mailbox wrote the column value in a hand-picked chip colour, and "sent" beside
 * "queued" did not say which of them was the one still waiting.
 */
export function mailChip(state: string): Chip {
  switch (state) {
    case "delivered":
      return { label: "Sent", tone: "live", title: "delivered — handed to the simulated mail transport" };
    case "retrying":
      return { label: "Retrying", tone: "wait", title: "retrying — the simulated transport failed and it is being tried again" };
    case "queued":
      return { label: "Not sent yet", tone: "wait", title: "queued — composed, and waiting for the simulated transport to run" };
    default:
      return { label: "Not sent", tone: "neutral", title: `${state} — this message has not been handed to the transport` };
  }
}

/**
 * Whether a topic has an HTTP API in this environment (kafka-rest-proxy). Having none is not a
 * fault — most topics are produced to over Kafka itself — so it is `neutral`, never `stop`. The
 * first reason it cannot have one, when there is one, is the title.
 */
/** On a catalog card: this API produces to a Kafka topic, and was generated from its schema. */
export function kafkaTopicApiChip(topic: string): Chip {
  return { label: "Kafka topic", tone: "neutral", title: `produces records to the Kafka topic ${topic}; its contract is the topic's schema` };
}

export function topicApiChip(published: boolean, blocker?: string | null): Chip {
  if (published)
    return { label: "HTTP API", tone: "live", title: "this topic has an API here, generated from its schema" };
  return blocker
    ? { label: "No HTTP API", tone: "neutral", title: blocker }
    : { label: "No HTTP API", tone: "neutral", title: "the topic's owner can create one on Kafka REST Proxy" };
}

// end phase-2: processes



// ==================================================================== phase-2: gateways
// Chips for the gateways screens. Add below this line only; the anchor keeps parallel additions apart.

/**
 * One replica, as Gateways and Health Status both list it.
 *
 * `instanceChip` answers three of the four questions; the fourth is a replica that *refused* the
 * current document — a missing artifact, a settings block its container cannot honour. Left to
 * `instanceChip` it read **Catching up**, which tells an administrator to wait for something that
 * will never arrive on its own (platform-administration, "An instance's state is read").
 */
export function replicaChip(instance: {
  revoked: boolean;
  stale: boolean;
  current: boolean;
  refused?: string | null;
}): Chip {
  if (!instance.revoked && !instance.stale && instance.refused) {
    return {
      label: "Refused config",
      tone: "stop",
      title: `it refused the current configuration and keeps serving the last one it activated: ${instance.refused}`,
    };
  }
  return instanceChip({ revoked: instance.revoked, stale: instance.stale, inSync: instance.current });
}

/**
 * Whether one gateway's replicas have all applied its current document. "No replicas" is `stop`
 * rather than `neutral` because a gateway with nothing behind it serves nothing, which is the
 * outage, not the absence of news.
 */
export function gatewaySyncChip(gateway: { inSync: boolean; expectedReplicas: number; behindReplicas: number }): Chip {
  if (gateway.expectedReplicas === 0) {
    return { label: "No replicas", tone: "stop", title: "no un-revoked replica is registered, so nothing serves this gateway" };
  }
  if (gateway.inSync) {
    return { label: "In sync", tone: "live", title: "every un-revoked replica has applied this gateway's current configuration" };
  }
  return {
    label: `${gateway.behindReplicas} behind`,
    tone: "wait",
    title: "some replicas are not yet on the current configuration, or are not reporting",
  };
}

/** A gateway whose deployments are held. It still serves; it is the *changes* that wait. */
export const PAUSED_CHIP: Chip = {
  label: "Paused",
  tone: "warn",
  title: "deployments are paused — it keeps serving what it has, and changes that include it wait until it is resumed",
};

// end phase-2: gateways



// ==================================================================== phase-2: governance
// Chips for the governance screens. Add below this line only; the anchor keeps parallel additions apart.

/**
 * How far a TLS exception relaxes verification. Named by what is still checked, because that is the
 * question the governance report exists to answer: a pin is the one mode that is not a downgrade.
 */
export function tlsModeChip(mode: string): Chip {
  switch (mode) {
    case "pin":
      return { label: "Pinned", tone: "live", title: "pin — the chain is verified and the certificate must be exactly this one" };
    case "skip-hostname":
      return { label: "No hostname check", tone: "warn", title: "skip-hostname — the chain is verified; the name in the certificate is ignored" };
    case "insecure":
      return { label: "Not verified", tone: "stop", title: "insecure — nothing about the backend's certificate is checked" };
    default:
      return { label: mode, tone: "neutral", title: mode };
  }
}

/**
 * Where a TLS exception stands in time. A week is the warning line because the attention row for an
 * expiring exception is raised on the same horizon (`trust-store`, *An exception is nearing its
 * expiry*), and the chip should not disagree with the dashboard about what "soon" is.
 */
export function tlsExceptionChip(row: { live: boolean; revokedAt: string | null; expiresInDays: number }): Chip {
  if (row.revokedAt) return { label: "Revoked", tone: "past", title: "revoked — the gateways no longer honour it" };
  if (!row.live) return { label: "Expired", tone: "past", title: "expired — the gateways stopped honouring it on their own clock" };
  const days = `${row.expiresInDays} day${row.expiresInDays === 1 ? "" : "s"} left`;
  return row.expiresInDays <= 7
    ? { label: days, tone: "warn", title: "live, and expires within a week — renew it or remove the need for it" }
    : { label: days, tone: "neutral", title: "live — the gateways honour it until it expires" };
}

/** A trusted certificate authority by its remaining life; thirty days is the renewal warning. */
export function anchorExpiryChip(row: { expired: boolean; expiresInDays: number }, notAfter: string): Chip {
  if (row.expired) return { label: "Expired", tone: "stop", title: `expired on ${notAfter} — no gateway trusts it any more` };
  const days = `${row.expiresInDays} day${row.expiresInDays === 1 ? "" : "s"}`;
  return row.expiresInDays <= 30
    ? { label: days, tone: "warn", title: `expires on ${notAfter} — register the replacement before then` }
    : { label: days, tone: "live", title: `trusted until ${notAfter}` };
}

/** What a route's `validate` unit does with a request or response that does not match. */
export function validationChip(state: string): Chip {
  switch (state) {
    case "blocking":
      return { label: "Blocking", tone: "live", title: "blocking — an invalid message is refused" };
    case "warning":
      return { label: "Warning only", tone: "warn", title: "warning — an invalid message is logged and passed through" };
    case "disabled":
      return { label: "Off", tone: "stop", title: "disabled — nothing is checked" };
    default:
      return { label: state, tone: "neutral", title: state };
  }
}

/** Why an operation cannot be validated at all: the fix is to the definition, not the policy. */
export function schemaStateChip(state: string): Chip {
  switch (state) {
    case "ok":
      return { label: "Validated", tone: "live", title: "ok — requests are checked against the declared schema" };
    case "no-schema":
      return { label: "No schema", tone: "warn", title: "no-schema — the definition declares nothing to validate against" };
    case "unsupported-schema":
      return { label: "Unsupported schema", tone: "warn", title: "unsupported-schema — the schema uses a construct outside the implemented subset" };
    default:
      return { label: state, tone: "warn", title: state };
  }
}

/** One global policy unit in one environment. */
export function globalUnitChip(attached: boolean): Chip {
  return attached
    ? { label: "Attached", tone: "live", title: "applied under every API in this environment that does not set it itself" }
    : { label: "Not attached", tone: "neutral", title: "not set for this environment; each API decides for itself" };
}

/** How an audited action ended — the three outcomes `writeAudit` records. */
export function auditOutcomeChip(outcome: string): Chip {
  switch (outcome) {
    case "ok":
      return { label: "Succeeded", tone: "live", title: "ok — the change was made" };
    case "denied":
      return { label: "Refused", tone: "stop", title: "denied — the caller was not allowed to do this, and nothing changed" };
    case "failed":
      return { label: "Failed", tone: "stop", title: "failed — it was attempted and did not complete" };
    default:
      return { label: outcome, tone: "neutral", title: outcome };
  }
}

/**
 * How a request ended, as Telemetry counts it. The served outcomes mirror `shared/telemetry.ts`'s
 * `SERVED_OUTCOMES`; duplicated because the bundle talks to the control plane only over the API, and
 * the cost of the copy is one chip's tone.
 */
const SERVED_OUTCOMES = new Set(["ok", "cache-hit", "stream-closed", "rpc-error"]);
export function telemetryOutcomeChip(outcome: string, count: number): Chip {
  return SERVED_OUTCOMES.has(outcome)
    ? { label: `${outcome} · ${count.toLocaleString()}`, tone: "live", title: `${outcome} — the request got an answer` }
    : { label: `${outcome} · ${count.toLocaleString()}`, tone: "warn", title: `${outcome} — the request did not get the answer it asked for` };
}
// end phase-2: governance



// ==================================================================== phase-2: identity
// Chips for the identity screens. Add below this line only; the anchor keeps parallel additions apart.

// Imported here rather than at the head of the file so this section merges on its own; an import
// is hoisted wherever it is written.
import { formatDate, formatDateTime } from "./datetime";

/**
 * How long a client certificate has left, on the Credentials list.
 *
 * It was a bare `badge ok|warn|bad` beside the name, and the row under an expired one carried a
 * `row-bad` class whose only rule was for table rows — the list is not a table, so the one state on
 * that screen that is an outage looked like every other row. The chip says the remaining days,
 * because that is the number somebody plans a renewal around; the date is in the title
 * (app-certificates, "Warn before a certificate expires").
 */
export function certificateExpiryChip(certificate: {
  expired: boolean;
  expiresInDays: number;
  notAfter: string;
}): Chip {
  const on = formatDate(certificate.notAfter);
  if (certificate.expired) {
    return {
      label: "Expired",
      tone: "stop",
      title: `expired on ${on} — every request through a binding that uses it fails its TLS handshake. Rotate it to replace the key pair in place.`,
    };
  }
  const days = `${certificate.expiresInDays} day${certificate.expiresInDays === 1 ? "" : "s"} left`;
  if (certificate.expiresInDays <= 30) {
    return {
      label: days,
      tone: "warn",
      title: `expires on ${on}. Rotating it keeps its name, so nothing that uses it has to be re-saved.`,
    };
  }
  return { label: days, tone: "live", title: `valid until ${on}` };
}

/**
 * What stands in the way of an account signing in, worst first — the People list and one person's
 * page. Each used to be a `pill` of its own colour class, so "disabled" on the list and "disabled"
 * anywhere else in the portal were two different reds. An account with nothing in the way has no
 * chip: "can sign in" is the absence of news.
 */
export function accountChips(account: {
  disabled: boolean;
  lockedUntil: string | null;
  mustChangePassword: boolean;
}): Chip[] {
  const chips: Chip[] = [];
  if (account.disabled) {
    chips.push({ label: "Disabled", tone: "stop", title: "disabled — they cannot sign in, whatever the identity provider says, and every session they had was ended" });
  }
  if (account.lockedUntil) {
    chips.push({ label: "Locked", tone: "warn", title: `locked until ${formatDateTime(account.lockedUntil)} after repeated failed sign-ins` });
  }
  if (account.mustChangePassword) {
    chips.push({ label: "Must change password", tone: "warn", title: "somebody else set their password, so they choose their own at the next sign-in" });
  }
  return chips;
}
// end phase-2: identity


