# Rules

## Must Always

- Delegate to the most specific subagent for the task. Implementers don't review, reviewers don't implement.
- Use isolated git worktrees for any task that writes code (`isolation: "worktree"` on Agent calls).
- Bootstrap a worktree on the host before invoking a test-runner against it. Never let a test-runner `npm install`.
- Follow the existing repository patterns of the *consuming* project (read its CLAUDE.md before suggesting structure).
- Append every completed task's `summary` to `docs/decisions.log`.
- Persist driver state to `docs/.bypilot-state.json` after every wave so resume works.
- Show the user a checkpoint summary at every wave boundary (TaskList + structured markdown block).

## Must Never

- Run `git push` automatically. Push is a human verb.
- Use `--no-verify`, `--force`, or `--amend` on commits.
- Use `git add .` or `git add -A`. Stage explicit files only.
- Skip a red test by `.skip`, `expect(true)`, or raised timeouts. Fix the root cause.
- Commit secrets, .env files, .secrets/, or anything matching the consuming project's `.gitignore`.
- Run an installer script (`npm install`, `yarn`, etc.) inside a test-runner agent. Bootstrap is the parent's job.
- Modify a different project's working tree from inside a worktree (cwd discipline).
- Promote an instinct to a skill silently. `/promote` is always explicit.

## Agent Format

- Agents live in `agents/<role>/<name>.md`.
- Each file: YAML frontmatter with `name`, `description`, `tools`, `model`, optional `origin` (`bypilot` | `ecc` | `community`).
- File names lowercase, hyphens. Names match folder + filename.
- Descriptions clearly say *when* to invoke; orchestrator routes by description match.

## Skill Format

- Skills live in `skills/<name>/SKILL.md`.
- Frontmatter: `name`, `description`, `origin`, optional `version`, optional `disable-model-invocation`.
- Body sections (canonical order): When to Use, How It Works, Process / Workflow, Examples, Sıkıştığında.
- Heavy logic in `skills/<name>/scripts/`; declarative workflows in `skills/<name>/workflows/`.
- Multi-layer customization via `skills/<name>/customize.toml` (base → team → user merge).

## Hook Format

- Hooks registered in `hooks/hooks.json` with matcher-driven JSON.
- Bash hooks under 200 lines, async hooks under 30s timeout, blocking hooks under 200ms (no network).
- All hooks must `exit 0` on non-critical errors. Block only when intentional.
- Gating env vars honored: `BYPILOT_HOOK_PROFILE` (off/lean/full), `BYPILOT_DISABLED_HOOKS` (csv).
- Log to stderr with `[bypilot:<hook-name>]` prefix.

## Commit Style

- Conventional commits with `bypilot` scope when touching the package itself: `feat(bypilot/skills): ...`, `fix(bypilot/hooks): ...`.
- When the orchestrator commits inside a consumed project, the scope follows the consumed project's convention (e.g., `feat(pilot): ...`).
- 72-character title cap. Body explains *why*.

## Observability Discipline

- Every subagent invocation logged to `docs/.bypilot-state.json` with `agent`, `taskId`, `worktreePath`, `tokensIn`, `tokensOut`, `durationMs`.
- Every PreToolUse → `~/.bypilot/observations/<project-hash>/<date>.jsonl` if `BYPILOT_HOOK_PROFILE != off`.
- Failures recorded with `failureLog` capped at 3000 chars (debugger ergonomics).
