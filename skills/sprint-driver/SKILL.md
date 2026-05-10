---
name: bypilot-sprint-driver
description: bypilot multi-sprint DAG orchestrator. Continuous slot-pool scheduler with epoch checkpoints, central worktree manager, automatic recovery points, and a self-fix policy that absorbs the small failures before they reach the user. Three modes — interactive (default), --ask-gates (one-time wizard), --auto (no UI gates, full headless). Reads docs/sprint-*/tasks.json across all active sprints.
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

You are the **sprint-driver conductor**. You sequence: pre-flight → claim → context → fan-out → bootstrap → test → debug → atomic commit → epoch-check → repeat. Every domain decision is delegated to a sub-agent. The conductor itself stays thin so its context window stays small.

**Symlink note:** in this repo, `.claude/skills/bypilot-sprint-driver` is a symlink into `bypilot-skill-pack/skills/sprint-driver`. Always use absolute paths or `BYPILOT_ROOT` to avoid drift.

## Modes

The conductor runs in one of three modes; pick exactly one.

| Flag | Mode | Behavior |
|---|---|---|
| (none) | `interactive` | Epoch UI shown, user can stop/redirect, recovery hints surfaced. Default. |
| `--ask-gates` | one-time wizard | Asks 3 yes/no gate questions, persists answers to `.bypilot/gate-prefs.json`, then runs interactive with those prefs |
| `--auto` | full-auto | No UI gates, no prompts. Only HALTS on critical-security findings or recovery-impossible failures. Pair with `bypilot-loop.sh` for headless cron-style runs. |

`--resume` is orthogonal — works with all three modes.

Mode resolution at startup:
```bash
MODE="interactive"
[ -f .bypilot/gate-prefs.json ] && MODE="interactive"   # use saved prefs
echo "$@" | grep -q -- "--auto" && MODE="auto"
echo "$@" | grep -q -- "--ask-gates" && MODE="ask-gates-wizard"
```

## Pre-flight (run ONCE at start)

If any check fails, list ALL failures in one message then stop. (Auto mode: same — pre-flight failures are HARD STOP.)

```bash
export BYPILOT_ROOT="$PWD"

# 1. Cwd is the consuming project
pwd  # must contain docs/sprint-*

# 2. Setup state present
[ -f .bypilot/setup.json ] || { echo "Need /bypilot-setup first"; exit 1; }

# 3. Lock acquire (prevents two drivers in same root)
node .claude/skills/bypilot-sprint-driver/scripts/worktree-manager.mjs ensure-lock

# 4. Working tree clean — unless --resume (in-progress worktrees may exist)
if ! echo "$@" | grep -q -- "--resume"; then
  if [ -n "$(git status --porcelain)" ]; then
    echo "dirty tree — auto-stashing to bypilot-snapshot/preflight"
    node .claude/skills/bypilot-sprint-driver/scripts/recovery-points.mjs branch \
      --name preflight-stash --from HEAD
    git stash push -u -m "bypilot pre-flight auto-stash"
  fi
fi

# 5. Sprints manifest
[ -f docs/sprints.manifest.json ] || { echo "Need docs/sprints.manifest.json"; exit 1; }

# 6. At least one runnable task
node .claude/skills/bypilot-sprint-driver/scripts/scheduler.mjs state
# exit 0 = ready, 1 = all done, 2 = stuck
```

## Mode wizard (only if `--ask-gates`)

Single `AskUserQuestion` call with 3 questions, then write `.bypilot/gate-prefs.json`:

```json
{
  "epochCheckpoint": "yes" | "no" | "blocked-only",
  "frontendTrial": "yes" | "no",
  "securityHandling": "stop" | "report-and-continue"
}
```

If saved already, skip the wizard.

## Main Loop

The loop is continuous: each iteration picks free slots from the pool and re-evaluates after every task completion. There are no rigid waves — but **epoch boundaries** still gate the user-facing UI.

### State variables (in driver memory)

