import { canonicalJson, sha256Hex } from "../../shared/canonical.ts";
import type {
  ArtifactRef,
  CompiledParameter,
  CompiledResponse,
  OperationSchemas,
  ValidationArtifact,
} from "../../shared/artifact.ts";
import type { ConfigOperation } from "../../shared/config-doc.ts";
import { SchemaCompiler, SchemaUnsupported } from "../../shared/jsonschema.ts";
import type { ApiModel, ApiOperation } from "../../shared/types.ts";
import { nowIso, type DB } from "./db.ts";

/**
 * Design section 8.7: compiled validators are derived from `model`, content-addressed, immutable,
 * and shipped to the data plane on their own channel.
 *
 * Compiled **when the revision is created**, not at release (plan `[R3-01]`): attaching `validate`
 * to an API that was released months ago has to work, and compiling once per contract is cheaper
 * than once per environment it reaches. A release only references what the revision already has.
 *
 * An operation whose schemas this cannot compile does not stop the API being published — it is
 * marked `unsupported-schema`, is not validated, and is listed beside real downgrades. Silently
 * half-validating would be the worse failure.
 */

/** One compiled bundle's ceiling. A bundle past it is refused rather than shipped. */
export const DEFAULT_ARTIFACT_MAX_BYTES = 8 * 1024 * 1024;

/** A route may carry at most this many operations; past it the index stops being small. */
export const MAX_OPERATIONS_PER_ROUTE = 1000;

/**
 * The compact operation index the config document carries: routing and selection only, never
 * schemas. Derived once, at revision creation, and stored on the revision — the config document is
 * rebuilt on every poll, and parsing a multi-megabyte model per route per poll is the read load
 * design section 13 warns about.
 */
export function buildOperationIndex(
  model: ApiModel,
  states: Record<string, OperationSchemas> = {},
): ConfigOperation[] {
  if (model.operations.length > MAX_OPERATIONS_PER_ROUTE) {
    throw new Error(
      `this contract declares ${model.operations.length} operations, over the ${MAX_OPERATIONS_PER_ROUTE} ` +
        "a single route may carry. Split it into several APIs.",
    );
  }
  return model.operations.map((op) => ({
    id: op.operationId,
    method: op.method,
    template: op.path,
    ...(op.inputElement ? { element: op.inputElement } : {}),
    ...(op.soapAction !== undefined ? { soapAction: op.soapAction } : {}),
    ...(op.selector ? { selector: op.selector } : {}),
    ...(op.summary ? { summary: op.summary } : {}),
    schemaState: states[op.operationId]?.state ?? "no-schema",
  }));
}

export interface CompileResult {
  artifact: ValidationArtifact | null;
  /** Human-readable notes for the import report: operations that will not be validated. */
  notes: string[];
}

export function compileArtifact(model: ApiModel): CompileResult {
  return model.soap ? compileXsdArtifact(model) : compileJsonArtifact(model);
}

// ------------------------------------------------------------------------------- SOAP

function compileXsdArtifact(model: ApiModel): CompileResult {
  const schema = model.soap?.schema;
  const notes: string[] = [];
  const operations: Record<string, OperationSchemas> = {};

  for (const op of model.operations) {
    if (!schema) {
      operations[op.operationId] = {
        state: "no-schema",
        reason: "the WSDL declares no inline schema, so there is nothing to validate against",
      };
      continue;
    }
    const input = op.inputElement;
    if (!input || !schema.elements[input]) {
      operations[op.operationId] = {
        state: "no-schema",
        reason: `the schema declares no global element ${input ?? "(none)"} for this operation`,
      };
      notes.push(`${op.operationId}: its body element is not declared by the inline schema`);
      continue;
    }
    operations[op.operationId] = {
      state: "ok",
      inputElement: input,
      ...(op.outputElement && schema.elements[op.outputElement]
        ? { outputElement: op.outputElement }
        : {}),
    };
  }

  if (!schema) return { artifact: null, notes: ["the WSDL declares no inline schema"] };
  return { artifact: { kind: "xsd-set", xsd: schema, operations }, notes };
}

