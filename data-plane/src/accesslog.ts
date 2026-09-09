import { closeSync, existsSync, mkdirSync, openSync, renameSync, statSync, unlinkSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { MAX_LOGGED_BODY_BYTES } from "../../shared/config-doc.ts";

/**
 * Where the access log goes, and how it gets there.
 *
 * One JSON line per request, for every request. That is not a tuning decision — the estate keeps
 * these lines to answer "who called what, when" for compliance, so sampling them is not on the
 * table and the write is on the request path for every single request. What *was* on the table was
 * how much each line costs, and two things dominated:
 *
 *  - **A syscall per line.** `console.log` writes through immediately, so a gateway answering
 *    40,000 rejections a second made 40,000 writes a second, each one blocking the event loop for
 *    however long the log driver felt like taking. Here the lines are buffered and written once per
 *    `highWaterMark`, which is the same bytes in a few hundred times fewer calls.
 *  - **A `Date` per line.** `new Date().toISOString()` allocates and formats; the part that
 *    changes between two requests in the same millisecond is three digits.
 *
 * The trade the buffer makes is explicit: a process killed with `SIGKILL` loses whatever has not
 * been flushed. `flushIntervalMs` bounds that by time as well as by size and `close()` flushes, so
 * an orderly shutdown loses nothing — but a compliance log whose last quarter-second must survive
 * a hard kill is not a log any proxy writes through a buffer, and no tuning here changes that.
 *
 * **Rotation lives here rather than in `logrotate`** because the shipper reads the file this
 * process writes. Renaming and reopening is the mode a tailing shipper handles correctly: it keeps
 * reading the renamed inode to the end and then picks up the new file. Truncating in place — what
 * an external rotator does without `copytruncate` support on both sides — loses whatever the
 * shipper had not read yet.
 */

/** Big enough to amortise the write, small enough that a line is never long off disk. */
const DEFAULT_HIGH_WATER_MARK = 64 * 1024;

/** So a quiet gateway's line still appears promptly, rather than when the buffer happens to fill. */
const DEFAULT_FLUSH_INTERVAL_MS = 250;

/**
 * The cap on a captured body, re-exported from the contract both planes read. Bodies are captured
 * only under a temporary, per-API window, and even then only the front of them.
 */
export { MAX_LOGGED_BODY_BYTES };

let cachedSecond = -1;
let cachedPrefix = "";

/**
 * `new Date(ms).toISOString()`, without the `Date`. The first nineteen characters change once a
 * second and the rest is arithmetic, so a gateway at any interesting rate formats one timestamp a
 * second instead of one per request. `test/data-plane.test.ts` holds it to exact equality.
 */
export function logTimestamp(nowMs: number = Date.now()): string {
  const second = Math.floor(nowMs / 1000);
  if (second !== cachedSecond) {
    cachedSecond = second;
    cachedPrefix = new Date(second * 1000).toISOString().slice(0, 19);
  }
  return `${cachedPrefix}.${String(nowMs % 1000).padStart(3, "0")}Z`;
}

// --------------------------------------------------------------------------- redaction

/**
 * Query parameter names whose value never reaches a line, whatever the route calls them. The
 * route's own subscription-key parameter is redacted by name as well — this list is for the ones
 * nobody declared to this gateway: a token somebody put in a URL because it was easier.
 *
 * Matched case-insensitively and by whole name, because `sort_key` is not a key.
 */
const CREDENTIAL_PARAMS = new Set([
  "access_token",
  "api_key",
  "apikey",
  "auth",
  "code",
  "id_token",
  "key",
  "password",
  "refresh_token",
  "secret",
  "sig",
  "signature",
  "subscription_key",
  "token",
]);

export const REDACTED = "***";

/**
 * The query string as it may be written down: every credential-shaped parameter replaced by a
 * marker, so the line still shows that the parameter was present and never shows what it was.
 * `extra` is the route's own key parameter, which is a credential because this gateway says so
 * rather than because of what it is called.
 */
export function redactQuery(search: string, extra?: string | null): string {
  if (!search || search === "?") return "";
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const extraLower = extra?.toLowerCase();
  let touched = false;
  for (const name of [...params.keys()]) {
    const lower = name.toLowerCase();
    if (CREDENTIAL_PARAMS.has(lower) || lower === extraLower) {
      params.set(name, REDACTED);
      touched = true;
    }
  }
  const rendered = params.toString();
  if (!touched) return search.startsWith("?") ? search : `?${search}`;
  return rendered ? `?${rendered}` : "";
}

/**
 * JSON members whose *value* is replaced before a captured body is written down. A body capture is
 * a deliberate, time-boxed, audited act, and it still must not put a password in a log line that
 * outlives the window by however long the estate keeps its index.
 *
 * Deliberately a scan rather than a parse: the body may not be JSON, may not be valid, and is
 * already truncated to `MAX_LOGGED_BODY_BYTES` — so this has to work on a fragment, and a fragment
 * is exactly what a parser refuses. It over-matches in the direction of redacting too much, which
 * is the correct direction.
 */
const CREDENTIAL_MEMBERS =
  /"(password|passwd|pwd|secret|token|access_token|refresh_token|id_token|api_?key|authorization|client_secret|private_key)"(\s*:\s*)"(?:[^"\\]|\\.)*"/gi;

export function redactBody(text: string): string {
  return text.replace(CREDENTIAL_MEMBERS, (_match, name: string, gap: string) => `"${name}"${gap}"${REDACTED}"`);
}

