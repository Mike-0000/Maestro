# Providers

## Source Of Truth

- `packages/plugins/src/agents/registry.ts`
- `packages/plugins/src/agents/impl/`
- `src/main/core/dependencies/dependency-managers.ts`
- `src/main/core/pty/`

## Current Providers (37)

codex, claude, grok, devin, qwen, qoder, droid, antigravity, cursor, copilot, amp, commandcode, opencode, hermes, charm, auggie, goose, kimi, kilocode, kiro, rovo, cline, codebuddy, continue, codebuff, freebuff, mistral, muse, jules, junie, oh-my-pi, pi, prime-agent, autohand, letta, mimocode, zero

## Current ACP-Capable Providers (23)

codex, claude, opencode, grok, devin, qwen, qoder, droid, cursor, copilot, hermes, auggie, goose, kimi, kilocode, kiro, cline, mistral, junie, mimocode, oh-my-pi, prime-agent, codebuddy

## Provider Metadata Includes

- provider metadata and icon assets
- PATH host dependency definitions and optional self-update argv descriptors
- prompt delivery behavior
- auto-approve, ACP, hooks, MCP, model, session, trust, and plugin capabilities

## Agent Hooks And Notifications

Agent activity, completion, and attention states come from explicit hooks or plugins
installed by the `tui-agents` runtime in `packages/core/src/runtimes/tui-agents/`. Emdash
does not infer agent status from terminal output. If a provider has no hook/plugin integration
for an event, the renderer should not show or notify an inferred status for that event.

A turn end is the one event whose meaning the conductor decides. When the conductor has a model
key and "Let the conductor decide who needs you" is on, `AgentStatusService` asks the conductor's
model (`ConductorService.judgeAttention`, registered through
`src/core/primitives/agents/api/attention-judge.ts`) whether the agent's final reply needs the
developer. A yes makes the conversation `awaiting-input` instead of `completed`; the status stays
`working` until the verdict lands, and the provider's `idle_prompt` reminder for that turn is then
ignored. Chat agents' replies are read from their transcript. With no reply, no key, the setting
off, or no answer within ten seconds, the hook rules below apply unchanged. Permission and
elicitation prompts never go through the model.

A provider's turn-end hook is not always completion. A plugin's `parseHookEvent` may report
`backgroundWork` on a `stop` event: the ids of in-flight work (background shells, subagents,
one-shot scheduled wakeups) that will wake the session when it settles. The runtime then keeps the
agent `working` with `awaitingBackgroundWork` set instead of `completed`, so no completion
notification fires, and it ignores the provider's `idle_prompt` reminder while that work is
awaited; permission and elicitation prompts still surface. A `start` event with
`initiator: 'background'` marks the wake-up turn. A turn the user opens acknowledges whatever was
already running, so a long-lived process such as a dev server holds back only the turn that
launched it. Claude Code is the provider that reports this today, from the `background_tasks` and
`session_crons` fields of its `Stop` payload; it also classifies `Notification` payloads by
`notification_type`, dropping informational ones rather than reporting them as waiting for input.

Shipped hook integrations install into user-global provider configuration, never into a task
worktree. The provider behavior resolves its root from the same allowlisted environment passed to
the CLI, including provider-specific home overrides and XDG/APPDATA conventions. Paths returned by
hook and file-drop behaviors are relative to that root. `scope: 'workspace'` remains available as
an extension escape hatch, but no built-in provider uses it.

Managed config entries include an Emdash hook-config version marker. On session startup the
installer checks the complete expected entry set before taking a per-root write lock, checks again
under the lock, and writes only when missing or stale. Existing JSON or TOML that cannot be parsed
is left untouched and reported through logging. Global hooks are harmless in sessions outside
Emdash: their commands exit successfully when the Emdash hook server environment is absent.

The global roots used by the built-in integrations are:

| Providers | Root behavior |
| --- | --- |
| Auggie, CodeBuddy, Command Code, Qoder, Grok, Amp, Kilo, Droid, Goose | Fixed home roots (`~/.augment`, `~/.codebuddy`, `~/.commandcode`, `~/.qoder`, `~/.grok`, `~/.amp`, `~/.kilo`, `~/.factory`, `~/.agents`) |
| Claude, Codex, Copilot, Qwen, Kimi, Kiro, Mistral Vibe | Provider home env override with a home fallback |
| OpenCode, MiMoCode, Devin | Provider override where supported, then XDG config on POSIX or APPDATA on Windows |
| Pi | `$PI_CODING_AGENT_DIR` with `~/.pi/agent` fallback |
| Oh My Pi | `$PI_CODING_AGENT_DIR`, then `$PI_CONFIG_DIR`, with `~/.omp/agent` fallback |
| Prime Agent | `$PRIME_AGENT_CODING_AGENT_DIR` with `~/.prime/agent` fallback |
| Antigravity CLI | `~/.gemini/config` |
| Muse Code | `$XDG_CONFIG_HOME/muse`, falling back to `~/.config/muse` on macOS and Linux |

Kimi also keeps the legacy `~/.kimi/config.toml` root synchronized. Kiro maintains both the classic
`agents/emdash.json` format and the standalone `hooks/emdash.json` v1 schema so classic and `--v3`
sessions are covered. The agent details UI obtains read-only installed/pending status through the
host's `agent-config` runtime for both local and remote hosts.

