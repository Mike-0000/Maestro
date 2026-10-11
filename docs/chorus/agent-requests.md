# Agent requests: agents talking to the conductor

An agent on the canvas can ask the conductor for something it cannot do itself, and through the
conductor reach other agents. The agent sends a **request** with a kind and a payload. The
conductor decides it, carries it out, and types the answer into the asking agent's terminal.

Paths that start with `conductor/` are under `apps/emdash-desktop/src/core/features/`; paths that
start with `main/` are under `apps/emdash-desktop/src/`.

## Why

The conductor's logs (September 25 to October 10) show the developer doing this work by hand:

- **Handing work to another agent.** "Tell Zulu 3 I'm going to hand this off to a ChatGPT agent
  with computer use. Give me a full prompt…" The prompt was then copied out by hand, and the
  conductor misread it as Zulu's result.
- **Answering an agent's question.** 11 of 38 completion summaries named a decision the agent
  needed. The developer answered by voice ("Tell Xenon 2 that I've decided…") or typed into the
  terminal.
- **Carrying text between agents.** About seven pastes of one agent's output into another.
- **Reports.** Completions are the most common event, and 13 of 38 were "still running" noise,
  because a finished turn is the only signal an agent has.

## How a request travels

```text
agent ──MCP tool──▶ main process ──event──▶ conductor (renderer) ──▶ decides ──▶ acts
  ▲                                              │
  └────────── answer typed into its terminal ◀───┘
```

1. **The agent calls one tool.** Every local Claude Code, Codex, and chat (ACP) session gets a
   loopback MCP server named `maestro` with one tool, `conductor_request`. It is the same kind of
   server, wired the same way, as the browser tools (`chorus-browser`): a per-conversation bearer
   token handed over in an environment variable.
2. **The main process stamps the sender** from the token (conversation, task, project). Nothing
   in the request can name a different sender. It validates the kind and payload, gives the
   request a short id (`r-3f9a1c`), and emits it to the window.
