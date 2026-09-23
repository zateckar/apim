import { useEffect, useState } from "react";
import { api, type Application, type MarketCard, type MarketFacets, type Meta, type User } from "../api";
import { EmptyState, Panel, Link, Notice, Segmented, Skeleton, StatusChip, envLabel, useAsync } from "../components";
import { catalogAccessChip, kafkaTopicApiChip, lifecycleChip, unpublishedChip } from "../lib/status";
import * as I from "../portal/icons";
import { KindBadge, type Kind } from "../portal/components/KindBadge";

/**
 * The Catalog is the marketplace: help somebody find a useful thing, then let them inspect it.
 * The page keeps the decision-making facts in view (what it is, who publishes it, where it is live,
 * and whether access is available) and leaves the contract details to the listing page.
 *
 * Browsing is grouped by domain because that is how the estate is organised. A query or an explicit
 * sort turns the same results into one compact list, because somebody who has typed a question no
 * longer needs the taxonomy to find the answer.
 */

const SORTS: Array<{ value: string; label: string }> = [
  { value: "relevance", label: "Best match" },
  { value: "popular", label: "Most used" },
  { value: "newest", label: "Newest" },
  { value: "name", label: "Name" },
];

/**
 * The most the browse view asks for in one read — the endpoint's own ceiling. When the whole
 * visible estate fits, every domain opens with its resources already in hand; when it does not,
 * the domains stay folded and each reads its own on the way open.
 */
const BROWSE_LIMIT = 200;

type ApplicationOption = Pick<Application, "id" | "name">;

/** What the catalogue is showing, which is also what its address says. */
export interface CatalogState {
  q: string;
  kind: string | null;
  tag: string | null;
  /** A publisher's application id. `publisher` in the address, because that is the control's name. */
  application: string;
  environment: string;
  sort: string;
}

/**
 * The address for a catalogue state: only what differs from the default, so an unfiltered catalogue
 * is plain `/catalog` and a link somebody pastes into a ticket carries exactly the filters they set.
 *
 * The state lived in component memory only, so a reload, the back button from a listing, or a link
 * sent to a colleague all landed on an empty search — the reader had to rebuild the question that
 * found the thing they wanted to show somebody.
 */
export function catalogSearch(state: CatalogState): string {
  const params = new URLSearchParams();
  if (state.q.trim()) params.set("q", state.q.trim());
  if (state.kind) params.set("kind", state.kind);
  if (state.tag) params.set("tag", state.tag);
  if (state.application) params.set("publisher", state.application);
  if (state.environment) params.set("environment", state.environment);
  if (state.sort !== "relevance") params.set("sort", state.sort);
  const text = params.toString();
  return text ? `?${text}` : "";
}

/**
 * The inverse, forgiving of an address somebody edited: a kind, environment or sort the portal does
 * not know is dropped rather than sent, because the search endpoint would refuse it with a 400 and
 * the reader would see an error for a typo in a bookmark.
 */
export function readCatalogSearch(search: string, meta: Pick<Meta, "chain" | "kinds">): CatalogState {
  const params = new URLSearchParams(search);
  const kind = params.get("kind");
  const environment = params.get("environment") ?? "";
  const sort = params.get("sort") ?? "relevance";
  return {
    q: params.get("q") ?? "",
    kind: kind && meta.kinds.includes(kind) ? kind : null,
    tag: params.get("tag") || null,
    application: params.get("publisher") ?? "",
    environment: meta.chain.includes(environment) ? environment : "",
    sort: SORTS.some((option) => option.value === sort) ? sort : "relevance",
  };
}

