# Conductor sub-agents: feasibility study

Can the Maestro conductor run a coding agent (Claude Code, Pi, or another installed CLI) as its
own sub-agent, to investigate a repository before it proposes a plan or starts agents?

Written 2026-10-08. No code was changed. Paths that start with `conductor/` or `voice/` are under
`apps/emdash-desktop/src/core/features/`.

**Correction.** Later probes, made for the
[implementation plan](conductor-subagent-plan.md), showed that `--safe-mode` does not make a
scout safe. It keeps the user's permission settings, and on this machine the scout then read a
file outside the project. Plain `claude -p` also runs a project's own hooks with no trust prompt.
The flag to use is `--restricted`. The recommendation and the risk table below are updated; the
measurements in section 3 were taken with `--safe-mode` and are left as they were run.

## Verdict

**Feasible, and worth a small prototype.** Every installed agent CLI has a non-interactive mode,
and four of them answered a real planning question about this repository correctly in 9 to 24
seconds, read-only, for between $0.003 and $0.04 (section 3).

The recommended first step is one new conductor tool, `investigate`, that runs a **headless,
read-only, time-capped** agent process from the main process and hands back a short answer. This
document calls that agent a **scout**. It needs no task, no worktree, and no tile.

The three things that decide whether it is worth keeping:

1. **Does it improve plans?** The conductor plans today from a 6,000-character sketch of the
   repository. A scout lets it check the one assumption a plan depends on.
2. **Is the added wait acceptable by voice?** A scout adds roughly 10 to 25 seconds to a turn, and
   the conductor cannot take another command while a turn runs.
3. **Can read-only be enforced the same way for each CLI?** It cannot. It is strong for Claude Code
   and Pi, and weaker or untested for the others.

## 1. How the conductor works today

### Voice in

| Step | Where |
| --- | --- |
| Capture (hold, toggle, hands-free, live Deepgram stream) | `voice/browser/voice-store.ts`, `voice/browser/push-to-talk.ts`, `voice/browser/mic-recorder.ts` |
| Speech-to-text in the main process | `voice/node/voice-service.ts:256`, engines in `voice/node/engines/` (OpenAI, Deepgram, local whisper.cpp, OpenRouter) |
| Hand-off to the conductor | `ConductorStore.activate` registers a transcript handler (`conductor/browser/conductor-store.ts:301-307`): dictation goes to `dictate()`, everything else to `handleUtterance()` |
| Typed input | The HUD command box calls `handleUtterance(text, 'typed')` (`conductor/browser/hud/conductor-hud.tsx:401`) |
| Phone | `runRemoteConductorCommand` calls the same `handleUtterance` (`conductor/browser/remote-voice-bridge.ts:61`) |

The conductor only ever sees text. Voice, typing, and the phone share one entry point.

### Routing

`handleUtterance` (`conductor-store.ts:419`) tries three routes in order:

1. **Grammar**: `parseCommand` handles the common commands with no model call
   (`conductor/api/grammar.ts`).
2. **Jev**: a fast decision model binds the action and runs confident ones directly
   (`routeWithJev`, `conductor-store.ts:1155`).
3. **The model**: `runModel` (`conductor-store.ts:1425`) for everything else.

`chooseMode` (`conductor/api/grammar.ts:377`) picks **plan** mode when the words suggest several
agents ("split", "in parallel") or a build verb with eight or more words. Otherwise the turn is a
**command**. Jev can also choose the mode.

### The model loop

The loop is split across the two processes:

- **Main process**: `ConductorService.runTurn` (`conductor/node/conductor-service.ts:141`) makes
  one model call per round trip, through the Anthropic API or OpenRouter. It holds the API key,
  the system prompt, and the tool definitions, and enforces the daily token budget (`:158-168`).
- **Renderer**: `modelLoop` (`conductor-store.ts:1485`) runs the round trips and executes every
  tool against the live canvas and task stores (`executeTool` at `:1585`, `runTool` at `:1619`).

Limits that matter for this study:

