import { useMemo, useState } from "react";
import type { Session } from "../App";
import { api } from "../api";
import {
  DangerZone,
  EmptyState,
  Field,
  Modal,
  Notice,
  Panel,
  Skeleton,
  StatusChip,
  Link,
  go,
  useAction,
  useAsync,
} from "../components";
import { permit, type Permission } from "../lib/capabilities";
import { lifecycleChip } from "../lib/status";
import type { Lifecycle } from "../../../shared/types";
import { DOMAINS } from "../../../shared/domains";
import { command, listAll } from "./client";
import * as I from "./icons";
import { KindBadge, legendOf, toneClassOf, type Kind } from "./components/KindBadge";
import { VersionEnvPicker } from "./components/VersionEnvPicker";
import { DescriptionMarkdown } from "./components/DescriptionMarkdown";

/**
 * What one application publishes, and what it may call: its APIs, its MCP servers, its A2A agents.
 *
 * This screen used to have a second setting, `discover`, which drew the same rows for the whole
 * estate and was the shell's Catalog. It is not any more. The catalogue is `views/MarketView`, at
 * `/catalog`, because that is the one backed by `/api/catalog` — ranking across the contract itself,
 * facet counts over the visible set, Kafka topics in the same taxonomy, and a truthful `truncated`
 * flag. Filtering `/api/resources` in the browser could imitate the list but not any of that, so
 * two screens under one title meant two answers to one question. What is left here is the owner's
 * list, which is what this component was always better at: it is the one with the version picker,
 * the environment chevrons and the two actions only an owner has.
 *
 * Three decisions shape it.
 *
 *  - **Grouped by domain, not by application.** People look for an API by what it does. The
 *    publishing team is incidental, and it is already on the row.
 *  - **Two kinds of row, told apart on the row.** An application's own APIs and the ones it merely
 *    subscribes to are both "the APIs I work with", and the list used to hold only the first — so
 *    the half of the estate a team calls every day was on a different screen, filed under the
 *    product that sells it. A subscribed row carries the publisher's name and a `subscribed` tag,
 *    has none of the owner's actions, and opens the catalogue's read-only listing rather than an
 *    editor that would refuse every edit.
 *  - **One card per family, not per version.** `orders v1` and `orders v2` are one API with two
 *    contracts. The version picker on the right chooses between them, and the chevrons beside it
 *    re-evaluate against whichever one is chosen.
 *  - **Every environment slot is always drawn.** A version live on DEV and nowhere else shows two
 *    grey chevrons, and that gap is the most useful thing on the row.
 */

interface ResourceRow {
  id: string;
  kind: Kind;
  name: string;
  applicationId: string;
  apiVersion: string;
  family: string;
  lifecycle: string;
  summary: string | null;
  description: string | null;
  domain: string | null;
  subdomain: string | null;
  capabilities: string[];
  liveIn: string[];
  etag: string;
}

/** Only the three fields this screen reads; the subscriptions screen owns the rest. */
interface SubscriptionRow {
  applicationId: string;
  productId: string;
  environment: string;
  state: string;
}

interface ProductRow {
  id: string;
  name: string;
  members: Array<{ id: string }>;
}

interface Version {
  apiVersion: string;
  id: string;
  environments: Set<string>;
  description: string | null;
  lifecycle: string;
  capabilities: string[];
  etag: string;
}

interface Family {
  key: string;
  name: string;
  kind: Kind;
  applicationId: string;
  domain: string | null;
  subdomain: string | null;
  /** Latest first. The row's chrome is the newest version's; the picker chooses among all of them. */
  versions: Version[];
}

const OTHER = "Other";

/** How this application reaches one resource it does not own. */
interface Reach {
  /** The products the subscription is to. A resource can be sold by more than one. */
  products: string[];
  /** The environments a subscription covers — keys are per environment, so this is where it works. */
  environments: Set<string>;
}

