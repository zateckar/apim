import { Fragment, useEffect, useId, useMemo, useState } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { json as jsonLanguage } from "@codemirror/lang-json";
import { EditorView } from "@codemirror/view";
import type { Session } from "../App";
import { api } from "../api";
import {
  CopyButton,
  DangerZone,
  EmptyState,
  Field,
  Link,
  Modal,
  Notice,
  PageActions,
  Panel,
  Segmented,
  Skeleton,
  StatusChip,
  envLabel,
  go,
  useAction,
  useAsync,
  useLeaveGuard,
  usePageTitle,
} from "../components";
import { ALLOWED } from "../lib/capabilities";
import { kafkaGrantChip, kafkaTopicChip, topicApiChip } from "../lib/status";
import {
  grantSections,
  matchesSearch,
  openingStage,
  splitPublishedSubscribed,
  stageAction,
  topicListRows,
  type GrantRow,
  type TopicListRow,
  type TopicRow,
} from "../lib/kafka";
import {
  BLANK_SCHEMAS,
  TOPIC_COMPATIBILITIES,
  TOPIC_LIMITS,
  TOPIC_OPERATIONS,
  TOPIC_SIZES,
  buildTopicName,
  displayNameError,
  principalError,
  prettySchema,
  schemaCheck,
  versionError,
  wikiLinkError,
  type TopicSize,
} from "../../../shared/kafka";
import { DomainPicker } from "./apis";
import { command } from "./client";
import * as I from "./icons";
import { KafkaTopicBadge } from "./components/KindBadge";
import { VersionEnvPicker } from "./components/VersionEnvPicker";
import { MarkdownEditor } from "./components/MarkdownEditor";
import { DescriptionMarkdown } from "./components/DescriptionMarkdown";
import { KafkaPlayground } from "./kafka-playground";

/**
 * Kafka Topics (kafka-workspace): the list, the create wizard, and one topic's page.
 *
 * The shape is the predecessor portal's, which is what people who produce to these topics already
 * know: one row per topic with its versions and the stages each is in; a three-step wizard whose
 * first step is the schema, because a topic is its schema; and a topic page with the schema and
 * size, who may read and write it, and a playground to try it as one of those grants.
 *
 * The stages are Kafka's — `meta.kafkaChain`, TEST and PROD — not the API chain: there is no DEV
 * cluster. One thing differs on purpose: the stage a topic page shows is the shell's switcher, so a
 * topic and an API move between stages with the same control, and DEV is disabled there.
 */

const SCHEMA_TYPES = [
  { value: "json", label: "JSON" },
  { value: "avro", label: "AVRO" },
  { value: "protobuf", label: "PROTOBUF" },
] as const;

const AUTH_LABEL: Record<string, string> = { mtls: "mTLS", oauth: "OAuth" };

function topicAddress(application: string, name: string, tab?: string): string {
  return `/${application}/kafka/${encodeURIComponent(name)}${tab ? `/${tab}` : ""}`;
}

function sizing(t: Pick<TopicRow, "partitions" | "replication" | "consumers">): string {
  const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;
  return `${plural(t.partitions, "partition")} · ${plural(t.replication, "replica")} · ${plural(t.consumers, "consumer")}`;
}

function domainOf(t: { domain: string | null; subdomain: string | null }): string {
  return t.domain ? `${t.domain}${t.subdomain ? ` / ${t.subdomain}` : ""}` : "no domain";
}

// ------------------------------------------------------------------------------------ the list

export function KafkaTopics({ session: s, tick }: { session: Session; tick: number }) {
  const topics = useAsync(() => api.get<{ items: TopicRow[] }>("/api/kafka/topics"), [tick]);
  const access = useAsync(() => api.get<{ items: GrantRow[] }>("/api/kafka/access"), [tick]);
  const [side, setSide] = useState<"published" | "subscribed">("published");
  const [search, setSearch] = useState("");
  const [subscribing, setSubscribing] = useState(false);
  const rows = useMemo(() => topicListRows(topics.data?.items ?? []), [topics.data]);
  const { published, subscribed } = useMemo(
    () => splitPublishedSubscribed(rows, access.data?.items ?? [], s.application),
    [rows, access.data, s.application],
  );
  const shown = (side === "published" ? published : subscribed).filter((row) => matchesSearch(row, search));
  const reload = () => {
    topics.reload();
    access.reload();
  };

  return (
    <>
      <PageActions>
        <button type="button" className="btn" onClick={reload} disabled={topics.loading}>
          <I.Refresh /> Refresh
        </button>
        <button type="button" className="btn" onClick={() => setSubscribing(true)}>
          Subscribe to Topic
        </button>
        <Link className="btn primary" to={`/${s.application}/kafka/new`}>
          <I.Plus /> Create Topic
        </Link>
      </PageActions>
      <Panel
        className="kafka-topic-list"
        flush
        actions={
          <>
            <div className="catalog-search">
              <span aria-hidden="true"><I.Search /></span>
              <input
                aria-label="Search topics"
                type="search"
                placeholder="Search topic or owner…"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </div>
            <Segmented
              label="Which topics to show"
              value={side}
              onChange={setSide}
              options={[
                { value: "published", label: `Published ${published.length}` },
                { value: "subscribed", label: `Subscribed ${subscribed.length}` },
              ]}
            />
          </>
        }
      >
        <Notice kind="error">{topics.error ?? access.error}</Notice>
        {!topics.data || !access.data ? (
          topics.error || access.error ? null : <Skeleton rows={4} />
        ) : shown.length === 0 ? (
          search.trim() ? (
            <EmptyState
              title={`No topic matches “${search.trim()}”`}
              detail="The search covers titles, topic names, owners and domains."
              action={<button type="button" className="btn sm" onClick={() => setSearch("")}>Clear the search</button>}
            />
          ) : side === "published" ? (
            <EmptyState
              title={`${s.applicationName(s.application)} publishes no topics yet`}
              detail={`A topic is created in ${envLabel(s.meta.kafkaChain[0])} with its schema, then staged to ${envLabel(s.meta.kafkaChain.at(-1))} from its page.`}
              action={<Link className="btn sm" to={`/${s.application}/kafka/new`}>Create a topic</Link>}
            />
          ) : (
            <EmptyState
              title={`${s.applicationName(s.application)} consumes no other application's topics`}
              detail="Access is asked for per principal — a certificate's DN or an OAuth client id — and the topic's owner approves it."
              action={<button type="button" className="btn sm" onClick={() => setSubscribing(true)}>Subscribe to a topic</button>}
            />
          )
        ) : (
          <table className="tbl kafka-topic-table">
            <thead>
              <tr>
                <th>Topic</th>
                <th className="kafka-topic-where">
                  <span className="sr-only">Version and stages</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {shown.map((row) => (
                <TopicListEntry key={row.key} row={row} session={s} subscribed={side === "subscribed"} onChanged={reload} />
              ))}
            </tbody>
          </table>
        )}
      </Panel>
      {subscribing && (
        <SubscribeDialog
          session={s}
          topics={topics.data?.items ?? []}
          close={() => setSubscribing(false)}
          onDone={reload}
        />
      )}
    </>
  );
}