```
busyTasks      : Array<{ taskId, worktreePath, branchName, startedAt, agentId }>
epochStart     : ISO timestamp of current epoch start
epochCompleted : count of tasks done since current epoch boundary
epochInstincts : count of high-confidence instincts emitted since boundary
mode           : "interactive" | "ask-gates-wizard" | "auto"
gatePrefs      : object loaded from .bypilot/gate-prefs.json
```

### Step 1 — Claim free slots (mini-burst)

```bash
busyIds="${busyTasks[*]}"   # comma-separated
freeSlots=$((MAX_PARALLEL - ${#busyTasks[@]}))
[ "$freeSlots" -le 0 ] && { /* wait for slot-free event */ }

CLAIM_JSON=$(node .claude/skills/bypilot-sprint-driver/scripts/scheduler.mjs claim \
  --busy "$busyIds" --slots "$freeSlots")
```

`claim.length === 0 && busyTasks.length > 0` → wait for in-flight task to finish.
`claim.length === 0 && busyTasks.length === 0 && pending > 0` → DAG stuck; classify via `self-fix-policy.mjs --kind dag-cycle` and apply.
`claim.length === 0 && pending === 0` → SPRINT COMPLETE → Step 9.

### Step 2 — TaskCreate UI tracking

For each task in claim, `TaskCreate({ subject, description, activeForm })`. Set in_progress just before its implementer spawns.

### Step 3 — Context-broker (parallel, MANDATORY)

Each task MUST get a fresh neighborhood brief. No shortcut. Single Agent batch:

```
Agent({
  subagent_type: "context-broker",
  description: "Brief for " + taskId,
  prompt: `Build neighborhood for task ${taskId}.
    Read: docs/CONTEXT.md, docs/decisions.log (last 30 lines — CRITICAL: pick up commits from sibling tasks committed since this driver started),
    docs/sprint-*/tasks.json (find downstream of ${taskId}),
    .bypilot/recovery-log.jsonl (last 5 entries),
    git log --oneline -15.
    Return JSON: { neighborhood: "<markdown brief>", relatedDownstream: [...], parallelTouchedFiles: [...] }`
})
```

If any context-broker returns empty neighborhood → halt that task, mark blocked. Implementer must not run blind.

### Step 4 — Worktree acquire (centralized) + implementer fan-out

For each task, FIRST acquire a worktree via the manager (no implementer creates its own):

```bash
WT_JSON=$(node .claude/skills/bypilot-sprint-driver/scripts/worktree-manager.mjs acquire \
  --task "$TASK_ID" --sprint "$SPRINT_SLUG" --scope "$SCOPE")
# { worktreePath, branchName, baseSha, reused }
```

Then fan out implementers in **a single Agent batch message** (parallel, cache-warm):

```
Agent({
  subagent_type: "<scope>-implementer",
  description: task.title,
  // NOTE: isolation:"worktree" REMOVED — manager already created it.
  prompt: `${neighborhood}

  ## Worktree (already created — DO NOT git worktree add)
  Path: ${worktreePath}
  Branch: ${branchName} (based on ${baseSha})

  ## Task
  ${task.id}: ${task.title}
  Test depth: ${task.testDepth}

  ## First-step requirement
  Before any edit, re-read docs/decisions.log tail. If a sibling task committed
  a change to a file you are about to touch, adapt — do not blindly overwrite.

  ## Description
  ${task.description}

  ## Acceptance
  ${task.acceptance.map(a => '- ' + a).join('\n')}

  ## Files (hint)
  ${task.files.join('\n')}

  ## Affects (downstream impact you must consider)
  ${(task.affects || []).join('\n')}

  ## Sibling-touched files (committed in this driver run)
  ${(neighborhood.parallelTouchedFiles || []).join('\n')}

  Return JSON: { status, commitHash, filesChanged, summary, blockedReason? }`
})
```

`status: blocked` → no commit, mark blocked via commit-task-state.

### Step 5 — Bootstrap (semaphore: max 2 parallel)

