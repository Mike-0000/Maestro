---
name: chorus-install
description: Guide the user through the Chorus local delivery coordinator to combine agent work, validate one integrated build, and schedule a safe local install. Use when the user asks to update their installed Chorus.
compatibility: Packaged Chorus on Windows
---

# Update the installed Chorus app through its coordinator

Never build and copy one task branch over the installed app. Agent work must first be submitted to
the repository's durable delivery coordinator, combined into one candidate, and validated as a full
Windows package.

1. Read `.agents/skills/chorus-integrate/SKILL.md` and use its worktree handoff steps.
2. In the packaged Windows app, open the **Local Chorus update** card or ask the voice agent for
   delivery status. Enable the project coordinator if it is not enabled.
3. Prepare a ready snapshot or wait for all active shipping tasks with follow-project. Resolve
   conflicts in the preserved coordinator worktree, then validate the integrated candidate.
4. Schedule the local install only after the user confirms. Scheduling is rejected while any local,
   remote, agent, or terminal session is active. Chorus remains open until the user quits normally;
   never close or kill the app on the user's behalf.
5. The detached installer verifies package hashes, backs up the profile, retains the previous
   install, and rolls back if the new app does not report matching startup health.
6. For a later rollback request, use the Local Chorus update card or voice agent and confirm
   restoring the matched pre-update profile. Stop all sessions and quit Chorus normally when asked.
   The post-update profile and current install are retained for recovery.

The old scripts in `scripts/` are intentionally disabled. Do not invoke them or use direct
`robocopy`, a force-close option, a task-branch build, or an NSIS installer as a shortcut around
the coordinator. For a disposable packaged build that leaves the installed app alone, use
`.agents/skills/emdash-windows-build`.
