import { formatDateTime } from "../lib/datetime";
import { useEffect, useMemo, useState } from "react";
import {
  api,
  ApiError,
  fixOf,
  type FormParameter,
  type PlaygroundEntry,
  type PlaygroundForm,
  type PlaygroundHistory,
  type PlaygroundHistoryEntry,
  type PlaygroundResponse,
} from "../api";
import {
  Panel,
  EmptyState,
  Link,
  Notice,
  Skeleton,
  StatusChip,
  Term,
  describe as describeError,
  useAsync,
} from "../components";

/**
 * "Try it" (G1, plan §5).
 *
 * The panel's job is to make three facts unmissable, because each one is something a person would
 * otherwise learn by being surprised:
 *
 *  - **this is a real call.** It goes through the gateway, spends the subscription's rate limit and
 *    quota, and appears in telemetry. Said beside the send button, not in a footnote.
 *  - **the key is not here.** The browser picks a subscription; the control plane decrypts and
 *    injects the key. The request shown back is the request as sent *minus* the key.
 *  - **what is offered is what will be accepted.** Every operation, parameter and prefilled body
 *    comes from `GET /api/playground/form`, which resolves the revision this environment is
 *    serving — so the form can never offer a call the send would refuse.
 */

interface Row {
  name: string;
  value: string;
  enabled: boolean;
}

export function PlaygroundPanel({
  resourceId,
  environment,
  onSubscribe,
}: {
  resourceId: string;
  environment: string;
  /** The owner path `[P1-10]`: a key is required and this caller holds no subscription for it. */
  onSubscribe?: () => void;
}) {
  const form = useAsync(
    () => api.get<PlaygroundForm>(`/api/playground/form?resourceId=${resourceId}&environment=${environment}`),
    [resourceId, environment],
  );

  if (form.loading) return <Skeleton rows={8} />;
  if (form.error) {
    return (
      <Refusal
        message={form.error}
        cause={form.cause}
        resourceId={resourceId}
        environment={environment}
      />
    );
  }
  if (!form.data) return null;

  return (
    <Console
      key={`${resourceId}:${environment}`}
      form={form.data}
      resourceId={resourceId}
      environment={environment}
      onSubscribe={onSubscribe}
    />
  );
}

/**
 * "Published is not the same as served" `[P3-02]`, "not published here", "no gateway configured" —
 * three different reasons, each with a different next step, and none of them a blank panel.
 *
 * Which screen fixes it is the control plane's answer, carried on the 409 as `extra.fix`, not this
 * component's guess from the wording: the sentence can be reworded, and a link that was inferred
 * from it would start pointing at the wrong screen without anything failing.
 */
export function Refusal({
  message,
  cause,
  resourceId,
  environment,
}: {
  message: string;
  cause?: unknown;
  resourceId: string;
  environment: string;
}) {
  const fix = fixOf(cause);
  const where = fix?.screen === "policy" ? "policies" : "publish";
  const to = `/apis/${fix?.resourceId ?? resourceId}/${where}?environment=${fix?.environment ?? environment}`;
  return (
    <EmptyState
      title={`Nothing to call in ${environment.toUpperCase()} yet`}
      // The problem document's `detail` sentence, without the `409 Conflict:` prefix `describe()`
      // adds — the remedy is in the sentence, and the status code is not news to anybody here.
      detail={message.replace(/^\d+ [^:]+: /, "")}
      action={
        <Link to={to}>
          {where === "policies" ? "Go to routing and policy →" : "Go to publishing →"}
        </Link>
      }
    />
  );
}

