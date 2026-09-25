# Voice-controlled canvas organization

Status: **plan, not built**. Written 2026-09-25 against `chorus/main` @ `b1fcd607a`.
Owner slices: `canvas` (model, layout, presentation), `conductor` (language → operations),
`browser` (a canvas presenter for browser sessions). Companion to [PLAN.md](PLAN.md) and
[voice.md](voice.md).

---

## 0. Summary

Developers will organize the canvas by talking to it: move and resize windows, group them into
named **regions** that can nest, move windows between regions, and **enter** a region so its
windows fill the screen in a tiled layout at interactive zoom. Everything can be undone, every
voice change is shown before or as it lands, and nothing a layout command does can touch an
agent's process, input, or files.

The design rests on six decisions:

1. **One canvas, nested regions.** A region is a named rectangle on the existing infinite board
   with explicit membership, not a separate board. The spatial overview, minimap, and single
   camera stay intact. (§2)
2. **Two presentations of the same state: Board and Stage.** Board is the free-form spatial canvas
   of today. Stage is a full-screen tiled projection of one region (or an ad-hoc set of windows) at
   zoom 1. Entering a Stage never changes board geometry, so leaving it restores exactly what was
   there. (§3)
3. **Every input compiles to the same typed operations.** Mouse, keyboard, palette, grammar, Jev,
   and Claude all produce `CanvasOp` values. A pure planner turns an op plus current state into a
   `LayoutPlan`; one applier commits it as a single undoable transaction. The model never emits
   coordinates. (§5)
4. **References resolve deterministically, or the system asks.** The existing "never guess
   between two candidates" rule extends from agents to every entity: windows, regions, tasks,
   the selection, and "what I just touched". Clarifications keep the rest of the command. (§6)
5. **Layout is reversible, so it is fast; side effects are not, so they stay gated.** Layout ops
   apply immediately with an Undo affordance; large or low-confidence ones show a ghost preview
   and the existing 1.5 s countdown. Agent side effects keep today's tiers unchanged. (§8)
6. **Undo is for layout, Back is for navigation.** Two stacks, two verbs, never mixed. (§4, §7)

---

## 1. What exists today (grounding)

Verified in source; the plan builds on these and changes them only where stated.

| Area | Today | File |
| --- | --- | --- |
| Board | React Flow (`@xyflow/react`), one app-wide board. Node types `agent`, `note`, `frame`. | `src/core/features/canvas/browser/canvas-board.tsx` |
| Board state | App memento `canvas.board` v2: `viewport`, `tiles` (rect by tile id), `notes`, `spokenNames`, `hiddenConversationIds`, `projectFilter`, `openOnLaunch`, `showTaskFrames`. Debounced writes (1 s), flushed on quit. | `contributions/mementos.ts`, `src/core/primitives/mementos/browser/memento-client.ts` |
| Tiles | Ids `agent:<conversationId>`, `note:<noteId>`. Agents placed by `placeTiles` (grid, no overlap) when first seen. | `api/canvas-model.ts`, `api/browser/stores/canvas-store.ts` |
| Task frames | Derived, not persisted: one frame per task around its agents' bounds; dragging the header moves the task's tiles. | `browser/tiles/task-frame.tsx`, `CanvasStore.taskFrames` |
| Level of detail | Live xterm only at zoom 1 ± 0.02 (xterm mis-targets pointers under CSS scale); preview otherwise; glyph below 0.35; live budget 6. | `canvas-model.ts` (`isInteractiveZoom`, `resolveTileDetail`) |
| Camera | `viewportCommand` (`focus` a tile at zoom 1, or `fit` a set) consumed by the board. | `CanvasStore.requestFocus/requestFit` |
| Voice pipeline | Transcript → `parseCommand` grammar → Jev routing (`DIRECT_INTENTS`) → Claude tool loop (max 8 iterations). | `conductor/api/grammar.ts`, `api/jev.ts`, `browser/conductor-store.ts` |
| Addressing | `resolveAgent`: exact → provider → task → edit distance → phonetic key; visible before hidden; deictics mean the focused tile; ambiguity returns candidates, never a guess. | `conductor/api/resolver.ts` |
| Safety | `requestPending(label, 'countdown' \| 'confirm')`: 1.5 s cancel window or explicit confirm (30 s). `CONFIRM_REQUIRED_TOOLS`, `CANCEL_WINDOW_TOOLS`. Enter confirms only outside text/terminal targets and after a 400 ms grace. | `conductor-store.ts`, `api/tools.ts`, `hud/pending-keys.ts` |
| Close/reopen | "Close" hides a window (agent keeps running); "reopen"/"undo" restores the last closed batch (`lastClosed`). | `conductor-store.ts`, `api/window-targets.ts` |
| Tools | 15 tools, order fixed for prompt caching; new tools are appended. System prompt is byte-stable. | `api/tools.ts`, `api/system-prompt.ts` |
| Context block | Roster, closed windows, focused agent, projects, providers, open plan. | `conductor/browser/roster.ts` (`buildContext`) |
| Browser | Webview-based browser exists only as a **task tab** (`BrowserPane`, sessions keyed by `browserId` with `projectId/workspaceId/taskId`). Not on the canvas. | `src/core/features/browser/` |
| App navigation | `NavigationHistoryStore` (view-level back/forward, 50 entries) with `NavigationParticipant { captureLocation, restoreLocation }` for in-view locations. | `src/core/primitives/navigation/` |
| Zen mode | `toggleZenMode` from the workspace layout context hides chrome. | `workbench/browser/window-scope.tsx` |
| Evals | 200-utterance routing eval (`routing.jsonl`, 200/200). | `docs/chorus/evals/` |
| E2E | Playwright drivers `tooling/chorus/steps/*.mjs` (canvas, frames, commands, conductor, voice…). | `apps/emdash-desktop/tooling/chorus/` |

Gaps this plan fills: no user-defined grouping, no nesting, no persistent layout beyond tile
rects, no focused multi-window view other than "focus one tile at zoom 1", no layout undo, no
browser windows on the canvas, no way to say where something should go.

---

## 2. Object model

```
Board (the one canvas)
├── Region "Frontend"                 ← named, nestable, explicit membership
│   ├── Window  Atlas   (agent)
│   ├── Window  Browser "localhost:5173" (browser)
│   └── Region "Review"               ← nested (max depth 3)
│       └── Window Bravo (agent)
├── Window  Cedar (agent)             ← root-level windows are allowed
└── Note    "check CORS"
```

### 2.1 Windows

A **window** is anything with a rect on the board. Kinds are registered, so browsers and future
kinds (a plain terminal, a diff) plug in without touching the planner:

```ts
// src/core/features/canvas/api/canvas-windows.ts
export type WindowKind = 'agent' | 'browser' | 'note';

export type WindowKindTraits = {
  readonly kind: WindowKind;
  readonly defaultSize: Size;        // agent 720×460, note 320×200, browser 960×640
  readonly minSize: Size;            // agent MIN_TILE_SIZE, browser 480×320, note 200×120
  readonly stageWeight: number;      // share of Stage space: agent 1, browser 1.5, note 0.5
  readonly liveCost: 'terminal' | 'webview' | 'none'; // counts against a live budget
  readonly spokenNoun: string;       // "agent", "browser", "note"
};
```

Tile ids stay as they are and gain one prefix: `browser:<browserId>`. Every window has a spoken
name (§6.2).