function TopicListEntry({
  row,
  session: s,
  subscribed,
  onChanged,
}: {
  row: TopicListRow;
  session: Session;
  subscribed: boolean;
  onChanged: () => void;
}) {
  const [selected, setSelected] = useState(row.versions[0]!.version);
  const [deleting, setDeleting] = useState(false);
  const version = row.versions.find((v) => v.version === selected) ?? row.versions[0]!;
  const stage = openingStage(version, s.meta.kafkaChain, s.environment);
  const topic = version.rows.get(stage)!;
  const open = (environment: string, tab?: string) => {
    s.setEnvironment(environment);
    go(topicAddress(s.application, version.name, tab));
  };
  return (
    <tr className="workspace-row">
      <td>
        <div className="api-name-cell">
          <KafkaTopicBadge schemaType={topic.schemaType} />
          <div className="kafka-topic-name">
            <Link className="di-name" to={topicAddress(s.application, version.name)}>
              {row.displayName}
            </Link>
            <span className="mono small">{version.name}</span>
            <span className="muted small">
              {sizing(topic)}
              {subscribed && ` · by ${row.applicationName}`}
            </span>
          </div>
          {/* Only when it is news: a ready topic is the normal case. */}
          {topic.state !== "ready" && <StatusChip chip={kafkaTopicChip(topic.state as "provisioning")} />}
        </div>
      </td>
      <td className="kafka-topic-where">
        <VersionEnvPicker
          selectedVersion={selected}
          versions={row.versions.map((v) => v.version)}
          chain={s.meta.kafkaChain}
          availableEnvironments={new Set(version.rows.keys())}
          onSelectVersion={setSelected}
          onSelectEnvironment={(environment) => open(environment)}
          trailing={
            subscribed ? (
              <button type="button" className="btn sm kafka-row-playground" onClick={() => open(stage, "playground")}>
                <I.Play size={14} /> Test in Playground
              </button>
            ) : topic.canEdit ? (
              <button
                type="button"
                className="icon-btn danger workspace-row-delete"
                aria-label={`Delete ${version.name} in ${envLabel(stage)}`}
                title={`Delete ${version.name} in ${envLabel(stage)}`}
                onClick={() => setDeleting(true)}
              >
                <I.Trash size={14} />
              </button>
            ) : null
          }
        />
        {deleting && (
          <DeleteTopicDialog
            topic={topic}
            close={() => setDeleting(false)}
            onDeleted={() => {
              setDeleting(false);
              onChanged();
            }}
          />
        )}
      </td>
    </tr>
  );
}

/**
 * Deleting a topic in one stage, with its name typed back. One stage, the one the row is showing:
 * a topic in PROD that consumers read from is not deleted by somebody tidying up DEV.
 */
