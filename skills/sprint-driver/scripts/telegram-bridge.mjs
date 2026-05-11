#!/usr/bin/env node
/**
 * telegram-bridge.mjs — bypilot Telegram Bot API client.
 *
 * Subcommands:
 *   probe                       Test bot token via getMe. JSON return.
 *   send --text "..."           Send a text message. Auto-splits at 4096 chars.
 *       [--parse-mode Markdown]
 *   send-document --file <path> Upload a file as document attachment.
 *       [--caption "..."]
 *   send-with-actions           Text + inline keyboard.
 *       --text "..." --buttons '[[{"text":"X","callback_data":"y"}]]'
 *   poll-once                   Long-poll getUpdates once, append to inbox.
 *   poll-daemon                 Forever long-poll loop (intended as background daemon).
 *   find-callback --prefix "ans:Q1:"
 *                              Find an unconsumed callback in inbox matching prefix. Echoes
 *                              the matched callback_data value (after prefix) or "null".
 *   consume-callback --question-id Q1
 *                              Mark all inbox entries with callback_data prefix "ans:Q1:" as consumed.
 *   consume --ts <iso>          Mark one inbox entry as consumed by ts.
 *
 * Config: reads .bypilot/integrations.json from process.cwd().
 *
 * No external deps. Node 18+ (native fetch + FormData).
 */

import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const INTEG_PATH = path.join(ROOT, ".bypilot", "integrations.json");
const INBOX_PATH = path.join(ROOT, ".bypilot", "telegram-inbox.jsonl");
const STATE_PATH = path.join(ROOT, ".bypilot", "telegram-state.json");

function readIntegrations() {
  try {
    return JSON.parse(fs.readFileSync(INTEG_PATH, "utf8"));
  } catch {
    return null;
  }
}

function tgConfig() {
  const integ = readIntegrations();
  if (!integ?.telegram?.enabled) return null;
  const { botToken, chatId } = integ.telegram;
  if (!botToken || !chatId) return null;
  return { botToken, chatId };
}

function out(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        out[key] = true;
      } else {
        out[key] = next;
        i++;
      }
    }
  }
  return out;
}

async function tgCall(token, method, payload) {
  const url = `https://api.telegram.org/bot${token}/${method}`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) {
      // Rate limit handling
      if (data.error_code === 429 && data.parameters?.retry_after) {
        await sleep(data.parameters.retry_after * 1000);
        return tgCall(token, method, payload);
      }
      return { ok: false, error: data.description || `HTTP ${res.status}` };
    }
    return { ok: true, result: data.result };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
}

