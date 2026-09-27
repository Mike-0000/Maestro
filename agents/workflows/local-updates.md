# Coordinated local Chorus updates

## Purpose

Chorus task worktrees are isolated while agents work, but an installed local Chorus update must
represent one explicit, reviewed set of task commits. The local updates slice owns one durable
coordinator per Git common directory. Its journal and snapshot live under
`%LOCALAPPDATA%\Chorus\Delivery\v1`, outside the app profile, and survive app restarts.

## Task lifecycle

- The app enrolls existing tasks when a local project enables the coordinator, enrolls newly
  created tasks once their worktree is ready (`task:workspace-ready`), and reconciles enabled
  projects during startup.
- Every agent dispatch records work started, which enrolls the task, invalidates its handoff, and
  honors the install gate: typed TUI input, TUI start/resume, ACP prompts, a TUI spawn that
  carries the conversation's initial prompt (`launchTuiConversation`), and the first ACP attach
  that sends an initial prompt queue.
- Archiving or deleting a task withdraws it only while it is still `working`; a task that already
  handed off (submitted, no-change, integrated) keeps its handoff. Restoring an archived task
  rejoins it as `working`, while an explicit `withdraw` stays withdrawn. Status reads and startup
  reconciliation withdraw enrolled tasks whose Chorus task is archived or deleted, so a missed
  lifecycle hook cannot leave stale `working` entries blocking follow-project. A task absent from
  this profile's database counts as deleted only once its worktree is gone, because other Chorus
  clones share the coordinator.
- Starting or resuming coding invalidates the task's previous handoff before prompt dispatch.
  Passive transcript hydration does not invalidate a submission.
- A handoff records a full commit SHA, the base captured at enrollment, a clean worktree, declared
  dependencies, changed paths, and a retained Git ref. The commit is not considered ready based on
  agent completion alone.
- Agents follow `.agents/skills/chorus-integrate/SKILL.md`. They do not merge or install their own
  task branch and do not push task commits as part of local delivery.

## Candidate lifecycle

1. The Local Chorus update card has one primary **Update Chorus** action. It prepares a ready
   snapshot, validates the package without the default 30-second Wire deadline, then requests
   separate explicit confirmations before promotion and scheduling. Declining either confirmation
   leaves the candidate ready to resume from that step; it never pushes a GitHub backup implicitly.
   Follow-project remains available through the conductor's voice tools and waits until all enrolled
   shipping tasks are submitted, marked no-change, or withdrawn; any later task revision makes its
   candidate ineligible.
2. Chorus creates a persistent detached integration worktree from the configured local main ref,
   merges commits in dependency order, and preserves conflict worktrees for manual resolution.
   Resolve and commit a merge in that worktree, then resume integration to merge the remaining
   selected commits.
3. A frozen install, workspace build, full-tree format/lint/typecheck, focused Chorus delivery
   and Wire timeout tests, native-addon rebuild, and unpacked Windows package build run on a second
   detached worktree pinned to the integrated commit. The unrelated inherited Emdash/Unix test suite
   still runs in the normal repository gate, but does not block a Windows local install. The
   coordinator records the checks, toolchain, manifest, and SHA-256 inventory of every package file.
4. Promotion is a separate, user-confirmed fast-forward of local `chorus/main`. It refuses a moved
   branch or dirty canonical checkout. A separate confirmed backup action pushes that exact commit
   to `origin/main` without force; a rejected push remains visibly pending.
5. Scheduling is a separate, user-confirmed action available from the Local Chorus update card or
   conductor voice tools. It requires complete session status and zero active agent sessions,
   terminals, or remote sessions. It does not quit Chorus automatically.
6. Scheduling blocks new agent dispatch across all Chorus clones through the shared per-user
   install gate and dispatch leases, then starts the packaged detached worker. The user quits
   Chorus normally when ready. The worker verifies the package, backs up the profile, stages a
   same-volume directory swap, and retains the previous installation for rollback.
7. The new app writes a one-time startup receipt only after its usable-workspace boot signal. The
   coordinator marks the candidate installed only when the receipt matches its commit, build id,
   nonce, and artifact digest. A missing or failed receipt restores the previous installation.
8. After a successful install, the Local Chorus update card and voice agent can schedule a
   rollback when the retained build has compatible provenance. Rollback requires explicit
   confirmation to restore the matched pre-update profile, stops new sessions, and waits for the
   user to quit Chorus normally. It preserves the current install and profile for recovery. If the
   worker reports a failure after replacement begins and cannot verify restoration, the coordinator
   keeps the install target paused and displays the recovery error instead of allowing new sessions
   into an uncertain install.

## Operational boundaries

- The UI and voice agent are the only supported scheduling path. The command-line helper is for
  identifying tasks and submitting immutable handoffs; it cannot forge validation receipts or
  schedule installation.
- Only the packaged Windows app can replace the current installation. A dev build can inspect
  coordinator state but cannot schedule the install.
- An applying worker waits for the user to exit normally. Do not kill Chorus, its children, or
  running agents. Scheduling is unavailable while any active sessions exist or their state cannot
  be read completely. Shared dispatch leases drain in-flight starts from every open Chorus clone
  before the install worker is launched.
- GitHub backup and local installation are separate confirmed actions. Backup pushes only the
  promoted commit to `origin/main` without force; local installation does not publish a release.

## Main implementation

- `src/core/features/local-updates/` â€” typed Wire API, task hooks, durable coordinator, frozen
  build validation, install result reconciliation
- `tooling/chorus-delivery/cli.mjs` â€” task identify and handoff commands
- `tooling/chorus-delivery/install-chorus-update.ps1` â€” packaged Windows wait, verify, swap,
  health-check, and rollback worker. Rollback restores a pre-update profile only after explicit
  user confirmation and only when retained build provenance supports startup verification.
- `src/core/features/conductor/` â€” voice tools and the visible local update card
- `.agents/skills/chorus-integrate/SKILL.md` â€” shared agent workflow
