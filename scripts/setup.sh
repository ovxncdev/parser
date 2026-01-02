#!/bin/bash

#═══════════════════════════════════════════════════════════════════════════════
# Dorker - Complete Setup Script
# Installs dependencies and builds both Go worker and TypeScript CLI
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

# Get script directory
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
        echo "Please install Go 1.22+ from https://golang.org/dl/"
        echo ""
        case "$OS" in
            linux)
                echo "  Ubuntu/Debian: sudo apt install golang-go"
                echo "  Fedora:        sudo dnf install golang"
                echo "  Arch:          sudo pacman -S go"
                ;;
            darwin)
                echo "  Homebrew:      brew install go"
                ;;
            windows)
                echo "  Download from: https://golang.org/dl/"
                ;;
        esac
        exit 1
    fi

    GO_VERSION=$(go version | grep -oP 'go\K[0-9]+\.[0-9]+' || go version | sed 's/.*go\([0-9]*\.[0-9]*\).*/\1/')
    GO_MAJOR=$(echo "$GO_VERSION" | cut -d. -f1)
    GO_MINOR=$(echo "$GO_VERSION" | cut -d. -f2)

    if [ "$GO_MAJOR" -lt 1 ] || ([ "$GO_MAJOR" -eq 1 ] && [ "$GO_MINOR" -lt 22 ]); then
        echo -e "${RED}✗ Go version $GO_VERSION is too old. Please upgrade to Go 1.22+${NC}"
        exit 1
    fi

    echo -e "${GREEN}✓ Go $GO_VERSION installed${NC}"
}

#───────────────────────────────────────────────────────────────────────────────
# Check Node.js installation
#───────────────────────────────────────────────────────────────────────────────

check_node() {
    echo -e "${YELLOW}Checking Node.js installation...${NC}"
    
    if ! command -v node &> /dev/null; then
        echo -e "${RED}✗ Node.js is not installed${NC}"
        echo ""
        echo "Please install Node.js 20+ from https://nodejs.org/"
        echo ""
        case "$OS" in
            linux)
                echo "  Using nvm:     nvm install 20"
                echo "  Ubuntu/Debian: curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt install -y nodejs"
                ;;
            darwin)
                echo "  Homebrew:      brew install node@20"
                echo "  Using nvm:     nvm install 20"
                ;;
            windows)
                echo "  Download from: https://nodejs.org/"
                ;;
        esac
        exit 1
    fi

    NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)

    if [ "$NODE_VERSION" -lt 20 ]; then
        echo -e "${RED}✗ Node.js version $(node -v) is too old. Please upgrade to Node.js 20+${NC}"
        exit 1
    fi

    echo -e "${GREEN}✓ Node.js $(node -v) installed${NC}"

    if ! command -v npm &> /dev/null; then
        echo -e "${RED}✗ npm is not installed${NC}"
        exit 1
    fi

    echo -e "${GREEN}✓ npm $(npm -v) installed${NC}"
}

#───────────────────────────────────────────────────────────────────────────────
# Create directories
#───────────────────────────────────────────────────────────────────────────────

create_directories() {
    echo -e "${YELLOW}Creating directories...${NC}"
    
    mkdir -p bin
    mkdir -p input
    mkdir -p output
    mkdir -p logs
    
    echo -e "${GREEN}✓ Directories created${NC}"
}

#───────────────────────────────────────────────────────────────────────────────
# Build Go worker
#───────────────────────────────────────────────────────────────────────────────

build_worker() {
    echo ""
    echo -e "${YELLOW}Building Go worker...${NC}"
    
    cd "$PROJECT_DIR/worker"
    
    # Download dependencies
    echo "  Downloading Go dependencies..."
    go mod download 2>/dev/null || go mod tidy 2>/dev/null || true
    
    # Build
    echo "  Compiling worker..."
    VERSION="1.0.0"
    BUILD_TIME=$(date -u '+%Y-%m-%d_%H:%M:%S')
    
    go build \
        -ldflags "-X main.Version=$VERSION -X main.BuildTime=$BUILD_TIME" \
        -o "$PROJECT_DIR/bin/worker" \
        ./cmd/worker
    
    if [ -f "$PROJECT_DIR/bin/worker" ]; then
        chmod +x "$PROJECT_DIR/bin/worker"
        echo -e "${GREEN}✓ Worker built: bin/worker${NC}"
    else
        echo -e "${RED}✗ Failed to build worker${NC}"
        exit 1
    fi
    
    cd "$PROJECT_DIR"
}

#───────────────────────────────────────────────────────────────────────────────
# Build TypeScript CLI
#───────────────────────────────────────────────────────────────────────────────

