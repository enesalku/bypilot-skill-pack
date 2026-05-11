---
name: bypilot-setup
description: bypilot one-shot prerequisite interview before any bypilot work. Gathers API keys, account access, env files, test fixtures, secrets, and integration MCPs (Linear, Playwright) in a single front-loaded pass so /bypilot-sprint-driver never stops mid-flow asking for a key.
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
  - mcp__linear__list_teams
---

You are the **setup conductor**. Your job: before any other bypilot work runs, gather everything needed in **one interactive pass**. Never let `/bypilot-sprint-driver` stop later because a key is missing — find that out now.

## When to Use

- First time invoking bypilot in a project (no `.bypilot/setup.json` exists).
- The orchestrator surfaced a missing prereq (`/bypilot-sprint-driver` paused with "needs key: X").
- The user explicitly types `/bypilot-setup`.
- A bypilot orchestrator (`/bypilot-sprint-driver`, `/bypilot-pipeline`) detects missing prereqs.

## Process

### Step 1 — Detect existing state

Read these signals before asking anything:

```bash
# Project-level
[ -f .env ] && echo "root .env present"
[ -f .env.test ] && echo "test env present"
[ -f apps/api/.env ] && echo "api env present"
[ -f e2e/.auth/user.json ] && echo "cached auth storageState present"

# Project's claim of what it needs
[ -f .env.example ] && cat .env.example
[ -f apps/api/.env.example ] && cat apps/api/.env.example

# bypilot's own setup state
[ -f .bypilot/setup.json ] && cat .bypilot/setup.json
```

Build a missing-set: the difference between **what `.env.example` declares** and **what `.env` actually has**, plus any project-specific signals (e.g., for ByPilot: `vertex-sa.json`, `e2e/.auth/user.json`, `apps/api/.nuxt/tsconfig.app.json`).

### Step 2 — Invoke `interviewer` agent

Hand the missing-set to the interviewer agent. It builds **one** AskUserQuestion batch (max 4 questions, multi-select where useful), grouping prereqs by source so the user doesn't get peppered.

The interviewer always offers a `--auto` escape: "Skip this, fill from defaults, mark blocked tasks". In auto mode it sets reasonable defaults and writes a list of tasks-that-need-a-real-prereq into `.bypilot/setup-blockers.json`.

### Step 2.5 — Integration gate (Linear + Playwright MCP + Telegram)

bypilot first-class destekli üç entegrasyon: **Linear** (sprint/task aynası), **Playwright MCP** (canlı UI smoke), **Telegram** (bildirim + interaktif kontrol). Setup üçünü tek bir batch'te yoklar.

```bash
# Linear probe
PROBE_L=$(Agent linear-broker mode:probe)
LINEAR_OK=$(echo "$PROBE_L" | jq -r '.ok // false')

# Playwright MCP probe (tool varlık tespiti)
PW_OK=false
grep -q "mcp__playwright" .claude/.tool-cache.json 2>/dev/null && PW_OK=true

# Telegram probe — bridge script (token integrations.json'dan, henüz yoksa probe atlanır)
TG_OK=false
if [ -n "$(jq -r '.telegram.botToken // empty' .bypilot/integrations.json 2>/dev/null)" ]; then
  PROBE_T=$(node .claude/skills/bypilot-sprint-driver/scripts/telegram-bridge.mjs probe)
  TG_OK=$(echo "$PROBE_T" | jq -r '.ok // false')
fi
```

3 entegrasyon × 3 durum (var / yok-ekleyelim / yok-atla). Sonuç: max 3 soru AskUserQuestion batch'inde (multiSelect destekli). Eksikleri tek seferde topla:

