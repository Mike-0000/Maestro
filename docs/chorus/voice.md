# Voice and the conductor

Chorus lets you run your agents by voice. Speech becomes text (speech-to-text, STT), a fast
built-in grammar handles common commands, and anything else goes to the **conductor**, a Claude
model that can read, message, start, and plan across your agents.

## Talking

| Action | How |
| --- | --- |
| Hold to talk (command) | Hold **Right Ctrl**, speak, release |
| Hold to dictate into the focused agent | Hold **Shift + Right Ctrl** |
| Toggle listening from anywhere in Windows | **Ctrl + Alt + Space** (configurable) |
| Click to talk | The mic button in the floating HUD |
| Cancel while listening | **Esc** |
| Type instead of talking | The keyboard button in the HUD |
| Open the canvas | **Ctrl + Shift + A** |
| Jump to the agent that has waited longest | **Ctrl + Shift + J** |

Toggle mode stops by itself when you pause for about a second.

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
- "Yes" / "no" (confirm or cancel the pending action or plan)

Agent names are the spoken names on each tile ("Claude 1", "Codex 2"). Double-click a name to
rename it. Common mishearings ("clod two", "codecs") are corrected automatically.

Sending text or interrupting shows a 1.5-second countdown in the HUD; press **Esc** or say "no"
to cancel. Answering an agent's permission prompt always needs an explicit "yes".

## The conductor (Claude)

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

## Troubleshooting

- **"Windows is blocking microphone access for desktop apps"**: Windows Settings → Privacy & security → Microphone → turn on
  "Let desktop apps access your microphone". The HUD error has a button that opens that page.
- **Global shortcut does nothing**: another app owns it. Pick a different one in settings (the row
  says when registration failed).
- **Names are misheard**: rename agents to distinct words ("Frontend", "Tests"), or switch engines.
- **No spoken replies**: check the mute button in the HUD and "Speak replies" in settings; pick an
  installed Windows voice under "Voice".
