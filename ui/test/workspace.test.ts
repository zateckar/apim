import { describe, expect, test } from "bun:test";
import {
  addressMove,
  dirtyTabs,
  poolBody,
  saveBlockers,
  type WorkspaceEdits,
} from "../src/portal/apis.tsx";
import { humanDuration, MILLISECOND_UNITS, SECOND_UNITS, unitFor } from "../src/portal/PolicyForm.tsx";
import { curlFor, formatBytes } from "../src/views/PlaygroundPanel.tsx";
import { initialMinutes, rangeOf } from "../src/views/LogsPanel.tsx";
import { diagnosticChip, diffChangeChip, httpStatusChip, localityChip, schemaStateChip } from "../src/lib/status.ts";
import { skillsOf, toolsOf, validationStateOf } from "../src/portal/components/OperationsCard.tsx";

/**
 * The API workspace's decisions, as opposed to its markup: what Save would write, what stops it,
 * whether a save moves the address, and the few formatters every tab of it shares.
 *
 * Each of these used to be an expression inside a render function, which is how the Save button
 * came to be blocked by a field on a different tab without saying so, and how the properties tab
 * warned about a move from `/checkout/v2` to `/checkout/v2`.
 */

const STORED: WorkspaceEdits = {
  description: "Orders.",
  docsUrl: "",
  domain: "sales",
  subdomain: "",
  pool: [{ url: "https://orders.internal" }],
  rule: "failover",
  gateways: ["managed", "onprem"],
  policy: JSON.stringify({ timeoutMs: 5000 }, null, 2),
  certificate: "",
  spec: '{"openapi":"3.0.3","info":{"title":"o","version":"1"},"paths":{}}',
};

describe("what Save would write", () => {
  test("nothing, when nothing changed — including a re-indented definition and a reordered gateway list", () => {
    const edited = {
      ...STORED,
      spec: JSON.stringify(JSON.parse(STORED.spec), null, 2),
      gateways: ["onprem", "managed"],
      policy: '{"timeoutMs":5000}',
    };
    expect(dirtyTabs(edited, STORED, "rest")).toEqual([]);
  });

  test("names each tab that holds an edit, in tab order", () => {
    const edited = {
      ...STORED,
      certificate: "cert_1",
      description: "Orders, and returns.",
      spec: STORED.spec.replace('"paths":{}', '"paths":{"/x":{}}'),
    };
    expect(dirtyTabs(edited, STORED, "rest")).toEqual(["definition", "properties", "policies"]);
  });

  test("an empty backend row is not an edit", () => {
    const edited = { ...STORED, pool: [...STORED.pool, { url: "  " }] };
    expect(dirtyTabs(edited, STORED, "rest")).toEqual([]);
    expect(poolBody(edited.pool, "failover")).toEqual([{ url: "https://orders.internal" }]);
  });

  test("a weight is carried only under round-robin, and only when it is not 1", () => {
    const pool = [{ url: "https://a", weight: 1 }, { url: "https://b", weight: 3 }];
    expect(poolBody(pool, "round-robin")).toEqual([{ url: "https://a" }, { url: "https://b", weight: 3 }]);
    expect(poolBody(pool, "failover")).toEqual([{ url: "https://a" }, { url: "https://b" }]);
  });
});

describe("what stops Save, and where", () => {
  const ok = {
    domain: "sales",
    docsUrl: "",
    pool: STORED.pool,
    policy: STORED.policy,
    spec: STORED.spec,
    kind: "rest",
    definitionChanged: false,
  };

  test("nothing, for a valid workspace", () => {
    expect(saveBlockers(ok)).toEqual([]);
  });

  test("each problem names the tab it is on", () => {
    const blockers = saveBlockers({
      ...ok,
      domain: "",
      docsUrl: "wiki",
      pool: [{ url: "https://fine" }, { url: "not a url" }],
      policy: "{ nope",
      spec: "openapi: [",
      definitionChanged: true,
    });
    expect(blockers.map((b) => b.tab)).toEqual([
      "definition",
      "properties",
      "properties",
      "properties",
      "policies",
    ]);
    expect(blockers[3]!.reason).toStartWith("Backend 2:");
  });

  test("an unchanged definition is not judged — it is not sent", () => {
    expect(saveBlockers({ ...ok, spec: "openapi: [" })).toEqual([]);
  });

  test("a WSDL is left to the server, which has the parser for it", () => {
    expect(saveBlockers({ ...ok, kind: "soap", spec: "<definitions", definitionChanged: true })).toEqual([]);
  });

  test("a policy has to be an object, not merely JSON", () => {
    expect(saveBlockers({ ...ok, policy: "[]" }).map((b) => b.tab)).toEqual(["policies"]);
  });
});

describe("whether a save moves the address", () => {
  test("no move when the address is the same, whatever the trailing slash", () => {
    expect(addressMove("/sales/orders/v1", "/sales/orders/v1/")).toBeNull();
  });

  test("no move before there is an address on both sides", () => {
    expect(addressMove(null, "/sales/orders/v1")).toBeNull();
    expect(addressMove("/orders/v1", "")).toBeNull();
  });

  test("a move from a legacy path, and from one domain to another", () => {
    expect(addressMove("/orders/v1", "/sales/orders/v1")).toEqual({ from: "/orders/v1", to: "/sales/orders/v1" });
    expect(addressMove("/sales/orders/v1", "/finance/orders/v1")).not.toBeNull();
  });
});

