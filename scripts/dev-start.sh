#!/usr/bin/env bash
# Start API + Web dev servers. Kills existing processes first.
# Usage: ./scripts/dev-start.sh [--api-only] [--web-only]

set -euo pipefail

API_ONLY=false
WEB_ONLY=false

for arg in "$@"; do
  case $arg in
    --api-only) API_ONLY=true ;;
    --web-only) WEB_ONLY=true ;;
  esac
done

# Kill existing
if [ "$WEB_ONLY" = false ]; then
  lsof -ti:3001 | xargs kill -9 2>/dev/null || true
  pkill -f "tsx.*src/index" 2>/dev/null || true
fi
if [ "$API_ONLY" = false ]; then
  lsof -ti:3000 | xargs kill -9 2>/dev/null || true
fi

sleep 1

# Start servers
if [ "$WEB_ONLY" = false ]; then
  bun run --filter @interceptor/api dev > /tmp/api-server.log 2>&1 &
  echo "API server starting on port 3001..."
fi
if [ "$API_ONLY" = false ]; then
  bun run --filter @interceptor/web dev > /tmp/web-server.log 2>&1 &
  echo "Web server starting on port 3000..."
fi

# Wait and verify
sleep 8

if [ "$WEB_ONLY" = false ]; then
  if curl -sf http://localhost:3001/health > /dev/null 2>&1; then
    echo "API: http://localhost:3001 ✓"
  else
    echo "API: FAILED — check /tmp/api-server.log"
  fi
fi

if [ "$API_ONLY" = false ]; then
  status=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/ 2>/dev/null)
  if [ "$status" = "200" ] || [ "$status" = "307" ]; then
    echo "Web: http://localhost:3000 ✓"
  else
    echo "Web: FAILED ($status) — check /tmp/web-server.log"
  fi
fi
