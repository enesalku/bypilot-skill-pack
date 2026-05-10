#!/usr/bin/env node
// classify-worktrees.mjs — READ-ONLY classifier for worktree migration.
// Reads `git worktree list --porcelain` + branch metadata + remote refs,
// emits a JSON plan describing what would happen if migration ran.
//
// IMPORTANT: this script never executes destructive actions. Migration runner
// is a separate script (TODO: migrate-worktrees.mjs) that consumes this output.
//
// Classification rules (match plan G.7):
//   pushed    + age <  24h  → KEEP  (active work)
//   pushed    + age >= 24h  → PRUNE (code is safe on origin)
//   unpushed  + has-commits + touch < 7d → KEEP+FLAG
//   unpushed  + no-commits  + touch < 24h → KEEP
//   unpushed  + no-commits  + touch > 24h → PRUNE (bundle first)
//   locked + dead-owner → UNLOCK_RECLASSIFY
//   orphan branch ref (no worktree, no upstream) → DELETE (backup first)
//
// Usage:
//   node classify-worktrees.mjs [--json]
// Exit: 0 always (read-only).

import { readFileSync, existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = process.env.BYPILOT_ROOT || process.cwd();
const log = (...m) => process.stderr.write('[wt-classify] ' + m.join(' ') + '\n');

function git(args, opts = {}) {
  const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', ...opts });
  return r;
}

function parseWorktrees() {
  const r = git(['worktree', 'list', '--porcelain']);
  const lines = (r.stdout || '').split('\n');
  const items = [];
  let cur = null;
  for (const line of lines) {
    if (line.startsWith('worktree ')) {
      if (cur) items.push(cur);
      cur = { path: line.slice(9), branch: null, head: null, locked: false, lockedReason: '' };
    } else if (line.startsWith('HEAD ') && cur) {
      cur.head = line.slice(5);
    } else if (line.startsWith('branch ') && cur) {
      cur.branch = line.slice(7).replace('refs/heads/', '');
    } else if (line === 'locked' && cur) {
      cur.locked = true;
    } else if (line.startsWith('locked ') && cur) {
      cur.locked = true; cur.lockedReason = line.slice(7);
    }
  }
  if (cur) items.push(cur);
  return items;
}

function lastCommitAge(ref) {
  const r = git(['log', '-1', '--format=%ct', ref], { allowFail: true });
  if (r.status !== 0) return { hours: Infinity, ts: null };
  const ts = Number(r.stdout.trim()) * 1000;
  return { hours: (Date.now() - ts) / 36e5, ts: new Date(ts).toISOString() };
}

function lastDiskTouch(path) {
  if (!existsSync(path)) return { hours: Infinity };
  try {
    const s = statSync(path);
    return { hours: (Date.now() - s.mtimeMs) / 36e5 };
  } catch { return { hours: Infinity }; }
}

function isPushed(branch) {
  if (!branch) return false;
  const r = git(['ls-remote', '--exit-code', '--heads', 'origin', branch], { allowFail: true });
  return r.status === 0;
}

function hasCommitsBeyondBase(branch, base = 'main') {
  if (!branch) return false;
  const r = git(['rev-list', '--count', `${base}..${branch}`], { allowFail: true });
  if (r.status !== 0) return false;
  return Number(r.stdout.trim()) > 0;
}

function lockOwnerAlive(reason) {
  const m = String(reason || '').match(/pid[=: ]+(\d+)/i);
  if (!m) return null;
  const pid = Number(m[1]);
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === 'EPERM' ? true : false; }
}

