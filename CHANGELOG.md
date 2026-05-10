# Changelog

## [0.1.0-alpha.1] — 2026-05-10

### Added — F0 + F1 partial

**Identity & policy**
- `SOUL.md` — 7 core principles, end-to-end pipeline philosophy
- `RULES.md` — Must always / must never / commit & hook formats
- `AGENTS.md` — full agent catalog with 3 lanes (orchestrator, planner, runner) + 5 sub-roles
- `CLAUDE.md` — guidance for working *on* the package
- `MANIFEST.md` — release plan, F0–F8 phases
- `LICENSE` (MIT), `package.json`, `.gitignore`, `README.md`

**Skills (canonical surface)**
- `skills/sprint-driver/SKILL.md` — multi-sprint DAG orchestrator
- `skills/setup/SKILL.md` — one-shot prerequisite interview
- `skills/research/SKILL.md` — open-source feature mining (BMAD-inspired)
- `skills/plan/SKILL.md` — analyst → PM → architect → task-composer chain
- `skills/pipeline/SKILL.md` — runs setup → research → plan → run end-to-end

**Agents**
- Orchestrator: `loop-operator`, `wave-picker`, `context-broker`, `checkpoint-gate`, `harness-optimizer`
- Planner: `interviewer`, `analyst`, `pm`, `architect`, `task-composer`, `researcher`
- Implementer: `pilot-implementer`, `coiffure-implementer`, `api-implementer`, `e2e-implementer`
- Runner: `test-runner`, `debugger`
- Reviewer: `security-reviewer`
- Learner: `observer`

**Scripts**
- `skills/sprint-driver/scripts/wave-picker.mjs` — DAG resolver, cycle detection, critical-path priority, file-overlap conflict, parallel wave selection
- `skills/sprint-driver/scripts/port-allocator.sh` — API/DEV/PW port assignment
- `skills/sprint-driver/scripts/bootstrap-worktree.sh` — env, node_modules, .nuxt, webkit, storageState, port

**Hooks**
- `hooks/hooks.json` — registry (SessionStart, PreToolUse, PostToolUse, PreCompact, Stop, SessionEnd)
- `hooks/stop-gate.sh` — sprint-driver gate (red-test stop block)
- `hooks/pre-tool-observe.js` — 100% observation with secret sanitization

**Schemas & Manifests**
- `schemas/tasks.schema.json` — DAG fields (dependsOn, conflictsWith, scope, testDepth, prerequisitesNeeded)
- `schemas/sprints-manifest.schema.json`
- `schemas/instinct.schema.json` — continuous-learning v2.1 format
- `manifests/install-profiles.json` — minimal/core/full
- `manifests/install-modules.json` — 9 modules
- `manifests/install-components.json` — granular skill/agent/hook selection

**Docs**
- `docs/ARCHITECTURE.md` — component map + hook gating + ports + worktrees + multi-sprint

### Inspired by

- [Everything Claude Code (ECC)](https://github.com/affaan-m/everything-claude-code) — agent catalog, hook-based 100% observation, continuous-learning v2.1, GateGuard, manifest selective install
- [BMAD-METHOD](https://github.com/bmad-code-org/BMAD-METHOD) — analyst→PM→architect persona chain, Party Mode parallel multi-agent, workflow-as-markdown, customize.toml hierarchical override
- [anthropics/skills](https://github.com/anthropics/skills) — SKILL.md + scripts/ pattern, official frontmatter format
- [anthropics/claude-code](https://github.com/anthropics/claude-code) — marketplace plugin layout

### Not yet shipping (F2-F8)

See MANIFEST.md "Not yet shipping" section.

### Known limitations

- Implementer/reviewer agents are partial (only `security-reviewer` shipped; `pilot-reviewer` etc. TODO).
- Hook scripts: only `stop-gate.sh` and `pre-tool-observe.js` shipped; other hooks have registry entries only.
- `harness-optimizer` agent design done; patch-application flow TODO.
- Tkinter dashboard NOT shipped (design-only).
- BYPILOT_DOCS_DIR env var not yet honored by wave-picker.mjs.
- Zero tests in `tests/` yet.
