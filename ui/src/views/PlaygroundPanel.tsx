import { formatDateTime, formatDuration } from "../lib/datetime";
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
  CopyButton,
  Panel,
  EmptyState,
  Link,
  Notice,
  Skeleton,
  StatusChip,
  Term,
  describe as describeError,
  envLabel,
  useAction,
  useAsync,
} from "../components";
import { httpStatusChip } from "../lib/status";

/**
 * A byte count as a person reads one: `812 B`, `4.2 KB`, `256 KB`. The body limit used to be
 * printed as `262,144 bytes`, which is a number to divide rather than a size to compare with.
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) {
    const kb = bytes / 1024;
    return `${kb < 10 && !Number.isInteger(kb) ? kb.toFixed(1) : Math.round(kb)} KB`;
  }
  const mb = bytes / (1024 * 1024);
  return `${mb < 10 && !Number.isInteger(mb) ? mb.toFixed(1) : Math.round(mb)} MB`;
}

/** A shell word, quoted so a space, a `&` or a `$` in it reaches curl as one argument. */
function quote(word: string): string {
  return `'${word.replace(/'/g, `'\\''`)}'`;
}

/**
 * The call on screen as one curl line a reader can paste into a terminal.
 *
 * The key is never in it — the browser does not have it — so where the policy wants one, the line
 * carries a placeholder in the header or parameter the policy names, which is exactly the one thing
 * the reader has to fill in from their subscription.
 */
export function curlFor(call: {
  method: string;
  url: string;
  pathParams: Record<string, string>;
  query: Array<{ name: string; value: string; enabled: boolean }>;
  headers: Array<{ name: string; value: string; enabled: boolean }>;
  body: string | null;
  key: { in: string; name: string } | null;
}): string {
  const path = call.url.replace(/\{([^}]+)\}/g, (whole, name: string) =>
    call.pathParams[name] ? encodeURIComponent(call.pathParams[name]!) : whole,
  );
  const params = call.query
    .filter((row) => row.enabled && row.name.trim())
    .map((row) => `${encodeURIComponent(row.name)}=${encodeURIComponent(row.value)}`);
  if (call.key?.in === "query") params.push(`${encodeURIComponent(call.key.name)}=<subscription-key>`);
  const parts = [`curl -X ${call.method}`, quote(params.length ? `${path}?${params.join("&")}` : path)];
  for (const row of call.headers.filter((entry) => entry.enabled && entry.name.trim())) {
    parts.push(`-H ${quote(`${row.name}: ${row.value}`)}`);
  }
  if (call.key?.in === "header") parts.push(`-H ${quote(`${call.key.name}: <subscription-key>`)}`);
  if (call.body) parts.push(`--data-raw ${quote(call.body)}`);
  return parts.join(" ");
}

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
  /**
   * The owner path `[P1-10]`: a key is required and this caller holds no subscription for it.
   * Opens a subscribe dialog in place — it must not navigate, because a button that navigates is
   * the thing the house rule forbids. Without it the panel links to the catalogue's subscribe
   * wizard instead, as a `Link`.
   */
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
      title={`Nothing to call in ${envLabel(environment)} yet`}
      // The problem document's `detail` sentence, without the `409 Conflict:` prefix `describe()`
      // adds — the remedy is in the sentence, and the status code is not news to anybody here.
      detail={message.replace(/^\d+ [^:]+: /, "")}
      // Named after the workspace tab it opens, which is the word the reader will see on arrival.
      action={
        <Link className="btn" to={to}>
          {where === "policies" ? "Open Policies" : "Open Properties"}
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

  // The two halves of the gateway list, told apart on the control rather than in a footnote: a
  // gateway's published hostname is the address a consumer is given, a replica is one process
  // behind it and is never published (`callableGateways`).
  const published = form.gateways.filter((entry) => entry.kind !== "replica");
  const replicas = form.gateways.filter((entry) => entry.kind === "replica");
  const gateway =
    form.gateways.find((entry) => entry.label === gatewayLabel) ?? form.gateways[0] ?? null;
  /** Exactly what the send will address, composed here from the same three parts the server joins. */
  const targetUrl =
    (gateway?.url ?? "") +
    (form.basePath === "/" ? "" : form.basePath) +
    (agentCard
      ? (form.agentCard?.path.replace(form.basePath, "") ?? "")
      : (operation?.template === "/" ? "" : (operation?.template ?? "")));
  const method = agentCard ? "GET" : (operation?.method ?? "GET");
  const curl = curlFor({
    method,
    url: targetUrl,
    pathParams: agentCard ? {} : pathParams,
    query: agentCard ? [] : query,
    headers: agentCard ? [] : headers,
    body: agentCard ? null : body || null,
    key: form.key,
  });

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
      ? `The body is ${formatBytes(bodyBytes)} and the limit is ${formatBytes(form.limits.maxBodyBytes)}. Send a smaller body, or use curl.`
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
          <div className="copy-row">
            <code className="pre">{form.streaming.command}</code>
            <CopyButton value={form.streaming.command} what="the command" />
          </div>
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
          {/* "New subscription", the same words the Subscriptions panel uses for the same act.
              It read "Subscribe an application to this API", which named the wrong object: what is
              subscribed to is the product carrying this API, which is what the dialog then asks. */}
          {onSubscribe ? (
            <button type="button" className="btn primary" onClick={onSubscribe}>
              New subscription
            </button>
          ) : (
            <Link className="btn primary" to={`/catalog/${resourceId}/subscribe`}>
              New subscription
            </Link>
          )}
        </Panel>
      )}

      <Panel title="Request" className="playground-request">
        {/* Four questions, one row: what to call, as whom, with which key, and through which
            gateway. They used to flow in a wrapping row of `flex: 1 1 220px` fields whose widths
            depended on how many of them a route happened to need, so the key select and its
            two-line hint pushed the pair beside it out of alignment. A grid puts each one in a
            column of its own and each label above its control. */}
        <div className="pg-controls">
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

          {/* Always offered, not only when there are several. Which gateway answered is part of
              reading the result — and with one gateway it is the line that finally says *where*
              the call went, which is the question a bare path could not answer. */}
          {form.gateways.length > 0 && (
            <div className="field">
              <label htmlFor="pg-gateway">Gateway</label>
              <select
                id="pg-gateway"
                value={gatewayLabel}
                aria-describedby={replicas.length > 0 ? "pg-gateway-help" : undefined}
                onChange={(event) => setGatewayLabel(event.target.value)}
              >
                {published.length > 0 && (
                  <optgroup label="Gateway">
                    {published.map((entry) => (
                      <option key={entry.label} value={entry.label}>
                        {entry.label}
                      </option>
                    ))}
                  </optgroup>
                )}
                {replicas.length > 0 && (
                  <optgroup label="One replica directly">
                    {replicas.map((entry) => (
                      <option key={entry.label} value={entry.label}>
                        {entry.label}
                      </option>
                    ))}
                  </optgroup>
                )}
              </select>
            </div>
          )}

          {needsKey && (
            <>
              <div className="field">
                <label htmlFor="pg-subscription">Call as</label>
                <select
                  id="pg-subscription"
                  value={subscriptionId}
                  onChange={(event) => { setSubscriptionId(event.target.value); setKeyKind("primary"); }}
                >
                  <option value="">Choose a subscription…</option>
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
                  <option value="primary">Primary</option>
                  <option
                    value="secondary"
                    disabled={!form.subscriptions.find((s) => s.id === subscriptionId)?.hasSecondary}
                  >
                    Secondary
                  </option>
                </select>
              </div>
            </>
          )}
        </div>

        {/* The target, composed by the platform, **whole**. There is no field to edit here, and
            that is the security property rather than a simplification (§5.3) — but showing only
            the path was a different thing: it left the one fact a reader needs to reproduce the
            call, or to tell DEV's answer from TEST's, off the screen entirely. */}
        <div className="pg-target copy-row">
          <span className="pg-method">{method}</span>
          <code className="mono pg-url">{targetUrl}</code>
          <CopyButton value={targetUrl} what="the address" />
          {/* The whole call, for a terminal. The address alone was what a reader copied and then
              rebuilt the rest of by hand — the headers, the query and the body the form already
              held. */}
          <CopyButton value={curl} label="Copy as curl" what="the call as a curl command" />
        </div>
        <p className="muted small pg-target-note">
          {gateway
            ? gateway.kind === "replica"
              ? `One replica behind ${envLabel(environment)}'s gateway — never an address to give a consumer.`
              : `${gateway.gateway}'s ${gateway.kind === "intranet" ? "intranet" : "published"} address`
            : "No gateway address"}{" "}
          · revision {form.rev}
          {form.host !== "*" && <> · Host {form.host}</>}
          {operation?.schemaState === "unsupported-schema" && (
            <> · the gateway cannot validate this operation</>
          )}
        </p>
        {/* Only where there is a replica to tell apart. Said on every console, it explained a
            distinction the gateway list did not contain. */}
        {replicas.length > 0 && (
          <p id="pg-gateway-help" className="hint pg-gateway-help">
            A replica is one gateway process, for checking a per-instance limit. Give consumers the
            gateway address, never a replica's.
          </p>
        )}
        {needsKey && (
          <p id="pg-key-help" className="hint">
            The key comes from the chosen subscription. Secondary is offered once it has a second key.
          </p>
        )}

        {!agentCard && operation && (
          <>
            {operation.summary && <p className="hint">{operation.summary}</p>}
            {operation.pathParams.length > 0 && (
              <div className="pg-path-params">
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

            {/* Side by side: two lists that are usually empty took two full-width blocks and most
                of the panel's height between them. */}
            <div className="pg-rows">
              <Rows title="Query" rows={query} onChange={setQuery} />
              <Rows title="Headers" rows={headers} onChange={setHeaders} />
            </div>

            {operation.body !== null && (
              <div className="field pg-body-field">
                <label htmlFor="pg-body">
                  Body <span className="muted">{operation.bodyKind === "xml" ? "XML" : "JSON"}</span>
                </label>
                <textarea
                  id="pg-body"
                  className="pg-body"
                  value={body}
                  aria-invalid={overBodyLimit ? true : undefined}
                  onChange={(event) => setBody(event.target.value)}
                />
                {/* Over the limit is an error and is drawn as one. It used to carry the `ok` class,
                    so the one line saying the send would be refused was the green one. */}
                <p className={overBodyLimit ? "small field-error" : "small muted"}>
                  {formatBytes(bodyBytes)} of {formatBytes(form.limits.maxBodyBytes)}
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

        <div className="action pg-send">
          <button className="btn primary" disabled={busy || blocked !== null} onClick={send} title={blocked ?? undefined}>
            {busy ? "Sending…" : "Send"}
          </button>
          {blocked && <span className="action-reason">{blocked}</span>}
          {/* Said beside the button, because a consumer who exhausts their own quota from a test
              console and cannot see why has been misled by us (§5.3). */}
          <span className="muted small">{form.note}</span>
        </div>
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
  const sent =
    `${request.method} ${request.path}${request.query ? `?${request.query}` : ""}\n` +
    Object.entries(request.headers)
      .map(([name, value]) => `${name}: ${value}`)
      .join("\n");
  const shown = response.body !== null ? format(response.body, response.headers["content-type"]) : null;

  return (
    <Panel
      title="Response"
      actions={shown !== null ? <CopyButton value={shown} label="Copy body" what="the response body" /> : undefined}
    >
      {response.error ? (
        // An outcome, not an error banner: the call happened, and this is what happened (§5.3).
        <Notice kind="error">{response.error}</Notice>
      ) : (
        <p className="inline">
          <StatusChip
            chip={httpStatusChip(response.status, {
              statusText: response.statusText,
              durationMs: response.durationMs,
            })}
          />
          <span className="muted small">
            {response.statusText} · {formatDuration(response.durationMs)} · {formatBytes(response.bytes)} ·
            via {request.gateway.label}
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

      <details className="pg-sent">
        <summary className="muted small">What was sent</summary>
        <div className="copy-row">
          <code className="pre">{sent}</code>
          <CopyButton value={sent} what="the request as sent" />
        </div>
        <p className="muted small">
          The key is not in this list, and never was in your browser: the portal injected it on the
          way out.
        </p>
      </details>

      {shown !== null && (
        <>
          <div className="pre">{shown}</div>
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
  // The delete had no error handling at all: a refused or failed request did nothing, and the row
  // stayed where it was with no word about why. It is an action like any other now, and its failure
  // is said at the top of the list it failed on.
  const remove = useAction();
  // A history that failed to load is not a history that is empty, and the difference matters to
  // somebody looking for a call they know they made.
  if (history.error) return <Notice kind="error">Your calls could not be listed: {history.error}</Notice>;
  if (!history.data || history.data.items.length === 0) return null;

  return (
    <Panel
      title="Your calls"
      hint={`The last ${history.data.cap} you made, across every environment, kept for ${history.data.retentionDays} days. Only you can see them.`}
    >
      <Notice kind="error">{remove.error}</Notice>
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
                <span className="chip">{envLabel(entry.environment)}</span>
              </td>
              <td className="mono small">
                {entry.method} {entry.path}
                {entry.query.length > 0 && "?…"}
              </td>
              <td>
                <StatusChip
                  chip={httpStatusChip(entry.status ?? null, {
                    statusText: entry.statusText,
                    durationMs: entry.durationMs,
                    error: entry.error,
                  })}
                />
              </td>
              <td className="right">
                {/* Not a typed confirmation: a row of the caller's own console history is a record,
                    not a thing anybody depends on (api-testing-playground, History is cleared). */}
                <span className="pg-history-actions">
                  <button
                    type="button"
                    className="btn ghost sm"
                    disabled={!entry.replayable}
                    onClick={() => onLoad(entry)}
                  >
                    Load
                  </button>
                  <button
                    type="button"
                    className="btn sm danger"
                    disabled={remove.busy}
                    aria-label={`Delete the ${entry.method} ${entry.path} call from your history`}
                    onClick={() =>
                      void remove
                        .run(() => api.del(`/api/playground/history/${entry.id}`))
                        .then((ok) => ok && onChanged())
                    }
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
      <p className="muted small">Load fills the form above; sending it is a new call.</p>
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
  const noun = title === "Headers" ? "header" : "parameter";
  return (
    <div className="pg-kv-block">
      <div className="spread">
        <strong className="small">{title}</strong>
        <button
          type="button"
          className="btn ghost sm"
          onClick={() => onChange([...rows, { name: "", value: "", enabled: true }])}
        >
          Add {noun}
        </button>
      </div>
      {rows.length === 0 ? (
        <p className="muted small">None.</p>
      ) : (
        rows.map((row, index) => (
          <div className="row pg-kv-line" key={index}>
            <label className="check-inline">
              <input
                type="checkbox"
                aria-label={`Send ${row.name || `this ${noun}`}`}
                checked={row.enabled}
                onChange={(event) => replace(index, { ...row, enabled: event.target.checked })}
              />
            </label>
            <input
              aria-label={`${title} name`}
              value={row.name}
              placeholder="name"
              onChange={(event) => replace(index, { ...row, name: event.target.value })}
            />
            <input
              aria-label={`${title} value`}
              value={row.value}
              placeholder="value"
              onChange={(event) => replace(index, { ...row, value: event.target.value })}
            />
            <button
              type="button"
              className="btn ghost sm"
              onClick={() => onChange(rows.filter((_, i) => i !== index))}
            >
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