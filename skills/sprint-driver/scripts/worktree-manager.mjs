#!/usr/bin/env node
// worktree-manager.mjs — central authority for git worktree + branch lifecycle.
// Replaces ad-hoc `git worktree add` calls scattered in implementer agents.
// Single source of truth: .bypilot/worktree-registry.json
//
// Branch naming:  task-<sprint>-<id>-<6charHash>
// Worktree path:  .claude/worktrees/<branchName>/
//
// Commands:
//   acquire --task <id> --sprint <slug> [--base <ref=HEAD>] [--scope <name>]
//     -> JSON { worktreePath, branchName, baseSha, reused }
//   release --task <id> --mode pushed|abandoned|stale [--keep-branch]
//   list [--json]
//   status --task <id>
//   ensure-lock         # PID-based exclusive lock; BYPILOT_ROOT must match cwd
//   release-lock
//   gc                  # prune orphan registry entries (worktree disappeared from disk)
//
// Pre-acquire side effect: invokes recovery-points.mjs `tag --reason wt-acquire-<id>`
// (best-effort; never blocks).

import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync, rmSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.BYPILOT_ROOT || process.cwd();
const BP_DIR = resolve(ROOT, '.bypilot');
const REGISTRY = resolve(BP_DIR, 'worktree-registry.json');
const LOCK = resolve(BP_DIR, 'lock');
const WT_BASE = resolve(ROOT, '.claude/worktrees');
const RECOVERY_SCRIPT = resolve(SCRIPT_DIR, 'recovery-points.mjs');
const DECISIONS_LOG = resolve(ROOT, 'docs/decisions.log');

const log = (...m) => process.stderr.write('[wt-mgr] ' + m.join(' ') + '\n');
const die = (code, msg) => { log('ERROR:', msg); process.exit(code); };

function ensureDir(p) { mkdirSync(p, { recursive: true }); }
function readJson(p, def) {
  if (!existsSync(p)) return def;
  try { return JSON.parse(readFileSync(p, 'utf8')); }
  catch { return def; }
}
function writeJson(p, data) {
  ensureDir(dirname(p));
  writeFileSync(p, JSON.stringify(data, null, 2) + '\n');
}
function git(args, opts = {}) {
  const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', ...opts });
  if (r.status !== 0 && !opts.allowFail) {
    die(2, `git ${args.join(' ')} failed: ${r.stderr.trim()}`);
  }
  return r;
}
function getArg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
}
function hasFlag(name) { return process.argv.includes(`--${name}`); }

function shortHash(input) {
  return createHash('sha1').update(input + '|' + Date.now()).digest('hex').slice(0, 6);
}
function slugify(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
}
function readRegistry() { return readJson(REGISTRY, { version: 1, items: {} }); }
function writeRegistry(r) { writeJson(REGISTRY, r); }

function appendDecision(line) {
  ensureDir(dirname(DECISIONS_LOG));
  const ts = new Date().toISOString();
  writeFileSync(DECISIONS_LOG, `${ts} ${line}\n`, { flag: 'a' });
}

function bestEffortTag(reason) {
  const r = spawnSync('node', [RECOVERY_SCRIPT, 'tag', '--reason', reason], {
    cwd: ROOT, encoding: 'utf8',
  });
  if (r.status !== 0) log('snapshot tag skipped:', (r.stderr || '').trim());
  else try { return JSON.parse(r.stdout).name; } catch { return null; }
}

function branchExists(name) {
  return git(['show-ref', '--verify', '--quiet', `refs/heads/${name}`], { allowFail: true }).status === 0;
}
function worktreeExistsAt(path) {
  const r = git(['worktree', 'list', '--porcelain'], { allowFail: true });
  return (r.stdout || '').split('\n').some(l => l === `worktree ${path}`);
}

// ─── lock ─────────────────────────────────────────────────────────────────────
function pidAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === 'EPERM'; }
}
function cmdEnsureLock() {
  // Verify cwd matches BYPILOT_ROOT (catch the two-parent-repo confusion).
  if (resolve(process.cwd()) !== resolve(ROOT)) {
    die(2, `BYPILOT_ROOT (${ROOT}) != cwd (${process.cwd()}). Refusing to acquire lock.`);
  }
  ensureDir(BP_DIR);
  if (existsSync(LOCK)) {
    const cur = readJson(LOCK, null);
    if (cur && pidAlive(cur.pid)) {
      die(2, `lock held by PID ${cur.pid} since ${cur.ts}`);
    }
    log('stale lock detected, taking over');
  }
  writeJson(LOCK, { pid: process.pid, ts: new Date().toISOString(), root: ROOT });
  console.log(JSON.stringify({ ok: true, pid: process.pid }));
}
function cmdReleaseLock() {
  if (!existsSync(LOCK)) { console.log(JSON.stringify({ ok: true, noop: true })); return; }
  const cur = readJson(LOCK, null);
  if (!cur || cur.pid === process.pid || !pidAlive(cur.pid)) {
    rmSync(LOCK, { force: true });
    console.log(JSON.stringify({ ok: true }));
  } else {
    die(2, `lock held by another live PID ${cur.pid}`);
  }
}

