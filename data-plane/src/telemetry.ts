import {
  addBuckets,
  bucketIndex,
  emptyBuckets,
  windowStartOf,
  type Outcome,
  type TelemetryReport,
  type TelemetrySeries,
} from "../../shared/telemetry.ts";

/**
 * Per-instance counters (plan G4). Everything here is bounded, and every bound has a defined
 * behaviour past it with a counter attached — silent truncation would read as "that traffic did
 * not happen".
 *
 * A request is attributed to the minute it **completed**, so a window that has closed can never
 * reopen. That is what lets the control plane replace rather than add on flush, which in turn is
 * what makes a re-sent report idempotent (review V1-01).
 */
export interface TelemetryOptions {
  maxSeries: number;
  maxWindowsPerReport: number;
}

interface Cell {
  count: number;
  durationMsSum: number;
  durationMsMax: number;
  bytesIn: number;
  bytesOut: number;
  buckets: number[];
  gatewayBuckets: number[];
  backendMsSum: number;
  backendCount: number;
}

export interface RecordInput {
  resourceId: string | null;
  subscriptionId: string | null;
  outcome: Outcome;
  status: number;
  /** Fractional milliseconds — see `roundMs`. Rounding here would erase the sub-ms buckets. */
  durationMs: number;
  /**
   * What the backend call took, when there was one: `null` for every request the gateway answered
   * itself. Never substituted with zero — "no backend" and "an instant backend" are different
   * facts, and only the first of them leaves `durationMs` entirely attributable to this gateway.
   */
  backendMs?: number | null;
  bytesIn: number;
  bytesOut: number;
  completedAtMs?: number;
}

const OVERFLOW = "overflow";

/**
 * The handle `record` hands back for the bytes, which are only known once the response body has
 * finished streaming. A function rather than an inline object literal because `record` returns it
 * from two places — the ordinary path and the one outcome that skips latency attribution — and two
 * copies of it would be two things to keep the same.
 */
function handleFor(cell: Cell): { addBytesOut: (bytes: number) => void } {
  return {
    addBytesOut: (bytes: number) => {
      cell.bytesOut += bytes;
    },
  };
}

export class InstanceTelemetry {
  /** windowStart → seriesKey → cell */
  private windows = new Map<string, Map<string, Cell>>();
  requestsTotal = 0;
  droppedSeries = 0;
  droppedWindows = 0;
  private batchSize: number;

  constructor(private readonly options: TelemetryOptions) {
    this.batchSize = options.maxWindowsPerReport;
  }

  /**
   * Both bounds are the fleet's decision and change when a document is activated. The windows
   * already accumulated are kept: they are traffic that happened, and a narrower series ceiling
   * applies to the *next* series rather than retroactively folding one that is already counted.
   *
   * `batchSize` follows `maxWindowsPerReport` only when it has not been halved by a 413 — that
   * halving is backpressure from the control plane about the size of one report, and a settings
   * change is not evidence the report will now fit.
   */
  resize(maxSeries: number, maxWindowsPerReport: number): void {
    const wasBackedOff = this.batchSize < this.options.maxWindowsPerReport;
    this.options.maxSeries = maxSeries;
    this.options.maxWindowsPerReport = maxWindowsPerReport;
    if (!wasBackedOff) this.batchSize = maxWindowsPerReport;
    else this.batchSize = Math.min(this.batchSize, maxWindowsPerReport);
  }

  /**
   * Counts the request as soon as its status is decided, and returns a handle for the bytes,
   * which are only known once the response body has finished streaming. Counting at completion
   * instead would lose every response whose body a client never reads — and would break the
   * identity the plan promises: requests sent = requestsTotal = the control plane's sum.
   *
   * `durationMs` therefore measures the gateway's own work up to the response, not the time
   * spent streaming a body to a slow client.
   */
  record(input: RecordInput): { addBytesOut: (bytes: number) => void } {
    this.requestsTotal++;
    const windowStart = windowStartOf(input.completedAtMs ?? Date.now());
    let window = this.windows.get(windowStart);
    if (!window) {
      window = new Map();
      this.windows.set(windowStart, window);
    }

    const resourceId = input.resourceId ?? "";
    const subscriptionId = input.subscriptionId ?? "";
    let key = `${resourceId}|${subscriptionId}|${input.outcome}|${input.status}`;
    if (!window.has(key) && this.seriesCount() >= this.options.maxSeries) {
      // Fold rather than drop: the request still shows up in the totals, and the counter says
      // how much detail was lost.
      this.droppedSeries++;
      key = `||${OVERFLOW}|0`;
    }

