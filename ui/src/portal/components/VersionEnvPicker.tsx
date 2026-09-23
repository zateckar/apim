import type { ReactNode } from "react";
import * as I from "../icons";
import { envLabel } from "../../components";

/**
 * The version selector and the promotion-chain buttons, as one cluster.
 *
 * Two controls that answer two questions in the same glance: *which version* (a solid rectangle,
 * the heaviest thing on the row) and *where is it live* (one chevron per environment, laid out in
 * promotion order). The shapes are deliberate — the rectangle can never be mistaken for an
 * environment, and the chevrons nest into each other so the row reads as DEV → TEST → PROD rather
 * than as three unrelated buttons.
 *
 * Every slot in the chain is always drawn, including the ones this version is *not* published in.
 * A missing slot would hide the promotion gap, which is the single most useful thing this control
 * says.
 *
 * The chevrons are SVG `<path>`s rather than CSS `clip-path`: a stroke on a path traces the shape
 * itself at any size, so the hover border follows the chevron's real edge instead of a rectangle
 * behind it. Corners are rounded **only** where two axis-aligned edges meet — the bounding-box
 * corners. Rounding the forward tip would bulge the arc past the vertex and make the triangle look
 * larger than the body; rounding the back notch would turn the V into a U and break the silhouette.
 */

const VERTICES = {
  first: [[0, 0], [86, 0], [100, 14], [86, 28], [0, 28]],
  middle: [[0, 0], [86, 0], [100, 14], [86, 28], [0, 28], [14, 14]],
  last: [[0, 0], [100, 0], [100, 28], [0, 28], [14, 14]],
} as const;

type Position = keyof typeof VERTICES;

function chevronPath(vertices: ReadonlyArray<ReadonlyArray<number>>, radius: number): string {
  const n = vertices.length;
  if (n < 3) return "";
  const segments: string[] = [];
  for (let i = 0; i < n; i++) {
    const previous = vertices[(i - 1 + n) % n]!;
    const current = vertices[i]!;
    const next = vertices[(i + 1) % n]!;
    const dx1 = previous[0]! - current[0]!;
    const dy1 = previous[1]! - current[1]!;
    const dx2 = next[0]! - current[0]!;
    const dy2 = next[1]! - current[1]!;
    // Both edges axis-aligned means this is a corner of the bounding box, and only those round.
    if ((dx1 === 0 || dy1 === 0) && (dx2 === 0 || dy2 === 0)) {
      const len1 = Math.hypot(dx1, dy1);
      const len2 = Math.hypot(dx2, dy2);
      const r = Math.min(radius, len1 / 2.1, len2 / 2.1);
      const ax = current[0]! + (dx1 / len1) * r;
      const ay = current[1]! + (dy1 / len1) * r;
      const bx = current[0]! + (dx2 / len2) * r;
      const by = current[1]! + (dy2 / len2) * r;
      segments.push(`${i === 0 ? "M" : "L"} ${ax.toFixed(2)} ${ay.toFixed(2)}`);
      segments.push(`A ${r.toFixed(2)} ${r.toFixed(2)} 0 0 1 ${bx.toFixed(2)} ${by.toFixed(2)}`);
    } else {
      segments.push(`${i === 0 ? "M" : "L"} ${current[0]!.toFixed(2)} ${current[1]!.toFixed(2)}`);
    }
  }
  segments.push("Z");
  return segments.join(" ");
}

const PATHS: Record<Position, string> = {
  first: chevronPath(VERTICES.first, 2),
  middle: chevronPath(VERTICES.middle, 2),
  last: chevronPath(VERTICES.last, 2),
};

