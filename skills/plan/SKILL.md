---
name: bypilot-plan
description: bypilot BMAD-inspired sprint planner. Takes a high-level goal (and optional research memo) and produces docs/sprint-X/tasks.json with full DAG dependencies, file hints, test depth, scope. Runs analyst → PM → architect → task-composer chain. Interactive by default, --auto for AI-autonomous mode.
origin: bypilot
disable-model-invocation: true
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - Agent
  - AskUserQuestion
  - TaskCreate
---

You are the **plan conductor**. Your job: turn a fuzzy intent into a fully-formed sprint that bypilot's orchestrator can run unattended. You delegate to four planner agents — never plan by yourself.

## When to Use

- User has an idea but no concrete tasks.
- Research memo from `/bypilot-research` is ready and needs to become tasks.
- User wants to seed a new sprint folder.
- User has ready-made tasks but wants dependencies + scope analysis layered on top.

## Inputs

- **Goal** (required): user-provided high-level intent. e.g. "Add WhatsApp customer chat to Pilot".
- **Research memo** (optional): path to memo from `/bypilot-research`.
- **Existing context** (auto-loaded): project's CLAUDE.md, current `docs/sprint-*/tasks.json`, `docs/CONTEXT.md`, `docs/decisions.log`, recent git log.
- **Mode** (default `interactive`): `interactive` asks at each handoff, `auto` runs the full chain unattended.

## Process

### Step 0 — Setup gate

Before anything else, check `.bypilot/setup.json`. If missing or stale (>14 days), invoke `/bypilot-setup` first. The plan needs to know what's reachable (e.g., don't plan WhatsApp tasks if META keys are blocked).

### Step 1 — Analyst pass

Invoke `analyst` agent with: goal + project context + research memo (if any). Returns `brief.md`:

- **Opportunity** — Why now, what's the pull?
- **Jobs-to-be-done** — Whose job, in what context?
- **Segments** — Which ByPilot users (admin / customer / staff)?
- **Constraints** — Time, dependencies, regulatory.
- **Out-of-scope** — Explicit rejects.

Interactive mode: present brief, ask "edit / accept / redo". Auto mode: accept silently, log to `docs/plan/<goal-slug>-brief.md`.

### Step 2 — PM pass

Invoke `pm` agent with: brief + research memo. Returns `prd.md`:

- **Epics** (1-3) — Each is a coherent feature group.
- **User stories** under each epic — "As <persona>, I want <X>, so that <Y>".
- **Acceptance criteria** per story — testable Given/When/Then.
- **Risks** — Known unknowns.

Interactive mode: present, ask "edit / accept / drop epics". Auto mode: pick the 1-2 highest-value epics for ByPilot's current product state, log rationale.

### Step 3 — Architect pass

Invoke `architect` agent with: PRD + project's actual structure (CLAUDE.md, package layout, schema). Returns `architecture.md`:

- **Component map** — Which packages, files affected per epic.
- **Schema deltas** — New tables, columns, RLS policies, migrations.
- **RBAC notes** — Which modes (admin/customer/staff), which permissions.
- **Risks + mitigations** — Concurrency, RLS bypasses, third-party rate limits.
- **File touch matrix** — Which stories share which files (input for conflictsWith detection).

Interactive: review, ask about trade-offs. Auto: pick the lowest-risk approach when alternatives exist; log decisions.

### Step 4 — Task-composer pass

Invoke `task-composer` agent with: architecture + file touch matrix. Returns `tasks.json` plus a sequencing memo:

```jsonc
{
  "$schema": "../schemas/tasks.schema.json",
  "sprint": "<N>",
  "createdAt": "2026-05-10",
  "tasks": [
    {
      "id": "wa-webhook-receiver",
      "title": "WhatsApp webhook receiver + signature verify",
      "scope": "api",
      "priority": 1,
      "status": "pending",
      "dependsOn": [],
      "conflictsWith": [],
      "files": ["apps/api/server/api/webhooks/whatsapp/index.post.ts"],
      "testDepth": "happy-path",
      "estCost": "M",
      "description": "...",
      "acceptance": [...],
      "context": {...}
    },
    {
      "id": "wa-incoming-route-to-pilot",
      "title": "Route incoming WhatsApp message to Pilot",
      "dependsOn": ["wa-webhook-receiver"],
      "scope": "pilot",
      "testDepth": "comprehensive",
      ...
    },
    ...
  ]
}
```

