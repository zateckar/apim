# The control plane: the API, the SQLite database, the job runner and the SPA it serves.
#
# `oven/bun:1.4.2-alpine`, pinned exactly rather than to a floating minor `[P1-21]`. The same
# version is pinned in `.github/workflows/{ci,images,perf}.yml` and in the gateway's Dockerfile, and
# a Dockerfile that floated would make a reproducible build stop being one without anybody changing
# a line. README.md, "The two images", names all five places, because they move together.

# ---------------------------------------------------------------- stage 1: the SPA
FROM oven/bun:1.4.2-alpine AS ui

WORKDIR /build
# The manifests first, so a change to a component does not invalidate the install layer.
COPY ui/package.json ui/bun.lock* ./ui/
RUN cd ui && bun install --frozen-lockfile

# `ui/src/lib/*` imports the wire vocabulary from `shared/` — the attention codes, the release
# states — rather than restating it, so the build needs one directory above the project root.
# `CHANGELOG.md` comes with it: `ui/src/lib/changelog.ts` imports it as `?raw`, so the portal's
# version and its Change Log modal are baked into the bundle rather than fetched, and a build
# without the file does not fall back to an empty change log — it fails to resolve the import.
COPY shared/ ./shared/
COPY CHANGELOG.md ./CHANGELOG.md
COPY ui/ ./ui/
RUN cd ui && bun run build


# ---------------------------------------------------------------- stage 2: the runtime
FROM oven/bun:1.4.2-alpine AS runtime

# `curl` for the healthcheck. Nothing else: the control plane has no runtime dependencies, which is
# the property the whole design is built on and the reason this image is as small as it is.
RUN apk add --no-cache curl

WORKDIR /app

COPY package.json bunfig.toml tsconfig.json ./
COPY shared/ ./shared/
COPY control-plane/ ./control-plane/
# `scripts/` stays, because `scripts/mint-instance.ts` runs in this image: a deployment with no
# browser still has to be able to enrol a gateway.
COPY scripts/ ./scripts/
COPY --from=ui /build/ui/dist/ ./ui/dist/

# The repository's own configuration, as a sample rather than a default. Its denied ranges omit
# loopback so the local stack's backends on 127.0.0.1 work, and an image that shipped that as its
# default would be a production deployment with a hole in it — deny 127.0.0.0/8 in anything real.
# `docker cp` these out, edit them, mount them.
COPY config/ ./config.sample/

# The database and the key encryption key. `/data` is a volume, so neither survives in a layer.
ENV DB_PATH=/data/apim.sqlite \
    KEK_PATH=/data/kek.key \
    UI_DIST=/app/ui/dist \
    INTEGRATIONS_FILE=/etc/apim/integrations.json \
    TARGETS_FILE=/etc/apim/targets.json \
    PORT=8080

# Deliberately **not** set: AUTH_PROVIDERS. It is required and has no default (D36) — a control
# plane that guessed would either be unreachable or wide open, and an image that guessed would
# make that guess for every deployment at once.

# No `--init` and no `STOPSIGNAL`, for the reason spelled out in `docker/data-plane.Dockerfile`:
# the entrypoint `exec`s, so SIGTERM reaches the runtime directly, and what was missing was a
# handler rather than an init. It is in `shared/shutdown.ts`, and here it is what flushes the
# telemetry and quota buffers and closes the database instead of leaving a WAL behind.

RUN mkdir -p /data /etc/apim && chown -R bun:bun /data /app

EXPOSE 8080
VOLUME ["/data"]

# `/readyz` rather than `/healthz`: it reads the schema version out of SQLite, so it answers the
# question a load balancer is actually asking — can this process serve — rather than only "is the
# socket open".
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8080/readyz || exit 1

USER bun
CMD ["bun", "run", "control-plane/src/server.ts"]
