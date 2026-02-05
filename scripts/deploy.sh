#!/bin/bash
set -e

# QuaiVault Indexer - Docker Deployment Script
# Usage: ./scripts/deploy.sh [command]
# Commands: start, stop, restart, logs, status, build, backfill

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_DIR"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

check_env() {
    if [ ! -f ".env" ]; then
        log_error ".env file not found!"
        log_info "Copy one of the example files:"
        log_info "  cp .env.testnet.example .env  # For Orchard Testnet"
        log_info "  cp .env.mainnet.example .env  # For Mainnet"
        exit 1
    fi
}

check_docker() {
    if ! command -v docker &> /dev/null; then
        log_error "Docker is not installed"
        exit 1
    fi
    if ! docker info &> /dev/null; then
        log_error "Docker daemon is not running"
        exit 1
    fi
}

cmd_build() {
    log_info "Building Docker image..."
    docker compose build
    log_info "Build complete"
}

cmd_start() {
    check_env
    log_info "Starting QuaiVault Indexer..."
    docker compose up -d
    log_info "Indexer started"
    log_info "View logs with: ./scripts/deploy.sh logs"

    # Wait and check health
    sleep 5
    cmd_status
}

cmd_stop() {
    log_info "Stopping QuaiVault Indexer..."
    docker compose down
    log_info "Indexer stopped"
}

cmd_restart() {
    log_info "Restarting QuaiVault Indexer..."
    docker compose restart
    log_info "Indexer restarted"

    sleep 5
    cmd_status
}

cmd_logs() {
    docker compose logs -f --tail=100
}

cmd_status() {
    log_info "Container status:"
    docker compose ps

    echo ""

    # Try to get health status
    HEALTH_PORT=$(grep HEALTH_CHECK_PORT .env 2>/dev/null | cut -d '=' -f2 | tr -d ' ')
    HEALTH_PORT=${HEALTH_PORT:-3000}

    if curl -s "http://localhost:$HEALTH_PORT/health" > /dev/null 2>&1; then
        log_info "Health check response:"
        curl -s "http://localhost:$HEALTH_PORT/health" | python3 -m json.tool 2>/dev/null || \
            curl -s "http://localhost:$HEALTH_PORT/health"
    else
        log_warn "Health endpoint not responding (service may still be starting)"
    fi
}

cmd_backfill() {
    check_env
    log_info "Starting backfill..."

    # Parse optional arguments
    FROM_BLOCK="${1:-}"
    TO_BLOCK="${2:-}"

    BACKFILL_ARGS=""
    if [ -n "$FROM_BLOCK" ]; then
        BACKFILL_ARGS="$BACKFILL_ARGS -e BACKFILL_FROM=$FROM_BLOCK"
    fi
    if [ -n "$TO_BLOCK" ]; then
        BACKFILL_ARGS="$BACKFILL_ARGS -e BACKFILL_TO=$TO_BLOCK"
    fi

    docker compose run --rm $BACKFILL_ARGS indexer node dist/backfill.js
    log_info "Backfill complete"
}

cmd_update() {
    log_info "Pulling latest changes..."
    git pull

    log_info "Rebuilding..."
    cmd_build

    log_info "Restarting..."
    cmd_restart

    log_info "Update complete"
}

cmd_help() {
    echo "QuaiVault Indexer - Docker Deployment Script"
    echo ""
    echo "Usage: ./scripts/deploy.sh [command]"
    echo ""
    echo "Commands:"
    echo "  start              Start the indexer"
    echo "  stop               Stop the indexer"
    echo "  restart            Restart the indexer"
    echo "  logs               View logs (follow mode)"
    echo "  status             Show container and health status"
    echo "  build              Build Docker image"
    echo "  backfill [from] [to]  Run backfill (optional block range)"
    echo "  update             Pull, rebuild, and restart"
    echo "  help               Show this help message"
    echo ""
    echo "Examples:"
    echo "  ./scripts/deploy.sh start"
    echo "  ./scripts/deploy.sh backfill 0 100000"
    echo "  ./scripts/deploy.sh logs"
}

# Main
check_docker

case "${1:-help}" in
    start)
        cmd_start
        ;;
    stop)
        cmd_stop
        ;;
    restart)
        cmd_restart
        ;;
    logs)
        cmd_logs
        ;;
    status)
        cmd_status
        ;;
    build)
        cmd_build
        ;;
    backfill)
        cmd_backfill "$2" "$3"
        ;;
    update)
        cmd_update
        ;;
    help|--help|-h)
        cmd_help
        ;;
    *)
        log_error "Unknown command: $1"
        cmd_help
        exit 1
        ;;
esac