// ─── acquire ──────────────────────────────────────────────────────────────────
function cmdAcquire() {
  const taskId = getArg('task') || die(1, '--task required');
  const sprintSlug = slugify(getArg('sprint') || die(1, '--sprint required'));
  const base = getArg('base', 'HEAD');
  const scope = getArg('scope', '');

  const reg = readRegistry();
  const existing = reg.items[taskId];
  if (existing && worktreeExistsAt(existing.worktreePath)) {
    log('reusing existing worktree for', taskId);
    console.log(JSON.stringify({ ...existing, reused: true }));
    return;
  }

  // collision-resistant branch name
  let branchName, attempt = 0;
  do {
    const hash = shortHash(`${sprintSlug}-${taskId}-${attempt}`);
    branchName = `task-${sprintSlug}-${slugify(taskId)}-${hash}`;
    attempt++;
    if (attempt > 8) die(2, 'could not find collision-free branch name');
  } while (branchExists(branchName));

  const worktreePath = resolve(WT_BASE, branchName);
  if (existsSync(worktreePath)) {
    die(2, `worktree path already exists on disk: ${worktreePath}`);
  }

  bestEffortTag(`wt-acquire-${slugify(taskId)}`);

  const baseSha = git(['rev-parse', base]).stdout.trim();
  ensureDir(WT_BASE);
  git(['worktree', 'add', '-b', branchName, worktreePath, baseSha]);

  const entry = {
    taskId,
    sprintSlug,
    scope,
    branchName,
    worktreePath,
    baseSha,
    createdAt: new Date().toISOString(),
    status: 'active',
  };
  reg.items[taskId] = entry;
  writeRegistry(reg);
  appendDecision(`wt-acquire ${taskId} -> ${branchName} @ ${worktreePath}`);

  console.log(JSON.stringify({ ...entry, reused: false }));
}

// ─── release ──────────────────────────────────────────────────────────────────
function cmdRelease() {
  const taskId = getArg('task') || die(1, '--task required');
  const mode = getArg('mode') || die(1, '--mode pushed|abandoned|stale required');
  const keepBranch = hasFlag('keep-branch');

  const reg = readRegistry();
  const entry = reg.items[taskId];
  if (!entry) {
    log('no registry entry for', taskId, '— nothing to release');
    console.log(JSON.stringify({ ok: true, noop: true }));
    return;
  }

  // bundle the branch before any destructive op (safety net).
  spawnSync('node', [RECOVERY_SCRIPT, 'bundle', '--branch', entry.branchName], {
    cwd: ROOT, encoding: 'utf8',
  });

  if (mode === 'pushed') {
    // Worktree+branch survive (user pushed, may continue to use). Just mark.
    entry.status = 'released-pushed';
    entry.releasedAt = new Date().toISOString();
    reg.items[taskId] = entry;
    writeRegistry(reg);
    appendDecision(`wt-release ${taskId} mode=pushed (branch retained)`);
    console.log(JSON.stringify({ ok: true, mode, retained: true }));
    return;
  }

  // abandoned | stale: prune worktree + delete branch (unless --keep-branch).
  git(['worktree', 'remove', '--force', entry.worktreePath], { allowFail: true });
  if (!keepBranch) {
    git(['branch', '-D', entry.branchName], { allowFail: true });
  }
  entry.status = `released-${mode}`;
  entry.releasedAt = new Date().toISOString();
  reg.items[taskId] = entry;
  writeRegistry(reg);
  appendDecision(`wt-release ${taskId} mode=${mode} branch=${keepBranch ? 'kept' : 'deleted'}`);
  console.log(JSON.stringify({ ok: true, mode, retained: keepBranch }));
}

// ─── list / status / gc ───────────────────────────────────────────────────────
function cmdList() {
  const reg = readRegistry();
  const items = Object.values(reg.items);
  if (hasFlag('json')) { console.log(JSON.stringify(items, null, 2)); return; }
  for (const it of items) {
    console.log(`${it.taskId.padEnd(28)} ${it.status.padEnd(20)} ${it.branchName}`);
  }
}
function cmdStatus() {
  const taskId = getArg('task') || die(1, '--task required');
  const reg = readRegistry();
  const entry = reg.items[taskId];
  if (!entry) { console.log(JSON.stringify({ found: false })); return; }
  const onDisk = worktreeExistsAt(entry.worktreePath);
  const branchOk = branchExists(entry.branchName);
  console.log(JSON.stringify({ found: true, onDisk, branchOk, ...entry }));
}
function cmdGc() {
  const reg = readRegistry();
  const removed = [];
  for (const [taskId, entry] of Object.entries(reg.items)) {
    if (entry.status?.startsWith('released-')) continue;
    if (!worktreeExistsAt(entry.worktreePath) && !branchExists(entry.branchName)) {
      removed.push(taskId);
      delete reg.items[taskId];
    }
  }
  writeRegistry(reg);
  console.log(JSON.stringify({ removed, remaining: Object.keys(reg.items).length }));
}

const cmd = process.argv[2];
const dispatch = {
  acquire: cmdAcquire, release: cmdRelease, list: cmdList, status: cmdStatus,
  'ensure-lock': cmdEnsureLock, 'release-lock': cmdReleaseLock, gc: cmdGc,
};
if (!dispatch[cmd]) {
  log('commands: acquire | release | list | status | ensure-lock | release-lock | gc');
  process.exit(1);
}
dispatch[cmd]();