```bash
bash .claude/skills/bypilot-sprint-driver/scripts/bootstrap-worktree.sh "$WORKTREE_PATH"
```

Run with a semaphore so disk I/O for `npm install` doesn't thrash. The conductor enforces this by spawning bootstrap calls in a chunked loop (chunk size 2). Bootstrap is idempotent — safe to retry.

### Step 6 — Test runner (parallel, port-isolated)

```
Agent({
  subagent_type: "test-runner",
  description: "Test " + task.title,
  prompt: `Worktree: ${worktreePath}
    Test depth: ${task.testDepth}
    Spec scope: ${task.testSpec || smartDefaultByDepth(task.testDepth)}

    ## Discipline (NON-NEGOTIABLE)
    1. vitest, tsc, AND playwright must all pass.
    2. If task touched any of: apps/coiffure/**, apps/app/**, packages/ui/**,
       packages/shared/src/pages/** → playwright spec is REQUIRED.
       If no playwright spec exists for the touched route, this run FAILS
       (driver will then create an e2e-spec follow-up task).

    Return JSON: { ok, vitest, tsc, playwright, durations, envIssues, frontendTouched }`
})
```

`smartDefaultByDepth`:
- `smoke` → just `task.testSpec` if specified, else 1 single-spec smoke
- `happy-path` → `task.testSpec` + regression check (KB spec)
- `comprehensive` → `task.testSpec` + full e2e/ + regression vitests

If `frontendTouched && !playwrightCovered` → create a follow-up task `e2e-spec-<taskId>` (status: pending, scope: e2e, dependsOn: <taskId>) and BLOCK the parent task. Don't ship UI without UI tests.

### Step 6.5 — Debugger loop (per-task; cross-task PARALLEL)

For each task where `test-runner.ok === false`, spawn a debugger sub-agent. Different tasks' debuggers run in parallel; per-task they're sequential up to 3 attempts.

```
for attempt in 1 2 3:
  Agent({
    subagent_type: "debugger",
    description: `Debug ${task.title} (${attempt}/3)`,
    prompt: `Worktree: ${worktreePath}
      Failure log: ${result.playwright.failureLog || result.vitest.logTail || result.tsc.errorTail}
      Previous attempts: ${prevAttempts.map(a => a.rootCause).join('; ')}
      Downstream impact: ${neighborhood.relatedDownstream}
      Recently committed sibling files: ${neighborhood.parallelTouchedFiles}

      Return JSON: { fixed, rootCause, filesChanged, commitHash, confidence, escalate }`
  })

  if escalate: break (will be classified by self-fix-policy)
  if !fixed: break

  result = test-runner(worktreePath)
  if result.ok: break

if !result.ok:
  # last-chance context refresh before block
  if attempt === 3:
    decision = self-fix-policy.classify({ kind: "three-fail-block", taskId })
    apply decision (default: snapshot bundle, mark blocked, continue)
```

### Step 7 — Per-task atomic commit (slot-free event)

When a task completes (impl green + tests green) OR is blocked:

```bash
# Optional: cherry-pick recovery snapshot for the branch (cheap, branch-level)
node .claude/skills/bypilot-sprint-driver/scripts/recovery-points.mjs tag \
  --reason "task-done-${TASK_ID}" --message "task ${TASK_ID} complete"

# Atomic flip in tasks.json
node .claude/skills/bypilot-sprint-driver/scripts/commit-task-state.mjs \
  --task "$TASK_ID" --status done \
  --commit "$COMMIT_HASH" --worktree "$WORKTREE_PATH" \
  --summary "$SUMMARY" --epoch "$EPOCH_NUM"

# Per-task state commit (in main repo, not worktree)
git add docs/sprint-*/tasks.json docs/decisions.log
git commit -m "chore(bypilot): task done — ${TASK_ID}"
```

Then **broadcast notify** to siblings: write `.bypilot-notify.json` into every other busy worktree describing what files this task touched. Implementers must check it before each edit.

```bash
for sib in "${busyTasks[@]}"; do
  echo "{\"from\":\"$TASK_ID\",\"files\":${FILES_JSON},\"affects\":${AFFECTS_JSON},\"ts\":\"$(date -u +%FT%TZ)\"}" \
    > "${sib.worktreePath}/.bypilot-notify.json"
