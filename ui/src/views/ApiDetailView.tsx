import { useEffect, useState } from "react";
import {
  api,
  type FleetHealth,
  type Meta,
  type ResourceDetail,
  type Subscription,
  type User,
} from "../api";
import {
  Action,
  AttentionList,
  Card,
  DangerZone,
  Digest,
  EmptyState,
  EnvironmentPicker,
  Field,
  Link,
  Notice,
  Skeleton,
  StatusChip,
  Term,
  useAction,
  useAsync,
} from "../components";
import { go } from "../components";
import { ALLOWED, permit, type Permission } from "../lib/capabilities";
import { lifecycleChip, releaseChip, subscriptionChip } from "../lib/status";
import { PlaygroundPanel } from "./PlaygroundPanel";
import { PolicyEditor } from "./PolicyEditor";
import { PromotionPanel } from "./PromotionPanel";
import { RevisionsPanel } from "./RevisionsPanel";
import { VersionWizard } from "./VersionWizard";

/**
 * The API page (plan §9.3).
 *
 * One page, one vocabulary, and the tab in the address — so an attention row, an error message or a
 * colleague's link can point at the exact panel that fixes the thing, rather than at the page and a
 * sentence saying which tab to click.
 *
 * **Overview is the default and is new.** The old default was Definition, which answers a question
 * only the person who just uploaded something has. Everybody else arrives asking "is this working,
 * where, and what is wrong with it" — which is what Overview answers.
 */
const TABS = [
  { id: "overview", label: "Overview" },
  { id: "definition", label: "Definition" },
  { id: "revisions", label: "Revisions" },
  { id: "routing", label: "Routing" },
  { id: "policies", label: "Policies" },
  { id: "publish", label: "Publish" },
  { id: "subscribers", label: "Subscribers" },
  { id: "try", label: "Try it" },
  { id: "listing", label: "Listing" },
] as const;

/** Everything in design §6.1's edited-in-place tier is per environment; the contract is not. */
const PER_ENVIRONMENT = new Set(["overview", "routing", "policies", "publish", "subscribers", "try"]);

