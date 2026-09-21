import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { normalizeWsdl } from "../control-plane/src/normalize-wsdl.ts";
import { actionAgrees, declaredAction, soapFault } from "../shared/soap.ts";
import { parseDocument, scanEnvelope, XmlError } from "../shared/xml.ts";
import { PetstoreBackend, startBackend as startPetstore } from "../tools/backend/server.ts";
import { makeCp, makeDp, publishApi, serveCp, type TestCp } from "./helpers.ts";

const WSDL = readFileSync("tools/backend/petstore.wsdl", "utf8");
const PETSTORE_NS = "urn:apim:petstore";

function envelope(inner: string, ns = "http://schemas.xmlsoap.org/soap/envelope/"): string {
  return `<?xml version="1.0"?><s:Envelope xmlns:s="${ns}"><s:Body>${inner}</s:Body></s:Envelope>`;
}

const GET_PET = envelope(`<tns:GetPetRequest xmlns:tns="${PETSTORE_NS}"><tns:petId>1</tns:petId></tns:GetPetRequest>`);

describe("the XML reader refuses what it does not understand", () => {
  test("DTDs and entity declarations are refused outright, not expanded safely", () => {
    expect(() => parseDocument(`<!DOCTYPE foo><foo/>`)).toThrow(XmlError);
    expect(() =>
      parseDocument(`<!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><foo>&xxe;</foo>`),
    ).toThrow(/DTDs, entity declarations and external entities/);
  });

  test("a billion-laughs payload never gets as far as expansion", () => {
    const bomb =
      `<!DOCTYPE lolz [<!ENTITY lol "lol">` +
      `<!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">]>` +
      `<lolz>&lol2;</lolz>`;
    expect(() => parseDocument(bomb)).toThrow(XmlError);
  });

  test("an undeclared entity reference is refused even without a DTD", () => {
    expect(() => parseDocument(`<a>&secret;</a>`)).toThrow(/entity reference/);
    // The five predefined ones and bounded numeric references are fine.
    expect(parseDocument(`<a>&amp;&lt;&#65;</a>`).text).toBe("&<A");
  });

  test("processing instructions other than the XML declaration are refused", () => {
    expect(parseDocument(`<?xml version="1.0"?><a/>`).local).toBe("a");
    expect(() => parseDocument(`<?php evil(); ?><a/>`)).toThrow(/processing instructions/);
  });

  test("depth and element caps are enforced before anything else happens", () => {
    const deep = "<a>".repeat(40) + "</a>".repeat(40);
    expect(() => parseDocument(deep, { maxDepth: 8 })).toThrow(/nested deeper than 8/);
    const wide = `<root>${"<x/>".repeat(50)}</root>`;
    expect(() => parseDocument(wide, { maxElements: 10 })).toThrow(/more than 10 elements/);
  });

  test("namespaces resolve, and an undeclared prefix is an error", () => {
    const node = parseDocument(`<a xmlns:p="urn:x"><p:b p:k="v"/></a>`);
    expect(node.children[0]!.qname).toBe("{urn:x}b");
    expect(node.children[0]!.nsAttributes["{urn:x}k"]).toBe("v");
    expect(() => parseDocument(`<p:a/>`)).toThrow(/prefix "p" is not declared/);
  });
});

describe("the bounded envelope scan", () => {
  test("finds the body's first child in 1.1 and 1.2 envelopes", () => {
    expect(scanEnvelope(GET_PET)).toEqual({
      soapVersion: "1.1",
      bodyChild: `{${PETSTORE_NS}}GetPetRequest`,
    });
    const twelve = envelope(
      `<tns:AddPetRequest xmlns:tns="${PETSTORE_NS}"/>`,
      "http://www.w3.org/2003/05/soap-envelope",
    );
    expect(scanEnvelope(twelve)).toEqual({
      soapVersion: "1.2",
      bodyChild: `{${PETSTORE_NS}}AddPetRequest`,
    });
  });

  test("a truncated prefix yields no body child rather than an error", () => {
    const cut = GET_PET.slice(0, GET_PET.indexOf("GetPetRequest"));
    expect(scanEnvelope(cut).bodyChild).toBeNull();
  });

  test("a document that is not a SOAP envelope is rejected", () => {
    expect(() => scanEnvelope(`<html><body/></html>`)).toThrow(/not a SOAP Envelope/);
  });

  test("it stops at the first body child, so a huge envelope costs the same as a small one", () => {
    const huge = envelope(
      `<tns:GetPetRequest xmlns:tns="${PETSTORE_NS}">${"<tns:pad>x</tns:pad>".repeat(5000)}</tns:GetPetRequest>`,
    );
    // maxElements is 3 and it still succeeds: nothing past the body child is read.
    expect(scanEnvelope(huge, { maxElements: 3 }).bodyChild).toBe(`{${PETSTORE_NS}}GetPetRequest`);
  });
});