Soru örnek (yalnızca eksik olanlar batch'e girer):

| Eksik | Soru | Kullanıcı seçenekleri |
|---|---|---|
| Linear | "Linear MCP bağlamak ister misin? bypilot sprint'leri ayna olur." | "Şimdi bağla" / "Sonra" |
| Playwright | "Playwright MCP yüklü değil. Frontend canlı smoke için ekleyelim mi?" | "Kurulum yönergesi göster" / "Geç" |
| Telegram | "Bildirim + uzaktan kontrol için Telegram bot bağlayalım mı?" | "Adım adım kur" / "Geç" |

**Telegram özel akış** ("Adım adım kur" seçilirse):

İkinci bir AskUserQuestion batch (sadece Telegram için):

```
Q1: "BotFather'dan yeni bot oluştur:
     1. Telegram'da @BotFather'a yaz: /newbot
     2. Bot adı: bypilot-<sen>
     3. Username: bypilot_<sen>_bot
     4. Sana verdiği token'ı (123456:ABC-...) buraya yapıştır."
input: free text → telegram.botToken

Q2: "Chat ID'ni öğren:
     1. Yeni botunla bir konuşma başlat — /start gönder.
     2. https://api.telegram.org/bot<TOKEN>/getUpdates aç.
     3. message.chat.id değerini buraya yapıştır."
input: free text → telegram.chatId
```

Sonra setup `telegram-bridge.mjs probe` çağırır:
- ✓ → `enabled: true`, persist
- ✗ → token/chatId tut ama `enabled: false`, lastAuthError yaz, kullanıcıya "token'ı tekrar kontrol et" mesajı

`--auto` modda Telegram setup atlanır (token'sız enabled false), `setup-blockers.json`'a `telegram-no-creds` notu düşer.

`AskUserQuestion` cevabı `evet` ise kullanıcıya MCP install talimatını ve yeniden run gerektirdiğini söyle. `hayır` ise enabled=false, ama gerekçeyi `integrations.json`'a yaz ki sonraki pipeline run'ı tekrar sormasın.

**Linear bağlı ise**, team/project/assignee'yi de bu adımda topla:

```
team = mcp__linear__list_teams(limit=10)
  → tek team varsa otomatik seç
  → birden fazla varsa AskUserQuestion ile sor
project = "ask-each-plan"   # kullanıcı kararı: her /bypilot-plan'de soruluyor
assignee = "me"             # default; kullanıcı override edebilir
```

`statusMap` default'u broker fallback'inden gelir (`pending→Todo, in_progress→In Progress, done→Done, blocked→Backlog, canceled→Canceled`). Kullanıcının özel mapping'i varsa `.bypilot/integrations.json`'u manuel edit edebilir.

Yazılacak dosya:

```json
{
  "linear": {
    "enabled": true,
    "team": "BYPİLOT",
    "teamId": "<uuid>",
    "project": "ask-each-plan",
    "assignee": "me",
    "sprintLabelTemplate": "Sprint-{N}",
    "statusMap": {
      "pending": "Todo",
      "in_progress": "In Progress",
      "done": "Done",
      "blocked": "Backlog",
      "canceled": "Canceled"
    },
    "lastVerifiedAt": "<ISO>"
  },
  "playwrightMcp": {
    "enabled": true | false,
    "tool": "mcp__playwright__browser_navigate",
    "frontendTouchSmokeRequired": true,
    "lastVerifiedAt": "<ISO>"
  },
  "telegram": {
    "enabled": true | false,
    "botToken": "<REDACTED-IN-LOGS>",
    "chatId": "<numeric chat id>",
    "botUsername": "@bypilot_xxx_bot",
    "askAndWaitTimeoutSec": 600,
    "commandsAllowed": ["/continue", "/stop", "/status", "/clear", "/reply", "/start-pipeline"],
    "reportFormat": "teaser-plus-attached-docs",
    "pollDaemon": {
      "spawnedBy": "bypilot-loop.sh",
      "lastSpawnedAt": null
    },
    "lastVerifiedAt": "<ISO>"
  }
}
```

Yazım yeri: `.bypilot/integrations.json`. setup.json'dan ayrı tutulur — çünkü integration durumu sıkça değişir, key'ler değişmez.

### Step 2.6 — Telegram poll daemon spawn (opsiyonel)

`telegram.enabled === true` ve daemon henüz çalışmıyorsa setup background daemon başlatır:

```bash
if [ "$(jq -r '.telegram.enabled' .bypilot/integrations.json)" = "true" ]; then
  if ! pgrep -f "telegram-bridge.mjs poll-daemon" > /dev/null; then
    nohup node .claude/skills/bypilot-sprint-driver/scripts/telegram-bridge.mjs poll-daemon \
      > /tmp/bypilot-telegram-poll.log 2>&1 &
    echo "{\"telegramPollDaemon\": \"spawned\", \"pid\": $!}" >> docs/decisions.log
  fi
fi
```

Daemon long-poll yapar (getUpdates timeout=25s) ve inbox dosyasına yazar. Maaliyet: bir node süreci, ~15MB RAM, ağ aktivitesi minimal.

Setup tamamlanınca kullanıcıya kısa bir Telegram "hoş geldin" mesajı atar:

```
🤖 *bypilot bağlandı*

Komutlar:
/continue · /stop · /status · /clear
/reply <metin> · /start-pipeline <hedef>

Raporlar ve uyarılar bu kanaldan gelir. Sprint sonu raporu inline + dosya olarak iletilir.
```

### Step 3 — Persist

Write `.bypilot/setup.json`:

```json
{
  "completedAt": "<ISO>",
  "mode": "interactive" | "auto",
  "providedKeys": ["VERTEX_AI_KEY", "..."],
  "skippedKeys": ["INSTAGRAM_API_KEY"],
  "envFilesPresent": [".env", "apps/api/.env", ".env.test"],
  "fixtures": {
    "authStorageState": "e2e/.auth/user.json",
    "nuxtPrepared": true
  },
  "blockers": [
    { "taskHint": "WhatsApp integration", "reason": "META_BUSINESS_ACCOUNT_ID missing" }
  ]
}
```

### Step 4 — Bootstrap quick steps the user shouldn't have to do

If the user provided enough, run these for them automatically:

```bash
# Nuxt prep (idempotent)
[ -f apps/api/.nuxt/tsconfig.app.json ] || (cd apps/api && npx nuxi prepare)

# Playwright browsers
[ -d ~/Library/Caches/ms-playwright/webkit-* ] || npx playwright install webkit
```

If the project is bypilot-moduler-pilot (detected by reading `package.json` `name`), apply the bypilot-specific bootstrap recipe (see `skills/sprint-driver/scripts/bootstrap-worktree.sh`).

### Step 5 — Report

Emit a structured block:

```
╭─ bypilot · setup complete ──────────────────────╮
│ Mode: interactive                                │
│ ✓ Keys collected: 8 / 8                          │
│ ✓ Env files: .env, apps/api/.env, .env.test     │
│ ✓ Auth storageState cached                       │
│ ⚠ Skipped: INSTAGRAM_API_KEY (3 tasks blocked)  │
│                                                  │
│ Integrations:                                    │
│ ✓ Linear MCP — team BYPİLOT, ask-each-plan      │
│ ✗ Playwright MCP — kurulumu önerildi             │
│   $ claude mcp add playwright @playwright/mcp@latest │
│ ✓ Telegram — @bypilot_xxx_bot, chat #******     │
│   poll-daemon spawned (pid 12345)                │
│                                                  │
│ Ready for /bypilot-research, /bypilot-plan, or  │
│ /bypilot-sprint-driver.                          │
╰──────────────────────────────────────────────────╯
```

## How It Works (one-paragraph)

The setup skill is the **single point of friction** by design. It pays the friction cost once, in one batch of questions, so every subsequent bypilot operation can assume preconditions hold. If a task later discovers a missing prereq, the orchestrator pauses and re-invokes setup with the *specific* missing item — but in normal flow this should never happen because setup is exhaustive.

## Auto Mode (`/bypilot-setup --auto`)

When the user trusts the AI:
- Use sensible defaults from `.env.example`
- Skip optional integrations (WhatsApp, Instagram) and mark them as blockers for relevant tasks
- Generate the auth storageState from `TEST_USER_EMAIL` if available, otherwise note in blockers
- Never invent secret values — empty/blocker is better than fabricated

## Sıkıştığında

- `.env.example` yoksa → manual interview without comparison; show user the project README
- User gives a placeholder ("xxx", "TODO") → flag, don't accept
- `nuxi prepare` fails (missing DATABASE_URL) → mark blocker, don't try to invent

## Bitti sayılan durum

- `.bypilot/setup.json` written
- All required keys present in `.env*`
- Bootstrap quick steps idempotent-applied
- User got a single structured report, not 7 separate questions
