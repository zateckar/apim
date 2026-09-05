import { PolicyForm } from "./PolicyForm";
import { PlaygroundPanel } from "../views/PlaygroundPanel";
import { useState } from "react";
import type { Session } from "../App";
import { api } from "../api";
import { go, useAsync } from "../components";
import { parse } from "yaml";
import CodeMirror from "@uiw/react-codemirror";
import { yaml } from "@codemirror/lang-yaml";
import { command, listAll } from "./client";
import {
  Panel,
  Field,
  ErrorNotice,
  Empty,
  Modal,
  OperationList,
  useWork,
} from "./common";
import { SubscribeDialog, Subscriptions } from "./processes";
import { parseWsdl } from "./lib/wsdl";
import { OperationsCard, WsdlServicesCard } from "./components/OperationsCard";
import { MAX_POOL_SIZE, MAX_WEIGHT } from "../../../shared/backend";

interface PoolEntry {
  url: string;
  weight?: number;
}

/**
 * The next free identifier in the `v<n>` series, which is what almost every version here is. An API
 * versioned some other way falls back to a suffix rather than to a guess that collides.
 */
export function nextVersion(existing: string[]): string {
  const numbers = existing
    .map((value) => /^v(\d+)$/.exec(value)?.[1])
    .filter((value): value is string => value !== undefined)
    .map(Number);
  if (numbers.length) return `v${Math.max(...numbers) + 1}`;
  return `${existing[existing.length - 1] ?? "v1"}-next`;
}

/** A sibling version needs its own path, since two versions serve at the same time. */
export function versionedPath(basePath: string, current: string, next: string): string {
  const trimmed = basePath.replace(/\/+$/, "");
  if (trimmed.endsWith(`/${current}`))
    return `${trimmed.slice(0, -current.length - 1)}/${next}`;
  return `${trimmed}/${next}`;
}

