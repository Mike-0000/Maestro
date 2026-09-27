# Worktrees

For Chorus task submission and combining parallel task work into one local install, see
[`local-updates.md`](local-updates.md) and `.agents/skills/chorus-integrate/SKILL.md`.

## Main Files

- `packages/core/src/runtimes/workspace-registry/` (creation pipeline, lifecycle steps, activation)
- `packages/core/src/runtimes/scripts/` (lifecycle script execution)
- `packages/core/src/runtimes/host-settings/` (per-host defaults)
- `src/core/features/workspaces/` (desktop wire controllers and UI)
- `.emdash.json`

## Current Behavior

- task worktrees are created under the project's DB-backed worktree directory setting
- branch prefix defaults to `chorus` and is configurable in app settings
- generated task branch names use the configured prefix plus a random suffix by default; app repository settings can disable only the random suffix
- worktree creation is managed by the project provider pattern
- a project may point at a linked worktree: desktop tasks and automation runs use that
  workspace record's `parentId` for `createWorktree`, while retaining the project's
  original checkout registration and selected base ref
- this happens on every creation attempt, not in a one-off project migration:
  `createWorkspace` registers existing paths missing from the registry and adopts linked
  worktrees' parent repositories,
  re-inspects saved directories that have become repositories, then provisioning resolves
  the returned record to its owning repository ID. A valid linked-worktree record is
  not corrupt and must not be changed to `repository` or require manual DB repair
- creation runs a fast foreground pipeline (`inspect → resolve-base → add-worktree → verify`);
  the base ref is fetched only when it is not locally resolvable
- newly created task branches use `git worktree add --no-track`; the selected base ref is a
  starting point, not the branch's upstream
- gitignored files named in `preservePatterns` are copied from the repository into the new
  worktree as a durable background step, using copy-on-write (`cp -c` on APFS,
  `--reflink=auto` on Linux) with a plain-copy fallback; nothing is copied without
  configured patterns
- there are no built-in preserve defaults: the `.env` family is no longer copied
  automatically — projects that relied on it must add `preservePatterns` (behavior
  change in workspace-lifecycle-v2; `excludePatterns` was removed at the same time and
  stale keys are silently ignored)
- branch publication carries the resolved project `pushRemote` as an explicit durable target;
  a successful push establishes that remote's same-named branch as upstream
- branch publication and ref freshening run as durable background steps; a failed push surfaces
  as a "branch not pushed" task state with a manual retry

## Integrating A Task Into The Main Directory

"Integrate" (task context menu, and the button in the task Changes panel footer) brings a
worktree task's committed HEAD into the branch checked out in the project's main directory
(`repositoryWorkspaceId`). It is offered only for tasks whose workspace is not the main
directory itself.

- Host procedures: `checkout.previewIntegration` / `checkout.integrate` in the git runtime
  (`packages/core/src/runtimes/git/node/checkout/ops/integrate.ts`); the desktop
  `sourceControl.checkout` wrappers take only `workspaceId` and resolve the target from the
  project, requiring both on the same host.
- The main directory is only ever fast-forwarded (`git merge --ff-only`). A non-fast-forward
  merge is computed off-tree with `git merge-tree --write-tree` + `git commit-tree`, so a
  conflict never leaves the main directory mid-merge. Requires Git 2.38+; older Git surfaces a
  `merge-unsupported` blocker.
- `integrate` requires the previewed target and source HEADs; a moved side refuses
  (`target_moved` / `source_moved`) instead of integrating unreviewed commits. Uncommitted task
  work is never integrated (the modal offers "Commit all" first). Dirty main-directory files that
  the integration would touch block it; unrelated dirty files are left alone.
- Nothing is pushed. `chorus/main` (owned by Update Chorus) is blocked in the UI.
- Conflicts, or a merge that fails after a clean preview, create a separate resolution task:
  a new worktree branched from the target branch whose Claude Code PTY conversation
  (`autoApprove: false`) is prompted to `git merge --no-ff <source sha>`, resolve, check, and
  commit without touching the original worktree or main directory and without pushing. The user
  reviews that task and integrates it (a fast-forward), which also makes the original task
  up-to-date. When Claude Code is unavailable the task is created without an agent, and when task
  creation fails the modal shows manual steps. Helpers: `source-control/browser/integrate/`.

## `.emdash.json`

`.emdash.json` stores optional shareable project settings. Supported runtime keys:

- `preservePatterns` (gitignored files deliberately carried into new worktrees; empty unless configured)
- `scripts.prepare`
- `scripts.setup`
- `scripts.run`
- `scripts.teardown`
- `shellSetup` (per-workspace override of the host-settings default; the per-project DB
  field was retired)

Base project settings are DB-backed Project Settings, not runtime `.emdash.json` keys:

- `worktreeDirectory`
- `defaultBranch`
- `baseRemote`
- `pushRemote`
- `tmux`

Host-local project settings are stored by the workspace registry and are not written to
`.emdash.json`:

- `env` (variables injected into new task terminals, lifecycle scripts, and TUI/ACP agent
  processes; Emdash-owned `EMDASH_*` task metadata takes precedence)

Host-level defaults (`shellSetup`, `worktreeRoot`, `tmux`) live in the host-settings
runtime (`packages/core/src/runtimes/host-settings/`), stored as a JSON file in the
host's emdash data directory and editable from the machines/system settings UI.
Precedence is per-project DB override, then host settings, then app defaults.

## Rules

- do not hardcode worktree paths; use service helpers
- use lifecycle config for repo-specific bootstrap and teardown behavior
- `scripts.prepare` is blocking and runs after the workspace exists but before task providers,
  conversations, setup scripts, or run scripts start; keep it idempotent
- `scripts.prepare`, `scripts.setup`, and `scripts.run` wait for the background artifact copy to
  settle before running, since they may consume preserved files
- `scripts.setup` and `scripts.run` are runtime-triggered after `scripts.prepare` succeeds; they do
  not block task readiness
- lifecycle scripts execute in the dedicated scripts runtime
  (`packages/core/src/runtimes/scripts/`) on the host: PTY-backed, one run per
  (workspace, script), with provenance (`activation`/`manual`/`retry`), per-run timeouts,
  and a stop verb; the workspace registry observes runs and mirrors them into durable
  lifecycle steps for the Activity timeline
- project environment variables are resolved by the workspace registry and passed explicitly to
  every launch path; exports performed by one lifecycle shell do not mutate sibling or later
  processes
- `shellSetup` runs inside each PTY before the interactive shell starts; the workspace's
  `.emdash.json` value overrides the host-settings default. Lifecycle commands and `shellSetup`
  are opaque strings run together in the default shell selected by the host-owned runtime at
  execution time; repository authors own their portability.
- tmux wrapping has an app level default but is also project-configurable in Project Settings
  and affects PTY lifecycle behavior. It is always disabled for local Windows sessions without
  deleting the stored preference.
- `preservePatterns` never copies tracked files or `.emdash.json`
