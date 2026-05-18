#!/usr/bin/env node
/**
 * seed-test-data.mjs — Test environment seed helper (Sprint-12 BYP-212).
 *
 * Authenticated test user (TEST_USER_EMAIL / TEST_ACCOUNT_ID — .env.test'ten)
 * için sample chatbot, customer ve whatsapp integration satırları ekler.
 * Idempotent: mevcut satırları korur, duplicate atmaz.
 *
 * Sprint-11 vision verify aşamasında keşfedilen DB seed eksikliğini
 * kapatmak için yazıldı. Önceden test env'de authenticated account'a
 * ait satır yoktu → /v1/chatbots, /v1/customers, /v1/integrations boş
 * data döndürüyordu → vision verify yapılamıyordu.
 *
 * Kullanım:
 *   node bypilot-skill-pack/skills/sprint-driver/scripts/seed-test-data.mjs --execute
 *
 * Flags:
 *   --dry-run    SQL planını göster, INSERT atma (default)
 *   --execute    Gerçekten ekle
 *   --account=<UUID>  Override TEST_ACCOUNT_ID
 *   --cleanup    Önceki seed verisini sil (e2e_seed_* prefix'i ile)
 *   --help       Bu mesajı göster
 *
 * Çıktı: JSON, her seed item için { table, id, action: "inserted" | "kept" }.
 *
 * Living Contract:
 *   contracts/test-env-seed.contract.md — exports `seedAuthenticatedAccount`
 *   ve `cleanupSeededData` adlı API'leri tüketici (test-runner agent + Sprint-12
 *   T6 vision verify) için garanti eder.
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// BYPILOT_ROOT = consuming project. postgres-js orada kurulu, skill-pack'te
// değil — bu yüzden dinamik import + path resolution.
const ROOT_EARLY = process.env.BYPILOT_ROOT ?? process.cwd();
let postgres;
{
  const candidates = [
    resolve(ROOT_EARLY, "node_modules/postgres/src/index.js"),
    resolve(ROOT_EARLY, "node_modules/postgres/cjs/src/index.js"),
  ];
  let loaded = false;
  for (const target of candidates) {
    if (existsSync(target)) {
      try {
        const mod = await import(pathToFileURL(target).href);
        postgres = mod.default ?? mod;
        loaded = true;
        break;
      } catch {
        /* try next */
      }
    }
  }
  if (!loaded) {
    console.error(
      `[seed] FATAL: postgres-js bulunamadı. BYPILOT_ROOT=${ROOT_EARLY} altında 'postgres' paketi kurulu olmalı.`,
    );
    process.exit(2);
  }
}

// ---------------------------------------------------------------------------
// Args + env
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const isExecute = args.includes("--execute");
const isCleanup = args.includes("--cleanup");
const isHelp = args.includes("--help") || args.includes("-h");
const accountOverride = args
  .find((a) => a.startsWith("--account="))
  ?.split("=")[1];

if (isHelp) {
  console.log(`seed-test-data.mjs — test DB seed helper

Usage:
  node seed-test-data.mjs [--dry-run|--execute|--cleanup] [--account=<UUID>]

Default mode is --dry-run. Use --execute to actually write to DB.
`);
  process.exit(0);
}

// BYPILOT_ROOT = consuming project (set by bootstrap-worktree.sh or sprint-driver)
const ROOT = process.env.BYPILOT_ROOT ?? process.cwd();