| Limit | Value | Where |
| --- | --- | --- |
| Model round trips per utterance | 8 | `MAX_TOOL_ITERATIONS`, `conductor-store.ts:168` |
| Output tokens per round trip | 4,096 (command), 16,000 (plan) | `conductor-service.ts:178` |
| Effort | low (command), high (plan) | `conductor/api/contract.ts:65-66` |
| History kept | 8 turns, past state blocks dropped | `conductor/api/history.ts:4` |
| Daily token budget | 3,000,000, conductor calls only | `contract.ts:70` |
| Default model | `claude-opus-5` | `contract.ts:62` |

Two behaviours shape the design:

- **One turn at a time.** While a turn runs, a new utterance is queued, and only the newest queued
  one is kept (`conductor-store.ts:457-468`). This includes fast commands such as "focus Atlas".
- **Replies are spoken at the end.** During a turn the only progress the user sees is one line of
  text in the HUD (`conductor.activity`, `conductor-hud.tsx:278`).

### Tools

There are 40 tools, defined in `conductor/api/tools.ts:26-205`. The order is fixed so the tool
list stays identical for prompt caching, which means new tools are appended at the end.

| Group | Tools |
| --- | --- |
| See agents | `list_agents`, `read_agent`, `agent_details`, `recent_activity`, `find_conversations` |
| Talk to agents | `send_to_agent`, `interrupt_agent`, `answer_permission` |
| Start and end agents | `spawn_agent`, `propose_plan`, `stop_agent`, `archive_agent` |
| Windows | `focus_agent`, `show_all`, `close_agent`, `reopen_agent`, `rename_agent`, `filter_canvas` |
| Canvas layout | `describe_canvas`, `arrange_canvas`, `canvas_view`, `add_note` |
| App browser | `start_app`, `show_app`, `look_at_app`, `use_app`, `stop_app`, `close_app` |
| Git | `check_conflicts` (read-only `git merge-tree`) |
| Delivery | `delivery_status`, `enable_delivery`, and eight more delivery tools |
| Other | `read_clipboard` |

Side effects are gated in the renderer, not by the model. Seven tools need an explicit yes
(`CONFIRM_REQUIRED_TOOLS`, `tools.ts:307`) and five run behind a 1.5-second cancel countdown
(`CANCEL_WINDOW_TOOLS`, `tools.ts:318`).

### How it talks to agents

| Direction | Mechanism | Where |
| --- | --- | --- |
| Conductor to agent | Bracketed paste plus Enter into the terminal, or `sendPrompt` for chat (ACP) agents | `sendToAgent`, `conductor/browser/agent-io.ts:21` |
| Agent to conductor, on request | Last lines of the terminal, or the chat transcript, capped at 6,000 characters | `readAgentOutput`, `agent-io.ts:94` |
| Agent to conductor, on finish | The agent's final reply, redacted and capped at 4,000 characters | `captureReport`, `conductor-store.ts:2569`; `apps/emdash-desktop/src/core/primitives/agents/api/completion-report.ts` |
| Starting an agent | Creates a task and a terminal conversation, then starts the CLI | `spawnAgentTask`, `conductor/browser/spawn.ts:90` |
| Starting a plan | One worktree and branch per subtask, after the user approves | `PlanStore.approve`, `conductor/browser/plan-store.ts:201` |

A finished agent gets one short follow-up turn that can only read state and open a local app
(`COMPLETION_FOLLOW_UP_TOOLS`, `conductor/api/completion-follow-up.ts:15`). The renderer refuses
every other tool in that turn, because the agent's reply is untrusted.

### What the conductor knows about the code

Almost nothing. It has **no tool that reads a file, searches a repository, or runs a command**.

In plan mode only, and for local projects only, it receives a "context pack"
(`projectContextPack`, `conductor-store.ts:2956`; built by `readProjectContext`,
`conductor/node/project-context.ts:118`):

- the directory tree to depth 2,
- `package.json` scripts,
- the first 40 lines of the README,
- the directories changed most in the last 30 commits.

The pack is cut at 6,000 characters. Nothing checks that a plan's `owned_paths` exist: `propose`
checks only that they do not overlap (`plan-store.ts:170`).

