# bypilot — Architecture

> Sprint orchestrator + planner + research + continuous-learning paketi. Felsefe: SOUL.md. Routing: AGENTS.md. Bu dosya: bileşenler nasıl bir arada çalışıyor.

## High-level pipeline

```
USER intent
  │
  ▼
┌─────────────┐    ┌──────────────┐    ┌─────────────┐    ┌──────────┐
│ /bypilot    │ →  │ /bypilot     │ →  │ /bypilot    │ →  │ /bypilot │
│ setup       │    │ research     │    │ plan        │    │ run      │
└─────────────┘    └──────────────┘    └─────────────┘    └──────────┘
  prereq             open-source         analyst→PM         wave loop
  interview          feature mining      →architect         (this paper)
                                         →task-composer
  ┌─────────────────────────────────────────────────────────┐
  │ (auto/intearctive at every step; --auto for AI-decides) │
  └─────────────────────────────────────────────────────────┘

  └──→ /bypilot pipeline = 4'lü zinciri tek komutta sırayla koşturur
```

## Sprint-driver wave loop (the heart)

```
                    ┌─→ pre-flight (file checks, setup state)
                    │
                    ▼
                 Wave-Picker (DAG resolver, file-overlap conflict, critical-path priority)
                    │
                    │ wave = [task-a, task-b, task-c]   (≤ maxParallel)
                    ▼
                 Context-Broker × N (parallel, Haiku)
                    │
                    │ neighborhood = "## Recent decisions...\n## In-flight...\n## Downstream..."
                    ▼
                 Implementer × N (parallel, Opus, isolation:worktree)
                    │
                    │ {status, worktreePath, commitHash, summary}
                    ▼
                 Bootstrap × N (sequential, disk I/O)
                    │
                    │ env files, node_modules --ignore-scripts, nuxi prepare, ports allocated
                    ▼
                 Test-Runner × N (parallel, Haiku, port-isolated)
                    │
                    │ {ok, vitest, tsc, playwright, durations}
                    ▼
                 Debugger (sequential per red task, Opus, max 3 attempts)
                    │
                    │ {fixed, rootCause, escalate}
                    ▼
                 Atomic State Commit (tasks.json, decisions.log, .bypilot-state.json)
                    │
                    ▼
                 Loop-Operator decides: continue / checkpoint / halt / escalate
                    │
                    ▼
                 Checkpoint-Gate renders the user-facing block
                    │
                    └─→ next wave (if any) or final retro
```

## File layout

See README.md for the directory tree. Quick reference:

| Path | Purpose |
|---|---|
| `SOUL.md`, `RULES.md`, `AGENTS.md` | Identity + routing |
| `skills/<name>/SKILL.md` | User-facing workflow definition |
| `agents/<lane>/<name>.md` | Subagent prompt + contract |
| `hooks/hooks.json` + `hooks/*.{sh,js}` | Lifecycle automation |
| `scripts/lib/*.js` | Shared utilities (CommonJS) |
| `manifests/install-*.json` | Selective install configuration |
| `schemas/*.schema.json` | JSON Schema for tasks, manifest, instinct |

## Hook gating

All hooks honor:
- `BYPILOT_HOOK_PROFILE` ∈ {off, lean, full} — granularity
- `BYPILOT_DISABLED_HOOKS` — comma-separated hook IDs to disable

Set `BYPILOT_HOOK_PROFILE=full` only when running bypilot pipelines (continuous learning observation is heavy).

## Continuous learning v2.1

```
Every PreToolUse → ~/.bypilot/observations/<project-hash>/<date>.jsonl  [sanitized]
Stop hook (async) → observer agent clusters into instincts
   → ~/.bypilot/instincts/<project-hash>/personal/<id>.json  [confidence-weighted]
   → registry sees instinct in 2+ projects → eligible for global scope
   → /bypilot promote <id> → graduates to skill (manual confirm)
```

## Self-improvement loop

Sprint end:
1. harness-optimizer reads telemetry
2. Suggests skill/agent patches (`skills/.bypilot-suggestions/sprint-N-*.patch`)
3. User reviews + `--apply <id>` per patch
4. Applied patches commit with `feat(bypilot/...)` scope

Never auto-applied.

## Multi-sprint

```
docs/sprints.manifest.json
  ↳ active: ["sprint-3", "sprint-4"]
  ↳ maxParallel: 3
  ↳ checkpointEvery: 5

docs/sprint-3/tasks.json   (DAG-aware schema)
docs/sprint-4/tasks.json
docs/CONTEXT.md            (cross-sprint memory)
docs/decisions.log         (append-only summaries)
docs/.bypilot-state.json   (resume state)
```

Wave-picker merges all active sprints into a global DAG. Tasks across sprints can depend on each other (sprint-4/foo dependsOn sprint-3/bar). DAG cycle detection is global.

## Install

```bash
bypilot install --profile full
# Reads manifests, picks modules, copies skills + agents + hooks to ~/.claude/plugins/bypilot/.
```

`bypilot install --components ...` for granular selection.

## Ports & worktrees

Every implementer gets its own git worktree (Claude Code `isolation: "worktree"`). bootstrap-worktree.sh prepares it idempotently. port-allocator.sh assigns API_PORT / DEV_PORT / PW_PORT in 5555..5599 / 3000..3099 / 4000..4099 ranges. Worktree's `.env.test` is rewritten with these ports.

Cleanup on push: `session-end-cleanup.sh` detects branches that exist on `origin` and removes the corresponding worktree. Unpushed work is never auto-cleaned.

## Front-facing UX

Three layers:

1. **TaskList** (always on) — Claude Code's native progress display
2. **Structured markdown block** (every wave, every checkpoint) — checkpoint-gate agent renders
3. **(Future) Tkinter dashboard** — opt-in, polls state files, ECC ilhamı

## Open questions / TODO (F2+)

- Reviewer agents (pilot-reviewer, api-reviewer, frontend-reviewer) — only security-reviewer present
- harness-optimizer's patch application path — currently writes to `.bypilot-suggestions/`, full apply flow TBD
- pre-edit-gateguard hook implementation — only registry entry, no script yet
- governance-capture, mcp-health-check hooks — registry placeholder
- bypilot-dash.py Tkinter dashboard — design only, not built
- evals/evals.json — BMAD-style eval patterns for bypilot's own skills
