# bypilot — Agent Catalog

This is the routing table. The orchestrator consults this to decide which subagent to invoke at each phase. New agents land here in the same PR that adds their `.md` file.

## Core Principles

1. **Agent-first** — Delegate to a specialist before doing work in the main loop.
2. **Plan before execute** — Always invoke a planner-style agent (wave-picker, context-broker, planner) before mutation.
3. **Test-driven via firewalls** — Implementer writes, test-runner runs, debugger fixes. The roles never overlap.
4. **Immutability** — Append-only logs, atomic state files, single-direction status transitions.
5. **Self-improving** — Background observer learns from every session; promotion is explicit.

## Orchestrator Lane

| Agent | Purpose | When to Use | Model |
|---|---|---|---|
| **loop-operator** | Decides keep-going vs pause vs escalate per wave | Top of every wave | opus |
| **wave-picker** | Resolves DAG, picks the next runnable parallel wave | Start of each iteration | haiku |
| **context-broker** | Builds neighborhood context per task before implementer spawn | Before each implementer Agent call | haiku |
| **checkpoint-gate** | Renders the front-facing checkpoint markdown block | After each wave commits | haiku |
| **harness-optimizer** | Reads telemetry, suggests skill/agent updates as patches | At sprint end (retrospective) | opus |

## Planner Lane (BMAD-inspired)

This lane runs *before* the orchestrator. It generates sprints from a high-level intent or a research memo, with detailed dependencies. Each agent has an interactive mode (asks the user) and an `--auto` mode (AI decides for the broader ByPilot product).

| Agent | Purpose | When to Use | Model |
|---|---|---|---|
| **interviewer** | Setup interview: keys, accounts, fixtures, env. Asks once, asks all at once, never piecemeal | First time on a new project, or when a missing prereq surfaces | haiku |
| **researcher** | Open-source feature mining. Fetches inspiration repos, extracts candidate features with cost/value notes | Start of a major initiative, or when planner needs more candidates | opus |
| **analyst** | Market/product framing. Turns intent → opportunity brief (jobs-to-be-done, segments, constraints) | Step 1 of `/bypilot-plan` | opus |
| **pm** | PRD synthesizer. Turns brief + research → epics, user stories, acceptance criteria | Step 2 of `/bypilot-plan` | opus |
| **architect** | Tech design. Turns PRD → component map, schema deltas, RBAC notes, observable risks | Step 3 of `/bypilot-plan` | opus |
| **task-composer** | DAG builder. Turns architect output → `docs/sprint-X/tasks.json` with `dependsOn`, `conflictsWith`, `testDepth`, `scope`, `files` | Step 4 of `/bypilot-plan` | opus |

## Implementer Lane

| Agent | Purpose | When to Use | Model |
|---|---|---|---|
| **pilot-implementer** | ByPilot Pilot package (`packages/pilot`, `apps/api/.../pilot/*`) | Tasks targeting Pilot tools, prompt, registry | opus |
| **coiffure-implementer** | ByPilot Coiffure UI (`apps/coiffure`, shared pages) | Tasks targeting Coiffure UI / Knowledge Base / sidebar | opus |
| **api-implementer** | Generic API endpoints, Drizzle, RLS, migrations | Backend tasks not Pilot-specific | opus |
| **e2e-implementer** | Playwright specs, page objects, fixtures, mock servers | Tasks under `e2e/` | opus |

## Reviewer Lane

| Agent | Purpose | When to Use | Model |
|---|---|---|---|
| **pilot-reviewer** | Pilot tool registry, autonomy rules, RBAC | After pilot-implementer commit | opus |
| **api-reviewer** | Drizzle schema, RLS, Zod validation, rate limit | After api-implementer commit | opus |
| **frontend-reviewer** | React/Coiffure UI, i18n, accessibility | After coiffure-implementer commit | opus |
| **security-reviewer** | OWASP, secrets, input validation, RLS bypasses | Before any commit touching auth, RLS, or external surface | opus |

## Runner Lane

| Agent | Purpose | When to Use | Model |
|---|---|---|---|
| **test-runner** | Vitest + tsc + Playwright in worktree (host-first, Docker fallback) | After every implementer commit | haiku |
| **debugger** | Test-failure → root cause → minimal fix (max 3 passes) | When test-runner reports `ok: false` | opus |

## Learner Lane

| Agent | Purpose | When to Use | Model |
|---|---|---|---|
| **observer** | Background pattern extraction from observations.jsonl | Stop hook (async) | haiku |

## Routing Heuristics

The orchestrator consults task fields to pick the implementer:
- `task.scope: pilot` → pilot-implementer
- `task.scope: coiffure` → coiffure-implementer
- `task.scope: api` → api-implementer
- `task.scope: e2e` → e2e-implementer
- `task.scope: shared` → pilot-implementer (default for shared/packages/pilot)

A task touching multiple scopes runs the **most specific** implementer for the dominant scope; the context-broker brief warns about cross-scope file overlap.

## Inter-Agent Contract

Agents communicate **via JSON return values only**. No shared mutable state. The orchestrator threads:

```
wave-picker → { wave: [...taskIds] }
              ↓
context-broker(taskId) → { neighborhood: "## Recent decisions ...\n..." }
              ↓
implementer(task, neighborhood) → { status, worktreePath, commitHash, summary, filesChanged }
              ↓
test-runner(worktreePath) → { ok, vitest, tsc, playwright, durations }
              ↓
debugger(worktreePath, failureLog) → { fixed, rootCause, commitHash, escalate }
```

Every step is atomic. Failures bubble up to loop-operator which decides next move.
