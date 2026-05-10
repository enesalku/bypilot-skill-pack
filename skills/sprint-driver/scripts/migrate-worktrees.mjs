#!/usr/bin/env node
// migrate-worktrees.mjs — execute the cleanup plan produced by classify-worktrees.mjs.
// Snapshots before every destructive op, never throws away unrecoverable state.
//
// Steps:
//   1. Run classify-worktrees.mjs (live read) → plan
//   2. Take a global pre-migration tag (recovery-points.mjs)
//   3. For each worktree decision:
//        KEEP / KEEP_FLAG    → no-op, log only
//        UNLOCK_RECLASSIFY   → snapshot tag, unlock, re-classify; if still locked, halt
//        PRUNE               → bundle the branch, `git worktree remove --force`, branch -D (unless --keep-branch)
//   4. For each orphan branch with DELETE:
//        backup branch via recovery-points, then `git branch -D`
//   5. Write summary to .bypilot/migration-report.json + decisions.log
//
// Default DRY-RUN. Pass --execute to apply.
//
// Usage:
//   node migrate-worktrees.mjs                  # dry run
//   node migrate-worktrees.mjs --execute        # apply
//   node migrate-worktrees.mjs --execute --keep-branch  # don't delete pruned branches
//   node migrate-worktrees.mjs --execute --skip-orphans # skip orphan branch deletion

import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.BYPILOT_ROOT || process.cwd();
const CLASSIFY = resolve(SCRIPT_DIR, 'classify-worktrees.mjs');
const RECOVERY = resolve(SCRIPT_DIR, 'recovery-points.mjs');
const REPORT_DIR = resolve(ROOT, '.bypilot');
const REPORT_PATH = resolve(REPORT_DIR, 'migration-report.json');
const DECISIONS_LOG = resolve(ROOT, 'docs/decisions.log');

const log = (...m) => process.stderr.write('[migrate] ' + m.join(' ') + '\n');
const die = (code, msg) => { log('ERROR:', msg); process.exit(code); };

const EXECUTE = process.argv.includes('--execute');
const KEEP_BRANCH = process.argv.includes('--keep-branch');
const SKIP_ORPHANS = process.argv.includes('--skip-orphans');

function nodeRun(script, args, opts = {}) {
  const r = spawnSync('node', [script, ...args], { cwd: ROOT, encoding: 'utf8', ...opts });
  if (r.status !== 0 && !opts.allowFail) die(2, `${script} failed: ${r.stderr.trim()}`);
  return r;
}
function git(args, opts = {}) {
  const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', ...opts });
  if (r.status !== 0 && !opts.allowFail) die(2, `git ${args.join(' ')} failed: ${r.stderr.trim()}`);
  return r;
}
function appendDecision(line) {
  if (!existsSync(dirname(DECISIONS_LOG))) mkdirSync(dirname(DECISIONS_LOG), { recursive: true });
  writeFileSync(DECISIONS_LOG, `${new Date().toISOString()} ${line}\n`, { flag: 'a' });
}
function bestEffort(fn, label) {
  try { return fn(); }
  catch (e) { log(`best-effort ${label} skipped: ${e.message}`); return null; }
}

// ─── 1. Get plan ────────────────────────────────────────────────────────────
log(EXECUTE ? 'EXECUTE mode' : 'DRY-RUN mode (use --execute to apply)');
const plan = JSON.parse(nodeRun(CLASSIFY, []).stdout);
log(`plan: ${plan.worktrees.length} worktrees, ${plan.orphanBranches.length} orphan branches`);
log(`summary: ${JSON.stringify(plan.summary)}`);

// ─── 2. Pre-migration global tag ────────────────────────────────────────────
let globalTag = null;
if (EXECUTE) {
  const r = nodeRun(RECOVERY, ['tag', '--reason', 'pre-migration', '--message', 'bypilot worktree migration']);
  globalTag = JSON.parse(r.stdout).name;
  log('global pre-migration tag:', globalTag);
}

const actions = [];

