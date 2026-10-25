# Voice and the conductor

Chorus lets you run your agents by voice. Speech becomes text (speech-to-text, STT), a fast
built-in grammar handles common commands, and anything else goes to the **conductor**, a Claude
model that can read, message, start, and plan across your agents.

## Talking

| Action | How |
| --- | --- |
| Hold to talk (command) | Hold **Right Ctrl**, speak, release |
| Hold to dictate into the focused agent | Hold **Shift + Right Ctrl** |
| Keep listening without holding (command) | Tap **Right Ctrl** twice; tap once more to send |
| Dictate to the open agent, on this computer | Tap **Right Ctrl** once, or click the dictation button next to the mic; tap or click again to send |
| Hold to talk from anywhere in Windows | **Right Ctrl** or **Right Alt**, if enabled in settings (off by default) |
| Toggle listening from anywhere in Windows | **Ctrl + Alt + Space** (configurable); press again to send |
| Click to talk | The mic button in the floating HUD, then **Send** (or click the mic again) |
| Cancel while listening | **Esc**, or the × next to **Send** |
| Type instead of talking | The keyboard button in the HUD |
| Open the canvas | **Ctrl + Shift + A** |
| Jump to the agent that has waited longest | **Ctrl + Shift + J** |

Pausing never ends a recording: it runs until you release the hold key, press the toggle shortcut
again, or click **Send** (up to 5 minutes). Only hands-free listening stops on a pause. A toggled
recording that was left open closes on its own: after 90 seconds with no speech at all it is
dropped, and 90 seconds of quiet after you spoke sends what you said.

## Dictation to the open agent

The dictation button sits next to the mic button in the HUD and is separate from it. The mic
talks to the conductor; dictation goes straight to the agent that is open, in your words.

| Step | How |
| --- | --- |
| Start | Click the dictation button, or tap **Right Ctrl** once (or your global hold key) |
| Watch | Your words appear in the dictation panel as you speak, and correct themselves as the sentence takes shape |
| Send | Click **Send** or the button again, or tap the key again. The final text is sent to the open agent at once, with no cancel window |
| Drop it | **Esc** or **Discard** |

Transcription runs on this computer with NVIDIA's
[Parakeet Unified English 0.6B](https://huggingface.co/nvidia/parakeet-unified-en-0.6b) (English
only, with punctuation and capitals), through the same sherpa-onnx runtime as the offline voice.
No audio or text leaves the machine and no API key is used. The model is not in the installer: the
first time you start dictation the panel offers a one-time download of about 660 MB into the app
profile. Each file is checked against a pinned SHA-256 before it is used. Once loaded the model
holds about 700 MB of memory, and is released after ten minutes without dictation.

The model transcribes whole recordings, so live text is done by transcribing the phrase you are
saying again every quarter of a second (buffered streaming). A pause of about 0.7 seconds makes
that phrase final; a phrase with no pause is cut at its quietest moment after 20 seconds.

- A tap answers a call first: with a call on the line, one tap picks it up as before, and
  dictation starts on a tap only when no call is waiting to be picked up.
- If no agent is open, or the agent is at a permission prompt, nothing is sent: the words stay in
  the panel with the reason, and **Send** (or a tap) tries again.
- Dictation left open closes on its own: after two minutes with no speech at all it is dropped;
  two quiet minutes after you spoke stops it and holds your words for you to send or discard.
- The command microphone stays closed while dictation is listening, including hands-free.
- The two-tap and hold presses are unchanged. Inside Maestro the key now waits 0.4 seconds after
  a tap to see whether a second one follows, as the system-wide key already did.

It was run against the real model on Linux (words about every quarter second, final text about
0.1 seconds after stopping, on four CPU threads). It has not been run in the packaged Windows
app yet: the microphone path, the download inside Electron, and speed on a slower CPU are
unmeasured there.

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

Chorus skips the verbatim copy when the brief already contains your words. It never skips it when
the brief drops a negation, a number, a path, or a name.

Asking for one agent that uses sub-agents ("start an agent and have it spin up subagents") stays a
single-agent request. It does not become a plan.