    let cell = window.get(key);
    if (!cell) {
      cell = {
        count: 0,
        durationMsSum: 0,
        durationMsMax: 0,
        bytesIn: 0,
        bytesOut: 0,
        buckets: emptyBuckets(),
        gatewayBuckets: emptyBuckets(),
        backendMsSum: 0,
        backendCount: 0,
      };
      window.set(key, cell);
    }
    cell.count++;
    cell.durationMsSum += input.durationMs;
    cell.durationMsMax = Math.max(cell.durationMsMax, input.durationMs);
    cell.bytesIn += input.bytesIn;
    cell.bytesOut += input.bytesOut;
    cell.buckets[bucketIndex(input.durationMs)]!++;

    /*
     * Latency attribution, and the one outcome it does not apply to.
     *
     * `stream-closed` reports how long a WebSocket or SSE connection stayed open. That is a real
     * and useful duration, and it is not a proxying latency: a two-hour stream would sit in the
     * last bucket of the gateway-cost histogram and move a p99 that is supposed to answer "what
     * does this gateway add to a request". So such a record counts toward requests, bytes, status
     * and total latency as it always has, and is **absent** from both attributions rather than
     * given a substituted value — the same rule the backend clock already follows. The percentile
     * is then taken over the requests that have an attribution, and the count that qualifies it is
     * reported beside it.
     */
    if (input.outcome === "stream-closed") return handleFor(cell);

    const backendMs = input.backendMs ?? null;
    if (backendMs !== null) {
      cell.backendMsSum += backendMs;
      cell.backendCount++;
    }
    // Subtracted per request, before bucketing, for the reason `gatewayBuckets` states: the
    // percentile of a difference is not the difference of two percentiles. Clamped at zero because
    // the two clocks are read either side of the response and a fast backend can legitimately land
    // a hair above the total.
    cell.gatewayBuckets[bucketIndex(Math.max(0, input.durationMs - (backendMs ?? 0)))]!++;

    return handleFor(cell);
  }

  private seriesCount(): number {
    let total = 0;
    for (const window of this.windows.values()) total += window.size;
    return total;
  }

  /**
   * Absolute values for every held window, oldest first. Nothing is cleared here: the instance
   * clears only what the control plane acknowledges, and only once the window has closed.
   */
  snapshot(): TelemetryReport {
    const ordered = [...this.windows.keys()].sort();
    if (ordered.length > this.batchSize) {
      // Past the cap the oldest windows are dropped for good — they would otherwise never be
      // sent, and pretending they are still queued would be worse than counting them.
      const excess = ordered.splice(0, ordered.length - this.batchSize);
      for (const windowStart of excess) {
        this.windows.delete(windowStart);
        this.droppedWindows++;
      }
    }

    return {
      droppedSeries: this.droppedSeries,
      droppedWindows: this.droppedWindows,
      windows: ordered.map((windowStart) => ({
        windowStart,
        series: [...this.windows.get(windowStart)!.entries()].map(([key, cell]) => {
          const [resourceId, subscriptionId, outcome, status] = key.split("|");
          const series: TelemetrySeries = {
            resourceId: resourceId!,
            subscriptionId: subscriptionId!,
            outcome: outcome as Outcome,
            status: Number(status),
            count: cell.count,
            durationMsSum: cell.durationMsSum,
            durationMsMax: cell.durationMsMax,
            bytesIn: cell.bytesIn,
            bytesOut: cell.bytesOut,
            buckets: addBuckets(emptyBuckets(), cell.buckets),
            gatewayBuckets: addBuckets(emptyBuckets(), cell.gatewayBuckets),
            backendMsSum: cell.backendMsSum,
            backendCount: cell.backendCount,
          };
          return series;
        }),
      })),
    };
  }

  /** Clears exactly the windows the control plane took responsibility for. */
  clearAccepted(windowStarts: string[]): void {
    for (const windowStart of windowStarts) this.windows.delete(windowStart);
    this.batchSize = this.options.maxWindowsPerReport;
  }

  /** Backpressure with a defined direction: a 413 means send less, not retry the same thing. */
  halveBatch(): number {
    this.batchSize = Math.max(1, Math.floor(this.batchSize / 2));
    return this.batchSize;
  }

  stats(): Record<string, number> {
    return {
      series: this.seriesCount(),
      pendingWindows: this.windows.size,
      droppedSeries: this.droppedSeries,
      droppedWindows: this.droppedWindows,
      batchSize: this.batchSize,
    };
  }
}
