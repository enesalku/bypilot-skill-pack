#!/usr/bin/env node
// housekeeping.mjs — retention pruner for bypilot recovery artifacts.
// Default: dry-run (just lists what would be removed). Use --execute to actually delete.
//
// Retention rules (per plan I.5):
//   tag    bypilot-recovery/* : keep newest 20
//   branch bypilot-snapshot/* : keep newest 14 days
//   bundle .bypilot/snapshots/*.bundle : keep newest 30 days
//   state  .bypilot/state-history/*.json : keep newest 50
//
// Also reports total .bypilot/snapshots/ size; warns at >500MB but never deletes
// outside the rules above.
//
// Usage:
//   node housekeeping.mjs                       # dry-run
//   node housekeeping.mjs --execute             # apply
//   node housekeeping.mjs --type tag --execute  # only tags
//   node housekeeping.mjs --json                # machine-readable plan

import { readdirSync, statSync, rmSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = process.env.BYPILOT_ROOT || process.cwd();
const SNAP_DIR = resolve(ROOT, '.bypilot/snapshots');
const STATE_DIR = resolve(ROOT, '.bypilot/state-history');

const log = (...m) => process.stderr.write('[housekeeping] ' + m.join(' ') + '\n');

const KEEP_TAGS = 20;
const KEEP_BRANCH_DAYS = 14;
const KEEP_BUNDLE_DAYS = 30;
const KEEP_STATES = 50;
const WARN_SIZE_MB = 500;

function git(args, opts = {}) {
  return spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', ...opts });
}
function getArg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
}
function hasFlag(name) { return process.argv.includes(`--${name}`); }

function planTags() {
  const r = git(['for-each-ref', '--sort=-creatordate',
    '--format=%(refname:short)|%(creatordate:iso-strict)',
    'refs/tags/bypilot-recovery/*']);
  const items = (r.stdout || '').split('\n').filter(Boolean).map(l => {
    const [name, when] = l.split('|');
    return { name, when };
  });
  const toRemove = items.slice(KEEP_TAGS);
  return { type: 'tag', kept: items.length - toRemove.length, willRemove: toRemove };
}

function planBranches() {
  const cutoff = Date.now() - KEEP_BRANCH_DAYS * 24 * 36e5;
  const r = git(['for-each-ref', '--sort=-creatordate',
    '--format=%(refname:short)|%(creatordate:iso-strict)',
    'refs/heads/bypilot-snapshot/*']);
  const items = (r.stdout || '').split('\n').filter(Boolean).map(l => {
    const [name, when] = l.split('|');
    return { name, when, ts: new Date(when).getTime() };
  });
  const toRemove = items.filter(it => it.ts < cutoff);
  return { type: 'branch', kept: items.length - toRemove.length, willRemove: toRemove };
}

function planBundles() {
  if (!existsSync(SNAP_DIR)) return { type: 'bundle', kept: 0, willRemove: [], totalMB: 0 };
  const cutoff = Date.now() - KEEP_BUNDLE_DAYS * 24 * 36e5;
  const items = readdirSync(SNAP_DIR)
    .filter(f => f.endsWith('.bundle'))
    .map(f => {
      const p = resolve(SNAP_DIR, f);
      const s = statSync(p);
      return { name: f, path: p, size: s.size, ts: s.mtimeMs };
    });
  const totalMB = items.reduce((a, b) => a + b.size, 0) / 1024 / 1024;
  const toRemove = items.filter(it => it.ts < cutoff);
  return { type: 'bundle', kept: items.length - toRemove.length, willRemove: toRemove, totalMB: Number(totalMB.toFixed(1)) };
}

function planStates() {
  if (!existsSync(STATE_DIR)) return { type: 'state', kept: 0, willRemove: [] };
  const items = readdirSync(STATE_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      const p = resolve(STATE_DIR, f);
      const s = statSync(p);
      return { name: f, path: p, ts: s.mtimeMs };
    })
    .sort((a, b) => b.ts - a.ts);
  const toRemove = items.slice(KEEP_STATES);
  return { type: 'state', kept: items.length - toRemove.length, willRemove: toRemove };
}

function executePlan(plans) {
  const summary = { tag: 0, branch: 0, bundle: 0, state: 0, errors: [] };
  for (const p of plans) {
    for (const it of p.willRemove) {
      try {
        if (p.type === 'tag') {
          const r = git(['tag', '-d', it.name], { allowFail: true });
          if (r.status === 0) summary.tag++;
          else summary.errors.push(`tag ${it.name}: ${r.stderr.trim()}`);
        } else if (p.type === 'branch') {
          const r = git(['branch', '-D', it.name], { allowFail: true });
          if (r.status === 0) summary.branch++;
          else summary.errors.push(`branch ${it.name}: ${r.stderr.trim()}`);
        } else if (p.type === 'bundle') {
          rmSync(it.path, { force: true });
          summary.bundle++;
        } else if (p.type === 'state') {
          rmSync(it.path, { force: true });
          summary.state++;
        }
      } catch (e) {
        summary.errors.push(`${p.type} ${it.name}: ${e.message}`);
      }
    }
  }
  return summary;
}

function main() {
  const onlyType = getArg('type');
  const execute = hasFlag('execute');
  const wantJson = hasFlag('json');

  const all = [planTags(), planBranches(), planBundles(), planStates()];
  const plans = onlyType ? all.filter(p => p.type === onlyType) : all;

  const totalToRemove = plans.reduce((a, p) => a + p.willRemove.length, 0);
  const bundlePlan = plans.find(p => p.type === 'bundle');
  const sizeWarn = bundlePlan && bundlePlan.totalMB > WARN_SIZE_MB
    ? `WARNING: snapshot dir is ${bundlePlan.totalMB}MB (> ${WARN_SIZE_MB}MB threshold)`
    : null;

  let executed = null;
  if (execute && totalToRemove > 0) executed = executePlan(plans);

  const out = {
    generatedAt: new Date().toISOString(),
    dryRun: !execute,
    plans: plans.map(p => ({
      type: p.type, kept: p.kept, wouldRemove: p.willRemove.length,
      ...(p.totalMB !== undefined ? { totalMB: p.totalMB } : {}),
      items: p.willRemove.map(it => ({ name: it.name, when: it.when || new Date(it.ts).toISOString() })),
    })),
    sizeWarn,
    executed,
  };

  if (wantJson) console.log(JSON.stringify(out, null, 2));
  else {
    for (const p of out.plans) {
      console.log(`${p.type.padEnd(7)} kept=${p.kept} wouldRemove=${p.wouldRemove}${p.totalMB ? ` totalMB=${p.totalMB}` : ''}`);
    }
    if (sizeWarn) console.log(sizeWarn);
    if (executed) console.log('executed:', JSON.stringify(executed));
    if (!execute) console.log('(dry-run; pass --execute to apply)');
  }
}

main();