function DeleteTopicDialog({ topic, close, onDeleted }: { topic: TopicRow; close: () => void; onDeleted: () => void }) {
  const w = useAction();
  return (
    <Modal title={`Delete ${topic.name} in ${envLabel(topic.environment)}?`} close={close}>
      <DangerZone
        open
        what={`Delete in ${envLabel(topic.environment)}`}
        name={topic.name}
        consequence={`The topic and its messages in ${envLabel(topic.environment)} go with it, and the name is not reused there. Every grant on it has to be revoked first, and an HTTP API retired.`}
        permission={topic.canEdit ? ALLOWED : { enabled: false, reason: "Only the topic's owner can delete it." }}
        busy={w.busy}
        error={w.error}
        onConfirm={() =>
          void w.run(async () => {
            await api.del(`/api/kafka/topics/${topic.id}`);
            onDeleted();
          })
        }
      />
      <div className="native-actions">
        <button type="button" className="btn" onClick={close}>Cancel</button>
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------------------- asking for access

/**
 * Ask for access to a topic, for one principal (kafka-workspace, "Access is granted to a principal,
 * one operation at a time"). The operations are checked together and decided together; READ gets a
 * consumer group of its own, which the Subscriptions tab shows once the broker has it.
 */
function SubscribeDialog({
  session: s,
  topics,
  preset,
  close,
  onDone,
}: {
  session: Session;
  topics: readonly TopicRow[];
  preset?: TopicRow;
  close: () => void;
  onDone: () => void;
}) {
  const ready = topics.filter((t) => t.state === "ready");
  const names = [...new Set(ready.map((t) => t.name))].sort();
  const [search, setSearch] = useState("");
  const [name, setName] = useState(preset?.name ?? "");
  const stages = s.meta.kafkaChain.filter((environment) => ready.some((t) => t.name === name && t.environment === environment));
  const [environment, setEnvironment] = useState(preset?.environment ?? s.environment);
  const target = ready.find((t) => t.name === name && t.environment === environment) ?? null;
  const [authType, setAuthType] = useState<"mtls" | "oauth">("mtls");
  const [principal, setPrincipal] = useState("");
  const [operations, setOperations] = useState<string[]>(["read"]);
  const [purpose, setPurpose] = useState("");
  const [result, setResult] = useState<{ state: string; owner: string } | null>(null);
  const w = useAction();
  const certificates = useAsync(
    () =>
      stages.includes(environment)
        ? api.get<{ items: Array<{ id: string; name: string; subject: string; applicationId: string; expired: boolean }> }>(
            `/api/certificates?environment=${encodeURIComponent(environment)}`,
          )
        : Promise.resolve({ items: [] }),
    [environment, stages.includes(environment)],
  );
  const subjects = (certificates.data?.items ?? []).filter((c) => c.applicationId === s.application && !c.expired);
  const listId = useId();
  useEffect(() => {
    // A topic chosen in a stage it is not in moves to one it is in, rather than leaving a dead select.
    if (name && !stages.includes(environment) && stages.length) setEnvironment(stages.includes(s.environment) ? s.environment : stages[0]!);
  }, [name, stages.join(",")]);

  const problem = !target
    ? "Choose a topic and a stage it is in."
    : principalError(authType, principal) ??
      (operations.length === 0
        ? "Choose at least one operation."
        : purpose.trim().length < 3 || purpose.trim().length > 500
          ? "A purpose of 3–500 characters: what this principal will do with the topic."
          : null);

  if (result)
    return (
      <Modal title="Access requested" close={close}>
        <p>
          <StatusChip chip={kafkaGrantChip(result.state as "pending")} />{" "}
          {result.state === "pending"
            ? `Sent to ${result.owner} for approval. Their decision appears on the topic's Subscriptions tab and in Mail.`
            : "Your own topic, so no approval is needed. The simulated broker applies it within seconds."}
        </p>
        <div className="native-actions">
          <button type="button" className="btn primary" onClick={close}>Done</button>
        </div>
      </Modal>
    );

  return (
    <Modal title={preset ? `New subscription to ${preset.displayName}` : "Subscribe to a topic"} close={close}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (problem || !target) return;
          void w.run(async () => {
            const response = await api.post<{ state: string }>(`/api/kafka/topics/${target.id}/subscribe`, {
              applicationId: s.application,
              purpose: purpose.trim(),
              authType,
              principal: principal.trim(),
              operations,
            });
            setResult({ state: response.state, owner: target.applicationName });
            onDone();
          });
        }}
      >
        <p className="muted">For {s.applicationName(s.application)}.</p>
        {!preset && (
          <>
            <Field label="Find a topic">
              <input type="search" value={search} placeholder="Name, title or owner…" onChange={(e) => setSearch(e.target.value)} />
            </Field>
            <Field label="Topic">
              <select required value={name} onChange={(e) => setName(e.target.value)}>
                <option value="">— Select a topic —</option>
                {names
                  .filter((n) => {
                    const t = ready.find((r) => r.name === n)!;
                    return `${n} ${t.displayName} ${t.applicationName}`.toLowerCase().includes(search.trim().toLowerCase());
                  })
                  .map((n) => {
                    const t = ready.find((r) => r.name === n)!;
                    return (
                      <option key={n} value={n}>
                        {t.displayName} — {n} ({t.applicationName})
                      </option>
                    );
                  })}
              </select>
            </Field>
          </>
        )}
        <Field label="Stage" hint="Access is granted per stage, like a subscription's keys.">
          <select value={environment} onChange={(e) => setEnvironment(e.target.value)} disabled={stages.length === 0}>
            {s.meta.kafkaChain.map((stage) => (
              <option key={stage} value={stage} disabled={!stages.includes(stage)}>
                {envLabel(stage)}{stages.includes(stage) ? "" : " — the topic is not here"}
              </option>
            ))}
          </select>
        </Field>
        <div className="native-field">
          <span className="lbl">Authentication</span>
          <Segmented
            label="Authentication"
            value={authType}
            onChange={setAuthType}
            options={[
              { value: "mtls", label: "mTLS" },
              { value: "oauth", label: "OAuth" },
            ]}
          />
        </div>
        <Field
          label={authType === "mtls" ? "Principal — the client certificate's DN" : "Principal — the OAuth client id"}
          hint={
            authType === "mtls"
              ? `What the broker binds the ACL to. ${subjects.length ? "Your certificates in this stage are offered." : "Upload the certificate on Credentials to be offered its DN."}`
              : "The client id your identity provider issued to the consuming service."
          }
        >
          <input
            className="mono"
            required
            list={authType === "mtls" ? listId : undefined}
            value={principal}
            placeholder={authType === "mtls" ? "CN=ABC123X,O=SKODA AUTO a.s.,C=CZ" : "orders-consumer"}
            onChange={(e) => setPrincipal(e.target.value)}
          />
        </Field>
        <datalist id={listId}>
          {subjects.map((c) => (
            <option key={c.id} value={c.subject}>{c.name}</option>
          ))}
        </datalist>
        <Notice kind="warn">{certificates.error && `Certificates could not be read: ${certificates.error}`}</Notice>
        <fieldset className="choice-field">
          <legend>Operations</legend>
          <div className="choice-options">
            {TOPIC_OPERATIONS.map((operation) => (
              <label key={operation} className={operations.includes(operation) ? "choice-option selected" : "choice-option"}>
                <input
                  type="checkbox"
                  checked={operations.includes(operation)}
                  onChange={(e) =>
                    setOperations(e.target.checked ? [...operations, operation] : operations.filter((op) => op !== operation))
                  }
                />
                <span>{operation.toUpperCase()}</span>
              </label>
            ))}
          </div>
          <p className="hint">READ consumes through a consumer group of its own; WRITE produces. DESCRIBE and DELETE are what tooling asks for.</p>
        </fieldset>
        <Field label="Purpose" hint="3–500 characters. The topic's owner reads this when deciding.">
          <textarea required minLength={3} maxLength={500} value={purpose} onChange={(e) => setPurpose(e.target.value)} />
        </Field>
        <Notice kind="error">{w.error}</Notice>
        {problem && <p className="muted">Still needed: {problem}</p>}
        <div className="native-actions">
          <button type="button" className="btn" onClick={close}>Cancel</button>
          <button className="btn primary" disabled={w.busy || Boolean(problem)}>
            {target && target.applicationId === s.application ? "Grant access" : "Request access"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// ------------------------------------------------------------------------------- the wizard

const CREATE_STEPS = ["Schema", "Topic", "Review"] as const;

/** The schema editor's language: JSON for JSON and Avro (an Avro schema is JSON), none for Protobuf. */
function languageFor(type: string) {
  return type === "protobuf" ? [EditorView.lineWrapping] : [jsonLanguage(), EditorView.lineWrapping];
}

function SchemaCheckChip({ type, text, topic }: { type: string; text: string; topic: string }) {
  if (!text.trim()) return null;
  const check = schemaCheck(type, text, topic || "topic");
  return (
    <span className={`chip ${check.level === "ok" ? "ok" : check.level === "warn" ? "warn" : "err"}`} role="status">
      {check.level === "ok" ? <I.Check size={12} /> : <I.Alert size={12} />} {check.message}
    </span>
  );
}

/**
 * The create wizard (kafka-workspace, "A topic is created by a wizard"): the schema first, then the
 * name — built by the convention from the domain, the application, a display name and a version —
 * and the size, then a review of exactly what will be created. Created in Kafka's first stage, TEST.
 */
export function KafkaCreate({ session: s }: { session: Session }) {
  const first = s.meta.kafkaChain[0]!;
  const [step, setStep] = useState(0);
  const [schemaType, setSchemaType] = useState<"json" | "avro" | "protobuf">("json");
  const [compatibility, setCompatibility] = useState("");
  const [definition, setDefinition] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [version, setVersion] = useState("v1");
  const [taxonomy, setTaxonomy] = useState({ domain: "", subdomain: "" });
  const [size, setSize] = useState<TopicSize | "custom">("S");
  const [custom, setCustom] = useState({ partitions: 8, replication: 2, retentionDays: 1 });
  const [description, setDescription] = useState("");
  const [wikiLink, setWikiLink] = useState("");
  const [created, setCreated] = useState<string | null>(null);
  const w = useAction();
  const existing = useAsync(() => api.get<{ items: TopicRow[] }>("/api/kafka/topics"), []);
  const name = buildTopicName({
    domain: taxonomy.domain,
    subdomain: taxonomy.subdomain,
    application: s.applicationName(s.application),
    displayName,
    version,
  });
  const numbers = size === "custom" ? custom : TOPIC_SIZES[size];
  const check = schemaCheck(schemaType, definition, name || "topic");
  const taken = name ? existing.data?.items.find((t) => t.name === name) : undefined;
  const started = Boolean(definition.trim() || displayName.trim() || taxonomy.domain || description.trim());
  useLeaveGuard(started && created === null, "the topic you were creating");
  useEffect(() => {
    if (created === null) return;
    s.setEnvironment(first);
    go(topicAddress(s.application, created));
  }, [created]);

  function missing(at: number): string | null {
    if (at === 0) {
      if (!definition.trim()) return "A schema — paste one, upload a file, or start from the blank template.";
      if (check.level === "error") return check.message;
      return null;
    }
    if (at === 1) {
      const nameProblem = displayNameError(displayName) ?? versionError(version);
      if (nameProblem) return nameProblem;
      if (!taxonomy.domain) return "A domain. It is the first segment of the topic's name.";
      if (!name) return "A name — the display name needs at least one letter or digit.";
      if (existing.loading) return "Checking existing names…";
      if (existing.error) return "Reload the existing names before continuing.";
      if (taken)
        return taken.state === "deleted"
          ? `${name} was deleted; a name is not reused. Choose another version.`
          : `${name} already exists. Open it, or choose another version.`;
      for (const [field, value] of Object.entries(numbers) as Array<[keyof typeof TOPIC_LIMITS, number]>) {
        const { min, max } = TOPIC_LIMITS[field];
        if (!Number.isInteger(value) || value < min || value > max) return `${field}: ${min}–${max}`;
      }
      const wiki = wikiLinkError(wikiLink);
      if (wiki) return wiki;
      return null;
    }
    return null;
  }
  const reachable = CREATE_STEPS.findIndex((_, at) => missing(at) !== null);
  const furthest = reachable === -1 ? CREATE_STEPS.length - 1 : reachable;
  const at = Math.min(step, furthest);
  const last = CREATE_STEPS.length - 1;
  const blocked = missing(at);

  return (
    <Panel title={`Create a Kafka topic in ${envLabel(first)}`} className="publish-flow kafka-create">
      <div className="stepper">
        {CREATE_STEPS.map((label, index) => (
          <Fragment key={label}>
            {index > 0 && <span className="sep" />}
            <button
              type="button"
              className={`step ${index === at ? "active" : index < at ? "done" : ""}`}
              aria-current={index === at ? "step" : undefined}
              disabled={index > furthest}
              onClick={() => setStep(index)}
            >
              <span className="n">{index + 1}</span>
              {label}
            </button>
          </Fragment>
        ))}
      </div>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (blocked || w.busy) return;
          if (at !== last) return setStep(at + 1);
          void w.run(async () => {
            const response = await api.post<{ name: string }>("/api/kafka/topics", {
              applicationId: s.application,
              displayName: displayName.trim(),
              version,
              domain: taxonomy.domain,
              subdomain: taxonomy.subdomain || null,
              ...(size === "custom" ? custom : { size }),
              schemaType,
              schemaDefinition: definition,
              compatibility: compatibility || null,
              description,
              wikiLink: wikiLink.trim() || null,
            });
            setCreated(response.name);
          });
        }}
      >
        <Notice kind="error">{w.error}</Notice>

        {at === 0 && (
          <div className="split-cols">
            <div>
              <div className="native-form-grid">
                <Field label="Type">
                  <select
                    value={schemaType}
                    onChange={(e) => {
                      const next = e.target.value as typeof schemaType;
                      // Untouched template → the new type's template; written text is the author's.
                      if (!definition.trim() || definition === BLANK_SCHEMAS[schemaType]) setDefinition(BLANK_SCHEMAS[next]);
                      setSchemaType(next);
                    }}
                  >
                    {SCHEMA_TYPES.map((t) => (
                      <option key={t.value} value={t.value}>{t.label}</option>
                    ))}
                  </select>
                </Field>
                <Field label="Compatibility" hint="How the registry holds a new version to the ones before it.">
                  <select value={compatibility} onChange={(e) => setCompatibility(e.target.value)}>
                    <option value="">(default)</option>
                    {TOPIC_COMPATIBILITIES.map((c) => (
                      <option key={c} value={c}>{c}</option>
                    ))}
                  </select>
                </Field>
              </div>
              <Field label="Upload a schema file">
                <input
                  type="file"
                  accept={schemaType === "protobuf" ? ".proto,.txt" : ".json,.avsc,.txt"}
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) void w.run(async () => setDefinition(prettySchema(schemaType, await file.text())));
                  }}
                />
              </Field>
              <div className="kafka-schema-head">
                <span className="lbl">Or paste the definition</span>
                <SchemaCheckChip type={schemaType} text={definition} topic={name} />
              </div>
              <CodeMirror
                aria-label="Schema definition"
                value={definition}
                extensions={languageFor(schemaType)}
                minHeight="320px"
                maxHeight="560px"
                onChange={setDefinition}
              />
            </div>
            <aside className="kafka-side-card">
              <Panel title="Start from scratch">
                <p className="muted small">A valid, empty {schemaType.toUpperCase()} definition to fill in.</p>
                <div className="native-actions">
                  <button type="button" className="btn sm" onClick={() => setDefinition(BLANK_SCHEMAS[schemaType])}>
                    Blank {schemaType.toUpperCase()} template
                  </button>
                  <button type="button" className="btn sm ghost" onClick={() => setDefinition("")} disabled={!definition}>
                    Clear
                  </button>
                </div>
              </Panel>
            </aside>
          </div>
        )}

        {at === 1 && (
          <>
            <div className="native-form-grid">
              <Field label="Display name" hint="What people call it. The topic's name is built from it.">
                <input required value={displayName} maxLength={80} placeholder="Order created" onChange={(e) => setDisplayName(e.target.value)} />
              </Field>
              <Field label="Version" hint="v1 for a new topic; a new version is a new topic beside the old one.">
                <input required value={version} maxLength={4} onChange={(e) => setVersion(e.target.value)} />
              </Field>
            </div>
            <DomainPicker domain={taxonomy.domain} subdomain={taxonomy.subdomain} onChange={setTaxonomy} />
            <Field label="Topic name" hint="domain _ sub-domain _ application _ name _ version. Fixed once created.">
              <code className="kafka-built-name">{name || "…"}</code>
            </Field>
            <div className="native-field">
              <span className="lbl">Size</span>
              <Segmented
                label="Size"
                value={size}
                onChange={setSize}
                options={[
                  ...(Object.keys(TOPIC_SIZES) as TopicSize[]).map((key) => ({
                    value: key,
                    label: `${key} · ${TOPIC_SIZES[key].partitions} partitions`,
                  })),
                  { value: "custom" as const, label: "Custom" },
                ]}
              />
            </div>
            <div className="native-form-grid">
              {(["partitions", "replication", "retentionDays"] as const).map((field) => (
                <Field
                  key={field}
                  label={field === "retentionDays" ? "Retention (days)" : field === "replication" ? "Replication" : "Partitions"}
                  hint={
                    field === "partitions"
                      ? "Can only be increased later."
                      : field === "replication"
                        ? "Fixed once created."
                        : `${TOPIC_LIMITS.retentionDays.min}–${TOPIC_LIMITS.retentionDays.max} days.`
                  }
                >
                  <input
                    type="number"
                    min={TOPIC_LIMITS[field].min}
                    max={TOPIC_LIMITS[field].max}
                    disabled={size !== "custom"}
                    value={numbers[field]}
                    onChange={(e) => setCustom({ ...custom, [field]: Number(e.target.value) })}
                  />
                </Field>
              ))}
            </div>
            {/* Not a `Field`: the editor's toolbar is buttons, and a label around it clicks the first. */}
            <div className="native-field">
              <span className="lbl">Description</span>
              <MarkdownEditor value={description} onChange={setDescription} rows={5} ariaLabel="Description" />
            </div>
            <Field label="Wiki link" hint="Optional: the page a consumer opens for the rest of the story.">
              <input type="url" value={wikiLink} placeholder="https://wiki.example/…" onChange={(e) => setWikiLink(e.target.value)} />
            </Field>
          </>
        )}

        {at === 2 && (
          <div className="kv-list">
            <div className="kv"><span className="k">Name</span><span className="v mono">{name}</span></div>
            <div className="kv"><span className="k">Display name</span><span className="v">{displayName.trim()}</span></div>
            <div className="kv"><span className="k">Owner</span><span className="v">{s.applicationName(s.application)}</span></div>
            <div className="kv"><span className="k">Domain</span><span className="v">{domainOf({ domain: taxonomy.domain, subdomain: taxonomy.subdomain || null })}</span></div>
            <div className="kv"><span className="k">Stage</span><span className="v">{envLabel(first)}</span></div>
            <div className="kv"><span className="k">Size</span><span className="v">{numbers.partitions} partitions · {numbers.replication} replicas · {numbers.retentionDays} days retention</span></div>
            <div className="kv"><span className="k">Schema</span><span className="v">{schemaType.toUpperCase()} · {compatibility || "registry default"} · subject <span className="mono">{name}-value</span> v1</span></div>
            {wikiLink.trim() && <div className="kv"><span className="k">Wiki</span><span className="v">{wikiLink.trim()}</span></div>}
          </div>
        )}

        {blocked && <p className="muted">Still needed: {blocked}</p>}
        {check.level === "warn" && at === 0 && <p className="hint">{check.message}</p>}
        <div className="native-actions">
          {at > 0 ? (
            <button type="button" className="btn" onClick={() => setStep(at - 1)}>Back</button>
          ) : (
            <Link className="btn" to={`/${s.application}/kafka`}>Back to Topics</Link>
          )}
          {at < last ? (
            <button type="submit" className="btn primary" disabled={Boolean(blocked)}>
              Next: {CREATE_STEPS[at + 1]}
            </button>
          ) : (
            <button type="submit" className="btn primary" disabled={w.busy || Boolean(blocked)}>
              {w.busy ? "Creating…" : `Create in ${envLabel(first)}`}
            </button>
          )}
        </div>
      </form>
    </Panel>
  );
}

