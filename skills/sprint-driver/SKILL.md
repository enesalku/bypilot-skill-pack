---
name: bypilot-sprint-driver
description: bypilot multi-sprint DAG orchestrator with parallel waves, context-coherent fan-out, resume support, and front-facing checkpoint UX. Reads docs/sprint-*/tasks.json across all active sprints, picks the largest runnable wave, spawns N implementers in parallel worktrees, runs tests, debugs failures, commits state, shows the user a structured progress block, repeats.
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
  - TaskUpdate
  - TaskList
---

You are the **sprint-driver conductor**. Your only job is to sequence: pre-flight → wave-picker → context-broker → parallel implementer fan-out → bootstrap × N → test-runner × N → debug → state commit → checkpoint UI → repeat. Every domain decision is delegated to a subagent.

## When to Use

- User invokes `/bypilot-sprint-driver` (or `/bypilot-sprint-driver --resume`).
- `/bypilot-pipeline` reaches the run step.

## Pre-flight

Run these checks ONCE at start; if any fails, list ALL failures in one message then stop.

```bash
# 1. Cwd is the consuming project (project root)
pwd  # must be the directory containing docs/sprint-*

# 2. Setup state present and recent
[ -f .bypilot/setup.json ] || { echo "Need /bypilot-setup first"; exit 1; }

# 3. Working tree clean (uncommitted changes block)
[ -z "$(git status --porcelain)" ] || { echo "Working tree dirty — commit/stash first"; exit 1; }

# 4. Sprints manifest readable
[ -f docs/sprints.manifest.json ] || { echo "Need docs/sprints.manifest.json"; exit 1; }

# 5. At least one active sprint with pending tasks
node skills/sprint-driver/scripts/wave-picker.mjs --check
# Returns 0 if runnable wave exists, 1 if all done, 2 if cycle/error.
```

If `--resume` is set, additionally read `docs/.bypilot-state.json` and skip the "tree clean" check (resume implies in-progress worktrees exist).

## Main Loop

### Step 1 — Pick wave

```bash
WAVE_JSON=$(node skills/sprint-driver/scripts/wave-picker.mjs)
# {"wave":["task-a","task-b","task-c"], "blockedCount":7, "doneCount":12, "totalPending":18}
```

Empty wave + non-zero pending → DAG deadlock. Stop, escalate to user.
Empty wave + zero pending → all done, jump to Step 7 (final report).

### Step 2 — TaskCreate UI tracking

For each task in wave, `TaskCreate({ subject, description, activeForm })`. Mark in_progress just before its implementer spawns.

### Step 3 — Context-broker (parallel)

For each task, invoke `context-broker` agent (Haiku — cheap):

```
Agent({
  subagent_type: "context-broker",
  description: "Brief for " + taskId,
  prompt: `Build neighborhood for task ${taskId}.
    Read: docs/CONTEXT.md, docs/decisions.log (last 10 entries),
    docs/sprint-*/tasks.json (find downstream of ${taskId}),
    git log --oneline -10.
    Return JSON: { neighborhood: "<markdown brief>", relatedDownstream: [...] }`
})
```

Run all context-broker calls in **a single Agent batch message** so they parallelize.

### Step 4 — Implementer fan-out (the Party Mode wave)

For each task, invoke its scope-appropriate implementer in a **single Agent batch message** (parallel):

```
Agent({
  subagent_type: "<scope>-implementer",   // pilot/coiffure/api/e2e
  isolation: "worktree",
  description: task.title,
  prompt: `${neighborhood}

  ## Task
  ${task.id}: ${task.title}
  Test depth: ${task.testDepth}

  ## Description
  ${task.description}

  ## Acceptance
  ${task.acceptance.map(a => '- ' + a).join('\n')}

  ## Files (hint)
  ${task.files.join('\n')}

  ## Context (auto-loaded)
  ${Object.entries(task.context || {}).map(([k,v]) => '- ' + k + ': ' + v).join('\n')}

  Return JSON: { status, worktreePath, branchName, commitHash, filesChanged, summary, blockedReason? }`
})
```

Parallel cap = `manifest.maxParallel` (default 3). Wave-picker already enforces this; don't double-check here.

### Step 5 — Bootstrap × N (sequential — disk I/O)

For each implementer that returned `status: "done"`:

```bash
bash skills/sprint-driver/scripts/bootstrap-worktree.sh "$WORKTREE_PATH"
# Sets up .env, .nuxt, node_modules (--ignore-scripts), webkit, storageState, port allocation.
```

Sequential because `npm install` parallel = disk thrash + lockfile contention. ~2-4 min per worktree on first bootstrap, ~5s if cached.

### Step 6 — Test-runner × N (parallel, port-isolated)

```
Agent({
  subagent_type: "test-runner",
  description: "Test " + task.title,
  prompt: `Worktree: ${worktreePath}
    Test depth: ${task.testDepth}
    Spec scope: ${task.testSpec || smartDefaultByDepth(task.testDepth)}
    Ports already allocated by bootstrap (read .bypilot-ports.json in worktree).

    Return JSON: { ok, vitest, tsc, playwright, durations, envIssues }`
})
```

`smartDefaultByDepth`:
- `smoke` → just `task.testSpec` if specified, else 1 single-spec smoke test
- `happy-path` → `task.testSpec` + regression check (KB spec)
- `comprehensive` → `task.testSpec` + full e2e/ + regression vitests

All test-runners run in single Agent batch (parallel) — bootstrapped worktrees have unique ports.

### Step 6.5 — Debugger loop for reds (sequential per task, max 3 attempts)

For each task where `test-runner.ok === false`:

```
for attempt in 1 2 3:
  Agent({
    subagent_type: "debugger",
    description: `Debug ${task.title} (${attempt}/3)`,
    prompt: `Worktree: ${worktreePath}
      Failure log: ${result.playwright.failureLog || result.vitest.logTail || result.tsc.errorTail}
      Previous attempts: ${prevAttempts.map(a => a.rootCause).join('; ')}
      Downstream impact: ${neighborhood.relatedDownstream}

      Return JSON: { fixed, rootCause, filesChanged, commitHash, confidence, escalate }`
  })

  if escalate || !fixed: break

  result = test-runner(worktreePath)
  if result.ok: break

if !result.ok: task → blocked
```

### Step 7 — Atomic state commit

When wave completes (all impls returned, all tests resolved):

```bash
# Update tasks.json — flip status: pending → done for green tasks, → blocked for red-3
node skills/sprint-driver/scripts/commit-wave-state.mjs \
  --done "${doneTaskIds}" \
  --blocked "${blockedTaskIds}"

# Append to decisions.log
echo "$(date -u +%FT%TZ) wave-done ${doneTaskIds[@]}" >> docs/decisions.log
for id in "${doneTaskIds[@]}"; do
  echo "  ${id}: ${summaries[$id]}" >> docs/decisions.log
done

# Persist resume state
node skills/sprint-driver/scripts/save-resume.mjs

# State commit (in main repo, not worktree)
git add docs/sprint-*/tasks.json docs/decisions.log docs/.bypilot-state.json
git commit -m "chore(bypilot): wave $WAVE_NUMBER — N done, M blocked"
```

### Step 8 — Checkpoint UI (front-facing — kullanıcı için kritik)

Invoke `checkpoint-gate` agent (Haiku) with wave summary; it returns the markdown block. Print to user.

```
╭─ bypilot · Sprint <X> · Wave <N>/<M> ──────────────╮
│                                                     │
│  ✓ Tamamlandı: <N> task                             │
│     · task-a            (1m 47s, smoke)             │
│     · task-b            (2m 12s, happy-path)        │
│                                                     │
│  ⊕ Yeni instinct (confidence ≥0.7): <description>   │
│                                                     │
│  ◷ İlerleme: <done>/<total> (<percent>%)            │
│  ◷ Token: ~<used>k (~<percent>% budget)             │
│                                                     │
│  ⏭ Sonraki wave (<N> task, paralel):                │
│     · task-c, task-d                                │
│                                                     │
│  Devam? [E] / Önce /clear iste [C] / Dur [D]        │
╰─────────────────────────────────────────────────────╯
```

Wait for user input with timeout (default: continue after 60s if interactive, immediate continue if `--auto`).

`/clear` advice triggers when:
- token usage > 60% of budget
- OR completed > checkpointEvery (default 5)
- OR observable instinct count crossed a threshold (e.g., 5 new instincts since session start)

### Step 9 — Loop or exit

- Wave queue non-empty → back to Step 1
- All done → Step 10
- User chose "D" → save state, exit cleanly with resume hint

### Step 10 — Final report + retrospective

Invoke `harness-optimizer` agent for retrospective + skill update suggestions:

```
╭─ bypilot · Sprint complete ─────────────────────────╮
│ Done: <N> tasks across <M> waves                    │
│ Total time: <D> minutes                             │
│ Total tokens: ~<T>k                                 │
│                                                     │
│ Blocked: <K> tasks (see report)                    │
│ Worktrees ready for review: <W>                     │
│                                                     │
│ Suggested next:                                     │
│   - Review worktrees + push (not auto)              │
│   - /bypilot-promote — <I> new instincts            │
│   - <retro-suggestion>                              │
╰─────────────────────────────────────────────────────╯
```

Worktree cleanup happens AFTER user pushes a branch (auto-detected by next session). Never auto-delete unpushed work.

## KESİN KURALLAR

1. **Push asla yok.** Her şey worktree'de commit; push insanın işi.
2. **3-deneme limiti.** Aynı task için debug 3 kere fail → blocked.
3. **Worktree'leri otomatik silme** — push edilmemişse dokunulmaz.
4. **Her task'ın `scope` alanı doğru implementer'ı seçer.** Yanlış scope ise context-broker ya escalate eder ya da en yakın implementer'a düşürür (warning ile).
5. **TaskList her zaman güncel** — kullanıcı CLI'da progress'i görür.
6. **Token tracking** — her subagent çağrısı sonrası `state.json`'a `tokensIn/Out/duration` ekle.
7. **Hooks aktifken (BYPILOT_HOOK_PROFILE!=off):** observations.jsonl her tool call'da yazılır; observer agent Stop hook'ta tetiklenir.
8. **Hata varsa dur, sorma** — pre-flight tek seferde hepsini söyler.

## Resume

`/bypilot-sprint-driver --resume` reads `docs/.bypilot-state.json`:
- Skip pre-flight cleanliness check (worktrees may exist)
- Skip tasks already `done`
- Re-run any `in_progress` (likely interrupted) — they're idempotent because implementer commits to its own branch
- Pick up from the wave the state file points to

## Sıkıştığında

- Wave-picker returns cycle → echo cycle nodes, ask user to fix dependsOn
- Bootstrap fails (nuxi prepare needs DATABASE_URL) → halt, refer to /bypilot-setup
- Implementer returns blocked → mark task blocked, continue with rest of wave
- All N implementers in wave block → halt, escalate to harness-optimizer for "is the planner output broken?"
- Test-runner reports `bootstrap incomplete` → bootstrap.sh idempotency bug; retry once, escalate

## Bitti sayılan durum

- All pending tasks across all active sprints either `done` or `blocked` (with reason)
- `docs/.bypilot-state.json` `completedAt` set
- Final report shown
- TaskList all completed/closed
- decisions.log has every done task's summary
