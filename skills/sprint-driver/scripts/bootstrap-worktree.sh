#!/usr/bin/env bash
# bootstrap-worktree.sh — prepare a fresh git worktree for parallel test runs.
# Idempotent: safe to call multiple times.
# Steps: env files, node_modules (--ignore-scripts), .nuxt prep, auth storageState,
#        webkit browser, port allocation.

set -euo pipefail

WORKTREE="${1:?usage: bootstrap-worktree.sh <worktree-path>}"
ROOT="${BYPILOT_ROOT:-$(cd "$(dirname "$0")/../../../.." && pwd)}"  # consuming project root
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

[ -d "$WORKTREE" ] || { echo "[bootstrap] worktree not found: $WORKTREE" >&2; exit 1; }
[ -d "$ROOT" ] || { echo "[bootstrap] consuming project root not found: $ROOT" >&2; exit 1; }

cd "$WORKTREE"

step() { echo "[bootstrap] $*" >&2; }

# 1. Env files (gitignored — manual copy from main checkout)
for env_file in .env .env.test; do
  if [ -f "$ROOT/$env_file" ] && [ ! -f "$WORKTREE/$env_file" ]; then
    cp "$ROOT/$env_file" "$WORKTREE/$env_file"
    step "copied $env_file"
  fi
done

# Per-app envs (ByPilot specifics — guard with existence check)
for app_env in apps/api/.env apps/coiffure/.env apps/app/.env; do
  if [ -f "$ROOT/$app_env" ] && [ ! -f "$WORKTREE/$app_env" ]; then
    mkdir -p "$WORKTREE/$(dirname $app_env)"
    cp "$ROOT/$app_env" "$WORKTREE/$app_env"
    step "copied $app_env"
  fi
done

# 2. node_modules — bypass NuxtHub postinstall (it requires DB connection)
NM_COUNT=$(ls -A "$WORKTREE/node_modules" 2>/dev/null | wc -l | tr -d ' ')
if [ "$NM_COUNT" -lt 50 ]; then
  step "installing node_modules (--ignore-scripts)"
  cd "$WORKTREE" && npm install --ignore-scripts --no-audit --no-fund --prefer-offline 2>&1 | tail -5
fi

# 3. .nuxt artifacts — vitest needs apps/api/.nuxt/tsconfig.app.json
if [ -d "$WORKTREE/apps/api" ] && [ ! -f "$WORKTREE/apps/api/.nuxt/tsconfig.app.json" ]; then
  step "running nuxi prepare"
  (cd "$WORKTREE/apps/api" && npx --yes nuxi prepare) 2>&1 | tail -3
fi

# 4. Cached auth storageState (skip auth.setup if available)
if [ -f "$ROOT/e2e/.auth/user.json" ] && [ ! -f "$WORKTREE/e2e/.auth/user.json" ]; then
  mkdir -p "$WORKTREE/e2e/.auth"
  cp "$ROOT/e2e/.auth/user.json" "$WORKTREE/e2e/.auth/user.json"
  step "copied auth storageState"
fi

# 5. Webkit (mobile project requires it)
if ! ls "$HOME/Library/Caches/ms-playwright/webkit-"* >/dev/null 2>&1; then
  step "installing webkit browser"
  (cd "$WORKTREE" && npx playwright install webkit) 2>&1 | tail -3
fi

# 6. Port allocation
bash "$SCRIPT_DIR/port-allocator.sh" "$WORKTREE" >/dev/null

# 7. Verify
[ -f "$WORKTREE/.env" ] || { echo "[bootstrap] FAIL: .env missing" >&2; exit 2; }
[ -f "$WORKTREE/.env.test" ] || { echo "[bootstrap] FAIL: .env.test missing" >&2; exit 2; }
[ -f "$WORKTREE/.bypilot-ports.json" ] || { echo "[bootstrap] FAIL: ports not allocated" >&2; exit 2; }
[ "$(ls -A "$WORKTREE/node_modules" 2>/dev/null | wc -l | tr -d ' ')" -gt 50 ] || { echo "[bootstrap] FAIL: node_modules sparse" >&2; exit 2; }

echo "[bootstrap] OK $WORKTREE" >&2
