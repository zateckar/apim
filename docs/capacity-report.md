# Gateway capacity report

> **Generated** by `bun run capacity --profile=quick --cpus=2` at 2026-09-02T19:30:13.572Z. Edits are overwritten; change `tools/capacity/index.ts` instead.

This is the companion to [`perf-report.md`](perf-report.md) and answers the opposite question. That report measures **what the gateway adds** — a difference, at one fixed concurrency, with everything in one process. This one measures **what the gateway takes** — an absolute number, swept up a concurrency ladder, with the gateway alone on a stated CPU budget and the load generated from processes that are not allowed near it.

## The short answer

On **2 cores**, one gateway process sustains **17,356 rps** on a normal published API (key check, rate limit, header rule, timeout) against a fast backend, and **11,229 rps** on mixed traffic (70% small, 20% 8 KiB, 6% 64 KiB, 2% 1 MiB, 2% a 200 ms backend). The ceiling with no policy at all is **24,424 rps**, so the whole policy pipeline costs less than this harness can distinguish from its own run-to-run spread of 29%.

**It does not use the 2 cores.** Bun serves HTTP from a single JavaScript thread, so one gateway process is a one-core program however many cores it is scheduled on. More processes is therefore the way to use more cores, and [Using the other cores](#using-the-other-cores) measures how far that goes before this harness — rather than the gateway — becomes the limit.

Past **concurrency 16** throughput stops rising and latency starts growing in proportion to the load offered — the queue, not the service, is what grows. p99 at that point is **3.69 ms**.

**Memory: about 113.34 MiB per process** in steady state, 42.81 MiB of it at rest before any traffic. The section [Memory](#memory) breaks that into base, configuration and in-flight work.

## How this was measured

| | |
|---|---|
| Host | Windows_NT 10.0.22631 |
| CPU | 12th Gen Intel(R) Core(TM) i7-12700 (20 logical) |
| Memory | 32 GiB |
| Runtime | Bun 1.4.0 |
| Gateway CPU budget | 2 cores — CPUs 0, 2 |
| Harness CPUs | 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19 |
| Load generators | 6 processes |
| Profile | quick |
| Wall time | 21 min |

Every piece is its own process, and none of the others may touch the gateway's cores: the gateway, the control plane, the petstore backend, and the load generators. The CPU budget is a Windows `ProcessorAffinity` mask, read back after it is set, and the run aborts if it did not take. The gateway's 2 CPUs are 2 *physical* cores with their SMT siblings left idle, so the budget means what it says — the cloud reading of “4 vCPU” is four hyperthreads on two cores and is worth appreciably less.

**Reading a plateau.** Throughput flattening only means the *gateway* is the limit if nothing else gave out first, so every table carries `direct rps`: the same work, at the same concurrency, sent straight to the backend. That is the harness's own ceiling. Where it is comfortably above the gateway's number the row is about the gateway; where it is not, the row is about the harness, and the text says so rather than leaving it to be noticed.

## Throughput against a fast backend

Each workload swept up a concurrency ladder. The backend answers immediately, so this is the gateway's own request-handling ceiling and nothing else.

### `bare`

route match and proxy, no policy: the ceiling the rest are measured against.

| conc | rps | p50 ms | p95 ms | p99 ms | rss MiB | direct rps | direct p50 | +p50 ms | errors |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | 7,358 | 0.11 | 0.19 | 0.42 | 96.73 | 21,520 | 0.04 | 0.07 | 0 |
| 16 | 23,604 | 0.55 | 1.06 | 2.49 | 100.83 | 38,817 | 0.42 | 0.13 | 0 |
| 64 | 24,424 | 2.11 | 4.72 | 7.02 | 102.29 | 37,006 | 1.7 | 0.41 | 0 |
| 256 | 17,433 | 12.09 | 34.74 | 41.41 | 98.63 | 36,715 | 7.35 | 4.74 | 0 |

Peak **24,424 rps**; 95% of it is reached at concurrency **16** (p99 2.49 ms).

### `typical`

key check, rate limit, one header rule, timeout — a normal published API.

| conc | rps | p50 ms | p95 ms | p99 ms | rss MiB | direct rps | direct p50 | +p50 ms | errors |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | 6,368 | 0.12 | 0.21 | 0.49 | 110.26 | 23,969 | 0.04 | 0.08 | 0 |
| 16 | 16,678 | 0.9 | 1.86 | 3.69 | 99.36 | 35,129 | 0.43 | 0.47 | 0 |
| 64 | 17,356 | 3.64 | 6.17 | 8.02 | 101.69 | 39,053 | 1.67 | 1.97 | 0 |
| 256 | 16,626 | 15.28 | 22.72 | 27.8 | 101.32 | 37,233 | 7.03 | 8.25 | 0 |

Peak **17,356 rps**; 95% of it is reached at concurrency **16** (p99 3.69 ms).

### `full`

every applicable policy unit at once.

| conc | rps | p50 ms | p95 ms | p99 ms | rss MiB | direct rps | direct p50 | +p50 ms | errors |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | 6,825 | 0.12 | 0.19 | 0.45 | 96.35 | 20,306 | 0.04 | 0.08 | 0 |
| 16 | 16,084 | 0.9 | 2.02 | 4.76 | 102.3 | 28,005 | 0.44 | 0.46 | 0 |
| 64 | 14,529 | 3.83 | 8.6 | 14.27 | 98.25 | 28,594 | 1.86 | 1.97 | 0 |
| 256 | 15,807 | 15.83 | 21.72 | 51.09 | 102.96 | 40,581 | 6.81 | 9.02 | 0 |

Peak **16,084 rps**; 95% of it is reached at concurrency **16** (p99 4.76 ms).

### `soap`

XML prefix scan and SOAPAction agreement on every request.

| conc | rps | p50 ms | p95 ms | p99 ms | rss MiB | direct rps | direct p50 | +p50 ms | errors |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | 1,765 | 0.2 | 0.93 | 1.5 | 95.39 | 19,445 | 0.04 | 0.16 | 0 |
| 4 | 6,516 | 0.45 | 1.38 | 2.04 | 88.46 | 36,775 | 0.13 | 0.32 | 0 |
| 16 | 6,680 | 2.37 | 3.41 | 5.15 | 97.75 | 36,647 | 0.49 | 1.88 | 0 |
| 32 | 6,951 | 4.26 | 6.97 | 10.29 | 96.8 | 36,812 | 0.96 | 3.3 | 0 |
| 64 | 6,566 | 8.62 | 12.61 | 17.87 | 94.99 | 34,428 | 1.91 | 6.71 | 0 |

Peak **6,951 rps**; 95% of it is reached at concurrency **16** (p99 5.15 ms).

### `reject-401`

rejected before any backend call: the pipeline's own floor.

| conc | rps | p50 ms | p95 ms | p99 ms | rss MiB | direct rps | direct p50 | +p50 ms | errors |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | 20,598 | 0.04 | 0.05 | 0.1 | 88.84 | — | — | — | 0 |
| 16 | 59,610 | 0.24 | 0.32 | 0.94 | 79.96 | — | — | — | 0 |
| 64 | 62,784 | 0.95 | 1.45 | 2.55 | 78.96 | — | — | — | 0 |
| 256 | 64,338 | 3.68 | 5.73 | 6.94 | 90.97 | — | — | — | 0 |

Peak **64,338 rps**; 95% of it is reached at concurrency **64** (p99 2.55 ms).

### `validate-off`

a POST with no schema check — the floor, since the always block still runs.

| conc | rps | p50 ms | p95 ms | p99 ms | rss MiB | direct rps | direct p50 | +p50 ms | errors |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | 3,358 | 0.17 | 0.9 | 2.47 | 89.82 | 18,165 | 0.04 | 0.13 | 0 |
| 4 | 7,533 | 0.27 | 1.73 | 2.87 | 101.04 | 57,423 | 0.06 | 0.21 | 0 |
| 16 | 8,126 | 1.79 | 3.98 | 5.73 | 94.59 | 59,600 | 0.22 | 1.57 | 0 |
| 32 | 8,355 | 3.5 | 6.59 | 9.07 | 94.11 | 62,267 | 0.44 | 3.06 | 0 |
| 64 | 8,772 | 6.86 | 11.22 | 13.02 | 91.96 | 61,646 | 0.86 | 6 | 0 |
| 128 | 8,751 | 14.17 | 19.41 | 23.57 | 93.06 | 54,919 | 1.92 | 12.25 | 0 |

Peak **8,772 rps**; 95% of it is reached at concurrency **32** (p99 9.07 ms).

### `validate-block`

the same POST, buffered and validated against the compiled schema before the backend.

| conc | rps | p50 ms | p95 ms | p99 ms | rss MiB | direct rps | direct p50 | +p50 ms | errors |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | 4,417 | 0.15 | 0.72 | 1.55 | 93.35 | 19,016 | 0.04 | 0.11 | 0 |
| 4 | 7,188 | 0.31 | 1.78 | 2.97 | 101.31 | 56,071 | 0.06 | 0.25 | 0 |
| 16 | 7,854 | 1.91 | 3.96 | 5.33 | 96.61 | 63,039 | 0.22 | 1.69 | 0 |
| 32 | 7,904 | 3.6 | 6.66 | 8.93 | 97.36 | 64,895 | 0.43 | 3.17 | 0 |
| 64 | 8,364 | 7.36 | 11.19 | 13.5 | 93.71 | 61,513 | 0.87 | 6.49 | 0 |
| 128 | 7,545 | 15.79 | 22.94 | 39.99 | 94.83 | 47,035 | 2.59 | 13.2 | 0 |

Peak **8,364 rps**; 95% of it is reached at concurrency **64** (p99 13.5 ms).

### `validate-warn`

the same POST, sampled at 1.0 and never rejecting — off the response path, not off the thread (D19).

| conc | rps | p50 ms | p95 ms | p99 ms | rss MiB | direct rps | direct p50 | +p50 ms | errors |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | 3,554 | 0.18 | 0.79 | 2.12 | 107.68 | 16,491 | 0.05 | 0.13 | 0 |
| 4 | 6,690 | 0.3 | 2.27 | 3.25 | 107.99 | 50,289 | 0.06 | 0.24 | 0 |
| 16 | 6,777 | 2.18 | 4.63 | 7.33 | 99.66 | 52,529 | 0.26 | 1.92 | 0 |
| 32 | 7,118 | 4.09 | 7.91 | 10.84 | 101.79 | 54,523 | 0.52 | 3.57 | 0 |
| 64 | 7,549 | 8.04 | 13.03 | 15.2 | 99.68 | 52,517 | 1.1 | 6.94 | 0 |
| 128 | 7,848 | 15.71 | 22.04 | 24.85 | 100.93 | 62,512 | 1.81 | 13.9 | 0 |

Peak **7,848 rps**; 95% of it is reached at concurrency **64** (p99 15.2 ms).

### `mixed`

70% small, 20% 8 KiB, 6% 64 KiB, 2% 1 MiB, 2% a 200 ms backend.

| conc | rps | p50 ms | p95 ms | p99 ms | rss MiB | direct rps | direct p50 | +p50 ms | errors |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | 260 | 0.14 | 0.73 | 201.47 | 88.36 | 258 | 0.04 | 0.1 | 0 |
| 4 | 905 | 0.3 | 2.18 | 203.05 | 89.39 | 1,012 | 0.06 | 0.24 | 0 |
| 16 | 3,475 | 0.26 | 2.01 | 201.26 | 102.6 | 3,655 | 0.06 | 0.2 | 0 |
| 32 | 6,710 | 0.36 | 2.7 | 201.53 | 104.49 | 7,480 | 0.06 | 0.3 | 0 |
| 64 | 10,552 | 1.27 | 5.56 | 203.47 | 107.63 | 14,599 | 0.05 | 1.22 | 0 |
| 128 | 11,229 | 6.05 | 14.48 | 209.62 | 108.41 | 17,302 | 2.37 | 3.68 | 0 |

Peak **11,229 rps**; 95% of it is reached at concurrency **128** (p99 209.62 ms).

### What the pipeline costs, as throughput

| Workload | peak rps | vs `bare` | knee | p99 at the knee |
|---|---:|---:|---:|---:|
| `bare` | 24,424 | — | 16 | 2.49 ms |
| `typical` | 17,356 | -29% | 16 | 3.69 ms |
| `full` | 16,084 | -34% | 16 | 4.76 ms |
| `soap` | 6,951 | -72% | 16 | 5.15 ms |
| `reject-401` | 64,338 | 163% | 64 | 2.55 ms |
| `validate-off` | 8,772 | -64% | 32 | 9.07 ms |
| `validate-block` | 8,364 | -66% | 64 | 13.5 ms |
| `validate-warn` | 7,848 | -68% | 64 | 15.2 ms |
| `mixed` | 11,229 | -54% | 128 | 209.62 ms |

Size from throughput, not from CPU. Per-request CPU would be the better sizing figure — it does not depend on the concurrency the ladder happened to reach — but it could not be measured reliably here; see [what is not measured](#what-this-still-does-not-measure).

Read the three `validate-*` rows against **each other**, not against `bare`: they POST a body where `bare` does a small GET, so most of the difference from `bare` is the body, not the checking. The comparison that means something is below.

### What validation costs, as capacity

One contract, one body, three states, the same ladder. `validate-off` is the **floor, not zero**: the `always` block — content type, body size, nesting depth, duplicate keys — is enforced in every state, which is the point of it. So the column that answers "what does schema validation cost me" is the one against `validate-off`.

| State | peak rps | vs `off` | knee | p99 at the knee |
|---|---:|---:|---:|---:|
| `off` | 8,772 | — | 32 | 9.07 ms |
| `block` | 8,364 | -5% | 64 | 13.5 ms |
| `warn` | 7,848 | -11% | 64 | 15.2 ms |

Two things this does **not** say. It does not say what validation will cost *your* estate: the figure scales with the schema and the body, and this is one small Pet document against the petstore's own schema. And `warn` is sampled at 1.0 here — the worst case for that state, not the usual one — because sampling at 0.1 would measure the sampler. It is charted on the same axis as `block` rather than assumed free because on this runtime it is not isolated from the request path (deviation D19).

### Where the time actually goes

`reject-401` is the whole pipeline with the upstream call removed: it parses the request, matches a route, hashes and looks up a key, and answers — at **64,338 rps**. `bare` does *less* policy work but makes the upstream call, and manages **24,424**. Adding one outbound HTTP request costs about **62%** of the achievable rate, which is to say: policy is not what limits this gateway, being an HTTP client is.

The per-request allocations that looked like suspects — a fresh `AbortSignal.timeout` for the request deadline, a `Headers` clone, a `randomUUID` for the request id, a `URL` parse — were each measured directly, in isolation, at well under a microsecond, and under 1 µs combined. Whatever the remaining cost is, it is not those.

## Slow backends: how much can one process hold

A gateway in front of a slow service spends its time holding sockets, not burning CPU. The question is how many it can hold at once before latency stops being the backend's fault. `rps` here is `concurrency / latency` and is included only so the arithmetic is checkable.

### `backend-50ms` — a fast internal service

| conc | rps | p50 ms | p99 ms | direct p50 | +p50 ms | rss MiB | in flight | errors |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 64 | 1,231 | 51.5 | 54.55 | 51.15 | 0.35 | 99.01 | 64 | 0 |
| 1024 | 4,848 | 205.03 | 275.94 | 52.09 | 152.94 | 132.71 | 1024 | 250 |

### `backend-500ms` — a slow one

| conc | rps | p50 ms | p99 ms | direct p50 | +p50 ms | rss MiB | in flight | errors |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 64 | 127 | 503.77 | 512.25 | 502.24 | 1.53 | 101.36 | 64 | 0 |
| 1024 | 498 | 1863.76 | 2015.68 | 504.4 | 1359.36 | 118.13 | 1024 | 232 |

### `backend-2s` — a bad day

| conc | rps | p50 ms | p99 ms | direct p50 | +p50 ms | rss MiB | in flight | errors |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 256 | 127 | 2003.44 | 2020.15 | 2005.11 | -1.67 | 100.66 | 256 | 0 |
| 1024 | 128 | 7997.54 | 8031.47 | 2003.87 | 5993.67 | 102.71 | 598 | 0 |

## Payload size

A proxied byte is moved twice — client to gateway, gateway to backend — and with telemetry on it is also counted. Requests per second is the wrong unit here; bytes per second is the number.

| direction | size | conc | rps | MiB/s | p50 ms | p99 ms | direct p50 | +p50 ms | errors |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| request | 4 KiB | 16 | 7,206 | 28.15 | 1.83 | 5.61 | 0.56 | 1.27 | 0 |
| response | 4 KiB | 16 | 17,999 | 70.19 | 0.62 | 3.11 | 0.46 | 0.16 | 0 |
| request | 64 KiB | 16 | 4,148 | 259.22 | 3.62 | 7.23 | 0.75 | 2.87 | 0 |
| response | 64 KiB | 16 | 6,860 | 428.69 | 2.11 | 4.79 | 1.2 | 0.91 | 0 |
| request | 256 KiB | 16 | 1,443 | 360.76 | 10.58 | 22.29 | 1.69 | 8.89 | 0 |
| response | 256 KiB | 16 | 4,152 | 1037.98 | 3.76 | 6.73 | 3.34 | 0.42 | 0 |
| request | 1 MiB | 16 | 363 | 362.76 | 41.41 | 75.41 | 11.77 | 29.64 | 0 |
| response | 1 MiB | 16 | 943 | 943.3 | 16.58 | 28.63 | 15.67 | 0.91 | 0 |
| request | 4 MiB | 16 | 529 | 2117.56 | 29.21 | 37.98 | 59.63 | -30.42 | 0 |
| response | 4 MiB | 16 | 255 | 1019.45 | 60.01 | 110.51 | 53.26 | 6.75 | 0 |
| request | 40 MiB | 4 | 70 | 2803.41 | 52.98 | 136.25 | 226.74 | -173.76 | 0 |
| response | 40 MiB | 4 | 20 | 804.79 | 189.93 | 342.34 | 161.22 | 28.71 | 0 |

## Using the other cores

One process is one JavaScript thread, so the way to use a second core is a second process. Two arrangements are measured. **`fleet`** is N gateway processes, each its own seeded instance with its own token and port, addressed by a client that cycles them — the fleet the control plane already models, and what a real load balancer in front would do. **`shared port`** is N processes on one port via `DP_REUSE_PORT=1`, letting the kernel spread the connections. Same CPU budget, same workload, same offered concurrency.

`reject-401` calls no backend, so its scaling is the gateway's own and is the row to read. `typical` proxies, and past one process it stops being a measurement of the gateway: four gateways offer far more work than one single-threaded petstore simulator will accept. Rows marked ⚠ are those, and they are left in rather than dropped — a table that quietly showed only what worked would not tell you where the measurement ends.

| arrangement | processes | workload | rps | vs 1 | p50 ms | p95 ms | p99 ms | rss MiB | statuses |
|---|---:|---|---:|---:|---:|---:|---:|---:|---|
| fleet | 1 | `reject-401` | 61,947 | 1x | 3.92 | 5.25 | 6.3 | 73.41 | 401x186113 |
| fleet | 1 | `typical` | 20,322 | 1x | 11.36 | 22.18 | 27.86 | 107.34 | 200x61160 |
| fleet | 4 | `reject-401` | 52,139 | 0.84x | 0.22 | 23.27 | 43.47 | 243.97 | 401x156912 |
| fleet | 4 | `typical` | 4,691 ⚠ | — | 51.72 | 79.56 | 94.5 | 281.24 | 200x11956 0x2335 |
| shared port | 4 | `reject-401` | 60,502 | 0.98x | 3.99 | 5.69 | 6.79 | 62.67 | 401x181775 |
| shared port | 4 | `typical` | 853 ⚠ | — | 273.32 | 384.64 | 450.17 | 88.82 | 502x1764 200x977 |

⚠ marks a row that is not about the gateway. Either more than 1% of requests failed to *connect* — a `0` in the statuses column, the load generators giving out, because six generator processes cannot offer the several hundred thousand requests a second that four gateway processes will now accept — or more than 1% came back `502`, which is the single-threaded petstore simulator refusing connections from four gateways at once. Those rows carry no ratio, because the ratio would describe the harness. Everything claimed below rests on the clean rows only.

**On this platform `DP_REUSE_PORT` does spread the load.** 4 processes on one port reached 60,502 rps against 52,139 rps for the same 4 processes on separate ports.

**More processes are not free.** Rate limiting is per process (design §5.7 scopes counters per instance), so an effective limit is `calls × processes` either way. In the `fleet` arrangement that arithmetic is at least visible — each process is an instance the UI shows. Behind a shared port it is not: the fleet view shows one instance and the real limit is silently N times the configured one. Telemetry survives both, because rollups are keyed by `run_id`, which is already per process.

## Can one slow backend take the others with it?

One route is flooded — 512 concurrent requests to a backend that takes two seconds, or in the last row a few very large uploads. A second route on the same instance, with a healthy backend, is probed at concurrency 8 while that is happening. A gateway that isolates its routes answers the probe as if nothing were wrong, and the first row is what that looks like when nothing is wrong.

| configuration | probe p50 ms | probe p99 ms | probe rps | held in flight | rss MiB | flood outcome |
|---|---:|---:|---:|---:|---:|---|
| control: no flood | 0.28 | 1.94 | 21,836 | — | 114.65 | — |
| narrow outbound queue | 8.92 | 17.89 | 854 | 256 | 88.13 | 503x198915 200x1024 |
| wide outbound queue | 0.28 | 1.94 | 22,072 | 520 | 137.33 | 200x2048 |
| per-route ceiling | 15.9 | 25.61 | 494 | 72 | 85.13 | 503x235166 200x256 |
| 40 MiB uploads | 2.34 | 6.51 | 2,944 | 1 | 71.36 | 413x349 |

- **control: no flood** — the healthy route with nothing else running, so the rows below have a baseline
- **narrow outbound queue** — `BUN_CONFIG_MAX_HTTP_REQUESTS=256`, the runtime's own default, with the instance ceiling matched to it and no per-route unit. This is what a gateway looks like when nobody chose the value.
- **wide outbound queue** — `BUN_CONFIG_MAX_HTTP_REQUESTS=8192`, instance ceiling 2048, still no per-route unit
- **per-route ceiling** — the same, plus `concurrency: { maxInFlight: 64 }` on the slow route only
- **40 MiB uploads** — four concurrent 40 MiB POSTs against a *fast* backend, instead of a slow backend. A large body is not a slow backend: it is work, on the one thread that also answers everything else.

**Why a timeout is not enough.** `timeoutMs` bounds how long one request waits; it does not bound how many are waiting. Requests arrive at whatever rate the callers choose and leave only when the backend answers or the timeout expires, so in-flight work settles at roughly `arrival rate × timeout`. At 500 rps against a hung backend with a 30-second timeout that is 15,000 requests parked on one process, each holding a client socket, an upstream socket and its buffers. Nothing looks busy while it happens — the slow-backend tables above show one process holding a thousand parked requests at a working set barely above idle — which is exactly why it is easy to miss, until the process runs out of the things it holds and takes every other route with it.

**The fix is a ceiling per route, and shedding at it.** `concurrency: { maxInFlight }` is a bulkhead: the sick backend fills its own bucket, requests past it get a 503 with `Retry-After` immediately instead of joining a queue, and every other route is untouched. `MAX_CONCURRENT_REQUESTS` is the same idea per instance, as the backstop for routes with no unit attached. Queueing was considered and rejected: a request that waits in a queue and *then* waits for a timeout is strictly worse than one refused at once, and design §8.4 makes the same call for the validation pool.

**Also set `BUN_CONFIG_MAX_HTTP_REQUESTS`.** The runtime keeps its own ceiling on concurrent outbound HTTP requests per process, across every origin, and it applies whether or not anyone chose it. If it is lower than the work the gateway accepts it becomes an invisible shared queue with no per-route fairness and no shed — the one mechanism by which a slow backend really can make an unrelated route wait. Set it above `MAX_CONCURRENT_REQUESTS` so that the gateway's own accounting, which is per route and visible in `/healthz`, is the binding constraint.

## What logging and counting cost

Two things happen on every request that are configuration rather than code: a JSON line on stdout, and a telemetry record. Both are on by default and both can be turned off. Same workload, same concurrency, one process, only the settings differ. The harness discards the gateway's stdout, so the access-log rows are the cost of *formatting and writing* a line, not of whatever consumes it — a lower bound on what it costs against a real log driver, and it is what the harness can honestly measure without putting gigabytes a run on the same disk as everything else it is timing.

| setting | rps (median of 3) | vs default | run-to-run spread | p50 ms | what it is |
|---|---:|---:|---:|---:|---|
| both on (default) | 19,192 | — | ±18% | 3.3 | one JSON access-log line and one telemetry record per request |
| access log off | 23,055 | +20% | ±29% | 2.38 | `DP_ACCESS_LOG=off` — no per-request line on stdout |
| telemetry off | 21,205 | +10% | ±23% | 2.47 | `DP_TELEMETRY=off` — no counting, and no counting transform on the body |
| both off | 24,385 | +27% | ±9% | 2.33 | neither; the floor for how cheap a request can be made by configuration alone |

Read the middle column against the one beside it. The identical configuration, restarted and measured again, varied by up to **29%** between attempts, so any difference smaller than that is not a finding. Each row is the median of three runs, taken round-robin rather than three-at-a-time, after a discarded pass: with one run each an early attempt had the access log coming out *slower* turned off, and with three grouped by configuration whichever went first inherited a machine still settling from the phase before and carried a 52% spread while the others sat inside 13%.

Telemetry used to cost **119%** of throughput. It now measures at 10%, which is inside this table's own 29% spread — the honest statement is that its cost is no longer distinguishable from noise, not that it is precisely 10%. The difference is not a tuning change: counting response bytes meant pulling every response body through a transform stream, and allocating one per request cost more than all the counters it fed. The gateway now takes the byte count from `Content-Length` when the backend declared one and the runtime has not decompressed underneath it, and hands the body through untouched — falling back to the transform only for chunked or re-encoded responses, where there is no declared length to believe. What remains is the bookkeeping itself, which is a fair price for the Telemetry view.

## Memory

| | working set | note |
|---|---:|---|
| At rest, 7 routes | 42.81 MiB | started, polled, serving nothing |
| With 57 routes | 44.44 MiB | 50 more published APIs, 5 KiB each |
| Under load, c=64 mixed | 128.84 MiB | peak during a 20s run at 9,611 rps |
| 15 s after the load stopped | 113.34 MiB | heap in use 10.18 MiB |
| Peak ever, this process | 228.62 MiB | what a memory limit has to be above |

Bodies are the variable that matters. At concurrency 16 with 4 KiB responses the working set reached **120.5 MiB** — the gateway streams rather than buffering, but a chunk of every in-flight body is resident, so the figure to budget for is `concurrency × body size`, not `concurrency` alone.

Two cautions. A JavaScript working set is a high-water mark: it grows to fit the busiest moment and is returned to the operating system lazily, so the number after a burst is not the number during it and neither is a leak. And the `MAX_BODY_BYTES` ceiling (8 MiB by default, 16 MiB here) is what bounds the worst case — without it, concurrency times an unbounded body is the memory requirement.

## Sizing, in one paragraph

One process handles **17,356 rps** on a normal published API and **11,229** on mixed traffic, in about **113.34 MiB** of memory, plus `concurrency × body size` for whatever is in flight. A process will not use more than about one core whatever it is given, so **size by processes, not by cores** — the 4-process rows above show what that buys. Divide your target rate by the row that matches your traffic and keep the margin you would keep anywhere else; there is no CPU term to add, because a process runs out of single-thread throughput long before it runs out of cores. If the backend is slow none of this binds and the limit becomes sockets held open — see the slow-backend tables, where one process holds a thousand concurrent requests without difficulty.

## What this still does not measure

- **No TLS.** Design §8.1 puts termination on the reverse proxy in front. TLS is CPU work this report does not contain, and on small payloads it is not a rounding error.
- **Loopback.** No network latency, no packet loss, no congestion control worth the name.
- **One backend, deterministic and local.** Real upstreams have connection limits, DNS, and tail latency that is not a constant.
- **No schema validation** (deviation D12), which design §13 calls the dominant sizing variable in a real deployment. Every number here would be smaller with it.
- **Windows.** `ProcessorAffinity` is not a cgroup: the gateway gets the cores exclusively, but there is no memory limit and no throttling, so this is a generous approximation of a container.
- **A single run.** Each rung is one measurement, not a distribution of measurements. Treat differences under about 5% as noise.
- **CPU per request, which is missing on purpose.** It is the figure this report most wants — it is independent of concurrency, so it is the one you would multiply — and it could not be measured to a standard worth publishing on this platform. Both available sources fail in different ways. `Get-Process | TotalProcessorTime` is accurate but is read inside a `pwsh` spawn that takes 200 ms when the machine is idle and 1.7 s when it is busy, at an unknown moment within that, so it cannot be paired with a request count taken at a known instant. Bun's own `process.cpuUsage()` can be paired exactly — `/healthz` returns both counters from one handler call — and agrees with Windows to 0.1% over a 24-second window, but over the 3-to-6-second windows a ladder rung uses it frequently does not advance at all: about one sample in three came back 15–16 ms apart, one scheduler tick, for rungs that had served thirty thousand requests. The resulting ratios were bimodal and self-contradictory — `reject-401`, which does strictly less work than `typical`, came out more expensive. Three attempts to fix it produced three different wrong answers, so the column is gone rather than caveated. The one figure that survived scrutiny, from a single long quiet window with both sources agreeing, is roughly **7 µs per proxied request**; it is quoted here as an order of magnitude and nothing more.
