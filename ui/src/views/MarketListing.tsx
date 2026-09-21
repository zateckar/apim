import { useState } from "react";
import { api, type Application, type MarketListingDetail, type Meta, type User } from "../api";
import {
  Panel,
  EmptyState,
  EnvironmentPicker,
  Link,
  Notice,
  StatusChip,
  Term,
  go,
  useAsync,
} from "../components";
import { lifecycleChip } from "../lib/status";
import { PlaygroundPanel } from "./PlaygroundPanel";
import { DescriptionMarkdown } from "../portal/components/DescriptionMarkdown";
import { KindBadge, type Kind } from "../portal/components/KindBadge";

/**
 * One listing, in consumer mode (goal G6, plan §9.3).
 *
 * The tabs answer the questions a consumer asks in order: what is it, what can it do, how do I call
 * it, can I see it work, and which version am I looking at. Subscribing is the wizard rather than a
 * dialog here, because the decision has three parts and the last one — the terms being agreed to —
 * is the part a dialog had no room for.
 */

type Tab = "overview" | "operations" | "start" | "try" | "versions";

export function MarketListing({
  resourceId,
  user,
  meta,
  applications = [],
}: {
  resourceId: string;
  user: User;
  meta: Meta;
  applications?: Array<Pick<Application, "id" | "name">>;
}) {
  const listing = useAsync(
    () => api.get<MarketListingDetail>(`/api/catalog/${resourceId}`),
    [resourceId],
  );
  const [tab, setTab] = useState<Tab>("overview");

  if (listing.error) {
    return (
      <>
        <Notice kind="error">{listing.error}</Notice>
        <p>
          <Link to="/catalog">← Back to the catalog</Link>
        </p>
      </>
    );
  }
  if (!listing.data) return <p className="muted">Loading…</p>;
  const item = listing.data;
  const publisherName = applications.find((application) => application.id === item.applicationId)?.name ?? item.applicationId;

  return (
    <>
      <p className="muted">
        <Link to="/catalog">← Catalog</Link>
      </p>
      {/* The object header, the same chrome the owner's resource page uses — a consumer arriving here
          and an owner arriving there must not feel like they are in two different products. */}
      <div className="object-head consumer-resource-head">
        <div className="inline" style={{ alignItems: "flex-start" }}>
          <span className="listing-icon big" aria-hidden>
            {item.icon || "🔗"}
          </span>
          <div>
            <h3>
              {item.title} <span className="mono muted">{item.apiVersion}</span>{" "}
              <KindBadge kind={item.kind as Kind} />
              <StatusChip chip={lifecycleChip(item.lifecycle as never)} />
            </h3>
            <p className="muted small">
              {item.summary?.trim() || "No summary provided."} · owned by {publisherName}
              {item.unpublished && " · not published anywhere yet"}
            </p>
          </div>
        </div>
        <div className="inline">
          {item.subscribed && <StatusChip chip={{ label: "You subscribe", tone: "live", title: "one of your applications holds a key for this" }} />}
          <span className="action">
            <button
              className="btn primary"
              disabled={item.products.length === 0}
              title={
                item.products.length === 0
                  ? "This resource is not in any product yet, and a subscription is to a product — so there is nothing to ask for."
                  : undefined
              }
              onClick={() => go(`/catalog/${item.id}/subscribe`)}
            >
              Subscribe
            </button>
          </span>
        </div>
      </div>

      {item.products.length === 0 && (
        <Notice kind="warn">
          This resource is not in any <Term name="product" /> yet, so there is nothing to subscribe to. A
          product is the subscription unit — its owner adds it to one from{" "}
          <Link to="/products">My products</Link>.
        </Notice>
      )}

      <div className="tabs">
        {(
          [
            ["overview", "Overview"],
            ["operations", operationsLabel(item.kind)],
            ["start", "Getting started"],
            ["try", "Try it"],
            ["versions", "Versions"],
          ] as Array<[Tab, string]>
        ).map(([value, label]) => (
          <button key={value} className={tab === value ? "active" : ""} onClick={() => setTab(value)}>
            {label}
          </button>
        ))}
      </div>

      {tab === "overview" && <Overview item={item} />}
      {tab === "operations" && <Operations item={item} />}
      {tab === "start" && <GettingStarted item={item} />}
      {tab === "try" && <TryIt item={item} meta={meta} />}
      {tab === "versions" && <Versions item={item} />}
    </>
  );
}

