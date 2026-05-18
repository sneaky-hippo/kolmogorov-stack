# workers/compile-server/Dockerfile
#
# W264: self-hosted kolm.ai compile server.
#
# Multi-stage Alpine build that produces an image with only the runtime
# files needed for `kolm compile`. No build toolchain in the final layer.
#
# Image:
#   docker build -f workers/compile-server/Dockerfile -t kolm-compile:w264 .
#
# Run:
#   docker run --rm -p 8080:8080 \
#     -e KOLM_SHARED_SECRET=$(openssl rand -hex 32) \
#     -e KOLM_OFFLINE=1 \
#     -v $(pwd)/data/artifacts:/data/artifacts \
#     kolm-compile:w264
#
# Air-gap note: when KOLM_OFFLINE=1 the server refuses any request whose
# handler path would touch the network (e.g. deploy_hook fan-out). Combine
# this with a network policy that blocks egress for a defense-in-depth setup.

# ---- Build stage ---------------------------------------------------------
FROM node:20-alpine AS build

WORKDIR /app

# Install production dependencies only. The repo's root package.json carries
# the deps the compile orchestrator needs (archiver, etc); the compile-server
# worker itself adds no new npm packages.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

# Copy only the bits the server uses at runtime.
COPY src ./src
COPY workers/compile-server ./workers/compile-server
COPY scripts/build-sdk-version.js ./scripts/build-sdk-version.js

# ---- Runtime stage -------------------------------------------------------
FROM node:20-alpine AS runtime

ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0 \
    KOLM_ARTIFACT_DIR=/data/artifacts

# Drop root for defense-in-depth. node:20-alpine ships a `node` user.
RUN mkdir -p /data/artifacts && chown -R node:node /data

WORKDIR /app
COPY --from=build --chown=node:node /app /app

USER node

EXPOSE 8080

# Health probe over the same /v1/health endpoint the server exposes. Five
# second timeout because the orchestrator does no work for health.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q -O- http://127.0.0.1:8080/v1/health || exit 1

CMD ["node", "workers/compile-server/server.mjs"]
