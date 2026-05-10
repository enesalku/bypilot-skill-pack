#!/usr/bin/env node
// save-resume.mjs — persist resume state for /bypilot-sprint-driver --resume.
// Aggregates active sprint tasks into docs/.bypilot-state.json. Idempotent; safe to call any time.
//
// Usage:
//   node save-resume.mjs [--wave N] [--note "free-text"]
//
// Writes docs/.bypilot-state.json with counts, in-progress task ids, last wave id, and timestamp.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = process.cwd();
const log = (...m) => process.stderr.write('[save-resume] ' + m.join(' ') + '\n');

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
  const waveArg = getArg('wave');
  const note = getArg('note');
  const manifest = loadManifest();

  const sprints = [];
  let totalPending = 0, totalDone = 0, totalBlocked = 0, totalInProgress = 0;
  const inProgressIds = [];
  const blockedIds = [];

  for (const sprint of manifest.active) {
    const path = resolve(ROOT, 'docs', sprint, 'tasks.json');
    if (!existsSync(path)) continue;
    const data = readJSON(path);
    const counts = { done: 0, pending: 0, blocked: 0, in_progress: 0 };
    for (const t of data.tasks || []) {
      counts[t.status] = (counts[t.status] || 0) + 1;
      if (t.status === 'in_progress') inProgressIds.push({ id: t.id, sprint, worktreePath: t.worktreePath });
      if (t.status === 'blocked') blockedIds.push({ id: t.id, sprint, reason: t.blockedReason });
    }
    sprints.push({ sprint, ...counts, total: data.tasks?.length ?? 0 });
    totalDone += counts.done;
    totalPending += counts.pending;
    totalBlocked += counts.blocked;
    totalInProgress += counts.in_progress;
  }

  const state = {
    updatedAt: new Date().toISOString(),
    lastWave: waveArg ? Number(waveArg) : null,
    note: note || null,
    totals: {
      done: totalDone,
      pending: totalPending,
      blocked: totalBlocked,
      in_progress: totalInProgress
    },
    sprints,
    inProgress: inProgressIds,
    blocked: blockedIds,
    completedAt: (totalPending === 0 && totalInProgress === 0) ? new Date().toISOString() : null
  };

  const out = resolve(ROOT, 'docs/.bypilot-state.json');
  writeJSON(out, state);
  log('wrote', out);
  console.log(JSON.stringify(state, null, 2));
  process.exit(0);
}

main();
