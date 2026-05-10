# bypilot

> Self-improving multi-sprint orchestrator skill pack for Claude Code.

bypilot turns sprint workflows into a DAG. It picks the largest parallelizable wave of pending tasks, fans out into git-worktree-isolated implementers, runs tests, debugs failures, and shows you a checkpoint after each wave. It learns from every session.

Inspired by [ECC](https://github.com/affaan-m/everything-claude-code), [BMAD-METHOD](https://github.com/bmad-code-org/BMAD-METHOD), and [anthropics/skills](https://github.com/anthropics/skills). Built for ByPilot's monorepo cadence.

## Status

**Pre-release.** F0 + F1 in progress. Not for general use yet.

## Quick Sketch

```bash
# In a project with docs/sprint-*/tasks.json:
/bypilot run

# bypilot picks the next runnable wave and goes:
#   pre-flight → wave-picker → context-broker → 3× implementer (parallel)
#                          → bootstrap × 3 → test-runner × 3
#                          → debugger (if red) → state commit → checkpoint UI
# Loop until all pending tasks are done or a human step is required.
```

## Architecture

See `SOUL.md` for the philosophy, `AGENTS.md` for the routing table, and `docs/ARCHITECTURE.md` for the design.

## Install (planned)

```bash
gh plugin install bypilotai/bypilot-skill-pack
```

Or, while developing:

```bash
git clone https://github.com/bypilotai/bypilot-skill-pack ~/.claude/plugins/bypilot
```

## License

MIT