/**
 * Which rows the list is showing.
 *
 * `all` is the default because the question "what do we work with" spans both, and the tag on the
 * row answers "which is this" without the reader touching a control.
 */
const SHOWING = {
  all: "All",
  ours: "Published here",
  theirs: "Subscribed",
} as const;
type Showing = keyof typeof SHOWING;

/** What one row is called, on each of the three screens this component draws. */
const NOUNS: Record<string, { one: string; many: string }> = {
  apis: { one: "API", many: "APIs" },
  mcp: { one: "MCP server", many: "MCP servers" },
  a2a: { one: "A2A agent", many: "A2A agents" },
};

/**
 * Descending by version, comparing the numbers inside rather than the strings around them, so
 * `v10` sorts above `v9`. Anything without a number falls back to reverse-lexicographic, which is
 * at least stable.
 */
function compareVersionsDesc(a: string, b: string): number {
  const numbersIn = (value: string) => (value.match(/\d+/g) ?? []).map(Number);
  const left = numbersIn(a);
  const right = numbersIn(b);
  if (left.length === 0 || right.length === 0) return b.localeCompare(a);
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const difference = (right[index] ?? 0) - (left[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return b.localeCompare(a);
}

/**
 * The first couple of sentences, clamped on the *source* rather than with CSS.
 *
 * The card renders Markdown, and a `line-clamp` over rendered Markdown cuts through the middle of
 * a table or a fenced block and leaves the wreckage visible. Cutting the text first means the
 * reader always sees whole sentences, and the `…` is honest about there being more.
 */
export function clampSentences(text: string, sentences: number): string {
  const trimmed = text.trim();
  const ends = [...trimmed.matchAll(/[.!?](\s|$)/g)];
  const end = ends[sentences - 1]?.index;
  if (end === undefined || end + 1 >= trimmed.length) {
    return trimmed.length > 240 ? `${trimmed.slice(0, 240).trimEnd()}…` : trimmed;
  }
  return `${trimmed.slice(0, end + 1)} …`;
}

/**
 * Rows into families, keyed on `applicationId/name` — the identity the control plane already puts
 * on every row as `family`, so the grouping here and the version list on the server agree.
 */
export function toFamilies(rows: ResourceRow[]): Family[] {
  const byKey = new Map<string, Family>();
  for (const row of rows) {
    const version: Version = {
      apiVersion: row.apiVersion,
      id: row.id,
      environments: new Set(row.liveIn ?? []),
      description: row.description ?? row.summary,
      lifecycle: row.lifecycle,
      capabilities: row.capabilities ?? [],
      etag: row.etag,
    };
    const existing = byKey.get(row.family);
    if (existing) {
      existing.versions.push(version);
      // The newest version's taxonomy wins. The domain is the front of the address and does not
      // change between versions; where two rows disagree, the one being published to is the truth.
      if (compareVersionsDesc(row.apiVersion, existing.versions[0]!.apiVersion) < 0) {
        existing.domain = row.domain;
        existing.subdomain = row.subdomain;
      }
    } else {
      byKey.set(row.family, {
        key: row.family,
        name: row.name,
        kind: row.kind,
        applicationId: row.applicationId,
        domain: row.domain,
        subdomain: row.subdomain,
        versions: [version],
      });
    }
  }
  for (const family of byKey.values()) {
    family.versions.sort((a, b) => compareVersionsDesc(a.apiVersion, b.apiVersion));
  }
  return [...byKey.values()];
}

export function Catalog({
  session: s,
  section,
  tick,
}: {
  session: Session;
  /** Which of the owner's three lists this is: `apis`, `mcp` or `a2a`. */
  section: string;
  tick: number;
}) {
  const [search, setSearch] = useState("");
  const [showing, setShowing] = useState<Showing>("all");
  const [folded, setFolded] = useState<ReadonlySet<string>>(new Set());

  const data = useAsync(() => listAll<ResourceRow>("/api/resources"), [tick]);
  // Two more calls, because a subscription names a product and a product names the APIs in it, and
  // neither side of that carries the other. Both are small and both are already cached by the
  // screens beside this one.
  const subscriptions = useAsync(
    () => api.get<{ items: SubscriptionRow[] }>("/api/subscriptions"),
    [tick],
  );
  const products = useAsync(() => api.get<{ items: ProductRow[] }>("/api/products"), [tick]);

  /** Resource id → how this application reaches it, for every resource it does not publish. */
  const reach = useMemo(() => {
    const byId = new Map((products.data?.items ?? []).map((product) => [product.id, product]));
    const found = new Map<string, Reach>();
    for (const subscription of subscriptions.data?.items ?? []) {
      if (subscription.applicationId !== s.application) continue;
      // `active` works now and `activating` is approved and on its way. The four that are neither
      // are the subscriptions screen's business: a rejected request is not access to an API, and a
      // row for one here would be a listing of things you cannot call.
      if (subscription.state !== "active" && subscription.state !== "activating") continue;
      const product = byId.get(subscription.productId);
      if (!product) continue;
      for (const member of product.members ?? []) {
        const entry = found.get(member.id) ?? { products: [], environments: new Set<string>() };
        if (!entry.products.includes(product.name)) entry.products.push(product.name);
        entry.environments.add(subscription.environment);
        found.set(member.id, entry);
      }
    }
    return found;
  }, [subscriptions.data, products.data, s.application]);

  const families = useMemo(() => {
    // `apis` means REST and SOAP, not "everything": MCP servers and A2A agents have their own
    // sidebar entries, and listing them here too put the same API under two headings.
    const rows = (data.data?.items ?? []).filter((row) => {
      // Somebody else's version is here only if a subscription reaches that exact version, so the
      // picker offers the contracts this application may call and not the ones it may not.
      if (row.applicationId !== s.application && !reach.has(row.id)) return false;
      if (section === "mcp") return row.kind === "mcp";
      if (section === "a2a") return row.kind === "a2a";
      if (section === "apis") return row.kind === "rest" || row.kind === "soap";
      return true;
    });
    return toFamilies(rows);
  }, [data.data, section, s.application, reach]);

  const ours = useMemo(
    () => families.filter((family) => family.applicationId === s.application),
    [families, s.application],
  );
  const theirs = families.length - ours.length;

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    const scoped =
      showing === "ours"
        ? ours
        : showing === "theirs"
          ? families.filter((family) => family.applicationId !== s.application)
          : families;
    if (!term) return scoped;
    return scoped.filter((family) => {
      const haystack = [
        family.name,
        family.domain ?? "",
        family.subdomain ?? "",
        s.applicationName(family.applicationId),
        ...family.versions.map((version) => `${version.apiVersion} ${version.description ?? ""}`),
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(term);
    });
  }, [families, ours, search, showing, s]);

  // Filters are applied *before* bucketing, so a group's count is truthful and an emptied group
  // disappears instead of standing there saying zero.
  const groups = useMemo(() => {
    const buckets = new Map<string, Family[]>();
    for (const family of filtered) {
      const key = family.domain ?? OTHER;
      buckets.set(key, [...(buckets.get(key) ?? []), family]);
    }
    // In taxonomy order with "Other" last, matching the facets endpoint: the domain list is a fixed
    // structure the estate is filed into, and one that reorders itself by count is not a structure.
    return [...DOMAINS.map((entry) => entry.name), OTHER]
      .filter((name) => buckets.has(name))
      .map((name) => ({
        name,
        families: buckets.get(name)!.sort((a, b) => a.name.localeCompare(b.name)),
      }));
  }, [filtered]);

  const filtering = Boolean(search.trim()) || showing !== "all";
  // One component draws three screens, so every noun on it is a variable. It used to say "API"
  // throughout — the MCP Servers screen offered a box placeholdered "Search APIs…" and an empty
  // state that told a reader with no MCP server to go and publish an API.
  const noun = NOUNS[section] ?? NOUNS.apis!;
  const count = (n: number) => `${n} ${n === 1 ? noun.one : noun.many}`;

  return (
    <>
      <Panel
        // The heading says the one thing the shell's title and purpose cannot: how many there are,
        // and — while a search is narrowing them — how many of how many. Naming the section again
        // here is what it used to do, and the reader had just read that in the `<h1>` above it.
        title={filtering ? `${filtered.length} of ${count(families.length)}` : count(families.length)}
        className="workspace-catalog"
        actions={
          <>
            {/* Offered only when there is something on both sides of it. A three-way filter over a
                list that is entirely one of the three is a control that operates nothing. */}
            {ours.length > 0 && theirs > 0 && (
              <div className="seg catalog-scope" role="group" aria-label={`Which ${noun.many} to show`}>
                {(Object.keys(SHOWING) as Showing[]).map((option) => (
                  <button
                    key={option}
                    className={showing === option ? "active" : ""}
                    aria-pressed={showing === option}
                    onClick={() => setShowing(option)}
                  >
                    {SHOWING[option]}{" "}
                    {option === "all" ? families.length : option === "ours" ? ours.length : theirs}
                  </button>
                ))}
              </div>
            )}
            <div className="catalog-search">
              <span aria-hidden="true"><I.Search /></span>
              <input
                aria-label={`Search this application's ${noun.many}`}
                type="search"
                placeholder={`Search ${noun.many}…`}
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </div>
          </>
        }
      >
        <Notice kind="error">{data.error ?? subscriptions.error ?? products.error}</Notice>

        {data.loading && !data.data ? (
          <Skeleton rows={4} />
        ) : groups.length === 0 ? (
          filtering ? (
            <EmptyState
              title={
                search.trim()
                  ? `Nothing here matches “${search.trim()}”`
                  : showing === "ours"
                    ? `${s.applicationName(s.application)} publishes no ${noun.many}`
                    : `${s.applicationName(s.application)} subscribes to no ${noun.many}`
              }
              detail={`The search covers the name, the domain, the publisher and each version's description, across what ${s.applicationName(s.application)} publishes and what it subscribes to. The estate-wide catalogue searches the contract itself.`}
              action={
                <button
                  className="btn sm"
                  onClick={() => {
                    setSearch("");
                    setShowing("all");
                  }}
                >
                  Clear the filters
                </button>
              }
            />
          ) : (
            <EmptyState
              title={`${s.applicationName(s.application)} has no ${noun.many} yet`}
              detail={`Publish your first ${noun.one}, or find a resource to subscribe to in the Catalog.`}
              action={
                <button className="btn sm" onClick={() => go(`/${s.application}/publish${section === "mcp" || section === "a2a" ? `?kind=${section}` : ""}`)}>
                  {/* All three are read letter-first — "an API", "an MCP server", "an A2A agent" —
                      so the article is a constant rather than a fourth field on the noun. */}
                  Publish an {noun.one}
                </button>
              }
            />
          )
        ) : (
          <div className="discover-list">
            {groups.map((group) => {
              // A search that folded its own hits away would defeat itself, so any active filter
              // opens every group — and the reader's own fold state returns when it is cleared.
              const open = filtering || !folded.has(group.name);
              return (
                <section className={`discover-card ${open ? "open" : ""}`} key={group.name}>
                  <button
                    className="discover-card-head"
                    aria-expanded={open}
                    onClick={() => {
                      const next = new Set(folded);
                      if (next.has(group.name)) next.delete(group.name);
                      else next.add(group.name);
                      setFolded(next);
                    }}
                  >
                    <span className="swatch">{group.name.slice(0, 2).toUpperCase()}</span>
                    <span className="meta">
                      <span className="n">{group.name}</span>
                      <span className="s">{count(group.families.length)}</span>
                    </span>
                    <I.ChevDown size={14} className={`chev ${open ? "rot" : ""}`} />
                  </button>
                  {open && (
                    <div className="discover-card-body">
                      <div className="discover-items">
                        {group.families.map((family) => (
                          <CatalogRow
                            key={family.key}
                            family={family}
                            session={s}
                            reach={reach}
                            onChanged={data.reload}
                          />
                        ))}
                      </div>
                    </div>
                  )}
                </section>
              );
            })}
          </div>
        )}
      </Panel>
    </>
  );
}

function CatalogRow({
  family,
  session: s,
  reach,
  onChanged,
}: {
  family: Family;
  session: Session;
  reach: ReadonlyMap<string, Reach>;
  onChanged: () => void;
}) {
  const [selected, setSelected] = useState(family.versions[0]!.apiVersion);
  const [deleting, setDeleting] = useState(false);
  const [transferring, setTransferring] = useState(false);
  const version = family.versions.find((row) => row.apiVersion === selected) ?? family.versions[0]!;
  const description = version.description?.trim();
  const owner = { application: s.applicationName(family.applicationId) };
  const canDelete = permit("delete", version.capabilities, owner);
  // Handing the API away is an edit of the whole family, so it follows `update` rather than
  // `delete` — a member who may change it may also decide it is somebody else's to change.
  const canTransfer = permit("edit", version.capabilities, owner);
  const editorSection = family.kind === "mcp" ? "mcp" : family.kind === "a2a" ? "a2a" : "apis";
  const ours = family.applicationId === s.application;
  const via = ours ? undefined : reach.get(version.id);

  /**
   * Where the name and the chevrons lead.
   *
   * The workspace for a row this application owns, on the environment the chevron names. The
   * catalogue's read-only listing for one it merely subscribes to — the editor would open, because
   * you may read everything, and then refuse every control on it.
   */
  function open(environment?: string) {
    if (environment) s.setEnvironment(environment);
    go(ours ? `/${family.applicationId}/${editorSection}/${version.id}` : `/catalog/${version.id}`);
  }
  const href = ours ? `/${family.applicationId}/${editorSection}/${version.id}` : `/catalog/${version.id}`;

  return (
    // Management actions stay discoverable on touch as well as with a mouse; deletion still
    // requires the typed confirmation (workspace-api-catalog, deletion requirement).
    <div className={`discover-item workspace-row ${toneClassOf(family.kind)}`} data-ours={ours ? "" : undefined}>
      <div className="di-meta">
        <div className="di-title">
          <Link className="di-name" to={href}>
            {family.name}
          </Link>
          <KindBadge kind={family.kind} />
          {/* Whose it is, said once and only when it is not obvious. Every row used to belong to
              the selected application, so naming the owner would have been noise on all of them;
              now half of them can be somebody else's and the reader has to be able to tell. */}
          {via && (
            <span
              className="di-tag"
              title={`Published by ${s.applicationName(family.applicationId)}. ${
                s.applicationName(s.application)
              } calls it through ${via.products.join(", ")} in ${[...via.environments]
                .map((environment) => environment.toUpperCase())
                .join(", ")}.`}
            >
              subscribed
            </span>
          )}
        </div>
        <div className="s">
          <span className="di-path">
            {family.domain
              ? `${family.domain}${family.subdomain ? ` / ${family.subdomain}` : ""}`
              : "no domain yet"}
          </span>
          {via && <span className="di-path">by {s.applicationName(family.applicationId)}</span>}
          <StatusChip chip={lifecycleChip(version.lifecycle as Lifecycle)} />
          {version.environments.size === 0 && <span className="di-tag">not published</span>}
        </div>
        <div className="discover-description" data-empty={description ? undefined : ""}>
          {description ? (
            <DescriptionMarkdown source={clampSentences(description, 2)} />
          ) : (
            <em>No description written.</em>
          )}
        </div>
      </div>
      <VersionEnvPicker
        selectedVersion={selected}
        versions={family.versions.map((row) => row.apiVersion)}
        chain={s.meta.chain}
        availableEnvironments={version.environments}
        hideVersion={family.kind === "mcp" || family.kind === "a2a"}
        onSelectVersion={setSelected}
        onSelectEnvironment={(environment) => open(environment)}
        // No owner's actions on somebody else's API. Disabled-with-a-reason is what the rest of
        // the portal does when a control is yours-but-not-now; these are never yours, and two
        // permanently dead buttons on every subscribed row is furniture, not an explanation.
        trailing={
          !ours ? null : (
          <>
            <button
              className="icon-btn workspace-row-change-owner"
              aria-label={`Change who owns ${family.name}`}
              title={
                canTransfer.enabled
                  ? `Hand ${family.name} to another application`
                  : (canTransfer.reason ?? undefined)
              }
              disabled={!canTransfer.enabled}
              onClick={() => setTransferring(true)}
            >
              <I.Users size={14} />
            </button>
            <button
              className="icon-btn danger workspace-row-delete"
              aria-label={`Delete ${family.name} ${version.apiVersion}`}
              title={
                canDelete.enabled
                  ? `Delete ${family.name} ${version.apiVersion}`
                  : (canDelete.reason ?? undefined)
              }
              disabled={!canDelete.enabled}
              onClick={() => setDeleting(true)}
            >
              <I.Trash size={14} />
            </button>
          </>
          )
        }
      />
      {transferring && (
        <ChangeOwnerDialog
          session={s}
          family={family}
          version={version}
          permission={canTransfer}
          close={() => setTransferring(false)}
          onMoved={() => {
            setTransferring(false);
            onChanged();
          }}
        />
      )}
      {deleting && (
        <DeleteVersionDialog
          family={family}
          version={version}
          permission={canDelete}
          close={() => setDeleting(false)}
          onDeleted={() => {
            setDeleting(false);
            onChanged();
          }}
        />
      )}
    </div>
  );
}

/**
 * Deleting one version, with its name typed back.
 *
 * The sentence says what stops working and *when* — at each gateway's next poll, not instantly —
 * because a publisher who believes the deletion is immediate will not go and warn their consumers.
 * One version, never the family: the picker chose which contract this is about.
 */
function DeleteVersionDialog({
  family,
  version,
  permission,
  close,
  onDeleted,
}: {
  family: Family;
  version: Version;
  permission: Permission;
  close: () => void;
  onDeleted: () => void;
}) {
  const w = useAction();
  const live = [...version.environments].map((environment) => environment.toUpperCase());
  return (
    <Modal title={`Delete ${family.name} ${version.apiVersion}?`} close={close}>
      <DangerZone
        what={`Delete ${family.name} ${version.apiVersion}`}
        name={family.name}
        consequence={
          live.length === 0
            ? "This version is not live anywhere, so no call stops working — but its definition, its policies and its history go with it."
            : `It is live on ${live.join(", ")}. Calls to it start failing at each gateway's next poll, and every subscription that reaches it through a product stops working.`
        }
        permission={permission}
        busy={w.busy}
        error={w.error}
        onConfirm={() =>
          void w.run(async () => {
            await api.del(`/api/resources/${version.id}`);
            onDeleted();
          })
        }
      />
      <div className="native-actions">
        <button className="btn" onClick={close}>
          Keep it
        </button>
      </div>
    </Modal>
  );
}

interface TransferResult {
  transferred: Array<{ id: string; apiVersion: string }>;
  /** Products that sold nothing but this API, and so followed it with their subscriptions. */
  productsMoved: Array<{ id: string; name: string }>;
}

/**
 * Handing the API to another application.
 *
 * The whole family moves, so the dialog names every version rather than the one the picker
 * happens to be showing — a publisher who thinks they are moving `v2` and moves `v1` too has been
 * misled by the control. It also says the two things people are surprised by afterwards: the
 * address does not change, and their own edit rights go with it.
 */
function ChangeOwnerDialog({
  session: s,
  family,
  version,
  permission,
  close,
  onMoved,
}: {
  session: Session;
  family: Family;
  version: Version;
  permission: Permission;
  close: () => void;
  onMoved: () => void;
}) {
  // Only the applications the caller may act as. Handing an API to a team that has not agreed to
  // it is the whole failure mode, and the control plane refuses it too — this just means the list
  // never offers a choice that will be rejected.
  const candidates = s.applications.filter(
    (application) =>
      application.id !== family.applicationId &&
      (s.user.isAdmin || s.user.applications.includes(application.id)),
  );
  const [target, setTarget] = useState(candidates[0]?.id ?? "");
  const [reason, setReason] = useState("");
  const [result, setResult] = useState<TransferResult | null>(null);
  const w = useAction();
  const keepsAccess = s.user.isAdmin || s.user.applications.includes(target);

  return (
    <Modal title={`Change who owns ${family.name}`} close={close}>
      {result ? (
        <>
          <p>
            {family.name} now belongs to <strong>{s.applicationName(target)}</strong>.
          </p>
          {result.productsMoved.length > 0 && (
            <p className="muted small">
              {result.productsMoved.map((product) => product.name).join(", ")} went with it, because
              {result.productsMoved.length === 1 ? " that product sells" : " those products sell"}{" "}
              nothing else. Existing subscriptions are untouched — the consumers keep their keys, and{" "}
              {s.applicationName(target)} now handles the approvals.
            </p>
          )}
          <div className="native-actions">
            <button className="btn" onClick={onMoved}>
              Done
            </button>
          </div>
        </>
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void w.run(async () => {
              // `command` rather than `api.post`: it carries the ETag the control plane requires
              // and an idempotency key, so a double-submitted transfer is one transfer.
              setResult(
                await command<TransferResult>(
                  `/api/resources/${version.id}/owner`,
                  { applicationId: target, reason: reason || undefined },
                  version.etag,
                ),
              );
            });
          }}
        >
          <p>
            All {family.versions.length}{" "}
            {family.versions.length === 1 ? "version" : "versions"} move together —{" "}
            {family.versions.map((row) => row.apiVersion).join(", ")}. The published address does not
            change, because it is built from the domain rather than from the owner, so nothing a
            consumer calls stops working.
          </p>
          <p className="muted small">
            A product that sells only this API moves with it and keeps its subscriptions. A product
            that also sells something else stops the transfer instead, and says so — that one is a
            decision for the two applications rather than for this dialog.
          </p>
          <Notice kind="error">{w.error}</Notice>
          {/* Not an empty state: nothing is missing, the reader simply has no second application
              to hand this to. The sentence says who does, which is the only useful next move. */}
          {candidates.length === 0 ? (
            <Notice kind="warn">
              You are only a member of {s.applicationName(family.applicationId)}, so there is nowhere
              to hand this to. An administrator can transfer it, or add you to the receiving
              application.
            </Notice>
          ) : (
            <>
              <Field label="New owner">
                <select
                  required
                  value={target}
                  onChange={(event) => setTarget(event.target.value)}
                >
                  {candidates.map((application) => (
                    <option key={application.id} value={application.id}>
                      {application.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Why (recorded in the audit log)">
                <textarea
                  maxLength={500}
                  value={reason}
                  placeholder="Team reorganisation, service handover, …"
                  onChange={(event) => setReason(event.target.value)}
                />
              </Field>
              {!keepsAccess && (
                <p className="muted small">
                  You are not a member of {s.applicationName(target)}, so once this lands you will
                  no longer be able to edit {family.name}.
                </p>
              )}
            </>
          )}
          <div className="native-actions">
            <button type="button" className="btn" onClick={close}>
              Cancel
            </button>
            <button
              className="btn primary"
              disabled={w.busy || !target || !permission.enabled}
              title={permission.reason ?? undefined}
            >
              Hand it over
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}
