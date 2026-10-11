# Voice and the conductor

Chorus lets you run your agents by voice. Speech becomes text (speech-to-text, STT), a fast
built-in grammar handles common commands, and anything else goes to the **conductor**, a Claude
model that can read, message, start, and plan across your agents.

## Talking

| Action | How |
| --- | --- |
| Hold to talk (command) | Hold **Right Ctrl**, speak, release |
| Hold to dictate into the focused agent | Hold **Shift + Right Ctrl** |
| Hold to talk from anywhere in Windows | **Right Ctrl** or **Right Alt**, if enabled in settings (off by default) |
| Toggle listening from anywhere in Windows | **Ctrl + Alt + Space** (configurable); press again to send |
| Click to talk | The mic button in the floating HUD, then **Send** (or click the mic again) |
| Cancel while listening | **Esc**, or the × next to **Send** |
| Type instead of talking | The keyboard button in the HUD |
| Open the canvas | **Ctrl + Shift + A** |
| Jump to the agent that has waited longest | **Ctrl + Shift + J** |

Pausing never ends a recording: it runs until you release the hold key, press the toggle shortcut
again, or click **Send** (up to 5 minutes). Only hands-free listening stops on a pause.

## From your phone

With [remote access](../../agents/architecture/remote-access.md) on, the web app has the same
voice mode: hold the mic to talk, tap to toggle, or type. Your words are transcribed by this
computer's speech-to-text engine and handled by the same conductor, so every command below
works, including the countdowns and confirmations. Replies are shown and spoken on the phone,
not on this computer. Commands that move windows act on this computer's canvas.

## Built-in commands (instant, no API key needed)

- "Focus Claude 2" / "go to Codex 1" / "show me the codex one"
- "Show all" / "zoom out"
- "Next" / "who needs me" (jumps to the agent that has waited longest)
- "Tell Claude 1 to run the tests" / "Codex 2, fix the lint errors"
- "Stop Claude 1" (interrupts)
- "What is Codex 1 doing" (reads its last line)
- "Send it" (presses Enter in the focused agent, after dictation)
- "Take a note: …"
- "Mute" / "unmute"
- "Yes" / "no" (confirm or cancel the pending action or plan; "stop", "wait", "hold on", and
  "scratch that" also cancel)
- "Help" / "what can I say"

### Windows and agents

| Say | What happens |
| --- | --- |
| "Close" / "close this" / "hide it" | Closes the focused window (or cancels a pending action) |
| "Close Atlas" / "dismiss the Bravo window" / "get rid of Bravo" | Closes that agent's window |
| "Close all" / "close the others" / "close the finished ones" | Closes several windows (countdown first) |
| "Reopen" / "bring it back" | Reopens what you closed last ("undo" does too; see below) |
| "Reopen Atlas" / "bring Atlas back" / "go to Atlas" | Reopens that agent's window and focuses it |
| "Reopen all" / "show hidden windows" | Reopens every closed window |
| "Allow Atlas" / "deny Bravo" | Answers that agent's permission prompt (confirm first) |
| "Shut down Atlas" / "kill Atlas" | Ends the agent's session; the conversation is kept (confirm first) |
| "Archive Atlas" | Archives the agent's task (confirm first) |

