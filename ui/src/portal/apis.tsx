import { PolicyForm } from "./PolicyForm";
import { PlaygroundPanel } from "../views/PlaygroundPanel";
import { LogsPanel } from "../views/LogsPanel";
import { RevisionsPanel } from "../views/RevisionsPanel";
import { Fragment, useState, useId } from "react";
import { EditorView } from "@codemirror/view";
import type { Session } from "../App";
import { api, type Locality } from "../api";
import {
  EmptyState,
  Field,
  Link,
  Modal,
  Notice,
  OperationList,
  Panel,
  Skeleton,
  go,
  useAction,
  useAsync,
} from "../components";
import { ALLOWED, type Permission } from "../lib/capabilities";
import { parse } from "yaml";
import CodeMirror from "@uiw/react-codemirror";
import { yaml } from "@codemirror/lang-yaml";
import { command, listAll } from "./client";
import { SubscribeDialog, Subscriptions } from "./processes";
import { parseWsdl } from "./lib/wsdl";
import { OperationsCard, WsdlServicesCard } from "./components/OperationsCard";
import { DefinitionDiagnostics } from "./components/DefinitionDiagnostics";
import { MarkdownEditor } from "./components/MarkdownEditor";
import { MAX_POOL_SIZE, MAX_WEIGHT } from "../../../shared/backend";
import { DOMAINS, findDomain, publishedPath } from "../../../shared/domains";

interface PoolEntry {
  url: string;
  weight?: number;
}

/**
 * The description row. Not a `<Field>`, because `Field` is a `<label>` and a label wrapping the
 * editor's toolbar would forward every button press to the textarea as a second activation. The
 * markup is otherwise the same, so the row lines up with the fields above and below it.
 */
function DescriptionField({
  value,
  onChange,
  rows,
  disabled,
}: {
  value: string;
  onChange: (next: string) => void;
  rows?: number;
  disabled?: boolean;
}) {
  return (
    <div className="native-field">
      <span className="lbl">Description</span>
      <MarkdownEditor
        value={value}
        onChange={onChange}
        rows={rows}
        disabled={disabled}
        ariaLabel="Description"
        placeholder="What this API is for, who should call it, what it is not."
      />
    </div>
  );
}

/**
 * Domain and sub-domain, which is where this thing sits in the catalogue **and** the first segment
 * of its address. A closed list rather than a text box: a free-text domain is a domain nobody can
 * browse by, and the same string typed two ways splits one part of the estate into two.
 */