### 2.2 Regions

```ts
export type Region = {
  readonly id: string;               // `region:<uuid>`
  readonly name: string;             // unique among regions and windows (§6.2)
  readonly parentId: string | null;  // null = board root
  readonly rect: TileRect;           // explicit; auto-grows to contain members
  readonly collapsed: boolean;       // folded to its header chip; members keep their rects
  readonly color?: RegionColor;      // optional accent, never the only signal
  readonly createdAt: number;
};
```

- **Membership is explicit** (`membership[tileId] = regionId`, absent = root), not inferred from
  geometry. Voice needs "move Atlas into Frontend" to mean the same thing regardless of where
  pixels happen to fall. Geometry is kept consistent with membership by the planner: a member's
  rect is always inside its region's content box, and a region grows to fit.
- **Dragging reparents on drop**: a window dropped with its center inside a region (the deepest
  one) joins it; dropped outside every region it goes to root. The drop target highlights while
  dragging. This matches Figma sections and is what users expect from a mouse.
- **Nesting depth is capped at 3.** Deeper trees are hard to address by voice, and stacked
  headers eat space. The cap is a constant, not a setting.
- **Regions are rigid bodies**: moving a region moves its whole subtree (the current task-frame
  drag code generalizes to this).
- **Collapsed regions** render as a header chip (name, member count, a status summary such as
  "2 working · 1 waiting"). Members keep their rects, stay addressable, and show on the minimap
  as a single block. "Expand Frontend" (board sense) unfolds it; see the verb table in §6.4 for
  how this differs from entering its Stage.
- **Deleting a region never deletes windows.** Members move to the parent at their current
  positions (collisions resolved, §5.4).

### 2.3 Task frames in a world with regions

Task frames remain derived and automatic. A frame is computed per **(task, region)** pair, so a
task split across two regions shows one frame in each, and a frame never crosses a region edge.
Frames are addressable by task name ("the auth task") as a *set of windows*, but they are not
containers: you cannot move a window "into" a task frame. Dragging a frame header still moves the
task's windows in that region.

### 2.4 Browser windows (prerequisite workstream, §11 phase B)

Today a browser exists only as a task tab. On the canvas:

- A browser window is **task-scoped** in v1: `BrowserSessionCreateInput` needs
  `projectId/workspaceId/taskId`, the partition and preview-server list come from the task, and a
  task scope gives the browser a sensible home region. "Open a browser for Atlas" creates one in
  Atlas's task; "put the Atlas preview on the canvas" promotes an existing tab.
- **Single presenter.** A webview, like an xterm, may be mounted in only one place. A session
  shown on the canvas is shown in the task tab as a "Shown on the canvas — bring here" placeholder,
  and vice versa. The canvas store owns a `presenter` map (`tileId → 'board' | 'stage' | 'tab'`)
  that both surfaces respect (§3.3).
- **Interaction follows the xterm rule.** Under CSS scale a `<webview>` mis-targets input the same
  way xterm does. Browser windows are live and interactive only at zoom 1 (Board focus or Stage);
  otherwise they show the last `capturePage()` snapshot, refreshed at most every 5 s while
  visible and never while hidden. Live webviews have their own budget (default 2 on Board; Stage
  exempts what it shows, up to its page size).
- `BrowserPane` depends on `usePaneContext` and `usePreviewServers` from the task composition. A
  thin `CanvasBrowserPaneHost` supplies both for the canvas instead of forking the pane.
- Spike S8 (§11) confirms webview behaviour under React Flow's transform before any of this is
  built.

---

## 3. Presentations: Board and Stage

### 3.1 Board

The current canvas: free-form geometry, pan/zoom, minimap, level-of-detail tiles, plus region
nodes (rendered below windows, above task frames, header strip takes pointer input like frames
do today). The camera moves only when the user asks (§7.3).

### 3.2 Stage

A **Stage** is a full-screen, tiled, zoom-1 view of a set of windows:

- **Region Stage**: "open Frontend", "full screen Frontend". Shows the region's direct members
  and, by default, members of nested regions flattened in reading order (setting on the region:
  `stageIncludesNested`, default on).
- **Selection Stage**: "put Atlas and Bravo side by side full screen", "focus on these". Shows an
  ad-hoc set. It can be saved as a region ("keep this as Review").
- **Solo Stage**: "maximize Atlas". One window filling the stage.

Properties:

- The Stage is a **projection**. It reads board state and writes only its own `stageLayouts`
  entry. Leaving restores the board viewport and selection exactly.
- It renders in a separate layer (`browser/stage/canvas-stage.tsx`), not inside React Flow: no CSS
  transform, so terminals and webviews take pointer input natively and the zoom-1 rule is
  satisfied by construction.
- The Board stays mounted underneath (`inert`, `aria-hidden`) so returning is instant. Windows
  owned by the Stage render as lightweight placeholders on the Board (§3.3).
- **Full screen** means the Stage fills the canvas view's main panel. "Full screen" / "immersive"
  also enters zen mode (existing `toggleZenMode`), and leaving the Stage leaves zen only if the
  Stage turned it on. Electron window-level full screen is out of scope.
- A Stage has a thin header: breadcrumb (`Canvas › Frontend › Review`), window chips in pane
  order, page indicator, Undo, and Exit.

### 3.3 Presenter ownership (terminals and webviews)

`FrontendPty.mount()` re-parents one xterm per session; a webview has one DOM home. The store
keeps `presenterOf(tileId): 'board' | 'stage' | 'tab'`:

- Entering a Stage claims its windows. The Board renders them as a "On stage" placeholder with the
  window name, not a preview, which saves the preview cost as well.
- Leaving the Stage releases them; the Board re-mounts them with the normal live budget.
- The task view's terminal/browser tabs check the same map, so the canvas and the task view never
  fight over one session. (Today they coexist because the task view unmounts when the canvas
  shows; the map makes that explicit before browsers make it matter.)

### 3.4 Stage layout engine

The Stage arranges N windows in the available rect (W×H px, zoom 1). Layouts are **split trees**
so they are resizable by drag and by voice, and stable across small membership changes:

```ts
export type SplitNode =
  | { type: 'leaf'; tileId: string }
  | { type: 'split'; axis: 'row' | 'column'; ratios: number[]; children: SplitNode[] };

export type StageLayout = {
  readonly template: StageTemplate;  // how the tree was generated
  readonly tree: SplitNode;
  readonly order: readonly string[]; // pane order: reading order, what "the second pane" means
  readonly page: number;
  readonly userAdjusted: boolean;    // ratios touched by the user: keep them on re-layout
  readonly soloTileId: string | null;// a maximized pane within this Stage
};
```

**Templates** (chosen from N, the window weights, and aspect ratio A = W/H):

| N | A ≥ 1.3 (landscape) | A < 1.3 |
| --- | --- | --- |
| 1 | full | full |
| 2 | side by side 50/50 (weighted: browser 60) | stacked |
| 3 | main 60 % + two stacked | main on top + two side by side |
| 4 | 2 × 2 | 2 × 2 |
| 5–6 | 3 × 2 | 2 × 3 |
| 7–9 | 3 × 3 | 3 × 3 |