This is the gap a scout fills. Today the conductor chooses file ownership and acceptance commands
for every subtask (4 per plan by default, 12 at most) from a sketch.

## 2. How a coding agent could run on the conductor's behalf

There are three ways to do it. They suit different jobs and are not exclusive.

| | A. Headless process | B. Agent tile (today's path) | C. Headless chat (ACP) session |
| --- | --- | --- | --- |
| What runs | The CLI's print mode, started by the main process | A normal terminal agent in a task | A chat session started with the ACP runtime's `launch` |
| Exists today | No | Yes (`spawn_agent`) | Partly: `launch` is the documented headless verb and automations use it |
| Task, worktree, DB row | None | Task and conversation rows | None required, but see the side effects below |
| On the canvas | Only what we choose to show | A tile, which can be hidden | Only what we choose to show |
| Read-only | CLI flags (strong for some CLIs) | Not today: full tool access | Provider modes (`plan`, `read-only`) |
| Result | Final message on stdout, as JSON | Final reply after the turn ends | Final reply from the transcript |
| In the same turn | Yes | No | Possible |
| Typical wait | 9 to 24 s measured | Startup plus the run; minutes | Not measured |
| Remote (SSH) projects | No | Yes | Likely, through the same runtime |

### A. Headless process (recommended for the prototype)

A new main-process function starts the CLI in the project directory with read-only flags, closed
standard input, a timeout, and a spend cap. It parses the final message and returns it over a new
Wire procedure, the same way `projectContext` and `checkConflicts` already work.

The building blocks exist:

- **Process**: `createBoundExec` (`packages/core/src/services/exec/api/bound-exec.ts:30`) takes a
  working directory, an environment, a timeout, and an abort signal. A timeout ends the whole
  process tree. Windows `.cmd` shims, which Pi and Cursor's agent use, are handled in
  `packages/core/src/primitives/exec/node/executable-launch.ts`.
- **Finding the CLI**: the host-dependency resolver returns the installed path and honours the
  user's override.
- **Environment**: `buildAllowlistedAgentEnv`
  (`packages/core/src/primitives/agent-env/api/index.ts:180`) passes only `PATH`, home, and the
  known provider variables.
- **Precedent**: the auth probe already runs `claude auth status` and `codex login status` this
  way (`packages/plugins/src/agents/helpers/auth.ts:15`).

One piece is missing. The conductor's main-process service receives only `ChorusHostServices`
(secrets, a data directory, shortcuts). It would need one new narrow port for "run this provider's
CLI", injected where the controller is created (`src/core/manifests/node/controllers.ts:497`).

No provider plugin models a print mode today. The capability list has no field for headless,
read-only, or JSON output, so the scout's flags would live in the conductor slice at first.

### B. Agent tile

This already works as two manual steps: start an agent with "investigate X and report", then hear
its reply when it finishes. Three things stop it from closing the loop:

1. **The turn ends at spawn.** The answer arrives later, in a follow-up turn that is fenced to
   read-only tools, so the conductor cannot then call `propose_plan`.
2. **The agent is not read-only.** `spawn_agent` starts an interactive terminal agent in the
   project directory with `autoApprove: false` (`spawn.ts:129-130`). It can ask for permissions
   and it can edit files.
3. **Only Claude Code reports a clean final reply.** Its Stop hook carries
   `last_assistant_message`. Codex, Pi, and Oh My Pi send no reply text, so the conductor reads
   the last 2,000 characters of the terminal instead. Cursor and Autohand declare no completion
   hook at all.

A tile is still the right shape when the work needs a shell, write access, or minutes of run
time, and when the user wants to watch. Bug reproduction is the main case.

### C. Headless chat session

`launch` starts a session for any conversation id without a database row
(`packages/core/src/runtimes/acp/node/runtime/session-manager.ts:219-243`). Streaming state, the
final reply, cancelling, and disposal all have calls (`packages/core/src/runtimes/acp/api/contract.ts`).
Claude Code, Codex, Oh My Pi, Devin, and Cursor support ACP. Pi and Autohand do not.

It costs more to do safely:

- `launch` is not on the renderer-facing contract, so this is new main-process code.
- A session with no row still appears in `sessions.list`, which the status bridge, automation
  delivery, and workspace session clean-up all read. Its intent is saved and restored at the next
  start unless `terminate` is called.
- The runtime has no auto-deny policy. A permission request waits until our code answers it.
- The client advertises `writeTextFile: true` for every session
  (`packages/core/src/runtimes/acp/node/connection/acp-agent-connection.ts:162`), so read-only
  depends on the provider's own mode.
- The adapter process is pooled by provider, directory, and environment, so a scout would share
  one with visible sessions in the same project.

The automations runtime is the nearest existing feature: its runs are tasks of type
`automation-run`, which the canvas and sidebar leave out. It is not a fit as it stands. It waits by
polling every 5 seconds with a 2-minute startup grace, and its unattended mode for Claude Code is
`bypassPermissions` (`automations/node/deployment-builder.ts:228`, under the same features
directory), the opposite of read-only.

### How the output comes back

The scout's answer should be treated exactly like a finished agent's reply:

- **Final message only.** Never the transcript, reasoning, or tool output.
- **Bounded and redacted.** `buildCompletionReport` already redacts keys and URL credentials and
  keeps the head and tail of a long reply within 4,000 characters.
- **Fenced as data.** The completion turn wraps replies in a labelled block and states that they
  are information, never instructions or the user's consent
  (`completion-follow-up.ts:47-72`). The same wording applies.
- **Optionally structured.** Claude Code (`--json-schema`), Codex (`--output-schema`), and Autohand
  (`--output-schema`) can return an answer that matches a schema, for example an answer, the files
  it rests on, and a confidence. That gives the plan panel something to show as evidence.

### Long-running and interactive runs

- **Short runs block the turn.** This is acceptable up to about a minute if the HUD shows what is
  happening and the user can cancel. A cancel path for a running investigation does not exist yet:
  "stop" during a turn is queued like any other utterance.
- **Long runs should not block.** They would return immediately and deliver the answer later as a
  Maestro event, the way completions already arrive. That re-entry turn would need `propose_plan`
  on its allowlist. This is safe in one respect: a plan still needs the user's approval.
- **Interactive runs are out of scope for a scout.** A print-mode process cannot ask anything.
  Claude Code's `--permission-prompts none` denies whatever would have prompted. If a scout needs
  a question answered, the question is its answer, and the conductor asks the user.
- **Follow-up questions** are possible later by resuming the scout's session (`claude --resume`,
  `codex exec resume`, `pi --session`). The prototype should run each scout without saving a
  session.

