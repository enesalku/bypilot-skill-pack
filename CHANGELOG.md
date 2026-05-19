# Changelog

## [0.2.2] — 2026-05-19 (Sprint-14 öğrenimleri)

### Vision verify pre-flight + mock infrastructure regression guards

Sprint-12+13+14 boyunca vision verify üç kez **false-FAIL** üretti (kod doğru, test env yanlış). Bu pattern v0.2.2'de skill-pack'e işlenir:

**Requirements-verifier rubric güncellemesi**
- `agents/reviewer/requirements-verifier.md`: vision FAIL kararı vermeden önce 3-adımlı **test infrastructure pre-flight** zorunlu hâle getirildi:
  1. **Dev server age check** — Playwright koşumundan önce başlatılan dev server son commit'ten önce mi? PID alive ama git HEAD farklıysa "stale-server" işaretle, FAIL yerine CONCERNS ver.
  2. **Mock fixtures health** — mock-pilot-server (veya benzeri mock) son sprint'te eklenen request shape'lerini destekliyor mu? `tests/mock-pilot-server.test.mjs` regression suite mevcutsa onun PASS olduğunu doğrula.
  3. **DB seed presence** — authenticated tenant için seed satırları DB'de mi (seed-test-data.mjs idempotent koşumu).
- Bu üçü yeşilse vision FAIL gerçek kod bug'ıdır; biri eksikse infrastructure CONCERNS + remediation önerisi.

**Sprint-14 vakası — silent test infrastructure debt pattern**
- Pilot widget attachment dispatch yolunda multipart/form-data kullanıyor; tüm body field'larını TEK `payload` field'ında JSON.stringify edip files'ı ayrı part'larda gönderiyor.
- Test fixture (mock-pilot-server) Sprint-9'da attachment desteği eklendiğinde güncellenmemişti — sadece `JSON.parse(postData)` yapıyordu.
- Sprint-12 vision verify "Pilot Anlamadım dedi" gördüğünde gerçek bug değildi: mock'un fallback'ine düşüyordu. Sprint-14'te düzeltildi (multipart parser + payload unwrap).
- **v0.2.2 öğrenimi:** Bir feature attachment/multipart/SSE gibi yeni request shape'i eklediğinde, **mock-server fixture'ı da aynı PR'da güncellenmeli**. Living Contract'a benzer "mock-fixture-author" rolü.

**Documented in `agents/reviewer/requirements-verifier.md` Step 2d kuralı:**
- "Vision evidence'da kullanıcının mesajını yutan generic bir cevap (örnek: 'Anlamadım', 'Daha açık ifade et') gördüğünde → mock-fixture fallback'i ihtimalini incele, FAIL damgası vermeden önce postData shape'i (JSON vs multipart) ile mock parser uyumunu kontrol et."

**v0.2.2 yeni file (gelecek consumer projeler için template):**
- `templates/mock-pilot-server.test.mjs.example` — consuming projelerde mock-server'ın multipart + JSON parse + scenario matching'ini doğrulayan minimal regression suite.

### Yeni follow-up notları (v0.3.0)
- `skills/sprint-driver/scripts/bootstrap-worktree.sh` stale-process detection: dev server PID alive ama `git rev-parse HEAD` farklı dosyalara ait commit'lerin önündeyse "restart önerilir" uyarısı.
- `bypilot-skill-pack-snapshot.json` her sprint sonunda — vision verify dengesini izlemek için (false-FAIL oranı sprint'ten sprint'e nasıl evrildi).

## [0.2.1] — 2026-05-18 (Sprint-12 canary)

### Added — Vision verify altyapı çalışıyor + e2e stream timeout savunma

Sprint-11 canary'sinde keşfedilen 4 boşluğu kapatır.

