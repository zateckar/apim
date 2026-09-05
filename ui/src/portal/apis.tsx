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
    [backend, setBackend] = useState(d.settings?.backend?.pool?.[0]?.url ?? ""),
    [path, setPath] = useState(d.settings?.basePath ?? ""),
    [spec, setSpec] = useState(d.definition ?? ""),
    [policy, setPolicy] = useState(
      JSON.stringify(d.settings?.policy ?? {}, null, 2),
    ),
    [promote, setPromote] = useState(false),
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
          {d.resource.kind.toUpperCase()} · Products:{" "}
          {d.products.map((p: any) => p.name).join(", ") || "None"}
        </p>
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
            <Field label={`${s.environment.toUpperCase()} backend URL`}>
              <input
                disabled={!d.resource.canEdit}
                value={backend}
                onChange={(e) => setBackend(e.target.value)}
              />
            </Field>
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
                  if (backend !== d.settings.backend.pool?.[0]?.url)
                    body.backendUrl = backend;
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
