#!/usr/bin/env bash
#
# browser-cli — Token-efficient browser control for discovery agents.
#
# Wraps the /browser/mcp/* REST endpoints into single-line commands.
# Each command returns minimal, structured output — no HTML dumps,
# no verbose JSON. Designed for agents that need to interact with
# pages and capture traffic in the fewest tool calls possible.
#
# Usage:
#   ./scripts/browser-cli.sh <command> [args...] [--port PORT]
#
# Commands:
#   status                     Check if browser is connected
#   navigate <url>             Navigate to URL, return snapshot
#   snapshot                   Get accessibility tree (interactive elements)
#   screenshot [path]          Save screenshot to path (default /tmp/screenshot.jpg)
#   click <selector>           Click element by text content or CSS selector
#   click-xy <x> <y>          Click at coordinates
#   scroll [pixels]            Scroll down (default 600px)
#   type <text>                Type into focused element
#   key <key>                  Press keyboard key (Enter, Escape, Tab, etc.)
#   traffic                    Show captured traffic (method, url, status, size)
#   traffic-clear              Clear traffic buffer
#   eval <js>                  Evaluate JavaScript in page context
#   gather <url>               Navigate + wait + snapshot + traffic (compound)
#   interact <selector>        Clear traffic, click element, return new traffic
#   paginate <selector> [max]  Click repeatedly, collect POST responses
#
# Examples:
#   ./scripts/browser-cli.sh navigate "https://example.com" --port 3012
#   ./scripts/browser-cli.sh click "Show more"
#   ./scripts/browser-cli.sh paginate "Show more" 10
#   ./scripts/browser-cli.sh gather "https://example.com/page"

set -euo pipefail

PORT="${INTERCEPTOR_PORT:-3001}"
API=""

# Parse --port from any position
ARGS=()
for arg in "$@"; do
  if [[ "$arg" == --port=* ]]; then
    PORT="${arg#--port=}"
  elif [[ "${prev:-}" == "--port" ]]; then
    PORT="$arg"
    prev=""
    continue
  elif [[ "$arg" == "--port" ]]; then
    prev="$arg"
    continue
  else
    ARGS+=("$arg")
  fi
  prev="$arg"
done
API="http://localhost:${PORT}/browser/mcp"
AUTH_ARGS=()
if [[ -n "${INTERCEPTOR_CONTROL_TOKEN:-}" ]]; then
  AUTH_ARGS=(-H "Authorization: Bearer ${INTERCEPTOR_CONTROL_TOKEN}")
fi

CMD="${ARGS[0]:-help}"

# --- Helper functions ---

api_get() {
  curl -sf "${AUTH_ARGS[@]}" "$API$1" 2>/dev/null
}

api_post() {
  curl -sf "${AUTH_ARGS[@]}" "$API$1" -X POST -H "Content-Type: application/json" -d "$2" 2>/dev/null
}

json_string() {
  printf "%s" "$1" | bun -e 'process.stdout.write(JSON.stringify(await Bun.stdin.text()))'
}

# Accessibility snapshot — structured list of interactive elements
# Uses page.evaluate to build a minimal tree
get_snapshot() {
  api_post "/evaluate" '{"script":"(()=>{const els=[];document.querySelectorAll(\"a[href],button,input,select,textarea,[role=button],[data-action],[onclick]\").forEach((el,i)=>{if(!el.offsetParent&&el.tagName!==\"INPUT\")return;const tag=el.tagName.toLowerCase();const text=(el.textContent||\"\").trim().slice(0,80);const type=el.getAttribute(\"type\")||\"\";const name=el.getAttribute(\"name\")||el.getAttribute(\"id\")||\"\";const href=el.getAttribute(\"href\")||\"\";const role=el.getAttribute(\"role\")||\"\";const action=el.getAttribute(\"data-action\")||\"\";els.push({ref:\"e\"+i,tag,text,type,name,href:href.slice(0,100),role,action})});return els})()"}' \
    | bun -e '
try {
  const d = JSON.parse(await Bun.stdin.text());
  const els = d.result ?? [];
  for (const e of els) {
    const parts = [e.ref, e.tag];
    if (e.text) parts.push(`"${String(e.text).slice(0, 60)}"`);
    if (e.type) parts.push(`type=${e.type}`);
    if (e.name) parts.push(`name=${e.name}`);
    if (e.href) parts.push(`->${String(e.href).slice(0, 60)}`);
    if (e.role) parts.push(`role=${e.role}`);
    if (e.action) parts.push(`action=${e.action}`);
    console.log(parts.join(" "));
  }
  console.log(`--- ${els.length} interactive elements ---`);
} catch {
  console.log("Error parsing snapshot");
}
' 2>/dev/null
}