- **Minimum pane size** is the window kind's `minSize` at 1× device-independent pixels. If the
  template cannot honour it on this screen, the page size drops (9 → 6 → 4 …) and the Stage
  **paginates** ("page 1 of 2"; "next page"). Scrolling Stages were rejected: they recreate the
  zoom/pan problem the Stage exists to remove.
- **Order** is spatial reading order of the windows' board rects (row bands, then x), so the Stage
  looks like the region it came from. Users reorder by voice ("put Bravo first", "swap Atlas and
  Bravo") or drag a pane chip.
- **Re-layout on membership change** preserves `order` for survivors, inserts newcomers at the
  end, and keeps user ratios when the tree shape is unchanged; otherwise it regenerates from the
  template and says so in the HUD ("Re-arranged for 5 windows").
- **Window resize → PTY resize.** Pane size changes resize the PTY (cols/rows) via the existing
  pane-resize hook. Animated transitions use CSS transforms and commit one PTY resize at the end,
  so a layout change does not send a storm of SIGWINCHs to agent TUIs.
- Stage layouts are **persisted per region** (`stageLayouts[regionId]`), so re-entering Frontend
  restores its arrangement. Selection Stages persist only while they are on the navigation trail.

---

## 4. Navigation: where am I, how do I get back

### 4.1 Locations

```ts
export type CanvasLocation =
  | { kind: 'board'; viewport: CanvasViewport; regionScope: string | null }
  | { kind: 'stage'; target: StageTarget; page: number };

export type StageTarget =
  | { kind: 'region'; regionId: string }
  | { kind: 'selection'; tileIds: readonly string[]; label: string }
  | { kind: 'solo'; tileId: string };
```

`regionScope` is the region the board is "looking at" after "go to Frontend" (camera fit), used
as the default context for commands like "make a new region here" and for breadcrumbs.

### 4.2 The canvas trail

- A **trail** (back/forward stack, 50 entries, session-only) records **navigations**: go to a
  region, enter/leave a Stage, focus a window, "show all". It does not record layout edits.
- Verbs: "back" / "go back" (previous location), "forward", "up" / "out" (parent: Stage of
  Review → Stage of Frontend if Frontend includes nested, else Board scoped to Frontend; Board
  scoped to a region → its parent → whole board), "home" / "show everything" (whole board, all
  regions expanded, fit). Keyboard: Alt+← / Alt+→ inside the canvas view, Alt+↑ for up,
  Shift+Esc from a terminal already returns focus to the canvas and then Esc on the canvas (not in
  a terminal) leaves a Stage.
- **App-level history integration**: the canvas registers as a `NavigationParticipant` so that
  leaving the canvas for a task view and pressing the global Back returns to the same Board
  viewport or Stage (`captureLocation`/`restoreLocation`). The trail itself stays canvas-local:
  pushing every in-canvas step into the app history would flood it and make view-level Back
  useless.
- **Breadcrumbs** replace the static "Canvas" in `CanvasTitlebar`:
  `Canvas › Frontend › Review [Stage]`. Each crumb is a button and a navigation target.
- **Persistence**: the current location is stored in the memento; on relaunch the canvas opens
  where the user left it (Stage included, if its region still exists; otherwise the board fit to
  where it was).
- **Stale trail entries** (region deleted, window archived) are pruned the way
  `NavigationHistoryStore.prune` does, and Back skips them.

---

## 5. Operations: one language for every input

### 5.1 The op vocabulary

Defined once with zod in `src/core/features/canvas/api/canvas-ops.ts`, shared by commands, the
grammar, Jev routing, and the conductor's tools.

```ts
type Ref = EntityRef;              // resolved reference (§6): window ids, region id, selection

type CanvasOp =
  // Geometry (mode-scoped: Board edits rects, Stage edits the split tree)
  | { op: 'move'; targets: Ref; to: Destination }
  | { op: 'resize'; targets: Ref; size: SizeSpec }
  | { op: 'arrange'; targets: Ref; layout: ArrangeSpec }      // grid | row | column | stack | tidy
  | { op: 'swap'; a: Ref; b: Ref }
  | { op: 'reorder'; target: Ref; position: 'first' | 'last' | number } // Stage pane order
  // Regions
  | { op: 'createRegion'; name?: string; members?: Ref; parent?: Ref; placement?: Destination }
  | { op: 'renameRegion'; region: Ref; name: string }
  | { op: 'dissolveRegion'; region: Ref }                     // members go to parent
  | { op: 'collapseRegion'; region: Ref; collapsed: boolean }
  | { op: 'reparentRegion'; region: Ref; parent: Ref | 'root' }
  // Visibility (existing semantics: hide, never stop)
  | { op: 'hide'; targets: Ref }
  | { op: 'show'; targets: Ref }
  // Selection (ephemeral, not undoable, not on the trail)
  | { op: 'select'; targets: Ref; mode: 'replace' | 'add' | 'remove' }
  | { op: 'clearSelection' }
  // Navigation (on the trail, not undoable)
  | { op: 'goTo'; target: Ref }                               // Board camera fit / focus
  | { op: 'enterStage'; target: Ref; solo?: boolean }
  | { op: 'leaveStage' }
  | { op: 'back' } | { op: 'forward' } | { op: 'up' } | { op: 'home' }
  | { op: 'page'; direction: 'next' | 'previous' }
  // History
  | { op: 'undo'; count?: number } | { op: 'redo'; count?: number };

type Destination =
  | { kind: 'region'; region: Ref }                           // into
  | { kind: 'relative'; anchor: Ref; side: 'left' | 'right' | 'above' | 'below' | 'next' }
  | { kind: 'slot'; slot: 'top-left' | 'top' | 'top-right' | 'left' | 'center' | 'right'
        | 'bottom-left' | 'bottom' | 'bottom-right' }         // within the current scope
  | { kind: 'nudge'; direction: 'left' | 'right' | 'up' | 'down'; amount: 'bit' | 'some' | 'far' }
  | { kind: 'here' };                                         // current region scope / Stage

type SizeSpec =
  | { kind: 'preset'; preset: 'small' | 'medium' | 'large' | 'wide' | 'tall' | 'default' }
  | { kind: 'relative'; axis: 'both' | 'width' | 'height'; factor: 'bit' | 'more' | 'much' | 'double' | 'half';
      direction: 'grow' | 'shrink' }
  | { kind: 'screen'; fraction: 'half' | 'third' | 'quarter' | 'full'; axis: 'width' | 'height' | 'both' }
  | { kind: 'match'; like: Ref };
```

There are **no absolute coordinates in the vocabulary.** Relative and semantic destinations are
what people say, they are testable, and they keep the model from inventing geometry. Mouse input
produces the same ops with a resolved rect internally (`move` with an `exact` destination that
only the pointer path can construct; it is not in the tool schema).

### 5.2 Constants

| Name | Value | Why |
| --- | --- | --- |
| Grid | 24 canvas units | matches the board's dot grid (`Background gap={24}`) |
| Nudge bit / some / far | 1 / 4 / 12 grid steps | "a bit left" should be visible but small |
| Relative bit / more / much | ×1.15 / ×1.25 / ×1.5 | compounding "bigger, bigger" feels linear |
| Presets | small 480×300, medium 720×460 (= `AGENT_TILE_SIZE`), large 1080×690, wide 1440×460, tall 720×920 | all ≥ `MIN_TILE_SIZE`; browser presets scale by its default |
| Screen fractions | fraction of the current screen size at zoom 1 | "half the screen" means what the user sees |
| Region padding / header | 16 / 32 units | fits inside `TILE_GAP` (48) with a frame |
| Max ops per batch | 12 | mirrors `propose_plan`'s cap |

### 5.3 Pipeline

```
input ─► parse (grammar | Jev | Claude | command | pointer)
      ─► CanvasOp[] with unresolved refs
      ─► resolve refs (§6)          ── ambiguous ─► clarification (§6.5)
      ─► plan (pure)                 ── infeasible ─► explain, no change
      ─► LayoutPlan { patch, displaced, created, removed, cameraHint, summary, tier }
      ─► gate by tier (§8)           ── cancelled ─► nothing changes
      ─► revalidate against current state (§8.4)
      ─► apply as one transaction ─► undo entry, trail entry (nav ops), feedback (§9)
```

- `planCanvasOps(state, ops, env) → LayoutPlan | PlanError` lives in
  `src/core/features/canvas/api/canvas-layout.ts` and is pure: `state` is a plain snapshot of the
  memento plus ephemeral selection/location, `env` carries screen size and live-budget facts. It
  is unit- and property-tested without React Flow, like `canvas-model.ts` today.
- A batch plans sequentially against the evolving snapshot, so "make a region called Review, put
  Atlas and Bravo in it, and open it" is three ops that compose, and the whole batch is one undo
  step.
- `LayoutPlan.patch` is a structural patch of `tiles`, `regions`, `membership`, `stageLayouts`,
  `hiddenConversationIds`: exactly the fields undo needs (§7).

### 5.4 Placement and collisions

Invariant for anything the system places (voice, commands, auto-placement): **siblings do not
overlap** (TILE_GAP / 2 clearance, the same rule `placeTiles` uses). Pointer drags may create
overlap: the user put it there on purpose, and the planner leaves overlaps it did not cause alone.

1. **Into a region**: first free grid slot inside the region's content box in reading order
   (`placeTiles` with the region as the anchor and its width setting the column count). No room →
   the region grows right, then down, to the next grid multiple.
2. **Region growth or a move that lands on siblings** → **push**: overlapped siblings move along
   the axis of least penetration, away from the cause, cascading (bounded to 3 passes and to the
   siblings in the same parent). Regions push as rigid bodies.
3. **Push budget**: if resolving would displace more than 4 windows or move any bystander farther
   than one tile width, the planner instead places the target in the nearest free slot that needs
   no push, and the summary says so ("No room next to Bravo, so Atlas went below it").
4. **Relative destinations** (`left of Bravo`) place adjacent with TILE_GAP, aligned on the shared
   edge; the target joins the anchor's region.
5. **Slots** (`top-right`) are computed within the current scope: the region in `regionScope`, else
   the visible board rect; the target is placed there and pushes per 2–3.
6. Every displaced bystander appears in `LayoutPlan.displaced`, in the feedback, and in the undo
   entry.

These rules are deterministic for a given state; property tests (§12) assert no-overlap and
containment after any random op sequence.

### 5.5 Mode-scoped verbs

Geometry verbs act on what the user is looking at:

| Verb | On the Board | In a Stage |
| --- | --- | --- |
| move X left / to top-right | moves X's rect | moves X's pane (swap with the pane in that position) |
| make X bigger / wide | resizes X's rect | shifts split ratios toward X (clamped to neighbours' min size) |
| side by side / grid | arranges rects inside X's region | re-templates the Stage |
| maximize X | enters a Solo Stage | solos X inside this Stage ("restore" un-solos) |
| move X into Review | reparents X | reparents X; X leaves this Stage if Review is not in it |

