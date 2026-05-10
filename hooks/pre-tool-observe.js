#!/usr/bin/env node
// pre-tool-observe.js — 100% PreToolUse observation hook for continuous-learning v2.1.
// ECC ilhamı. Asenk; tool execution'ı bloklamaz (timeout 5s).
//
// Hook gating:
//   BYPILOT_HOOK_PROFILE=off → no-op
//   BYPILOT_HOOK_PROFILE=lean → no-op (observation full mode'a özgü)
//   BYPILOT_HOOK_PROFILE=full → kayıt aktif
//   BYPILOT_DISABLED_HOOKS=pre-tool-observe → no-op

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execSync } = require('node:child_process');

function gateOff() {
  const profile = process.env.BYPILOT_HOOK_PROFILE || 'off';
  if (profile !== 'full') return true;
  const disabled = (process.env.BYPILOT_DISABLED_HOOKS || '').split(',').map(s => s.trim());
  if (disabled.includes('pre-tool-observe')) return true;
  return false;
}

function projectHash() {
  try {
    const url = execSync('git remote get-url origin 2>/dev/null', { encoding: 'utf8', timeout: 1000 }).trim();
    if (!url) return 'no-remote';
    return crypto.createHash('sha1').update(url).digest('hex').slice(0, 12);
  } catch { return 'no-git'; }
}

function sanitize(input) {
  if (!input) return input;
  // Cheap secret pattern scrubbing — aggressive on common token shapes
  let s = JSON.stringify(input);
  s = s.replace(/sk-[a-zA-Z0-9]{20,}/g, '[REDACTED-OPENAI]');
  s = s.replace(/AIza[0-9A-Za-z\-_]{35}/g, '[REDACTED-GOOGLE]');
  s = s.replace(/AKIA[0-9A-Z]{16}/g, '[REDACTED-AWS]');
  s = s.replace(/ghp_[A-Za-z0-9]{36,}/g, '[REDACTED-GITHUB]');
  s = s.replace(/gAAAAA[A-Za-z0-9_-]+/g, '[REDACTED-FERNET]');
  s = s.replace(/(password|token|secret|api[_-]?key)\s*[:=]\s*"[^"]+"/gi, '$1: "[REDACTED]"');
  return s;
}

function main() {
  if (gateOff()) { process.stdout.write('{}\n'); return; }

  let stdin = '';
  try { stdin = fs.readFileSync(0, 'utf8'); } catch { /* no input */ }

  let event;
  try { event = JSON.parse(stdin); } catch { process.stdout.write('{}\n'); return; }

  const hash = projectHash();
  const dir = path.join(os.homedir(), '.bypilot', 'observations', hash);
  fs.mkdirSync(dir, { recursive: true });

  const file = path.join(dir, new Date().toISOString().slice(0, 10) + '.jsonl');
  const entry = {
    ts: new Date().toISOString(),
    tool: event.tool_name || 'unknown',
    paramsSummary: sanitize(event.tool_input || {}).slice(0, 500),
    sessionId: event.session_id || null
  };

  try {
    fs.appendFileSync(file, JSON.stringify(entry) + '\n');
  } catch (e) {
    process.stderr.write('[bypilot:pre-tool-observe] write failed: ' + e.message + '\n');
  }

  process.stdout.write('{}\n');
}

main();
