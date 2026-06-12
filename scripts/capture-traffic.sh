#!/usr/bin/env bash
# Capture and display browser traffic from the API server.
#
# Fetches traffic entries from GET /browser/traffic and pretty-prints them.
# Use after connect-browser.sh has established a browser session.
#
# Usage:
#   ./scripts/capture-traffic.sh                          # Print traffic summary
#   ./scripts/capture-traffic.sh --full                   # Print full entries with bodies
#   ./scripts/capture-traffic.sh --save /tmp/traffic      # Save full entries to directory
#   ./scripts/capture-traffic.sh --since 42               # Only entries after ID 42
#   ./scripts/capture-traffic.sh --port 3001              # Custom port
#   ./scripts/capture-traffic.sh --watch                  # Poll every 3s for new traffic
#   ./scripts/capture-traffic.sh --watch --interval 5     # Poll every 5s
#   ./scripts/capture-traffic.sh --summary                # Show endpoint summary only
#   ./scripts/capture-traffic.sh --clear                  # Clear traffic buffer
#
# Requires: curl, bun (for JSON formatting)

set -euo pipefail

# Defaults
PORT="3001"
SINCE=""
FULL=false
SAVE_DIR=""
WATCH=false
INTERVAL=3
SUMMARY=false
CLEAR=false

# Parse arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    --port) PORT="$2"; shift 2 ;;
    --since) SINCE="$2"; shift 2 ;;
    --full) FULL=true; shift ;;
    --save) SAVE_DIR="$2"; shift 2 ;;
    --watch) WATCH=true; shift ;;
    --interval) INTERVAL="$2"; shift 2 ;;
    --summary) SUMMARY=true; shift ;;
    --clear) CLEAR=true; shift ;;
    -h|--help)
      head -18 "$0" | tail -15
      exit 0
      ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

BASE_URL="http://localhost:${PORT}"
AUTH_ARGS=()
if [[ -n "${INTERCEPTOR_CONTROL_TOKEN:-}" ]]; then
  AUTH_ARGS=(-H "Authorization: Bearer ${INTERCEPTOR_CONTROL_TOKEN}")
fi

# Check if API server is running
if ! curl -sf "${BASE_URL}/health" > /dev/null 2>&1; then
  echo "Error: API server not responding on port $PORT"
  echo "  Start it with: bun run --filter @interceptor/api dev"
  exit 1
fi

# Clear mode
if [[ "$CLEAR" == "true" ]]; then
  RESULT=$(curl -sf "${AUTH_ARGS[@]}" -X DELETE "${BASE_URL}/browser/traffic")
  echo "Traffic buffer cleared: $RESULT"
  exit 0
fi

# Summary mode
if [[ "$SUMMARY" == "true" ]]; then
  curl -sf "${AUTH_ARGS[@]}" "${BASE_URL}/browser/traffic/summary" | bun -e "
    const data = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
    console.log('Traffic Summary');
    console.log('===============');
    console.log('Total entries: ' + data.totalEntries);
    console.log('Unique endpoints: ' + data.uniqueEndpoints);
    console.log('');
    if (data.endpoints && data.endpoints.length > 0) {
      console.log('Endpoint                                                          Count  Methods    Statuses');
      console.log('-'.repeat(100));
      for (const ep of data.endpoints) {
        const pattern = ep.pattern.length > 65 ? ep.pattern.slice(0, 62) + '...' : ep.pattern;
        const line = pattern.padEnd(66) +
          String(ep.count).padEnd(7) +
          ep.methods.join(',').padEnd(11) +
          ep.statuses.join(',');
        console.log(line);
      }
    } else {
      console.log('No traffic captured yet. Connect a browser first:');
      console.log('  ./scripts/connect-browser.sh --profile generic --url <target-url>');
    }
  "
  exit 0
fi

