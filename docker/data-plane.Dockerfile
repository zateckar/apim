# A gateway. One process, no database, no UI, no control-plane code — it polls, activates a config
# document, and serves. The whole contract between the planes is that document, which is why this
# image shares nothing with the other one but `shared/`.

FROM oven/bun:1.4.1-alpine AS runtime

RUN apk add --no-cache curl

WORKDIR /app

COPY package.json bunfig.toml tsconfig.json ./
COPY shared/ ./shared/
COPY data-plane/ ./data-plane/

# The cache directories. Both are per instance and must be: the artifact cache holds compiled
# validators and the certificate material beside it is written 0600 (deviation D22), so two
# gateways sharing one directory would race on file names and on permissions.
ENV GATEWAY_CONFIG_CACHE=/var/lib/apim/config.json \
    GATEWAY_ARTIFACT_CACHE=/var/lib/apim/artifacts \
    DP_PORT=8081 \
    POLL_INTERVAL_SEC=5

# Both concurrency values, at the numbers `scripts/seed.ts` writes `[P1-22]`. This is not tidiness.
# v3 made the gateway refuse to start unless BUN_CONFIG_MAX_HTTP_REQUESTS >= MAX_CONCURRENT_REQUESTS
# precisely to catch the pairing an image that set neither would inherit: the runtime's default
# outbound queue against the gateway's default ceiling, where one slow backend delays every other
# route (docs/capacity-report.md). Raise them together or not at all.
ENV MAX_CONCURRENT_REQUESTS=8192 \
    BUN_CONFIG_MAX_HTTP_REQUESTS=16384 \
    MAX_CONCURRENT_UPGRADES=1024 \
    BLOCKING_BUFFER_BUDGET_BYTES=268435456 \
    VALIDATE_POOL_SIZE=4 \
    VALIDATE_QUEUE_DEPTH=256

# Deliberately not set: GATEWAY_CP_URL, GATEWAY_TOKEN_FILE, DP_NAME, MAX_BODY_BYTES,
# TRUSTED_PROXY_CIDRS. Each is a deployment decision the process fails to start without, by name.
#
# `GATEWAY_TOKEN_FILE` rather than `GATEWAY_TOKEN` in the documented path: an environment variable
# is visible to every process in the container and `docker inspect` prints it.

RUN mkdir -p /var/lib/apim && chown -R bun:bun /var/lib/apim /app

EXPOSE 8081
VOLUME ["/var/lib/apim"]

# The gateway's own health endpoint: it reports whether a config has been activated, which is the
# difference between "listening" and "able to serve anything".
HEALTHCHECK --interval=15s --timeout=3s --start-period=15s --retries=3 \
  CMD curl -fsS http://127.0.0.1:${DP_PORT}/healthz || exit 1

USER bun
CMD ["bun", "run", "data-plane/src/server.ts"]
