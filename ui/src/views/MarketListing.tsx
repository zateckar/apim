import { useEffect, useId, useState } from "react";
import { api, type Application, type EffectivePolicyView, type MarketListingDetail, type Meta, type Subscription, type User } from "../api";
import {
  Panel,
  Action,
  CopyButton,
  EmptyState,
  EnvironmentPicker,
  Link,
  Notice,
  StatusChip,
  Skeleton,
  envLabel,
  useAsync,
  usePageTitle,
} from "../components";
import { endpointChip, lifecycleChip, listingAccessChip, unpublishedChip } from "../lib/status";
import { formatDateTime } from "../lib/datetime";
import { PlaygroundPanel } from "./PlaygroundPanel";
import { CallExample, callExample, type KeyUnit } from "./SubscriptionView";
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
const TABS: Tab[] = ["overview", "operations", "start", "try", "versions"];

/**
 * The tab an address asks for, or Overview. `?tab=` is how the portal's own screens link to a
 * panel (api-edit-properties, "A link lands on a specific panel"), and the listing did not read it —
 * so a reload, the back button from the wizard, or "how to call it" in a message all landed on
 * Overview. A tab that is not offered — Versions, for a resource with one — opens Overview rather
 * than a blank panel.
 */
export function listingTab(asked: string | null, versions: number): Tab {
  const tab = TABS.find((candidate) => candidate === asked) ?? "overview";
  return tab === "versions" && versions <= 1 ? "overview" : tab;
}

/** The states in which a consumer's subscription is, or is about to be, access. */
const HELD = ["active", "activating", "pending"];

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
  // The reader's own subscriptions, to say *where* they already have access and through which of
  // their applications. The card's `subscribed` flag says only that some application somewhere does.
  const mine = useAsync(() => api.get<{ items: Subscription[] }>("/api/subscriptions"), []);
  const [asked] = useState(() => new URLSearchParams(window.location.search).get("tab"));
  const [chosen, setChosen] = useState<Tab | null>(null);
  const tabId = useId();
  const item = listing.data;
  usePageTitle(item ? `${item.title} ${item.apiVersion}` : null);
  const tab = chosen ?? listingTab(asked, item?.versions.length ?? 0);

  // Replaced, not pushed: switching tabs is looking, not going somewhere, and Back should leave
  // the listing rather than step through its tabs.
  useEffect(() => {
    if (!item) return;
    const params = new URLSearchParams(window.location.search);
    if (tab === "overview") params.delete("tab");
    else params.set("tab", tab);
    const search = params.toString();
    const next = `${window.location.pathname}${search ? `?${search}` : ""}`;
    if (next !== window.location.pathname + window.location.search) {
      window.history.replaceState(window.history.state, "", next);
    }
  }, [tab, item]);

  if (listing.error) {
    return (
      <EmptyState
        title="This listing could not be opened"
        detail={listing.error}
        action={<Link to="/catalog">Back to the catalog →</Link>}
      />
    );
  }
  if (!item) return <Skeleton rows={6} />;
  const publisherName = applications.find((application) => application.id === item.applicationId)?.name ?? item.applicationId;
  const tabs: Array<[Tab, string]> = [
    ["overview", "Overview"],
    ["operations", operationsLabel(item.kind)],
    ["start", "Getting started"],
    ["try", "Try it"],
    // A resource with one version has nothing to pick between, so no tab for it — the same rule the
    // workspace's version selector follows (api-edit-properties).
    ...(item.versions.length > 1 ? [["versions", "Versions"] as [Tab, string]] : []),
  ];

  // Only this reader's own applications, as the card's flag counts them — an administrator can act
  // for every application, and "subscribed" should not mean "somebody in the estate is".
  const productIds = new Set(item.products.map((product) => product.id));
  const held = (mine.data?.items ?? []).filter(
    (row) => productIds.has(row.productId) && user.applications.includes(row.applicationId) && HELD.includes(row.state),
  );
  const accessChip = (state: "active" | "waiting", rows: Subscription[]) =>
    rows.length === 0
      ? null
      : listingAccessChip(
          state,
          meta.chain.filter((env) => rows.some((row) => row.environment === env)).map(envLabel),
          [...new Set(rows.map((row) => row.applicationName ?? row.applicationId))],
        );
  const activeChip = accessChip("active", held.filter((row) => row.state === "active"));
  const waitingChip = accessChip("waiting", held.filter((row) => row.state !== "active"));

  return (
    <>
      {/* The object header, the same chrome the owner's resource page uses — a consumer arriving here
          and an owner arriving there must not feel like they are in two different products. The name
          is the page's own title now, so the header carries what the title does not. */}
      <div className="object-head consumer-resource-head">
        <div className="listing-head">
          <span className="listing-icon big" aria-hidden>
            {item.icon || "🔗"}
          </span>
          <div>
            <p className="listing-head-facts">
              <KindBadge kind={item.kind as Kind} />
              <StatusChip chip={lifecycleChip(item.lifecycle as never)} />
              {item.unpublished && <StatusChip chip={unpublishedChip()} />}
              <span className="muted">Published by {publisherName}</span>
            </p>
            <p className="muted">{item.summary?.trim() || "No summary provided."}</p>
          </div>
        </div>
        <div className="inline">
          <StatusChip chip={activeChip} />
          <StatusChip chip={waitingChip} />
          {mine.error && <span className="muted small">Your own subscriptions could not be read: {mine.error}</span>}
          {item.products.length > 0 ? (
            <Link className="btn primary" to={`/catalog/${item.id}/subscribe`}>New subscription</Link>
          ) : (
            <Action
              className="primary"
              permission={{
                enabled: false,
                reason: "Not in any product yet, so there is nothing to subscribe to. Its owner adds it to one from Products.",
              }}
              onClick={() => {}}
            >
              New subscription
            </Action>
          )}
        </div>
      </div>

      <div className="workspace-tabs" role="tablist" aria-label="Listing panels">
        {tabs.map(([value, label], index) => (
          <button
            key={value}
            type="button"
            role="tab"
            id={`${tabId}-${value}`}
            aria-selected={tab === value}
            aria-controls={`${tabId}-panel`}
            tabIndex={tab === value ? 0 : -1}
            className={tab === value ? "active" : ""}
            onClick={() => setChosen(value)}
            onKeyDown={(event) => {
              const next = event.key === "ArrowRight" ? (index + 1) % tabs.length
                : event.key === "ArrowLeft" ? (index + tabs.length - 1) % tabs.length
                : event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : null;
              if (next === null) return;
              event.preventDefault();
              setChosen(tabs[next]![0]);
              (event.currentTarget.parentElement?.children[next] as HTMLElement)?.focus();
            }}
          >
            {label}
          </button>
        ))}
      </div>

      <div role="tabpanel" id={`${tabId}-panel`} aria-labelledby={`${tabId}-${tab}`}>
        {tab === "overview" && <Overview item={item} />}
        {tab === "operations" && <Operations item={item} />}
        {tab === "start" && <GettingStarted item={item} />}
        {tab === "try" && <TryIt item={item} meta={meta} />}
        {tab === "versions" && <Versions item={item} />}
      </div>
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
        <div className="inline listing-env-choice">
          <span className="muted small">Call</span>
          <EnvironmentPicker chain={live} value={environment} onChange={setEnvironment} />
        </div>
      )}
      {/* No `onSubscribe`: without it the panel offers a link to the wizard, and a control that
          navigates is a link rather than a button. */}
      <PlaygroundPanel resourceId={item.id} environment={environment} />
    </>
  );
}

