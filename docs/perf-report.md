# Gateway performance report

> **Generated** by `bun run perf --profile=quick` at 2026-09-03T20:59:16.016Z. Edits are overwritten; change the scenarios in `tools/loadgen/index.ts` instead.

## Machine and method

| | |
|---|---|
| Host | Windows_NT 10.0.22631 |
| CPU | 12th Gen Intel(R) Core(TM) i7-12700 (20 logical) |
| Memory | 32 GiB |
| Runtime | Bun 1.4.0 |
| Profile | quick |
| Gateways | 2 |
| Backend seed | 1 (deterministic) |
| Warm-up | one full baseline run, discarded |
| Wall time | 278s |

Every gateway scenario is paired with the identical request straight to the backend in the same run, and **the headline number is the difference**. Absolute throughput on one machine measures that machine.

## Results

| Scenario | Group | conc | n | rps | p50 ms | p95 ms | p99 ms | direct p50 | direct p95 | +p50 | +p95 | statuses |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| `baseline` | baseline | 8 | 14107 | 7051.98 | 1.07 | 1.73 | 3.19 | 0.12 | 0.18 | 0.95 | 1.55 | 200x14107 |
| `auth` | policy | 8 | 13568 | 6781.17 | 1.1 | 1.81 | 3.56 | 0.12 | 0.19 | 0.98 | 1.62 | 200x13568 |
| `precondition-equals` | policy | 8 | 13303 | 6650.28 | 1.11 | 1.83 | 4.22 | 0.13 | 0.19 | 0.98 | 1.64 | 200x13303 |
| `precondition-pattern` | policy | 8 | 13840 | 6918.21 | 1.08 | 1.72 | 3.81 | 0.13 | 0.19 | 0.95 | 1.53 | 200x13840 |
| `ratelimit` | policy | 8 | 12857 | 6425.91 | 1.17 | 1.85 | 3.97 | 0.13 | 0.19 | 1.04 | 1.66 | 200x12857 |
| `headers` | policy | 8 | 12539 | 6267.71 | 1.19 | 1.93 | 3.85 | 0.12 | 0.17 | 1.07 | 1.76 | 200x12539 |
| `all-policies` | policy | 8 | 12487 | 6242.22 | 1.19 | 1.88 | 4.11 | 0.13 | 0.2 | 1.06 | 1.68 | 200x12487 |
| `reject-401` | rejection | 8 | 95344 | 47670.8 | 0.15 | 0.21 | 0.36 | — | — | — | — | 401x95344 |
| `reject-403` | rejection | 8 | 88343 | 44168.68 | 0.16 | 0.23 | 0.41 | — | — | — | — | 403x88343 |
| `reject-429` | rejection | 8 | 78586 | 39252.44 | 0.18 | 0.26 | 0.47 | — | — | — | — | 429x78586 |
| `reject-404` | rejection | 8 | 98946 | 49471.68 | 0.14 | 0.2 | 0.34 | — | — | — | — | 404x98946 |
| `reject-415-soap-fault` | rejection | 8 | 13438 | 6715.44 | 1.13 | 1.85 | 3.12 | — | — | — | — | 500x13438 |
| `validate-disabled` | validation | 8 | 9363 | 4679.77 | 1.53 | 3.11 | 4.05 | 0.14 | 0.21 | 1.39 | 2.9 | 200x9363 |
| `validate-blocking` | validation | 8 | 10010 | 5001.71 | 1.43 | 2.93 | 4.39 | 0.14 | 0.21 | 1.29 | 2.72 | 200x10010 |
| `validate-warning` | validation | 8 | 9985 | 4991.05 | 1.48 | 2.88 | 3.9 | 0.14 | 0.21 | 1.34 | 2.67 | 200x9985 |
| `validate-reject` | rejection | 8 | 34873 | 17430.44 | 0.31 | 1.19 | 1.42 | — | — | — | — | 400x34873 |
| `body-1mib-up` | size | 4 | 662 | 329.88 | 11.92 | 15.38 | 17.2 | 1.42 | 2.71 | 10.5 | 12.67 | 200x662 |
| `body-1mib-down` | size | 4 | 1766 | 881.9 | 4.21 | 6.85 | 8.84 | 2.41 | 4.6 | 1.8 | 2.25 | 200x1766 |
| `telemetry-on` | telemetry | 4 | 1771 | 883.95 | 4.26 | 6.69 | 8.84 | — | — | — | — | 200x1771 |
| `telemetry-off` | telemetry | 4 | 1638 | 817.21 | 4.58 | 7.67 | 11.62 | — | — | — | — | 200x1638 |
| `latency-100ms` | latency | 16 | 624 | 154.06 | 103.29 | 107.19 | 120.38 | 101.27 | 114.42 | 2.02 | -7.23 | 200x624 |
| `latency-2s` | latency | 16 | 32 | 7.99 | 2003.27 | 2003.5 | 2003.52 | 2000.86 | 2000.97 | 2.41 | 2.53 | 200x32 |
| `latency-30s` | latency | 8 | 8 | 0.27 | 30004.01 | 30004.02 | 30004.02 | 30001.49 | 30001.54 | 2.52 | 2.48 | 200x8 |
| `timeout-edge` | latency | 8 | 8 | 1.6 | 5002.46 | 5002.56 | 5002.56 | — | — | — | — | 504x8 |
| `soap-small` | soap | 8 | 8748 | 4373.35 | 1.68 | 3.15 | 4.26 | 0.14 | 0.21 | 1.54 | 2.94 | 200x8748 |
| `fleet-2` | fleet | 16 | 13868 | 13861.07 | 1.08 | 1.75 | 3.75 | 0.12 | 0.17 | 0.96 | 1.58 | 200x13868 |
| `trust-anchor` | tls | 8 | 13675 | 6836.13 | 1.08 | 1.77 | 3.72 | — | — | — | — | 200x13675 |
| `tls-exception-pin` | tls | 8 | 13591 | 6794.39 | 1.1 | 1.78 | 3.29 | — | — | — | — | 200x13591 |
| `baseline-again` | baseline | 8 | 13839 | 6917.54 | 1.06 | 1.74 | 3.84 | 0.12 | 0.18 | 0.94 | 1.56 | 200x13839 |

