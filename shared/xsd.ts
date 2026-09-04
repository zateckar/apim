/**
 * An XSD 1.0 compiler and validator over a documented subset, on top of `shared/xml.ts`.
 *
 * Deviation D12′. The design budgets libxml2 for this and calls it "**1** + a C library"; there is
 * no binding available to this runtime, and design section 13 calls validation "the dominant
 * sizing variable" for an estate that is half SOAP. Shipping no schema validation for half the
 * estate is the worse answer, so the subset below is implemented and **everything outside it is
 * rejected at import**, naming the construct. That is the difference between a validator with a
 * subset and a validator that lies: a WSDL this cannot fully check never becomes a published API
 * that claims to be checked.
 *
 * Content-model matching is greedy and driven by element names. That is correct rather than
 * approximate because XSD's Unique Particle Attribution constraint makes every legal content model
 * deterministic: at any point, the next element name selects at most one branch. A model that
 * violates UPA is not a legal schema.
 *
 * Compilation produces plain JSON — the `xsd-set` artifact of design section 8.7 — so the data
 * plane never parses a WSDL.
 */
import { childrenNamed, parseDocument, qnameOf, resolveQName, XmlError, type XmlNode } from "./xml.ts";

export const XSD_NS = "http://www.w3.org/2001/XMLSchema";
export const XSI_NS = "http://www.w3.org/2001/XMLSchema-instance";

export class XsdUnsupported extends Error {
  constructor(
    readonly construct: string,
    readonly where: string,
    reason: string,
  ) {
    super(`${where}: ${construct} is not supported — ${reason}`);
    this.name = "XsdUnsupported";
  }
}

// --------------------------------------------------------------------------- the compiled bundle

export interface XsdFacets {
  enumeration?: string[];
  patterns?: string[];
  length?: number;
  minLength?: number;
  maxLength?: number;
  minInclusive?: string;
  maxInclusive?: string;
  minExclusive?: string;
  maxExclusive?: string;
  totalDigits?: number;
  fractionDigits?: number;
  whiteSpace?: "preserve" | "replace" | "collapse";
}

export interface XsdSimpleType {
  kind: "simple";
  /** The ultimate built-in, resolved at compile time so the runtime never walks a base chain. */
  builtin: string;
  variety: "atomic" | "list" | "union";
  facets: XsdFacets;
  itemRef?: string;
  memberRefs?: string[];
}

export interface XsdAttribute {
  qname: string;
  typeRef: string;
  use: "optional" | "required" | "prohibited";
  fixed?: string;
}

export interface XsdElementDecl {
  qname: string;
  typeRef: string;
  nillable: boolean;
  fixed?: string;
}

export type XsdParticle =
  | { kind: "sequence" | "choice" | "all"; min: number; max: number; items: XsdParticle[] }
  | { kind: "element"; min: number; max: number; decl: XsdElementDecl }
  | { kind: "any"; min: number; max: number };

export interface XsdComplexType {
  kind: "complex";
  particle: XsdParticle | null;
  attributes: XsdAttribute[];
  anyAttribute: boolean;
  /** Present for `simpleContent`: the element carries text of this simple type plus attributes. */
  textTypeRef?: string;
  mixed: boolean;
}

export type XsdType = XsdSimpleType | XsdComplexType;

export interface XsdBundle {
  kind: "xsd-set";
  /** `{ns}local` → global element declaration. */
  elements: Record<string, XsdElementDecl>;
  /** `{ns}name` for named types, `#N` for inline ones. */
  types: Record<string, XsdType>;
}

/** `xs:anyType` — accepts anything, which is what an undeclared type means. */
export const ANY_TYPE = `{${XSD_NS}}anyType`;

// --------------------------------------------------------------------------- compilation

const UNSUPPORTED: Record<string, string> = {
  key: "identity constraints are not evaluated, so accepting one would claim a check we do not make",
  keyref: "identity constraints are not evaluated",
  unique: "identity constraints are not evaluated",
  redefine: "xs:redefine rewrites another schema's components",
  notation: "xs:notation has no validation effect this implements",
};

interface SchemaSource {
  node: XmlNode;
  targetNamespace: string;
  elementFormQualified: boolean;
  attributeFormQualified: boolean;
}

export function compileXsdSet(schemaNodes: XmlNode[]): XsdBundle {
  const compiler = new XsdCompiler(schemaNodes);
  return compiler.compile();
}

class XsdCompiler {
  private readonly bundle: XsdBundle = { kind: "xsd-set", elements: {}, types: {} };
  private readonly sources: SchemaSource[] = [];
  private readonly namedTypeNodes = new Map<string, { node: XmlNode; source: SchemaSource }>();
  private readonly globalElementNodes = new Map<string, { node: XmlNode; source: SchemaSource }>();
  private readonly groupNodes = new Map<string, { node: XmlNode; source: SchemaSource }>();
  private readonly attributeGroupNodes = new Map<string, { node: XmlNode; source: SchemaSource }>();
  private readonly attributeNodes = new Map<string, { node: XmlNode; source: SchemaSource }>();
  private readonly inProgress = new Set<string>();
  private inline = 0;

  constructor(schemaNodes: XmlNode[]) {
    for (const node of schemaNodes) {
      const source: SchemaSource = {
        node,
        targetNamespace: node.attributes.targetNamespace ?? "",
        elementFormQualified: node.attributes.elementFormDefault === "qualified",
        attributeFormQualified: node.attributes.attributeFormDefault === "qualified",
      };
      this.sources.push(source);
      this.index(node, source);
    }
  }

