import { useState } from "react";
import { api, type Application, type MarketCard, type MarketFacets, type Meta, type User } from "../api";
import { Panel, Link, Notice, StatusChip, useAsync } from "../components";
import { lifecycleChip } from "../lib/status";
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

type ApplicationOption = Pick<Application, "id" | "name">;

export function MarketView({
  user,
  meta,
  applications = [],
}: {
  user: User;
  meta: Meta;
  /** Names make the publisher filter readable; ids remain the values sent to the API. */
  applications?: ApplicationOption[];
}) {
  const [q, setQ] = useState("");
  const [kind, setKind] = useState<string | null>(null);
  const [tag, setTag] = useState<string | null>(null);
  const [application, setApplication] = useState("");
  const [environment, setEnvironment] = useState("");
  const [sort, setSort] = useState("relevance");

  const query = new URLSearchParams();
  if (q.trim()) query.set("q", q.trim());
  if (kind) query.set("kind", kind);
  if (tag) query.set("tag", tag);
  if (application) query.set("application", application);
  if (environment) query.set("environment", environment);
  query.set("sort", sort);
  query.set("limit", "60");

  // The index is local and small enough that immediate feedback is more useful than a debounce.
  const listing = useAsync(
    () => api.get<{ items: MarketCard[]; total: number; truncated: boolean }>(`/api/catalog?${query}`),
    [q, kind, tag, application, environment, sort],
    query.toString(),
  );
  const facets = useAsync(() => api.get<MarketFacets>("/api/catalog/facets"), []);

  const items = listing.data?.items ?? [];
  const activeFilters = [q.trim(), kind, tag, application, environment].filter(Boolean).length;
  // A non-default sort is also a deliberate discovery mode, so it should show the ranked answer
  // directly rather than leaving the reader to open every domain to see the ordering.
  const browsing = activeFilters === 0 && sort === "relevance";
  const applicationName = (id: string) => applications.find((entry) => entry.id === id)?.name ?? id;
  const total = listing.data?.total;

  const clearFilters = () => {
    setQ("");
    setKind(null);
    setTag(null);
    setApplication("");
    setEnvironment("");
    setSort("relevance");
  };

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
          <FacetRow
            label="Type"
            options={(facets.data?.kinds ?? []).map((entry) => ({
              ...entry,
              label: kindLabel(entry.value),
            }))}
            value={kind}
            onChange={setKind}
          />
          <label className="catalog-select">
            <span>Environment</span>
            <select aria-label="Environment" value={environment} onChange={(event) => setEnvironment(event.target.value)}>
              <option value="">All environments</option>
              {(facets.data?.environments ?? meta.chain.map((value) => ({ value, count: 0 }))).map((entry) => (
                <option key={entry.value} value={entry.value}>
                  {entry.value.toUpperCase()}{entry.count ? ` · ${entry.count}` : ""}
                </option>
              ))}
            </select>
          </label>
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
            <button className="ghost catalog-clear" type="button" onClick={clearFilters}>
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
        <p className="catalog-guidance">
          {browsing
            ? "Browse by domain, or search when you know what you need."
            : "Showing the resources that match your filters."}
        </p>
      </Panel>

      <Notice kind="error">{listing.error}</Notice>
      {facets.error && <Notice kind="warn">Filters unavailable: {facets.error}</Notice>}
      {listing.loading && items.length === 0 && <p className="catalog-loading muted">Searching…</p>}

      {!listing.loading && !listing.error && items.length === 0 && (
        <Panel className="catalog-no-results">
          {activeFilters > 0 ? (
            <>
              <h3>Nothing matches that</h3>
              <p className="muted">Try a broader search or clear the filters. Search also covers operation ids and MCP tool names.</p>
              <button className="ghost small" type="button" onClick={clearFilters}>Clear filters</button>
            </>
          ) : (
            <>
              <h3>Nothing is published yet</h3>
              <p className="muted">
                A resource appears here after it is released into an environment. Publish an API from <Link to="/apis">APIs</Link>, add it to a product, and release it into {meta.chain[0] ?? "DEV"}.
              </p>
            </>
          )}
        </Panel>
      )}

      {browsing && facets.data ? (
        items.length > 0 && (
          <div className="domain-list">
            {(facets.data.domains ?? []).filter((entry) => entry.count + entry.topics > 0).map((entry) => (
              <DomainSection key={entry.value} entry={entry} onTag={setTag} publisherName={applicationName} />
            ))}
            {(facets.data.domains ?? []).some((entry) => entry.count + entry.topics === 0) && (
              <details className="catalog-unused-domains">
                <summary>Domains with no resources <span>{facets.data.domains.filter((entry) => entry.count + entry.topics === 0).length}</span></summary>
                {facets.data.domains.filter((entry) => entry.count + entry.topics === 0).map((entry) => (
                  <DomainSection key={entry.value} entry={entry} onTag={setTag} publisherName={applicationName} />
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
          The estate is larger than one ranking pass reads. These results and filter counts are a floor; narrow the search to see more.
        </Notice>
      )}
      {user.isAdmin && items.some((item) => item.unpublished) && (
        <p className="catalog-admin-note muted">Listings marked <span className="badge warn">not published</span> are visible because you own them.</p>
      )}
    </div>
  );
}

function DomainSection({
  entry,
  onTag,
  publisherName,
}: {
  entry: { value: string; count: number; topics: number };
  onTag: (tag: string) => void;
  publisherName: (id: string) => string;
}) {
  const [open, setOpen] = useState(false);
  const listing = useAsync(
    () => open ? api.get<{ items: MarketCard[] }>(`/api/catalog?domain=${encodeURIComponent(entry.value)}&sort=name&limit=200`) : Promise.resolve({ items: [] as MarketCard[] }),
    [open, entry.value],
  );
  const empty = entry.count === 0 && entry.topics === 0;
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
          {entry.value === "other" && <p className="catalog-domain-note muted small">Published before the taxonomy existed.</p>}
          {entry.topics > 0 && (
            <p className="catalog-domain-note muted small">
              {entry.topics} Kafka topic{entry.topics === 1 ? "" : "s"} also filed here. <Link to="/kafka">Open Kafka</Link>
            </p>
          )}
          <Notice kind="error">{listing.error}</Notice>
          {listing.loading && <p className="muted">Loading resources…</p>}
          <div className="catalog-results-list">
            {(listing.data?.items ?? []).map((item) => <ListingCard key={item.id} item={item} onTag={onTag} publisherName={publisherName(item.applicationId)} />)}
          </div>
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
            {item.unpublished && <span className="badge warn">not published</span>}
            {item.subscribed && <span className="badge ok">subscribed</span>}
            {!item.subscribed && item.products.length > 0 && <span className="catalog-available">Available to subscribe</span>}
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
              {item.tags.slice(0, 3).map((tag) => <button key={tag} type="button" className="chip small" onClick={() => onTag(tag)}>{tag}</button>)}
              {item.tags.length > 3 && <span className="muted small">+{item.tags.length - 3}</span>}
            </div>
          )}
        </div>
      </div>
      <div className="catalog-result-facts">
        <div className="listing-envs" aria-label="Live environments">
          {item.environments.length > 0
            ? item.environments.map((env) => <span key={env} className="pill ok">{env.toUpperCase()}</span>)
            : <span className="badge warn">not live</span>}
        </div>
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
