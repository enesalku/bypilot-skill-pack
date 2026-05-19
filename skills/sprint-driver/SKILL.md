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

### Step 0.5 — Inbox tarama (Telegram komutları, her iterasyon)

Telegram aktifse `.bypilot/telegram-inbox.jsonl`'ı her wave başında oku:

```
INBOX=$(Agent({
  subagent_type: "notifier-broker",
  description: "Check Telegram inbox",
  prompt: `mode: inbox-poll, sinceCursor: "${state.lastInboxCursor || ''}"`
}))
```

Yeni komutlar varsa işle:

| Komut | Aksiyon |
|---|---|
| `/stop` | Loop sonlanır — graceful: save-resume.mjs + worktree lock release + Telegram "🛑 durduruldu" yanıtı |
| `/clear` | save-resume.mjs + clean exit (exit 0). `bypilot-loop.sh` wrapper fresh session başlatır (context wipe + --resume) |
| `/status` | Fire-and-forget bridge `send` ile: current wave, busy tasks, ETA |
| `/continue` | Default — noop, döngü zaten devam ediyor |
| `/reply <text>` | Pending ask-and-wait varsa fallback — context'e enjekte; yoksa decisions.log'a not düşülür |
| `/start-pipeline <goal>` | Sprint-driver kabul etmez — bu komut wrapper-level (bypilot-loop.sh), driver ignore eder ve "⚠️ pipeline ortasında yeni başlatılamaz" döner |

Inbox temizliği: işlenen entry'ler `consume-command` ile işaretlenir, dosyadan silinmez (audit trail).

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

### Step 2 — TaskCreate UI tracking + Linear `In Progress`

For each task in claim, `TaskCreate({ subject, description, activeForm })`. Set in_progress just before its implementer spawns.

**Linear sync (in-progress):** if task has `linearIssueId` and `integrations.linear.enabled`:

```
Agent({
  subagent_type: "linear-broker",
  description: "Linear in_progress " + taskId,
  prompt: `mode: set-status, linearId: "${task.linearIssueId}", bypilotStatus: "in_progress"`
})
```

Tek atış; broker noop dönerse pipeline devam eder.

### Step 3 — Context-broker (parallel, MANDATORY)

Each task MUST get a fresh neighborhood brief. No shortcut. Single Agent batch:

```
Agent({
  subagent_type: "context-broker",
  description: "Brief for " + taskId,
  prompt: `Build neighborhood for task ${taskId}.
    Read: docs/CONTEXT.md, docs/decisions.log (last 30 lines — CRITICAL: pick up commits from sibling tasks committed since this driver started),
    docs/sprint-*/tasks.json (find downstream of ${taskId}),
    docs/sprint-*/requirements.json (REQ traceability — bu task hangi REQ'lere katkı yapacak),
    .bypilot/recovery-log.jsonl (last 5 entries),
    git log --oneline -15.
    Living Contract pass: oku tüm .subscribes path'lerini, .creates.contract varsa not düş, .mustIntegrate'i en üste yerleştir, .affects etiketleriyle sibling task'ları listele.
    Return JSON: { neighborhood, relatedDownstream, parallelTouchedFiles, waitingForContracts, subscribedContracts, affectsTags }`
})
```

**`waitingForContracts` non-empty ise:** task'ı bu wave'de SPAWN ETME. Onu pending'e geri al; yazıcı bittiğinde re-claim (Step 1'in claim mantığı bunu sibling-done sinyaliyle yakalar).

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

  ## Subscribe edilen kontratlar (Living Contracts)
  Snapshot zaten neighborhood'da yukarıda. Edit/write yapmadan önce bu kontratları izle. mustIntegrate dolu ise direktifi uygula.

  ## Reporting kontrat
  Done JSON'unda **şu alanları doldur:**
  - integratedWith: subscribes'tan hangilerini wire ettin (yoksa [] ama o zaman task auto-blocked)
  - contractsAuthored: creates.contract varsa ilk commit'te yazıldığını teyit et (path)
  - affectsHandled: affects etiketlerinden hangi feature'ları gerçekten dokunduğun

  Return JSON: { status, commitHash, filesChanged, summary, integratedWith, contractsAuthored, affectsHandled, blockedReason? }`
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
    Frontend touched: ${task.scope === "coiffure" || frontendTouchedFiles}
    Smoke URL (if frontend): ${task.smokeUrl || guessFromFiles(task.files)}
    Task: { id: "${task.id}", linearIssueId: "${task.linearIssueId || ''}" }

    ## Discipline (NON-NEGOTIABLE)
    1. vitest, tsc, AND playwright must all pass.
    2. If task touched any of: apps/coiffure/**, apps/app/**, packages/ui/**,
       packages/shared/src/pages/** → playwright spec is REQUIRED.
       If no playwright spec exists for the touched route, this run FAILS
       (driver will then create an e2e-spec follow-up task).
    3. integrations.json.playwrightMcp.enabled && frontend touched && testDepth in
       (happy-path|comprehensive) → also run MCP live smoke (advisory).

    Return JSON: { ok, vitest, tsc, playwright, durations, envIssues, frontendTouched, linearPayload }`
})
```

Test-runner Linear MCP'ye doğrudan yazmaz; `linearPayload` alanını doldurur. Step 7'de driver bunu `linear-broker mode: comment` ile forward eder. screenshot path verilmişse comment markdown'ında embed edilir.

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

### Step 6.7 — Integration sanity (commit ÖNCESİ, Sprint-9 audio gap önleme)

Implementer done JSON'unu döndü, test-runner yeşil. Commit etmeden ÖNCE:

```bash
# Task'ın affects etiketi var mı?
HAS_AFFECTS=$(jq -r ".tasks[] | select(.id == \"$TASK_ID\") | .affects | length" "docs/$SPRINT_DIR/tasks.json")

