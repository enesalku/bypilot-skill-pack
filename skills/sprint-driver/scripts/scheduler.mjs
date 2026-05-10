#!/usr/bin/env node
// scheduler.mjs — continuous DAG scheduler for bypilot.
// Replaces wave-picker.mjs for the new continuous mode. wave-picker.mjs is
// preserved for the legacy wave-based driver path.
//
// Model:
//   - Slot pool of capacity = manifest.maxParallel (default 3).
//   - Whenever a slot frees, claim() returns the best K ready tasks NOT
//     conflicting with the current busySet (running tasks' files+conflictsWith).
//   - "Mini-burst": claim() returns up to `slots` tasks in one call so the
//     driver can spawn them in a single Agent batch (LLM cache locality).
//   - Epoch boundaries are advisory checkpoints (UI / clear / instinct check),
//     decided by epoch-trigger().
//
// Sub-commands:
//   claim   --busy <id1,id2,...> --slots <N>             → JSON { ready, claim, blockedCount, doneCount }
//   ready   [--busy <ids>]                                → JSON { ready: [task-summaries] }
//   epoch   --since <ISO> --completed-since-epoch <N>
//           [--max-tasks <K>] [--max-minutes <T>] [--escalation true|false]
//                                                          → JSON { boundary: bool, reason }
//   summary                                                → JSON { totals, sprints }
//   state                                                  → like wave-picker --check (compat)
//
// Always exits 0 unless input is malformed (1) or DAG is broken (2).

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = process.env.BYPILOT_ROOT || process.cwd();

const log = (...m) => process.stderr.write('[scheduler] ' + m.join(' ') + '\n');

function readJSON(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch (e) { log('failed to read', path, ':', e.message); return null; }
}

function loadManifest() {
  const path = resolve(ROOT, 'docs/sprints.manifest.json');
  if (!existsSync(path)) {
    const docs = resolve(ROOT, 'docs');
    if (!existsSync(docs)) return { active: [], maxParallel: 3 };
    const sprints = readdirSync(docs).filter(f => f.startsWith('sprint-'));
    return { active: sprints, maxParallel: 3, checkpointEvery: 5 };
  }
  return readJSON(path) || { active: [], maxParallel: 3 };
}

function loadActiveTasks(manifest) {
  const all = [];
  for (const sprint of manifest.active) {
    const p = resolve(ROOT, 'docs', sprint, 'tasks.json');
    if (!existsSync(p)) { log('skipping missing', p); continue; }
    const data = readJSON(p);
    if (!data || !Array.isArray(data.tasks)) continue;
    for (const t of data.tasks) all.push({ ...t, _sprint: sprint });
  }
  return all;
}

function detectCycle(tasks) {
  const color = new Map();
  const taskMap = new Map(tasks.map(t => [t.id, t]));
  for (const t of tasks) color.set(t.id, 0);

  function visit(start) {
    const stack = [[start, 0]];
    while (stack.length) {
      const [id, depIdx] = stack[stack.length - 1];
      if (depIdx === 0) {
        if (color.get(id) === 1) return [...stack.map(([x]) => x)];
        if (color.get(id) === 2) { stack.pop(); continue; }
        color.set(id, 1);
      }
      const t = taskMap.get(id);
      const deps = (t && t.dependsOn) || [];
      if (depIdx >= deps.length) { color.set(id, 2); stack.pop(); continue; }
      stack[stack.length - 1][1] = depIdx + 1;
      const next = deps[depIdx];
      if (!taskMap.has(next)) continue;
      stack.push([next, 0]);
    }
    return null;
  }

  for (const t of tasks) {
    if (color.get(t.id) !== 0) continue;
    const cycle = visit(t.id);
    if (cycle) return cycle;
  }
  return null;
}

function computeReady(tasks, busyIds) {
  const doneIds = new Set(tasks.filter(t => t.status === 'done').map(t => t.id));
  const busy = new Set(busyIds);
  return tasks.filter(t => {
    if (t.status !== 'pending') return false;
    if (busy.has(t.id)) return false;
    const deps = t.dependsOn || [];
    return deps.every(d => doneIds.has(d));
  });
}

function filesOverlap(a, b) {
  const fa = new Set(a.files || []);
  for (const f of b.files || []) if (fa.has(f)) return true;
  return false;
}
function conflictsWith(a, b) {
  if (filesOverlap(a, b)) return true;
  const cw = new Set([...(a.conflictsWith || []), ...(b.conflictsWith || [])]);
  return cw.has(a.id) || cw.has(b.id);
}

function computeBusyConflictSet(tasks, busyIds) {
  // For each running task, its files+conflictsWith form the exclusion set.
  // We return the ids the busy set conflicts with (for filtering ready tasks).
  const busySet = busyIds.map(id => tasks.find(t => t.id === id)).filter(Boolean);
  return busySet;
}

function criticalPathDepth(taskId, taskMap, memo = new Map()) {
  if (memo.has(taskId)) return memo.get(taskId);
  const t = taskMap.get(taskId);
  if (!t) return 0;
  let maxChild = 0;
  for (const [id, other] of taskMap) {
    if ((other.dependsOn || []).includes(taskId)) {
      maxChild = Math.max(maxChild, criticalPathDepth(id, taskMap, memo));
    }
  }
  const d = 1 + maxChild;
  memo.set(taskId, d);
  return d;
}

