import type { ApiModel, ApiOperation } from "../../shared/types.ts";
import { childNamed, childrenNamed, parseDocument, resolveQName, XmlError, type XmlNode } from "../../shared/xml.ts";
import { compileXsdSet, XsdUnsupported, type XsdBundle } from "../../shared/xsd.ts";
import { badRequest } from "./router.ts";
import type { XmlLimits } from "./egress.ts";

/**
 * WSDL 1.1 into the same normalized model the REST path uses (design section 4.1): routing,
 * policy resolution and export are one code path regardless of the dialect a contract arrived in.
 *
 * Scope is deliberately narrow and every exclusion is an error that says so:
 *  - WSDL 1.1, `document/literal`, one service and one SOAP port;
 *  - self-contained — `wsdl:import` and `xsd:import`/`xsd:include` with a location are rejected
 *    exactly as a remote `$ref` is (design section 5.3), because an uploaded contract must not
 *    depend on someone else's web server;
 *  - the inline schema set is **compiled** (deviation D12′), and a construct outside
 *    `shared/xsd.ts`'s subset is rejected here rather than silently unvalidated: a contract this
 *    cannot fully check never becomes a published API that claims to be checked.
 */
export const WSDL_NS = "http://schemas.xmlsoap.org/wsdl/";
export const WSDL_SOAP11_NS = "http://schemas.xmlsoap.org/wsdl/soap/";
export const WSDL_SOAP12_NS = "http://schemas.xmlsoap.org/wsdl/soap12/";
export const XSD_NS = "http://www.w3.org/2001/XMLSchema";

export function looksLikeWsdl(raw: string): boolean {
  const head = raw.slice(0, 4096);
  return head.includes(WSDL_NS) || /<(\w+:)?definitions[\s>]/.test(head);
}

function attr(node: XmlNode, name: string): string | undefined {
  return node.attributes[name];
}

function required(node: XmlNode, name: string, where: string): string {
  const value = attr(node, name);
  if (value === undefined) throw badRequest(`${where}: missing required attribute "${name}"`);
  return value;
}

function assertSelfContained(root: XmlNode): void {
  const walk = (node: XmlNode): void => {
    if (node.ns === WSDL_NS && node.local === "import") {
      throw badRequest(
        `wsdl:import (location "${attr(node, "location") ?? "?"}") is not supported: an uploaded ` +
          "contract must be self-contained (design section 5.3). Inline the imported document.",
      );
    }
    if (node.ns === XSD_NS && (node.local === "import" || node.local === "include")) {
      const location = attr(node, "schemaLocation");
      if (location) {
        throw badRequest(
          `xsd:${node.local} schemaLocation "${location}" is not supported: an uploaded contract ` +
            "must be self-contained (design section 5.3). Inline the schema.",
        );
      }
    }
    for (const child of node.children) walk(child);
  };
  walk(root);
}

interface MessageParts {
  element: string | null;
}

/**
 * The message a portType operation names, refusing one that is not declared. Absent is legal —
 * a one-way operation has no output — but a name that resolves to nothing is a broken contract.
 */
function messageNamed(
  messages: Map<string, MessageParts>,
  qname: string | null,
  operation: string,
  role: "input" | "output",
): MessageParts | null {
  if (!qname) return null;
  const message = messages.get(qname);
  if (!message) {
    throw badRequest(
      `operation ${operation}: its ${role} names message ${qname}, which this WSDL does not declare`,
    );
  }
  return message;
}

