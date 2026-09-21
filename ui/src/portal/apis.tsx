import { nameError, versionError, httpUrlError, NAME_PATTERN, NAME_HINT, VERSION_HINT } from "../lib/form-validation";
import { EMPTY_CATALOGUE, PolicyForm, type CredentialCatalogue } from "./PolicyForm";
import { PlaygroundPanel } from "../views/PlaygroundPanel";
import { LogsPanel } from "../views/LogsPanel";
import { RevisionsPanel } from "../views/RevisionsPanel";
import { Fragment, useState, useId } from "react";
import { EditorView } from "@codemirror/view";
import type { Session } from "../App";
import { api, type Locality } from "../api";
import {
  EmptyState,
  ChoiceField,
  TextField,
  Field,
  Link,
  Modal,
  Notice,
  OperationList,
  Panel,
  Skeleton,
  Term,
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
    <div className="taxonomy-fields" role="group" aria-label="Catalog location">
      <Field label="Domain" hint="Choose the domain first; it determines the sub-domains below.">
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
      <Field label="Sub-domain (optional)" hint={found ? `Options belong to ${found.name}. Changing the domain clears this choice.` : "Select a domain to see its sub-domains."}>
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
    </div>
  );
}

/**
 * Which of an environment's gateways an API answers on, and what it answers at on each.
 *
 * An environment can be served from more than one place — a managed gateway in the cloud, an
 * on-premise one — and the choice is per API and per environment. It is a checkbox list rather
 * than a dropdown because the answer is usually "both", and it refuses to reach zero: an API on
 * no gateway has an address nobody can call, which is not a state anyone means to be in.
 *
 * **The addresses are the final ones.** This control and a separate preview below it used to be
 * two components, so every gateway's origin was listed once bare and once with the base path
 * appended — the same URL twice, ten lines apart, differing by the only part that was worth
 * reading. There is one list now, and each line is what a consumer will actually call. A consumer
 * inside the network and one outside are given different names for the same gateway, so a gateway
 * with two addresses has two lines rather than an "internal or external" the reader has to
 * resolve themselves.
 */
export function GatewayPicker({
  localities,
  selected,
  path,
  environment,
  onChange,
  disabled,
}: {
  localities: Locality[];
  selected: string[];
  /** The base path the API answers at, appended to each address so the line is callable. */
  path: string;
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
  const addresses = (locality: Locality) =>
    locality.addresses.length === 0 ? (
      <li className="muted small">no published address yet</li>
    ) : (
      locality.addresses.map((address) => (
        <li key={address.url}>
          <span className="badge">
            {address.network === "intranet" ? "Intranet" : "Internet"}
          </span>
          <span className="mono">
            {address.url}
            {path}
          </span>
        </li>
      ))
    );

  // With one gateway there is no choice to make, so a checkbox would be one that cannot be
  // unticked. The addresses are the point either way, so they are all that is drawn.
  if (localities.length === 1) {
    const only = localities[0]!;
    return (
      <div className="gateway-list">
        <p className="muted">
          Answers on <strong>{only.name}</strong>
          {only.label ? ` · ${only.label}` : ""} — the only gateway {environment.toUpperCase()} has.
        </p>
        <ul className="url-list">{addresses(only)}</ul>
      </div>
    );
  }
  return (
    <div className="gateway-list">
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
          <label key={locality.name} className={on ? "pick-option on" : "pick-option"}>
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
              <ul className="url-list">{addresses(locality)}</ul>
            </span>
          </label>
        );
      })}
      <p className="hint">
        An API must be published on at least one gateway. Each address above is a gateway's own
        published hostname; its replicas sit behind it and are never called directly.
      </p>
    </div>
  );
}

/**
 * The next free identifier in the `v<n>` series, which is what almost every version here is. An API
 * versioned some other way falls back to a suffix rather than to a guess that collides.
 */
