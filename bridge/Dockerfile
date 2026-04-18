# syntax=docker/dockerfile:1.7
#
# Cloudflare Containers build. `wrangler deploy` uses the repo root as build
# context (see containers.image in wrangler.jsonc), so paths here are relative
# to the repo root.

FROM node:24-alpine AS base
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate

# --- deps: isolated bridge install ------------------------------------------
FROM base AS deps
COPY bridge/package.json bridge/pnpm-lock.yaml /app/bridge/
WORKDIR /app/bridge
RUN pnpm install --frozen-lockfile --prod=false

# --- runtime: copy source + deps, run via tsx -------------------------------
FROM base AS runtime
# The bridge entry imports two .ts modules from the Worker `src/` tree by
# relative path (`../../src/infrastructure/webull/TradeEventBridge`,
# `../../src/trading/domain/TradeEvent`). They are TYPES + one string const —
# copying the two files keeps the image tight.
COPY --from=deps /app/bridge/node_modules /app/bridge/node_modules
COPY bridge/ /app/bridge/
COPY src/infrastructure/webull/TradeEventBridge.ts /app/src/infrastructure/webull/TradeEventBridge.ts
COPY src/trading/domain/TradeEvent.ts /app/src/trading/domain/TradeEvent.ts

# Drop root: outbound-only process, no reason to run as root.
RUN addgroup -S bridge && adduser -S -G bridge -h /app bridge \
 && chown -R bridge:bridge /app
USER bridge

WORKDIR /app/bridge
ENV NODE_ENV=production
CMD ["pnpm", "start"]
