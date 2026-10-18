ARG NODE_VERSION=24

# Stage 1: Build stage
FROM node:${NODE_VERSION}-alpine AS builder

WORKDIR /app

# Copy workspace manifest files first so npm ci is cached separately from source
COPY package.json package-lock.json ./
COPY packages/core/package.json ./packages/core/
COPY packages/picker-dom/package.json ./packages/picker-dom/
COPY apps/application/package.json ./apps/application/
COPY packages/reporter/package.json ./packages/reporter/
COPY integrations/nitro/package.json ./integrations/nitro/

# Install all dependencies; --ignore-scripts skips application's postinstall
# (nuxt prepare) which requires source files not yet present.
# nuxt build regenerates the same output during the build step below.
RUN --mount=type=cache,target=/root/.npm \
    npm ci --ignore-scripts

# Copy root tsconfig (extended by apps/application/tsconfig.json)
COPY tsconfig.json ./

# Copy the shared workspace packages (@piwitests/core, @piwitests/picker-dom).
# Both ship TypeScript source: Vite transpiles them and Nitro inlines them into
# the server bundle (both via nuxt.config build.transpile), so their source must
# be present at build time or Rollup fails to resolve the imports.
COPY packages/core/ ./packages/core/
COPY packages/picker-dom/ ./packages/picker-dom/

# Copy application source
COPY apps/application/ ./apps/application/

# Copy integrations (imported by server/plugins/piwi-test-logs.ts via relative path)
COPY integrations/ ./integrations/

# The docs pages and the changelog, bundled into the server as assets for the
# MCP describe_piwi and get_release_notes tools, and the workflow skills the MCP
# server serves as prompts (.dockerignore keeps only these).
COPY apps/docs/ ./apps/docs/
COPY CHANGELOG.md ./
COPY packages/reporter/templates/skills/ ./packages/reporter/templates/skills/

# Build the application. The glibc-flavoured native packages are pruned from the
# bundled output: this image is Alpine (musl), so only the *-musl* builds are ever
# loaded. TARGETARCH is set by buildx; map it to the arch string npm packages use.
ARG PIWI_BUILD_SHA
ARG TARGETARCH
ENV NITRO_PRESET=node-server
# Node caps the heap at 4 GB in this image, half what it picks on a bare 16 GB
# runner, and the build peaks around 3 GB. Leave it room to grow.
ENV NODE_OPTIONS=--max-old-space-size=6144
ENV PIWI_BUILD_SHA=${PIWI_BUILD_SHA}
RUN set -eux; \
    npm run app:build --workspace=apps/application; \
    case "${TARGETARCH:-}" in \
      amd64) NODE_ARCH=x64 ;; \
      arm64) NODE_ARCH=arm64 ;; \
      *) echo "unsupported TARGETARCH: '${TARGETARCH:-}'" >&2; exit 1 ;; \
    esac; \
    rm -rf "apps/application/.output/server/node_modules/@img/sharp-libvips-linux-${NODE_ARCH}"; \
    rm -rf "apps/application/.output/server/node_modules/@img/sharp-linux-${NODE_ARCH}"; \
    rm -rf "apps/application/.output/server/node_modules/@libsql/linux-${NODE_ARCH}-gnu"; \
    rm -rf apps/application/.output/server/node_modules/sql.js; \
    rm -rf apps/application/.output/public/demo

# Stage 2: Production stage
FROM node:${NODE_VERSION}-alpine AS production

WORKDIR /app

ARG PORT=3000
ENV NODE_ENV=production
ENV NITRO_HOST=0.0.0.0
# PORT rather than NITRO_PORT: Nitro reads `NITRO_PORT || PORT || 3000`, so baking
# NITRO_PORT would override the PORT that hosting platforms inject at runtime.
ENV PORT=${PORT}

# Install dumb-init for proper signal handling
RUN apk add --no-cache dumb-init

# Create non-root user
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001 && \
    chown nodejs:nodejs /app