function rankReady(ready, allTasks) {
  const taskMap = new Map(allTasks.map(t => [t.id, t]));
  const costRank = { XS: 0, S: 1, M: 2, L: 3, XL: 4 };
  return [...ready].sort((a, b) => {
    const pa = a.priority || 3, pb = b.priority || 3;
    if (pa !== pb) return pa - pb;
    const da = criticalPathDepth(a.id, taskMap);
    const db = criticalPathDepth(b.id, taskMap);
    if (da !== db) return db - da;
    return (costRank[a.estCost] ?? 2) - (costRank[b.estCost] ?? 2);
  });
}

function pickClaim(rankedReady, busyTasks, slots) {
  // Pick up to `slots` tasks from rankedReady such that none conflict with
  // each other or with busyTasks.
  const claim = [];
  for (const t of rankedReady) {
    if (claim.length >= slots) break;
    if (busyTasks.some(b => conflictsWith(b, t))) continue;
    if (claim.some(c => conflictsWith(c, t))) continue;
    claim.push(t);
  }
  return claim;
}

function summarize(t) {
  return {
    id: t.id, title: t.title, sprint: t._sprint, scope: t.scope,
    testDepth: t.testDepth, priority: t.priority || 3, estCost: t.estCost,
    files: t.files || [], dependsOn: t.dependsOn || [],
    affects: t.affects || [],
  };
}

function getArg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
}
function parseList(s) {
  return (s || '').split(',').map(x => x.trim()).filter(Boolean);
}

function loadAllAndCheck() {
  const manifest = loadManifest();
  const tasks = loadActiveTasks(manifest);
  const cycle = detectCycle(tasks);
  if (cycle) { console.log(JSON.stringify({ error: 'cycle', cycle })); process.exit(2); }
  const counts = { done: 0, pending: 0, blocked: 0, in_progress: 0 };
  for (const t of tasks) counts[t.status] = (counts[t.status] || 0) + 1;
  return { manifest, tasks, counts };
}

// ─── claim ────────────────────────────────────────────────────────────────
function cmdClaim() {
  const busyIds = parseList(getArg('busy', ''));
  const slots = Number(getArg('slots') || 1);
  if (slots < 1) { console.log(JSON.stringify({ error: '--slots must be >=1' })); process.exit(1); }
  const { tasks, counts, manifest } = loadAllAndCheck();
  const ready = computeReady(tasks, busyIds);
  const ranked = rankReady(ready, tasks);
  const busyTasks = computeBusyConflictSet(tasks, busyIds);
  const claim = pickClaim(ranked, busyTasks, slots);
  const result = {
    claim: claim.map(summarize),
    readyCount: ready.length,
    blockedByConflict: ready.length - claim.length,
    busy: busyIds,
    capacity: manifest.maxParallel || 3,
    doneCount: counts.done, blockedCount: counts.blocked,
    totalPending: counts.pending, inProgressCount: counts.in_progress,
  };
  console.log(JSON.stringify(result, null, 2));
}

// ─── ready ────────────────────────────────────────────────────────────────
function cmdReady() {
  const busyIds = parseList(getArg('busy', ''));
  const { tasks } = loadAllAndCheck();
  const ready = computeReady(tasks, busyIds);
  const ranked = rankReady(ready, tasks);
  console.log(JSON.stringify({ ready: ranked.map(summarize) }, null, 2));
}

// ─── epoch ────────────────────────────────────────────────────────────────
function cmdEpoch() {
  const since = getArg('since');
  const completed = Number(getArg('completed-since-epoch') || 0);
  const maxTasks = Number(getArg('max-tasks') || 6);
  const maxMinutes = Number(getArg('max-minutes') || 15);
  const escalation = getArg('escalation', 'false') === 'true';
  const newInstincts = Number(getArg('new-instincts') || 0);

  const reasons = [];
  let boundary = false;

  if (escalation) { boundary = true; reasons.push('debugger-escalate'); }
  if (completed >= maxTasks) { boundary = true; reasons.push(`completed>=${maxTasks}`); }
  if (newInstincts > 0) { boundary = true; reasons.push(`instinct-confidence-high(${newInstincts})`); }
  if (since) {
    const ageMs = Date.now() - new Date(since).getTime();
    const ageMin = ageMs / 60000;
    if (ageMin >= maxMinutes) { boundary = true; reasons.push(`epoch-age>=${maxMinutes}min`); }
  }
  console.log(JSON.stringify({ boundary, reasons }));
}

// ─── summary ──────────────────────────────────────────────────────────────
function cmdSummary() {
  const { manifest, tasks, counts } = loadAllAndCheck();
  const sprints = {};
  for (const t of tasks) {
    sprints[t._sprint] = sprints[t._sprint] || { done: 0, pending: 0, blocked: 0, in_progress: 0 };
    sprints[t._sprint][t.status] = (sprints[t._sprint][t.status] || 0) + 1;
  }
  console.log(JSON.stringify({
    capacity: manifest.maxParallel || 3,
    totals: counts,
    sprints,
    completedAt: counts.pending === 0 && counts.in_progress === 0 ? new Date().toISOString() : null,
  }, null, 2));
}

// ─── state (wave-picker compat) ───────────────────────────────────────────
function cmdState() {
  const { tasks, counts } = loadAllAndCheck();
  if (counts.pending === 0 && counts.in_progress === 0) process.exit(1); // all done
  const ready = computeReady(tasks, []);
  process.exit(ready.length > 0 ? 0 : 2); // 2 = stuck (deps blocked)
}

const cmd = process.argv[2];
const dispatch = {
  claim: cmdClaim, ready: cmdReady, epoch: cmdEpoch,
  summary: cmdSummary, state: cmdState,
};
if (!dispatch[cmd]) {
  log('commands: claim | ready | epoch | summary | state');
  process.exit(1);
}
dispatch[cmd]();
