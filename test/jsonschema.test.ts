import { describe, expect, test } from "bun:test";
import { JsonError, readJsonBounded } from "../shared/json-reader.ts";
import {
  coerceParameter,
  formatError,
  SchemaCompiler,
  SchemaUnsupported,
  validate,
  type JsonSchemaNode,
} from "../shared/jsonschema.ts";
import { matchOperation, renderPathTemplate } from "../shared/opmatch.ts";

/** Compiles one schema against an empty component set and returns what the runtime would walk. */
function compile(
  schema: unknown,
  dialect: "2020-12" | "oas-3.0" | "swagger-2.0" = "2020-12",
  components: Record<string, unknown> = {},
) {
  const compiler = new SchemaCompiler({ dialect, components });
  const ref = compiler.hoist(schema, "test");
  return { node: compiler.defs[ref]!, defs: compiler.defs };
}

function check(schema: unknown, value: unknown, dialect: "2020-12" | "oas-3.0" = "2020-12") {
  const { node, defs } = compile(schema, dialect);
  return validate(value, node, defs);
}

describe("the bounded JSON reader (design section 5.1 `always`)", () => {
  test("reads what JSON.parse reads", () => {
    const text = '{"a":[1,2,{"b":"x"}],"c":null,"d":true,"e":-1.5e3}';
    expect(readJsonBounded(text)).toEqual(JSON.parse(text));
  });

  test("refuses duplicate keys, which JSON.parse silently collapses", () => {
    expect(JSON.parse('{"a":1,"a":2}')).toEqual({ a: 2 });
    expect(() => readJsonBounded('{"a":1,"a":2}')).toThrow(/duplicate object key "a"/);
    // The policy is a setting, because a backend that tolerates them may need to be reached.
    expect(readJsonBounded('{"a":1,"a":2}', { duplicateKeys: "last-wins" })).toEqual({ a: 2 });
  });

  test("bounds depth, array length and object width", () => {
    const deep = "[".repeat(40) + "1" + "]".repeat(40);
    expect(() => readJsonBounded(deep, { maxDepth: 32 })).toThrow(/nested deeper than 32/);
    expect(() => readJsonBounded("[1,2,3,4]", { maxArrayLength: 3 })).toThrow(/longer than 3 elements/);
    expect(() => readJsonBounded('{"a":1,"b":2}', { maxObjectKeys: 1 })).toThrow(/more than 1 keys/);
  });

  test("refuses unescaped control characters and trailing content", () => {
    expect(() => readJsonBounded('"a\nb"')).toThrow(/unescaped control character/);
    expect(() => readJsonBounded("{} {}")).toThrow(/trailing content/);
    expect(() => readJsonBounded("{")).toThrow(JsonError);
  });

  test("reports a JSON pointer to the offending value", () => {
    try {
      readJsonBounded('{"pets":[{"id":1},{"id":[1,2,3]}]}', { maxArrayLength: 2 });
      throw new Error("expected a throw");
    } catch (err) {
      expect((err as JsonError).path).toBe("/pets/1/id");
    }
  });
});