## 3. Options compared

All seven CLIs are installed on this machine. The flags below are from each CLI's own `--help`.

| CLI | Non-interactive | Read-only control | Output | Caps | In Maestro today |
| --- | --- | --- | --- | --- | --- |
| **Claude Code** 2.1.295 | `claude -p` | `--tools "Read,Grep,Glob"` removes every other built-in tool; `--permission-prompts none` denies anything that would prompt; `--permission-mode plan` | `--output-format json` or `stream-json`; `--json-schema` | `--max-budget-usd`; `--no-session-persistence` | ACP; Stop hook carries the final reply |
| **Pi** 0.87.1 | `pi -p` | `--tools read,grep,find,ls` (the help calls this read-only mode) | `--mode json` or `rpc` | `--no-session`; no spend or time cap | Terminal only; hook sends no reply text |
| **Oh My Pi** 18.3.4 | `omp -p` | `--tools read,grep`; `--approval-mode` | `--mode json`, `rpc`, `rpc-ui` | `--max-time`; `--no-session` | ACP (`omp acp`); hook sends no reply text |
| **Codex** 0.156.1 | `codex exec` | `--sandbox read-only` (it keeps a shell for reading) | `--json`; `-o` writes the last message to a file; `--output-schema` | `--ephemeral`; no spend cap | ACP with a `read-only` mode; hook sends no reply text |
| **Cursor agent** | `cursor-agent -p` | `--mode ask` or `--mode plan`. Without one, print mode "has access to all tools, including write and shell" | `--output-format json` or `stream-json` | None listed | ACP; no completion hook |
| **Devin** 3000.11.3 | `devin -p` | `--permission-mode auto` approves read-only tools. `--sandbox` is macOS and Linux only | Text; `--export` writes the conversation | None listed | ACP; Stop hook forwards its payload |
| **Autohand Code** 0.9.8 | `autohand -p` | `--restricted`, `--plan`, `--allowed-tools`, `--dry-run` | `--output-format stream-json`; `--output-schema` | `--max-cost`, `--max-duration`, `--max-tokens`; `--ephemeral` | Terminal only; no completion hook |

