#!/usr/bin/env bash
# Screenshot a localhost dashboard page using Patchright.
# Usage: ./scripts/screenshot-dashboard.sh --path /dashboard --width 1280 --output /tmp/screenshot.png
set -euo pipefail

PATH_ARG="/"
WIDTH=1280
HEIGHT=800
OUTPUT="/tmp/screenshot.png"
PORT=3000

while [[ $# -gt 0 ]]; do
  case $1 in
    --path) PATH_ARG="$2"; shift 2;;
    --width) WIDTH="$2"; shift 2;;
    --height) HEIGHT="$2"; shift 2;;
    --output) OUTPUT="$2"; shift 2;;
    --port) PORT="$2"; shift 2;;
    *) echo "Unknown arg: $1"; exit 1;;
  esac
done

bun -e "
const { chromium } = require('patchright');
(async () => {
  const b = await chromium.launch({ headless: true });
  const p = await b.newPage({ viewport: { width: ${WIDTH}, height: ${HEIGHT} } });
  await p.goto('http://localhost:${PORT}${PATH_ARG}', { waitUntil: 'networkidle', timeout: 30000 });
  await p.screenshot({ path: '${OUTPUT}', type: 'png' });
  await b.close();
  console.log('${OUTPUT}');
})().catch(e => { console.error(e.message); process.exit(1); });
"