done
```

Remove the task from `busyTasks`, free the slot, increment `epochCompleted`, jump to Step 8 (epoch check) and back to Step 1.

### Step 8 — Epoch check (advisory boundary)

```bash
EPOCH=$(node .claude/skills/bypilot-sprint-driver/scripts/scheduler.mjs epoch \
  --since "$EPOCH_START" \
  --completed-since-epoch "$EPOCH_COMPLETED" \
  --max-tasks "${gatePrefs.maxTasks:-6}" \
  --max-minutes 15 \
  --escalation "$ESCALATION_FLAG" \
  --new-instincts "$NEW_INSTINCTS")
# {"boundary":true,"reasons":["completed>=6"]}
```

If `boundary === true`:

1. **Recovery tag** (always):
   ```bash
   node .claude/skills/bypilot-sprint-driver/scripts/recovery-points.mjs tag \
     --reason "epoch-${EPOCH_NUM}-end"
   ```

2. **Save resume state**:
   ```bash
   node .claude/skills/bypilot-sprint-driver/scripts/save-resume.mjs --wave "$EPOCH_NUM"
   ```

3. **Mode-dependent UI/halt logic**:

   **Interactive mode:**
   - Render checkpoint via `checkpoint-gate` agent (Haiku); print to user.
   - If `gatePrefs.frontendTrial === "yes"` and any done task touched UI:
     show URL + ports for manual try (non-blocking — driver continues unless user says stop).
   - If token utilization >70%:
     ```
     ╭─ bypilot · context approaching limit (estimated 72%) ────╮
     │  state saved to docs/.bypilot-state.json                  │
     │  recovery tag: bypilot-recovery/epoch-3-end-...           │
     │  resume: claude → /bypilot-sprint-driver --resume         │
     ╰───────────────────────────────────────────────────────────╯
     ```
     then exit cleanly. (Headless / `--auto`: same trigger but no message — just save and exit. The wrapper will spawn a fresh process.)
   - Else show progress card and continue.

   **Auto mode:**
   - No UI. Just log epoch end to `decisions.log`, save state, continue.
   - Token check still applies — exit clean if >70%.

   **Wizard:** behaves like interactive after wizard completes.

4. Reset `epochStart = now`, `epochCompleted = 0`, `epochInstincts = 0`.

Increment epoch counter regardless of mode.

### Step 9 — Sprint complete

When `pending === 0 && in_progress === 0`:

```bash
node .claude/skills/bypilot-sprint-driver/scripts/recovery-points.mjs tag \
  --reason "sprint-complete" --message "all tasks done/blocked"
