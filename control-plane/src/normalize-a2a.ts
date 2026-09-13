import {
  A2A_PROTOCOL_VERSION,
  AGENT_CARD_PATH,
  LEGACY_AGENT_CARD_PATH,
  operationsFromCard,
} from "../../shared/a2a.ts";
import type { A2aBinding, A2aSkill, ApiModel } from "../../shared/types.ts";
import { checkEgress, type EgressScope } from "./egress.ts";
import { badGateway, badRequest } from "./router.ts";
import type { NormalizeResult } from "./normalize.ts";

/**
 * Publishing an existing A2A agent (goal G5, plan section 10).
 *
 * An agent's contract is its **Agent Card**, so unlike MCP there is a document to fetch — but the
 * card is also an *advertisement*, and that is what makes this variant different from every other:
 * it names a URL, and consumers follow it. Publishing an agent through this platform therefore has
 * to rewrite the card, or every consumer would discover the origin and walk straight past every
 * policy the platform exists to apply (plan `[R1-16]`).
 *
 * The rewrite itself lives in the gateway (`shared/a2a.ts`'s `rewriteCard`), because the public URL
 * is a property of the route rather than of the revision — one agent published into three
 * environments has three URLs and one card. What is stored here is the origin's card as it was
 * found, which is also what `regenerate` diffs.
 */

