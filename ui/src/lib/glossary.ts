/**
 * The vocabulary, defined once (plan §9.4).
 *
 * Every domain word this portal uses in a heading, a chip or a button is defined here in one
 * sentence, in the language a person who does not work on the platform would use. `<Term>` renders
 * the word with its definition attached; the "How this works" page renders the whole table from the
 * same source, so the page and the tooltips cannot drift apart.
 *
 * The rule for writing one: say what it **is** and what it **decides**, not how it is stored. If a
 * definition needs another term, link it by name — `see` — rather than explaining it twice.
 */

export interface GlossaryEntry {
  term: string;
  definition: string;
  /** Related terms, by key. Rendered as "see also" on the How this works page. */
  see?: string[];
  group: "publishing" | "consuming" | "policy" | "operating" | "identity";
}

export const GLOSSARY: Record<string, GlossaryEntry> = {
  api: {
    term: "API",
    definition:
      "One published interface, at one version: its definition, where it is routed, which backend it forwards to, and the policies applied to it.",
    see: ["version", "revision", "route"],
    group: "publishing",
  },
  version: {
    term: "version",
    definition:
      "A separate API that shares a name with its siblings — v1 and v2 have their own routes, policies and subscribers, and a consumer moves between them deliberately.",
    see: ["api", "lifecycle"],
    group: "publishing",
  },
  revision: {
    term: "revision",
    definition:
      "One upload of an API's definition. Revisions are numbered, immutable once released, and are what gets promoted from one environment to the next.",
    see: ["release", "promote"],
    group: "publishing",
  },
  definition: {
    term: "definition",
    definition:
      "The contract an API is described by: an OpenAPI or Swagger document, a WSDL, an MCP manifest or an Agent Card.",
    see: ["revision"],
    group: "publishing",
  },
  release: {
    term: "release",
    definition:
      "The act of making one revision the live one in one environment. Until a revision is released, editing it changes nothing anybody can call.",
    see: ["revision", "promote", "environment"],
    group: "publishing",
  },
  promote: {
    term: "promote",
    definition:
      "Release the revision that is already live in one environment into the next one along the chain — DEV to TEST to PROD. Only the definition travels; policies, routes, backends and subscriptions belong to each environment.",
    see: ["release", "environment", "plan"],
    group: "publishing",
  },
  plan: {
    term: "plan",
    definition:
      "What a promotion would do, worked out before you confirm it: what is created, what is kept, and anything that would block it. Confirming applies exactly the plan you were shown.",
    see: ["promote"],
    group: "publishing",
  },
  environment: {
    term: "environment",
    definition:
      "One stage of the chain — DEV, TEST or PROD — with its own gateways, routes, backends, policies and subscription keys.",
    see: ["promote", "gateway"],
    group: "publishing",
  },
  route: {
    term: "route",
    definition:
      "The host and base path an API answers on in one environment. It is what the gateway matches an incoming request against.",
    see: ["base path", "gateway"],
    group: "publishing",
  },
  "base path": {
    term: "base path",
    definition:
      "The prefix every call to this API starts with, such as /petstore/v1. Two APIs cannot share one in the same environment.",
    see: ["route"],
    group: "publishing",
  },
  backend: {
    term: "backend",
    definition:
      "The address the gateway forwards to once a request has passed every policy. One API can have several, and the gateway spreads traffic across them.",
    see: ["route", "trust anchor"],
    group: "publishing",
  },
  lifecycle: {
    term: "lifecycle",
    definition:
      "Whether a version is active, deprecated (still served, but a newer one exists) or retired (no longer served at all).",
    see: ["version"],
    group: "publishing",
  },
  product: {
    term: "product",
    definition:
      "A bundle of APIs that consumers subscribe to as one thing. Subscribing to a product grants a key that works for every API in it.",
    see: ["subscription", "application"],
    group: "consuming",
  },
  application: {
    term: "application",
    group: "identity",
    definition: "The owner of APIs, products and subscriptions. Developers with membership act on its behalf to publish and consume services.",
  },
  subscription: {
    term: "subscription",
    definition:
      "One application's access to one product in one environment. It carries the keys and it is what rate limits and quotas are counted against.",
    see: ["application", "product", "key", "quota"],
    group: "consuming",
  },
  key: {
    term: "key",
    definition:
      "The secret a caller sends to identify its subscription. Every subscription can hold two at once, so a key can be replaced without a moment where neither works.",
    see: ["subscription", "rotate"],
    group: "consuming",
  },
  rotate: {
    term: "rotate",
    definition:
      "Issue a second key beside the first, move callers across, then retire the old one. Nothing breaks in between, which is the point.",
    see: ["key"],
    group: "consuming",
  },
  playground: {
    term: "playground",
    definition:
      "Calling a subscribed API from this portal. The request goes through the gateway exactly like any other call, so it spends the subscription's rate limit and quota and shows up in telemetry.",
    see: ["subscription", "quota"],
    group: "consuming",
  },
  policy: {
    term: "policy",
    definition:
      "A control attached to an API in one environment: who may call it, how often, what is validated, what is cached, how long it may take.",
    see: ["policy unit", "effective policy"],
    group: "policy",
  },
  "policy unit": {
    term: "policy unit",
    definition:
      "One control, attached or not attached. There is no half-on: a unit that is not attached is not running.",
    see: ["policy", "effective policy"],
    group: "policy",
  },
  "effective policy": {
    term: "effective policy",
    definition:
      "What the gateway actually runs for this API here: the environment's global units, with the API's own units on top where both set the same one.",
    see: ["policy unit", "global policy"],
    group: "policy",
  },
  "global policy": {
    term: "global policy",
    definition:
      "A policy unit attached to a whole environment, so it applies to every API in it unless that API sets the same unit itself.",
    see: ["effective policy"],
    group: "policy",
  },
  "rate limit": {
    term: "rate limit",
    definition:
      "How many calls one subscription may make in a short window, counted per gateway instance. Two instances mean twice the number in total.",
    see: ["quota", "subscription"],
    group: "policy",
  },
  quota: {
    term: "quota",
    definition:
      "How many calls one subscription may make over a long window — a day, a month — counted across the whole fleet rather than per instance.",
    see: ["rate limit", "subscription"],
    group: "policy",
  },
  validation: {
    term: "validation",
    definition:
      "Checking a request against the API's own definition before it reaches the backend. Blocking by default: an invalid request is refused rather than forwarded.",
    see: ["definition"],
    group: "policy",
  },
  gateway: {
    term: "gateway",
    definition:
      "The process that receives calls, applies the policies and forwards to the backend. Each environment runs one or more, and each fetches its configuration from this portal.",
    see: ["environment", "config document"],
    group: "operating",
  },
  "config document": {
    term: "config document",
    definition:
      "Everything one environment's gateways need, rendered from what this portal holds: routes, policies, subscriptions and trust. A gateway either applies all of it or keeps what it had.",
    see: ["gateway", "digest"],
    group: "operating",
  },
  digest: {
    term: "digest",
    definition:
      "A fingerprint of a document. Two gateways showing the same digest are running exactly the same configuration.",
    see: ["config document"],
    group: "operating",
  },
  "trust anchor": {
    term: "trust anchor",
    definition:
      "A certificate authority this environment's gateways trust. Registering the authority that signed your internal backends is what lets the gateway verify them instead of skipping the check.",
    see: ["tls exception", "backend"],
    group: "operating",
  },
  // Keys are lowercase — `define()` lowercases what it is given, so a key with a capital in it
  // could never be looked up. `term` carries the capitalisation the reader should see.
  "tls exception": {
    term: "TLS exception",
    definition:
      "A dated, admin-created permission to relax certificate checking for one backend. It always expires, and registering the certificate authority instead removes the need for it.",
    see: ["trust anchor"],
    group: "operating",
  },
  certificate: {
    term: "certificate",
    definition:
      "An identity the gateway presents to a backend that demands one. Distinct from a trust anchor, which is what the gateway checks the backend against.",
    see: ["trust anchor", "tls exception"],
    group: "operating",
  },
  telemetry: {
    term: "telemetry",
    definition:
      "Counts of calls per minute, reported by each gateway: how many were served, how many the gateway refused, and how many the backend failed.",
    see: ["gateway"],
    group: "operating",
  },
  attention: {
    term: "attention",
    definition:
      "Something the platform has noticed and can name: an API nobody can call yet, a key ageing out, a gateway that has stopped reporting. Each one links to the screen that fixes it.",
    group: "operating",
  },

  // ------------------------------------------------------------------ who you are (v5)
  member: {
    term: "member",
    definition:
      "Somebody in an application. A member can publish, change and withdraw anything their applications own, and can read everything else.",
    see: ["application", "administrator"],
    group: "identity",
  },
  administrator: {
    term: "administrator",
    definition:
      "Somebody who can act on every application, plus the things no application owns: gateways, global policy, the trust store, the audit log and this directory.",
    see: ["member", "application"],
    group: "identity",
  },
  principal: {
    term: "account",
    definition:
      "One person as this portal knows them. An account remembers who signed in, which applications they are in and what they have changed — so it is disabled rather than deleted.",
    see: ["identity provider", "session"],
    group: "identity",
  },
  "identity provider": {
    term: "identity provider",
    definition:
      "The directory people sign in through — Keycloak, or whatever your organisation runs. It owns their name, their password and which groups they are in; the portal reads those and maps the groups to applications.",
    see: ["application", "session"],
    group: "identity",
  },
  session: {
    term: "session",
    definition:
      "One signed-in browser. It ends when you sign out, after a period of inactivity, or at a fixed age whichever comes first — and an administrator can end it sooner.",
    see: ["principal"],
    group: "identity",
  },
};

export function define(key: string): GlossaryEntry | null {
  return GLOSSARY[key.toLowerCase()] ?? null;
}

/** The terms the portal must define to be usable without documentation, asserted by `ui/test`. */
export const REQUIRED_TERMS = [
  "api",
  "version",
  "revision",
  "release",
  "promote",
  "environment",
  "route",
  "base path",
  "backend",
  "product",
  "application",
  "subscription",
  "key",
  "policy",
  "effective policy",
  "rate limit",
  "quota",
  "gateway",
  "trust anchor",
  // v5. "Who is allowed to do this" is the question a newcomer asks first and the portal answered
  // nowhere: `application` in particular was a switcher in the sidebar with no definition anywhere.
  "application",
  "member",
  "administrator",
  "principal",
  "identity provider",
  "session",
];
