/**
 * The Kafka workspace's decisions (kafka-workspace, kafka-playground), apart from the markup so
 * they are tested rather than read out of JSX: how topic rows become list rows, what a grant list
 * splits into, what the stage button does, which certificate proves a principal, and the
 * playground's request history.
 */

import { dnMatches } from "../../../shared/kafka";

export interface TopicRow {
  id: string;
  name: string;
  environment: string;
  state: string;
  applicationId: string;
  applicationName: string;
  canEdit: boolean;
  displayName: string;
  version: string | null;
  family: string;
  partitions: number;
  replication: number;
  retentionDays: number | null;
  minInsyncReplicas: number | null;
  schemaType: string | null;
  schemaDefinition: string | null;
  schemaVersion: number;
  compatibility: string | null;
  subject: string;
  description: string;
  wikiLink: string | null;
  domain: string | null;
  subdomain: string | null;
  certificateId: string | null;
  consumers: number;
  apiResourceId: string | null;
  apiPublished: boolean;
  apiBlockers: string[];
}

export interface GrantRow {
  id: string;
  topicId: string;
  topicName: string;
  topicDisplayName: string | null;
  environment: string;
  applicationId: string;
  applicationName: string | null;
  publisher: string;
  principal: string | null;
  authType: string | null;
  operation: string;
  groupId: string | null;
  requestId: string;
  state: string;
  purpose: string;
  createdAt: string;
}

/** Access that is live or on its way — what a list of "who may use this" shows. */
export const LIVE_GRANT = ["pending", "activating", "active", "revoking"];

/** One version of a topic, across the stages it is in. */
export interface TopicVersion {
  version: string;
  name: string;
  /** Stage → that stage's row, for the stages it exists in (deleted rows left out). */
  rows: Map<string, TopicRow>;
}

/** One list row: a topic family — every version of one topic under one owner. */
export interface TopicListRow {
  key: string;
  applicationId: string;
  applicationName: string;
  displayName: string;
  /** Latest first. */
  versions: TopicVersion[];
}

function versionNumber(version: string): number {
  return Number(/\d+/.exec(version)?.[0] ?? 0);
}

/**
 * Topic rows into list rows: one per family per owner, its versions newest first, each version's
 * stages keyed by environment. A name written before the convention has no version and is its own
 * family, shown as `—` in the picker.
 */
export function topicListRows(items: readonly TopicRow[]): TopicListRow[] {
  const families = new Map<string, TopicListRow>();
  for (const row of items) {
    if (row.state === "deleted") continue;
    const key = `${row.applicationId}/${row.family}`;
    const family =
      families.get(key) ??
      families
        .set(key, { key, applicationId: row.applicationId, applicationName: row.applicationName, displayName: row.displayName, versions: [] })
        .get(key)!;
    const label = row.version ?? "—";
    let version = family.versions.find((v) => v.version === label);
    if (!version) {
      version = { version: label, name: row.name, rows: new Map() };
      family.versions.push(version);
    }
    version.rows.set(row.environment, row);
  }
  for (const family of families.values()) {
    family.versions.sort((a, b) => versionNumber(b.version) - versionNumber(a.version));
    // The newest version names the row: a display name edited in v2 is the one people now use.
    const newest = family.versions[0]!;
    family.displayName = [...newest.rows.values()][0]?.displayName ?? family.displayName;
  }
  return [...families.values()].sort((a, b) => a.displayName.localeCompare(b.displayName));
}

/** The stage a version's row opens on: the one the reader is looking at when it is there, else the furthest. */
export function openingStage(version: TopicVersion, chain: readonly string[], current: string): string {
  if (version.rows.has(current)) return current;
  return [...chain].reverse().find((environment) => version.rows.has(environment)) ?? chain[0]!;
}

/**
 * Which families an application sees on each side of the list: the ones it publishes, and the ones
 * it holds a live grant on without owning them. A subscribed row carries only the versions it holds
 * a grant on — a consumer of v1 opened on v2 saw a version it cannot read and a Test in Playground
 * that led to no grant.
 */
