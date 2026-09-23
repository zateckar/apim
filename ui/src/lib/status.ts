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
      return { label: "Needs confirming", tone: "stop", title: "stale — the plan changed between confirmation and apply, so nothing was published" };
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
      return { label: "Active", tone: "live", title: "active — this application can produce to and consume from the topic" };
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
// end phase-2: workspace



// ==================================================================== phase-2: catalog
// Chips for the catalog screens. Add below this line only; the anchor keeps parallel additions apart.
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
 * A topic's HTTP proxy. Off is not a fault — it is the default (kafka-workspace, "Offer an HTTP
 * proxy per topic, off by default") — so it is `neutral`, never `stop`.
 */
export function kafkaProxyChip(enabled: boolean): Chip {
  return enabled
    ? { label: "Proxy on", tone: "live", title: "proxy_enabled — this topic can be produced to and read over HTTP" }
    : { label: "Proxy off", tone: "neutral", title: "proxy disabled — the topic's owner has not turned the HTTP proxy on" };
}

// end phase-2: processes



// ==================================================================== phase-2: gateways
// Chips for the gateways screens. Add below this line only; the anchor keeps parallel additions apart.
// end phase-2: gateways



// ==================================================================== phase-2: governance
// Chips for the governance screens. Add below this line only; the anchor keeps parallel additions apart.
// end phase-2: governance



// ==================================================================== phase-2: identity
// Chips for the identity screens. Add below this line only; the anchor keeps parallel additions apart.
// end phase-2: identity