// ------------------------------------------------------------------------------- REST and RPC

function compileJsonArtifact(model: ApiModel): CompileResult {
  const notes: string[] = [];
  const compiler = new SchemaCompiler({
    dialect: model.schemaDialect ?? "2020-12",
    components: model.components ?? {},
  });
  const operations: Record<string, OperationSchemas> = {};
  let anySchema = false;

  for (const op of model.operations) {
    try {
      const compiled = compileOperation(compiler, op);
      operations[op.operationId] = compiled;
      if (compiled.state === "ok") anySchema = true;
    } catch (err) {
      if (!(err instanceof SchemaUnsupported)) throw err;
      operations[op.operationId] = { state: "unsupported-schema", reason: err.message };
      notes.push(`${op.operationId}: ${err.message}`);
    }
  }

  if (!anySchema && Object.keys(compiler.defs).length === 0) {
    return { artifact: null, notes: [...notes, "the document declares no schemas"] };
  }
  return { artifact: { kind: "json-schema", defs: compiler.defs, operations }, notes };
}

function compileOperation(compiler: SchemaCompiler, op: ApiOperation): OperationSchemas {
  const where = op.operationId;
  const parameters: CompiledParameter[] = [];
  for (const parameter of op.parameters) {
    if (parameter.in !== "path" && parameter.in !== "query" && parameter.in !== "header") continue;
    parameters.push({
      name: parameter.name,
      in: parameter.in,
      required: parameter.required,
      ...(parameter.schema === undefined
        ? {}
        : { ref: compiler.hoist(parameter.schema, `${where}.${parameter.in}.${parameter.name}`) }),
    });
  }

  let request: OperationSchemas["request"];
  if (op.requestBody && Object.keys(op.requestBody.content).length > 0) {
    const content: Record<string, string> = {};
    for (const [mediaType, schema] of Object.entries(op.requestBody.content)) {
      content[mediaType] = compiler.hoist(schema, `${where}.requestBody.${mediaType}`);
    }
    request = { required: op.requestBody.required, content };
  }

  let responses: Record<string, CompiledResponse> | undefined;
  for (const [status, response] of Object.entries(op.responses ?? {})) {
    const entry: CompiledResponse = {};
    if (response.content) {
      const content: Record<string, string> = {};
      for (const [mediaType, schema] of Object.entries(response.content)) {
        content[mediaType] = compiler.hoist(schema, `${where}.responses.${status}.${mediaType}`);
      }
      if (Object.keys(content).length > 0) entry.content = content;
    }
    if (response.headers && response.headers.length > 0) {
      entry.headers = response.headers.map((header) => ({
        name: header.name,
        in: "header" as const,
        required: header.required,
        ...(header.schema === undefined
          ? {}
          : { ref: compiler.hoist(header.schema, `${where}.responses.${status}.${header.name}`) }),
      }));
    }
    if (entry.content || entry.headers) (responses ??= {})[status] = entry;
  }

  const hasSomething =
    request !== undefined || responses !== undefined || parameters.some((p) => p.ref !== undefined);
  if (!hasSomething) {
    return {
      state: "no-schema",
      reason: "the document declares no request body, response or parameter schema for this operation",
      ...(parameters.length > 0 ? { parameters } : {}),
    };
  }
  return {
    state: "ok",
    ...(parameters.length > 0 ? { parameters } : {}),
    ...(request ? { request } : {}),
    ...(responses ? { responses } : {}),
  };
}

// ------------------------------------------------------------------------------- storage

export interface StoredArtifact extends ArtifactRef {
  bytes: string;
}

/**
 * Content-addressed: two revisions whose schemas are identical share one row and one download
 * (design section 4.1). Storage is idempotent, so re-compiling the same model is a no-op.
 */
