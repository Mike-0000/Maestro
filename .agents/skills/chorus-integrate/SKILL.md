---
name: chorus-integrate
description: Coordinate work in Chorus task worktrees so independent agents can contribute safely to one installed Chorus project. Use when changing Chorus from an agent task worktree, handing off completed changes, combining parallel work, or installing a local Chorus update.
compatibility: Chorus desktop repo with Node 24 and pnpm
---

# Integrate Chorus task worktrees

Chorus has one durable delivery coordinator per Git common directory. Each task has a single
worktree and an immutable base commit. Agents hand off reviewed commits to that coordinator; the
user combines the desired ready tasks, validates one integrated candidate, and schedules a local
install from the packaged Chorus app.

## Before editing

1. Work only in the task's assigned worktree. Do not edit the canonical checkout or another task's
   worktree.
2. Identify the task and its recorded base:

   ```powershell
   corepack pnpm --dir apps/emdash-desktop exec node tooling/chorus-delivery/cli.mjs identify --repo <task-worktree>
   ```

3. Treat the coordinator's task state as authoritative. If the task is not enrolled or its base
   differs from the expected project branch, stop and report that; do not hand-edit coordinator
   state or infer the base from a moving branch.
4. Before each new coding turn or resumed agent run, invalidate any previous handoff by starting
   work through Chorus. Never keep using a previously submitted SHA after making more edits.

## Hand off completed work

1. Review the full diff, run the focused checks required by the task, and commit the task's changes
   on its assigned branch. Keep the worktree clean, including untracked files.
2. Run `identify` again and use its exact recorded base and the current full `HEAD` SHA. Submit the
   commit and a useful summary:

   ```powershell
   corepack pnpm --dir apps/emdash-desktop exec node tooling/chorus-delivery/cli.mjs submit `
     --repo <task-worktree> --commit <full-head-sha> --base <recorded-base-sha> `
     --summary "<what changed and relevant checks>"
   ```

3. If there are no source changes, use `no-change` with `HEAD` equal to the recorded base. If the
   task will not contribute, use `withdraw` only when the user has abandoned it.
4. For prerequisite work from another task, include its exact submitted task id and commit SHA as
   a JSON `--dependencies` value. Do not duplicate changes from another task or claim checks that
   were not run.
5. Report the submitted SHA and summary to the user. Submission only makes the task available; it
   does not merge or install it.

## Combine and install

- The user selects either the current ready snapshot or follow-project, which waits for all active
  shipping tasks and includes late arrivals. A new agent or resumed task makes a following
  candidate stale; prepare a fresh candidate after the new work is handed off.
- Chorus creates a persistent integration worktree and merges submitted commits in dependency
  order. Resolve conflicts in that preserved worktree, stage and commit the merge resolution while
  Git still has the conflicted task commit as `MERGE_HEAD`, then use **Resume resolved integration**.
  Chorus checks the worktree is clean and merges the remaining selected commits. Never choose
  ours/theirs automatically or rewrite task branches.
- Validate the full candidate with Chorus's fixed checks and packaged Windows build. Do not
  substitute a per-agent build, manually copy an app directory, or report a green check from an
  agent's claim.
- Scheduling an install is a separate, user-confirmed action in the local update card or voice
  agent. It is rejected while any local, remote, agent, or terminal session is active. The app
  remains open; the user quits Chorus normally when ready. New agent work is blocked while the
  worker waits. Never kill Chorus or restart it on the user's behalf.
- The detached Windows worker verifies every packaged file hash, backs up the profile, retains the
  prior install for rollback, and requires a matching startup-health receipt before reporting the
  candidate installed.
- If the installed candidate later needs rollback, use the confirmed rollback action in the Local
  Chorus update card or voice agent. It restores the matching previous build and profile only when
  retained provenance supports health verification, and keeps the post-update profile in local
  recovery storage. If rollback stops after replacement begins, do not start agents; follow the
  recovery error shown in the update card.
- Do not push task commits or change GitHub remotes. Remote publication follows the user's
  separate GitHub workflow.
