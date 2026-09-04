/**
 * A deliberately restrictive XML reader, not a general parser.
 *
 * Design section 5.1's `always` block is enforced here and cannot be turned off by any policy:
 * DTDs, entity declarations, external entities and processing instructions other than the XML
 * declaration are **refused**, not expanded safely; depth, element count and input length are
 * bounded before and during parsing. This is the same call as v1's deviation D8 pattern linter —
 * the safe thing is refusing what we do not understand, because the alternative is a parser
 * whose hardening we would have to prove.
 *
 * Two entry points sit on one scanner: `parseDocument` for the control plane's WSDL import, and
 * `scanEnvelope` for the data plane's bounded prefix scan, which never builds a tree.
 */

export class XmlError extends Error {
  constructor(
    message: string,
    readonly offset: number,
  ) {
    super(message);
    this.name = "XmlError";
  }
}

export interface XmlLimits {
  maxBytes: number;
  maxDepth: number;
  maxElements: number;
}

export const XML_DEFAULT_LIMITS: XmlLimits = {
  maxBytes: 8 * 1024 * 1024,
  maxDepth: 32,
  maxElements: 100_000,
};

export interface StartTagEvent {
  /** Raw qualified name as written, e.g. `soap:Body`. */
  raw: string;
  prefix: string;
  local: string;
  /** Resolved namespace URI, `""` when the element is in no namespace. */
  ns: string;
  /** `{ns}local`, or `local` when there is no namespace. */
  qname: string;
  attributes: XmlAttribute[];
  /** Namespace declarations made *on this element*; `""` is the default namespace. */
  declarations: Record<string, string>;
  selfClosing: boolean;
  depth: number;
}

export interface XmlAttribute {
  prefix: string;
  local: string;
  ns: string;
  value: string;
}

export interface ScanHandlers {
  onStart?: (event: StartTagEvent) => void | "stop";
  /**
   * Only for elements that were opened and closed by separate tags. A self-closing element emits
   * one start event with `selfClosing: true` and no end event, so a consumer that maintains a
   * stack cannot pop something it never pushed.
   */
  onEnd?: (qname: string, depth: number) => void | "stop";
  onText?: (text: string, depth: number) => void | "stop";
}

const NAME_START = /[A-Za-z_]/;
const NAME_CHAR = /[A-Za-z0-9._:-]/;

export function qnameOf(ns: string, local: string): string {
  return ns ? `{${ns}}${local}` : local;
}

/** The five predefined entities. Everything else — including any declared entity — is refused. */
function decodeEntities(raw: string, offset: number): string {
  if (!raw.includes("&")) return raw;
  let out = "";
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!;
    if (ch !== "&") {
      out += ch;
      continue;
    }
    const end = raw.indexOf(";", i);
    if (end === -1) throw new XmlError("unterminated entity reference", offset + i);
    const name = raw.slice(i + 1, end);
    i = end;
    switch (name) {
      case "amp":
        out += "&";
        continue;
      case "lt":
        out += "<";
        continue;
      case "gt":
        out += ">";
        continue;
      case "quot":
        out += '"';
        continue;
      case "apos":
        out += "'";
        continue;
    }
    if (name.startsWith("#")) {
      const code = name[1] === "x" || name[1] === "X" ? parseInt(name.slice(2), 16) : Number(name.slice(1));
      if (!Number.isInteger(code) || code <= 0 || code > 0xffff) {
        throw new XmlError(
          `character reference &${name}; is out of the supported range (bounded to the BMP)`,
          offset + i,
        );
      }
      out += String.fromCharCode(code);
      continue;
    }
    throw new XmlError(
      `entity reference &${name}; is not allowed: only the five predefined entities and numeric ` +
        "character references are supported, and entity declarations are refused outright",
      offset + i,
    );
  }
  return out;
}

interface ScanOptions extends Partial<XmlLimits> {
  /** The data plane sees only the first N bytes of a body, so a cut-off tail is expected. */
  allowTruncated?: boolean;
}

/**
 * One pass over the document, emitting events. Returning `"stop"` from a handler ends the scan,
 * which is how the prefix scan stops as soon as it has what it needs.
 */