# Copy workspace files for native module install (sharp, libsql, sql.js)
# Pure-JS deps ship in .output/server/node_modules (traced by Nitro) — only native
# binaries needed here.
# --chown is required: `npm install` below runs as nodejs and rewrites package.json
# to record the added deps, which fails with EACCES on a root-owned copy.
COPY --chown=nodejs:nodejs package.json package-lock.json ./

# Trim workspaces to just application
RUN printf "import{readFileSync,writeFileSync}from'node:fs';const p=JSON.parse(readFileSync('package.json','utf8'));p.workspaces=['apps/application'];writeFileSync('package.json',JSON.stringify(p));" > /tmp/fix.mjs && node /tmp/fix.mjs && rm /tmp/fix.mjs

# Install only the native packages needed at runtime (sharp + libsql + sql.js), at
# the exact versions package-lock.json resolved: the ones the server was built and
# traced with (`packages/server/package.json` pins the same). All pure-JS deps ship
# in .output/server/node_modules, traced by Nitro.
# Run as nodejs to avoid a duplicate chown layer
USER nodejs

ENV npm_config_cache=/home/nodejs/.npm

# TARGETARCH is set by buildx per matrix leg; the libsql binding is arch-specific,
# so it must not be hardcoded (@libsql/linux-x64-musl fails EBADPLATFORM on arm64).
# `set -eux` matters here: the previous `;`-joined chain ended in `|| true`, which
# masked a failing npm install and shipped an image with no native modules at all.
ARG TARGETARCH

RUN --mount=type=cache,target=/home/nodejs/.npm,uid=1001,gid=1001 \
    set -eux; \
    case "${TARGETARCH:-}" in \
      amd64) NODE_ARCH=x64 ;; \
      arm64) NODE_ARCH=arm64 ;; \
      *) echo "unsupported TARGETARCH: '${TARGETARCH:-}'" >&2; exit 1 ;; \
    esac; \
    locked() { node -p "require('./package-lock.json').packages['node_modules/' + process.argv[1]].version" "$1"; }; \
    SHARP_VERSION="$(locked sharp)"; \
    LIBSQL_VERSION="$(locked @libsql/client)"; \
    BINDING_VERSION="$(locked "@libsql/linux-${NODE_ARCH}-musl")"; \
    npm install --omit=dev --ignore-scripts \
      "sharp@${SHARP_VERSION}" "@libsql/client@${LIBSQL_VERSION}" \
      "@libsql/linux-${NODE_ARCH}-musl@${BINDING_VERSION}"; \
    npm cache clean --force; \
    rm -rf "node_modules/@img/sharp-libvips-linux-${NODE_ARCH}"; \
    rm -rf "node_modules/@img/sharp-linux-${NODE_ARCH}"; \
    rm -rf "node_modules/@libsql/linux-${NODE_ARCH}-gnu"; \
    rm -rf node_modules/sql.js; \
    find node_modules -type d \( -name "test" -o -name "tests" -o -name ".devcontainer" \) -exec rm -rf {} + 2>/dev/null || true; \
    node -e "require('sharp'); require.resolve('@libsql/client'); require('@libsql/linux-${NODE_ARCH}-musl')"

# Copy built application — pure-JS deps travel in .output/server/node_modules
COPY --chown=nodejs:nodejs --from=builder /app/apps/application/.output ./apps/application/.output

# Mirrors the operator-facing PIWI_* env the prebuilt server reads through its baked
# runtime config onto the NUXT_* overrides it honors (see the file for why). It is the
# file `npx @piwitests/server` imports too. Preloaded before the entry.
COPY --chown=nodejs:nodejs packages/server/bin/server-env.mjs ./

EXPOSE ${PORT}

# Readiness for compose/k8s/monitors — /api/health verifies DB connectivity
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO /dev/null "http://127.0.0.1:${PORT}/api/health" || exit 1

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "--import", "./server-env.mjs", "apps/application/.output/server/index.mjs"]
