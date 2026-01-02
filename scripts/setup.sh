#!/bin/bash

#═══════════════════════════════════════════════════════════════════════════════
# Dorker - Setup Script
# Installs dependencies and builds Go worker
#═══════════════════════════════════════════════════════════════════════════════

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

# Print banner
echo -e "${CYAN}"
echo "╔═══════════════════════════════════════════════════════════════════╗"
echo "║     ██████╗  ██████╗ ██████╗ ██╗  ██╗███████╗██████╗              ║"
echo "║     ██╔══██╗██╔═══██╗██╔══██╗██║ ██╔╝██╔════╝██╔══██╗             ║"
echo "║     ██║  ██║██║   ██║██████╔╝█████╔╝ █████╗  ██████╔╝             ║"
echo "║     ██║  ██║██║   ██║██╔══██╗██╔═██╗ ██╔══╝  ██╔══██╗             ║"
echo "║     ██████╔╝╚██████╔╝██║  ██║██║  ██╗███████╗██║  ██║             ║"
echo "║     ╚═════╝  ╚═════╝ ╚═╝  ╚═╝╚═╝  ╚═╝╚══════╝╚═╝  ╚═╝             ║"
echo "║                                                                   ║"
echo "║                       Setup Script v1.0                           ║"
echo "╚═══════════════════════════════════════════════════════════════════╝"
echo -e "${NC}"

# Get project directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

cd "$PROJECT_DIR"

echo -e "${BLUE}Project directory: ${PROJECT_DIR}${NC}"
echo ""

#───────────────────────────────────────────────────────────────────────────────
# Detect OS
#───────────────────────────────────────────────────────────────────────────────

detect_os() {
    case "$(uname -s)" in
        Linux*)     OS="linux";;
        Darwin*)    OS="darwin";;
        MINGW*|MSYS*|CYGWIN*) OS="windows";;
        *)          OS="unknown";;
    esac
    echo -e "${GREEN}✓ Detected OS: ${OS}${NC}"
}

#───────────────────────────────────────────────────────────────────────────────
# Check Go installation
#───────────────────────────────────────────────────────────────────────────────

check_go() {
    echo -e "${YELLOW}Checking Go installation...${NC}"
    
    if ! command -v go &> /dev/null; then
        echo -e "${RED}✗ Go is not installed${NC}"
        echo ""
        echo "Please install Go 1.21+ from https://golang.org/dl/"
        case "$OS" in
            linux)
                echo "  Ubuntu/Debian: sudo apt install golang-go"
                echo "  Fedora:        sudo dnf install golang"
                ;;
            darwin)
                echo "  Homebrew:      brew install go"
                ;;
        esac
        exit 1
    fi

    echo -e "${GREEN}✓ Go $(go version | awk '{print $3}') installed${NC}"
}

#───────────────────────────────────────────────────────────────────────────────
# Check Node.js installation
#───────────────────────────────────────────────────────────────────────────────

check_node() {
    echo -e "${YELLOW}Checking Node.js installation...${NC}"
    
    if ! command -v node &> /dev/null; then
        echo -e "${RED}✗ Node.js is not installed${NC}"
        echo ""
        echo "Please install Node.js 18+ from https://nodejs.org/"
        case "$OS" in
            linux)
                echo "  Using nvm: nvm install 18"
                ;;
            darwin)
                echo "  Homebrew: brew install node"
                ;;
        esac
        exit 1
    fi

    NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
    if [ "$NODE_VERSION" -lt 18 ]; then
        echo -e "${RED}✗ Node.js 18+ required. Current: $(node -v)${NC}"
        exit 1
    fi

    echo -e "${GREEN}✓ Node.js $(node -v) installed${NC}"
    echo -e "${GREEN}✓ npm $(npm -v) installed${NC}"
}

#───────────────────────────────────────────────────────────────────────────────
# Create directories
#───────────────────────────────────────────────────────────────────────────────

create_directories() {
    echo -e "${YELLOW}Creating directories...${NC}"
    
    mkdir -p bin input output
    
    echo -e "${GREEN}✓ Directories created${NC}"
}