describe("SOAPAction agreement", () => {
  test("1.1 reads the header, quoted or not; 1.2 reads the content-type parameter", () => {
    expect(declaredAction("1.1", '"urn:a"', null)).toBe("urn:a");
    expect(declaredAction("1.1", "urn:a", null)).toBe("urn:a");
    expect(declaredAction("1.1", null, null)).toBeNull();
    expect(declaredAction("1.2", null, 'application/soap+xml; action="urn:a"')).toBe("urn:a");
    expect(declaredAction("1.2", null, "application/soap+xml")).toBeNull();
  });

  test("absent and empty are the same thing, which is what WSDL 1.1 allows", () => {
    expect(actionAgrees(null, "")).toBe(true);
    expect(actionAgrees("", "")).toBe(true);
    expect(actionAgrees(null, "urn:a")).toBe(false);
    expect(actionAgrees("urn:b", "urn:a")).toBe(false);
    expect(actionAgrees("urn:a", "urn:a")).toBe(true);
  });

  test("a fault carries the real status in its detail and the right code by class", () => {
    const client = soapFault({ version: "1.1", status: 429, reason: "slow down", requestId: "r1" });
    expect(client).toContain("<faultcode>soap:Client</faultcode>");
    expect(client).toContain("<apim:status>429</apim:status>");
    const server = soapFault({ version: "1.2", status: 502, reason: "backend", requestId: "r2" });
    expect(server).toContain("<env:Value>env:Receiver</env:Value>");
  });
});

