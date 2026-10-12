# Risky Area: PTY And Sessions

## Main Files

- `packages/core/src/services/pty/` — terminal env construction, shell resolution, spawning, and session registry
- `packages/core/src/runtimes/terminals/` — interactive terminal lifecycle and Wire component
- `packages/core/src/runtimes/scripts/` — lifecycle script execution through the shared PTY plane
- `packages/core/src/runtimes/tui-agents/` — PTY-backed agent sessions, runtime-owned hook server, hook installation, and agent state LiveModels
- `src/main/core/agent-status/` — desktop projection of runtime agent states into the conversation cache
- `src/services/notifications/` — desktop notification feed, batching, sound sink, and OS notification sink

## Core Risks

- PTY cleanup and exit handling
- resize behavior
- shell quoting and Windows command wrapping
- tmux lifecycle
- tmux capability negotiation: `PtySession` answers xterm.js DA1/DA2 queries on
  the host and consumes them before logging output. Keep replies aligned with
  the renderer's actual capabilities; never filter user input or invent support
  for protocols such as XTVERSION. Direct PTYs retain renderer negotiation.
- historical replay: answered tmux DA queries are removed before retention.
  Do not mute all snapshot replies: initial snapshots can contain outstanding
  queries from a process started before subscription. Other queries keep their
  existing renderer behavior. Let xterm own write buffering and scheduling.
- output parsing: consuming a DA query must preserve its introducer's effect on
  an interrupted escape sequence or string; test display and replies against xterm
- provider-specific resume/session behavior
- env passthrough safety

## Rules

- construct every PTY environment through `packages/core/src/services/pty/api/terminal-env.ts`
- keep the host/worker `process.env` separate from the captured user-shell environment; only the
  host process captures it, spawning runtimes receive a parent-owned source and resolve that source
  exactly once per spawn, never as an ambient fallback or immutable worker config
- do not weaken quoting or spawn behavior casually
- cmd.exe arguments (`quoteArg(..., 'windows-cmd')`) stay entirely inside double quotes: no `^`
  escapes inside quotes (they reach the program), `"` becomes `""`, `%` becomes `%%cd:~,%`, and
  line breaks are flattened because cmd ends a command at one. The Windows-only round trip in
  `packages/core/src/primitives/exec/node/executable-launch.test.ts` runs a real `.cmd` shim; run
  it on Windows after touching this quoting
- TUI initial prompts with line breaks are spilled to a file on Windows (`spillLineBreaks` in
  `runtimes/tui-agents/node/runtime/prompt-spill.ts`); inline they would be cut at the first line
- validate both direct spawn and shell-wrapped spawn cases when changing PTY startup logic
- confirm renderer event flow if hook/plugin payload or agent status behavior changes
- a completed agent's `lastAssistantMessage` leaves the main process only through
  `buildCompletionReport` (`src/core/primitives/agents/api/completion-report.ts`): redacted,
  bounded, with no reasoning or transcript. The conductor treats it as untrusted data. A
  completion follow-up turn may run only `COMPLETION_FOLLOW_UP_TOOLS`
  (`src/core/features/conductor/api/completion-follow-up.ts`), and `show_app` opens only
  loopback or same-origin URLs in such a turn: a public website needs the user's own request
  (`actingOnAgentOutput` in `src/core/features/conductor/browser/app-tools.ts`). Keep both fences
  when changing either side.