function classifyOne(wt) {
  const age = lastCommitAge(wt.branch || wt.head);
  const touch = lastDiskTouch(wt.path);
  const pushed = isPushed(wt.branch);
  const hasCommits = hasCommitsBeyondBase(wt.branch);

  // Skip the parent worktree itself (no branch ref usually means main checkout)
  const isParent = resolve(wt.path) === resolve(ROOT);
  if (isParent) {
    return { decision: 'KEEP', reason: 'parent-checkout' };
  }

  if (wt.locked) {
    const alive = lockOwnerAlive(wt.lockedReason);
    if (alive === false) {
      return { decision: 'UNLOCK_RECLASSIFY', reason: `lock owner dead (${wt.lockedReason})` };
    }
    if (alive === true) {
      return { decision: 'KEEP', reason: `locked, owner alive (${wt.lockedReason})` };
    }
    return { decision: 'KEEP', reason: `locked, owner unknown (${wt.lockedReason})` };
  }

  if (pushed && age.hours < 24) {
    return { decision: 'KEEP', reason: `pushed + recent (${age.hours.toFixed(1)}h)` };
  }
  if (pushed && age.hours >= 24) {
    return { decision: 'PRUNE', reason: `pushed + stale (${age.hours.toFixed(1)}h); code safe on origin` };
  }
  if (hasCommits && touch.hours < 24 * 7) {
    return { decision: 'KEEP_FLAG', reason: `unpushed work-in-progress (${touch.hours.toFixed(1)}h since touch)` };
  }
  if (!hasCommits && touch.hours < 24) {
    return { decision: 'KEEP', reason: `fresh empty worktree (${touch.hours.toFixed(1)}h)` };
  }
  if (!hasCommits && touch.hours >= 24) {
    return { decision: 'PRUNE', reason: `empty + stale (${touch.hours.toFixed(1)}h); will bundle first` };
  }
  return { decision: 'KEEP_FLAG', reason: 'fallback — needs human eyes' };
}

function findOrphanBranches(activeBranches) {
  const r = git(['for-each-ref', '--format=%(refname:short)|%(upstream:short)|%(committerdate:iso-strict)', 'refs/heads/']);
  const items = [];
  for (const line of (r.stdout || '').split('\n').filter(Boolean)) {
    const [name, upstream, when] = line.split('|');
    if (activeBranches.has(name)) continue;
    if (name === 'main' || name === 'master') continue;
    // orphan candidates: bypilot-related naming patterns
    const isWorktreeOrphan = /^worktree-agent-/.test(name);
    const isAbandonedAgent = /^(task-|agent-a)/.test(name);
    if (!isWorktreeOrphan && !isAbandonedAgent) continue;
    const pushed = isPushed(name);
    const decision = isWorktreeOrphan ? 'DELETE' : (pushed ? 'KEEP' : 'DELETE');
    items.push({
      branch: name, upstream: upstream || null, when, pushed,
      decision, reason: isWorktreeOrphan
        ? 'orphan worktree-* ref (no worktree)'
        : (pushed ? 'pushed; safe on origin' : 'unpushed agent branch with no worktree'),
    });
  }
  return items;
}

function main() {
  const wts = parseWorktrees();
  const activeBranches = new Set(wts.map(w => w.branch).filter(Boolean));
  const enriched = wts.map(wt => {
    const cls = classifyOne(wt);
    return {
      ...wt,
      pushed: isPushed(wt.branch),
      hasCommits: hasCommitsBeyondBase(wt.branch),
      lastCommitAgeHours: lastCommitAge(wt.branch || wt.head).hours,
      lastTouchAgeHours: lastDiskTouch(wt.path).hours,
      ...cls,
    };
  });
  const orphans = findOrphanBranches(activeBranches);

  const summary = {
    keep: enriched.filter(w => w.decision === 'KEEP').length,
    keep_flag: enriched.filter(w => w.decision === 'KEEP_FLAG').length,
    prune: enriched.filter(w => w.decision === 'PRUNE').length,
    unlock_reclassify: enriched.filter(w => w.decision === 'UNLOCK_RECLASSIFY').length,
    orphans_delete: orphans.filter(o => o.decision === 'DELETE').length,
    orphans_keep: orphans.filter(o => o.decision === 'KEEP').length,
  };

  const result = { generatedAt: new Date().toISOString(), root: ROOT, summary, worktrees: enriched, orphanBranches: orphans };
  console.log(JSON.stringify(result, null, 2));
}

main();
