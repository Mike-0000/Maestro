# Laptop log analysis (2026-11-12)

An analysis of the conductor logs the developer's laptop uploaded to the Supabase project
"Maestro-Logs", and the fixes made for the real bugs it found. Scope, as the developer set it
partway through: **the conductor-to-agent relationship** in the new conductor system. The old desk and canvas
features are left out; voice-only UX findings are recorded but were not fixed.

Method: three analysts read every laptop table in parallel with read-only SQL (aggregates, then
the rows behind every unusual pattern), checked each candidate against the code at
`chorus/main a12c6afdc`, and checked git history for later fixes. Every fix below started with a
unit test that failed on the unchanged code.

## 1. Data coverage

| Install | What it is | voice turns | interaction trace | chat-conductor calls | conductor threads |
|---|---|---|---|---|---|
| `fc7e3452…` | **laptop** | 1,140 (Oct 14 00:06 – Nov 12 23:14 UTC) | 7,004 (Oct 29 17:23 – Nov 12 23:44) | 318 (Nov 12 02:17 – 23:46) | 592 (Nov 10 23:53 – Nov 12 23:46) |
| `b9f2b0b2…` | desktop (this computer; its `remote-logs-state.json` holds this id) | 46 | 2,302 | 25 | 508 |

- The laptop uploaded everything in one batch on 2026-11-13 00:03 UTC. Every laptop row's
  `app_version` (`1.2.6-maestro.202611122356`) is the version **at upload time**, not the version
  that wrote the record. The `read_chat` output format shows the laptop ran a build from before
  `149a7c214` for most of Nov 12; only the last 8 chat-conductor calls (YOLO, from 23:25 UTC) came
  from a newer build. Every finding was therefore re-checked against current code.
- "Keep a voice history" is on for the laptop: the voice-turn log, the interaction trace and the
  chat-conductor call log are all written only when it is on, and all three hold laptop rows.
- Threads: 580 entry rows and 12 header rows (notes/status/autonomy) across 12 threads (2 chat,
  10 task).

What is missing, and why:

- **Older history.** Each local log is capped before upload (voice log 2 MB and the days setting;
  trace 2 MB, so it starts Oct 29; chat-conductor call log 4 MB, about 22 hours because each call
  holds a whole prompt; threads only as they are now). The upload feature is a day old, so
  everything older was dropped on the laptop before it could be sent. Expected.
- **Spoken commands routed to a chat conductor** write no voice-turn record and end the trace at
  `route` (42 of 43 such commands on Nov 11–12 have no traced outcome). A logging gap.
- **Not uploaded at all:** the main-process app log (model and text-to-speech error text), raw
  hook bodies, dictation activity, and cache-read tokens of chat-conductor calls.

## 2. Findings, ranked

Classes: **real bug**, **expected behaviour**, **user-environment issue**, **already fixed**.
"Fixed" names the branch and commit; "not fixed" says why.

### In scope: conductor ↔ agent

| # | Finding | Class | Status |
|---|---|---|---|
| 1 | Claude hook events reach Maestro with an empty body on Windows, and cmd.exe runs text from them | real bug (security) | fixed |
| 2 | `answer_prompt` can never succeed | real bug | fixed |
| 3 | Lines that are not input are labelled as the developer's words | real bug | fixed |
| 4 | A settled agent request is announced without the decision, cut mid-word | real bug | fixed |
| 5 | A model error after a successful tool call hides what was done | real bug | fixed |
| 6 | A failed completion follow-up speaks "X finished: <task name>" every time | real bug | fixed |
| 7 | OpenRouter 429s and network errors get no retry; the reason is dropped | real bug (trigger: provider) | fixed |
| 8 | A provider named only to rule it out starts that provider | real bug | fixed |
| 9 | Spawn waits 15 s to fail on a reconnecting project, and never waits for it | real bug | fixed |
| 10 | Agent request/report lines are long and read commands and URLs aloud | real bug | fixed |
| 11 | Completion fallback says "asks:" for statements and speaks tool status lines | real bug | fixed |
| 12 | Failed model calls carry no model name or error in the logs | real bug (diagnostics) | fixed |
| 13 | The conductor's model call is cut by the default 30 s Wire timeout | real bug (latent) | fixed |
| 14 | Chat-conductor call log lacks cache tokens; thread headers lack `yolo` | real bug (diagnostics) | fixed |
| 15 | Short or garbled terminal-tail stand-in reports make the conductor re-ask agents | consequence of 1 | fixed by 1 |
| 16 | The same agent event delivered twice (4 pairs, ~400k tokens) | consequence of 1 (likely) | fixed by 1 |
| 17 | Codex permission events read before the dialog is drawn | real bug, minor | fixed |
| 18 | One "Could not reach OpenRouter." chat-conductor call | user-environment issue | retry covered by 7 |
| 19 | Task conductor returned an empty reply after tools | already fixed (`e6dfe9dfa`, log-finder) | 0 laptop occurrences |
| 20 | `open_browser` refused `localhost:4100` twice | belongs to log-finder's dev-server branch | skipped |

