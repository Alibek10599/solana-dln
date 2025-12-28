# =============================================================================
# DLN Solana Dashboard - Makefile
# =============================================================================

.PHONY: help build up down logs restart clean dev infra collect status env-check monitoring

# Default target
help:
	@echo "DLN Solana Dashboard - Available Commands"
	@echo ""
	@echo "Setup:"
	@echo "  make env           - Create .env from .env.example"
	@echo "  make install       - Install npm dependencies"
	@echo ""
	@echo "Development:"
	@echo "  make dev           - Start infrastructure only (for local dev)"
	@echo "  make infra         - Same as 'make dev'"
	@echo ""
	@echo "Docker:"
	@echo "  make build         - Build all Docker images"
	@echo "  make up            - Start all services + migrate + start collection"
	@echo "  make down          - Stop all services"
	@echo "  make restart       - Restart all services"
	@echo "  make logs          - Follow logs for all services"
	@echo "  make logs-api      - Follow API logs"
	@echo "  make logs-worker   - Follow worker logs"
	@echo ""
	@echo "Scaling:"
	@echo "  make up-scaled     - Start with scaled workers + monitoring + collection"
	@echo "  make scale-rpc N=3 - Scale RPC workers to N instances"
	@echo ""
	@echo "Monitoring:"
	@echo "  make monitoring    - Start Prometheus and Grafana"
	@echo ""
	@echo "Temporal:"
	@echo "  make collect       - Start collection workflow"
	@echo "  make status        - Check collection status"
	@echo "  make watch         - Watch collection progress"
	@echo "  make pause         - Pause collection"
	@echo "  make resume        - Resume collection"
	@echo "  make cancel        - Cancel collection"
	@echo ""
	@echo "Maintenance:"
	@echo "  make clean         - Remove all containers and volumes"
	@echo "  make reset         - Clean + rebuild + start fresh"
	@echo "  make shell-api     - Open shell in API container"
	@echo "  make shell-worker  - Open shell in worker container"

# =============================================================================
# Setup
# =============================================================================

# Check if .env exists
env-check:
	@if [ ! -f .env ]; then \
		echo "❌ .env file not found!"; \
		echo "   Run 'make env' to create it from .env.example"; \
		exit 1; \
	fi

# Create .env from .env.example
env:
	@if [ -f .env ]; then \
		echo "⚠️  .env already exists. Backing up to .env.backup"; \
		cp .env .env.backup; \
	fi
	cp .env.example .env
	@echo "✅ Created .env from .env.example"
	@echo "   Edit .env to configure your settings (especially RPC_URLS)"

# Install dependencies
install:
	npm install
	cd dashboard && npm install
	@echo "✅ Dependencies installed"

# =============================================================================
# Development
# =============================================================================

# Start infrastructure only (ClickHouse, Temporal)
dev:
	docker compose up -d clickhouse temporal temporal-db temporal-ui
	@echo ""
	@echo "✅ Infrastructure started!"
	@echo ""
	@echo "Services:"
	@echo "  - ClickHouse: http://localhost:$${CLICKHOUSE_PORT:-8123}"
	@echo "  - Temporal UI: http://localhost:$${TEMPORAL_UI_PORT:-8233}"
	@echo ""
	@echo "Now run locally:"
	@echo "  npm run migrate"
	@echo "  npm run api"
	@echo "  npm run temporal:worker"
	@echo "  npm run dashboard"

infra: dev

# Start monitoring stack (Prometheus + Grafana)
monitoring: env-check
	docker compose --profile monitoring up -d
	@echo ""
	@echo "✅ Monitoring started!"
	@echo ""
	@echo "Services:"
	@echo "  - Prometheus:  http://localhost:$${PROMETHEUS_PORT:-9090}"
	@echo "  - Grafana:     http://localhost:$${GRAFANA_PORT:-3002}"
	@echo "    (Login: admin/admin)"

# =============================================================================
# Docker Operations
# =============================================================================

# Build all images
build: env-check
	docker compose build
	@echo "✅ Images built"

# Start all services with migration and collection
up: env-check
	@echo "🚀 Starting DLN Solana Dashboard..."
	@echo ""
	docker compose up -d
	@echo ""
	@echo "⏳ Waiting for services to be healthy..."
	@sleep 10
	@echo ""
	@echo "🔧 Running database migrations..."
	@docker compose exec -T api node dist/db/migrate.js 2>/dev/null || \
		(echo "⏳ Waiting for API to be ready..." && sleep 5 && \
		docker compose exec -T api node dist/db/migrate.js)
	@echo ""
	@echo "🎬 Starting collection workflow..."
	@docker compose exec -T worker node dist/temporal/client.js start 2>/dev/null || \
		(echo "⏳ Waiting for worker to be ready..." && sleep 5 && \
		docker compose exec -T worker node dist/temporal/client.js start) || \
		echo "⚠️  Workflow may already be running (check 'make status')"
	@echo ""
	@echo "════════════════════════════════════════════════════════════"
	@echo "✅ DLN Dashboard is running!"
	@echo "════════════════════════════════════════════════════════════"
	@echo ""
	@echo "📊 Dashboard:    http://localhost:$${DASHBOARD_PORT:-3000}"
	@echo "🔌 API:          http://localhost:$${API_PORT:-3001}"
	@echo "📈 Metrics:      http://localhost:$${API_PORT:-3001}/metrics"
	@echo "⚡ Temporal UI:  http://localhost:$${TEMPORAL_UI_PORT:-8233}"
	@echo ""
	@echo "Commands:"
	@echo "  make watch      - Watch collection progress"
	@echo "  make status     - Check workflow status"
	@echo "  make logs       - View logs"
	@echo ""

