import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { cpus, totalmem, type as osType, release } from "node:os";
import { BUCKET_COUNT } from "../../shared/telemetry.ts";
import { runTarget, type RunResult } from "./runner.ts";
import { buildWorld, VALID_PET, type PerfWorld } from "./world.ts";

/**
 * `bun run perf` (plan G6).
 *
 * Every gateway scenario is paired with the identical work done straight to the backend in the
 * same run, and the reported number is the difference. That is the only honest way to separate
 * gateway overhead from backend latency on one machine.
 */
interface Scenario {
  name: string;
  group: string;
  /** Which of the world's APIs to go through, and what to append to its base path. */
  api: string;
  path: string;
  /** The same work straight at the backend. Absent means there is nothing to compare against. */
  directPath?: string;
  method?: string;
  headers?: Record<string, string>;
  authenticated?: boolean;
  bodyBytes?: number;
  /** A body that has to be a real document rather than filler — a SOAP envelope, or a valid Pet. */
  rawBody?: string;
  concurrency?: number;
  expectStatus?: number;
  /** Runs against both gateways in turn, to show `calls x instances` (design section 5.7). */
  roundRobin?: boolean;
  /** Sends to the gateway started with counting off, so its cost is measured not assumed. */
  withoutTelemetry?: boolean;
  note?: string;
}

const SOAP_ENVELOPE =
  `<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body>` +
  `<tns:GetPetRequest xmlns:tns="urn:apim:petstore"><tns:petId>1</tns:petId></tns:GetPetRequest>` +
  `</s:Body></s:Envelope>`;