## Provider API Keys

Emdash passes provider API keys through to the agent CLIs it spawns. The allowlisted agent
environment in `packages/core/src/primitives/agent-env/api/index.ts` is the single source of truth
for which variables reach a spawned agent.

[OrcaRouter](https://www.orcarouter.ai) is an OpenAI-compatible gateway that routes to models from
OpenAI, Anthropic, Google, DeepSeek, Qwen, and more through one API key (`sk-orca-…`). OpenCode
resolves `orcarouter/*` models through its models.dev catalog, so setting `ORCAROUTER_API_KEY` lets
you select an OrcaRouter model from the OpenCode model picker.

## Provider Runtime Notes

- Host dependencies are resolved by the host-scoped `HostDependencies` Wire component.
  Provider plugins declare PATH-only definitions (`binaryNames`, install guidance, and optional
  update argv). Runtimes receive only the narrow resolver contract and must not infer package
  managers, fetch latest versions, or keep a second executable cache.
- Install command metadata stays sudo-free and declares an elevation policy. Commands that always
  require elevation are wrapped by the host-dependency runtime, while npm-style `on-failure`
  commands first run with user privileges and may be explicitly retried with passwordless sudo
  after a permission-classified failure. Homebrew and user-local installers must remain
  `never`-elevated.
- A provider self-update command runs directly as argv against the selected PATH binary. There is no
  interpolated shell command and no uninstall/install lifecycle in provider metadata. Future managed
  sources such as Nix should add new source and selection variants without changing runtime spawn
  injection.
- Executable selection belongs to the host-dependency runtime. Auto follows the plugin's binary
  names on the host PATH; a saved path or CLI-name override resolves independently of discovery.
  The resolver accepts an optional proposed selection, so validation and startup share one
  operation and implementation. Invalid overrides block launch and
  never fall back to Auto. Settings save only after validation, and failed saves retain the previous
  selection. Existing path-selection JSON remains valid; CLI selections add a `kind: 'cli'` variant
  with a `command` field. Overrides accept executable files or PATH names; use a wrapper script for
  commands with arguments, such as `srt claude`.
- Claude uses deterministic `--session-id` values for conversation isolation.
- Codex ACP exposes collaboration mode separately from permission mode. The ACP runtime maps the
  provider-owned `collaboration_mode` config category to the chat composer's Default/Plan selector
  and persists that selection with the conversation; filesystem and approval controls remain in
  the existing permission-mode selector.
- Agents that cannot receive an automated initial prompt via argv or stdin declare `pty-only`
  prompt delivery. Their TUI opens without an initial prompt, and automation flows exclude them
  unless they also support ACP.
- `packages/core/src/runtimes/tui-agents/` owns hook ingestion, hook config/plugin installation, and the agent state LiveModel. `src/main/core/agent-status/` projects those runtime states into the conversation SQLite/cache state, while `src/services/notifications/` turns deliverable agent events into the persisted notification feed, batched sound delivery, and Electron OS notifications over the desktop Wire contract.
- Qwen Code hooks use the documented Qwen settings schema in `$QWEN_HOME/settings.json` (falling back to `~/.qwen/settings.json`). Emdash installs command hooks for permission requests and session end/stop events while preserving unrelated user hooks.
- Antigravity CLI installs lifecycle hooks in `~/.gemini/config/plugins/emdash/` to report
  working and completion status while preserving existing user hooks.
- Claude Code is launched with a sub-agent delegation policy appended to its system prompt
  (`packages/plugins/src/agents/impl/claude/delegation.ts`): its Agent tool otherwise tells the
  model not to spawn sub-agents unless the user asks. The TUI path passes `--append-system-prompt`
  on fresh and resumed launches; the ACP path sends it as `_meta.systemPrompt.append` through the
  plugin's `acp.sessionMeta`. A user who sets their own system-prompt flag in "Additional
  parameters" keeps it and the policy is not added.
- Muse Code installs managed hooks through `managed_hooks_path` in `settings.json`.
  `SessionStart`, `UserPromptSubmit`, and `Stop` report session, working, and completion events.
  `managed_hooks_env_vars` forwards the Emdash hook routing variables.
  Existing hooks are preserved; paths outside the config root are rejected.
- Prime Agent uses its native ACP stdio mode (`prime-agent --mode acp`). Its TUI extension reports
  session file paths, turn starts, and turn completion for resume and notification support. Emdash
  synchronizes standard stdio and HTTP MCP definitions in `~/.prime/agent/settings.json`. ACP
  sessions receive those definitions through `session/new`, and Prime exposes them to the model
  through its pre-imported `mcp` Python program.

## Adding Or Changing A Provider

1. add or update the plugin in `packages/plugins/src/agents/impl/` and register it in
   `packages/plugins/src/agents/registry.ts`
2. update allowlisted agent env vars in `packages/core/src/primitives/agent-env/api/index.ts` if needed
3. add or update hook/plugin installation and parsing in the provider plugin if the provider
   supports explicit events; `tui-agents` installs and hosts those hooks at runtime
4. validate PATH dependency behavior through the `HostDependencies` component and resolver contract
5. add or update tests for any non-standard behavior