### Measured: one real planning question

Each CLI was asked, read-only, in this repository: *"Does the Maestro conductor already have a
tool that lets it read project files or run shell commands in a project? Answer in at most three
sentences and name the file that defines the conductor's tools."*

| CLI | Model it used | Wall time | Steps | Cost it reported | Correct |
| --- | --- | --- | --- | --- | --- |
| Claude Code (`--model sonnet`) | `claude-sonnet-5-5` | 8.7 s | 5 turns | $0.041 | Yes |
| Claude Code (`--model haiku`) | `claude-haiku-5-5` | 12.6 s | 4 turns | $0.003 | Yes |
| Oh My Pi | `cursor/cursor-grok-4.6-fast` | 19.1 s | 15 tool calls | $0 reported | Yes |
| Pi | `openai-codex/gpt-6-sol` | 21.3 s | 4 tool calls | $0.036 | Yes |
| Codex | `gpt-6-sol`, high effort | 23.6 s | 3 shell commands | Tokens only: 114,426 input (80,256 cached), 439 output | Yes |
| Autohand Code | none | Killed at 170 s | none | none | No answer: it was not signed in |
| Devin, Cursor agent | not run | | | | |

This is one question and one run each, so it shows the rough size of the wait and cost, not a
ranking. Devin and Cursor's agent were not run because neither has a flag to skip saving the
session, and a run would have left an entry in the user's history.

What the runs showed beyond the numbers:

- **Process start is not the problem.** Claude Code's wall time was about 1.1 seconds more than the
  run time it reported. `docs/chorus/PLAN.md` (spike S5) expected a headless `claude -p` to be
  "too slow for direct commands but fine for planning". That matches.
- **The scout absorbs the reading.** Codex pulled one 357 KB search result into its own context
  and used 114,000 input tokens. The conductor would have received a 300-character answer.
- **Each CLI picks its own model unless told.** Pi used an OpenAI model and Oh My Pi used a Cursor
  one, from their own settings. A scout must pass the model explicitly, both for cost and because
  it decides which company receives the code.
- **An unauthenticated CLI can hang and open a browser.** Autohand started a device sign-in, opened
  a browser tab, and waited until it was killed. A scout needs an auth check first and a hard
  timeout always.
- **Streams are large.** One question produced 300 KB to 920 KB of JSON events from Pi, Codex, and
  Oh My Pi. The runner should read the stream as it arrives and keep only the final message, or
  ask for the single-result form (`--output-format json`, `codex exec -o`).
- **Tool names differ per install.** Oh My Pi rejected `find` as an unknown tool; on this machine
  its list is `read, grep, write, goal` and four experiment tools. Flags need a test per CLI.

### Other ways to get the same result

| Option | For | Against |
| --- | --- | --- |
| **Direct read tools for the conductor** (`read_file`, `search_repo`) run in the main process, no sub-agent | Fastest per call; no CLI, no auth | Every result lands in the conductor's own context at Opus prices, and multi-step exploration uses up the 8-round-trip limit |
| **Deterministic facts tools** (paths exist, file sizes, changed files per worktree) | Milliseconds, free, exact; same pattern as `check_conflicts` | Answers only questions that need no judgement |
| **Our own small agent loop** on the conductor's API key, with read tools we write | One code path for every user with a conductor key; read-only is guaranteed because we write the tools | We build and maintain an agent harness that the CLIs already are |
| **Claude Agent SDK** in process | Typed stream and a permission callback | A new dependency for what `claude -p` already gives |

These are complements, not competitors: exact facts are best fetched directly, and questions that
need reading and judgement are best delegated.

## 4. Planning-phase use cases