export function scan(input: string, handlers: ScanHandlers, options: ScanOptions = {}): void {
  const limits: XmlLimits = { ...XML_DEFAULT_LIMITS, ...options };
  if (input.length > limits.maxBytes) {
    throw new XmlError(`document longer than ${limits.maxBytes} bytes`, limits.maxBytes);
  }

  // prefix → uri, innermost last. `xml` is bound by specification and never declared.
  const nsStack: Array<Record<string, string>> = [{ xml: "http://www.w3.org/XML/1998/namespace" }];
  const openTags: string[] = [];
  let elements = 0;
  let i = 0;
  let sawDeclaration = false;
  let sawRoot = false;

  const resolve = (prefix: string, offset: number): string => {
    for (let s = nsStack.length - 1; s >= 0; s--) {
      const uri = nsStack[s]![prefix];
      if (uri !== undefined) return uri;
    }
    if (prefix === "") return "";
    throw new XmlError(`namespace prefix "${prefix}" is not declared`, offset);
  };

  const truncated = (): void => {
    if (!options.allowTruncated) throw new XmlError("unexpected end of document", input.length);
  };

  while (i < input.length) {
    const lt = input.indexOf("<", i);
    if (lt === -1) {
      const tail = input.slice(i);
      if (tail.trim() !== "" && handlers.onText) handlers.onText(decodeEntities(tail, i), openTags.length);
      return;
    }
    if (lt > i) {
      const text = input.slice(i, lt);
      if (text.trim() !== "" && handlers.onText) {
        if (handlers.onText(decodeEntities(text, i), openTags.length) === "stop") return;
      }
    }
    i = lt;

    // --- declarations, comments, CDATA, and everything we refuse
    if (input.startsWith("<?", i)) {
      const end = input.indexOf("?>", i);
      if (end === -1) return truncated();
      const target = input.slice(i + 2, end).trimStart();
      if (!target.startsWith("xml") || sawDeclaration || sawRoot) {
        throw new XmlError(
          "processing instructions are not allowed (only a leading XML declaration is)",
          i,
        );
      }
      sawDeclaration = true;
      i = end + 2;
      continue;
    }
    if (input.startsWith("<!--", i)) {
      const end = input.indexOf("-->", i);
      if (end === -1) return truncated();
      i = end + 3;
      continue;
    }
    if (input.startsWith("<![CDATA[", i)) {
      const end = input.indexOf("]]>", i);
      if (end === -1) return truncated();
      const text = input.slice(i + 9, end);
      if (handlers.onText && text !== "") {
        if (handlers.onText(text, openTags.length) === "stop") return;
      }
      i = end + 3;
      continue;
    }
    if (input.startsWith("<!", i)) {
      const kind = /^<!\s*([A-Za-z]+)/.exec(input.slice(i, i + 32))?.[1]?.toUpperCase() ?? "";
      throw new XmlError(
        `<!${kind}> is refused: DTDs, entity declarations and external entities are not ` +
          "processed at all (design section 5.1)",
        i,
      );
    }

    // --- end tag
    if (input.startsWith("</", i)) {
      const gt = input.indexOf(">", i);
      if (gt === -1) return truncated();
      const raw = input.slice(i + 2, gt).trim();
      const expected = openTags.pop();
      if (expected === undefined) throw new XmlError(`unexpected closing tag </${raw}>`, i);
      if (expected !== raw) {
        throw new XmlError(`closing tag </${raw}> does not match <${expected}>`, i);
      }
      // The end tag is *inside* the element's scope, so its prefix resolves against the
      // declarations the element itself made — which means resolving before popping them.
      // Popping first made `</xs:schema>` on an element that declared `xmlns:xs` unresolvable.
      let ended: string | null = null;
      if (handlers.onEnd) {
        const colon = raw.indexOf(":");
        const prefix = colon === -1 ? "" : raw.slice(0, colon);
        const local = colon === -1 ? raw : raw.slice(colon + 1);
        ended = qnameOf(resolve(prefix, i), local);
      }
      nsStack.pop();
      if (ended !== null && handlers.onEnd!(ended, openTags.length) === "stop") return;
      i = gt + 1;
      continue;
    }

    // --- start tag
    if (++elements > limits.maxElements) {
      throw new XmlError(`document has more than ${limits.maxElements} elements`, i);
    }
    let j = i + 1;
    if (j >= input.length) return truncated();
    if (!NAME_START.test(input[j]!)) throw new XmlError("expected an element name after <", i);
    while (j < input.length && NAME_CHAR.test(input[j]!)) j++;
    if (j >= input.length) return truncated();
    const raw = input.slice(i + 1, j);

    // attributes
    const declarations: Record<string, string> = {};
    const pending: Array<{ prefix: string; local: string; value: string; at: number }> = [];
    let selfClosing = false;
    let closed = false;
    while (j < input.length) {
      while (j < input.length && /\s/.test(input[j]!)) j++;
      if (j >= input.length) break;
      if (input[j] === ">") {
        closed = true;
        j++;
        break;
      }
      if (input.startsWith("/>", j)) {
        selfClosing = true;
        closed = true;
        j += 2;
        break;
      }
      const nameStart = j;
      while (j < input.length && NAME_CHAR.test(input[j]!)) j++;
      if (j === nameStart) throw new XmlError("expected an attribute name", j);
      const attrName = input.slice(nameStart, j);
      while (j < input.length && /\s/.test(input[j]!)) j++;
      if (input[j] !== "=") throw new XmlError(`attribute ${attrName} has no value`, j);
      j++;
      while (j < input.length && /\s/.test(input[j]!)) j++;
      const quote = input[j];
      if (quote !== '"' && quote !== "'") throw new XmlError("attribute values must be quoted", j);
      const valueStart = ++j;
      const valueEnd = input.indexOf(quote, valueStart);
      if (valueEnd === -1) break;
      const value = decodeEntities(input.slice(valueStart, valueEnd), valueStart);
      j = valueEnd + 1;

      if (attrName === "xmlns") declarations[""] = value;
      else if (attrName.startsWith("xmlns:")) declarations[attrName.slice(6)] = value;
      else {
        const colon = attrName.indexOf(":");
        pending.push({
          prefix: colon === -1 ? "" : attrName.slice(0, colon),
          local: colon === -1 ? attrName : attrName.slice(colon + 1),
          value,
          at: nameStart,
        });
      }
    }
    if (!closed) return truncated();

    nsStack.push(declarations);
    if (nsStack.length - 1 > limits.maxDepth) {
      throw new XmlError(`document nested deeper than ${limits.maxDepth} elements`, i);
    }

    const colon = raw.indexOf(":");
    const prefix = colon === -1 ? "" : raw.slice(0, colon);
    const local = colon === -1 ? raw : raw.slice(colon + 1);
    const ns = resolve(prefix, i);
    const attributes: XmlAttribute[] = pending.map((a) => ({
      prefix: a.prefix,
      local: a.local,
      // An unprefixed attribute is in no namespace, per the XML Namespaces specification.
      ns: a.prefix === "" ? "" : resolve(a.prefix, a.at),
      value: a.value,
    }));

    sawRoot = true;
    const event: StartTagEvent = {
      raw,
      prefix,
      local,
      ns,
      qname: qnameOf(ns, local),
      attributes,
      declarations,
      selfClosing,
      depth: openTags.length,
    };
    if (selfClosing) nsStack.pop();
    else openTags.push(raw);

    if (handlers.onStart && handlers.onStart(event) === "stop") return;
    i = j;
  }

  if (openTags.length > 0) truncated();
}

