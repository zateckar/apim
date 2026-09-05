/**
 * The catalogue's taxonomy: every published thing belongs to exactly one domain and optionally to
 * one sub-domain, and the domain is the **first segment of its published path**.
 *
 * A closed list rather than free text, and shared rather than duplicated in the portal: the same
 * table has to constrain the publish form, validate the write on the control plane, and bucket the
 * catalog — three surfaces that must never disagree about what a domain is.
 *
 * A slash-bearing sub-domain such as `Crm/leads` is one entry, because it maps 1:1 onto a
 * multi-segment path (`…/sales/crm/leads/…`). Slugging splits on `/`, slugs each part and re-joins,
 * so the slash survives normalisation.
 */

export interface Domain {
  /** Canonical display label, shown verbatim in the picker. */
  name: string;
  /** `[]` means the domain has none, and the sub-domain control is disabled rather than empty. */
  subdomains: string[];
}

export const DOMAINS: Domain[] = [
  {
    name: "Aftersales",
    subdomains: [
      "Diagnosis",
      "Maintenance",
      "Parts",
      "Repairs",
      "Service Support",
      "Vehicle Data",
      "Warranty",
    ],
  },
  {
    name: "Business Support",
    subdomains: [
      "Archive",
      "Audit",
      "Catering",
      "Communication",
      "Events",
      "Legal",
      "Media",
      "Mobility",
      "Office Management",
      "Risk and Compliance",
      "Security",
      "Sustainability",
      "Travel",
    ],
  },
  { name: "Connectivity", subdomains: ["Data", "Management", "Operations"] },
  { name: "Finances", subdomains: ["Accounting", "Customs", "Tax", "Treasury"] },
  { name: "HR", subdomains: ["Data", "Health", "Personnel", "Qualification", "Rewards", "Safety"] },
  {
    name: "IT",
    subdomains: [
      "Architecture",
      "Governance",
      "Lifecycle",
      "Operation",
      "Portfolio",
      "Security",
      "Solution",
    ],
  },
  {
    name: "Marketing",
    subdomains: [
      "Brand communication",
      "Content production",
      "Dealer contact",
      "Digital product",
      "Market research",
      "Price Management",
      "Product communication",
      "Product Data Management",
      "Social media",
    ],
  },
  { name: "Product", subdomains: [] },
  { name: "Production", subdomains: ["Logistics", "Orders", "Preparation", "Reporting", "Steering"] },
  { name: "Quality", subdomains: [] },
  { name: "RD", subdomains: [] },
  {
    name: "Sales",
    subdomains: [
      "Crm/campaigns",
      "Crm/complaints",
      "Crm/contracts",
      "Crm/customer data management",
      "Crm/leads",
      "Fleets",
      "Merchandise",
      "New cars",
      "Orders",
      "Services",
      "Strategy",
      "Strategy/brand strategy",
      "Strategy/communication",
      "Strategy/inporter steering",
      "Strategy/market development",
      "Strategy/product and portfolio strategy",
      "Strategy/retail network development",
      "Strategy/training",
      "Strategy/volume and price planning",
      "Used cars",
    ],
  },
];

/** By display label, which is what is stored — the label is the identity, the slug is derived. */
export function findDomain(name: string | null | undefined): Domain | undefined {
  if (!name) return undefined;
  return DOMAINS.find((domain) => domain.name === name);
}

/** lowercase, every run of non-alphanumerics to one hyphen, no leading or trailing hyphen. */
export function slugify(input: string): string {
  return (input ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** `Crm/leads` → `crm/leads`: each segment slugged, the separators kept. */
export function slugifyPath(input: string): string {
  return (input ?? "")
    .split("/")
    .map(slugify)
    .filter(Boolean)
    .join("/");
}

/**
 * Whether this pair is one the taxonomy actually offers. Returns the reason it is not, so the
 * control plane and the form can say the same sentence.
 */
export function domainError(domain: string | null | undefined, subdomain: string | null | undefined): string | null {
  if (!domain) return "domain: required — it is the first segment of the published path";
  const found = findDomain(domain);
  if (!found) return `domain: "${domain}" is not one of ${DOMAINS.map((d) => d.name).join(", ")}`;
  if (!subdomain) return null;
  if (found.subdomains.length === 0) return `subdomain: ${found.name} has no sub-domains`;
  if (!found.subdomains.includes(subdomain)) {
    return `subdomain: "${subdomain}" is not a sub-domain of ${found.name}`;
  }
  return null;
}

/**
 * The segments every path in this domain has to start with: `/sales/crm/leads`.
 *
 * Separate from `publishedPath` because it is what the control plane *enforces*. A publisher may
 * still choose what follows — a version segment, a shorter name — but not whether the domain is
 * there, or the domain would be a label rather than an address.
 */
export function domainPrefix(domain: string, subdomain?: string | null): string {
  const segments = [slugify(domain)];
  if (subdomain) segments.push(slugifyPath(subdomain));
  return "/" + segments.filter(Boolean).join("/");
}

/**
 * The address a caller uses: `/<domain>/<sub-domain>/<name>/<version>`.
 *
 * Derived rather than typed. A base path a publisher can write by hand is a base path two
 * publishers can collide on and nobody can find in the catalog by its domain; deriving it means
 * the taxonomy and the URL cannot drift, which is the whole point of asking for a domain.
 *
 * The version is **always** a segment, including for `v1`. Segment versioning is the estate's
 * convention: every published address ends in its version, so a consumer reading a URL knows which
 * contract they are on without looking it up, and `v2` does not have to explain why it is shaped
 * differently from `v1`.
 */
export function publishedPath(parts: {
  domain: string;
  subdomain?: string | null;
  name: string;
  apiVersion?: string | null;
}): string {
  return storedPath(parts) + versionSegment(parts.apiVersion);
}

/**
 * The path as it is **stored**, without the version: `/<domain>/<sub-domain>/<name>`.
 *
 * The version segment belongs to the gateway, which appends it from the API's own `apiVersion`
 * (segment versioning). Storing it as well is how you get `/sales/orders/v2/v2` the first time
 * somebody edits a path by hand, so the stored form never carries it and `stripVersionSegment` is
 * the guard that keeps it that way.
 */
export function storedPath(parts: {
  domain: string;
  subdomain?: string | null;
  name: string;
}): string {
  const segments = [slugify(parts.domain)];
  if (parts.subdomain) segments.push(slugifyPath(parts.subdomain));
  segments.push(slugify(parts.name));
  return "/" + segments.filter(Boolean).join("/");
}

/** `v2` → `/v2`, and nothing at all for an API with no version. */
export function versionSegment(apiVersion: string | null | undefined): string {
  const slug = slugify(apiVersion ?? "");
  return slug ? `/${slug}` : "";
}

/**
 * Remove a trailing version segment from a stored path. The last line of defence against a
 * doubled `/sales/orders/v2/v2`, which is not a cosmetic problem: it is an address nothing serves.
 */
export function stripVersionSegment(path: string, apiVersion: string | null | undefined): string {
  const slug = slugify(apiVersion ?? "");
  if (!slug) return path;
  const segments = path.replace(/\/+$/, "").split("/");
  if (slugify(segments[segments.length - 1] ?? "") === slug) segments.pop();
  return segments.join("/") || "/";
}

/** The reverse, for bucketing a catalog that still holds paths written before domains existed. */
export function domainFromPath(path: string | null | undefined): Domain | undefined {
  if (!path) return undefined;
  const head = path.replace(/^\/+/, "").split("/")[0];
  if (!head) return undefined;
  return DOMAINS.find((domain) => slugify(domain.name) === slugify(head));
}