export function ApiDetailView({
  resourceId,
  tab,
  user,
  meta,
  environment,
  onEnvironment,
}: {
  resourceId: string;
  tab: string;
  user: User;
  meta: Meta;
  environment: string;
  onEnvironment: (next: string) => void;
}) {
  const detail = useAsync(() => api.get<ResourceDetail>(`/api/resources/${resourceId}`), [resourceId]);

  if (detail.error) return <Notice kind="error">{detail.error}</Notice>;
  if (!detail.data) return <Skeleton rows={6} />;
  const resource = detail.data;
  const owner = { team: resource.teamId };
  const canEdit = permit("edit", resource.capabilities, owner);
  const canPublish = permit("publish", resource.capabilities, owner);
  const canPolicy = permit("policy", resource.capabilities, owner);
  const current = TABS.some((candidate) => candidate.id === tab) ? tab : "overview";
  // The version wizard is a screen you arrive at from this page, not a tab on it: it produces a
  // *different* API, so leaving it on the tab strip would suggest it edits this one.
  if (tab === "version") {
    return <VersionWizard resource={resource} meta={meta} canPublish={canPublish} />;
  }

  const liveIn = [
    ...new Set(
      resource.releases.filter((release) => release.state === "converged").map((r) => r.environment),
    ),
  ];

  return (
    <>
      {/* The object header: which API this page is about, where it is live, and who owns it. */}
      <div className="object-head">
        <div>
          <h3>
            {resource.name} <span className="mono muted">{resource.apiVersion}</span>{" "}
            <span className={`badge kind-${resource.kind}`}>{resource.kind}</span>
            <StatusChip chip={lifecycleChip(resource.lifecycle as never)} />
          </h3>
          <p className="muted small">
            {liveIn.length > 0 ? (
              <>
                Live in{" "}
                {liveIn.map((name) => (
                  <span key={name} className="pill ok">
                    {name}
                  </span>
                ))}
              </>
            ) : (
              <>Not published anywhere yet.</>
            )}{" "}
            · Team <strong>{resource.teamId}</strong> ·{" "}
            <Link to={`/catalog/${resource.id}`}>See it as a consumer does</Link>
          </p>
        </div>
        <div className="inline" style={{ alignItems: "flex-end" }}>
          {resource.versions.length > 1 && (
            <div className="field" style={{ maxWidth: 180 }}>
              <label htmlFor="version-switch">
                <Term name="version" />
              </label>
              <select
                id="version-switch"
                value={resource.id}
                onChange={(event) => go(`/apis/${event.target.value}/${current}`)}
              >
                {resource.versions.map((version) => (
                  <option key={version.id} value={version.id}>
                    {version.apiVersion}
                    {version.lifecycle === "active" ? "" : ` (${version.lifecycle})`}
                  </option>
                ))}
              </select>
            </div>
          )}
          <Action permission={canPublish} onClick={() => go(`/apis/${resource.id}/version`)}>
            New version
          </Action>
        </div>
      </div>

      <div className="tabs">
        {TABS.map((candidate) => (
          <button
            key={candidate.id}
            className={current === candidate.id ? "active" : ""}
            onClick={() => go(`/apis/${resource.id}/${candidate.id}`)}
          >
            {candidate.label}
          </button>
        ))}
      </div>

      {PER_ENVIRONMENT.has(current) && (
        <div className="inline" style={{ marginBottom: 14 }}>
          <span className="muted small">Showing</span>
          <EnvironmentPicker chain={meta.chain} value={environment} onChange={onEnvironment} />
        </div>
      )}

      {current === "overview" && (
        <Overview resource={resource} environment={environment} reload={detail.reload} canEdit={canEdit} />
      )}
      {current === "definition" && (
        <Definition resource={resource} reload={detail.reload} canEdit={canEdit.enabled} />
      )}
      {current === "revisions" && (
        <RevisionsPanel resourceId={resource.id} chain={meta.chain} canEdit={canEdit} />
      )}
      {current === "routing" && (
        <Routing
          resource={resource}
          reload={detail.reload}
          canEdit={canPublish.enabled}
          environment={environment}
        />
      )}
      {current === "policies" && (
        <PolicyEditor
          resource={resource}
          meta={meta}
          canEdit={canPolicy.enabled}
          environment={environment}
        />
      )}
      {current === "publish" && (
        <>
          <Publish
            resource={resource}
            reload={detail.reload}
            canEdit={canPublish.enabled}
            environment={environment}
          />
          {/* Promotion is not a separate idea from publishing — it is publishing into the next
              environment along — so §9.7 folds the old Promotion tab in here. */}
          <PromotionPanel resource={resource} user={user} onChanged={detail.reload} />
        </>
      )}
      {current === "subscribers" && <Subscribers resource={resource} environment={environment} />}
      {current === "try" && (
        // Owning an API is not being one of its callers: on a key-protected route the owner needs a
        // subscription like anybody else, and this is the cheapest moment to teach that `[P1-10]`.
        <PlaygroundPanel
          resourceId={resource.id}
          environment={environment}
          onSubscribe={() => go(`/catalog/${resource.id}/subscribe`)}
        />
      )}
      {current === "listing" && (
        <Listing resource={resource} reload={detail.reload} canEdit={canEdit.enabled} />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------- overview

/**
 * What this API is, where it is live, and what is wrong with it — the attention rows straight from
 * the control plane's one evaluator, so this banner and Home cannot disagree.
 */
function Overview({
  resource,
  environment,
  reload,
  canEdit,
}: {
  resource: ResourceDetail;
  environment: string;
  reload: () => void;
  canEdit: Permission;
}) {
  const here = resource.attention.filter(
    (row) => row.environment === undefined || row.environment === environment,
  );
  const route = resource.routes.find((candidate) => candidate.environment === environment);
  const binding = resource.bindings.find((candidate) => candidate.environment === environment);
  const live = resource.releases.find(
    (release) => release.state === "converged" && release.environment === environment,
  );

  return (
    <>
      {here.length > 0 && (
        <Card title="What needs attention">
          <AttentionList rows={here} />
        </Card>
      )}

      <Card title={`In ${environment.toUpperCase()}`}>
        <dl className="kv">
          <dt>Serving</dt>
          <dd>
            {live ? (
              <>
                <StatusChip chip={releaseChip("converged")} /> revision {live.rev}, published by{" "}
                {live.released_by} on {new Date(live.released_at).toLocaleDateString()}
              </>
            ) : (
              <span className="muted">
                Nothing. Publish a <Term name="revision" /> here to make it callable.
              </span>
            )}
          </dd>
          <dt>
            <Term name="route" />
          </dt>
          <dd>
            {route ? (
              <span className="mono">
                {route.host === "*" ? "any host" : route.host}
                {route.basePath}
              </span>
            ) : (
              <span className="muted">Not set for this environment.</span>
            )}
          </dd>
          <dt>
            <Term name="backend" />
          </dt>
          <dd>
            {binding ? (
              <span className="mono">{binding.backend.urls.join(", ")}</span>
            ) : (
              <span className="muted">Not set for this environment.</span>
            )}
          </dd>
          <dt>
            <Term name="product">Products</Term>
          </dt>
          <dd>
            {resource.products.length === 0 ? (
              <span className="muted">
                In none, so nobody can subscribe to it. A <Term name="subscription" /> is to a
                product, never to an API directly.
              </span>
            ) : (
              resource.products.map((product) => (
                <span key={product.id} className="pill">
                  {product.name}
                </span>
              ))
            )}
          </dd>
        </dl>
      </Card>

      <Lifecycle resource={resource} reload={reload} canEdit={canEdit} />
    </>
  );
}

/**
 * Lifecycle is a property of the version and is global across the chain — design §6.1's
 * per-environment tier does not include it, and saying so on the control is cheaper than the
 * support question that follows from not saying it.
 */
function Lifecycle({
  resource,
  reload,
  canEdit,
}: {
  resource: ResourceDetail;
  reload: () => void;
  canEdit: Permission;
}) {
  const [lifecycle, setLifecycle] = useState(resource.lifecycle);
  const [sunsetAt, setSunsetAt] = useState(resource.sunsetAt?.slice(0, 10) ?? "");
  const action = useAction();

  return (
    <Card
      title="Lifecycle"
      hint="Global across every environment, not per environment. Deprecated keeps serving and warns every caller on every response; retired stops new subscriptions and leaves existing ones working."
    >
      <Notice kind="error">{action.error}</Notice>
      <Notice kind="ok">{action.message}</Notice>
      <div className="row">
        <div className="field">
          <label htmlFor="lifecycle">State</label>
          <select
            id="lifecycle"
            value={lifecycle}
            disabled={!canEdit.enabled}
            onChange={(event) => setLifecycle(event.target.value)}
          >
            <option value="active">active — the current version</option>
            <option value="deprecated">deprecated — still served, a newer one exists</option>
            <option value="retired">retired — no longer served</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="sunset">Sunset date</label>
          <input
            id="sunset"
            type="date"
            value={sunsetAt}
            disabled={!canEdit.enabled}
            onChange={(event) => setSunsetAt(event.target.value)}
          />
        </div>
        <Action
          permission={canEdit}
          busy={action.busy}
          onClick={async () => {
            const ok = await action.run(
              () =>
                api.patch(
                  `/api/resources/${resource.id}`,
                  { lifecycle, sunsetAt: sunsetAt ? new Date(sunsetAt).toISOString() : null },
                  resource.etag,
                ),
              "Saved. Every gateway picks it up at its next poll.",
            );
            if (ok) reload();
          }}
        >
          Save
        </Action>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------- subscribers

/** Who is calling this, and how hard. An owner's first question when something looks wrong. */
function Subscribers({ resource, environment }: { resource: ResourceDetail; environment: string }) {
  const subscriptions = useAsync(
    () =>
      Promise.all(
        resource.products.map((product) =>
          api.get<{ items: Subscription[] }>(`/api/subscriptions?product=${product.id}`),
        ),
      ).then((results) => results.flatMap((result) => result.items)),
    [resource.id, resource.products.length],
  );

  if (resource.products.length === 0) {
    return (
      <EmptyState
        title="Nobody can subscribe to this yet"
        detail="Consumers subscribe to a product, never to an API directly. Until this API is in one, there is nothing for them to ask for."
        action={<Link to="/products">Put it in a product →</Link>}
      />
    );
  }
  if (subscriptions.error) return <Notice kind="error">{subscriptions.error}</Notice>;
  if (!subscriptions.data) return <Skeleton rows={4} />;
  const here = subscriptions.data.filter((row) => row.environment === environment);

  return (
    <Card
      title={`Subscribers in ${environment.toUpperCase()}`}
      hint="Every application with a key that reaches this API here. Keys are per environment, so this list is too."
    >
      {here.length === 0 ? (
        <EmptyState
          title="No subscribers in this environment"
          detail="Nobody has taken a key for this API here yet. That is normal for a version that has just been published."
          action={<Link to={`/apis/${resource.id}/try`}>Call it yourself →</Link>}
        />
      ) : (
        <table>
          <thead>
            <tr>
              <th>Application</th>
              <th>Product</th>
              <th>State</th>
              <th>Key last rotated</th>
            </tr>
          </thead>
          <tbody>
            {here.map((subscription) => (
              <tr key={subscription.id}>
                <td>
                  <Link to={`/subscriptions/${subscription.id}`}>{subscription.applicationName}</Link>
                </td>
                <td className="muted">{subscription.productName}</td>
                <td>
                  <StatusChip chip={subscriptionChip(subscription.state)} />
                </td>
                <td className="muted small">
                  {subscription.keyRotatedAt
                    ? new Date(subscription.keyRotatedAt).toLocaleDateString()
                    : "never"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}


// ---------------------------------------------------------------------------- definition

function Definition({
  resource,
  reload,
  canEdit,
}: {
  resource: ResourceDetail;
  reload: () => void;
  canEdit: boolean;
}) {
  // mcp and a2a are published by *asking the endpoint what it offers* rather than by uploading a
  // document somebody wrote: there is no OpenAPI for an MCP server, and an agent's card is the
  // contract. The rest of the screen — revisions, freezing, export — is identical, because after
  // discovery they are ordinary revisions (plan sections 9 and 10).
  const discoverable = resource.kind === "mcp" || resource.kind === "a2a";
  const [specUrl, setSpecUrl] = useState(
    resource.discoveryUrl ??
      // The demo endpoints `scripts/stack.ps1` starts, so the first click works out of the box.
      (resource.kind === "mcp"
        ? "http://127.0.0.1:9085/mcp"
        : resource.kind === "a2a"
          ? "http://127.0.0.1:9086"
          : "https://petstore.swagger.io/v2/swagger.json"),
  );
  const [pasted, setPasted] = useState("");
  const [name, setName] = useState(resource.name);
  const [apiVersion, setApiVersion] = useState(resource.apiVersion);
  const importAction = useAction();
  const editAction = useAction();

  const announce = (result: { rev: number; unchanged: boolean }) =>
    importAction.setMessage(
      result.unchanged
        ? `unchanged: this is already revision ${result.rev}`
        : `revision ${result.rev} created`,
    );

  return (
    <>
      <Card
        title={discoverable ? "Discover the endpoint" : "Import a definition"}
        hint={
          discoverable
            ? resource.kind === "mcp"
              ? "The gateway initializes a session, walks tools, resources and prompts through their cursors, and stores what came back as the revision. There is no document to upload, so what is published is what the server said it offers at that moment."
              : "The agent's card is the contract. Both the current well-known path and the legacy one are tried, and the card is stored verbatim — the gateway rewrites it when serving so a consumer who follows it reaches us rather than the origin."
            : "Uploads are normalized into one internal model (design section 4.1); the original is kept verbatim beside it. Swagger 2.0 and OpenAPI 3.x, JSON. The URL is checked against the admin-registered egress allowlist before anything is fetched."
        }
      >
        <Notice kind="error">{importAction.error}</Notice>
        <Notice kind="ok">{importAction.message}</Notice>
        <div className="row">
          <Field
            label={discoverable ? (resource.kind === "mcp" ? "MCP endpoint" : "Agent base URL") : "Spec URL"}
            value={specUrl}
            onChange={setSpecUrl}
          />
          <button
            disabled={!canEdit || importAction.busy || !specUrl}
            onClick={async () => {
              const ok = await importAction.run(async () => {
                announce(
                  await api.post<{ rev: number; unchanged: boolean }>(
                    `/api/resources/${resource.id}/revisions`,
                    discoverable ? { discoverUrl: specUrl } : { specUrl },
                  ),
                );
              });
              if (ok) reload();
            }}
          >
            {discoverable ? "Discover" : "Import from URL"}
          </button>
        </div>

        {discoverable && resource.discoveryUrl && (
          <div className="row" style={{ marginTop: 12 }}>
            <p className="muted" style={{ flex: 1, margin: 0 }}>
              Last discovered from <span className="mono">{resource.discoveryUrl}</span>. Re-reading
              it creates a revision only if what the endpoint offers has actually changed — an
              unchanged answer is a no-op, not a new revision.
            </p>
            <button
              className="ghost"
              disabled={!canEdit || importAction.busy}
              onClick={async () => {
                const ok = await importAction.run(async () => {
                  announce(
                    await api.post<{ rev: number; unchanged: boolean }>(
                      `/api/resources/${resource.id}/regenerate`,
                    ),
                  );
                });
                if (ok) reload();
              }}
            >
              Re-discover
            </button>
          </div>
        )}

        <div className="field" style={{ marginTop: 12 }}>
          <label>
            …or paste{" "}
            {resource.kind === "mcp"
              ? "a manifest"
              : resource.kind === "a2a"
                ? "an agent card"
                : "a document"}
          </label>
          <textarea
            value={pasted}
            placeholder={
              resource.kind === "mcp"
                ? '{"serverInfo":{…},"capabilities":{…},"tools":[…]}'
                : resource.kind === "a2a"
                  ? '{"name":"…","skills":[…]}'
                  : '{"swagger":"2.0", …}'
            }
            onChange={(event) => setPasted(event.target.value)}
          />
        </div>
        <button
          className="ghost"
          disabled={!canEdit || importAction.busy || !pasted.trim()}
          onClick={async () => {
            const ok = await importAction.run(async () => {
              announce(
                await api.post<{ rev: number; unchanged: boolean }>(
                  `/api/resources/${resource.id}/revisions`,
                  { spec: pasted },
                ),
              );
            });
            if (ok) {
              setPasted("");
              reload();
            }
          }}
        >
          Create revision from pasted document
        </button>
      </Card>

      <Card title="Revisions" hint="A revision freezes on its first release; iterating means a new revision.">
        <table>
          <thead>
            <tr>
              <th>Rev</th>
              <th>Format</th>
              <th>Version digest</th>
              <th>Frozen</th>
              <th>Author</th>
              <th>Export</th>
            </tr>
          </thead>
          <tbody>
            {resource.revisions.map((revision) => (
              <tr key={revision.id}>
                <td>
                  <strong>{revision.rev}</strong>
                </td>
                <td className="mono">{revision.original_format}</td>
                <td>
                  <Digest value={revision.version_digest} />
                </td>
                <td>
                  {revision.frozen_at ? <span className="badge">frozen</span> : <span className="muted">—</span>}
                </td>
                <td className="muted">{revision.created_by}</td>
                <td className="inline">
                  <a
                    href={`/api/revisions/${revision.id}/spec?format=${
                      resource.kind === "soap" ? "model" : "openapi-3.1"
                    }`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {resource.kind === "soap" ? "model" : "OpenAPI 3.1"}
                  </a>
                  <a href={`/api/revisions/${revision.id}/spec?format=original`} target="_blank" rel="noreferrer">
                    {resource.kind === "mcp"
                      ? "manifest"
                      : resource.kind === "a2a"
                        ? "agent card"
                        : "original"}
                  </a>
                </td>
              </tr>
            ))}
            {resource.revisions.length === 0 && (
              <tr>
                <td colSpan={6} className="muted">
                  {discoverable
                    ? "No revisions yet — discover the endpoint above."
                    : "No revisions yet — import the petstore document above."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Card>

      <Card title="Properties">
        <Notice kind="error">{editAction.error}</Notice>
        <Notice kind="ok">{editAction.message}</Notice>
        <div className="row">
          <Field label="Name" value={name} onChange={setName} />
          <Field label="API version" value={apiVersion} onChange={setApiVersion} />
          <button
            className="ghost"
            disabled={!canEdit || editAction.busy}
            onClick={async () => {
              const ok = await editAction.run(
                () => api.patch(`/api/resources/${resource.id}`, { name, apiVersion }, resource.etag),
                "saved",
              );
              if (ok) reload();
            }}
          >
            Save
          </button>
        </div>
        <p className="muted" style={{ marginTop: 10, marginBottom: 0 }}>
          Saving sends <span className="mono">If-Match: {resource.etag.slice(0, 12)}…</span>, so a
          concurrent edit is a conflict rather than a silent overwrite.
        </p>

        <DangerZone
          what={`Delete ${resource.name} ${resource.apiVersion}`}
          name={resource.name}
          consequence="Every gateway stops serving it at its next poll, every subscription to it stops working, and its revisions and release history go with it."
          permission={canEdit ? ALLOWED : { enabled: false, reason: "Only the owning team, or an administrator, can delete this." }}
          busy={editAction.busy}
          error={editAction.error}
          onConfirm={async () => {
            const ok = await editAction.run(() => api.del(`/api/resources/${resource.id}`));
            if (ok) go("/apis");
          }}
        />
      </Card>
    </>
  );
}

// ---------------------------------------------------------------------------- listing (G6)

const ICONS = ["🔗", "🐾", "📦", "💳", "🚗", "🧾", "📊", "🔌", "🤝", "🧼", "🗺️", "🔐", "📨", "⚙️"];

/**
 * What this API looks like in the Catalog.
 *
 * Nothing here changes behaviour except `visibility`, and that one exception is worth stating on
 * the screen: for an A2A agent it also decides whether the gateway serves the agent card without a
 * key, which is the difference between an agent other agents can discover and one they cannot.
 *
 * The preview is not decoration either. A summary is written once and read by everyone who has to
 * decide whether to use this API, and the only way to write a good one is to see it in the shape it
 * will be read in.
 */
function Listing({
  resource,
  reload,
  canEdit,
}: {
  resource: ResourceDetail;
  reload: () => void;
  canEdit: boolean;
}) {
  const [summary, setSummary] = useState(resource.summary ?? "");
  const [description, setDescription] = useState(resource.description ?? "");
  const [tags, setTags] = useState(resource.tags.join(", "));
  const [docsUrl, setDocsUrl] = useState(resource.docsUrl ?? "");
  const [icon, setIcon] = useState(resource.icon ?? "");
  const [visibility, setVisibility] = useState(resource.visibility);
  const action = useAction();

  const parsedTags = tags
    .split(",")
    .map((tag) => tag.trim().toLowerCase())
    .filter(Boolean);

  return (
    <>
      <Card
        title="Catalog listing"
        hint="How this API is presented to the people who might subscribe to it. Search matches these fields and the contract itself — operation ids, MCP tool names, A2A skills — so a good summary is worth more than a long description."
      >
        <Notice kind="error">{action.error}</Notice>
        <Notice kind="ok">{action.message}</Notice>

        <div className="row">
          <div className="field" style={{ flex: "0 0 120px" }}>
            <label>Icon</label>
            <select value={icon} onChange={(event) => setIcon(event.target.value)}>
              <option value="">none</option>
              {ICONS.map((choice) => (
                <option key={choice} value={choice}>
                  {choice}
                </option>
              ))}
            </select>
          </div>
          <Field
            label="Summary (one line, shown on the card)"
            value={summary}
            onChange={setSummary}
            placeholder="Pets, their owners and the orders between them."
          />
        </div>

        <div className="field" style={{ marginTop: 12 }}>
          <label>Description</label>
          <textarea
            value={description}
            placeholder="What it is for, who owns it, what it is not for."
            onChange={(event) => setDescription(event.target.value)}
          />
        </div>

        <div className="row" style={{ marginTop: 12 }}>
          <Field
            label="Tags (comma separated, at most 20)"
            value={tags}
            onChange={setTags}
            placeholder="orders, retail, internal"
          />
          <Field label="Documentation URL" value={docsUrl} onChange={setDocsUrl} />
          <div className="field">
            <label>Visibility</label>
            <select value={visibility} onChange={(event) => setVisibility(event.target.value)}>
              <option value="listed">listed — anyone can find it</option>
              <option value="unlisted">unlisted — only the owning team sees it</option>
            </select>
          </div>
        </div>

        {resource.kind === "a2a" && (
          <Notice kind="warn">
            For an A2A agent, visibility is not only presentation: a listed agent's card is served
            without a subscription key so other agents can discover it, and an unlisted one's is not.
          </Notice>
        )}

        <div className="inline" style={{ marginTop: 12 }}>
          <button
            disabled={!canEdit || action.busy}
            onClick={async () => {
              const ok = await action.run(
                () =>
                  api.patch(
                    `/api/resources/${resource.id}`,
                    {
                      summary: summary.trim() || null,
                      description: description.trim() || null,
                      tags: parsedTags,
                      docsUrl: docsUrl.trim() || null,
                      icon: icon || null,
                      visibility,
                    },
                    resource.etag,
                  ),
                "listing updated",
              );
              if (ok) reload();
            }}
          >
            Save listing
          </button>
          <Link to={`/catalog/${resource.id}`}>Open in the Catalog →</Link>
        </div>
      </Card>

      <Card title="Preview" hint="The card as it appears in the grid.">
        <div className="market-grid" style={{ maxWidth: 380 }}>
          <article className="listing">
            <header>
              <span className="listing-icon" aria-hidden>
                {icon || "🔗"}
              </span>
              <div className="listing-title">
                {/* The card's heading is the contract's own title when it has one, so this preview
                    shows the resource name — what it falls back to — rather than inventing one. */}
                <strong>{resource.name}</strong>
                <div className="muted mono">
                  {resource.name} · {resource.apiVersion}
                </div>
              </div>
              <span className={`badge kind-${resource.kind}`}>{resource.kind}</span>
            </header>
            <p className="listing-summary">
              {summary || <span className="muted">No summary yet.</span>}
            </p>
            <div className="listing-tags">
              {parsedTags.slice(0, 5).map((tag) => (
                <span key={tag} className="chip small">
                  {tag}
                </span>
              ))}
            </div>
            <footer>
              <span className="listing-envs">
                {resource.releases.filter((release) => release.state === "converged").length === 0 ? (
                  <span className="badge warn">not published</span>
                ) : (
                  [
                    ...new Set(
                      resource.releases
                        .filter((release) => release.state === "converged")
                        .map((release) => release.environment),
                    ),
                  ].map((environment) => (
                    <span key={environment} className="pill ok">
                      {environment}
                    </span>
                  ))
                )}
              </span>
              {visibility === "unlisted" && <span className="badge">unlisted</span>}
            </footer>
          </article>
        </div>
      </Card>
    </>
  );
}

// ---------------------------------------------------------------------------- routing

function Routing({
  resource,
  reload,
  canEdit,
  environment,
}: {
  resource: ResourceDetail;
  reload: () => void;
  canEdit: boolean;
  environment: string;
}) {
  const route = resource.routes.find((r) => r.environment === environment);
  const binding = resource.bindings.find((b) => b.environment === environment);
  // Re-seeded whenever the environment changes: routes and backends are per environment, and a
  // promotion deliberately does not copy them (design section 6.1).
  const [host, setHost] = useState(route?.host ?? "*");
  const [basePath, setBasePath] = useState(
    route?.basePath ?? `/${resource.name}/${resource.apiVersion}`,
  );
  const [backend, setBackend] = useState(binding?.backend.urls[0] ?? "http://127.0.0.1:9080/v2");
  const action = useAction();

  useEffect(() => {
    setHost(route?.host ?? "*");
    setBasePath(route?.basePath ?? `/${resource.name}/${resource.apiVersion}`);
    setBackend(binding?.backend.urls[0] ?? "http://127.0.0.1:9080/v2");
  }, [environment, route?.host, route?.basePath, binding?.backend.urls[0]]);

  return (
    <Card
      title={`Route and backend in ${environment}`}
      hint="A route is a row with UNIQUE(environment, host, base_path) — not an implication of the spec's servers block. Routes and backends are per environment and a promotion never copies them: a TEST backend guessed from DEV is exactly the mistake that separation prevents."
    >
      <Notice kind="error">{action.error}</Notice>
      <Notice kind="ok">{action.message}</Notice>
      <div className="row">
        <Field label="Host (* matches any)" value={host} onChange={setHost} />
        <Field label="Base path" value={basePath} onChange={setBasePath} />
      </div>
      <div className="row" style={{ marginTop: 12 }}>
        <Field label="Backend URL" value={backend} onChange={setBackend} />
        <button
          disabled={!canEdit || action.busy}
          onClick={async () => {
            const ok = await action.run(async () => {
              await api.put(`/api/resources/${resource.id}/routes`, {
                environment,
                host,
                basePath,
              });
              await api.put(`/api/resources/${resource.id}/binding`, {
                environment,
                urls: [backend],
              });
            }, "route and backend saved");
            if (ok) reload();
          }}
        >
          Save
        </button>
      </div>
      <p className="muted" style={{ marginTop: 14, marginBottom: 0 }}>
        Callers will reach it on a <span className="mono">{environment}</span> gateway at{" "}
        <span className="mono">{basePath}/…</span> and the gateway will call{" "}
        <span className="mono">{backend}/…</span> (with{" "}
        <span className="mono">rewrite.stripBasePath</span> attached).
      </p>
    </Card>
  );
}

// ---------------------------------------------------------------------------- publish

function Publish({
  resource,
  reload,
  canEdit,
  environment,
}: {
  resource: ResourceDetail;
  reload: () => void;
  canEdit: boolean;
  environment: string;
}) {
  const latest = resource.revisions[0]?.rev ?? 1;
  const [rev, setRev] = useState(String(latest));
  const [warnings, setWarnings] = useState<string[]>([]);
  const action = useAction();
  const [health, setHealth] = useState<FleetHealth | null>(null);

  useEffect(() => {
    let live = true;
    const tick = () =>
      api
        .get<FleetHealth>(`/api/targets/${environment}/health`)
        .then((data) => live && setHealth(data))
        .catch(() => {});
    tick();
    const timer = setInterval(tick, 2000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [environment]);

  const live = resource.releases.find((r) => r.state === "converged" && r.environment === environment);

  return (
    <>
      <Card
        title={`Publish to the ${environment} gateways`}
        hint="A release writes one row and enqueues a reconcile job; the gateway picks the new config up on its next poll. Policy, route and backend edits need no release."
      >
        <Notice kind="error">{action.error}</Notice>
        <Notice kind="ok">{action.message}</Notice>
        {warnings.map((warning) => (
          <Notice kind="warn" key={warning}>
            {warning}
          </Notice>
        ))}
        <div className="row">
          <div className="field">
            <label>Revision</label>
            <select value={rev} onChange={(event) => setRev(event.target.value)}>
              {resource.revisions.map((revision) => (
                <option key={revision.id} value={revision.rev}>
                  rev {revision.rev} · {revision.original_format}
                </option>
              ))}
            </select>
          </div>
          <button
            disabled={!canEdit || action.busy || resource.revisions.length === 0}
            onClick={async () => {
              setWarnings([]);
              const ok = await action.run(async () => {
                const result = await api.post<{ state: string; warnings: string[]; rev: number }>(
                  `/api/resources/${resource.id}/releases`,
                  { revision: Number(rev), environment },
                );
                setWarnings(result.warnings ?? []);
                action.setMessage(`revision ${result.rev} is ${result.state}`);
              });
              if (ok) reload();
            }}
          >
            Publish
          </button>
        </div>

        {/* Withdrawing breaks every caller in this environment at the next poll, so it asks for
            the name rather than sitting one click away from Publish. */}
        <DangerZone
          what={`Withdraw ${resource.name} from ${environment}`}
          name={resource.name}
          consequence={`The ${environment} gateways stop serving it on their next poll and every caller there starts getting 404s. Publishing again brings it back.`}
          permission={
            !canEdit
              ? { enabled: false, reason: "Only the owning team can withdraw this API." }
              : !live
                ? { enabled: false, reason: `Nothing of this API is live in ${environment}.` }
                : ALLOWED
          }
          busy={action.busy}
          error={action.error}
          onConfirm={async () => {
            const ok = await action.run(
              () => api.del(`/api/resources/${resource.id}/releases?environment=${environment}`),
              "withdrawn — the gateway stops serving it on its next poll",
            );
            if (ok) reload();
          }}
        />
      </Card>

      <Card title="Fleet">
        {health ? (
          <dl className="kv">
            <dt>Live now</dt>
            <dd>
              {live ? (
                <span className="badge ok">revision {live.rev} published</span>
              ) : (
                <span className="badge off">not published</span>
              )}
            </dd>
            <dt>Config digest</dt>
            <dd>
              <Digest value={health.configDigest} />
            </dd>
            <dt>Instances</dt>
            <dd>
              {health.liveInstances} live ·{" "}
              {health.inSync ? (
                <span className="badge ok">in sync</span>
              ) : (
                <span className="badge warn">converging</span>
              )}
            </dd>
          </dl>
        ) : (
          <p className="muted">no fleet data</p>
        )}
      </Card>

      <Card title="Release history">
        <table>
          <thead>
            <tr>
              <th>Rev</th>
              <th>Environment</th>
              <th>State</th>
              <th>By</th>
              <th>At</th>
              <th>Reason</th>
            </tr>
          </thead>
          <tbody>
            {resource.releases.map((release) => (
              <tr key={release.id}>
                <td>{release.rev}</td>
                <td>{release.environment}</td>
                <td>
                  <span
                    className={`badge ${
                      release.state === "converged" ? "ok" : release.state === "failed" ? "off" : ""
                    }`}
                  >
                    {release.state}
                  </span>
                </td>
                <td className="muted">{release.released_by}</td>
                <td className="muted">{new Date(release.released_at).toLocaleString()}</td>
                <td className="muted">{release.reason ?? "—"}</td>
              </tr>
            ))}
            {resource.releases.length === 0 && (
              <tr>
                <td colSpan={6} className="muted">
                  Never published.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Card>
    </>
  );
}
