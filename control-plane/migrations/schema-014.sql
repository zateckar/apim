-- ---------------------------------------------------------------------------------------------
-- v14 — the gateway's own latency becomes something the estate can see.
--
-- Two defects, one cause. The platform's stated goal is that a gateway add well under a
-- millisecond to a request, and until now nothing in it could observe that:
--
--   - `BUCKET_BOUNDS_MS` began at 1 ms, so every request the gateway answered from cache or
--     refused outright — and every proxied request on a fast network — landed in bucket 0. The
--     dashboard's only possible answer was "1 ms", whether the truth was 0.3 or 0.9, and
--     `reports/perf-report.md` had to read its own headline back as "p50 / p95 (approximate) 1 / 1
--     ms". Two sub-millisecond bounds are added, 0.25 and 0.5.
--
--   - the rollup recorded total latency only, so a slow backend and a slow gateway were the same
--     row. `backendMs` was measured per request and written into the access log, then thrown away
--     before it reached telemetry. It now travels, alongside a histogram of `duration − backend`
--     computed per request on the instance.
--
-- The buckets are widened rather than reinterpreted. A stored array of exactly 15 entries was
-- written by a build whose index 0 meant "<= 1 ms" — which is this build's index 2 — so two empty
-- buckets are prepended and every count keeps the meaning it was written with. Nothing pretends to
-- know which of the three sub-millisecond buckets an old "<= 1 ms" request belonged to, because
-- nothing does. `json_array_length` guards it, so the statement is idempotent and a row already
-- 17 wide (there are none, but a partially-applied upgrade should not need to be reasoned about)
-- is left alone.
--
-- `gateway_buckets_json` defaults to '[]' rather than a 17-zero array: an existing row has no
-- attribution and must read as "no data" rather than as 17 buckets' worth of zero observations,
-- which `percentile` already answers `null` for. New rows carry the real thing.
--
-- The sums become REAL because the durations behind them are now fractional. SQLite's column types
-- are advisory, so this affects nothing already stored and the existing integers read back
-- unchanged; it is declared for the next person reading the schema rather than for the engine.
--
-- CONFIG_VERSION is deliberately **unchanged**, and that is worth stating because it looks like it
-- should have moved. Both directions degrade correctly without one:
--
--   - an instance on the previous build reports 15-wide buckets and no attribution. `addBuckets`
--     widens the first (`widenBuckets`, which is the same rule this migration applies to stored
--     rows) and the three new fields read as absent, so its traffic is counted exactly as before
--     and simply carries no gateway/backend split.
--   - an instance on this build handed a document from a previous control plane finds no
--     `serverTiming` in `settings`, which is the same answer as off.
--
-- A version bump would have blocked activation across a fleet mid-upgrade to gain nothing: the
-- whole change is additive, and a rolling restart converges on its own.
-- ---------------------------------------------------------------------------------------------

ALTER TABLE telemetry_rollup ADD COLUMN gateway_buckets_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE telemetry_rollup ADD COLUMN backend_ms_sum       REAL NOT NULL DEFAULT 0;
ALTER TABLE telemetry_rollup ADD COLUMN backend_count        INTEGER NOT NULL DEFAULT 0;

UPDATE telemetry_rollup
   SET buckets_json = '[0,0,' || substr(buckets_json, 2)
 WHERE json_array_length(buckets_json) = 15;