**`rps` is not a capacity figure.** Every scenario runs a fixed number of workers, so `rps ≈ conc / latency` — Little's Law. Where the backend is deliberately slow the rps column is therefore arithmetic and says nothing about the gateway: `latency-30s` at concurrency 8 against a 30-second backend *cannot* exceed 0.27 rps, and the same scenario at concurrency 800 would report 27 rps and mean exactly as little. Read **rps** only for rows whose backend is fast (`baseline`, the policy group, the rejection group); read **p50/p95** and the **+p50/+p95** overhead columns everywhere else. `n` is the sample count: a percentile drawn from single digits is the maximum wearing a hat.

## What each policy costs

Two subtractions, both necessary. **Overhead** is gateway minus direct for that scenario, run seconds apart. **Cost** is that overhead minus the overhead of a no-policy baseline run immediately before the same scenario — because a loopback run drifts by more than any single policy costs, and a baseline measured minutes earlier would report the drift as policy cost. A negative number is noise, not a speed-up.

| Policy | overhead p50 ms | cost p50 ms | overhead p95 ms | cost p95 ms | what it does |
|---|---:|---:|---:|---:|---|
| `auth` | 0.98 | 0.04 | 1.62 | 0.08 | auth.subscriptionKey: hash the presented key and look it up |
| `precondition-equals` | 0.98 | 0.01 | 1.64 | 0.04 | one requireHeader rule, constant-time compare |
| `precondition-pattern` | 0.95 | -0.02 | 1.53 | -0.11 | one requireHeader rule matching a linted regex |
| `ratelimit` | 1.04 | 0.08 | 1.66 | 0.11 | fixed-window counter with a limit high enough never to reject |
| `headers` | 1.07 | 0.14 | 1.76 | 0.25 | remove, set, append with template rendering |
| `all-policies` | 1.06 | 0.11 | 1.68 | 0.18 | auth + rate limit + precondition + header rules together |

**Run drift.** `baseline` ran first at p95 1.73 ms and `baseline-again` ran last at p95 1.74 ms (0.01 ms). On a loopback run this is mostly ephemeral-port and connection-pool churn on the host, not the gateway. Read any per-policy figure smaller than this gap as noise.

## What validation costs

The same POST, the same body, the same compiled schema — three states. `disabled` is the **floor, not zero**: the `always` block (content type, body size, nesting depth, duplicate keys) runs in every state, which is the point of it. So the number that answers "what does schema validation cost" is each row minus that floor, and it is given here rather than left to the reader.

| State | rps | vs disabled | p50 ms | p95 ms | +p50 vs disabled |
|---|---:|---:|---:|---:|---:|
| `disabled` | 4679.77 | — | 1.53 | 3.11 | — |
| `blocking` | 5001.71 | 6.88% | 1.43 | 2.93 | -0.1 |
| `warning` | 4991.05 | 6.65% | 1.48 | 2.88 | -0.05 |

