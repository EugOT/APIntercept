# syntax=docker/dockerfile:1

FROM oven/bun:1.3.3-alpine AS base
RUN apk add --no-cache git libc6-compat
RUN bun add --global turbo@2.8.17
WORKDIR /app

FROM base AS pruner
COPY . .
RUN turbo prune @interceptor/api --docker

FROM base AS deps
COPY --from=pruner /app/out/json/ .
COPY --from=pruner /app/out/bun.lock ./bun.lock
RUN --mount=type=cache,id=bun,target=/root/.bun/install/cache \
    bun install --frozen-lockfile --ignore-scripts --linker=hoisted

FROM base AS builder
COPY --from=deps /app/ ./
COPY --from=pruner /app/out/full/ .
COPY --from=pruner /app/tsconfig.base.json ./tsconfig.base.json
COPY --from=pruner /app/turbo.json ./turbo.json
RUN turbo run build --filter=@interceptor/api

FROM base AS prod-deps
COPY --from=pruner /app/out/json/ .
COPY --from=pruner /app/out/bun.lock ./bun.lock
RUN --mount=type=cache,id=bun,target=/root/.bun/install/cache \
    bun install --frozen-lockfile --production --ignore-scripts --linker=hoisted

# Runtime stage uses Node because the app and Patchright target a Node server process.
FROM node:22-slim AS runner

RUN apt-get update && apt-get install -y --no-install-recommends \
    wget gnupg ca-certificates \
    xvfb xauth dbus \
    fonts-liberation fonts-noto-color-emoji \
    libgbm1 libnss3 libatk-bridge2.0-0 libgtk-3-0 libxss1 libasound2 \
    python3 \
    && rm -rf /var/lib/apt/lists/*

RUN ARCH=$(dpkg --print-architecture) && \
    if [ "$ARCH" = "amd64" ]; then \
      wget -q -O /tmp/chrome-key.pub https://dl.google.com/linux/linux_signing_key.pub && \
      gpg --dearmor -o /usr/share/keyrings/google-chrome.gpg /tmp/chrome-key.pub && \
      echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google-chrome.gpg] http://dl.google.com/linux/chrome/deb/ stable main" \
        > /etc/apt/sources.list.d/google-chrome.list && \
      apt-get update && apt-get install -y --no-install-recommends google-chrome-stable && \
      rm -rf /var/lib/apt/lists/* /tmp/chrome-key.pub; \
    else \
      apt-get update && apt-get install -y --no-install-recommends chromium && \
      rm -rf /var/lib/apt/lists/*; \
    fi

ENV CHROME_PATH=/usr/bin/google-chrome-stable
ENV CHROMIUM_PATH=/usr/bin/chromium
ENV BROWSER_HEADLESS=false
ENV INTERCEPTOR_PYTHON=/usr/bin/python3
ENV NODE_ENV=production

WORKDIR /app

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=builder /app/apps/api/package.json ./apps/api/package.json
COPY --from=builder /app/apps/api/dist ./apps/api/dist
COPY --from=builder /app/packages/browser/package.json ./packages/browser/package.json
COPY --from=builder /app/packages/browser/dist ./packages/browser/dist
COPY --from=builder /app/packages/shared/package.json ./packages/shared/package.json
COPY --from=builder /app/packages/shared/dist ./packages/shared/dist
COPY --from=builder /app/domains/boardshop/package.json ./domains/boardshop/package.json
COPY --from=builder /app/domains/boardshop/dist ./domains/boardshop/dist
COPY services/python/ ./services/python/

RUN mkdir -p /app/data/browser-profiles

WORKDIR /app/apps/api
CMD ["xvfb-run", "--auto-servernum", "--server-args=-screen 0 1280x720x24 -ac", "node", "dist/index.js"]