"Itself" means a direct, deterministic tool with no model. "Scout" means the headless agent.
"Tile" means a normal visible agent.

| Use case | Example | Best done by | Why |
| --- | --- | --- | --- |
| Check an assumption about the code | "Is there already a settings page for the conductor?" | **Scout** | Needs search and reading across files; 10 to 25 s |
| Does the feature already exist? | "Add retry to uploads" when a retry helper exists | **Scout** | The highest-value check: it can save a whole plan's worth of agent runs |
| Choose file ownership for a plan | Which directories does "the export feature" touch? | **Scout**, then **itself** to confirm the paths exist | The scout finds the files; a path check is exact and free |
| Measure sizes and counts | Lines per file, files per directory | **Itself** | A file listing is exact and takes milliseconds |
| Dependency questions | "What imports `conductor-store.ts`?" | **Scout** for "what depends on this", **itself** for a plain import search | Needs interpretation only sometimes |
| Find the acceptance command | Which test script covers `packages/core`? | **Itself** for `package.json` scripts (already in the pack), **scout** for Nx targets and test layout | |
| What are running agents touching? | Will a new plan collide with Atlas and Bravo? | **Itself** | `git status` and `git diff --stat` per worktree, like `check_conflicts` |
| Read logs or data | "Why did last night's build fail?" from a log file | **Scout**, limited to named paths | Large files must not enter the conductor's context; redaction matters most here |
| Reproduce a bug | "The export crashes on empty input" | **Tile**, in a worktree, user-approved | Needs a shell, write access, and minutes; not a scout job |
| Answer the user directly | "Do we already have X?" by voice | **Scout** | Likely the most used path; today it takes a visible agent and a wait |
| Research outside the repo | "Does library Y support Z?" | Later | Needs web access, which the first scout should not have |

The conductor benefits from doing a thing itself when the answer is a fact a command can produce.
It benefits from delegating when the answer needs several steps of reading, because those steps
then cost a cheaper model's tokens in a separate context instead of the conductor's own.

## 5. Benefits and risks

### Benefits

- **Plans rest on the code, not on a sketch.** File ownership that matches real directories and
  acceptance commands that exist.
- **Less duplicated work.** A $0.04 check can stop a four-agent plan from building something that
  is already there.
- **The conductor's context stays small.** The scout does the reading and returns a paragraph.
- **A cheaper model does the exploring.** The conductor runs on Opus; a scout can run on a small
  model.
- **Better prompts for the agents it starts.** A prompt that names the right files saves each
  spawned agent its own search, once per agent.
- **Direct answers by voice** to questions about the code, without a tile.
- **Fewer rejected plans.** Jev's plan review sends vague or overlapping plans back; grounded ones
  should pass more often.
- **It can use a subscription the user already has**, with no extra API key.
- **Evidence.** A structured answer lets the plan panel show what a plan was based on.

### Risks

