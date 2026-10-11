# Realtime voice for the conductor: feasibility

Should Maestro offer an OpenAI realtime model (speech in, speech out, one live session) as an option
for the conductor, and what would it improve?

Written 2026-10-10. No production code was changed. Paths that start with `conductor/` or `voice/`
are under `apps/emdash-desktop/src/core/features/`. Line numbers are from the working tree on that
day; the conductor files were being edited while this was written (the tool count went from 40 to
41), so treat them as approximate.

> **Superseded on 2026-10-10.** The developer's intent was the opposite of this note's
> recommendation: while the realtime line is on, its model is the conductor and calls the
> conductor's tools itself (shape A below), with the text model only as the fallback. The gates
> stayed in code, in `executeTool`. What is built is described in
> [the voice guide](../chorus/voice.md#the-realtime-voice-conductor-experimental); the seam is
> `conductor/api/voice-line.ts`.

## Recommendation

**Go with conditions.** Add it as an opt-in **talk mode**: a realtime model does the listening and
speaking, answers read-only questions itself, and hands every action to the existing conductor.
Do not replace the conductor's model with a realtime model.

The conditions, in order:

1. **Fix the current pipeline first** (section 7, about 2 to 3 days). Most of today's wait is not
   something a realtime model removes, and the fixed pipeline is the baseline it has to beat.
2. **A one-week spike must pass the gates in section 9** on this Windows machine. Every realtime
   latency figure in this note is published or third-party; none was measured here.
3. **A direct OpenAI API key.** OpenRouter does not carry realtime sessions, and the developer's
   current setup runs everything through OpenRouter.

The detailed design is in [talk mode](talk-mode.md). It supersedes sections 5 and 9 here where
they differ: the session is set up through the main process with no token in the renderer, calls
and pick-up are built on today's pipeline before the realtime line, and its estimates are larger
(about 4 to 5 weeks before the realtime spike, 11 to 13 weeks in all with code checks).

Estimated scope when this note was written: 2 to 3 days of fixes, about 1 week for the spike, then
3 to 4 weeks to ship the opt-in mode on desktop. Replacing the conductor's model outright would be 6 to 8 weeks plus a
tool-calling eval set, and is not recommended.

## 1. How the voice agent works today

The conductor only ever receives text and only ever produces text. Audio exists before
`handleUtterance` and after `setReply`; everything between is text.

| Stage | What happens | Where | Provider-specific? |
| --- | --- | --- | --- |
| Capture | Renderer. `getUserMedia` with echo cancellation, an AudioWorklet, downsampled to 16 kHz mono. Hold, toggle, or hands-free. One WAV is uploaded after release (up to 5 minutes); only Deepgram's live transcript streams while you speak. | `voice/browser/mic-recorder.ts`, `voice-store.ts` | No |
| Speech-to-text | Main process. `SttEngine.transcribe(request): Promise<string \| { text, confidence }>`, 20 s timeout, agent names passed as hints. Four engines. | `voice/node/engines/` | Engines yes. The interface is generic but assumes one utterance gives one string; streaming is wired to Deepgram only. |
| Routing | Renderer. Grammar, then the Jev router, then the model. All three read the transcript. | `handleUtterance`, `conductor/browser/conductor-store.ts:419` | No |
| Model call | Main process. Anthropic SDK or OpenRouter chat completions. One request per round trip, **not streamed**. | `runTurn`, `conductor/node/conductor-service.ts:141` | Yes. There is no provider interface: Anthropic message blocks are the internal format, and OpenRouter is a translation at the edge (`conductor/api/openrouter-format.ts`). |
| Tools | 41 tools, zod schemas converted to JSON Schema. Executed **in the renderer**, one at a time, up to 8 round trips. | `conductor/api/tools.ts`; `executeTool`, `conductor-store.ts:1587` | No |
| Context | A `<context>` block (time, agents, regions, recent activity) is rebuilt per utterance and prefixed to the user's text. History is 8 turns, in renderer memory, with old context blocks replaced by a placeholder. | `conductorUserMessage`, `conductor/api/system-prompt.ts`; `conductor/api/history.ts` | No |
| Events | A finished agent arrives as a synthetic user message that begins `[Maestro event, not the developer speaking]`, with the reply inside `<final-reply>` tags. That turn may use only 6 tools. | `conductor/api/completion-follow-up.ts` | No |
| Spoken reply | The reply is one string, available only after the whole tool loop ends. It goes to main for synthesis and comes back as 24 kHz PCM chunks. With no first audio after 3.5 s (8 s through OpenRouter, 12 s local), the Windows voice takes over. | `setReply`, `conductor-store.ts:3024`; `voice/browser/speech-output.ts` | Synthesis yes; playback no |
| Keys | Encrypted with Electron `safeStorage`, read only in main. The renderer sees presence flags. An `openai` slot already exists, used for transcription. | `core/primitives/chorus-host/` | No |
| Phone | The phone records, this computer transcribes, and the text enters the same `handleUtterance` as typed input. | `conductor/browser/remote-voice-bridge.ts` | No |

Three behaviours matter most for this study:

- **Safety gates are code, in the renderer, at or below `executeTool`.** Seven tools need an explicit
  yes, five run behind a 1.5-second countdown (`conductor/api/tools.ts:321`, `:332`), and the model has no tool
  that settles a pending action. A spoken "yes", "no" or "stop" is matched by the grammar **before
  any model sees it** (`conductor-store.ts:432-455`).
- **Interruption is by key only.** Starting to talk stops speech (`voice-store.ts:186`). In
  hands-free mode speech detection is switched off while the app is speaking
  (`voice-store.ts:310`), so you cannot interrupt by voice.
- **One turn at a time.** A command spoken during a turn waits in a single-slot queue, and a model
  call in flight cannot be cancelled (`runTurn` takes no abort signal).

## 2. What today's logs show

Source: the diagnostic history in `%APPDATA%\chorus\chorus\` for 2026-10-10, 18:36 to 20:23 UTC: 47
interactions, 9 completed voice commands, 20 logged turns. **This is one afternoon and one
configuration**: OpenRouter for everything, with `openai/gpt-audio-mini` for speech-to-text,
`anthropic/claude-haiku-5.5:nitro` at low effort as the conductor, Jev on, and Gemini 3.8
Flash-Lite through OpenRouter for speech.

### Latency

For the 6 voice commands that reached the model. Key release is estimated as the final-transcript
time minus the reported transcription time.

| Stage | Measured |
| --- | --- |
| Speaking | 5 to 95 s, median 21 s (all 9 commands) |
| Speech-to-text | 0.6 to 3.6 s, median 1.1 s; 3.4 to 3.6 s for the 45 s and 95 s recordings |
| Stall before routing | about 3.2 s in 3 of 6 turns, none in the other 3 (section 7, item 1) |
| Jev routing | 0.26 to 0.35 s; it passed all 6 to the model |
| Model, to its first tool call | 1.5 to 5.3 s, median 2.9 s |
| Countdown, by design | 1.5 s (5 of 6) |
| Tool result to reply text | 0.7 to 1.2 s, and 5.3 s once |
| **Key release to the action starting** | **2.6 to 12.3 s, median 6.1 s** |
| **Key release to reply text** | **5.0 to 15.0 s, median 9.6 s** |
| Reply text to first audio | Never observed. Two replies were sent to speech and both were cancelled, 3.1 s and 3.8 s later, with no audio started. |

The three commands the grammar handled needed about 1.1 s of transcription and then the countdown.

### How the voice was used

- Eight of the 9 commands were dictated briefs that ended by sending text to an agent (5) or
  starting one (3). One read an agent. None was a back-and-forth with the conductor.
- **Spoken replies were effectively off.** The other 7 replies were suppressed, which the code does
  only when muted or when speak-replies is off (`voice-store.ts:483`), and speak-replies is on. The
  likely reading is that the developer muted about two minutes in. This is inferred from the trace.
- 11 of the 17 model turns were completion follow-ups started by the app, not by speech. They took
  1.0 to 4.7 s (median 4.3 s).

### Cost and size

- The day's usage file: **2,298,232 input tokens, 12,702 output, 0 read from cache**, which is 77%
  of the 3M daily budget. At OpenRouter's list price for Haiku 5.5 ($0.10 and $0.50 per million;
  the `:nitro` route may differ) that is about $0.24.
- No request was smaller than 15,600 tokens, and requests grew to about 25,000 as history filled.
- The fixed part is the 41 tool definitions (24,000 characters of JSON) and the system prompt
  (9,400 characters), roughly 8,000 to 9,000 tokens. The rest is the context block and history.
- Nothing was cached because the OpenRouter path sends no `cache_control`
  (`conductor-service.ts:247-262`), and OpenRouter requires it for Anthropic models.

The wait is spread over five places. A speech-to-speech model removes two of them by construction
(transcription and the wait for first audio). The other three are the stall, the model's thinking
time, and the countdown.

## 3. What OpenAI offers now

Read on 2026-10-10. Prices, deprecation dates, and the GPT-Live delegation page were checked twice;
the rest comes from one research pass over OpenAI's documentation (links at the end).

| Topic | Fact |
| --- | --- |
| Models | `gpt-realtime-2.1` and `gpt-realtime-2.1-mini` (July 2026), reasoning models with tool use and a 128,000-token context. `gpt-realtime` and `gpt-realtime-mini` shut down on 2027-01-20. |
| Price per 1M tokens, 2.1 | Text in $4.00 (cached $0.40), text out $24.00, audio in $32.00 (cached $0.40), audio out $64.00 |
| Price per 1M tokens, 2.1-mini | Text in $0.60 (cached $0.06), text out $2.40, audio in $10.00 (cached $0.30), audio out $20.00 |
| Audio tokens | 1 per 100 ms heard, 1 per 50 ms spoken: about $0.019 per minute of your speech and $0.077 per minute of its speech on 2.1 |
| Billing shape | The whole conversation is billed again as input on every response, at cached rates when the prefix is unchanged |
| Transport | WebRTC is recommended for client apps, WebSocket for servers. A server mints a short-lived client secret (10 s to 2 h, default 10 min), so the real key stays out of the client. |
| Limits | 60 minutes per session. Instructions plus tools are limited to 16,384 tokens (from OpenAI's developer notes and community reports through September 2026; not in the current guides). |
| Tools | JSON Schema function tools. The call arrives as an event, the client returns a `function_call_output` item, then asks for the next response. |
| Turn-taking | Server voice detection, semantic voice detection, or off (push-to-talk with a manual commit). With WebRTC the server drops unplayed audio when the user interrupts. |
| Text | Text input, system-role items added mid-session, text-only output, and one-off responses that stay out of the conversation |
| Your transcript | Optional, produced by a separate model, asynchronous, and described as "guidance of input audio content rather than precisely what the model heard" |
| Latency | OpenAI gives 1.41 s turn-taking for 2.1. Third parties measured 0.82 s to first audio on the non-reasoning 1.5 and 2.33 s on 2 at high effort. |
| Tool accuracy | An OpenAI forum announcement reports 45.7% first-attempt task completion for Realtime 2.1 on the Tau3 benchmark against 83.6% for a voice layer backed by a frontier text model. I could not confirm the poster is staff. |

Two related facts:

- **GPT-Live** (`gpt-live-1`, 2026-09-10) is a separate API at $0.05 per session minute. Its
  "client delegation" mode has the voice model run the conversation and hand work to "any model,
  agent, or service your application operates". Results go back in appends of at most 500 tokens.
  The delegation event carries no task text, so the app derives the task from transcript events,
  and no push-to-talk is documented.
- **OpenRouter has no realtime endpoint** (none of its 458 listed models is one), and Anthropic has
  no speech-to-speech API. Google's Gemini Live is the closest alternative.

## 4. Three shapes

| | A. Realtime model is the conductor | B. Realtime voice in front of the conductor | C. Keep the pipeline, fix the waits |
| --- | --- | --- | --- |
| What speaks and listens | Realtime model | Realtime model | Today's engines |
| What decides and calls tools | Realtime model, all 41 tools | Realtime model for 5 or 6 read-only tools; Claude for everything else, through one `ask_conductor` tool | Claude |
| Gates | Must be re-proved for a new model and a new input path | Unchanged: actions still pass through `executeTool` | Unchanged |
| Dictated briefs | Model's paraphrase of what it heard | Unchanged (existing path) | Unchanged |
| Effort | 6 to 8 weeks plus evals | About 1 week to spike, 3 to 4 weeks to ship | 2 to 3 days |
| Verdict | No | **Yes, with conditions** | **Do first** |

A is rejected because it moves 41 tools, at least 12 of them gated, to a model family whose own vendor
reports much weaker task completion than a text model, in exchange for speed on work that is mostly
dictation.

In B, an action still costs a Claude turn, so **actions do not get faster**; the voice can only say
"on it" sooner. B's gain is in spoken questions and answers and in conversation flow.

## 5. What B would change

| Area | Change |
| --- | --- |
| Audio transport | The renderer opens an `RTCPeerConnection` to OpenAI with the existing microphone stream and plays the model's voice from the remote track. For this mode it replaces the Wire audio path (one base64 `pushAudio` call per 43 ms chunk in, `tts-chunk` out). Nothing in the app blocks it: the main window has no content security policy, and `main/host/media-permissions.ts` already grants audio-only capture. A main-process WebSocket is the alternative, but it needs header authentication (the app's only outbound socket passes its key as a subprotocol, `voice/node/engines/deepgram-stream.ts:102`) and app-side playback and truncation. |
| Session management | New. Open on the first talk-mode press, keep while the conversation is live, close after idle, reconnect at the 60-minute limit. `VoicePhase` has no duplex state today. The context block goes in as a system-role item per turn, not into the instructions, so the cached prefix stays stable. A server-held session cannot be rewritten the way `dropStaleContexts` rewrites history, so state accumulates until the session is recreated. |
| Tool mapping | Small. The schemas already convert to JSON Schema; Realtime wants a flat `{ type, name, description, parameters }`. Calls arrive on the data channel in the renderer, where `executeTool` already runs. `executeTool` is private but already has a second caller (the Jev path). |
| Interruption | Voice barge-in comes with WebRTC and semantic voice detection. Push-to-talk sends clear, cancel, clear on key down and commit on release. Stopping the voice does not stop the work: cancelling a conductor turn in flight needs new plumbing. |
| Confirmations | The hard part. The realtime model gets **no gated tool and no tool that settles a pending action**. Gated work goes through `ask_conductor`, so countdowns and confirmations still apply. A spoken yes or no is taken from the input transcript and passed through the existing grammar while something is pending; because that transcript is late and approximate, Enter, Esc and the buttons stay the reliable path. Completion follow-ups stay on the Claude path, and the realtime model is only given the sentence to say. |
| Keys | Main mints a client secret per session from the existing `openai` key through a new Wire procedure. This is the first time the renderer holds any provider token; it is short-lived and scoped to one session type. |
| Fallback | Keep `MicRecorder` recording alongside, so a WAV exists. If the session does not open in about 1.5 s, drops, or has no key, send the WAV down today's path. Deepgram's live transcript already falls back this way (`voice-store.ts:238-247`). |
| Also needed | A setting and its migration (an unknown enum value in `voice-settings.json` resets every setting on an older build), a spend limit in dollars (usage is three token counters today), new trace events, and HUD states. The phone stays on today's path: its page policy (`connect-src 'self' ws: wss:`) blocks the session setup call. |

## 6. Risks

| Risk | Detail |
| --- | --- |
| Tool-calling accuracy | Section 3. OpenAI also documents that instructions "are not guaranteed to be followed" and that the model may "pretend it completed the action". B limits the exposure to read-only tools and one delegate. |
| Prompt fidelity | Briefs of 50 words or more reach agents with the verbatim transcript attached. A realtime model has no verbatim transcript, only a separate approximate one. Dictation must stay on today's path. |
| Latency | Not measured here. 2.1 is a reasoning model, a tool call needs two responses, and delegating adds a Claude turn (1.5 to 5.3 s today). |
| Cost | Today's 2.3M input tokens would be $9.20 at 2.1's uncached text rate and $0.92 fully cached, against about $0.24 now. A spoken turn is roughly $0.03 to $0.15 on 2.1 and about a quarter of that on mini (my estimate). Small in absolute terms; 4 to 40 times today's. |
| Windows audio | Echo cancellation should cover the WebRTC remote track, but speakers, device changes and the global hold key are untested. One SDK issue reports dropped connections going unnoticed. |
| Agent names | Today names are passed as transcription hints and common mishearings are corrected in the grammar. A realtime model gets the roster as context only. Untested. |
| Prompt caching | Changing instructions or tools mid-session, or truncating, discards the cache from that point. |
| Context limits | Instructions plus tools must fit in 16,384 tokens. The full set is about 8,000 to 9,000; B's would be far smaller. |
| Untrusted text | Agent replies read aloud become model input. This is why gates must stay in code. |
| Privacy | Audio goes to OpenAI for as long as a session is open, not only while a key is held. |
| Churn | Three realtime generations in 2026, the beta interface removed in May, and the first general release retiring in January 2027. GPT-Live is one month old. |

## 7. Fix first, whatever is decided

1. **A 3-second stall before routing.** `installedProviders()` caches for 60 s
   (`conductor/browser/roster.ts:25`), and both `routerInput` (`conductor/browser/jev-router.ts:62`)
   and `runModel` (`conductor-store.ts:1451`) wait for it. The three stalled turns are exactly the
   ones that arrived more than 60 s after the last refresh. Serve the stale value and refresh in the
   background. Inferred from timing and code, not profiled.
2. **Replies are not streamed.** Speech starts only after the last round trip returns in full.
   Stream the final answer and speak it sentence by sentence.
3. **First audio is slow or absent.** Neither spoken reply produced audio within 3 s. Measure
   request-to-start per engine and compare direct Gemini and the local voice.
4. **No prompt caching through OpenRouter.** Send `cache_control`. About 8,000 to 9,000 tokens of
   every request are identical.
5. **Missing numbers.** Record key release to first audio, and model time per round trip.
6. **Deprecated models.** `gpt-4o-transcribe`, the default engine (`voice/node/engines/openai.ts:14`),
   shuts down on 2027-02-26. OpenAI also lists `gpt-audio-mini`, the developer's current
   transcription model, for 2027-01-20.

With items 1 to 3 done, a no-tool reply should start speaking about 3 to 4 s after key release
(my estimate: about 1 s of transcription, 1 to 2 s to the first sentence, under 1 s to audio).
A realtime model would have to beat that.

## 8. Benefit, and use cases

**Where realtime is better:** interrupting by voice; the first spoken word in 1 to 2 s where today
takes more than 8 s; several short turns without pressing a key each time; spoken progress while
work runs.

**Where today is already good enough, or better:** dictating a brief and dispatching it (8 of 9
commands in the log), where fidelity matters more than speed; grammar commands, which are instant
and free; completion announcements, which are one-way; planning, which needs a high-effort text
model; and cost.

One caution about the evidence: the log shows what the developer does with a voice that takes ten
seconds to answer and was muted. It cannot show whether conversation would be used if it worked.
The spike answers that.

| Use case | Needs realtime? |
| --- | --- |
| Hands-free status check with follow-ups ("what's everyone doing?", "and Atlas?") | Possible today with the wake phrase, one question at a time and slowly. Realtime makes it a conversation. |
| Interrupting a long reply mid-sentence by voice | Needs realtime. Today only a key press stops speech. |
| Quick clarification in one open exchange ("which Atlas?", "the one in Chorus") | Possible today, one key press per turn. Realtime removes the presses and most of the wait. |
| Talking a plan through before approving it | Possible today at 5 to 15 s per round. Realtime shortens the talk; Claude still writes the plan. |
| Spoken progress during a long action ("two of three agents are up") | Needs a live voice. Today the HUD shows one line of text. |
| Questions about a finished agent's report | Possible today as separate commands. Realtime keeps the thread. |
| Going through waiting agents and allowing or denying each | Possible today ("next", "allow Atlas", "yes"). Realtime adds flow only; confirmations stay in code. |
| Stopping the conductor's work, not just its voice | The voice half needs realtime. Cancelling a turn needs new plumbing either way. |
| Dictating a long brief to an agent | No. Today's path is better: the transcript is verbatim. |
| Instant commands ("focus Atlas", "show all") | No. The grammar is faster and free. |
| Talking to the conductor from the phone | Not in a first version. |

Top three: hands-free status checks with follow-ups, interrupting by voice, and quick
clarifications in one open exchange.

## 9. Scope

| Phase | Work | Estimate |
| --- | --- | --- |
| 0. Fixes | Section 7, items 1 to 5 | 2 to 3 days |
| 1. Spike | Behind a developer flag: a client-secret procedure in main, a WebRTC session in the renderer, push-to-talk and voice detection, 5 read-only tools plus `ask_conductor`, state as system items, trace events. No settings UI, no phone. Try GPT-Live's delegation mode for a day. | About 1 week |
| 2. Ship opt-in | Settings and migration, dollar limit, HUD states, fallback, diagnostics and redaction, tests, docs | 3 to 4 weeks |

Proposed gates after the spike, all measured on this machine:

- Key release to first audio under 1.5 s at the median for read-only answers, and at least 1.5 s
  better than the fixed pipeline. If not, stop: the pipeline is good enough.
- Voice interruption works on speakers, and the model does not interrupt itself, in 20 tries.
- Over about 50 recorded commands: no wrong action with side effects, and at least 90% delegated
  or answered correctly.
- Spend per hour of talk mode under a figure agreed beforehand.

The estimates are mine, for one developer working with agents. The change touches provider
credentials (a token reaches the renderer) and microphone handling. It does not touch the database,
PTY, SSH, or the updater.

## Not verified

- Nothing was run against the Realtime API. Latency and accuracy figures are published,
  third-party, or community reports.
- The 16,384-token limit and the Tau3 comparison are not in OpenAI's current guides.
- Token counts for the tools and system prompt are estimated from character counts.
- The mute and the provider stall are inferred from the trace and the code.

## Sources

- OpenAI: [pricing](https://developers.openai.com/api/docs/pricing),
  [deprecations](https://developers.openai.com/api/docs/deprecations),
  [models](https://developers.openai.com/api/docs/models),
  [WebRTC](https://developers.openai.com/api/docs/guides/voice-webrtc?api=realtime),
  [conversations](https://developers.openai.com/api/docs/guides/realtime-conversations),
  [function calling](https://developers.openai.com/api/docs/guides/realtime-function-calling),
  [latency and cost](https://developers.openai.com/api/docs/guides/voice-latency-cost?api=realtime),
  [transcription](https://developers.openai.com/api/docs/guides/realtime-transcription),
  [developer notes](https://developers.openai.com/blog/realtime-api),
  [GPT-Live delegation](https://developers.openai.com/api/docs/guides/live-delegation)
- OpenAI community: [16,384-token limit](https://community.openai.com/t/realtime-api-instruction-limit-16-384-tokens-is-too-low-for-production-voice-agents-with-tool-calling/1378932),
  [GPT-Live announcement](https://community.openai.com/t/introducing-gpt-live-1-in-the-api/1396471)
- Third party: [Artificial Analysis speech-to-speech index](https://artificialanalysis.ai/articles/announcing-the-artificial-analysis-speech-to-speech-index)
- OpenRouter: [prompt caching](https://openrouter.ai/docs/features/prompt-caching),
  [model list](https://openrouter.ai/api/v1/models)
- Earlier study of the conductor's structure: [conductor sub-agents](../conductor-subagent-feasibility.md)
