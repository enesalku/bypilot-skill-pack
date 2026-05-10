#!/usr/bin/env bash
# port-allocator.sh — assign unique localhost ports per worktree so parallel test-runners don't clash.
# Usage: port-allocator.sh <worktree-path>
# Writes: <worktree>/.bypilot-ports.json
# Allocates: API_PORT (5555..5599), DEV_PORT (3000..3099), PW_PORT (4000..4099)

set -euo pipefail

WORKTREE="${1:?usage: port-allocator.sh <worktree-path>}"
OUT="$WORKTREE/.bypilot-ports.json"

if [ -f "$OUT" ]; then
  echo "[port-allocator] reusing existing $OUT" >&2
  cat "$OUT"
  exit 0
fi

is_free() {
  ! lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1
}

find_free() {
  local base="$1" max="$2" port
  for port in $(seq "$base" "$max"); do
    if is_free "$port"; then echo "$port"; return 0; fi
  done
  echo "[port-allocator] no free port in $base..$max" >&2
  return 1
}

API_PORT=$(find_free 5555 5599)
DEV_PORT=$(find_free 3000 3099)
PW_PORT=$(find_free 4000 4099)

cat > "$OUT" <<EOF
{
  "API_PORT": $API_PORT,
  "DEV_PORT": $DEV_PORT,
  "PW_PORT": $PW_PORT,
  "allocatedAt": "$(date -u +%FT%TZ)"
}
EOF

# Inject into worktree's .env.test (idempotent — sed replace if present, append otherwise)
ENV_TEST="$WORKTREE/.env.test"
if [ -f "$ENV_TEST" ]; then
  for var in API_PORT DEV_PORT PW_PORT; do
    val=$(grep -E "^${var}=" "$ENV_TEST" | head -1 | cut -d= -f2 || true)
    new=$(eval echo \$$var)
    if [ -z "$val" ]; then
      echo "${var}=${new}" >> "$ENV_TEST"
    elif [ "$val" != "$new" ]; then
      sed -i.bak "s/^${var}=.*/${var}=${new}/" "$ENV_TEST" && rm -f "$ENV_TEST.bak"
    fi
  done
fi

echo "[port-allocator] $WORKTREE → API=$API_PORT DEV=$DEV_PORT PW=$PW_PORT" >&2
cat "$OUT"