The HUD always names the scope in its summary ("Stage: Atlas is now 60 % wide"). Stage edits are
undoable like Board edits.

---

## 6. Addressing and disambiguation

### 6.1 Entities

The resolver input grows from `RosterAgent[]` to an entity roster:

```ts
type RosterEntity =
  | { kind: 'window'; windowKind: WindowKind; id: string; name: string; providerLabel?: string;
      taskName?: string; regionId: string | null; hidden: boolean; rect: TileRect }
  | { kind: 'region'; id: string; name: string; parentId: string | null; memberCount: number }
  | { kind: 'task'; id: string; name: string; windowIds: readonly string[] };
```

`resolveAgent` keeps its current behaviour and tests. A new `resolveEntity` in
`conductor/api/entity-resolver.ts` layers kinds on top of it; agent-only commands continue to call
`resolveAgent` so the 200-utterance routing eval cannot regress.

### 6.2 Names

- **Windows**: agents keep roster names (Atlas, Bravo…). Browsers are "Browser" plus the page's
  host or title when unique ("the localhost browser", "the docs browser"), else a roster-style
  number ("Browser 2"); the user can rename them like agents. Notes are addressed by their first
  words ("the CORS note") or not at all.
- **Regions** are named by the user ("make a region called Review"). Unnamed regions get a name
  from their contents when all members share a task (the task name), otherwise from a separate
  **region roster** of short words chosen to be phonetically distant from the agent roster and
  from each other (checked by `phoneticKey` + edit distance at build time in a unit test).