# Traffic summary — compact one-line-per-entry format
get_traffic() {
  local endpoint="/traffic"
  if [[ "${1:-}" != "" ]]; then
    endpoint="/traffic?since=$1"
  fi
  api_get "$endpoint" | bun -e '
try {
  const d = JSON.parse(await Bun.stdin.text());
  const entries = d.entries ?? [];
  const skip = ["google-analytics", "doubleclick", "facebook", "snapchat", "onetrust", "cookielaw", "sentry", "forter", "riskified"];
  for (const e of entries) {
    const url = String(e.url ?? "").slice(0, 120);
    if (skip.some((item) => url.toLowerCase().includes(item))) continue;
    const method = String(e.method ?? "?").padEnd(4);
    const status = String(e.status ?? "?").padStart(3);
    const ct = String(e.responseHeaders?.["content-type"] ?? "").slice(0, 30).padEnd(30);
    const size = Number(e.responseSize ?? 0);
    const sz = (size < 1024 ? `${size}B` : `${Math.floor(size / 1024)}KB`).padStart(6);
    console.log(`${method} ${status} ${sz} ${ct} ${url}`);
  }
  console.log(`--- ${entries.length} entries ---`);
} catch {
  console.log("Error parsing traffic");
}
' 2>/dev/null
}

# Click by text content or CSS selector
click_element() {
  local selector="$1"
  local selector_json
  selector_json="$(json_string "$selector")"
  # Try clicking by evaluating in the page — find by text first, then CSS
  api_post "/evaluate" "{\"script\":\"(()=>{const s=${selector_json};let el=null;document.querySelectorAll('button,a,[role=button],[data-action]').forEach(e=>{if(e.textContent&&e.textContent.trim().includes(s)&&e.offsetParent)el=el||e});if(!el)el=document.querySelector(s);if(!el)return{error:'Element not found: '+s};el.scrollIntoView({block:'center'});el.click();return{clicked:true,tag:el.tagName,text:(el.textContent||'').trim().slice(0,60)}})()\"}" \
    | bun -e '
try {
  const d = JSON.parse(await Bun.stdin.text()).result ?? {};
  if (d.error) console.log("ERROR:", d.error);
  else console.log(`Clicked ${d.tag ?? "?"}:`, String(d.text ?? "").slice(0, 60));
} catch (error) {
  console.log(`Error: ${error.message}`);
}
' 2>/dev/null
}

# --- Commands ---

case "$CMD" in
  status)
    api_get "/status" | bun -e '
const d = JSON.parse(await Bun.stdin.text());
if (d.connected) console.log(`Connected: ${d.url ?? "?"}`);
else console.log("Not connected");
' 2>/dev/null
    ;;

  navigate)
    url="${ARGS[1]:-}"
    [[ -z "$url" ]] && echo "Usage: browser-cli.sh navigate <url>" && exit 1
    url_json="$(json_string "$url")"
    api_post "/navigate" "{\"url\":${url_json}}" | bun -e 'const d = JSON.parse(await Bun.stdin.text()); console.log("Navigated to:", d.url ?? "?")' 2>/dev/null
    sleep 3
    echo ""
    get_snapshot
    ;;

  snapshot)
    get_snapshot
    ;;

  screenshot)
    path="${ARGS[1]:-/tmp/screenshot.jpg}"
    api_post "/screenshot" '{"quality":60}' | SCREENSHOT_PATH="$path" bun -e '
