import { useState } from "react";
import type { Session } from "../App";
import { api } from "../api";
import { EmptyState, Field, Link, Notice, Panel, Segmented, StatusChip, envLabel, useAction, useAsync } from "../components";
import { formatDateTime } from "../lib/datetime";
import {
  appendHistory,
  certificatesFor,
  historyKey,
  readHistory,
  type GrantRow,
  type HistoryEntry,
  type TopicRow,
} from "../lib/kafka";
import { kafkaGrantChip } from "../lib/status";
import { PLAYGROUND_MAX_HEADERS, PLAYGROUND_MAX_MESSAGES, PLAYGROUND_MAX_VALUE } from "../../../shared/kafka";
import * as I from "./icons";

/**
 * The Kafka playground (kafka-playground): one read or one write against the simulated broker, as
 * one of this application's own grants on the topic.
 *
 * The grant is who is asking. It is chosen on the left, and the credential the broker would check
 * for it is chosen on the right — an mTLS grant is tried with one of the application's certificates
 * whose subject *is* that grant's DN, and an OAuth grant by its client id. A test that could read as
 * anybody would say nothing about whether the consumer it stands for can.
 *
 * Reads are group-less on purpose: joining the grant's consumer group from here would move the
 * offsets of the real client reading through it.
 */

interface Certificate {
  id: string;
  name: string;
  subject: string;
  applicationId: string;
  expired: boolean;
}

interface KafkaRecord {
  partition: number;
  offset: number;
  key: string | null;
  headers: Array<{ key: string; value: string }>;
  value: string;
  timestamp: string;
}

type Position = "latest" | "earliest" | "offset" | "timestamp";

const AUTH_LABEL: Record<string, string> = { mtls: "mTLS", oauth: "OAuth" };