#### 1. Claude hook events arrive empty on Windows, and cmd.exe runs text from them

- **Evidence.** 105 of 106 "finished" events from Claude agents reached the task conductors
  without the agent's reply ("Its provider reports no final reply"; the terminal tail stood in);
  102 of them were held decisions with `completionReport: null`. The desktop shows the same, 11 of
  12. Claude "waiting" events only ever arrived as `idle_prompt`, even with an approval dialog on
  screen (call `770c5b91…`, Nov 12 16:58:36). None of the 272 Claude stops in the desktop's app log
  reported background work. Confirmed live: the hook output inside a Claude Code session on this
  computer is the cmd.exe banner (`Microsoft Windows [Version …]`) followed by the hook's JSON
  echoed at a `C:\Github\chorus>` prompt.
- **Cause.** Claude Code runs hook commands through Git Bash on Windows. The default Windows
  launcher, `cmd.exe /d /c set …&&powershell.exe -EncodedCommand …`
  (`packages/core/src/services/agent-plugins/api/plugins/helpers/hooks.ts`), has its `/d /c`
  rewritten as paths by bash, so cmd.exe starts interactively and reads the event JSON from stdin
  as commands; bash then runs the PowerShell half with an empty stdin, which posts an empty body. A
  reply containing `Done" & echo X & echo "` ran `echo X`: text from a prompt or an agent's reply
  was executed. The diagnostic that should have shown it skipped empty bodies
  (`packages/core/src/runtimes/tui-agents/node/hooks/hook-pipeline.ts`).
- **Knock-on.** No final replies for the conductors (so finding 15 and probably 16), no
  `permission_prompt` notifications, no background-work or sub-agent tracking, no session-id
  tracking for Claude.
- **Fix** (`fix/laptop-logs-claude-hooks`, `3e6ad2fe4`): the `powershell` launcher Codex already
  used (`powershell.exe -NoProfile -ExecutionPolicy Bypass -EncodedCommand …`, markers inside the
  encoded script) is now the Windows default for every hook command; it runs the same under Git
  Bash, cmd.exe and PowerShell. Installed hooks migrate by themselves (old entries no longer match
  and are filtered by marker on rewrite). An empty stop body now logs the "no final reply"
  warning. Test: a hook run through Git Bash delivers its body byte for byte and never runs the
  `& echo` in it (failed before: empty body); a stop with no body logs the warning (failed
  before). **High-risk area** (provider hook commands); every provider test was re-run.

#### 2. `answer_prompt` can never succeed

- **Evidence.** All 4 task-conductor calls on Nov 12 failed with "The agent is not showing a
  permission prompt" (`770c5b91…` 16:58:36, `dd54fc35…` 19:47:59, `ddbbc5bb…` 19:48:18 retried,
  `0e65936c…` 21:12:35). A Supabase approval then expired unapproved and the developer clicked
  Accept by hand. The refusal misled the conductor: it told the developer the prompt "had already
  closed… someone else answered it, most likely you" (`19cd6b71…`).
- **Cause.** `answerPrompt` checks `showsPermissionPrompt`, built from
  `ConversationStore.lastNotificationType`, which production code never sets (only tests call
  `setAwaitingInput`; the `agent-status-changed` event has no notification type), and while main
  holds a decision for the task conductor it does not publish the new status.