# Implementer integratedWith doldurdu mu?
IMPL_INTEGRATED=$(echo "$IMPL_DONE_JSON" | jq -r '.integratedWith | length')

if [ "$HAS_AFFECTS" -gt 0 ] && [ "$IMPL_INTEGRATED" -eq 0 ]; then
  # Affects var ama integratedWith boş — task component yarattı/etkiledi ama hiçbir sibling kontratına bağlanmadı
  # Implementer'a TEK bir geri dönüş şansı ver (mid-task reprompt):
  RETRY_JSON=$(Agent({
    subagent_type: "<scope>-implementer",
    description: "Integration retry for " + task.title,
    prompt: `Önceki implementasyonun affects etiketinde [${affectsList}] gözüküyor ama integratedWith boş döndün.
      Sprint-9'da bu hata pilot widget'taki audio butonu eksik kalmasına yol açtı.

      Şu sibling task'ları kontrol et: ${siblingsWithSameAffects}
      Onlara bağlanan bir entegrasyon noktası var mı? Varsa şimdi yap, integratedWith'i doldur ve döndür.
      Yoksa, "integration not applicable: <neden>" açıklamasıyla integratedWith: ["not-applicable:<sebep>"] döndür.
      Worktree: ${worktreePath}
      Return JSON: { integratedWith, additionalCommitHash?, summary }`
  }))

  # Hâlâ boş ise → task auto-blocked, snapshot al, kullanıcıya bildir (telegram alert)
  if [ "$(echo "$RETRY_JSON" | jq -r '.integratedWith | length')" -eq 0 ]; then
    SKIP_REASON="affects:${affectsList} but no integration wired after retry"
    # commit-task-state ile blocked yaz, snapshot tag, slot serbest
    node .claude/skills/bypilot-sprint-driver/scripts/commit-task-state.mjs \
      --task "$TASK_ID" --status blocked \
      --reason "$SKIP_REASON" --epoch "$EPOCH_NUM"
    continue
  fi
fi
```

Bu adım Sprint-9 audio-gap hatasının kaynakta önlenmesidir: T4 affects:`audio-recording` etiketli, integratedWith boş kalmışsa, retry'da "PilotComposer'a bağladın mı?" diye sorulur; hâlâ bağlanmamışsa task blocked, manuel inceleme.

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

**Yeni — ContractChanged Mailbox enjeksiyonu (paralel kayıp önleme):**

Eğer biten task `creates.contract` veya bu pattern'a uyan bir dosya edit ettiyse, **subscribe eden sibling task'ların worktree'sine kontratın güncel halini yaz + agent'ın bir sonraki tool call'unda görmesi için `.bypilot-contract-changed.jsonl` (append-only) ekle:

```bash
# Bu task hangi kontratları yazdı/değiştirdi?
TOUCHED_CONTRACTS=$(echo "$FILES_JSON" | jq -r '.[]' | grep -E '\.contract\.(ts|md|json)$' || true)