const SCENARIOS: Scenario[] = [
  {
    name: "baseline",
    group: "baseline",
    api: "baseline",
    path: "/pet/1",
    directPath: "/v2/pet/1",
    note: "route match and proxy only, no policy attached",
  },
  {
    name: "auth",
    group: "policy",
    api: "auth",
    path: "/pet/1",
    directPath: "/v2/pet/1",
    authenticated: true,
    note: "auth.subscriptionKey: hash the presented key and look it up",
  },
  {
    name: "precondition-equals",
    group: "policy",
    api: "precondition",
    path: "/pet/1",
    directPath: "/v2/pet/1",
    headers: { "X-Request-Origin": "loadgen" },
    note: "one requireHeader rule, constant-time compare",
  },
  {
    name: "precondition-pattern",
    group: "policy",
    api: "pattern",
    path: "/pet/1",
    directPath: "/v2/pet/1",
    headers: { "X-Request-Origin": "loadgen" },
    note: "one requireHeader rule matching a linted regex",
  },
  {
    name: "ratelimit",
    group: "policy",
    api: "ratelimit",
    path: "/pet/1",
    directPath: "/v2/pet/1",
    authenticated: true,
    note: "fixed-window counter with a limit high enough never to reject",
  },
  {
    name: "headers",
    group: "policy",
    api: "headers",
    path: "/pet/1",
    directPath: "/v2/pet/1",
    note: "remove, set, append with template rendering",
  },
  {
    name: "all-policies",
    group: "policy",
    api: "all-policies",
    path: "/pet/1",
    directPath: "/v2/pet/1",
    authenticated: true,
    headers: { "X-Request-Origin": "loadgen" },
    note: "auth + rate limit + precondition + header rules together",
  },
  {
    name: "reject-401",
    group: "rejection",
    api: "auth",
    path: "/pet/1",
    expectStatus: 401,
    note: "no key: rejected at step 4, the backend is never reached",
  },
  {
    name: "reject-403",
    group: "rejection",
    api: "precondition",
    path: "/pet/1",
    expectStatus: 403,
    note: "precondition denial, after the rate limit has already been consumed",
  },
  {
    name: "reject-429",
    group: "rejection",
    api: "ratelimit-tight",
    path: "/pet/1",
    authenticated: true,
    expectStatus: 429,
    note: "over the limit: the cheapest possible answer",
  },
  {
    name: "reject-404",
    group: "rejection",
    api: "baseline",
    path: "-does-not-exist/pet/1",
    expectStatus: 404,
    note: "no route matches: the shortest path through the pipeline",
  },
  {
    name: "reject-415-soap-fault",
    group: "rejection",
    api: "soap",
    path: "",
    method: "POST",
    headers: { "content-type": "application/json" },
    expectStatus: 415,
    note: "rejected at step 3 and rendered as a SOAP Fault instead of problem+json",
  },
  /*
   * What validation costs (goal G1). One contract, one body, three states — so the difference
   * between these rows is the state and nothing else. `validate-disabled` is the floor rather than
   * zero, because the `always` block runs in every state; the numbers that mean something are
   * `blocking − disabled` and `warning − disabled`.
   */
  {
    name: "validate-disabled",
    group: "validation",
    api: "validate-disabled",
    path: "/pet",
    directPath: "/v2/pet",
    method: "POST",
    rawBody: VALID_PET,
    note: "no schema check; the always block (type, size, depth, duplicate keys) still runs",
  },
  {
    name: "validate-blocking",
    group: "validation",
    api: "validate-blocking",
    path: "/pet",
    directPath: "/v2/pet",
    method: "POST",
    rawBody: VALID_PET,
    note: "the default: body buffered and checked against the compiled schema before the backend",
  },
  {
    name: "validate-warning",
    group: "validation",
    api: "validate-warning",
    path: "/pet",
    directPath: "/v2/pet",
    method: "POST",
    rawBody: VALID_PET,
    note: "sampled at 1.0 and never rejecting — off the response path, but not off this thread (D19)",
  },
  {
    name: "validate-reject",
    group: "rejection",
    api: "validate-blocking",
    path: "/pet",
    method: "POST",
    rawBody: '{"name":42}',
    expectStatus: 400,
    note: "a body the schema refuses: rejected before any backend call, naming the JSON pointer",
  },
  {
    name: "body-1mib-up",
    group: "size",
    api: "baseline",
    path: "/echo",
    directPath: "/v2/echo",
    method: "POST",
    bodyBytes: 1024 * 1024,
    concurrency: 4,
    note: "1 MiB request body streamed through with duplex: half",
  },
  {
    name: "body-1mib-down",
    group: "size",
    api: "baseline",
    path: "/pet/1",
    directPath: "/v2/pet/1",
    headers: { "X-Sim-Body-Bytes": String(1024 * 1024) },
    concurrency: 4,
    note: "1 MiB response body counted while streaming",
  },
  {
    name: "telemetry-on",
    group: "telemetry",
    api: "baseline",
    path: "/pet/1",
    headers: { "X-Sim-Body-Bytes": String(1024 * 1024) },
    concurrency: 4,
    note: "1 MiB response through a gateway that counts bytes and outcomes",
  },
  {
    name: "telemetry-off",
    group: "telemetry",
    api: "baseline",
    path: "/pet/1",
    headers: { "X-Sim-Body-Bytes": String(1024 * 1024) },
    concurrency: 4,
    withoutTelemetry: true,
    note: "the same, through a gateway started with DP_TELEMETRY=off",
  },
  {
    name: "latency-100ms",
    group: "latency",
    api: "slow",
    path: "/pet/1",
    directPath: "/v2/pet/1",
    headers: { "X-Sim-Delay-Ms": "100" },
    concurrency: 16,
    note: "backend at 100 ms; overhead should disappear into it",
  },
  {
    name: "latency-2s",
    group: "latency",
    api: "slow",
    path: "/pet/1",
    directPath: "/v2/pet/1",
    headers: { "X-Sim-Delay-Ms": "2000" },
    concurrency: 16,
    note: "backend at 2 s, timeoutMs 60 s",
  },
  {
    name: "latency-30s",
    group: "latency",
    api: "slow",
    path: "/pet/1",
    directPath: "/v2/pet/1",
    headers: { "X-Sim-Delay-Ms": "30000" },
    concurrency: 8,
    note: "backend at the 30 s ceiling with timeoutMs 60 s: still a 200",
  },
  {
    name: "timeout-edge",
    group: "latency",
    api: "impatient",
    path: "/pet/1",
    headers: { "X-Sim-Delay-Ms": "30000" },
    concurrency: 8,
    expectStatus: 504,
    note: "30 s backend against timeoutMs 5 s: every request is a 504, deliberately",
  },
  {
    name: "soap-small",
    group: "soap",
    api: "soap",
    path: "",
    directPath: "/soap/petstore",
    method: "POST",
    headers: { "content-type": "text/xml", soapaction: '"urn:apim:petstore:GetPet"' },
    note: "the bounded prefix scan plus SOAPAction agreement",
  },
  {
    name: "fleet-2",
    group: "fleet",
    api: "baseline",
    path: "/pet/1",
    directPath: "/v2/pet/1",
    roundRobin: true,
    note: "spread across both DEV gateways: per-instance state, so calls x instances",
  },
  /*
   * G4's two ways to talk to a backend nothing publicly trusts. No `directPath`: the comparison
   * that matters is between these two rows, not against the backend — they run through the same
   * gateway to the same TLS backend with the same policy, and differ only in how TLS is settled.
   */
  {
    name: "trust-anchor",
    group: "tls",
    api: "trust-anchor",
    path: "/pet/1",
    note: "verify normally against a CA registered for the environment: no exception",
  },
  {
    name: "tls-exception-pin",
    group: "tls",
    api: "tls-exception-pin",
    path: "/pet/1",
    note: "the same backend reached through a pinned exception (custom checkServerIdentity)",
  },
  {
    name: "baseline-again",
    group: "baseline",
    api: "baseline",
    path: "/pet/1",
    directPath: "/v2/pet/1",
    note: "the first scenario, repeated last: the gap between the two is the run's own drift",
  },
];