function operationsLabel(kind: string): string {
  if (kind === "mcp") return "Tools";
  if (kind === "a2a") return "Skills";
  return "Operations";
}

function Overview({ item }: { item: MarketListingDetail }) {
  const requests = item.traffic.reduce((sum, entry) => sum + entry.requests, 0);
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
              {envLabel(endpoint.environment)} <StatusChip chip={endpointChip(endpoint.live)} />
            </h4>
            {endpoint.urls.length > 0 ? (
              <ul className="url-list">
                {endpoint.urls.map((entry) => (
                  <li key={`${entry.gateway}:${entry.url}`}>
                    <span className="chip">
                      {entry.network === "intranet" ? "Intranet" : "Internet"}
                    </span>
                    <div className="copy-row">
                      <code>{entry.url}</code>
                      <CopyButton value={entry.url} what={`the ${envLabel(endpoint.environment)} ${entry.network} address`} />
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted">
                No gateway here publishes an address for it yet, so there is no URL to call.
              </p>
            )}
          </div>
        ))}
        {item.endpoints.length === 0 && <p className="muted">It has no route in any environment yet.</p>}
      </Panel>

      {item.a2a && (
        <Panel
          title="Agent card"
          hint="Served by the gateway with its address and security scheme rewritten, so following it reaches the gateway rather than the agent behind it."
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
                  <span key={name} className="chip">
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

      <Panel title="Recent traffic">
        <Sparkline points={item.traffic.map((entry) => entry.requests)} />
        <p className="muted listing-traffic">
          {item.traffic.length > 0
            ? `${requests.toLocaleString()} request${requests === 1 ? "" : "s"} since ${formatDateTime(item.traffic[0]!.windowStart)}`
            : "No calls recorded yet"}{" "}
          · {item.subscriberCount} subscriber{item.subscriberCount === 1 ? "" : "s"}
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
        hint="The gateway checks each call against the tool's input schema, so a malformed call comes back as a JSON-RPC error."
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
                This tool declares no input schema, so its arguments are not checked.
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
    <Panel title="Operations">
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
                  <span className="chip mono">{operation.method}</span>
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
  // Only environments with somewhere to send the call. The example was the server's, for whichever
  // environment the resource reached first, with `<gateway-host>` standing in for any route without
  // a host — the one part of the line a reader cannot guess, beside a panel that listed the real
  // addresses. It is built from those addresses now, the same way the subscription's page builds it.
  const callable = item.endpoints.filter((endpoint) => endpoint.live && endpoint.urls.length > 0);
  const [environment, setEnvironment] = useState(callable[0]?.environment ?? null);
  const endpoint = callable.find((entry) => entry.environment === environment) ?? callable[0] ?? null;
  const policy = useAsync(
    () =>
      endpoint
        ? api.get<EffectivePolicyView>(`/api/resources/${item.id}/policy/effective?environment=${encodeURIComponent(endpoint.environment)}`)
        : Promise.resolve(null),
    [item.id, endpoint?.environment],
  );
  const key = (policy.data?.document["auth.subscriptionKey"] as KeyUnit | undefined) ?? null;

  return (
    <>
      <Panel title="1 · Subscribe" hint="Subscribe to a product using the application that will call this resource.">
        {item.products.length > 0 ? (
          <>
            <p>
              {item.products.length === 1
                ? "It is sold through this product:"
                : `It is sold through ${item.products.length} products:`}
            </p>
            <ul className="units">
              {item.products.map((product) => (
                <li key={product.id}>
                  <strong>{product.name}</strong> <StatusChip chip={lifecycleChip(product.lifecycle as never)} />
                  {product.summary && <div className="muted">{product.summary}</div>}
                </li>
              ))}
            </ul>
            <Link className="btn primary" to={`/catalog/${item.id}/subscribe`}>New subscription</Link>
          </>
        ) : (
          <p className="muted">It is not in any product yet, so there is nothing to subscribe to.</p>
        )}
      </Panel>

      <Panel
        title="2 · Call it"
        hint="Set SUBSCRIPTION_KEY to your subscription's key first; the example sends it the way this resource asks for it."
      >
        <Notice kind="error">{policy.error}</Notice>
        {endpoint ? (
          <>
            {callable.length > 1 && (
              <div className="inline listing-env-choice">
                <span className="muted small">Against</span>
                <EnvironmentPicker
                  chain={callable.map((entry) => entry.environment)}
                  value={endpoint.environment}
                  onChange={setEnvironment}
                />
              </div>
            )}
            {policy.loading ? (
              <Skeleton rows={2} />
            ) : policy.data ? (
              <>
                <p className="small">
                  {key === null ? (
                    <>It asks for no subscription key in {envLabel(endpoint.environment)}.</>
                  ) : key.in === "header" ? (
                    <>In {envLabel(endpoint.environment)} the key goes in the <code>{key.name}</code> header.</>
                  ) : (
                    <>In {envLabel(endpoint.environment)} the key goes in the <code>{key.name}</code> query parameter.</>
                  )}
                </p>
                <CallExample text={callExample(item.kind, endpoint.urls[0]!.url, key, item.operations)} />
              </>
            ) : null}
          </>
        ) : item.example ? (
          <>
            <p className="muted">Against {envLabel(item.example.environment)} — no gateway publishes an address yet, so substitute the host:</p>
            <CallExample text={item.example.text} />
          </>
        ) : (
          <p className="muted">No calling example is available yet. Check the published addresses and release status in Overview.</p>
        )}
      </Panel>
    </>
  );
}

function Versions({ item }: { item: MarketListingDetail }) {
  return (
    <Panel
      title="Versions"
      hint="A breaking change is a new version, and every version stays callable until it is retired."
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
                {lifecycleChip(version.lifecycle as never)
                  ? <StatusChip chip={lifecycleChip(version.lifecycle as never)} />
                  : <span className="muted">Active</span>}
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
  if (points.length === 0) return null;
  const max = Math.max(1, ...points);
  const width = Math.max(points.length * 6, 120);
  const height = 40;
  const step = width / Math.max(points.length - 1, 1);
  const path = points
    .map((value, index) => `${index === 0 ? "M" : "L"}${index * step},${height - (value / max) * height}`)
    .join(" ");
  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="chart listing-spark" preserveAspectRatio="none">
      <path d={path} className="spark" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