// ------------------------------------------------------------------------------ one topic

const TOPIC_TABS = ["schema", "subscriptions", "playground"] as const;
type TopicTab = (typeof TOPIC_TABS)[number];
const TOPIC_TAB_LABEL: Record<TopicTab, string> = {
  schema: "Schema & Properties",
  subscriptions: "Subscriptions",
  playground: "Playground",
};

export function KafkaTopic({
  name,
  tab: asked,
  session: s,
  tick,
}: {
  name: string;
  tab?: string;
  session: Session;
  tick: number;
}) {
  const topics = useAsync(() => api.get<{ items: TopicRow[] }>("/api/kafka/topics"), [tick]);
  const access = useAsync(() => api.get<{ items: GrantRow[] }>("/api/kafka/access"), [tick]);
  const [tab, setTab] = useState<TopicTab>(TOPIC_TABS.includes(asked as TopicTab) ? (asked as TopicTab) : "schema");
  const [dialog, setDialog] = useState<"stage" | "proxy" | null>(null);
  const tabId = useId();
  const all = topics.data?.items ?? [];
  const rows = all.filter((t) => t.name === name && t.state !== "deleted");
  const topic = rows.find((t) => t.environment === s.environment) ?? null;
  usePageTitle(topic?.displayName ?? rows[0]?.displayName ?? name);
  const reload = () => {
    topics.reload();
    access.reload();
  };

  if (topics.error) return <Notice kind="error">{topics.error}</Notice>;
  if (!topics.data) return <Skeleton rows={6} />;
  if (rows.length === 0)
    return (
      <Panel>
        <EmptyState
          title={`There is no topic called ${name}`}
          detail="It may have been deleted, or the address is incomplete."
          action={<Link className="btn primary" to={`/${s.application}/kafka`}>Back to Kafka Topics</Link>}
        />
      </Panel>
    );
  if (!topic) {
    const here = s.meta.kafkaChain.filter((environment) => rows.some((t) => t.environment === environment));
    const clustered = s.meta.kafkaChain.includes(s.environment);
    return (
      <Panel>
        <EmptyState
          title={clustered ? `Not in ${envLabel(s.environment)}` : `Kafka has no ${envLabel(s.environment)}`}
          detail={
            clustered
              ? `${name} is in ${here.map(envLabel).join(", ")}. A topic reaches a stage by being staged from the one before it.`
              : `Topics live in ${s.meta.kafkaChain.map(envLabel).join(" and ")}; ${name} is in ${here.map(envLabel).join(", ")}.`
          }
          action={<button type="button" className="btn primary" onClick={() => s.setEnvironment(here.at(-1)!)}>Open in {envLabel(here.at(-1))}</button>}
        />
      </Panel>
    );
  }

  const present = new Set(rows.map((t) => t.environment));
  const stage = stageAction(topic, s.meta.kafkaChain, present);
  const siblings = [...new Set(all.filter((t) => t.family === topic.family && t.applicationId === topic.applicationId && t.state !== "deleted").map((t) => t.name))];
  const grants = (access.data?.items ?? []).filter((g) => g.topicId === topic.id);

  return (
    <div className="api-workspace kafka-workspace">
      <div className="workspace-head">
        <div className="workspace-identity">
          <p className="workspace-summary">
            {topic.applicationName} · <KafkaTopicBadge schemaType={topic.schemaType} /> · {domainOf(topic)}{" "}
            <StatusChip chip={topic.state === "ready" ? { label: "Published", tone: "live", title: `ready in ${envLabel(topic.environment)}` } : kafkaTopicChip(topic.state as "provisioning")} />
          </p>
          <div className="copy-row workspace-url">
            <code>{topic.name}</code>
            <CopyButton value={topic.name} what="the topic name" />
          </div>
        </div>
        <div className="native-actions">
          {siblings.length > 1 ? (
            <label className="workspace-version">
              <span className="lbl">Ver</span>
              <select aria-label="Version" value={topic.name} onChange={(e) => go(topicAddress(s.application, e.target.value))}>
                {siblings.map((sibling) => (
                  <option key={sibling} value={sibling}>{all.find((t) => t.name === sibling)?.version ?? sibling}</option>
                ))}
              </select>
            </label>
          ) : (
            <span className="chip" title="The version is part of the topic's name">Ver {topic.version ?? "—"}</span>
          )}
          {topic.wikiLink && (
            <a className="btn" href={topic.wikiLink} target="_blank" rel="noopener noreferrer">Open wiki ↗</a>
          )}
          {topic.canEdit && topic.schemaType === "json" && (
            <button type="button" className="btn" onClick={() => setDialog("proxy")}>
              {topic.apiPublished ? "HTTP Proxy" : "Create HTTP Proxy"}
            </button>
          )}
          {stage.next && topic.canEdit && (
            <span className="action">
              <button type="button" className="btn primary" disabled={Boolean(stage.reason)} title={stage.reason ?? undefined} onClick={() => setDialog("stage")}>
                Stage to {envLabel(stage.next)}
              </button>
              {stage.reason && <span className="action-reason">{stage.reason}</span>}
            </span>
          )}
        </div>
      </div>
      <Notice kind="error">{access.error}</Notice>
      {!topic.canEdit && (
        <Notice kind="info">
          {topic.applicationName} owns this topic. You can read everything here, ask for access on Subscriptions and try your grants in the Playground.
        </Notice>
      )}
      <div className="workspace-tabs" role="tablist" aria-label="Topic panels">
        {TOPIC_TABS.map((t, index) => (
          <button
            key={t}
            type="button"
            role="tab"
            id={`${tabId}-${t}`}
            className={tab === t ? "active" : ""}
            aria-selected={tab === t}
            aria-controls={`${tabId}-panel`}
            tabIndex={tab === t ? 0 : -1}
            onClick={() => setTab(t)}
            onKeyDown={(event) => {
              const target = event.key === "ArrowRight" ? (index + 1) % TOPIC_TABS.length
                : event.key === "ArrowLeft" ? (index + TOPIC_TABS.length - 1) % TOPIC_TABS.length
                : null;
              if (target === null) return;
              event.preventDefault();
              setTab(TOPIC_TABS[target]!);
              (event.currentTarget.parentElement?.children[target] as HTMLElement)?.focus();
            }}
          >
            {TOPIC_TAB_LABEL[t]}
          </button>
        ))}
      </div>
      <div role="tabpanel" className="workspace-panel" id={`${tabId}-panel`} aria-labelledby={`${tabId}-${tab}`} tabIndex={0}>
        {tab === "schema" && <SchemaTab key={`${topic.id}:${topic.schemaVersion}`} topic={topic} onSaved={reload} />}
        {tab === "subscriptions" && (
          <SubscriptionsTab topic={topic} grants={grants} session={s} topics={all} onChanged={reload} />
        )}
        {tab === "playground" && <KafkaPlayground topic={topic} grants={grants} session={s} />}
      </div>
      {dialog === "stage" && stage.next && (
        <StageDialog topic={topic} next={stage.next} session={s} close={() => setDialog(null)} onStaged={reload} />
      )}
      {dialog === "proxy" && <HttpProxyDialog topic={topic} session={s} close={() => setDialog(null)} onChanged={reload} />}
    </div>
  );
}

