#!/bin/bash

# QuaiVault Indexer - Health Check Script
# Usage: ./scripts/health-check.sh [port]
# Returns exit code 0 if healthy, 1 if unhealthy

PORT="${1:-3000}"
URL="http://localhost:$PORT/health"

# Fetch health status
RESPONSE=$(curl -s -w "\n%{http_code}" "$URL" 2>/dev/null)
HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
BODY=$(echo "$RESPONSE" | sed '$d')

if [ "$HTTP_CODE" != "200" ]; then
    echo "UNHEALTHY: HTTP $HTTP_CODE"
    echo "$BODY" | python3 -m json.tool 2>/dev/null || echo "$BODY"
    exit 1
fi

# Parse status from JSON
STATUS=$(echo "$BODY" | python3 -c "import sys, json; print(json.load(sys.stdin)['status'])" 2>/dev/null)

if [ "$STATUS" == "healthy" ]; then
    echo "HEALTHY"

    # Print details
    echo ""
    echo "$BODY" | python3 -m json.tool 2>/dev/null || echo "$BODY"
    exit 0
else
    echo "UNHEALTHY: $STATUS"
    echo ""
    echo "$BODY" | python3 -m json.tool 2>/dev/null || echo "$BODY"
    exit 1
fi
