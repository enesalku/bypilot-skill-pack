# MANIFEST

**Package:** `bypilot`
**Version:** `0.1.0-alpha.1`
**Status:** Pre-release. F0 + F1 in progress.

## What's Shipping

### F0 (skeleton) — done
- Identity files (SOUL, RULES, CLAUDE, AGENTS, this MANIFEST)
- Directory tree
- Manifests stubs (install-profiles, install-modules, install-components)
- Schemas (tasks, sprints-manifest, instinct)
- LICENSE (MIT)

### F1 (sprint-driver MVP) — in progress
- `skills/sprint-driver/SKILL.md` + workflows + scripts
- `agents/orchestrator/{loop-operator, wave-picker, context-broker, checkpoint-gate}.md`
- `agents/implementer/{pilot,coiffure,api,e2e}-implementer.md`
- `agents/runner/{test-runner, debugger}.md` (adapted from existing)
- `scripts/wave-picker.mjs` (DAG resolver)
- `scripts/lib/{git-utils, worktree, tasks-loader, port-allocator, bootstrap}.js`

### Not yet shipping (F2-F8 planned)
- Parallel wave executor with port allocation (F2)
- Hook layer with PreToolUse observation, GateGuard, Stop pattern-extract (F3)
- Continuous-learning v2.1: instincts CLI, observer agent, /promote (F4)
- Front-facing checkpoint UX polish (F5)
- harness-optimizer agent (F6)
- Manifest install system with SQLite state (F7)
- Evals (F8)

## Install Profiles (manifests/install-profiles.json)

| Profile | Modules | Use Case |
|---|---|---|
| **minimal** | sprint-driver-core | Just want multi-sprint orchestration, no learning, no extras |
| **core** | sprint-driver-core, runner-core, reviewer-core | Default — orchestration + reviewers |
| **full** | all modules | Continuous learning, dashboard hooks, install system |

## Compatibility

- **Claude Code:** primary target. Tested on `claude-opus-4-7[1m]`.
- **Node.js:** >=18 (CommonJS, no transpile).
- **Cross-harness:** designed for portability (Cursor/Codex/OpenCode adapters planned in F7+).

## License

MIT — see LICENSE.