describe("WSDL import", () => {
  test("a WSDL becomes the same model shape the REST path produces", () => {
    const { model } = normalizeWsdl(WSDL);
    expect(model.title).toBe("PetstoreService");
    expect(model.soap).toMatchObject({
      version: "1.1",
      service: "PetstoreService",
      port: "PetstorePort",
      endpoint: "http://127.0.0.1:9080/soap/petstore",
      targetNamespace: PETSTORE_NS,
    });
    // v3: the inline schema set is compiled into the model, so `version_digest` moves when the
    // schema does and the data plane never parses a WSDL (deviation D12′, design section 8.7).
    expect(Object.keys(model.soap!.schema!.elements).sort()).toEqual([
      `{${PETSTORE_NS}}AddPetRequest`,
      `{${PETSTORE_NS}}AddPetResponse`,
      `{${PETSTORE_NS}}GetPetRequest`,
      `{${PETSTORE_NS}}GetPetResponse`,
    ]);
    expect(model.servers).toEqual(["http://127.0.0.1:9080/soap/petstore"]);
    expect(model.operations.map((o) => o.operationId)).toEqual(["AddPet", "GetPet"]);
    const getPet = model.operations.find((o) => o.operationId === "GetPet")!;
    expect(getPet.soapAction).toBe("urn:apim:petstore:GetPet");
    expect(getPet.inputElement).toBe(`{${PETSTORE_NS}}GetPetRequest`);
    expect(getPet.outputElement).toBe(`{${PETSTORE_NS}}GetPetResponse`);
  });

  test("an imported document is refused: an uploaded contract must be self-contained", () => {
    const withImport = WSDL.replace(
      "<types>",
      `<import namespace="urn:other" location="http://evil.test/other.wsdl"/><types>`,
    );
    expect(() => normalizeWsdl(withImport)).toThrow(/self-contained/);

    const withXsdImport = WSDL.replace(
      "<xsd:element name=\"GetPetRequest\">",
      `<xsd:import namespace="urn:other" schemaLocation="http://evil.test/x.xsd"/><xsd:element name="GetPetRequest">`,
    );
    expect(() => normalizeWsdl(withXsdImport)).toThrow(/self-contained/);
  });

  /**
   * A WSDL's references have to resolve for the same reason an OpenAPI `$ref` does: a contract
   * that names a message or a body element it does not declare compiles into no validator, so the
   * operation used to publish reading `blocking` on the policy screen and check nothing at all.
   * Each of these three was silence before — the first read as "no element part", the second was
   * dropped, and the third became `no-schema` two layers down in the artifact compiler.
   */
  test("a message the WSDL does not declare is refused, naming it", () => {
    const dangling = WSDL.replace('message="tns:GetPetIn"', 'message="tns:NotDeclared"');
    expect(() => normalizeWsdl(dangling)).toThrow(/NotDeclared.*does not declare/s);
  });

  test("an output message with no element part is refused rather than dropped", () => {
    const noPart = WSDL.replace(
      '<message name="GetPetOut"><part name="parameters" element="tns:GetPetResponse"/></message>',
      '<message name="GetPetOut"><part name="parameters" type="xsd:string"/></message>',
    );
    expect(() => normalizeWsdl(noPart)).toThrow(/output message with no element part/);
  });

  test("a body element the inline schema does not declare is refused, not silently unvalidated", () => {
    const undeclared = WSDL.replace(
      'element="tns:GetPetRequest"',
      'element="tns:GetPetRequestV2"',
    );
    expect(() => normalizeWsdl(undeclared)).toThrow(
      /GetPetRequestV2 is not declared by the WSDL's inline schema/,
    );

    const undeclaredOutput = WSDL.replace(
      'element="tns:GetPetResponse"',
      'element="tns:GetPetResponseV2"',
    );
    expect(() => normalizeWsdl(undeclaredOutput)).toThrow(/output body element/);
  });

  test("rpc style is refused with a message that says why", () => {
    const rpc = WSDL.replace('<soap:binding style="document"', '<soap:binding style="rpc"');
    expect(() => normalizeWsdl(rpc)).toThrow(/only document\/literal is/);
  });

  test("reformatting the WSDL does not churn the model", () => {
    const reformatted = WSDL.replace(/>\s+</g, "><");
    expect(JSON.stringify(normalizeWsdl(reformatted).model)).toBe(
      JSON.stringify(normalizeWsdl(WSDL).model),
    );
  });
});