export function normalizeWsdl(raw: string, limits?: Partial<XmlLimits>): { model: ApiModel } {
  let root: XmlNode;
  try {
    root = parseDocument(raw, {
      maxBytes: limits?.maxBytes,
      maxDepth: limits?.maxDepth,
      maxElements: limits?.maxElements,
    });
  } catch (err) {
    if (err instanceof XmlError) throw badRequest(`the WSDL could not be parsed: ${err.message}`);
    throw err;
  }

  if (root.ns !== WSDL_NS || root.local !== "definitions") {
    throw badRequest(
      `not a WSDL 1.1 document: expected <definitions> in ${WSDL_NS}, found {${root.ns}}${root.local}`,
    );
  }
  assertSelfContained(root);

  const targetNamespace = required(root, "targetNamespace", "definitions");
  const schema = compileInlineSchemas(root);

  // messages: qname -> first part's element qname (document/literal has one part)
  const messages = new Map<string, MessageParts>();
  for (const message of childrenNamed(root, WSDL_NS, "message")) {
    const name = required(message, "name", "message");
    const part = childrenNamed(message, WSDL_NS, "part")[0];
    const element = part && attr(part, "element") ? resolveQName(part, attr(part, "element")!) : null;
    messages.set(resolveQName(root, `${prefixFor(root, targetNamespace)}${name}`), { element });
  }

  // portTypes: qname -> operation name -> { input, output } message qnames
  const portTypes = new Map<string, Map<string, { input: string | null; output: string | null }>>();
  for (const portType of childrenNamed(root, WSDL_NS, "portType")) {
    const name = required(portType, "name", "portType");
    const operations = new Map<string, { input: string | null; output: string | null }>();
    for (const operation of childrenNamed(portType, WSDL_NS, "operation")) {
      const operationName = required(operation, "name", "portType/operation");
      const input = childNamed(operation, WSDL_NS, "input");
      const output = childNamed(operation, WSDL_NS, "output");
      operations.set(operationName, {
        input: input && attr(input, "message") ? resolveQName(input, attr(input, "message")!) : null,
        output: output && attr(output, "message") ? resolveQName(output, attr(output, "message")!) : null,
      });
    }
    portTypes.set(resolveQName(root, `${prefixFor(root, targetNamespace)}${name}`), operations);
  }

  // The service's port picks the binding, which picks the portType — so start from the service.
  const service = childrenNamed(root, WSDL_NS, "service")[0];
  if (!service) throw badRequest("the WSDL declares no <service>");
  const serviceName = required(service, "name", "service");

  let chosen: { port: XmlNode; soapNs: string; address: XmlNode } | null = null;
  for (const port of childrenNamed(service, WSDL_NS, "port")) {
    for (const soapNs of [WSDL_SOAP11_NS, WSDL_SOAP12_NS]) {
      const address = childNamed(port, soapNs, "address");
      if (address) {
        chosen = { port, soapNs, address };
        break;
      }
    }
    if (chosen) break;
  }
  if (!chosen) {
    throw badRequest(
      "the WSDL declares no SOAP port: expected a <port> containing <soap:address> " +
        `(${WSDL_SOAP11_NS} or ${WSDL_SOAP12_NS})`,
    );
  }

  const portName = required(chosen.port, "name", "port");
  const endpoint = required(chosen.address, "location", "soap:address");
  const bindingQName = resolveQName(chosen.port, required(chosen.port, "binding", "port"));
  const binding = childrenNamed(root, WSDL_NS, "binding").find(
    (b) => resolveQName(root, `${prefixFor(root, targetNamespace)}${required(b, "name", "binding")}`) === bindingQName,
  );
  if (!binding) throw badRequest(`the port references binding ${bindingQName}, which is not declared`);

  const soapBinding = childNamed(binding, chosen.soapNs, "binding");
  const bindingStyle = soapBinding ? (attr(soapBinding, "style") ?? "document") : "document";
  if (bindingStyle !== "document") {
    throw badRequest(
      `soap:binding style="${bindingStyle}" is not supported; only document/literal is ` +
        "(rpc/literal needs a different body shape and is out of scope)",
    );
  }

  const portTypeQName = resolveQName(binding, required(binding, "type", "binding"));
  const portTypeOperations = portTypes.get(portTypeQName);
  if (!portTypeOperations) {
    throw badRequest(`the binding references portType ${portTypeQName}, which is not declared`);
  }

  const operations: ApiOperation[] = [];
  for (const operation of childrenNamed(binding, WSDL_NS, "operation")) {
    const name = required(operation, "name", "binding/operation");
    const soapOperation = childNamed(operation, chosen.soapNs, "operation");
    const style = soapOperation ? (attr(soapOperation, "style") ?? bindingStyle) : bindingStyle;
    if (style !== "document") {
      throw badRequest(`operation ${name}: style="${style}" is not supported, only document/literal`);
    }
    // May legitimately be the empty string: WSDL 1.1 allows soapAction="", and SOAP 1.2 has no
    // SOAPAction header at all. Absent and "" are the same thing when agreement is checked.
    const soapAction = soapOperation ? (attr(soapOperation, "soapAction") ?? "") : "";

    const declared = portTypeOperations.get(name);
    if (!declared) {
      throw badRequest(`binding operation ${name} is not declared in portType ${portTypeQName}`);
    }
    /**
     * A WSDL's references have to *resolve*, not merely be present, for the same reason an
     * OpenAPI `$ref` does (see `assertSelfContained` in `normalize.ts`): a contract whose message
     * or body element points at nothing compiles into no validator, so the operation publishes,
     * reads `blocking` on the policy screen and checks nothing. These three refusals used to be
     * silence — an undeclared message read as "no element part", and an undeclared element became
     * `no-schema` two layers down in `artifacts.ts`.
     */
    const inputMessage = messageNamed(messages, declared.input, name, "input");
    const outputMessage = messageNamed(messages, declared.output, name, "output");
    const inputElement = inputMessage?.element ?? null;
    const outputElement = outputMessage?.element ?? null;
    if (!inputElement) {
      throw badRequest(
        `operation ${name}: its input message has no element part, which document/literal requires`,
      );
    }
    if (declared.output && !outputElement) {
      throw badRequest(
        `operation ${name}: it declares an output message with no element part, which ` +
          "document/literal requires. Give the part an element, or drop the output.",
      );
    }
    // Only when the contract carries a schema at all: a WSDL without <types> declares no schema
    // and is validated as `no-schema`, which is a contract saying nothing rather than one
    // pointing at nothing.
    if (schema) {
      for (const [role, element] of [
        ["input", inputElement],
        ["output", outputElement],
      ] as const) {
        if (element && !schema.elements[element]) {
          throw badRequest(
            `operation ${name}: its ${role} body element ${element} is not declared by the ` +
              "WSDL's inline schema, so there would be nothing to validate that body against. " +
              "Declare the element, or remove the inline schema.",
          );
        }
      }
    }

    operations.push({
      operationId: name,
      // Every SOAP operation is a POST to the one endpoint; the body identifies the operation.
      method: "POST",
      path: "/",
      parameters: [{ name: "body", in: "body", required: true }],
      soapAction,
      inputElement,
      outputElement: outputElement ?? undefined,
    });
  }
  if (operations.length === 0) throw badRequest("the WSDL binding declares no operations");

  // Deterministic order: the model is digested, so iteration order must not leak into the digest.
  operations.sort((a, b) => a.operationId.localeCompare(b.operationId));

  const documentation = childNamed(root, WSDL_NS, "documentation");
  return {
    model: {
      title: serviceName,
      version: "1.0.0",
      description: documentation?.text.trim() || undefined,
      servers: [endpoint],
      operations,
      soap: {
        version: chosen.soapNs === WSDL_SOAP12_NS ? "1.2" : "1.1",
        service: serviceName,
        port: portName,
        endpoint,
        targetNamespace,
        ...(schema ? { schema } : {}),
      },
    },
  };
}

