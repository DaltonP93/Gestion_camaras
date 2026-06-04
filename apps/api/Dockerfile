FROM node:20-alpine AS builder

WORKDIR /app

# OpenSSL required by Prisma schema-engine on Alpine
RUN apk add --no-cache openssl

# Install dependencies
COPY apps/api/package*.json ./
RUN npm install

# Copy source and prisma schema (from root context)
COPY apps/api/src ./src
COPY apps/api/tsconfig.json ./
COPY prisma ./prisma

# Generate Prisma client then compile TypeScript
# Use the local CLI — never npx which could resolve the global Prisma 7
RUN ./node_modules/.bin/prisma generate --schema=./prisma/schema.prisma && npm run build

# ─── Producción ───────────────────────────────────────────────
FROM node:20-alpine AS production

WORKDIR /app

RUN apk add --no-cache dumb-init openssl ffmpeg

COPY apps/api/package*.json ./
# prisma moved to dependencies so the CLI is present in production too
RUN npm install --only=production

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY prisma ./prisma

EXPOSE 4000

ENV NODE_ENV=production

# Bake the git commit SHA into the image at build time.
# Pass via: docker build --build-arg COMMIT_SHA=$(git rev-parse --short HEAD) ...
ARG COMMIT_SHA=development
ENV COMMIT_SHA=$COMMIT_SHA

ENTRYPOINT ["dumb-init", "--"]
# Use the local Prisma CLI (production dep) — never the global npx one
CMD ["sh", "-c", "./node_modules/.bin/prisma migrate deploy --schema=./prisma/schema.prisma && node dist/server.js"]
