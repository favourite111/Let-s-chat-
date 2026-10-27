# ─────────────────────────────────────────────────────────────────────────────
# VideoCall — production image
#
# Two stages: build everything (needs devDependencies + a C toolchain for the
# native SQLite driver), then ship only the compiled output and prod modules.
# ─────────────────────────────────────────────────────────────────────────────

# ---- build -----------------------------------------------------------------
FROM node:22-bookworm-slim AS build
WORKDIR /app

# CI=true is load-bearing: without it `pnpm prune` aborts with
# ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY because there is no TTY to confirm
# purging node_modules. (This is what broke the Render deploy.)
ENV CI=true

# Toolchain so better-sqlite3 can build if no prebuilt binary matches.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# npm rather than corepack: corepack's bundled signing keys go stale and fail
# with "Cannot find matching keyid" on some Node images.
RUN npm install -g pnpm@10.34.9 --no-audit --no-fund

# Manifests first, so this layer is cached until dependencies actually change.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY artifacts/api-server/package.json artifacts/api-server/
COPY artifacts/video-call/package.json artifacts/video-call/
COPY artifacts/mockup-sandbox/package.json artifacts/mockup-sandbox/
COPY lib/api-client-react/package.json lib/api-client-react/
COPY lib/api-spec/package.json lib/api-spec/
COPY lib/api-zod/package.json lib/api-zod/
COPY lib/db/package.json lib/db/
COPY scripts/package.json scripts/

RUN pnpm install --frozen-lockfile

COPY . .

# Build the frontend, then the server bundle.
RUN pnpm --filter @workspace/video-call run build \
 && pnpm --filter @workspace/api-server run build

# Drop devDependencies.
#
# NOT `pnpm prune --prod`. At a workspace root that empties the SUB-project
# node_modules - it deletes artifacts/api-server/node_modules, including the
# symlink to better-sqlite3 that the server resolves at runtime. The container
# then builds fine, boots, fails to open SQLite and exits 1 (this is what broke
# the Render deploy). A --prod install relinks each workspace project's
# production dependencies instead, which is what we actually want.
RUN pnpm install --prod --frozen-lockfile

# ---- runtime ---------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    PORT=8080 \
    SQLITE_PATH=/app/data/videocall.db \
    TRUST_PROXY=1

# The esbuild bundle inlines express/socket.io/pino, so node_modules here is
# only the native SQLite driver and its prod deps.
#
# The *workspace* node_modules matters too: pnpm links better-sqlite3 into
# artifacts/api-server/node_modules, and the server resolves it from there. Copy
# only the root folder and the import fails at startup.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/artifacts/api-server/node_modules ./artifacts/api-server/node_modules
COPY --from=build /app/artifacts/api-server/dist ./artifacts/api-server/dist
COPY --from=build /app/artifacts/video-call/dist ./artifacts/video-call/dist
COPY --from=build /app/artifacts/api-server/package.json ./artifacts/api-server/package.json
COPY --from=build /app/package.json ./package.json

# Fail the BUILD, not the deploy, if the native driver cannot be resolved from
# where the server actually imports it. Without this the image builds happily
# and the failure only shows up as a crashing container.
RUN cd artifacts/api-server \
 && node -e "import('better-sqlite3').then(()=>console.log('better-sqlite3 resolves')).catch(e=>{console.error('better-sqlite3 missing:',e.message);process.exit(1)})"

# Rooms live here when STORE=sqlite. On an ephemeral filesystem (Render) use
# STORE=postgres + DATABASE_URL instead — this directory is just a fallback.
RUN mkdir -p /app/data && chown -R node:node /app/data
VOLUME ["/app/data"]

USER node

# Render sets $PORT itself (usually 10000), which overrides the ENV above.
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "--enable-source-maps", "artifacts/api-server/dist/index.mjs"]