export function VersionEnvPicker({
  selectedVersion,
  versions,
  chain,
  availableEnvironments,
  loadingEnvironments,
  failedEnvironments,
  onSelectVersion,
  onSelectEnvironment,
  hideVersion = false,
  trailing,
}: {
  selectedVersion: string;
  /** Every published version, latest first. */
  versions: readonly string[];
  /** The promotion chain, in order. Comes from `/api/meta`, so a two-stage estate draws two. */
  chain: readonly string[];
  availableEnvironments: ReadonlySet<string>;
  /** Environments whose answer has not arrived. Drawn as a third state, never as "not published". */
  loadingEnvironments?: ReadonlySet<string>;
  /** Environments whose read failed, with the reason. Availability is *unknown*, not false. */
  failedEnvironments?: ReadonlyMap<string, string>;
  onSelectVersion: (version: string) => void;
  onSelectEnvironment: (environment: string) => void;
  /** MCP servers and A2A agents have no version dimension; the footprint is still reserved. */
  hideVersion?: boolean;
  trailing?: ReactNode;
}) {
  const many = versions.length > 1;
  return (
    <div className="version-env-picker">
      {hideVersion ? (
        // An invisible placeholder of exactly the picker's width, so the chevrons of a versionless
        // row still line up with every other row's.
        <span className="version-picker version-picker-placeholder" aria-hidden="true">
          <span className="version-picker-value">v1</span>
          <span className="version-picker-chev" data-hidden="true">
            <I.ChevDown size={12} />
          </span>
        </span>
      ) : many ? (
        <label className="version-picker" data-multi="true" title="Choose a version">
          <span className="version-picker-value">{selectedVersion || "(no version)"}</span>
          <span className="version-picker-chev" aria-hidden="true">
            <I.ChevDown size={12} />
          </span>
          <select
            className="version-picker-select"
            value={selectedVersion}
            aria-label="API version"
            onChange={(event) => onSelectVersion(event.target.value)}
          >
            {versions.map((version) => (
              <option key={version} value={version}>
                {version || "(no version)"}
              </option>
            ))}
          </select>
        </label>
      ) : (
        // One version is a fact, not a choice, so it is not a `label` — a `label` wrapping no
        // control is a promise of something to operate that this row does not have. The chevron
        // stays in the markup, hidden, so the picker's width — and therefore where the environment
        // chevrons start — is identical on every row.
        <span className="version-picker" data-multi="false" title="Only one version is published">
          <span className="version-picker-value">{selectedVersion || "(no version)"}</span>
          <span className="version-picker-chev" data-hidden="true" aria-hidden="true">
            <I.ChevDown size={12} />
          </span>
        </span>
      )}
      <div className="env-buttons">
        {chain.map((environment, index) => {
          // Precedence: a failed read beats a pending one, and both beat "not published" — the
          // difference between "we do not know" and "it is not there" is the whole point.
          const failure = failedEnvironments?.get(environment);
          const failed = failure !== undefined;
          const loading = !failed && (loadingEnvironments?.has(environment) ?? false);
          const available = !failed && !loading && availableEnvironments.has(environment);
          const position: Position =
            index === 0 ? "first" : index === chain.length - 1 ? "last" : "middle";
          const state = failed ? "failed" : loading ? "loading" : available ? "available" : "unavailable";
          const title = failed
            ? `${envLabel(environment)} could not be read — ${failure}`
            : loading
              ? `Checking ${envLabel(environment)}…`
              : available
                ? `Open ${envLabel(environment)}`
                : `Not published on ${envLabel(environment)}`;
          return (
            <span
              key={environment}
              className="env-btn-cell"
              data-available={available ? "true" : "false"}
              data-loading={loading ? "true" : undefined}
              data-failed={failed ? "true" : undefined}
              data-position={position}
            >
              <button
                type="button"
                className={`env-btn ${state}`}
                disabled={!available}
                data-available={available ? "true" : "false"}
                data-loading={loading ? "true" : undefined}
                data-failed={failed ? "true" : undefined}
                data-position={position}
                title={title}
                onClick={() => available && onSelectEnvironment(environment)}
              >
                <svg className="env-btn-shape" viewBox="0 0 100 28" preserveAspectRatio="none" aria-hidden="true">
                  <path d={PATHS[position]} />
                </svg>
                <span className="env-btn-label">{envLabel(environment)}</span>
              </button>
            </span>
          );
        })}
      </div>
      {trailing}
    </div>
  );
}