build_cli() {
    echo ""
    echo -e "${YELLOW}Building TypeScript CLI...${NC}"
    
    cd "$PROJECT_DIR/cli"
    
    # Install dependencies
    echo "  Installing npm dependencies..."
    npm install --silent 2>/dev/null || npm install
    
    # Build
    echo "  Compiling TypeScript..."
    npm run build 2>/dev/null || npx tsc
    
    if [ -d "$PROJECT_DIR/cli/dist" ]; then
        echo -e "${GREEN}✓ CLI built: cli/dist/${NC}"
    else
        echo -e "${RED}✗ Failed to build CLI${NC}"
        exit 1
    fi
    
    cd "$PROJECT_DIR"
}

#───────────────────────────────────────────────────────────────────────────────
# Create sample files
#───────────────────────────────────────────────────────────────────────────────

create_samples() {
    echo ""
    echo -e "${YELLOW}Creating sample files...${NC}"
    
    # Sample dorks
    if [ ! -f "$PROJECT_DIR/input/sample-dorks.txt" ]; then
        cat > "$PROJECT_DIR/input/sample-dorks.txt" << 'EOF'
# Sample dorks file
# One dork per line, lines starting with # are comments

inurl:admin
inurl:login
inurl:dashboard
inurl:config
filetype:pdf confidential
filetype:sql password
intitle:"index of" password
intitle:"index of" backup
site:pastebin.com password
inurl:wp-admin
EOF
        echo -e "${GREEN}✓ Created input/sample-dorks.txt${NC}"
    else
        echo -e "${BLUE}  input/sample-dorks.txt already exists${NC}"
    fi
    
    # Sample proxies
    if [ ! -f "$PROJECT_DIR/input/sample-proxies.txt" ]; then
        cat > "$PROJECT_DIR/input/sample-proxies.txt" << 'EOF'
# Sample proxies file
# Supported formats:
#   ip:port
#   ip:port:user:pass
#   user:pass@ip:port
#   http://ip:port
#   https://ip:port
#   socks4://ip:port
#   socks5://ip:port
#   socks5://user:pass@ip:port

# Add your proxies below:
# 192.168.1.1:8080
# 192.168.1.2:8080:admin:password
# socks5://192.168.1.3:1080
EOF
        echo -e "${GREEN}✓ Created input/sample-proxies.txt${NC}"
    else
        echo -e "${BLUE}  input/sample-proxies.txt already exists${NC}"
    fi
    
    # Sample config
    if [ ! -f "$PROJECT_DIR/dorker.yml" ]; then
        cat > "$PROJECT_DIR/dorker.yml" << 'EOF'
# Dorker Configuration

# Concurrency settings
workers: 10
timeout: 30000
baseDelay: 8000
minDelay: 3000
maxDelay: 15000
maxRetries: 3
resultsPerPage: 100

# Filter settings
filters:
  antiPublic: true
  removeDuplicateDomains: true
  noRedirectUrls: true
  urlParametersOnly: false
  cleanTopDomains: false
  keepUnfiltered: true

# Output settings
output:
  format: txt
  directory: ./output
  prefix: dorker
  splitByDork: false
  includeMetadata: false
EOF
        echo -e "${GREEN}✓ Created dorker.yml${NC}"
    else
        echo -e "${BLUE}  dorker.yml already exists${NC}"
    fi
}

#───────────────────────────────────────────────────────────────────────────────
# Run tests
#───────────────────────────────────────────────────────────────────────────────

run_tests() {
    echo ""
    echo -e "${YELLOW}Running tests...${NC}"
    
    # Go tests
    echo "  Running Go tests..."
    cd "$PROJECT_DIR/worker"
    if go test ./... -short 2>/dev/null; then
        echo -e "${GREEN}  ✓ Go tests passed${NC}"
    else
        echo -e "${YELLOW}  ⚠ Some Go tests failed (continuing anyway)${NC}"
    fi
    
    cd "$PROJECT_DIR"
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
    echo -e "  ${BLUE}Worker binary:${NC}  bin/worker"
    echo -e "  ${BLUE}CLI:${NC}            cli/dist/index.js"
    echo -e "  ${BLUE}Config:${NC}         dorker.yml"
    echo ""
    echo -e "  ${YELLOW}Quick Start:${NC}"
    echo ""
    echo "  1. Add your proxies to input/sample-proxies.txt"
    echo "  2. Add your dorks to input/sample-dorks.txt"
    echo "  3. Run:"
    echo ""
    echo -e "     ${CYAN}# Standalone mode (worker only)${NC}"
    echo "     ./bin/worker --standalone --dorks input/sample-dorks.txt --proxies input/sample-proxies.txt"
    echo ""
    echo -e "     ${CYAN}# Full CLI with UI${NC}"
    echo "     cd cli && node dist/index.js run -d ../input/sample-dorks.txt -p ../input/sample-proxies.txt"
    echo ""
    echo -e "     ${CYAN}# Using Make${NC}"
    echo "     make run"
    echo ""
    echo -e "  ${YELLOW}Other commands:${NC}"
    echo "     make test      - Run all tests"
    echo "     make clean     - Clean build artifacts"
    echo "     make release   - Build release binaries"
    echo "     make help      - Show all commands"
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
    build_cli
    create_samples
    run_tests
    print_summary
}

# Run main
main "$@"
