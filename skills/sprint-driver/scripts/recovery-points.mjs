#!/usr/bin/env node
// recovery-points.mjs — bypilot recovery primitives.
// Provides 4 snapshot kinds:
//   tag     — lightweight git tag at HEAD (cheap, persistent)
//   branch  — backup ref pointing at a chosen ref (lossless, kept locally)
//   bundle  — git bundle file under .bypilot/snapshots/ (standalone repo, restorable
//             even if branches are deleted)
//   state   — copy of docs/.bypilot-state.json into .bypilot/state-history/
//
// Every operation appends to .bypilot/recovery-log.jsonl (append-only audit).
// Snapshots are LOCAL ONLY by design (no push). Cleanup handled by housekeeping.mjs.
//
// Usage:
//   node recovery-points.mjs tag --reason <slug> [--message <msg>] [--ref <gitref>]
//   node recovery-points.mjs branch --name <slug> --from <gitref>
//   node recovery-points.mjs bundle --branch <name> [--out <path>]
//   node recovery-points.mjs state-snap --reason <slug>
//   node recovery-points.mjs list [--type tag|branch|bundle|state] [--limit N] [--json]
//   node recovery-points.mjs verify <ref>             # check restorability
//
// Exit codes: 0 ok, 1 user error, 2 git/io error.

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, copyFileSync } from 'node:fs';
import { resolve, dirname, basename } from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = process.env.BYPILOT_ROOT || process.cwd();
const BP_DIR = resolve(ROOT, '.bypilot');
const SNAP_DIR = resolve(BP_DIR, 'snapshots');
const STATE_DIR = resolve(BP_DIR, 'state-history');
const LOG_PATH = resolve(BP_DIR, 'recovery-log.jsonl');
const STATE_SRC = resolve(ROOT, 'docs/.bypilot-state.json');

const TAG_PREFIX = 'bypilot-recovery';
const BRANCH_PREFIX = 'bypilot-snapshot';

const log = (...m) => process.stderr.write('[recovery] ' + m.join(' ') + '\n');
const die = (code, msg) => { log('ERROR:', msg); process.exit(code); };

function ensureDir(p) { mkdirSync(p, { recursive: true }); }
function isoStamp() { return new Date().toISOString().replace(/[:.]/g, '-'); }

function git(args, opts = {}) {
  const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', ...opts });
  if (r.status !== 0 && !opts.allowFail) {
    die(2, `git ${args.join(' ')} failed: ${r.stderr.trim()}`);
  }
  return r;
}

function getArg(name, def = undefined) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
}
function hasFlag(name) { return process.argv.includes(`--${name}`); }

function appendLog(entry) {
  ensureDir(BP_DIR);
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n';
  writeFileSync(LOG_PATH, line, { flag: 'a' });
}

function slugify(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
}

// ─── tag ──────────────────────────────────────────────────────────────────────
function cmdTag() {
  const reason = slugify(getArg('reason') || die(1, '--reason required'));
  const message = getArg('message') || `bypilot recovery: ${reason}`;
  const ref = getArg('ref') || 'HEAD';
  const tag = `${TAG_PREFIX}/${reason}-${isoStamp()}`;
  git(['tag', '-a', tag, '-m', message, ref]);
  const sha = git(['rev-parse', tag]).stdout.trim();
  appendLog({ kind: 'tag', name: tag, ref, sha, reason });
  console.log(JSON.stringify({ kind: 'tag', name: tag, sha }));
}

// ─── branch ───────────────────────────────────────────────────────────────────
function cmdBranch() {
  const nameSlug = slugify(getArg('name') || die(1, '--name required'));
  const from = getArg('from') || die(1, '--from required');
  const branch = `${BRANCH_PREFIX}/${nameSlug}-${isoStamp()}`;
  git(['branch', branch, from]);
  const sha = git(['rev-parse', branch]).stdout.trim();
  appendLog({ kind: 'branch', name: branch, from, sha });
  console.log(JSON.stringify({ kind: 'branch', name: branch, sha }));
}

// ─── bundle ───────────────────────────────────────────────────────────────────
function cmdBundle() {
  const branch = getArg('branch') || die(1, '--branch required');
  ensureDir(SNAP_DIR);
  const out = getArg('out') || resolve(SNAP_DIR, `${slugify(branch)}-${isoStamp()}.bundle`);
  // Bundle a single ref + its history. Standalone, restorable into any clone.
  git(['bundle', 'create', out, branch]);
  const size = statSync(out).size;
  appendLog({ kind: 'bundle', branch, path: out, size });
  console.log(JSON.stringify({ kind: 'bundle', path: out, size }));
}