node .claude/skills/bypilot-sprint-driver/scripts/save-resume.mjs --note "sprint complete"
node .claude/skills/bypilot-sprint-driver/scripts/worktree-manager.mjs release-lock
```

Render final report via `harness-optimizer` agent (retro + skill-update suggestions). Worktree cleanup is NOT automatic — even after sprint complete, user pushes branches manually and `housekeeping.mjs --execute` handles retention later.

```
╭─ bypilot · Sprint complete ────────────────────────────────╮
│ Done: <N> across <E> epochs · time <D>min · tokens ~<T>k   │
│ Blocked: <K> (see report)                                   │
│ Self-fixes applied: <S> (5 most critical listed below)     │
│ Recovery tags created: <R>                                  │
│ Worktrees ready for review: <W>  (push manually)           │
│                                                             │
│ Suggested next:                                             │
│   - review/push branches you want to keep                  │
│   - /bypilot-promote — <I> new instincts                   │
│   - /bypilot-recover --list — see snapshot history         │
│   - housekeeping.mjs --execute — prune old recovery points │
╰─────────────────────────────────────────────────────────────╯
```

## Self-fix policy (consume self-fix-policy.mjs)

Whenever an error surfaces, classify it before halting:

```bash
ACTION=$(echo "$ERROR_CTX_JSON" | node .claude/skills/bypilot-sprint-driver/scripts/self-fix-policy.mjs classify)
# { class: "auto-fix-safe"|"auto-fix-snapshot"|"halt", action, recoveryRequired, reason, halt }
```

| Class | What conductor does |
|---|---|
| `auto-fix-safe` | Apply action, log to `decisions.log`, continue |
| `auto-fix-snapshot` | First `recovery-points.mjs` (kind=`recoveryRequired`), then apply, then continue |
| `halt` | Snapshot tag, save state, surface to user with full context |

Even in `--auto` mode, `halt` honors halts. Halt list is intentionally short:
- `security-critical` finding from security-reviewer
- `unknown` error class (unrecognized — never silently auto-fix unknowns)
- Pre-flight failure
- Fallback chain exhausted (e.g. dag-cycle relax → still cyclic)

Everything else (branch collisions, stale locks, port conflicts, bootstrap retries, registry drift, debug-3-fail-block) is auto-handled.

## Resume

`/bypilot-sprint-driver --resume` reads `docs/.bypilot-state.json`:
- Skip pre-flight cleanliness check (worktrees may exist)
- Skip tasks already `done`
- Re-run any `in_progress` (likely interrupted) — implementer is idempotent because branches/worktrees are stable
- Pick up from the epoch the state file points to
- Re-acquire the bypilot lock

`--resume --auto` is the primary headless re-entry point used by `bypilot-loop.sh`.

## KESİN KURALLAR

1. **Push asla yok.** Her şey worktree'de commit; push insanın işi.
2. **3-deneme limiti.** Aynı task için debug 3 kere fail → blocked (snapshot'lı).
3. **Worktree'leri otomatik silme.** Push edilmemişse dokunulmaz; `housekeeping.mjs` ayrı bir komut.
4. **Frontend touch → Playwright zorunlu.** Coverage yoksa task BLOCKED + e2e-spec follow-up task.
5. **Implementer'lar `git worktree add` ÇAĞIRMAZ.** Sadece `worktree-manager.mjs acquire` çıktısını kullanır.
6. **Context-broker bypass yok.** Her task fresh neighborhood ile spawn olur; boş neighborhood → blocked.
7. **TaskList her zaman güncel** — kullanıcı CLI'da progress'i görür.
8. **Token tracking** — her sub-agent çağrısı sonrası `state.json`'a `tokensIn/Out/duration` ekle.
9. **Self-fix önce snapshot.** `auto-fix-snapshot` sınıfında recovery-points çağrısı atomic. Crash → snapshot kalır.
10. **`--auto` modda soru yok.** `AskUserQuestion` çağırırsan auto-mode kontratını bozarsın.

## Sıkıştığında

- Wave-picker / scheduler `cycle` döndürdü → `self-fix-policy --kind dag-cycle` ile sınıflandır
- Bootstrap fail (DATABASE_URL eksik) → halt, refer to /bypilot-setup
- Implementer `blocked` döndü → mark blocked via commit-task-state, slot serbest, devam
- Tüm slot'lar `blocked` → halt, escalate to harness-optimizer ("planner output broken?")
- Test-runner `bootstrap incomplete` → bootstrap.sh idempotency bug; retry once, then escalate
- Recovery-points yazımı fail → log warn, devam (best-effort); ama destructive op'u atla
- Worktree-manager `acquire` collision-free name bulamadı → halt (8 attempts exhausted = sistemik problem)

## Bitti sayılan durum

- All pending tasks across all active sprints either `done` or `blocked` (with reason)
- `docs/.bypilot-state.json` `completedAt` set
- Final report shown (interactive) or logged (auto)
- TaskList all completed
- decisions.log has every done task's summary + every self-fix entry
- Lock released