export function nextVersion(existing: string[]): string {
  const numbers = existing.map(value => /^v([1-9][0-9]{0,30})$/.exec(value)?.[1])
    .filter((value): value is string => value !== undefined).map(value => BigInt(value));
  const largest = numbers.reduce((max, value) => value > max ? value : max, 0n);
  const next = `v${largest + 1n}`;
  if (!versionError(next)) return next;
  let available = 1n;
  while (numbers.includes(available)) available++;
  return `v${available}`;
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
  if (clash === undefined) return versionError(identifier);
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
 * address, the address is what the definition is served under, and only then is there somewhere to
 * send the traffic. A single long form let somebody paste a definition and choose a backend before
 * they had decided what the API was called, and then re-do both when the name changed the path.
 *
 * The third step was "Route and sell", and the compound name was the honest description of a step
 * that did two unrelated things. The selling half is gone: an API sold on its own gets its own
 * product without being asked, and bundling several into one is the Products screen's job, for the
 * minority who want it. What is left is one word.
 *
 * A step is reachable only when every step before it is answered, and the reason a step is not
 * reachable is on the screen rather than in a disabled button's tooltip. Going *back* is always
 * allowed — nothing is submitted until the last step.
 */
const PUBLISH_STEPS = [
  { key: "identify", label: "Identify" },
  { key: "define", label: "Define" },
  { key: "route", label: "Route" },
] as const;

export function Publish({ session: s }: { session: Session }) {
  const requestedKind = new URLSearchParams(location.search).get("kind");
  const fixedKind = requestedKind === "mcp" || requestedKind === "a2a" ? requestedKind : null;
  const noun = fixedKind === "mcp" ? "MCP server" : fixedKind === "a2a" ? "A2A agent" : "API";
  const resources = useAsync(() => listAll<{ id: string; name: string; applicationId: string }>("/api/resources"), [s.application]);
  const [step, setStep] = useState(0);
  const w = useAction();
  const [kind, setKind] = useState(
      fixedKind ?? (requestedKind === "soap" ? "soap" : "rest"),
    ),
    [name, setName] = useState(""),
    [apiVersion, setApiVersion] = useState("v1"),
    [description, setDescription] = useState(""),
    [docsUrl, setDocsUrl] = useState(""),
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

  const duplicate = resources.data?.items.find(resource => resource.applicationId === s.application && resource.name.toLowerCase() === name.trim().toLowerCase());
  const nameProblem = nameError(name) ?? (duplicate ? `This application already has ${name}. Open its workspace to edit it or create a new version.` : null);
  const versionProblem = versionError(apiVersion);

  /** What is still missing from a step, in one sentence, or `null` when it is answered. */
  function missing(at: number): string | null {
    if (at === 0) {
      if (nameProblem) return nameProblem;
      if (versionProblem) return versionProblem;
      if (resources.loading) return "Checking existing names…";
      if (resources.error) return "Reload the existing names before continuing.";
      if (!domain) return "A domain. It is the first segment of the address and how the catalog is browsed.";
      return null;
    }
    if (at === 1) {
      if (source === "url" && httpUrlError(url)) return "Definition URL: " + httpUrlError(url);
      if (httpUrlError(docsUrl, true)) return "Documentation link: " + httpUrlError(docsUrl, true);
      if (source !== "url" && !spec.trim()) return "A definition — paste one, or upload a file.";
      return null;
    }
    if (httpUrlError(backendUrl)) return `Backend URL: ${httpUrlError(backendUrl)}`;
    if (selected.length === 0) return "At least one gateway to answer on.";
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
    <Panel title={`Publish ${noun} to ${first.toUpperCase()}`} className="publish-flow">
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
          if (blocked || w.busy) return;
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
        <Notice kind="error">{w.error}</Notice>

        {at === 0 && (
          <>
            <div className="publish-identity">
              <TextField label={`${noun} name`} value={name} onChange={setName} required pattern={NAME_PATTERN}
                hint={NAME_HINT} error={name ? nameProblem : null} maxLength={61} />
              <div className="publish-short-fields">
                {fixedKind ? <div className="native-field"><span className="lbl">Type</span><strong>{fixedKind.toUpperCase()}</strong></div> :
                  <ChoiceField label="Type" value={kind} onChange={setKind} options={[{value: "rest", label: "REST"}, {value: "soap", label: "SOAP"}]} />}
                <TextField label="Version" value={apiVersion} onChange={setApiVersion} required pattern="v[1-9][0-9]{0,30}"
                  hint={VERSION_HINT} error={apiVersion ? versionProblem : null} maxLength={32} />
              </div>
            </div>
            {duplicate && <p><Link to={`/${s.application}/apis/${duplicate.id}`}>Open {duplicate.name} workspace →</Link></p>}
            {resources.error && <><Notice kind="error">{resources.error}</Notice><button type="button" className="btn" onClick={resources.reload}>Retry name check</button></>}
            <DomainPicker domain={domain} subdomain={subdomain} onChange={(next) => { setDomain(next.domain); setSubdomain(next.subdomain); }} />
            {!nameProblem && !versionProblem && domain && (
              <Field label="Published path">
                <code>{publishedPath({ domain, subdomain, name, apiVersion })}</code>
              </Field>
            )}
            <p className="muted">
              Address: domain / sub-domain (if chosen) / name / version.
              {" "}Full URLs appear after you choose gateways in the Route step.
            </p>
          </>
        )}

        {at === 1 && (
          <>
            <ChoiceField label="Definition source" value={source} onChange={setSource}
              options={[{value: "text", label: "Upload or paste"}, {value: "url", label: "Import from URL"}]} />
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
              <Field label={`${first.toUpperCase()} backend URL`}>
                <input
                  type="url"
                  value={backendUrl}
                  onChange={(e) => setBackend(e.target.value)}
                />
              </Field>
            </div>
            {/* Said rather than asked. Consumers still subscribe to products and never to an API,
                but the product for an API sold on its own is a bundle of one and the answer people
                typed was the API's name — so it is made, named after the API, and only a publisher
                who genuinely wants to bundle has anything to do. */}
            <p className="muted">
              <Term name="product">A product</Term> named <strong>{name || "…"}</strong> will be
              created for this <Term name="api">API</Term>, because that is what consumers subscribe
              to. Later versions of {name || "it"} join the same one. To sell several APIs together
              instead, put them in one product on{" "}
              <Link to={`/${s.application}/products`}>Products</Link>.
            </p>
            <GatewayPicker
              localities={localities}
              selected={selected}
              environment={first}
              path={
                domain ? publishedPath({ domain, subdomain, name: name || "api", apiVersion }) : "/…"
              }
              onChange={setGateways}
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
              {w.busy ? "Publishing…" : `Publish to ${first.toUpperCase()}`}
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
  /**
   * What the policy form's reference pickers are drawn from. Fetched here rather than inside the
   * form because the form is also rendered on the global-policy screen, which has no application
   * to own a credential — and a component that fetched for itself would have to invent one.
   */
  const credentials = useAsync(
    () =>
      d.resource.canEdit
        ? api.get<{ items: any[]; registered: any }>(
            `/api/credentials?environment=${s.environment}`,
          )
        : Promise.resolve({ items: [], registered: EMPTY_CATALOGUE.registered }),
    [s.environment, d.resource.canEdit],
  );
  const catalogue: CredentialCatalogue = {
    applicationId: d.resource.applicationId,
    own: (credentials.data?.items ?? []).filter(
      (row: any) => row.applicationId === d.resource.applicationId,
    ),
    registered: credentials.data?.registered ?? EMPTY_CATALOGUE.registered,
  };
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
  /** Changes this API has made that the fleet has not finished acknowledging. */
  const inFlight = operations.filter(
    (operation) => !["complete", "superseded", "failed"].includes(operation.state),
  ).length;
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
            {/* Beside "New version", because switching version and making one are the same kind
                of act — moving between siblings of the thing on screen. It was a page-wide `Field`
                under the summary line, which put a navigation control among the API's properties
                and gave a two-character value a thousand pixels of box. */}
            {versions.length > 1 && (
              <label className="workspace-version">
                <span className="lbl">Version</span>
                <select
                  aria-label="Version"
                  value={d.resource.id}
                  onChange={(e) => go(`/${s.application}/apis/${e.target.value}`)}
                >
                  {versions.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.apiVersion}
                      {v.lifecycle === "active" ? "" : ` (${v.lifecycle})`}
                    </option>
                  ))}
                </select>
              </label>
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
          /* Two columns, because they are two readings of one document and the question this tab
             answers is whether they agree. Stacked, the operation list began below a definition
             that is routinely a thousand lines long — so the editor grew to the height of whatever
             was pasted into it, the page scrolled for a minute, and the list of what the API
             actually offers was somewhere past the end of it. The editor is capped and scrolls
             within itself instead; the columns collapse below 1100px, where side by side would
             mean two unreadable ones. */
          <div className="definition-split">
            <div className="definition-source">
              <CodeMirror
                value={spec}
                extensions={[yaml(), EditorView.lineWrapping]}
                minHeight="340px"
                maxHeight="560px"
                editable={d.resource.canEdit && !!d.settings}
                onChange={setSpec}
              />
              {/* Under the editor, so the text being judged is the text on screen, and in the same
                  column, so a diagnostic and the line it is about are never in different halves. */}
              <DefinitionDiagnostics
                source={spec}
                kind={d.resource.kind}
                onFix={d.resource.canEdit ? setSpec : undefined}
              />
            </div>
            <div className="definition-shape">
              {d.resource.kind === "rest" && <OperationsCard doc={doc} loading={false} />}
              {d.resource.kind === "soap" && (
                <WsdlServicesCard wsdl={parseWsdl(spec)} loading={false} />
              )}
            </div>
          </div>
        )}
        {tab === "properties" && (
          /* Three headed sections rather than three cards inside the workspace's own card. A
             panel is a boundary, and nesting one inside another draws a boundary around
             something that was never separate — the reader was looking at a box, in a box, in a
             box, and the only thing the inner two added was a border and a shadow. What actually
             groups here is a *set of fields*, and that is what carries the tint. */
          <div className="workspace-properties">
            <section className="workspace-section">
              <h4>Catalog information</h4>
              <div className="field-group">
                <DescriptionField
                  value={description}
                  onChange={setDescription}
                  disabled={!d.resource.canEdit}
                />
                {/* One link, not a list: the question a consumer has after the description is
                    "where do I read more", and two answers to it means one of them is stale. */}
                <Field
                  label="Documentation link"
                  hint="Shown on the catalog listing and behind Open wiki above. Clear it to remove the link."
                >
                  <input
                    type="url"
                    placeholder="https://wiki.example/teams/…"
                    disabled={!d.resource.canEdit}
                    value={docsUrl}
                    onChange={(e) => setDocsUrl(e.target.value)}
                  />
                </Field>
              </div>
            </section>
            <section className="workspace-section">
              <h4>Backends · {s.environment.toUpperCase()}</h4>
              <div className="field-group">
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
              </div>
            </section>
            <section className="workspace-section">
              <h4>Published address · {s.environment.toUpperCase()}</h4>
              {/* Domain, sub-domain and path are one thought — the first two *are* the third — so
                  one group holds all three, and the derived path sits with the two boxes that
                  decide it rather than under a heading of its own. */}
              <div className="field-group">
                <DomainPicker
                  domain={domain}
                  subdomain={subdomain}
                  disabled={!d.resource.canEdit}
                  onChange={(nextTaxonomy) => {
                    setDomain(nextTaxonomy.domain);
                    setSubdomain(nextTaxonomy.subdomain);
                  }}
                />
                <Field
                  label="Public path"
                  hint="Built from the domain, the sub-domain and the API's name — change those to change this."
                >
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
              </div>
              <div className="field-group">
                <GatewayPicker
                  localities={localities}
                  selected={gateways}
                  path={basePath}
                  environment={s.environment}
                  disabled={!d.resource.canEdit}
                  onChange={setGateways}
                />
              </div>
              <Notice kind="error">{certificates.error}</Notice>
            </section>
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
              catalogue={catalogue}
              globalUnits={d.globalUnits ?? []}
            />
            <Notice kind="error">{credentials.error}</Notice>
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
        {tab === "history" && (
          /* The one place deployment progress is reported. It used to be here *and* in a panel
             below the workspace on every other tab — so the Definition tab, the Playground and the
             log search each carried a table about something else, and the tab named after it was
             the only one that did not. Finishing is announced by the bell rather than by a table
             somebody has to be looking at (`operation.complete`). */
          <section className="workspace-section">
            <h4>Deployment progress</h4>
            <OperationList items={operations} />
          </section>
        )}{" "}
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
            ) : (
              /* Where the progress went. One sentence beside the button that starts a deployment,
                 rather than a table on every panel: what is still in flight is on History, and
                 what has landed arrives in the bell without anybody watching for it. */
              <span className="muted">
                Saving deploys automatically.{" "}
                {inFlight > 0 ? (
                  <>
                    <button type="button" className="linklike" onClick={() => setTab("history")}>
                      {inFlight} change{inFlight === 1 ? "" : "s"} still reaching the gateways
                    </button>
                    .
                  </>
                ) : (
                  <>
                    Progress is on{" "}
                    <button type="button" className="linklike" onClick={() => setTab("history")}>
                      History
                    </button>
                    ; the bell says when it lands.
                  </>
                )}
              </span>
            )}
          </div>
        )}
        </div>
      </Panel>
      {version && (
        <NewVersion
          data={d}
          session={s}
          spec={spec}
          close={() => setVersion(false)}
        />
      )}
      {promote && next && (
        <PromoteDialog
          resourceId={d.resource.id}
          session={s}
          to={next}
          // What it answers on here, as the preview's path until the destination has one of its
          // own — the address is derived from the taxonomy, so it is the same in every environment.
          basePath={basePath}
          close={() => setPromote(false)}
        />
      )}
    </>
  );
}