export interface DiscoverA2aOptions {
  /** Estate-wide deny rules and the denied ranges: discovery is a fetch like a spec import. */
  egress: EgressScope;
  maxBytes: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export function looksLikeAgentCard(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{")) return false;
  try {
    const doc = JSON.parse(trimmed) as Record<string, unknown>;
    return typeof doc.name === "string" && (doc.skills !== undefined || doc.capabilities !== undefined);
  } catch {
    return false;
  }
}

/**
 * The card becomes the model: skills are the catalog's facets, capabilities decide which JSON-RPC
 * methods exist as operations, and `url` is kept only so the binding can be prefilled from it.
 */
export function normalizeA2a(raw: string): NormalizeResult {
  let doc: Record<string, unknown>;
  try {
    doc = JSON.parse(raw.trim()) as Record<string, unknown>;
  } catch (err) {
    throw badRequest(`the agent card is not valid JSON: ${(err as Error).message}`);
  }
  const binding = readCard(doc);
  const model: ApiModel = {
    title: binding.name,
    version: binding.version,
    ...(binding.description ? { description: binding.description } : {}),
    // The origin, so `PUT /binding` can be prefilled the way a WSDL's `soap:address` prefills one.
    servers: binding.originUrl ? [binding.originUrl] : [],
    operations: operationsFromCard(binding),
    a2a: binding,
    schemaDialect: "2020-12",
  };
  return { model, format: "a2a-agent-card" };
}

function readCard(doc: Record<string, unknown>): A2aBinding {
  const name = typeof doc.name === "string" && doc.name.length > 0 ? doc.name : null;
  if (!name) throw badRequest("the agent card has no name, so there is nothing to publish it as");

  const capabilities = asRecord(doc.capabilities);
  const url = typeof doc.url === "string" ? doc.url : "";
  return {
    protocolVersion:
      typeof doc.protocolVersion === "string" ? doc.protocolVersion : A2A_PROTOCOL_VERSION,
    name,
    ...(typeof doc.description === "string" ? { description: doc.description } : {}),
    version: typeof doc.version === "string" ? doc.version : "0.0.0",
    originUrl: url,
    ...(typeof doc.preferredTransport === "string"
      ? { preferredTransport: doc.preferredTransport }
      : {}),
    capabilities: {
      ...(capabilities.streaming === true ? { streaming: true } : {}),
      ...(capabilities.pushNotifications === true ? { pushNotifications: true } : {}),
      ...(capabilities.stateTransitionHistory === true ? { stateTransitionHistory: true } : {}),
    },
    defaultInputModes: stringsOf(doc.defaultInputModes, ["text/plain"]),
    defaultOutputModes: stringsOf(doc.defaultOutputModes, ["text/plain"]),
    skills: asArray(doc.skills)
      .map((entry) => readSkill(asRecord(entry)))
      .filter((skill): skill is A2aSkill => skill !== null),
    ...(isPlainObject(doc.securitySchemes) ? { securitySchemes: doc.securitySchemes } : {}),
    ...(typeof doc.documentationUrl === "string" ? { documentationUrl: doc.documentationUrl } : {}),
    ...(isPlainObject(doc.provider)
      ? {
          provider: {
            ...(typeof doc.provider.organization === "string"
              ? { organization: doc.provider.organization }
              : {}),
            ...(typeof doc.provider.url === "string" ? { url: doc.provider.url } : {}),
          },
        }
      : {}),
  };
}

function readSkill(entry: Record<string, unknown>): A2aSkill | null {
  const id = typeof entry.id === "string" ? entry.id : null;
  const name = typeof entry.name === "string" ? entry.name : id;
  if (!id || !name) return null;
  return {
    id,
    name,
    ...(typeof entry.description === "string" ? { description: entry.description } : {}),
    tags: stringsOf(entry.tags, []),
    ...(Array.isArray(entry.examples) ? { examples: stringsOf(entry.examples, []) } : {}),
    ...(Array.isArray(entry.inputModes) ? { inputModes: stringsOf(entry.inputModes, []) } : {}),
    ...(Array.isArray(entry.outputModes) ? { outputModes: stringsOf(entry.outputModes, []) } : {}),
  };
}

/**
 * Fetches the card. `discoverUrl` may be the agent's base URL or the card itself, because both are
 * what people have in hand — and the pre-0.3 location is tried after the current one, since agents
 * in the wild still serve it there.
 */
export async function discoverA2a(
  discoverUrl: string,
  options: DiscoverA2aOptions,
): Promise<{ raw: string; card: A2aBinding }> {
  const candidates = cardUrlsFor(discoverUrl);
  const doFetch = options.fetchImpl ?? fetch;
  const tried: string[] = [];
  /** Kept apart from `tried`: "answered 404" and "did not answer" are different diagnoses. */
  const unreachable: string[] = [];

  for (const candidate of candidates) {
    const errors = await checkEgress(candidate, "discoverUrl", options.egress);
    if (errors.length > 0) throw badRequest(errors.join("; "));

    let response: Response;
    try {
      response = await doFetch(candidate, {
        redirect: "manual",
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(options.timeoutMs ?? 20_000),
      });
    } catch (err) {
      unreachable.push(`${candidate} → ${(err as Error).message}`);
      continue;
    }
    if (response.status >= 300 && response.status < 400) {
      throw badRequest(
        `the agent card at ${candidate} redirected to ${response.headers.get("location") ?? "elsewhere"}; ` +
          "redirects are never followed (design section 5.3)",
      );
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      tried.push(`${candidate} → HTTP ${response.status}`);
      continue;
    }
    const raw = await readBounded(response, options.maxBytes, candidate);
    return { raw, card: readCard(JSON.parse(raw.trim()) as Record<string, unknown>) };
  }

  if (tried.length === 0) {
    throw badGateway(`the agent could not be reached: ${unreachable.join("; ")}`);
  }
  throw badRequest(
    `no agent card was found: ${[...tried, ...unreachable].join("; ")}. An A2A agent publishes ` +
      `one at ${AGENT_CARD_PATH} (or, before 0.3, ${LEGACY_AGENT_CARD_PATH}).`,
  );
}

/** The URLs to try, in order, for something somebody typed into a box. */
export function cardUrlsFor(discoverUrl: string): string[] {
  let url: URL;
  try {
    url = new URL(discoverUrl);
  } catch {
    throw badRequest("discoverUrl: not a valid absolute URL");
  }
  if (url.pathname.endsWith(".json")) return [url.toString()];
  const base = url.toString().replace(/\/+$/, "");
  return [`${base}${AGENT_CARD_PATH}`, `${base}${LEGACY_AGENT_CARD_PATH}`];
}

async function readBounded(response: Response, maxBytes: number, what: string): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) throw badRequest(`${what} returned an empty body`);
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => {});
      throw badRequest(`${what} returned more than MAX_SPEC_BYTES (${maxBytes}) bytes`);
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

function stringsOf(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return fallback;
  const items = value.filter((entry): entry is string => typeof entry === "string");
  return items.length > 0 ? items : fallback;
}

function asRecord(value: unknown): Record<string, unknown> {
  return isPlainObject(value) ? value : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