| Risk | Detail | Mitigation |
| --- | --- | --- |
| **Latency** | 10 to 25 s per simple lookup, on top of the plan turn | Plan mode and explicit requests only; one or two scouts per turn; show progress; say "checking the code first" aloud |
| **The conductor is busy** | No other command runs during a turn; only the newest queued utterance is kept | Cap inline scouts at about 60 s; add a cancel path; make long ones asynchronous later |
| **Context pressure** | A long answer in the tool result | 4,000-character cap; final message only |
| **Cost** | Scout spend is outside the conductor's daily token budget, and only some CLIs report cost | `--max-budget-usd` where it exists; a per-day scout count; record reported cost separately |
| **Wrong answers** | A scout can be confidently wrong, and "not found" is not proof | Ask for file paths as evidence; treat it as a hint; the user still approves the plan |
| **Read-only is uneven** | Strong where tools are removed (Claude Code, Pi). Codex keeps a shell under a sandbox policy, and whether a write is blocked on Windows was not tested. Cursor and Devin rely on a mode | Start with Claude Code; add a CLI only after a test that tries to write |
| **Write access** | None for a scout. No shell, no web, no MCP servers in the prototype | Anything that needs a shell is a tile in a worktree |
| **Sandboxing** | No OS sandbox on Windows for most CLIs; Devin's is macOS and Linux only | Rely on tool removal, not on a sandbox |
| **Prompt injection** | Repository text can steer the scout, and its answer could carry instructions | Fence the answer as data; every conductor side effect already needs a countdown, a yes, or plan approval |
| **Privacy** | Code goes to the scout's provider, which may differ from the conductor's | Pin the provider and model in settings; say which one is used |
| **Secrets** | A scout can read `.env` files in the project | Redact the answer; the same exposure exists for any agent run in that project |
| **Hooks and environment** | Maestro's hooks report against a tile when `EMDASH_HOOK_PORT`, `EMDASH_HOOK_NONCE`, and `EMDASH_PTY_ID` are set, and each hook starts PowerShell on Windows | Build the environment from the allowlist, which has none of them; run Claude Code with `--restricted`, which ignores user and project settings |
| **Auth and trust prompts** | Autohand opened a browser. Devin's print mode fails in an untrusted folder. Cursor has a `--trust` flag for its own trust prompt | Check auth first; closed standard input; hard timeout |
| **Flag drift** | CLI flags and tool names change between versions | One adapter and one test per CLI |
| **Prompt cache** | Adding a tool and a system-prompt line rebuilds the cached prefix once | Append the tool last; change the prompt once |
| **Remote projects** | A local process cannot read an SSH project | Local projects only at first, as the context pack does today |
| **High-risk area** | `AGENTS.md` lists provider process spawning as high risk | Call it out in the PR; reuse the exec and env helpers, add no new spawn code |

### How it would show up on the canvas

From least to most visible:

1. **HUD line** (prototype): "Checking the code: is there already a settings page?" with the
   elapsed time and a cancel button. Streaming output can show the current step.
2. **Conductor log**: each investigation is recorded as an action with its question, answer, time,
   and cost. The log panel already lists tool calls.
3. **Evidence on the plan panel**: the files a plan was based on.
4. **A scout tile** (later, for long runs): a compact tile that shows the stream, lives in the
   plan's region, and closes itself. A hidden tile already keeps its agent running, so the
   mechanics exist (`hideConversation` in `canvas/api/browser/stores/canvas-store.ts`).

## 6. Recommendation

Build the smallest version of shape A and measure it before adding anything.

- **One tool**, `investigate`, with a project and one question.
- **One CLI**, Claude Code, because its tool removal is the strongest read-only control, it reports
  cost, it has a spend cap, and it was the fastest in the test.
- **Read tools only**: `--tools "Read,Grep,Glob"`, `--restricted`, `--strict-mcp-config`,
  `--permission-prompts none`, `--no-session-persistence`, `--max-budget-usd`, an explicit
  `--model`, and a deny list for secret files.
- **Inline**, capped at 60 seconds, local projects only.
- **Off by default**, behind a setting.
- **Not on the completion follow-up allowlist**, so a finished agent's reply cannot trigger one.

Keep bug reproduction and anything that needs a shell on the existing tile path. Treat the ACP
session (shape C) as the second stage, for long or visible investigations and for remote projects.

### Prototype plan

| Step | Work | Files |
| --- | --- | --- |
| 1 | **Runner.** Resolve the CLI, build the allowlisted environment, run with a timeout and abort signal, parse the JSON result. Return the answer, duration, model, and reported cost, or a typed failure (not installed, not signed in, timed out, failed) | New `conductor/node/investigation.ts`; a narrow new port on `ChorusHostServices` |
| 2 | **Wire procedure** `investigate`, plus a way to cancel | `conductor/api/contract.ts`, `conductor/node/wire-controller.ts` |
| 3 | **Tool.** Append `investigate` to the schema list. In `runTool`: local projects only, set the HUD line, call the procedure, cap, redact, and fence the answer | `conductor/api/tools.ts`, `conductor/browser/conductor-store.ts` |
| 4 | **Prompt.** One line: use it in plan mode, or when asked, to check an assumption that would change the plan; one question per call; never for commands | `conductor/api/system-prompt.ts` |
| 5 | **Settings.** On or off, model, time limit, daily count | `conductor/api/contract.ts`, `conductor/browser/settings/chorus-settings-page.tsx` |
| 6 | **Tests.** Argument building, result parsing, timeout, fencing, the tool path, and an environment test that no `EMDASH_*` variable reaches the child | New `conductor/node/investigation.test.ts`; `conductor/api/tools.test.ts`; a tool test like `conductor/browser/spawn-agent-tool.test.ts` |
| 7 | **Evaluate** on about 20 real planning requests, with and without the tool | A step script under `apps/emdash-desktop/tooling/chorus/steps/` |

