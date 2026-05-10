#!/usr/bin/env node
// commit-wave-state.mjs — atomic per-wave status flip in active sprint tasks.json files.
// Used by /bypilot-sprint-driver Step 7. Does NOT git-commit; the driver does that.
//
// Usage:
//   node commit-wave-state.mjs --done id1,id2 --blocked id3 \
//                              [--worktree id1=/path1,id2=/path2] \
//                              [--commit id1=hash1,id2=hash2] \
//                              [--reason id3="failure summary"]
//
// Flips status pending|in_progress -> done for --done IDs (sets completedAt + optional commitHash + worktreePath).
// Flips status pending|in_progress -> blocked for --blocked IDs (sets blockedReason).
// Returns 0 on success, 1 on missing IDs, 2 on schema/IO error.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = process.cwd();
const log = (...m) => process.stderr.write('[commit-wave-state] ' + m.join(' ') + '\n');

function parseListArg(value) {
  if (!value) return [];
  return value.split(',').map(s => s.trim()).filter(Boolean);
}

function parseKvArg(value) {
  if (!value) return {};
  const out = {};
  for (const part of value.split(',')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    out[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  return out;
}

function getArg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : '';
}

function readJSON(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function writeJSON(path, data) {
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n');
}

function loadManifest() {
  const path = resolve(ROOT, 'docs/sprints.manifest.json');
  if (!existsSync(path)) return { active: ['sprint-3'] };
  return readJSON(path);
}

function main() {
  const doneIds = parseListArg(getArg('done'));
  const blockedIds = parseListArg(getArg('blocked'));
  const worktrees = parseKvArg(getArg('worktree'));
  const commits = parseKvArg(getArg('commit'));
  const reasons = parseKvArg(getArg('reason'));

  if (doneIds.length === 0 && blockedIds.length === 0) {
    log('nothing to do (no --done / --blocked)');
    process.exit(0);
  }

  const manifest = loadManifest();
  const completedAt = new Date().toISOString();
  const target = new Set([...doneIds, ...blockedIds]);
  const found = new Set();
  const updates = [];

  for (const sprint of manifest.active) {
    const path = resolve(ROOT, 'docs', sprint, 'tasks.json');
    if (!existsSync(path)) continue;
    let dirty = false;
    const data = readJSON(path);
    for (const t of data.tasks || []) {
      if (!target.has(t.id)) continue;
      found.add(t.id);
      if (doneIds.includes(t.id)) {
        t.status = 'done';
        t.completedAt = completedAt;
        if (commits[t.id]) t.commitHash = commits[t.id];
        if (worktrees[t.id]) t.worktreePath = worktrees[t.id];
        delete t.blockedReason;
        updates.push({ id: t.id, sprint, to: 'done' });
        dirty = true;
      } else if (blockedIds.includes(t.id)) {
        t.status = 'blocked';
        t.blockedReason = reasons[t.id] || 'see decisions.log';
        if (worktrees[t.id]) t.worktreePath = worktrees[t.id];
        updates.push({ id: t.id, sprint, to: 'blocked', reason: t.blockedReason });
        dirty = true;
      }
    }
    if (dirty) writeJSON(path, data);
  }

  const missing = [...target].filter(id => !found.has(id));
  const result = {
    completedAt,
    updates,
    missing,
    sprintsTouched: [...new Set(updates.map(u => u.sprint))]
  };
  console.log(JSON.stringify(result, null, 2));
  if (missing.length > 0) {
    log('warning: ids not found in any active sprint:', missing.join(', '));
    process.exit(1);
  }
  process.exit(0);
}

main();