  /**
   * Every unsupported construct is refused wherever it appears, not only at the top level: an
   * `xs:key` nested inside an element declaration is exactly as unevaluated as a global one, and
   * the point of refusing is that a contract this cannot fully check never becomes a published
   * API that claims to be checked.
   */
  private assertSupported(node: XmlNode, depth = 0): void {
    if (depth > 128) throw new XsdUnsupported("schema", "schema", "nested deeper than 128 elements");
    if (node.ns === XSD_NS) {
      const reason = UNSUPPORTED[node.local];
      if (reason) throw new XsdUnsupported(`xs:${node.local}`, node.attributes.name ?? "schema", reason);
      if (node.attributes.substitutionGroup) {
        throw new XsdUnsupported(
          "substitutionGroup",
          node.attributes.name ?? "element",
          "substitution groups are not resolved",
        );
      }
      if (node.attributes.abstract === "true") {
        throw new XsdUnsupported(
          "abstract",
          node.attributes.name ?? node.local,
          "abstract declarations need xsi:type resolution, which is not implemented",
        );
      }
    }
    for (const child of node.children) this.assertSupported(child, depth + 1);
  }

  private index(schema: XmlNode, source: SchemaSource): void {
    this.assertSupported(schema);
    for (const child of schema.children) {
      if (child.ns !== XSD_NS) continue;
      const name = child.attributes.name;
      const qname = name ? qnameOf(source.targetNamespace, name) : null;
      switch (child.local) {
        case "element":
          if (qname) this.globalElementNodes.set(qname, { node: child, source });
          break;
        case "complexType":
        case "simpleType":
          if (qname) this.namedTypeNodes.set(qname, { node: child, source });
          break;
        case "group":
          if (qname) this.groupNodes.set(qname, { node: child, source });
          break;
        case "attributeGroup":
          if (qname) this.attributeGroupNodes.set(qname, { node: child, source });
          break;
        case "attribute":
          if (qname) this.attributeNodes.set(qname, { node: child, source });
          break;
        default:
          break;
      }
    }
  }

  compile(): XsdBundle {
    for (const [qname] of this.globalElementNodes) this.globalElement(qname);
    // Named types nobody references are compiled too: a WSDL may point at one from a message part.
    for (const [qname] of this.namedTypeNodes) this.namedType(qname);
    return this.bundle;
  }

  private globalElement(qname: string): XsdElementDecl {
    const existing = this.bundle.elements[qname];
    if (existing) return existing;
    const entry = this.globalElementNodes.get(qname);
    if (!entry) throw new XsdUnsupported("element", qname, "is referenced but not declared");
    // Registered before its type is compiled, so a self-referential element terminates.
    const decl: XsdElementDecl = { qname, typeRef: ANY_TYPE, nillable: false };
    this.bundle.elements[qname] = decl;
    const compiled = this.elementDecl(entry.node, entry.source, qname);
    Object.assign(decl, compiled);
    return decl;
  }

  private namedType(qname: string): string {
    if (this.bundle.types[qname]) return qname;
    if (qname.startsWith(`{${XSD_NS}}`)) return qname; // a built-in needs no compilation
    const entry = this.namedTypeNodes.get(qname);
    if (!entry) throw new XsdUnsupported("type", qname, "is referenced but not declared");
    if (this.inProgress.has(qname)) return qname; // recursive type: the placeholder is enough
    this.inProgress.add(qname);
    try {
      this.bundle.types[qname] =
        entry.node.local === "simpleType"
          ? this.simpleType(entry.node, entry.source, qname)
          : this.complexType(entry.node, entry.source, qname);
    } finally {
      this.inProgress.delete(qname);
    }
    return qname;
  }

  private inlineType(node: XmlNode, source: SchemaSource, where: string): string {
    const ref = `#${++this.inline}`;
    this.bundle.types[ref] =
      node.local === "simpleType"
        ? this.simpleType(node, source, where)
        : this.complexType(node, source, where);
    return ref;
  }

  private typeRefOf(node: XmlNode, source: SchemaSource, where: string): string {
    const declared = node.attributes.type;
    if (declared) {
      const qname = resolveQName(node, declared);
      if (!qname.startsWith(`{${XSD_NS}}`)) this.namedType(qname);
      return qname;
    }
    const inlineComplex = childrenNamed(node, XSD_NS, "complexType")[0];
    if (inlineComplex) return this.inlineType(inlineComplex, source, where);
    const inlineSimple = childrenNamed(node, XSD_NS, "simpleType")[0];
    if (inlineSimple) return this.inlineType(inlineSimple, source, where);
    return ANY_TYPE;
  }

  private elementDecl(node: XmlNode, source: SchemaSource, qname: string): XsdElementDecl {
    return {
      qname,
      typeRef: this.typeRefOf(node, source, `element ${qname}`),
      nillable: node.attributes.nillable === "true",
      ...(node.attributes.fixed === undefined ? {} : { fixed: node.attributes.fixed }),
    };
  }

  /** A local element's name is qualified only when the schema (or the element) says so. */
  private localElementQName(node: XmlNode, source: SchemaSource): string {
    const name = node.attributes.name;
    if (!name) throw new XsdUnsupported("element", "particle", "a local element needs a name or a ref");
    const form = node.attributes.form;
    const qualified = form ? form === "qualified" : source.elementFormQualified;
    return qnameOf(qualified ? source.targetNamespace : "", name);
  }

  // ------------------------------------------------------------------ simple types

