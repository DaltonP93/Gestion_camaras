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
RUN npx prisma generate && npm run build

# ─── Producción ───────────────────────────────────────────────
FROM node:20-alpine AS production

WORKDIR /app

RUN apk add --no-cache dumb-init openssl ffmpeg

COPY apps/api/package*.json ./
RUN npm install --only=production

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY prisma ./prisma

EXPOSE 4000

ENV NODE_ENV=production

ENTRYPOINT ["dumb-init", "--"]
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/server.js"]
