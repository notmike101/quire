# syntax=docker/dockerfile:1

# --- Stage 1: build the Vue viewer --------------------------------------------
FROM node:22-alpine AS web-build
WORKDIR /app
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY protocol/package.json protocol/
COPY web/package.json web/
RUN corepack enable && pnpm install --frozen-lockfile --filter @quire/web...
COPY protocol/ protocol/
COPY web/ web/
RUN pnpm --filter @quire/web build

# --- Stage 2: build the server, produce a self-contained prod dir -------------
FROM node:22-alpine AS server-build
WORKDIR /app
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY protocol/package.json protocol/
COPY server/package.json server/
RUN corepack enable && pnpm install --frozen-lockfile --filter @quire/server...
COPY protocol/ protocol/
COPY server/ server/
RUN pnpm --filter @quire/server build \
 && pnpm --filter @quire/server deploy --prod /prod

# --- Stage 3: runtime ----------------------------------------------------------
FROM node:22-alpine
ENV NODE_ENV=production \
    PORT=8787 \
    WEB_DIST=/app/web-dist
RUN addgroup -S quire && adduser -S -G quire quire
WORKDIR /app
COPY --from=server-build /prod ./
COPY --from=web-build /app/web/dist ./web-dist
# Safety net for the CWD-relative ./drizzle migrations folder: copy it even if
# a future "files" field in server/package.json would exclude it from `deploy`.
COPY server/drizzle ./drizzle
USER quire
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=3s --start-period=15s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8787/healthz || exit 1
CMD ["node", "dist/index.js"]
