#!/usr/bin/env node
// self-fix-policy.mjs — classification policy for sprint-driver self-healing.
// Pure decision module: maps an error context to a structured action plan.
// Exposed both as a Node import (default + classify) and as a CLI for sprint-driver
// shell glue.
//
// Three classes:
//   auto-fix-safe       — mechanical, reversible, no downstream impact → apply, log, continue
//   auto-fix-snapshot   — reversible BUT touches files/branches → snapshot first, then apply
//   halt                — high data-loss risk OR unclassified → snapshot then stop
//
// Recognised error patterns (extend as new ones surface):
//   dag-cycle, three-fail-block, uncommitted-changes, branch-collision,
//   worktree-locked-stale, security-critical, security-warn, bootstrap-fail,
//   port-conflict, registry-drift, unknown
//
// CLI:
//   echo '{"kind":"branch-collision","branch":"task-x"}' | node self-fix-policy.mjs classify
//   node self-fix-policy.mjs classify --kind dag-cycle --extra '{"cycle":["a","b"]}'

import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve as pathResolve } from 'node:path';

export const POLICIES = {
  'dag-cycle': {
    class: 'auto-fix-snapshot',
    action: 'remove the weakest edge (least dependent path) from the cycle',
    recovery: 'tag',
    reasonTemplate: ctx => `cycle ${(ctx.cycle || []).join(' -> ')}; relaxed weakest edge`,
    fallback: 'halt',  // if cycle persists after fix
  },
  'three-fail-block': {
    class: 'auto-fix-safe',
    action: 'mark task as blocked; continue with rest of wave',
    recovery: null,
    reasonTemplate: ctx => `task ${ctx.taskId} failed 3 attempts; blocked, sprint continues`,
  },
  'uncommitted-changes': {
    class: 'auto-fix-snapshot',
    action: 'git stash with named ref; resume after sprint',
    recovery: 'branch',
    reasonTemplate: ctx => `pre-flight uncommitted; stashed to bypilot-snapshot/preflight-*`,
  },
  'branch-collision': {
    class: 'auto-fix-safe',
    action: 'generate alternative branch name with fresh hash, retry acquire',
    recovery: null,
    reasonTemplate: ctx => `branch ${ctx.branch} exists; retry with new hash`,
  },
  'worktree-locked-stale': {
    class: 'auto-fix-snapshot',
    action: 'verify lock owner dead, unlock, re-classify',
    recovery: 'tag',
    reasonTemplate: ctx => `stale lock on ${ctx.path}, owner pid=${ctx.pid} not alive`,
  },
  'security-critical': {
    class: 'halt',
    action: 'stop sprint, surface to user with full report',
    recovery: 'tag',
    reasonTemplate: ctx => `critical security finding: ${ctx.summary}`,
  },
  'security-warn': {
    class: 'auto-fix-safe',
    action: 'log to decisions.log + continue; surface in epoch report',
    recovery: null,
    reasonTemplate: ctx => `security warn: ${ctx.summary}`,
  },
  'bootstrap-fail': {
    class: 'auto-fix-snapshot',
    action: 'retry once with --force-prep, escalate to halt if still failing',
    recovery: 'tag',
    reasonTemplate: ctx => `bootstrap failed at ${ctx.step}; retrying`,
    fallback: 'halt',
  },
  'port-conflict': {
    class: 'auto-fix-safe',
    action: 're-allocate ports via port-allocator.sh',
    recovery: null,
    reasonTemplate: ctx => `port ${ctx.port} busy; re-allocating`,
  },
  'registry-drift': {
    class: 'auto-fix-safe',
    action: 'run worktree-manager.mjs gc to reconcile registry with disk',
    recovery: null,
    reasonTemplate: ctx => `registry has entries with no on-disk worktree`,
  },
  'unknown': {
    class: 'halt',
    action: 'snapshot everything, stop, ask user',
    recovery: 'tag',
    reasonTemplate: ctx => `unrecognised error: ${ctx.message || JSON.stringify(ctx)}`,
  },
};

export function classify(ctx) {
  const kind = ctx?.kind || 'unknown';
  const policy = POLICIES[kind] || POLICIES.unknown;
  return {
    kind,
    class: policy.class,
    action: policy.action,
    recoveryRequired: policy.recovery,
    fallback: policy.fallback || null,
    reason: policy.reasonTemplate(ctx || {}),
    halt: policy.class === 'halt',
  };
}

// CLI ---------------------------------------------------------------------
function getArg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : null;
}
function hasFlag(name) { return process.argv.includes(`--${name}`); }

function readStdinSync() {
  try { return readFileSync(0, 'utf8'); } catch { return ''; }
}

function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return fileURLToPath(import.meta.url) === realpathSync(pathResolve(process.argv[1]));
  } catch { return false; }
}

if (isMainModule()) {
  const cmd = process.argv[2];
  if (cmd === 'classify') {
    let ctx = {};
    const kind = getArg('kind');
    const extra = getArg('extra');
    if (kind) ctx.kind = kind;
    if (extra) Object.assign(ctx, JSON.parse(extra));
    if (!kind && !extra) {
      const stdin = readStdinSync().trim();
      if (stdin) ctx = JSON.parse(stdin);
    }
    console.log(JSON.stringify(classify(ctx), null, 2));
  } else if (cmd === 'list') {
    console.log(JSON.stringify(Object.keys(POLICIES), null, 2));
  } else {
    process.stderr.write('commands: classify [--kind X --extra JSON] | list\n');
    process.exit(1);
  }
}

export default { classify, POLICIES };
