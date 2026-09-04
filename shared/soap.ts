import { SOAP_11_ENVELOPE, SOAP_12_ENVELOPE } from "./xml.ts";

/**
 * SOAP specifics shared by both planes: how an action is declared, when it agrees with the body,
 * and what a fault looks like.
 */

export function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function soapContentType(version: "1.1" | "1.2"): string {
  return version === "1.2" ? "application/soap+xml; charset=utf-8" : "text/xml; charset=utf-8";
}

/** The media type without parameters, lowercased. */
export function mediaTypeOf(contentType: string | null): string {
  return (contentType ?? "").split(";")[0]!.trim().toLowerCase();
}

/**
 * SOAP 1.1 declares the action in a `SOAPAction` header, conventionally quoted. SOAP 1.2 has no
 * such header at all — the action is an optional parameter of the `application/soap+xml` media
 * type. Returns `null` when nothing was declared, which is different from `""`.
 */
export function declaredAction(
  version: "1.1" | "1.2",
  header: string | null,
  contentType: string | null,
): string | null {
  if (version === "1.2") {
    const match = /;\s*action\s*=\s*("([^"]*)"|([^;]*))/i.exec(contentType ?? "");
    if (!match) return null;
    return (match[2] ?? match[3] ?? "").trim();
  }
  if (header === null) return null;
  const trimmed = header.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/**
 * Agreement, not presence (review V1-10). `soapAction=""` is legal in a WSDL 1.1 binding and
 * SOAP 1.2 has no header, so an absent declaration and an empty one are the same thing. What is
 * rejected is a declaration that names a *different* operation than the body does.
 */
export function actionAgrees(declared: string | null, bindingAction: string): boolean {
  return (declared ?? "") === (bindingAction ?? "");
}

export interface FaultOptions {
  version: "1.1" | "1.2";
  status: number;
  reason: string;
  requestId: string;
  code?: string;
}

/**
 * A fault carrying the **real HTTP status**, not 500. SOAP 1.1 conventionally uses 500 for every
 * fault; keeping 401/403/429 means a consumer that reads status codes keeps working and
 * `Retry-After` on a 429 still means something. Deliberate departure, stated in the plan.
 */
export function soapFault(options: FaultOptions): string {
  const client = options.status >= 400 && options.status < 500;
  const reason = escapeXml(options.reason);
  const requestId = escapeXml(options.requestId);

  if (options.version === "1.2") {
    const code = options.code ?? (client ? "env:Sender" : "env:Receiver");
    return (
      `<?xml version="1.0" encoding="UTF-8"?>` +
      `<env:Envelope xmlns:env="${SOAP_12_ENVELOPE}"><env:Body><env:Fault>` +
      `<env:Code><env:Value>${code}</env:Value></env:Code>` +
      `<env:Reason><env:Text xml:lang="en">${reason}</env:Text></env:Reason>` +
      `<env:Detail><apim:error xmlns:apim="urn:apim:error">` +
      `<apim:status>${options.status}</apim:status><apim:requestId>${requestId}</apim:requestId>` +
      `</apim:error></env:Detail>` +
      `</env:Fault></env:Body></env:Envelope>`
    );
  }

  const code = options.code ?? (client ? "soap:Client" : "soap:Server");
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<soap:Envelope xmlns:soap="${SOAP_11_ENVELOPE}"><soap:Body><soap:Fault>` +
    `<faultcode>${code}</faultcode><faultstring>${reason}</faultstring>` +
    `<detail><apim:error xmlns:apim="urn:apim:error">` +
    `<apim:status>${options.status}</apim:status><apim:requestId>${requestId}</apim:requestId>` +
    `</apim:error></detail>` +
    `</soap:Fault></soap:Body></soap:Envelope>`
  );
}