/**
 * The consumer's playground, on the consumer's page. Same panel as the owner's Try it tab, because
 * they are the same act — and a consumer who can only try a resource by writing code first is a
 * consumer who has to trust the documentation.
 */
function TryIt({ item, meta }: { item: MarketListingDetail; meta: Meta }) {
  const live = item.endpoints.filter((endpoint) => endpoint.live).map((e) => e.environment);
  const [environment, setEnvironment] = useState(live[0] ?? meta.chain[0]!);

  if (live.length === 0) {
    return (
      <EmptyState
        title="Not live anywhere yet"
        detail="This resource has no environment currently serving it, so there is nothing to call."
        action={<Link to="/catalog">Back to the catalog →</Link>}
      />
    );
  }

  return (
    <>
      {live.length > 1 && (
        <div className="inline" style={{ marginBottom: 12 }}>
          <span className="muted small">Call</span>
          <EnvironmentPicker chain={live} value={environment} onChange={setEnvironment} />
        </div>
      )}
      <PlaygroundPanel
        resourceId={item.id}
        environment={environment}
        onSubscribe={() => go(`/catalog/${item.id}/subscribe`)}
      />
    </>
  );
}

function operationsLabel(kind: string): string {
  if (kind === "mcp") return "Tools";
  if (kind === "a2a") return "Skills";
  return "Operations";
}

