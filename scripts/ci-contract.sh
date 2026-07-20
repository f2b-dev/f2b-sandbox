#!/usr/bin/env bash
# 契约冒烟：拉起 fake 服务 → smoke / smoke:stream → 鉴权实例 → smoke:auth → 清理
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

PORT="${F2B_CI_PORT:-18787}"
AUTH_PORT="${F2B_CI_AUTH_PORT:-18788}"
BASE="http://127.0.0.1:${PORT}"
AUTH_BASE="http://127.0.0.1:${AUTH_PORT}"
ADMIN_TOKEN="${F2B_ADMIN_TOKEN:-ci-admin-token}"
PIDS=()

cleanup() {
  for pid in "${PIDS[@]:-}"; do
    if kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
    fi
  done
}
trap cleanup EXIT

wait_health() {
  local url="$1" expect_auth="${2:-}"
  for i in $(seq 1 60); do
    if body=$(curl -sf "$url/healthz" 2>/dev/null); then
      if [[ -z "$expect_auth" ]] || echo "$body" | grep -q "\"auth\":\"$expect_auth\""; then
        echo "  ready $url ($body)"
        return 0
      fi
    fi
    sleep 0.25
  done
  echo "timeout waiting for $url" >&2
  return 1
}

echo "== typecheck =="
pnpm typecheck

echo "== start fake (auth=off) :$PORT =="
F2B_SANDBOX_BACKEND=fake \
  F2B_AUTH_MODE=off \
  PORT="$PORT" \
  HOST=127.0.0.1 \
  DATABASE_URL="file:${ROOT}/data/ci-contract.db" \
  pnpm exec tsx src/server.ts &
PIDS+=($!)
wait_health "$BASE" "off"

echo "== smoke =="
F2B_SANDBOX_URL="$BASE" pnpm smoke

echo "== smoke:stream =="
F2B_SANDBOX_URL="$BASE" pnpm smoke:stream

echo "== start fake (auth=api_key) :$AUTH_PORT =="
F2B_SANDBOX_BACKEND=fake \
  F2B_AUTH_MODE=api_key \
  F2B_ADMIN_TOKEN="$ADMIN_TOKEN" \
  PORT="$AUTH_PORT" \
  HOST=127.0.0.1 \
  DATABASE_URL="file:${ROOT}/data/ci-contract-auth.db" \
  pnpm exec tsx src/server.ts &
PIDS+=($!)
wait_health "$AUTH_BASE" "api_key"

echo "== smoke:auth =="
F2B_SANDBOX_URL="$AUTH_BASE" F2B_ADMIN_TOKEN="$ADMIN_TOKEN" pnpm smoke:auth

echo "CONTRACT_CI_OK"
