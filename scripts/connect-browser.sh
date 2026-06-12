#!/usr/bin/env bash
# Connect a browser to a URL via the API server's WebSocket endpoint.
#
# Launches a browser session, waits for it to be ready, then keeps the
# WebSocket connection alive in the background so traffic capture works.
#
# Usage:
#   ./scripts/connect-browser.sh --profile mysite --url https://www.example.com
#   ./scripts/connect-browser.sh --profile generic --url http://localhost:4444/boardshop
#   ./scripts/connect-browser.sh --profile generic --url http://localhost:4444/boardshop --port 3001
#
# Options:
#   --profile <name>    Browser profile name (default: generic)
#   --url <target-url>  URL to navigate to (required)
#   --port <number>     API server port (default: 3001)
#   --timeout <seconds> Max wait for browser ready (default: 60)
#   --foreground        Run in foreground instead of background
#
# Output:
#   Prints "Browser connected. Capture traffic at: GET http://localhost:PORT/browser/traffic"
#   when ready. The WebSocket process runs in the background (PID saved to /tmp/connect-browser-PROFILE.pid).
#
# Cleanup:
#   kill $(cat /tmp/connect-browser-PROFILE.pid)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# Defaults
PROFILE="generic"
URL=""
PORT="3001"
TIMEOUT="60"
FOREGROUND=false

# Parse arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    --profile) PROFILE="$2"; shift 2 ;;
    --url) URL="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --timeout) TIMEOUT="$2"; shift 2 ;;
    --foreground) FOREGROUND=true; shift ;;
    -h|--help)
      head -25 "$0" | tail -20
      exit 0
      ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

if [[ -z "$URL" ]]; then
  echo "Error: --url is required"
  echo "Usage: $0 --profile <name> --url <target-url> [--port <number>]"
  exit 1
fi

# Resolve the ws module path from Bun's workspace install.
WS_MODULE="$PROJECT_DIR/node_modules/ws"
if [[ ! -d "$WS_MODULE" ]]; then
  echo "Error: 'ws' module not found. Run 'bun install' first."
  exit 1
fi

# Check if API server is running
if ! lsof -iTCP:"$PORT" -sTCP:LISTEN -P >/dev/null 2>&1; then
  echo "Error: Nothing listening on port $PORT. Start the API server first:"
  echo "  bun run --filter @interceptor/api dev"
  exit 1
fi

PIDFILE="/tmp/connect-browser-${PROFILE}.pid"
CONNECT_SCRIPT="$SCRIPT_DIR/connect-browser.cjs"

# Kill any existing connection for this profile
if [[ -f "$PIDFILE" ]]; then
  OLD_PID=$(cat "$PIDFILE")
  if kill -0 "$OLD_PID" 2>/dev/null; then
    echo "Killing existing browser connection (PID $OLD_PID) for profile '$PROFILE'"
    kill "$OLD_PID" 2>/dev/null || true
    sleep 1
  fi
  rm -f "$PIDFILE"
fi

if [[ "$FOREGROUND" == "true" ]]; then
  # Run in foreground — useful for debugging
  exec bun "$CONNECT_SCRIPT" "$PORT" "$PROFILE" "$URL" "$TIMEOUT"
else
  # Run in background, wait for BROWSER_READY signal
  OUTFILE=$(mktemp /tmp/connect-browser-out.XXXXXX)

  bun "$CONNECT_SCRIPT" "$PORT" "$PROFILE" "$URL" "$TIMEOUT" > "$OUTFILE" 2>&1 &
  BG_PID=$!
  echo "$BG_PID" > "$PIDFILE"

  # Wait for the BROWSER_READY signal or process exit
  ELAPSED=0
  while [[ $ELAPSED -lt $TIMEOUT ]]; do
    # Check if process died
    if ! kill -0 "$BG_PID" 2>/dev/null; then
      echo "Error: Browser connection process exited unexpectedly:"
      cat "$OUTFILE"
      rm -f "$OUTFILE" "$PIDFILE"
      exit 1
    fi

    # Check for ready signal
    if grep -q "BROWSER_READY" "$OUTFILE" 2>/dev/null; then
      # Print all output (includes the ready message)
      grep -v "BROWSER_READY|" "$OUTFILE"
      echo ""
      echo "WebSocket connection running in background (PID $BG_PID)"
      echo "To stop: kill $BG_PID  (or: kill \$(cat $PIDFILE))"
      rm -f "$OUTFILE"
      exit 0
    fi

    sleep 1
    ELAPSED=$((ELAPSED + 1))
  done

  # Timeout
  echo "Error: Timed out after ${TIMEOUT}s waiting for browser to be ready"
  echo "Output so far:"
  cat "$OUTFILE"
  kill "$BG_PID" 2>/dev/null || true
  rm -f "$OUTFILE" "$PIDFILE"
  exit 1
fi
