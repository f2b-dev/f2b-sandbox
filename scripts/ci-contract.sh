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

echo "== smoke:templates =="
F2B_SANDBOX_URL="$BASE" pnpm smoke:templates

echo "== smoke:pause =="
F2B_SANDBOX_URL="$BASE" pnpm smoke:pause

echo "== smoke:meta =="
F2B_SANDBOX_URL="$BASE" pnpm smoke:meta
echo "== smoke:files-delete =="
F2B_SANDBOX_URL="$BASE" pnpm smoke:files-delete
echo "== smoke:files-mkdir-rename =="
F2B_SANDBOX_URL="$BASE" pnpm smoke:files-mkdir-rename
echo "== smoke:list-filter =="
F2B_SANDBOX_URL="$BASE" pnpm smoke:list-filter

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

# 避开本机常见占用（如 18789 被其它本地服务占用）
CAP_PORT="${F2B_CI_CAP_PORT:-19789}"
echo "== start fake (max concurrent=1) :$CAP_PORT =="
F2B_SANDBOX_BACKEND=fake \
  F2B_AUTH_MODE=off \
  F2B_MAX_CONCURRENT_SANDBOXES=1 \
  PORT="$CAP_PORT" \
  HOST=127.0.0.1 \
  DATABASE_URL="file:${ROOT}/data/ci-contract-cap.db" \
  pnpm exec tsx src/server.ts &
PIDS+=($!)
wait_health "http://127.0.0.1:${CAP_PORT}" "off"

echo "== smoke:capacity =="
F2B_SANDBOX_URL="http://127.0.0.1:${CAP_PORT}" pnpm smoke:capacity

echo "== smoke:usage =="
F2B_SANDBOX_URL="http://127.0.0.1:${CAP_PORT}" pnpm smoke:usage

TO_PORT="${F2B_CI_TIMEOUT_PORT:-19790}"
echo "== start fake (reaper 500ms) :$TO_PORT =="
F2B_SANDBOX_BACKEND=fake \
  F2B_AUTH_MODE=off \
  F2B_TIMEOUT_REAPER_MS=500 \
  PORT="$TO_PORT" \
  HOST=127.0.0.1 \
  DATABASE_URL="file:${ROOT}/data/ci-contract-timeout.db" \
  pnpm exec tsx src/server.ts &
PIDS+=($!)
wait_health "http://127.0.0.1:${TO_PORT}" "off"

echo "== smoke:timeout =="
F2B_SANDBOX_URL="http://127.0.0.1:${TO_PORT}" pnpm smoke:timeout

CUBE_PORT="${F2B_CI_CUBE_PORT:-18991}"
ENVD_PORT="${F2B_CI_ENVD_PORT:-18992}"

echo "== start mock CubeAPI + envd :$CUBE_PORT / :$ENVD_PORT =="
F2B_MOCK_CUBE_PORT="$CUBE_PORT" \
  F2B_MOCK_ENVD_PORT="$ENVD_PORT" \
  F2B_MOCK_HOST=127.0.0.1 \
  pnpm exec tsx scripts/mock-cube-envd.ts &
PIDS+=($!)

for i in $(seq 1 40); do
  if curl -sf "http://127.0.0.1:${CUBE_PORT}/health" >/dev/null 2>&1; then
    echo "  mock cube ready"
    break
  fi
  if [[ "$i" -eq 40 ]]; then
    echo "timeout waiting for mock cube" >&2
    exit 1
  fi
  sleep 0.25
done

echo "== smoke:cube (adapter + envd protocol) =="
F2B_CUBE_API_URL="http://127.0.0.1:${CUBE_PORT}" \
  F2B_CUBE_ENVD_BASE_URL="http://127.0.0.1:${ENVD_PORT}" \
  F2B_CUBE_API_TOKEN=mock-ci \
  pnpm smoke:cube

echo "CONTRACT_CI_OK"