// ─── state-snap ───────────────────────────────────────────────────────────────
function cmdStateSnap() {
  const reason = slugify(getArg('reason') || die(1, '--reason required'));
  if (!existsSync(STATE_SRC)) {
    appendLog({ kind: 'state', reason, skipped: 'no state file' });
    console.log(JSON.stringify({ kind: 'state', skipped: true, reason: 'no state file' }));
    return;
  }
  ensureDir(STATE_DIR);
  const dest = resolve(STATE_DIR, `${reason}-${isoStamp()}.json`);
  copyFileSync(STATE_SRC, dest);
  appendLog({ kind: 'state', reason, path: dest });
  console.log(JSON.stringify({ kind: 'state', path: dest }));
}

// ─── list ─────────────────────────────────────────────────────────────────────
function cmdList() {
  const type = getArg('type');
  const limit = Number(getArg('limit') || 50);
  const wantJson = hasFlag('json');
  const items = [];

  if (!type || type === 'tag') {
    const r = git(['for-each-ref', '--sort=-creatordate',
      '--format=%(refname:short)|%(creatordate:iso-strict)|%(objectname)',
      `refs/tags/${TAG_PREFIX}/*`], { allowFail: true });
    for (const line of (r.stdout || '').split('\n').filter(Boolean)) {
      const [name, when, sha] = line.split('|');
      items.push({ kind: 'tag', name, when, sha });
    }
  }
  if (!type || type === 'branch') {
    const r = git(['for-each-ref', '--sort=-creatordate',
      '--format=%(refname:short)|%(creatordate:iso-strict)|%(objectname)',
      `refs/heads/${BRANCH_PREFIX}/*`], { allowFail: true });
    for (const line of (r.stdout || '').split('\n').filter(Boolean)) {
      const [name, when, sha] = line.split('|');
      items.push({ kind: 'branch', name, when, sha });
    }
  }
  if ((!type || type === 'bundle') && existsSync(SNAP_DIR)) {
    for (const f of readdirSync(SNAP_DIR)) {
      if (!f.endsWith('.bundle')) continue;
      const p = resolve(SNAP_DIR, f);
      const s = statSync(p);
      items.push({ kind: 'bundle', name: f, when: s.mtime.toISOString(), path: p, size: s.size });
    }
  }
  if ((!type || type === 'state') && existsSync(STATE_DIR)) {
    for (const f of readdirSync(STATE_DIR)) {
      if (!f.endsWith('.json')) continue;
      const p = resolve(STATE_DIR, f);
      const s = statSync(p);
      items.push({ kind: 'state', name: f, when: s.mtime.toISOString(), path: p });
    }
  }

  items.sort((a, b) => (b.when || '').localeCompare(a.when || ''));
  const sliced = items.slice(0, limit);

  if (wantJson) {
    console.log(JSON.stringify(sliced, null, 2));
  } else {
    for (const it of sliced) {
      const extra = it.size ? ` (${(it.size / 1024).toFixed(1)}KB)` : '';
      console.log(`${it.kind.padEnd(7)} ${it.when}  ${it.name}${extra}`);
    }
  }
}

// ─── verify ───────────────────────────────────────────────────────────────────
function cmdVerify() {
  const ref = process.argv[3];
  if (!ref) die(1, 'usage: verify <ref-or-bundle-path>');
  if (existsSync(ref) && ref.endsWith('.bundle')) {
    const r = git(['bundle', 'verify', ref], { allowFail: true });
    if (r.status === 0) console.log(JSON.stringify({ ok: true, kind: 'bundle', ref }));
    else die(2, `bundle verify failed: ${r.stderr.trim()}`);
    return;
  }
  const r = git(['rev-parse', '--verify', ref], { allowFail: true });
  if (r.status === 0) {
    console.log(JSON.stringify({ ok: true, kind: 'ref', ref, sha: r.stdout.trim() }));
  } else {
    die(2, `ref not found: ${ref}`);
  }
}

const cmd = process.argv[2];
const dispatch = {
  tag: cmdTag, branch: cmdBranch, bundle: cmdBundle,
  'state-snap': cmdStateSnap, list: cmdList, verify: cmdVerify,
};
if (!dispatch[cmd]) {
  log('commands: tag | branch | bundle | state-snap | list | verify');
  process.exit(1);
}
dispatch[cmd]();