export function DomainPicker({
  domain,
  subdomain,
  onChange,
  disabled,
}: {
  domain: string;
  subdomain: string;
  onChange: (next: { domain: string; subdomain: string }) => void;
  disabled?: boolean;
}) {
  const found = findDomain(domain);
  return (
    <>
      <Field label="Domain">
        <select
          required
          disabled={disabled}
          value={domain}
          // Choosing a domain clears the sub-domain: keeping it would leave a pair the taxonomy
          // does not contain, which the control plane refuses at save time rather than here.
          onChange={(e) => onChange({ domain: e.target.value, subdomain: "" })}
        >
          <option value="">— Select domain —</option>
          {DOMAINS.map((d) => (
            <option key={d.name} value={d.name}>
              {d.name}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Sub-domain">
        <select
          disabled={disabled || !found || found.subdomains.length === 0}
          value={subdomain}
          onChange={(e) => onChange({ domain, subdomain: e.target.value })}
        >
          {!found ? (
            <option value="">Select a domain first</option>
          ) : found.subdomains.length === 0 ? (
            <option value="">No sub-domains available for {found.name}</option>
          ) : (
            <>
              <option value="">— None —</option>
              {found.subdomains.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </>
          )}
        </select>
      </Field>
    </>
  );
}

/**
 * Which of an environment's gateways an API answers on.
 *
 * An environment can be served from more than one place — a managed gateway in the cloud, an
 * on-premise one — and the choice is per API and per environment. It is a checkbox list rather
 * than a dropdown because the answer is usually "both", and it refuses to reach zero: an API on
 * no gateway has an address nobody can call, which is not a state anyone means to be in.
 *
 * A locality's addresses are shown beside it, badged, because "on-premise" tells you nothing
 * about what a consumer will type and the URL does.
 */
export function GatewayPicker({
  localities,
  selected,
  environment,
  onChange,
  disabled,
}: {
  localities: Locality[];
  selected: string[];
  environment: string;
  onChange: (next: string[]) => void;
  disabled?: boolean;
}) {
  if (localities.length === 0) {
    return (
      <p className="muted">
        {environment.toUpperCase()} has no gateway. An administrator adds one on the Gateways
        screen; until then nothing published here is served.
      </p>
    );
  }
  // With one gateway there is no choice to make, so the control would be a checkbox that cannot
  // be unticked. It says where the API answers instead.
  if (localities.length === 1) {
    return (
      <p className="muted">
        Published on <strong>{localities[0]!.name}</strong>
        {localities[0]!.label ? ` · ${localities[0]!.label}` : ""} — the only gateway{" "}
        {environment.toUpperCase()} has.
      </p>
    );
  }
  return (
    <div className="pick-list">
      <div className="pick-list-head">
        <strong>Gateways</strong>
        <span className="muted small">
          {selected.length} of {localities.length} selected · {environment.toUpperCase()}
        </span>
      </div>
      {localities.map((locality) => {
        const on = selected.includes(locality.name);
        // The last one standing cannot be unticked; the reason is on the line below the list.
        const locked = on && selected.length === 1;
        return (
          <label key={locality.name} className="pick-option">
            <input
              type="checkbox"
              checked={on}
              disabled={disabled || locked}
              onChange={() =>
                onChange(
                  on
                    ? selected.filter((n) => n !== locality.name)
                    : [...selected, locality.name].sort(),
                )
              }
            />
            <span className="pick-option-body">
              <span>
                <strong>{locality.name}</strong>
                {locality.label ? <span className="muted"> · {locality.label}</span> : null}
                {locality.paused && <span className="badge warn">paused</span>}
              </span>
              {locality.addresses.length === 0 ? (
                <span className="muted small">no published address yet</span>
              ) : (
                locality.addresses.map((address) => (
                  <span key={address.url} className="muted small mono">
                    <span className="badge">
                      {address.network === "intranet" ? "Intranet" : "Internet"}
                    </span>{" "}
                    {address.url}
                  </span>
                ))
              )}
            </span>
          </label>
        );
      })}
      <p className="hint">An API must be published on at least one gateway.</p>
    </div>
  );
}

/**
 * Every URL this API answers at — one per address of every gateway it is published on.
 *
 * Not one URL with a placeholder host. A consumer inside the network and a consumer outside it
 * are given different names for the same gateway, and an API on two localities has four addresses
 * rather than one; showing a single line meant somebody had to know which of them applied to them,
 * which is exactly the thing a portal exists to answer.
 */
export function PathPreview({
  localities,
  selected,
  path,
}: {
  localities: Locality[];
  selected: string[];
  path: string;
}) {
  const urls = localities
    .filter((l) => selected.includes(l.name))
    .flatMap((l) => l.addresses.map((a) => ({ ...a, gateway: l.name })));
  if (urls.length === 0) {
    return (
      <p className="muted">
        This API will answer at <span className="mono">{path}</span> on every gateway it is
        published on. None of them has a published address yet, so there is no URL to show.
      </p>
    );
  }
  return (
    <ul className="url-list">
      {urls.map((entry) => (
        <li key={`${entry.gateway}:${entry.url}`}>
          <span className="badge">
            {entry.network === "intranet" ? "Intranet" : "Internet"}
          </span>
          <span className="mono">
            {entry.url}
            {path}
          </span>
          <span className="muted small">{entry.gateway}</span>
        </li>
      ))}
    </ul>
  );
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

/**
 * Why this identifier cannot be published, or `null`.
 *
 * The control plane refuses a duplicate too — `API name and version already exist` — but only after
 * the request, by which point the dialog has closed on its way to a resource that was never created.
 * The screen this dialog replaced checked in the browser and disabled its own control; the check
 * went with the screen when it was deleted, and nobody noticed because that screen was unreachable.
 *
 * Case-insensitively: two versions of one API that differ only by case are one version to anybody
 * reading the published address, where the version is a path segment.
 */
export function versionRefusal(
  name: string,
  identifier: string,
  existing: string[],
): string | null {
  const wanted = identifier.trim().toLowerCase();
  // An empty box is not a refusal — the input is `required`, and saying "pick another" about
  // nothing is an error message for a mistake nobody has made yet.
  if (!wanted) return null;
  const clash = existing.find((value) => value.trim().toLowerCase() === wanted);
  if (clash === undefined) return null;
  return (
    `${name} already has a version called ${clash}. Its versions are ${existing.join(", ")} — and ` +
    `two that differ only by case would be one version to anybody reading the address.`
  );
}

/** A sibling version needs its own path, since two versions serve at the same time. */
export function versionedPath(basePath: string, current: string, next: string): string {
  const trimmed = basePath.replace(/\/+$/, "");
  if (trimmed.endsWith(`/${current}`))
    return `${trimmed.slice(0, -current.length - 1)}/${next}`;
  return `${trimmed}/${next}`;
}

/**
 * Publishing, in three questions rather than one screen of eighteen fields.
 *
 * The order is the order the answers depend on each other: what this thing *is* decides its
 * address, the address is what the definition is served under, and only then is there something to
 * route and something to sell. A single long form let somebody paste a definition and choose a
 * backend before they had decided what the API was called, and then re-do both when the name
 * changed the path.
 *
 * A step is reachable only when every step before it is answered, and the reason a step is not
 * reachable is on the screen rather than in a disabled button's tooltip. Going *back* is always
 * allowed — nothing is submitted until the last step.
 */
const PUBLISH_STEPS = [
  { key: "identify", label: "Identify" },
  { key: "define", label: "Define" },
  { key: "route", label: "Route and sell" },
] as const;

export function Publish({ session: s }: { session: Session }) {
  const [step, setStep] = useState(0);
  const w = useAction(),
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
    [docsUrl, setDocsUrl] = useState(""),
    [productId, setProduct] = useState(""),
    [productName, setProductName] = useState(""),
    [backendUrl, setBackend] = useState(""),
    [domain, setDomain] = useState(""),
    [subdomain, setSubdomain] = useState(""),
    [source, setSource] = useState("text"),
    [url, setUrl] = useState(""),
    [spec, setSpec] = useState("");
  const first = s.meta.chain[0]!;
  const localities = s.meta.environments.find((e) => e.environment === first)?.localities ?? [];
  // Everything the environment has, until somebody narrows it: publishing on every gateway is
  // what a one-gateway estate does anyway, and it is what somebody who has not thought about
  // localities means.
  const [gateways, setGateways] = useState<string[] | null>(null);
  const selected = gateways ?? localities.map((l) => l.name);

  /** What is still missing from a step, in one sentence, or `null` when it is answered. */
  function missing(at: number): string | null {
    if (at === 0) {
      if (!/^[a-z0-9][a-z0-9-]{1,60}$/.test(name))
        return "A name: 2–61 lowercase letters, digits or hyphens. It is the middle of the address.";
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/.test(apiVersion))
        return "A version. It is the last segment of the address, so both versions can answer at once.";
      if (!domain) return "A domain. It is the first segment of the address and how the catalog is browsed.";
      return null;
    }
    if (at === 1) {
      if (source === "url" && !url.trim()) return "The URL to import the definition from.";
      if (source !== "url" && !spec.trim()) return "A definition — paste one, or upload a file.";
      return null;
    }
    if (!backendUrl.trim()) return "Somewhere to forward to in DEV.";
    if (selected.length === 0) return "At least one gateway to answer on.";
    if (!productId && !productName.trim())
      return "A product. Consumers subscribe to products, never directly to an API.";
    return null;
  }
  // The furthest step whose predecessors are all answered. Everything past it is disabled rather
  // than hidden, so the shape of what is being asked is visible from the first screen.
  const reachable = PUBLISH_STEPS.findIndex((_, at) => missing(at) !== null);
  const furthest = reachable === -1 ? PUBLISH_STEPS.length - 1 : reachable;
  const at = Math.min(step, furthest);
  const last = PUBLISH_STEPS.length - 1;
  const blocked = missing(at);

  return (
    <Panel title={`Publish to ${first.toUpperCase()}`}>
      <div className="stepper">
        {PUBLISH_STEPS.map((entry, index) => (
          <Fragment key={entry.key}>
            {index > 0 && <span className="sep" />}
            <button
              type="button"
              className={`step ${index === at ? "active" : index < at ? "done" : ""}`}
              aria-current={index === at ? "step" : undefined}
              disabled={index > furthest}
              onClick={() => setStep(index)}
            >
              <span className="n">{index + 1}</span>
              {entry.label}
            </button>
          </Fragment>
        ))}
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          // Enter on any step but the last advances rather than publishing: a form that submits
          // from the middle is how somebody publishes an API they had not finished describing.
          if (at !== last) {
            if (!blocked) setStep(at + 1);
            return;
          }
          void w.run(async () => {
            const body: any = {
              applicationId: s.application,
              name,
              kind,
              apiVersion,
              description,
              docsUrl: docsUrl.trim() || null,
              backendUrl,
              domain,
              subdomain: subdomain || null,
              // Derived, never typed: the same function the control plane validates against, so
              // what the preview above the button says is what the gateway will answer on.
              basePath: publishedPath({ domain, subdomain, name, apiVersion }),
              gateways: selected,
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
        <Notice kind="error">{w.error ?? products.error}</Notice>

        {at === 0 && (
          <>
            <div className="native-form-grid">
              <Field label="API name">
                <input
                  autoFocus
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
                  pattern="[A-Za-z0-9][A-Za-z0-9._-]{0,31}"
                  value={apiVersion}
                  onChange={(e) => setApiVersion(e.target.value)}
                />
              </Field>
              <DomainPicker
                domain={domain}
                subdomain={subdomain}
                onChange={(next) => {
                  setDomain(next.domain);
                  setSubdomain(next.subdomain);
                }}
              />
            </div>
            <PathPreview
              localities={localities}
              selected={selected}
              path={
                domain ? publishedPath({ domain, subdomain, name: name || "api", apiVersion }) : "/…"
              }
            />
            <p className="muted">
              The domain is the first segment of the address and the version is the last, which is
              what makes the catalog browsable by domain and a URL legible without looking anything
              up. Everything on this step is part of the address, which is why it is asked first.
            </p>
          </>
        )}

        {at === 1 && (
          <>
            <Field label="Definition source">
              <select value={source} onChange={(e) => setSource(e.target.value)}>
                <option value="text">Upload or paste definition</option>
                <option value="url">Import from URL</option>
              </select>
            </Field>
            {source === "url" ? (
              <Field
                label={
                  kind === "mcp" || kind === "a2a"
                    ? "Discovery URL"
                    : "Definition URL"
                }
              >
                <input
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
                {/* The same checks the workspace runs, on the step where the document is chosen.
                    They are not a gate here — the wizard's own `missing()` decides that — because
                    a publisher fixing an upstream document should be able to see every problem at
                    once rather than one refusal per attempt. */}
                <DefinitionDiagnostics source={spec} kind={kind} onFix={setSpec} />
              </>
            )}
            <DescriptionField
              value={description}
              onChange={setDescription}
              rows={6}
            />
            <Field label="Documentation link">
              <input
                type="url"
                placeholder="https://wiki.example/teams/…"
                value={docsUrl}
                onChange={(e) => setDocsUrl(e.target.value)}
              />
              <span className="hint">
                One page a consumer can open for the rest of the story. Optional, and changeable
                later.
              </span>
            </Field>
          </>
        )}

        {at === 2 && (
          <>
            <div className="native-form-grid">
              <Field label="DEV backend URL">
                <input
                  type="url"
                  value={backendUrl}
                  onChange={(e) => setBackend(e.target.value)}
                />
              </Field>
              <Field label="Product">
                <select value={productId} onChange={(e) => setProduct(e.target.value)}>
                  <option value="">Create a product</option>
                  {products.data?.items
                    .filter(
                      (p) => p.applicationId === s.application && p.lifecycle === "active",
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
                    value={productName}
                    onChange={(e) => setProductName(e.target.value)}
                  />
                </Field>
              )}
            </div>
            <GatewayPicker
              localities={localities}
              selected={selected}
              environment={first}
              onChange={setGateways}
            />
            <PathPreview
              localities={localities}
              selected={selected}
              path={
                domain ? publishedPath({ domain, subdomain, name: name || "api", apiVersion }) : "/…"
              }
            />
          </>
        )}

        {/* The reason the next step is out of reach, as a sentence, on the screen. A disabled
            button whose reason lives in a `title` is a button nobody can read on a phone. */}
        {blocked && <p className="muted">Still needed: {blocked}</p>}

        <div className="native-actions">
          {at > 0 && (
            <button type="button" className="btn" onClick={() => setStep(at - 1)}>
              Back
            </button>
          )}
          {at < last ? (
            <button type="submit" className="btn primary" disabled={Boolean(blocked)}>
              Next: {PUBLISH_STEPS[at + 1]!.label}
            </button>
          ) : (
            <button
              type="submit"
              className="btn primary"
              disabled={w.busy || !s.application || Boolean(blocked)}
            >
              {w.busy ? "Publishing…" : "Publish to DEV"}
            </button>
          )}
          {at === last && (
            <span className="muted">
              Deployment runs automatically. Progress appears in Activity.
            </span>
          )}
        </div>
      </form>
    </Panel>
  );
}
export function Editor({
  id,
  tab,
  session: s,
  operations,
  tick,
}: {
  id: string;
  /** The panel to open on, from `/apis/:id/:tab`. `?tab=` is read when the address carries none. */
  tab?: string;
  session: Session;
  operations: any[];
  tick: number;
}) {
  const data = useAsync(
    () =>
      api.get<any>(`/api/resources/${id}/editor?environment=${s.environment}`),
    [id, s.environment],
  );
  return (
    <>
      <Notice kind="error">{data.error}</Notice>
      {data.data ? (
        <EditorForm
          key={`${id}:${s.environment}:${data.data.resource.etag}`}
          data={data.data}
          session={s}
          tab={tab}
          refresh={data.reload}
          operations={operations.filter((o) => o.resourceId === id)}
          tick={tick}
        />
      ) : (
        // Not an empty state — nothing is empty, the request has not answered yet. A skeleton the
        // size of what is coming keeps the page from jumping when it does.
        <Skeleton rows={6} />
      )}
    </>
  );
}
/**
 * The workspace's own `canEdit` boolean, as the `Permission` the shared panels take.
 *
 * The two shapes exist because the workspace reads a resource view that already collapsed the
 * capability list into a flag and a sentence, while `lib/capabilities` is the vocabulary every
 * other screen speaks. Converting here rather than re-deriving keeps one source for the reason.
 */
function editPermission(d: any): Permission {
  return d.resource.canEdit
    ? ALLOWED
    : { enabled: false, reason: d.resource.editReason ?? "Only the owning application may change this." };
}

/** The workspace's panels, in reading order. Also the allowlist an asked-for tab is checked against. */
const EDITOR_TABS = [
  "definition",
  "properties",
  "policies",
  "subscriptions",
  "playground",
  "logs",
  "revisions",
  "history",
];

/**
 * What the control plane calls a panel, in the attention rows it writes: `/apis/:id/policy` for a
 * policy that will not compile, `/apis/:id/routing` for an API with no route, `/apis/:id/publish`
 * for one with no backend. Those names are older than this workspace and name a *problem* rather
 * than a panel, so they are translated here rather than renamed at the source — a stored href is
 * somebody's open tab.
 */
const ASKED_FOR: Record<string, string> = {
  policy: "policies",
  routing: "properties",
  publish: "properties",
  // "Try it from here instead" at the end of the subscribe wizard, which is the playground.
  try: "playground",
};

/** The panel an address asks for, or `definition`. A tab nobody has is ignored, never left blank. */
export function editorTab(asked: string | null | undefined): string {
  if (!asked) return "definition";
  const named = ASKED_FOR[asked] ?? asked;
  return EDITOR_TABS.includes(named) ? named : "definition";
}

/**
 * The definition as a person should read it.
 *
 * A normalised OpenAPI document is stored minified, so the editor opened on one very long line —
 * a 700-character wall with a single line number beside it, in a pane tall enough for forty lines.
 * Nothing was wrong with the editor; it had never been given anything to indent.
 *
 * Only strict JSON is reformatted. A YAML definition is left exactly as its author wrote it,
 * because re-emitting YAML restyles quoting, key order and block scalars, and "we tidied your file"
 * is not a thing a viewer should do. Anything that does not parse is returned untouched so a
 * malformed definition can still be seen and repaired.
 */
export function prettyDefinition(text: string, kind: string): string {
  if (kind === "soap" || !text.trim().startsWith("{")) return text;
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

/**
 * Whether the definition in the editor differs from the stored one **as a document**.
 *
 * This used to be `spec !== d.definition`, which made every save that followed a reformat — now
 * every save at all, since the editor indents on open — upload the definition again and cut a new
 * revision that said nothing. Whitespace is not a change to an API.
 */
export function definitionChanged(edited: string, stored: string, kind: string): boolean {
  if (kind === "soap") return edited.trim() !== (stored ?? "").trim();
  try {
    return JSON.stringify(parse(edited)) !== JSON.stringify(parse(stored ?? ""));
  } catch {
    // Unparseable on either side: fall back to the text, so a broken edit still counts as one.
    return edited !== stored;
  }
}

function EditorForm({
  data: d,
  session: s,
  tab: asked,
  refresh,
  operations,
  tick,
}: {
  data: any;
  session: Session;
  tab?: string;
  refresh: () => void;
  operations: any[];
  tick: number;
}) {
  const tabId = useId();
  // The link in the chain before this one, which is where an unpublished API is promoted from.
  // `null` at the head of the chain, where there is nothing before it and the answer is to publish.
  const previousEnvironment = s.meta.chain[s.meta.chain.indexOf(s.environment) - 1] ?? null;
  const w = useAction(),
    // How a link lands on the right panel: the dashboard's traffic table opens the Logs tab, an
    // attention row opens Policies. The address may name it as a segment — `/apis/:id/policy`,
    // which is what the control plane writes — or as `?tab=`, which is what the screens here write.
    [tab, setTab] = useState(() =>
      editorTab(asked ?? new URLSearchParams(location.search).get("tab")),
    ),
    [description, setDescription] = useState(d.resource.description ?? ""),
    [docsUrl, setDocsUrl] = useState(d.resource.docsUrl ?? ""),
    [pool, setPool] = useState<PoolEntry[]>(() =>
      (d.settings?.backend?.pool ?? []).length
        ? d.settings.backend.pool.map((entry: PoolEntry) => ({ ...entry }))
        : [{ url: "" }],
    ),
    [rule, setRule] = useState<string>(d.settings?.backend?.rule ?? "failover"),
    [domain, setDomain] = useState<string>(d.resource.domain ?? ""),
    [subdomain, setSubdomain] = useState<string>(d.resource.subdomain ?? ""),
    [spec, setSpec] = useState(() => prettyDefinition(d.definition ?? "", d.resource.kind)),
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
      d.resource.canEdit
        ? api.get<{ items: any[] }>(
            `/api/certificates?environment=${s.environment}`,
          )
        : Promise.resolve({ items: [] }),
    [s.environment, d.resource.canEdit],
  );
  const next = s.meta.chain[s.meta.chain.indexOf(s.environment) + 1];
  const first = s.meta.chain[0]!;
  const versions: Array<{ id: string; apiVersion: string; lifecycle: string }> =
    d.versions ?? [];
  const environmentMeta = s.meta.environments.find(
    (e) => e.environment === s.environment,
  );
  const localities = environmentMeta?.localities ?? [];
  // Where it answers today. Falling back to every gateway rather than to none: a row published
  // before an environment could hold more than one is on all of them, and an empty list here
  // would read as "on nothing" and refuse the next save.
  const [gateways, setGateways] = useState<string[]>(() =>
    (d.settings?.gateways ?? []).length
      ? [...d.settings.gateways]
      : localities.map((l: Locality) => l.name),
  );
  /**
   * The address, derived from the taxonomy rather than typed, and always ending in the version —
   * the same shape every other API in the estate has, so a consumer reading the URL knows which
   * contract they are on.
   */
  const basePath = domain
    ? publishedPath({
        domain,
        subdomain,
        name: d.resource.name,
        apiVersion: d.resource.apiVersion,
      })
    : (d.settings?.basePath ?? "");
  /** Load balancing and the breaker need somewhere to fail over to. */
  const members = pool.filter((entry) => entry.url.trim()).length;
  const canBalance = members >= 2;
  let doc: unknown = null;
  try {
    doc = parse(spec);
  } catch {}
  return (
    <>
      <Panel
        title={d.resource.name}
        className="api-workspace"
        actions={
          <div className="native-actions">
            {/* The documentation link, where somebody looking at the API is: the description says
                what it is, this is the rest of the story. Absent rather than disabled — unlike the
                controls below there is nothing to explain, the owner simply has not set one. */}
            {d.resource.docsUrl && (
              <a
                className="btn"
                href={d.resource.docsUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                Open wiki ↗
              </a>
            )}
            {/* Present and disabled rather than absent, with the reason on the screen: a control
                that vanishes leaves somebody wondering whether the feature exists at all, and on a
                foreign API that was the only answer this workspace gave (finding 8). */}
            {s.environment === first ? (
              <button
                className="btn"
                disabled={w.busy || !d.resource.canEdit || !d.published}
                title={d.resource.editReason ?? undefined}
                onClick={() => setVersion(true)}
              >
                New version
              </button>
            ) : (
              <span className="muted">
                A new version starts in {first.toUpperCase()} — switch
                environment to publish one.
              </span>
            )}
            {next && (
              <button
                className="btn primary"
                disabled={w.busy || !d.resource.canEdit || !d.published}
                title={d.resource.editReason ?? undefined}
                onClick={() => setPromote(true)}
              >
                Promote to {next.toUpperCase()}
              </button>
            )}
          </div>
        }
      >
        {d.resource.editReason && (
          <Notice kind="warn">{d.resource.editReason}</Notice>
        )}
        <p className="workspace-summary">
          {s.applicationName(d.resource.applicationId)} ·{" "}
          {d.resource.kind.toUpperCase()} · {d.resource.apiVersion} ·{" "}
          {d.resource.domain
            ? `${d.resource.domain}${d.resource.subdomain ? ` / ${d.resource.subdomain}` : ""}`
            : "no domain yet"}{" "}
          · Products: {d.products.map((p: any) => p.name).join(", ") || "None"}
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
        <div className="workspace-tabs" role="tablist" aria-label="API workspace panels">
          {EDITOR_TABS.map((t) => (
            <button
              className={tab === t ? "active" : ""}
              type="button"
              role="tab"
              id={`${tabId}-${t}`}
              aria-selected={tab === t}
              aria-controls={`${tabId}-panel`}
              tabIndex={tab === t ? 0 : -1}
              key={t}
              onClick={() => setTab(t)}
              onKeyDown={(event) => {
                const index = EDITOR_TABS.indexOf(t);
                const next = event.key === "ArrowRight" ? (index + 1) % EDITOR_TABS.length
                  : event.key === "ArrowLeft" ? (index + EDITOR_TABS.length - 1) % EDITOR_TABS.length
                  : event.key === "Home" ? 0 : event.key === "End" ? EDITOR_TABS.length - 1 : null;
                if (next === null) return;
                event.preventDefault();
                setTab(EDITOR_TABS[next]!);
                (event.currentTarget.parentElement?.children[next] as HTMLElement)?.focus();
              }}
            >
              {t.charAt(0).toUpperCase() + t.slice(1)}
            </button>
          ))}
        </div>
        <div role="tabpanel" id={`${tabId}-panel`} aria-labelledby={`${tabId}-${tab}`} tabIndex={0}>
        <Notice kind="error">{w.error}</Notice>
        {!d.published && (
          <EmptyState
            title={`Not published to ${s.environment.toUpperCase()}`}
            detail="Everything on the panels below is per environment, and this one is serving none of it. A version reaches an environment by being promoted into it from the one before."
            // The action is the environment it would come *from*, because "promote it" with no way
            // to reach the screen that promotes is the dead end this rule exists to stop.
            action={
              previousEnvironment ? (
                <button className="btn" onClick={() => s.setEnvironment(previousEnvironment)}>
                  Open {previousEnvironment.toUpperCase()} and promote it →
                </button>
              ) : (
                <Link to={`/${s.application}/publish`}>Publish an API →</Link>
              )
            }
          />
        )}
        {/* Not an empty state: the API is published and answering, and what is hidden is hidden on
            purpose. Saying "nothing here" about somebody else's configuration would be a lie. */}
        {d.published && d.settings?.redacted && (
          <Notice kind="info">
            It answers on <span className="mono">{d.settings.basePath}</span> in{" "}
            {s.environment.toUpperCase()}. Its backends and its policy belong to{" "}
            {d.resource.applicationName} and are not shown outside it.
          </Notice>
        )}
        {tab === "definition" && (
          <>
            <CodeMirror
              value={spec}
              extensions={[yaml(), EditorView.lineWrapping]}
              minHeight="340px"
              editable={d.resource.canEdit && !!d.settings}
              onChange={setSpec}
            />
            {/* Above the operations, because a document with an error in it has no trustworthy
                operation list to read — and below the editor, so the text being judged is the
                text on screen. */}
            <DefinitionDiagnostics
              source={spec}
              kind={d.resource.kind}
              onFix={d.resource.canEdit ? setSpec : undefined}
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
          <div className="workspace-properties">
            <Panel title="Catalog information">
            <DescriptionField
              value={description}
              onChange={setDescription}
              disabled={!d.resource.canEdit}
            />
            {/* One link, not a list: the question a consumer has after the description is "where do
                I read more", and two answers to it means one of them is stale. */}
            <Field label="Documentation link">
              <input
                type="url"
                placeholder="https://wiki.example/teams/…"
                disabled={!d.resource.canEdit}
                value={docsUrl}
                onChange={(e) => setDocsUrl(e.target.value)}
              />
              <span className="hint">
                Shown on the catalog listing and behind <b>Open wiki</b> above. Clear it to remove
                the link.
              </span>
            </Field>
            </Panel>
            <Panel title={`Backends · ${s.environment.toUpperCase()}`}>
            {/* A pool, not a URL: one member is the ordinary case and reads as one field, and the
                second one appears only when somebody asks for it. */}
            <div className="native-pool">
              <span className="lbl">
                {s.environment.toUpperCase()} backends
              </span>
              {/* The weight column names itself once, above the rows. Each input carries an
                  `aria-label`, so a screen reader always knew what the box was for; a sighted
                  reader saw an unexplained `1` in a narrow box next to a URL. */}
              {rule === "round-robin" && (
                <div className="backend-row backend-row-head" aria-hidden="true">
                  <span className="hint">Address</span>
                  <span className="hint">Share</span>
                  <span />
                </div>
              )}
              {pool.map((entry, index) => (
                <div className="backend-row" key={index}>
                  <input
                    type="url"
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
            {/* Load balancing is a choice between backends, so it only exists once there are two.
                Shown disabled with the reason rather than hidden, so "where did the setting go"
                has an answer on the screen. */}
            <Field label="How calls are spread across the backends">
              <select
                disabled={!d.resource.canEdit || !canBalance}
                value={canBalance ? rule : "failover"}
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
            {!canBalance ? (
              <p className="muted">
                Add a second backend to choose between failover and round-robin.
                With one backend every call goes to it, and a circuit breaker
                has nothing to fail over to — so that policy is unavailable too.
              </p>
            ) : rule === "round-robin" ? (
              <p className="muted">
                Each gateway keeps its own place in the rotation, so calls are
                spread per instance rather than across the fleet.
              </p>
            ) : null}
            </Panel>
            <Panel title={`Published address · ${s.environment.toUpperCase()}`}>
            <div className="native-form-grid">
            <DomainPicker
              domain={domain}
              subdomain={subdomain}
              disabled={!d.resource.canEdit}
              onChange={(nextTaxonomy) => {
                setDomain(nextTaxonomy.domain);
                setSubdomain(nextTaxonomy.subdomain);
              }}
            />
            </div>
            <Field label="Public path">
              {/* Derived, not typed: the domain is the first segment of the address, so a path
                  somebody could edit freely is a path that could contradict the catalog. */}
              <input readOnly value={basePath} aria-label="Public path" />
            </Field>
            {!d.resource.domain && (
              <Notice kind="warn">
                This API was published before the catalog had domains. Choosing
                one moves it from <span className="mono">{d.settings?.basePath}</span>{" "}
                to <span className="mono">{basePath}</span> when you save, so
                anybody calling the old address has to be told.
              </Notice>
            )}
            <GatewayPicker
              localities={localities}
              selected={gateways}
              environment={s.environment}
              disabled={!d.resource.canEdit}
              onChange={setGateways}
            />
            <PathPreview localities={localities} selected={gateways} path={basePath} />
            <p className="muted">
              These are the addresses consumers are given in {s.environment.toUpperCase()}. Each
              is a gateway's published hostname; its replicas are behind it and are never
              addressed directly.
            </p>
            <Notice kind="error">{certificates.error}</Notice>
            </Panel>
          </div>
        )}
        {tab === "policies" && (
          <>
            <PolicyForm
              value={policy}
              onChange={setPolicy}
              disabled={!d.resource.canEdit || !d.published}
              units={s.meta.policyUnits as any}
              kind={d.resource.kind}
              isAdmin={s.user.isAdmin}
              instances={environmentMeta?.liveInstances ?? 1}
              poolSize={members}
              certificates={(certificates.data?.items ?? []).filter(
                (c) => c.applicationId === d.resource.applicationId && !c.expired,
              )}
              certificate={certificate}
              onCertificate={setCertificate}
            />
            <details className="workspace-advanced">
              <summary>Advanced settings</summary>
              <CodeMirror
                value={policy}
                editable={d.resource.canEdit && !!d.published}
                minHeight="280px"
                onChange={setPolicy}
              />
            </details>
          </>
        )}
        {tab === "subscriptions" && (
          <Subscriptions session={s} tick={tick} resourceId={d.resource.id} />
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
        {tab === "logs" && (
          <div className="native-legacy">
            {/* Publisher-only, and said so on the screen rather than by the tab disappearing: a
                consumer who wonders where their calls went should learn who to ask. */}
            <LogsPanel
              resourceId={d.resource.id}
              environment={s.environment}
              canRead={d.resource.canEdit}
              reason={d.resource.editReason}
            />
          </div>
        )}
        {tab === "revisions" && (
          <div className="native-legacy">
            {/* Separate from `history` on purpose: that one is what the portal did, this one is
                what the contract promises and when the promise changed. */}
            <RevisionsPanel
              resourceId={d.resource.id}
              chain={s.meta.chain}
              environment={s.environment}
              canEdit={editPermission(d)}
              canPublish={editPermission(d)}
              onReleased={refresh}
            />
          </div>
        )}
        {tab === "history" && <OperationList items={operations} />}{" "}
        {["definition", "properties", "policies"].includes(tab) && (
          <div className="native-actions workspace-save">
            <button
              className="btn primary"
              disabled={w.busy || !d.resource.canEdit || !d.published || !domain}
              title={d.resource.editReason ?? undefined}
              onClick={() =>
                void w.run(async () => {
                  const body: any = {
                    environment: s.environment,
                    description,
                    // `""` is how the link is taken off — absent would mean "the form does not
                    // carry this field", which is what the definition and policy tabs mean.
                    docsUrl: docsUrl.trim(),
                    domain,
                    subdomain: subdomain || null,
                    basePath,
                    gateways,
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
                  if (definitionChanged(spec, d.definition, d.resource.kind))
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
            {/* The reason a disabled Save is disabled, in the order it becomes true. */}
            {!d.resource.canEdit ? (
              <span className="muted">{d.resource.editReason}</span>
            ) : !d.published ? (
              <span className="muted">
                Nothing to save: this API is not in {s.environment.toUpperCase()}.
              </span>
            ) : !domain ? (
              /* The blocker is one field, and this Save is shared by three panels — so the reason
                 has to know which one the reader is looking at. It used to say "choose a domain on
                 the properties tab first" from every one of them, including from Properties, where
                 the field is a few centimetres up the same screen. */
              <span className="muted">
                {tab === "properties" ? (
                  "Choose a domain above first — it is the first segment of the address."
                ) : (
                  <>
                    <button type="button" className="linklike" onClick={() => setTab("properties")}>
                      Choose a domain
                    </button>{" "}
                    first — it is the first segment of the address.
                  </>
                )}
              </span>
            ) : null}
          </div>
        )}
        </div>
      </Panel>
      {/* Only where there is progress to report. On somebody else's long-published API this used
          to read "No changes yet. Publish an API to get started." (finding 8). */}
      {operations.length > 0 && (
        <Panel title="Deployment progress">
          <OperationList items={operations.slice(0, 5)} />
        </Panel>
      )}
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
            <Notice kind="error">{w.error}</Notice>
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
  const w = useAction(),
    first = s.meta.chain[0]!;
  const products = useAsync(
    () => api.get<{ items: any[] }>("/api/products"),
    [d.resource.id],
  );
  const existing: string[] = (d.versions ?? []).map((v: any) => v.apiVersion);
  // Both versions answer at once, so the new one needs its own path. With a domain that is the
  // taxonomy plus the version; without one (an API published before domains) it is the old rule.
  const pathFor = (version: string) =>
    d.resource.domain
      ? publishedPath({
          domain: d.resource.domain,
          subdomain: d.resource.subdomain,
          name: d.resource.name,
          apiVersion: version,
        })
      : versionedPath(d.settings?.basePath ?? "", d.resource.apiVersion, version);
  const [identifier, setIdentifier] = useState(() => nextVersion(existing));
  const [path, setPath] = useState(() => pathFor(nextVersion(existing)));
  const [productId, setProduct] = useState<string>(d.products?.[0]?.id ?? "");
  const owned =
    products.data?.items.filter(
      (p) => p.applicationId === d.resource.applicationId && p.lifecycle === "active",
    ) ?? [];
  /** The name of the product both versions would share, or `null` when they would not. */
  const sameProduct: string | null =
    (d.products ?? []).find((p: any) => p.id === productId)?.name ?? null;
  const refusal = versionRefusal(d.resource.name, identifier, existing);
  return (
    <Modal title={`New version of ${d.resource.name}`} close={close}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (refusal) return;
          void w.run(async () => {
            const result = await command("/api/publish", {
              applicationId: d.resource.applicationId,
              name: d.resource.name,
              kind: d.resource.kind,
              apiVersion: identifier,
              productId,
              description: d.resource.description ?? "",
              host: d.settings.host,
              // A version is the same API in the same part of the catalog.
              domain: d.resource.domain,
              subdomain: d.resource.subdomain ?? null,
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
          <strong>{d.resource.apiVersion}</strong> keeps serving on its own path.
        </p>
        {/* Conditional on the product chosen below, because that is what actually decides it: a
            subscription is held against a product, not against an API, so putting both versions in
            one product means one key opens both (finding 7). */}
        <p className={sameProduct ? "banner warn" : "muted"}>
          {sameProduct
            ? `Both versions will be in ${sameProduct}, so an existing key for ${d.resource.apiVersion} will open ${identifier} too. Choose a different product below if the versions should be subscribed to separately.`
            : `${identifier} goes into a different product, so it has its own subscriptions and an existing key for ${d.resource.apiVersion} will not open it.`}
        </p>
        <Notice kind="error">{products.error ?? w.error}</Notice>
        <Field label="Version identifier">
          <input
            required
            pattern="[A-Za-z0-9][A-Za-z0-9._-]{0,31}"
            aria-invalid={refusal ? true : undefined}
            value={identifier}
            onChange={(e) => {
              setIdentifier(e.target.value);
              setPath(pathFor(e.target.value));
            }}
          />
        </Field>
        {/* Beside the field it is about rather than in the disabled button's tooltip: the reader
            has to change this box, and a reason they can only find by hovering the control they
            cannot press is a reason nobody reads. */}
        {refusal && <Notice kind="error">{refusal}</Notice>}
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
        <button className="btn primary" disabled={w.busy || !productId || refusal !== null}>
          {w.busy ? "Publishing…" : `Publish ${identifier} to ${first.toUpperCase()}`}
        </button>
      </form>
    </Modal>
  );
}
