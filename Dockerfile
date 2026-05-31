FROM node:22.16-slim AS base
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ curl ca-certificates && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate
WORKDIR /app

FROM base AS build
WORKDIR /app

# Copy all workspace package.json files for dependency resolution
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/web/package.json ./apps/web/
COPY apps/server/package.json ./apps/server/
COPY packages/core/package.json ./packages/core/
COPY packages/web-sdk/package.json ./packages/web-sdk/
COPY plugins/collector-browser/package.json ./plugins/collector-browser/
COPY plugins/collector-media/package.json ./plugins/collector-media/
COPY plugins/tracking/package.json ./plugins/tracking/
COPY plugins/tool-search-tavily/package.json ./plugins/tool-search-tavily/
COPY plugins/tool-search-serper/package.json ./plugins/tool-search-serper/
COPY plugins/tool-search-google/package.json ./plugins/tool-search-google/
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm build

# yt-dlp binary 预装：装到 /app/yt-dlp（独立于 ./data 挂载点），collector-media 启动 0 延迟
# - YT_DLP_PINNED_VERSION 不传时由 inject-yt-dlp-version.mjs 从 plugin 源码抽默认值
# - TARGETARCH 由 buildx 自动注入（amd64 / arm64）；普通 docker build 不传时默认 amd64
ARG YT_DLP_PINNED_VERSION=
ARG TARGETARCH
RUN VERSION="${YT_DLP_PINNED_VERSION:-$(node scripts/inject-yt-dlp-version.mjs)}" && \
    case "${TARGETARCH:-amd64}" in \
      amd64) BIN=yt-dlp_linux ;; \
      arm64) BIN=yt-dlp_linux_aarch64 ;; \
      *) echo "unsupported TARGETARCH: ${TARGETARCH} (only amd64/arm64)" >&2; exit 1 ;; \
    esac && \
    curl -fL "https://github.com/yt-dlp/yt-dlp/releases/download/${VERSION}/${BIN}" -o "/tmp/${BIN}" && \
    curl -fL "https://github.com/yt-dlp/yt-dlp/releases/download/${VERSION}/SHA2-256SUMS" -o /tmp/SHA2-256SUMS && \
    ( cd /tmp && grep " ${BIN}\$" SHA2-256SUMS | sha256sum -c - ) && \
    chmod +x "/tmp/${BIN}" && \
    mkdir -p /tmp/yt-dlp-staging && \
    mv "/tmp/${BIN}" "/tmp/yt-dlp-staging/${BIN}" && \
    printf '%s' "${VERSION}" > /tmp/yt-dlp-staging/version.txt

# Create self-contained server deployment with all runtime dependencies.
# pnpm deploy resolves workspace:* deps (core) and installs production node_modules.
# The "files" fields in core/server package.json ensure dist/ and drizzle/ are included
# despite dist/ being in .gitignore (pnpm deploy uses npm-pack logic).
# --legacy: required for pnpm 10.x peer dependency resolution in deploy
RUN pnpm --filter @goldpan/server deploy /app/server-deploy --prod --legacy

FROM node:22.16-slim AS production
WORKDIR /app

# tini: proper PID 1 for signal forwarding and zombie reaping
# libstdc++6: required by better-sqlite3 native addon
RUN apt-get update && apt-get install -y --no-install-recommends tini libstdc++6 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
ENV PORT=3000
ENV GOLDPAN_WEB_ENABLED=true
# yt-dlp 装到独立目录，不会被 docker-compose 的 ./data:/app/data 挂载覆盖；
# 用户可用 GOLDPAN_YT_DLP_DIR 在自定义挂载方案下覆盖
ENV GOLDPAN_YT_DLP_DIR=/app/yt-dlp

# Web: Next.js standalone output (includes traced web-sdk dependencies)
COPY --from=build /app/apps/web/.next/standalone ./
COPY --from=build /app/apps/web/.next/static ./apps/web/.next/static
RUN mkdir -p ./apps/web/public
COPY --from=build /app/apps/web/public/ ./apps/web/public/

# Server: pnpm deploy output (self-contained with @goldpan/core, migrations, prompts, native addons)
COPY --from=build /app/server-deploy ./server

# Entrypoint script
COPY --from=build /app/docker-entrypoint.sh ./docker-entrypoint.sh
RUN chmod +x docker-entrypoint.sh

# yt-dlp binary + version.txt：整目录 COPY 保留正确文件名（yt-dlp_linux / _aarch64）
COPY --from=build /tmp/yt-dlp-staging /app/yt-dlp

RUN adduser --disabled-password --gecos '' --uid 1001 goldpan && \
    mkdir -p /app/data && \
    chown -R goldpan:goldpan /app

USER goldpan

EXPOSE 3000 3001

# Health check verifies both server and web processes.
# /api/healthz is a filesystem route in the web app (not rewritten to server)
# and is whitelisted by middleware so it succeeds even when GOLDPAN_AUTH_PASSWORD
# is set. start-period must cover bootstrap() worst-case: migrations + optional
# embedding backfill + plugin init; keep it aligned with GOLDPAN_SERVER_READY_TIMEOUT_S
# in docker-entrypoint.sh (default 120s) so the entrypoint and orchestrator
# share the same grace window.
HEALTHCHECK --interval=30s --timeout=5s --start-period=120s --retries=3 \
  CMD node -e "const p=process.env.GOLDPAN_SERVER_PORT||3001;Promise.all([fetch('http://localhost:'+p+'/health'),fetch('http://localhost:3000/api/healthz')]).then(rs=>process.exit(rs.every(r=>r.ok)?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["tini", "--"]
CMD ["bash", "docker-entrypoint.sh"]