export function KafkaPlayground({ topic, grants, session: s }: { topic: TopicRow; grants: GrantRow[]; session: Session }) {
  const mine = grants.filter((g) => g.applicationId === s.application && (g.operation === "read" || g.operation === "write"));
  const active = mine.filter((g) => g.state === "active");
  const [grantId, setGrantId] = useState(active[0]?.id ?? "");
  const grant = active.find((g) => g.id === grantId) ?? null;
  const operation = (grant?.operation ?? "read") as "read" | "write";
  const certificates = useAsync(
    () =>
      mine.some((g) => g.authType === "mtls")
        ? api.get<{ items: Certificate[] }>(`/api/certificates?environment=${encodeURIComponent(topic.environment)}`)
        : Promise.resolve({ items: [] as Certificate[] }),
    [topic.environment],
  );
  const matching = grant?.authType === "mtls" && grant.principal ? certificatesFor(certificates.data?.items ?? [], s.application, grant.principal) : [];
  const [certificateId, setCertificateId] = useState("");
  const chosenCertificate = matching.find((c) => c.id === certificateId) ?? matching[0] ?? null;

  const [partition, setPartition] = useState("");
  const [position, setPosition] = useState<Position>("latest");
  const [count, setCount] = useState(20);
  const [offset, setOffset] = useState(0);
  const [from, setFrom] = useState("");
  const [maxMessages, setMaxMessages] = useState(PLAYGROUND_MAX_MESSAGES);
  const [key, setKey] = useState("");
  const [headers, setHeaders] = useState<Array<{ key: string; value: string }>>([]);
  const [value, setValue] = useState("");
  const [prodConfirmed, setProdConfirmed] = useState(false);
  const [result, setResult] = useState<HistoryEntry | null>(null);
  const storageKey = historyKey(topic.name, topic.environment);
  const [history, setHistory] = useState<HistoryEntry[]>(() => readHistory(localStorage, storageKey));
  const [shown, setShown] = useState<HistoryEntry | null>(null);
  const w = useAction();
  // The last stage is the one real consumers read; a write there is said out loud before it is sent.
  const lastStage = topic.environment === s.meta.kafkaChain.at(-1);

  /** Switch between reading and writing by choosing the same principal's grant for the other one. */
  function chooseOperation(next: "read" | "write") {
    const candidates = active.filter((g) => g.operation === next);
    const same = candidates.find((g) => g.principal === grant?.principal) ?? candidates[0];
    if (same) setGrantId(same.id);
  }

  const problem = !grant
    ? "Choose one of your active grants on the left."
    : grant.authType === "mtls" && !chosenCertificate
      ? "An mTLS grant is tested with a certificate whose subject is its principal."
      : operation === "write" && value.length > PLAYGROUND_MAX_VALUE
        ? `The value is over ${PLAYGROUND_MAX_VALUE} characters.`
        : operation === "write" && lastStage && !prodConfirmed
          ? `Confirm the write to ${envLabel(topic.environment)} below.`
          : operation === "read" && position === "offset" && partition === ""
            ? "An offset belongs to one partition — choose it."
            : operation === "read" && position === "timestamp" && !from
              ? "Choose the time to read from."
              : null;

  function send() {
    if (!grant || problem) return;
    const request: Record<string, unknown> =
      operation === "write"
        ? {
            partition: partition === "" ? null : Number(partition),
            key: key || null,
            headers: headers.filter((h) => h.key.trim()),
            value,
          }
        : {
            partition: partition === "" ? null : Number(partition),
            position:
              position === "latest"
                ? { kind: "latest", count }
                : position === "offset"
                  ? { kind: "offset", offset }
                  : position === "timestamp"
                    ? { kind: "timestamp", at: new Date(from).toISOString() }
                    : { kind: "earliest" },
            maxMessages,
          };
    void w.run(async () => {
      const entry: HistoryEntry = {
        id: crypto.randomUUID(),
        at: new Date().toISOString(),
        topic: topic.name,
        environment: topic.environment,
        action: operation === "write" ? "produce" : "consume",
        principal: grant.principal,
        operation: grant.operation,
        // The certificate by name, never its material: the history is kept in this browser.
        request: { ...request, ...(chosenCertificate && grant.authType === "mtls" ? { certificate: chosenCertificate.name } : {}) },
        ok: false,
        summary: "",
        response: null,
      };
      try {
        const response = await api.post<{ record?: KafkaRecord; items?: KafkaRecord[]; groupId?: string | null }>(
          `/api/kafka/topics/${topic.id}/playground`,
          {
            applicationId: s.application,
            accessId: grant.id,
            action: entry.action,
            certificateId: grant.authType === "mtls" ? chosenCertificate?.id : undefined,
            ...request,
          },
        );
        entry.ok = true;
        entry.response = response;
        entry.summary = response.record
          ? `Written to partition ${response.record.partition} at offset ${response.record.offset}`
          : `${response.items?.length ?? 0} message${response.items?.length === 1 ? "" : "s"}`;
        if (operation === "write") setProdConfirmed(false);
      } catch (error) {
        entry.summary = error instanceof Error ? error.message : String(error);
        throw error;
      } finally {
        setHistory(appendHistory(localStorage, storageKey, entry));
        setResult(entry);
        setShown(null);
      }
    });
  }

  if (mine.length === 0)
    return (
      <Panel>
        <EmptyState
          title={`${s.applicationName(s.application)} holds no READ or WRITE grant here`}
          detail={`The playground reads and writes as one of your grants on ${topic.name} in ${envLabel(topic.environment)}, so there has to be one first.`}
          action={<Link className="btn sm" to={`/${s.application}/kafka/${encodeURIComponent(topic.name)}/subscriptions`}>Ask for access</Link>}
        />
      </Panel>
    );

  const view = shown ?? result;
  return (
    <>
      <div className="pg-console kafka-playground">
        <div className="pg-ops" role="group" aria-label="Your grants">
          <span className="lbl">Your grants</span>
          <div className="pg-ops-list">
            {mine.map((g) => (
              <button
                key={g.id}
                type="button"
                className={g.id === grantId ? "pg-op active" : "pg-op"}
                disabled={g.state !== "active"}
                aria-pressed={g.id === grantId}
                onClick={() => setGrantId(g.id)}
              >
                <span className="pg-op-label">
                  <span className="mono small">{g.principal ?? "granted before principals"}</span>
                  <span className="muted small">
                    {AUTH_LABEL[g.authType ?? ""] ?? "—"} · {g.operation.toUpperCase()}
                  </span>
                </span>
                <StatusChip chip={kafkaGrantChip(g.state as "active")} />
              </button>
            ))}
          </div>
        </div>
        <div className="pg-main">
          <Panel title="Credentials">
            {!grant ? (
              <p className="muted">None of your grants here is active yet.</p>
            ) : grant.authType === "mtls" ? (
              <>
                <Notice kind="error">{certificates.error}</Notice>
                {certificates.data && matching.length === 0 ? (
                  <Notice kind="warn">
                    No uploaded certificate matches <span className="mono">{grant.principal}</span> in {envLabel(topic.environment)}.{" "}
                    <Link className="btn sm" to={`/${s.application}/credentials`}>Go to Certificates</Link>
                  </Notice>
                ) : (
                  <Field label="Client certificate" hint="One of yours whose subject is the grant's principal.">
                    <select value={chosenCertificate?.id ?? ""} onChange={(e) => setCertificateId(e.target.value)}>
                      {matching.map((c) => (
                        <option key={c.id} value={c.id}>{c.name}</option>
                      ))}
                    </select>
                  </Field>
                )}
              </>
            ) : grant.authType === "oauth" ? (
              <p className="muted">
                OAuth client <span className="mono">{grant.principal}</span>. The simulated broker checks the grant by client id; no secret is
                sent from here.
              </p>
            ) : (
              <p className="muted">Granted before principals existed: nothing is checked but the grant itself.</p>
            )}
          </Panel>
          <Panel title="Request">
            <div className="native-field">
              <span className="lbl">Operation</span>
              <Segmented
                label="Operation"
                value={operation}
                onChange={chooseOperation}
                options={(["read", "write"] as const).map((op) => {
                  const available = active.some((g) => g.operation === op);
                  return {
                    value: op,
                    label: op === "read" ? "Read" : "Write",
                    disabled: !available,
                    reason: available ? undefined : `No active ${op.toUpperCase()} grant — ask for one on Subscriptions.`,
                  };
                })}
              />
            </div>
            <div className="native-form-grid">
              <Field
                label="Partition"
                hint={operation === "read" ? "Leave blank to read across all partitions." : "Blank: by the key's hash, or round-robin without a key."}
              >
                <select value={partition} onChange={(e) => setPartition(e.target.value)}>
                  <option value="">{operation === "read" ? "All partitions" : "Automatic"}</option>
                  {Array.from({ length: topic.partitions }, (_, index) => (
                    <option key={index} value={String(index)}>{index}</option>
                  ))}
                </select>
              </Field>
              {operation === "read" && (
                <>
                  <Field label="Position">
                    <select value={position} onChange={(e) => setPosition(e.target.value as Position)}>
                      <option value="latest">Latest N</option>
                      <option value="earliest">Earliest</option>
                      <option value="offset">From offset</option>
                      <option value="timestamp">From time</option>
                    </select>
                  </Field>
                  {position === "latest" && (
                    <Field label="N">
                      <input type="number" min={1} max={PLAYGROUND_MAX_MESSAGES} value={count} onChange={(e) => setCount(Number(e.target.value))} />
                    </Field>
                  )}
                  {position === "offset" && (
                    <Field label="Offset">
                      <input type="number" min={0} value={offset} onChange={(e) => setOffset(Number(e.target.value))} />
                    </Field>
                  )}
                  {position === "timestamp" && (
                    <Field label="From">
                      <input type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)} />
                    </Field>
                  )}
                  <Field label="Max messages" hint={`At most ${PLAYGROUND_MAX_MESSAGES}.`}>
                    <input type="number" min={1} max={PLAYGROUND_MAX_MESSAGES} value={maxMessages} onChange={(e) => setMaxMessages(Number(e.target.value))} />
                  </Field>
                </>
              )}
            </div>
            {operation === "read" && grant?.groupId && (
              <p className="hint">
                Consumer group ACL: <span className="mono">{grant.groupId}</span> ✓ (not used by this test — reads are group-less)
              </p>
            )}
            {operation === "write" && (
              <>
                <Field label="Key" hint="Optional. Records with one key stay on one partition, in order.">
                  <input className="mono" value={key} maxLength={1024} onChange={(e) => setKey(e.target.value)} />
                </Field>
                <div className="pg-kv-block">
                  <span className="lbl">Headers</span>
                  <div className="pg-kv">
                    {headers.map((header, index) => (
                      <div className="pg-kv-row" key={index}>
                        <input className="pg-kv-key" aria-label={`Header ${index + 1} name`} value={header.key} onChange={(e) => setHeaders(headers.map((h, i) => (i === index ? { ...h, key: e.target.value } : h)))} />
                        <input className="pg-kv-val" aria-label={`Header ${index + 1} value`} value={header.value} onChange={(e) => setHeaders(headers.map((h, i) => (i === index ? { ...h, value: e.target.value } : h)))} />
                        <button type="button" className="pg-kv-del" aria-label={`Remove header ${index + 1}`} onClick={() => setHeaders(headers.filter((_, i) => i !== index))}>
                          <I.X size={12} />
                        </button>
                      </div>
                    ))}
                    {headers.length < PLAYGROUND_MAX_HEADERS && (
                      <button type="button" className="pg-kv-add" onClick={() => setHeaders([...headers, { key: "", value: "" }])}>
                        + Add header
                      </button>
                    )}
                  </div>
                </div>
                <Field label="Value" hint={topic.schemaType ? `The record's value, as ${topic.schemaType.toUpperCase()} would carry it.` : "The record's value."}>
                  <textarea className="mono pg-body" rows={8} spellCheck={false} value={value} onChange={(e) => setValue(e.target.value)} />
                </Field>
                {lastStage && (
                  <label className="choice-option kafka-prod-confirm">
                    <input type="checkbox" checked={prodConfirmed} onChange={(e) => setProdConfirmed(e.target.checked)} />
                    <span>This writes a record to {envLabel(topic.environment)}, where real consumers read. Send it.</span>
                  </label>
                )}
              </>
            )}
            {problem && grant && <p className="muted">Still needed: {problem}</p>}
            <div className="native-actions">
              <button type="button" className="btn primary" disabled={w.busy || Boolean(problem)} onClick={send}>
                {operation === "read" ? <><I.Download /> Read</> : <><I.Upload /> Write</>}
              </button>
              <span className="muted small">Simulated broker.</span>
            </div>
          </Panel>
          <Panel title="Result">
            <Notice kind="error">{w.error}</Notice>
            {!view ? (
              <p className="muted">Send a read or write to see the result here.</p>
            ) : (
              <PlaygroundResult entry={view} />
            )}
          </Panel>
        </div>
      </div>
      <Panel
        title={`Request history · ${history.length}`}
        hint="Kept in this browser only, and never with a credential in it."
        actions={
          history.length > 0 ? (
            <button
              type="button"
              className="btn sm"
              onClick={() => {
                localStorage.removeItem(storageKey);
                setHistory([]);
                setShown(null);
              }}
            >
              Clear
            </button>
          ) : undefined
        }
        flush
      >
        {history.length === 0 ? (
          <p className="muted kafka-grant-none">Nothing sent from this browser yet.</p>
        ) : (
          <table className="tbl pg-history-table">
            <thead><tr><th>When</th><th>Operation</th><th>Principal</th><th>Result</th><th /></tr></thead>
            <tbody>
              {history.map((entry) => (
                <tr key={entry.id} className={shown?.id === entry.id ? "history-row current" : "history-row"}>
                  <td className="pg-history-when">{formatDateTime(entry.at)}</td>
                  <td>{entry.action === "produce" ? "Write" : "Read"}</td>
                  <td className="mono small">{entry.principal ?? "—"}</td>
                  <td>
                    <span className={entry.ok ? "chip ok" : "chip err"}>{entry.ok ? "OK" : "Refused"}</span> {entry.summary}
                  </td>
                  <td className="row-end">
                    <button type="button" className="btn sm" onClick={() => setShown(entry)}>Show</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
    </>
  );
}

function PlaygroundResult({ entry }: { entry: HistoryEntry }) {
  const response = entry.response as { record?: KafkaRecord; items?: KafkaRecord[] } | null;
  if (!entry.ok || !response)
    return (
      <p>
        <span className="chip err">Refused</span> {entry.summary}
      </p>
    );
  const records = response.record ? [response.record] : response.items ?? [];
  return (
    <div className="pg-response">
      <div className="pg-response-head">
        <span className="chip ok">{entry.action === "produce" ? "Written" : "Read"}</span>
        <span className="pg-time">{formatDateTime(entry.at)}</span>
        <span className="muted small">{entry.summary}</span>
      </div>
      {records.length === 0 ? (
        <p className="muted">No messages at that position.</p>
      ) : (
        <table className="tbl">
          <thead><tr><th>Partition</th><th>Offset</th><th>Key</th><th>Timestamp</th><th>Value</th></tr></thead>
          <tbody>
            {records.map((record) => (
              <tr key={`${record.partition}:${record.offset}`}>
                <td className="num">{record.partition}</td>
                <td className="num">{record.offset}</td>
                <td className="mono small">{record.key ?? "—"}</td>
                <td>{formatDateTime(record.timestamp)}</td>
                <td className="mono small kafka-record-value">
                  {record.value}
                  {record.headers.length > 0 && (
                    <span className="muted small"> · {record.headers.map((h) => `${h.key}=${h.value}`).join(", ")}</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
