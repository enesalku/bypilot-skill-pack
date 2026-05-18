# test-env-seed Living Contract (Sprint-12 BYP-212)

> **Author task:** `db-seed-helper` (Sprint-12)
> **Subscribers:** Sprint-12 T6 (`sprint-11-vision-verify-coşumu`), gelecek sprint'lerin vision verify ihtiyacı, test-runner agent
> **Status:** active

## Amaç

Test environment'inde authenticated kullanıcı (`bypilotai@gmail.com` / `TEST_ACCOUNT_ID`) için sample chatbot, customer ve integration satırlarının var olmasını garanti eder. Vision verify ve Playwright canlı koşumlarının "DB boş → /v1 endpoint'leri boş data döndürüyor → UI loading state'inde takılı" pattern'ine düşmemesi için kritiktir.

## Garantili API

### `node seed-test-data.mjs --execute`

Aşağıdaki satırların DB'de var olduğunu garanti eder (idempotent — mevcutlarsa korur):

| Tablo | Eşleme anahtarı | Satır |
|---|---|---|
| `chatbots` | `(account_id, name="E2E Seed Chatbot — Berber")` | 1 active chatbot, system_prompt Türkçe |
| `customers` | `(account_id, slug="ahmet-yilmaz-seed")` | 1 müşteri, phone `+905550009999` |
| `account_integrations` | `(account_id, platform="whatsapp", provider_account_id="+905550000000")` | 1 active WhatsApp integration, `metadata.tag="e2e_seed_sprint12"` |

### `node seed-test-data.mjs --cleanup`

Seed prefix'li satırları siler (metadata tag veya bilinen slug/name match).

### `node seed-test-data.mjs --dry-run`

INSERT atmadan plan çıktısı verir (default mode).

### `node seed-test-data.mjs --account=<UUID>`

`TEST_ACCOUNT_ID` override — başka tenant'a seed.

## Çıktı JSON şekli

```json
{
  "mode": "execute" | "dry-run" | "cleanup",
  "accountId": "<UUID>",
  "results": [
    { "table": "chatbots", "id": "<UUID>", "action": "inserted" | "kept" | "would-insert" },
    { "table": "customers", "id": "<UUID>", "action": "..." },
    { "table": "account_integrations", "id": "<UUID>", "action": "..." }
  ]
}
```

`action` değerleri:
- `inserted` — yeni satır yaratıldı
- `kept` — mevcut satır korundu (idempotent path)
- `would-insert` — dry-run'da görseydi insert ederdi

## Subscribers şu kontratı gözetir

- `accountId` parametresi her zaman geçerli UUID, RLS scope'u doğrulanmış olmalı.
- `service_role` ile yazılır → RLS politikası bypass edilir (test env'inde normal).
- Çıktı `results[]` her zaman 3 element içerir (chatbot + customer + integration), başarısızlık durumunda exit code 3.

## Sprint-12 T6 nasıl kullanır

```bash
# 1. Test ortamı hazır olduktan sonra
node bypilot-skill-pack/skills/sprint-driver/scripts/seed-test-data.mjs --execute

# 2. Dev server up (bootstrap STEP 7 ile)
BYPILOT_BOOTSTRAP_START_DEV=1 bash bypilot-skill-pack/skills/sprint-driver/scripts/bootstrap-worktree.sh "$WORKTREE"

# 3. Playwright koşumu
npx playwright test e2e/sprint-11/ --project=sprint11 --reporter=html
```

## Cleanup garantisi

Sprint-12 T6 ve sonrası vision verify koşumlarının ardından seed verisi *kalmak zorunda değil* — `--cleanup` flag'i ile temizlenebilir. Ama idempotent yapı, tekrar `--execute` çağrısının zarar vermediğini de garanti eder.
