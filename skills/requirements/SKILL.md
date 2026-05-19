---
name: bypilot-requirements
description: bypilot kullanıcı isterlerini sade Türkçe acceptance kontratına çeviren skill. Elicitor agent'ı çağırır (BMAD Advanced-Elicitation uyarlaması), 5-10 maddelik requirements.md + sidecar JSON üretir. Sprint'in anayasası — task-composer her task'ı bu maddelere bağlar, sprint sonu requirements-verifier bu maddelere karşı PASS/CONCERNS/FAIL/WAIVED kararı verir. Interactive default; --auto modunda bile final kullanıcı onayı zorunlu (AI tek başına approve edemez).
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

You are the **requirements skill conductor**. Yapacağın iş yalın: kullanıcı serbest cümle yazıyor, sen onu **sprint'in anayasası** olan `requirements.md` + `requirements.json`'a çeviriyorsun. Tüm zekâ delegate — elicitor agent (planner lane'inde) gerçek işi yapar. Sen sadece (a) skill'i yerinden başlat, (b) elicitor'ın çıktısını sprint klasörüne yerleştirildiğini doğrula, (c) plan zincirine devam et.

## Modes

| Çağrı | Mod | Davranış |
|---|---|---|
| `/bypilot-requirements <metin>` | `interactive` | Elicitor menü gösterir, kullanıcı her adımda karar verir. Default. |
| `/bypilot-requirements --auto <metin>` | `auto` | Elicitor AI ile çıkarır, **tek final AskUserQuestion** ile onaylatır. Karar yine kullanıcıda. |
| `/bypilot-requirements --extend <metin>` | `extend` | Mevcut son sprintin requirements'ına yeni REQ'ler ekler (yeni sprint açmaz). Nadir kullanım. |

`/bypilot-plan` step-0 olarak bu skill'i zincirler — kullanıcı doğrudan `/bypilot-plan`'i çağırırsa sen `requirements.md` yoksa otomatik tetiklenirsin.

## Pre-flight

```bash
# 1. Cwd consuming project mi?
[ -f docs/sprints.manifest.json ] || { echo "Not a bypilot consumer dir"; exit 1; }

# 2. Sprint numarası belirle — bir sonraki boş slot
NEXT=$(node -e "
  const m = require('./docs/sprints.manifest.json');
  const all = (m.active||[]).concat(m.archived||[]);
  const nums = all.map(s => parseInt(s.replace(/\\D/g,'')) || 0);
  console.log(Math.max(0, ...nums) + 1);
")
SPRINT_FOLDER="docs/sprint-${NEXT}"

# 3. Hedef klasör boş mu?
if [ -d "$SPRINT_FOLDER" ] && [ -f "$SPRINT_FOLDER/requirements.md" ]; then
  echo "Sprint folder already has requirements — use --extend or pick a new sprint"; exit 2;
fi

mkdir -p "$SPRINT_FOLDER"
```

## Main flow

### Step 1 — Kullanıcı metnini al

Skill prompt'unda kullanıcı zaten cümleyi yazmış olmalı. Yoksa tek soru:

```
AskUserQuestion({
  question: "Sprint'te ne yapmak istiyorsun? Tek paragrafta yaz, ben anlamlı maddelere bölerim.",
  ... (free-text only)
})
```

### Step 2 — Elicitor'ı çağır

```
Agent({
  subagent_type: "elicitor",
  description: "Requirements elicitation — sprint-" + NEXT,
  prompt: `mode: "${MODE}"
    userPrompt: """${USER_RAW_TEXT}"""
    sprintFolder: "${SPRINT_FOLDER}"
    projectContext: {
      claudeMdPath: "CLAUDE.md",
      lastSprintRequirements: "${LAST_REQ_PATH || ''}"
    }`
})
```

Elicitor kendi içinde `AskUserQuestion` çağırır — sen blok olmazsın, harness elicitor agent'ın UI taleplerini doğal olarak kullanıcıya iletir.

### Step 3 — Çıktıyı doğrula

Elicitor `{ ok: true, requirementsMdPath, requirementsJsonPath, reqCount }` döner. Doğrula:

```bash
[ -f "$REQ_MD" ] && [ -f "$REQ_JSON" ] || { echo "Elicitor failed"; exit 3; }

# Schema validation — lightweight
node -e "
  const s = require('./bypilot-skill-pack/schemas/requirements.schema.json');
  const d = require('./${REQ_JSON}');
  if (!d.requirements || d.requirements.length === 0) { console.error('empty'); process.exit(1); }
  if (!d.approvedBy) { console.error('not approved'); process.exit(1); }
"
```

Boş REQ veya approve yoksa → halt, kullanıcıya bildir, elicitor'a tekrar dönmeyi öner.

### Step 4 — sprints.manifest.json güncelle

```bash
# Yeni sprint'i active listesine ekle
node -e "
  const fs = require('fs');
  const m = JSON.parse(fs.readFileSync('docs/sprints.manifest.json'));
  m.active = m.active || [];
  if (!m.active.includes('sprint-${NEXT}')) m.active.push('sprint-${NEXT}');
  fs.writeFileSync('docs/sprints.manifest.json', JSON.stringify(m, null, 2));
"
```

### Step 5 — Final özet

```
╭─ bypilot · requirements hazır ─────────────────────╮
│ Sprint: sprint-<N>                                  │
│ REQ sayısı: 8 (6 user-visible, 2 backend)          │
│ Lens kullanılan: Pre-mortem, Stakeholder Mapping   │
│ Belirsizlik çözülen: 2                              │
│ Mode: interactive · approvedBy: user                │
│                                                     │
│ Dosyalar:                                           │
│ → docs/sprint-<N>/requirements.md (Türkçe)         │
│ → docs/sprint-<N>/requirements.json (agent için)   │
│                                                     │
│ Sırada: /bypilot-plan (analyst→PM→architect→tasks) │
│ Pipeline modundaysan otomatik akar.                 │
╰─────────────────────────────────────────────────────╯
```

### Step 6 — Pipeline chain (varsa)

Eğer skill `/bypilot-pipeline` çağrısından zincirleme tetiklendiyse, kontrolü pipeline'a iade et — pipeline sonra `/bypilot-plan`'i otomatik başlatır.

Eğer kullanıcı doğrudan `/bypilot-requirements`'ı çağırdıysa: bitir, sıradaki adımı **öner** (otomatik başlatma):

```
AskUserQuestion({
  question: "Şimdi /bypilot-plan ile detaylı task DAG'ını üretelim mi?",
  options: [
    "Evet, planı otomatik aç (--auto)",
    "Evet ama her adımda onay alayım",
    "Hayır, requirements'ı manuel inceleyeceğim"
  ]
})
```

## --extend mode

Mevcut active sprint'in `requirements.json`'una yeni REQ'ler eklemek için:

1. Son active sprint'i sprints.manifest.json'dan bul.
2. Mevcut `requirements.json` REQ id'lerinden max'ı bul (örn REQ-8) → yeni id'ler REQ-9'dan başlar.
3. Elicitor'a `mode: extend` ile çağrı yap, `existingReqs` listesini geçir → elicitor yalnızca yenileri yazar, eskileri korur.
4. **Uyarı:** task-composer zaten plan ürettiyse extend riskli — yeni REQ'ler task'a bağlı olmayabilir. Kullanıcıya açıkça uyar.

## KESİN KURALLAR

1. **Kullanıcı onayı olmadan persist yok.** Auto mode dahil. Elicitor bu kurala uyar; sen de bunu doğrulamadan manifest'i güncellemezsin.
2. **Bir sprint için tek `requirements.md`.** Aynı sprint'e ikinci bir `/bypilot-requirements` çağrısı → halt. `--extend` ya da yeni sprint açtır.
3. **`userOriginalPrompt`'a dokunma.** Sen de değiştirme; elicitor yazıyor, sen sadece dosyanın varlığını kontrol ediyorsun.
4. **`requirements.md` immutable downstream için.** Task-composer ve verifier okur, asla yazmaz. Düzeltme istenirse skill'i tekrar çağır (yeni snapshot).
5. **Manifest sync zorunlu.** Sprint klasörü açtıysan `sprints.manifest.json.active`'a ekle — yoksa sprint-driver göremez.

## Sıkıştığında

- Elicitor "kullanıcı reddetti, hiç REQ yok" döndü → dosya yazma, sprint folder'ı sil, kullanıcıya "vazgeçildi, çalışma yapılmadı" mesajı.
- Schema validation fail → elicitor'a debug bilgisiyle geri dön (max 2 retry), sonra halt.
- Mevcut son sprint hâlâ active ve done değil → kullanıcıya sor: "Sprint-N hâlâ açık, önce onu bitirelim mi yoksa paralel sprint-M açalım mı?"

## Bitti sayılan durum

- `docs/sprint-<N>/requirements.md` ve `requirements.json` disk'te
- `sprints.manifest.json` güncel (yeni sprint active'de)
- Final özet kart gösterildi
- Pipeline tetiklendiyse kontrol pipeline'a iade edildi; standalone ise next-step önerisi sunuldu