- **Fix.** (`fix/laptop-logs-chat-conductor`, `5e6108cb7`): the session records the permission
  prompts it is deciding (forgotten as soon as main closes the hold) and `answerPrompt` presses the
  key for a held prompt; `agent-status-changed` now carries the notification type and the renderer
  stores it, which also lets the delivery lane hold a send while a prompt is on screen; the refusal
  now says it does not mean anyone answered. Tests: a held `permission_prompt` is answered though
  the chat still shows working; a closed hold is not; status keeps which prompt it stands for (all
  failed before).

#### 3. Lines that are not input are labelled as the developer's words

- **Evidence.** About 29 of 42 lines that task-conductor inputs labelled "[not from you: the
  developer's…]" were not developer input: Maestro's own launch brief (10), Codex's empty-input
  placeholder "Ask Codex to do anything" (5), an MCP Accept/Decline menu (4), numbered approval
  options (3), agent-to-agent messages (3), quoted `>` lines (2), the conductor's own mark wrapped
  by a narrow terminal (1), UI chrome (1). Two wrong statements followed: a Maestro-written brief
  called "the task brief the developer handed it" (`6aaa7524…`), and an approval justified with
  "it's the developer's own brief" (`dd54fc35…`).
- **Cause.** `INPUT_LINE` in `completion-follow-up.ts` treats any line after a prompt glyph as
  typed input; the Maestro-prefix check misses agent-to-agent messages and the launch brief; the
  conductor-mark check needs 40 characters.
- **Fix.** (`fix/laptop-logs-chat-conductor`, `1155d91d5`): numbered options, key hints
  (`(y)`, `(esc)`…), bare Accept/Decline/Cancel and known input placeholders are no longer input;
  agent-to-agent messages and the launch brief are labelled as Maestro's; the conductor's mark is
  known from 20 characters; for the chat conductor a plain `>` line is a quote. A real `› merge it`
  is still the developer's. Tests for each case (failed before).

#### 4. A settled agent request is announced without the decision

- **Evidence.** 30 laptop voice turns end "…I answered it." (Oct 26 – Nov 12), every one with the
  agent's question cut mid-word, and 3 more "…I approved it."; the desktop has 8 more. Example
  `5c82a2b3…` (Nov 12 22:52:51): "…one az run-comm… I answered it." The answer actually sent,
  "Yes, register the runner…", was never said. Also `80428fe4…`, `20c01838…`, `0fac025d…`.
- **Cause.** Since `ad2ea68c9` a request turn ends as soon as `answer_request` settles it, and the
  closing line (`settledSentence` in `conductor-store.ts`, and the request desk) is the agent's
  question plus a fixed verdict; the answer's message is never used, and the question is cut with
  `clip()` (mid-word) instead of `spokenClip()`.
- **Fix.** (`fix/laptop-logs-request-speech`, `9a1a761d8`): an answered request is announced as
  "Told Lima: <the answer>", cut between words at about 140 characters; approvals and denials keep
  their verdict. Test: says what it answered, not the clipped question (failed before).

#### 5. A model error after a successful tool call hides what was done

- **Evidence.** Nov 2 17:43 (`ffd9a2ab…`, trace `e1edf8b7`): `spawn_agent` succeeded and Delta's
  session started, then the next model call returned an API error. The developer heard only "The
  conductor hit an API error.", and the turn was left out of history, so repeating the request
  would start a second agent. "I stopped after several steps. Check the canvas." (`16695993…`)
  has the same gap.
- **Cause.** `conductor-store.ts` replaces the reply with the error regardless of actions already
  done.
- **Fix.** (`fix/laptop-logs-model-failures`, `047bb6284`): when the model fails after something
  changed, the reply starts with what was done ("Done so far: started Atlas. The conductor hit an
  API error."), and the finished steps stay in history so a retry knows the agent exists. Tests:
  started agent named before the error and remembered; several steps summarised (failed before).

#### 6. A failed completion follow-up speaks "X finished: <task name>" every time

- **Evidence.** Nov 2: "Atlas finished: Fill the Jar yesterday toggle." was spoken 4 times in 2
  hours (trace rows `01d2f02c…` 16:05, `8374c329…` 16:13, `69d6b63a…` 16:19, `b47e0eee…` 17:46).
  Jev had read three of those as progress with no news; Atlas had not finished, and the text is
  only the task name.
- **Cause.** On a failed follow-up the reply is empty, so it is neither "no news" nor quiet, and
  the "heard lately" quieting only covers the no-news branch, so the fixed sentence is spoken.
- **Fix.** (`fix/laptop-logs-model-failures`, `cca8faca5`): a failed follow-up with none of the
  agent's own words is quiet on the same terms as "no news"; a first report never heard is still
  spoken. Test: spoken 3 times before, once after.

#### 7. OpenRouter 429s and network errors get no retry

- **Evidence.** Nov 2 15:57–17:56: 12 of 29 conductor calls to mercury-3 failed with 429 in
  258–631 ms each. Completions fell back to fixed lines (finding 6), Bravo's request closed with "I
  could not decide it, so nothing was done" (`7658dc69…`), and the developer's question about the
  failures was itself rate limited (`4d667081…`). They stopped when the model was switched at
  18:00. One more chat-conductor call failed with "Could not reach OpenRouter." (`d4995dcd…`, Nov
  12 10:52, the laptop asleep or offline). The 429s themselves are the provider's (user
  environment); having no retry, and dropping the reason, is the bug.
