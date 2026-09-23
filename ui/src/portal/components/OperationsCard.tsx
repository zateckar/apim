// The operations a definition declares, beside the definition on the workspace's Definition tab.
// Same parsing as the consumer's listing in the catalogue, so a publisher and a consumer see the
// same operation surface for the same API.

import { useMemo, useState } from 'react';
import { toolSelector } from '../../../../shared/mcp';
import { Panel, Skeleton, StatusChip } from '../../components';
import { schemaStateChip } from '../../lib/status';
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
function Count({ n, noun = 'operation' }: { n: number; noun?: string }) {
  return <span className="op-count">{n} {n === 1 ? noun : `${noun}s`}</span>;
}

/**
 * Whether one operation of the saved revision is validated — the operation index's `schemaState`,
 * which the editor payload carries (api-edit-properties, "Show the operations the definition
 * declares"). "Not validated" has to be visible rather than assumed, and it is a fact about the
 * definition in force, so it comes from the server rather than from re-reading the draft.
 */
export interface OperationValidation {
  id: string;
  method: string;
  template: string;
  selector?: string;
  schemaState: string;
}

/**
 * The saved state of one declared operation, found the way the gateway finds it: by method and path
 * template for REST, by operation name for SOAP, by selector for an MCP tool. `null` when the saved
 * revision has no such operation — it was added in this edit, or nothing is saved here yet.
 */
export function validationStateOf(
  validation: readonly OperationValidation[],
  match: { method?: string; path?: string; id?: string; selector?: string },
): string | null {
  const row = validation.find((entry) =>
    match.selector !== undefined
      ? entry.selector === match.selector
      : match.id !== undefined
        ? entry.id === match.id
        : entry.method.toUpperCase() === match.method?.toUpperCase() && entry.template === match.path,
  );
  return row?.schemaState ?? null;
}

/** The chip for one row, or a quiet word when the saved revision does not know the operation yet. */
function ValidationCell({ state, known }: { state: string | null; known: boolean }) {
  if (!known) return null;
  if (state === null) return <span className="op-faint">not saved yet</span>;
  return <StatusChip chip={schemaStateChip(state)} />;
}

/** Under the list, once: the chips describe what is saved, and an unsaved edit is not that. */
function ValidationNote({ known, edited }: { known: boolean; edited?: boolean }) {
  if (!known || !edited) return null;
  return <p className="op-note">Validation is shown for the definition as saved. Save to see it for this edit.</p>;
}

export function OperationsCard({
  doc,
  loading,
  error,
  onRetry,
  validation,
  edited,
}: {
  doc: unknown;
  loading: boolean;
  error?: boolean;
  onRetry?: () => void;
  /** The saved revision's states. Absent where nothing is saved (the publish wizard). */
  validation?: readonly OperationValidation[];
  edited?: boolean;
}) {
  const known = (validation?.length ?? 0) > 0;
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
                <ValidationCell
                  known={known}
                  state={validationStateOf(validation ?? [], { method: op.method, path: op.path })}
                />
                <I.ChevDown size={14} className={`op-row-chev ${expanded ? 'rot' : ''}`} />
              </button>
              {expanded && <OperationDetail op={op} />}
            </li>
          );
        })}
      </ul>
      <ValidationNote known={known} edited={edited} />
    </Panel>
  );
}

interface ManifestTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: unknown;
}

/** The tools an MCP manifest declares, from the draft on screen; nothing when it does not parse. */
export function toolsOf(doc: unknown): ManifestTool[] {
  const tools = (doc as { tools?: unknown } | null)?.tools;
  if (!Array.isArray(tools)) return [];
  return tools.filter((tool): tool is ManifestTool => typeof (tool as ManifestTool)?.name === 'string');
}

/**
 * An MCP server's tools, beside its manifest — what `OperationsCard` is for an OpenAPI document
 * (api-edit-properties, "The definition panel renders"). A tool is an operation to the gateway, one
 * `tools/call` selector each, so each carries the same validation chip; its input schema is what the
 * arguments are checked against, and a tool without one says so.
 */