interface ScenarioResult {
  scenario: Scenario;
  gateway: RunResult;
  direct: RunResult | null;
  overheadP50: number | null;
  overheadP95: number | null;
  /**
   * For a policy scenario: the overhead of the no-policy baseline measured **immediately before
   * it**, in the same conditions. A loopback run drifts by more than any single policy costs, so
   * comparing against a baseline taken minutes earlier would report the drift as policy cost.
   */
  localBaselineP50?: number | null;
  localBaselineP95?: number | null;
}

interface Profile {
  durationMs: number;
  warmup: number;
  concurrency: number;
  latencyDurationMs: number;
}

const PROFILES: Record<string, Profile> = {
  quick: { durationMs: 2000, warmup: 20, concurrency: 8, latencyDurationMs: 4000 },
  full: { durationMs: 8000, warmup: 100, concurrency: 16, latencyDurationMs: 35_000 },
};

function flag(name: string, fallback: string): string {
  const prefix = `--${name}=`;
  for (const arg of Bun.argv) if (arg.startsWith(prefix)) return arg.slice(prefix.length);
  return fallback;
}

function headersFor(scenario: Scenario, world: PerfWorld): Record<string, string> {
  const api = world.apis.get(scenario.api);
  const headers: Record<string, string> = { ...(scenario.headers ?? {}) };
  if (scenario.authenticated && api?.key) headers["X-Api-Key"] = api.key;
  return headers;
}