describe("durations and sizes in the units people read", () => {
  test("a duration opens in the largest unit it is a whole number of", () => {
    expect(unitFor(2_592_000, SECOND_UNITS)).toBe("d");
    expect(unitFor(60, SECOND_UNITS)).toBe("min");
    expect(unitFor(90, SECOND_UNITS)).toBe("s");
    expect(unitFor(30_000, MILLISECOND_UNITS)).toBe("s");
    expect(unitFor(0, SECOND_UNITS)).toBe("s");
  });

  test("a policy summary says 30d, not 2592000s", () => {
    expect(humanDuration(2_592_000)).toBe("30d");
    expect(humanDuration(3_600)).toBe("1h");
    expect(humanDuration(90)).toBe("90s");
    expect(humanDuration("x")).toBe("?");
  });

  test("bytes", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(64 * 1024)).toBe("64 KB");
    expect(formatBytes(2 * 1024 * 1024)).toBe("2 MB");
  });
});

describe("the playground's curl line", () => {
  const call = {
    method: "POST",
    url: "https://gw.example/sales/orders/v1/orders/{id}",
    pathParams: { id: "a b" },
    query: [
      { name: "expand", value: "lines", enabled: true },
      { name: "off", value: "x", enabled: false },
    ],
    headers: [{ name: "Content-Type", value: "application/json", enabled: true }],
    body: `{"note":"it's"}`,
  };

  test("never carries a key, only a placeholder where the policy wants one", () => {
    const line = curlFor({ ...call, key: { in: "header", name: "Ocp-Key" } });
    expect(line).toContain("-H 'Ocp-Key: <subscription-key>'");
    expect(line).toStartWith("curl -X POST 'https://gw.example/sales/orders/v1/orders/a%20b?expand=lines'");
    expect(line).not.toContain("off=x");
    // A quote inside the body is closed, escaped and reopened, so the line pastes as one argument.
    expect(line).toContain(`--data-raw '{"note":"it'\\''s"}'`);
  });

  test("a key in the query goes in the query", () => {
    const line = curlFor({ ...call, body: null, key: { in: "query", name: "key" } });
    expect(line).toContain("expand=lines&key=<subscription-key>");
    expect(line).not.toContain("--data-raw");
  });
});

describe("the request log window", () => {
  test("a preset reads as pressed only when the window is exactly it", () => {
    const to = Date.now();
    expect(rangeOf({ from: to - 60 * 60_000, to })).toBe("1h");
    expect(rangeOf({ from: to - 61 * 60_000, to })).toBe("custom");
  });

  test("a dashboard drill-down opens on the window it was counted over, snapped to a preset", () => {
    expect(initialMinutes("")).toBe(60);
    expect(initialMinutes("?tab=logs&sinceMin=15")).toBe(15);
    expect(initialMinutes("?sinceMin=1440")).toBe(1440);
    expect(initialMinutes("?sinceMin=300")).toBe(360);
    expect(initialMinutes("?sinceMin=nonsense")).toBe(60);
  });
});

describe("the workspace's chips", () => {
  test("a status says what happened, and a redirect is not a warning", () => {
    expect(httpStatusChip(200).tone).toBe("live");
    expect(httpStatusChip(302).tone).toBe("neutral");
    expect(httpStatusChip(404).tone).toBe("warn");
    expect(httpStatusChip(503).tone).toBe("stop");
    expect(httpStatusChip(null).label).toBe("No response");
    expect(httpStatusChip(200, { error: "timeout" }).label).toBe("No response");
  });

  test("a diff's tone is whether it breaks callers", () => {
    expect(diffChangeChip("removed", true).tone).toBe("stop");
    expect(diffChangeChip("added", false).tone).toBe("live");
    expect(diffChangeChip("changed", false).label).toBe("Changed");
  });

  test("severity and gateway state", () => {
    expect(diagnosticChip("error").tone).toBe("stop");
    expect(diagnosticChip("info").tone).toBe("neutral");
    expect(localityChip({ paused: false })).toBeNull();
    expect(localityChip({ paused: true })?.label).toBe("Paused");
  });
});

describe("what the definition declares, beside it", () => {
  const saved = [
    { id: "listPets", method: "GET", template: "/pets", schemaState: "ok" },
    { id: "addPet", method: "POST", template: "/pets", schemaState: "no-schema" },
    { id: "GetQuote", method: "POST", template: "/", schemaState: "unsupported-schema" },
    { id: "tools/call:search", method: "POST", template: "/", selector: "tools/call:search", schemaState: "ok" },
  ];

  test("a REST operation is found by method and path template, the way the gateway routes it", () => {
    expect(validationStateOf(saved, { method: "get", path: "/pets" })).toBe("ok");
    expect(validationStateOf(saved, { method: "POST", path: "/pets" })).toBe("no-schema");
  });

  test("a SOAP operation by its name and an MCP tool by its selector", () => {
    expect(validationStateOf(saved, { id: "GetQuote" })).toBe("unsupported-schema");
    expect(validationStateOf(saved, { selector: "tools/call:search" })).toBe("ok");
  });

  test("an operation the saved definition does not have yet has no state rather than a guessed one", () => {
    expect(validationStateOf(saved, { method: "DELETE", path: "/pets/{id}" })).toBeNull();
    expect(validationStateOf(saved, { selector: "tools/call:new-tool" })).toBeNull();
  });

  test("tools and skills are read from the draft on screen, and a malformed entry is skipped", () => {
    expect(toolsOf({ tools: [{ name: "search" }, { description: "no name" }] }).map((t) => t.name)).toEqual(["search"]);
    expect(toolsOf(null)).toEqual([]);
    expect(skillsOf({ skills: [{ id: "summarise", name: "Summarise" }, { name: "no id" }] }).map((s) => s.id)).toEqual([
      "summarise",
    ]);
  });

  test("a validated operation says so in words, like the ones that are not", () => {
    expect(schemaStateChip("ok").label).toBe("Validated");
    expect(schemaStateChip("no-schema").label).toBe("No schema");
  });
});
