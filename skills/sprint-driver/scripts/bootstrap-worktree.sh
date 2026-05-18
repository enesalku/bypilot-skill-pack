#!/usr/bin/env bash
# bootstrap-worktree.sh — prepare a fresh git worktree for parallel test runs.
# Idempotent: safe to call multiple times.
# Steps: env files, node_modules (--ignore-scripts), .nuxt prep, auth storageState,
#        webkit browser, port allocation, [opt-in: dev server start].
#
# v0.2.1 — Vision verify / e2e canlı koşumları için dev server start
# adımı (Step 7) BYPILOT_BOOTSTRAP_START_DEV=1 ile opt-in.

set -euo pipefail

WORKTREE="${1:?usage: bootstrap-worktree.sh <worktree-path>}"
ROOT="${BYPILOT_ROOT:-$(cd "$(dirname "$0")/../../../.." && pwd)}"  # consuming project root
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

[ -d "$WORKTREE" ] || { echo "[bootstrap] worktree not found: $WORKTREE" >&2; exit 1; }
[ -d "$ROOT" ] || { echo "[bootstrap] consuming project root not found: $ROOT" >&2; exit 1; }

# G4 — guard against running in the wrong checkout when two parent repos
# share the same .git (e.g. moduler vs moduler-pilot symlink). If
# BYPILOT_ROOT was set explicitly and disagrees with the worktree's parent
# git common dir, refuse — silently writing to the wrong repo is the most
# expensive failure mode here.
if [ -n "${BYPILOT_ROOT:-}" ]; then
  EXPECTED_GIT_DIR="$(cd "$ROOT" && git rev-parse --git-common-dir 2>/dev/null || true)"
  ACTUAL_GIT_DIR="$(cd "$WORKTREE" && git rev-parse --git-common-dir 2>/dev/null || true)"
  if [ -n "$EXPECTED_GIT_DIR" ] && [ -n "$ACTUAL_GIT_DIR" ] && \
     [ "$(cd "$ROOT" && cd "$EXPECTED_GIT_DIR" && pwd)" != "$(cd "$WORKTREE" && cd "$ACTUAL_GIT_DIR" && pwd)" ]; then
    echo "[bootstrap] FATAL: worktree git-common-dir != BYPILOT_ROOT git-common-dir" >&2
    echo "[bootstrap]   ROOT=$ROOT (.git=$EXPECTED_GIT_DIR)" >&2
    echo "[bootstrap]   WORKTREE=$WORKTREE (.git=$ACTUAL_GIT_DIR)" >&2
    echo "[bootstrap]   refusing to bootstrap across repo boundaries" >&2
    exit 3
  fi
fi

# Optional: respect the bypilot session lock so a second concurrent driver
# in the same root surfaces fast instead of stomping on shared state.
if [ -f "$ROOT/.bypilot/lock" ]; then
  LOCK_PID="$(grep -o '"pid"[^,}]*' "$ROOT/.bypilot/lock" 2>/dev/null | grep -o '[0-9]*' | head -1 || true)"
  if [ -n "$LOCK_PID" ] && [ "$LOCK_PID" != "$$" ] && [ "$LOCK_PID" != "$PPID" ] && kill -0 "$LOCK_PID" 2>/dev/null; then
    echo "[bootstrap] note: session lock held by PID $LOCK_PID (continuing — bootstrap is per-worktree)" >&2
  fi
fi

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

# 7. (v0.2.1) Dev server start — opt-in via BYPILOT_BOOTSTRAP_START_DEV=1.
#    Vision verify / e2e canlı koşumları için Vite (react) + Nuxt (api)
#    arkaplanda başlatılır. Idempotent: PID dosyası varsa ve süreç hâlâ
#    çalışıyorsa noop. Logları .bypilot-dev/{api,coiffure,app}.log'a yazar.
if [ "${BYPILOT_BOOTSTRAP_START_DEV:-0}" = "1" ]; then
  DEV_DIR="$WORKTREE/.bypilot-dev"
  PID_FILE="$DEV_DIR/dev.pid"
  mkdir -p "$DEV_DIR"

  # Eğer PID hâlâ alive ise, dev server up kabul et.
  if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE" 2>/dev/null)" 2>/dev/null; then
    step "dev server already running (pid $(cat $PID_FILE))"
  else
    # Port'ları .bypilot-ports.json'dan oku.
    API_PORT=$(grep -o '"API_PORT"[^,}]*' "$WORKTREE/.bypilot-ports.json" | grep -o '[0-9]*' | head -1)
    DEV_PORT=$(grep -o '"DEV_PORT"[^,}]*' "$WORKTREE/.bypilot-ports.json" | grep -o '[0-9]*' | head -1)
    step "starting dev server (api=$API_PORT dev=$DEV_PORT)"

    # turbo dev — monorepo köründen, port env'leri export.
    (
      cd "$WORKTREE" && \
      API_PORT="$API_PORT" \
      DEV_PORT="$DEV_PORT" \
      NUXT_PORT="$API_PORT" \
      VITE_PORT="$DEV_PORT" \
      nohup npm run dev > "$DEV_DIR/dev.log" 2>&1 &
      echo $! > "$PID_FILE"
    )

    # Sağlık kontrolü: en fazla 60 sn bekle, /api root'una HTTP iste.
    for i in $(seq 1 60); do
      if curl -fsS -o /dev/null --max-time 1 "http://localhost:$API_PORT/" 2>/dev/null; then
        step "dev server UP (api ready in ${i}s)"
        break
      fi
      sleep 1
    done

    if ! curl -fsS -o /dev/null --max-time 1 "http://localhost:$API_PORT/" 2>/dev/null; then
      echo "[bootstrap] WARN: dev server didn't respond on :$API_PORT in 60s — see $DEV_DIR/dev.log" >&2
    fi
  fi
fi

# 8. Verify
[ -f "$WORKTREE/.env" ] || { echo "[bootstrap] FAIL: .env missing" >&2; exit 2; }
[ -f "$WORKTREE/.env.test" ] || { echo "[bootstrap] FAIL: .env.test missing" >&2; exit 2; }
[ -f "$WORKTREE/.bypilot-ports.json" ] || { echo "[bootstrap] FAIL: ports not allocated" >&2; exit 2; }
[ "$(ls -A "$WORKTREE/node_modules" 2>/dev/null | wc -l | tr -d ' ')" -gt 50 ] || { echo "[bootstrap] FAIL: node_modules sparse" >&2; exit 2; }

echo "[bootstrap] OK $WORKTREE" >&2
