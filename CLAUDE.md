# CLAUDE.md

This file guides Claude Code when working **on the bypilot package itself** (not when *using* it in a consuming project).

## What is bypilot

bypilot is a Claude Code skill pack: agents, skills, hooks, scripts, manifests. It targets Claude Code's plugin format. Consumers `git clone` or `gh plugin install` it into `.claude/plugins/bypilot/` (or develop locally pointing at this repo).

## Stack

- **Runtime:** Node.js >=18, CommonJS only (no ESM, no TS in the package — keep zero-build).
- **Hooks:** Bash or Node.js (CommonJS).
- **Tests:** `node tests/run-all.js` (planned).
- **Lint:** ESLint flat config + markdownlint-cli.

## Repo Layout

```
SOUL.md, RULES.md, AGENTS.md, MANIFEST.md  — identity
manifests/                                  — install profiles/modules/components
skills/                                     — canonical workflow surface
agents/                                     — subagent prompts
hooks/                                      — matcher-driven automation
scripts/                                    — install + lib utilities
schemas/                                    — JSON Schemas for tasks.json, instincts, etc.
tests/                                      — unit, integration, evals
docs/                                       — architecture, hook catalog, placement policy
```

## Key Commands (planned)

| Command | Purpose |
|---|---|
| `/bypilot-sprint-driver` | Multi-sprint orchestrator entrypoint |
| `/bypilot-sprint-driver --resume` | Resume from last checkpoint |
| `/bypilot-setup` | One-shot prereq interview |
| `/bypilot-research <goal>` | Open-source feature mining |
| `/bypilot-plan <goal>` | Analyst→PM→architect→task-composer chain |
| `/bypilot-pipeline <goal>` | setup→research→plan→sprint-driver end-to-end |
| `/bypilot-learn` | Mid-session pattern extraction |
| `/bypilot-promote <instinct-id>` | Graduate an instinct to a skill |
| `/bypilot-status` | Show current state, wave, instincts |

## Development Workflow

1. **Plan** — touch SOUL.md / RULES.md only when philosophy changes; otherwise modify a single skill or agent.
2. **TDD-ish** — for scripts, write a fixture under `tests/integration/` first.
3. **Don't break consumers** — bypilot is consumed by ByPilot. Run a smoke test of `/bypilot-sprint-driver` against `bypilot-moduler-pilot`'s `docs/sprint-3/tasks.json` before merging.
4. **Document the why** — every skill SKILL.md ends with "When to Use" so the orchestrator routes correctly.

## Self-Improvement Loop

bypilot uses its own continuous-learning system. When developing the package, observations land in `~/.bypilot/observations/<package-hash>/`. Patterns in editing skills cluster into bypilot-specific instincts (e.g., "when adding a new agent, also update AGENTS.md table"). These promote to bypilot's own skills over time.

## Multi-Harness Note

While the initial target is Claude Code, the on-disk layout mirrors ECC's `.claude/`, `.cursor/`, `.codex/` pattern. Future bypilot can ship to other harnesses by adding adapters under `manifests/harnesses/<name>/`. Don't optimize for this yet; design for Claude Code, leave the door open.
