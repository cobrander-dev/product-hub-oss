FROM node:24.21.0-bookworm-slim AS base

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"

RUN apt-get update \
  && apt-get install --yes --no-install-recommends openssl \
  && rm -rf /var/lib/apt/lists/* \
  && npm install --global pnpm@11.19.0

FROM base AS deps
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=product-hub-pnpm,target=/pnpm/store \
  pnpm install --frozen-lockfile --network-concurrency=8 --fetch-timeout=300000

FROM base AS builder
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN export DATABASE_URL="postgresql://build:build@127.0.0.1:5432/build" \
  BETTER_AUTH_SECRET="build-only-placeholder-not-used-at-runtime" \
  BETTER_AUTH_URL="https://build.invalid" \
  BETTER_AUTH_TRUSTED_ORIGINS="https://build.invalid"; \
  pnpm prisma:generate && pnpm build

FROM base AS migrator-deps
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY --from=deps /app/node_modules ./node_modules
RUN pnpm prune --prod

# Official docker:29.9.0-cli index. Only the CLI binary is copied; its bundled
# Compose plugin is rebuilt below until upstream ships one on a patched Go.
FROM docker@sha256:1a4c7cb63513f349bdad01fcc6e0f3f2f67d37b9da86f14dc0d4a0942eecda00 AS docker-cli

# Official Compose v5.6.0 tag rebuilt with official golang:1.26.9-alpine3.24 and
# golang.org/x/net v0.60.0 (Go stdlib/x/net High fixes). Checksums via GOSUMDB.
FROM --platform=$BUILDPLATFORM golang@sha256:3082400e369fa24d5fc60bca20edab3f6d604e0c5a690ec66b295eff4dd87ade AS compose-build
ARG TARGETOS
ARG TARGETARCH
ENV GOTOOLCHAIN=local CGO_ENABLED=0 GOFLAGS=-mod=mod
RUN apk add --no-cache git \
  && git clone --depth 1 --branch v5.6.0 https://github.com/docker/compose.git /src \
  && test "$(git -C /src rev-parse HEAD)" = 42f48072bbf92ee9b0e43f9fdf2008d03546e7ca
WORKDIR /src
RUN go get golang.org/x/net@v0.60.0 \
  && GOOS=$TARGETOS GOARCH=$TARGETARCH go build -trimpath \
    -ldflags "-w -X github.com/docker/compose/v5/internal.Version=v5.6.0" \
    -o /out/docker-compose ./cmd \
  && go version -m /out/docker-compose | grep -Eq '^/out/docker-compose: go1\.26\.9$' \
  && go version -m /out/docker-compose | grep -Eq 'golang\.org/x/net[[:space:]]+v0\.60\.0'

# Official Caddy v2.11.7 tag for the optional built-in HTTPS proxy, rebuilt with
# the same patched Go toolchain instead of shipping upstream's Go 1.26.8 binary.
FROM --platform=$BUILDPLATFORM golang@sha256:3082400e369fa24d5fc60bca20edab3f6d604e0c5a690ec66b295eff4dd87ade AS caddy-build
ARG TARGETOS
ARG TARGETARCH
ENV GOTOOLCHAIN=local CGO_ENABLED=0 GOFLAGS=-mod=mod
RUN apk add --no-cache git \
  && git clone --depth 1 --branch v2.11.7 https://github.com/caddyserver/caddy.git /src \
  && test "$(git -C /src rev-parse HEAD)" = 72dd0fb067f6d7826c7f79907670ba4a713bfe37
WORKDIR /src
RUN go get golang.org/x/net@v0.60.0 \
  && GOOS=$TARGETOS GOARCH=$TARGETARCH go build -trimpath -ldflags "-w" \
    -o /out/caddy ./cmd/caddy \
  && go version -m /out/caddy | grep -Eq '^/out/caddy: go1\.26\.9$' \
  && go version -m /out/caddy | grep -Eq 'golang\.org/x/net[[:space:]]+v0\.60\.0'

FROM node:24.21.0-bookworm-slim AS migrator
WORKDIR /app
ENV NODE_ENV=production
ARG SOURCE_COMMIT=0000000000000000000000000000000000000000
ARG RELEASE_VERSION=unreleased
LABEL org.opencontainers.image.source="https://github.com/cobrander-dev/product-hub-oss" \
  org.opencontainers.image.revision="$SOURCE_COMMIT" \
  org.opencontainers.image.version="$RELEASE_VERSION"

RUN apt-get update \
  && apt-get upgrade --yes --no-install-recommends \
  && apt-get install --yes --no-install-recommends openssl libpcre2-8-0 \
  && rm -rf /var/lib/apt/lists/* /usr/local/lib/node_modules/npm \
  && rm -f /usr/local/bin/npm /usr/local/bin/npx

COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=compose-build /out/docker-compose /usr/local/libexec/docker/cli-plugins/docker-compose

COPY package.json prisma.config.ts ./
COPY --from=migrator-deps /app/node_modules ./node_modules
COPY prisma ./prisma
COPY scripts/configure-runtime-role.ts ./scripts/configure-runtime-role.ts
COPY scripts/provision-hard-delete-worker-role.ts ./scripts/provision-hard-delete-worker-role.ts
COPY scripts/bootstrap-admin.ts ./scripts/bootstrap-admin.ts
COPY scripts/backup.sh ./scripts/backup.sh
COPY scripts/installer ./scripts/installer
COPY scripts/release ./scripts/release
COPY deploy ./deploy
COPY compose.yaml compose.production.yaml compose.hard-delete.yaml compose.bootstrap.yaml compose.https.yaml ./
COPY docker/postgres/init-production ./docker/postgres/init-production

RUN mkdir -p \
  /app/distribution-bundle/docker/postgres \
  /app/distribution-bundle/scripts/installer \
  /app/distribution-bundle/deploy \
  && cp /app/compose.yaml /app/compose.production.yaml /app/compose.hard-delete.yaml /app/compose.bootstrap.yaml /app/compose.https.yaml /app/distribution-bundle/ \
  && cp -R /app/docker/postgres/init-production /app/distribution-bundle/docker/postgres/ \
  && cp /app/scripts/backup.sh /app/distribution-bundle/scripts/backup.sh \
  && cp /app/scripts/installer/backup-entrypoint.sh /app/distribution-bundle/scripts/installer/backup-entrypoint.sh \
  && cp -R /app/deploy/caddy /app/deploy/nginx /app/distribution-bundle/deploy/

USER node
CMD ["node", "./node_modules/prisma/build/index.js", "migrate", "deploy"]

FROM node:24.21.0-bookworm-slim AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV HOSTNAME="0.0.0.0"
ENV PORT=3000
ARG SOURCE_COMMIT=0000000000000000000000000000000000000000
ARG RELEASE_VERSION=unreleased
LABEL org.opencontainers.image.source="https://github.com/cobrander-dev/product-hub-oss" \
  org.opencontainers.image.revision="$SOURCE_COMMIT" \
  org.opencontainers.image.version="$RELEASE_VERSION"

RUN apt-get update \
  && apt-get upgrade --yes --no-install-recommends \
  && apt-get install --yes --no-install-recommends libpcre2-8-0 \
  && rm -rf /var/lib/apt/lists/* \
  && groupadd --system --gid 1001 nodejs \
  && useradd --system --uid 1001 --gid nodejs nextjs \
  && mkdir -p /data/uploads /data/caddy \
  && chown nextjs:nodejs /data/uploads /data/caddy \
  && rm -rf /usr/local/lib/node_modules/npm \
  && rm -f /usr/local/bin/npm /usr/local/bin/npx

# Used only by the optional product-hub-https service; the app never invokes it.
COPY --from=caddy-build /out/caddy /usr/local/bin/caddy
COPY --from=builder --chown=nextjs:nodejs /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/docker/entrypoint.mjs ./docker/entrypoint.mjs

USER nextjs

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]

CMD ["node", "docker/entrypoint.mjs"]

FROM node:24.21.0-bookworm-slim AS hard-delete-worker
WORKDIR /app
ENV NODE_ENV=production
ARG SOURCE_COMMIT=0000000000000000000000000000000000000000
ARG RELEASE_VERSION=unreleased
LABEL org.opencontainers.image.source="https://github.com/cobrander-dev/product-hub-oss" \
  org.opencontainers.image.revision="$SOURCE_COMMIT" \
  org.opencontainers.image.version="$RELEASE_VERSION"

RUN apt-get update \
  && apt-get upgrade --yes --no-install-recommends \
  && apt-get install --yes --no-install-recommends libpcre2-8-0 \
  && rm -rf /var/lib/apt/lists/* \
  && groupadd --system --gid 1001 worker \
  && useradd --system --uid 1001 --gid worker worker \
  && mkdir -p /data/uploads \
  && chown worker:worker /data/uploads \
  && rm -rf /usr/local/lib/node_modules/npm \
  && rm -f /usr/local/bin/npm /usr/local/bin/npx

COPY package.json tsconfig.json ./
COPY --from=migrator-deps /app/node_modules ./node_modules
COPY scripts/run-hard-delete-worker.ts ./scripts/run-hard-delete-worker.ts
COPY scripts/installer/worker-probe.mjs ./scripts/installer/worker-probe.mjs
COPY src/features/hard-delete ./src/features/hard-delete
COPY src/lib/storage ./src/lib/storage

USER worker
CMD ["node", "./node_modules/tsx/dist/cli.mjs", "scripts/run-hard-delete-worker.ts"]