/** The front of a body, decoded, redacted, and marked when there was more of it. */
export function bodyExcerpt(body: Uint8Array | string): { body: string; truncated: boolean } {
  const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
  const truncated = bytes.byteLength > MAX_LOGGED_BODY_BYTES;
  const head = truncated ? bytes.subarray(0, MAX_LOGGED_BODY_BYTES) : bytes;
  // `fatal: false`: a truncation lands mid-character sooner or later, and a replacement character
  // is a better answer than a thrown exception on the logging path.
  return { body: redactBody(new TextDecoder().decode(head)), truncated };
}

// --------------------------------------------------------------------------- sinks

interface Sink {
  write(line: string): void;
  flush(): void;
  close(): void;
  /** The rotation bounds, where there is a file to rotate. A no-op on stdout. */
  resize(maxBytes: number, keep: number): void;
}

/** The container's log driver reads this. Append-only by nature, so there is nothing to rotate. */
class StdoutSink implements Sink {
  private readonly sink = Bun.stdout.writer({ highWaterMark: DEFAULT_HIGH_WATER_MARK });

  constructor() {
    // Not a reason to keep the process alive: this is a side effect of serving.
    this.sink.unref?.();
  }

  write(line: string): void {
    this.sink.write(line);
  }

  flush(): void {
    this.sink.flush();
  }

  close(): void {
    this.flush();
  }

  /** Nothing to rotate: the container's log driver owns the file this writes into. */
  resize(): void {}
}

/**
 * An append-only file this process rotates itself.
 *
 * `O_APPEND` rather than a position, because the shipper is not the only reader and a rotation
 * must never be able to write over a line. One file per process: two gateways sharing a path would
 * interleave their buffers and race each other's rotation, which is why every path the compose
 * file suggests carries the instance name.
 */
class RotatingFileSink implements Sink {
  private fd: number;
  private size: number;
  private pending: string[] = [];
  private pendingBytes = 0;

  constructor(
    private readonly path: string,
    private maxBytes: number,
    private keep: number,
    private readonly highWaterMark: number,
  ) {
    mkdirSync(dirname(path), { recursive: true });
    this.fd = openSync(path, "a");
    this.size = this.currentSize();
  }

  private currentSize(): number {
    try {
      return statSync(this.path).size;
    } catch {
      return 0;
    }
  }

  write(line: string): void {
    this.pending.push(line);
    this.pendingBytes += Buffer.byteLength(line, "utf8");
    if (this.pendingBytes >= this.highWaterMark) this.flush();
  }

  flush(): void {
    if (this.pendingBytes === 0) return;
    const chunk = Buffer.from(this.pending.join(""), "utf8");
    this.pending = [];
    this.pendingBytes = 0;
    try {
      writeSync(this.fd, chunk);
      this.size += chunk.byteLength;
    } catch (err) {
      // A log that cannot be written is not a request that failed. Say so once per occurrence on
      // stderr — which is where a container's log driver is still listening — and carry on serving.
      console.error(`[dp] access log write failed: ${(err as Error).message}`);
      return;
    }
    if (this.size >= this.maxBytes) this.rotate();
  }

  /**
   * `access.log` → `access.log.1` → … → `access.log.<keep>`, oldest discarded. Renaming rather
   * than truncating is what lets a tailing shipper finish the file it is on before following the
   * new one.
   */
  private rotate(): void {
    try {
      closeSync(this.fd);
      const oldest = `${this.path}.${this.keep}`;
      if (existsSync(oldest)) unlinkSync(oldest);
      for (let n = this.keep - 1; n >= 1; n--) {
        const from = `${this.path}.${n}`;
        if (existsSync(from)) renameSync(from, `${this.path}.${n + 1}`);
      }
      renameSync(this.path, `${this.path}.1`);
    } catch (err) {
      console.error(`[dp] access log rotation failed: ${(err as Error).message}`);
    } finally {
      // Reopened whatever happened above: a failed rotation must not also stop the logging.
      this.fd = openSync(this.path, "a");
      this.size = this.currentSize();
    }
  }

  close(): void {
    this.flush();
    try {
      closeSync(this.fd);
    } catch {
      // Already gone.
    }
  }

  /**
   * A lowered size takes effect at the next flush rather than rotating here: rotation is what the
   * flush already does when the file is over the bound, and doing it from a settings change would
   * hand the shipper a rename it did not expect between two lines.
   */
  resize(maxBytes: number, keep: number): void {
    this.maxBytes = maxBytes;
    this.keep = keep;
  }
}

export interface AccessLogOptions {
  /** Absent means stdout, which is what a container without a mounted log volume wants. */
  path?: string;
  maxBytes?: number;
  keep?: number;
  highWaterMark?: number;
  flushIntervalMs?: number;
}

export class AccessLogWriter {
  private readonly sink: Sink;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Lines written since boot. Reported on `/healthz`, so "is it logging" is answerable. */
  lines = 0;
  readonly destination: string;

  constructor(options: AccessLogOptions = {}) {
    if (options.path) {
      this.sink = new RotatingFileSink(
        options.path,
        options.maxBytes ?? 128 * 1024 * 1024,
        options.keep ?? 5,
        options.highWaterMark ?? DEFAULT_HIGH_WATER_MARK,
      );
      this.destination = options.path;
    } else {
      this.sink = new StdoutSink();
      this.destination = "stdout";
    }
    const interval = options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
    if (interval > 0) {
      this.timer = setInterval(() => this.sink.flush(), interval);
      this.timer.unref?.();
    }
  }

  write(record: Record<string, unknown>): void {
    this.sink.write(`${JSON.stringify(record)}\n`);
    this.lines++;
  }

  flush(): void {
    this.sink.flush();
  }

  /** The rotation bounds are the fleet's, and change when a configuration document is activated. */
  resize(maxBytes: number, keep: number): void {
    this.sink.resize(maxBytes, keep);
  }

  close(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.sink.close();
  }
}
