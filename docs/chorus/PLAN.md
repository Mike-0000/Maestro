# Voice-driven agent canvas for Windows, built on emdash

Working name: **Chorus** (placeholder; don't ship with "CNVS" or "emdash" branding).
Base: fork of `generalaction/emdash` @ `95838289` (2026-09-24), Apache-2.0.
Plan version: v4 (revision log and self-scores at the end).

---

## 1. What we are building

A Windows desktop ADE where you:

1. See every running coding agent (Claude Code, Codex, Cursor CLI, Gemini, …) as a live tile on an infinite canvas, each in its own git worktree.
2. Talk to it. "Build a settings page with dark mode, split it between Claude and Codex" becomes a plan card, then N agents spawned on the canvas. "Tell Codex two to run the tests." "What's the auth agent doing?" "Approve it."
3. Get told when something needs you (permission prompt, done, error), spoken and visual, and jump straight there.

### Success criteria for v1 beta (measured, not vibes)

| # | Metric | Target |
|---|--------|--------|
| M1 | Push-to-talk release → keystrokes land in the target agent (direct command, cloud STT) | p50 ≤ 1.5 s, p95 ≤ 3 s |
| M2 | Same, local STT (whisper.cpp small.en, GPU) | p50 ≤ 2.5 s |
| M3 | Command routing accuracy on the 200-utterance eval set (§9.3) | ≥ 95 % correct tool + target |
| M4 | Side-effectful actions executed without a confirmation or cancel window | 0 |
| M5 | Canvas with 16 agent tiles (4 live, 12 preview): pan/zoom frame rate on an i5 laptop with integrated GPU | ≥ 55 fps |
| M6 | Renderer memory with 16 tiles, 10k scrollback each | < 1.5 GB |
| M7 | Goal decomposition: 10 benchmark goals, branches that merge with no conflicts | ≥ 80 % |
| M8 | Fresh install → first agent running on canvas | < 5 min |

### Non-goals for v1

macOS/Linux QA (must still compile and pass `pnpm run check`), SSH/remote hosts on the canvas, auto-merging branches, multi-user, hosting models ourselves, a mobile companion.

---

## 2. Why this is tractable on emdash (what already exists)

These are verified in the source, not assumed:

| Need | Existing emdash piece |
|------|----------------------|
| Parallel agents in isolated worktrees | Tasks = worktree + conversations; `tasksWireContract.createTask` (`src/core/features/tasks/api/wire-contract.ts`) |
| Spawn an agent with a prompt programmatically | `TaskConfig.initialConversation { provider, initialPrompt, initialQueue, autoApprove, model, type: 'pty' \| 'acp' }` (`src/core/primitives/tasks/api/task-config.ts`) |
| Send follow-up input to a running TUI agent | terminals `sendInput` (`src/core/features/terminals/api/wire-contract.ts`) + prompt-injection helper (`api/browser/pty/prompt-injection.ts`) |
| Send a prompt to a structured (ACP) agent | ACP `sendPrompt` (`packages/core/src/runtimes/acp/api/contract.ts`) |
| Know what each agent is doing | `TuiAgentState { status: idle\|working\|awaiting-input\|error\|completed, notificationType, lastAssistantMessage }` via provider hooks (`packages/core/src/runtimes/tui-agents/api/schemas.ts`); Claude, Codex and others have hook adapters in `packages/plugins/src/agents/impl/*/hooks.ts` |
| Terminals that can be re-parented into any DOM node | `FrontendPty.mount()/unmount()` keeps one xterm per session alive off-screen (`src/core/features/terminals/api/browser/pty/pty.ts`) |
| 20+ agent CLIs detected and wired | `packages/plugins/src/agents/impl/*` |
| Diff review, PRs, notifications, secrets store, command palette, keybindings, settings, DB migrations | Existing slices and primitives |
| Windows build + release pipeline | `release-prod.yml` `release-win` job, `electron-builder.config.ts` |
| Mic permission plumbing (macOS only today) | `src/main/bootstrap/boot/phases/background.ts` |

What does **not** exist: any canvas, any speech capture/STT/TTS, any LLM-driven orchestration, and session persistence across app restarts on Windows (tmux is disabled on local Windows, per `agents/workflows/worktrees.md`).

---

## 3. Fork and upstream strategy

emdash ships ~10 merges a day. If we edit its core files freely we'll be buried in conflicts within a month.

- **Rule:** all new behavior lives in three new vertical slices (`canvas`, `voice`, `conductor`) that follow the repo's slice conventions (`api/`, `node/`, `browser/`, `contributions/`). Existing files are touched only at the registration seams listed below.
- **Allowed seam edits** (expect trivial conflicts only):
  - `src/core/manifests/browser/view-catalog.ts`, `browser-contributions.ts`, `app-scoped-stores.ts`
  - `src/core/manifests/node/controllers.ts`, `src/core/manifests/shared/desktop-wire-contract.ts`, `command-catalog.ts`, `command-palette-catalog.ts`
  - Drizzle schema + a new generated migration
  - `electron-builder.config.ts` (app id, name, icons), `app-identity` primitive (branding)
  - One main-process permission handler for `media` on the main window session (§5.1)
- **Sync:** `upstream` remote; merge `upstream/main` weekly; CI runs `pnpm run check` plus our canvas/voice/conductor suites on `windows-2022`.
- **Licensing:** keep `LICENSE.md` and add a `NOTICE` crediting emdash; rename the product (app id, name, icons, update feed) so we don't collide with emdash's auto-updater or trademark.
- **Upstreaming:** generic improvements (e.g. Windows fixes) go upstream as PRs, which shrinks our diff.

---

## 4. Architecture

```
Renderer (React 19 + MobX)                      Main process (Node)
┌──────────────────────────────┐                ┌───────────────────────────────────┐
│ canvas slice                 │  Wire RPC /    │ canvas node: boards/nodes repo    │
│  React Flow board            │  live models   │ conductor node:                   │
│  AgentTile (live xterm |     │◄──────────────►│  LLM client (Anthropic API)       │
│   preview | ACP chat)        │                │  tool executor → existing ops     │
│  PlanCard, NoteCard, DiffCard│                │   (createTask, sendInput,         │
│ voice slice                  │  audio frames  │    sendPrompt, agent status, git) │
│  mic capture (AudioWorklet)  │ ─MessagePort──►│ voice node: STT engines           │
│  VAD, PTT, HUD, TTS          │                │  (Deepgram | OpenAI | whisper.cpp)│
└──────────────────────────────┘                └───────────────────────────────────┘
                                                  existing: tasks, terminals, ACP,
                                                  tui-agents hooks, git, SQLite
```

Principles:
- **API keys never enter the renderer.** STT and LLM calls run in main, with keys in the existing `secrets` primitive.
- **The conductor calls only existing domain operations**, so it has no side door that skips emdash's lifecycle, tombstone or worktree rules.
- **Voice is an input method, not a separate mode.** Anything you can say, you can also type into the conductor bar (`Ctrl+K`, then `>`). That makes testing deterministic and gives users who don't want voice full access.

---

## 5. Workstreams in detail

### 5.1 Canvas slice (`src/core/features/canvas/`)

**Library: `@xyflow/react` (React Flow, MIT).** Rejected: tldraw (production use needs a paid license key; its whiteboard model fights DOM-heavy nodes) and a custom canvas (weeks spent rebuilding selection, minimap and viewport math).

**Data model** (new Drizzle tables; desktop-owned entities per `agents/architecture/state-ownership.md`):

```
canvas_boards(id PK, project_id NULL, name, viewport_json, created_at, updated_at, deleted_at)
canvas_nodes(id PK, board_id FK, kind, ref_id NULL, x, y, w, h, z, collapsed, label, meta_json, updated_at)
  kind ∈ agent | terminal | group | note | plan | diff
  ref_id → conversation id (agent/terminal), task id (group/diff), plan id (plan)
```
One board per project by default, plus an "All projects" board. A new conversation in a task auto-adds a tile to that project's board; closing a tile ≠ deleting the conversation.

**Tile types**
- **AgentTile** (the core one): header shows spoken name ("Codex‑2"), provider icon, branch, status pill driven by `TuiAgentState.status`, attention badge when `notificationType ∈ ATTENTION_NOTIFICATION_TYPES`, and a one-line `lastAssistantMessage`. The body has three levels of detail:
  - **Live**: the real `FrontendPty` mounted into the tile via `mount()`. Only when effective zoom is 1.0 (±0.02) and the tile is on screen, capped at N live tiles (default 6, least-recently-focused get demoted).
  - **Preview**: a read-only DOM `<pre>` of the last ~40 visible buffer lines (read from the same xterm buffer, ANSI colors mapped to spans), refreshed at ≤ 4 Hz while the agent is working and not at all while it's idle. Cheap and fine under CSS scale.
  - **Glyph** (zoom < 0.35): header and status only.
  - ACP agents render `@emdash/chat-ui` in live mode, and their last message in preview.
- **GroupTile**: a frame around all tiles in one task/worktree, with branch name and diff stats (+/−, files).
- **PlanTile**: the conductor's proposed decomposition, with Approve / Edit / Cancel (§5.3).
- **DiffTile**: opens the existing diff review for a task. We reuse it, not rewrite it.
- **NoteTile**: markdown sticky; a note can be dragged onto an agent to send its text as a prompt.

**Interaction**
- Double-click a tile or say "focus X": the viewport animates to zoom 1.0 centered on it and it goes live with keyboard focus. `Esc` gives focus back to the canvas.
- "Open in panes": jumps to the existing task view for deep work (editor, full diff).
- `Ctrl+Tab` / "next" cycles tiles needing attention, ordered by oldest attention first.
- Auto-layout for spawned agents: grid next to the originating PlanTile. No graph-layout library in v1.

**Why the zoom rule exists (tested in spike S1):** xterm.js computes mouse and selection coordinates from unscaled cell metrics, so a CSS `scale()` on an ancestor breaks click-to-position and selection. React Flow zooms by CSS transform. Snapping to zoom 1.0 for interaction avoids the whole problem. S1 also tests the alternative (keep the tile unscaled and set `fontSize = 13 × zoom`) in case it feels better.

**Registration:** `contributions/views.ts` (`defineView('canvas')`), `commands.ts` (focus/next/arrange/new-note), `mementos.ts` (last board, per-board viewport), manifests as in §3. The canvas becomes the default home view, set by a setting; the task-list sidebar stays.

### 5.2 Voice slice (`src/core/features/voice/`)

**Capture (renderer)**: `getUserMedia({ audio: { echoCancellation, noiseSuppression } })` → `AudioWorklet` resampling to 16 kHz mono Int16 → 20 ms frames → a dedicated `MessagePort` to main (the preload already brokers ports via `requestWirePort`; spike S3 picks between a Wire binary stream and a raw port by latency).

**Activation modes**
- **Hold-to-talk in app**: default `Right Ctrl` (configurable). Uses keydown/keyup in the renderer, via the keybindings primitive.
- **Global toggle**: `Ctrl+Alt+Space` via Electron `globalShortcut`. `globalShortcut` has no key-up event, so a true global hold-to-talk would need a native hook (`uiohook-napi`). That's deferred to P5, and v1 uses toggle + VAD auto-stop globally.
- **Hands-free** (opt-in): Silero VAD (`@ricky0123/vad-web`, ONNX in the renderer) for endpointing, plus a wake phrase later. Off by default, because an always-hot mic in a room with meetings is a footgun.

**STT engines** behind `interface SttEngine { open(opts): SttStream }` in `voice/node/engines/`:

| Engine | Why | Notes |
|--------|-----|-------|
| Deepgram streaming (Nova) | Lowest latency partials; keyword boosting | BYO key |
| OpenAI realtime transcription | Good accuracy; many users already have a key | BYO key |
| whisper.cpp `whisper-server.exe` sidecar | Offline/private; Vulkan build runs on any GPU | Ship small.en (~470 MB) as an optional download, not in the installer |

- **Vocabulary biasing** is the biggest accuracy lever for developer speech. Per utterance, send agent spoken names, provider names, current branch names, top-level dirs and `package.json` script names as keywords (Deepgram) or prompt text (Whisper/OpenAI).
- **Windows mic privacy:** on `NotAllowedError`, show a card with a button that opens `ms-settings:privacy-microphone`. Also add the main-window `setPermissionRequestHandler` allowing `media` for our own origin only. The browser-profile sessions keep denying.

**Routing a transcript** (`voice/browser/router.ts`):
1. A tile is focused **and** the dictation modifier is held (`Shift` + PTT): the text is typed into that agent's input and not submitted. Saying "send it" or pressing Enter submits. This is plain dictation, no LLM.
2. Otherwise: send to the conductor, with context (focused tile, visible tiles, selection).

**TTS**: `speechSynthesis` (Chromium on Windows uses the installed OneCore/SAPI voices, offline, free). It only speaks short conductor replies and attention events, never agent output wholesale. Pressing PTT cuts TTS off immediately (barge-in). A per-event mute matrix lives in settings.

**Voice HUD**: bottom-center pill with the states `idle → listening (live partials) → thinking → acting (action preview) → speaking`. It's what makes voice trustworthy (§5.3 confirmations).

### 5.3 Conductor slice (`src/core/features/conductor/`)

The LLM agent that turns intent into operations. It runs in main.

**Model backend**
- Default: Anthropic Messages API with tool use. `claude-haiku-4-5` for the fast path (single-tool commands), `claude-sonnet-5` for planning. Cache the system prompt and tool definitions with prompt caching. Key in the secrets store.
- Alternative (spike S5): drive the user's installed `claude` CLI headless (`claude -p --output-format stream-json`) so people with only a subscription can use it. Expected to be too slow for direct commands (process start) but fine for planning. If so, v1 ships as "commands need an API key, or fall back to the deterministic grammar below."
- **Deterministic fast path, before any LLM:** a small grammar that handles the ~15 most common forms with zero latency and zero cost: `focus <agent>`, `next`, `approve`/`deny`, `stop <agent>`, `send it`, `tell <agent> <text>`, `status`, `mute`. Agent names match fuzzily (phonetic + edit distance) against the live roster. An eval set (§9.3) keeps it honest.

**Tools** (zod schemas; every executor calls an existing operation):

| Tool | Executes | Side effect | Confirmation |
|------|----------|-------------|--------------|
| `list_agents` | task/conversation lists + `TuiAgentState` | none | none |
| `get_agent_detail(agent)` | last N transcript lines / `lastAssistantMessage` / diff stats | none | none |
| `focus(agent)` / `arrange(layout)` | renderer canvas command | UI only | none |
| `send_message(agent, text)` | PTY: `buildPromptInjectionPayload` (portable primitive in `src/core/primitives/prompt-injection/api/`; the `pastePromptInjection` wrapper is renderer-only) → PTY input from main; ACP: `sendPrompt` | yes | 1.5 s cancel window in the HUD |
| `interrupt(agent)` | ESC to PTY / ACP cancel | yes | cancel window |
| `respond_permission(agent, allow\|deny)` | keystrokes to the agent's permission prompt | **high** | show the exact prompt text; needs an explicit "yes"/click |
| `propose_plan(goal, subtasks[])` | creates a PlanTile | none | n/a |
| `spawn_agents(planId)` | `createTask` × N with `initialConversation` | **high** (worktrees, spend) | plan approval (default on; per-project "auto-approve plans" setting) |
| `check_conflicts(agents[])` | `git merge-tree --write-tree` between branches, read-only | none | none |
| `archive_agent(agent)` | existing archive mutation (keeps worktree) | yes | explicit confirm |

Deliberately **not** tools in v1: delete worktree/branch, push, merge, open PR. Those stay user clicks in the existing UI.

**Planning quality** (what M7 depends on)
- Context pack per project, cached and refreshed on HEAD change: top-level tree (depth 2), `package.json`/`pyproject` scripts, README head, and recent `git log --stat` (touched-path hot spots).
- The plan schema requires, per subtask: `title`, `provider`, `prompt`, `ownedPaths[]` (glob), `acceptance` (command to run, e.g. `pnpm test src/settings`). The system prompt asks for subtasks with disjoint `ownedPaths`, and the executor rejects plans whose globs overlap unless a subtask is marked `sequential_after`.
- Each spawned agent's prompt gets a standard suffix: its owned paths, "don't edit outside these without saying so", and the acceptance command.
- **Conflict radar**: while ≥ 2 agents from one plan are active, run `check_conflicts` when an agent goes idle/completed. Predicted conflicts show as a red edge between tiles and a spoken heads-up.

**Addressing agents by voice:** every agent gets a unique short spoken name at creation (`<Provider>-<n>` by default, renameable: "call this one Auth"). The resolver order is: exact/phonetic name → focused ("this one") → ordinal/visual ("the top left one") → a clarifying question. It never guesses between two candidates.

**Persistence and audit:** a `conductor_turns` table stores utterance, transcript, tool calls, results and cost per board. It shows as a collapsible log panel, so "why did it do that?" always has an answer.

**Budget guards:** max concurrent agents (default 4), a per-day conductor token budget with a meter in the HUD, and a model-cost readout on PlanTiles before approval.

### 5.4 Windows hardening

| Issue | Action |
|-------|--------|
| Long paths (hit while cloning emdash: checkout failed until `core.longpaths=true`) | Doctor check and one-click `git config --global core.longpaths true`; default worktree root to a short path (e.g. `%USERPROFILE%\.chorus\wt`) |
| No tmux → agents die when the app quits | v1: the existing quit confirmation (`src/renderer/app/app-shutdown-lifecycle.tsx`) already counts running agent sessions — extend it to name them; resume via provider session resume (the existing TUI resume path). v2 (P5): detached PTY-host process that outlives the UI and reattaches |
| Defender real-time scanning slows worktree creation and installs | Detect a slow `git worktree add`; show a guide for the user to add an exclusion (we never change security settings ourselves) |
| ConPTY quirks in bracketed paste and multi-line prompt submit | Spike S6: validate prompt injection into Claude Code/Codex/Gemini on ConPTY; fixes go upstream |
| SmartScreen warnings | Azure Trusted Signing in the release job |
| Native modules (node-pty, better-sqlite3) on dev machines | `pnpm run doctor` already exists; document VS Build Tools only if prebuilds fail |
| Mic privacy toggle | §5.2 deep-link card |
| HiDPI / mixed-DPI monitors | Include 150 % and mixed-DPI in manual QA for xterm cell metrics on the canvas |

---

## 6. Spikes (P0) with decision gates

Each spike is time-boxed, produces a short written result in `docs/chorus/spikes/`, and has a pre-agreed fallback.

| Spike | Question | Box | Pass → | Fail → |
|-------|----------|-----|--------|--------|
| S1 | Can xterm tiles be interactive on a zoomable React Flow canvas? Compare snap-to-1.0, fontSize scaling, and raw scale | 2 d | chosen approach | snap-to-1.0 only (already the default) |
| S2 | 16 tiles (4 live DOM xterms + 12 previews) at ≥ 55 fps on an iGPU laptop? | 2 d | proceed | lower live cap to 3; preview at 2 Hz; glyph earlier |
| S3 | Audio transport renderer→main: added latency and CPU | 1 d | pick transport | STT client in a utility process with a key-scoped proxy |
| S4 | STT accuracy/latency on 50 recorded dev utterances (code words, agent names), Deepgram vs OpenAI vs whisper small.en Vulkan | 2 d | choose default engine | default to whichever wins; biasing required if WER > 10 % |
| S5 | `claude -p` headless as conductor backend: latency, tool calling | 1 d | offer subscription mode for planning | API-key-only for the conductor |
| S6 | Prompt injection into Claude Code/Codex/Gemini TUIs on ConPTY (multi-line, while busy, at a permission prompt) | 2 d | reuse `prompt-injection` as-is | per-provider injection strategies in plugins |

---

## 7. Phases, deliverables, exit criteria

Estimates assume one engineer working with coding agents (i.e. heavy use of this very tool). Weeks are calendar weeks.

**P0 — Foundation and spikes (1.5 wk)**
- Fork, rebrand (app id/name/icons/update feed off), `pnpm install && pnpm run dev` on Windows 11, `pnpm run check` green on `windows-2022` CI.
- Baseline: measure startup, memory with 4 agents.
- Spikes S1–S6.
- *Exit:* fork builds and packages an unsigned installer; spike reports written; §5 decisions updated.

**P1 — Canvas MVP (3 wk)**
- DB tables + migration; canvas slice; AgentTile (live/preview/glyph), GroupTile, NoteTile; focus/next/arrange commands; auto-add tiles for new conversations; persistence.
- *Exit:* M5 and M6 met; Playwright tests: create board, spawn fixture agent, focus, type, zoom out/in, restart app, layout restored.

**P2 — Voice input (2 wk)**
- Capture, PTT, the chosen STT engine plus one alternative, vocabulary biasing, HUD, dictation into the focused tile, TTS for attention events, mic permission UX.
- *Exit:* dictation p50 ≤ 1.2 s; WER ≤ 8 % on the S4 set with biasing; works with a USB headset and a laptop mic.

**P3 — Conductor (4 wk)**
- Fast-path grammar; LLM tool loop; all tools in §5.3 with confirmations; PlanTile + `spawn_agents`; conflict radar; `conductor_turns` log; budget guards.
- *Exit:* M1, M3, M4 on the eval set; M7 on the 10 benchmark goals (§9.3); no tool bypasses existing operations (code review checklist).

**P4 — Windows hardening and packaging (2 wk)**
- Everything in §5.4 marked v1; signing; first-run onboarding (pick agents detected on PATH, pick STT, test mic, say "hello").
- *Exit:* M8 on a clean Windows 11 VM; no SmartScreen block on the signed build.

**P5 — Beta (2 wk) + backlog**
- 5–10 external users, telemetry (opt-in, existing telemetry slice), bug burn-down.
- Backlog, roughly by value: persistent PTY host (agents survive quit); global hold-to-talk (`uiohook-napi`); wake word; multi-window boards across monitors; SSH hosts on canvas; "integrate" flow that stacks plan branches into a merge-preview worktree.

**Total to beta: ~14.5 weeks.** The biggest schedule risk is P3 (prompt/eval iteration is open-ended). It's time-boxed by the eval targets, not by features.

---

## 8. Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Upstream churn breaks our seams | High | Med | Seam-only edits (§3); weekly merges; CI on every merge |
| xterm-on-canvas feels bad | Med | High | S1; snap-to-1.0 default; "open in panes" escape hatch |
| Misrecognized voice command does damage | Med | High | No destructive tools; cancel windows; permission answers need explicit confirmation; resolver never guesses |
| Provider TUIs change prompts/hooks | High | Med | Rely on emdash's maintained plugins; injection lives in plugins; fixture tests per provider |
| Planner splits produce conflicting branches | Med | Med | `ownedPaths` disjointness validation; conflict radar; sequential subtasks |
| LLM/STT cost surprises users | Med | Med | Local STT option; Haiku fast path; grammar before LLM; budget meter |
| Agents lost on app quit (Windows) | High | Med | Quit guard + provider resume in v1; PTY host in P5 |
| Solo-dev bandwidth | High | High | Strict non-goals; spikes gate scope; fixtures instead of live LLMs in CI |

---

## 9. Testing and evaluation

### 9.1 Unit and integration
Vitest per the repo's projects (`node`, `main-db`, `browser`): canvas repo/migrations (`pnpm run test:migrations`), LOD state machine, router, grammar, name resolver, tool executors with mocked operations, plan validation (overlapping globs rejected).

### 9.2 End-to-end
Playwright browser tests (`src/renderer/tests/browser/`) using emdash's fixture providers (`packages/plugins/src/agents/acp-fixture-driver.ts`) so no real LLM runs in CI. Voice E2E feeds WAV files into the capture pipeline through a test-only injection seam.

### 9.3 Eval sets (checked into `docs/chorus/evals/`)
- **Routing (200 utterances):** text + roster snapshot → expected tool call(s) and target. Covers fillers ("uh"), homophones ("Codex to" vs "Codex two"), deictics, and ambiguous names (expected: clarifying question). CI runs it with the grammar plus a recorded-response LLM mock; a nightly job runs it against the live model and tracks drift.
- **STT (50 recordings, 3 speakers, 2 mics):** WER and latency per engine.
- **Planning (10 goals on 3 sample repos):** plan validity, disjointness, % conflict-free merges after agents finish (the M7 run is manual, weekly during P3).

---

## 10. First concrete steps (day 1–2)

1. Move the clone out of the scratch workspace into a permanent folder; add `upstream`; create the `chorus/main` branch.
2. `git config core.longpaths true`, `pnpm install`, `pnpm run doctor`, `pnpm run dev` — record any Windows setup friction.
3. Rebrand the app id/name and disable the update feed so a dev build can't pull emdash updates.
4. Start S1 (canvas + xterm) and S6 (ConPTY injection); they carry the most technical risk.

---

## Revision log and scoring

Scored against: **grounding** (is it tied to real code?), **completeness** (canvas, voice, orchestration, Windows, shipping), **specificity** (could an engineer start tomorrow?), **risk handling**, **measurability**, and **realism**.

- **v1 — 5/10.** Outline of three features plus phases. No success metrics. Assumed live terminals would just work on a zoomable canvas. No upstream-sync strategy for a repo merging ~10 PRs/day. Didn't notice that tmux is disabled on Windows, so agents die with the app. "LLM orchestrator" with no tool contract or safety model. No estimates.
- **v2 — 7/10.** Added metrics M1–M8, a tool table tied to real operations (`createTask`, `sendInput`, `sendPrompt`, `TuiAgentState`), the seam-only fork rule, and the level-of-detail tile model. Still weak: unknowns stated as decisions, `globalShortcut` assumed to support hold-to-talk (it has no key-up), API keys implicitly in the renderer, no eval method behind M3/M7.
- **v3 — 8/10.** Added time-boxed spikes with fallbacks, main-process-only secrets, the toggle-vs-hold distinction, the deterministic fast path, vocabulary biasing, `ownedPaths` + conflict radar, and eval sets. Still weak: no data model, confirmation policy scattered, Windows issues listed without actions, phases without exit criteria, no audit trail.
- **v4 — 9/10.** Added the Drizzle data model, a per-tool confirmation policy with an explicit deny-list, the Windows table with concrete actions (including the long-path failure seen in practice), exit criteria per phase, the `conductor_turns` audit log, budget guards, and day-1 steps.

**Why not 10:** the schedule hasn't been tested against real velocity on this codebase; three core UX choices (snap-to-1.0 interaction, default STT engine, conductor backend) remain open until S1/S4/S5 run; and M7's 80 % target is an informed guess, not a baseline. After P0 those become facts, and the plan should be re-scored then.
