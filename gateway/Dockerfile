# =============================================================================
# NovaChat — TS Gateway Dockerfile
#
# Build:
#   docker build -t novachat-gateway -f gateway/Dockerfile gateway/
# =============================================================================

FROM node:20-alpine AS builder

WORKDIR /app

# Install dependencies
COPY package.json package-lock.json* ./
RUN npm ci --ignore-scripts

# Copy source and build
COPY tsconfig.json ./
COPY src/ src/
RUN npm run build

# =========================== Runtime ================================
FROM node:20-alpine

WORKDIR /app

# Only copy production deps + built output
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./
COPY --from=builder /app/dist ./dist

ENV NODE_ENV=production
ENV GATEWAY_PORT=3000
ENV GATEWAY_HOST=0.0.0.0

EXPOSE 3000

HEALTHCHECK --interval=15s --timeout=3s --retries=3 \
    CMD wget -qO- http://localhost:3000/health || exit 1

CMD ["node", "dist/main.js"]
