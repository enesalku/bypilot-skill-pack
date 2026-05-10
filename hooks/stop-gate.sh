#!/usr/bin/env bash
# stop-gate.sh — sprint-driver aktifken kırmızı testlerle Stop'u engeller.
# BYPILOT_HOOK_PROFILE=off ise pasif. SPRINT_DRIVER_GATE=1 ile aktif.

set +e

# Hook gating
case "${BYPILOT_HOOK_PROFILE:-off}" in
  off|"") echo '{}'; exit 0 ;;
  lean|full) ;;
  *) echo '{}'; exit 0 ;;
esac

# Bireysel kapatma kontrolü
if [[ ",${BYPILOT_DISABLED_HOOKS:-}," == *",stop-gate,"* ]]; then
  echo '{}'; exit 0
fi

# Sadece sprint-driver context'inde aktif
if [[ "${SPRINT_DRIVER_GATE:-0}" != "1" ]]; then
  echo '{}'; exit 0
fi

cd "${CLAUDE_PROJECT_DIR:-$PWD}" || exit 0

# Hızlı vitest kontrol — kısa subset
if ! timeout 60 npx vitest run apps/api/server packages/pilot --reporter=basic --silent > /tmp/bp-sg-vitest.log 2>&1; then
  TAIL=$(tail -20 /tmp/bp-sg-vitest.log)
  if command -v jq >/dev/null 2>&1; then
    jq -n --arg tail "$TAIL" \
      '{decision: "block", reason: ("Sprint driver aktif — testler kırmızı, durmaya izin yok. Tail:\n" + $tail)}'
  else
    printf '{"decision":"block","reason":"Sprint driver aktif — testler kırmızı."}\n'
  fi
  exit 0
fi

echo '{}'
