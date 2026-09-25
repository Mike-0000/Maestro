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
| "Reopen" / "bring it back" / "undo" | Reopens what you closed last |
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

Sending text, interrupting, or closing several windows shows a 1.5-second countdown in the HUD;
press **Esc** or say "no" to cancel. Answering a permission prompt, shutting down, and archiving
always need an explicit "yes" (or **Enter**). Enter only confirms when it is pressed outside a
terminal or text field, and not in the instant the action appears, so typing into an agent never
approves something by accident. For the same reason, Chorus refuses to type a message into a
terminal agent that is showing a permission prompt; say "allow" or "deny" instead.

## The conductor

Anything the grammar does not recognise goes to Claude, which can:

- read what agents are doing and summarise it,
- send clear instructions to one or more agents,
- start a new agent in a fresh git worktree (`spawn_agent`),
- **plan**: split a goal into 2–4 parallel agents, each owning distinct paths, with an acceptance
  command. You approve the plan in the HUD ("yes" or **Start**) before anything runs. Subtasks
  can run after one another, and a conflict radar (`git merge-tree`, read-only) warns when two
  branches would conflict.

Add an Anthropic API key in **Settings → Voice & Conductor**. The default model is
`claude-opus-5` with low effort for commands and high effort for plans; both are configurable,
and a daily token budget (3M by default) stops runaway spend. Every turn is logged to
`%APPDATA%\chorus\chorus\conductor-log.jsonl` (utterance, actions, reply, latency, tokens).

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

With an OpenRouter or TypeSafe API key, the conductor uses Jev, a fast decision model (~50 ms, typed answers
with calibrated confidence), for:

- **Routing:** commands the built-in grammar misses ("can you bring up the codex agent") are
  classified; confident navigation runs without calling Claude, and Jev decides whether a goal
  needs planning.
- **Triage:** when an agent starts waiting, Jev rates how urgently it needs you (the "next" order)
  and how risky its permission request is (shown on the tile and in the confirmation).
- **Plan review:** plans whose parallel subtasks would likely edit the same code, or whose prompts
  are vague, go back to Claude to fix; subtasks get a size and the plan a rough token estimate.

Jev only acts above the confidence you set (default 0.8); below it, Claude decides.

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
  installed Windows voice under "Voice".