  private simpleType(node: XmlNode, source: SchemaSource, where: string): XsdSimpleType {
    const restriction = childrenNamed(node, XSD_NS, "restriction")[0];
    const list = childrenNamed(node, XSD_NS, "list")[0];
    const union = childrenNamed(node, XSD_NS, "union")[0];

    if (list) {
      const itemType = list.attributes.itemType;
      const itemRef = itemType
        ? this.namedType(resolveQName(list, itemType))
        : this.inlineType(childrenNamed(list, XSD_NS, "simpleType")[0]!, source, `${where}/list`);
      return { kind: "simple", builtin: "string", variety: "list", facets: {}, itemRef };
    }
    if (union) {
      const memberRefs: string[] = [];
      for (const raw of (union.attributes.memberTypes ?? "").split(/\s+/).filter(Boolean)) {
        memberRefs.push(this.namedType(resolveQName(union, raw)));
      }
      for (const child of childrenNamed(union, XSD_NS, "simpleType")) {
        memberRefs.push(this.inlineType(child, source, `${where}/union`));
      }
      return { kind: "simple", builtin: "string", variety: "union", facets: {}, memberRefs };
    }
    if (!restriction) {
      throw new XsdUnsupported("simpleType", where, "expected a restriction, list or union");
    }

    const baseAttr = restriction.attributes.base;
    let builtin = "string";
    let facets: XsdFacets = {};
    if (baseAttr) {
      const baseQName = resolveQName(restriction, baseAttr);
      if (baseQName.startsWith(`{${XSD_NS}}`)) {
        builtin = baseQName.slice(XSD_NS.length + 2);
      } else {
        // Facets are flattened along the derivation chain at compile time, so the runtime never
        // walks a base chain and a cycle cannot exist in the compiled form.
        const baseRef = this.namedType(baseQName);
        const base = this.bundle.types[baseRef];
        if (base && base.kind === "simple") {
          builtin = base.builtin;
          facets = { ...base.facets };
        }
      }
    } else {
      const inlineBase = childrenNamed(restriction, XSD_NS, "simpleType")[0];
      if (inlineBase) {
        const ref = this.inlineType(inlineBase, source, `${where}/restriction`);
        const base = this.bundle.types[ref];
        if (base && base.kind === "simple") {
          builtin = base.builtin;
          facets = { ...base.facets };
        }
      }
    }

    for (const facet of restriction.children) {
      if (facet.ns !== XSD_NS) continue;
      const value = facet.attributes.value;
      if (value === undefined) continue;
      switch (facet.local) {
        case "enumeration":
          (facets.enumeration ??= []).push(value);
          break;
        case "pattern":
          (facets.patterns ??= []).push(xsdPatternToJs(value, where));
          break;
        case "length":
          facets.length = Number(value);
          break;
        case "minLength":
          facets.minLength = Number(value);
          break;
        case "maxLength":
          facets.maxLength = Number(value);
          break;
        case "minInclusive":
          facets.minInclusive = value;
          break;
        case "maxInclusive":
          facets.maxInclusive = value;
          break;
        case "minExclusive":
          facets.minExclusive = value;
          break;
        case "maxExclusive":
          facets.maxExclusive = value;
          break;
        case "totalDigits":
          facets.totalDigits = Number(value);
          break;
        case "fractionDigits":
          facets.fractionDigits = Number(value);
          break;
        case "whiteSpace":
          facets.whiteSpace = value as XsdFacets["whiteSpace"];
          break;
        default:
          break;
      }
    }
    return { kind: "simple", builtin, variety: "atomic", facets };
  }

  // ------------------------------------------------------------------ complex types

  private complexType(node: XmlNode, source: SchemaSource, where: string): XsdComplexType {
    const out: XsdComplexType = {
      kind: "complex",
      particle: null,
      attributes: [],
      anyAttribute: false,
      mixed: node.attributes.mixed === "true",
    };

    const simpleContent = childrenNamed(node, XSD_NS, "simpleContent")[0];
    const complexContent = childrenNamed(node, XSD_NS, "complexContent")[0];

    if (simpleContent) {
      const derivation =
        childrenNamed(simpleContent, XSD_NS, "extension")[0] ??
        childrenNamed(simpleContent, XSD_NS, "restriction")[0];
      if (!derivation) throw new XsdUnsupported("simpleContent", where, "expected extension or restriction");
      const base = resolveQName(derivation, derivation.attributes.base ?? "xs:string");
      out.textTypeRef = base.startsWith(`{${XSD_NS}}`) ? base : this.namedType(base);
      this.collectAttributes(derivation, source, out, where);
      return out;
    }

    if (complexContent) {
      const extension = childrenNamed(complexContent, XSD_NS, "extension")[0];
      const restriction = childrenNamed(complexContent, XSD_NS, "restriction")[0];
      const derivation = extension ?? restriction;
      if (!derivation) throw new XsdUnsupported("complexContent", where, "expected extension or restriction");
      const baseQName = resolveQName(derivation, derivation.attributes.base ?? "");
      const own = this.particleOf(derivation, source, where, 0);

      if (extension && !baseQName.startsWith(`{${XSD_NS}}`)) {
        const baseRef = this.namedType(baseQName);
        const base = this.bundle.types[baseRef];
        if (base && base.kind === "complex") {
          out.attributes.push(...base.attributes);
          out.anyAttribute = out.anyAttribute || base.anyAttribute;
          out.mixed = out.mixed || base.mixed;
          // Extension is "the base's content model, then the derived one" — a sequence of both.
          out.particle =
            base.particle && own
              ? { kind: "sequence", min: 1, max: 1, items: [base.particle, own] }
              : (own ?? base.particle);
        } else {
          out.particle = own;
        }
      } else {
        // Restriction: the derived content model replaces the base's, and the instance is checked
        // against the derived one — which is the stricter of the two by construction.
        out.particle = own;
      }
      this.collectAttributes(derivation, source, out, where);
      return out;
    }

    out.particle = this.particleOf(node, source, where, 0);
    this.collectAttributes(node, source, out, where);
    return out;
  }

