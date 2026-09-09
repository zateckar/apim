import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccessLogWriter } from "../data-plane/src/accesslog.ts";
import { DEFAULT_GRACE_MS, drain, onShutdown } from "../shared/shutdown.ts";
import { makeCp, makeDp, publishApi, serveCp, startBackend, type TestCp } from "./helpers.ts";

/**
 * Orderly shutdown.
 *
 * The defect these guard against was not a logic error anywhere — it was the absence of a
 * `process.on("SIGTERM")` in either plane, which on PID 1 means the kernel discards the signal and
 * the container runtime hard-kills after its grace period. Every restart was therefore the SIGKILL
 * case, and the access log's buffered tail — a compliance record — went with it.
 *
 * So the first assertion here is deliberately about a listener existing rather than about
 * behaviour: it is the one fact whose absence caused the outage, and the one a future refactor
 * could quietly remove without failing anything else.
 */

let logDir: string;

beforeAll(() => {
  logDir = mkdtempSync(join(tmpdir(), "apim-shutdown-"));
});

afterAll(() => {
  rmSync(logDir, { recursive: true, force: true });
});

/** A signal is emitted rather than raised: raising one would take the test runner with it. */
function raise(signal: "SIGTERM" | "SIGINT"): void {
  process.emit(signal as never);
}

describe("the signal handler", () => {
  test("a handler is installed for both signals, which is the whole fix", () => {
    const before = {
      term: process.listenerCount("SIGTERM"),
      int: process.listenerCount("SIGINT"),
    };
    const off = onShutdown("t", () => {}, { exit: () => {} });
    try {
      expect(process.listenerCount("SIGTERM")).toBe(before.term + 1);
      expect(process.listenerCount("SIGINT")).toBe(before.int + 1);
    } finally {
      off();
    }
    // The disposer has to work, or every test below leaks a listener into the next one.
    expect(process.listenerCount("SIGTERM")).toBe(before.term);
    expect(process.listenerCount("SIGINT")).toBe(before.int);
  });

  test("SIGTERM runs the wind-down and exits 0", async () => {
    let wound = 0;
    const codes: number[] = [];
    const off = onShutdown("t", () => void wound++, { exit: (code) => codes.push(code) });
    try {
      raise("SIGTERM");
      await Bun.sleep(20);
      expect(wound).toBe(1);
      expect(codes).toEqual([0]);
    } finally {
      off();
    }
  });

  test("an async wind-down is awaited before the exit", async () => {
    const order: string[] = [];
    const off = onShutdown(
      "t",
      async () => {
        await Bun.sleep(30);
        order.push("wound");
      },
      { exit: () => order.push("exit") },
    );
    try {
      raise("SIGTERM");
      await Bun.sleep(10);
      expect(order).toEqual([]);
      await Bun.sleep(60);
      expect(order).toEqual(["wound", "exit"]);
    } finally {
      off();
    }
  });

  test("a second signal exits immediately rather than waiting out the first", async () => {
    let wound = 0;
    const codes: number[] = [];
    const off = onShutdown(
      "t",
      async () => {
        wound++;
        await Bun.sleep(200);
      },
      { exit: (code) => codes.push(code) },
    );
    try {
      raise("SIGTERM");
      await Bun.sleep(10);
      raise("SIGINT");
      // The wind-down ran once, and the impatient operator got their exit without waiting for it.
      expect(wound).toBe(1);
      expect(codes).toEqual([1]);
    } finally {
      off();
    }
  });

  test("a wind-down that hangs still exits, so a handled stop is never a worse outage", async () => {
    const codes: number[] = [];
    const off = onShutdown("t", () => new Promise<void>(() => {}), {
      graceMs: 40,
      exit: (code) => codes.push(code),
    });
    try {
      raise("SIGTERM");
      await Bun.sleep(120);
      expect(codes).toEqual([1]);
    } finally {
      off();
    }
  });

  test("a wind-down that throws is reported and exits non-zero", async () => {
    const codes: number[] = [];
    const said: string[] = [];
    const off = onShutdown(
      "t",
      () => {
        throw new Error("the disk went away");
      },
      { exit: (code) => codes.push(code), log: (m) => said.push(m) },
    );
    try {
      raise("SIGTERM");
      await Bun.sleep(20);
      expect(codes).toEqual([1]);
      expect(said.join("\n")).toContain("the disk went away");
    } finally {
      off();
    }
  });

  test("the default grace is inside a container runtime's default patience", () => {
    // The runtime's own default is 10s. A grace at or above it turns every stop back into the
    // SIGKILL this module exists to stop producing.
    expect(DEFAULT_GRACE_MS).toBeLessThan(10_000);
  });
});

describe("draining a listener", () => {
  test("returns once the server has stopped", async () => {
    let stopped = false;
    await drain({ stop: () => void (stopped = true) }, 1000);
    expect(stopped).toBe(true);
  });

  test("gives up on a stop that never resolves, so what comes after it still runs", async () => {
    const started = Date.now();
    await drain({ stop: () => new Promise<void>(() => {}) }, 40);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

/**
 * The behaviour the whole change is for. `AccessLogWriter` buffers, so a line written and not
 * flushed is only in memory — which is correct, and is exactly why the shutdown path has to close
 * it. These drive the real `RotatingFileSink`: a stub would pass whether or not a line reached disk.
 */
describe("the access log survives an orderly shutdown", () => {
  test("close() writes a buffered line that no flush interval has reached yet", () => {
    const path = join(logDir, "close.log");
    // No flush timer at all, so nothing but `close()` can put this line on disk.
    const writer = new AccessLogWriter({ path, flushIntervalMs: 0 });
    writer.write({ requestId: "r1", status: 200 });
    expect(existsSync(path) ? readFileSync(path, "utf8") : "").toBe("");
    writer.close();
    const lines = readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines).toEqual([{ requestId: "r1", status: 200 }]);
  });

  test("the gateway's own stop() flushes it, which is what the signal handler calls", async () => {
    const path = join(logDir, "dp-stop.log");
    const cp = makeCp();
    const backend = startBackend();
    const cpServer = serveCp(cp);
    try {
      await publishApi(cp, { backendUrl: backend.url });
      const dp = makeDp(cpServer.url, cp.token, cp.dir, {
        name: "shutdown-1",
        quiet: false,
        accessLogPath: path,
      });
      await dp.start();
      // A request the gateway refuses is still a line: "a call arrived and was rejected" is the
      // compliance question more often than "a call succeeded", and it needs no subscription here.
      await dp.fetchHttp(new Request("http://gw/nothing-here"), "203.0.113.9");
      expect(dp.accessLog).not.toBeNull();
      expect(dp.accessLog!.lines).toBeGreaterThan(0);
      // Buffered, not written: this is the state a SIGKILL used to throw away on every deploy.
      expect(existsSync(path) ? readFileSync(path, "utf8") : "").toBe("");

      dp.stop();

      const written = readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l));
      expect(written.length).toBe(dp.accessLog!.lines);
      expect(written[0]!.path).toBe("/nothing-here");
    } finally {
      cpServer.stop();
      backend.stop();
      cp.close();
    }
  });
});
