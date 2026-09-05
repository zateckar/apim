// Shared Operations / WSDL-services display. Used by both the
// publisher's Edit page (Definition tab + Properties tab aside) and
// the read-only API detail modal in Discover. Same parsing logic, same
// HTML, same CSS — both views render identical operation lists so a
// publisher and a consumer see the same operation surface for the same
// API.

import { useMemo, useState } from 'react';
import * as I from '../icons';
import {
  extractOperations,
  type SpecOperation,
  type SpecParameter,
  type SpecResponse,
} from '../lib/specValidate';
import type { WsdlParseResult } from '../lib/wsdl';

// Shared loading/error shell: while the definition is still in flight (it
// loads in PARALLEL with the snapshot/properties) the Operations section must
// stay visible with an explicit loading state — silently omitting it makes a
// half-loaded editor look fully loaded. Same for a failed definition load.
function OperationsShell({ state, onRetry }: { state: 'loading' | 'error'; onRetry?: () => void }) {
  return (
    <div className="card" data-testid={state === 'loading' ? 'operations-loading' : 'operations-error'}>
      <div className="card-head">
        <h3>Operations</h3>
      </div>
      <div className="card-body">
        {state === 'loading'
          ? <div className="empty" style={{ padding: '18px 0' }}><span className="spinner" /> Loading operations…</div>
          : (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, justifyContent: 'space-between', fontSize: 12.5, color: 'var(--fg-muted)' }}>
              <span>Couldn’t load the definition, so operations are unavailable.</span>
              {onRetry && <button type="button" className="btn sm" onClick={onRetry}>Retry</button>}
            </div>
          )}
      </div>
    </div>
  );
}

