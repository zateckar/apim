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
 * Exact segments beat parameters, and among equally specific candidates the one declared first
 * wins — the model's operations are sorted deterministically at normalization, so "first" is
 * stable across instances and across restarts.
 */
export function matchOperation<T extends OperationRef>(
  operations: readonly T[],
  method: string,
  relativePath: string,
): OperationMatch<T> | null {
  const wanted = method.toUpperCase();
  const parts = segmentsOf(relativePath);
  let best: OperationMatch<T> | null = null;
  let bestScore = -1;

  for (const operation of operations) {
    const opMethod = operation.method.toUpperCase();
    // A HEAD is a GET whose body is discarded; a contract that declares only GET still describes it.
    const methodOk = opMethod === wanted || (wanted === "HEAD" && opMethod === "GET");
    if (!methodOk) continue;

    const template = segmentsOf(operation.template);
    if (template.length !== parts.length) continue;

    const params: Record<string, string> = {};
    let score = 0;
    let ok = true;
    for (let i = 0; i < template.length; i++) {
      const declared = template[i]!;
      const actual = parts[i]!;
      if (isParam(declared)) {
        params[declared.slice(1, -1)] = safeDecode(actual);
        continue;
      }
      if (declared !== actual) {
        ok = false;
        break;
      }
      score++;
    }
    if (!ok) continue;
    // An exact-method match outranks the HEAD→GET fallback at equal specificity.
    const total = score * 2 + (opMethod === wanted ? 1 : 0);
    if (total > bestScore) {
      bestScore = total;
      best = { operation, params };
    }
  }
  return best;
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
