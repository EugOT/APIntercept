#!/usr/bin/env bash
# Cache API route responses for offline dashboard development.
# Usage: ./scripts/cache-routes.sh [--port 3001] [--domain boardshop]
set -euo pipefail

PORT=3001
DOMAIN=""
CACHE_DIR="tmp/cache"

while [[ $# -gt 0 ]]; do
  case $1 in
    --port) PORT="$2"; shift 2;;
    --domain) DOMAIN="$2"; shift 2;;
    --cache-dir) CACHE_DIR="$2"; shift 2;;
    *) echo "Unknown arg: $1"; exit 1;;
  esac
done

API_BASE="http://localhost:${PORT}"
AUTH_ARGS=()
if [[ -n "${INTERCEPTOR_CONTROL_TOKEN:-}" ]]; then
  AUTH_ARGS=(-H "Authorization: Bearer ${INTERCEPTOR_CONTROL_TOKEN}")
fi

api_get() {
  curl -sf "${AUTH_ARGS[@]}" "$1"
}

if ! api_get "${API_BASE}/api" > /dev/null 2>&1; then
  echo "ERROR: API server not reachable at localhost:${PORT}. Start it first."
  exit 1
fi

ROUTES_JSON=$(api_get "${API_BASE}/api")

if [ -n "$DOMAIN" ]; then
  if ! printf "%s" "$ROUTES_JSON" | DOMAIN="$DOMAIN" bun -e '
    const data = JSON.parse(await Bun.stdin.text());
    const names = data.domains?.map((domain) => domain.name) ?? [];
    process.exit(names.includes(process.env.DOMAIN) ? 0 : 1);
  ' 2>/dev/null; then
    echo "ERROR: Domain '${DOMAIN}' is not registered on localhost:${PORT}."
    printf "Registered domains: "
    printf "%s" "$ROUTES_JSON" | bun -e '
      const data = JSON.parse(await Bun.stdin.text());
      console.log((data.domains?.map((domain) => domain.name) ?? []).join(", "));
    '
    exit 1
  fi
fi

printf "%s" "$ROUTES_JSON" | \
  PORT="$PORT" DOMAIN="$DOMAIN" CACHE_DIR="$CACHE_DIR" INTERCEPTOR_CONTROL_TOKEN="${INTERCEPTOR_CONTROL_TOKEN:-}" bun -e '
const data = JSON.parse(await Bun.stdin.text());
const port = process.env.PORT;
const domainFilter = process.env.DOMAIN;
const cacheDir = process.env.CACHE_DIR;
const token = process.env.INTERCEPTOR_CONTROL_TOKEN;

for (const domain of data.domains ?? []) {
  const name = domain.name ?? "";
  if (domainFilter && name !== domainFilter) continue;

  const domainDir = `${cacheDir}/${name}`;
  await Bun.$`mkdir -p ${domainDir}`.quiet();
  console.log(`Caching ${name}...`);

  for (const route of domain.routes ?? []) {
    const [method, path] = String(route).split(" ", 2);
    if (method !== "GET" || !path) continue;
    if (path.includes(":")) {
      console.log(`  SKIP ${path} (needs params)`);
      continue;
    }

    const cacheName = path.replace(`/api/${name}/`, "").replaceAll("/", "-") || "index";
    let url = `http://localhost:${port}${path}`;
    if (path.includes("search") && !url.includes("?")) url += "?q=test";

    console.log(`  GET ${path} -> ${domainDir}/${cacheName}.json`);
    const response = await fetch(url, {
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    });
    await Bun.write(`${domainDir}/${cacheName}.json`, await response.text());
  }
}

console.log("Done.");
'