function Console({
  form,
  resourceId,
  environment,
  onSubscribe,
}: {
  form: PlaygroundForm;
  resourceId: string;
  environment: string;
  onSubscribe?: () => void;
}) {
  const [operationId, setOperationId] = useState(form.operations[0]?.id ?? "");
  const [agentCard, setAgentCard] = useState(false);
  const [subscriptionId, setSubscriptionId] = useState(form.subscriptions[0]?.id ?? "");
  const [keyKind, setKeyKind] = useState<"primary" | "secondary">("primary");
  const [gatewayLabel, setGatewayLabel] = useState(form.gateways[0]?.label ?? "");
  const [pathParams, setPathParams] = useState<Record<string, string>>({});
  const [query, setQuery] = useState<Row[]>([]);
  const [headers, setHeaders] = useState<Row[]>([]);
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<PlaygroundResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retryAfter, setRetryAfter] = useState<number | null>(null);
  const [historyTick, setHistoryTick] = useState(0);

  const operation = useMemo(
    () => form.operations.find((candidate) => candidate.id === operationId) ?? null,
    [form.operations, operationId],
  );

  // Choosing an operation replaces the form with that operation's own prefill. Deliberately not
  // merged with what was typed: a body from the last operation is never valid for this one.
  useEffect(() => {
    if (!operation) return;
    setPathParams(Object.fromEntries(operation.pathParams.map((p) => [p.name, p.value])));
    setQuery(operation.query.map(rowOf));
    setHeaders(operation.headers.map(rowOf));
    setBody(operation.body ?? "");
    setResult(null);
    setError(null);
  }, [operation]);

  const bodyBytes = new TextEncoder().encode(body).length;
  const overBodyLimit = !agentCard && bodyBytes > form.limits.maxBodyBytes;
  const missing = agentCard ? [] : operation?.pathParams.filter((p) => !(pathParams[p.name] ?? "").trim()) ?? [];
  const needsKey = form.key !== null;
  const noSubscription = needsKey && !subscriptionId;

  const blocked = form.streaming
    ? "The console cannot hold a stream open. Use the command below."
    : overBodyLimit
      ? `The body is ${bodyBytes.toLocaleString()} bytes and the limit is ${form.limits.maxBodyBytes.toLocaleString()}. Send a smaller body, or use curl.`
      : missing.length > 0
        ? `Fill ${missing.map((p) => p.name).join(", ")} before sending.`
        : noSubscription
          ? `This API requires a key in ${form.key!.in === "header" ? form.key!.name : `?${form.key!.name}`}. Choose a subscription.`
          : !agentCard && !operation
            ? "Choose an operation."
            : null;

  async function send() {
    setBusy(true);
    setError(null);
    setRetryAfter(null);
    try {
      const response = await api.post<PlaygroundResponse>("/api/playground", {
        resourceId,
        environment,
        subscriptionId: subscriptionId || null,
        keyKind,
        gatewayLabel: gatewayLabel || undefined,
        ...(agentCard ? { agentCard: true } : { operationId }),
        pathParams,
        query: entries(query),
        headers: entries(headers),
        body: agentCard ? null : body || null,
      });
      setResult(response);
      setHistoryTick((tick) => tick + 1);
    } catch (err) {
      // A refusal is a sentence with a remedy in it, shown inline beside the control that caused
      // it — never a toast, which is gone before it has been read.
      setError(describeError(err));
      if (err instanceof ApiError && err.status === 429) {
        setRetryAfter(Number(/(\d+)/.exec(err.detail)?.[1] ?? 0) || null);
      }
    } finally {
      setBusy(false);
    }
  }

  function load(entry: PlaygroundHistoryEntry) {
    if (entry.operationId === "agent-card") setAgentCard(true);
    else {
      setAgentCard(false);
      setOperationId(entry.operationId ?? "");
    }
    setSubscriptionId(entry.subscriptionId ?? "");
    setQuery(entry.query.map((row) => ({ name: row.name, value: row.value, enabled: true })));
    setHeaders(Object.entries(entry.headers).map(([name, value]) => ({ name, value, enabled: true })));
    setBody(entry.body ?? "");
    setResult(null);
  }

  return (
    <>
      {form.warnings.map((warning) => (
        <Notice key={warning} kind="warn">
          {warning}
        </Notice>
      ))}

      {form.streaming && (
        <Panel
          title="This is a streaming route"
          hint="The console cannot hold a stream open, so here is the line that does work."
        >
          <div className="pre">{form.streaming.command}</div>
        </Panel>
      )}

      {form.needsSubscription && (
        <Panel title="You need a subscription to call this">
          <p className="muted">
            This API requires a <Term name="key" /> in{" "}
            <span className="mono">
              {form.key!.in === "header" ? form.key!.name : `?${form.key!.name}`}
            </span>
            . Owning an API is not the same as being one of its callers, so you need a{" "}
            <Term name="subscription" /> like anybody else.
          </p>
          {onSubscribe ? (
            <button onClick={onSubscribe}>Subscribe an application to try this</button>
          ) : (
            <Link to={`/catalog/${resourceId}/subscribe`}>Subscribe an application to try this →</Link>
          )}
        </Panel>
      )}

      <Panel title="Request" className="playground-request">
        <div className="row wrap" style={{ marginBottom: 12 }}>
          <div className="field">
            <label htmlFor="pg-operation">Operation</label>
            <select
              id="pg-operation"
              value={agentCard ? "__card__" : operationId}
              onChange={(event) => {
                setAgentCard(event.target.value === "__card__");
                if (event.target.value !== "__card__") setOperationId(event.target.value);
              }}
            >
              {form.operations.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.method} {candidate.name}
                </option>
              ))}
              {form.agentCard && <option value="__card__">GET the agent card</option>}
            </select>
          </div>

          {needsKey && (
            <>
              <div className="field">
                <label htmlFor="pg-subscription">Call as</label>
                <select
                  id="pg-subscription"
                  value={subscriptionId}
                  onChange={(event) => { setSubscriptionId(event.target.value); setKeyKind("primary"); }}
                >
                  <option value="">choose a subscription…</option>
                  {form.subscriptions.map((subscription) => (
                    <option key={subscription.id} value={subscription.id}>
                      {subscription.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label htmlFor="pg-keykind">Key</label>
                <select
                  id="pg-keykind"
                  disabled={!subscriptionId}
                  aria-describedby="pg-key-help"
                  value={keyKind}
                  onChange={(event) => setKeyKind(event.target.value as "primary" | "secondary")}
                >
                  <option value="primary">primary</option>
                  <option
                    value="secondary"
                    disabled={!form.subscriptions.find((s) => s.id === subscriptionId)?.hasSecondary}
                  >
                    secondary
                  </option>
                </select>
                <p id="pg-key-help" className="hint">Keys belong to the selected subscription. Secondary is available only after a second key is created.</p>
              </div>
            </>
          )}

          {form.gateways.length > 1 && (
            <div className="field">
              <label htmlFor="pg-gateway">Gateway</label>
              <select
                id="pg-gateway"
                value={gatewayLabel}
                onChange={(event) => setGatewayLabel(event.target.value)}
              >
                {form.gateways.map((gateway) => (
                  <option key={gateway.label} value={gateway.label}>
                    {gateway.label}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>

        {/* The target, composed by the platform. There is no field to edit here, and that is the
            security property rather than a simplification (§5.3). */}
        <p className="muted small">
          <span className="mono">
            {agentCard ? "GET" : (operation?.method ?? "GET")}{" "}
            {form.basePath === "/" ? "" : form.basePath}
            {agentCard ? form.agentCard?.path.replace(form.basePath, "") : (operation?.template ?? "")}
          </span>{" "}
          on {environment.toUpperCase()}, revision {form.rev}
          {form.host !== "*" && <> · Host {form.host}</>}
          {operation?.schemaState === "unsupported-schema" && (
            <> · the gateway cannot validate this operation</>
          )}
        </p>

        {!agentCard && operation && (
          <>
            {operation.summary && <p className="hint">{operation.summary}</p>}
            {operation.pathParams.length > 0 && (
              <div className="row wrap">
                {operation.pathParams.map((parameter) => (
                  <div className="field" key={parameter.name}>
                    <label htmlFor={`pp-${parameter.name}`}>
                      {parameter.name} <span className="muted">path</span>
                    </label>
                    <input
                      id={`pp-${parameter.name}`}
                      value={pathParams[parameter.name] ?? ""}
                      onChange={(event) =>
                        setPathParams({ ...pathParams, [parameter.name]: event.target.value })
                      }
                    />
                  </div>
                ))}
              </div>
            )}

            <Rows title="Query" rows={query} onChange={setQuery} />
            <Rows title="Headers" rows={headers} onChange={setHeaders} />

            {operation.body !== null && (
              <div className="field" style={{ marginTop: 10 }}>
                <label htmlFor="pg-body">
                  Body <span className="muted">{operation.bodyKind === "xml" ? "XML" : "JSON"}</span>
                </label>
                <textarea
                  id="pg-body"
                  value={body}
                  onChange={(event) => setBody(event.target.value)}
                  style={{ minHeight: 160 }}
                />
                <p className={overBodyLimit ? "small ok" : "small muted"}>
                  {bodyBytes.toLocaleString()} of {form.limits.maxBodyBytes.toLocaleString()} bytes
                </p>
              </div>
            )}
          </>
        )}

        <Notice kind="error">{error}</Notice>
        {retryAfter !== null && (
          <p className="muted small">
            This is the portal's own limit — {form.limits.ratePerMin} calls a minute per person — not
            your subscription's. Try again in {retryAfter} seconds.
          </p>
        )}

        <div className="action" style={{ marginTop: 8 }}>
          <button className="btn primary" disabled={busy || blocked !== null} onClick={send} title={blocked ?? undefined}>
            {busy ? "Sending…" : "Send"}
          </button>
          {blocked && <span className="action-reason">{blocked}</span>}
        </div>
        {/* Said beside the button, because a consumer who exhausts their own quota from a test
            console and cannot see why has been misled by us (§5.3). */}
        <p className="muted small" style={{ marginTop: 8 }}>
          {form.note}
        </p>
      </Panel>

      {result && <ResultCard result={result} />}

      <History
        resourceId={resourceId}
        tick={historyTick}
        onLoad={load}
        onChanged={() => setHistoryTick((tick) => tick + 1)}
      />
    </>
  );
}

// --------------------------------------------------------------------------- the response

function ResultCard({ result }: { result: PlaygroundResponse }) {
  const { request, response } = result;
  const tone =
    response.error !== null || response.status === null
      ? "stop"
      : response.status < 300
        ? "live"
        : response.status < 500
          ? "warn"
          : "stop";

  return (
    <Panel title="Response">
      {response.error ? (
        // An outcome, not an error banner: the call happened, and this is what happened (§5.3).
        <Notice kind="error">{response.error}</Notice>
      ) : (
        <p className="inline">
          <span className={`chip-status tone-${tone}`}>
            {response.status} {response.statusText}
          </span>
          <span className="muted small">
            {response.durationMs} ms · {response.bytes.toLocaleString()} bytes · via{" "}
            {request.gateway.label}
            {request.keyKind !== "none" && <> · {request.keyKind} key</>}
          </span>
        </p>
      )}

      {request.droppedHeaders.length > 0 && (
        <Notice kind="warn">
          These headers were not sent: {request.droppedHeaders.join(", ")}. The gateway sets them, or
          they would let one API's console address another's route.
        </Notice>
      )}
      {response.truncated && (
        <Notice kind="warn">
          The response was longer than the console keeps and has been cut off here.
        </Notice>
      )}

      <details style={{ marginBottom: 10 }}>
        <summary className="muted small">What was sent</summary>
        <div className="pre">
          {request.method} {request.path}
          {request.query ? `?${request.query}` : ""}
          {"\n"}
          {Object.entries(request.headers)
            .map(([name, value]) => `${name}: ${value}`)
            .join("\n")}
        </div>
        <p className="muted small">
          The key is not in this list, and never was in your browser: the portal injected it on the
          way out.
        </p>
      </details>

      {response.body !== null && (
        <>
          <div className="pre">{format(response.body, response.headers["content-type"])}</div>
          {response.encoding === "base64" && (
            <p className="muted small">
              The body is not text, so it is shown base64-encoded rather than mangled.
            </p>
          )}
        </>
      )}
    </Panel>
  );
}

function format(body: string, contentType: string | undefined): string {
  if (!contentType?.includes("json")) return body;
  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    return body;
  }
}

// --------------------------------------------------------------------------- history (§5.5)

function History({
  resourceId,
  tick,
  onLoad,
  onChanged,
}: {
  resourceId: string;
  tick: number;
  onLoad: (entry: PlaygroundHistoryEntry) => void;
  onChanged: () => void;
}) {
  const history = useAsync(
    () => api.get<PlaygroundHistory>(`/api/playground/history?resourceId=${resourceId}`),
    [resourceId, tick],
  );
  // A history that failed to load is not a history that is empty, and the difference matters to
  // somebody looking for a call they know they made.
  if (history.error) return <Notice kind="error">Your calls could not be listed: {history.error}</Notice>;
  if (!history.data || history.data.items.length === 0) return null;

  return (
    <Panel
      title="Your calls"
      hint={`The last ${history.data.cap} you made, across every environment, kept for ${history.data.retentionDays} days. Nobody else can see them.`}
    >
      <table>
        <thead>
          <tr>
            <th>When</th>
            <th>Environment</th>
            <th>Call</th>
            <th>Result</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {history.data.items.map((entry) => (
            <tr key={entry.id}>
              <td className="muted small">{formatDateTime(entry.createdAt)}</td>
              <td>
                {/* Environments are mixed on purpose — the same call against DEV and TEST is the
                    comparison people want — so every row says which one `[P1-28]`. */}
                <span className="pill">{entry.environment}</span>
              </td>
              <td className="mono small">
                {entry.method} {entry.path}
                {entry.query.length > 0 && "?…"}
              </td>
              <td>
                {entry.error ? (
                  <StatusChip chip={{ label: "No response", tone: "stop", title: entry.error }} />
                ) : (
                  <StatusChip
                    chip={{
                      label: String(entry.status),
                      tone: (entry.status ?? 500) < 300 ? "live" : (entry.status ?? 500) < 500 ? "warn" : "stop",
                      title: `${entry.statusText ?? ""} in ${entry.durationMs} ms`,
                    }}
                  />
                )}
              </td>
              <td className="right">
                <span className="action">
                  <button
                    className="ghost small"
                    disabled={!entry.replayable}
                    title={entry.reason ?? undefined}
                    onClick={() => onLoad(entry)}
                  >
                    Load
                  </button>
                  <button
                    className="danger small"
                    onClick={async () => {
                      await api.del(`/api/playground/history/${entry.id}`);
                      onChanged();
                    }}
                  >
                    Delete
                  </button>
                </span>
                {entry.reason && <div className="action-reason">{entry.reason}</div>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted small">
        There is no replay button: loading an entry fills the form, and sending it is an ordinary
        call with its own audit entry.
      </p>
    </Panel>
  );
}

// --------------------------------------------------------------------------- editable rows

function Rows({
  title,
  rows,
  onChange,
}: {
  title: string;
  rows: Row[];
  onChange: (next: Row[]) => void;
}) {
  return (
    <div style={{ marginTop: 10 }}>
      <div className="spread">
        <strong className="small">{title}</strong>
        <button
          className="ghost small"
          onClick={() => onChange([...rows, { name: "", value: "", enabled: true }])}
        >
          Add
        </button>
      </div>
      {rows.length === 0 ? (
        <p className="muted small">None.</p>
      ) : (
        rows.map((row, index) => (
          <div className="row" key={index} style={{ marginTop: 6 }}>
            <label className="check-inline">
              <input
                type="checkbox"
                checked={row.enabled}
                onChange={(event) => replace(index, { ...row, enabled: event.target.checked })}
              />
            </label>
            <input
              value={row.name}
              placeholder="name"
              onChange={(event) => replace(index, { ...row, name: event.target.value })}
            />
            <input
              value={row.value}
              placeholder="value"
              onChange={(event) => replace(index, { ...row, value: event.target.value })}
            />
            <button className="ghost small" onClick={() => onChange(rows.filter((_, i) => i !== index))}>
              Remove
            </button>
          </div>
        ))
      )}
    </div>
  );

  function replace(index: number, next: Row) {
    onChange(rows.map((row, i) => (i === index ? next : row)));
  }
}

function rowOf(parameter: FormParameter): Row {
  // A parameter the document marks required starts enabled; an optional one starts off, so the
  // first send is the smallest call that can work.
  return { name: parameter.name, value: parameter.value, enabled: parameter.required };
}

function entries(rows: Row[]): PlaygroundEntry[] {
  return rows
    .filter((row) => row.name.trim().length > 0)
    .map((row) => ({ name: row.name, value: row.value, enabled: row.enabled }));
}