- **Uniqueness across kinds**: a new region or window name that collides with any entity name, or
  shares a `phoneticKey` with one, is refused with a suggestion ("There is already an agent called
  Cedar. Call the region 'Cedar group'?"). This prevents most cross-kind ambiguity at the source.
- Names are in the STT vocabulary (`vocabulary()` in `roster.ts` gains region and browser names).

### 6.3 Reference forms and resolution order

| Form | Example | Resolves to |
| --- | --- | --- |
| Kind-qualified name | "the Frontend region", "browser two", "Atlas's window" | only entities of that kind |
| Bare name | "Frontend", "Atlas" | any kind; kinds disambiguate by verb (below) |
| Deictic singular | "this", "it", "this one", "here" | focused window; in a Stage, the focused pane |
| Deictic scope | "this region", "here" as a destination | region containing focus, else `regionScope`, else current Stage region |
| Selection | "these", "the selected ones", "the selection" | current selection |
| Anaphora | "them", "those", "it" right after a command | the previous command's targets, if within 60 s |
| Group | "the agents in Frontend", "all browsers", "the auth task", "the waiting ones" | set by predicate |
| Spatial | "the left one", "top right", "the one next to Atlas", "the second pane" | unique within the visible scope only |
| Provider/task | "the codex one", "the auth agent" | existing `resolveAgent` rules |

Order: explicit kind qualifier → exact name (visible before hidden, as today) → verb-compatible
kind filter (a verb that only takes regions, like "open"/"collapse", drops windows from the
candidate set and vice versa for window-only verbs) → deictic/selection/anaphora → group predicate
→ spatial (visible scope only) → fuzzy/phonetic (existing tiers) → clarify.

**"It/them" rule**, fixed and documented: "these/selected" always mean the selection; "it/them"
mean the last command's targets when that command was under 60 s ago, otherwise the focused
window / the selection. When the two candidates differ *and* both are non-empty, "them" asks
("The selection, or Atlas and Bravo that you just moved?").

Spatial references are computed from rects in the current visible scope with a tolerance band;
"the left one" among three windows in a row is the leftmost, and among a 2×2 is ambiguous (two
windows share the left column) → clarify with both names.

### 6.4 Verb lexicon (the ambiguity table)

Chosen so each verb has one meaning per object kind. Grammar, Jev criteria, the system prompt, and
`voice.md` all come from this table.

| Say | Window | Region |
| --- | --- | --- |
| show / go to / look at / zoom to | Board: focus it at zoom 1 (today's `focus`) | Board: fit the region (camera only) |
| open / enter / full screen / expand into | reopen if closed, then focus (today) | **enter its Stage** |
| maximize | Solo Stage (or solo pane in a Stage) | enter its Stage |
| collapse / fold · expand / unfold | n/a → "Windows can't be collapsed; close it?" | fold/unfold on the Board |
| close / hide / dismiss | hide (today) | **clarify**: "Collapse Frontend, or hide its 3 windows?" |
| close (no object) | in a Stage: leave the Stage; else today's rule (focused window, else pending plan) | — |
| delete / remove | today's clarify (close or archive) | dissolve region, windows move to parent (countdown if non-empty) |
| move / put / drag X to Y | move per §5.4 | move region (and subtree) |
| group / make a region (with/for/called) | creates region around targets | creates nested region |
| rename / call | rename | rename |
| select / add / deselect | selection | selects its members |
| back / up / home / next page | navigation | navigation |
| undo / redo / put it back | layout history (§7) | layout history |

"Open" for a region means Stage because that is the only thing you can open a region *into*;
"show" is always camera-only. That split is the main thing the help text teaches.

### 6.5 Clarifications that keep the command

Today a clarification is a question and the user repeats the whole command. For layout, the
conductor keeps a **pending clarification**:

```ts
type PendingClarification = {
  readonly id: number;
  readonly ops: readonly CanvasOp[];      // with one unresolved slot
  readonly slot: string;                  // path of the ambiguous ref
  readonly candidates: readonly RosterEntity[];
  readonly expiresAt: number;             // 20 s
};
```

- The HUD lists numbered choices with context ("1 · Atlas — Claude, Frontend; 2 · Atlas browser —
  Review"), and each candidate gets a numbered badge on the canvas.
- The next utterance first tries to fill the slot: a number ("the first", "two"), a name, a
  distinguishing attribute ("the browser", "the one in Review"), or a click on a candidate. Anything
  else cancels the clarification and is handled as a new command. "Never mind" cancels.
- Only one slot is asked at a time; a second ambiguity asks again after the first is filled.
- Clarifications are not a pending *action*: they do not count down and nothing happens on
  timeout.

### 6.6 Addressability overlay

While push-to-talk is held (after 300 ms, so quick commands don't flash), or on "show names", every
visible window and region shows a large name badge, and Stage panes show their pane number. This
shows what can be addressed, teaches the names, and removes most spatial-reference needs. Setting:
**Show names while listening** (default on). Badges are `aria-hidden`; the same information is in
each node's accessible name (§9.3).

---

## 7. Undo, redo, and history

### 7.1 Scope

**Undoable**: every applied layout transaction: geometry, regions, membership, Stage layouts,
hide/show. Pointer drags and resizes are undoable too (one entry per gesture; a frame/region drag
is one entry).

**Not undoable**: navigation (use Back), selection, and every agent side effect (send, interrupt,
permission answers, stop, archive, spawn). "Undo" after "tell Atlas to run the tests" answers
"I can't unsend a message. The last layout change was moving Bravo; undo that?" and waits for a
yes; it never skips silently past a side effect to undo something older.

### 7.2 Mechanism

```ts
type LayoutHistoryEntry = {
  readonly id: number;
  readonly label: string;                  // "Moved Atlas to Review (pushed Cedar)"
  readonly source: 'voice' | 'typed' | 'pointer' | 'keyboard' | 'command';
  readonly before: LayoutPatch;            // touched fields only
  readonly after: LayoutPatch;
  readonly at: number;
};
```

- Pure module `api/canvas-history.ts`: `record`, `undo(state, entry)`, and `redo(state, entry)`
  over `LayoutHistoryEntry`,
  capped at 100 entries, session-only (layout survives restart; the undo stack does not, which is
  the norm for canvas tools and avoids persisting stale diffs).
- **Conflict-aware undo**: undo applies a field only if its current value still equals
  `entry.after` for that field. Fields the user changed since are left alone, and the reply says
  "Partly undone: Cedar was moved since." This makes undo safe after interleaved pointer edits.
- Redo is cleared by any new transaction.
- The existing `lastClosed` / "reopen" behaviour stays as a separate, narrower verb. Bare "undo"
  now goes to the unified stack, whose hide entries restore closed windows, so today's "undo" after
  a close still works.
- Keyboard: Ctrl+Z / Ctrl+Shift+Z (and Ctrl+Y) when focus is on the canvas, never inside a
  terminal, webview, or text field (reuse `isTextEntryTarget`). Palette: "Undo Canvas Change".
- Voice: "undo", "undo that", "undo the last three", "redo", "put it back". Every applied voice
  op's HUD line carries an **Undo** button for 8 s.

### 7.3 Saved layouts (later phase)

"Save this layout as Review setup" stores a named snapshot of `tiles/regions/membership/
stageLayouts` (max 10, persisted); "restore Review setup" is a normal undoable transaction. Kept
out of the first phases because undo plus regions cover most needs.

---

## 8. Safety and predictability

### 8.1 Hard boundaries

- Canvas ops can only change presentation state. The op runner has no access to `agent-io.ts`;
  sending, interrupting, stopping, archiving, and permission answers remain separate tools with
  today's tiers, whatever batch they arrive in.
- "Close" of a region never hides windows without the clarification in §6.4; deleting a region
  never deletes or hides windows.
- The model cannot emit coordinates or unknown ids: tool input is validated with the zod schemas,
  refs are resolved by `resolveEntity`, and an unresolved ref fails the op with a readable reason
  the model can relay.

### 8.2 Tiers for layout ops

| Tier | When | Behaviour |
| --- | --- | --- |
| **Immediate** | Navigation, selection, and layout changes touching ≤ 4 windows with ≤ 2 displaced bystanders | Apply now; HUD line with Undo; motion shows the change |
| **Preview** | > 4 windows touched, > 2 bystanders displaced, `dissolveRegion` of a non-empty region, `arrange … tidy` over the whole board, any model-originated batch of > 3 layout ops, or a Jev route below the direct-action threshold but above 0.6 | Ghost outlines of the result on the canvas + the existing 1.5 s countdown (`requestPending(…, 'countdown')`); "no"/Esc cancels |
| **Confirm** | none for layout | Layout is always undoable; explicit confirmation stays reserved for irreversible actions |

The threshold values are constants in `canvas-layout.ts` with tests, not settings.

### 8.3 Voice-specific guards

- **Hands-free** still requires the wake phrase; in hands-free mode Preview-tier ops also require
  the wake phrase on "yes" (a room conversation must not confirm a batch).
- **Pointer in flight**: if the user is dragging or resizing (React Flow `dragging`/`resizing`
  flags, or a Stage splitter drag), a voice op waits up to 2 s for the gesture to end, then aborts
  with "You were moving something; say it again."
- **Serial application**: ops apply one transaction at a time; the conductor's existing queue
  already serializes utterances.
- **Camera discipline**: the camera moves only for navigation verbs or when nothing of the result
  is visible *and* the op was voice-initiated; in that case it does not jump but offers "Show"
  (HUD button, and "show me" works for 10 s). Unexpected camera motion is the most disorienting
  thing a voice canvas can do.

### 8.4 Revalidation

Plans are computed from a snapshot. Before applying, the applier checks a per-entity revision
counter (bumped on every write to a tile, region, or membership). If anything the plan touches
changed, it re-plans once from the new state; if the re-plan differs in targets (a window
vanished) it aborts and explains. This covers "an agent was archived during the countdown" and
"the user dragged Atlas while the model was thinking".

### 8.5 Lifecycle edge cases

| Event | Behaviour |
| --- | --- |
| Window's conversation archived / deleted | Membership and Stage leaf pruned on the next `ensureLayout`; if on stage, the Stage reflows and the HUD says "Atlas left the stage (archived)" |
| Window hidden (closed) | Keeps membership, so "reopen" puts it back in its region at its rect (pushing if needed) |
| Project filter excludes members | Region header shows "3 filtered"; the Stage shows only visible members and says why others are missing |
| Region deleted while on its Stage | Stage leaves to the parent location; trail entries for it are pruned |
| New agent spawned | Goes into the "current region": the Stage's region, else the region containing focus, else `regionScope`, else root. Plans (`propose_plan`) create a region named after the plan (short goal text, uniqued) containing their agents, so a plan's agents arrive grouped. Setting: **Group plan agents in a region** (default on). |
| App window resized | Stage re-templates if the page size changes, keeping user ratios where the tree shape holds |
| Memento from a newer app version | Existing versioned-schema `future-version` path: canvas opens read-only for regions and says so |

---

## 9. Feedback and accessibility

### 9.1 Visual

- **Ghost preview** (Preview tier): dashed outlines of each target's destination, arrows from old
  to new position for moved windows, displaced bystanders tinted; region-to-be outlined with its
  name.
- **Motion**: applied changes animate 250 ms (ease-out) on the Board and in the Stage. With
  `prefers-reduced-motion`, changes are instant and each changed window gets a 600 ms outline
  pulse instead.
- **Region chrome**: header with name, member count, status summary, collapse toggle, and "Open"
  (Stage) button; optional accent colour, always paired with the name.
- **Selection**: selected windows get a distinct outline (not the blue focus ring, not the amber
  attention ring) and a toolbar chip "3 selected · Clear".
- **Where am I**: breadcrumbs (§4.2), region outlines on the minimap, and the current Stage's
  region highlighted there.
- **Collisions**: displaced windows flash once; the HUD line names them.

### 9.2 HUD and speech

- The HUD reply line shows the op summary and scope ("Board: moved Atlas into Review, pushed Cedar
  right") with Undo; Preview-tier ops use the existing pending card with the countdown.
- **Speak only what the eyes can't confirm.** Layout results that are visible are not spoken; an
  earcon (short tick) confirms them. Spoken replies are used for clarifications, failures,
  results off-screen, and Preview-tier prompts. Setting: **Speak layout confirmations** (default
  off). This keeps a busy layout session quiet while staying fully usable eyes-free when enabled.
- Replies stay one short sentence, per the existing system prompt rule.

### 9.3 Screen readers and keyboard

- React Flow nodes get `role="group"` and an accessible name built from the entity roster: "Atlas,
  Claude agent, working, in Frontend". Regions get `role="region"` with "Frontend region, 3
  windows, 1 waiting". The Stage is a `role="main"` landmark whose panes are labelled groups with
  their pane number.
- Every applied op's summary goes to the existing `role="status" aria-live="polite"` HUD region;
  clarifications use `aria-live="assertive"` because they block.
- **Full keyboard parity** (voice is an input method, not a mode). With the canvas (not a terminal)
  focused:
  - Tab / Shift+Tab: move focus between windows and regions in reading order; Enter focuses a
    window (zoom 1), Enter on a region enters its Stage.
  - Alt+Arrow: nudge by one grid step; Alt+Shift+Arrow: resize by one grid step.
  - Ctrl+G: group selection into a new region (prompts for a name); F2: rename.
  - Ctrl+Z / Ctrl+Shift+Z: undo/redo. Alt+← / Alt+→ / Alt+↑: back / forward / up.
  - In a Stage: Ctrl+1…9 focus pane N; Ctrl+Alt+Arrow moves the focused pane.
  - Space+drag stays pan; none of these fire inside `.xterm`, webviews, or inputs.
- Palette commands for every op kind with a target picker (region, window), so pointer-free users
  without voice have everything.
- Forced-colors/high-contrast: outlines use `border-style` differences (dashed ghost, dotted
  selection) as well as colour.

---

## 10. Language layers

### 10.1 Grammar (deterministic fast path)

New module `conductor/api/grammar-canvas.ts`, called from `parseCommand` **after** the existing
confirm/reject/next/overview checks and **before** `parseWindowCommand`, returning
`{ kind: 'canvas'; ops: CanvasOp[] } | { kind: 'clarify'; … } | null`. Patterns (with the existing
`clean`, `POLITE`, and filler handling):

- `move|put|drag <ref> (in)to <region>` · `move <ref> (to the) <slot>` · `move <ref> <dir> (a bit|a lot)`
  · `put <ref> (to the) (left|right) of|next to|above|below <ref>`
- `make <ref> (a bit|much)? (bigger|smaller|wider|taller|narrower|shorter)` ·
  `make <ref> (small|medium|large|wide|tall)` · `make <ref> half the screen` ·
  `make <ref> the same size as <ref>`
- `(put|show) <refs> side by side|in a grid|in a row|stacked` · `tidy (up) <ref>?`
- `swap <ref> and <ref>` · `put <ref> first|last`
- `(make|create) a (new)? region|group (called|named) <name> (with|for) <refs>?` ·
  `group <refs> (as|into|called) <name>` · `rename <ref> (to) <name>` · `call this region <name>`
- `collapse|fold|expand|unfold <region>` · `dissolve|ungroup|delete the <region> region`
- `open|enter|full screen|maximize <ref>` · `(go|zoom) to <region>` · `back|go back|forward|up|out|home|
  show everything` · `next|previous page` · `exit|leave (full screen|the stage)` · `restore`
- `select <refs>` · `add <refs>` · `deselect|clear (the)? selection`
- `undo( that| the last <n>)?|redo|put it back`

Reference lists split on "and"/commas and reuse `resolveEntity`. Names inside patterns use the
same longest-match splitting as `splitAddressed` (so "move Claude two to Review" and "move Claude to
Review" behave like today's "tell" commands, including the "to/too/two" rule).

Anything the grammar does not recognise with certainty returns null and flows on; the grammar
never partially executes.

### 10.2 Jev routing

Add two intents to `INTENT_CRITERIA`: `navigate` ("go to, open, enter, leave, or go back between
regions and full-screen views") and `arrange` ("move, resize, group, or rearrange windows or
regions"). Only `navigate` joins `DIRECT_INTENTS`, and only with a single confidently resolved
target, mapping to `goTo`/`enterStage`/`back`/`home`. `arrange` always goes to Claude, since it
needs structured destinations; Jev's value there is sending it with `mode: 'command'` quickly.
The routing questions gain region names in the `target` choice list (bounded by
`JEV_MAX_CHOICE_OPTIONS`, visible entities first).

### 10.3 Conductor tools

Appended after `stop_agent` so the cached prefix is unchanged:

- `describe_canvas {}` (read-only): regions tree with members, current location, selection, Stage
  layout, and spoken names. Used when the context block is not enough.
- `arrange_canvas { ops: CanvasOpInput[] (1–12), reason?: string }`: the §5.1 vocabulary with refs
  as spoken names (`"Atlas"`, `"Frontend"`, `"selection"`, `"focused"`), resolved in the renderer.
  Returns the plan summary, what was displaced, and any per-op failure. Tier per §8.2.

The **context block** (`buildContext`) gains, bounded to ~30 lines: `Location: Stage of Frontend
(page 1/1)` or `Board, looking at Frontend`; `Regions:` one line per region (`Frontend (3): Atlas,
Browser localhost, Review(1)`); `Selection:`; `Last changed: Atlas, Bravo (20 s ago)`.

The **system prompt** gets one paragraph (a one-time cache invalidation on release): regions and
Stage in two sentences, "use arrange_canvas for any layout change; never describe coordinates;
move/resize/group are reversible and need no confirmation; 'open' a region means its full-screen
Stage and 'show' means just the camera; if a reference is unclear, ask".

### 10.4 Evals

- New `docs/chorus/evals/canvas-routing.jsonl`: header line with a roster **and regions** snapshot
  plus location, then ≥ 150 utterances with expected `CanvasOp[]` or `clarify`/`model`. Tags:
  move, resize, arrange, region-create, nesting, navigate, stage, undo, deictic, anaphora, spatial,
  cross-kind collision, homophones ("to Review" vs "two"), fillers, polite forms.
- `routing-eval.test.ts` pattern: grammar-only tier must reach **≥ 95 %** on grammar-tagged lines
  and **100 %** "never wrong" (a line may fall through to `model`, but must not produce a wrong
  op). Model-tagged lines run nightly against the live model with the recorded-response mock in CI,
  per PLAN.md §9.3.
- The existing 200-line agent eval must stay at 200/200.

---

## 11. Implementation plan

Phases are ordered so each ships something usable and nothing depends on voice until the model
underneath is solid. Estimates assume the same one-engineer-plus-agents velocity as PLAN.md.

### Phase 0 — Spikes (3 d)

| Spike | Question | Pass → | Fail → |
| --- | --- | --- | --- |
| S7 Stage remount | Re-parent 6 live xterms from Board to a Stage and back: time, scrollback kept, one PTY resize each | Stage as a separate layer (§3.2) | Render the Stage inside React Flow at zoom 1 with nodes temporarily repositioned |
| S8 Webview on canvas | `<webview>` under React Flow transform: rendering, input at zoom 1, `capturePage` cost | Browser windows per §2.4 | Browser windows show snapshots only on the Board; live only in Stage |
| S9 Op batches from the model | 40 layout utterances through `arrange_canvas` with a draft schema: valid ops, right targets | Schema as drafted | Narrow the schema (drop `slot`/`nudge` from the tool, keep in grammar) |

Results go to `docs/chorus/spikes/` as PLAN.md §6 prescribes.

### Phase A — Layout core and undo (1 wk)

- `api/canvas-ops.ts` (schemas), `api/canvas-layout.ts` (planner, placement, push, presets),
  `api/canvas-history.ts`; unit + property tests.
- Memento `canvas.board` **v3** (upgrade from v2 fills defaults):
  `regions: {}`, `membership: {}`, `stageLayouts: {}`, `browserWindows: {}`,
  `location: { kind: 'board', viewport, regionScope: null }`, `settings: { showNamesWhileListening:
  true, speakLayoutConfirmations: false, groupPlanAgents: true }`.
- `CanvasStore.apply(plan)` transaction entry point; revision counters; pointer drags/resizes
  routed through ops; Ctrl+Z/Ctrl+Shift+Z; keyboard nudge/resize; palette "Undo/Redo Canvas
  Change".
- Split the growing store: `canvas-store.ts` keeps derivation and persistence;
  new `canvas-layout-controller.ts` (apply, undo, revisions) and `canvas-navigation.ts` (trail,
  location) in `api/browser/stores/`.
- *Exit*: every existing canvas Playwright step passes; drag → undo → redo round-trips; property
  tests (10k random op sequences) hold no-overlap-for-placed, containment, and undo∘apply = id.

### Phase B — Browser windows (1 wk, parallel with C after A)

- `browser:` tiles, `CanvasBrowserPaneHost`, snapshot previews, live webview budget, presenter
  map shared with the task tab; "open a browser for <agent>" and "put <agent>'s preview on the
  canvas" as palette commands (voice arrives in D).
- *Exit*: new `tooling/chorus/steps/canvas-browser.mjs`: open, pan/zoom (snapshot), focus
  (interactive), move to the task view and back without a double mount.

### Phase C — Regions (1.5 wk)

- `browser/regions/region-node.tsx` (header, collapse, count/status), drag-to-reparent with drop
  highlight, rigid-body region drag, nested rendering order, minimap outlines, task frames per
  (task, region), region naming + uniqueness, region roster, "Group plan agents in a region".
- Commands: `canvas.region.create` (Ctrl+G), `canvas.region.rename` (F2),
  `canvas.region.dissolve`, `canvas.region.collapse`, `canvas.moveToRegion` (picker).
- *Exit*: `tooling/chorus/steps/regions.mjs`: create, nest (3 levels), reparent by drag, collapse,
  dissolve, restart app and verify restoration.

### Phase D — Stage and navigation (1.5 wk)

- `browser/stage/canvas-stage.tsx`, `api/stage-layout.ts` (templates, split tree, pagination,
  ratio edits), presenter ownership, Board placeholders, zen integration, trail + breadcrumbs,
  `NavigationParticipant`, location persistence.
- Commands: `canvas.enterStage`, `canvas.leaveStage`, `canvas.back`, `canvas.forward`,
  `canvas.up`, `canvas.home`, `canvas.stage.nextPage`.
- *Exit*: `tooling/chorus/steps/stage.mjs`: enter a 4-window region (all live, interactive),
  resize a splitter, leave, board viewport byte-identical to before, re-enter with ratios kept;
  enter/leave p95 < 250 ms with 6 terminals.

### Phase E — Voice (2 wk)

- `conductor/api/entity-resolver.ts`, `grammar-canvas.ts`, pending clarifications, Jev intents,
  `describe_canvas` / `arrange_canvas`, context block, system prompt paragraph, addressability
  overlay, ghost preview, tier gating, pointer-in-flight guard, camera discipline, earcon, HUD
  Undo, spoken-reply policy, vocabulary additions.
- `canvas-routing.jsonl` + eval test; `voice.md` sections "Arranging the canvas" and "Regions and
  full-screen views" generated from the §6.4 table.
- *Exit*: eval targets in §10.4; `tooling/chorus/steps/canvas-voice.mjs` drives typed utterances
  through the HUD ("make a region called Review with Atlas and Bravo", "open Review", "make Atlas
  bigger", "back", "undo") and asserts state after each.

### Phase F — Polish and measurement (1 wk)

- Reduced motion, forced colours, screen-reader pass (NVDA on Windows), keyboard-only walkthrough,
  saved layouts (§7.3), perf with 16 windows in 4 regions (PLAN.md M5/M6 re-measured), telemetry
  (below), PLAN.md §11 status update.

**Total ≈ 8 weeks** after spikes, with B overlapping C.

### File map

```
src/core/features/canvas/
  api/canvas-windows.ts         window kinds and traits
  api/canvas-ops.ts             CanvasOp zod schemas (shared with conductor)
  api/canvas-layout.ts          pure planner, placement, push, tiers
  api/stage-layout.ts           templates, split trees, pagination
  api/canvas-history.ts         undo/redo entries and conflict-aware apply
  api/canvas-location.ts        locations, trail, pruning
  api/*.test.ts                 unit + property tests
  api/browser/stores/canvas-store.ts               (extended: v3 state, entities)
  api/browser/stores/canvas-layout-controller.ts   apply, revisions, undo
  api/browser/stores/canvas-navigation.ts          trail, participant, breadcrumbs model
  browser/regions/region-node.tsx
  browser/stage/canvas-stage.tsx, stage-pane.tsx, stage-header.tsx
  browser/overlays/name-badges.tsx, ghost-preview.tsx
  browser/canvas-breadcrumbs.tsx                   (in CanvasTitlebar)
  browser/tiles/browser-tile.tsx, canvas-browser-pane-host.tsx
  contributions/mementos.ts     v3
  contributions/commands.ts, palette.ts            new commands and aliases
src/core/features/conductor/
  api/entity-resolver.ts        resolveEntity (resolveAgent unchanged)
  api/grammar-canvas.ts         layout/navigation grammar
  api/tools.ts                  + describe_canvas, arrange_canvas (appended)
  api/jev.ts                    + navigate, arrange intents
  api/system-prompt.ts          + one paragraph
  browser/canvas-op-runner.ts   resolve → plan → gate → apply, clarifications
  browser/roster.ts             entity roster, context lines, vocabulary
  browser/hud/clarification-card.tsx
docs/chorus/evals/canvas-routing.jsonl
docs/chorus/voice.md            new sections
apps/emdash-desktop/tooling/chorus/steps/{regions,stage,canvas-browser,canvas-voice}.mjs
```

Seams touched outside the three slices: `command-catalog.ts`, `command-palette-catalog.ts`
(aggregation only), and the browser slice's tab provider for the presenter check. No Drizzle
migration (state stays in the memento, consistent with PLAN.md §11's deviation), no main-process,
PTY, or ACP changes; the PTY resize path is reused, not modified.

---

## 12. Testing strategy

- **Pure units** (`node` project): planner cases per op and destination kind, push resolution,
  region growth, templates per N × aspect, pagination thresholds, ratio edits clamped by min size,
  history conflict handling, trail pruning, resolver forms and precedence (§6.3), region-roster
  phonetic distinctness, memento v2 → v3 upgrade.
- **Property tests** (seeded, 10k sequences): after any sequence of system-placed ops, siblings
  don't overlap and members are inside their region; `undo(apply(s)) == s` on touched fields;
  planning is deterministic (same input, same plan); Stage layouts never produce a pane below its
  kind's min size.
- **Grammar/eval**: §10.4; plus the existing 200-line eval unchanged.
- **Browser tests** (`@vitest/browser`): Stage keyboard navigation, focus management between Board
  and Stage, `inert` Board, reduced-motion path, accessible names.
- **E2E** (`tooling/chorus/steps`): per phase exits above; restart persistence; pointer-in-flight
  abort; revalidation abort when a fixture agent is archived during a countdown.
- **Manual**: NVDA pass, 150 % and mixed-DPI (Stage math in device-independent pixels), a
  30-minute dogfood session with a task list of layout goals, recording every "undo within 10 s".

### Metrics

| # | Metric | Target |
| --- | --- | --- |
| C1 | Grammar-path layout command: transcript → change visible | p95 ≤ 150 ms |
| C2 | Canvas routing eval (grammar-tagged lines) | ≥ 95 % correct, 0 % wrong-op |
| C3 | Voice layout ops undone within 10 s (proxy for misunderstanding) | < 5 % in dogfood |
| C4 | Stage enter/leave with 6 live terminals | p95 ≤ 250 ms, no scrollback loss |
| C5 | Board with 16 windows in 4 regions, pan/zoom | ≥ 55 fps (PLAN.md M5 unchanged) |
| C6 | Layout ops that moved a window the user didn't name, without saying so | 0 |

Telemetry (optional, existing slice, `TELEMETRY_ENABLED` respected): `canvas_op` with `source`,
`op`, `tier`, `clarified`, `undoneWithinMs`; no utterance text, names, or URLs.

---

## 13. Decisions to confirm

Each has a recommendation; building proceeds on the recommendation unless changed.

1. **Nesting depth 3.** Deeper nesting is rare and hurts voice addressing. *Recommend: keep 3.*
2. **Stage includes nested regions by default.** Alternative: direct members only, nested regions
   as a single "Review (2)" pane that opens its own Stage. *Recommend: flatten by default, per-region
   toggle.*
3. **Full screen enters zen mode.** *Recommend: yes for "full screen"/"immersive", no for plain
   "open".*
4. **Browser windows task-scoped in v1.** Free-floating browsers need a partition and preview
   server story outside tasks. *Recommend: task-scoped now, revisit after Phase B.*
5. **Undo stack not persisted.** *Recommend: session-only; saved layouts cover durable recall.*
6. **Plan agents grouped into a region automatically.** *Recommend: on by default, one setting.*
7. **Layout confirmations silent by default (earcon + HUD).** *Recommend: yes; eyes-free users turn
   speech on.*

---

## 14. Worked example

A developer has Atlas and Bravo (Claude) working on auth, Cedar (Codex) on tests, and a browser on
`localhost:5173` for Atlas's task, all loose on the board.

| Says | Parsed as | What happens |
| --- | --- | --- |
| "Make a region called Auth with Atlas, Bravo and the localhost browser" | grammar → `createRegion{name:'Auth', members:[Atlas,Bravo,Browser]}` | 3 windows, 0 displaced → Immediate. Region appears around them (placed as a grid inside), HUD "Board: grouped 3 into Auth · Undo", tick. |
| "Put Cedar next to Auth" | grammar → `move{Cedar, relative: Auth, next}` | Cedar placed right of Auth, aligned to its top. |
| "Open Auth" | grammar → `enterStage{Auth}` | Stage: main-plus-two template (browser weighted to 60 %), all three live at zoom 1; breadcrumb `Canvas › Auth`. |
| "Make the browser bigger" | grammar → `resize{Browser, relative grow}` (Stage scope) | Split ratio 60 → 69 %; PTYs of Atlas and Bravo resize once at the end of the animation. |
| "Move Claude to the left" | resolver: Atlas and Bravo both Claude → clarification | HUD "Which one: 1 · Atlas, 2 · Bravo?", badges 1/2 on panes. |
| "Bravo" | fills slot | Bravo's pane swaps into the left position. |
| "Undo" | history | Bravo back where it was; "Undid moving Bravo." shown, not spoken. |
| "Tell Bravo to run the auth tests" | existing grammar `send` | Unchanged behaviour: 1.5 s countdown, then sent. |
| "Undo" | history, top is not layout | "I can't unsend a message. The last layout change was resizing the browser; undo that?" |
| "No. Go back" | reject, then `back` | Stage closes; board viewport exactly as before "Open Auth". |
| "Collapse Auth and tidy up everything" | model → `arrange_canvas{[collapse Auth, arrange root tidy]}` | Touches > 4 windows → Preview: ghost outlines, 1.5 s countdown, then applied as one undo step. |