`warning` is sampled at 1.0 here, so it is the *worst* case for that state rather than the usual one. It never rejects and never delays the response — but on this runtime it is not isolated from the request path either (deviation D19), which is why it is measured on the same axis as `blocking` instead of being assumed free.

## Rejection paths

A request the gateway rejects never reaches a backend, so these are the floor of what the pipeline costs.

| Scenario | rps | p50 ms | p95 ms | statuses | what it does |
|---|---:|---:|---:|---|---|
| `reject-401` | 47670.8 | 0.15 | 0.21 | 401x95344 | no key: rejected at step 4, the backend is never reached |
| `reject-403` | 44168.68 | 0.16 | 0.23 | 403x88343 | precondition denial, after the rate limit has already been consumed |
| `reject-429` | 39252.44 | 0.18 | 0.26 | 429x78586 | over the limit: the cheapest possible answer |
| `reject-404` | 49471.68 | 0.14 | 0.2 | 404x98946 | no route matches: the shortest path through the pipeline |
| `reject-415-soap-fault` | 6715.44 | 1.13 | 1.85 | 500x13438 | rejected at step 3 and rendered as a SOAP Fault instead of problem+json |
| `validate-reject` | 17430.44 | 0.31 | 1.19 | 400x34873 | a body the schema refuses: rejected before any backend call, naming the JSON pointer |

## Payload throughput

For a body-moving scenario, requests per second is the wrong unit — these run at concurrency 4, so rps is capped by that, not by the gateway. Bytes per second is the number. Note that a proxied request moves each byte **twice**: client to gateway, then gateway to backend.

| Scenario | conc | req MiB/s | resp MiB/s | p50 ms | direct p50 ms | +p50 ms |
|---|---:|---:|---:|---:|---:|---:|
| `body-1mib-up` | 4 | 329.88 | 0.13 | 11.92 | 1.42 | 10.5 |
| `body-1mib-down` | 4 | 0 | 881.9 | 4.21 | 2.41 | 1.8 |

## What counting costs

The same 1 MiB response through two gateways: one counting bytes and outcomes, one with `DP_TELEMETRY=off`. Counting is per byte on the response path, so a large body is where it shows. Measured rather than assumed, because the alternative is a guess.

| Gateway | conc | p50 ms | p95 ms | resp MiB/s |
|---|---:|---:|---:|---:|
| `telemetry-off` | 4 | 4.58 | 7.67 | 817.2 |
| `telemetry-on` | 4 | 4.26 | 6.69 | 883.94 |

Counting costs **-0.32 ms p50** and **-0.98 ms p95** on a 1 MiB response. Turning it off also turns off everything the Telemetry view shows, which is the trade.

## Reaching a backend nothing publicly trusts

Both rows go through the same gateway to the same HTTPS backend, whose certificate is signed by a CA generated for this run. They differ only in how that certificate is settled: `trust-anchor` registers the CA for the environment, `tls-exception-pin` pins the leaf and installs a custom `checkServerIdentity`.

| Scenario | conc | n | rps | p50 ms | p95 ms | statuses | note |
|---|---:|---:|---:|---:|---:|---|---|
| `trust-anchor` | 8 | 13675 | 6836.13 | 1.08 | 1.77 | 200x13675 | verify normally against a CA registered for the environment: no exception |
| `tls-exception-pin` | 8 | 13591 | 6794.39 | 1.1 | 1.78 | 200x13591 | the same backend reached through a pinned exception (custom checkServerIdentity) |

Measured here: the pin is **0.02 ms p50** and **0.01 ms p95** away from the registered anchor (a negative number means it was faster in this run). Both are within a run's own drift of each other and of the plain-HTTP `baseline` row, so on loopback with an ECDSA P-256 certificate **neither TLS path costs anything this harness can resolve** — the earlier expectation that a pin would pay a handshake per request does not reproduce through the gateway's client, and is not claimed here.

The argument for retiring a pin is therefore correctness rather than speed: a pin trusts one certificate and breaks the day the backend rotates it, while a registered anchor trusts the issuer and keeps verifying. And an exception is a dated hole in verification that somebody has to renew; an anchor is not.

## Backend latency and timeouts

The gateway adds a fixed cost; the backend's own delay dominates. rps here is `conc / latency` and is shown only so the arithmetic is checkable — the column that means something is **+p50**, the gateway's cost on top of a backend that is asleep.