for CONTRACT in $TOUCHED_CONTRACTS; do
  # Kim subscribe ediyor?
  SUBSCRIBERS=$(jq -r ".tasks[] | select(.subscribes // [] | index(\"$CONTRACT\")) | select(.status == \"in_progress\") | .id" "docs/$SPRINT_DIR/tasks.json")

  for SUB_ID in $SUBSCRIBERS; do
    SUB_WT=$(jq -r ".tasks[] | select(.id == \"$SUB_ID\") | .worktreePath" "docs/$SPRINT_DIR/tasks.json")

    # 1) Kontratın yeni snapshot'ını sib worktree'ye kopyala (read-only reference)
    mkdir -p "$SUB_WT/.bypilot-mailbox"
    cp "$CONTRACT" "$SUB_WT/.bypilot-mailbox/$(basename $CONTRACT)"

    # 2) Append event log — implementer'ın notifier-broker prompt'una takipte enjekte edilecek
    echo "{\"event\":\"ContractChanged\",\"from\":\"$TASK_ID\",\"contract\":\"$CONTRACT\",\"ts\":\"$(date -u +%FT%TZ)\"}" \
      >> "$SUB_WT/.bypilot-mailbox/inbox.jsonl"

    # 3) Notifier-broker üzerinden mid-flight inject (async) — implementer hâlâ çalışıyorsa
    Agent({
      subagent_type: "notifier-broker",
      description: "ContractChanged inject for " + SUB_ID,
      prompt: `mode: agent-inbox-inject
        agentId: "${SUB_ID}"
        kind: "ContractChanged"
        contractPath: "${CONTRACT}"
        contractBody: <inline snapshot, max 3KB>
        ts: "${ISO}"`
    })
  done
done
```

**Not — `mode: agent-inbox-inject`:** notifier-broker'ın yeni alt-modu (broker güncellemesi gerekli). İlk fazda fallback olarak `.bypilot-mailbox/inbox.jsonl`'a yazmak yeterli — implementer her tool call öncesi bu dosyayı kontrol etmek zorunda (context-broker bunu prompt'a injekte ediyor).

**Linear sync (done / blocked):** if `task.linearIssueId` and `integrations.linear.enabled`, ONE broker call per task — never per attempt:

```
# Status transition first
Agent({
  subagent_type: "linear-broker",
  prompt: `mode: set-status, linearId: "${task.linearIssueId}", bypilotStatus: "${task.status}"`
})

# Then ONE comment summarizing the outcome
if (task.status === "done") {
  body = `**${task.id}** — ${task.title}

- commit: \`${commitHash}\`
- worktree: \`${worktreePath}\`
- branch: \`${branchName}\` (push pending — manual)
- testDepth: ${task.testDepth}
- tests: vitest ${vitestN} ✓ · tsc ✓ · playwright ${playwrightN} ✓
- duration: ${durationMin}m
- summary: ${summary}`
  Agent({ subagent_type: "linear-broker", prompt: `mode: comment, linearId: ..., kind: "test-result", body: <above>` })
}