Steps 1 to 6 are roughly two to three days of work. That estimate is a guess, not a measurement.

**Keep it if**, across the evaluation set, plans name paths that exist more often, at least one
duplicate-work plan is avoided, and the added wait stays under about 30 seconds at the median.
**Drop or rethink it if** the model calls it on most turns, or answers are wrong often enough that
plans get worse.

**Cheap wins that need no sub-agent**, worth doing alongside:

- Reject a plan whose `owned_paths` do not exist.
- A facts tool for file sizes and for what each running agent's worktree has changed.

### After the prototype

1. A second CLI (Pi or Codex), each behind a test that tries to write.
2. Let the user call it directly: "check whether we already have X".
3. Structured answers, with evidence shown on the plan panel.
4. Long investigations through an ACP session in `plan` or `read-only` mode, with a scout tile and
   an asynchronous result.
5. Remote projects.

## Open questions

1. **Who pays?** The user's CLI login (a subscription, no extra key) or the conductor's API key
   (`claude --bare` reads only `ANTHROPIC_API_KEY`, which also works for users with no Claude
   subscription)?
2. **Which CLI by default?** Always Claude Code, or the first installed from a fixed order?
3. **How long may a voice turn wait?** 30 seconds, 60, or should anything over 15 run in the
   background and report later?
4. **Should a scout ever get a shell?** `git log`, `rg`, and test runs answer more questions, but
   a shell ends structural read-only for every CLI except through its sandbox.
5. **How visible should it be?** A HUD line only, a note with the finding, or a tile?
6. **Should the model decide when to investigate**, or only the user ("check first")? The request
   says "if it really feels like it needs to", which points to the model, with a tight cap.
7. **How is a wrong scout answer caught?** Is evidence on the plan panel enough?
8. **Which provider may see the code?** Is it acceptable for a scout to send code to a different
   company than the conductor uses?
9. **Remote projects**: wait for the ACP path, or run the CLI over SSH?
10. **Should the scout's flags move into the provider plugins** as a "print mode" capability once
    a second CLI is added?

## Appendix: how the measurements were taken

- CLI versions and flags come from each CLI's `--help` on this machine on 2026-10-08.
- Each probe ran once, from the repository root, with standard input closed and a 170-second limit.
- The probes ran from inside a Maestro agent tile, whose shell carries `EMDASH_*` hook variables.
  Those and the `CLAUDE_CODE_*` session variables were removed first, so a nested agent's hooks
  could not report against the tile.
- Commands:
  - `claude -p "<question>" --output-format json --model <sonnet|haiku> --tools "Read,Grep,Glob" --permission-prompts none --no-session-persistence --max-budget-usd 0.75 --safe-mode`
  - `codex exec --sandbox read-only --ephemeral --json --color never "<question>"`
  - `pi -p --no-session --tools read,grep,find,ls --mode json "<question>"`
  - `omp -p --no-session --tools read,grep --mode json --max-time 150 "<question>"`
  - `autohand -p "<question>" --restricted --ephemeral --output-format stream-json --max-duration 150`
- Cost figures are what each CLI printed. Whether a run was billed or counted against a
  subscription was not checked.
- Not tested: whether each CLI's read-only setting blocks a write attempt, how long an ACP session
  takes to start, and any run on a remote project.

Noticed in passing, not investigated: the Devin plugin passes `--permission-mode=bypass` for
auto-approve (`packages/plugins/src/agents/impl/devin/index.ts:79`), while the installed Devin
3000.11.3 lists the modes `auto`, `accept-edits`, `smart`, and `dangerous`.
