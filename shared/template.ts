/**
 * The closed template-variable set of design section 5.6: substitution only, no arithmetic, no
 * function calls, no user-defined variables. An unknown `${...}` is a write-time validation
 * error, never an empty render.
 *
 * Three families are *prefixed* rather than enumerated, because their tail is data the contract
 * supplies rather than something this list can know: `path.<name>` comes from the matched
 * operation's template, `query.<name>` from the request, and `jwt.claim.<name>` from the token.
 * The prefix is still closed — `${anything.else}` is rejected at write time.
 */
export const TEMPLATE_VARS = [
  "subscription.id",
  "subscription.name",
  "application.id",
  "application.name",
  "product.id",
  "product.name",
  "resource.name",
  "revision.rev",
  "environment",
  "route.basePath",
  "operation.id",
  "operation.method",
  "operation.template",
  "request.id",
  "trace.id",
  "client.ip",
  "jwt.sub",
  "cert.subject.cn",
  "cert.issuer",
  "cert.thumbprint",
  "now.iso8601",
  "now.rfc1123",
  "now.epoch",
] as const;

/** Families whose tail is contract- or request-supplied. */
export const TEMPLATE_PREFIXES = ["path.", "query.", "jwt.claim."] as const;

export type TemplateVar = (typeof TEMPLATE_VARS)[number];
/** Keyed by variable name, including the prefixed families, which are resolved at request time. */
export type TemplateContext = Record<string, string | undefined>;

const PLACEHOLDER = /\$\{([^}]*)\}/g;
const KNOWN = new Set<string>(TEMPLATE_VARS);

function isKnown(name: string): boolean {
  if (KNOWN.has(name)) return true;
  return TEMPLATE_PREFIXES.some((prefix) => name.startsWith(prefix) && name.length > prefix.length);
}

/** Every `${...}` used in a string, in order of appearance. */
export function referencedVars(input: string): string[] {
  const found: string[] = [];
  for (const match of input.matchAll(PLACEHOLDER)) found.push(match[1]!.trim());
  return found;
}

/** Validation errors for one string. Empty array means it renders. */
export function templateErrors(input: string, where: string): string[] {
  return referencedVars(input)
    .filter((name) => !isKnown(name))
    .map(
      (name) =>
        `${where}: unknown template variable \${${name}} (design section 5.6's set is closed: ` +
        `${TEMPLATE_VARS.join(", ")}, plus ${TEMPLATE_PREFIXES.map((p) => `${p}<name>`).join(", ")})`,
    );
}

/** Walks any JSON value and validates every string it contains. */
export function templateErrorsDeep(value: unknown, where: string): string[] {
  if (typeof value === "string") return templateErrors(value, where);
  if (Array.isArray(value)) return value.flatMap((v, i) => templateErrorsDeep(v, `${where}[${i}]`));
  if (value && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) =>
      templateErrorsDeep(v, `${where}.${k}`),
    );
  }
  return [];
}

export function render(input: string, ctx: TemplateContext): string {
  return input.replace(PLACEHOLDER, (whole, rawName: string) => {
    const name = rawName.trim();
    if (!isKnown(name)) return whole;
    return ctx[name] ?? "";
  });
}

export function renderDeep<T>(value: T, ctx: TemplateContext): T {
  if (typeof value === "string") return render(value, ctx) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => renderDeep(v, ctx)) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[render(k, ctx)] = renderDeep(v, ctx);
    }
    return out as unknown as T;
  }
  return value;
}

export function baseContext(now = new Date()): TemplateContext {
  return {
    "now.iso8601": now.toISOString(),
    "now.rfc1123": now.toUTCString(),
    "now.epoch": String(Math.floor(now.getTime() / 1000)),
  };
}
