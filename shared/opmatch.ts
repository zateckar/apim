/**
 * Operation resolution for REST routes: which declared operation is this request?
 *
 * Design section 5.2 puts it at step 11 — after authentication, authorization and the limits, and
 * before validation — so unauthenticated traffic can never make the gateway do this work. It is
 * what per-operation policy (design section 5), per-operation validation (5.1) and the
 * `${path.<param>}` template variables (5.6) all resolve against.
 *
 * The path matched is the request path with the route's base path removed, because an operation's
 * template is declared relative to the API's server URL and the base path is this platform's
 * choice, not the contract's.
 */

export interface OperationRef {
  id: string;
  method: string;
  /** As declared, e.g. `/pet/{petId}`. */
  template: string;
}

export interface OperationMatch<T extends OperationRef = OperationRef> {
  operation: T;
  /** Path template variables, decoded — what `${path.<name>}` renders from. */
  params: Record<string, string>;
}

function segmentsOf(path: string): string[] {
  return path.split("/").filter((s) => s.length > 0);
}

function isParam(segment: string): boolean {
  return segment.length > 2 && segment.startsWith("{") && segment.endsWith("}");
}

/**
 * One operation with everything that depends only on its *declaration* already worked out: the
 * method uppercased, the template split, each segment's variable name extracted, and the
 * specificity score. A successful match scores exactly the template's literal count — the request
 * cannot change it, because a request that disagreed with a literal is not a match at all — so the
 * score is a property of the declaration too.
 */
interface CompiledOperation<T extends OperationRef> {
  operation: T;
  method: string;
  segments: string[];
  /** `params[i]` is the variable name at segment `i`, or `null` where the segment is a literal. */
  params: Array<string | null>;
  /** `literals * 2 + 1` for an exact-method match; the `+ 1` is what outranks the HEAD→GET fallback. */
  score: number;
}

export interface CompiledOperations<T extends OperationRef = OperationRef> {
  /**
   * Candidates by segment count, in declaration order. A request is only ever compared against
   * templates of its own arity, so an API declaring operations at several depths pays for one
   * depth rather than for all of them.
   */
  byArity: Map<number, Array<CompiledOperation<T>>>;
}

/**
 * Splits every template once, for a caller that will match many requests against the same set.
 * The data plane does this per config activation (`RouteTable`), for the same reason it sorts the
 * routes and composes the trust store there: a declaration cannot change between two requests, so
 * re-deriving it on each one is work the request path does not owe.
 */
export function compileOperations<T extends OperationRef>(
  operations: readonly T[],
): CompiledOperations<T> {
  const byArity = new Map<number, Array<CompiledOperation<T>>>();
  for (const operation of operations) {
    const segments = segmentsOf(operation.template);
    const params = segments.map((segment) => (isParam(segment) ? segment.slice(1, -1) : null));
    const literals = params.reduce((count, name) => (name === null ? count + 1 : count), 0);
    const bucket = byArity.get(segments.length);
    const compiled: CompiledOperation<T> = {
      operation,
      method: operation.method.toUpperCase(),
      segments,
      params,
      score: literals * 2 + 1,
    };
    if (bucket) bucket.push(compiled);
    else byArity.set(segments.length, [compiled]);
  }
  return { byArity };
}

/**
 * Exact segments beat parameters, and among equally specific candidates the one declared first
 * wins — the model's operations are sorted deterministically at normalization, so "first" is
 * stable across instances and across restarts.
 *
 * Nothing is allocated per candidate: the variables are read out of the winner once the winner is
 * known, so a request against an API with many operations at its depth allocates one object rather
 * than one per operation it did not match.
 */
export function matchCompiled<T extends OperationRef>(
  compiled: CompiledOperations<T>,
  method: string,
  relativePath: string,
): OperationMatch<T> | null {
  const wanted = method.toUpperCase();
  const parts = segmentsOf(relativePath);
  const candidates = compiled.byArity.get(parts.length);
  if (!candidates) return null;

  let best: CompiledOperation<T> | null = null;
  let bestScore = -1;

  for (const candidate of candidates) {
    const exactMethod = candidate.method === wanted;
    // A HEAD is a GET whose body is discarded; a contract that declares only GET still describes it.
    if (!exactMethod && !(wanted === "HEAD" && candidate.method === "GET")) continue;
    // The score is known before the comparison, so a candidate that could not win is never
    // compared. `>` rather than `>=` is what keeps the first-declared winner on a tie.
    const score = exactMethod ? candidate.score : candidate.score - 1;
    if (score <= bestScore) continue;

    let ok = true;
    for (let i = 0; i < parts.length; i++) {
      if (candidate.params[i] !== null) continue;
      if (candidate.segments[i] !== parts[i]) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    bestScore = score;
    best = candidate;
  }

  if (!best) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < parts.length; i++) {
    const name = best.params[i];
    if (typeof name === "string") params[name] = safeDecode(parts[i]!);
  }
  return { operation: best.operation, params };
}

/**
 * The one-shot form: compiles and matches in the same call. For a caller holding a set it will ask
 * again — every request path — use `compileOperations` once and `matchCompiled` per request.
 */
export function matchOperation<T extends OperationRef>(
  operations: readonly T[],
  method: string,
  relativePath: string,
): OperationMatch<T> | null {
  return matchCompiled(compileOperations(operations), method, relativePath);
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Renders `rewrite.path`, e.g. `/{vin}/description` against the matched operation's parameters.
 * A variable with no value renders empty rather than leaving the literal in the URL, and the
 * result is percent-encoded per segment so a parameter cannot introduce path structure.
 */
export function renderPathTemplate(template: string, params: Record<string, string>): string {
  return template.replace(/\{([A-Za-z0-9_.-]+)\}/g, (_match, name: string) =>
    encodeURIComponent(params[name] ?? ""),
  );
}
