import { parseDocument, XmlError, type XmlLimits, type XmlNode } from "../../shared/xml.ts";

/**
 * `transform.response: soap-to-json` (design section 5, deviation D21).
 *
 * Only the response direction exists. Turning JSON into a SOAP envelope means *generating* XML that
 * satisfies an XSD — choosing element order, namespace prefixes and lexical forms for every value —
 * which is a writer, not a reader, and a writer that gets any of that wrong produces an envelope
 * the backend rejects with an error the consumer cannot act on. Reading is the tractable direction,
 * so it is the one that ships.
 *
 * The conversion is deliberately boring, because a consumer has to be able to predict it from the
 * WSDL without running it:
 *
 *  - the result is the **body's first child**, not the envelope: `Envelope` and `Body` are transport
 *    framing, and a consumer who asked for JSON did not ask for SOAP's frame;
 *  - an element with only text becomes that text, as a **string** — never a guessed number or
 *    boolean, because `007`, `1e3` and a leading-zero postcode all survive a string round-trip and
 *    none of them survives a guess;
 *  - repeated sibling names become an array, and a name that appears once does not. This is the one
 *    genuinely lossy rule in the conversion: XML has no way to say "this list has one item", so a
 *    single-element list and a scalar are indistinguishable in the instance. The schema knows the
 *    difference; the document does not, and inventing an array from the schema here would mean
 *    carrying the compiled XSD into the transform for one edge case;
 *  - attributes are prefixed `@`, so they cannot collide with a child element of the same name;
 *  - `xsi:nil="true"` becomes `null`, which is the one type the instance really does declare.
 */

export interface TransformResult {
  ok: boolean;
  value?: unknown;
  error?: string;
}

const XSI = "http://www.w3.org/2001/XMLSchema-instance";
const SOAP_ENVELOPES = new Set([
  "http://schemas.xmlsoap.org/soap/envelope/",
  "http://www.w3.org/2003/05/soap-envelope",
]);

export function soapToJson(envelope: string, limits: Partial<XmlLimits> = {}): TransformResult {
  let root: XmlNode;
  try {
    root = parseDocument(envelope, limits);
  } catch (err) {
    // A backend that answered with something other than XML is not a transform failure worth
    // failing the request over: the caller gets the original bytes and the original content type.
    return { ok: false, error: err instanceof XmlError ? err.message : String((err as Error).message) };
  }

  if (!SOAP_ENVELOPES.has(root.ns) || root.local !== "Envelope") {
    return { ok: false, error: "the response is not a SOAP envelope" };
  }
  const body = root.children.find((child) => child.ns === root.ns && child.local === "Body");
  if (!body) return { ok: false, error: "the envelope has no Body" };

  const first = body.children[0];
  if (!first) return { ok: true, value: {} };
  return { ok: true, value: convert(first) };
}

function convert(node: XmlNode): unknown {
  if (node.nsAttributes[`{${XSI}}nil`] === "true") return null;

  const attributes = Object.entries(node.attributes).filter(([name]) => name !== "xmlns");
  const text = node.text.trim();

  if (node.children.length === 0) {
    if (attributes.length === 0) return text;
    const out: Record<string, unknown> = {};
    for (const [name, value] of attributes) out[`@${name}`] = value;
    if (text) out["#text"] = text;
    return out;
  }

  const out: Record<string, unknown> = {};
  for (const [name, value] of attributes) out[`@${name}`] = value;
  // Mixed content: the parser accumulates an element's own text separately from its children's, so
  // whatever text this element carries directly is kept rather than silently dropped.
  if (text) out["#text"] = text;

  const counts = new Map<string, number>();
  for (const child of node.children) counts.set(child.local, (counts.get(child.local) ?? 0) + 1);

  for (const child of node.children) {
    const value = convert(child);
    if ((counts.get(child.local) ?? 0) > 1) {
      const list = (out[child.local] as unknown[] | undefined) ?? [];
      list.push(value);
      out[child.local] = list;
    } else {
      out[child.local] = value;
    }
  }
  return out;
}
