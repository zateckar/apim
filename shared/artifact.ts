/**
 * The compiled validation bundle of design section 8.7 — the second channel between the planes.
 *
 * Schemas reach megabytes. Inlining them in the config document of section 8.5 would make it
 * hundreds of megabytes and re-download all of it on any change, so they travel separately,
 * content-addressed and immutable: a digest never changes meaning, so there is no invalidation
 * logic, only eviction.
 *
 * Everything here is a *compiled* form — `$ref`s resolved, patterns linted, XSD derivation chains
 * flattened — which is what lets the rule hold that **the data plane never parses OpenAPI or
 * WSDL**. It consumes a routing table and this.
 */
import type { JsonSchemaNode } from "./jsonschema.ts";
import type { XsdBundle } from "./xsd.ts";

/**
 * Why an operation is or is not validated. Three states rather than two, because "there is no
 * schema to check against" and "there is one this validator will not claim to check" are
 * different facts and both belong in `GET /api/validation/downgrades` (plan `[R1-14]`, `[R1-15]`).
 */
export type SchemaState = "ok" | "no-schema" | "unsupported-schema";

export interface CompiledParameter {
  name: string;
  in: "path" | "query" | "header" | "cookie";
  required: boolean;
  /** A key into `defs`. Absent means the parameter is declared but carries no schema. */
  ref?: string;
}

export interface CompiledResponse {
  /** Media type → a key into `defs`. */
  content?: Record<string, string>;
  headers?: CompiledParameter[];
}

export interface OperationSchemas {
  state: SchemaState;
  /** Why, when the state is not `ok`. Surfaced verbatim in the governance report. */
  reason?: string;
  parameters?: CompiledParameter[];
  request?: { required: boolean; content: Record<string, string> };
  /** Keyed by status code or `default`. */
  responses?: Record<string, CompiledResponse>;
  /** `xsd-set` only: the element the request and response bodies must be. */
  inputElement?: string;
  outputElement?: string;
}

export interface ValidationArtifact {
  kind: "json-schema" | "xsd-set";
  /** `json-schema`: every schema the operations reference, flat and `$ref`-resolved. */
  defs?: Record<string, JsonSchemaNode>;
  /** `xsd-set`: the compiled schema set. */
  xsd?: XsdBundle;
  operations: Record<string, OperationSchemas>;
}

export interface ArtifactRef {
  digest: string;
  kind: ValidationArtifact["kind"];
  sizeBytes: number;
}
