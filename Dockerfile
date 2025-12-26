# =============================================================================
# DLN Solana Dashboard - Backend Dockerfile
# =============================================================================
# Multi-stage build for smaller production image
# Includes: API server, Collector, Temporal worker

FROM node:20-alpine AS base

# Install dependencies for native modules
RUN apk add --no-cache python3 make g++

WORKDIR /app

# =============================================================================
# Dependencies stage
# =============================================================================
FROM base AS deps

# Copy package files
COPY package*.json ./

# Install all dependencies (including dev for build)
RUN npm ci

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
FROM node:20-alpine AS production

WORKDIR /app

# Create non-root user for security
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001

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
