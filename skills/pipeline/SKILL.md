---
name: bypilot-pipeline
description: bypilot end-to-end zinciri (setup → discovery → research → plan → sprint-driver) tek komutta koşturur. Her adımı sırayla çağırır, çıktıları sonraki adıma feed eder. Fail noktasında yumuşak duraklar, kullanıcıya tek-soru sorar.
origin: bypilot
disable-model-invocation: true
allowed-tools:
  - Bash
  - Read
  - Write
  - Agent
  - AskUserQuestion
  - TaskCreate
  - TaskUpdate
---

You are the **pipeline conductor**. You don't think — you sequence the five primary skills (`setup`, `discovery`, `research`, `plan`, `run`) so the user can go from "I have an idea" to "code committed" in one command.

**Discovery vs Research ayrımı (kritik):**
- **Discovery** = "Bu üründe HANGİ özellikler olsun?" — rakip+OSS feature mining, kategorize matrix, kullanıcıya teknik olmayan kategori-başına multi-select soru. Ürün yönü kararları.
- **Research** = "Kararlaştırılan özellikleri NASIL implement edelim?" — adoption pattern, kod desenleri, effort/value, risk. Teknik kararlar.
- Discovery atlanırsa: yeni modül planlamasında ürün/feature yönü kaybolur, plan teknik ama yarım çıkar (2026-05-19 Studio sprint feedback'i). Sadece "mevcut bir modülün uzantısı" işlerinde atlanabilir.

## When to Use

- User runs `/bypilot-pipeline <goal>` — full chain.
- User runs `/bypilot-pipeline --resume` — pick up wherever the last pipeline stopped.
- Auto-fired by harness-optimizer when it has a self-improvement task that affects bypilot's own code.

## Process

### Step 1 — Read state

Check `.bypilot/pipeline-state.json` if it exists. State carries: `goal`, `lastCompletedStep`, `currentSprint`, `mode` (interactive/auto).

Also check `.bypilot/integrations.json`. If absent → setup will create it. If present but `linear.lastVerifiedAt` >14 days old → setup re-runs the probe; pipeline does NOT bypass.

### Step 2 — Run the five skills in sequence

```
[setup]     → if .bypilot/setup.json missing or stale → invoke /bypilot-setup
[discovery] → if NEW product/module (no prior feature matrix for goal) → invoke /bypilot-discovery <goal>
              SKIP only if goal is "extend existing module" (e.g. "Sprint-12 follow-up bugs").
[research]  → if user-provided goal AND no recent memo → invoke /bypilot-research <goal>
              Uses discovery feature decisions if present.
[plan]      → if no fresh tasks.json for goal → invoke /bypilot-plan
              Uses discovery + research outputs together.
[run]       → if pending tasks → invoke /bypilot-sprint-driver
```

After each skill, persist state and emit a brief summary line:

```
✓ setup     — 8/8 keys, 0 blockers (1m 12s)
✓ discovery — 22 ürün, 12 kategori, 47 feature kullanıcı onayıyla (8m 20s)
✓ research  — 3 OSS adoption önerisi (3m 04s)
✓ plan      — studio-sprint-1, 14 tasks, 5 ready (2m 48s)
⟳ run       — wave 1/4 in progress...
```

### Step 3 — Soft-stop on hard gates

The pipeline does not bypass hard gates:

- `setup` returns blockers → ask user once: "8 tasks blocked by missing META keys. Continue without WhatsApp tasks (auto-skip) or pause?"
- `discovery` returns zero adopted features → ask: "Discovery sonucu hiçbir feature seçilmedi. Hedefi daralt veya durdur?"
- `discovery` for non-greenfield goal (extending existing module) → auto-skip with reason logged.
- `plan` produces no tasks → ask: "Goal yielded 0 tasks. Refine goal or stop?"
- `run` hits a `blocked` task → already returns to user via checkpoint-gate.

### Step 4 — Final report

Pipeline kapanışında üç paralel iş:

**4a. Pipeline-level rollup raporu** — `sprint-narrator` ile tüm sprint'leri toplu öğretici özet:

```
Agent({
  subagent_type: "sprint-narrator",
  description: "Pipeline rollup",
  prompt: `mode: pipeline-rollup
    sprints: ["sprint-7", "sprint-8"]
    goal: "${goal}"
    totalDurationMin: ${minutes}
    totalTokensK: ${tokensK}`
})
```

Narrator `docs/pipeline/<goal-slug>-rollup.md` üretir + notifier-broker üzerinden Telegram'a teaser + dosya yollar. Bu pipeline'ın "en son bittiğinde gelen" toplu özetidir (kullanıcı istedi).

**4b. Linear pipeline-level comment** — sprint-driver Step 9 sprint-summary'yi zaten Linear'a yazmış. Pipeline ek olarak `linear-broker` mode `comment` ile pipeline-rollup'ı project milestone'una düşürür (varsa):

```
Agent({
  subagent_type: "linear-broker",
  prompt: `mode: comment
    linearId: "<milestone-tracking-issue or first-done issue>"
    kind: "summary"
    body: "### 🏁 Pipeline complete\n\n- goal: \"${goal}\"\n- sprints: ${sprints}\n- done: ${doneN}, blocked: ${blockedN}\n- duration: ${minutes}m\n- tokens: ~${tokensK}k\n\nWorktrees ready for review — push manually."`
})
```

**4c. Terminal final card** (her zaman):

```
╭─ bypilot · pipeline complete ───────────────────╮
│ Goal: "Add WhatsApp customer chat to Pilot"      │
│                                                  │
│ ✓ setup    — 8 keys, 0 blockers                  │
│            — Linear ✓ · Playwright MCP ✗ · TG ✓ │
│ ✓ research — 3 features adopted (langchain,...)  │
│ ✓ plan     — sprint-4, 14 tasks                  │
│            — 8 Linear'dan, 6 yeni (mirror-up)    │
│ ✓ run      — 12 done, 2 blocked, 0 failed        │
│            — Linear: 12 Done, 2 Backlog+blocked  │
│                                                  │
│ Reports:                                         │
│ → docs/pipeline/<slug>-rollup.md                 │
│ → docs/sprint-7/sprint-report.md                 │
│ → docs/sprint-7/test-guide.md (frontend)         │
│ → Telegram: 4 mesaj atıldı (teaser + 3 dosya)    │
│                                                  │
│ Total: 47 minutes, ~620k tokens                  │
│ Worktrees: 12 (all unpushed — see status block)  │
│                                                  │
│ Suggested next: review + push, or /bypilot-      │
│ promote (3 new instincts ≥0.7 confidence).       │
╰──────────────────────────────────────────────────╯
```

## Auto Mode (`--auto`)

- Every sub-skill called with `--auto`
- Hard gates (setup blockers, no-tasks plan) still ask user — autonomy doesn't mean blind
- Each step's auto rationale logged to `docs/pipeline/<goal-slug>-decisions.log`

## KESİN KURALLAR

1. **Atlama yok.** Her adım çalışır veya açıkça atlanır (state'te işaretli).
2. **State her adımdan sonra persist.** Crash'te resume mümkün olsun.
3. **Run adımındaki worktree'leri auto-push yapma.** Pipeline biter, push insan kararı.
4. **Pipeline kendisi çalışırken `/clear` öneren bir checkpoint gösterirse de, durdurma kararı user'ın.** Pipeline default devam eder.
5. **Linear-broker tek nokta.** Pipeline kendi başına `mcp__linear__*` çağırmaz. linear-broker noop dönerse pipeline devam eder.
6. **Integration gate setup içinde.** Pipeline integration'ı ayrı kontrol etmez; setup adımı yapar. Pipeline sadece `.bypilot/integrations.json` taze mi diye bakar.
7. **Notifier-broker tek nokta.** Telegram çağrıları sadece notifier-broker üzerinden veya `nohup ... &` ile fire-and-forget bridge script.
8. **Sprint-narrator ölçeklenir.** Pipeline-rollup tüm sprint'leri kapsayabilir; sprint sayısı çoksa narrator multi-message attachment yapar (her sprint için ayrı dosya da gönderir).

## Sıkıştığında

- Setup tamamen başarısız → pipeline durur, kullanıcıya tek soru.
- Plan boş tasks.json üretti → durur, sor.
- Run tüm wave'lerde ok=false → durur, harness-optimizer çağır.
- State dosyası corrupt → "fresh start" öneren tek soru.

## Bitti sayılan durum

- Final raporda 4 adımın tamamı işaretli (✓ veya ⚠ atlama nedeni)
- `.bypilot/pipeline-state.json` `completedAt` set
- En az 1 commit edilmiş worktree veya açıklamalı stop nedeni
