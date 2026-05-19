# MANIFEST

**Package:** `bypilot`
**Version:** `0.2.0-alpha.1`
**Status:** Pre-release. F0 + F1 done. Requirement Lifecycle + Living Contract + Acceptance Gate (F1.5) added 2026-05-14.

## What's Shipping

### F0 (skeleton) — done
- Identity files (SOUL, RULES, CLAUDE, AGENTS, this MANIFEST)
- Directory tree
- Manifests stubs (install-profiles, install-modules, install-components)
- Schemas (tasks, sprints-manifest, instinct)
- LICENSE (MIT)

### F1 (sprint-driver MVP) — done
- `skills/sprint-driver/SKILL.md` + workflows + scripts
- `agents/orchestrator/{loop-operator, wave-picker, context-broker, checkpoint-gate}.md`
- `agents/implementer/{pilot,coiffure,api,e2e}-implementer.md`
- `agents/runner/{test-runner, debugger}.md` (adapted from existing)
- `scripts/wave-picker.mjs` (DAG resolver)
- `scripts/lib/{git-utils, worktree, tasks-loader, port-allocator, bootstrap}.js`

### F1.5 (Requirement Lifecycle + Living Contract + Acceptance Gate) — done 2026-05-14

Closes the "Sprint-9 audio gap" pattern. Three layered defenses against parallel-task feature loss + sprint-end silent acceptance failure.

**Requirements skill (Faz-A — kullanıcı zorunlu interactive)**
- `skills/requirements/SKILL.md` + `/bypilot-requirements` command
- `agents/planner/elicitor.md` — BMAD Advanced-Elicitation menu adaptation
- `schemas/requirements.schema.json` — REQ-N pattern, userOriginalPrompt preserved verbatim

**Living Contract coordination**
- `schemas/tasks.schema.json` extended — `linksRequirement`, `creates.contract`, `subscribes`, `mustIntegrate`, `affects`, `integratedWith`
- `agents/planner/task-composer.md` — requirement traceability invariant + contract single-author rule
- `agents/orchestrator/context-broker.md` — contract injection (Step 5.3-5.8), `waitingForContracts` defer
- `agents/orchestrator/sid-judge.md` (new, Haiku) — wave-end Semantic Intent Divergence detector, 5 drift classes, bounded retry
- `skills/sprint-driver/SKILL.md` — Step 6.7 integratedWith sanity, Step 7 ContractChanged Mailbox broadcast, Step 7.5 SID-judge dispatch

**Acceptance Verification Gate**
- `agents/reviewer/requirements-verifier.md` (new, Opus) — per-REQ PASS/CONCERNS/FAIL/WAIVED
- Vision verify — when `integrations.visionVerify.enabled` + REQ userVisible, Playwright screenshot → multimodal Claude vision
- `skills/sprint-driver/SKILL.md` Step 8.5 — verifier dispatch, bounded retry (1 cycle), 2nd FAIL → halt + human escalation
- `skills/setup/SKILL.md` — `visionVerify` integration template

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