# Fetch and format traffic entries
fetch_traffic() {
  local url="${BASE_URL}/browser/traffic"
  if [[ -n "$SINCE" ]]; then
    url="${url}?since=${SINCE}"
  fi

  local response
  response=$(curl -sf "${AUTH_ARGS[@]}" "$url")

  if [[ -z "$response" ]]; then
    echo "No response from traffic endpoint"
    return 1
  fi

  local entry_count
  entry_count=$(echo "$response" | bun -e "
    const data = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
    console.log(data.entries ? data.entries.length : 0);
  ")

  if [[ "$entry_count" == "0" ]]; then
    if [[ "$WATCH" != "true" ]]; then
      echo "No traffic entries found${SINCE:+ since ID $SINCE}."
      echo "Make sure a browser is connected and has navigated to a page."
    fi
    return 0
  fi

  if [[ -n "$SAVE_DIR" ]]; then
    mkdir -p "$SAVE_DIR"
    echo "$response" | bun -e "
      const fs = require('fs');
      const path = require('path');
      const data = JSON.parse(fs.readFileSync('/dev/stdin','utf8'));
      const dir = process.argv[1];

      // Save full JSON
      fs.writeFileSync(path.join(dir, 'traffic.json'), JSON.stringify(data, null, 2));

      // Save individual response bodies
      for (const entry of data.entries) {
        const safeName = entry.url.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 80);
        const filename = entry.id + '_' + entry.method + '_' + safeName + '.json';
        const entryData = {
          id: entry.id,
          method: entry.method,
          url: entry.url,
          status: entry.status,
          requestHeaders: entry.requestHeaders,
          requestBody: entry.requestBody,
          responseHeaders: entry.responseHeaders,
          responseBody: entry.responseBody,
          durationMs: entry.durationMs,
        };
        fs.writeFileSync(path.join(dir, filename), JSON.stringify(entryData, null, 2));
      }

      console.log('Saved ' + data.entries.length + ' entries to ' + dir);
      console.log('  Full traffic: ' + path.join(dir, 'traffic.json'));
      console.log('  Individual entries: ' + dir + '/<id>_<method>_<url>.json');
    " "$SAVE_DIR"
    return 0
  fi

  if [[ "$FULL" == "true" ]]; then
    echo "$response" | bun -e "
      const data = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
      console.log('Traffic Entries (' + data.total + ' total, showing ' + data.entries.length + ')');
      console.log('='.repeat(80));
      for (const entry of data.entries) {
        console.log('');
        console.log('#' + entry.id + ' [' + entry.method + '] ' + entry.url);
        console.log('  Status: ' + entry.status + '  Duration: ' + entry.durationMs + 'ms');
        console.log('  Request Headers: ' + JSON.stringify(entry.requestHeaders));
        if (entry.requestBody) console.log('  Request Body: ' + JSON.stringify(entry.requestBody).slice(0, 500));
        console.log('  Response Headers: ' + JSON.stringify(entry.responseHeaders));
        const bodyStr = JSON.stringify(entry.responseBody);
        if (bodyStr && bodyStr.length > 500) {
          console.log('  Response Body (' + bodyStr.length + ' chars): ' + bodyStr.slice(0, 500) + '...');
        } else {
          console.log('  Response Body: ' + bodyStr);
        }
      }
    "
  else
    echo "$response" | bun -e "
      const data = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
      console.log('Traffic: ' + data.total + ' entries (oldest: #' + data.oldestId + ', newest: #' + data.newestId + ')');
      console.log('');
      console.log('ID     Method  Status  Duration  Content-Type                     URL');
      console.log('-'.repeat(120));
      for (const entry of data.entries) {
        const ct = (entry.responseHeaders['content-type'] || entry.responseHeaders['Content-Type'] || '-').slice(0, 32);
        const urlStr = entry.url.length > 60 ? entry.url.slice(0, 57) + '...' : entry.url;
        const bodySize = entry.responseBody
          ? (entry.responseBody._truncated
            ? entry.responseBody._size + 'B (truncated)'
            : JSON.stringify(entry.responseBody).length + 'B')
          : '-';
        const line =
          String(entry.id).padEnd(7) +
          entry.method.padEnd(8) +
          String(entry.status).padEnd(8) +
          (entry.durationMs + 'ms').padEnd(10) +
          ct.padEnd(33) +
          urlStr;
        console.log(line);
      }
    "
  fi

  # Update SINCE for watch mode to avoid re-printing
  if [[ "$WATCH" == "true" ]]; then
    SINCE=$(echo "$response" | bun -e "
      const data = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
      console.log(data.newestId);
    ")
  fi
}

if [[ "$WATCH" == "true" ]]; then
  echo "Watching traffic on port $PORT (every ${INTERVAL}s). Ctrl+C to stop."
  echo ""
  # Show existing traffic first
  fetch_traffic
  # Then poll for new
  while true; do
    sleep "$INTERVAL"
    fetch_traffic
  done
else
  fetch_traffic
fi
