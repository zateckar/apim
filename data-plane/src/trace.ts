import { randomBytes } from "node:crypto";

/**
 * W3C Trace Context, on the one hop this gateway is.
 *
 * The estate correlates a call across the portal, this gateway and the backend by `traceparent`,
 * so the gateway's job is the standard one: continue a trace it was given, start one it was not,
 * and hand the backend a `traceparent` naming *this* hop as the parent. Every log line carries the
 * trace id, which is what makes "show me everything that happened to this call" a query rather
 * than a reconstruction.
 *
 * `x-request-id` stays exactly as it was. It is this gateway's own identifier, it is what a
 * consumer quotes in a ticket, and it is on the response — where `traceparent` deliberately is
 * not, because the specification defines no response header and inventing one would be this
 * platform's convention wearing a standard's name.
 *
 * Only version `00` is understood. The specification says an unknown version with a parseable
 * prefix may be continued, but a gateway that guessed at a format it does not know would forward
 * a header it cannot honour; starting a fresh trace is the honest answer and costs one field.
 */

const VERSION = "00";
const TRACEPARENT = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;
const ZERO_TRACE = "00000000000000000000000000000000";
const ZERO_SPAN = "0000000000000000";

/** `tracestate` is vendor data this gateway neither reads nor writes, only carries. */
const MAX_TRACESTATE_BYTES = 512;

export interface TraceContext {
  traceId: string;
  /** This hop. Freshly minted on every request — it is what the backend sees as its parent. */
  spanId: string;
  /** The span that called us, or `null` when this gateway started the trace. */
  parentSpanId: string | null;
  /** The sampling flags byte, carried through unchanged when there was one. */
  flags: string;
  /** What to send to the backend. */
  header: string;
  /** Whether an inbound header was understood, which is the difference between joining and starting. */
  continued: boolean;
}

function hex(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}

/**
 * The trace this request belongs to. A malformed, all-zero or unknown-version `traceparent` starts
 * a new trace rather than being repaired: a trace id nobody else knows about is useless, and one
 * assembled out of a broken header is worse than useless because it looks like a correlation.
 */
export function traceContextFrom(header: string | null): TraceContext {
  const spanId = hex(8);
  const match = header ? TRACEPARENT.exec(header.trim()) : null;
  if (match && match[1] === VERSION && match[2] !== ZERO_TRACE && match[3] !== ZERO_SPAN) {
    const traceId = match[2]!;
    const parentSpanId = match[3]!;
    const flags = match[4]!;
    return {
      traceId,
      spanId,
      parentSpanId,
      flags,
      header: `${VERSION}-${traceId}-${spanId}-${flags}`,
      continued: true,
    };
  }
  const traceId = hex(16);
  // `01` — sampled. This gateway records every request it serves, so saying anything else would
  // describe a sampling decision it does not make.
  return {
    traceId,
    spanId,
    parentSpanId: null,
    flags: "01",
    header: `${VERSION}-${traceId}-${spanId}-01`,
    continued: false,
  };
}

/**
 * `tracestate` travels only with a trace that was continued: it is keyed to the trace it belongs
 * to, so forwarding it onto a trace this gateway just started would attach one vendor's state to
 * an unrelated call. Bounded, because it is caller-supplied and the specification's own limit is
 * advisory.
 */
export function traceStateFor(context: TraceContext, header: string | null): string | null {
  if (!context.continued || !header) return null;
  const value = header.trim();
  if (!value || Buffer.byteLength(value, "utf8") > MAX_TRACESTATE_BYTES) return null;
  return value;
}
