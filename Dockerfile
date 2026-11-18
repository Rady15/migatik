# syntax=docker/dockerfile:1
# MikroTik Cloud Manager — NOC edition (Next.js + realtime socket service)
FROM oven/bun:1 AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

FROM oven/bun:1 AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN bunx prisma generate && bun run build

FROM oven/bun:1 AS runtime
WORKDIR /app
ENV NODE_ENV=production DATABASE_URL="file:/data/custom.db"
RUN apt-get update && apt-get install -y --no-install-recommends sqlite3 && rm -rf /var/lib/apt/lists/*
COPY --from=build /app ./
VOLUME ["/data"]
EXPOSE 3000
CMD ["sh", "-c", "bunx prisma db push --skip-generate && bun .next/standalone/server.js"]