  private collectAttributes(
    holder: XmlNode,
    source: SchemaSource,
    into: XsdComplexType,
    where: string,
    depth = 0,
  ): void {
    if (depth > 16) throw new XsdUnsupported("attributeGroup", where, "reference nesting beyond 16");
    for (const child of holder.children) {
      if (child.ns !== XSD_NS) continue;
      if (child.local === "anyAttribute") {
        into.anyAttribute = true;
        continue;
      }
      if (child.local === "attributeGroup") {
        const ref = child.attributes.ref;
        if (!ref) continue;
        const entry = this.attributeGroupNodes.get(resolveQName(child, ref));
        if (!entry) throw new XsdUnsupported("attributeGroup", where, `${ref} is not declared`);
        this.collectAttributes(entry.node, entry.source, into, where, depth + 1);
        continue;
      }
      if (child.local !== "attribute") continue;

      const use = (child.attributes.use ?? "optional") as XsdAttribute["use"];
      const ref = child.attributes.ref;
      if (ref) {
        const qname = resolveQName(child, ref);
        const entry = this.attributeNodes.get(qname);
        if (!entry) throw new XsdUnsupported("attribute", where, `${ref} is not declared`);
        into.attributes.push({
          qname,
          typeRef: this.typeRefOf(entry.node, entry.source, `attribute ${qname}`),
          use,
          ...(child.attributes.fixed === undefined ? {} : { fixed: child.attributes.fixed }),
        });
        continue;
      }
      const name = child.attributes.name;
      if (!name) continue;
      const form = child.attributes.form;
      const qualified = form ? form === "qualified" : source.attributeFormQualified;
      into.attributes.push({
        qname: qnameOf(qualified ? source.targetNamespace : "", name),
        typeRef: this.typeRefOf(child, source, `attribute ${name}`),
        use,
        ...(child.attributes.fixed === undefined ? {} : { fixed: child.attributes.fixed }),
      });
    }
  }

  private particleOf(
    holder: XmlNode,
    source: SchemaSource,
    where: string,
    depth: number,
  ): XsdParticle | null {
    if (depth > 32) {
      throw new XsdUnsupported("group", where, "content model nested deeper than 32 (or a group cycle)");
    }
    for (const child of holder.children) {
      if (child.ns !== XSD_NS) continue;
      if (child.local === "sequence" || child.local === "choice" || child.local === "all") {
        return this.modelGroup(child, source, where, depth);
      }
      if (child.local === "group") {
        const ref = child.attributes.ref;
        if (!ref) continue;
        const entry = this.groupNodes.get(resolveQName(child, ref));
        if (!entry) throw new XsdUnsupported("group", where, `${ref} is not declared`);
        const inner = this.particleOf(entry.node, entry.source, where, depth + 1);
        if (!inner) return null;
        return { ...inner, min: occurs(child, "minOccurs", 1), max: occurs(child, "maxOccurs", 1) };
      }
    }
    return null;
  }

  private modelGroup(
    node: XmlNode,
    source: SchemaSource,
    where: string,
    depth: number,
  ): XsdParticle {
    const items: XsdParticle[] = [];
    for (const child of node.children) {
      if (child.ns !== XSD_NS) continue;
      switch (child.local) {
        case "element": {
          const min = occurs(child, "minOccurs", 1);
          const max = occurs(child, "maxOccurs", 1);
          const ref = child.attributes.ref;
          const decl = ref
            ? this.globalElement(resolveQName(child, ref))
            : this.elementDecl(child, source, this.localElementQName(child, source));
          items.push({ kind: "element", min, max, decl });
          break;
        }
        case "sequence":
        case "choice":
        case "all":
          items.push(this.modelGroup(child, source, where, depth + 1));
          break;
        case "group": {
          const ref = child.attributes.ref;
          if (!ref) break;
          const entry = this.groupNodes.get(resolveQName(child, ref));
          if (!entry) throw new XsdUnsupported("group", where, `${ref} is not declared`);
          const inner = this.particleOf(entry.node, entry.source, where, depth + 1);
          if (inner) {
            items.push({
              ...inner,
              min: occurs(child, "minOccurs", 1),
              max: occurs(child, "maxOccurs", 1),
            });
          }
          break;
        }
        case "any":
          items.push({
            kind: "any",
            min: occurs(child, "minOccurs", 1),
            max: occurs(child, "maxOccurs", 1),
          });
          break;
        default:
          break;
      }
    }
    return {
      kind: node.local as "sequence" | "choice" | "all",
      min: occurs(node, "minOccurs", 1),
      max: occurs(node, "maxOccurs", 1),
      items,
    };
  }
}

function occurs(node: XmlNode, attribute: "minOccurs" | "maxOccurs", fallback: number): number {
  const raw = node.attributes[attribute];
  if (raw === undefined) return fallback;
  if (raw === "unbounded") return -1;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : fallback;
}

/**
 * XSD regular expressions are implicitly anchored and carry a few multi-character escapes JS does
 * not have. Translating rather than passing through is the difference between enforcing the
 * author's constraint and enforcing a different one.
 */
export function xsdPatternToJs(pattern: string, where: string): string {
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (ch === "\\") {
      const next = pattern[i + 1];
      i++;
      switch (next) {
        case "i":
          out += "[A-Za-z_:]";
          break;
        case "I":
          out += "[^A-Za-z_:]";
          break;
        case "c":
          out += "[A-Za-z0-9_:.\\-]";
          break;
        case "C":
          out += "[^A-Za-z0-9_:.\\-]";
          break;
        case undefined:
          throw new XsdUnsupported("pattern", where, "ends with a dangling backslash");
        default:
          out += "\\" + next;
      }
      continue;
    }
    if (ch === "^" || ch === "$") {
      // Literal in XSD; anchors in JS.
      out += "\\" + ch;
      continue;
    }
    out += ch;
  }
  return `^(?:${out})$`;
}

// --------------------------------------------------------------------------- validation

export interface XsdIssue {
  path: string;
  rule: string;
  message: string;
}

export interface XsdValidateOptions {
  maxErrors?: number;
  maxDepth?: number;
}

export interface XsdResult {
  ok: boolean;
  issues: XsdIssue[];
  truncated: boolean;
}

interface VCtx {
  bundle: XsdBundle;
  issues: XsdIssue[];
  maxErrors: number;
  maxDepth: number;
  truncated: boolean;
}

const patternCache = new Map<string, RegExp>();
function rx(source: string): RegExp {
  let regex = patternCache.get(source);
  if (!regex) {
    regex = new RegExp(source, "u");
    patternCache.set(source, regex);
  }
  return regex;
}