/**
 * The WSDL's inline `<xs:schema>` elements, compiled. Absent `<wsdl:types>` is legal and means
 * this contract declares no schema, which the validator reports per operation as `no-schema`
 * rather than failing closed (plan `[R1-14]`).
 */
function compileInlineSchemas(root: XmlNode): XsdBundle | undefined {
  const types = childNamed(root, WSDL_NS, "types");
  if (!types) return undefined;
  const schemas = childrenNamed(types, XSD_NS, "schema");
  if (schemas.length === 0) return undefined;
  try {
    return compileXsdSet(schemas);
  } catch (err) {
    if (err instanceof XsdUnsupported) {
      throw badRequest(
        `the WSDL's schema uses a construct this validator does not implement, so publishing it ` +
          `would claim a check that is not made: ${err.message}`,
      );
    }
    throw err;
  }
}

/**
 * WSDL names its own components without a prefix and refers to them with one, so a local name is
 * turned into a QName against the target namespace. Finding a prefix bound to it keeps
 * `resolveQName` as the single resolution path instead of building QNames by string concatenation.
 */
function prefixFor(root: XmlNode, targetNamespace: string): string {
  for (const [prefix, uri] of Object.entries(root.declarations)) {
    if (uri === targetNamespace && prefix !== "") return `${prefix}:`;
  }
  // No prefix is bound to the target namespace, so the default namespace must be it.
  return "";
}

/** Design section 4.1: export is generation. For `soap` that is a summary, not a WSDL (D13). */
export function toSoapSummary(model: ApiModel): Record<string, unknown> {
  return {
    kind: "soap",
    service: model.soap?.service,
    port: model.soap?.port,
    soapVersion: model.soap?.version,
    targetNamespace: model.soap?.targetNamespace,
    endpoint: model.soap?.endpoint,
    note:
      "Generated summary of the normalized model. The uploaded WSDL is available verbatim at " +
      "?format=original; regenerating WSDL and XSD from the model is out of scope (deviation D13).",
    operations: model.operations.map((op) => ({
      operationId: op.operationId,
      soapAction: op.soapAction ?? "",
      inputElement: op.inputElement,
      outputElement: op.outputElement ?? null,
    })),
  };
}
