// WSDL parser used by the Publish wizard. Browser-side only (uses
// `DOMParser` for XML). Pulled out of `specValidate.ts` because the
// OpenAPI lint pipeline and the WSDL parser have nothing meaningful in
// common — same wizard, different semantic worlds.
//
// Outputs the small subset of WSDL the portal actually surfaces in UI:
//   - Service name + port (endpoint) names — needed for APIM's
//     `wsdlSelector: { wsdlServiceName, wsdlEndpointName }` selector
//   - The first SOAP address (if any) — seeds the Backend URL field
//   - Best-effort title + description for auto-fill
//   - Unsupported `wsdl:import` / `xsd:import` / `xsd:include` directives
//     so we can warn — APIM rejects WSDLs that carry them, and there is
//     no portal-side merge tool today

const WSDL_NS = 'http://schemas.xmlsoap.org/wsdl/';
const SOAP_NS = 'http://schemas.xmlsoap.org/wsdl/soap/';
const SOAP12_NS = 'http://schemas.xmlsoap.org/wsdl/soap12/';
const XSD_NS = 'http://www.w3.org/2001/XMLSchema';

export interface WsdlServiceInfo {
  /** Value of the <wsdl:service name="X"> attribute. */
  name: string;
  /** Names of every <wsdl:port name="Y"> child of the service. */
  endpoints: string[];
}

export interface WsdlOperationInfo {
  /** Value of the <wsdl:operation name="X"> attribute under <wsdl:portType>. */
  name: string;
  /**
   * SOAPAction value from the matching <wsdl:binding><wsdl:operation>
   * <soap:operation soapAction="..."/>. Optional — bindings can omit it,
   * and document-style WSDLs frequently set it to the empty string.
   * Useful as a sub-line in the UI so consumers know which SOAPAction
   * header their client needs to send.
   */
  soapAction?: string;
  /** `tns:`-prefixed message names from the operation's <input>/<output>. */
  inputMessage?: string;
  outputMessage?: string;
}

export interface WsdlImportNotice {
  kind: 'wsdl-import' | 'xsd-import' | 'xsd-include';
  /** `location` for wsdl:import, `schemaLocation` for xsd:import / xsd:include. */
  location?: string;
}

export interface WsdlParseResult {
  ok: boolean;
  /** Parser error message when ok=false. */
  error?: string;
  /** Best-effort line/column when the XML parser surfaces them in its message. */
  errorLine?: number;
  errorColumn?: number;
  /**
   * Best-effort title — taken from <wsdl:definitions name="X"> when set, falling
   * back to the first <wsdl:service name="X">. Either may be missing.
   */
  title?: string;
  /** Stripped text content of the first <wsdl:documentation> child of definitions. */
  description?: string;
  /**
   * `location` attribute of the first <soap:address> / <soap12:address> seen.
   * The wizard uses this to seed the Backend URL field — usually the user
   * wants to point APIM at their actual backend, not at the WSDL's published
   * service URL, so it's only a default they can override.
   */
  defaultServiceUrl?: string;
  /** One entry per <wsdl:service> root element. */
  services: WsdlServiceInfo[];
  /**
   * Flat list of operations across every <wsdl:portType> in the
   * document. APIM creates one APIM operation resource per WSDL
   * operation during import (visible as `POST <opName>` in the
   * APIM portal's Design tab) so surfacing the same list here
   * gives the publish wizard + the consumer detail modal an
   * operation enumeration that matches the APIM source-of-truth.
   * Empty when the document declares no portTypes (rare but legal).
   */
  operations: WsdlOperationInfo[];
  /** Unsupported import directives APIM will reject. Empty when clean. */
  imports: WsdlImportNotice[];
}

/**
 * Cheap content-sniff: does this text look like a WSDL document? Used to
 * dispatch between the OpenAPI/Swagger parser and the WSDL parser without
 * paying the full XML-parse cost on every keystroke. We only sample the
 * first ~1 KB so a multi-megabyte WSDL doesn't slow the regex.
 */