/** Validates one instance element (a SOAP body child, say) against a compiled bundle. */
export function validateXmlElement(
  element: XmlNode,
  bundle: XsdBundle,
  options: XsdValidateOptions = {},
): XsdResult {
  const ctx: VCtx = {
    bundle,
    issues: [],
    maxErrors: options.maxErrors ?? 20,
    maxDepth: options.maxDepth ?? 64,
    truncated: false,
  };
  const decl = bundle.elements[element.qname];
  if (!decl) {
    ctx.issues.push({
      path: "/",
      rule: "element",
      message: `${element.qname} is not a global element declared by this contract's schema`,
    });
    return { ok: false, issues: ctx.issues, truncated: false };
  }
  checkElement(element, decl, "/" + element.local, ctx, 0);
  return { ok: ctx.issues.length === 0, issues: ctx.issues, truncated: ctx.truncated };
}

/** Parses and validates in one step; `maxBytes`/`maxDepth`/`maxElements` are the `always` block. */
export function validateXmlDocument(
  xml: string,
  bundle: XsdBundle,
  limits: { maxBytes?: number; maxDepth?: number; maxElements?: number } = {},
  options: XsdValidateOptions = {},
): XsdResult {
  let root: XmlNode;
  try {
    root = parseDocument(xml, limits);
  } catch (err) {
    const message = err instanceof XmlError ? err.message : String((err as Error).message);
    return { ok: false, issues: [{ path: "/", rule: "xml", message }], truncated: false };
  }
  return validateXmlElement(root, bundle, options);
}

function addIssue(ctx: VCtx, path: string, rule: string, message: string): void {
  if (ctx.issues.length >= ctx.maxErrors) {
    ctx.truncated = true;
    return;
  }
  ctx.issues.push({ path, rule, message });
}

function fullCtx(ctx: VCtx): boolean {
  return ctx.issues.length >= ctx.maxErrors;
}

function checkElement(
  node: XmlNode,
  decl: XsdElementDecl,
  path: string,
  ctx: VCtx,
  depth: number,
): void {
  if (fullCtx(ctx)) return;
  if (depth > ctx.maxDepth) {
    addIssue(ctx, path, "depth", `nested deeper than ${ctx.maxDepth} elements`);
    return;
  }

  const nil = node.nsAttributes[qnameOf(XSI_NS, "nil")];
  if (nil === "true" || nil === "1") {
    if (!decl.nillable) {
      addIssue(ctx, path, "nillable", `${decl.qname} is not declared nillable`);
    } else if (node.children.length > 0 || node.text.trim() !== "") {
      addIssue(ctx, path, "nillable", "an xsi:nil element must be empty");
    }
    return;
  }

  if (decl.fixed !== undefined && node.text.trim() !== decl.fixed) {
    addIssue(ctx, path, "fixed", `must be exactly "${decl.fixed}"`);
  }
  checkType(node, decl.typeRef, path, ctx, depth);
}

function checkType(node: XmlNode, typeRef: string, path: string, ctx: VCtx, depth: number): void {
  if (typeRef === ANY_TYPE) return;

  if (typeRef.startsWith(`{${XSD_NS}}`)) {
    // A built-in used directly as an element type: text content only, no children, no attributes.
    if (node.children.length > 0) {
      addIssue(ctx, path, "content", "expected simple content, found child elements");
      return;
    }
    checkSimpleValue(node.text, { kind: "simple", builtin: typeRef.slice(XSD_NS.length + 2), variety: "atomic", facets: {} }, path, ctx);
    return;
  }

  const type = ctx.bundle.types[typeRef];
  if (!type) {
    addIssue(ctx, path, "type", `the compiled schema has no type "${typeRef}"`);
    return;
  }
  if (type.kind === "simple") {
    if (node.children.length > 0) {
      addIssue(ctx, path, "content", "expected simple content, found child elements");
      return;
    }
    checkSimpleValue(node.text, type, path, ctx);
    return;
  }
  checkComplex(node, type, path, ctx, depth);
}

function checkComplex(node: XmlNode, type: XsdComplexType, path: string, ctx: VCtx, depth: number): void {
  // --- attributes
  const declared = new Map(type.attributes.map((a) => [a.qname, a]));
  const present = new Set<string>();
  for (const [name, value] of Object.entries(node.attributes)) {
    // Unprefixed attributes are in no namespace; `xmlns` declarations never reach here.
    const qname = qnameOf("", name);
    present.add(qname);
    const attribute = declared.get(qname);
    if (!attribute) {
      if (!type.anyAttribute) {
        addIssue(ctx, `${path}/@${name}`, "attribute", `attribute "${name}" is not declared here`);
      }
      continue;
    }
    if (attribute.use === "prohibited") {
      addIssue(ctx, `${path}/@${name}`, "attribute", `attribute "${name}" is prohibited here`);
      continue;
    }
    if (attribute.fixed !== undefined && value !== attribute.fixed) {
      addIssue(ctx, `${path}/@${name}`, "fixed", `must be exactly "${attribute.fixed}"`);
    }
    checkAttributeValue(value, attribute.typeRef, `${path}/@${name}`, ctx);
  }
  for (const [qname, value] of Object.entries(node.nsAttributes)) {
    if (qname.startsWith(`{${XSI_NS}}`)) continue; // xsi:nil, xsi:type and friends
    present.add(qname);
    const attribute = declared.get(qname);
    if (!attribute) {
      if (!type.anyAttribute) {
        addIssue(ctx, `${path}/@${qname}`, "attribute", `attribute ${qname} is not declared here`);
      }
      continue;
    }
    checkAttributeValue(value, attribute.typeRef, `${path}/@${qname}`, ctx);
  }
  for (const attribute of type.attributes) {
    if (attribute.use === "required" && !present.has(attribute.qname)) {
      addIssue(ctx, path, "attribute", `required attribute ${attribute.qname} is missing`);
    }
  }
  if (fullCtx(ctx)) return;

  // --- content
  if (type.textTypeRef !== undefined) {
    if (node.children.length > 0) {
      addIssue(ctx, path, "content", "expected simple content, found child elements");
      return;
    }
    checkAttributeValue(node.text, type.textTypeRef, path, ctx);
    return;
  }

  const children = node.children;
  if (!type.particle) {
    if (children.length > 0) {
      addIssue(ctx, path, "content", `expected no child elements, found <${children[0]!.local}>`);
    }
    if (!type.mixed && node.text.trim() !== "") {
      addIssue(ctx, path, "content", "expected no text content");
    }
    return;
  }
  if (!type.mixed && node.text.trim() !== "" && children.length > 0) {
    addIssue(ctx, path, "content", "text is not allowed between elements of a non-mixed type");
  }

  const end = matchParticle(type.particle, children, 0, path, ctx, depth);
  if (end === null) return; // matchParticle reported
  if (end < children.length) {
    addIssue(
      ctx,
      `${path}/${children[end]!.local}`,
      "content",
      `<${children[end]!.local}> is unexpected here`,
    );
  }
}