const d = JSON.parse(await Bun.stdin.text());
const img = Buffer.from(d.data, "base64");
await Bun.write(process.env.SCREENSHOT_PATH, img);
console.log(`Screenshot saved: ${process.env.SCREENSHOT_PATH} (${Math.floor(img.length / 1024)}KB)`);
' 2>/dev/null
    ;;

  click)
    selector="${ARGS[1]:-}"
    [[ -z "$selector" ]] && echo "Usage: browser-cli.sh click <selector>" && exit 1
    click_element "$selector"
    ;;

  click-xy)
    x="${ARGS[1]:-}"
    y="${ARGS[2]:-}"
    [[ -z "$x" || -z "$y" ]] && echo "Usage: browser-cli.sh click-xy <x> <y>" && exit 1
    api_post "/click" "{\"x\":$x,\"y\":$y}" >/dev/null
    echo "Clicked ($x, $y)"
    ;;

  scroll)
    pixels="${ARGS[1]:-600}"
    api_post "/scroll" "{\"x\":512,\"y\":288,\"deltaY\":$pixels}" >/dev/null
    echo "Scrolled ${pixels}px"
    ;;

  type)
    text="${ARGS[1]:-}"
    [[ -z "$text" ]] && echo "Usage: browser-cli.sh type <text>" && exit 1
    text_json="$(json_string "$text")"
    api_post "/type" "{\"text\":${text_json}}" >/dev/null
    echo "Typed: $text"
    ;;

  key)
    key="${ARGS[1]:-}"
    [[ -z "$key" ]] && echo "Usage: browser-cli.sh key <key>" && exit 1
    api_post "/key" "{\"key\":\"$key\"}" >/dev/null
    echo "Pressed: $key"
    ;;

  traffic)
    get_traffic "${ARGS[1]:-}"
    ;;

  traffic-clear)
    api_post "/traffic/clear" '{}' >/dev/null
    echo "Traffic cleared"
    ;;

  eval)
    script="${ARGS[1]:-}"
    [[ -z "$script" ]] && echo "Usage: browser-cli.sh eval <js>" && exit 1
    script_json="$(json_string "$script")"
    api_post "/evaluate" "{\"script\":${script_json}}" \
      | bun -e '
const r = JSON.parse(await Bun.stdin.text()).result;
console.log(typeof r === "object" ? JSON.stringify(r, null, 2) : String(r));
' 2>/dev/null
    ;;

  # --- Compound commands ---

  gather)
    url="${ARGS[1]:-}"
    [[ -z "$url" ]] && echo "Usage: browser-cli.sh gather <url>" && exit 1
    # Clear traffic, navigate, wait, return snapshot + traffic
    api_post "/traffic/clear" '{}' >/dev/null
    api_post "/navigate" "{\"url\":\"$url\"}" >/dev/null
    echo "Navigating to: $url"
    sleep 5
    echo ""
    echo "=== Interactive Elements ==="
    get_snapshot
    echo ""
    echo "=== Traffic ==="
    get_traffic
    ;;

  interact)
    selector="${ARGS[1]:-}"
    [[ -z "$selector" ]] && echo "Usage: browser-cli.sh interact <selector>" && exit 1
    # Clear traffic, click, wait, return new traffic
    api_post "/traffic/clear" '{}' >/dev/null
    click_element "$selector"
    sleep 3
    echo ""
    echo "=== New Traffic ==="
    get_traffic
    ;;

  paginate)
    selector="${ARGS[1]:-}"
    max_clicks="${ARGS[2]:-20}"
    [[ -z "$selector" ]] && echo "Usage: browser-cli.sh paginate <selector> [max_clicks]" && exit 1
    echo "Paginating: clicking \"$selector\" up to $max_clicks times"
    api_post "/traffic/clear" '{}' >/dev/null
    clicks=0
    while [[ $clicks -lt $max_clicks ]]; do
      # Try to click the element
      result=$(click_element "$selector" 2>&1)
      if echo "$result" | grep -q "ERROR"; then
        echo "No more \"$selector\" button — done after $clicks clicks."
        break
      fi
      clicks=$((clicks + 1))
      echo "Click #$clicks: $result"
      sleep 2
    done
    echo ""
    echo "=== Captured Traffic ==="
    get_traffic
    ;;

  help|*)
    echo "browser-cli — Token-efficient browser control for discovery agents"
    echo ""
    echo "Usage: ./scripts/browser-cli.sh <command> [args...] [--port PORT]"
    echo ""
    echo "Atomic commands:"
    echo "  status                     Check browser connection"
    echo "  navigate <url>             Navigate + return snapshot"
    echo "  snapshot                   Accessibility tree (interactive elements)"
    echo "  screenshot [path]          Save screenshot"
    echo "  click <text|selector>      Click by text or CSS selector"
    echo "  click-xy <x> <y>          Click at coordinates"
    echo "  scroll [pixels]            Scroll down"
    echo "  type <text>                Type text"
    echo "  key <key>                  Press key"
    echo "  traffic [since]            Show captured traffic"
    echo "  traffic-clear              Clear traffic buffer"
    echo "  eval <js>                  Run JavaScript"
    echo ""
    echo "Compound commands:"
    echo "  gather <url>               Navigate + snapshot + traffic"
    echo "  interact <text|selector>   Click + capture new traffic"
    echo "  paginate <text> [max]      Click repeatedly, collect responses"
    echo ""
    echo "Environment: INTERCEPTOR_PORT (default 3001)"
    ;;
esac
