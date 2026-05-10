#!/usr/bin/env bash
# bypilot-loop.sh — full-auto headless wrapper for /bypilot-sprint-driver.
# Each iteration spawns a FRESH `claude -p` invocation, so the model context
# is empty every loop — no /clear needed, no cache miss surprises within a
# wave. State is persisted via .bypilot/state.json and docs/.bypilot-state.json
# between iterations, so --resume picks up exactly where the previous one left.
#
# Use this only when:
#   - you actually want full-auto (no UI gates, no manual approval)
#   - the active sprint(s) are properly scoped — runaway autonomy can churn
#   - you have the recovery points (recovery-points.mjs) safety net armed
#
# Stop conditions:
#   - exit code 0 from the inner claude AND no pending tasks → SPRINT COMPLETE
#   - exit code != 0 three iterations in a row → HALT (escalate to user)
#   - .bypilot/loop.stop file exists (touch it from another shell to abort)
#   - max-iterations reached (default 50)
#
# Usage:
#   bypilot-loop.sh                      # uses defaults
#   bypilot-loop.sh --max-iterations 20
#   bypilot-loop.sh --inter-iteration-sleep 30
#   bypilot-loop.sh --skill bypilot-sprint-driver
#   BYPILOT_ROOT=/path/to/repo bypilot-loop.sh
#
# Logs land in .bypilot/loop-logs/iter-NN.log. Summary in .bypilot/loop-summary.json.

set -euo pipefail

ROOT="${BYPILOT_ROOT:-$PWD}"
SKILL="bypilot-sprint-driver"
MAX_ITERATIONS=50
INTER_SLEEP=10
MAX_CONSECUTIVE_FAILS=3

while [ $# -gt 0 ]; do
  case "$1" in
    --max-iterations) MAX_ITERATIONS="$2"; shift 2;;
    --inter-iteration-sleep) INTER_SLEEP="$2"; shift 2;;
    --skill) SKILL="$2"; shift 2;;
    --root) ROOT="$2"; shift 2;;
    -h|--help)
      grep '^#' "$0" | head -40 | sed 's/^# //; s/^#//'; exit 0;;
    *) echo "unknown flag: $1" >&2; exit 1;;
  esac
done

cd "$ROOT"

LOG_DIR="$ROOT/.bypilot/loop-logs"
SUMMARY="$ROOT/.bypilot/loop-summary.json"
STOP_FILE="$ROOT/.bypilot/loop.stop"
mkdir -p "$LOG_DIR"

if [ -f "$STOP_FILE" ]; then
  echo "[loop] stop file exists at $STOP_FILE — refusing to start. Remove it first." >&2
  exit 2
fi

if ! command -v claude >/dev/null 2>&1; then
  echo "[loop] FATAL: 'claude' CLI not found in PATH" >&2
  exit 3
fi

iter=0
fails=0
start_ts="$(date -u +%FT%TZ)"

cleanup() {
  echo '[loop] cleanup'
  jq -n --arg start "$start_ts" --arg end "$(date -u +%FT%TZ)" \
        --argjson iter "$iter" --argjson fails "$fails" \
        '{startedAt: $start, endedAt: $end, iterations: $iter, consecutiveFails: $fails}' \
    > "$SUMMARY" 2>/dev/null || true
}
trap cleanup EXIT

while [ "$iter" -lt "$MAX_ITERATIONS" ]; do
  iter=$((iter + 1))
  log="$LOG_DIR/iter-$(printf '%02d' "$iter").log"
  ts="$(date -u +%FT%TZ)"
  echo "[loop] === iter $iter @ $ts ==="

  if [ -f "$STOP_FILE" ]; then
    echo "[loop] stop file appeared, halting at iter $iter"
    break
  fi

  # Decide: --resume if state.json says there's leftover work; otherwise start fresh.
  resume_flag=""
  if [ -f "$ROOT/docs/.bypilot-state.json" ]; then
    pending=$(jq -r '.totals.pending // 0' "$ROOT/docs/.bypilot-state.json" 2>/dev/null || echo 0)
    in_progress=$(jq -r '.totals.in_progress // 0' "$ROOT/docs/.bypilot-state.json" 2>/dev/null || echo 0)
    if [ "$pending" != "0" ] || [ "$in_progress" != "0" ]; then
      resume_flag="--resume"
    elif [ "$iter" -gt 1 ]; then
      echo "[loop] state shows nothing pending → SPRINT COMPLETE"
      break
    fi
  fi

  prompt="/${SKILL}${resume_flag:+ $resume_flag} --auto"
  echo "[loop] prompt: $prompt"
  echo "[loop] log: $log"

  set +e
  claude -p "$prompt" > "$log" 2>&1
  rc=$?
  set -e

  echo "[loop] iter $iter exit=$rc"

  if [ "$rc" -ne 0 ]; then
    fails=$((fails + 1))
    if [ "$fails" -ge "$MAX_CONSECUTIVE_FAILS" ]; then
      echo "[loop] $MAX_CONSECUTIVE_FAILS consecutive non-zero exits — halting" >&2
      tail -40 "$log" >&2 || true
      exit 4
    fi
    echo "[loop] non-zero exit ($fails/$MAX_CONSECUTIVE_FAILS) — sleeping $INTER_SLEEP s before retry"
  else
    fails=0
  fi

  sleep "$INTER_SLEEP"
done

echo "[loop] done after $iter iterations"
