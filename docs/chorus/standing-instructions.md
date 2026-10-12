# Standing instructions: the conductor adjusting itself

The developer can tell the conductor how to act from now on ("from now on, stop being so
descriptive when you prompt, and keep things open-ended"). The conductor saves that itself and
follows it in every later turn and session, on the realtime voice line and on the text path.

## How it works

- **A layer, not an edit.** The built-in prompt (`conductor/api/system-prompt.ts`) never changes
  at run time. Saved instructions are rendered as one block (`standingInstructionsBlock`) that
  follows it: a second system block for the text model, the end of the session instructions on
  the voice line. Each instruction has an id (`i3`) the model uses to replace or remove it.
- **Tools.** `adjust_instructions` (add, replace, remove, clear), `review_instructions` (what
  the conductor was told, what it may change, what it may not) and `change_setting` (an
  allowlist of conductor settings in `conductor/api/adjustable-settings.ts`).
- **Storage.** The main process keeps `conductor-instructions.json` in the Chorus data
  directory and reports the list in the conductor status. Text is redacted before it is saved.
- **Taking effect.** The text model reads the block on its next call. The voice line watches
  the conductor store and sends the open session a `session.update` with the new instructions,
  so nothing reconnects; a new session opens with them.

## Limits

- At most 20 instructions, 400 characters each, 4,000 in all (`STANDING_LIMITS`), so the voice
  line's instructions stay well under the provider's cap.
- Instructions shape wording, length and defaults. They cannot change what Maestro asks the
  developer to confirm, the tool fences of completion and agent-request turns, or anything else
  enforced in code. Commands Maestro runs without the model (the grammar, fast verbatim
  routing) never read them.
- Only the developer adjusts the conductor. The tools are refused in turns an agent started,
  ask for a yes in a tainted turn, and ask for a yes when the turn already read agent output,
  a page, a file or the clipboard. Turning on a setting that removes a safeguard
  (`auto_approve_plans`, `agent_requests`) always asks.
- Provider, models, keys, budgets, diagnostics, code checks and the voice line's own settings
  stay in the settings page.

## Cost

No extra model call: the conductor writes the instruction in the tool call it already makes.
The cached prefix (tools and built-in prompt) is byte-identical whatever is saved; the block has
its own cache breakpoint. Reads come from memory in both processes.