if (task.status === "blocked") {
  body = `**${task.id}** — ${task.title}

- attempts: 3
- root causes seen: ${prevAttempts.map(a => a.rootCause).join('; ')}
- last failing log (tail 40):
\`\`\`
${failureLogTail}
\`\`\`
- snapshot tag: ${snapshotTag}
- next action: human review needed`
  Agent({ subagent_type: "linear-broker", prompt: `mode: comment, linearId: ..., kind: "blocker", body: <above>` })

  // Telegram immediate alert (fire-and-forget; pipeline durmaz)
  ALERT="⛔ *${task.id} BLOKE*\n\n${task.title}\n\nNeden: ${prevAttempts[2].rootCause}\nSnapshot: \`${snapshotTag}\`\n\nManuel inceleme gerekli."
  bash -c "nohup node .claude/skills/bypilot-sprint-driver/scripts/telegram-bridge.mjs send --text \"${ALERT}\" > /dev/null 2>&1 &"
}
```

Comment volume disiplini: her task için maks **1 status-set + 1 comment**. Debugger retry'larında ek Linear çağrısı yok.

Remove the task from `busyTasks`, free the slot, increment `epochCompleted`, jump to Step 7.5 (SID-judge wave-end) and back to Step 1.

### Step 7.5 — SID-judge wave-end check (semantic conflict, ZORUNLU)

Bir wave'in tüm slot'ları tamamlandığında (yani `busyTasks.length === 0` veya epoch boundary tetiklenmek üzere), commit-state Linear sync zaten yapıldı ama epoch UI'sı çıkmadan ÖNCE:

```
JUDGE=$(Agent({
  subagent_type: "sid-judge",
  description: "SID check wave-end",
  prompt: `mode: wave-end
    sprintFolder: "${SPRINT_FOLDER}"
    waveTasks: ${JSON.stringify(waveDoneList)}
    currentContracts: ${JSON.stringify(contractsMap)}  // path -> body
    requirements: ${JSON.stringify(reqsArray)}`
}))
```

JUDGE çıktısına göre:

| `shouldCommitAsIs` | Aksiyon |
|---|---|
| `true` | Step 8'e geç (epoch check / UI). Drift yok. |
| `false` + `shouldRetry: [...]` | Her retry hedefini sırayla **mid-task reprompt** ile re-spawn et (max 2 retry-cycle). Retry sonra SID-judge tekrar koş. |
| `false` + `shouldBlock: [...]` | 2 retry sonrası hâlâ drift varsa o task'ları `commit-task-state --status blocked --reason "sid-drift: ${kind}"` ile bloke et, snapshot tag, kullanıcıya Telegram alert (`kind: sid-blocker`). |

Retry prompt'u, JUDGE'ın `suggestedAction`'ı + ilgili drift kartı:

```
Agent({
  subagent_type: "<scope>-implementer",
  description: "SID retry: " + driftKind,
  prompt: `Wave-end SID-judge bir drift tespit etti:
    Kind: ${drift.kind}
    Evidence: ${drift.evidence}
    Suggested action: ${drift.suggestedAction}
    Worktree: ${worktreePath}

    Bu drift düzeltilmeden task done sayılmıyor. Suggested action'ı uygula, kontratı/kodu güncelle, ek commit at, integratedWith'i güncelle.
    Return JSON: { fixed, additionalCommitHash, integratedWith, summary }`
})
```

SID-judge tek bir wave-end başına maksimum **2 retry-cycle** koşturur. Bu çerçeve Voyager-style "bounded retry" kuralından gelir — sonsuz loop tehlikesi yok.

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

### Step 8.5 — Acceptance Verification Gate (ZORUNLU, Step 9 öncesi)

`pending === 0 && in_progress === 0` koşulu sağlandı ama henüz **sprint kapanmadı**. Önce kullanıcı isterleri karşılandı mı diye kontrol et.

```bash
# requirements.json var mı?
REQ_PATH="${SPRINT_FOLDER}/requirements.json"
if [ ! -f "$REQ_PATH" ]; then
  echo "[bypilot:sprint-driver] WARNING: requirements.json yok — bu sprint elicitor adımını atlamış. Verifier atlanıyor; eski davranışla devam."
  # Step 9'a atla; geriye dönük uyumluluk
else
  echo "[bypilot:sprint-driver] Step 8.5 — acceptance verification"
fi
```

requirements.json varsa verifier çalışır:

```
VERIFY=$(Agent({
  subagent_type: "requirements-verifier",
  description: "Sprint acceptance verification",
  prompt: `mode: sprint-end
    sprintFolder: "${SPRINT_FOLDER}"
    requirements: <docs/sprint-N/requirements.json'dan oku>
    userOriginalPrompt: <requirements.json.userOriginalPrompt>
    doneTasks: <tasks.json status=done liste, includes summary, commitHash, linksRequirement>
    blockedTasks: <tasks.json status=blocked liste>
    playwrightSpecs: <find e2e/sprint-${N}/ -name '*.spec.ts'>
    playwrightScreenshots: <find test-results -name '*.png' -mmin -180>
    integrations: { visionVerify: <.bypilot/integrations.json.visionVerify> }`
}))
```

Verifier `gateDecision` döndü:

| Decision | Aksiyon (interactive) | Aksiyon (auto) |
|---|---|---|
| `PASS` | Step 9'a geç (sprint kapanır) | Step 9'a geç |
| `PARTIAL` | AskUserQuestion: "X CONCERNS var. (a) Sprint'i kapat ve follow-up sprintle hallet, (b) Şimdi mini-wave ile çöz, (c) WAIVED işaretle." | Otomatik (b) — mini-wave koş, sonra retry |
| `FAIL` | AskUserQuestion: "Y FAIL var. (a) Otomatik follow-up wave koş, (b) Halt + manuel inceleme." | Otomatik (a) — bounded retry |

**Retry mekanizması (Voyager bounded retry):**

```bash
RETRY_COUNT=$(node -e "console.log(state.acceptanceRetryCount || 0)")