**Bootstrap dev server (REQ-1)**
- `skills/sprint-driver/scripts/bootstrap-worktree.sh` Step 7 (opt-in via `BYPILOT_BOOTSTRAP_START_DEV=1`): Vite + Nuxt dev server arkaplanda başlatılır, PID `.bypilot-dev/dev.pid`, log `.bypilot-dev/dev.log`. Sağlık kontrolü 60 sn timeout. Idempotent.
- Daha önce silent fail oluyordu (Vision verify canlı koşumu yapılamıyordu).

**Test DB seed helper (REQ-2)**
- `skills/sprint-driver/scripts/seed-test-data.mjs` — authenticated test user'ı için chatbot/contact/account_integrations seed eder. Idempotent: mevcutları korur. `--dry-run` (default), `--execute`, `--cleanup`, `--account=<UUID>` modları.
- `contracts/test-env-seed.contract.md` (Living Contract) — seedAuthenticatedAccount + cleanupSeededData API'lerini Sprint-12 T6 ve sonrası için garanti eder.
- Connection user = db owner (postgres); migration 0035'in service_role GRANT eksiği nedeniyle SET LOCAL ROLE service_role kullanılmıyor.

**Verifier vision-skip CONCERNS (REQ-3)**
- `agents/reviewer/requirements-verifier.md` — `visionVerifyStatus: skipped-no-screenshots` + `REQ.userVisible: true` artık otomatik PASS değil **CONCERNS**. Sprint-11 silent-fail pattern'i tekrarlanmaz.
- Output JSON'a `visionVerifyStatus` alanı eklendi (`passed | skipped-no-screenshots | vision-disabled | partial`).
- Karar tablosuna yeni satır: skipped-no-screenshots + userVisible → CONCERNS.

**E2e implementer scope daraltma (REQ-4)**
- `agents/implementer/e2e-implementer.md` testDepth tablosu güncellendi: `comprehensive` artık **max 3 senaryo**. KESİN KURAL #13 eklendi: tek dosya, max 3 senaryo; ötesi task-composer auto-split alanı.
- `agents/planner/task-composer.md` KESİN KURAL #10 eklendi: scope=e2e + senaryo>3 → otomatik 2 parça (`<id>-a` smoke/happy, `<id>-b` edge cases, `dependsOn: [a]`).
- Sprint-11 T7 stream-idle timeout (~13 dk) pattern'i bu sayede önlenir.

### Bilinen sınırlamalar
- Vision verify gerçek canlı koşum (Sprint-11 8 REQ × screenshot) Sprint-12 T6'da yapılıyor. Bu CHANGELOG girdisi T6 öncesi yazıldı.

## [0.2.0-alpha.1] — 2026-05-14

### Added — Requirement Lifecycle + Living Contract + Acceptance Gate

This release closes the "Sprint-9 audio gap" pattern: parallel tasks losing each other's features, and sprint-end declared "done" while user-visible requirements were silently unmet. Three layered defenses:

**Requirements skill (Faz-A — kullanıcı zorunlu interactive)**
- `skills/requirements/SKILL.md` — `/bypilot-requirements` skill: user's free text → Türkçe behavioral acceptance contract. Mandatory in `/bypilot-plan` step 0.3.
- `agents/planner/elicitor.md` — BMAD Advanced-Elicitation adaptation. 8-lens menu (Six Thinking Hats, Pre-mortem, Inversion, Red Team / Blue Team, Socratic Questioning, Stakeholder Mapping, First Principles, Analogical Reasoning). Even in `--auto` mode, requires single final user-approval AskUserQuestion gate. AI cannot self-approve.
- `schemas/requirements.schema.json` — REQ id pattern (REQ-N), userVisible boolean, linkedTasks, verificationHints, ambiguityFlag, originLens. `userOriginalPrompt` field preserves the raw text verbatim for intent-drift detection.

