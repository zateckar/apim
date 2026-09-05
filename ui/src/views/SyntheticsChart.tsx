import type { SyntheticsBucket } from "../api";
import { formatClock, formatDateTimeShort } from "../lib/datetime";

/**
 * One monitor's response time over the window: a hand-rolled line-and-area chart.
 *
 * Two decisions carry the whole thing.
 *
 * **`preserveAspectRatio="none"`** lets the plot stretch to whatever width the card renders at
 * without a layout pass, which is why the viewBox numbers below are arbitrary — only their ratios
 * matter. Nothing inside the SVG is text, because text in a non-uniformly stretched coordinate
 * space is text nobody can read; the axis labels are a separate HTML layer positioned by
 * percentage, and the "was down here" dots are too. An SVG `<circle>` in that space renders as an
 * ellipse.
 *
 * **A gap breaks the line.** Buckets where no check ran contribute nothing, and the path is split
 * into contiguous runs rather than bridged — a straight segment across a four-hour hole is a claim
 * about four hours nobody measured.
 */

const CHART_W = 600;
const CHART_H = 110;
const PLOT_TOP = 6;
const PLOT_BOTTOM = CHART_H - 6;

interface Point {
  /** The bucket's index, kept so a run can be told from a jump. */
  i: number;
  x: number;
  y: number;
}

/**
 * A peak rounded up to a readable step, so the axis says "500 ms" rather than "437 ms". Falls back
 * to a small ceiling when there is nothing to scale, which keeps an empty chart from dividing by
 * zero and drawing its baseline off the top.
 */
export function niceRoundUp(peak: number): number {
  if (peak <= 0) return 10;
  const magnitude = 10 ** Math.floor(Math.log10(peak));
  const norm = peak / magnitude;
  const nice = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10;
  return Math.round(nice * magnitude);
}

function segmentPath(segment: Point[]): string {
  return segment
    .map((point, index) => `${index === 0 ? "M" : "L"} ${point.x.toFixed(1)} ${point.y.toFixed(1)}`)
    .join(" ");
}

function segmentAreaPath(segment: Point[], baselineY: number): string {
  const first = segment[0]!;
  const last = segment[segment.length - 1]!;
  return `${segmentPath(segment)} L ${last.x.toFixed(1)} ${baselineY} L ${first.x.toFixed(1)} ${baselineY} Z`;
}

/** Contiguous runs only: a skipped bucket ends a segment rather than being drawn through. */
export function buildPaths(points: Point[]): { linePath: string; areaPath: string } {
  if (points.length === 0) return { linePath: "", areaPath: "" };
  const lineParts: string[] = [];
  const areaParts: string[] = [];
  let start = 0;
  for (let k = 1; k <= points.length; k++) {
    const atEnd = k === points.length;
    const isBreak = !atEnd && points[k]!.i !== points[k - 1]!.i + 1;
    if (atEnd || isBreak) {
      const segment = points.slice(start, k);
      lineParts.push(segmentPath(segment));
      areaParts.push(segmentAreaPath(segment, PLOT_BOTTOM));
      start = k;
    }
  }
  return { linePath: lineParts.join(" "), areaPath: areaParts.join(" ") };
}

function bucketTooltip(bucket: SyntheticsBucket): string {
  const time = formatDateTimeShort(bucket.at);
  const base = `${time} — avg ${bucket.avgDurationMs} ms`;
  return bucket.status === "down" ? `${base} — ${bucket.down}/${bucket.total} checks failed` : base;
}

export function SyntheticsChart({
  monitorId,
  buckets,
}: {
  monitorId: string;
  buckets: SyntheticsBucket[];
}) {
  const n = buckets.length;
  if (n === 0) return null;

  const measured = buckets.map((bucket) => bucket.avgDurationMs).filter((v): v is number => v !== null);
  const max = niceRoundUp(measured.length > 0 ? Math.max(...measured) : 0);

  const xFor = (i: number) => (n <= 1 ? CHART_W / 2 : (i / (n - 1)) * CHART_W);
  const yFor = (v: number) => PLOT_BOTTOM - (v / max) * (PLOT_BOTTOM - PLOT_TOP);
  const bottomPctFor = (v: number) => ((CHART_H - yFor(v)) / CHART_H) * 100;

  const points: Point[] = [];
  const downPoints: Point[] = [];
  buckets.forEach((bucket, i) => {
    if (bucket.avgDurationMs === null) return;
    const point = { i, x: xFor(i), y: yFor(bucket.avgDurationMs) };
    points.push(point);
    if (bucket.status === "down") downPoints.push(point);
  });
  const { linePath, areaPath } = buildPaths(points);

  const slotWidth = CHART_W / n;
  const yTicks = [0, max / 2, max];
  // At most six, always including the first and the last: more than that and they collide at the
  // widths this card actually renders at.
  const labelCount = Math.min(6, n);
  const labelIndexes = [
    ...new Set(
      labelCount <= 1
        ? [0]
        : Array.from({ length: labelCount }, (_, k) => Math.round((k * (n - 1)) / (labelCount - 1))),
    ),
  ];

  return (
    <div className="synth-chart">
      <div className="synth-chart-main">
        <div className="synth-chart-yaxis">
          {yTicks.map((value) => (
            <span key={value} className="synth-chart-ylabel" style={{ bottom: `${bottomPctFor(value)}%` }}>
              {Math.round(value)} ms
            </span>
          ))}
        </div>
        <div className="synth-chart-plot">
          <svg viewBox={`0 0 ${CHART_W} ${CHART_H}`} preserveAspectRatio="none" className="synth-chart-svg">
            {yTicks.map((value) => (
              <line
                key={value}
                x1={0}
                x2={CHART_W}
                y1={yFor(value)}
                y2={yFor(value)}
                className="synth-gridline"
              />
            ))}
            {areaPath && <path d={areaPath} className="synth-area" />}
            {linePath && <path d={linePath} className="synth-line" />}
            {buckets.map((bucket, i) =>
              bucket.avgDurationMs === null ? null : (
                <rect
                  key={bucket.at}
                  x={xFor(i) - slotWidth / 2}
                  y={0}
                  width={slotWidth}
                  height={CHART_H}
                  className="synth-hover-rect"
                >
                  <title>{bucketTooltip(bucket)}</title>
                </rect>
              ),
            )}
          </svg>
          <div className="synth-marker-layer" aria-hidden="true">
            {downPoints.map((point) => (
              <span
                key={point.i}
                className="synth-down-dot"
                style={{ left: `${(point.x / CHART_W) * 100}%`, top: `${(point.y / CHART_H) * 100}%` }}
              />
            ))}
          </div>
        </div>
      </div>
      <div className="synth-chart-xaxis-row">
        <div className="synth-chart-yaxis-spacer" />
        <div className="synth-chart-xaxis">
          {labelIndexes.map((i, k) => (
            <span
              key={i}
              className="synth-chart-xlabel"
              style={{
                left: `${(xFor(i) / CHART_W) * 100}%`,
                // The first and last labels are anchored inward so they do not hang off the card.
                transform: `translateX(${k === 0 ? "0%" : k === labelIndexes.length - 1 ? "-100%" : "-50%"})`,
              }}
            >
              {formatClock(buckets[i]!.at)}
            </span>
          ))}
        </div>
      </div>
      {/* The id is on the wrapper for the smoke suite to anchor on; nothing reads it at runtime. */}
      <span hidden data-monitor={monitorId} />
    </div>
  );
}