describe("the JSON Schema subset", () => {
  test("type, including the integer/number distinction", () => {
    expect(check({ type: "integer" }, 3).ok).toBe(true);
    expect(check({ type: "integer" }, 3.5).ok).toBe(false);
    expect(check({ type: "number" }, 3.5).ok).toBe(true);
    expect(check({ type: ["string", "null"] }, null).ok).toBe(true);
    const bad = check({ type: "string" }, 7);
    expect(bad.issues[0]).toMatchObject({ rule: "type", path: "/" });
    expect(bad.issues[0]!.message).toContain("expected string, got integer");
  });

  test("object keywords and JSON pointers into the failure", () => {
    const schema = {
      type: "object",
      required: ["name", "id"],
      properties: { name: { type: "string", minLength: 2 }, id: { type: "integer", minimum: 1 } },
      additionalProperties: false,
    };
    expect(check(schema, { name: "rex", id: 1 }).ok).toBe(true);
    expect(check(schema, { name: "r", id: 1 }).issues[0]).toMatchObject({
      path: "/name",
      rule: "minLength",
    });
    expect(check(schema, { name: "rex" }).issues[0]).toMatchObject({ path: "/id", rule: "required" });
    // additionalProperties:false compiles to `not: {}`, so an extra key is reported against itself.
    expect(check(schema, { name: "rex", id: 1, extra: 1 }).issues[0]!.path).toBe("/extra");
  });

  test("a pointer segment escapes / and ~ per RFC 6901", () => {
    const result = check(
      { type: "object", properties: { "a/b": { type: "integer" } } },
      { "a/b": "no" },
    );
    expect(result.issues[0]!.path).toBe("/a~1b");
  });

  test("array keywords", () => {
    expect(check({ type: "array", items: { type: "integer" }, minItems: 2 }, [1]).issues[0]).toMatchObject({
      rule: "minItems",
    });
    expect(check({ type: "array", uniqueItems: true }, [{ a: 1 }, { a: 1 }]).ok).toBe(false);
    expect(check({ type: "array", items: { type: "integer" } }, [1, "x"]).issues[0]!.path).toBe("/1");
    expect(
      check({ type: "array", prefixItems: [{ type: "string" }], items: { type: "integer" } }, ["a", 1]).ok,
    ).toBe(true);
    expect(check({ type: "array", contains: { const: 3 }, minContains: 2 }, [3, 1]).ok).toBe(false);
  });

  test("numeric keywords, in both exclusive forms", () => {
    expect(check({ type: "integer", exclusiveMinimum: 0 }, 0).issues[0]).toMatchObject({
      rule: "exclusiveMinimum",
    });
    // OAS 3.0 writes it as a boolean beside `minimum`; the compiler converts once (design 4.1).
    expect(check({ type: "integer", minimum: 0, exclusiveMinimum: true }, 0, "oas-3.0").ok).toBe(false);
    expect(check({ type: "integer", minimum: 0, exclusiveMinimum: true }, 1, "oas-3.0").ok).toBe(true);
    expect(check({ type: "number", multipleOf: 0.1 }, 0.3).ok).toBe(true);
    expect(check({ type: "number", multipleOf: 0.1 }, 0.35).ok).toBe(false);
  });

  test("applicators", () => {
    expect(check({ allOf: [{ type: "integer" }, { minimum: 5 }] }, 4).ok).toBe(false);
    expect(check({ anyOf: [{ type: "string" }, { type: "integer" }] }, true).issues[0]).toMatchObject({
      rule: "anyOf",
    });
    expect(check({ oneOf: [{ type: "integer" }, { minimum: 0 }] }, 5).issues[0]!.message).toContain(
      "matched 2",
    );
    expect(check({ not: { type: "string" } }, "x").ok).toBe(false);
    const conditional = { if: { type: "integer" }, then: { minimum: 10 }, else: { type: "string" } };
    expect(check(conditional, 5).ok).toBe(false);
    expect(check(conditional, 11).ok).toBe(true);
    expect(check(conditional, "hello").ok).toBe(true);
  });

  test("nullable is an OAS 3.0 spelling, resolved at compile time", () => {
    expect(check({ type: "string", nullable: true }, null, "oas-3.0").ok).toBe(true);
    expect(check({ type: "string", nullable: true }, null, "2020-12").ok).toBe(false);
  });

  test("$ref resolves inside the document, and a recursive schema terminates", () => {
    const components = {
      components: {
        schemas: {
          Node: {
            type: "object",
            properties: { value: { type: "integer" }, next: { $ref: "#/components/schemas/Node" } },
          },
        },
      },
    };
    const compiler = new SchemaCompiler({ dialect: "oas-3.0", components });
    const ref = compiler.hoist({ $ref: "#/components/schemas/Node" }, "test");
    const node = compiler.defs[ref]!;
    expect(validate({ value: 1, next: { value: 2 } }, node, compiler.defs).ok).toBe(true);
    expect(validate({ value: 1, next: { value: "x" } }, node, compiler.defs).issues[0]!.path).toBe(
      "/next/value",
    );
  });

  test("a $ref outside the document is refused at compile time (design section 5.3)", () => {
    expect(() => compile({ $ref: "https://elsewhere/schema.json" })).toThrow(SchemaUnsupported);
    expect(() => compile({ $ref: "#/components/schemas/Missing" })).toThrow(/does not resolve/);
  });

  test("unsupported keywords are refused, not ignored", () => {
    for (const keyword of ["unevaluatedProperties", "dependentRequired", "$dynamicRef", "contentSchema"]) {
      expect(() => compile({ [keyword]: {} })).toThrow(SchemaUnsupported);
    }
    // Annotations are ignored, because they assert nothing.
    expect(compile({ title: "x", description: "y", example: 1, "x-vendor": true }).node).toEqual({});
  });

  test("patterns are linted at compile time, because JS regexes backtrack (deviation D8)", () => {
    expect(() => compile({ type: "string", pattern: "(a+)+$" })).toThrow(SchemaUnsupported);
    expect(() => compile({ type: "object", patternProperties: { "(a+)+": {} } })).toThrow(SchemaUnsupported);
    expect(check({ type: "string", pattern: "^[a-z]+$" }, "abc").ok).toBe(true);
    expect(check({ type: "string", pattern: "^[a-z]+$" }, "ABC").ok).toBe(false);
  });

  test("a long value is not matched against a pattern at all", () => {
    const { node, defs } = compile({ type: "string", pattern: "^[a-z]+$" });
    const result = validate("a".repeat(5000), node, defs, { maxPatternInputBytes: 1024 });
    expect(result.issues[0]!.message).toContain("was not matched");
  });

  test("errors are bounded and say so [R3-07]", () => {
    const schema = { type: "array", items: { type: "integer" } };
    const value = new Array(100).fill("x");
    const result = check(schema, value);
    expect(result.issues).toHaveLength(20);
    expect(result.truncated).toBe(true);
  });

  test("formats", () => {
    expect(formatError("date", "2026-02-30")).toContain("not an RFC 3339 date");
    expect(formatError("date", "2026-02-28")).toBeNull();
    expect(formatError("date-time", "2026-09-01T10:00:00Z")).toBeNull();
    expect(formatError("uuid", "not-a-uuid")).not.toBeNull();
    expect(formatError("ipv4", "10.0.0.1")).toBeNull();
    expect(formatError("ipv4", "10.0.0.256")).not.toBeNull();
    expect(formatError("ipv6", "::1")).toBeNull();
    expect(formatError("int32", 2 ** 40)).not.toBeNull();
    // An unknown format is an annotation and asserts nothing.
    expect(formatError("iban", "anything")).toBeNull();
  });

  test("swagger 2.0 definitions resolve the same way", () => {
    const components = { definitions: { Pet: { type: "object", required: ["id"] } } };
    const compiler = new SchemaCompiler({ dialect: "swagger-2.0", components });
    const ref = compiler.hoist({ $ref: "#/definitions/Pet" }, "test");
    expect(validate({}, compiler.defs[ref]!, compiler.defs).ok).toBe(false);
  });
});

