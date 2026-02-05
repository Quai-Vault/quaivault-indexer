#!/bin/bash
set -e

# QuaiVault Indexer - Ubuntu Installation Script
# Run as root or with sudo

# Configuration
INSTALL_DIR="/opt/quaivault-indexer"
SERVICE_USER="quai-indexer"
NODE_VERSION="20"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

check_root() {
    if [ "$EUID" -ne 0 ]; then
        log_error "This script must be run as root or with sudo"
        exit 1
    fi
}

install_nodejs() {
    if command -v node &> /dev/null; then
        CURRENT_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
        if [ "$CURRENT_VERSION" -ge "$NODE_VERSION" ]; then
            log_info "Node.js v$(node -v) already installed"
            return
        fi
    fi

    log_info "Installing Node.js $NODE_VERSION..."
    curl -fsSL https://deb.nodesource.com/setup_${NODE_VERSION}.x | bash -
    apt-get install -y nodejs
    log_info "Node.js $(node -v) installed"
}

create_user() {
    if id "$SERVICE_USER" &>/dev/null; then
        log_info "User $SERVICE_USER already exists"
    else
        log_info "Creating service user $SERVICE_USER..."
        useradd -r -s /bin/false "$SERVICE_USER"
    fi
}

setup_directory() {
    log_info "Setting up $INSTALL_DIR..."

    if [ -d "$INSTALL_DIR" ]; then
        log_warn "Directory $INSTALL_DIR already exists"
        read -p "Overwrite? [y/N] " -n 1 -r
        echo
        if [[ ! $REPLY =~ ^[Yy]$ ]]; then
            log_info "Skipping directory setup"
            return
        fi
    fi

    mkdir -p "$INSTALL_DIR"

    # Copy files from current directory if running from repo
    SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

    if [ -f "$PROJECT_DIR/package.json" ]; then
        log_info "Copying project files..."
        cp -r "$PROJECT_DIR"/* "$INSTALL_DIR/"
        cp "$PROJECT_DIR"/.env.*.example "$INSTALL_DIR/" 2>/dev/null || true
    else
        log_error "Run this script from the project directory"
        exit 1
    fi

    chown -R "$SERVICE_USER:$SERVICE_USER" "$INSTALL_DIR"
}

install_dependencies() {
    log_info "Installing Node.js dependencies..."
    cd "$INSTALL_DIR"
    sudo -u "$SERVICE_USER" npm ci --production
}

build_project() {
    log_info "Building TypeScript..."
    cd "$INSTALL_DIR"

    # Need dev dependencies for build
    sudo -u "$SERVICE_USER" npm ci
    sudo -u "$SERVICE_USER" npm run build

    # Clean up dev dependencies
    sudo -u "$SERVICE_USER" npm ci --production
}

setup_env() {
    if [ -f "$INSTALL_DIR/.env" ]; then
        log_info ".env file already exists"
        return
    fi

    log_info "Setting up environment file..."

    echo "Which network are you deploying to?"
    echo "1) Orchard Testnet"
    echo "2) Mainnet"
    read -p "Select [1/2]: " -n 1 -r
    echo

    if [[ $REPLY == "2" ]]; then
        cp "$INSTALL_DIR/.env.mainnet.example" "$INSTALL_DIR/.env"
        log_info "Created .env from mainnet template"
    else
        cp "$INSTALL_DIR/.env.testnet.example" "$INSTALL_DIR/.env"
        log_info "Created .env from testnet template"
    fi

    chown "$SERVICE_USER:$SERVICE_USER" "$INSTALL_DIR/.env"
    chmod 600 "$INSTALL_DIR/.env"

    log_warn "IMPORTANT: Edit $INSTALL_DIR/.env with your configuration"
}

install_service() {
    log_info "Installing systemd service..."

    cp "$INSTALL_DIR/deploy/quaivault-indexer.service" /etc/systemd/system/

    # Update paths if different from default
    if [ "$INSTALL_DIR" != "/opt/quaivault-indexer" ]; then
        sed -i "s|/opt/quaivault-indexer|$INSTALL_DIR|g" \
            /etc/systemd/system/quaivault-indexer.service
    fi

    systemctl daemon-reload
    systemctl enable quaivault-indexer

    log_info "Service installed and enabled"
}

print_next_steps() {
    echo ""
    echo "============================================"
    echo -e "${GREEN}Installation Complete!${NC}"
    echo "============================================"
    echo ""
    echo "Next steps:"
    echo ""
    echo "1. Edit the environment file:"
    echo "   sudo nano $INSTALL_DIR/.env"
    echo ""
    echo "2. Start the service:"
    echo "   sudo systemctl start quaivault-indexer"
    echo ""
    echo "3. Check status:"
    echo "   sudo systemctl status quaivault-indexer"
    echo ""
    echo "4. View logs:"
    echo "   sudo journalctl -u quaivault-indexer -f"
    echo ""
    echo "5. Run backfill (if needed):"
    echo "   cd $INSTALL_DIR && sudo -u $SERVICE_USER node dist/backfill.js"
    echo ""
}

# Main
check_root

log_info "Starting QuaiVault Indexer installation..."
echo ""

install_nodejs
create_user
setup_directory
install_dependencies
build_project
setup_env
install_service
print_next_steps