export function Workspace({
  session: s,
  section,
  tick,
}: {
  session: Session;
  section: string;
  tick: number;
}) {
  const [search, setSearch] = useState(""),
    [subscribe, setSubscribe] = useState<any>(null);
  const data = useAsync(() => listAll("/api/resources"), [tick]);
  const rows = (data.data?.items ?? []).filter(
    (r) =>
      (section === "discover" || r.applicationId === s.application) &&
      (section === "mcp"
        ? r.kind === "mcp"
        : section === "a2a"
          ? r.kind === "a2a"
          : true) &&
      `${r.name} ${r.description}`.toLowerCase().includes(search.toLowerCase()),
  );
  return (
    <Panel
      title={section === "discover" ? "Discover APIs" : "Published APIs"}
      actions={
        <input
          aria-label="Search APIs"
          placeholder="Search APIs…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      }
    >
      <ErrorNotice error={data.error} />
      {data.loading && !data.data ? (
        <Empty>Loading APIs…</Empty>
      ) : rows.length ? (
        <div className="native-list">
          {rows.map((r) => (
            <div className="native-row" key={r.id}>
              <div>
                <a
                  href={`/${s.application}/apis/${r.id}`}
                  onClick={(e) => {
                    e.preventDefault();
                    go(`/${s.application}/apis/${r.id}`);
                  }}
                >
                  <strong>{r.name}</strong>
                </a>
                <small>
                  {r.kind.toUpperCase()} · {s.applicationName(r.applicationId)}{" "}
                  · {r.apiVersion}
                </small>
                <p>{r.description}</p>
              </div>
              <button className="btn" onClick={() => setSubscribe(r)}>
                Subscribe
              </button>
            </div>
          ))}
        </div>
      ) : (
        <Empty>No APIs match this view.</Empty>
      )}
      {subscribe && (
        <SubscribeDialog
          session={s}
          resourceId={subscribe.id}
          close={() => setSubscribe(null)}
        />
      )}
    </Panel>
  );
}
export function Publish({ session: s }: { session: Session }) {
  const w = useWork(),
    products = useAsync(
      () => api.get<{ items: any[] }>("/api/products"),
      [s.application],
    );
  const [kind, setKind] = useState(
      new URLSearchParams(location.search).get("kind") ?? "rest",
    ),
    [name, setName] = useState(""),
    [apiVersion, setApiVersion] = useState("v1"),
    [description, setDescription] = useState(""),
    [productId, setProduct] = useState(""),
    [productName, setProductName] = useState(""),
    [backendUrl, setBackend] = useState(""),
    [basePath, setPath] = useState(""),
    [source, setSource] = useState("text"),
    [url, setUrl] = useState(""),
    [spec, setSpec] = useState("");
  return (
    <Panel title="Publish to DEV">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void w.run(async () => {
            const body: any = {
              applicationId: s.application,
              name,
              kind,
              apiVersion,
              description,
              backendUrl,
              basePath: basePath || `/${name}`,
              ...(productId ? { productId } : { productName }),
            };
            if (source === "url")
              body[
                kind === "mcp" || kind === "a2a" ? "discoverUrl" : "specUrl"
              ] = url;
            else body.spec = kind === "soap" ? spec : parse(spec);
            const result = await command("/api/publish", body);
            s.setEnvironment(s.meta.chain[0]!);
            go(`/${s.application}/apis/${result.resourceId}`);
          });
        }}
      >
        <ErrorNotice error={w.error ?? products.error} />
        <div className="native-form-grid">
          <Field label="API name">
            <input
              required
              pattern="[a-z0-9][a-z0-9-]{1,60}"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          <Field label="Type">
            <select value={kind} onChange={(e) => setKind(e.target.value)}>
              {["rest", "soap", "mcp", "a2a"].map((k) => (
                <option key={k} value={k}>
                  {k.toUpperCase()}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Version">
            <input
              required
              pattern="[A-Za-z0-9][A-Za-z0-9._-]{0,31}"
              value={apiVersion}
              onChange={(e) => setApiVersion(e.target.value)}
            />
          </Field>
          <Field label="Product">
            <select
              value={productId}
              onChange={(e) => setProduct(e.target.value)}
            >
              <option value="">Create a product</option>
              {products.data?.items
                .filter(
                  (p) =>
                    p.applicationId === s.application &&
                    p.lifecycle === "active",
                )
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
            </select>
          </Field>
          {!productId && (
            <Field label="New product name">
              <input
                required
                value={productName}
                onChange={(e) => setProductName(e.target.value)}
              />
            </Field>
          )}
          <Field label="DEV backend URL">
            <input
              type="url"
              required
              value={backendUrl}
              onChange={(e) => setBackend(e.target.value)}
            />
          </Field>
          <Field label="Public path">
            <input
              placeholder={`/${name || "api"}`}
              value={basePath}
              onChange={(e) => setPath(e.target.value)}
            />
          </Field>
        </div>
        <Field label="Description">
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </Field>
        <Field label="Definition source">
          <select value={source} onChange={(e) => setSource(e.target.value)}>
            <option value="text">Upload or paste definition</option>
            <option value="url">Import from URL</option>
          </select>
        </Field>
        {source === "url" ? (
          <Field label="Definition or discovery URL">
            <input
              required
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
          </Field>
        ) : (
          <>
            <input
              aria-label="Upload API definition"
              type="file"
              accept=".json,.yaml,.yml,.xml,.wsdl"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void w.run(async () => setSpec(await file.text()));
              }}
            />
            <CodeMirror
              aria-label="API definition"
              value={spec}
              extensions={[yaml()]}
              minHeight="260px"
              onChange={setSpec}
            />
          </>
        )}
        <div className="native-actions">
          <button className="btn primary" disabled={w.busy || !s.application}>
            {w.busy ? "Publishing…" : "Publish to DEV"}
          </button>
          <span className="muted">
            Deployment runs automatically. Progress appears in Activity.
          </span>
        </div>
      </form>
    </Panel>
  );
}
export function Editor({
  id,
  session: s,
  operations,
}: {
  id: string;
  session: Session;
  operations: any[];
}) {
  const data = useAsync(
    () =>
      api.get<any>(`/api/resources/${id}/editor?environment=${s.environment}`),
    [id, s.environment],
  );
  return (
    <>
      <ErrorNotice error={data.error} />
      {data.data ? (
        <EditorForm
          key={`${id}:${s.environment}:${data.data.resource.etag}`}
          data={data.data}
          session={s}
          refresh={data.reload}
          operations={operations.filter((o) => o.resourceId === id)}
        />
      ) : (
        <Empty>Loading API…</Empty>
      )}
    </>
  );
}
function EditorForm({
  data: d,
  session: s,
  refresh,
  operations,
}: {
  data: any;
  session: Session;
  refresh: () => void;
  operations: any[];
}) {
  const w = useWork(),
    [tab, setTab] = useState("definition"),
    [description, setDescription] = useState(d.resource.description ?? ""),
    [pool, setPool] = useState<PoolEntry[]>(() =>
      (d.settings?.backend?.pool ?? []).length
        ? d.settings.backend.pool.map((entry: PoolEntry) => ({ ...entry }))
        : [{ url: "" }],
    ),
    [rule, setRule] = useState<string>(d.settings?.backend?.rule ?? "failover"),
    [path, setPath] = useState(d.settings?.basePath ?? ""),
    [spec, setSpec] = useState(d.definition ?? ""),
    [policy, setPolicy] = useState(
      JSON.stringify(d.settings?.policy ?? {}, null, 2),
    ),
    [promote, setPromote] = useState(false),
    [version, setVersion] = useState(false),
    [certificate, setCertificate] = useState(
      d.settings?.backend?.clientCertRef ?? "",
    ),
    [targetUrl, setTargetUrl] = useState(""),
    [subscribe, setSubscribe] = useState(false);
  const certificates = useAsync(
    () =>
      api.get<{ items: any[] }>(
        `/api/certificates?environment=${s.environment}`,
      ),
    [s.environment],
  );
  const next = s.meta.chain[s.meta.chain.indexOf(s.environment) + 1];
  const first = s.meta.chain[0]!;
  const versions: Array<{ id: string; apiVersion: string; lifecycle: string }> =
    d.versions ?? [];
  let doc: unknown = null;
  try {
    doc = parse(spec);
  } catch {}
  return (
    <>
      <Panel
        title={d.resource.name}
        actions={
          <div className="native-actions">
            {d.resource.canEdit &&
              // A new version is published where publishing starts, so it is offered there and the
              // reason is on the screen rather than in a tooltip nobody hovers.
              (s.environment === first ? (
                <button
                  className="btn"
                  disabled={w.busy || !d.settings}
                  onClick={() => setVersion(true)}
                >
                  New version
                </button>
              ) : (
                <span className="muted">
                  A new version starts in {first.toUpperCase()} — switch
                  environment to publish one.
                </span>
              ))}
            {d.resource.canEdit && next && (
              <button
                className="btn primary"
                disabled={w.busy || !d.settings}
                onClick={() => setPromote(true)}
              >
                Promote to {next.toUpperCase()}
              </button>
            )}
          </div>
        }
      >
        <p>
          {s.applicationName(d.resource.applicationId)} ·{" "}
          {d.resource.kind.toUpperCase()} · {d.resource.apiVersion} · Products:{" "}
          {d.products.map((p: any) => p.name).join(", ") || "None"}
        </p>
        {versions.length > 1 && (
          <Field label="Version">
            <select
              value={d.resource.id}
              onChange={(e) =>
                go(`/${s.application}/apis/${e.target.value}`)
              }
            >
              {versions.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.apiVersion}
                  {v.lifecycle === "active" ? "" : ` (${v.lifecycle})`}
                </option>
              ))}
            </select>
          </Field>
        )}
        <div className="seg">
          {[
            "definition",
            "properties",
            "policies",
            "subscriptions",
            "playground",
            "history",
          ].map((t) => (
            <button
              className={tab === t ? "active" : ""}
              key={t}
              onClick={() => setTab(t)}
            >
              {t}
            </button>
          ))}
        </div>
        <ErrorNotice error={w.error} />
        {!d.settings && (
          <Empty>
            This API has not been published to {s.environment.toUpperCase()}.
            Switch to the preceding environment and promote it.
          </Empty>
        )}
        {tab === "definition" && (
          <>
            <CodeMirror
              value={spec}
              extensions={[yaml()]}
              minHeight="340px"
              editable={d.resource.canEdit && !!d.settings}
              onChange={setSpec}
            />
            {d.resource.kind === "rest" && (
              <OperationsCard doc={doc} loading={false} />
            )}{" "}
            {d.resource.kind === "soap" && (
              <WsdlServicesCard wsdl={parseWsdl(spec)} loading={false} />
            )}
          </>
        )}
        {tab === "properties" && (
          <div className="native-form-grid">
            <Field label="Description">
              <textarea
                disabled={!d.resource.canEdit}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </Field>
            {/* A pool, not a URL: one member is the ordinary case and reads as one field, and the
                second one appears only when somebody asks for it. */}
            <div className="native-pool">
              <span className="lbl">
                {s.environment.toUpperCase()} backends
              </span>
              {pool.map((entry, index) => (
                <div className="native-actions" key={index}>
                  <input
                    aria-label={`Backend ${index + 1} URL`}
                    disabled={!d.resource.canEdit}
                    value={entry.url}
                    onChange={(e) =>
                      setPool(
                        pool.map((row, at) =>
                          at === index ? { ...row, url: e.target.value } : row,
                        ),
                      )
                    }
                  />
                  {rule === "round-robin" && (
                    <input
                      type="number"
                      min={1}
                      max={MAX_WEIGHT}
                      aria-label={`Backend ${index + 1} share of traffic`}
                      disabled={!d.resource.canEdit}
                      value={entry.weight ?? 1}
                      onChange={(e) =>
                        setPool(
                          pool.map((row, at) =>
                            at === index
                              ? { ...row, weight: Number(e.target.value) }
                              : row,
                          ),
                        )
                      }
                    />
                  )}
                  <button
                    type="button"
                    className="btn sm"
                    disabled={!d.resource.canEdit || pool.length === 1}
                    onClick={() =>
                      setPool(pool.filter((_, at) => at !== index))
                    }
                  >
                    Remove
                  </button>
                </div>
              ))}
              <button
                type="button"
                className="btn sm"
                disabled={!d.resource.canEdit || pool.length >= MAX_POOL_SIZE}
                onClick={() => setPool([...pool, { url: "" }])}
              >
                Add backend
              </button>
            </div>
            <Field label="When there is more than one backend">
              <select
                disabled={!d.resource.canEdit}
                value={rule}
                onChange={(e) => setRule(e.target.value)}
              >
                <option value="failover">
                  Failover — try them in the order written
                </option>
                <option value="round-robin">
                  Round-robin — spread calls across them
                </option>
              </select>
            </Field>
            {rule === "round-robin" && (
              <p className="muted">
                Each gateway keeps its own place in the rotation, so calls are
                spread per instance rather than across the fleet.
              </p>
            )}
            <Field label="Public path">
              <input
                disabled={!d.resource.canEdit}
                value={path}
                onChange={(e) => setPath(e.target.value)}
              />
            </Field>
            <Field label="Client certificate">
              <select
                disabled={!d.resource.canEdit}
                value={certificate}
                onChange={(e) => setCertificate(e.target.value)}
              >
                <option value="">No client certificate</option>
                {certificates.data?.items
                  .filter(
                    (c) =>
                      c.applicationId === d.resource.applicationId &&
                      !c.expired,
                  )
                  .map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
              </select>
            </Field>
            <ErrorNotice error={certificates.error} />
          </div>
        )}
        {tab === "policies" && (
          <>
            <PolicyForm
              value={policy}
              onChange={setPolicy}
              disabled={!d.resource.canEdit || !d.settings}
            />
            <details>
              <summary>Advanced settings</summary>
              <CodeMirror
                value={policy}
                editable={d.resource.canEdit && !!d.settings}
                minHeight="280px"
                onChange={setPolicy}
              />
            </details>
          </>
        )}
        {tab === "subscriptions" && (
          <Subscriptions
            session={s}
            tick={operations.length}
            resourceId={d.resource.id}
          />
        )}{" "}
        {tab === "playground" && (
          <div className="native-legacy">
            <PlaygroundPanel
              resourceId={d.resource.id}
              environment={s.environment}
              onSubscribe={() => setSubscribe(true)}
            />
          </div>
        )}
        {subscribe && (
          <SubscribeDialog
            session={s}
            resourceId={d.resource.id}
            close={() => setSubscribe(false)}
          />
        )}{" "}
        {tab === "history" && <OperationList items={operations} />}{" "}
        {d.resource.canEdit &&
          d.settings &&
          ["definition", "properties", "policies"].includes(tab) && (
            <button
              className="btn primary"
              disabled={w.busy}
              onClick={() =>
                void w.run(async () => {
                  const body: any = {
                    environment: s.environment,
                    description,
                    basePath: path,
                  };
                  if (certificate !== (d.settings.backend.clientCertRef ?? ""))
                    body.clientCertRef = certificate || null;
                  const next = pool
                    .filter((entry) => entry.url.trim())
                    .map((entry) => ({
                      url: entry.url.trim(),
                      ...(rule === "round-robin" && entry.weight && entry.weight !== 1
                        ? { weight: Number(entry.weight) }
                        : {}),
                    }));
                  if (
                    JSON.stringify(next) !==
                      JSON.stringify(d.settings.backend.pool ?? []) ||
                    rule !== (d.settings.backend.rule ?? "failover")
                  ) {
                    body.pool = next;
                    body.rule = rule;
                  }
                  if (policy !== JSON.stringify(d.settings.policy, null, 2))
                    body.policy = JSON.parse(policy);
                  if (spec !== d.definition)
                    body.spec = d.resource.kind === "soap" ? spec : parse(spec);
                  await command(
                    `/api/resources/${d.resource.id}/configure`,
                    body,
                    d.resource.etag,
                  );
                  refresh();
                })
              }
            >
              {w.busy ? "Saving…" : "Save changes"}
            </button>
          )}
      </Panel>
      <Panel title="Deployment progress">
        <OperationList items={operations.slice(0, 5)} />
      </Panel>
      {version && (
        <NewVersion
          data={d}
          session={s}
          spec={spec}
          close={() => setVersion(false)}
        />
      )}
      {promote && (
        <Modal
          title={`Promote to ${next!.toUpperCase()}`}
          close={() => setPromote(false)}
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void w.run(async () => {
                await command(`/api/resources/${d.resource.id}/promote`, {
                  environment: next,
                  ...(targetUrl ? { backendUrl: targetUrl } : {}),
                });
                setPromote(false);
                s.setEnvironment(next!);
              });
            }}
          >
            <p>
              Your API definition and settings will be promoted automatically.
              Existing target backend settings are retained.
            </p>
            <Field
              label={`${next!.toUpperCase()} backend URL (required for first promotion)`}
            >
              <input
                type="url"
                value={targetUrl}
                onChange={(e) => setTargetUrl(e.target.value)}
              />
            </Field>
            <ErrorNotice error={w.error} />
            <button className="btn primary" disabled={w.busy}>
              Promote
            </button>
          </form>
        </Modal>
      )}
    </>
  );
}

