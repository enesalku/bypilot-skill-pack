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
  - mcp__linear__list_projects
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

Also read `.bypilot/integrations.json`. If file is missing → invoke setup. If `linear.enabled: false` → log info and continue **without** Linear sourcing (skip Step 0.5).

### Step 0.3 — Requirements gate (user-visible intent kontratı, ZORUNLU)

Plan zinciri analyst'a başlamadan önce **kullanıcı isterlerinin** kontratı disk'te olmalı. Sprint klasörünü belirle (komutta `--sprint sprint-11` verildiyse onu kullan; yoksa `sprints.manifest.json.active` listesindeki sonuncu veya yeni numara):

```bash
REQ_PATH="${SPRINT_FOLDER}/requirements.json"
if [ ! -f "$REQ_PATH" ]; then
  # Yok — bypilot-requirements skill'ini zincirle
  /bypilot-requirements "${USER_PROMPT_VERBATIM}"
  # ${MODE_FLAG:+--auto}
fi

# Şimdi var olmalı; yine yoksa halt
[ -f "$REQ_PATH" ] || { echo "Requirements missing — user did not approve. Plan halted."; exit 1; }

# Schema validation
node -e "
  const d = require('./${REQ_PATH}');
  if (!d.requirements || !d.requirements.length) process.exit(1);
  if (!d.approvedBy) process.exit(1);
"
```

Yani plan **kullanıcı onaylı bir `requirements.json` olmadan başlamaz**. `--auto` modu bile bu kuralı atlayamaz (elicitor zaten tek final onay sorusunu çalıştırır).

requirements.json analyst/PM/architect/composer'ın hepsine input olarak akar. PM stories'i REQ id'leriyle hizalar; composer her task'a `linksRequirement` doldurur.

### Step 0.5 — Linear pre-pass (if `linear.enabled`)

Linear, *kaynak değil aynadır*. Bu adımda Linear'ı **input** olarak kullan, ama AI'nın genişletme/parçalama/iptal etme yetkisi korunur.