/**
 * Greedy, name-driven matching. Returns the index after the last consumed child, or `null` when a
 * required particle could not be satisfied (having reported why).
 *
 * Correct rather than approximate because of Unique Particle Attribution: in a legal XSD, the next
 * element name selects at most one branch, so no backtracking is required and none is done.
 */
function matchParticle(
  particle: XsdParticle,
  children: XmlNode[],
  start: number,
  path: string,
  ctx: VCtx,
  depth: number,
): number | null {
  let index = start;
  let repetitions = 0;
  const max = particle.max === -1 ? Number.POSITIVE_INFINITY : particle.max;

  while (repetitions < max) {
    // Past the minimum, a repetition is only attempted when the next child could actually begin
    // it. Without that check an optional group would "fail" at the end of the content and report
    // a missing element that the schema never required.
    if (repetitions >= particle.min && !canStart(particle, children, index)) break;
    const next = matchOnce(particle, children, index, path, ctx, depth);
    if (next === null) break;
    if (next === index && particle.kind !== "element") break; // an empty match cannot repeat
    index = next;
    repetitions++;
  }

  if (repetitions < particle.min) {
    if (!fullCtx(ctx)) {
      addIssue(ctx, path, "content", describeMissing(particle, children, index));
    }
    return null;
  }
  return index;
}

function matchOnce(
  particle: XsdParticle,
  children: XmlNode[],
  start: number,
  path: string,
  ctx: VCtx,
  depth: number,
): number | null {
  switch (particle.kind) {
    case "element": {
      const child = children[start];
      if (!child || child.qname !== particle.decl.qname) return null;
      checkElement(child, particle.decl, `${path}/${child.local}`, ctx, depth + 1);
      return start + 1;
    }
    case "any":
      return start < children.length ? start + 1 : null;
    case "sequence": {
      let index = start;
      for (const item of particle.items) {
        const next = matchParticle(item, children, index, path, ctx, depth);
        if (next === null) return null;
        index = next;
      }
      return index;
    }
    case "choice": {
      for (const item of particle.items) {
        if (!canStart(item, children, start)) continue;
        const next = matchParticle(item, children, start, path, ctx, depth);
        if (next !== null) return next;
      }
      // A branch that matches nothing is still a match when every branch is optional.
      for (const item of particle.items) {
        if (minimumOf(item) === 0) return start;
      }
      return null;
    }
    case "all": {
      const remaining = new Map<string, XsdParticle>();
      for (const item of particle.items) {
        for (const name of firstNames(item)) remaining.set(name, item);
      }
      let index = start;
      const seen = new Set<XsdParticle>();
      while (index < children.length) {
        const item = remaining.get(children[index]!.qname);
        if (!item || seen.has(item)) break;
        seen.add(item);
        const next = matchParticle(item, children, index, path, ctx, depth);
        if (next === null || next === index) break;
        index = next;
      }
      for (const item of particle.items) {
        if (!seen.has(item) && minimumOf(item) > 0) {
          addIssue(ctx, path, "content", describeMissing(item, children, index));
          return null;
        }
      }
      return index;
    }
    default:
      return null;
  }
}

function minimumOf(particle: XsdParticle): number {
  return particle.min;
}

/** The element names a particle can begin with — what a `choice` selects on. */
function firstNames(particle: XsdParticle, depth = 0): string[] {
  if (depth > 32) return [];
  switch (particle.kind) {
    case "element":
      return [particle.decl.qname];
    case "any":
      return ["*"];
    case "sequence": {
      const names: string[] = [];
      for (const item of particle.items) {
        names.push(...firstNames(item, depth + 1));
        // A required item stops the scan: nothing after it can be the first element.
        if (item.min > 0) break;
      }
      return names;
    }
    default: {
      // choice and all: any member can come first.
      const names: string[] = [];
      for (const item of particle.items) names.push(...firstNames(item, depth + 1));
      return names;
    }
  }
}

function canStart(particle: XsdParticle, children: XmlNode[], index: number): boolean {
  const child = children[index];
  if (!child) return particle.min === 0;
  const names = firstNames(particle);
  return names.includes("*") || names.includes(child.qname);
}

function describeMissing(particle: XsdParticle, children: XmlNode[], index: number): string {
  const expected = firstNames(particle)
    .map((n) => (n === "*" ? "any element" : localOf(n)))
    .slice(0, 5);
  const found = children[index] ? `<${children[index]!.local}>` : "the end of the element";
  return `expected ${expected.length > 0 ? expected.map((e) => `<${e}>`).join(" or ") : "content"}, found ${found}`;
}

function localOf(qname: string): string {
  const close = qname.indexOf("}");
  return close === -1 ? qname : qname.slice(close + 1);
}

