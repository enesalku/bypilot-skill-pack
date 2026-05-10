#!/usr/bin/env node
// wave-picker.mjs — DAG resolver + parallel wave selection for bypilot.
// Reads docs/sprints.manifest.json + docs/sprint-*/tasks.json, picks the next runnable wave.
// Output: stdout = JSON, exit code conveys state:
//   0 = wave found (printed JSON has non-empty wave)
//   1 = all tasks done
//   2 = cycle / schema error

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';

const ROOT = process.cwd();
const args = process.argv.slice(2);
const CHECK_ONLY = args.includes('--check');

const log = (...m) => process.stderr.write('[wave-picker] ' + m.join(' ') + '\n');

function readJSON(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch (e) { log('failed to read', path, ':', e.message); return null; }
}

function loadManifest() {
  const path = resolve(ROOT, 'docs/sprints.manifest.json');
  if (!existsSync(path)) {
    // Backwards-compat: single sprint mode if manifest missing
    log('no sprints.manifest.json — falling back to docs/sprint-3/tasks.json');
    return { active: ['sprint-3'], maxParallel: 3, checkpointEvery: 5 };
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
  // Iterative DFS: white(0) / gray(1) / black(2) coloring
  const color = new Map();
  const taskMap = new Map(tasks.map(t => [t.id, t]));
  for (const t of tasks) color.set(t.id, 0);

  function visit(start) {
    const stack = [[start, 0]];
    while (stack.length) {
      const [id, depIdx] = stack[stack.length - 1];
      if (depIdx === 0) {
        if (color.get(id) === 1) return [...stack.map(([x]) => x)]; // cycle
        if (color.get(id) === 2) { stack.pop(); continue; }
        color.set(id, 1);
      }
      const t = taskMap.get(id);
      const deps = (t && t.dependsOn) || [];
      if (depIdx >= deps.length) {
        color.set(id, 2);
        stack.pop();
        continue;
      }
      stack[stack.length - 1][1] = depIdx + 1;
      const next = deps[depIdx];
      if (!taskMap.has(next)) {
        log('warning:', id, 'depends on unknown', next);
        continue;
      }
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

function computeReady(tasks) {
  const doneIds = new Set(tasks.filter(t => t.status === 'done').map(t => t.id));
  return tasks.filter(t => {
    if (t.status !== 'pending') return false;
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

function criticalPathDepth(taskId, taskMap, memo = new Map()) {
  if (memo.has(taskId)) return memo.get(taskId);
  const t = taskMap.get(taskId);
  if (!t) return 0;
  // depth = 1 + max depth of any task that depends on this one
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

function pickWave(ready, maxParallel) {
  if (ready.length === 0) return [];
  const taskMap = new Map(ready.map(t => [t.id, t]));
  // Sort by: priority asc (1=highest), then critical path depth desc, then estCost asc (cheap first)
  const costRank = { XS: 0, S: 1, M: 2, L: 3, XL: 4 };
  const sorted = [...ready].sort((a, b) => {
    const pa = a.priority || 3, pb = b.priority || 3;
    if (pa !== pb) return pa - pb;
    const da = criticalPathDepth(a.id, taskMap);
    const db = criticalPathDepth(b.id, taskMap);
    if (da !== db) return db - da;
    return (costRank[a.estCost] ?? 2) - (costRank[b.estCost] ?? 2);
  });

  const wave = [];
  for (const t of sorted) {
    if (wave.length >= maxParallel) break;
    if (wave.some(w => conflictsWith(w, t))) continue;
    wave.push(t);
  }
  return wave;
}

function main() {
  const manifest = loadManifest();
  const tasks = loadActiveTasks(manifest);

  if (tasks.length === 0) {
    console.log(JSON.stringify({ wave: [], totalPending: 0, doneCount: 0, blockedCount: 0, message: 'no tasks found' }));
    process.exit(1);
  }

  const cycle = detectCycle(tasks);
  if (cycle) {
    console.log(JSON.stringify({ error: 'cycle', cycle }));
    process.exit(2);
  }

  const counts = { done: 0, pending: 0, blocked: 0, in_progress: 0 };
  for (const t of tasks) counts[t.status] = (counts[t.status] || 0) + 1;

  if (counts.pending === 0 && counts.in_progress === 0) {
    console.log(JSON.stringify({ wave: [], doneCount: counts.done, blockedCount: counts.blocked, totalPending: 0, message: 'all done' }));
    process.exit(1);
  }

  const ready = computeReady(tasks);
  const wave = pickWave(ready, manifest.maxParallel || 3);

  const result = {
    wave: wave.map(t => ({
      id: t.id,
      title: t.title,
      sprint: t._sprint,
      scope: t.scope,
      testDepth: t.testDepth,
      priority: t.priority || 3,
      estCost: t.estCost,
      files: t.files || [],
      dependsOn: t.dependsOn || []
    })),
    readyCount: ready.length,
    blockedCount: counts.pending - ready.length,
    doneCount: counts.done,
    totalPending: counts.pending,
    inProgressCount: counts.in_progress
  };

  if (CHECK_ONLY) {
    process.exit(wave.length > 0 ? 0 : (counts.pending === 0 ? 1 : 2));
  }

  console.log(JSON.stringify(result, null, 2));
  process.exit(wave.length > 0 ? 0 : 1);
}

main();