Replies are short. Spawn and send acknowledgements are about 12 words. A confirmation says the
action plus a short preview: `Send to Zulu "run the tests again…"? Say yes.` After a code check, your
own explicit spawn or send into the same project no longer asks for confirmation (once per turn).

The conductor keeps up to 14 turns of history, then cuts it to 8, keeping your newest 4 turns. The
cut happens all at once so the start of each request stays the same between cuts. The conductor
also sends a per-run OpenRouter `session_id`, so providers that cache prompts automatically (for
example Mercury) can reuse them.

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

An agent with background work ends its turn many times per task. When a later turn adds nothing to
what you already heard about that agent in the last 30 minutes, the conductor shows "Zulu: finished
a turn with nothing new." on the HUD and says nothing. An agent's first report is always spoken. The
conductor offers only a step it can take when you say yes, and treats lines you typed into an
agent's terminal as yours, not as something to pass on.

You hear each completion once. If there is no reply, the follow-up is off, the conductor is busy with
your request, or the model call fails, you get the fixed sentence instead, which still names the
reported app URL. Turn it off with **Report what finished agents said** in Settings → Voice &
Conductor.

Reports are cut at a sentence end, never mid-word, and the HUD shows the full text.

Claude's idle reminder after a finished turn no longer announces the agent again, unless its reply
ended in a question.

#### Only what needs you