**Sub-step A — Project seçimi (her plan'de sorulur)**

```
Agent({
  subagent_type: "linear-broker",
  description: "List projects for plan input",
  prompt: `mode: list-projects (read team from integrations.json). Return up to 8 most recently updated.`
})
```

Sonra `AskUserQuestion`:

```
Q: "Bu plan hangi Linear project'ten besleniyor?"
options:
  - "<project A> — <summary 60ch>"
  - "<project B> — ..."
  - "(yeni — Linear'da yok, sadece tasks.json üret)"
```

Auto modda: en yakın `targetDate` veya en çok güncel project; rationale `docs/plan/<slug>-decisions.log`'a.

**Sub-step B — Issue fetch + seçim**

```
Agent({
  subagent_type: "linear-broker",
  description: "Fetch issues for plan",
  prompt: `mode: fetch-project-issues
    project: "${selectedProject}"
    statuses: ["Todo", "Backlog", "In Progress"]
    assignee: "${integrations.linear.assignee}"`
})
```

Dönen issue listesi 1-25 arası ise `AskUserQuestion`'a (multiSelect: true) sığar — kullanıcıya seçim sunar:

```
Q: "Hangi Linear issue'ları bu sprint'e dahil edelim?"
header: "Linear seç"
multiSelect: true
options:
  - "BYP-29 — Brain: context-builder modülü [P1 · Backend]"
  - "BYP-30 — Brain: ayrı intent classifier [P1 · Backend]"
  - "BYP-64 — Dry-run modu finalize [P0 · Urgent]"
  ...
```

25'ten fazla ise priority desc + updatedAt sort, ilk 25'i göster + "...ve N issue daha — query daralt ister misin?" ek option.

Auto modda: P0+P1+P2 olan tüm Todo+In Progress'leri import; sebep loglanır.

**Sub-step C — Linear issue → goal context'e eklenir**

Seçilen issue'lar analyst'in input'una eklenir:

```
goalContext = {
  userGoal: "<original user-typed goal>",
  linearSource: {
    project: "<project name>",
    issues: [{ id, title, description, labels, priority, parentId, estimate, milestone }]
  }
}
```

Analyst bu input'u **temel** olarak kullanır ama **birebir kopyalamak zorunda değildir**: gerekirse 1 Linear issue'unu N task'a parçalar, gerekirse 2 ilgili issue'u 1 task altında birleştirir, gerekirse Linear'da olmayan refactor-prep task'ı ekler. Her kararın gerekçesi `docs/plan/<slug>-decisions.log`'a.

### Step 1 — Analyst pass

Invoke `analyst` agent with: goal + project context + **`requirements.json` (kullanıcı isterleri)** + research memo (if any). Analyst, opportunity / JTBD analizini yaparken kullanıcı isterlerini başlangıç noktası kabul eder — yeni "neden şimdi" çıkarmaya zorlanmaz. Returns `brief.md`:

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
- **Requirement coverage:** her `userVisible: true` REQ en az bir task'ın `linksRequirement`'ında olmalı (composer Step 2.5 invariant'ı)
- **Contract author tekliği:** her `creates.contract` path'i sadece TEK task tarafından sahiplenilmiş olmalı (Mailbox tek-yazar kuralı)
- **Subscribe-sources resolvable:** her `subscribes` path'i bir task'ın `creates.contract`'inde tanımlı olmalı veya halihazırda repo'da var olmalı

Bunlardan biri fail ederse composer'a `--fix` ile dön (max 2 retry); hâlâ fail ise plan halt — kullanıcıya net hata.

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

### Step 6.5 — Mirror-up to Linear (if `linear.enabled`)

Composer'ın çıkardığı her task için:

```
if (task.linearIssueId) {
  // Linear'dan gelmiş — sadece status'u "Todo" garantile
  Agent({ subagent_type: "linear-broker", prompt: `mode: set-status, linearId: "${task.linearIssueId}", bypilotStatus: "pending"` })
} else {
  // AI'nın eklediği yeni task — Linear'a mirror et
  result = Agent({ subagent_type: "linear-broker", prompt: `mode: mirror-up, task: <json>, sprint: "sprint-<N>"` })
  if (result.ok) {
    // broker tasks.json'a linearIssueId zaten yazdı
    log decisions: "task ${task.id} mirrored to ${result.linearId}"
  }
}
```

Auto modda hep otomatik mirror. Interactive modda da otomatik — kullanıcı kararı buydu.

Composer'ın **drop ettiği** Linear issue'lar (örn. PRD scope-out'u nedeniyle) için:

```
Agent({ subagent_type: "linear-broker", prompt: `mode: cancel, linearId: "${droppedId}", reason: "composer dropped: ${rationale}"` })
```

Tüm aksiyonlar `docs/plan/<slug>-decisions.log`'a tek satır olarak yazılır.

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
│ Linear:                                          │
│ ✓ 8 issue Linear'dan import edildi               │
│ ✓ 4 yeni issue Linear'da açıldı (mirror-up)     │
│ ✓ 1 issue cancel edildi (composer drop)         │
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
5. **Linear input, not constraint.** Linear issue listesi planlama girdisidir; AI parçalayabilir/birleştirebilir/refactor-prep ekleyebilir. Her sapma gerekçeli loglanır.
6. **Linear MCP yoksa noop.** `integrations.json.linear.enabled === false` ise Step 0.5 ve Step 6.5 tamamen atlanır; plan eskisi gibi local çalışır.
7. **Linear-broker dışında MCP çağrısı yok.** Plan skill `mcp__linear__*` tool'larını doğrudan çağırmaz — daima linear-broker üzerinden.
8. **Requirements gate atlanamaz.** Step 0.3 zorunlu — `requirements.json` onaylı olmadan analyst başlatılmaz. Auto mode bile bu kuralı atlayamaz.
9. **REQ id'leri immutable.** Plan zinciri requirements.json'a yazmaz, sadece okur. Düzeltme gerekiyorsa kullanıcı `/bypilot-requirements --extend` veya yeni sprint açar.

## Sıkıştığında

- Goal too vague after step 1 → analyst returns "needs clarification", AskUserQuestion ile 2-3 framing seçeneği sun.
- Architect cannot fit goal in current architecture (would need refactor) → composer ekstra "refactor-prep" task'ları üretir, zincir başına yerleştirir.
- Existing sprint has overlapping epic → uyar, kullanıcıya sor: "merge with sprint-N or new sprint-M?"

## Bitti sayılan durum

- 4 dosya yazıldı (brief, prd, architecture, tasks.json) + sprints.manifest.json güncel
- DAG validation green
- CONTEXT.md güncel
- Ready-set non-empty (en az 1 task `dependsOn: []`)