export function storeArtifact(
  db: DB,
  artifact: ValidationArtifact,
  maxBytes = DEFAULT_ARTIFACT_MAX_BYTES,
): ArtifactRef {
  // Canonical, not `JSON.stringify`: the instance re-hashes the bytes it received and compares them
  // to the digest in its config, on every read. Storing a different serialisation of the same
  // object would make every download fail its integrity check — the name has to be the digest of
  // the bytes actually served, not of an equivalent value.
  const bytes = canonicalJson(artifact);
  const sizeBytes = Buffer.byteLength(bytes, "utf8");
  if (sizeBytes > maxBytes) {
    throw new Error(
      `the compiled validation bundle is ${sizeBytes} bytes, over ARTIFACT_MAX_BYTES (${maxBytes}). ` +
        "Split the contract or raise the ceiling; shipping it would make every gateway download it.",
    );
  }
  const digest = `sha256:${sha256Hex(bytes)}`;
  db.run(
    `INSERT INTO artifact (digest, kind, bytes, size_bytes, created_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (digest) DO NOTHING`,
    [digest, artifact.kind, bytes, sizeBytes, nowIso()],
  );
  return { digest, kind: artifact.kind, sizeBytes };
}

/**
 * Compiles, stores, and derives the operation index in one step — everything a revision needs
 * before it can be released, computed once when the revision is created.
 */
export function compileAndStore(
  db: DB,
  model: ApiModel,
  maxBytes = DEFAULT_ARTIFACT_MAX_BYTES,
): { digest: string | null; index: ConfigOperation[]; notes: string[] } {
  const { artifact, notes } = compileArtifact(model);
  const index = buildOperationIndex(model, artifact?.operations ?? {});
  if (!artifact) return { digest: null, index, notes };
  return { digest: storeArtifact(db, artifact, maxBytes).digest, index, notes };
}

export function readArtifact(db: DB, digest: string): StoredArtifact | null {
  const row = db
    .query<{ digest: string; kind: string; bytes: string; size_bytes: number }, [string]>(
      "SELECT digest, kind, bytes, size_bytes FROM artifact WHERE digest = ?",
    )
    .get(digest);
  if (!row) return null;
  return {
    digest: row.digest,
    kind: row.kind as ValidationArtifact["kind"],
    sizeBytes: row.size_bytes,
    bytes: row.bytes,
  };
}

/**
 * Backfills revisions created before v3, and any whose compilation was deferred. Idempotent and
 * bounded per run, so it is safe to enqueue on every boot (plan section 4).
 */
export function compileMissingArtifacts(db: DB, limit = 50, maxBytes = DEFAULT_ARTIFACT_MAX_BYTES): string {
  const rows = db
    .query<{ id: string; model: string }, [number]>(
      // Never a tombstone: a pruned revision has no model to compile, and picking it up would
      // make the backfill fail for ever on a row that is deliberately empty (plan §7.4).
      `SELECT id, model FROM revision
        WHERE artifact_digest IS NULL AND pruned_at IS NULL ORDER BY created_at LIMIT ?`,
    )
    .all(limit);
  if (rows.length === 0) return "no revision needs a validation bundle";

  let compiled = 0;
  let empty = 0;
  const failures: string[] = [];
  for (const row of rows) {
    try {
      const model = JSON.parse(row.model) as ApiModel;
      const { digest, index } = compileAndStore(db, model, maxBytes);
      // The sentinel `''` says "compiled, nothing to compile", so the backfill does not retry the
      // same revision on every boot forever.
      db.run("UPDATE revision SET artifact_digest = ?, index_json = ? WHERE id = ?", [
        digest ?? "",
        JSON.stringify(index),
        row.id,
      ]);
      if (digest) compiled++;
      else empty++;
    } catch (err) {
      db.run("UPDATE revision SET artifact_digest = '', index_json = '[]' WHERE id = ?", [row.id]);
      failures.push(`${row.id}: ${(err as Error).message}`);
    }
  }
  return (
    `compiled ${compiled} validation bundle(s), ${empty} revision(s) declare no schema` +
    (failures.length > 0 ? `, ${failures.length} failed (${failures[0]})` : "")
  );
}