// ------------------------------------------------------------------ tree, for the control plane

export interface XmlNode {
  qname: string;
  ns: string;
  local: string;
  attributes: Record<string, string>;
  /** `{ns}local` → value, for the prefixed attributes that WSDL actually uses. */
  nsAttributes: Record<string, string>;
  /** Declarations made on this element; resolution walks up through `parent`. */
  declarations: Record<string, string>;
  parent: XmlNode | null;
  children: XmlNode[];
  text: string;
}

/**
 * WSDL is full of QName-valued *attributes* (`message="tns:GetPetIn"`), which resolve against
 * the prefixes in scope where they are written — so the tree keeps its declarations rather than
 * flattening them away at parse time.
 */
export function resolveQName(node: XmlNode, value: string): string {
  const colon = value.indexOf(":");
  const prefix = colon === -1 ? "" : value.slice(0, colon);
  const local = colon === -1 ? value : value.slice(colon + 1);
  for (let current: XmlNode | null = node; current; current = current.parent) {
    const uri = current.declarations[prefix];
    if (uri !== undefined) return qnameOf(uri, local);
  }
  if (prefix === "xml") return qnameOf("http://www.w3.org/XML/1998/namespace", local);
  return qnameOf("", local);
}

export function parseDocument(input: string, limits: Partial<XmlLimits> = {}): XmlNode {
  const root: XmlNode = {
    qname: "",
    ns: "",
    local: "",
    attributes: {},
    nsAttributes: {},
    declarations: {},
    parent: null,
    children: [],
    text: "",
  };
  const stack: XmlNode[] = [root];

  scan(
    input,
    {
      onStart(event) {
        const parent = stack[stack.length - 1]!;
        const node: XmlNode = {
          qname: event.qname,
          ns: event.ns,
          local: event.local,
          attributes: Object.fromEntries(event.attributes.filter((a) => a.prefix === "").map((a) => [a.local, a.value])),
          nsAttributes: Object.fromEntries(
            event.attributes.filter((a) => a.prefix !== "").map((a) => [qnameOf(a.ns, a.local), a.value]),
          ),
          declarations: event.declarations,
          parent,
          children: [],
          text: "",
        };
        parent.children.push(node);
        if (!event.selfClosing) stack.push(node);
      },
      onEnd() {
        if (stack.length > 1) stack.pop();
      },
      onText(text) {
        stack[stack.length - 1]!.text += text;
      },
    },
    limits,
  );

  const documentElement = root.children[0];
  if (!documentElement) throw new XmlError("the document has no root element", 0);
  return documentElement;
}