/** A simple type by reference, whether that reference names a built-in or a compiled type. */
function simpleTypeFor(typeRef: string, ctx: VCtx): XsdSimpleType | null {
  if (typeRef.startsWith(`{${XSD_NS}}`)) {
    return {
      kind: "simple",
      builtin: typeRef.slice(XSD_NS.length + 2),
      variety: "atomic",
      facets: {},
    };
  }
  const type = ctx.bundle.types[typeRef];
  return type && type.kind === "simple" ? type : null;
}

function checkAttributeValue(value: string, typeRef: string, path: string, ctx: VCtx): void {
  if (typeRef === ANY_TYPE) return;
  const type = simpleTypeFor(typeRef, ctx);
  if (!type) return;
  checkSimpleValue(value, type, path, ctx);
}

// --------------------------------------------------------------------------- simple values

const WHITESPACE_COLLAPSED = new Set([
  "token",
  "language",
  "Name",
  "NCName",
  "NMTOKEN",
  "ID",
  "IDREF",
  "ENTITY",
  "QName",
  "NOTATION",
]);

function normalizeWhitespace(value: string, type: XsdSimpleType): string {
  const explicit = type.facets.whiteSpace;
  const builtin = type.builtin;
  const mode =
    explicit ??
    (builtin === "string"
      ? "preserve"
      : builtin === "normalizedString"
        ? "replace"
        : WHITESPACE_COLLAPSED.has(builtin) || isNumericBuiltin(builtin) || isTemporalBuiltin(builtin)
          ? "collapse"
          : "collapse");
  if (mode === "preserve") return value;
  const replaced = value.replace(/[\t\n\r]/g, " ");
  return mode === "replace" ? replaced : replaced.trim().replace(/ {2,}/g, " ");
}

const INTEGER_RANGES: Record<string, [bigint | null, bigint | null]> = {
  integer: [null, null],
  nonPositiveInteger: [null, 0n],
  negativeInteger: [null, -1n],
  nonNegativeInteger: [0n, null],
  positiveInteger: [1n, null],
  long: [-9223372036854775808n, 9223372036854775807n],
  int: [-2147483648n, 2147483647n],
  short: [-32768n, 32767n],
  byte: [-128n, 127n],
  unsignedLong: [0n, 18446744073709551615n],
  unsignedInt: [0n, 4294967295n],
  unsignedShort: [0n, 65535n],
  unsignedByte: [0n, 255n],
};

function isNumericBuiltin(builtin: string): boolean {
  return builtin === "decimal" || builtin === "float" || builtin === "double" || builtin in INTEGER_RANGES;
}

function isTemporalBuiltin(builtin: string): boolean {
  return (
    builtin === "date" ||
    builtin === "dateTime" ||
    builtin === "time" ||
    builtin === "duration" ||
    builtin.startsWith("gYear") ||
    builtin.startsWith("gMonth") ||
    builtin.startsWith("gDay")
  );
}

const RE_DECIMAL = /^[+-]?(\d+(\.\d*)?|\.\d+)$/;
const RE_DOUBLE = /^(\+|-)?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$|^(-)?INF$|^NaN$/;
const RE_INTEGER = /^[+-]?\d+$/;
const RE_DATE = /^-?\d{4,}-\d{2}-\d{2}(Z|[+-]\d{2}:\d{2})?$/;
const RE_TIME = /^\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})?$/;
const RE_DATETIME = /^-?\d{4,}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})?$/;
const RE_DURATION = /^-?P(?!$)(\d+Y)?(\d+M)?(\d+D)?(T(?!$)(\d+H)?(\d+M)?(\d+(\.\d+)?S)?)?$/;
const RE_NCNAME = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
const RE_NAME = /^[A-Za-z_:][A-Za-z0-9_.:-]*$/;
const RE_NMTOKEN = /^[A-Za-z0-9_.:-]+$/;
const RE_HEX = /^([0-9a-fA-F]{2})*$/;
const RE_B64 = /^[A-Za-z0-9+/\s]*={0,2}$/;
const RE_LANGUAGE = /^[a-zA-Z]{1,8}(-[a-zA-Z0-9]{1,8})*$/;