Composer rules:
- Every task gets `scope` (pilot / coiffure / api / e2e / shared) — drives implementer routing
- Every task gets `testDepth`:
  - `smoke` — 1 happy-path test
  - `happy-path` — 3-5 scenarios covering main flow
  - `comprehensive` — 5+ scenarios including edge cases, errors, persistence
- File-overlap auto-detected → `conflictsWith` populated
- Critical-path-first ordering (longest dep chain → highest priority)

### Step 5 — Validate

Auto-run validation before writing:

```bash
node scripts/validate-tasks.mjs docs/sprint-<N>/tasks.json
```

Checks:
- DAG has no cycles
- Every `dependsOn` ID exists
- Every `files` entry is a valid relative path
- `testDepth` is in enum
- No two tasks share `priority: 1` without dep edge between them

### Step 6 — Persist

```bash
mkdir -p docs/sprint-<N>
write docs/sprint-<N>/tasks.json
write docs/sprint-<N>/brief.md
write docs/sprint-<N>/prd.md
write docs/sprint-<N>/architecture.md

# Update sprints manifest
jq '.active += ["sprint-<N>"]' docs/sprints.manifest.json > tmp && mv tmp docs/sprints.manifest.json

# CONTEXT.md append
echo "\n## Sprint <N> — <goal>\n<one-paragraph summary>" >> docs/CONTEXT.md
```

### Step 7 — Report

```
╭─ bypilot · plan complete ───────────────────────╮
│ Sprint: sprint-<N>                               │
│ Tasks: 12 (5 ready, 7 dependent)                 │
│ Critical path: 4 tasks, est ~6h                  │
│ Test depth distribution: 3 smoke, 6 happy, 3 comp│
│                                                  │
│ Brief: docs/sprint-<N>/brief.md                  │
│ PRD: docs/sprint-<N>/prd.md                      │
│ Architecture: docs/sprint-<N>/architecture.md    │
│ Tasks: docs/sprint-<N>/tasks.json                │
│                                                  │
│ Ready for: /bypilot-sprint-driver                          │
╰──────────────────────────────────────────────────╯
```

## Auto Mode (`/bypilot-plan --auto <goal>`)

- Each handoff between agents is auto-accepted.
- AI applies "what makes sense for ByPilot" — consults `MEMORY.md` and CLAUDE.md before deciding.
- Edge calls (epic count, story selection, architecture trade-offs) all logged to `docs/plan/<goal-slug>-decisions.log` so the user can audit.
- One final report at the end; no mid-flow questions.

## Accepting Pre-made Tasks

If user already has tasks (a list, a doc, etc.), `/bypilot-plan --import <path>`:
- Skip steps 1-3 (analyst, PM, architect)
- Run step 4 (task-composer) with `mode=normalize` — adds `dependsOn`, `conflictsWith`, `scope`, `testDepth` fields
- Validate, persist

## KESİN KURALLAR

1. **Hiçbir agent'ı atlama.** Analyst → PM → architect → composer zinciri korunur. Tek istisna: `--import` modu (composer-only).
2. **Tüm karar gerekçeleri loglanır.** Auto mode da dahil — `docs/plan/<slug>-decisions.log` her handoff'u kaydeder.
3. **DAG cycle yasak.** Validate step bunu yakalar; cycle varsa task-composer tekrar çağrılır.
4. **Mevcut tasks.json'a değme.** Yeni sprint klasörü açılır; eski sprintlerin task'larını taşıma/silmeye yetkin değilsin.

## Sıkıştığında

- Goal too vague after step 1 → analyst returns "needs clarification", AskUserQuestion ile 2-3 framing seçeneği sun.
- Architect cannot fit goal in current architecture (would need refactor) → composer ekstra "refactor-prep" task'ları üretir, zincir başına yerleştirir.
- Existing sprint has overlapping epic → uyar, kullanıcıya sor: "merge with sprint-N or new sprint-M?"

## Bitti sayılan durum

- 4 dosya yazıldı (brief, prd, architecture, tasks.json) + sprints.manifest.json güncel
- DAG validation green
- CONTEXT.md güncel
- Ready-set non-empty (en az 1 task `dependsOn: []`)