if [ "$VERIFY_DECISION" = "FAIL" ] && [ "$RETRY_COUNT" -lt 1 ]; then
  # Follow-up task'ları tasks.json'a append et
  for FT in $(echo "$VERIFY" | jq -c '.followUpTasks[]'); do
    node .claude/skills/bypilot-sprint-driver/scripts/append-followup-task.mjs \
      --task "$FT" --sprint "${SPRINT_FOLDER}"
  done

  # State'e retry counter yaz
  node -e "state.acceptanceRetryCount = (state.acceptanceRetryCount||0)+1; saveState()"

  # Step 1'e dön — mini-wave başlasın
  GOTO Step 1
fi

if [ "$VERIFY_DECISION" = "FAIL" ] && [ "$RETRY_COUNT" -ge 1 ]; then
  # İkinci kez fail — halt + insan eskalasyonu (Voyager kuralı: bounded retry)
  TG_ALERT="🛑 *Sprint-${N} acceptance FAIL (2. tur)*\n\n$(echo $VERIFY | jq -r .rationale)\n\nManuel inceleme gerekli — verifier raporu: docs/sprint-${N}/verification.md"
  nohup node .../telegram-bridge.mjs send --text "$TG_ALERT" > /dev/null 2>&1 &

  # decisions.log + verification.md persist
  echo "$VERIFY" > "${SPRINT_FOLDER}/verification.md.json"
  # halt — Step 9'a geçmez, sprint açık kalır
  exit 1
fi
```

Verifier raporu `docs/sprint-${N}/verification.md` olarak yazılır (her zaman, gateDecision farketmez). sprint-narrator Step 9'da bu dosyayı okuyup raporuna entegre eder.

### Step 9 — Sprint complete

When `pending === 0 && in_progress === 0` **AND verifier `PASS` (veya kullanıcı manuel onayladı)**:

```bash
node .claude/skills/bypilot-sprint-driver/scripts/recovery-points.mjs tag \
  --reason "sprint-complete" --message "all tasks done/blocked"
node .claude/skills/bypilot-sprint-driver/scripts/save-resume.mjs --note "sprint complete"
node .claude/skills/bypilot-sprint-driver/scripts/worktree-manager.mjs release-lock
```

**Linear sync (sprint summary):** if `integrations.linear.enabled`:

```
Agent({
  subagent_type: "linear-broker",
  description: "Linear sprint summary",
  prompt: `mode: sprint-summary
    sprint: "${sprintSlug}"
    doneIds: [<linearIds of done tasks>]
    blockedIds: [<linearIds of blocked tasks>]
    canceledIds: [<linearIds of canceled tasks>]
    addedIds: [<linearIds of tasks added DURING this sprint by debugger follow-ups e.g. e2e-spec-*>]
    projectName: "${linearProject}"
    durationMin: ${totalMin}`
})
```

Broker tek bir rollup comment yazar (en eski done issue'a) — sprint başına bir kez. Pipeline (`/bypilot-pipeline`) bittiğinde **ek olarak** pipeline-level summary de aynı broker üzerinden milestone'a yazılabilir.

**Telegram öğretici rapor (sprint-narrator):** if `integrations.telegram.enabled`:

```
Agent({
  subagent_type: "sprint-narrator",
  description: "Sprint <N> educational report",
  prompt: `mode: sprint-complete
    sprint: "${sprintSlug}"
    doneTaskIds: [...]
    blockedTaskIds: [...]
    canceledTaskIds: [...]
    addedDuringRun: [...]
    totalDurationMin: ${totalMin}
    totalTokensK: ${totalTokensK}
    frontendTouchedFiles: [...]`
})
```

Narrator kendi içinde:
1. `docs/sprint-<N>/sprint-report.md` yazar (her zaman, Telegram'dan bağımsız)
2. Frontend touch varsa `docs/sprint-<N>/test-guide.md` yazar
3. `notifier-broker` üzerinden:
   - Inline teaser mesajı
   - sprint-report.md sendDocument
   - test-guide.md sendDocument (varsa)
   - Opsiyonel `send-with-actions` (next pipeline önerisi)

Bu çağrı sprint-driver'ın **son adımı** — Step 9 cleanup bittikten sonra. Pipeline akışı zaten bitmiş; rapor üretimi onu bölmüyor. Eğer eş zamanlı başka sprint koşacaksa (multi-sprint manifest), driver narrator'ı `nohup ... &` ile background'a atabilir.

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

## Interactive AskUserQuestion routing (Telegram-aware)

Sprint-driver `interactive` veya `ask-gates-wizard` modunda iken bir `AskUserQuestion` gerektiren karar noktası varsa:

```
if (mode === "interactive" && integrations.telegram?.enabled) {
  // 1. Önce Telegram'a yolla, 10 dk bekle
  RESULT = Agent({
    subagent_type: "notifier-broker",
    description: "Ask via Telegram",
    prompt: `mode: ask-and-wait
      questionId: "${qId}"
      text: "${questionText}"
      choices: [{label: "...", value: "..."}, ...]
      timeoutSec: 600`
  })

  if (!RESULT.timeout) {
    answer = RESULT.answer
  } else {
    // 2. Timeout — terminal AskUserQuestion fallback
    answer = AskUserQuestion(...)
    // 3. Telegram'a "timeout — terminal'e düştü" notu yolla
    bash -c "nohup node .../telegram-bridge.mjs send --text '⏰ 10 dk cevap gelmedi — terminale düştüm. Cevap: ${answer}' &"
  }
}

