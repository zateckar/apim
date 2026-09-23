// The operations a definition declares, beside the definition on the workspace's Definition tab.
// Same parsing as the consumer's listing in the catalogue, so a publisher and a consumer see the
// same operation surface for the same API.

import { useMemo, useState } from 'react';
import { Panel, Skeleton } from '../../components';
import * as I from '../icons';
import {
  extractOperations,
  type SpecOperation,
  type SpecParameter,
  type SpecResponse,
} from '../lib/specValidate';
import type { WsdlParseResult } from '../lib/wsdl';

// Shared loading/error shell: while the definition is still in flight the Operations section must
// stay visible with an explicit loading state — silently omitting it makes a half-loaded editor look
// fully loaded. Same for a failed definition load.
function OperationsShell({ state, onRetry }: { state: 'loading' | 'error'; onRetry?: () => void }) {
  return (
    <Panel title="Operations">
      {state === 'loading'
        ? <Skeleton rows={3} />
        : (
          <div className="op-note spread">
            <span>Couldn’t load the definition, so operations are unavailable.</span>
            {onRetry && <button type="button" className="btn sm" onClick={onRetry}>Retry</button>}
          </div>
        )}
    </Panel>
  );
}

/** "3 operations", drawn at the far end of the panel's head. */
function Count({ n }: { n: number }) {
  return <span className="op-count">{n} {n === 1 ? 'operation' : 'operations'}</span>;
}

export function OperationsCard({ doc, loading, error, onRetry }: { doc: unknown; loading: boolean; error?: boolean; onRetry?: () => void }) {
  const ops = useMemo(() => extractOperations(doc), [doc]);
  // One row may be expanded at a time; clicking the same row collapses it.
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  if (loading) return <OperationsShell state="loading" />;
  if (error && ops.length === 0) return <OperationsShell state="error" onRetry={onRetry} />;
  if (ops.length === 0) {
    // A LOADED definition with zero operations (e.g. `paths: {}`) must say so — an absent card is
    // indistinguishable from "not loaded yet". No doc at all (definition missing or unparseable)
    // hides the card: the definition checks beside it already say why.
    if (doc) {
      return (
        <Panel title="Operations">
          <p className="op-note">
            This definition declares no operations (<span className="mono">paths</span> is empty).
          </p>
        </Panel>
      );
    }
    return null;
  }
  return (
    <Panel title="Operations" flush actions={<Count n={ops.length} />}>
      <ul className="op-list">
        {ops.map((op, i) => {
          const key = `${op.method}:${op.path}:${i}`;
          const expanded = expandedKey === key;
          return (
            <li key={key}>
              <button
                type="button"
                onClick={() => setExpandedKey(expanded ? null : key)}
                aria-expanded={expanded}
                className="op-row-toggle"
              >
                <MethodBadge method={op.method} />
                <div className="op-row-copy">
                  <div className="mono op-row-path">{op.path}</div>
                  {(op.summary || op.description) && (
                    <div className="op-row-summary">{op.summary || op.description}</div>
                  )}
                </div>
                <I.ChevDown size={14} className={`op-row-chev ${expanded ? 'rot' : ''}`} />
              </button>
              {expanded && <OperationDetail op={op} />}
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}

// Expanded body for one operation row. Shows whatever metadata the spec actually carries —
// parameter / request body / response sections that don't apply to this operation are simply
// omitted, so a parameter-less `GET` doesn't render an empty Parameters block.
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
                <span key={ct} className="chip op-chip">{ct}</span>
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
          <div className="op-detail-text op-faint">No additional details declared in the spec.</div>
        </div>
      )}
    </div>
  );
}

function ParameterRow({ param }: { param: SpecParameter }) {
  const typePill = [param.schemaType, param.schemaFormat].filter(Boolean).join(' · ');
  return (
    <li className="op-param-row">
      <div className="op-param-head">
        <code className="op-detail-mono">{param.name}</code>
        <span className="chip op-chip">{param.in}</span>
        {typePill && <span className="op-faint">{typePill}</span>}
        {param.required && <span className="op-required">required</span>}
      </div>
      {param.description && <div className="op-row-summary">{param.description}</div>}
    </li>
  );
}

function ResponseRow({ resp }: { resp: SpecResponse }) {
  const code = /^\d{3}$/.test(resp.status) ? Number(resp.status) : null;
  // A declared status is a fact about the contract, not the state of anything — so `.chip` with
  // the estate's tone words, rather than a status chip that would claim something happened.
  const tone = code == null
    ? '' : code < 300 ? 'ok' : code < 400 ? 'info' : code < 500 ? 'warn' : 'err';
  return (
    <li className="op-response-row">
      <span className={`chip op-chip op-status ${tone}`}>{resp.status}</span>
      <div className="op-row-copy">
        {resp.description && <div className="op-response-text">{resp.description}</div>}
        {resp.contentTypes.length > 0 && (
          <div className="op-faint">{resp.contentTypes.join(' · ')}</div>
        )}
      </div>
    </li>
  );
}

// Postman-style method chip. Fixed colour mapping per HTTP verb (see `.method-chip` in
// brand.css). Falls back to a grey `head`-styled chip for any verb outside the standard set so log
// rows can pass in whatever the gateway recorded.
export function MethodBadge({ method }: { method: string | undefined }) {
  if (!method) return <span>—</span>;
  const upper = method.toUpperCase();
  const known = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'TRACE']);
  const cls = known.has(upper) ? upper.toLowerCase() : 'head';
  return <span className={`method-chip ${cls}`}>{upper}</span>;
}

/**
 * The SOAP equivalent of `OperationsCard`: one row per `<wsdl:portType><operation>`, each a `POST`
 * at the HTTP layer because the operation name travels inside the envelope. The service and port
 * topology the WSDL also carries is left out — the operation name is what a consumer calls, and the
 * rest is plumbing the SOAP client library hides.
 */
export function SoapOperationsCard({ wsdl, loading, error, onRetry }: { wsdl: WsdlParseResult | null; loading: boolean; error?: boolean; onRetry?: () => void }) {
  if (loading) return <OperationsShell state="loading" />;
  if (error && !wsdl) return <OperationsShell state="error" onRetry={onRetry} />;
  if (!wsdl || !wsdl.ok) return null;
  if (!wsdl.operations || wsdl.operations.length === 0) return null;
  return (
    <Panel title="Operations" flush actions={<Count n={wsdl.operations.length} />}>
      <ul className="op-list">
        {wsdl.operations.map((op) => (
          <li key={op.name} className="op-row-toggle op-row-static">
            <MethodBadge method="POST" />
            <div className="op-row-copy">
              <div className="mono op-row-path">{op.name}</div>
            </div>
          </li>
        ))}
      </ul>
    </Panel>
  );
}
