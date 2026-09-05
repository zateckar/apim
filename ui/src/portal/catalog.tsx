import { useMemo, useState } from "react";
import type { Session } from "../App";
import { api } from "../api";
import { go, useAsync, DangerZone } from "../components";
import { permit, type Permission } from "../lib/capabilities";
import { DOMAINS } from "../../../shared/domains";
import { command, listAll } from "./client";
import { Empty, ErrorNotice, Field, Modal, Panel, useWork } from "./common";
import * as I from "./icons";
import { KindBadge, legendOf, toneClassOf, type Kind } from "./components/KindBadge";
import { VersionEnvPicker } from "./components/VersionEnvPicker";
import { DescriptionMarkdown } from "./components/DescriptionMarkdown";
import { SubscribeDialog } from "./processes";

/**
 * The catalog, and the per-application API list — one surface with two settings.
 *
 * They are the same list at two scopes, so they are one component: the estate-wide **Catalog**
 * every developer browses, and **My APIs**, which is that list narrowed to the selected
 * application. Keeping them apart produced two rows that drifted, and a publisher who could not
 * tell what a consumer saw.
 *
 * Three decisions shape it.
 *
 *  - **Grouped by domain, not by application.** People look for an API by what it does. The
 *    publishing team is incidental, and it is already on the row.
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
const KIND_FILTERS: Kind[] = ["rest", "soap", "mcp", "a2a"];

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
  /** `discover` is the whole estate; `apis`, `mcp` and `a2a` narrow to the selected application. */
  section: string;
  tick: number;
}) {
  const everything = section === "discover";
  const [search, setSearch] = useState("");
  const [kinds, setKinds] = useState<ReadonlySet<Kind>>(new Set());
  const [application, setApplication] = useState("");
  const [domain, setDomain] = useState("");
  const [folded, setFolded] = useState<ReadonlySet<string>>(new Set());
  const [listing, setListing] = useState<{ family: Family; version: Version } | null>(null);
  const [subscribe, setSubscribe] = useState<string | null>(null);

  const data = useAsync(() => listAll<ResourceRow>("/api/resources"), [tick]);

  function clearFilters() {
    setSearch("");
    setKinds(new Set());
    setApplication("");
    setDomain("");
  }

  const families = useMemo(() => {
    // `apis` means REST and SOAP, not "everything": MCP servers and A2A agents have their own
    // sidebar entries, and listing them here too put the same API under two headings.
    const rows = (data.data?.items ?? []).filter((row) => {
      if (!everything && row.applicationId !== s.application) return false;
      if (section === "mcp") return row.kind === "mcp";
      if (section === "a2a") return row.kind === "a2a";
      if (section === "apis") return row.kind === "rest" || row.kind === "soap";
      return true;
    });
    return toFamilies(rows);
  }, [data.data, section, s.application, everything]);

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    return families.filter((family) => {
      if (kinds.size > 0 && !kinds.has(family.kind)) return false;
      if (application && family.applicationId !== application) return false;
      if (domain && (family.domain ?? OTHER) !== domain) return false;
      if (!term) return true;
      const haystack = [
        family.name,
        s.applicationName(family.applicationId),
        family.domain ?? "",
        family.subdomain ?? "",
        ...family.versions.map((version) => `${version.apiVersion} ${version.description ?? ""}`),
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(term);
    });
  }, [families, search, kinds, application, domain, s]);

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

  const filtering = Boolean(search.trim() || kinds.size || application || domain);
  const applications = useMemo(
    () => [...new Set(families.map((family) => family.applicationId))].sort(),
    [families],
  );
  const title = everything
    ? "Catalog"
    : section === "mcp"
      ? "MCP servers"
      : section === "a2a"
        ? "A2A agents"
        : "Published APIs";

  return (
    <>
      <Panel
        title={title}
        actions={
          <div className="search">
            <input
              aria-label="Search the catalog"
              placeholder="Search by name, application, domain or description…"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </div>
        }
      >
        <ErrorNotice error={data.error} />

        {everything && (
          <div className="discover-filters">
            {KIND_FILTERS.map((kind) => {
              const on = kinds.has(kind);
              return (
                <button
                  key={kind}
                  className={`chip ${on ? "accent" : ""}`}
                  aria-pressed={on}
                  onClick={() => {
                    // An empty set means every kind; selecting chips narrows to their union, which
                    // is what "filter" means to somebody who has just clicked one.
                    const next = new Set(kinds);
                    if (on) next.delete(kind);
                    else next.add(kind);
                    setKinds(next);
                  }}
                >
                  {kind.toUpperCase()}
                </button>
              );
            })}
            <label className="sr-only" htmlFor="catalog-application">
              Application
            </label>
            <select
              id="catalog-application"
              value={application}
              onChange={(event) => setApplication(event.target.value)}
            >
              <option value="">All applications</option>
              {applications.map((id) => (
                <option key={id} value={id}>
                  {s.applicationName(id)}
                </option>
              ))}
            </select>
            <label className="sr-only" htmlFor="catalog-domain">
              Domain
            </label>
            <select
              id="catalog-domain"
              value={domain}
              onChange={(event) => setDomain(event.target.value)}
            >
              <option value="">All domains</option>
              {[...DOMAINS.map((entry) => entry.name), OTHER].map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
            {filtering && (
              <button className="btn ghost sm" onClick={clearFilters}>
                Clear filters
              </button>
            )}
          </div>
        )}

        {data.loading && !data.data ? (
          <Empty>Loading the catalog…</Empty>
        ) : groups.length === 0 ? (
          <Empty>
            {filtering ? (
              <>
                Nothing matches those filters.{" "}
                <button className="btn sm" onClick={clearFilters}>
                  Clear them
                </button>
              </>
            ) : everything ? (
              <>
                Nothing has been published to this estate yet.{" "}
                <button className="btn sm" onClick={() => go(`/${s.application}/publish`)}>
                  Publish the first API
                </button>
              </>
            ) : (
              <>
                {s.applicationName(s.application)} has published nothing here yet.{" "}
                <button className="btn sm" onClick={() => go(`/${s.application}/publish`)}>
                  Publish an API
                </button>
              </>
            )}
          </Empty>
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
                      <span className="s">
                        {group.families.length} {group.families.length === 1 ? "API" : "APIs"}
                      </span>
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
                            everything={everything}
                            onOpenListing={(version) => setListing({ family, version })}
                            onSubscribe={(version) => setSubscribe(version.id)}
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

      {listing && (
        <ListingDialog
          session={s}
          family={listing.family}
          version={listing.version}
          close={() => setListing(null)}
          onSubscribe={() => {
            setSubscribe(listing.version.id);
            setListing(null);
          }}
        />
      )}
      {subscribe && (
        <SubscribeDialog session={s} resourceId={subscribe} close={() => setSubscribe(null)} />
      )}
    </>
  );
}

function CatalogRow({
  family,
  session: s,
  everything,
  onOpenListing,
  onSubscribe,
  onChanged,
}: {
  family: Family;
  session: Session;
  everything: boolean;
  onOpenListing: (version: Version) => void;
  onSubscribe: (version: Version) => void;
  onChanged: () => void;
}) {
  const [selected, setSelected] = useState(family.versions[0]!.apiVersion);
  const [deleting, setDeleting] = useState(false);
  const [transferring, setTransferring] = useState(false);
  const version = family.versions.find((row) => row.apiVersion === selected) ?? family.versions[0]!;
  const mine = family.applicationId === s.application;
  const description = version.description?.trim();
  const owner = { application: s.applicationName(family.applicationId) };
  const canDelete = permit("delete", version.capabilities, owner);
  // Handing the API away is an edit of the whole family, so it follows `update` rather than
  // `delete` — a member who may change it may also decide it is somebody else's to change.
  const canTransfer = permit("edit", version.capabilities, owner);
  const editorSection = family.kind === "mcp" ? "mcp" : family.kind === "a2a" ? "a2a" : "apis";

  /**
   * Where the name and the chevrons lead. A publisher looking at their own API wants the editor; a
   * consumer browsing the catalog wants the listing, which is the read-only view of the same thing.
   * A chevron additionally says *which environment* the editor should open on.
   */
  function open(environment?: string) {
    if (everything && !mine) {
      onOpenListing(version);
      return;
    }
    if (environment) s.setEnvironment(environment);
    go(`/${family.applicationId}/${editorSection}/${version.id}`);
  }

  return (
    // `workspace-row` is what keeps Delete and Change owner hidden until the row is hovered or
    // focused: they are the two actions nobody is looking for while browsing, and the two that
    // must never be a stray click away.
    <div className={`discover-item workspace-row ${toneClassOf(family.kind)}`}>
      <span className="di-type-legend">{legendOf(family.kind)}</span>
      <span className="di-owner-legend">Owner · {s.applicationName(family.applicationId)}</span>
      <div className="di-meta">
        <div className="di-title">
          <button className="di-name" onClick={() => open()}>
            {family.name}
          </button>
          <KindBadge kind={family.kind} />
        </div>
        <div className="s">
          <span className="di-path">
            {family.domain
              ? `${family.domain}${family.subdomain ? ` / ${family.subdomain}` : ""}`
              : "no domain yet"}
          </span>
          {version.lifecycle !== "active" && <span className="di-tag">{version.lifecycle}</span>}
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
        trailing={
          everything && !mine ? (
            <button
              className="btn sm"
              title={`Request access to ${family.name}`}
              onClick={() => onSubscribe(version)}
            >
              <I.Key size={13} /> Subscribe
            </button>
          ) : (
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
  const w = useWork();
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
  const w = useWork();
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
          <ErrorNotice error={w.error} />
          {candidates.length === 0 ? (
            <Empty>
              You are only a member of {s.applicationName(family.applicationId)}, so there is nowhere
              to hand this to. An administrator can transfer it, or add you to the receiving
              application.
            </Empty>
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

interface Listing {
  description: string | null;
  docsUrl: string | null;
  operations: Array<{
    id: string;
    name?: string;
    method?: string;
    path?: string;
    summary?: string | null;
  }>;
  endpoints: Array<{ environment: string; live: boolean; basePath: string; urls: string[] }>;
  example: string | null;
  products: Array<{ id: string; name: string; lifecycle: string }>;
  subscriberCount: number;
  subscribed: boolean;
}

/**
 * What a consumer sees before subscribing: what it does, what it offers, and where to call it. No
 * control on it changes anything except the one that asks for access.
 */
function ListingDialog({
  session: s,
  family,
  version,
  close,
  onSubscribe,
}: {
  session: Session;
  family: Family;
  version: Version;
  close: () => void;
  onSubscribe: () => void;
}) {
  const [tab, setTab] = useState("overview");
  const listing = useAsync(
    () => api.get<Listing>(`/api/catalog/${encodeURIComponent(version.id)}`),
    [version.id],
  );
  const detail = listing.data;
  const description = detail?.description ?? version.description;

  return (
    <Modal title={`${family.name} ${version.apiVersion}`} close={close}>
      <p className="muted small">
        {s.applicationName(family.applicationId)} ·{" "}
        {family.domain
          ? `${family.domain}${family.subdomain ? ` / ${family.subdomain}` : ""}`
          : "no domain"}
      </p>
      <div className="tabs">
        {["overview", "operations", "endpoints"].map((name) => (
          <button
            key={name}
            className={`tab ${tab === name ? "active" : ""}`}
            onClick={() => setTab(name)}
          >
            {name}
          </button>
        ))}
      </div>
      <ErrorNotice error={listing.error} />
      {!detail ? (
        <Empty>Loading the listing…</Empty>
      ) : tab === "overview" ? (
        <>
          {description ? (
            <DescriptionMarkdown source={description} />
          ) : (
            <p className="muted">
              <em>The publisher has not written a description.</em>
            </p>
          )}
          <div className="kv-list compact">
            <div className="kv">
              <span className="k">Live in</span>
              <span className="v">
                {[...version.environments].map((environment) => environment.toUpperCase()).join(", ") ||
                  "nowhere yet"}
              </span>
            </div>
            <div className="kv">
              <span className="k">Sold through</span>
              {/* Named rather than counted, because "no product yet" is the whole reason a
                  Subscribe button can be pressed and answer with nothing to subscribe to. */}
              <span className="v">
                {detail.products.length
                  ? detail.products.map((product) => product.name).join(", ")
                  : "no product yet — nobody can subscribe"}
              </span>
            </div>
            <div className="kv">
              <span className="k">Consumers</span>
              <span className="v">
                {detail.subscriberCount}
                {detail.subscribed ? " · you already have access" : ""}
              </span>
            </div>
            {detail.docsUrl && (
              <div className="kv">
                <span className="k">Documentation</span>
                <span className="v">
                  <a href={detail.docsUrl} target="_blank" rel="noopener noreferrer">
                    {detail.docsUrl}
                  </a>
                </span>
              </div>
            )}
          </div>
        </>
      ) : tab === "operations" ? (
        detail.operations.length === 0 ? (
          <Empty>The stored contract declares nothing callable.</Empty>
        ) : (
          <div className="native-list">
            {detail.operations.map((operation) => (
              <div className="native-row" key={operation.id}>
                <div>
                  <strong>
                    {operation.method ? `${operation.method} ` : ""}
                    {operation.path ?? operation.name ?? operation.id}
                  </strong>
                  <small>{operation.summary ?? operation.name ?? ""}</small>
                </div>
              </div>
            ))}
          </div>
        )
      ) : detail.endpoints.length === 0 ? (
        <Empty>No route has been created for this API yet, so there is no address to call.</Empty>
      ) : (
        <>
          <div className="native-list">
            {detail.endpoints.map((endpoint) => (
              <div className="native-row" key={endpoint.environment}>
                <div>
                  <strong>{endpoint.environment.toUpperCase()}</strong>
                  {/* Every address it answers at, not a base path: with an internet name and an
                      intranet name for the same gateway there is no single right guess. */}
                  <small className="mono">
                    {endpoint.urls.length ? endpoint.urls.join("  ·  ") : endpoint.basePath}
                  </small>
                </div>
                <span className={`chip ${endpoint.live ? "ok" : "neutral"}`}>
                  {endpoint.live ? "live" : "not live"}
                </span>
              </div>
            ))}
          </div>
          {detail.example && <pre className="mono">{detail.example}</pre>}
        </>
      )}
      <div className="native-actions">
        <button className="btn" onClick={close}>
          Close
        </button>
        <button className="btn accent-soft" onClick={onSubscribe}>
          <I.Key size={13} /> Request access
        </button>
      </div>
    </Modal>
  );
}