export function childrenNamed(node: XmlNode, ns: string, local: string): XmlNode[] {
  const target = qnameOf(ns, local);
  return node.children.filter((child) => child.qname === target);
}

export function childNamed(node: XmlNode, ns: string, local: string): XmlNode | null {
  return childrenNamed(node, ns, local)[0] ?? null;
}

// ------------------------------------------------------- bounded prefix scan, for the data plane

export const SOAP_11_ENVELOPE = "http://schemas.xmlsoap.org/soap/envelope/";
export const SOAP_12_ENVELOPE = "http://www.w3.org/2003/05/soap-envelope";

export interface EnvelopeScan {
  soapVersion: "1.1" | "1.2";
  /** `{ns}local` of the first child element of Body — the operation's identity. */
  bodyChild: string | null;
}

/**
 * Reads at most the prefix it is given and stops at the first child element of `Body`. It never
 * builds a tree, so a 5 MB envelope costs the same as an 8 KB one (design section 5.1's
 * "hardened, bounded prefix scan").
 */
export function scanEnvelope(prefix: string, limits: Partial<XmlLimits> = {}): EnvelopeScan {
  let soapVersion: "1.1" | "1.2" | null = null;
  let inBody = false;
  let bodyDepth = -1;
  let bodyChild: string | null = null;

  scan(
    prefix,
    {
      onStart(event) {
        if (event.depth === 0) {
          if (event.ns === SOAP_11_ENVELOPE) soapVersion = "1.1";
          else if (event.ns === SOAP_12_ENVELOPE) soapVersion = "1.2";
          else {
            throw new XmlError(
              `the root element is {${event.ns}}${event.local}, not a SOAP Envelope`,
              0,
            );
          }
          if (event.local !== "Envelope") {
            throw new XmlError(`expected a SOAP Envelope, found ${event.local}`, 0);
          }
          return;
        }
        if (!inBody && event.depth === 1 && event.local === "Body" && event.ns === (soapVersion === "1.2" ? SOAP_12_ENVELOPE : SOAP_11_ENVELOPE)) {
          inBody = true;
          bodyDepth = event.depth;
          return;
        }
        if (inBody && event.depth === bodyDepth + 1) {
          bodyChild = event.qname;
          return "stop";
        }
        return;
      },
    },
    { ...limits, allowTruncated: true },
  );

  if (soapVersion === null) throw new XmlError("no SOAP Envelope found in the scanned prefix", 0);
  return { soapVersion, bodyChild };
}
