import { describe, expect, test } from "bun:test";
import { lintDefinition, lintSource, validateOpenApi } from "../src/portal/lib/specValidate";

/**
 * What the definition editor tells an author before they publish.
 *
 * The validator was ported from the Azure-APIM-backed predecessor and, until it was wired to a
 * screen, nothing had ever read its messages — so nothing had ever noticed that they described a
 * different product. It warned about a "tested matrix" of OpenAPI 3.0.0–3.0.3 and called 3.1
 * "supported with limitations", neither of which is true of a control plane that normalises 2.0,
 * 3.0 and 3.1 into one model. Meanwhile the two rules that actually get a document refused went
 * unchecked, and an author met both of them as a 400 after the publish wizard had closed.
 *
 * These tests are pinned to `control-plane/src/normalize.ts`: `parseSpecDocument` refuses anything
 * not starting with `{`, and `assertSelfContained` refuses any `$ref` that does not start with
 * `#/`. If those move, these should fail.
 */

const MINIMAL = {
  openapi: "3.0.0",
  info: { title: "checkout", version: "1.0.0" },
  paths: { "/pets": { get: { responses: { "200": { description: "ok" } } } } },
};

const json = (doc: unknown) => JSON.stringify(doc);

describe("the definition checks an author sees while editing", () => {
  test("a clean OpenAPI 3.0 document raises nothing at all", () => {
    expect(lintDefinition(json(MINIMAL)).diagnostics).toEqual([]);
  });

  test("3.1 and Swagger 2.0 are first-class, not second-best", () => {
    // The ported validator warned on both. This control plane accepts `swagger-2.0`,
    // `openapi-3.0` and `openapi-3.1` alike and records the dialect rather than rewriting it, so
    // there is no fidelity claim to make and a warning would only be noise an author learns to skip.
    expect(lintDefinition(json({ ...MINIMAL, openapi: "3.1.0" })).diagnostics).toEqual([]);
    const two = { swagger: "2.0", info: MINIMAL.info, paths: MINIMAL.paths };
    expect(lintDefinition(json(two)).diagnostics).toEqual([]);
  });

  test("a version that is not 3.x, or a Swagger that is not 2.0, is an error", () => {
    const bad = lintDefinition(json({ ...MINIMAL, openapi: "4.0.0" })).diagnostics;
    expect(bad.filter((d) => d.severity === "error")).toHaveLength(1);
    const one = lintDefinition(json({ swagger: "1.2", info: MINIMAL.info, paths: MINIMAL.paths }));
    expect(one.diagnostics.some((d) => d.severity === "error")).toBe(true);
  });

  test("a $ref pointing outside the document is an error, with the path to it", () => {
    // The single most common reason a real exported spec is rejected: they routinely split their
    // schemas across files. `normalize.ts` refuses it as an SSRF vector and an availability
    // dependency, and the editor said nothing about it until now.
    const split = {
      ...MINIMAL,
      paths: {
        "/pets": {
          get: {
            responses: {
              "200": {
                description: "ok",
                content: { "application/json": { schema: { $ref: "./schemas/pet.json" } } },
              },
            },
          },
        },
      },
    };
    const found = lintDefinition(json(split)).diagnostics.filter((d) => d.severity === "error");
    expect(found).toHaveLength(1);
    expect(found[0]!.message).toContain("./schemas/pet.json");
    expect(found[0]!.path?.join(".")).toContain("$ref");
  });

  test("an internal $ref is fine, however deeply it is nested", () => {
    const internal = {
      ...MINIMAL,
      components: { schemas: { Pet: { type: "object" } } },
      paths: {
        "/pets": {
          get: {
            responses: {
              "200": {
                description: "ok",
                content: { "application/json": { schema: { $ref: "#/components/schemas/Pet" } } },
              },
            },
          },
        },
      },
    };
    expect(lintDefinition(json(internal)).diagnostics).toEqual([]);
  });

  test("YAML is refused, and offered a conversion rather than converted behind the author's back", () => {
    // The portal loads CodeMirror's YAML mode and leaves YAML untouched on open, so it reads as a
    // supported input all the way to the 400 at publish. `parseSpecDocument` refuses anything not
    // starting with `{`.
    const yaml = "openapi: 3.0.0\ninfo:\n  title: checkout\n  version: 1.0.0\npaths:\n  /pets:\n    get:\n      responses:\n        '200':\n          description: ok\n";
    const result = lintDefinition(yaml);
    expect(result.format).toBe("yaml");
    expect(result.convertible).toBe(true);
    expect(result.diagnostics[0]!.severity).toBe("error");
    expect(result.diagnostics[0]!.message).toContain("JSON only");
    // `lintSource` is the document's own validity and knows nothing about serialisation, so the
    // same YAML is structurally clean there. The two questions stay separate.
    expect(lintSource(yaml).diagnostics).toEqual([]);
  });

  test("YAML that does not even parse is not offered a conversion", () => {
    const broken = "openapi: 3.0.0\n  info:\n :::\n";
    const result = lintDefinition(broken);
    expect(result.convertible).toBe(false);
    expect(result.diagnostics.some((d) => d.severity === "error")).toBe(true);
  });

  test("an empty document is an error here, and suppressed by the panel rather than by the linter", () => {
    // "There is nothing to publish" is a true thing to say about an API — the attention list says
    // it too. But turning the editor red the instant somebody selects-all and deletes is nagging,
    // and that judgement belongs to the screen, so `DefinitionDiagnostics` renders nothing for
    // blank source and the linter stays honest.
    expect(lintDefinition("").diagnostics).toEqual([
      { severity: "error", message: "Definition is empty." },
    ]);
    expect(lintDefinition("   ").convertible).toBe(false);
  });

  test("no message mentions the product this was ported from", () => {
    // The porting rule in CLAUDE.md, enforced where it was actually broken. Every branch of the
    // validator is reachable from one of these documents.
    const documents: unknown[] = [
      MINIMAL,
      { ...MINIMAL, openapi: "4.0.0" },
      { swagger: "1.2", info: MINIMAL.info, paths: MINIMAL.paths },
      { openapi: "3.0.0" },
      { ...MINIMAL, paths: {} },
      { ...MINIMAL, components: 7 },
      { ...MINIMAL, definitions: 7 },
      { ...MINIMAL, servers: "not-an-array" },
      { ...MINIMAL, info: {} },
      "not an object",
    ];
    const messages = documents.flatMap((doc) => validateOpenApi(doc)).map((d) => d.message);
    expect(messages.length).toBeGreaterThan(8);
    for (const message of messages) {
      expect(message).not.toContain("APIM");
      expect(message).not.toContain("Azure");
    }
  });
});