# Start with scaled workers + monitoring + collection
up-scaled: env-check
	@echo "🚀 Starting DLN Solana Dashboard (Scaled Mode)..."
	@echo ""
	docker compose --profile scaled --profile monitoring up -d
	@echo ""
	@echo "⏳ Waiting for services to be healthy..."
	@sleep 10
	@echo ""
	@echo "🔧 Running database migrations..."
	@docker compose exec -T api node dist/db/migrate.js 2>/dev/null || \
		(echo "⏳ Waiting for API to be ready..." && sleep 5 && \
		docker compose exec -T api node dist/db/migrate.js)
	@echo ""
	@echo "🎬 Starting collection workflow..."
	@docker compose exec -T worker node dist/temporal/client.js start 2>/dev/null || \
		(echo "⏳ Waiting for worker to be ready..." && sleep 5 && \
		docker compose exec -T worker node dist/temporal/client.js start) || \
		echo "⚠️  Workflow may already be running (check 'make status')"
	@echo ""
	@echo "════════════════════════════════════════════════════════════"
	@echo "✅ DLN Dashboard is running (Scaled Mode)!"
	@echo "════════════════════════════════════════════════════════════"
	@echo ""
	@echo "📊 Dashboard:    http://localhost:$${DASHBOARD_PORT:-3000}"
	@echo "🔌 API:          http://localhost:$${API_PORT:-3001}"
	@echo "📈 Metrics:      http://localhost:$${API_PORT:-3001}/metrics"
	@echo "⚡ Temporal UI:  http://localhost:$${TEMPORAL_UI_PORT:-8233}"
	@echo "📉 Prometheus:   http://localhost:$${PROMETHEUS_PORT:-9090}"
	@echo "📊 Grafana:      http://localhost:$${GRAFANA_PORT:-3002} (admin/admin)"
	@echo ""
	@echo "Commands:"
	@echo "  make watch      - Watch collection progress"
	@echo "  make status     - Check workflow status"
	@echo "  make logs       - View logs"
	@echo ""

# Stop all services
down:
	docker compose --profile scaled --profile monitoring --profile tools down
	@echo "✅ All services stopped"

# Restart all services
restart: down up

# Follow logs
logs:
	docker compose logs -f

logs-api:
	docker compose logs -f api

logs-worker:
	docker compose logs -f worker

logs-all-workers:
	docker compose --profile scaled logs -f worker worker-rpc worker-db

# Scale RPC workers
scale-rpc: env-check
ifndef N
	$(error N is not set. Usage: make scale-rpc N=3)
endif
	docker compose --profile scaled up -d --scale worker-rpc=$(N)
	@echo "✅ Scaled RPC workers to $(N) instances"

# =============================================================================
# Temporal Operations
# =============================================================================

# Initialize database (run migrations)
migrate: env-check
	docker compose exec api node dist/db/migrate.js
	@echo "✅ Database migrated"

# Start collection workflow
collect: env-check
	docker compose exec worker node dist/temporal/client.js start

# Check status
status: env-check
	docker compose exec worker node dist/temporal/client.js status

# Watch progress
watch: env-check
	docker compose exec worker node dist/temporal/client.js watch

# Pause collection
pause: env-check
	docker compose exec worker node dist/temporal/client.js pause

# Resume collection
resume: env-check
	docker compose exec worker node dist/temporal/client.js resume

# Cancel collection
cancel: env-check
	docker compose exec worker node dist/temporal/client.js cancel

# Health check
health: env-check
	docker compose exec worker node dist/temporal/client.js health

# =============================================================================
# Maintenance
# =============================================================================

# Clean up everything
clean:
	docker compose --profile scaled --profile monitoring --profile tools down -v
	docker system prune -f
	@echo "✅ Cleaned up containers and volumes"

# Full reset - clean, rebuild, and start fresh
reset: env-check
	@echo "🧹 Cleaning up..."
	docker compose --profile scaled --profile monitoring --profile tools down -v
	@echo ""
	@echo "🔨 Rebuilding images..."
	docker compose build --no-cache
	@echo ""
	@echo "🚀 Starting fresh..."
	$(MAKE) up-scaled

# Shell access
shell-api:
	docker compose exec api sh

shell-worker:
	docker compose exec worker sh

shell-clickhouse:
	docker compose exec clickhouse clickhouse-client

# Temporal admin tools
temporal-admin:
	docker compose --profile tools run --rm temporal-admin-tools

# =============================================================================
# Local Development (without Docker for app, with Docker for infra)
# =============================================================================

# Run API locally (requires: make dev)
run-api:
	npm run api

# Run Temporal worker locally (requires: make dev)
run-worker:
	npm run temporal:worker

# Run dashboard locally
run-dashboard:
	npm run dashboard

# =============================================================================
# Utilities
# =============================================================================

# Show current configuration
config:
	@echo "Current Configuration (from .env):"
	@echo ""
	@grep -v '^#' .env | grep -v '^$$' | sort
	@echo ""

# Validate environment
validate: env-check
	@echo "Validating configuration..."
	@if grep -q "RPC_URLS=" .env && [ -n "$$(grep 'RPC_URLS=' .env | cut -d= -f2)" ]; then \
		echo "✅ RPC_URLS is configured"; \
	elif grep -q "SOLANA_RPC_URL=" .env && [ -n "$$(grep 'SOLANA_RPC_URL=' .env | cut -d= -f2)" ]; then \
		echo "✅ SOLANA_RPC_URL is configured"; \
	else \
		echo "⚠️  No RPC URL configured in .env"; \
	fi
	@echo "✅ Validation complete"

# Quick start - one command to rule them all
start: up

# Alias for make up-scaled
production: up-scaled