// ------------------------------------------------------------------------ schema & properties

function SchemaTab({ topic, onSaved }: { topic: TopicRow; onSaved: () => void }) {
  return (
    <div className="split-cols kafka-schema-tab">
      <div>
        <SchemaCard topic={topic} onSaved={onSaved} />
        <DetailsCard topic={topic} onSaved={onSaved} />
      </div>
      <PropertiesCard topic={topic} onSaved={onSaved} />
    </div>
  );
}

function SchemaCard({ topic, onSaved }: { topic: TopicRow; onSaved: () => void }) {
  const stored = {
    type: topic.schemaType ?? "json",
    compatibility: topic.compatibility ?? "",
    definition: topic.schemaDefinition ?? "",
  };
  const [type, setType] = useState(stored.type);
  const [compatibility, setCompatibility] = useState(stored.compatibility);
  const [definition, setDefinition] = useState(stored.definition);
  const [note, setNote] = useState<string | null>(null);
  const w = useAction();
  const dirty = type !== stored.type || compatibility !== stored.compatibility || definition !== stored.definition;
  useLeaveGuard(dirty, `the schema of ${topic.name} in ${envLabel(topic.environment)}`);
  const check = schemaCheck(type, definition, topic.name);
  const definitionChanged = type !== stored.type || definition !== stored.definition;
  const refusal =
    !topic.canEdit
      ? null
      : definitionChanged && check.level === "error"
        ? check.message
        : topic.apiPublished && type !== "json"
          ? "This topic has an HTTP API here, which needs a JSON schema. Retire the API first."
          : null;
  return (
    <Panel
      title="Schema"
      actions={<span className="chip">{topic.schemaVersion ? `Version ${topic.schemaVersion}` : "No version yet"}</span>}
    >
      <div className="native-form-grid">
        <Field label="Type">
          <select value={type} disabled={!topic.canEdit} onChange={(e) => setType(e.target.value)}>
            {SCHEMA_TYPES.map((t) => (
              <option key={t.value} value={t.value}>{t.label}</option>
            ))}
          </select>
        </Field>
        <Field label="Compatibility">
          <select value={compatibility} disabled={!topic.canEdit} onChange={(e) => setCompatibility(e.target.value)}>
            <option value="">(default)</option>
            {TOPIC_COMPATIBILITIES.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        </Field>
      </div>
      <div className="kafka-schema-head">
        <span className="lbl">Definition</span>
        <SchemaCheckChip type={type} text={definition} topic={topic.name} />
      </div>
      <CodeMirror
        aria-label="Schema definition"
        value={definition}
        editable={topic.canEdit}
        extensions={languageFor(type)}
        minHeight="280px"
        maxHeight="560px"
        onChange={setDefinition}
      />
      {topic.apiPublished && definitionChanged && (
        <p className="hint">This topic has an HTTP API here; saving regenerates its definition, and the change reaches the gateways like any other.</p>
      )}
      {refusal && <p className="field-error">{refusal}</p>}
      <Notice kind="error">{w.error}</Notice>
      <Notice kind="ok">{note}</Notice>
      {topic.canEdit && (
        <div className="native-actions">
          <button
            type="button"
            className="btn primary"
            disabled={w.busy || !dirty || Boolean(refusal)}
            onClick={() =>
              void w.run(async () => {
                const saved = await api.patch<{ schemaVersion: number; operation: unknown }>(`/api/kafka/topics/${topic.id}`, {
                  schemaType: type,
                  ...(definitionChanged ? { schemaDefinition: definition } : {}),
                  compatibility: compatibility || null,
                });
                setNote(
                  saved.operation
                    ? `Saved as version ${saved.schemaVersion}. The topic's HTTP API is being regenerated; Activity shows it reaching the gateways.`
                    : `Saved as version ${saved.schemaVersion}.`,
                );
                onSaved();
              })
            }
          >
            <I.Save /> Save
          </button>
          <span className="muted small">
            Saving registers a new schema version for subject <span className="mono">{topic.subject}</span>.
          </span>
        </div>
      )}
    </Panel>
  );
}

function PropertiesCard({ topic, onSaved }: { topic: TopicRow; onSaved: () => void }) {
  const stored = {
    partitions: topic.partitions,
    retentionDays: topic.retentionDays === null ? "" : String(topic.retentionDays),
    minInsync: topic.minInsyncReplicas === null ? "" : String(topic.minInsyncReplicas),
  };
  const [partitions, setPartitions] = useState(stored.partitions);
  const [retentionDays, setRetentionDays] = useState(stored.retentionDays);
  const [minInsync, setMinInsync] = useState(stored.minInsync);
  const w = useAction();
  const dirty = partitions !== stored.partitions || retentionDays !== stored.retentionDays || minInsync !== stored.minInsync;
  useLeaveGuard(dirty, `the properties of ${topic.name} in ${envLabel(topic.environment)}`);
  const problem =
    !Number.isInteger(partitions) || partitions < topic.partitions || partitions > TOPIC_LIMITS.partitions.max
      ? `Partitions: ${topic.partitions}–${TOPIC_LIMITS.partitions.max}. A partition cannot be taken away.`
      : retentionDays && (Number(retentionDays) < 1 || Number(retentionDays) > TOPIC_LIMITS.retentionDays.max || !Number.isInteger(Number(retentionDays)))
        ? `Retention: 1–${TOPIC_LIMITS.retentionDays.max} days, or empty for the broker's default.`
        : minInsync && (Number(minInsync) < 1 || Number(minInsync) > topic.replication || !Number.isInteger(Number(minInsync)))
          ? `min.insync.replicas: 1–${topic.replication}, the replication factor — or empty for the broker's default.`
          : null;
  if (!topic.canEdit)
    return (
      <Panel title="Properties">
        <div className="kv-list">
          <div className="kv"><span className="k">Partitions</span><span className="v">{topic.partitions}</span></div>
          <div className="kv"><span className="k">Replication</span><span className="v">{topic.replication}</span></div>
          <div className="kv"><span className="k">Retention</span><span className="v">{topic.retentionDays === null ? "broker default" : `${topic.retentionDays} days`}</span></div>
          <div className="kv"><span className="k">min.insync.replicas</span><span className="v">{topic.minInsyncReplicas ?? "broker default"}</span></div>
          <div className="kv"><span className="k">Consumers</span><span className="v">{topic.consumers}</span></div>
        </div>
      </Panel>
    );
  return (
    <Panel title="Properties">
      <Field label="Partitions" hint="Can only be increased.">
        <input type="number" min={topic.partitions} max={TOPIC_LIMITS.partitions.max} value={partitions} onChange={(e) => setPartitions(Number(e.target.value))} />
      </Field>
      <Field label="Replication" hint="Fixed when the topic was created.">
        <input type="number" value={topic.replication} readOnly disabled />
      </Field>
      <Field label="Retention (days)" hint="Empty for the broker's default.">
        <input type="number" min={1} max={TOPIC_LIMITS.retentionDays.max} value={retentionDays} onChange={(e) => setRetentionDays(e.target.value)} />
      </Field>
      <Field label="min.insync.replicas" hint={`At most ${topic.replication}. Empty for the broker's default.`}>
        <input type="number" min={1} max={topic.replication} value={minInsync} onChange={(e) => setMinInsync(e.target.value)} />
      </Field>
      {problem && <p className="field-error">{problem}</p>}
      <Notice kind="error">{w.error}</Notice>
      <div className="native-actions">
        <button
          type="button"
          className="btn primary"
          disabled={w.busy || !dirty || Boolean(problem)}
          onClick={() =>
            void w.run(async () => {
              await api.patch(`/api/kafka/topics/${topic.id}`, {
                partitions,
                retentionDays: retentionDays ? Number(retentionDays) : null,
                minInsyncReplicas: minInsync ? Number(minInsync) : null,
              });
              onSaved();
            })
          }
        >
          <I.Save /> Save
        </button>
      </div>
    </Panel>
  );
}

function DetailsCard({ topic, onSaved }: { topic: TopicRow; onSaved: () => void }) {
  const [description, setDescription] = useState(topic.description ?? "");
  const [wikiLink, setWikiLink] = useState(topic.wikiLink ?? "");
  const w = useAction();
  const dirty = description !== (topic.description ?? "") || wikiLink !== (topic.wikiLink ?? "");
  useLeaveGuard(dirty, `the description of ${topic.name}`);
  const problem = wikiLinkError(wikiLink);
  if (!topic.canEdit)
    return (
      <Panel title="Details">
        {topic.description ? <DescriptionMarkdown source={topic.description} /> : <p className="muted">No description written.</p>}
        {topic.wikiLink && (
          <p>
            <a href={topic.wikiLink} target="_blank" rel="noopener noreferrer">{topic.wikiLink} ↗</a>
          </p>
        )}
      </Panel>
    );
  return (
    <Panel title="Details">
      <div className="native-field">
        <span className="lbl">Description</span>
        <MarkdownEditor value={description} onChange={setDescription} rows={6} ariaLabel="Description" />
      </div>
      <div className="native-field">
        <span className="lbl">Wiki link</span>
        <div className="copy-row">
          <input type="url" aria-label="Wiki link" value={wikiLink} placeholder="https://wiki.example/…" onChange={(e) => setWikiLink(e.target.value)} />
          {wikiLink && !problem && (
            <a className="btn sm" href={wikiLink} target="_blank" rel="noopener noreferrer">Open ↗</a>
          )}
        </div>
      </div>
      {problem && <p className="field-error">{problem}</p>}
      <Notice kind="error">{w.error}</Notice>
      <div className="native-actions">
        <button
          type="button"
          className="btn primary"
          disabled={w.busy || !dirty || Boolean(problem)}
          onClick={() =>
            void w.run(async () => {
              await api.patch(`/api/kafka/topics/${topic.id}`, { description, wikiLink: wikiLink.trim() || null });
              onSaved();
            })
          }
        >
          <I.Save /> Save
        </button>
      </div>
    </Panel>
  );
}

// ---------------------------------------------------------------------------- subscriptions

function SubscriptionsTab({
  topic,
  grants,
  topics,
  session: s,
  onChanged,
}: {
  topic: TopicRow;
  grants: GrantRow[];
  topics: TopicRow[];
  session: Session;
  onChanged: () => void;
}) {
  const [asking, setAsking] = useState(false);
  const [revoking, setRevoking] = useState<GrantRow | null>(null);
  const mine = grants.filter((g) => g.applicationId === s.application);
  const sections = grantSections(mine);
  const others = grantSections(grants.filter((g) => g.applicationId !== s.application));
  const count = sections.read.length + sections.write.length + sections.other.length;
  const connection = useAsync(
    () => api.get<{ bootstrap: string | null; variable: string; listeners: Array<{ authType: string; port: number; address: string | null }> }>(
      `/api/kafka/connection?environment=${encodeURIComponent(topic.environment)}`,
    ),
    [topic.environment],
  );

  const action = (g: GrantRow) =>
    ["pending", "activating", "active"].includes(g.state) ? (
      <button
        type="button"
        className="icon-btn danger"
        aria-label={g.state === "pending" ? `Cancel the request for ${g.principal ?? "this grant"}` : `Revoke ${g.operation.toUpperCase()} for ${g.principal ?? "this grant"}`}
        title={g.state === "pending" ? "Cancel the request" : "Revoke"}
        onClick={() => setRevoking(g)}
      >
        <I.Trash size={14} />
      </button>
    ) : null;
  const principalCell = (g: GrantRow) =>
    g.principal ? <span className="mono small">{g.principal}</span> : <span className="muted small">granted before principals — no principal recorded</span>;

  return (
    <>
      <Panel
        title={`${count} owned by ${s.applicationName(s.application)}`}
        hint={`Access in ${envLabel(topic.environment)}. Each operation is its own grant; a READ has its own consumer group.`}
        actions={
          <button type="button" className="btn sm primary" onClick={() => setAsking(true)} disabled={topic.state !== "ready"}>
            <I.Plus /> New subscription
          </button>
        }
        flush
      >
        <h4 className="kafka-grant-head">Read</h4>
        {sections.read.length ? (
          <table className="tbl">
            <thead><tr><th>Principal</th><th>Group ID</th><th>Auth</th><th>State</th><th /></tr></thead>
            <tbody>
              {sections.read.map((g) => (
                <tr key={g.id}>
                  <td>{principalCell(g)}</td>
                  <td>
                    {g.groupId ? (
                      <span className="copy-row"><code>{g.groupId}</code><CopyButton value={g.groupId} what="the consumer group" /></span>
                    ) : "—"}
                  </td>
                  <td>{AUTH_LABEL[g.authType ?? ""] ?? "—"}</td>
                  <td><StatusChip chip={kafkaGrantChip(g.state as "active")} /></td>
                  <td className="row-end">{action(g)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="muted kafka-grant-none">No READ grants here.</p>
        )}
        <h4 className="kafka-grant-head">Write</h4>
        {sections.write.length ? (
          <table className="tbl">
            <thead><tr><th>Principal</th><th>Auth</th><th>State</th><th /></tr></thead>
            <tbody>
              {sections.write.map((g) => (
                <tr key={g.id}>
                  <td>{principalCell(g)}</td>
                  <td>{AUTH_LABEL[g.authType ?? ""] ?? "—"}</td>
                  <td><StatusChip chip={kafkaGrantChip(g.state as "active")} /></td>
                  <td className="row-end">{action(g)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="muted kafka-grant-none">No WRITE grants here.</p>
        )}
        <h4 className="kafka-grant-head">Delete / Describe</h4>
        {sections.other.length ? (
          <table className="tbl">
            <thead><tr><th>Principal</th><th>Auth</th><th>Permissions</th><th>State</th><th /></tr></thead>
            <tbody>
              {sections.other.map((g) => (
                <tr key={g.id}>
                  <td>{principalCell(g)}</td>
                  <td>{AUTH_LABEL[g.authType ?? ""] ?? "—"}</td>
                  <td>{g.operation.toUpperCase()}</td>
                  <td><StatusChip chip={kafkaGrantChip(g.state as "active")} /></td>
                  <td className="row-end">{action(g)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="muted kafka-grant-none">No Delete / Describe grants — they are added with new Read and Write subscriptions.</p>
        )}
      </Panel>

      {/* Both sides of the relationship, for the owner: a topic cannot be deleted while anybody holds
          it, so the owner has to be able to find — and revoke — every grant, not only their own. */}
      {topic.canEdit && topic.applicationId === s.application && (
        <Panel title="Other applications" hint="Who else may read or write this topic here. A pending request is decided on Approvals." flush>
          {others.read.length + others.write.length + others.other.length === 0 ? (
            <p className="muted kafka-grant-none">Nobody else holds access to this topic in {envLabel(topic.environment)}.</p>
          ) : (
            <table className="tbl">
              <thead><tr><th>Application</th><th>Principal</th><th>Operation</th><th>State</th><th /></tr></thead>
              <tbody>
                {[...others.read, ...others.write, ...others.other].map((g) => (
                  <tr key={g.id}>
                    <td>{g.applicationName ?? s.applicationName(g.applicationId)}</td>
                    <td>{principalCell(g)}</td>
                    <td>{g.operation.toUpperCase()}</td>
                    <td><StatusChip chip={kafkaGrantChip(g.state as "active")} /></td>
                    <td className="row-end">
                      {g.state === "pending" ? <Link className="btn sm" to={`/${s.application}/approvals`}>Review</Link> : action(g)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>
      )}

      <Panel title="Connection" hint={`Where a client connects to ${envLabel(topic.environment)}'s cluster.`}>
        <Notice kind="error">{connection.error}</Notice>
        {connection.data && (
          <div className="kv-list">
            {connection.data.listeners.map((listener) => (
              <div className="kv" key={listener.authType}>
                <span className="k">{AUTH_LABEL[listener.authType]} bootstrap</span>
                <span className="v">
                  {listener.address ? (
                    <span className="copy-row"><code>{listener.address}</code><CopyButton value={listener.address} what={`the ${AUTH_LABEL[listener.authType]} bootstrap address`} /></span>
                  ) : (
                    <span className="muted">not configured — port {listener.port}; an administrator sets {connection.data!.variable}</span>
                  )}
                </span>
              </div>
            ))}
          </div>
        )}
      </Panel>

      {asking && <SubscribeDialog session={s} topics={topics} preset={topic} close={() => setAsking(false)} onDone={onChanged} />}
      {revoking && (
        <RevokeDialog grant={revoking} topic={topic} session={s} close={() => setRevoking(null)} onDone={() => { setRevoking(null); onChanged(); }} />
      )}
    </>
  );
}

function RevokeDialog({
  grant,
  topic,
  session: s,
  close,
  onDone,
}: {
  grant: GrantRow;
  topic: TopicRow;
  session: Session;
  close: () => void;
  onDone: () => void;
}) {
  const w = useAction();
  const pending = grant.state === "pending";
  const whose = grant.applicationId === s.application ? s.applicationName(s.application) : grant.applicationName ?? s.applicationName(grant.applicationId);
  return (
    <Modal title={pending ? "Cancel this request" : `Revoke ${grant.operation.toUpperCase()}`} close={close}>
      <DangerZone
        open
        what={pending ? "Cancel the request" : "Revoke access"}
        name={topic.name}
        consequence={
          pending
            ? "The whole request is withdrawn — every operation asked for with it — before the owner decides."
            : `${whose} loses ${grant.operation.toUpperCase()} for ${grant.principal ?? "this grant"} in ${envLabel(topic.environment)}. The other operations stay. Revoked access cannot be restored; asking again is a new request.`
        }
        permission={ALLOWED}
        busy={w.busy}
        error={w.error}
        onConfirm={() =>
          void w.run(async () => {
            await api.del(`/api/kafka/access/${grant.id}`);
            onDone();
          })
        }
      />
    </Modal>
  );
}

// ------------------------------------------------------------------------ stage and proxy

function StageDialog({
  topic,
  next,
  session: s,
  close,
  onStaged,
}: {
  topic: TopicRow;
  next: string;
  session: Session;
  close: () => void;
  onStaged: () => void;
}) {
  const w = useAction();
  const [done, setDone] = useState(false);
  return (
    <Modal title={`Stage ${topic.name} to ${envLabel(next)}`} close={close}>
      {done ? (
        <>
          <p>
            <StatusChip chip={kafkaTopicChip("provisioning")} /> The simulated broker is creating it in {envLabel(next)}. Access there is asked
            for separately — grants do not travel.
          </p>
          <div className="native-actions">
            <button type="button" className="btn" onClick={close}>Stay in {envLabel(topic.environment)}</button>
            <button type="button" className="btn primary" onClick={() => { close(); s.setEnvironment(next); }}>Open in {envLabel(next)}</button>
          </div>
        </>
      ) : (
        <>
          <p>
            Creates <span className="mono">{topic.name}</span> in {envLabel(next)} with the same {topic.partitions} partitions,
            replication {topic.replication}, {topic.retentionDays === null ? "the broker's retention" : `${topic.retentionDays} days' retention`},
            description and schema ({topic.schemaType?.toUpperCase() ?? "none"}
            {topic.schemaVersion ? `, version ${topic.schemaVersion}` : ""}).
          </p>
          <p className="muted small">
            Not carried: grants — each stage's access is asked for and approved on its own — and the HTTP proxy's certificate, which
            belongs to one stage.
          </p>
          <Notice kind="error">{w.error}</Notice>
          <div className="native-actions">
            <button type="button" className="btn" onClick={close}>Cancel</button>
            <button
              type="button"
              className="btn primary"
              disabled={w.busy}
              onClick={() =>
                void w.run(async () => {
                  await api.post(`/api/kafka/topics/${topic.id}/stage`);
                  setDone(true);
                  onStaged();
                })
              }
            >
              Stage to {envLabel(next)}
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}

/**
 * A topic's HTTP proxy (kafka-rest-proxy): an API generated from its JSON schema, produced to
 * through the shared proxy with the certificate chosen here. The certificate is set on the topic,
 * then the API is created — both from here, where the topic is.
 */
function HttpProxyDialog({
  topic,
  session: s,
  close,
  onChanged,
}: {
  topic: TopicRow;
  session: Session;
  close: () => void;
  onChanged: () => void;
}) {
  const certificates = useAsync(
    () =>
      api.get<{ items: Array<{ id: string; name: string; applicationId: string; expired: boolean; subject: string }> }>(
        `/api/certificates?environment=${encodeURIComponent(topic.environment)}`,
      ),
    [topic.environment],
  );
  const usable = (certificates.data?.items ?? []).filter((c) => c.applicationId === topic.applicationId && !c.expired);
  const [certificateId, setCertificateId] = useState(topic.certificateId ?? "");
  const w = useAction();
  const [created, setCreated] = useState(false);
  const blockers = topic.apiBlockers.filter((b) => certificateId === (topic.certificateId ?? "") || !/certificate/i.test(b));
  return (
    <Modal title={topic.apiPublished ? "HTTP proxy" : "Create HTTP proxy"} close={close}>
      <p>
        <StatusChip chip={topicApiChip(topic.apiPublished, topic.apiBlockers[0])} /> An API generated from this topic's JSON schema, which
        produces each call's body as a record through the shared Kafka proxy.
      </p>
      {topic.apiPublished && topic.apiResourceId ? (
        <div className="native-actions">
          <Link className="btn primary" to={`/${topic.applicationId}/apis/${topic.apiResourceId}`}>Open its API</Link>
        </div>
      ) : (
        <>
          <Field label="Client certificate" hint={`The certificate records are produced with — one of ${topic.applicationName}'s in ${envLabel(topic.environment)}.`}>
            <select value={certificateId} onChange={(e) => setCertificateId(e.target.value)}>
              <option value="">— Select a certificate —</option>
              {usable.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </Field>
          <Notice kind="warn">{certificates.error && `Certificates could not be read: ${certificates.error}`}</Notice>
          {certificates.data && usable.length === 0 && (
            <p className="hint">
              No certificate in {envLabel(topic.environment)} yet. <Link to={`/${s.application}/credentials`}>Add one on Credentials</Link>
            </p>
          )}
          {blockers.length > 0 && (
            <ul className="plain">
              {blockers.map((b) => <li key={b} className="muted small">{b}</li>)}
            </ul>
          )}
          <Notice kind="error">{w.error}</Notice>
          <Notice kind="ok">{created ? "Created. Activity shows it reaching the gateways; it is listed with your APIs." : null}</Notice>
          <div className="native-actions">
            <button type="button" className="btn" onClick={close}>Close</button>
            <button
              type="button"
              className="btn primary"
              disabled={w.busy || !certificateId || created}
              onClick={() =>
                void w.run(async () => {
                  if (certificateId !== (topic.certificateId ?? ""))
                    await api.patch(`/api/kafka/topics/${topic.id}`, { certificateId });
                  await command(`/api/kafka/topics/${topic.id}/proxy`, {});
                  setCreated(true);
                  onChanged();
                })
              }
            >
              Create HTTP proxy
            </button>
          </div>
          <p className="muted small">
            The shared proxy itself is an administrator's, per stage, on <Link to={`/${s.application}/kafka-proxy`}>Kafka REST Proxy</Link>.
          </p>
        </>
      )}
    </Modal>
  );
}