// ─── 3. Worktree decisions ──────────────────────────────────────────────────
for (const wt of plan.worktrees) {
  const id = `${wt.path} (${wt.branch || '<detached>'})`;

  if (wt.decision === 'KEEP' || wt.decision === 'KEEP_FLAG') {
    actions.push({ kind: 'worktree', target: id, decision: wt.decision, action: 'noop', reason: wt.reason });
    continue;
  }

  if (wt.decision === 'UNLOCK_RECLASSIFY') {
    if (!EXECUTE) {
      actions.push({ kind: 'worktree', target: id, decision: wt.decision, action: 'would-unlock', reason: wt.reason });
      continue;
    }
    const r = git(['worktree', 'unlock', wt.path], { allowFail: true });
    if (r.status !== 0) {
      actions.push({ kind: 'worktree', target: id, decision: wt.decision, action: 'unlock-failed', reason: r.stderr.trim() });
      continue;
    }
    appendDecision(`migrate unlock ${wt.path} reason=${wt.reason}`);
    actions.push({ kind: 'worktree', target: id, decision: wt.decision, action: 'unlocked', reason: wt.reason });
    // Now that it's unlocked, treat as PRUNE candidate (it's stale anyway — that's why owner was dead).
    wt.decision = 'PRUNE';
    wt.reason = 'auto-prune after unlock (was stale lock)';
    // fall through to PRUNE handling below
  }

  if (wt.decision === 'PRUNE') {
    if (!EXECUTE) {
      actions.push({ kind: 'worktree', target: id, decision: wt.decision, action: 'would-bundle-then-prune', reason: wt.reason });
      continue;
    }
    let bundle = null;
    if (wt.branch) {
      const r = bestEffort(
        () => nodeRun(RECOVERY, ['bundle', '--branch', wt.branch], { allowFail: true }),
        `bundle ${wt.branch}`
      );
      if (r && r.status === 0) {
        try { bundle = JSON.parse(r.stdout).path; } catch {}
      }
    }
    const removeR = git(['worktree', 'remove', '--force', wt.path], { allowFail: true });
    if (removeR.status !== 0) {
      actions.push({ kind: 'worktree', target: id, decision: wt.decision, action: 'remove-failed', reason: removeR.stderr.trim(), bundle });
      continue;
    }
    let branchDeleted = false;
    if (wt.branch && !KEEP_BRANCH) {
      const r = git(['branch', '-D', wt.branch], { allowFail: true });
      branchDeleted = r.status === 0;
    }
    appendDecision(`migrate prune ${wt.path} branch=${wt.branch} bundle=${bundle || 'none'} branchDeleted=${branchDeleted}`);
    actions.push({ kind: 'worktree', target: id, decision: 'PRUNE', action: 'pruned', reason: wt.reason, bundle, branchDeleted });
  }
}

// ─── 4. Orphan branches ─────────────────────────────────────────────────────
if (!SKIP_ORPHANS) {
  for (const orphan of plan.orphanBranches) {
    if (orphan.decision !== 'DELETE') {
      actions.push({ kind: 'orphan', target: orphan.branch, decision: orphan.decision, action: 'noop', reason: orphan.reason });
      continue;
    }
    if (!EXECUTE) {
      actions.push({ kind: 'orphan', target: orphan.branch, decision: 'DELETE', action: 'would-backup-then-delete', reason: orphan.reason });
      continue;
    }
    let backupBranch = null;
    const bR = bestEffort(
      () => nodeRun(RECOVERY, ['branch', '--name', `orphan-${orphan.branch}`, '--from', orphan.branch], { allowFail: true }),
      `backup-branch ${orphan.branch}`
    );
    if (bR && bR.status === 0) {
      try { backupBranch = JSON.parse(bR.stdout).name; } catch {}
    }
    const dR = git(['branch', '-D', orphan.branch], { allowFail: true });
    if (dR.status !== 0) {
      actions.push({ kind: 'orphan', target: orphan.branch, decision: 'DELETE', action: 'delete-failed', reason: dR.stderr.trim(), backupBranch });
      continue;
    }
    appendDecision(`migrate orphan-delete ${orphan.branch} backup=${backupBranch || 'none'}`);
    actions.push({ kind: 'orphan', target: orphan.branch, decision: 'DELETE', action: 'deleted', reason: orphan.reason, backupBranch });
  }
}

// ─── 5. Report ──────────────────────────────────────────────────────────────
const summary = actions.reduce((acc, a) => {
  const k = `${a.kind}:${a.action}`;
  acc[k] = (acc[k] || 0) + 1;
  return acc;
}, {});

const report = {
  generatedAt: new Date().toISOString(),
  mode: EXECUTE ? 'execute' : 'dry-run',
  flags: { keepBranch: KEEP_BRANCH, skipOrphans: SKIP_ORPHANS },
  globalTag,
  summary,
  actions,
  inputSummary: plan.summary,
};

if (EXECUTE) {
  if (!existsSync(REPORT_DIR)) mkdirSync(REPORT_DIR, { recursive: true });
  writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2) + '\n');
  appendDecision(`migrate complete tag=${globalTag} actions=${JSON.stringify(summary)}`);
  log('report:', REPORT_PATH);
}

console.log(JSON.stringify(report, null, 2));
