# =============================================================================
# SvelteKit Node adapter — multi-stage Docker build
# =============================================================================
# Builds the SvelteKit app with ADAPTER=node and produces a minimal
# production image running built/index.js on port 4174.
#
# Build:    docker build -t svelte-review-frontend ./frontend
# Run:      docker run -p 4174:4174 -e PORT=4174 svelte-review-frontend
# =============================================================================

# ── Stage 1: Install + Build ──────────────────────────────────────────────────
FROM node:22-alpine AS builder

LABEL stage=builder

# pnpm requires its own version pinned alongside the lockfile
RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /app

# Copy dependency manifests first (layer caching)
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN pnpm install --frozen-lockfile

# Copy the rest of the source
COPY . .

# Build the Node adapter output
RUN ADAPTER=node pnpm build:teacher

# ── Stage 2: Production runtime ──────────────────────────────────────────────
FROM node:22-alpine

# Tini for proper signal handling (SIGTERM → Node)
RUN apk add --no-cache tini

WORKDIR /app

# Copy only what's needed to run the built server
COPY --from=builder /app/build ./build
COPY --from=builder /app/package.json ./
COPY --from=builder /app/node_modules ./node_modules

# Verify the build output exists
RUN test -f build/index.js || (echo "ERROR: build/index.js not found — did build:teacher succeed?" && exit 1)

# Runtime environment defaults
ENV ADAPTER=node \
    PORT=4174 \
    NODE_ENV=production \
    EXECUTOR_URL=http://executor:8766

EXPOSE 4174

HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:4174/ || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "build/index.js"]
