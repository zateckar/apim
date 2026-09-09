# A gateway. One process, no database, no UI, no control-plane code — it polls, activates a config
# document, and serves. The whole contract between the planes is that document, which is why this
# image shares nothing with the other one but `shared/`.

FROM oven/bun:1.4.2-alpine AS runtime

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

# The one concurrency value left in the image. Its pair — the `maxConcurrentRequests` gateway
# setting — became the control plane's in v6, and the gateway still refuses to start, and now also
# refuses to activate a document, unless this is at least that setting. The check exists precisely
# to catch the pairing an image that set neither would inherit: the runtime's default outbound queue
# behind the gateway's ceiling, where one slow backend delays every other route
# (reports/capacity-report.md). Headroom rather than a match, so raising the setting from a browser
# is a normal thing to do; past 16384 raise this and restart the container.
ENV BUN_CONFIG_MAX_HTTP_REQUESTS=16384

# Deliberately not set: GATEWAY_CP_URL, GATEWAY_TOKEN_FILE, DP_NAME, TRUSTED_PROXY_CIDRS,
# DP_ACCESS_LOG_PATH. Each is a deployment decision, and an image that guessed would make that guess
# for every deployment at once. The log path most of all: unset means stdout, which is what the
# container's own log driver collects, and a path in the image would send every gateway's lines to
# one file on a volume the operator may not have mounted.
#
# **Cannot be set here at all**: the request-body cap, the concurrency and buffer ceilings, the
# cache sizes, the JWKS floor, the telemetry bounds and the access-log switches. They are the
# control plane's since v6 and arrive in the configuration document; a container that still sets one
# of their old variables refuses to start and names it. That is the upgrade path — see
# `shared/gateway-settings.ts`.
#
# Only the token stops the process for a missing value: `loadDpConfig` refuses to start without one
# and names both variables. The rest have code defaults — which is the argument for setting them,
# not a reason to relax about them, because a gateway that defaulted GATEWAY_CP_URL polls
# `http://localhost:8080` and looks like a network fault. `docker-compose.data-plane.yml` is where
# that refusal lives, before a container exists.
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