function Overview({ item }: { item: MarketListingDetail }) {
  return (
    <div className="listing-overview">
      <Panel title="What it is" className="listing-description">
        {item.description?.trim() ? <DescriptionMarkdown source={item.description} /> : <p className="muted">No description provided.</p>}
        {item.tags.length > 0 && (
          <div className="listing-tags">
            {item.tags.map((tag) => (
              <span key={tag} className="chip small">
                {tag}
              </span>
            ))}
          </div>
        )}
        {item.docsUrl && (
          <p>
            <a href={item.docsUrl} target="_blank" rel="noreferrer">
              Documentation ↗
            </a>
          </p>
        )}
      </Panel>

      <Panel
        title="Where it is live"
        // Two clauses, not five. The hint was three lines of how releases converge above a list
        // that is usually one line long — the explanation outweighed the answer, and the part a
        // caller acts on (which of two names they can reach) was at the end of it.
        hint="One line per gateway address; which one you can reach depends on where you call from."
      >
        {item.endpoints.map((endpoint) => (
          <div key={endpoint.environment} className="endpoint-block">
            <h4>
              {endpoint.environment.toUpperCase()}{" "}
              {endpoint.live ? (
                <span className="badge ok">live</span>
              ) : (
                <span className="badge">routed, not released</span>
              )}
            </h4>
            {endpoint.urls.length > 0 ? (
              <ul className="url-list">
                {endpoint.urls.map((entry) => (
                  <li key={`${entry.gateway}:${entry.url}`}>
                    <span className="badge">
                      {entry.network === "intranet" ? "Intranet" : "Internet"}
                    </span>
                    <span className="mono">{entry.url}</span>
                    <span className="muted small">
                      {entry.gateway}
                      {entry.label ? ` · ${entry.label}` : ""}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted">
                <span className="mono">
                  {endpoint.host === "*" ? "" : endpoint.host}
                  {endpoint.basePath}
                </span>{" "}
                — no gateway here has a published address yet, so there is no URL to call.
              </p>
            )}
          </div>
        ))}
        {item.endpoints.length === 0 && <p className="muted">No routes yet.</p>}
      </Panel>

      {item.a2a && (
        <Panel
          title="Agent card"
          hint="Served by the gateway, with the URL and the security scheme rewritten — follow it and you reach us, not the origin."
        >
          <dl className="kv">
            <dt>Protocol</dt>
            <dd className="mono">{item.a2a.protocolVersion}</dd>
            <dt>Card path</dt>
            <dd className="mono">{item.a2a.cardPath}</dd>
            <dt>Capabilities</dt>
            <dd>
              {Object.entries(item.a2a.capabilities)
                .filter(([, on]) => on)
                .map(([name]) => (
                  <span key={name} className="pill ok">
                    {name}
                  </span>
                ))}
              {Object.values(item.a2a.capabilities).every((on) => !on) && (
                <span className="muted">none declared</span>
              )}
            </dd>
          </dl>
        </Panel>
      )}

      {item.mcp && (
        <Panel title="MCP server">
          <dl className="kv">
            <dt>Protocol</dt>
            <dd className="mono">{item.mcp.protocolVersion}</dd>
            <dt>Server</dt>
            <dd className="mono">
              {item.mcp.serverInfo.name}
              {item.mcp.serverInfo.version ? ` ${item.mcp.serverInfo.version}` : ""}
            </dd>
          </dl>
        </Panel>
      )}

      <Panel title="Recent traffic" hint="From the telemetry the gateways already report.">
        <Sparkline points={item.traffic.map((entry) => entry.requests)} />
        <p className="muted" style={{ marginBottom: 0 }}>
          {item.traffic.reduce((sum, entry) => sum + entry.requests, 0)} requests across{" "}
          {item.traffic.length} retained window{item.traffic.length === 1 ? "" : "s"} ·{" "}
          {item.subscriberCount} subscriber{item.subscriberCount === 1 ? "" : "s"}
        </p>
      </Panel>
    </div>
  );
}

function Operations({ item }: { item: MarketListingDetail }) {
  if (item.operations.length === 0) {
    return (
      /* An empty state, not a card with a sentence in it: the tab has nothing to show and the
         reader needs somewhere to go. */
      <EmptyState
        title="No contract has been imported yet"
        detail="There is nothing to list until the owner imports a definition. The catalog listing shows what a contract declares; it cannot invent one."
        action={<Link to="/catalog">Back to the catalog →</Link>}
      />
    );
  }

  if (item.kind === "mcp") {
    return (
      <Panel
        title="Tools"
        hint="Input schemas are enforced at the gateway, so a malformed call comes back as a JSON-RPC error."
      >
        {item.operations.map((operation) => (
          <div className="unit" key={operation.id}>
            <header>
              <h4>
                {operation.title ?? operation.name} <span className="mono muted">{operation.name}</span>
              </h4>
            </header>
            <p className="desc">{operation.summary ?? "No description."}</p>
            {operation.inputSchema ? (
              <pre className="pre">{JSON.stringify(operation.inputSchema, null, 2)}</pre>
            ) : (
              <p className="muted">
                This tool declares no input schema, so its arguments are not validated here.
              </p>
            )}
          </div>
        ))}
      </Panel>
    );
  }

  if (item.kind === "a2a") {
    return (
      <Panel title="Skills" hint="What the agent's card says it can do.">
        {item.operations.map((operation) => (
          <div className="unit" key={operation.id}>
            <header>
              <h4>
                {operation.name} <span className="mono muted">{operation.id}</span>
              </h4>
            </header>
            <p className="desc">{operation.summary ?? "No description."}</p>
            <div className="listing-tags">
              {(operation.tags ?? []).map((tag) => (
                <span key={tag} className="chip small">
                  {tag}
                </span>
              ))}
            </div>
            {(operation.examples ?? []).length > 0 && (
              <ul className="units">
                {operation.examples!.map((example) => (
                  <li key={example}>“{example}”</li>
                ))}
              </ul>
            )}
          </div>
        ))}
      </Panel>
    );
  }

  return (
    <Panel title="Operations" hint="From this resource's own definition — the same one validation uses.">
      <table>
        <thead>
          <tr>
            <th>{item.kind === "soap" ? "Operation" : "Method"}</th>
            <th>{item.kind === "soap" ? "SOAPAction" : "Path"}</th>
            <th>Summary</th>
          </tr>
        </thead>
        <tbody>
          {item.operations.map((operation) => (
            <tr key={operation.id}>
              <td>
                {item.kind === "soap" ? (
                  <strong>{operation.id}</strong>
                ) : (
                  <span className="badge">{operation.method}</span>
                )}
              </td>
              <td className="mono">
                {item.kind === "soap" ? (operation.soapAction ?? <span className="muted">none</span>) : operation.path}
              </td>
              <td>
                {operation.summary ?? <span className="muted">—</span>}
                {item.kind !== "soap" && (
                  <div className="mono muted">{operation.id}</div>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Panel>
  );
}

function GettingStarted({ item }: { item: MarketListingDetail }) {
  return (
    <>
      <Panel title="1 · Subscribe" hint="Subscribe to a product using the application that will call this resource.">
        <p>
          {item.products.length === 1
            ? "Subscribe through this product:"
            : `Subscribe through one of these ${item.products.length} products:`}
        </p>
        <ul className="units">
          {item.products.map((product) => (
            <li key={product.id}>
              <strong>{product.name}</strong>{" "}
              {product.lifecycle !== "active" && <span className="badge warn">{product.lifecycle}</span>}
              {product.summary && <div className="muted">{product.summary}</div>}
            </li>
          ))}
          {item.products.length === 0 && <li className="muted">Not in any product yet.</li>}
        </ul>
      </Panel>

      <Panel
        title="2 · Call it"
        hint="Built from the live route and the credential this route actually requires, so it works as pasted once you substitute the key."
      >
        {item.example ? (
          <>
            <p className="muted">
              Against <strong>{item.example.environment}</strong>:
            </p>
            <pre className="pre">{item.example.text}</pre>
          </>
        ) : (
          <p className="muted">No calling example is available yet. Check the published addresses and release status in Overview.</p>
        )}
        {item.products.length === 0 && (
          <p className="muted" style={{ marginBottom: 0 }}>
            There is nothing to subscribe to yet, so the key above is hypothetical.
          </p>
        )}
      </Panel>
    </>
  );
}

function Versions({ item }: { item: MarketListingDetail }) {
  return (
    <Panel
      title="Versions"
      hint="A breaking change is a new version rather than a new revision, and both stay callable until one is retired."
    >
      <table>
        <thead>
          <tr>
            <th>Version</th>
            <th>Lifecycle</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {item.versions.map((version) => (
            <tr key={version.id}>
              <td>
                <strong>{version.api_version}</strong>
                {version.id === item.id && <span className="muted"> — this one</span>}
              </td>
              <td>
                <span className={`badge ${version.lifecycle === "active" ? "ok" : "warn"}`}>
                  {version.lifecycle}
                </span>
              </td>
              <td>
                {version.id !== item.id && <Link to={`/catalog/${version.id}`}>Open</Link>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Panel>
  );
}


/** Twenty lines of SVG rather than a charting dependency, like the rest of this UI. */
function Sparkline({ points }: { points: number[] }) {
  if (points.length === 0) return <p className="muted">No traffic recorded yet.</p>;
  const max = Math.max(1, ...points);
  const width = Math.max(points.length * 6, 120);
  const height = 40;
  const step = width / Math.max(points.length - 1, 1);
  const path = points
    .map((value, index) => `${index === 0 ? "M" : "L"}${index * step},${height - (value / max) * height}`)
    .join(" ");
  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="chart" style={{ height }} preserveAspectRatio="none">
      <path d={path} className="spark" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