export function MarketView({
  meta,
  applications = [],
}: {
  user: User;
  meta: Meta;
  /** Names make the publisher filter readable; ids remain the values sent to the API. */
  applications?: ApplicationOption[];
}) {
  const [initial] = useState(() => readCatalogSearch(window.location.search, meta));
  const [q, setQ] = useState(initial.q);
  const [kind, setKind] = useState<string | null>(initial.kind);
  const [tag, setTag] = useState<string | null>(initial.tag);
  const [application, setApplication] = useState(initial.application);
  const [environment, setEnvironment] = useState(initial.environment);
  const [sort, setSort] = useState(initial.sort);

  // Replaced rather than pushed: a history entry per keystroke would make Back walk through every
  // prefix of a query. What Back is for is returning here from a listing, and it does, filters kept.
  useEffect(() => {
    const next = window.location.pathname + catalogSearch({ q, kind, tag, application, environment, sort });
    if (next !== window.location.pathname + window.location.search) {
      window.history.replaceState(window.history.state, "", next);
    }
  }, [q, kind, tag, application, environment, sort]);

  const activeFilters = [q.trim(), kind, tag, application, environment].filter(Boolean).length;
  // A non-default sort is also a deliberate discovery mode, so it should show the ranked answer
  // directly rather than leaving the reader to open every domain to see the ordering.
  const browsing = activeFilters === 0 && sort === "relevance";

  const query = new URLSearchParams();
  if (q.trim()) query.set("q", q.trim());
  if (kind) query.set("kind", kind);
  if (tag) query.set("tag", tag);
  if (application) query.set("application", application);
  if (environment) query.set("environment", environment);
  // Browsing reads as much of the estate as one request may, by name, so the domains below can be
  // drawn open from it without one request each.
  query.set("sort", browsing ? "name" : sort);
  query.set("limit", browsing ? String(BROWSE_LIMIT) : "60");

  // The index is local and small enough that immediate feedback is more useful than a debounce.
  const listing = useAsync(
    () => api.get<{ items: MarketCard[]; total: number; truncated: boolean }>(`/api/catalog?${query}`),
    [q, kind, tag, application, environment, sort],
    query.toString(),
  );
  const facets = useAsync(() => api.get<MarketFacets>("/api/catalog/facets"), []);

  const items = listing.data?.items ?? [];
  const applicationName = (id: string) => applications.find((entry) => entry.id === id)?.name ?? id;
  const total = listing.data?.total;
  // Everything visible is in hand, so every domain can be drawn from it.
  const complete = Boolean(listing.data && !listing.data.truncated && items.length >= listing.data.total);
  const byDomain = new Map<string, MarketCard[]>();
  for (const item of items) {
    const key = item.domain ?? "other";
    byDomain.set(key, [...(byDomain.get(key) ?? []), item]);
  }

  const clearFilters = () => {
    setQ("");
    setKind(null);
    setTag(null);
    setApplication("");
    setEnvironment("");
    setSort("relevance");
  };

  const populated = (facets.data?.domains ?? []).filter((entry) => entry.count + entry.topics > 0);
  const unused = (facets.data?.domains ?? []).filter((entry) => entry.count + entry.topics === 0);

  return (
    <div className="catalog-page">
      <Panel className="catalog-controls">
        <div className="catalog-search-row">
          <div className="catalog-search-field">
            <label htmlFor="catalog-search">
              <span>Search resources</span>
            </label>
            <div className="catalog-search">
              <I.Search />
              <input
                id="catalog-search"
                type="search"
                value={q}
                placeholder="Name, operation, tool or tag"
                onChange={(event) => setQ(event.target.value)}
              />
              {q && (
                <button className="catalog-clear-search" type="button" aria-label="Clear search" onClick={() => setQ("")}>
                  ×
                </button>
              )}
            </div>
          </div>
          <div className="catalog-result-total" aria-live="polite">
            <strong>{listing.loading && total === undefined ? "…" : total ?? 0}</strong>
            <span>{total === 1 ? "resource" : "resources"}</span>
          </div>
        </div>

        <div className="catalog-filter-row">
          {/* One value each, so the one segmented control — they were rows of chip buttons and a
              select, three shapes for the same act on one panel. Tags stay chips below: there can
              be a dozen, and a segmented control that wraps onto three lines is not one. */}
          {(facets.data?.kinds.length ?? 0) > 0 && (
            <div className="catalog-segment">
              <span aria-hidden="true">Type</span>
              <Segmented
                label="Type"
                value={kind ?? ""}
                onChange={(next) => setKind(next || null)}
                options={[
                  { value: "", label: "All" },
                  ...(facets.data?.kinds ?? []).map((entry) => ({
                    value: entry.value,
                    label: <>{kindLabel(entry.value)} <span className="chip-count">{entry.count}</span></>,
                  })),
                ]}
              />
            </div>
          )}
          <div className="catalog-segment">
            <span aria-hidden="true">Environment</span>
            <Segmented
              label="Environment"
              value={environment}
              onChange={setEnvironment}
              options={[
                { value: "", label: "All" },
                ...(facets.data?.environments ?? meta.chain.map((value) => ({ value, count: 0 }))).map((entry) => ({
                  value: entry.value,
                  label: <>{envLabel(entry.value)}{entry.count ? <> <span className="chip-count">{entry.count}</span></> : null}</>,
                })),
              ]}
            />
          </div>
          <label className="catalog-select catalog-sort">
            <span>Sort</span>
            <select aria-label="Sort by" value={sort} onChange={(event) => setSort(event.target.value)}>
              {SORTS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          {activeFilters > 0 && (
            <button className="btn ghost sm" type="button" onClick={clearFilters}>
              Clear {activeFilters} filter{activeFilters === 1 ? "" : "s"}
            </button>
          )}
        </div>

        <details className="catalog-more-filters" open={Boolean(tag || application)}>
          <summary>
            More filters
            {(tag || application) && <span className="catalog-filter-badge">{[tag, application].filter(Boolean).length}</span>}
          </summary>
          <div className="catalog-more-grid">
            <label className="catalog-select">
              <span>Publisher</span>
              <select aria-label="Publisher" value={application} onChange={(event) => setApplication(event.target.value)}>
                <option value="">All publishers</option>
                {(facets.data?.applications ?? []).map((entry) => (
                  <option key={entry.value} value={entry.value}>
                    {applicationName(entry.value)} · {entry.count}
                  </option>
                ))}
              </select>
            </label>
            {(facets.data?.tags.length ?? 0) > 0 && (
              <FacetRow
                label="Tag"
                options={(facets.data?.tags ?? []).slice(0, 12).map((entry) => ({ ...entry, label: entry.value }))}
                value={tag}
                onChange={setTag}
              />
            )}
          </div>
        </details>
        {browsing && <p className="catalog-guidance">Browse by domain, or search when you know what you need.</p>}
      </Panel>

      <Notice kind="error">{listing.error}</Notice>
      {facets.error && <Notice kind="warn">Filters unavailable: {facets.error}</Notice>}
      {/* Words rather than a skeleton: the count above already holds its place, and "Searching…" is
          what tells a reader the list they are looking at is not yet the answer to what they typed. */}
      {listing.loading && items.length === 0 && <p className="catalog-loading muted">Searching…</p>}

      {!listing.loading && !listing.error && items.length === 0 && (
        <Panel className="catalog-no-results">
          {activeFilters > 0 ? (
            <EmptyState
              title="Nothing matches that"
              detail="Try a broader search or clear the filters. Search also covers operation ids and MCP tool names."
              action={<button className="btn" type="button" onClick={clearFilters}>Clear filters</button>}
            />
          ) : (
            <EmptyState
              title="Nothing is published yet"
              detail={`A resource appears here once it is released into an environment. Publish an API, add it to a product and release it into ${envLabel(meta.chain[0] ?? "dev")}.`}
              action={<Link className="btn primary" to="/apis">Publish an API</Link>}
            />
          )}
        </Panel>
      )}

      {browsing && facets.data ? (
        items.length > 0 && (
          <div className="domain-list">
            {populated.map((entry) => (
              <DomainSection
                key={entry.value}
                entry={entry}
                preloaded={complete ? byDomain.get(entry.value) ?? [] : null}
                onTag={setTag}
                publisherName={applicationName}
              />
            ))}
            {unused.length > 0 && (
              <details className="catalog-unused-domains">
                <summary>Domains with no resources <span>{unused.length}</span></summary>
                {unused.map((entry) => (
                  <DomainSection key={entry.value} entry={entry} preloaded={null} onTag={setTag} publisherName={applicationName} />
                ))}
              </details>
            )}
          </div>
        )
      ) : (
        items.length > 0 && (
          <div className="catalog-results-list" aria-label="Catalog results">
            {items.map((item) => <ListingCard key={item.id} item={item} onTag={setTag} publisherName={applicationName(item.applicationId)} />)}
          </div>
        )
      )}

      {(listing.data?.truncated || facets.data?.truncated) && (
        <Notice kind="warn">
          There are more resources than one search reads, so these results and counts may be incomplete. Narrow the search to see the rest.
        </Notice>
      )}
    </div>
  );
}

/**
 * One domain. It started folded, every time — so the first thing the catalogue asked of a visitor
 * was to open each domain in turn to learn what was in it. It now opens with its resources when the
 * browse read already holds them (`preloaded`), and folds only when the estate is too large for one
 * read, where opening is what fetches.
 */
function DomainSection({
  entry,
  preloaded,
  onTag,
  publisherName,
}: {
  entry: { value: string; count: number; topics: number };
  /** This domain's resources, when the browse read holds the whole estate; `null` when it does not. */
  preloaded: MarketCard[] | null;
  onTag: (tag: string) => void;
  publisherName: (id: string) => string;
}) {
  const empty = entry.count === 0 && entry.topics === 0;
  const [open, setOpen] = useState(preloaded !== null && !empty);
  // Keyed on whether there is anything preloaded rather than on the array, which is a new one on
  // every render of the parent and would re-run this read in a loop.
  const fetches = open && preloaded === null;
  const listing = useAsync(
    () => fetches
      ? api.get<{ items: MarketCard[] }>(`/api/catalog?domain=${encodeURIComponent(entry.value)}&sort=name&limit=${BROWSE_LIMIT}`)
      : Promise.resolve({ items: [] as MarketCard[] }),
    [fetches, entry.value],
  );
  const shown = preloaded ?? listing.data?.items ?? [];
  const noun = entry.count === 1 ? "resource" : "resources";

  return (
    <section className="domain-section">
      <button type="button" className="domain-head" aria-expanded={open} disabled={empty} onClick={() => setOpen(!open)}>
        <span className="domain-chevron" aria-hidden>{open ? "⌄" : "›"}</span>
        <span className="domain-name">{entry.value === "other" ? "Other" : entry.value}</span>
        <span className="domain-count muted">
          {empty ? "Nothing filed here yet" : `${entry.count} ${noun}${entry.topics ? ` · ${entry.topics} topic${entry.topics === 1 ? "" : "s"}` : ""}`}
        </span>
        {!empty && <span className="domain-action muted">{open ? "Hide" : "Show"}</span>}
      </button>
      {open && (
        <div className="domain-body">
          {entry.value === "other" && <p className="catalog-domain-note muted small">Published before domains existed.</p>}
          {entry.topics > 0 && (
            <p className="catalog-domain-note muted small">
              {entry.topics} Kafka topic{entry.topics === 1 ? "" : "s"} also filed here. <Link to="/kafka">Open Kafka</Link>
            </p>
          )}
          <Notice kind="error">{listing.error}</Notice>
          {fetches && listing.loading ? (
            <Skeleton rows={Math.min(entry.count, 4) || 1} />
          ) : (
            shown.length > 0 && (
              <div className="catalog-results-list">
                {shown.map((item) => <ListingCard key={item.id} item={item} onTag={onTag} publisherName={publisherName(item.applicationId)} />)}
              </div>
            )
          )}
        </div>
      )}
    </section>
  );
}

function FacetRow({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: Array<{ value: string; label: string; count: number }>;
  value: string | null;
  onChange: (next: string | null) => void;
}) {
  if (options.length === 0) return null;
  return (
    <div className="facet-row" role="group" aria-label={label}>
      <span className="facet-label">{label}</span>
      <button className={value === null ? "chip active" : "chip"} aria-pressed={value === null} onClick={() => onChange(null)} type="button">All</button>
      {options.map((option) => (
        <button key={option.value} type="button" className={value === option.value ? "chip active" : "chip"} aria-pressed={value === option.value} onClick={() => onChange(value === option.value ? null : option.value)}>
          {option.label} <span className="chip-count">{option.count}</span>
        </button>
      ))}
    </div>
  );
}

function ListingCard({
  item,
  onTag,
  publisherName,
}: {
  item: MarketCard;
  onTag: (tag: string) => void;
  publisherName?: string;
}) {
  const lifecycle = lifecycleChip(item.lifecycle as never);
  return (
    <article className="listing catalog-result">
      <div className="catalog-result-main">
        <span className="listing-icon" aria-hidden>{item.icon || defaultIcon(item.kind)}</span>
        <div className="catalog-result-copy">
          <div className="catalog-result-title">
            <Link to={`/catalog/${item.id}`}><strong>{item.title}</strong></Link>
            <KindBadge kind={item.kind as Kind} />
            {/* A generated API is still a REST API; this says what it is for, which the kind cannot. */}
            {item.kafkaTopic && <StatusChip chip={kafkaTopicApiChip(item.kafkaTopic)} />}
            {item.unpublished && <StatusChip chip={unpublishedChip()} />}
            <StatusChip chip={catalogAccessChip(item)} />
            {lifecycle && <StatusChip chip={lifecycle} />}
          </div>
          <div className="catalog-result-meta">
            <span className="mono">{item.apiVersion}</span>
            <span aria-hidden>·</span>
            <span>{publisherName ?? item.applicationId}</span>
            {item.domain && <><span aria-hidden>·</span><span>{item.domain}{item.subdomain ? ` / ${item.subdomain}` : ""}</span></>}
          </div>
          <p className="catalog-result-summary">{item.summary?.trim() || "No summary provided."}</p>
          {item.tags.length > 0 && (
            <div className="listing-tags">
              {item.tags.slice(0, 3).map((tag) => <button key={tag} type="button" className="chip small" aria-label={`Filter by tag ${tag}`} onClick={() => onTag(tag)}>{tag}</button>)}
              {item.tags.length > 3 && <span className="muted small">+{item.tags.length - 3}</span>}
            </div>
          )}
        </div>
      </div>
      <div className="catalog-result-facts">
        {/* The environments only. "Not live" beside them repeated the Not published chip in the
            title, which is the same fact about the same row. */}
        {item.environments.length > 0 && (
          <div className="listing-envs" aria-label="Live in">
            {item.environments.map((env) => <span key={env} className="chip">{envLabel(env)}</span>)}
          </div>
        )}
        <span className="catalog-result-stats">
          {item.operationCount} {countNoun(item.kind, item.operationCount)}
          {item.products.length > 0 && <><span aria-hidden> · </span>{item.products.length} product{item.products.length === 1 ? "" : "s"}</>}
          {item.subscriberCount > 0 && <><span aria-hidden> · </span>{item.subscriberCount} subscriber{item.subscriberCount === 1 ? "" : "s"}</>}
        </span>
      </div>
      <Link className="catalog-result-open" to={`/catalog/${item.id}`} ariaLabel={`View ${item.title}`}>
        View <span aria-hidden>→</span>
      </Link>
    </article>
  );
}

function countNoun(kind: string, n: number): string {
  if (kind === "mcp") return n === 1 ? "tool" : "tools";
  if (kind === "a2a") return n === 1 ? "skill" : "skills";
  return n === 1 ? "operation" : "operations";
}

function kindLabel(kind: string): string {
  if (kind === "mcp") return "MCP server";
  if (kind === "a2a") return "A2A agent";
  return kind.toUpperCase();
}

function defaultIcon(kind: string): string {
  if (kind === "mcp") return "🔌";
  if (kind === "a2a") return "🤝";
  if (kind === "soap") return "🧼";
  return "🔗";
}
