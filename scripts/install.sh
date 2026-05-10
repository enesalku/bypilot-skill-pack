#!/usr/bin/env bash
# install.sh — symlink bypilot into a consuming project's .claude/ directory.
# Usage: install.sh <project-root>
# Default: current cwd if no arg.
#
# Strategy: dev-mode symlinks (not copies). Easy to update bypilot, easy to remove.
# Conflicts with existing skills/agents are detected and skipped (with warning).

set -euo pipefail

BYPILOT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TARGET="${1:-$PWD}"

echo "[bypilot-install] BYPILOT_ROOT = $BYPILOT_ROOT"
echo "[bypilot-install] TARGET      = $TARGET"

[ -d "$TARGET" ] || { echo "[bypilot-install] FAIL: target not found"; exit 1; }
mkdir -p "$TARGET/.claude/skills" "$TARGET/.claude/agents" "$TARGET/.claude/hooks/bypilot"

skipped=0
linked=0

# --- Skills (prefix: bypilot-) ---
for skill_dir in "$BYPILOT_ROOT/skills/"*/; do
  name=$(basename "$skill_dir")
  link="$TARGET/.claude/skills/bypilot-$name"
  if [ -e "$link" ] || [ -L "$link" ]; then
    echo "[bypilot-install] skill skip (exists): bypilot-$name"
    skipped=$((skipped+1))
    continue
  fi
  ln -s "$skill_dir" "$link"
  echo "[bypilot-install] skill link: bypilot-$name → $skill_dir"
  linked=$((linked+1))
done

# --- Agents: only bypilot-unique names; preserve existing test-runner/debugger/implementer ---
# bypilot-unique = anything in agents/ EXCEPT runner/test-runner.md and runner/debugger.md
# (existing project's agents stay as-is)

declare -a AGENT_FILES=(
  "orchestrator/loop-operator.md"
  "orchestrator/wave-picker.md"
  "orchestrator/context-broker.md"
  "orchestrator/checkpoint-gate.md"
  "orchestrator/harness-optimizer.md"
  "planner/interviewer.md"
  "planner/analyst.md"
  "planner/pm.md"
  "planner/architect.md"
  "planner/task-composer.md"
  "planner/researcher.md"
  "implementer/pilot-implementer.md"
  "implementer/coiffure-implementer.md"
  "implementer/api-implementer.md"
  "implementer/e2e-implementer.md"
  "reviewer/security-reviewer.md"
  "learner/observer.md"
)

for agent_path in "${AGENT_FILES[@]}"; do
  src="$BYPILOT_ROOT/agents/$agent_path"
  [ -f "$src" ] || { echo "[bypilot-install] missing source: $agent_path"; continue; }
  base=$(basename "$agent_path")
  link="$TARGET/.claude/agents/$base"
  if [ -e "$link" ] || [ -L "$link" ]; then
    echo "[bypilot-install] agent skip (exists): $base"
    skipped=$((skipped+1))
    continue
  fi
  ln -s "$src" "$link"
  echo "[bypilot-install] agent link: $base"
  linked=$((linked+1))
done

# --- Hooks: don't auto-register; user must enable via settings.json + env var ---
# We just mirror the hook scripts under .claude/hooks/bypilot/ so they're available.
for hook_file in "$BYPILOT_ROOT/hooks/"*.sh "$BYPILOT_ROOT/hooks/"*.js; do
  [ -f "$hook_file" ] || continue
  base=$(basename "$hook_file")
  link="$TARGET/.claude/hooks/bypilot/$base"
  if [ -e "$link" ] || [ -L "$link" ]; then continue; fi
  ln -s "$hook_file" "$link"
done

# --- Schemas + Manifests + Docs (read-only references) ---
ln -sfn "$BYPILOT_ROOT/schemas" "$TARGET/.claude/bypilot-schemas"
ln -sfn "$BYPILOT_ROOT/manifests" "$TARGET/.claude/bypilot-manifests"

cat <<EOF

[bypilot-install] DONE
  ✓ $linked symlinks created
  ⚠ $skipped skipped (already exist — manual review if you want to override)

Next steps:
  1. Run /bypilot-sprint-driver --check    (should list sprints + pending tasks)
  2. Or invoke any bypilot- skill directly
  3. To enable hooks: set BYPILOT_HOOK_PROFILE=full in shell env, then
     add hook entries to .claude/settings.json (see hooks/hooks.json)

To uninstall:
  find .claude -lname '*bypilot-skill-pack*' -delete

EOF