async function tgCallMultipart(token, method, formFields, fileField) {
  const url = `https://api.telegram.org/bot${token}/${method}`;
  const form = new FormData();
  for (const [k, v] of Object.entries(formFields)) {
    if (v !== undefined && v !== null) form.append(k, String(v));
  }
  if (fileField) {
    const { name, filePath, asFieldName } = fileField;
    const buf = fs.readFileSync(filePath);
    const blob = new Blob([buf]);
    form.append(asFieldName, blob, name);
  }
  try {
    const res = await fetch(url, { method: "POST", body: form });
    const data = await res.json();
    if (!res.ok || !data.ok) {
      return { ok: false, error: data.description || `HTTP ${res.status}` };
    }
    return { ok: true, result: data.result };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function splitMessage(text, limit = 4000) {
  if (text.length <= limit) return [text];
  const parts = [];
  let remaining = text;
  while (remaining.length > limit) {
    let cut = remaining.lastIndexOf("\n\n", limit);
    if (cut < limit / 2) cut = remaining.lastIndexOf("\n", limit);
    if (cut < limit / 2) cut = limit;
    parts.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining.length) parts.push(remaining);
  return parts;
}

function appendInbox(entry) {
  fs.mkdirSync(path.dirname(INBOX_PATH), { recursive: true });
  fs.appendFileSync(INBOX_PATH, JSON.stringify(entry) + "\n");
}

function readInbox() {
  if (!fs.existsSync(INBOX_PATH)) return [];
  return fs
    .readFileSync(INBOX_PATH, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function rewriteInbox(entries) {
  fs.writeFileSync(INBOX_PATH, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
  } catch {
    return { updateOffset: 0 };
  }
}

function writeState(state) {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

// ----- Subcommands -----

async function cmdProbe() {
  const cfg = tgConfig();
  if (!cfg) {
    out({ skipped: true, reason: "telegram-disabled-or-creds-missing" });
    return;
  }
  const r = await tgCall(cfg.botToken, "getMe", {});
  if (!r.ok) {
    out({ ok: false, error: r.error });
    return;
  }
  out({ ok: true, botUsername: `@${r.result.username}`, botId: r.result.id });
}

async function cmdSend(args) {
  const cfg = tgConfig();
  if (!cfg) {
    out({ skipped: true, reason: "telegram-disabled" });
    return;
  }
  const text = args.text || "";
  if (!text) {
    out({ ok: false, error: "no text" });
    return;
  }
  const parseMode = args["parse-mode"] || "Markdown";
  const parts = splitMessage(text);
  const messageIds = [];
  for (const part of parts) {
    const r = await tgCall(cfg.botToken, "sendMessage", {
      chat_id: cfg.chatId,
      text: part,
      parse_mode: parseMode,
      disable_web_page_preview: true,
    });
    if (!r.ok) {
      out({ ok: false, error: r.error, partialMessageIds: messageIds });
      return;
    }
    messageIds.push(r.result.message_id);
  }
  out({ ok: true, messageIds });
}

async function cmdSendDocument(args) {
  const cfg = tgConfig();
  if (!cfg) {
    out({ skipped: true, reason: "telegram-disabled" });
    return;
  }
  const filePath = args.file;
  if (!filePath || !fs.existsSync(filePath)) {
    out({ ok: false, error: `file not found: ${filePath}` });
    return;
  }
  const stat = fs.statSync(filePath);
  if (stat.size > 50 * 1024 * 1024) {
    out({ ok: false, error: "file-too-large", sizeBytes: stat.size });
    return;
  }
  const caption = (args.caption || "").slice(0, 1024);
  const name = path.basename(filePath);

  const r = await tgCallMultipart(
    cfg.botToken,
    "sendDocument",
    { chat_id: cfg.chatId, caption, parse_mode: "Markdown" },
    { name, filePath, asFieldName: "document" }
  );
  if (!r.ok) {
    out({ ok: false, error: r.error });
    return;
  }
  out({ ok: true, messageId: r.result.message_id, fileName: name });
}

async function cmdSendWithActions(args) {
  const cfg = tgConfig();
  if (!cfg) {
    out({ skipped: true, reason: "telegram-disabled" });
    return;
  }
  let buttons;
  try {
    buttons = JSON.parse(args.buttons);
  } catch (err) {
    out({ ok: false, error: `bad buttons JSON: ${err.message}` });
    return;
  }
  // Validate callback_data ≤ 64 bytes
  for (const row of buttons) {
    for (const btn of row) {
      if (btn.callback_data && Buffer.byteLength(btn.callback_data, "utf8") > 64) {
        out({ ok: false, error: `callback_data too long: ${btn.callback_data}` });
        return;
      }
    }
  }
  const r = await tgCall(cfg.botToken, "sendMessage", {
    chat_id: cfg.chatId,
    text: args.text,
    parse_mode: "Markdown",
    reply_markup: { inline_keyboard: buttons },
  });
  if (!r.ok) {
    out({ ok: false, error: r.error });
    return;
  }
  out({ ok: true, messageId: r.result.message_id });
}

async function cmdPollOnce(args) {
  const cfg = tgConfig();
  if (!cfg) {
    out({ skipped: true, reason: "telegram-disabled" });
    return;
  }
  const state = readState();
  const r = await tgCall(cfg.botToken, "getUpdates", {
    offset: state.updateOffset || 0,
    timeout: parseInt(args.timeout || "20", 10),
    allowed_updates: ["message", "callback_query"],
  });
  if (!r.ok) {
    out({ ok: false, error: r.error });
    return;
  }
  const updates = r.result || [];
  let collected = 0;
  let maxId = state.updateOffset || 0;
  for (const u of updates) {
    if (u.update_id >= maxId) maxId = u.update_id + 1;
    if (u.callback_query) {
      const cq = u.callback_query;
      // ACK the callback so Telegram stops retrying
      await tgCall(cfg.botToken, "answerCallbackQuery", {
        callback_query_id: cq.id,
        text: "alındı",
      });
      // Only accept from authorized chat
      if (String(cq.message?.chat?.id) !== String(cfg.chatId)) continue;
      appendInbox({
        kind: "callback",
        data: cq.data,
        messageId: cq.message?.message_id,
        ts: new Date().toISOString(),
        from: cq.from?.username || cq.from?.first_name,
      });
      collected++;
    } else if (u.message) {
      const m = u.message;
      if (String(m.chat?.id) !== String(cfg.chatId)) continue;
      const text = m.text || "";
      if (text.startsWith("/")) {
        const [cmd, ...rest] = text.split(/\s+/);
        appendInbox({
          kind: "command",
          command: cmd,
          args: rest.join(" "),
          messageId: m.message_id,
          ts: new Date().toISOString(),
          from: m.from?.username || m.from?.first_name,
        });
      } else {
        appendInbox({
          kind: "text",
          text,
          messageId: m.message_id,
          ts: new Date().toISOString(),
          from: m.from?.username || m.from?.first_name,
        });
      }
      collected++;
    }
  }
  writeState({ updateOffset: maxId });
  out({ ok: true, collected, newOffset: maxId });
}

async function cmdPollDaemon() {
  const cfg = tgConfig();
  if (!cfg) {
    out({ skipped: true, reason: "telegram-disabled" });
    return;
  }
  // Forever loop. Used as background daemon.
  // Caller spawns via `nohup node telegram-bridge.mjs poll-daemon > /tmp/tg-poll.log 2>&1 &`
  while (true) {
    try {
      const state = readState();
      const r = await tgCall(cfg.botToken, "getUpdates", {
        offset: state.updateOffset || 0,
        timeout: 25,
        allowed_updates: ["message", "callback_query"],
      });
      if (r.ok) {
        const updates = r.result || [];
        let maxId = state.updateOffset || 0;
        for (const u of updates) {
          if (u.update_id >= maxId) maxId = u.update_id + 1;
          if (u.callback_query) {
            const cq = u.callback_query;
            await tgCall(cfg.botToken, "answerCallbackQuery", {
              callback_query_id: cq.id,
              text: "alındı",
            });
            if (String(cq.message?.chat?.id) === String(cfg.chatId)) {
              appendInbox({
                kind: "callback",
                data: cq.data,
                messageId: cq.message?.message_id,
                ts: new Date().toISOString(),
                from: cq.from?.username || cq.from?.first_name,
              });
            }
          } else if (u.message) {
            const m = u.message;
            if (String(m.chat?.id) === String(cfg.chatId)) {
              const text = m.text || "";
              if (text.startsWith("/")) {
                const [cmd, ...rest] = text.split(/\s+/);
                appendInbox({
                  kind: "command",
                  command: cmd,
                  args: rest.join(" "),
                  messageId: m.message_id,
                  ts: new Date().toISOString(),
                  from: m.from?.username || m.from?.first_name,
                });
              } else {
                appendInbox({
                  kind: "text",
                  text,
                  messageId: m.message_id,
                  ts: new Date().toISOString(),
                  from: m.from?.username || m.from?.first_name,
                });
              }
            }
          }
        }
        writeState({ updateOffset: maxId });
      } else {
        await sleep(10000);
      }
    } catch (err) {
      await sleep(10000);
    }
  }
}

function cmdFindCallback(args) {
  const prefix = args.prefix;
  if (!prefix) {
    out({ ok: false, error: "missing --prefix" });
    return;
  }
  const entries = readInbox();
  for (const e of entries) {
    if (e.kind === "callback" && !e.consumedAt && typeof e.data === "string" && e.data.startsWith(prefix)) {
      out({ ok: true, value: e.data.slice(prefix.length), ts: e.ts });
      return;
    }
  }
  out({ ok: true, value: null });
}

function cmdConsumeCallback(args) {
  const qid = args["question-id"];
  if (!qid) {
    out({ ok: false, error: "missing --question-id" });
    return;
  }
  const entries = readInbox();
  let n = 0;
  for (const e of entries) {
    if (e.kind === "callback" && typeof e.data === "string" && e.data.startsWith(`ans:${qid}:`) && !e.consumedAt) {
      e.consumedAt = new Date().toISOString();
      n++;
    }
  }
  rewriteInbox(entries);
  out({ ok: true, consumed: n });
}

function cmdConsume(args) {
  const ts = args.ts;
  if (!ts) {
    out({ ok: false, error: "missing --ts" });
    return;
  }
  const entries = readInbox();
  let n = 0;
  for (const e of entries) {
    if (e.ts === ts && !e.consumedAt) {
      e.consumedAt = new Date().toISOString();
      n++;
    }
  }
  rewriteInbox(entries);
  out({ ok: true, consumed: n });
}

// ----- Entry point -----

async function main() {
  const [, , sub, ...rest] = process.argv;
  const args = parseArgs(rest);
  switch (sub) {
    case "probe":
      await cmdProbe();
      break;
    case "send":
      await cmdSend(args);
      break;
    case "send-document":
      await cmdSendDocument(args);
      break;
    case "send-with-actions":
      await cmdSendWithActions(args);
      break;
    case "poll-once":
      await cmdPollOnce(args);
      break;
    case "poll-daemon":
      await cmdPollDaemon();
      break;
    case "find-callback":
      cmdFindCallback(args);
      break;
    case "consume-callback":
      cmdConsumeCallback(args);
      break;
    case "consume":
      cmdConsume(args);
      break;
    default:
      out({
        ok: false,
        error: `unknown subcommand: ${sub}`,
        usage: "probe|send|send-document|send-with-actions|poll-once|poll-daemon|find-callback|consume-callback|consume",
      });
      process.exit(1);
  }
}

main().catch((err) => {
  out({ ok: false, error: String(err.message || err) });
  process.exit(1);
});