/**
 * A new version is a *different* API that serves at the same time as this one, so it is a dialog
 * rather than a tab: nothing here edits the version you are looking at. It starts as a copy of the
 * definition, backends and policies on screen, and it needs its own path because both answer at once.
 */
function NewVersion({
  data: d,
  session: s,
  spec,
  close,
}: {
  data: any;
  session: Session;
  spec: string;
  close: () => void;
}) {
  const w = useWork(),
    first = s.meta.chain[0]!;
  const products = useAsync(
    () => api.get<{ items: any[] }>("/api/products"),
    [d.resource.id],
  );
  const existing: string[] = (d.versions ?? []).map((v: any) => v.apiVersion);
  const [identifier, setIdentifier] = useState(() => nextVersion(existing));
  const [path, setPath] = useState(() =>
    versionedPath(d.settings?.basePath ?? "", d.resource.apiVersion, nextVersion(existing)),
  );
  const [productId, setProduct] = useState<string>(d.products?.[0]?.id ?? "");
  const owned =
    products.data?.items.filter(
      (p) => p.applicationId === d.resource.applicationId && p.lifecycle === "active",
    ) ?? [];
  return (
    <Modal title={`New version of ${d.resource.name}`} close={close}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void w.run(async () => {
            const result = await command("/api/publish", {
              applicationId: d.resource.applicationId,
              name: d.resource.name,
              kind: d.resource.kind,
              apiVersion: identifier,
              productId,
              description: d.resource.description ?? "",
              host: d.settings.host,
              basePath: path,
              pool: d.settings.backend.pool,
              rule: d.settings.backend.rule ?? "failover",
              policy: d.settings.policy,
              ...(d.settings.backend.clientCertRef
                ? { clientCertRef: d.settings.backend.clientCertRef }
                : {}),
              spec: d.resource.kind === "soap" ? spec : parse(spec),
            });
            s.setEnvironment(first);
            close();
            go(`/${s.application}/apis/${result.resourceId}`);
          });
        }}
      >
        <p>
          This publishes a separate API to {first.toUpperCase()}.{" "}
          <strong>{d.resource.apiVersion}</strong> keeps serving on its own path
          and keeps its own subscriptions — a key for one does not open the other.
        </p>
        <ErrorNotice error={products.error ?? w.error} />
        <Field label="Version identifier">
          <input
            required
            pattern="[A-Za-z0-9][A-Za-z0-9._-]{0,31}"
            value={identifier}
            onChange={(e) => {
              setIdentifier(e.target.value);
              setPath(
                versionedPath(
                  d.settings?.basePath ?? "",
                  d.resource.apiVersion,
                  e.target.value,
                ),
              );
            }}
          />
        </Field>
        <Field label="Public path">
          <input required value={path} onChange={(e) => setPath(e.target.value)} />
        </Field>
        <Field label="Product">
          <select
            required
            value={productId}
            onChange={(e) => setProduct(e.target.value)}
          >
            {!owned.length && <option value="">No product to publish into</option>}
            {owned.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </Field>
        <p className="muted">
          Carried over: the definition on screen, the {first.toUpperCase()}{" "}
          backends and the policies. Not carried over: subscriptions, and
          anything set in a later environment.
        </p>
        <button className="btn primary" disabled={w.busy || !productId}>
          {w.busy ? "Publishing…" : `Publish ${identifier} to ${first.toUpperCase()}`}
        </button>
      </form>
    </Modal>
  );
}
