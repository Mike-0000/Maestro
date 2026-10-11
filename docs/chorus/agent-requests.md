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
| The conductor | One short model turn (up to four round trips) approves, denies, or passes it to the developer. |

Built:

| Kind | Payload | Decided by | Carried out with |
| --- | --- | --- | --- |
| `spawn_agent` | `provider`, `task_name`, `brief`, `worktree?`, `report_back?` | Conductor | `spawn_agent` |
| `message_agent` | `agent`, `text`, `report_back?` | Conductor | `send_to_agent` |
| `ask_developer` | `question`, `options?` | Developer | (the answer is the reply) |
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
  `answer_request` with `approve` or `deny`. Every other tool is refused, whatever the request
  says. An approved request runs one conductor tool with input built from the validated payload,
  so a brief reaches the new agent unchanged and the model cannot be talked into a different
  action. The new agent starts in the asking agent's project, by id. A message goes to the agent
  that carries exactly the name the request gave, resolved when the request was accepted; "it"
  and near matches are refused with the list of names.
- **Unsure means the developer.** If the model does not settle the request, it asks the
  developer in one spoken sentence and the request stays open. With no model configured, or when
  the turn fails, the conductor asks with a fixed sentence instead.
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

A decision turn can settle only the request it was started for, and can tell the asking agent at
most one short line. A developer's turn can settle only a request that was put to the developer.
A question can be answered only with the developer's words.

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
| Answered | `The developer answered: <their words>` |
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
  carry on.
- One setting turns the channel off: **Settings → Voice & Conductor → Let agents ask the
  conductor**. New requests are refused, and the ones still open are closed with a denial.
- A conductor-decided request costs one model turn against the daily token budget.

## Out of scope

- **Remote and other-provider agents.** Session MCP servers reach local Claude Code, Codex, and
  chat sessions only. Other CLIs would need the hook server (`EMDASH_HOOK_PORT`) as a second
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