export function splitPublishedSubscribed(
  rows: readonly TopicListRow[],
  grants: readonly GrantRow[],
  application: string,
): { published: TopicListRow[]; subscribed: TopicListRow[] } {
  const held = new Set(
    grants.filter((g) => g.applicationId === application && LIVE_GRANT.includes(g.state)).map((g) => g.topicId),
  );
  const subscribed: TopicListRow[] = [];
  for (const row of rows) {
    if (row.applicationId === application) continue;
    const versions = row.versions.filter((version) => [...version.rows.values()].some((topic) => held.has(topic.id)));
    if (versions.length) subscribed.push({ ...row, versions });
  }
  return { published: rows.filter((row) => row.applicationId === application), subscribed };
}

/** Case-insensitive, over what a reader would type: the title, the name, the owner, the domain. */
export function matchesSearch(row: TopicListRow, term: string): boolean {
  const needle = term.trim().toLowerCase();
  if (!needle) return true;
  const topics = row.versions.flatMap((version) => [...version.rows.values()]);
  return [row.displayName, row.applicationName, ...topics.flatMap((t) => [t.name, t.domain ?? "", t.subdomain ?? ""])]
    .join(" ")
    .toLowerCase()
    .includes(needle);
}

/**
 * A grant list in the three sections the Subscriptions tab draws: READ (with its group), WRITE, and
 * the DESCRIBE and DELETE grants that ride along with them. Live grants only.
 */
export function grantSections(grants: readonly GrantRow[]): { read: GrantRow[]; write: GrantRow[]; other: GrantRow[] } {
  const live = grants.filter((g) => LIVE_GRANT.includes(g.state));
  return {
    read: live.filter((g) => g.operation === "read"),
    write: live.filter((g) => g.operation === "write"),
    other: live.filter((g) => g.operation === "describe" || g.operation === "delete"),
  };
}

/**
 * What "Stage to …" does on a topic in one stage, or why it cannot: the next stage along the chain,
 * refused while the topic is still being created here and once the next stage already has it.
 */
export function stageAction(
  topic: Pick<TopicRow, "state" | "canEdit" | "environment">,
  chain: readonly string[],
  present: ReadonlySet<string>,
): { next: string | null; reason: string | null } {
  const next = chain[chain.indexOf(topic.environment) + 1] ?? null;
  if (!next) return { next: null, reason: null };
  if (present.has(next)) return { next, reason: "Already there — switch to it to stage it further." };
  if (!topic.canEdit) return { next, reason: "Only the topic's owner can stage it." };
  if (topic.state !== "ready") return { next, reason: "The topic is still being created here." };
  return { next, reason: null };
}

/** The certificates that prove an mTLS principal: the application's own, here, unexpired, with that subject. */
export function certificatesFor<T extends { subject: string; applicationId: string; expired: boolean }>(
  certificates: readonly T[],
  application: string,
  principal: string,
): T[] {
  return certificates.filter((c) => c.applicationId === application && !c.expired && dnMatches(c.subject, principal));
}

// ------------------------------------------------------------------------------ request history

/**
 * One playground request, as the history keeps it. What was asked and what came back — never a
 * credential: an mTLS test names its certificate by name, and an OAuth one sends nothing secret.
 */
export interface HistoryEntry {
  id: string;
  at: string;
  topic: string;
  environment: string;
  action: "produce" | "consume";
  principal: string | null;
  operation: string;
  request: Record<string, unknown>;
  ok: boolean;
  summary: string;
  response: unknown;
}

export const HISTORY_LIMIT = 25;

export function historyKey(topic: string, environment: string): string {
  return `kafka-playground:${environment}:${topic}`;
}

export function readHistory(storage: Pick<Storage, "getItem">, key: string): HistoryEntry[] {
  try {
    const parsed = JSON.parse(storage.getItem(key) ?? "[]");
    return Array.isArray(parsed) ? parsed.slice(0, HISTORY_LIMIT) : [];
  } catch {
    return [];
  }
}

/** Newest first, capped, and forgiving of a full or unavailable store: history is a convenience. */
export function appendHistory(
  storage: Pick<Storage, "getItem" | "setItem">,
  key: string,
  entry: HistoryEntry,
): HistoryEntry[] {
  const next = [entry, ...readHistory(storage, key)].slice(0, HISTORY_LIMIT);
  try {
    storage.setItem(key, JSON.stringify(next));
  } catch {
    // A full store keeps the history on screen for this visit; nothing else depends on it.
  }
  return next;
}