if (mode === "auto") {
  // Hiç sorma. Auto contract.
}
```

Bu routing sadece kritik karar noktalarında çalışır (örn. `--ask-gates` wizard, blocker noktasında "devam mı dur mu?"). Her iterasyonda değil.

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
| `halt` | Snapshot tag, save state, surface to user with full context. **Telegram aktifse**: fire-and-forget alert (kind=halt) + bekleyen aksiyonu net yaz. |

Halt durumunda terminal'e basılan mesaj ek olarak Telegram'a da düşer:

```bash
# Halt anında — sprint-driver'ın halt branch'inde
HALT_MSG="🛑 *bypilot HALT*\n\nNeden: ${haltReason}\nSnapshot: \`${snapshotTag}\`\n\nSenin aksiyonun: ${nextStep}\n\n/continue veya /clear ile devam ettir."
nohup node .claude/skills/bypilot-sprint-driver/scripts/telegram-bridge.mjs send --text "$HALT_MSG" > /dev/null 2>&1 &
```

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
11. **Linear MCP çağrısı sadece linear-broker üzerinden.** Sprint-driver kendi başına `mcp__linear__*` çağırmaz; broker noop dönerse pipeline devam eder.
12. **Linear comment volume disiplini.** Task başına max 1 status-set + 1 comment. Retry'lar, epoch boundary'leri Linear'a yansıtılmaz; sadece kesin state geçişleri.
13. **Telegram fire-and-forget kuralı.** Alert/halt/blocker bildirimleri pipeline'ı bekletmez — `nohup ... &` ile background. ask-and-wait sadece interactive mode'da senkron çalışır; --auto'da hiç çağrılmaz.
14. **Sprint raporu akışı bölmez.** sprint-narrator çağrısı Step 9 sonunda; pipeline zaten bitmiş olur. Multi-sprint manifestinde sıradaki sprint başlamadan önce narrator'ı `&` ile background'a at.
15. **`subscribes` dolu task yazıcı bitmeden başlamaz.** context-broker `waitingForContracts` döndürdüyse task pending'e geri alınır; yazıcı task biter bitmez slot-free event tetiklenir ve bu task re-claim edilir.
16. **`creates.contract` task'ı ilk commit'inde kontratı yazmadan ikinci edit yapamaz.** Implementer prompt'unda bu zorunlu kısım olarak vurgulanır.
17. **`integratedWith` boş ama `affects` dolu → auto-blocked.** Step 6.7 retry zaten verir; ikinci pas boşsa task blocked, snapshot, kullanıcı bilgilendirilir.
18. **ContractChanged event Mailbox-style enjekte edilir.** Sibling worktree'lerin `.bypilot-mailbox/inbox.jsonl`'ı güncellenir + notifier-broker `agent-inbox-inject` ile mid-flight bilgilendirir.

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
