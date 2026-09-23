import { useEffect, useRef, useState } from "react";
import type { LogHistogram } from "../api";
import { Notice } from "../components";
import { formatClock, formatDateTimeShort } from "../lib/datetime";

/**
 * The request timeline over the Logs table: one stacked bar per bucket, OK / 4xx / 5xx.
 *
 * Hand-rolled SVG rather than a charting dependency, and the same discipline the rest of the
 * portal's charts use — the `<svg>` stretches with `preserveAspectRatio="none"` and carries **no
 * text**, so nothing is distorted; the axis labels are an HTML layer beside it that does not
 * stretch.
 *
 * Dragging across the plot selects a bucket-snapped range; a drag under four pixels counts as a
 * click and zooms to the one bucket under it; Escape abandons a drag in progress. The range state
 * belongs to the parent, so zooming out is a callback rather than something this component knows.
 */

const CHART_W = 600;
const CHART_H = 90;
const PLOT_TOP = 4;
const PLOT_BOTTOM = CHART_H - 2;

/**
 * A y-axis maximum a person can read. The raw peak gives an axis labelled `1,447`; this rounds up
 * the ladder to the next 1 / 2 / 2.5 / 5 / 10 times a power of ten.
 */
function niceCeiling(peak: number): number {
  if (peak <= 0) return 10;
  const magnitude = Math.pow(10, Math.floor(Math.log10(peak)));
  const normalised = peak / magnitude;
  const nice = normalised <= 1 ? 1 : normalised <= 2 ? 2 : normalised <= 2.5 ? 2.5 : normalised <= 5 ? 5 : 10;
  return Math.round(nice * magnitude);
}

interface Drag {
  startFraction: number;
  endFraction: number;
  pixelWidth: number;
}