/**
 * Promotion into the next environment, and **which of its gateways** the API answers on there.
 *
 * The gateway choice belongs here rather than only on the Properties tab, because a promotion is
 * the first time the API exists in the destination at all: without it the answer was "every gateway
 * that environment has", and the only way to narrow it was to promote onto all of them and then
 * take some away — which is a window during which the API is answering somewhere nobody chose.
 * Gateway names travel by name, not by id, so a locality DEV has and TEST does not is a decision to
 * be made on this screen rather than a silent drop (`resolveGateways`).
 *
 * What it already answers on there is read before the choice is offered. Defaulting to "all" would
 * quietly widen a second promotion into a locality somebody had previously removed it from; the
 * control plane's own default for a re-promotion is the existing binding, and this matches it.
 */
function PromoteDialog({
  resourceId,
  session: s,
  to,
  basePath,
  close,
}: {
  resourceId: string;
  session: Session;
  to: string;
  /** The address it answers on today, for the preview before the destination has a route. */
  basePath: string;
  close: () => void;
}) {
  const w = useAction();
  const [targetUrl, setTargetUrl] = useState("");
  const [gateways, setGateways] = useState<string[] | null>(null);
  const localities: Locality[] =
    s.meta.environments.find((e) => e.environment === to)?.localities ?? [];
  // What is already there, so a second promotion neither re-asks for a backend it has nor widens a
  // locality choice somebody already narrowed.
  const there = useAsync(
    () => api.get<any>(`/api/resources/${resourceId}/editor?environment=${to}`),
    [resourceId, to],
  );
  const first = there.data ? !there.data.published : false;
  const selected =
    gateways ??
    (there.data?.settings?.gateways?.length
      ? [...there.data.settings.gateways]
      : localities.map((l) => l.name));

  return (
    <Modal title={`Promote to ${to.toUpperCase()}`} close={close}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void w.run(async () => {
            await command(`/api/resources/${resourceId}/promote`, {
              environment: to,
              gateways: selected,
              ...(targetUrl ? { backendUrl: targetUrl } : {}),
            });
            close();
            s.setEnvironment(to);
          });
        }}
      >
        <p>
          Your saved API definition and settings will be promoted automatically. Save any pending
          edits before promoting. Existing target backend settings are retained.
        </p>
        <Notice kind="error">{there.error}</Notice>
        {there.loading && !there.data ? (
          <Skeleton rows={3} />
        ) : (
          <>
            <Field
              label={
                first
                  ? `${to.toUpperCase()} backend URL (required for the first promotion)`
                  : `${to.toUpperCase()} backend URL (leave empty to keep the one it has)`
              }
            >
              <input
                type="url"
                required={first}
                value={targetUrl}
                onChange={(e) => setTargetUrl(e.target.value)}
              />
            </Field>
            <GatewayPicker
              localities={localities}
              selected={selected}
              environment={to}
              path={there.data?.settings?.basePath ?? basePath}
              onChange={setGateways}
            />
          </>
        )}
        <Notice kind="error">{w.error}</Notice>
        <button
          className="btn primary"
          disabled={w.busy || there.loading || selected.length === 0}
        >
          {w.busy ? "Promoting…" : `Promote to ${to.toUpperCase()}`}
        </button>
      </form>
    </Modal>
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
  // Derived from the identifier above, not held in state. It was a state the identifier's own
  // `onChange` wrote and a text box could then overwrite — so a path outside the API's domain
  // prefix was one keystroke away, which is the address contradicting the catalog that the
  // workspace's Public path is read-only to prevent.
  const path = pathFor(identifier);
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
              gateways: d.settings.gateways,
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
            pattern="v[1-9][0-9]{0,30}"
            aria-invalid={refusal ? true : undefined}
            value={identifier}
            onChange={(e) => setIdentifier(e.target.value)}
          />
        </Field>
        {/* Beside the field it is about rather than in the disabled button's tooltip: the reader
            has to change this box, and a reason they can only find by hovering the control they
            cannot press is a reason nobody reads. */}
        {refusal && <Notice kind="error">{refusal}</Notice>}
        {/* Kept, but as a fact rather than a field. The sentence above promises that v1 keeps
            serving on its own path, and this is the claim that makes it checkable — where the new
            version will answer, changing as the identifier is typed. */}
        <Field label="Public path" hint="Built from the catalog location and the identifier above.">
          <input readOnly value={path} aria-label="Public path" />
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
          backends, gateway selection and saved policies. Access comes from the selected product's
          subscriptions. Settings in later environments are not carried over.
        </p>
        <button className="btn primary" disabled={w.busy || !productId || refusal !== null}>
          {w.busy ? "Publishing…" : `Publish ${identifier} to ${first.toUpperCase()}`}
        </button>
      </form>
    </Modal>
  );
}
