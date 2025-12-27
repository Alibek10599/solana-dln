# =============================================================================
# DLN Solana Dashboard - Makefile
# =============================================================================

.PHONY: help build up down logs restart clean dev infra collect status env-check

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
	@echo "  make up            - Start all services"
	@echo "  make down          - Stop all services"
	@echo "  make restart       - Restart all services"
	@echo "  make logs          - Follow logs for all services"
	@echo "  make logs-api      - Follow API logs"
	@echo "  make logs-worker   - Follow worker logs"
	@echo ""
	@echo "Scaling:"
	@echo "  make up-scaled     - Start with scaled workers"
	@echo "  make scale-rpc N=3 - Scale RPC workers to N instances"
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
	@echo "   Edit .env to configure your settings (especially SOLANA_RPC_URL)"

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

# =============================================================================
# Docker Operations
# =============================================================================

# Build all images
build: env-check
	docker compose build
	@echo "✅ Images built"

# Start all services
up: env-check
	docker compose up -d
	@echo ""
	@echo "✅ All services started!"
	@echo ""
	@echo "Services:"
	@echo "  - Dashboard:    http://localhost:$${DASHBOARD_PORT:-3000}"
	@echo "  - API:          http://localhost:$${API_PORT:-3001}"
	@echo "  - Temporal UI:  http://localhost:$${TEMPORAL_UI_PORT:-8233}"
	@echo "  - ClickHouse:   http://localhost:$${CLICKHOUSE_PORT:-8123}"
	@echo ""
	@echo "Next steps:"
	@echo "  make collect    - Start data collection"
	@echo "  make watch      - Watch progress"

# Start with scaled workers
up-scaled: env-check
	docker compose --profile scaled up -d
	@echo "✅ Started with scaled workers"

# Stop all services
down:
	docker compose --profile scaled --profile tools down
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
	docker compose --profile scaled --profile tools down -v
	docker system prune -f
	@echo "✅ Cleaned up containers and volumes"

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

# Run API locally
run-api:
	npm run api

# Run worker locally
run-worker:
	npm run temporal:worker

# Run dashboard locally
run-dashboard:
	npm run dashboard

# Run simple collector (non-Temporal)
run-collect:
	npm run collect

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
	@if [ -z "$${SOLANA_RPC_URL}" ]; then \
		echo "⚠️  SOLANA_RPC_URL is not set in .env"; \
	else \
		echo "✅ SOLANA_RPC_URL is configured"; \
	fi
	@echo "✅ Validation complete"