**Living Contract coordination (Faz-B-i — paralel kayıp önleme)**
- `schemas/tasks.schema.json` — new task fields: `linksRequirement[]`, `creates.contract`, `creates.contractExports[]`, `subscribes[]`, `mustIntegrate`, `affects[]`, `integratedWith[]`.
- `agents/planner/task-composer.md` — Step 2.5 (requirement traceability invariant — every userVisible REQ ≥1 linked task) + Step 2.6 (contract assignment, single-author rule).
- `agents/orchestrator/context-broker.md` — new Step 5.3 (read subscribed contract files current state into neighborhood), 5.6 (contract-author directive injected as "mandatory first commit"), 5.7 (`mustIntegrate` placed at top of neighborhood — implementer cannot miss it), 5.8 (affects siblings listing). Returns `waitingForContracts` to driver — task not spawned until author commits.
- `skills/sprint-driver/SKILL.md` — Step 3-4-7 updated. Step 4 implementer prompt now requires `integratedWith`, `contractsAuthored`, `affectsHandled` in done JSON. Step 6.7 (new) — auto-block if `affects` non-empty but `integratedWith` empty after one retry. Step 7 — ContractChanged Mailbox-style injection into sibling worktrees (`.bypilot-mailbox/inbox.jsonl` + notifier-broker `agent-inbox-inject` mode).
- `agents/orchestrator/sid-judge.md` (new, Haiku) — wave-end Semantic Intent Divergence judge. 5 drift classes: causal-violation, contract-orphan, subscribed-but-stale, REQ-uncovered, affects-tag-mismatch. Bounded retry (max 2 cycles per wave) before block.

**Acceptance Verification Gate (Faz-B-ii — sprint-end final kapı)**
- `agents/reviewer/requirements-verifier.md` (new, Opus, executor ≠ verifier) — runs at Step 8.5 (Step 9 öncesi). Inputs: `userOriginalPrompt` (raw) + structured REQ rubric + done task summaries + Playwright spec list + Playwright screenshots. Per-REQ gate decision: PASS / CONCERNS / FAIL / WAIVED. BMAD TEA `trace` pattern + Voyager critic_agent + Devin acceptance rubric harmonization.
- Vision verification — when `integrations.visionVerify.enabled` and `REQ.userVisible: true`, verifier uses Read tool to load Playwright screenshots → multimodal Claude vision evaluates "does the UI in this screenshot match the REQ description?".
- `skills/sprint-driver/SKILL.md` Step 8.5 — verifier dispatch + bounded-retry policy. FAIL → auto-followup task append → mini-wave → re-verify (max 1 retry). 2nd FAIL → halt + Telegram human escalation.
- `verification.md` artifact written under `docs/sprint-<N>/` regardless of gate decision (sprint-narrator consumes).

**Setup**
- `skills/setup/SKILL.md` — `visionVerify` integration added to `.bypilot/integrations.json` template.

### Research-backed
- Living Contract pattern — Augment Code Coordinator-Implementor-Verifier, MetaGPT publish-subscribe message pool, Anthropic Agent Teams Mailbox primitive
- SID detection — academic *Semantic Consensus Framework* (arxiv 2604.16339): "Semantic Intent Divergence" — names exactly the Sprint-8/9 pattern (causal violation, etc.)
- Executor ≠ Verifier — Voyager ablation (NeurIPS 2024): verifier removal causes measurable performance drop; not optional
- Verifier input = raw + rubric — Voyager critic_agent uses raw task string; Devin uses acceptance rubric; combined approach more robust
- Bounded retry → halt — Voyager 4-attempt cap; Devin halt + refine pattern (no infinite loops)
- Vision verify — Playwright + multimodal LLM round-trip screenshot testing now production-standard

### Known limitations
- `agent-inbox-inject` mode in notifier-broker not yet implemented — fallback: `.bypilot-mailbox/inbox.jsonl` file write only. Context-broker reads it on respawn.
- `requirements-verifier` follow-up task append script (`append-followup-task.mjs`) referenced but not yet scripted — Step 8.5 currently calls it inline; can manual-append until F2.
- No tests for new agents yet (`tests/` still empty for these).

---

## [0.1.0-alpha.1] — 2026-05-10

### Added — F0 + F1 partial

