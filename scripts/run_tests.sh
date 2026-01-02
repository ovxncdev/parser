#!/bin/bash

#═══════════════════════════════════════════════════════════════════════════════
# Dorker Test Runner
# Run all Go tests for the worker engine
#═══════════════════════════════════════════════════════════════════════════════

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# Change to worker directory
cd "$(dirname "$0")/../worker"

echo -e "${BLUE}"
echo "╔═══════════════════════════════════════════════════════════════════╗"
echo "║                    Dorker Test Runner                             ║"
echo "╚═══════════════════════════════════════════════════════════════════╝"
echo -e "${NC}"

# Track results
TOTAL=0
PASSED=0
FAILED=0

run_test() {
    local package=$1
    local name=$2
    
    TOTAL=$((TOTAL + 1))
    
    echo -e "${YELLOW}[$TOTAL] Testing $name...${NC}"
    
    if go test -v ./$package/ 2>&1; then
        echo -e "${GREEN}✓ $name passed${NC}"
        PASSED=$((PASSED + 1))
    else
        echo -e "${RED}✗ $name failed${NC}"
        FAILED=$((FAILED + 1))
    fi
    
    echo ""
}

# Run tests for each package
echo -e "${BLUE}Running all tests...${NC}"
echo ""

run_test "internal/proxy" "Proxy Package"
run_test "internal/stealth" "Stealth Package"
run_test "internal/engine" "Engine Package"
run_test "internal/worker" "Worker Package"
run_test "internal/protocol" "Protocol Package"

# Summary
echo -e "${BLUE}═══════════════════════════════════════════════════════════════════${NC}"
echo -e "${BLUE}                         TEST SUMMARY                              ${NC}"
echo -e "${BLUE}═══════════════════════════════════════════════════════════════════${NC}"
echo ""
echo -e "  Total:   $TOTAL"
echo -e "  ${GREEN}Passed:  $PASSED${NC}"
echo -e "  ${RED}Failed:  $FAILED${NC}"
echo ""

if [ $FAILED -eq 0 ]; then
    echo -e "${GREEN}All tests passed! ✓${NC}"
    exit 0
else
    echo -e "${RED}Some tests failed! ✗${NC}"
    exit 1
fi
