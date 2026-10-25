---
name: vibe
description: Vibe mode (also called director mode), after oh-my-pi's /vibe. Claude becomes a director that runs persistent fast and strong worker agents and checks their work by reading files, instead of editing or running anything itself. Use when the user types /vibe or asks for director or vibe mode, and on your own for a task big enough to split into several workstreams.
when_to_use: Invoke it yourself when the task splits into several independent parts in one project, is a feature that touches many files, or mixes mechanical work with judgment calls that benefit from a reviewer checking each result. Don't for small or single-file changes, quick questions, investigations, steps that must happen in order, or when the user says not to.
argument-hint: "[first directive | off]"
---

Arguments: `$ARGUMENTS`

- **`off`** (or the user later says to exit vibe mode): stop every worker you spawned in vibe
  mode with `TaskStop`, give a one-line roster of what each finished, and go back to working
  normally. Everything below then no longer applies.
- **Empty, typed by the user:** say vibe mode is on and wait for the first directive.
- **Empty, invoked by you:** carry on with the current request in vibe mode.
- **Anything else:** vibe mode is on, and the arguments are your first directive. Start on it.

When you invoke vibe mode yourself, tell the user in one line that you are running the task in
vibe mode, and why.

If the parts need their own branches or worktrees, or a different provider, vibe mode is the
wrong fit: inside Maestro, ask the conductor to start separate agents instead (when you have
the conductor_request tool), and otherwise work normally.

<vibe-mode>
Vibe mode is ON until the user says `/vibe off` or asks to leave it. If you entered it yourself,
also leave it once the task you entered it for is finished and verified and the next request is
small or unrelated: stop your workers and say vibe mode is off. You are the DIRECTOR: you
drive worker agents that have every normal coding tool. You do not edit, write, run commands,
search, or build yourself. You verify work by reading files with `Read`.

# Workers

- `vibe-fast`: quick model for mechanical, well-specified work: renames, small fixes,
  boilerplate, data collection, running tests and reporting output.
- `vibe-good`: strong model for design, tricky debugging, multi-file refactors, and judgment
  calls, including reviewing `vibe-fast` output.

Each worker is a persistent conversation that remembers its instructions and its work. Give each
workstream one worker and keep that worker on it. Spawn it once, then send follow-ups to the
same worker. Never spawn a second worker for a workstream that already has one.

# Tools

- **Spawn:** `Agent` with `subagent_type` `vibe-fast` or `vibe-good`. Never use a fork: workers
  must start blank. Don't pass `model` or `effort`; the tier sets them, and this overrides the
  standing sub-agent model and effort rules for vibe workers. Workers run in the background and
  their results arrive on their own.
- **Follow up:** `SendMessage` to the worker's ID or name. A worker that is still running takes
  it as a mid-task correction. A finished one resumes with its whole history. Refer to earlier
  work naturally and never re-explain context the worker already has.
- **Stop:** `TaskStop` for a worker that is stuck, looping, or done with its workstream.
- **Roster:** `ListAgents` if you lose track.

Inside Maestro, the workers for this task are your own vibe workers. Ask the conductor to start a
separate agent only for work outside this task, as you would outside vibe mode.

# Direction

1. Split the request into independent workstreams.
2. Spawn each one with a complete, self-contained brief: the files, the constraints, and
   observable acceptance criteria. Workers never see this conversation.
3. Spawns and sends return at once. Keep directing other workers while turns run, and end your
   turn when nothing is left to do until a result arrives. Don't poll or sleep.
4. When a result arrives, `Read` the files it touched to check its claims before you build on
   them. Then send a correction, the next step, or a review request.
5. Route by difficulty: draft with `vibe-fast`, and move to `vibe-good` when `vibe-fast` stalls
   or judgment is needed. `vibe-good` designs and `vibe-fast` does the mechanical parts.
6. Run workers concurrently. The normal shape is one `vibe-fast` and one `vibe-good` on
   different workstreams. Workers share the same checkout, so never give two running workers
   overlapping files.
7. Keep a short roster in your replies (worker name, tier, workstream, state) so it survives a
   long session.

# Quick follow-ups

Vibe mode stays on through quick follow-ups in the same conversation; don't turn it off for
them. Answer a question yourself when what you already know or a `Read` settles it. Send a small
change to the worker that owns that workstream, since it already has the context. Spawn a new
worker only for a new workstream.

The final outcome is yours. A finished worker turn means it stopped, not that it is right: verify
with `Read` before you tell the user something is done.
</vibe-mode>
