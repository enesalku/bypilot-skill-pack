#!/usr/bin/env node
// commit-task-state.mjs — per-task atomic status flip.
// Replaces commit-wave-state.mjs in the new continuous scheduler. Old script
// is kept for backwards compatibility with existing wave-based callers.
//
// Differences vs commit-wave-state.mjs:
//   - Single task per invocation (one commit per task done/blocked)
//   - Adds optional --epoch <N> field for epoch-grouped reporting
//   - Writes a per-task entry to docs/decisions.log immediately
//   - Idempotent: re-running for an already-flipped task is a no-op
//
// Usage:
//   node commit-task-state.mjs --task <id> --status done [--commit <sha>] [--worktree <path>] [--summary <text>] [--epoch <n>]
//   node commit-task-state.mjs --task <id> --status blocked --reason <text> [--worktree <path>] [--epoch <n>]
//
// Exit: 0 ok, 1 user error, 2 schema/IO error.

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

const ROOT = process.env.BYPILOT_ROOT || process.cwd();
const DECISIONS_LOG = resolve(ROOT, 'docs/decisions.log');

const log = (...m) => process.stderr.write('[commit-task] ' + m.join(' ') + '\n');
const die = (code, msg) => { log('ERROR:', msg); process.exit(code); };

function getArg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
}
function readJson(p) {
  return JSON.parse(readFileSync(p, 'utf8'));
}
function writeJson(p, data) {
  writeFileSync(p, JSON.stringify(data, null, 2) + '\n');
}
function loadManifest() {
  const path = resolve(ROOT, 'docs/sprints.manifest.json');
  if (!existsSync(path)) {
    // Fall back: scan docs/sprint-*/ for tasks.json files.
    const docs = resolve(ROOT, 'docs');
    if (!existsSync(docs)) return { active: [] };
    const sprints = readdirSync(docs).filter(f => f.startsWith('sprint-'));
    return { active: sprints };
  }
  return readJson(path);
}
function appendDecision(line) {
  if (!existsSync(dirname(DECISIONS_LOG))) mkdirSync(dirname(DECISIONS_LOG), { recursive: true });
  writeFileSync(DECISIONS_LOG, `${new Date().toISOString()} ${line}\n`, { flag: 'a' });
}

function main() {
  const taskId = getArg('task') || die(1, '--task required');
  const status = getArg('status') || die(1, '--status done|blocked required');
  if (status !== 'done' && status !== 'blocked') die(1, '--status must be done|blocked');

  const commit = getArg('commit');
  const worktreePath = getArg('worktree');
  const summary = getArg('summary');
  const reason = getArg('reason');
  const epoch = getArg('epoch');

  if (status === 'blocked' && !reason) die(1, '--reason required when --status blocked');

  const manifest = loadManifest();
  const ts = new Date().toISOString();
  let found = null;

  for (const sprint of manifest.active) {
    const path = resolve(ROOT, 'docs', sprint, 'tasks.json');
    if (!existsSync(path)) continue;
    const data = readJson(path);
    let dirty = false;
    for (const t of data.tasks || []) {
      if (t.id !== taskId) continue;
      // idempotency: if already in target state, no-op
      if (t.status === status && (status !== 'blocked' || t.blockedReason === reason)) {
        log('idempotent: task already', status);
        console.log(JSON.stringify({ ok: true, noop: true, task: taskId, sprint }));
        return;
      }
      t.status = status;
      if (status === 'done') {
        t.completedAt = ts;
        if (commit) t.commitHash = commit;
        if (worktreePath) t.worktreePath = worktreePath;
        if (summary) t.summary = summary;
        if (epoch) t.completedInEpoch = Number(epoch);
        delete t.blockedReason;
      } else {
        t.blockedAt = ts;
        t.blockedReason = reason;
        if (worktreePath) t.worktreePath = worktreePath;
        if (epoch) t.blockedInEpoch = Number(epoch);
      }
      found = { sprint, task: t };
      dirty = true;
      break;
    }
    if (dirty) {
      writeJson(path, data);
      break;
    }
  }

  if (!found) die(1, `task not found in any active sprint: ${taskId}`);

  const logLine = status === 'done'
    ? `task-done ${taskId} sprint=${found.sprint}${epoch ? ` epoch=${epoch}` : ''}${commit ? ` commit=${commit}` : ''}${summary ? ` -- ${summary}` : ''}`
    : `task-blocked ${taskId} sprint=${found.sprint}${epoch ? ` epoch=${epoch}` : ''} reason=${reason}`;
  appendDecision(logLine);

  console.log(JSON.stringify({ ok: true, task: taskId, sprint: found.sprint, status, ts }));
}

main();
