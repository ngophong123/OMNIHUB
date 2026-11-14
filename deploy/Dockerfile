FROM node:22-bookworm-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
RUN npm install --global pnpm@12.4.1
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY prisma prisma
RUN pnpm install --frozen-lockfile && pnpm exec prisma generate
COPY . .
RUN pnpm --filter @omnihub/contracts build && pnpm --filter @omnihub/api build

FROM build AS web-build
ARG NEXT_PUBLIC_API_URL=https://localhost:8444
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL NEXT_TELEMETRY_DISABLED=1
RUN pnpm --filter @omnihub/web build

FROM node:22-bookworm-slim AS api
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build --chown=node:node /app /app
USER node
ENV NODE_ENV=production
CMD ["node", "--require", "/app/deploy/load-secrets.cjs", "apps/api/dist/main.js"]

FROM node:22-bookworm-slim AS web
WORKDIR /app
COPY --from=web-build --chown=node:node /app /app
USER node
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
WORKDIR /app/apps/web
CMD ["node", "node_modules/next/dist/bin/next", "start", "--hostname", "0.0.0.0"]
