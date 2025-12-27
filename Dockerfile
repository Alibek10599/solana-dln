# =============================================================================
# DLN Solana Dashboard - Backend Dockerfile
# =============================================================================
# Multi-stage build for smaller production image
# Includes: API server, Collector, Temporal worker

FROM node:20-slim AS base

# Install dependencies for native modules
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# =============================================================================
# Dependencies stage
# =============================================================================
FROM base AS deps

# Copy package files
COPY package*.json ./

# Install all dependencies (use npm install since package-lock.json may not exist)
RUN npm install

# =============================================================================
# Build stage
# =============================================================================
FROM base AS builder

WORKDIR /app

# Copy dependencies
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Build TypeScript
RUN npm run build

# =============================================================================
# Production stage
# =============================================================================
FROM node:20-slim AS production

WORKDIR /app

# Install wget for healthcheck
RUN apt-get update && apt-get install -y wget && rm -rf /var/lib/apt/lists/*

# Create non-root user for security
RUN groupadd -g 1001 nodejs && \
    useradd -r -u 1001 -g nodejs nodejs

# Copy built files and production dependencies
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package*.json ./

# Set ownership
RUN chown -R nodejs:nodejs /app

USER nodejs

# Environment variables (defaults)
ENV NODE_ENV=production
ENV API_PORT=3001

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:${API_PORT}/health || exit 1

# Expose API port
EXPOSE 3001

# Default command (can be overridden)
CMD ["node", "dist/api/server.js"]