export function ToolsCard({
  doc,
  validation,
  edited,
}: {
  doc: unknown;
  validation?: readonly OperationValidation[];
  edited?: boolean;
}) {
  const tools = useMemo(() => toolsOf(doc), [doc]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const known = (validation?.length ?? 0) > 0;
  if (!doc) return null;
  if (tools.length === 0) {
    return (
      <Panel title="Tools">
        <p className="op-note">This server declares no tools.</p>
      </Panel>
    );
  }
  return (
    <Panel title="Tools" flush actions={<Count n={tools.length} noun="tool" />}>
      <ul className="op-list">
        {tools.map((tool) => {
          const open = expanded === tool.name;
          return (
            <li key={tool.name}>
              <button
                type="button"
                className="op-row-toggle"
                aria-expanded={open}
                onClick={() => setExpanded(open ? null : tool.name)}
              >
                <div className="op-row-copy">
                  <div className="mono op-row-path">{tool.name}</div>
                  {(tool.title || tool.description) && (
                    <div className="op-row-summary">{tool.title || tool.description}</div>
                  )}
                </div>
                <ValidationCell
                  known={known}
                  state={validationStateOf(validation ?? [], { selector: toolSelector(tool.name) })}
                />
                <I.ChevDown size={14} className={`op-row-chev ${open ? 'rot' : ''}`} />
              </button>
              {open && (
                <div className="op-detail">
                  {tool.title && tool.description && (
                    <div className="op-detail-section">
                      <div className="op-detail-text">{tool.description}</div>
                    </div>
                  )}
                  <div className="op-detail-section">
                    <div className="op-detail-label">Input schema</div>
                    {tool.inputSchema ? (
                      <pre className="pre">{JSON.stringify(tool.inputSchema, null, 2)}</pre>
                    ) : (
                      <div className="op-detail-text op-faint">
                        This tool declares no input schema, so its arguments are not checked.
                      </div>
                    )}
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ul>
      <ValidationNote known={known} edited={edited} />
    </Panel>
  );
}

interface CardSkill {
  id: string;
  name?: string;
  description?: string;
  tags?: string[];
  examples?: string[];
}

/** The skills an A2A agent card declares, from the draft on screen. */
export function skillsOf(doc: unknown): CardSkill[] {
  const skills = (doc as { skills?: unknown } | null)?.skills;
  if (!Array.isArray(skills)) return [];
  return skills.filter((skill): skill is CardSkill => typeof (skill as CardSkill)?.id === 'string');
}

/**
 * An A2A agent's skills, beside its card. No validation chip: a skill is what the card says the
 * agent can do, not something a caller selects — every call is one of the A2A methods, and those
 * are validated whichever skill the agent uses to answer.
 */
export function SkillsCard({ doc }: { doc: unknown }) {
  const skills = useMemo(() => skillsOf(doc), [doc]);
  if (!doc) return null;
  if (skills.length === 0) {
    return (
      <Panel title="Skills">
        <p className="op-note">This agent's card declares no skills.</p>
      </Panel>
    );
  }
  return (
    <Panel title="Skills" flush actions={<Count n={skills.length} noun="skill" />}>
      <ul className="op-list">
        {skills.map((skill) => (
          <li key={skill.id} className="op-row-toggle op-row-static">
            <div className="op-row-copy">
              <div className="op-row-path">
                {skill.name ?? skill.id} <span className="mono op-faint">{skill.id}</span>
              </div>
              {skill.description && <div className="op-row-summary">{skill.description}</div>}
              {(skill.tags ?? []).length > 0 && (
                <div className="op-detail-chips">
                  {skill.tags!.map((tag) => (
                    <span key={tag} className="chip op-chip">{tag}</span>
                  ))}
                </div>
              )}
              {(skill.examples ?? []).length > 0 && (
                <div className="op-faint">For example: {skill.examples!.join(' · ')}</div>
              )}
            </div>
          </li>
        ))}
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
export function SoapOperationsCard({
  wsdl,
  loading,
  error,
  onRetry,
  validation,
  edited,
}: {
  wsdl: WsdlParseResult | null;
  loading: boolean;
  error?: boolean;
  onRetry?: () => void;
  validation?: readonly OperationValidation[];
  edited?: boolean;
}) {
  const known = (validation?.length ?? 0) > 0;
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
            <ValidationCell known={known} state={validationStateOf(validation ?? [], { id: op.name })} />
          </li>
        ))}
      </ul>
      <ValidationNote known={known} edited={edited} />
    </Panel>
  );
}