**Close only hides the window:** the agent keeps running and stays addressable by name, and the
canvas's "show hidden" button or "reopen" brings it back. Stopping the current step is "stop
Atlas" / "interrupt Atlas"; ending the session is "shut down"; archiving is separate again.
"Delete Atlas" asks which of close or archive you meant. Polite lead-ins work ("can you close
Atlas", "please close Bravo"), and a name the grammar cannot place goes to the conductor rather
than closing the wrong window.

Agent names are the spoken names on each tile ("Atlas", "Bravo", or "Claude 1"). Double-click a
name to rename it. Common mishearings ("clod two", "codecs", "at less", "brave oh") are corrected
automatically; a close-but-ambiguous name gets a "which one?" instead of a guess. "Atlas's
window" and "the Bravo terminal" work too.

How a name finds its agent:

- An agent's own name always wins, whether its window is open or closed. "Atlas 3" is the agent
  called Atlas 3, never an agent that only has those words in its title or task.
- The number is part of the name. "Atlas 3" is never Atlas or Atlas 2: if no agent has the name
  (it was archived, or the number was misheard), nothing is sent and the conductor asks which
  agent you mean. "Atlas one" is plain Atlas.
- A name said without its number ("Jasper" for Jasper 3) works when only one agent has that
  name; with two, you are asked which.
- "Too" and "for" after a name are words unless only the number makes sense: "stop Atlas too"
  stops Atlas, and asks "Atlas or Atlas 2?" when both exist. "Ask Atlas for a status update"
  goes to Atlas.
- When you talk to one agent, nothing reaches the one beside it: with "tell Atlas 3 ...", "send
  that to Atlas 3", or "what's Atlas 3 doing", an action headed for Atlas is refused, and the
  other way round. A name you only mention ("rebase onto Atlas 3's branch") changes nothing.
- An agent has one name everywhere. When the canvas names or renames an agent, the
  conversation's title in the task view becomes that name, unless someone wrote the title
  themselves. A written title works as a second name when it is that agent's alone. A title
  from before is only replaced when it would send you to a different agent.
- After a rename the agent still answers to its old name for the rest of the session, until
  another agent takes that name.
- For a few minutes after you archive or delete an agent, its name names nobody: "tell Backend
  ..." does not go to the agent whose task happens to mention the backend. "The backend agent"
  still describes that one.
- Every agent has its own name. A new agent gets a word no other agent uses, so names carry a
  number only when more than 26 agents exist at once. A name is free again about a minute
  after its agent is archived or deleted; an agent that is merely not loaded yet keeps its
  name. Renaming an agent to a name another agent has is refused.
- "Simplify the agent names" (or "drop the numbers from the names") takes the number off every
  name whose word no other agent uses: Atlas 3 becomes Atlas. It shows what it will rename
  with the usual countdown. Names never change by themselves.

Sending text, interrupting, or closing several windows shows a 1.5-second countdown in the HUD;
press **Esc** or say "no" to cancel. Answering a permission prompt, shutting down, and archiving
always need an explicit "yes" (or **Enter**). Enter only confirms when it is pressed outside a
terminal or text field, and not in the instant the action appears, so typing into an agent never
approves something by accident. For the same reason, Chorus refuses to type a message into a
terminal agent that is showing a permission prompt; say "allow" or "deny" instead.

### Organizing the canvas

Windows can be grouped into named **regions** (sub-canvases) that nest, and any region or set of
windows can go on the **stage**: tiled full screen, live, without moving anything on the board.

A sub-canvas is a workspace. Going into one zooms it to fill the screen, and every window in it
runs live (terminals interactive, browsers awake) for as long as you are there. A new sub-canvas
made by voice opens by itself. A **tiled** sub-canvas splits its space between its windows with
no gaps or overlap: four windows make quadrants, and a browser gets more room than a terminal.
When windows join or leave, the split redraws. When the app window resizes, a sub-canvas that
fills the screen resizes with it. If you size or place it yourself, it keeps your layout.

| Say | What happens |
| --- | --- |
| "Group Atlas and Bravo as Review" / "make a region called Docs with Cedar" | New region around those windows |
| "Put these in a new group called Sprint" | Groups the selected windows |
| "Move Cedar into Backend" / "take Atlas out of the region" | Moves windows between regions |
| "Put Cedar next to Atlas" / "move the browser to the top right" / "move Atlas a bit left" | Places windows |
| "Make Atlas bigger" / "make the browser half the screen" / "make Cedar the same size as Atlas" | Resizes |
| "Put Atlas and Bravo side by side" / "tidy up" / "swap Atlas and Cedar" | Lines windows up |
| "Put these four agents in quadrants" / "tile them" / "tile this" | Tiles the windows, or the sub-canvas you are in |
| "Make the browser larger" / "give Atlas more room" | In a tiled sub-canvas, shifts space between its windows |
| "Organize by status" (task, project, provider) / "organize the Review region by task" | One region per group (previewed first) |
| "Rename Review to QA" / "make Backend green" / "collapse Review" / "ungroup Backend" | Edits a region |
| "Full screen Review" / "put Atlas and Bravo on the stage" / "just Atlas" / "exit full screen" | The stage |
| "Open Backend" / "switch to the new one" / "this one" / "switch back" | Goes into a sub-canvas (fills the screen) |
| "Next sub-canvas" / "previous sub-canvas" | Steps between sub-canvases at the same level |
| "Leave this sub-canvas" / "exit" / "main canvas" | Out one level, or all the way to the main canvas |
| "Go to Backend" / "go back" / "up a level" / "go home" | Moves around the canvas |
| "What's in Review" / "list regions" / "where is Cedar" | Answers out loud |
| "Undo" / "redo" | Reverts or re-applies the last layout change |

"These" means the selection, "them" what the last change touched, and "here" or "this one"
the region you are in. "The new one" is the sub-canvas made most recently, and "the other one" is
the one you were in before. A count must match: "these four agents" with three selected is asked
about, not guessed. So is "the new one" before any sub-canvas exists. Layout changes are shown, not spoken (turn on spoken confirmations in the canvas layout
settings), and the HUD shows **Undo** for a few seconds after each one. Anything the grammar
cannot place ("arrange my review agents so the failing one is biggest") goes to the conductor,
which has the same abilities through its `arrange_canvas` tool. Rearranging never closes, stops,
or types into an agent.

### Desks (Canvas Pro)

Canvas Pro shows the canvas as **desks**: each desk is one screen of windows, only one shows at a
time, and you swap between them. Windows on the other desks keep running. A desk is a top-level
region shown alone, so everything in "Organizing the canvas" still works inside one; a region
made there sits on the desk in view. Say "desktop" or "space" if you prefer; both mean desk.

Only the first row works on the classic canvas. The rest need Canvas Pro, and there the phrases
are instant, with no API key.

| Say | What happens |
| --- | --- |
| "Switch to Canvas Pro" / "go back to the classic canvas" | Changes the mode. Entering Pro puts loose windows on a desk called Main (one undo step); leaving it turns the desks back into regions on one board |
| "New desk" / "new desk called Review with Atlas and Bravo" | Makes a desk and switches to it ("… and stay here" does not switch) |
| "Put Atlas and Bravo on a new desk called Pairing" | The same, said the other way round |
| "Make a desk for everything that needs me" | A **gathering desk**, called Triage unless you name it: while it shows, every window that needs you appears on it. Also "… for the failed ones", "… that is working", "… that are done" |
| "Switch to the Review desk" / "open Review" / "go to Review" | Swaps to that desk |
| "Next desk" / "previous desk" | Steps through the desks in order, wrapping at the ends |
| "Desk 2" / "the second desk" / "the new desk" | By its place in the order, or the newest one |
| "The other desk" / "switch back" | The desk you were on before |
| "Put Cedar on the Frontend desk" / "move Atlas here" | Moves windows to a desk for good ("… and follow" or "… and take me there" also switches to it) |
| "Bring Atlas here" / "bring Atlas and Bravo over" | Shows windows from another desk on this one **without moving them**. They go home when you change desk |
| "Send it back" / "send them back" / "send Atlas back" | Sends visitors home now |
| "Keep it here" / "keep them here" | Makes visitors live on this desk |
| "Rename this desk to Home" / "rename the Review desk to QA" | Renames a desk |
| "Move this desk left" (right, first, last) / "put the Review desk first" | Changes the order of the desks |
| "Remove the Review desk" / "close this desk" / "delete desk 3" | Removes the desk; its windows go to the desk before it. Nothing is closed, and the last desk stays. Previewed first when the desk has windows on it |
| "List desks" / "what's on the Review desk" / "which desk am I on" | Answers out loud |

"Focus Atlas", "next" (the agent that needs you), "reopen Bravo", and "show the app" switch to the
desk the window is on first. There is no main canvas above a desk: "leave" inside a region goes
back to the desk, and on a desk it says which one you are on. A change you can see is not spoken;
one that happens on a desk you cannot see ("put Atlas on the Review desk" from a third desk) is.
Every desk change that moves windows is one **Undo** step.

Anything else about desks ("put the failing ones on their own desk and call it Fire", "remove
Scratch and send its windows to Review") goes to the conductor, which has the same abilities
through its `canvas_desks` tool. On the classic canvas that tool only answers that desks are part
of Canvas Pro. The conductor never switches the canvas mode unless you ask.

## The conductor

Anything the grammar does not recognise goes to Claude, which can:

- read what agents are doing and summarise it,
- send clear instructions to one or more agents,
- start a new agent in a fresh git worktree (`spawn_agent`),
- **plan**: split a goal into 2–4 parallel agents, each owning distinct paths, with an acceptance
  command. You approve the plan in the HUD ("yes" or **Start**) before anything runs. Subtasks
  can run after one another, and a conflict radar (`git merge-tree`, read-only) warns when two
  branches would conflict.

Long dictated briefs reach agents intact. The conductor writes an organized prompt from what you
said, and when a request is long (50 words or more) Chorus also attaches your verbatim transcript
to `spawn_agent` and `send_to_agent` prompts, so details such as examples and emphasis do not
depend on the model's summary. The start/send countdown shows the prompt's size and first line,
and the tool result tells the conductor exactly how much was delivered. If you say an agent got
too little, the conductor reads what the agent actually received before resending.

### What the conductor knows

Every request carries the current state, so questions about your agents are answered from data
instead of guessed or refused:

- the local date and time;
- each agent, newest first: name, provider, status and how long it has waited, task, project,
  when it started, when you last messaged it, its region, and any other title it goes by (an
  agent started from your phone keeps the name it got there);
- the focused agent and where that reading comes from (see below);
- the newest agent in each project, who has waited longest, and the current project ("this
  project" is the focused agent's project, else the project of the task or project view on
  screen, else the one the canvas is filtered to);
- closed windows, app browsers, regions, the selection, and the last layout change;
- in Canvas Pro: the mode, the desks in order with the one in view marked, how many windows each
  has and what they are up to, what a gathering desk gathers, which desk each agent is on, and
  the windows visiting the desk in view;
- the conductor's recent activity: the last few things sent and started, with the exact text,
  including commands the built-in grammar handled without the model.

### The focused agent

The focused agent is the one you are looking at. "This one", "it", and dictation mean that
agent, and so does an instruction that names no agent ("run the tests again"): the conductor
sends it there and says the name. A named agent always wins, and the send countdown shows the
target before anything leaves. Focus is read from whatever is on screen, on every request:

| On screen | Focused agent |
| --- | --- |
| The canvas | The window you clicked or asked to focus. A window the project filter hid does not count. |
| The stage (full screen) | The only agent on the stage, else the pane you clicked. A window focused on the board underneath does not count. |
| A task view (outside the canvas) | The chat that is the active tab, else the only chat showing, else the task's only agent. |
| Anything else (settings, home, a project) | None |

The conductor asks instead of guessing when nothing is focused, when the stage or a task view
shows several agents and none is in front, and when the focused window is outside the
sub-canvas that fills the screen. Saying "focus Atlas" focuses Atlas's window on the canvas;
while a task view is on screen, the chat in front stays the focused agent.

So these work:

| Say | What happens |
| --- | --- |
| "Run the tests again" (Atlas focused) | Goes to Atlas |
| "Send this to the latest agent in this project" | Goes to the newest agent of the current project |
| "Tell the newest Codex agent in Chorus to rebase" | Picks by provider, project, and start time |
| "Ask Atlas in ACE COMBAT 8 …" | Only an Atlas in that project matches; otherwise you are told who is there |
| "That message was supposed to go to Echo" | Resends the exact earlier text to Echo |
| "What did I tell Lima earlier?" | Read back from the recent activity (`recent_activity`) |
| "Where is Lima working?" / "when did I start Atlas?" | Folder, branch, timing (`agent_details`) |
| "I started an agent from my phone and can't see it" | Looks through archived tasks and conversations that are not on the canvas (`find_conversations`) |
| "Send what I copied to Atlas" | Reads the clipboard (`read_clipboard`; Maestro must be the focused window) |
| "Rename Atlas to Backend" | Changes the spoken name |
| "Simplify the agent names" / "drop the numbers from the names" | Atlas 3 becomes Atlas wherever no other agent uses the word |
| "Only show the Chorus project" / "show all projects" | Filters the canvas |

"The latest agent in Chorus" and "Atlas in ACE COMBAT 8" also work in the instant commands
("tell the latest agent in Chorus to run the tests"). With agents in more than one project, the
send countdown names the project ("Send to Atlas 3 (Chorus): …"), so a message headed to the
wrong project can be cancelled before it leaves. Recent activity is kept in memory; with
diagnostic history on, the last 20 turns are recalled after a restart.

### When an agent finishes

The conductor hears what a finished agent told you: its final reply, not just "Zulu is done".
Claude Code and other agents whose Stop hook carries the reply send it through the hook; for chat
(ACP) agents Chorus reads the last turn of the transcript. Only the final user-facing reply is used.
Reasoning, tool output, and the rest of the transcript are left out. The reply is redacted
(keys, tokens, URL credentials) and capped at 4,000 characters, keeping the start and the end.
Local URLs such as `http://localhost:3000` are also extracted from it.

With a conductor API key, a finished agent that reported something gets one short follow-up turn.
The conductor says in a sentence or two what matters, such as "Zulu built the todo app; it's running
at localhost port 3000. Want me to open it?". If you asked earlier ("open it in the browser when it's
done"), it opens the app itself. That turn can only read state and run `show_app`; Chorus refuses
every other tool, whatever the model asks. `show_app` opens only localhost URLs or the app's current
origin. The reply counts as information, never as instructions or your consent, so sending,
starting, stopping, or approving anything still needs you, with the usual countdowns and
confirmations. Later, "open it" or "what did Zulu say?" works: the conductor's context carries a
short preview of each finished agent's reply, and `read_agent` returns the whole reply.

You hear each completion once. If there is no reply, the follow-up is off, the conductor is busy with
your request, or the model call fails, you get the fixed sentence instead, which still names the
reported app URL. Turn it off with **Report what finished agents said** in Settings → Voice &
Conductor.

Codex's notify hook sends no reply text, and neither does any hook without
`last_assistant_message`. For these terminal agents Chorus reads the last 2,000 characters of the
agent's terminal instead, about one screen, where the TUI prints its closing message. Box-drawing
borders and blank runs are dropped, and the text is redacted like a reply. The conductor is told
this is terminal output, which can include tool output, status lines, and the input box, and works
out what the agent said from it. The same safety limits apply. Because it is a screen tail, it can
include whatever the TUI showed last, such as reasoning summaries that Codex prints.

Add an Anthropic API key in **Settings → Voice & Conductor**. The default model is
`claude-opus-5` with low effort for commands and high effort for plans; both are configurable,
and a daily token budget (3M by default) stops runaway spend. **Diagnostic history is off by
 default.** Enable it in Settings → Voice & Conductor to retain recent, redacted command summaries
and interaction events under the Chorus profile's `chorus/` directory (`conductor-log.jsonl` and
`interaction-trace.jsonl`). On a standard Windows install this is `%APPDATA%\chorus\chorus\`;
development, canary, and overridden profiles have different locations. Traces include final STT
text, live Deepgram partials, routing, tool activity, the HUD reply, and whether speech started,
ended, was suppressed, or was interrupted. They do **not** contain audio or prove what the
microphone actually captured. Deepgram confidence, when supplied, describes the latest segment
or selected alternative, not the reliability of the whole command; other adapters do not expose it. A reported agent send
may mean only that it was accepted or scheduled, not that the agent completed the work.

Diagnostics are limited to 2 MB per file and 7 days by default (configurable up to 30 days).
Turning the setting off deletes stored diagnostics. Use **Delete diagnostics** to erase them
without disabling collection. **Copy recent events for agent** requires confirmation and copies
up to 200 redacted events to the clipboard; paste into a trusted coding agent only after review.
The app does not silently grant worktree agents access to the desktop profile. Speech and tool
arguments may contain private data despite automatic secret redaction; do not export without
reviewing them. Cloud STT sends audio to the chosen provider; local whisper.cpp does not.

### When an agent asks for something

Claude Code and Codex agents on this computer can send the conductor a request:

| The agent asks to | What you hear | What happens |
| --- | --- | --- |
| Start another agent with a brief | What the conductor decided, or "Atlas asks to start a codex agent on … Say yes to allow it, or no." | An approved agent starts behind the usual cancel window, with the brief unchanged |
| Send another agent a message | The same | The message is passed on, marked as coming from that agent |
| Ask you a question | "Atlas asks: …" | Answer by voice ("make the pod longer", or "tell Atlas …"); the answer is typed into Atlas |
| Tell you something | "Atlas is blocked: …" | Nothing else |

The conductor decides requests to start or message an agent, and asks you when it is unsure.
"Yes" or "no" answers a request only when its question is the last thing the conductor said;
say more ("tell Atlas yes", "make the pod longer") at any other time. A request is never treated
as your permission for anything else. When an agent finishes work another agent asked for, its final
reply is passed back to the one that asked. Turn all of this off with **Let agents ask the
conductor** in Settings → Voice & Conductor. See [agent requests](agent-requests.md) for the
request format and the kinds.

### Checking the code (built, not switched on)

The conductor can ask a read-only Claude Code process questions about a project's files ("do we
already have a retry helper?") before it plans or answers, and show each answer with the files it
rests on. A check runs in a contained process: it cannot write, cannot read outside the project
or its secret files, and runs no project hooks. While a check runs, a card shows what is being
read, and Esc or "stop" cancels it. After a check, everything the conductor does in that turn
asks for an explicit yes, because the files it read are not your words.

The setting for this is hidden until the checks in
[the code-check plan](../conductor-subagent-plan.md) have been run; see
[the design](../design/talk-mode.md#implementation-status).

### Calls from agents

Off by default. Turn it on with **Calls from agents** in Settings → Voice & Conductor.

With calls on, agents reach you **one at a time**. A finished agent, an agent's question, a
request that needs your yes or no, and a permission prompt each become a call from exactly one
agent. Maestro says it (or only shows it, with **Shown**), marks that agent's window with a green
ring, and keeps the call "on the line" for a few seconds. The ring is a mark, not focus: nothing
moves on the canvas.

While a call is on the line, **pick it up** and speak. What you say goes to that caller without
naming it:

| Pick up by | Then |
| --- | --- |
| Tapping **Right Ctrl** once (or your global hold key) | Speak; it ends when you pause. A second tap sends at once |
| Holding the talk key | Speak, release |
| **Answer** on the call card | Same as a tap |
| **Type** on the call card | Type the answer in the command box |

| Say (after picking up) | What happens |
| --- | --- |
| "Fix the lint error too" (after Atlas finished) | Goes to Atlas, behind the usual cancel window |
| "It should, default three" (after Maple asked a question) | Sent to Maple as your answer, in your words |
| "Allow" / "no" (at a permission call) | Answers that agent's prompt, after the usual explicit yes |
| "Yes" / "no" (at a request call) | Settles that request, not whichever is newest |
| "Yes" / "sure, do that" (after an agent's news) | Goes to the conductor, which asks before each thing it does: your words named no action |
| "Tell Bravo to rebase" | A name you say always wins over the caller, also when the caller asked a question |
| "Never mind" / "stop" | Ends the call; nothing is sent |

A yes or a no after a pick-up is always for the caller. It never approves or discards a plan, or
settles another agent's request, that happens to be waiting too. Calls are not delivered while a
plan waits for your yes.

Dictation after a pick-up is typed into the caller, and a "send it" in the next 45 seconds is
sent there, not to the window in front, unless you have moved to another window since. A call
picked up with **Type** goes back on the line when nothing was typed for a minute; a sound that
opens the hands-free microphone does not use it up. **Skip** stays on the call card while you
answer. A second sentence said while the first still waits its turn is for the same caller. If
the caller's window closes while you are speaking to it, your words go nowhere.

Steering needs no pick-up:

| Say | What happens |
| --- | --- |
| "Skip" / "not now" | Drops the call on the line and takes the next |
| "Later" | Sets it aside: it comes back after the others, and not for two minutes |
| "Next call" | Takes the next call now, including one you set aside |
| "Hold my calls" / "take my calls" | Stops and resumes delivery; calls keep queuing |
| "Stay with Atlas" / "back to everyone" | Atlas's calls go first, until you say otherwise |

The most urgent call comes first (Jev's triage when it is on, otherwise permission prompts, then
questions, then finished agents). A call you do not pick up lapses and the next one comes; the
agent still shows as waiting, so "next" and "who needs me" work as before. An agent that calls
more than four times in a minute is shown, not spoken. A tap with no call on the line does
nothing, so a stray tap never opens the microphone. With no call on the line or waiting, "skip",
"later" and "not now" are ordinary words again and go to the conductor. An agent that leaves the
canvas takes its calls with it.

With calls on, **confirmations are read aloud** in a spoken turn, by the computer's own voice, so
you are not left waiting on a prompt you cannot see. A send is read out too ("Send to Atlas: …")
when you answered a call or Maestro is not the window in front; otherwise the countdown is enough.
Speaking over the read-back counts as having heard it.

Always on, with or without calls:

- **A yes counts only for the prompt it was said to.** Words you began to say before a prompt
  appeared, or before it finished being read out, never confirm it. They can still stop it:
  "stop" cancels it, and any other words cancel a countdown, as they always did. The same goes
  for a plan and for an agent's question: a yes or a no begun before the plan was shown, or
  before the question was asked, neither starts nor discards the plan and is not sent to the
  agent.
- **Speaking stops the clock.** Opening the microphone during a countdown pauses it until your
  words arrive, so "no" lands in time. Anything other than a yes still cancels. Dictation pauses
  the clock too, and it runs again when the dictation ends.
- **"Stop" ends the conductor's turn.** While it is thinking, or during one of its countdowns,
  "stop" (or "no" to a countdown) ends the whole turn: what it already did stays done, the action
  it was about to take is not taken, and nothing else it asked for runs. Any wording works
  there: "No, stop!", "stop it", "cancel that", "no, don't send that", "hang on". With nothing
  pending and the conductor idle, "stop it" is still a command for the agent in front. Other
  words said during one of the conductor's countdowns drop the rest of that turn too, then take
  their own turn. "No" to a yes-or-no question answers that question only, and "no" to a note
  you dropped by hand cancels the note, not the conductor's turn.
- **Allowing a permission prompt** checks that the last 60 lines of the terminal are still what
  you were asked about, character for character apart from an agent's working line ("… esc to
  interrupt") and spinner lines. If the agent moved on to a different prompt, or its terminal
  cannot be read, nothing is sent and you answer it in its window. Denying needs no such check.
- **A reply that names no action** ("yes", "um, sure, do that", "the second one", "yes, run it")
  to something an agent suggested makes each action the conductor then takes ask for an explicit
  yes, with the full text shown and, in a spoken turn, read aloud. That covers a call you picked
  up, anything Maestro announced since you last spoke ("Atlas finished: tests pass. Shall I
  push?"), an agent's report, and output the conductor read for you a turn or two ago. An
  instruction in your own words ("merge it", "yes, and add a changelog entry") keeps the usual
  cancel window. The rule is a word list, so it can misjudge an unusual phrasing either way.
- A message is not typed into an agent that reached a permission prompt while the countdown ran,
  and "send it" is refused there too: Enter would answer the prompt.

### The talk line (experimental)

Off by default. Turn it on with **Talk with Maestro on a live line** in Settings → Voice &
Conductor → Talk line. It needs an OpenAI API key (API keys, in the same settings); OpenRouter
does not carry realtime sessions.

The talk line is one realtime voice session (OpenAI's Realtime API, over WebRTC) between you and
Maestro. A small dot next to the microphone button shows it: green when open, with a ring while
its microphone is open, amber while connecting, red when it is wanted but not connected.

What it adds:

- **Questions get a spoken answer in about a second or two.** "What's everyone doing?", "what
  did Maple change?", "why did Bravo stop?" are answered by a voice model that is kept up to
  date with your agents and can read their output.
- **Follow-ups need no key.** After Maestro speaks, the line's microphone stays open for a few
  seconds (6 by default, 0 to turn this off). In that window you can ask the next question, say
  "stop", or steer calls ("skip", "later").
- **One voice.** With the line open, replies and calls are spoken by it. Consent prompts and
  read-backs still use the computer's own voice, which reads exactly what it is given.

What it cannot do, by design:

- **It cannot act.** The voice model's tools only read (an agent's output and details, recent
  activity, conversations off the canvas, the canvas layout). It cannot message, start, stop, or
  approve anything, focus a window, or move the canvas.
- **Nothing said with no key can change anything.** In the open window a command ("tell Atlas to
  rebase", "focus Bravo", "yes") is not run; Maestro tells you to tap the talk key and say it
  again. Only "no"/"stop" (which cancel), call steering, and "mute" (which silences) work without
  a key. "No" and "stop" are never mistaken for Maestro's own voice coming back.
- **It writes nothing that is acted on.** When you ask for something with the key and the voice
  model decides it needs the conductor, the conductor gets your own words, and each action in
  that turn asks for an explicit yes.

How turns are taken: the provider detects when you stop speaking but never answers on its own.
Maestro reads the transcript first, drops noise and its own voice coming back through the
microphone, and only then lets the voice answer. While you hold the talk key the line says
nothing, and a sentence it had started is cut off. Muted, the line neither speaks nor listens:
its microphone closes and its answers are shown. The microphone opens a moment after a voice
stops, and closes after a minute of sound that never turns into words for Maestro (a meeting, a
radio).

| Setting | What it does |
| --- | --- |
| Voice model | `gpt-realtime-2.1` (default), `gpt-realtime-2.1-mini` (about a quarter of the cost), or `gpt-realtime-1.5` |
| Seconds the microphone stays open | The follow-up window; 0 means the microphone opens only with the talk key |
| Speak over the voice to stop it | Keeps the microphone open while the voice speaks. Use it with headphones, or if echo cancellation holds on your speakers. Off, the talk key stops the voice |
| Daily limit | In US dollars ($5 by default). At the limit the line closes; it opens again by itself within half an hour of the next day starting |

Privacy and cost: while the line is open, what you say in its window, the state of your agents,
and what the voice reads (redacted like diagnostics) go to OpenAI. No audio leaves outside the
window or a held key. A spoken reply costs roughly two cents on the full model and half a cent on
mini; the settings show today's spend. If the line drops, cannot open, or hits its limit,
everything works as it does without it.

The line has been built against OpenAI's documentation and tested with a stand-in for the
provider. Its latency, its echo cancellation on speakers, and its answers have not been measured
on a real session yet; see [the design](../design/talk-mode.md) for what to check.

## Spoken replies (text-to-speech)

In **Settings → Voice & Conductor → Spoken output**, select **Kitten Mini (offline)** for
higher-quality English speech on the CPU without an account, download, or GPU. The packaged app
includes [KittenTTS Mini 0.8](https://huggingface.co/KittenML/kitten-tts-mini-0.8) and its
English phonemizer data; the model is about 96 MB unpacked. Pick from eight local
voices. Windows speech remains the default and fallback. The local option does **not** send text
to any service. Synthesis occurs in the app's main process, so it can run without Internet, even
on a Windows PC without a dedicated GPU. Initial model load can take a few seconds on slow CPUs.

Alternatively, select Gemini 3.8 Flash (higher quality) or Flash-Lite (faster and cheaper). Add a
Google Gemini API key under **API keys**, or set `GEMINI_API_KEY` before launching Chorus. Keys
stay in the encrypted secret store or main-process environment; the renderer never receives the
key. Only short conductor replies to spoken commands and enabled attention notices are
synthesized, not entire agent transcripts. **Gemini sends that reply text to Google**; both
engines stream 24 kHz PCM and stop when you start talking, mute, or another reply arrives. If
synthesis fails or times out, Chorus uses the chosen Windows fallback voice. The **Test** button
previews the active output engine.

The same two models are also available **through OpenRouter**: choose **Gemini 3.8 Flash via
OpenRouter** (`google/gemini-3.8-flash-tts`) or **Gemini 3.8 Flash-Lite via OpenRouter**
(`google/gemini-3.8-flash-lite-tts`). They use the OpenRouter key that already runs the conductor,
STT, and Jev (or `OPENROUTER_API_KEY`), so no Google key is needed, and are billed to your
OpenRouter account. Chorus calls OpenRouter's OpenAI-compatible `POST /api/v1/audio/speech` with
`response_format: "pcm"` from the main process and plays the audio as it arrives, honouring any
`rate`/`channels` in the response's `Content-Type` (24 kHz mono by default). Reply text is sent to
OpenRouter and Google. Because OpenRouter may buffer audio before the first byte, Chorus waits up
to 8 seconds before falling back to the Windows voice.

For developers, `pnpm --dir apps/emdash-desktop run voice:model` downloads the model for local
development. `electron-builder` does this automatically when packaging and verifies the pinned
SHA-256 before including the model in every installer; end users never need to run that command.
The model archive is not stored in Git. The native runtime is
[sherpa-onnx-node](https://www.npmjs.com/package/sherpa-onnx-node) 1.13.8, with explicit
platform binaries for Windows x64, macOS arm64/x64, and Linux arm64/x64. KittenTTS and
sherpa-onnx are Apache-2.0, but sherpa-onnx links **eSpeak NG (GPL-3.0)** for phonemization;
its COPYING text is shipped with the model. Public redistribution of the bundled runtime
requires GPL-3.0 source/notice compliance and legal review before a release. Bundling adds
roughly 100 MB plus platform runtime libraries to the installer; no install scripts are needed.

Google bills paid usage by text input and generated audio tokens; check the current
[Gemini pricing](https://ai.google.dev/gemini-api/docs/pricing) before enabling cloud output.
The cloud option is separate from speech-to-text and from the conductor provider.

## Speech-to-text engines

| Engine | Setup | Notes |
| --- | --- | --- |
| OpenAI `gpt-4o-transcribe` | OpenAI API key | Default. Agent names are passed as a prompt hint. |
| Deepgram Nova-3 | Deepgram API key | Agent names are boosted with `keyterm`. |
| Local whisper.cpp | Run `whisper-server` | Audio never leaves your machine. |
| OpenRouter | OpenRouter API key | Any audio-input model; one key for everything. |

API keys are encrypted with Windows DPAPI (Electron `safeStorage`) and only ever used in the main
process; the UI never sees them. Environment variables `OPENAI_API_KEY`, `DEEPGRAM_API_KEY`, and
`ANTHROPIC_API_KEY` are used as fallbacks.

### Local whisper.cpp setup

1. Download a Windows release of [whisper.cpp](https://github.com/ggml-org/whisper.cpp/releases)
   (for NVIDIA GPUs, pick a CUDA build) and a model such as `ggml-base.en.bin` or
   `ggml-large-v3-turbo.bin`.
2. Start the server:

   ```powershell
   .\whisper-server.exe -m .\models\ggml-base.en.bin --host 127.0.0.1 --port 8178
   ```

3. In **Settings → Voice & Conductor**, choose **Local whisper.cpp server** and keep the URL
   `http://127.0.0.1:8178`.

Chorus posts 16 kHz mono WAV to `/inference`.

## Hands-free

Turn on **Hands-free** in Settings → Voice & Conductor. The mic stays open; when you start
speaking, Chorus records (including the moment before you started) until you pause. Only
utterances that begin with the wake phrase run: "Chorus, focus Claude 1" (a greeting first is
fine: "hey Chorus, close Atlas"; common mishearings such as "courses" also count, but only as a
whole word). Everything else is ignored (the HUD shows what it ignored). Every utterance is transcribed, so this uses more STT.

## Live transcript

With Deepgram and **Live transcript** on, audio streams while you speak and the words appear in
the HUD as they are recognized. Other engines transcribe after you stop. If streaming fails,
Chorus uploads the recording instead.

## Jev (fast decisions)

With an OpenRouter or TypeSafe API key, the conductor uses Jev, a fast decision model (~50 ms, typed
answers with calibrated confidence). Each decision is one request that asks many typed questions
at once.

### Routing

Commands the built-in grammar misses ("can you bring up the codecs agent", "tell Maple 2 to rerun
the tests with the verbose flag") go to Jev's router before Claude. One request (about 20–60
questions answered in parallel) reads:

- **Who it is for:** a command, an answer to Chorus's last question, a correction of the last
  action, talk with Chorus, cancel, or a speech-to-text artifact.
- **Each slot of the action:** the intent (focus, status, interrupt, close, reopen, send, start
  an agent, plan, and non-direct ones such as kill, archive, delivery, and layout), the target
  agent, the project, the provider, and how many new agents.
- **One joint pick** from up to 255 fully bound actions ("send_verbatim · Maple 2", "spawn ·
  Codex in Chorus"). Chorus acts only when this pick matches the one composed from the separate
  slots, so every request checks itself.
- **The message span:** where your own words for the agent begin and end, plus a per-sentence
  check that drops sentences meant for Chorus ("and focus it after").

Short conversation memory (last agent started, messaged, and reported; the last reply) lets
"it", "that agent", "the same project", and corrections resolve without Claude. For example,
"no, send that to Tango" re-sends the last message, and "I meant in Website" restarts the last
agent in the Website project.

What happens next:

| Reading | Result |
| --- | --- |
| Confident navigation (focus, status, reopen, overview, next) | Runs directly |
| Confident close or interrupt | Runs behind the usual cancel window |
| Confident send or start, with **Fast verbatim routing** on | Your words go to the agent unchanged, behind the countdown |
| Two similar live names split the vote ("Maple" or "Maple 2") | Chorus asks "Maple or Maple 2?"; answer "the first" or the name |
| Speech-to-text artifact ("I'm sorry, I can't hear any audio") | Dropped: "I didn't catch that." |
| Anything else | Claude handles it, with Jev's reading as hints; plan mode only when Jev expects several agents |

Thresholds come from **Jev confidence to act** (default 0.8): navigation acts at 0.1 below it,
close and interrupt at it, and sends and starts at 0.05 above it. Kill, archive, permission
answers, closing many windows, delivery, and composed messages ("write Delta a better prompt")
always go to Claude. Jev also refuses to act when more than 15% of its intent probability is on a
destructive action.

**Fast verbatim routing** (settings, on by default) is the switch for direct sends and starts.
Turn it off to send those through Claude.

### Completion reports

When agents finish, Jev reads their final reports before Claude does, in one request per batch:

- Progress notes with nothing new, and repeats of the last report, stay on the HUD.
- A clear result or question is spoken as the agent's own sentence ("Maple asks: Should I also
  update the docs?").
- Only reports that need interpretation get a Claude follow-up: terminal output, low confidence,
  or a follow-up you asked for ("open it when it's done").

This is part of **Completion follow-up**.

### Triage and plan review

- **Triage:** when an agent starts waiting, Jev rates how urgently it needs you (the "next" order)
  and how risky its permission request is (shown on the tile and in the confirmation).
- **Plan review:** plans whose parallel subtasks would likely edit the same code, or whose prompts
  are vague, go back to Claude to fix. Subtasks get a size and the plan a rough token estimate.

### Diagnostics

With diagnostic history on, every Jev evaluation is traced as a `jev` event. The event records the
purpose (`route`, `completion`, `triage`, `permission-risk`, `plan-review`), latency, cost, the
decision and its reason, and a compact form of each answer. The following summarizes fallback
reasons and lists the most uncertain decisions (good eval candidates):

```bash
node apps/emdash-desktop/tooling/chorus/jev-mine.mjs
```

The router's eval set is `docs/chorus/evals/jev-router.jsonl`. To run it against the live API,
set `JEV_LIVE_EVAL=1` and `TYPESAFE_API_KEY` or `OPENROUTER_API_KEY`, then run:

```bash
pnpm exec vitest run --project node src/core/features/conductor/node/jev-router-live-eval.test.ts
```

The eval fails on any wrong action and reports how many expected actions ran directly.

## OpenRouter

One OpenRouter key can run everything: turn on **Use OpenRouter for everything** in settings. The
conductor then uses an OpenRouter model with tool calling (default `anthropic/claude-opus-5`),
speech-to-text uses an audio-input model (default `google/gemini-3.5-flash-lite`), and Jev runs
through OpenRouter's System One API (`~typesafe/jev-latest`). No TypeSafe key is needed; Jev's
source can also be set to Auto or TypeSafe.

## Troubleshooting

- **"Windows is blocking microphone access for desktop apps"**: Windows Settings → Privacy & security → Microphone → turn on
  "Let desktop apps access your microphone". The HUD error has a button that opens that page.
- **Global shortcut does nothing**: another app owns it. Pick a different one in settings (the row
  says when registration failed).
- **Names are misheard**: rename agents to distinct words ("Frontend", "Tests"), or switch engines.
- **No spoken replies**: check the mute button in the HUD and "Speak replies" in settings; pick an
  installed Windows fallback voice or configure Gemini under "Spoken output".