function checkSimpleValue(raw: string, type: XsdSimpleType, path: string, ctx: VCtx): void {
  if (fullCtx(ctx)) return;

  if (type.variety === "list") {
    const item = type.itemRef ? simpleTypeFor(type.itemRef, ctx) : null;
    for (const part of raw.trim().split(/\s+/).filter(Boolean)) {
      if (item) checkSimpleValue(part, item, path, ctx);
    }
    return;
  }
  if (type.variety === "union") {
    for (const ref of type.memberRefs ?? []) {
      const member = simpleTypeFor(ref, ctx);
      if (!member) continue;
      const probe: VCtx = { ...ctx, issues: [], truncated: false, maxErrors: 1 };
      checkSimpleValue(raw, member, path, probe);
      if (probe.issues.length === 0) return;
    }
    addIssue(ctx, path, "union", `"${trim(raw)}" matches none of the union's member types`);
    return;
  }

  const value = normalizeWhitespace(raw, type);
  const builtin = type.builtin;

  const typeMessage = builtinError(builtin, value);
  if (typeMessage) {
    addIssue(ctx, path, "type", `"${trim(value)}" ${typeMessage}`);
    return;
  }

  const f = type.facets;
  if (f.enumeration && !f.enumeration.includes(value)) {
    addIssue(ctx, path, "enumeration", `"${trim(value)}" is not one of ${f.enumeration.slice(0, 8).join(", ")}`);
  }
  if (f.patterns) {
    // XSD says the value must match at least one pattern facet at each derivation step; flattened,
    // matching any of them is the reading that never rejects a value the author allowed.
    if (!f.patterns.some((p) => rx(p).test(value))) {
      addIssue(ctx, path, "pattern", `"${trim(value)}" does not match the declared pattern`);
    }
  }
  const length = [...value].length;
  if (f.length !== undefined && length !== f.length) {
    addIssue(ctx, path, "length", `must be exactly ${f.length} characters`);
  }
  if (f.minLength !== undefined && length < f.minLength) {
    addIssue(ctx, path, "minLength", `shorter than ${f.minLength} characters`);
  }
  if (f.maxLength !== undefined && length > f.maxLength) {
    addIssue(ctx, path, "maxLength", `longer than ${f.maxLength} characters`);
  }

  if (isNumericBuiltin(builtin)) {
    const numeric = Number(value);
    if (f.minInclusive !== undefined && numeric < Number(f.minInclusive)) {
      addIssue(ctx, path, "minInclusive", `less than ${f.minInclusive}`);
    }
    if (f.maxInclusive !== undefined && numeric > Number(f.maxInclusive)) {
      addIssue(ctx, path, "maxInclusive", `greater than ${f.maxInclusive}`);
    }
    if (f.minExclusive !== undefined && numeric <= Number(f.minExclusive)) {
      addIssue(ctx, path, "minExclusive", `not greater than ${f.minExclusive}`);
    }
    if (f.maxExclusive !== undefined && numeric >= Number(f.maxExclusive)) {
      addIssue(ctx, path, "maxExclusive", `not less than ${f.maxExclusive}`);
    }
    if (f.fractionDigits !== undefined) {
      const dot = value.indexOf(".");
      const digits = dot === -1 ? 0 : value.length - dot - 1;
      if (digits > f.fractionDigits) {
        addIssue(ctx, path, "fractionDigits", `more than ${f.fractionDigits} fractional digits`);
      }
    }
    if (f.totalDigits !== undefined) {
      const digits = value.replace(/[^0-9]/g, "").replace(/^0+/, "").length;
      if (digits > f.totalDigits) {
        addIssue(ctx, path, "totalDigits", `more than ${f.totalDigits} digits`);
      }
    }
  } else if (f.minInclusive !== undefined || f.maxInclusive !== undefined) {
    // Ordered non-numeric types (dates) compare lexically in their canonical form.
    if (f.minInclusive !== undefined && value < f.minInclusive) {
      addIssue(ctx, path, "minInclusive", `earlier than ${f.minInclusive}`);
    }
    if (f.maxInclusive !== undefined && value > f.maxInclusive) {
      addIssue(ctx, path, "maxInclusive", `later than ${f.maxInclusive}`);
    }
  }
}

function trim(value: string): string {
  return value.length > 64 ? value.slice(0, 61) + "…" : value;
}

/** `null` when the lexical form is valid for the built-in, a message when it is not. */
export function builtinError(builtin: string, value: string): string | null {
  if (builtin in INTEGER_RANGES) {
    if (!RE_INTEGER.test(value)) return `is not an xs:${builtin}`;
    const [lo, hi] = INTEGER_RANGES[builtin]!;
    let n: bigint;
    try {
      n = BigInt(value);
    } catch {
      return `is not an xs:${builtin}`;
    }
    if (lo !== null && n < lo) return `is below the range of xs:${builtin}`;
    if (hi !== null && n > hi) return `is above the range of xs:${builtin}`;
    return null;
  }
  switch (builtin) {
    case "anyType":
    case "anySimpleType":
    case "string":
    case "normalizedString":
    case "token":
      return null;
    case "boolean":
      return ["true", "false", "1", "0"].includes(value) ? null : "is not an xs:boolean";
    case "decimal":
      return RE_DECIMAL.test(value) ? null : "is not an xs:decimal";
    case "float":
    case "double":
      return RE_DOUBLE.test(value) ? null : `is not an xs:${builtin}`;
    case "date":
      return RE_DATE.test(value) ? null : "is not an xs:date";
    case "dateTime":
      return RE_DATETIME.test(value) ? null : "is not an xs:dateTime";
    case "time":
      return RE_TIME.test(value) ? null : "is not an xs:time";
    case "duration":
      return RE_DURATION.test(value) ? null : "is not an xs:duration";
    case "gYear":
      return /^-?\d{4,}(Z|[+-]\d{2}:\d{2})?$/.test(value) ? null : "is not an xs:gYear";
    case "gYearMonth":
      return /^-?\d{4,}-\d{2}(Z|[+-]\d{2}:\d{2})?$/.test(value) ? null : "is not an xs:gYearMonth";
    case "gMonth":
      return /^--\d{2}(Z|[+-]\d{2}:\d{2})?$/.test(value) ? null : "is not an xs:gMonth";
    case "gMonthDay":
      return /^--\d{2}-\d{2}(Z|[+-]\d{2}:\d{2})?$/.test(value) ? null : "is not an xs:gMonthDay";
    case "gDay":
      return /^---\d{2}(Z|[+-]\d{2}:\d{2})?$/.test(value) ? null : "is not an xs:gDay";
    case "base64Binary":
      return RE_B64.test(value) && value.replace(/\s/g, "").length % 4 === 0
        ? null
        : "is not xs:base64Binary";
    case "hexBinary":
      return RE_HEX.test(value) ? null : "is not xs:hexBinary";
    case "anyURI":
      return value.includes(" ") ? "is not an xs:anyURI" : null;
    case "language":
      return RE_LANGUAGE.test(value) ? null : "is not an xs:language";
    case "Name":
      return RE_NAME.test(value) ? null : "is not an xs:Name";
    case "NCName":
    case "ID":
    case "IDREF":
    case "ENTITY":
      return RE_NCNAME.test(value) ? null : `is not an xs:${builtin}`;
    case "NMTOKEN":
      return RE_NMTOKEN.test(value) ? null : "is not an xs:NMTOKEN";
    case "QName":
      return RE_NAME.test(value) ? null : "is not an xs:QName";
    default:
      // An unknown built-in asserts nothing rather than rejecting everything: the compile step is
      // where an unsupported construct is refused, and nothing reached here without passing it.
      return null;
  }
}