export function LogsHistogram({
  data,
  loading,
  error,
  onSelectRange,
  onZoomOut,
}: {
  data: LogHistogram | null;
  loading: boolean;
  error: string | null;
  onSelectRange: (fromMs: number, toMs: number) => void;
  onZoomOut: () => void;
}) {
  const plot = useRef<HTMLDivElement | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);

  useEffect(() => {
    if (!drag) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setDrag(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drag]);

  // The one place the timeline's failure is said. The panel above it used to print the same error
  // in a banner as well, so one failed request read as two problems.
  if (error) return <Notice kind="error">The timeline could not be drawn: {error}</Notice>;
  if (!data && loading) return <div className="logs-hist-skeleton" aria-hidden="true" />;
  if (!data) return null;

  const buckets = data.buckets ?? [];
  const count = buckets.length;
  const intervalMs = data.intervalSec * 1000;
  const peak = count === 0 ? 0 : Math.max(...buckets.map((b) => b.total));
  const max = niceCeiling(peak);
  const slot = count === 0 ? CHART_W : CHART_W / count;
  const heightOf = (value: number) => (value / max) * (PLOT_BOTTOM - PLOT_TOP);
  // A non-zero class stays visible. One 5xx among six hundred OK calls is sub-pixel drawn to
  // scale, and an invisible error segment is precisely what this chart exists to show.
  const segment = (value: number) => (value > 0 ? Math.max(heightOf(value), 1.8) : 0);
  const ticks = [0, max / 2, max];

  function fractionAt(clientX: number): number {
    const rect = plot.current!.getBoundingClientRect();
    return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
  }

  function onPointerDown(event: React.PointerEvent<HTMLDivElement>) {
    if (count === 0 || event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const fraction = fractionAt(event.clientX);
    setDrag({
      startFraction: fraction,
      endFraction: fraction,
      pixelWidth: plot.current!.getBoundingClientRect().width,
    });
  }

  function onPointerUp() {
    if (!drag || count === 0) {
      setDrag(null);
      return;
    }
    const low = Math.min(drag.startFraction, drag.endFraction);
    const high = Math.max(drag.startFraction, drag.endFraction);
    setDrag(null);
    const startOf = (index: number) => Date.parse(buckets[index]!.at);
    if ((high - low) * drag.pixelWidth < 4) {
      const index = Math.min(count - 1, Math.floor(((low + high) / 2) * count));
      onSelectRange(startOf(index), startOf(index) + intervalMs);
      return;
    }
    const first = Math.min(count - 1, Math.floor(low * count));
    const last = Math.max(first, Math.min(count - 1, Math.ceil(high * count) - 1));
    onSelectRange(startOf(first), startOf(last) + intervalMs);
  }

  // Six labels at most, always including the first and the last. The clock alone below a day;
  // once the window crosses one, the date has to be there or two days read as one.
  const wide = Date.parse(data.window.to) - Date.parse(data.window.from) > 86_400_000;
  const label = (iso: string) => (wide ? formatDateTimeShort(iso) : formatClock(iso));
  const labelCount = Math.min(6, Math.max(1, count));
  const labelled = [
    ...new Set(
      labelCount <= 1
        ? [0]
        : Array.from({ length: labelCount }, (_, k) => Math.round((k * (count - 1)) / (labelCount - 1))),
    ),
  ];

  const selectionLeft = drag ? Math.min(drag.startFraction, drag.endFraction) * 100 : 0;
  const selectionWidth = drag ? Math.abs(drag.endFraction - drag.startFraction) * 100 : 0;

  return (
    <div className={`logs-hist${loading ? " stale" : ""}`}>
      <div className="logs-hist-head">
        <span className="logs-hist-title">Timeline</span>
        <span className="logs-hist-legend" aria-hidden="true">
          <span className="sw ok" /> OK <span className="sw warn" /> 4xx <span className="sw err" /> 5xx
        </span>
        <span className="logs-hist-hint">drag to zoom</span>
        <button className="btn ghost sm" onClick={onZoomOut} title="Double the time range">
          Zoom out
        </button>
      </div>
      <div className="logs-hist-main">
        {/* The only inline styles on the workspace, and deliberately so: each label's offset is
            computed from the data, and a class cannot carry a number it does not know. */}
        <div className="logs-hist-yaxis">
          {ticks.map((value) => (
            <span
              key={value}
              className="logs-hist-ylabel"
              style={{
                bottom: `${((heightOf(value) + (CHART_H - PLOT_BOTTOM)) / CHART_H) * 100}%`,
              }}
            >
              {Math.round(value).toLocaleString()}
            </span>
          ))}
        </div>
        <div
          ref={plot}
          className="logs-hist-plot"
          onPointerDown={onPointerDown}
          onPointerMove={(event) => drag && setDrag({ ...drag, endFraction: fractionAt(event.clientX) })}
          onPointerUp={onPointerUp}
        >
          <svg viewBox={`0 0 ${CHART_W} ${CHART_H}`} preserveAspectRatio="none" className="logs-hist-svg">
            {ticks.map((value) => (
              <line
                key={value}
                x1={0}
                x2={CHART_W}
                y1={PLOT_BOTTOM - heightOf(value)}
                y2={PLOT_BOTTOM - heightOf(value)}
                className="logs-hist-gridline"
              />
            ))}
            {buckets.map((bucket, index) => {
              const x = index * slot + slot * 0.07;
              const width = slot * 0.86;
              const ok = segment(bucket.ok);
              const client = segment(bucket.clientError);
              const server = segment(bucket.serverError);
              const endIso = new Date(Date.parse(bucket.at) + intervalMs).toISOString();
              return (
                <g key={bucket.at}>
                  {bucket.ok > 0 && (
                    <rect x={x} width={width} y={PLOT_BOTTOM - ok} height={ok} className="logs-hist-bar-ok" />
                  )}
                  {bucket.clientError > 0 && (
                    <rect
                      x={x}
                      width={width}
                      y={PLOT_BOTTOM - ok - client}
                      height={client}
                      className="logs-hist-bar-warn"
                    />
                  )}
                  {bucket.serverError > 0 && (
                    <rect
                      x={x}
                      width={width}
                      y={PLOT_BOTTOM - ok - client - server}
                      height={server}
                      className="logs-hist-bar-err"
                    />
                  )}
                  <rect x={index * slot} width={slot} y={0} height={CHART_H} className="logs-hist-hover">
                    <title>
                      {`${formatDateTimeShort(bucket.at)} – ${formatClock(endIso)} — ${bucket.total} ` +
                        `request${bucket.total === 1 ? "" : "s"} · ok ${bucket.ok} · 4xx ${bucket.clientError}` +
                        ` · 5xx ${bucket.serverError}` +
                        (bucket.p95Ms === null ? "" : ` · p95 ${bucket.p95Ms} ms`)}
                    </title>
                  </rect>
                </g>
              );
            })}
          </svg>
          {drag && selectionWidth > 0 && (
            <div
              className="logs-hist-brush"
              style={{ left: `${selectionLeft}%`, width: `${selectionWidth}%` }}
              aria-hidden="true"
            />
          )}
          {count === 0 && <div className="logs-hist-note in-plot">No traffic in the selected range.</div>}
        </div>
      </div>
      <div className="logs-hist-xaxis-row">
        <div className="logs-hist-yaxis-spacer" />
        <div className="logs-hist-xaxis">
          {count > 0 &&
            labelled.map((index, position) => (
              <span
                key={index}
                className="logs-hist-xlabel"
                style={{
                  left: `${((index * slot + slot / 2) / CHART_W) * 100}%`,
                  transform: `translateX(${position === 0 ? "0%" : position === labelled.length - 1 ? "-100%" : "-50%"})`,
                }}
              >
                {label(buckets[index]!.at)}
              </span>
            ))}
        </div>
      </div>
    </div>
  );
}
