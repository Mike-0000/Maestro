# Conductor YOLO mode

Status: implemented on branch `yolo-mode`, not merged.

## Problem

A task's chat conductor can already "Act on my behalf": on a chat event it may prompt, answer or
interrupt the task's agents within the developer's direction. In practice it still comes back with
questions the developer would rather it settled, and it stops after 12 unattended actions. The
developer wants to hand over a task and come back to it finished, hearing from the conductor only
when it truly cannot go on alone.

## What YOLO mode is

YOLO mode is a standing, full delegation of the task's decisions, set with a switch rather than in
words. It sits on top of "Act on my behalf" (autonomy):

| Mode | On a chat event the conductor | Unattended actions before the developer must write |
| --- | --- | --- |
| Autonomy off | reads and reports, never acts | 0 |
| Act on my behalf | acts within the developer's direction, asks for choices | 12 |
| YOLO | acts, and makes every choice itself unless it hits a blocker | 60 |

Turning YOLO on also turns autonomy on. Turning autonomy off also turns YOLO off. Each task keeps
its own YOLO state in its saved thread, like autonomy.

## Where it is set

- **Per task:** a "YOLO" switch in the row of controls under the conductor's composer, next to
  "Act on my behalf". It shows in an accent colour while on, with a tooltip that says what the
  conductor will and will not do.
- **Default:** Settings → Voice & Conductor → Chat conductors → "New chats start in YOLO mode"
  (`chatConductorYolo`, default off). A new task's thread starts from it; an existing task keeps
  what it had.

## What the conductor gets

1. **The prompt variant.** In YOLO mode every chat conductor model call carries a second system
   block, `CHAT_YOLO_RULES` (`api/chat-conductor/yolo.ts`), after the cached base prompt. The base
   prompt stays byte-stable and keeps its cache breakpoint; the YOLO block is cached by the
   conversation breakpoints. Switching the mode costs one conversation cache miss.
2. **A context line.** The per-turn `<context>` block says `Autonomy: YOLO` and how many unattended
   actions remain before Maestro's safety cap.
3. **Code-enforced rules** (see below).

### The rules in the YOLO block

- The developer's goal is delegated in full: carry it through to completion without asking.
  Every choice that would have been put to them is the conductor's: pick the default it would have
  recommended, act, and say what it chose and why in one line.
- Answer the agents' questions and permission prompts itself: allow what serves the goal, deny
  and redirect what hits a blocker.
- Do not stop to report progress. Keep the status line true (`working`, with the step in the
  headline) and post a line only at a milestone.
- When an approach fails twice, try another (another agent, another provider, a narrower step)
  before calling it a blocker.
- Never present what has not happened as done.

### Escalation: the only reasons to stop and ask

The block lists them, and `set_status` with `needs_you` must name one in its `blocker` field:

| `blocker` | Meaning |
| --- | --- |
| `credential` | A password, token, sign-in or 2FA code that neither the conductor nor an agent can obtain. |
| `payment` | Spending money or paid resources beyond what the project already uses. |
| `irreversible` | A step that destroys work or data that cannot be recovered: deleting outside version control, dropping data, force-pushing, rewriting shared history. |
| `outside_project` | A step that reaches people or systems beyond this project: pushing or merging to a shared or default branch, releasing, publishing, deploying, sending messages, unless the developer's direction already names it. |
| `refused` | Maestro refused a step and no other route reaches the goal. |
| `limit` | Maestro's cap on unattended actions is reached. |
| `stuck` | Several different approaches failed, or the work needs something only the developer has (a decision about intent that no reading of their words settles, a physical action). |

Anything else is a decision, and decisions are the conductor's.

### Decision logic in code

- `gateYoloStatus` (`api/chat-conductor/yolo.ts`): in YOLO mode, `set_status` with `needs_you`
  and no valid `blocker` is refused with a reason telling the conductor to decide and carry on.
  This is what keeps "needs you" notifications for real blockers. Outside YOLO, `blocker` is
  optional and ignored.
- `gateChatTool` (`api/chat-conductor/turns.ts`): the unattended action cap is
  `MAX_UNATTENDED_ACTIONS_YOLO` (60) instead of 12. The cap stays as a runaway-loop backstop; when
  it is reached the conductor must stop and report, and the developer's next message resets it.
- Unchanged in YOLO: stopping or restarting an agent that is mid-turn is still refused on a chat
  event; the browser address rules are unchanged; agent output is still never consent.

## How a task ends

The conductor ends the task when the developer's goal is met and verified: it posts a
`post_digest` report (what was done, what was checked and what was only claimed, anything held
back such as an unpushed branch) and sets the status to `done` with `notify: true`, so the
developer hears it even when they only asked to hear about agents that need them. Work it held back
because it needs a go-ahead (a push to a shared branch, a release) is listed under "Your move", not
asked as a question. A task that cannot finish ends with `needs_you` and the blocker.

## Decisions made and why

1. **YOLO is a level above autonomy, stored as its own flag.** A three-level enum would have
   rewritten the thread schema, the session and many tests. An optional `yolo` flag on the task
   thread is backward compatible (old threads read as off, older builds drop it) and keeps the
   diff small.
2. **The YOLO rules go in a second system block, not in the base prompt or the context block.**
   The base prompt stays byte-stable and cached; the context block stays short on every turn.
3. **The escalation list is enforced on `needs_you`, not on free text.** Code cannot reliably tell
   a question in prose, but it can make the notification that pulls the developer back conditional
   on a named blocker. The prompt covers the prose.
4. **Pushes.** Committing in the task's own folder is fine. Pushing, merging or releasing to
   anything shared needs the developer's direction to name it; without that the conductor does not
   ask, it finishes and lists the push under "Your move".
5. **A higher cap, not no cap.** 60 unattended actions is enough for a long task (each prompt,
   answer or new chat is one) and still stops a loop that never settles.
6. **Default off.** YOLO is opt-in per task or as a setting, since it widens what happens while
   the developer is away.

## Vocabulary: "cloud agent"

Both conductors' prompts (`CONDUCTOR_RULES` for Maestro's conductor and its voice line, and the
chat conductor's direction rules) now include `CONDUCTOR_VOCABULARY` (`api/vocabulary.ts`): when
the developer says "cloud agent" they mean a Claude agent (provider `claude`), never Codex or an
agent running in the cloud. The fast router already maps "cloud" to Claude.

## Not covered

- YOLO does not change Maestro's own (voice) conductor, which acts only on the developer's words.
- No telemetry of how often YOLO escalates.
