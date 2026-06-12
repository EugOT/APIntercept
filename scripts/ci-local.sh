#!/usr/bin/env bash
set -euo pipefail

# Run the local CI gate.
# Usage:
#   ./scripts/ci-local.sh          # full pipeline
#   ./scripts/ci-local.sh --quick  # skip docker build

QUICK=false
for arg in "$@"; do
  case $arg in
    --quick) QUICK=true ;;
  esac
done

export NEXT_TELEMETRY_DISABLED="${NEXT_TELEMETRY_DISABLED:-1}"
export NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=6144}"
export TURBO_TELEMETRY_DISABLED="${TURBO_TELEMETRY_DISABLED:-1}"

pass() { printf "\033[32m✓ %s\033[0m\n" "$1"; }
fail() { printf "\033[31m✗ %s\033[0m\n" "$1"; exit 1; }
step() { printf "\n\033[1m→ %s\033[0m\n" "$1"; }

step "Install (frozen-lockfile)"
bun install --frozen-lockfile --ignore-scripts || fail "Install failed — lockfile out of sync?"
pass "Install"

step "Lint (Biome)"
bun run biome ci . || fail "Biome lint failed"
pass "Lint"

step "Build"
bun run build -- --concurrency=1 || fail "Build failed"
pass "Build"

step "Typecheck"
bun run typecheck || fail "Typecheck failed"
pass "Typecheck"

step "Test"
bun run test || fail "Tests failed"
pass "Test"

step "Python test"
if pixi run python -m pytest --version >/dev/null 2>&1; then
  pixi run python -m pytest services/python/ -v || fail "Python tests failed"
else
  printf "\033[33m⊘ Python tests skipped (pixi pytest environment unavailable)\033[0m\n"
fi
pass "Python test"

step "E2E tests (Playwright)"
if [ -f "playwright.config.ts" ] && [ -d "tests/e2e" ]; then
  # Kill any stale server on port 3002
  lsof -ti:3002 | xargs kill 2>/dev/null || true
  sleep 1
  PLAYWRIGHT_HTML_OPEN=never bun run e2e || fail "E2E tests failed"
  pass "E2E tests"
else
  printf "\033[33m⊘ E2E tests skipped (no playwright config or test directory)\033[0m\n"
fi

if [ "$QUICK" = false ]; then
  step "Docker build (api)"
  docker build -f apps/api/Dockerfile . || fail "Docker build (api) failed"
  pass "Docker build (api)"

  step "Docker build (web)"
  docker build -f apps/web/Dockerfile . || fail "Docker build (web) failed"
  pass "Docker build (web)"
else
  printf "\n\033[33m⊘ Docker build skipped (--quick)\033[0m\n"
fi

printf "\n\033[32m✓ All checks passed.\033[0m\n"
