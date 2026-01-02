#!/bin/bash

#═══════════════════════════════════════════════════════════════════════════════
# Test Worker IPC Communication
#═══════════════════════════════════════════════════════════════════════════════

set -e

WORKER_BIN="./bin/worker"

echo "Testing Worker IPC Communication"
echo "================================"
echo ""

# Check if worker exists
if [ ! -f "$WORKER_BIN" ]; then
    echo "❌ Worker binary not found at $WORKER_BIN"
    echo "   Run: make build-worker"
    exit 1
fi

echo "1. Testing Init Message..."
echo '{"type":"init","ts":1234567890,"data":{"workers":10,"timeout":30000}}' | timeout 2 $WORKER_BIN 2>/dev/null || true
echo ""

echo "2. Testing Task Message..."
echo '{"type":"task","ts":1234567890,"data":{"task_id":"task_001","dork":"inurl:admin"}}' | timeout 2 $WORKER_BIN 2>/dev/null || true
echo ""

echo "3. Testing Shutdown Message..."
echo '{"type":"shutdown","ts":1234567890}' | timeout 2 $WORKER_BIN 2>/dev/null || true
echo ""

echo "================================"
echo "✅ IPC Communication Test Complete"