describe("a soap API through the gateway", () => {
  let cp: TestCp;

  beforeEach(() => {
    cp = makeCp();
  });
  afterEach(() => {
    cp.close();
  });

  async function soapWorld(extraPolicy: Record<string, unknown> = {}) {
    const backend = new PetstoreBackend({ port: 0, seed: 1 });
    const server = startPetstore(backend);
    const cpServer = serveCp(cp);
    const api = await publishApi(cp, {
      name: "petstore-soap",
      kind: "soap",
      backendUrl: `http://127.0.0.1:${server.port}/soap/petstore`,
      basePath: "/petstore-soap",
      spec: WSDL,
      policy: {
        "auth.subscriptionKey": { in: "header", name: "X-Api-Key" },
        rewrite: { stripBasePath: true },
        rateLimit: {
          calls: 2,
          periodSec: 60,
          per: "instance",
          by: "subscription",
          scope: "route",
          emitHeaders: true,
        },
        ...extraPolicy,
      },
    });
    const dp = makeDp(cpServer.url, cp.token, cp.dir);
    await dp.start();
    return {
      api,
      dp,
      backend,
      stop: () => {
        dp.stop();
        cpServer.stop();
        server.stop(true);
      },
    };
  }

  function soapRequest(key: string | null, action: string | null, body = GET_PET): Request {
    const headers: Record<string, string> = { "content-type": "text/xml; charset=utf-8" };
    if (key) headers["x-api-key"] = key;
    if (action !== null) headers.soapaction = `"${action}"`;
    return new Request("http://gw/it/solution/petstore-soap", { method: "POST", headers, body });
  }

  test("a valid call proxies and the backend sees the envelope untouched", async () => {
    const world = await soapWorld();
    try {
      const response = await world.dp.fetchHttp(
        soapRequest(world.api.key!, "urn:apim:petstore:GetPet"),
        "127.0.0.1",
      );
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text).toContain("GetPetResponse");
      expect(text).toContain("doggie");
      expect(world.backend.stats.requests).toBe(1);
    } finally {
      world.stop();
    }
  });

  test("an action that disagrees with the body is 400, before the backend is reached", async () => {
    const world = await soapWorld();
    try {
      const response = await world.dp.fetchHttp(
        soapRequest(world.api.key!, "urn:apim:petstore:AddPet"),
        "127.0.0.1",
      );
      expect(response.status).toBe(400);
      const text = await response.text();
      expect(text).toContain("<soap:Fault>");
      expect(text).toContain("disagrees with the body");
      expect(world.backend.stats.requests).toBe(0);
    } finally {
      world.stop();
    }
  });

  test("a body element that is not an operation of this API is refused", async () => {
    const world = await soapWorld();
    try {
      const response = await world.dp.fetchHttp(
        soapRequest(
          world.api.key!,
          "urn:apim:petstore:GetPet",
          envelope(`<tns:DeleteEverything xmlns:tns="${PETSTORE_NS}"/>`),
        ),
        "127.0.0.1",
      );
      expect(response.status).toBe(400);
      expect(await response.text()).toContain("is not an operation of this API");
    } finally {
      world.stop();
    }
  });

  test("a non-XML content type is 415, as a fault", async () => {
    const world = await soapWorld();
    try {
      const response = await world.dp.fetchHttp(
        new Request("http://gw/it/solution/petstore-soap", {
          method: "POST",
          headers: { "content-type": "application/json", "x-api-key": world.api.key! },
          body: "{}",
        }),
        "127.0.0.1",
      );
      expect(response.status).toBe(415);
      expect(response.headers.get("content-type")).toContain("text/xml");
      expect(await response.text()).toContain("soap:Client");
    } finally {
      world.stop();
    }
  });

  test("every gateway rejection on a soap route is a fault with the real status", async () => {
    const world = await soapWorld();
    try {
      const noKey = await world.dp.fetchHttp(soapRequest(null, "urn:apim:petstore:GetPet"), "127.0.0.1");
      expect(noKey.status).toBe(401);
      expect(await noKey.text()).toContain("<soap:Fault>");

      // Two calls are allowed, the third is not — and it is still a fault, with Retry-After.
      await world.dp.fetchHttp(soapRequest(world.api.key!, "urn:apim:petstore:GetPet"), "127.0.0.1");
      await world.dp.fetchHttp(soapRequest(world.api.key!, "urn:apim:petstore:GetPet"), "127.0.0.1");
      const limited = await world.dp.fetchHttp(
        soapRequest(world.api.key!, "urn:apim:petstore:GetPet"),
        "127.0.0.1",
      );
      expect(limited.status).toBe(429);
      expect(limited.headers.get("retry-after")).toBeTruthy();
      expect(limited.headers.get("content-type")).toContain("text/xml");
      const text = await limited.text();
      expect(text).toContain("<apim:status>429</apim:status>");
      expect(text).toContain("rate limit of 2 calls");
    } finally {
      world.stop();
    }
  });

  /**
   * The envelope scan reads a bounded prefix to find the body's first child and then stops; the
   * rest of the envelope is never held. With validation off, that is the whole request path, so
   * a 40 KB body reaches the backend without this process ever having all of it.
   */
  test("an envelope larger than the scan prefix still streams to the backend", async () => {
    // Turning validation off needs a stated reason (design section 5.1); it is audited and listed.
    const world = await soapWorld({
      validate: {
        request: "disabled",
        response: "disabled",
        downgradeReason: "this test asserts the streaming path, which is what runs when nothing buffers",
      },
    });
    try {
      const padding = "<tns:pad>" + "x".repeat(40_000) + "</tns:pad>";
      const big = envelope(
        `<tns:GetPetRequest xmlns:tns="${PETSTORE_NS}"><tns:petId>1</tns:petId>${padding}</tns:GetPetRequest>`,
      );
      expect(big.length).toBeGreaterThan(8192);
      const response = await world.dp.fetchHttp(
        soapRequest(world.api.key!, "urn:apim:petstore:GetPet", big),
        "127.0.0.1",
      );
      expect(response.status).toBe(200);
      expect(world.backend.stats.bytesIn).toBeGreaterThan(40_000);
    } finally {
      world.stop();
    }
  });

  /**
   * The same envelope, with validation at its default. The scan prefix decided which operation
   * this is; the XSD decides whether the body is that operation — and `<pad>` is not in
   * `GetPetRequest`'s sequence, however far past the prefix it appears.
   */
  test("past the scan prefix, blocking validation still sees the whole body", async () => {
    const world = await soapWorld();
    try {
      const padding = "<tns:pad>" + "x".repeat(40_000) + "</tns:pad>";
      const big = envelope(
        `<tns:GetPetRequest xmlns:tns="${PETSTORE_NS}"><tns:petId>1</tns:petId>${padding}</tns:GetPetRequest>`,
      );
      const response = await world.dp.fetchHttp(
        soapRequest(world.api.key!, "urn:apim:petstore:GetPet", big),
        "127.0.0.1",
      );
      expect(response.status).toBe(400);
      // A rejection on a soap route is a fault carrying the real status (design section 5).
      const text = await response.text();
      expect(text).toContain("Fault");
      expect(world.backend.stats.requests).toBe(0);
    } finally {
      world.stop();
    }
  });

  test("errorFormat is resolved into the config, so the data plane computes no defaults", async () => {
    const world = await soapWorld();
    try {
      const route = world.dp.client.table!.routes[0]!;
      expect(route.kind).toBe("soap");
      expect(route.policy.errorFormat).toEqual({ shape: "soap-fault", soapVersion: "1.1" });
      expect(route.soap!.operations.map((o) => o.operationId).sort()).toEqual(["AddPet", "GetPet"]);
    } finally {
      world.stop();
    }
  });

  test("soap-fault cannot be attached to a rest API", async () => {
    const api = await publishApi(cp, { name: "resty", backendUrl: "http://127.0.0.1:9999" });
    const response = await cp.call(
      `PUT`,
      `/api/resources/${api.resourceId}/policy/units/errorFormat`,
      { cookie: api.pavel, body: { value: { shape: "soap-fault", soapVersion: "1.1" } } },
    );
    expect(response.status).toBe(400);
    expect((await response.json()).detail).toContain("only valid on a soap API");
  });

  test("a WSDL cannot be uploaded to a rest API, and JSON cannot be uploaded to a soap one", async () => {
    const rest = await publishApi(cp, { name: "restonly", backendUrl: "http://127.0.0.1:9999" });
    const wrongWsdl = await cp.call("POST", `/api/resources/${rest.resourceId}/revisions`, {
      cookie: rest.pavel,
      body: { spec: WSDL },
    });
    expect(wrongWsdl.status).toBe(400);
    expect((await wrongWsdl.json()).detail).toContain("create a soap API");

    const soapResource = await (
      await cp.call("POST", "/api/resources", {
        cookie: rest.pavel,
        body: { kind: "soap", name: "soaponly", applicationId: "application_platform" },
      })
    ).json();
    const wrongJson = await cp.call("POST", `/api/resources/${soapResource.id}/revisions`, {
      cookie: rest.pavel,
      body: { spec: { swagger: "2.0", info: { title: "x", version: "1" }, paths: {} } },
    });
    expect(wrongJson.status).toBe(400);
    expect((await wrongJson.json()).detail).toContain("must be a WSDL");
  });

  test("a soap revision exports the original WSDL and a generated summary", async () => {
    const world = await soapWorld();
    try {
      const detail = await (
        await cp.call("GET", `/api/resources/${world.api.resourceId}`, { cookie: world.api.pavel })
      ).json();
      const revisionId = detail.revisions[0].id;

      const original = await cp.call("GET", `/api/revisions/${revisionId}/spec?format=original`, {
        cookie: world.api.pavel,
      });
      expect(original.headers.get("content-type")).toContain("text/xml");
      expect(await original.text()).toBe(WSDL);

      const summary = await (
        await cp.call("GET", `/api/revisions/${revisionId}/spec?format=model`, {
          cookie: world.api.pavel,
        })
      ).json();
      expect(summary.kind).toBe("soap");
      expect(summary.operations).toHaveLength(2);
      expect(summary.note).toContain("deviation D13");
    } finally {
      world.stop();
    }
  });
});