3. **The conductor accepts or refuses at once**, and that verdict is the tool result. A refusal
   says why in words the agent can act on ("Provider "chatgpt" is not installed. Installed:
   claude (Claude Code), codex (Codex)."). If no window answers within eight seconds, the agent
   is told nothing happened.
4. **The request is settled** by whoever decides its kind (next section).
5. **The answer is typed into the asking agent**, as a message that starts with
   `[Maestro reply r-3f9a1c to your spawn_agent request]`. It waits up to ten minutes while that
   agent sits at a permission prompt or a dialog, where typing could answer the prompt. It is
   never typed into an agent that is not running, and it never starts one. When an answer cannot
   be delivered, the conductor tells the developer.

## What agents are told

Nothing reaches the conductor unless the agent decides to call the tool, so the wording is the
trigger. Three texts carry it, strongest first:

| Text | Reaches | Source |
| --- | --- | --- |
| Appended system prompt | Claude Code (terminal and chat) | `CLAUDE_CONDUCTOR_POLICY` in `packages/plugins/src/agents/impl/claude/delegation.ts` |
| MCP server instructions | Any client that shows them to its model | `AGENT_REQUEST_INSTRUCTIONS` |
| Tool description and each kind's `usage` | Every agent that has the tool | `agentRequestToolDefinition()` |

All three give the same rules, to be followed without being told:

- **Hands-free.** The developer is often away. The conductor decides requests on their behalf,
  so an agent sends the request and acts on the conductor's decision. It does not stop to ask
  the developer for permission or confirmation, in a request or in its reply.
- **Stuck.** The same approach failed twice, a tool or information is missing, a choice cannot
  be settled, or the turn would end with the work unfinished: send `ask_conductor` and follow
  the answer. `ask_developer` is only for what the developer alone can supply (a password, a
  payment), and the agent does not wait on it.
- **Other work.** A separate investigation, a parallel piece, a specialised task, or a follow-up
  outside the task: send `spawn_agent`. Sub-agents stay for pieces of the agent's own task.
- **Computer use.** Control of the desktop, another application, or a real browser always goes to
  a Codex agent: `spawn_agent` with provider `codex`. The canvas browser tools do not count.

The conductor's decision turn is told the developer wants the last two, so it approves them
unless something else is wrong.

## Request format

```json
{ "kind": "spawn_agent", "payload": { "provider": "codex", "task_name": "…", "brief": "…" },
  "reason": "The order form needs a real browser, which I cannot drive." }
```

`kind` picks the payload schema. `reason` is optional and is what the conductor weighs. The main
process adds `id`, `at`, and `from`. The schemas, the tool description agents read, and every
text the conductor or an agent sees are in `conductor/api/agent-requests.ts`.

## Kinds

Each kind names who decides it:

| Decided by | What happens |
| --- | --- |
| Nobody | The conductor says one sentence to the developer. No reply follows. |
| The developer | The conductor asks aloud. The request waits up to 10 minutes for the answer. |
| The conductor | One short model turn (up to four round trips) approves, denies, or answers. The developer is not asked. |

Built:

| Kind | Payload | Decided by | Carried out with |
| --- | --- | --- | --- |
| `spawn_agent` | `provider`, `task_name`, `brief`, `worktree?`, `report_back?` | Conductor | `spawn_agent` |
| `message_agent` | `agent`, `text`, `report_back?` | Conductor | `send_to_agent` |
| `ask_conductor` | `question`, `options?` | Conductor | (the conductor's answer is the reply) |
| `ask_developer` | `question`, `options?` | Developer | (the developer's answer is the reply) |
| `report` | `status` (`progress`, `done`, `blocked`), `message` | Nobody | (spoken) |

Designed, not built. Each is one registry entry that maps to a conductor tool that already
exists:

| Kind | Purpose | Would run |
| --- | --- | --- |
| `read_agent` | Read another agent's recent output | `read_agent`; the output is the reply |
| `show` | Open or focus an app or browser tile, or a local URL | `show_app` |
| `decide` | A permission-style yes or no, with no action attached | Nothing; the verdict is the reply |
| `window` | Focus, close, hide, or reopen an agent's window | `focus_agent`, `close_agent`, `reopen_agent` |
| `arrange` | Group or lay out windows and regions | `arrange_canvas` |
| `list_agents` | Learn which agents exist, to message one | `list_agents`; the roster is the reply |

The logs show no agent asking for canvas or browser changes yet (agents already drive their own
browser through `chorus-browser`), so those wait for a real need.

## How the conductor decides

A request is **agent output**. It is a proposal, never an instruction and never the developer's
permission. Four rules follow from that:

- **The model judges; Maestro acts.** In the decision turn the model can only read state and call
  `answer_request` with `approve` or `deny` (or `answer`, for a question put to it). Every other
  tool is refused, whatever the request
  says. An approved request runs one conductor tool with input built from the validated payload,
  so a brief reaches the new agent unchanged and the model cannot be talked into a different
  action. The new agent starts in the asking agent's project, by id. A message goes to the agent
  that carries exactly the name the request gave, resolved when the request was accepted; "it"
  and near matches are refused with the list of names.
- **The conductor decides alone.** The developer is often away, so the decision turn is told to
  settle the request itself and never to ask them: approve what is reversible and in scope, deny
  the rest, and answer a question in its own name. If the turn fails or ends without a decision,
  the agent is told at once that nothing was done and to carry on, and the conductor says so
  aloud. Only with no model configured does a request wait for the developer's yes or no.
- **A bare yes or no counts only for the question just asked.** It settles a request only when
  that request's question is the last thing the conductor said and has stood for two seconds.
  Among several, the one asked last wins. "No", "nope", and "deny" refuse; "stop" and "wait" do
  not. Any other answer goes through the model, which sees the open requests in its context.
- **The usual brakes still apply.** An approved spawn or message runs behind the same 1.5-second
  cancel window as one the developer asked for. The conductor says what it did afterwards, and
  the new agent does not take the focus.

Open requests are listed in the conductor's context, so a later answer ("make the pod longer")
reaches the right agent through `answer_request`. While a request waits for the developer, the
fast router is skipped: it would type the answer into whichever agent is focused.

A decision turn can settle only the request it was started for. Its note to the asking agent is
one short line (300 characters); its answer to an `ask_conductor` question may run to 1,500. A
developer's turn can settle only a request that was put to the developer. An answer always says
whose it is: the conductor never speaks as the developer.

### Text an agent wrote

Whatever an agent puts in a request is handled as data everywhere it goes:

- **Into a terminal.** Control characters are removed when the payload is parsed and again when
  a message is typed, so nothing can end the paste it travels in and become keystrokes.
- **Into another agent.** A brief, a message, or a passed-on reply sits between two marker lines
  that carry a fresh random word. Its author could not know the word, so a forged
  `[Maestro reply …]` line stays visibly inside the other agent's text.
- **Into the conductor's model.** The request is fenced as `<agent-request>` and cannot close the
  fence or the context block. Names (`task_name`, `agent`, `provider`, options) are one line
  without brackets, angle brackets, or quotes, because they later appear in headers and in the
  context.

## Replies

| Ending | The asking agent reads |
| --- | --- |
| Approved | `Approved by the conductor.` (or `the developer`), then what happened, such as the new agent's name |
| Denied | `Denied by the conductor: <reason>. Continue without it.` |
| Answered | `The conductor answered, deciding on the developer's behalf: <answer>`, or `The developer answered: <their words>` |
| Undecided | `The conductor could not decide it just now, so nothing was done.` |
| Cancelled | `The developer cancelled it.` |
| Failed | `Approved, but it could not be carried out: <error>` |
| No answer | `No answer: the developer did not respond in time.` |

**Report back.** Unless the request says `report_back: false`, the next final reply of the agent
that was started or messaged is typed into the asking agent, marked as that agent's output. This
is how a Claude Code agent hands a task to a Codex agent and continues when it returns. Codex
reports no final reply, so its reply is the end of its terminal, and is labeled as such. When
several agents asked the same agent, each gets that reply. A reply that comes more than two hours
after the request is not passed on.

Agents told about each other by name (in the approval reply, in the brief, in each passed-on
message) can keep a conversation going with `message_agent`.

## Limits

- Three open requests per agent, and eight requests per agent in ten minutes, counted when each
  arrives (refused ones too), so sending many at once does not get around them.
- No request stays open for more than ten minutes without an answer; the agent is then told to
  carry on with what does not depend on the answer, and not to ask the same question again unless
  it is blocked. The conductor keeps the newest unanswered question per agent (up to six, for a
  day) and tells the developer once, after their next command: "2 questions went unanswered while
  you were away. Atlas asks: …". Writing to that agent first drops its question from the list.
- One setting turns the channel off: **Settings → Voice & Conductor → Let agents ask the
  conductor**. New requests are refused, and the ones still open are closed with a denial.
- A conductor-decided request costs one model turn against the daily token budget.

## Out of scope

- **Remote and other-provider agents.** Session MCP servers reach local Claude Code, Codex, and
  chat sessions only. A project attached as a machine is remote even when that machine is this
  computer: its agents run under the workspace server and get no `maestro` server, so they
  cannot send requests at all. Other CLIs would need the hook server (`EMDASH_HOOK_PORT`) as a second
  transport; the request format does not depend on the transport.
- **Waiting inside the tool call.** The tool returns when the request is accepted, and the
  answer arrives as a new message. Holding the call open for fast answers is a later change.
- **Messages queued behind a busy agent.** Report back returns the target's next final reply. If
  the target was mid-turn when the message arrived, or the developer spoke to it in between,
  that can be the reply to other work.
- **One send at a time per terminal.** A reply is pasted and submitted like any conductor
  message. If the developer is typing in that terminal at that moment, their half-typed text is
  submitted with it.
- **Answers typed straight into a terminal.** The conductor sees an answer the developer gives
  through it (by voice, "tell Atlas …", or dictation and "send it"). One typed into the agent's
  terminal by hand leaves the question open until it expires.
- **Cross-project requests.** A new agent starts in the asking agent's project.
- **Agents answering each other's permission prompts**, stopping, or archiving each other.
- **A place on the canvas for open requests.** They are spoken and listed in the conductor's
  context; there is no card yet.
- **Requests surviving a restart.** Open requests live in the window's memory.

## Adding a kind

Add one entry to `agentRequestKinds` in `conductor/api/agent-requests.ts`: the payload schema,
who decides, the sentence the conductor speaks, the text the model reads, and (for
conductor-decided kinds) the conductor tool call that carries it out. The tool description agents
see, validation, the decision turn, and the reply all follow from the entry. A kind that needs a
tool the decision turn should also read with goes in `REQUEST_TURN_TOOLS`.

## Where it lives

| Part | File |
| --- | --- |
| Request format, kinds, texts | `conductor/api/agent-requests.ts` |
| MCP server for agents | `main/host/agent-requests/agent-request-server.ts` |
| Session wiring (with the browser server) | `main/host/agent-requests/agent-session-mcp.ts` |
| Shared loopback MCP plumbing | `main/host/mcp/loopback-mcp-server.ts` |
| Main-to-window hand-off and verdict | `conductor/node/agent-request-hub.ts` |
| Open requests, decisions, replies | `conductor/browser/agent-requests.ts` |
| Decision turn, tool fence, `answer_request` | `conductor/browser/conductor-store.ts` |