describe("parameter coercion", () => {
  test("a declared integer parameter arrives as a string and is still an integer", () => {
    const { node } = compile({ type: "integer" }) as { node: JsonSchemaNode };
    expect(coerceParameter("42", node)).toBe(42);
    expect(coerceParameter("abc", node)).toBe("abc");
    expect(coerceParameter("true", compile({ type: "boolean" }).node)).toBe(true);
    expect(coerceParameter("a,b", compile({ type: "array", items: { type: "string" } }).node)).toEqual([
      "a",
      "b",
    ]);
    expect(coerceParameter("1,2", compile({ type: "array", items: { type: "integer" } }).node)).toEqual([
      1, 2,
    ]);
    // A string parameter is never touched, so a comma stays a comma.
    expect(coerceParameter("a,b", compile({ type: "string" }).node)).toBe("a,b");
  });
});

describe("operation matching", () => {
  const operations = [
    { id: "listPets", method: "GET", template: "/pets" },
    { id: "getPet", method: "GET", template: "/pets/{petId}" },
    { id: "getPetOwner", method: "GET", template: "/pets/{petId}/owner" },
    { id: "getPetMine", method: "GET", template: "/pets/mine" },
    { id: "addPet", method: "POST", template: "/pets" },
  ];

  test("static segments beat parameters", () => {
    expect(matchOperation(operations, "GET", "/pets/mine")!.operation.id).toBe("getPetMine");
    const byId = matchOperation(operations, "GET", "/pets/7")!;
    expect(byId.operation.id).toBe("getPet");
    expect(byId.params).toEqual({ petId: "7" });
  });

  test("method and arity are part of the match", () => {
    expect(matchOperation(operations, "POST", "/pets")!.operation.id).toBe("addPet");
    expect(matchOperation(operations, "DELETE", "/pets")).toBeNull();
    expect(matchOperation(operations, "GET", "/pets/7/owner/extra")).toBeNull();
    // HEAD is a GET whose body is discarded.
    expect(matchOperation(operations, "HEAD", "/pets")!.operation.id).toBe("listPets");
  });

  test("path parameters are decoded, and rendering re-encodes them", () => {
    expect(matchOperation(operations, "GET", "/pets/a%2Fb")!.params.petId).toBe("a/b");
    expect(renderPathTemplate("/{petId}/description", { petId: "a/b" })).toBe("/a%2Fb/description");
    expect(renderPathTemplate("/{missing}/x", {})).toBe("//x");
  });
});