#───────────────────────────────────────────────────────────────────────────────
# Build Go worker
#───────────────────────────────────────────────────────────────────────────────

build_worker() {
    echo ""
    echo -e "${YELLOW}Building Go worker...${NC}"
    
    cd "$PROJECT_DIR/worker"
    
    go mod tidy 2>/dev/null || true
    
    VERSION="1.0.0"
    BUILD_TIME=$(date -u '+%Y-%m-%d_%H:%M:%S')
    
    go build \
        -ldflags "-X main.Version=$VERSION -X main.BuildTime=$BUILD_TIME" \
        -o "$PROJECT_DIR/bin/worker" \
        ./cmd/worker
    
    chmod +x "$PROJECT_DIR/bin/worker"
    echo -e "${GREEN}✓ Worker built: bin/worker${NC}"
    
    cd "$PROJECT_DIR"
}

#───────────────────────────────────────────────────────────────────────────────
# Install CLI dependencies
#───────────────────────────────────────────────────────────────────────────────

install_cli() {
    echo ""
    echo -e "${YELLOW}Installing CLI dependencies...${NC}"
    
    cd "$PROJECT_DIR/cli"
    
    npm install --silent 2>/dev/null || npm install
    
    echo -e "${GREEN}✓ CLI dependencies installed${NC}"
    
    cd "$PROJECT_DIR"
}

#───────────────────────────────────────────────────────────────────────────────
# Create sample files
#───────────────────────────────────────────────────────────────────────────────

create_samples() {
    echo ""
    echo -e "${YELLOW}Creating sample files...${NC}"
    
    # Sample dorks
    if [ ! -f "$PROJECT_DIR/input/dorks.txt" ]; then
        cat > "$PROJECT_DIR/input/dorks.txt" << 'DORKS'
# Sample dorks - add your own below
inurl:admin
inurl:login
inurl:dashboard
inurl:config.php
inurl:wp-admin
filetype:pdf confidential
filetype:sql password
filetype:xls password
intitle:"index of"
site:edu filetype:pdf
DORKS
        echo -e "${GREEN}✓ Created input/dorks.txt${NC}"
    fi
    
    # Sample proxies
    if [ ! -f "$PROJECT_DIR/input/proxies.txt" ]; then
        cat > "$PROJECT_DIR/input/proxies.txt" << 'PROXIES'
# Add your proxies below, one per line
# Formats supported:
#   ip:port
#   ip:port:user:pass
#   http://ip:port
#   socks5://user:pass@ip:port
PROXIES
        echo -e "${GREEN}✓ Created input/proxies.txt${NC}"
    fi
}

#───────────────────────────────────────────────────────────────────────────────
# Print summary
#───────────────────────────────────────────────────────────────────────────────

print_summary() {
    echo ""
    echo -e "${CYAN}═══════════════════════════════════════════════════════════════════${NC}"
    echo -e "${GREEN}                     Setup Complete!${NC}"
    echo -e "${CYAN}═══════════════════════════════════════════════════════════════════${NC}"
    echo ""
    echo -e "  ${BLUE}Worker:${NC}  bin/worker"
    echo -e "  ${BLUE}CLI:${NC}     cli/src/index.js"
    echo ""
    echo -e "  ${YELLOW}Quick Start:${NC}"
    echo ""
    echo "  1. Add your proxies to input/proxies.txt"
    echo "  2. Run:"
    echo ""
    echo -e "     ${CYAN}# Interactive mode${NC}"
    echo "     cd cli && node src/index.js"
    echo ""
    echo -e "     ${CYAN}# With arguments${NC}"
    echo "     cd cli && node src/index.js run -d ../input/dorks.txt -p ../input/proxies.txt"
    echo ""
    echo -e "     ${CYAN}# Standalone worker (no UI)${NC}"
    echo "     ./bin/worker --standalone --dorks input/dorks.txt --proxies input/proxies.txt"
    echo ""
}

#───────────────────────────────────────────────────────────────────────────────
# Main
#───────────────────────────────────────────────────────────────────────────────

main() {
    detect_os
    check_go
    check_node
    create_directories
    build_worker
    install_cli
    create_samples
    print_summary
}

main "$@"
