# =============================================================================
# DLN Solana Dashboard - Frontend Dockerfile
# =============================================================================
# Multi-stage build: Build React app, serve with Nginx

# Build stage
FROM node:20-alpine AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies (use npm install since package-lock.json may not exist)
RUN npm install

# Copy source files
COPY . .

# Build arguments for API URL
ARG VITE_API_URL=http://localhost:3001
ENV VITE_API_URL=$VITE_API_URL

# Build the app
RUN npm run build

# =============================================================================
# Production stage - Nginx
# =============================================================================
FROM nginx:alpine AS production

# Copy custom nginx config
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Copy built assets
COPY --from=builder /app/dist /usr/share/nginx/html

# Add healthcheck
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:80/health || exit 1

# Expose port
EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