| Scenario | conc | n | rps | p50 ms | direct p50 ms | +p50 ms | statuses | note |
|---|---:|---:|---:|---:|---:|---:|---|---|
| `latency-100ms` | 16 | 624 | 154.06 | 103.29 | 101.27 | 2.02 | 200x624 | backend at 100 ms; overhead should disappear into it |
| `latency-2s` | 16 | 32 | 7.99 | 2003.27 | 2000.86 | 2.41 | 200x32 | backend at 2 s, timeoutMs 60 s |
| `latency-30s` | 8 | 8 | 0.27 | 30004.01 | 30001.49 | 2.52 | 200x8 | backend at the 30 s ceiling with timeoutMs 60 s: still a 200 |
| `timeout-edge` | 8 | 8 | 1.6 | 5002.46 | — | — | 504x8 | 30 s backend against timeoutMs 5 s: every request is a 504, deliberately |

A slow backend is also thin on samples: at concurrency 8 against a 30-second backend, a 4-second measurement window collects exactly 8 requests, one per worker. Those percentiles are the maximum by another name. The `full` profile widens the window to 35 seconds; nothing short of minutes would give `latency-30s` a real distribution, and it is here to prove the timeout boundary rather than to characterise a curve.

## What the control plane saw

The same run, read back through `/api/telemetry/summary` — the gateway's own counters, aggregated per minute. Percentiles here are interpolated from 15 histogram buckets and are labelled approximate; the table above uses exact samples the harness kept.

| | |
|---|---:|
| requests | 698418 |
| ok | 288761 |
| gateway rejections | 396199 |
| upstream errors | 13458 |
| bytes out | 3856907244 |
| p50 / p95 (approximate) | 1 / 1 ms |

## Change since the previous run

Previous run: 2026-09-03T15:50:24.324Z.

| Scenario | p95 now | p95 then | change |
|---|---:|---:|---:|
| `baseline` | 1.73 | 1.87 | -0.14 |
| `auth` | 1.81 | 1.69 | 0.12 |
| `precondition-equals` | 1.83 | 1.7 | 0.13 |
| `precondition-pattern` | 1.72 | 1.68 | 0.04 |
| `ratelimit` | 1.85 | 1.9 | -0.05 |
| `headers` | 1.93 | 1.86 | 0.07 |
| `all-policies` | 1.88 | 1.92 | -0.04 |
| `reject-401` | 0.21 | 0.22 | -0.01 |
| `reject-403` | 0.23 | 0.23 | 0 |
| `reject-429` | 0.26 | 0.3 | -0.04 |
| `reject-404` | 0.2 | 0.24 | -0.04 |
| `reject-415-soap-fault` | 1.85 | 1.79 | 0.06 |
| `validate-disabled` | 3.11 | 3.41 | -0.3 |
| `validate-blocking` | 2.93 | 3.16 | -0.23 |
| `validate-warning` | 2.88 | 3.24 | -0.36 |
| `validate-reject` | 1.19 | 1.27 | -0.08 |
| `body-1mib-up` | 15.38 | 17.49 | -2.11 |
| `body-1mib-down` | 6.85 | 7.18 | -0.33 |
| `telemetry-on` | 6.69 | 8.02 | -1.33 |
| `telemetry-off` | 7.67 | 8.89 | -1.22 |
| `latency-100ms` | 107.19 | 105.77 | 1.42 |
| `latency-2s` | 2003.5 | 2005.32 | -1.82 |
| `latency-30s` | 30004.02 | 30002.69 | 1.33 |
| `timeout-edge` | 5002.56 | 5003.31 | -0.75 |
| `soap-small` | 3.15 | 3.46 | -0.31 |
| `fleet-2` | 1.75 | 1.95 | -0.2 |
| `trust-anchor` | 1.77 | 1.74 | 0.03 |
| `tls-exception-pin` | 1.78 | 1.85 | -0.07 |
| `baseline-again` | 1.74 | 1.69 | 0.05 |

## What this does not measure

- **One machine.** The load generator, both gateways, the control plane and the backend share the same cores, so they compete with each other. The paired direct numbers absorb most of that, but not all of it.
- **No TLS and no reverse proxy.** Design section 8.1 puts both in front of a real gateway.
- **Loopback only.** No network latency, so proxy overhead is at its most visible here.
- **One body, one schema.** The validation rows use a small Pet document against the petstore's own schema. Validation cost scales with both, and design section 13 calls it the dominant variable in a real deployment — so treat the percentage below as the shape of the cost, not its size for your contracts.
- **Rate limiting is per instance** (design section 5.7): the `fleet-2` row spreads traffic over two gateways, which is why an effective limit is `calls x instances`.