function readEnvFile(rel) {
  const p = resolve(ROOT, rel);
  if (!existsSync(p)) return {};
  const text = readFileSync(p, "utf8");
  const out = {};
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*"?([^"\n#]+)"?/);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

const envApi = readEnvFile("apps/api/.env");
const envTest = readEnvFile(".env.test");
const merged = { ...envApi, ...envTest, ...process.env };

const DATABASE_URL = merged.DATABASE_URL || merged.POSTGRES_URL;
const ACCOUNT_ID =
  accountOverride ||
  merged.TEST_ACCOUNT_ID ||
  "09279d29-fb3c-48e7-bf20-9e1fbc77037b";

if (!DATABASE_URL) {
  console.error(
    "[seed] FATAL: DATABASE_URL not found in apps/api/.env or .env.test or process.env",
  );
  process.exit(2);
}

// ---------------------------------------------------------------------------
// Seed plan
// ---------------------------------------------------------------------------

const SEED_TAG = "e2e_seed_sprint12"; // her seed row'unda metadata ile işaretle
const PLAN = {
  chatbot: {
    name: "E2E Seed Chatbot — Berber",
    systemPrompt:
      "Sen Bypilot Berber test salonunun yardımcısısın. Randevu alma, hizmet listeleme ve fiyat sorma konularında müşterilere yardım edersin.",
    status: "active",
  },
  contact: {
    // Bu repodaki "customer-slug-page" surface'i `contacts` tablosuna düşer.
    name: "Ahmet Yılmaz (seed)",
    phone: "+905550009999",
    identifier: "ahmet-yilmaz-seed",
    locale: "tr",
  },
  integration: {
    platform: "whatsapp",
    providerAccountId: "+905550000000",
    displayName: "E2E Seed WA Hesap",
  },
};

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const sql = postgres(DATABASE_URL, { max: 2, idle_timeout: 5 });
  const results = [];

  try {
    if (isCleanup) {
      console.error(
        `[seed] CLEANUP mode — deleting seed rows for account ${ACCOUNT_ID}`,
      );
      await sql.begin(async (tx) => {
        // Connection user is db owner ('postgres') — table grants OK without SET ROLE.
        // Migration 0035 doesn't include service_role GRANT on account_integrations,
        // bu yüzden eski db-cleanup.ts paterni (SET LOCAL ROLE service_role) burada
        // permission denied verirdi. Owner natural access kullanıyoruz.
        const r1 = await tx`
          DELETE FROM account_integrations
          WHERE account_id = ${ACCOUNT_ID}::uuid
            AND metadata->>'tag' = ${SEED_TAG}
          RETURNING id
        `;
        const r2 = await tx`
          DELETE FROM contacts
          WHERE account_id = ${ACCOUNT_ID}::uuid
            AND identifier = ${PLAN.contact.identifier}
          RETURNING id
        `;
        const r3 = await tx`
          DELETE FROM chatbots
          WHERE account_id = ${ACCOUNT_ID}::uuid
            AND name = ${PLAN.chatbot.name}
          RETURNING id
        `;
        results.push({ table: "account_integrations", deleted: r1.length });
        results.push({ table: "contacts", deleted: r2.length });
        results.push({ table: "chatbots", deleted: r3.length });
      });
      console.log(JSON.stringify({ mode: "cleanup", results }, null, 2));
      return;
    }

    if (!isExecute) {
      console.error(
        "[seed] DRY-RUN — no DB writes (pass --execute to actually seed)",
      );
    }

    await sql.begin(async (tx) => {
      // Owner-role natural access (bkz. cleanup branch yorumu)

      // ---- 1) chatbot (idempotent: name + account_id) ----
      const existingCb = await tx`
        SELECT id FROM chatbots
        WHERE account_id = ${ACCOUNT_ID}::uuid
          AND name = ${PLAN.chatbot.name}
        LIMIT 1
      `;
      let chatbotId;
      if (existingCb.length > 0) {
        chatbotId = existingCb[0].id;
        results.push({ table: "chatbots", id: chatbotId, action: "kept" });
      } else if (isExecute) {
        const rows = await tx`
          INSERT INTO chatbots (account_id, name, system_prompt, status)
          VALUES (
            ${ACCOUNT_ID}::uuid,
            ${PLAN.chatbot.name},
            ${PLAN.chatbot.systemPrompt},
            ${PLAN.chatbot.status}
          )
          RETURNING id
        `;
        chatbotId = rows[0].id;
        results.push({ table: "chatbots", id: chatbotId, action: "inserted" });
      } else {
        results.push({
          table: "chatbots",
          id: "<dry-run>",
          action: "would-insert",
          plan: PLAN.chatbot,
        });
      }

      // ---- 2) contact (idempotent: identifier + account_id) ----
      const existingCust = await tx`
        SELECT id FROM contacts
        WHERE account_id = ${ACCOUNT_ID}::uuid
          AND identifier = ${PLAN.contact.identifier}
        LIMIT 1
      `;
      let contactId;
      if (existingCust.length > 0) {
        contactId = existingCust[0].id;
        results.push({ table: "contacts", id: contactId, action: "kept" });
      } else if (isExecute) {
        const rows = await tx`
          INSERT INTO contacts (account_id, name, phone, identifier, locale)
          VALUES (
            ${ACCOUNT_ID}::uuid,
            ${PLAN.contact.name},
            ${PLAN.contact.phone},
            ${PLAN.contact.identifier},
            ${PLAN.contact.locale}
          )
          RETURNING id
        `;
        contactId = rows[0].id;
        results.push({
          table: "contacts",
          id: contactId,
          action: "inserted",
        });
      } else {
        results.push({
          table: "contacts",
          id: "<dry-run>",
          action: "would-insert",
          plan: PLAN.contact,
        });
      }

      // ---- 3) account_integrations (idempotent: platform + provider_account_id) ----
      const existingInt = await tx`
        SELECT id FROM account_integrations
        WHERE account_id = ${ACCOUNT_ID}::uuid
          AND platform = ${PLAN.integration.platform}
          AND provider_account_id = ${PLAN.integration.providerAccountId}
          AND soft_deleted_at IS NULL
        LIMIT 1
      `;
      if (existingInt.length > 0) {
        results.push({
          table: "account_integrations",
          id: existingInt[0].id,
          action: "kept",
        });
      } else if (isExecute) {
        const rows = await tx`
          INSERT INTO account_integrations (
            account_id, platform, provider_account_id, display_name, metadata
          )
          VALUES (
            ${ACCOUNT_ID}::uuid,
            ${PLAN.integration.platform},
            ${PLAN.integration.providerAccountId},
            ${PLAN.integration.displayName},
            ${JSON.stringify({ tag: SEED_TAG })}::jsonb
          )
          RETURNING id
        `;
        results.push({
          table: "account_integrations",
          id: rows[0].id,
          action: "inserted",
        });
      } else {
        results.push({
          table: "account_integrations",
          id: "<dry-run>",
          action: "would-insert",
          plan: PLAN.integration,
        });
      }
    });

    console.log(
      JSON.stringify(
        {
          mode: isExecute ? "execute" : "dry-run",
          accountId: ACCOUNT_ID,
          results,
        },
        null,
        2,
      ),
    );
  } catch (err) {
    console.error("[seed] FAILED:", err.message);
    process.exitCode = 3;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main();