- **Cause.** `primitives/chorus-host/node/openrouter.ts` throws on 429 and drops the error body;
  `conductor-service.ts` maps it straight to a failed turn. The Anthropic path at least retries
  once.
- **Fix.** (`fix/laptop-logs-model-failures`, `68a72396a`): one retry on 429/502/503 or a dropped
  connection, honouring Retry-After capped at 2 s; the upstream reason is kept and failed turns are
  logged. Four tests (failed before).

#### 8. A provider named only to rule it out starts that provider

- **Evidence.** Nov 12 21:12:13 (`9eb2d229…`): a spawn request that said Codex agents should not
  be needed started a Codex agent. Jev read `Codex (0.81)` and passed "Provider: Codex (81%)" to
  the model. The developer corrected it 23 s later ("This was supposed to be a cloud agent, not a
  codex agent").
- **Cause.** Jev's provider question asked which provider the words *name*, and `routerHints`
  passes any provider read at 0.6 or more. (The "cloud agent" vocabulary rule, `ac6b0f7b3`, came
  later and does not cover a negated provider.)
- **Fix** (`fix/laptop-logs-spawn`, `fc2deef43`): a negation (not, no, never, without,
  don't, shouldn't, should not, won't, can't, cannot) up to five words before the provider's name,
  in the same clause, drops the provider hint and stops Jev from starting that provider itself;
  the Jev question now asks which provider the words ask to use. Tests: the hint is dropped for
  three negated phrasings and kept for "No, start a codex agent"; Jev does not start a negated
  provider (both failed before).

#### 9. Spawn fails slowly on a reconnecting project

- **Evidence.** "This action requires live Project access." came back 15.1 s after the call on
  Oct 29 23:41 (`d920beac…`; the model retried 3 s later and it worked) and Nov 1 05:56
  (`e50c2099…`; the developer had to say "try again").
- **Cause.** `createTask` refuses at once when the project's host is not live, but `spawn.ts` then
  polled 15 s for a task that could not exist, and never waited for the host.
- **Fix** (`fix/laptop-logs-spawn`, `3e668989c`): wait up to 10 s for the project's host to
  be ready before creating the task; if it is still refused, fail at once with "The project is
  reconnecting…" instead of polling. Tests: waits for a reconnecting project; says it is
  reconnecting without the 15 s wait (both failed before).

#### 10. Agent request and report lines are long and read commands and URLs aloud

- **Evidence.** 56 spoken request/report lines average 246–280 characters (42 over 250) against
  107 for completion lines. `cd14fc92…` (Nov 8 04:55) read `gh secret set …` commands aloud;
  `0c865dbb…` (Nov 11 02:02) was 401 characters, cut mid-word; `eba57bff…` (Nov 11 02:37) read a
  full URL.
- **Cause.** `api/agent-requests.ts` clips with no cleanup for speech; the completion path already
  turns URLs into "a link".
- **Fix.** (`fix/laptop-logs-request-speech`, `d7802b1f0`): one shared `speakable()` turns URLs into
  "a link", commands into "a command" and long paths into "a path"; reports and questions to the
  conductor are spoken at about 160 characters, cut between words, and shown in full. Questions to
  the developer keep their text, because a spoken "yes" is matched against it. Tests (failed
  before).

#### 11. Completion fallback wording

- **Evidence.** "Iris asks: Nothing will be committed…" (`80267062…`) uses "asks:" for a
  statement; a Claude Code background-task line, `Agent "…" finished · 29m 41s`, was spoken as the
  agent's report twice (`32b8f2d7…`, `147b91a6…`).
- **Cause.** `api/jev-router/completion.ts` adds "asks:" to any picked sentence and does not drop
  tool status lines.
- **Fix.** (`fix/laptop-logs-request-speech`, `bbee0ff9c`): "asks:" only for a sentence ending
  in "?"; background-task status lines are dropped from reports. Tests (failed before).

#### 12. Failed model calls carry no model name or error

- **Evidence.** All 12 failed `model` trace rows have `model: null` and no error text; failed Jev
  rows (Nov 4 20:59, Nov 5 21:36, Nov 12 10:52) have no latency or error; the developer's own
  failed spoken turns are never flagged `modelFailed` in the voice log.
- **Fix.** (`fix/laptop-logs-model-failures`, `ff865bd12`): failed model rows carry the model and
  a redacted error (≤ 200 characters), a thrown call gets an `exception` row, failed Jev rows carry
  latency and error, and every failed turn sets `modelFailed` and `error`. Tests (failed before).

#### 13. The conductor's model call is cut by the default 30 s Wire timeout

- **Evidence.** 3 laptop turns on Oct 14 (22:02–22:21, e.g. `cf8c7852…`) stopped at exactly
  30,005 ms with no tokens. Nothing since Oct 29 took over 8.7 s, but a slower model makes it
  likely again.
- **Cause.** `runTurn` is called with no `timeoutMs`, so the Wire default of 30 s applies while
  the main process keeps the request running.
- **Fix.** (`fix/laptop-logs-model-failures`, `51a530f9b`): `runTurn` and `runChatTurn` pass a
  120 s timeout. Tests (failed before).

#### 14. Chat-conductor diagnostics gaps

- The call log records no cache-read tokens (calls run 32k–68k input tokens, about 11.35M in
  total, so caching cannot be judged), and uploaded thread headers omit the task conductor's
  `yolo` flag.
- **Fix.** (`fix/laptop-logs-chat-conductor`, `11960eb88`): optional `cacheReadTokens` per call and
  `yolo` on thread headers. Tests (failed before).

#### 15–20. Consequences, minor, environment, already fixed

- **15. Stand-in reports.** 4 of 6 sends on event turns asked an agent to repeat its report
  ("top of your report was cut off" `6b17292e…`, "came through garbled" `780b915c…`/`f2fedbce…`,
  "scrolled out of the history" `86ba7c0e…`). They were built from the terminal tail because of
  finding 1; the `read_chat` limit seen here was already raised by `149a7c214`/`03cd66f5f`.
- **16. Duplicate events.** 4 pairs of calls with identical input (8 of 318 calls, ~400k tokens),
  all but one answered NOTHING_NEW. Turns that only launched background work look finished
  without the hook body (finding 1).
- **17. Codex permission events before the dialog is drawn** (`33b465e9…`, `37299afb…`: screen
  shows "Working · Running hook"). Fixed (`fix/laptop-logs-chat-conductor`, `f6f021be7`): the
  conductor waits up to 3 s for Codex's approval dialog before reading a held prompt, says the
  dialog may not be drawn yet (not that it closed) if it never shows, and `answer_prompt` will not
  press Enter on a Codex agent with no dialog drawn. The dialog patterns are from Codex's known
  option wording and have not been seen against a live Codex screen.
- **18.** The one failed chat-conductor call (`d4995dcd…`) was the laptop offline; finding 7's
  retry covers a brief blip.
- **19.** The empty-final-reply bug fixed on log-finder's branch (`e6dfe9dfa`) has 0 laptop
  occurrences.
- **20.** `open_browser` refusing `localhost:4100` (`c9d8c183…`, `32daa966…`) is left to
  log-finder's dev-server detection branch.

### Out of scope (voice-only UX): recorded, not fixed

Findings about the old desk and canvas features are left out entirely, as the developer asked.

| Finding | Class | Evidence |
|---|---|---|
| Announcements play over a running dictation and can be dictated into it | real bug (voice) | Nov 3 00:41:32: a reply cut by a dictation start, then a queued announcement spoken 1 ms later; all 7 `stopped` cancels are dictation starts |
| A reply is spoken over an open command microphone | real bug (voice) | Nov 12 21:12:11–24 (capture `e6673b99`), then a HUD cancel and re-record; desktop once on Nov 11 |
| A long agent report is followed by a redundant "X finished…" | real bug, minor (voice) | Nov 3 00:45:46 Delta report, then `b788ce3d…` 28 s later |
| "Look before you write" prompt rule blocked an explicit "open an agent" | real bug, one-off (voice prompt) | `db53cff1…` Nov 3 17:34 |
| Slow jev turns (69–75 s) | main-process stall in `createTask` (38.7 s Oct 29; 97.8 s Nov 8) | `0a044fc7…`, `236c053f…`, `8fe325b8…`; the 30 s routing gap was fixed by `28aa1e07f` |
| Vertex text-to-speech failed for 3.5 days (184 fallbacks to the computer's voice) | user-environment issue (sign-in), with no warning in the app | Nov 2 04:55 – Nov 5 17:53, every utterance failing in ~200 ms |
| Trace journal rewrites the whole file on every event | performance, low | `diagnostics.ts` loads and rewrites up to 2 MB per event |
| 26 "X needs you" announcements dropped as stale | expected behaviour | queued 599 = told 573 + dropped 26; each dropped after the agent's state changed |
| 18 HUD cancels (11 with speech heard) | expected behaviour | 13 of 18 followed within 1–2 s by a full re-recording; the one exception is the open-mic reply above |
| Mute used as "stop talking", stays on until restart | expected behaviour (UX note) | 8 mutes, 0 unmutes; 157 sentences suppressed |

### Checked and fine

- Speech accounting balances: 431 requested = 431 started = 416 ended + 15 cancelled.
- Every queued announcement was resolved; deferred follow-ups resumed within 4 s.
- Jev: p50 0.25–0.47 s, about $0.13 in total; local speech-to-text p50 161 ms, no failures.
- Chat and task conductors: no `max_tokens` stops, refusals, loops or unparsed tool inputs; history
  stays bounded (about 40k growing to 68k tokens, then trimmed); notes stay at or under 3,100 of
  8,000 characters; no NOTHING_NEW text leaked into a thread; with autonomy off (29 calls) no
  action was taken on events; all 13 "the developer said/approved…" messages to agents match what
  the developer said; YOLO mode (8 calls) behaved; no duplicate thread entries.
- Already fixed since the records were written: provider "Claude" rejected as unknown and an
  orphaned agent after a `createTask` timeout (Oct 15, fixed by `e6080d412`); the 30 s routing
  delay from re-probing installed CLIs (Oct 29, fixed by `28aa1e07f`).

## 3. Branches and checks

All branches start from `chorus/main a12c6afdc` and are merged into
`fix/laptop-logs-conductor`, which was pushed.

| Branch | Commits | Findings |
|---|---|---|
| `fix/laptop-logs-claude-hooks` | `3e6ad2fe4` | 1 (and 15, 16) |
| `fix/laptop-logs-spawn` | `fc2deef43`, `3e668989c` | 8, 9 |
| `fix/laptop-logs-request-speech` | `9a1a761d8`, `d7802b1f0`, `bbee0ff9c` | 4, 10, 11 |
| `fix/laptop-logs-model-failures` | `68a72396a`, `cca8faca5`, `51a530f9b`, `047bb6284`, `ff865bd12` | 5, 6, 7, 12, 13 |
| `fix/laptop-logs-chat-conductor` | `5e6108cb7`, `1155d91d5`, `11960eb88`, `f6f021be7` | 2, 3, 14, 17 |

Checks on the merged branch: desktop node tests for conductor, conversations, tasks and main
(2,635 passed; the 13 failures fail identically on clean `chorus/main`: Windows symlink/folder
checks, boot and user-env tests); `packages/core` hook and agent-plugin tests (all pass);
`packages/plugins` (454 passed; the 6 failures fail identically on clean `chorus/main`); `tsgo`
for the browser and node projects (clean); `oxfmt` and `oxlint` on every changed file (clean).
The push script then ran format, lint, typecheck and the delivery tests again.

Not merged here: log-finder's `fix/chat-conductor-empty-final-reply` (`e6dfe9dfa`) merges
cleanly with these changes; `fix/detect-agent-started-dev-servers` was not touched.
