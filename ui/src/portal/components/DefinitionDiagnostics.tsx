// What is wrong with the definition in the editor, said while it is still being edited.
//
// The validator behind this has existed since the portal was ported, and nothing had ever rendered
// its output: `lintSource` was exported and never called, so the only thing that told an author
// their document was unacceptable was a 400 from `POST /api/publish`, after the wizard had closed.
// The two rules that reject real-world documents most often — it must be JSON, and every `$ref`
// must point inside it — were not even checked before this.
//
// A sub-section (`h4`) rather than a `Panel`: it always sits under the editor it judges, and both of
// the places that draw it — the publish wizard and the workspace's Definition panel — are already a
// panel. Two boxes, one inside the other, was the nesting the consistency pass removed.

import { useMemo } from 'react';
import { Notice, StatusChip } from '../../components';
import { diagnosticChip } from '../../lib/status';
import { convertSource, lintDefinition, type SpecDiagnostic } from '../lib/specValidate';

const ORDER = { error: 0, warning: 1, info: 2 } as const;

/** `['paths', '/pets', 'get']` reads as `paths./pets.get`, which is what the editor shows. */
function pathOf(diagnostic: SpecDiagnostic): string | null {
  if (!diagnostic.path || diagnostic.path.length === 0) return null;
  return diagnostic.path.join('.');
}

export function DefinitionDiagnostics({
  source,
  kind,
  onFix,
}: {
  source: string;
  kind: string;
  /** Absent when the reader may not edit: there is then nothing to offer, only something to say. */
  onFix?: (next: string) => void;
}) {
  // Only REST is linted here. A WSDL has its own parser and its own card, and MCP and A2A are
  // generated rather than authored, so an author-facing diagnostic would have nobody to address.
  const result = useMemo(
    () => (kind === 'rest' ? lintDefinition(source) : null),
    [source, kind],
  );
  if (!result || !source.trim()) return null;

  const sorted = [...result.diagnostics].sort((a, b) => ORDER[a.severity] - ORDER[b.severity]);
  const errors = sorted.filter((d) => d.severity === 'error').length;
  const warnings = sorted.filter((d) => d.severity === 'warning').length;

  if (sorted.length === 0) {
    // Said out loud rather than left blank. "No news" and "not checked" look identical otherwise,
    // and this section's whole purpose is to be the thing the author trusts before they publish.
    return (
      <section className="workspace-section definition-checks">
        <h4>Definition checks</h4>
        <Notice kind="ok">
          No problems found. These are the checks publishing runs; they look at the structure, not
          at every schema.
        </Notice>
      </section>
    );
  }

  return (
    <section className="workspace-section definition-checks">
      <h4>
        Definition checks · {errors} {errors === 1 ? 'error' : 'errors'}, {warnings}{' '}
        {warnings === 1 ? 'warning' : 'warnings'}
      </h4>
      {errors > 0 && (
        <Notice kind="error">
          Publishing refuses {errors === 1 ? 'a definition with this error' : 'a definition with these errors'}.
        </Notice>
      )}
      {/* The one problem with a one-click answer. Converting is offered rather than done, because
          re-emitting somebody's YAML rewrites their comments, their quoting and their key order —
          a thing to accept, not a thing to have happen. Not `primary`: the screen's one primary is
          its Save, and this is a step on the way to it. */}
      {result.convertible && onFix && (
        <div className="native-actions">
          <button
            type="button"
            className="btn"
            onClick={() => onFix(convertSource(source, 'yaml', 'json'))}
          >
            Convert this document to JSON
          </button>
          <span className="muted small">
            Comments and key order are not preserved by the conversion.
          </span>
        </div>
      )}
      <ul className="plain diagnostics">
        {sorted.map((diagnostic, index) => (
          <li key={index} className={`diagnostic sev-${diagnostic.severity}`}>
            <StatusChip chip={diagnosticChip(diagnostic.severity)} />
            <span className="diagnostic-body">
              <span>{diagnostic.message}</span>
              {(pathOf(diagnostic) || diagnostic.line !== undefined) && (
                <span className="muted small mono">
                  {pathOf(diagnostic) ?? ''}
                  {diagnostic.line !== undefined ? ` · line ${diagnostic.line}` : ''}
                </span>
              )}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