export function OperationsCard({ doc, loading, error, onRetry }: { doc: unknown; loading: boolean; error?: boolean; onRetry?: () => void }) {
  const ops = useMemo(() => extractOperations(doc), [doc]);
  // One row may be expanded at a time; clicking the same row collapses it.
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  if (loading) return <OperationsShell state="loading" />;
  if (error && ops.length === 0) return <OperationsShell state="error" onRetry={onRetry} />;
  if (ops.length === 0) {
    // A LOADED definition with zero operations (e.g. `paths: {}`) must say so —
    // an absent card is indistinguishable from "not loaded yet". No doc at all
    // (definition missing/unparseable) keeps the old hide-yourself behavior.
    if (doc) {
      return (
        <div className="card" data-testid="operations-none">
          <div className="card-head"><h3>Operations</h3></div>
          <div className="card-body" style={{ fontSize: 12.5, color: 'var(--fg-muted)' }}>
            This definition declares no operations (<span className="mono">paths</span> is empty).
          </div>
        </div>
      );
    }
    return null;
  }
  return (
    <div className="card">
      <div className="card-head">
        <h3>Operations</h3>
        <span style={{ fontSize: 11.5, color: 'var(--fg-subtle)' }}>
          {ops.length} {ops.length === 1 ? 'operation' : 'operations'}
        </span>
      </div>
      <div className="card-body" style={{ padding: 0 }}>
        <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {ops.map((op, i) => {
            const key = `${op.method}:${op.path}:${i}`;
            const expanded = expandedKey === key;
            return (
              <li
                key={key}
                style={{
                  borderBottom: i === ops.length - 1 ? 'none' : '1px solid var(--divider)',
                }}
              >
                <button
                  type="button"
                  onClick={() => setExpandedKey(expanded ? null : key)}
                  aria-expanded={expanded}
                  className="op-row-toggle"
                >
                  <MethodBadge method={op.method} />
                  <div style={{ flex: 1, minWidth: 0, textAlign: 'left' }}>
                    <div className="mono" style={{ fontSize: 12.5, fontWeight: 500, wordBreak: 'break-all' }}>
                      {op.path}
                    </div>
                    {(op.summary || op.description) && (
                      <div style={{ fontSize: 11, color: 'var(--fg-muted)', marginTop: 2 }}>
                        {op.summary || op.description}
                      </div>
                    )}
                  </div>
                  <I.ChevDown size={14} className={`op-row-chev ${expanded ? 'rot' : ''}`} />
                </button>
                {expanded && <OperationDetail op={op} />}
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}

// Expanded body for one operation row. Shows whatever metadata the
// spec actually carries — parameter / request body / response sections
// that don't apply to this operation are simply omitted, so a
// parameter-less `GET` doesn't render an empty Parameters block.
function OperationDetail({ op }: { op: SpecOperation }) {
  const hasParams = op.parameters.length > 0;
  const hasResponses = op.responses.length > 0;
  const hasRequestBody = !!op.requestBody;
  return (
    <div className="op-detail">
      {op.description && op.summary && (
        <div className="op-detail-section">
          <div className="op-detail-text">{op.description}</div>
        </div>
      )}
      {op.operationId && (
        <div className="op-detail-section">
          <div className="op-detail-label">Operation ID</div>
          <code className="op-detail-mono">{op.operationId}</code>
        </div>
      )}
      {hasParams && (
        <div className="op-detail-section">
          <div className="op-detail-label">Parameters</div>
          <ul className="op-detail-list">
            {op.parameters.map((p) => <ParameterRow key={`${p.in}:${p.name}`} param={p} />)}
          </ul>
        </div>
      )}
      {hasRequestBody && op.requestBody && (
        <div className="op-detail-section">
          <div className="op-detail-label">
            Request body{op.requestBody.required ? ' · required' : ''}
          </div>
          {op.requestBody.description && (
            <div className="op-detail-text">{op.requestBody.description}</div>
          )}
          {op.requestBody.contentTypes.length > 0 && (
            <div className="op-detail-chips">
              {op.requestBody.contentTypes.map((ct) => (
                <span key={ct} className="chip" style={{ fontSize: 10.5 }}>{ct}</span>
              ))}
            </div>
          )}
        </div>
      )}
      {hasResponses && (
        <div className="op-detail-section">
          <div className="op-detail-label">Responses</div>
          <ul className="op-detail-list">
            {op.responses.map((r) => <ResponseRow key={r.status} resp={r} />)}
          </ul>
        </div>
      )}
      {!hasParams && !hasRequestBody && !hasResponses && !op.description && !op.operationId && (
        <div className="op-detail-section">
          <div className="op-detail-text" style={{ color: 'var(--fg-subtle)' }}>
            No additional details declared in the spec.
          </div>
        </div>
      )}
    </div>
  );
}

function ParameterRow({ param }: { param: SpecParameter }) {
  const typePill = [param.schemaType, param.schemaFormat].filter(Boolean).join(' · ');
  return (
    <li className="op-param-row">
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, flexWrap: 'wrap' }}>
        <code className="op-detail-mono">{param.name}</code>
        <span className="chip" style={{ fontSize: 10, padding: '0 6px' }}>{param.in}</span>
        {typePill && <span style={{ fontSize: 11, color: 'var(--fg-subtle)' }}>{typePill}</span>}
        {param.required && <span style={{ fontSize: 10.5, color: 'var(--err)', fontWeight: 600 }}>required</span>}
      </div>
      {param.description && (
        <div style={{ fontSize: 11, color: 'var(--fg-muted)', marginTop: 2 }}>{param.description}</div>
      )}
    </li>
  );
}

function ResponseRow({ resp }: { resp: SpecResponse }) {
  const code = /^\d{3}$/.test(resp.status) ? Number(resp.status) : null;
  const tone = code == null
    ? '' : code < 300 ? 'ok' : code < 400 ? 'info' : code < 500 ? 'warn' : 'err';
  return (
    <li className="op-response-row">
      <span className={`chip ${tone}`} style={{ fontSize: 10.5, fontWeight: 600 }}>{resp.status}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        {resp.description && (
          <div style={{ fontSize: 11.5, color: 'var(--fg)' }}>{resp.description}</div>
        )}
        {resp.contentTypes.length > 0 && (
          <div style={{ fontSize: 10.5, color: 'var(--fg-subtle)', marginTop: 2 }}>
            {resp.contentTypes.join(' · ')}
          </div>
        )}
      </div>
    </li>
  );
}

// Postman-style method chip. Fixed colour mapping per HTTP verb (see
// `.method-chip` rules in styles.css). Falls back to a grey
// `head`-styled chip for any verb outside the standard set so log
// rows can pass in whatever the gateway recorded.
export function MethodBadge({ method }: { method: string | undefined }) {
  if (!method) return <span>—</span>;
  const upper = method.toUpperCase();
  const known = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'TRACE']);
  const cls = known.has(upper) ? upper.toLowerCase() : 'head';
  return <span className={`method-chip ${cls}`}>{upper}</span>;
}

// SOAP equivalent of OperationsCard. Renders the operations APIM
// generates per <wsdl:portType><operation> during import (each one
// shows up as a `POST <name>` row in APIM's Design tab) so the SOAP
// surface reads symmetric to the REST one. The WSDL services + port
// listing that used to render alongside this card is gone — the
// operation name is what consumers need to call; the service / port
// topology is plumbing the SOAP client library hides and surfacing
// it on the Properties tab just added noise.
//
// The component is named `WsdlServicesCard` for backwards-compat
// with its three call sites (Publish preview, Edit Properties aside,
// Discover detail modal); name's now slightly misleading but the
// rename can wait for a dedicated cleanup.
export function WsdlServicesCard({ wsdl, loading, error, onRetry }: { wsdl: WsdlParseResult | null; loading: boolean; error?: boolean; onRetry?: () => void }) {
  if (loading) return <OperationsShell state="loading" />;
  if (error && !wsdl) return <OperationsShell state="error" onRetry={onRetry} />;
  if (!wsdl || !wsdl.ok) return null;
  if (!wsdl.operations || wsdl.operations.length === 0) return null;
  return (
    <div className="card">
      <div className="card-head">
        <h3>Operations</h3>
        <span style={{ fontSize: 11.5, color: 'var(--fg-subtle)' }}>
          {wsdl.operations.length} {wsdl.operations.length === 1 ? 'operation' : 'operations'}
        </span>
      </div>
      <div className="card-body" style={{ padding: 0 }}>
        <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {wsdl.operations.map((op, i) => (
            <li
              key={op.name}
              className="op-row-toggle"
              style={{
                borderBottom: i === wsdl.operations.length - 1 ? 'none' : '1px solid var(--divider)',
                cursor: 'default',
              }}
            >
              {/* Every SOAP operation is POST at the HTTP layer (the
                  WSDL operation name lives inside the SOAP envelope
                  body) — we hardcode the method badge here for
                  symmetry with the REST OperationsCard. The earlier
                  `SOAPAction: <urn>` sub-line is gone: that value is
                  a namespace identifier the consumer's SOAP client
                  fills in automatically from the WSDL, not a callable
                  URL, so surfacing it on the row just added noise. */}
              <MethodBadge method="POST" />
              <div style={{ flex: 1, minWidth: 0, textAlign: 'left' }}>
                <div className="mono" style={{ fontSize: 12.5, fontWeight: 500, wordBreak: 'break-all' }}>
                  {op.name}
                </div>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
