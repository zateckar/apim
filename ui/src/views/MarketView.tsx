import { useState } from "react";
import { api, type MarketCard, type MarketFacets, type Meta, type User } from "../api";
import { Panel, Link, Notice, useAsync } from "../components";

/**
 * The Catalog (goal G6) — the marketplace, and for most people the front door.
 *
 * Everything here is one question with two halves: *find the thing*, and *decide about the thing*.
 * So the grid carries only what a decision needs — what it is, what it does, whether it is live,
 * whether anyone else uses it, and whether you already hold a key — and the rest is one click away.
 *
 * The empty and no-result states are not decoration. A marketplace with nothing in it is the state
 * every new installation starts in, and a search that finds nothing is the most common thing a
 * consumer will see; both have to say what to do next rather than showing a blank panel.
 */

const KIND_LABELS: Record<string, string> = {
  rest: "REST",
  soap: "SOAP",
  mcp: "MCP server",
  a2a: "A2A agent",
};

const SORTS: Array<{ value: string; label: string }> = [
  { value: "relevance", label: "Best match" },
  { value: "popular", label: "Most used" },
  { value: "newest", label: "Newest" },
  { value: "name", label: "Name" },
];

export function MarketView({ user, meta }: { user: User; meta: Meta }) {
  const [q, setQ] = useState("");
  const [kind, setKind] = useState<string | null>(null);
  const [tag, setTag] = useState<string | null>(null);
  const [application, setApplication] = useState("");
  const [sort, setSort] = useState("relevance");

  const query = new URLSearchParams();
  if (q.trim()) query.set("q", q.trim());
  if (kind) query.set("kind", kind);
  if (tag) query.set("tag", tag);
  if (application) query.set("application", application);
  query.set("sort", sort);
  query.set("limit", "60");

  // Re-runs as you type: the index is local and the estate is small, so a debounce would only add
  // latency somebody can feel.
  const listing = useAsync(
    () => api.get<{ items: MarketCard[]; total: number; truncated: boolean }>(`/api/catalog?${query}`),
    [q, kind, tag, application, sort],
    query.toString(),
  );
  const facets = useAsync(() => api.get<MarketFacets>("/api/catalog/facets"), []);

  const items = listing.data?.items ?? [];
  const filtered = Boolean(q.trim() || kind || tag || application);

  /*
   * Two layouts, one estate. Browsing is by domain, because the domain is how the estate is
   * organised and how a URL is read; searching is across domains, because somebody typing `addPet`
   * is asking a question the taxonomy has no opinion about. The filter bar decides which is on.
   */
  return (
    <>
      <Panel>
        <div className="row wrap catalog-filters">
          {/* Each label names its own control. They used to sit beside one, which reads the same
              and is not the same: a screen reader announced three unlabelled fields. */}
          <div className="field catalog-query">
            <label htmlFor="catalog-search">Search resources{facets.data ? ` (${facets.data.total})` : ""}</label>
            <input
              id="catalog-search"
              type="text"
              value={q}
              placeholder="Search names, descriptions, operations or tags…"
              onChange={(event) => setQ(event.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="catalog-application">Application</label>
            <select
              id="catalog-application"
              value={application}
              onChange={(event) => setApplication(event.target.value)}
            >
              <option value="">All applications</option>
              {(facets.data?.applications ?? []).map((entry) => (
                <option key={entry.value} value={entry.value}>
                  {entry.value} ({entry.count})
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="catalog-sort">Sort by</label>
            <select id="catalog-sort" value={sort} onChange={(event) => setSort(event.target.value)}>
              {SORTS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="facets">
          <FacetRow
            label="Kind"
            options={(facets.data?.kinds ?? []).map((entry) => ({
              ...entry,
              label: KIND_LABELS[entry.value] ?? entry.value,
            }))}
            value={kind}
            onChange={setKind}
          />
          {(facets.data?.tags.length ?? 0) > 0 && (
            <FacetRow
              label="Tag"
              options={(facets.data?.tags ?? []).slice(0, 14).map((entry) => ({
                ...entry,
                label: entry.value,
              }))}
              value={tag}
              onChange={setTag}
            />
          )}
        </div>
      </Panel>

      <Notice kind="error">{listing.error}</Notice>
      {/* The facets are the filter bar above; if they failed, the bar is empty rather than wrong,
          and saying so is the difference between "no tags exist" and "the tags did not load". */}
      {facets.error && <Notice kind="warn">Filters unavailable: {facets.error}</Notice>}

      {listing.loading && items.length === 0 && <p className="muted">Searching…</p>}

      {!listing.loading && !listing.error && items.length === 0 && (
        <Panel>
          {filtered ? (
            <>
              <h3>Nothing matches that</h3>
              <p className="muted">
                Try fewer words, or clear the filters. Search covers operation ids and MCP tool
                names too, so <span className="mono">addPet</span> finds the API that declares it.
              </p>
              <button
                className="ghost small"
                onClick={() => {
                  setQ("");
                  setKind(null);
                  setTag(null);
                  setApplication("");
                }}
              >
                Clear filters
              </button>
            </>
          ) : (
            <>
              <h3>Nothing is published yet</h3>
              <p className="muted">
                A listing appears here once it has been released into an environment. Publish an API
                from <Link to="/apis">APIs</Link>, bundle it into a product, and release it into{" "}
                {meta.chain[0] ?? "dev"}.
              </p>
            </>
          )}
        </Panel>
      )}

      {filtered ? (
        <div className="market-grid">
          {items.map((item) => (
            <ListingCard key={item.id} item={item} onTag={setTag} />
          ))}
        </div>
      ) : (
        items.length > 0 && (
          <div className="domain-list">
            {(facets.data?.domains ?? []).filter((entry) => entry.count + entry.topics > 0).map((entry) => (
              <DomainSection key={entry.value} entry={entry} onTag={setTag} />
            ))}
            {(facets.data?.domains ?? []).some((entry) => entry.count + entry.topics === 0) && (
              <details className="catalog-unused-domains">
                <summary>Domains with no resources ({facets.data!.domains.filter((entry) => entry.count + entry.topics === 0).length})</summary>
                {facets.data!.domains.filter((entry) => entry.count + entry.topics === 0).map((entry) => (
                  <DomainSection key={entry.value} entry={entry} onTag={setTag} />
                ))}
              </details>
            )}
          </div>
        )
      )}

      {/* The flag is about the scan, not the answer: the estate is larger than one ranking pass
          looks at, so listings may exist that were never considered — including when the list
          above is short, because the filters run after the scan. Said plainly, because a search
          that quietly stops looking is the one failure a catalog must not have. */}
      {(listing.data?.truncated || facets.data?.truncated) && (
        <Notice kind="warn">
          This estate is larger than one ranking pass reads, so these results and the counts beside
          each filter are a floor rather than a total. Narrow the search to see the rest.
        </Notice>
      )}
      {user.isAdmin && items.some((item) => item.unpublished) && (
        <p className="muted">
          Listings badged <span className="badge warn">not published</span> are visible to you
          because you own them; nobody else can see them yet.
        </p>
      )}
    </>
  );
}

/**
 * One domain, closed until asked for. The count comes from the facets — every domain in the
 * taxonomy is retained, with empty domains behind a disclosure (workspace-api-catalog: Group the
 * catalogue by domain), so browsing starts with resources. The rows are fetched only on
 * expand: thirteen domains eagerly loading their contents is thirteen requests nobody asked for.
 */
function DomainSection({
  entry,
  onTag,
}: {
  entry: { value: string; count: number; topics: number };
  onTag: (tag: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const listing = useAsync(
    () =>
      open
        ? api.get<{ items: MarketCard[] }>(
            `/api/catalog?domain=${encodeURIComponent(entry.value)}&sort=name&limit=200`,
          )
        : Promise.resolve({ items: [] as MarketCard[] }),
    [open, entry.value],
  );
  const empty = entry.count === 0 && entry.topics === 0;

  return (
    <section className="domain-section">
      <button
        type="button"
        className="domain-head"
        aria-expanded={open}
        disabled={empty}
        onClick={() => setOpen(!open)}
      >
        <span className="domain-name">
          {entry.value === "other" ? "Other" : entry.value}
        </span>
        <span className="muted small">
          {empty
            ? "nothing filed here yet"
            : [
                entry.count > 0 ? `${entry.count} API${entry.count === 1 ? "" : "s"}` : null,
                entry.topics > 0 ? `${entry.topics} topic${entry.topics === 1 ? "" : "s"}` : null,
              ]
                .filter(Boolean)
                .join(" · ")}
        </span>
        <span aria-hidden className="domain-chevron">
          {open ? "⌄" : "›"}
        </span>
      </button>
      {open && (
        <div className="domain-body">
          {entry.value === "other" && (
            <p className="muted small">
              Published before the taxonomy existed. Each of these gets a domain — and a new
              address — on its next save.
            </p>
          )}
          <Notice kind="error">{listing.error}</Notice>
          {listing.loading && <p className="muted">Loading…</p>}
          <div className="market-grid">
            {(listing.data?.items ?? []).map((item) => (
              <ListingCard key={item.id} item={item} onTag={onTag} />
            ))}
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
    <div className="facet-row">
      <span className="facet-label">{label}</span>
      <button
        className={value === null ? "chip active" : "chip"}
        aria-pressed={value === null}
        onClick={() => onChange(null)}
        type="button"
      >
        Any
      </button>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className={value === option.value ? "chip active" : "chip"}
          aria-pressed={value === option.value}
          onClick={() => onChange(value === option.value ? null : option.value)}
        >
          {option.label} <span className="muted">{option.count}</span>
        </button>
      ))}
    </div>
  );
}

function ListingCard({ item, onTag }: { item: MarketCard; onTag: (tag: string) => void }) {
  return (
    <article className="listing">
      <header>
        <span className="listing-icon" aria-hidden>
          {item.icon || defaultIcon(item.kind)}
        </span>
        <div className="listing-title">
          <Link to={`/catalog/${item.id}`}>
            <strong>{item.title}</strong>
          </Link>
          {/* Version only. This carried the name as well, which read as a second fact while the
              heading above was the definition's title; now that the heading *is* the name, the
              two lines would have said it twice. */}
          <div className="muted mono">{item.apiVersion}</div>
          {/* Where it is filed, so a search result read outside its domain section still says
              which part of the estate it belongs to. */}
          <div className="muted small">
            {item.domain
              ? `${item.domain}${item.subdomain ? ` / ${item.subdomain}` : ""}`
              : "no domain yet"}
          </div>
        </div>
        <span className={`badge kind-${item.kind}`}>{KIND_LABELS[item.kind] ?? item.kind}</span>
      </header>

      <p className="listing-summary">
        {item.summary ?? <span className="muted">No summary yet.</span>}
      </p>

      <div className="listing-tags">
        {item.tags.slice(0, 5).map((tag) => (
          <button key={tag} type="button" className="chip small" onClick={() => onTag(tag)}>
            {tag}
          </button>
        ))}
      </div>

      <footer>
        <span className="listing-envs">
          {item.environments.length === 0 ? (
            <span className="badge warn">not published</span>
          ) : (
            /* Upper case, like every other environment name in the portal — the picker's chevrons,
               the page head's switcher, the certificates panel. The control plane returns them in
               promotion-chain order, so the row reads DEV → TEST → PROD. */
            item.environments.map((environment) => (
              <span key={environment} className="pill ok">
                {environment.toUpperCase()}
              </span>
            ))
          )}
        </span>
        <span className="muted">
          {item.operationCount} {countNoun(item.kind, item.operationCount)} ·{" "}
          {item.subscriberCount} subscriber{item.subscriberCount === 1 ? "" : "s"}
        </span>
        {item.subscribed && <span className="badge ok">subscribed</span>}
        {item.lifecycle !== "active" && <span className="badge warn">{item.lifecycle}</span>}
      </footer>
    </article>
  );
}

function countNoun(kind: string, n: number): string {
  if (kind === "mcp") return n === 1 ? "tool" : "tools";
  if (kind === "a2a") return n === 1 ? "skill" : "skills";
  return n === 1 ? "operation" : "operations";
}

function defaultIcon(kind: string): string {
  if (kind === "mcp") return "🔌";
  if (kind === "a2a") return "🤝";
  if (kind === "soap") return "🧼";
  return "🔗";
}