**Identity & policy**
- `SOUL.md` — 7 core principles, end-to-end pipeline philosophy
- `RULES.md` — Must always / must never / commit & hook formats
- `AGENTS.md` — full agent catalog with 3 lanes (orchestrator, planner, runner) + 5 sub-roles
- `CLAUDE.md` — guidance for working *on* the package
- `MANIFEST.md` — release plan, F0–F8 phases
- `LICENSE` (MIT), `package.json`, `.gitignore`, `README.md`

**Skills (canonical surface)**
- `skills/sprint-driver/SKILL.md` — multi-sprint DAG orchestrator
- `skills/setup/SKILL.md` — one-shot prerequisite interview
- `skills/research/SKILL.md` — open-source feature mining (BMAD-inspired)
- `skills/plan/SKILL.md` — analyst → PM → architect → task-composer chain
- `skills/pipeline/SKILL.md` — runs setup → research → plan → run end-to-end

**Agents**
- Orchestrator: `loop-operator`, `wave-picker`, `context-broker`, `checkpoint-gate`, `harness-optimizer`
- Planner: `interviewer`, `analyst`, `pm`, `architect`, `task-composer`, `researcher`
- Implementer: `pilot-implementer`, `coiffure-implementer`, `api-implementer`, `e2e-implementer`
- Runner: `test-runner`, `debugger`
- Reviewer: `security-reviewer`
- Learner: `observer`

**Scripts**
- `skills/sprint-driver/scripts/wave-picker.mjs` — DAG resolver, cycle detection, critical-path priority, file-overlap conflict, parallel wave selection
- `skills/sprint-driver/scripts/port-allocator.sh` — API/DEV/PW port assignment
- `skills/sprint-driver/scripts/bootstrap-worktree.sh` — env, node_modules, .nuxt, webkit, storageState, port

**Hooks**
- `hooks/hooks.json` — registry (SessionStart, PreToolUse, PostToolUse, PreCompact, Stop, SessionEnd)
- `hooks/stop-gate.sh` — sprint-driver gate (red-test stop block)
- `hooks/pre-tool-observe.js` — 100% observation with secret sanitization

**Schemas & Manifests**
- `schemas/tasks.schema.json` — DAG fields (dependsOn, conflictsWith, scope, testDepth, prerequisitesNeeded)
- `schemas/sprints-manifest.schema.json`
- `schemas/instinct.schema.json` — continuous-learning v2.1 format
- `manifests/install-profiles.json` — minimal/core/full
- `manifests/install-modules.json` — 9 modules
- `manifests/install-components.json` — granular skill/agent/hook selection

**Docs**
- `docs/ARCHITECTURE.md` — component map + hook gating + ports + worktrees + multi-sprint

### Inspired by

- [Everything Claude Code (ECC)](https://github.com/affaan-m/everything-claude-code) — agent catalog, hook-based 100% observation, continuous-learning v2.1, GateGuard, manifest selective install
- [BMAD-METHOD](https://github.com/bmad-code-org/BMAD-METHOD) — analyst→PM→architect persona chain, Party Mode parallel multi-agent, workflow-as-markdown, customize.toml hierarchical override
- [anthropics/skills](https://github.com/anthropics/skills) — SKILL.md + scripts/ pattern, official frontmatter format
- [anthropics/claude-code](https://github.com/anthropics/claude-code) — marketplace plugin layout

### Not yet shipping (F2-F8)

See MANIFEST.md "Not yet shipping" section.

### Known limitations

- Implementer/reviewer agents are partial (only `security-reviewer` shipped; `pilot-reviewer` etc. TODO).
- Hook scripts: only `stop-gate.sh` and `pre-tool-observe.js` shipped; other hooks have registry entries only.
- `harness-optimizer` agent design done; patch-application flow TODO.
- Tkinter dashboard NOT shipped (design-only).
- BYPILOT_DOCS_DIR env var not yet honored by wave-picker.mjs.
- Zero tests in `tests/` yet.