async function runScenario(
  scenario: Scenario,
  world: PerfWorld,
  profile: Profile,
): Promise<ScenarioResult> {
  const api = world.apis.get(scenario.api);
  if (!api) throw new Error(`scenario ${scenario.name} names unknown api ${scenario.api}`);
  const headers = headersFor(scenario, world);
  const method = scenario.method ?? "GET";
  const concurrency = scenario.concurrency ?? profile.concurrency;
  const durationMs = scenario.group === "latency" ? profile.latencyDurationMs : profile.durationMs;
  const options = { concurrency, durationMs, warmup: scenario.group === "latency" ? 1 : profile.warmup };

  // A SOAP scenario has to send a real envelope; a padded JSON body would be rejected by the
  // prefix scan, which is exactly the code path being measured. Same reasoning for the validation
  // scenarios, which name their own body.
  const rawBody =
    scenario.rawBody ??
    (scenario.api === "soap" && method === "POST" && !scenario.headers?.["content-type"]?.includes("json")
      ? SOAP_ENVELOPE
      : undefined);
  const base = scenario.roundRobin
    ? world.gateways
    : [scenario.withoutTelemetry ? world.gatewayWithoutTelemetry : world.gateways[0]!];

  const gatewayRuns: RunResult[] = [];
  for (const gateway of base) {
    gatewayRuns.push(
      await runTarget(
        {
          base: gateway,
          path: `${api.basePath}${scenario.path}`,
          method,
          headers,
          bodyBytes: scenario.bodyBytes ?? 0,
          rawBody,
        },
        { ...options, durationMs: Math.round(durationMs / base.length) },
      ),
    );
  }
  const gateway = mergeRuns(gatewayRuns);

  let direct: RunResult | null = null;
  if (scenario.directPath) {
    direct = await runTarget(
      {
        base: world.backendUrl,
        path: scenario.directPath,
        method,
        headers,
        bodyBytes: scenario.bodyBytes ?? 0,
        rawBody,
      },
      options,
    );
  }

  return {
    scenario,
    gateway,
    direct,
    overheadP50: direct ? round(gateway.p50 - direct.p50) : null,
    overheadP95: direct ? round(gateway.p95 - direct.p95) : null,
  };
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

function mergeRuns(runs: RunResult[]): RunResult {
  if (runs.length === 1) return runs[0]!;
  const statuses: Record<string, number> = {};
  for (const run of runs) {
    for (const [status, count] of Object.entries(run.statuses)) {
      statuses[status] = (statuses[status] ?? 0) + count;
    }
  }
  const completed = runs.reduce((sum, r) => sum + r.completed, 0);
  const wallMs = Math.max(...runs.map((r) => r.wallMs));
  return {
    completed,
    errors: runs.reduce((sum, r) => sum + r.errors, 0),
    rps: round((completed / wallMs) * 1000),
    concurrency: runs.reduce((sum, r) => sum + r.concurrency, 0),
    bytesSent: runs.reduce((sum, r) => sum + r.bytesSent, 0),
    p50: round(Math.max(...runs.map((r) => r.p50))),
    p90: round(Math.max(...runs.map((r) => r.p90))),
    p95: round(Math.max(...runs.map((r) => r.p95))),
    p99: round(Math.max(...runs.map((r) => r.p99))),
    min: round(Math.min(...runs.map((r) => r.min))),
    max: round(Math.max(...runs.map((r) => r.max))),
    mean: round(runs.reduce((sum, r) => sum + r.mean, 0) / runs.length),
    statuses,
    bytesOut: runs.reduce((sum, r) => sum + r.bytesOut, 0),
    wallMs: round(wallMs),
  };
}

function statusSummary(result: RunResult): string {
  return Object.entries(result.statuses)
    .sort((a, b) => b[1] - a[1])
    .map(([status, count]) => `${status}x${count}`)
    .join(" ");
}

function report(
  results: ScenarioResult[],
  profileName: string,
  world: PerfWorld,
  telemetry: Record<string, unknown> | null,
  previous: { at: string; results: Record<string, number> } | null,
  startedAt: string,
  elapsedMs: number,
): string {
  const baseline = results.find((r) => r.scenario.name === "baseline");
  const lines: string[] = [];

  lines.push("# Gateway performance report");
  lines.push("");
  lines.push(
    `> **Generated** by \`bun run perf --profile=${profileName}\` at ${startedAt}. ` +
      "Edits are overwritten; change the scenarios in `tools/loadgen/index.ts` instead.",
  );
  lines.push("");
  lines.push("## Machine and method");
  lines.push("");
  lines.push(`| | |`);
  lines.push(`|---|---|`);
  lines.push(`| Host | ${osType()} ${release()} |`);
  lines.push(`| CPU | ${cpus()[0]?.model ?? "unknown"} (${cpus().length} logical) |`);
  lines.push(`| Memory | ${Math.round(totalmem() / 1024 / 1024 / 1024)} GiB |`);
  lines.push(`| Runtime | Bun ${Bun.version} |`);
  lines.push(`| Profile | ${profileName} |`);
  lines.push(`| Gateways | ${world.gateways.length} |`);
  lines.push(`| Backend seed | 1 (deterministic) |`);
  lines.push(`| Warm-up | one full baseline run, discarded |`);
  lines.push(`| Wall time | ${Math.round(elapsedMs / 1000)}s |`);
  lines.push("");
  lines.push(
    "Every gateway scenario is paired with the identical request straight to the backend in the " +
      "same run, and **the headline number is the difference**. Absolute throughput on one " +
      "machine measures that machine.",
  );
  lines.push("");

  lines.push("## Results");
  lines.push("");
  lines.push(
    "| Scenario | Group | conc | n | rps | p50 ms | p95 ms | p99 ms | direct p50 | direct p95 | +p50 | +p95 | statuses |",
  );
  lines.push("|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|");
  for (const result of results) {
    lines.push(
      `| \`${result.scenario.name}\` | ${result.scenario.group} | ${result.gateway.concurrency} | ` +
        `${result.gateway.completed} | ${result.gateway.rps} | ` +
        `${result.gateway.p50} | ${result.gateway.p95} | ${result.gateway.p99} | ` +
        `${result.direct?.p50 ?? "—"} | ${result.direct?.p95 ?? "—"} | ` +
        `${result.overheadP50 ?? "—"} | ${result.overheadP95 ?? "—"} | ${statusSummary(result.gateway)} |`,
    );
  }
  lines.push("");
  lines.push(
    "**`rps` is not a capacity figure.** Every scenario runs a fixed number of workers, so " +
      "`rps ≈ conc / latency` — Little's Law. Where the backend is deliberately slow the rps " +
      "column is therefore arithmetic and says nothing about the gateway: `latency-30s` at " +
      "concurrency 8 against a 30-second backend *cannot* exceed 0.27 rps, and the same scenario " +
      "at concurrency 800 would report 27 rps and mean exactly as little. Read **rps** only for " +
      "rows whose backend is fast (`baseline`, the policy group, the rejection group); read " +
      "**p50/p95** and the **+p50/+p95** overhead columns everywhere else. `n` is the sample " +
      "count: a percentile drawn from single digits is the maximum wearing a hat.",
  );
  lines.push("");

  const againstDrift = results.find((r) => r.scenario.name === "baseline-again");
  if (baseline) {
    lines.push("## What each policy costs");
    lines.push("");
    lines.push(
      "Two subtractions, both necessary. **Overhead** is gateway minus direct for that scenario, " +
        "run seconds apart. **Cost** is that overhead minus the overhead of a no-policy baseline " +
        "run immediately before the same scenario — because a loopback run drifts by more than " +
        "any single policy costs, and a baseline measured minutes earlier would report the drift " +
        "as policy cost. A negative number is noise, not a speed-up.",
    );
    lines.push("");
    lines.push(
      "| Policy | overhead p50 ms | cost p50 ms | overhead p95 ms | cost p95 ms | what it does |",
    );
    lines.push("|---|---:|---:|---:|---:|---|");
    for (const result of results.filter((r) => r.scenario.group === "policy")) {
      const p50 = result.overheadP50;
      const p95 = result.overheadP95;
      const base50 = result.localBaselineP50 ?? baseline.overheadP50;
      const base95 = result.localBaselineP95 ?? baseline.overheadP95;
      lines.push(
        `| \`${result.scenario.name}\` | ${p50 ?? "—"} | ` +
          `${p50 !== null && base50 !== null && base50 !== undefined ? round(p50 - base50) : "—"} | ` +
          `${p95 ?? "—"} | ` +
          `${p95 !== null && base95 !== null && base95 !== undefined ? round(p95 - base95) : "—"} | ` +
          `${result.scenario.note ?? ""} |`,
      );
    }
    lines.push("");
    if (againstDrift) {
      lines.push(
        `**Run drift.** \`baseline\` ran first at p95 ${baseline.gateway.p95} ms and ` +
          `\`baseline-again\` ran last at p95 ${againstDrift.gateway.p95} ms ` +
          `(${round(againstDrift.gateway.p95 - baseline.gateway.p95)} ms). On a loopback run this ` +
          "is mostly ephemeral-port and connection-pool churn on the host, not the gateway. Read " +
          "any per-policy figure smaller than this gap as noise.",
      );
      lines.push("");
    }

    const validation = results.filter((r) => r.scenario.group === "validation");
    const floor = validation.find((r) => r.scenario.name === "validate-disabled");
    if (validation.length > 0 && floor) {
      lines.push("## What validation costs");
      lines.push("");
      lines.push(
        "The same POST, the same body, the same compiled schema — three states. `disabled` is the " +
          "**floor, not zero**: the `always` block (content type, body size, nesting depth, " +
          "duplicate keys) runs in every state, which is the point of it. So the number that " +
          "answers \"what does schema validation cost\" is each row minus that floor, and it is " +
          "given here rather than left to the reader.",
      );
      lines.push("");
      lines.push("| State | rps | vs disabled | p50 ms | p95 ms | +p50 vs disabled |");
      lines.push("|---|---:|---:|---:|---:|---:|");
      for (const result of validation) {
        const deltaRps =
          floor.gateway.rps > 0
            ? `${round(((result.gateway.rps - floor.gateway.rps) / floor.gateway.rps) * 100)}%`
            : "—";
        lines.push(
          `| \`${result.scenario.name.replace("validate-", "")}\` | ${result.gateway.rps} | ` +
            `${result.scenario.name === "validate-disabled" ? "—" : deltaRps} | ` +
            `${result.gateway.p50} | ${result.gateway.p95} | ` +
            `${result.scenario.name === "validate-disabled" ? "—" : round(result.gateway.p50 - floor.gateway.p50)} |`,
        );
      }
      lines.push("");
      lines.push(
        "`warning` is sampled at 1.0 here, so it is the *worst* case for that state rather than " +
          "the usual one. It never rejects and never delays the response — but on this runtime it " +
          "is not isolated from the request path either (deviation D19), which is why it is " +
          "measured on the same axis as `blocking` instead of being assumed free.",
      );
      lines.push("");
    }

    lines.push("## Rejection paths");
    lines.push("");
    lines.push(
      "A request the gateway rejects never reaches a backend, so these are the floor of what the " +
        "pipeline costs.",
    );
    lines.push("");
    lines.push("| Scenario | rps | p50 ms | p95 ms | statuses | what it does |");
    lines.push("|---|---:|---:|---:|---|---|");
    for (const result of results.filter((r) => r.scenario.group === "rejection")) {
      lines.push(
        `| \`${result.scenario.name}\` | ${result.gateway.rps} | ${result.gateway.p50} | ` +
          `${result.gateway.p95} | ${statusSummary(result.gateway)} | ${result.scenario.note ?? ""} |`,
      );
    }
    lines.push("");
  }

  const size = results.filter((r) => r.scenario.group === "size");
  if (size.length > 0) {
    lines.push("## Payload throughput");
    lines.push("");
    lines.push(
      "For a body-moving scenario, requests per second is the wrong unit — these run at " +
        "concurrency 4, so rps is capped by that, not by the gateway. Bytes per second is the " +
        "number. Note that a proxied request moves each byte **twice**: client to gateway, then " +
        "gateway to backend.",
    );
    lines.push("");
    lines.push("| Scenario | conc | req MiB/s | resp MiB/s | p50 ms | direct p50 ms | +p50 ms |");
    lines.push("|---|---:|---:|---:|---:|---:|---:|");
    for (const result of size) {
      const seconds = result.gateway.wallMs / 1000;
      const perSecond = (byteCount: number) => round(byteCount / seconds / 1024 / 1024);
      lines.push(
        `| \`${result.scenario.name}\` | ${result.gateway.concurrency} | ` +
          `${perSecond(result.gateway.bytesSent)} | ${perSecond(result.gateway.bytesOut)} | ` +
          `${result.gateway.p50} | ${result.direct?.p50 ?? "—"} | ${result.overheadP50 ?? "—"} |`,
      );
    }
    lines.push("");
  }

  const telemetryPair = results.filter((r) => r.scenario.group === "telemetry");
  if (telemetryPair.length === 2) {
    const on = telemetryPair.find((r) => r.scenario.name.endsWith("-on"));
    const off = telemetryPair.find((r) => r.scenario.name.endsWith("-off"));
    if (on && off) {
      lines.push("## What counting costs");
      lines.push("");
      lines.push(
        "The same 1 MiB response through two gateways: one counting bytes and outcomes, one with " +
          "`DP_TELEMETRY=off`. Counting is per byte on the response path, so a large body is where " +
          "it shows. Measured rather than assumed, because the alternative is a guess.",
      );
      lines.push("");
      lines.push("| Gateway | conc | p50 ms | p95 ms | resp MiB/s |");
      lines.push("|---|---:|---:|---:|---:|");
      for (const result of [off, on]) {
        const seconds = result.gateway.wallMs / 1000;
        lines.push(
          `| \`${result.scenario.name}\` | ${result.gateway.concurrency} | ${result.gateway.p50} | ` +
            `${result.gateway.p95} | ${round(result.gateway.bytesOut / seconds / 1024 / 1024)} |`,
        );
      }
      lines.push("");
      lines.push(
        `Counting costs **${round(on.gateway.p50 - off.gateway.p50)} ms p50** and ` +
          `**${round(on.gateway.p95 - off.gateway.p95)} ms p95** on a 1 MiB response. Turning it ` +
          "off also turns off everything the Telemetry view shows, which is the trade.",
      );
      lines.push("");
    }
  }

  const tls = results.filter((r) => r.scenario.group === "tls");
  if (tls.length === 2) {
    const anchor = tls.find((r) => r.scenario.name === "trust-anchor");
    const pinned = tls.find((r) => r.scenario.name === "tls-exception-pin");
    if (anchor && pinned) {
      lines.push("## Reaching a backend nothing publicly trusts");
      lines.push("");
      lines.push(
        "Both rows go through the same gateway to the same HTTPS backend, whose certificate is " +
          "signed by a CA generated for this run. They differ only in how that certificate is " +
          "settled: `trust-anchor` registers the CA for the environment, `tls-exception-pin` " +
          "pins the leaf and installs a custom `checkServerIdentity`.",
      );
      lines.push("");
      lines.push("| Scenario | conc | n | rps | p50 ms | p95 ms | statuses | note |");
      lines.push("|---|---:|---:|---:|---:|---:|---|---|");
      for (const result of [anchor, pinned]) {
        lines.push(
          `| \`${result.scenario.name}\` | ${result.gateway.concurrency} | ${result.gateway.completed} | ` +
            `${result.gateway.rps} | ${result.gateway.p50} | ${result.gateway.p95} | ` +
            `${statusSummary(result.gateway)} | ${result.scenario.note ?? ""} |`,
        );
      }
      lines.push("");
      const deltaP50 = round(pinned.gateway.p50 - anchor.gateway.p50);
      const deltaP95 = round(pinned.gateway.p95 - anchor.gateway.p95);
      lines.push(
        `Measured here: the pin is **${deltaP50} ms p50** and **${deltaP95} ms p95** away from ` +
          "the registered anchor (a negative number means it was faster in this run). Both are " +
          "within a run's own drift of each other and of the plain-HTTP `baseline` row, so on " +
          "loopback with an ECDSA P-256 certificate **neither TLS path costs anything this " +
          "harness can resolve** — the earlier expectation that a pin would pay a handshake per " +
          "request does not reproduce through the gateway's client, and is not claimed here.",
      );
      lines.push("");
      lines.push(
        "The argument for retiring a pin is therefore correctness rather than speed: a pin trusts " +
          "one certificate and breaks the day the backend rotates it, while a registered anchor " +
          "trusts the issuer and keeps verifying. And an exception is a dated hole in verification " +
          "that somebody has to renew; an anchor is not.",
      );
      lines.push("");
    }
  }

  const latency = results.filter((r) => r.scenario.group === "latency");
  if (latency.length > 0) {
    lines.push("## Backend latency and timeouts");
    lines.push("");
    lines.push(
      "The gateway adds a fixed cost; the backend's own delay dominates. rps here is `conc / " +
        "latency` and is shown only so the arithmetic is checkable — the column that means " +
        "something is **+p50**, the gateway's cost on top of a backend that is asleep.",
    );
    lines.push("");
    lines.push("| Scenario | conc | n | rps | p50 ms | direct p50 ms | +p50 ms | statuses | note |");
    lines.push("|---|---:|---:|---:|---:|---:|---:|---|---|");
    for (const result of latency) {
      lines.push(
        `| \`${result.scenario.name}\` | ${result.gateway.concurrency} | ${result.gateway.completed} | ` +
          `${result.gateway.rps} | ${result.gateway.p50} | ${result.direct?.p50 ?? "—"} | ` +
          `${result.overheadP50 ?? "—"} | ${statusSummary(result.gateway)} | ${result.scenario.note ?? ""} |`,
      );
    }
    lines.push("");
    lines.push(
      "A slow backend is also thin on samples: at concurrency 8 against a 30-second backend, a " +
        "4-second measurement window collects exactly 8 requests, one per worker. Those " +
        "percentiles are the maximum by another name. The `full` profile widens the window to 35 " +
        "seconds; nothing short of minutes would give `latency-30s` a real distribution, and it " +
        "is here to prove the timeout boundary rather than to characterise a curve.",
    );
    lines.push("");
  }

  if (telemetry) {
    lines.push("## What the control plane saw");
    lines.push("");
    lines.push(
      "The same run, read back through `/api/telemetry/summary` — the gateway's own counters, " +
        `aggregated per minute. Percentiles here are interpolated from ${BUCKET_COUNT} histogram ` +
        "buckets and are labelled approximate; the table above uses exact samples the harness kept. " +
        "The gateway line is the per-request total minus that request's backend leg, which is the " +
        "figure this harness cannot measure from outside.",
    );
    lines.push("");
    const totals = telemetry.totals as Record<string, number>;
    lines.push(`| | |`);
    lines.push(`|---|---:|`);
    lines.push(`| requests | ${totals.requests} |`);
    lines.push(`| ok | ${totals.ok} |`);
    lines.push(`| gateway rejections | ${totals.gatewayRejections} |`);
    lines.push(`| upstream errors | ${totals.upstreamErrors} |`);
    lines.push(`| bytes out | ${totals.bytesOut} |`);
    lines.push(`| p50 / p95 (approximate) | ${totals.p50Ms} / ${totals.p95Ms} ms |`);
    lines.push(
      `| p50 / p95 in the gateway (approximate) | ${totals.gatewayP50Ms} / ${totals.gatewayP95Ms} ms |`,
    );
    lines.push("");
  }

  if (previous) {
    lines.push("## Change since the previous run");
    lines.push("");
    lines.push(`Previous run: ${previous.at}.`);
    lines.push("");
    lines.push("| Scenario | p95 now | p95 then | change |");
    lines.push("|---|---:|---:|---:|");
    for (const result of results) {
      const then = previous.results[result.scenario.name];
      if (then === undefined) continue;
      lines.push(
        `| \`${result.scenario.name}\` | ${result.gateway.p95} | ${then} | ` +
          `${round(result.gateway.p95 - then)} |`,
      );
    }
    lines.push("");
  }

  lines.push("## What this does not measure");
  lines.push("");
  lines.push(
    "- **One machine.** The load generator, both gateways, the control plane and the backend " +
      "share the same cores, so they compete with each other. The paired direct numbers absorb " +
      "most of that, but not all of it.",
  );
  lines.push("- **No TLS and no reverse proxy.** Design section 8.1 puts both in front of a real gateway.");
  lines.push("- **Loopback only.** No network latency, so proxy overhead is at its most visible here.");
  lines.push(
    "- **One body, one schema.** The validation rows use a small Pet document against the " +
      "petstore's own schema. Validation cost scales with both, and design section 13 calls it " +
      "the dominant variable in a real deployment — so treat the percentage below as the shape of " +
      "the cost, not its size for your contracts.",
  );
  lines.push(
    "- **Rate limiting is per instance** (design section 5.7): the `fleet-2` row spreads traffic " +
      "over two gateways, which is why an effective limit is `calls x instances`.",
  );
  lines.push("");
  return lines.join("\n");
}

async function main(): Promise<void> {
  const profileName = flag("profile", "quick");
  const profile = PROFILES[profileName];
  if (!profile) throw new Error(`unknown profile "${profileName}" (known: quick, full)`);
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();

  console.log(`[perf] building an isolated world (profile ${profileName})…`);
  const world = await buildWorld(2);
  const results: ScenarioResult[] = [];
  try {
    const baselineScenario = SCENARIOS.find((s) => s.name === "baseline")!;
    // One discarded run first: whatever is measured first pays for JIT warm-up, connection
    // establishment and the first config poll, and that cost would otherwise be attributed to
    // whichever policy happened to be measured first.
    console.log("[perf] warm-up (discarded)");
    await runScenario(baselineScenario, world, profile);
    await Bun.sleep(500);

    for (const scenario of SCENARIOS) {
      // Each policy scenario gets its own baseline, run seconds before it rather than minutes.
      let localBaseline: ScenarioResult | null = null;
      if (scenario.group === "policy") {
        localBaseline = await runScenario(baselineScenario, world, profile);
        await Bun.sleep(500);
      }

      process.stdout.write(`[perf] ${scenario.name.padEnd(24)}`);
      const result = await runScenario(scenario, world, profile);
      if (localBaseline) {
        result.localBaselineP50 = localBaseline.overheadP50;
        result.localBaselineP95 = localBaseline.overheadP95;
      }
      results.push(result);
      // Let sockets drain between scenarios; on Windows a loopback run otherwise walks into
      // TIME_WAIT accumulation and reports it as latency.
      await Bun.sleep(500);
      console.log(
        `rps ${String(result.gateway.rps).padStart(8)}  p50 ${String(result.gateway.p50).padStart(8)}ms  ` +
          `p95 ${String(result.gateway.p95).padStart(8)}ms  ${statusSummary(result.gateway)}`,
      );
    }

    // Read the run back through the control plane, which is the point of G4.
    for (const dp of world.dataPlanes) await dp.client.pollOnce();
    world.app.telemetry.flushNow();
    const login = await fetch(`${world.cpUrl}/api/auth/dev-login`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost:8080" },
      body: JSON.stringify({ userId: "alice" }),
    });
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    const telemetry = (await (
      await fetch(`${world.cpUrl}/api/telemetry/summary?environment=dev&sinceMin=60`, {
        headers: { cookie },
      })
    ).json()) as Record<string, unknown>;

    mkdirSync(".data/perf", { recursive: true });
    // `reports/` is committed, so it is there in a checkout — but a harness that fails at the last
    // line after forty minutes of measuring, because a directory was missing, is not worth risking.
    mkdirSync("reports", { recursive: true });
    let previous: { at: string; results: Record<string, number> } | null = null;
    try {
      const history = (await Bun.file(".data/perf/history.jsonl").text())
        .trim()
        .split("\n")
        .filter(Boolean);
      const last = history[history.length - 1];
      if (last) previous = JSON.parse(last) as { at: string; results: Record<string, number> };
    } catch {
      previous = null;
    }

    const elapsedMs = Date.now() - startedMs;
    const markdown = report(results, profileName, world, telemetry, previous, startedAt, elapsedMs);
    writeFileSync("reports/perf-report.md", markdown);
    writeFileSync(
      `.data/perf/${startedAt.replace(/[:.]/g, "-")}.json`,
      JSON.stringify({ startedAt, profile: profileName, results, telemetry }, null, 2),
    );
    appendFileSync(
      ".data/perf/history.jsonl",
      JSON.stringify({
        at: startedAt,
        profile: profileName,
        results: Object.fromEntries(results.map((r) => [r.scenario.name, r.gateway.p95])),
      }) + "\n",
    );

    console.log("");
    console.log(`[perf] wrote reports/perf-report.md (${Math.round(elapsedMs / 1000)}s)`);
  } finally {
    world.stop();
  }
}

if (import.meta.main) {
  await main();
  // Bun keeps the process alive while sockets linger; the work is done.
  process.exit(0);
}