export function looksLikeWsdl(text: string): boolean {
  const head = text.trim().slice(0, 1024);
  if (!head.startsWith('<')) return false;
  if (/xmlns(?::[a-z0-9_-]+)?=["']http:\/\/schemas\.xmlsoap\.org\/wsdl\//i.test(head)) return true;
  if (/<(?:[a-z0-9_-]+:)?definitions[\s>]/i.test(head)) return true;
  return false;
}

function parseLineCol(message: string): { line?: number; column?: number } {
  const m = /line\s*(?:number)?:?\s*(\d+).*?column\s*:?\s*(\d+)/i.exec(message);
  if (!m) return {};
  return { line: Number(m[1]), column: Number(m[2]) };
}

/**
 * Pretty-print an XML / WSDL document by parsing it with DOMParser and
 * re-serialising with indentation. APIM stores WSDLs as a single line
 * (no whitespace) — the editor displays them unchanged unless we run
 * them through this helper. WSDL is element-element structure with no
 * meaningful mixed content, so naive whitespace insertion is safe; the
 * one place we preserve text content verbatim is on leaf elements that
 * carry non-whitespace text (e.g. `<wsdl:documentation>`), to avoid
 * collapsing user-authored documentation strings.
 *
 * Returns the original text unchanged when parsing fails — better to
 * show the raw bytes than to silently drop them.
 */
export function prettyPrintWsdl(text: string): string {
  if (!text || !text.trim()) return text;
  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(text, 'application/xml');
  } catch {
    return text;
  }
  if (doc.getElementsByTagName('parsererror').length > 0) return text;
  const root = doc.documentElement;
  if (!root) return text;

  const INDENT = '  ';
  const sb: string[] = [];
  const xmlDecl = /^\s*<\?xml[^?]*\?>/i.exec(text);
  if (xmlDecl) sb.push(xmlDecl[0].trim(), '\n');

  function escapeAttr(v: string): string {
    return v.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
  }
  function escapeText(v: string): string {
    return v.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  }
  function serialiseAttrs(el: Element): string {
    const attrs = Array.from(el.attributes);
    if (attrs.length === 0) return '';
    return ' ' + attrs.map(a => `${a.name}="${escapeAttr(a.value)}"`).join(' ');
  }
  function isInlineLeaf(el: Element): { inline: boolean; text?: string } {
    // Only one child, a non-whitespace text node, and no element children
    // → render as `<tag>text</tag>` on a single line.
    if (el.children.length > 0) return { inline: false };
    const text = el.textContent ?? '';
    if (!text.trim()) return { inline: true, text: '' };
    return { inline: true, text };
  }
  function emit(el: Element, depth: number): void {
    const pad = INDENT.repeat(depth);
    const tag = el.tagName;
    const attrs = serialiseAttrs(el);
    const leaf = isInlineLeaf(el);
    if (leaf.inline) {
      if (leaf.text === '') {
        sb.push(pad, `<${tag}${attrs}/>`, '\n');
      } else {
        sb.push(pad, `<${tag}${attrs}>`, escapeText(leaf.text!), `</${tag}>`, '\n');
      }
      return;
    }
    sb.push(pad, `<${tag}${attrs}>`, '\n');
    for (let i = 0; i < el.childNodes.length; i++) {
      const node = el.childNodes[i]!;
      if (node.nodeType === 1 /* ELEMENT_NODE */) {
        emit(node as Element, depth + 1);
      } else if (node.nodeType === 8 /* COMMENT_NODE */) {
        const c = (node.nodeValue ?? '').trim();
        if (c) sb.push(INDENT.repeat(depth + 1), `<!-- ${c} -->`, '\n');
      } else if (node.nodeType === 4 /* CDATA_SECTION_NODE */) {
        sb.push(INDENT.repeat(depth + 1), `<![CDATA[${node.nodeValue ?? ''}]]>`, '\n');
      }
      // Skip text nodes between elements — they're insignificant whitespace.
    }
    sb.push(pad, `</${tag}>`, '\n');
  }
  emit(root, 0);
  return sb.join('').replace(/\n+$/, '\n').trimEnd();
}

export function parseWsdl(text: string): WsdlParseResult {
  if (!text.trim()) {
    return { ok: false, error: 'Empty WSDL document.', services: [], operations: [], imports: [] };
  }
  // Browser DOMParser exposes XML errors as a `<parsererror>` element
  // inside the returned Document instead of throwing — we have to look
  // for it explicitly. The error text itself is non-standard across
  // engines (Firefox vs Chromium) but always includes the offending
  // location, which we forward as-is.
  let doc: Document;
  try {
    const parser = new DOMParser();
    doc = parser.parseFromString(text, 'application/xml');
  } catch (err) {
    const message = err instanceof Error ? err.message : 'XML parse error';
    return { ok: false, error: message, services: [], operations: [], imports: [] };
  }
  const parserError = doc.getElementsByTagName('parsererror')[0];
  if (parserError) {
    const message = (parserError.textContent ?? 'XML parse error').trim().split('\n')[0] ?? 'XML parse error';
    const { line, column } = parseLineCol(message);
    return { ok: false, error: message, errorLine: line, errorColumn: column, services: [], operations: [], imports: [] };
  }

  const definitions = doc.getElementsByTagNameNS(WSDL_NS, 'definitions')[0];
  if (!definitions) {
    return {
      ok: false,
      error: 'No <wsdl:definitions> root element found. The document is XML but not WSDL.',
      services: [],
      operations: [],
      imports: [],
    };
  }

  // Service + port enumeration
  const services: WsdlServiceInfo[] = [];
  const serviceNodes = definitions.getElementsByTagNameNS(WSDL_NS, 'service');
  for (let i = 0; i < serviceNodes.length; i++) {
    const svc = serviceNodes[i]!;
    const serviceName = svc.getAttribute('name') ?? `service-${i + 1}`;
    const portNodes = svc.getElementsByTagNameNS(WSDL_NS, 'port');
    const endpoints: string[] = [];
    for (let j = 0; j < portNodes.length; j++) {
      const portName = portNodes[j]!.getAttribute('name');
      if (portName) endpoints.push(portName);
    }
    services.push({ name: serviceName, endpoints });
  }

  // Operation enumeration. Walk every <wsdl:portType> and collect
  // its <wsdl:operation> children, then enrich each with the
  // soapAction declared in the matching <wsdl:binding> (where the
  // SOAP-specific extension lives — portType is transport-agnostic).
  // We key the join by operation name within a binding/portType pair,
  // which is unambiguous in practice: WSDL forbids duplicate
  // operation names inside a single portType. If two portTypes
  // happen to share an operation name with different soapActions
  // (legal but vanishingly rare), the lookup falls back to the first
  // soapAction we found — better than nothing, and the operation
  // name + input/output messages are still distinct.
  const soapActionByOp = new Map<string, string>();
  const bindingNodes = definitions.getElementsByTagNameNS(WSDL_NS, 'binding');
  for (let i = 0; i < bindingNodes.length; i++) {
    const opNodes = bindingNodes[i]!.getElementsByTagNameNS(WSDL_NS, 'operation');
    for (let j = 0; j < opNodes.length; j++) {
      const op = opNodes[j]!;
      const name = op.getAttribute('name');
      if (!name) continue;
      for (const ns of [SOAP_NS, SOAP12_NS]) {
        const soapOp = op.getElementsByTagNameNS(ns, 'operation')[0];
        if (soapOp) {
          const action = soapOp.getAttribute('soapAction');
          if (action !== null && !soapActionByOp.has(name)) {
            soapActionByOp.set(name, action);
          }
          break;
        }
      }
    }
  }
  const operations: WsdlOperationInfo[] = [];
  const seenOpNames = new Set<string>();
  const portTypeNodes = definitions.getElementsByTagNameNS(WSDL_NS, 'portType');
  for (let i = 0; i < portTypeNodes.length; i++) {
    const opNodes = portTypeNodes[i]!.getElementsByTagNameNS(WSDL_NS, 'operation');
    for (let j = 0; j < opNodes.length; j++) {
      const op = opNodes[j]!;
      const name = op.getAttribute('name');
      if (!name) continue;
      // Dedup across portTypes — if the same operation name is defined
      // in two portTypes (multi-binding WSDLs), surfacing both as
      // separate rows would just clutter the UI. APIM also dedups.
      if (seenOpNames.has(name)) continue;
      seenOpNames.add(name);
      const inputNode = op.getElementsByTagNameNS(WSDL_NS, 'input')[0];
      const outputNode = op.getElementsByTagNameNS(WSDL_NS, 'output')[0];
      operations.push({
        name,
        soapAction: soapActionByOp.get(name) || undefined,
        inputMessage: inputNode?.getAttribute('message') ?? undefined,
        outputMessage: outputNode?.getAttribute('message') ?? undefined,
      });
    }
  }

  // Default backend URL — first SOAP 1.1 or 1.2 address found anywhere
  // in the document. Only a hint; users can override.
  let defaultServiceUrl: string | undefined;
  for (const ns of [SOAP_NS, SOAP12_NS]) {
    const addresses = definitions.getElementsByTagNameNS(ns, 'address');
    if (addresses.length > 0) {
      const loc = addresses[0]!.getAttribute('location');
      if (loc) { defaultServiceUrl = loc; break; }
    }
  }

  // Unsupported imports
  const imports: WsdlImportNotice[] = [];
  const collect = (ns: string, tag: string, kind: WsdlImportNotice['kind'], locAttr: string) => {
    const nodes = definitions.getElementsByTagNameNS(ns, tag);
    for (let i = 0; i < nodes.length; i++) {
      imports.push({ kind, location: nodes[i]!.getAttribute(locAttr) ?? undefined });
    }
  };
  collect(WSDL_NS, 'import', 'wsdl-import', 'location');
  collect(XSD_NS, 'import', 'xsd-import', 'schemaLocation');
  collect(XSD_NS, 'include', 'xsd-include', 'schemaLocation');

  const title = definitions.getAttribute('name') ?? services[0]?.name ?? undefined;
  const docElements = definitions.getElementsByTagNameNS(WSDL_NS, 'documentation');
  let description: string | undefined;
  if (docElements.length > 0) {
    const raw = docElements[0]!.textContent ?? '';
    const trimmed = raw.trim();
    if (trimmed.length > 0) description = trimmed;
  }

  return {
    ok: true,
    title,
    description,
    defaultServiceUrl,
    services,
    operations,
    imports,
  };
}