Say "don't notify me when things don't need my attention" (or "only tell me when an agent needs
me") and the conductor sets `announce_completions` to `attention_only`; "tell me about everything
again" sets it back to `all`. It is a setting, not a standing instruction, because whether a
finished agent is spoken and sounds is decided in Maestro, not in the conductor's reply. The switch
is also **Only tell me when an agent needs me** in Settings → Voice & Conductor.

With it on, a finished agent that the attention verdict found to need nothing from you shows on
the HUD only. It is not read out, and its notification sound, desktop notification and phone push
are dropped (it still appears in the notification feed). Agents waiting for you, at a permission
prompt, or ending on a question they cannot go on without arrive as attention notifications and are
announced and sound as before. The conductor can still call you for a finished agent: when Jev
finds its report asks a question or says it is stuck, or the follow-up turn finds something you
must decide or do, that report is spoken with the attention sound (under your notification sound
settings). A plain result, a progress note, or a follow-up turn that fails stays on the HUD.

It takes effect only while **Let the conductor decide who needs you** is on and the conductor has a
key, since those verdicts are what tell a finished agent from one that needs you. Until then every
finished agent is announced as before.

### Agent news queue

News from agents waits instead of cutting off a reply to you.

- It also waits while the mic is open, a confirmation is pending, or a plan awaits approval.
- It expires after 2 minutes, and at most 3 items wait.
- "Stop" clears the queue. "Hold my calls" holds it, except failures.
- A question from an agent counts as heard only once it is read out.

### Failures you hear

Chorus announces failures that used to be silent:

- an agent that did not start;
- "Codex didn't start; press Enter";
- a message left in an agent's input because you were typing there;
- a failed reply to an agent that left the canvas.

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

Newer trace fields cover speech reasons (suppressed, cancelled, fallback, engine), announcement
queue events, the model id of each model call, capture cancel causes, and delivery holds. The
conductor log also keeps request bodies, redacted and capped.

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

Routine message approvals and answers go to the HUD only. Spawns, denials, failures, and anything
about publishing, uploading, pushing, releasing, deleting, or paying are spoken. The decisions
themselves are unchanged.

### Messages while you type

Messages to an agent are held while you type in that agent's window, then sent one at a time.
Nothing is pasted over your text or onto a permission prompt. Your own sends go first.

### Looking things up before it writes a prompt

Off by default. Turn it on with **Let the conductor read project files** in Settings → Voice &
Conductor → Code checks. Once it is on, the conductor can look things up in a project before it
writes a prompt, a plan, or an answer, so a name you use for part of the project ("the desk
switcher", "the mirror") is placed before an agent is briefed. It decides for itself when a
request needs it, and you can ask outright: "check the code first", "look it up before you write
the prompt". Those words always reach the conductor's model, never the fast router, so it can
look before anything is started.

It has two ways to look:

| Lookup | What it does | Wait | Works on |
| --- | --- | --- | --- |
| **Find in project** | Where a name appears: the files whose path contains it, and the files that mention it most. Names and counts only, never file contents | Under a second | Every project: this computer, WSL, SSH |
| **Code check** | A read-only Claude Code process answers up to three questions ("what does the desk switcher do, and where?") with the files and lines it rests on | 10 to 20 seconds | Projects on this computer, and WSL projects made with **Run in WSL**, through their Windows copy |

A code check runs in a contained process: it cannot write or run commands, cannot read outside
the project (and the extra folders you add) or any secret file, and runs no project hooks. While
a check runs, a card shows what is being read, and Esc or "stop" cancels it. After a check,
everything the conductor does in that turn asks for an explicit yes, because the files it read
are not your words. A lookup by name reads no file contents, so it asks nothing extra.

Projects on network shares (UNC paths) are refused. A check is stopped if Claude Code starts
outside the project folder. After a check, your own explicit spawn or send into the same project
asks for no confirmation (once per turn).

**Extra folders.** By default a code check reads only the project (or the named agent's folder).
**Add folder…** under Code checks lets it also read other folders you choose, read-only: another
repository, a notes folder. A whole drive, your home folder, a folder that holds it, and hidden
or settings folders are refused, and secret files stay unreadable in extra folders too. The
self-test proves this on your computer when you turn checks on and after Claude Code updates.

For anything wider, such as searching the whole computer or running commands, start a normal
agent and watch it: "start a Claude agent to find where my old deploy scripts are". It works
under the permissions you set for that agent, in a window you can see and stop. See
[the design](../design/voice-prompt-grounding.md).

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
more than four times in a minute is shown, not spoken. A tap with no call on the line starts
[dictation to the open agent](#dictation-to-the-open-agent) instead. With no call on the line or waiting, "skip",
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

### The realtime voice conductor (experimental)

Off by default. Turn it on with **Use a realtime voice model as the conductor** in Settings →
Voice & Conductor → Realtime voice conductor. It needs an OpenAI API key (API keys, in the same
settings); OpenRouter does not carry realtime sessions.

While it is on, one realtime voice session (OpenAI's Realtime API, over WebRTC) takes the
conductor's place. The voice model hears you directly, answers aloud, and acts on your agents
with the conductor's own tools: it messages, starts, stops and reads agents, makes plans, and
arranges the canvas. It is not a voice in front of the text conductor; it is the conductor. A
small dot next to the microphone button shows it: green when open, with a ring while it hears
you, amber while connecting, red when it is wanted but not connected. The line is billed for every
minute it is open, so after a quiet spell (20 seconds by default, see below) it closes and
sleeps, shown as a hollow green ring. The next press of the talk key opens it again, and that
press goes to the line too: speak at once, and what you say while it connects (a second or two)
is kept and sent when it is open. The new session is told what the last few turns came to (what
you asked, what was done, what you were told), so "do that again" and follow-ups still work;
what it does not have is the conversation word for word. Say "go to sleep" (on its own, or with
a word around it, as in "okay, go to sleep now") to put it to sleep yourself: whatever it is
saying or doing stops, and it stays closed, even with the microphone open, until the next press.

What changes while it is on:

- **Speech goes straight to the model.** Hold the talk key, speak, let go. The model answers
  what it heard at once; there is no separate transcription step, no fast router, and no text
  model in between. Typed commands go to it too, and it answers those in text.
- **Follow-ups need no key.** After Maestro speaks, the microphone stays open for a few seconds
  (6 by default, 0 to turn this off), so you can answer its question or go on.
- **It can listen all the time.** With **Listen without the talk key** on, the microphone stays
  open and Maestro answers whatever you say to it. Use it with headphones or in a quiet room.
- **One voice.** Replies, calls and read-backs are spoken by the line. Consent prompts for an
  agent's permission still use the computer's own voice, which reads exactly what it is given.

What stays as it was:

- **Every gate.** The model's tool calls run through the same code as the text conductor's:
  the cancel window before a message is sent or an agent started, the explicit yes before
  stopping or archiving an agent or answering a permission prompt, and the rule that a bare
  "yes" to something an agent suggested asks first.
- **Your own words.** A long dictated brief still reaches the agent with your verbatim words
  attached. The model's tool call waits for the transcript of what you said before anything that
  changes something runs; reading and looking do not wait.
- **Exact commands.** Words that are read before they are answered (see below) still go through
  the grammar first, so "stop", "yes", "skip" and "later" do exactly what they did.
- **Dictation, the tap that answers a call, the wake phrase** use the recorder as before.

How turns are taken:

- With the key, the model answers the moment you let go. A press nobody spoke into is dropped.
- When something is in progress (a turn is running, an action waits for a yes or a stop, a call
  from an agent is on the line, a plan waits for approval), what you say is transcribed first
  and handled as words: it can confirm, cancel, answer the call, or wait its turn.
- Speech heard with no key is always transcribed first. Noise and Maestro's own voice coming
  back through the microphone are dropped before anything answers.
- While you hold the key, nothing of Maestro's plays. A turn that was working keeps working; its
  answer is shown instead of said. "Stop" ends the turn where it is.
- Muted, Maestro still listens and acts; its answers are shown instead of said.

What still uses the text conductor: turns Maestro starts by itself (an agent finished, an agent
sent a request) and every turn while the line is down, connecting, being replaced by a fresh
session, or over its daily limit. Those need an Anthropic or OpenRouter key, as before.

| Setting | What it does |
| --- | --- |
| Custom voice agent | An agent made in xAI's Voice Agent Builder, by its id (`agent_…`). The line connects to it (`?agent_id=`) instead of the voice model, and uses the agent's own model, voice and effort. Maestro still sends the conductor's instructions, its tools, hand-taken turns and its audio format, so the line acts as it does without one. Empty (the default) uses the voice model |
| Voice model | `grok-voice-3.0` (default, pinned) or `grok-voice-latest`. Not used while a custom voice agent is set |
| Voice | A built-in Grok voice. Not used while a custom voice agent is set |
| Custom voice | A voice id from xAI's Custom Voices API, such as a clone of your own voice; the line speaks in it instead of a built-in voice. Empty goes back to the default voice |
| Voice style | How the voice should sound, in your words (tone, pace, manner). It is added after the built-in rules, changes how Maestro speaks but not what it does or reports, and reaches the open line from its next answer |
| Web and X search | On by default. Gives the line xAI's built-in `web_search` and `x_search` tools, for news and facts from outside your projects. Each search is billed by xAI on top of the minutes |
| Listen without the talk key | Keeps the microphone open all the time. Off, Maestro hears you while you hold the key and for a moment after it speaks |
| Seconds the microphone stays open | The follow-up window after Maestro speaks; 0 means the microphone opens only with the talk key |
| Seconds of quiet before the line closes | 20 by default. Nothing said, played, held or worked on for this long closes the line, until the next press of the talk key. 0 keeps it open until xAI closes it after 15 minutes of quiet. Not used when Maestro listens without the key |
| Speak over the voice to stop it | Keeps the microphone open while the voice speaks. Use it with headphones, or if echo cancellation holds on your speakers. Off, the talk key stops the voice |
| Daily limit | In US dollars ($5 by default). The line is billed for every minute it is open, used or not. At the limit the line closes, the dot turns into a hollow red ring, and the text conductor takes over; it opens again by itself within half an hour of the next day (UTC) starting, or at once when the limit is raised |

Privacy and cost: while the line is open, what you say with the key held or the microphone open,
the state of your agents, and what the model reads (redacted like diagnostics) go to OpenAI. No
audio leaves outside a held key or an open microphone. Each turn is billed for the conversation
so far; the state is replaced rather than appended before each turn, and a long session is
replaced by a fresh one that starts from a short summary. The settings show today's spend.

What the line remembers: a request stays in the conversation as you said it only while it is
open (the model asked something, or only read and answered). Once a turn acts (starts or
messages an agent, moves the canvas), that exchange is replaced by one line per turn saying what
you asked, what was done, and what you were told. The text of a brief that was delivered is not
kept there, so it cannot leak into the next brief; "send that to Echo instead" still works from
the recent activity in the state.

The line has been built against OpenAI's documentation and tested with a stand-in for the
provider. It has not been run on a real session yet: the event names and fields, its latency,
how well the model calls about forty tools, and echo cancellation on speakers are all unmeasured.
See [the design](../design/talk-mode.md) for what to check.

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

A custom Gemini voice id is used only with the Google Cloud (Vertex) engines.

The same two models are also available **through OpenRouter**: choose **Gemini 3.8 Flash via
OpenRouter** (`google/gemini-3.8-flash-tts`) or **Gemini 3.8 Flash-Lite via OpenRouter**
(`google/gemini-3.8-flash-lite-tts`). They use the OpenRouter key that already runs the conductor,
STT, and Jev (or `OPENROUTER_API_KEY`), so no Google key is needed, and are billed to your
OpenRouter account. Chorus calls OpenRouter's OpenAI-compatible `POST /api/v1/audio/speech` with
`response_format: "pcm"` from the main process and plays the audio as it arrives, honouring any
`rate`/`channels` in the response's `Content-Type` (24 kHz mono by default). Reply text is sent to
OpenRouter and Google. Because OpenRouter may buffer audio before the first byte, Chorus waits up
to 8 seconds before falling back to the Windows voice.

All four Gemini engines speak in a prebuilt voice (Kore, Puck, Aoede, Zephyr) unless you paste a
**Custom Gemini voice** id, such as a `voice_…` id from Google AI Studio's voice design or a
`voicekey_…` replicated voice. When set, the id replaces the prebuilt voice for every Gemini
engine. Clear the field to go back to the prebuilt voice.

A voice made with voice design belongs to the Google Cloud project it was made in, so OpenRouter
and Gemini API keys cannot speak with it. For those voices choose **Gemini 3.8 Flash via Google
Cloud** or **Flash-Lite via Google Cloud**. They call Vertex AI
(`aiplatform.googleapis.com/v1beta1/projects/<project>/locations/global/.../:streamGenerateContent`)
with your gcloud application default credentials: run
`gcloud auth application-default login` once. Chorus reads only `authorized_user` credentials
(from `GOOGLE_APPLICATION_CREDENTIALS`, `CLOUDSDK_CONFIG`, or gcloud's default folder), exchanges
the refresh token for an access token in the main process, and caches it until shortly before it
expires. **Google Cloud project** picks the project that owns the voices; empty uses the sign-in's
quota project, then `GOOGLE_CLOUD_PROJECT`. Usage is billed to that project.

When cloud speech fails, the main log records `voice: speech synthesis failed` with the engine
and the error's status (never the reply text or a key) before Chorus uses the Windows voice.

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

### Transcribe on this computer (NVIDIA Parakeet)

**Settings → Voice & Conductor → Voice → Transcribe on this computer** is off by default. When it
is on, every voice command is transcribed by the same on-device Parakeet model that dictation uses,
whatever engine is chosen above, and the text goes straight to the conductor: no audio is sent to
a speech-to-text API, and the live Deepgram transcript is not used. The model is a one-time
download from the same row. If it is missing or fails, the command shows an error naming the cause;
voice never silently switches back to a cloud engine. Parakeet is English only and takes no
vocabulary hints.

Parakeet warms up when a capture starts. Long captures are transcribed in phrases while you record,
with a full-pass fallback. On local transcripts, misheard names are fixed ("Cloud Code" becomes
Claude Code).

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

For 10 seconds after the conductor answers a command, your next utterance runs without the wake
phrase, so "Chorus, switch to the chorus desk" can be followed by "now close the finished ones".
The 10 seconds start when the spoken reply ends. Only one utterance is taken this way: the one
after it needs the wake phrase again.

## Live transcript

With Deepgram and **Live transcript** on, audio streams while you speak and the words appear in
the HUD as they are recognized. Other engines transcribe after you stop. If streaming fails,
Chorus uploads the recording instead.

In the HUD, a typed line that ends in ":" waits 3 seconds for the rest of the message.

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

New work always lands in a project you named or meant. When Jev reads the project at **Jev
confidence to act** or above, that project is settled: a new agent or plan goes there even when
Claude takes the turn and leaves the project out or names another. "Here" and "this project" mean
the project on screen. When you named none and several projects are open, nothing starts and
nothing is guessed from focus: the conductor asks "Which project, Chorus or Website?" and starts
the agent as soon as you answer. With one project open, it just uses that one.

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
