# Canvas Pro: voice-controlled desks

Status: **phase 1 built** (2026-10-10), on `chorus/main` @ `141e543ba`, uncommitted. Desks, the
swap, visitors, gathering desks, edge signals, and the `canvas_desks` voice tool are in and were
driven end to end in the built app. Glass and image backgrounds (phase 2) are not. "As built" at
the end lists the code, what was checked, and what was not.
Companion to [canvas-organization.md](canvas-organization.md) (regions, Stage, sub-canvas
workspaces, multi-canvas) and [voice.md](voice.md).
Owner slices: `canvas` (model, presentation), `conductor` (voice surface), and, for phase 2, the
main-process window host.

---

## 0. Summary

Canvas Pro is a second way to present the canvas. Instead of one board that holds everything,
the developer has many **desks**, sees exactly one at a time, and swaps between them the way macOS
swaps Spaces. Everything is driven by the voice agent; hotkeys come second.

A plain copy of Spaces would hide work: with one desk on screen, an agent waiting on another desk
is invisible. Spaces can live with that because it does not know what its windows are doing.
Maestro does, so desks here are **aware of the work on them**. Three things follow, and they are
what makes this more than virtual desktops:

1. **The edge of the screen points at work that needs you.** A desk out of view with an agent
   waiting or failed lights the screen edge it lies toward, with a chip that goes there. (§5.1)
2. **Windows visit.** "Bring Atlas here" shows Atlas on the desk in view without moving it. You
   answer it; it goes home when you switch desks or say "send it back". Because only one desk is
   ever drawn, a window can be shown anywhere without being mounted twice. (§5.2)
3. **Desks that fill themselves.** A gathering desk collects every window with a given status
   while it is showing: a Triage desk holds whatever needs you right now, and empties itself back
   to the desks those agents live on when you leave. (§5.3)

Whether nobody has built these before is not something this document can vouch for. They are not
in macOS Spaces, Windows virtual desktops, or the tiling window managers this design borrows from,
and they only make sense in a workspace that knows the state of what it holds.

The other decisions:

4. **A desk is a top-level region, shown alone.** The region model, tiling, membership, undo,
   references, and most of the voice surface are reused as they are. Canvas Pro is a presentation
   mode over the same state, not a second data model. (§2, §3)
5. **Switching is a swap.** The other desks are not drawn at all and the camera jumps. (§4)
6. **Glass comes from the operating system** (phase 2). On Windows 11 the window's acrylic
   material shows blurred content behind the window; its blur strength is fixed by Windows.
   Image backgrounds are drawn by the renderer, so their blur is adjustable. (§6)
7. **One new voice tool, `canvas_desks`.** Existing canvas tools keep working on desks. (§7)

### Name: **Desk**

Spoken as "desk"; the grammar also accepts "desktop" and "space".

- It is the developer's own word, shortened: one syllable, said many times a day.
- It does not collide in code. `desktop` already means the Electron app (`emdash-desktop`,
  `desktop-wire`) and `workspace` means a Git worktree.
- It is distinct from **region**, which stays the name for a group of windows *inside* a desk.

Alternatives considered: Scene ("scene/seen" is a homophone), Deck (heard as "desk", "tech"),
Space ("more space" is already layout talk), Room ("give the browser more room" is existing
grammar).

---

## 1. What existed before

Paths are relative to `apps/emdash-desktop/src/core/features/`.

| Area | Before Canvas Pro | File |
| --- | --- | --- |
| Board | One app-wide React Flow board; every window has a rect on it. | `canvas/browser/canvas-board.tsx` |
| State | App memento `canvas.board` v4: `tiles`, `regions`, `membership`, `stageLayouts`, `location`, `panes`, names, notes, browsers. | `canvas/contributions/mementos.ts` |
| Regions | Named rects with explicit membership, nested up to 3 deep. New regions are tiled; a top-level tiled region takes `workspaceSize(screen)` and stays `screenSized`. | `canvas/api/canvas-regions.ts`, `region-tiling.ts` |
| `go_to_region` | `goToRegion(id)` → `navigate` → `requestFrame`: the camera travels to frame the region. Windows outside stay drawn at 30 % opacity. | `canvas-store.ts`, `canvas-board.tsx` |
| `leave_region` | `up()`: Stage → its region → the parent → the main board. Panning or zooming away also leaves. | `canvas-store.ts` |
| Stage | A separate full-screen tiled layer for a region, a selection, or one window. | `canvas/browser/stage/` |
| Voice | `arrange_canvas` (13 step kinds → planner ops, one undoable change), `canvas_view` (stage, regions, back, undo), `describe_canvas`. Names resolve in the renderer. | `conductor/api/` |
| Backgrounds | Opaque everywhere: `body`, the board, the Stage. Opaque `BrowserWindow`, Electron 40. | `renderer/index.css`, `src/main/host/window.ts` |

The sub-canvas workspace work already got most of the way: a screen-sized tiled region that fills
the view at zoom 1 with its windows live. What it lacked was the swap. You travelled to a region
across a board that was still there, dimmed, and you fell out of it by panning.

---

## 2. How desks differ from regions

| | Region | Desk (Canvas Pro) |
| --- | --- | --- |
| Where it lives | A rect on the shared board | A top-level region; its board position is never shown |
| Seeing others | Always there, dimmed while you are inside one | Not drawn. One desk at a time |
| Getting there | Camera travels and frames it | Swap: camera jumps, the node set changes |
| Getting out | Esc, click outside, pan or zoom away, "leave" | You are always on a desk. You switch, you do not leave |
| Order | Reading order of board geometry | Explicit (`order`), shown in the desk strip |
| Loose windows | Allowed at the board root | None. Every window is on a desk |
| Nesting | Up to 3 deep | Desks do not nest. Regions inside a desk still do |
| Chrome | Border, header, tint | None. The name is in the strip; the desk has its own wash of color |
| Other desks' windows | n/a | Can visit (§5.2) |

Unchanged: windows keep running whichever desk is showing; removing a desk never closes or stops
anything; every layout change is one undoable step; the model never sees ids or coordinates.

---

## 3. Data model

### 3.1 The rule

**In Canvas Pro, every region whose parent is the board root is a desk.** There is no separate desk
entity: the role follows from `parentOf(state, id) === null`. Classic mode shows the same regions
on the board as it always did, so switching modes loses nothing in either direction.

The alternative, one independent board per desk, was rejected. It would put a desk dimension under
every read of `tiles`, `regions`, and `membership` in a 2,400-line store, the planner, undo, and
the reference resolver, and macOS desktops are screen-sized, not infinite.

### 3.2 Changes

Memento `canvas.board` **v5** (v4 upgrades with `mode: 'classic'`; no Drizzle migration):

```ts
mode: 'classic' | 'pro'

// RegionState gains
order?: number          // place among desks; a new desk takes the last place
gather?: WindowStatus   // a gathering desk: windows with this status visit while it shows
```

`location` is unchanged. The desk in view is derived (`CanvasStore.activeDeskId`): the top-level
ancestor of the board scope. In Pro the store keeps one invariant, enforced in `navigate` and
`writeLayout`: a board location always names a region, so the user is never "off" a desk.

Because `order` and `gather` sit on `RegionState`, they are part of `LayoutState` and get undo and
redo for free. Visitors are **not** persisted and not in `LayoutState`: they are a projection
(§5.2). The desk that was in view before (`previousDeskId`, for "switch back") is session-only.

A desk refits to the screen when it comes into view (`fitWorkspace`), so one made at another
window size, or before the canvas was measured, still lands at zoom 1.

### 3.3 Planner ops

| Op | Does |
| --- | --- |
| `createRegion { parent: null, gather? }` | A top-level region is a desk. Where desks are ordered it takes the last place |
| `dissolveRegion { region, into }` | New `into`: members go to another region instead of the parent. A removed desk's windows go to its heir |
| `reorderDesk { region, position }` | Renumbers every desk (`first`, `last`, `left`, `right`, or a 1-based place) |

Pure rules live in `canvas/api/canvas-desks.ts`: order, the adjacent desk, a removed desk's heir,
homing loose windows, signals, and visitor layout.

### 3.4 Entering and leaving Pro

- **Entering** (`setMode('pro')`). Top-level regions become desks, in the order the board shows
  them (reading order) unless they were ordered before. Loose root windows are put on a desk
  called **Main**, as one undoable change. With nothing on the canvas, an empty Main is made.
  **Undoing that change also goes back to the classic canvas** (and redo switches again): in Pro
  a window must be on a desk, so the move to Main cannot be undone on its own.
- **Leaving.** Nothing is converted. The desks are regions on the board again.
- **Strays.** A window that ends up on no desk while in Pro (a new note, an undo, a drag outside
  the desk) is put on the desk in view by a reaction, since it would otherwise never be drawn.
  A gathering desk takes no residents: strays and new agents go to Main instead.

---

## 4. Window rendering

### 4.1 One board, filtered

The existing board stays. In Pro:

1. **Node set.** `buildNodes` leaves out everything that is not on the desk in view, apart from
   visitors. Task frames follow their windows.
2. **Camera.** A swap issues the existing `frame` viewport command with `instant`, so the camera
   is set, not animated. While the desk fills the screen at zoom 1 (`deskLocked`), pan, zoom, and
   auto-pan while dragging are off, and `cameraMoved`, `leaveScope`, and `up()` cannot leave the
   desk. `requestFit` frames the desk again instead of fitting a board that is not there.
   Because a locked camera cannot be dragged back, everything that moves the scope or resizes the
   desk under it frames again: stepping out of a region on the desk, focusing a window outside
   the region in scope, and a reaction on the desk's own rect (a window closed, an undo).
   Pointer drops are clamped to the desk in view (`dropRegionAt`): the other desks sit beside it
   on the hidden board and must not catch a drop.
3. **Chrome.** The desk's region node draws no border or header: only what an empty desk says,
   and its name while push-to-talk is held. The minimap and the dot grid are off. The toolbar
   gains the **desk strip**: desks in order, the one in view marked in its color, a status dot
   each, + to add, double-click to rename, × on the one in view to remove. To leave room for it,
   the rest of the bar is icon-only in Pro and drops the per-canvas counts (the strip carries
   them per desk).
4. **Identity.** Each desk has a wash of its region color behind its windows, so desks are
   recognisable at a glance before any text is read. On a swap the wash drifts in from the side
   the new desk lies on; the windows themselves fade in over 160 ms (nothing moves under reduced
   motion). Window tiles are never transformed during the swap: a `<webview>` or an xterm placed
   from a mid-animation rect would stay misplaced.

The Stage, undo, selection, ghost previews, task frames, and nested regions work inside the desk
in view as they did.

### 4.2 Rules that follow from "one desk at a time"

- **Focusing a window brings its desk into view.** `requestFocus` switches desk first, so
  `focus_agent`, the attention jump, and reopen never act on something off screen.
- **New windows** follow the existing settings: the desk in view, or the project's desk
  (`projectRegionId`). With the project setting on, Pro gives one desk per project.
- **Removing a desk** moves its windows to the desk before it, or a named one. The last desk
  stays.
- **A desk too full for one screen** grows past the screen, frames below zoom 1, and unlocks pan
  and zoom. Splitting it is the better answer; the conductor can suggest it.
- **Multi-canvas** is one view in Pro. Each view already remembers its own scope, so "a different
  desk in each view" is a small later addition.

---

## 5. Work-aware desks

### 5.1 Signals at the edges

`deskSignals` (pure) takes the desks in order and the one in view and returns every other desk
with agents waiting or failed, each tagged `left` or `right` by where it sits in the order. The
board draws a soft amber (waiting) or rose (failed) glow down that edge and a chip, "Review ·
1 needs you". Clicking it, or `answerDesk`, swaps to that desk and focuses the agent that has
waited longest there. The desk strip carries the same state as dots, so the signal is never
color alone.

### 5.2 Visitors

`bringHere(tileIds)` adds windows to `visitorIds`. The board then draws them on the desk in view
at rects from `visitorLayout`:

- On a desk with its own windows, the visitors **float** as a group in the middle (78 % of the
  desk), above a scrim that dims the desk. A click on the scrim sends them home.
- On a desk with none (a gathering desk), they fill the whole desk.

Either way they sit in an even grid that never leaves the desk: with many visitors the panes get
smaller. A region's tiling would instead grow past the screen, where a locked camera cannot
follow.

Nothing is written: `CanvasStore.tileRect` answers with the projected rect for a visitor, and the
window's membership and its rect on its own desk are untouched. This is the Stage's rule (a
projection never edits the board) applied to a single window. So there is nothing to undo, no
re-tiling of the desk it came from, and its home is exactly as it was when it returns.

Visitors go home when the desk changes, on "send it back", or on a scrim click. "Keep it here"
(`keepVisitors`) turns the visit into a real move, which is an ordinary undoable layout change.
A visitor cannot be dragged, selected, grouped, or nudged from the keyboard: each of those would
edit the desk it lives on, out of sight. Live app browsers on the desk underneath are hidden
while visitors float, since a live page would paint over them.

### 5.3 Gathering desks

A desk with `gather: 'needs-you'` (or `error`, `working`, `done`, `idle`) takes in, as visitors,
every window with that status that lives on another desk, for as long as it is showing. Windows
already there stay until the desk changes, so an agent does not vanish the moment it is answered.
Leaving the desk sends everyone home.

"Make a desk for everything that needs me" creates one called Triage. It is the same mechanism as
`bringHere`, driven by a status instead of a name.

### 5.4 Not built, same idea

- **Spoken roll call on arrival** when the eyes are elsewhere ("Review: Atlas is waiting on a
  permission, Bravo is running tests").
- **A tone per desk** on a swap, pitched by its place in the order, so you can hear where you
  landed.
- **Status in the glass** (phase 2): the desk's backdrop carries the same amber or rose light as
  the edge signal, so the whole desk shows its state.

---

## 6. Backgrounds (phase 2, not built)

A desk's background is a layer behind the board's nodes. Phase 1 puts the color wash there; phase
2 replaces it with glass or an image.

### 6.1 Glass on Windows

**Approach: the system acrylic material, switched on at runtime.** Electron 40 exposes
`BrowserWindow.setBackgroundMaterial('acrylic' | 'mica' | 'tabbed' | 'auto' | 'none')` on Windows 11
22H2 and later. Acrylic shows blurred live content behind the window. Mica samples only the
wallpaper, so it is not what was asked for.

1. **Main process** (`src/main/host/window.ts`): a small `setWindowGlass(on)` that sets the
   material and makes the window `backgroundColor` transparent, or restores both. Both calls work
   on a live window, so no relaunch. The boot path keeps its opaque anti-flash colour.
2. **Wire:** one procedure in the canvas slice, `setGlass({ enabled })` → `{ supported }`.
3. **Renderer:** an attribute on `<html>` while a glass desk shows. Under it, `body`, the shell
   layers down to the canvas panel, the board, and the Stage go transparent. One opaque ancestor
   defeats the effect, so the first task is an audit of those layers.
4. **Tint:** the theme background at an adjustable opacity over the material, plus the desk's
   color wash.

**Limits:**

- **Windows fixes the blur strength of acrylic.** The glass slider controls tint, not blur.
  Decision: accept that; the adjustable blur is for image backgrounds.
- **Fallbacks.** Windows 10, Windows 11 before 22H2, "Transparency effects" off, battery saver, and
  some remote sessions give no material. Glass falls back to the wash, and the reply says so once.
- **To verify in a spike, not assumed:** whether acrylic survives the window losing focus,
  behaviour when maximized and in immersive Stage, whether a transparent `backgroundColor` is
  required, and the frame cost with six WebGL terminals over moving content.
- **Tiled windows cover the backdrop.** Tiling already leaves a 24 px gutter (60 px with task
  frames) and a 16 px outer inset, which is where glass shows on a full desk. Translucent window
  surfaces are a separate, later decision.

**Rejected:** `transparent: true` windows (creation-time only, cannot be maximized from the title
bar, and give no blur at all), and a native addon on `SetWindowCompositionAttribute` (undocumented
API, new native build).

### 6.2 Image backgrounds

- **Choosing:** by voice the conductor opens the native file picker through main
  (`dialog.showOpenDialog`, as `src/main/core/app/service.ts` already does); also drag and drop,
  and settings.
- **Import, in the renderer:** `createImageBitmap`, downscale to at most 5120 px on the long edge,
  re-encode, hand the bytes to main. No image library is added.
- **Storage, in main:** `<userData>/canvas-backgrounds/<generated id>.<ext>`. The file name is
  kept only as the spoken label. Caps: 40 MB source, 12 images.
- **Drawing:** `background-size: cover`, `filter: blur(<n>px)` on a static layer that overhangs
  the surface by twice the radius, and a scrim for contrast.
- **The slider:** in canvas settings and on the desk strip. By voice in percent: "blur 30", "a bit
  more blur", "no blur".
- **Scope:** one default for every desk, with an optional override per desk.

---

## 7. Voice tool surface

### 7.1 `canvas_desks`

Appended after the last existing tool, so the cached prefix of earlier definitions is unchanged.
It takes spoken names; the renderer resolves them.

| Action | Arguments | Does |
| --- | --- | --- |
| `create` | `name?`, `windows?`, `gather?`, `follow?` (default true) | A new desk, tiled, and (unless `follow: false`) in view. `gather` makes a gathering desk |
| `switch` | `desk` | Swaps to a desk by name, `next`, `previous`, `last` (the one before), `new`, or its number |
| `rename` | `desk?` (default: in view), `name` | Renames it |
| `move_windows` | `windows`, `desk`, `follow?` (default false) | Moves windows to live on another desk; both re-tile |
| `bring` | `windows` | Shows windows from other desks on the desk in view, without moving them |
| `send_back` | `windows?` | Sends visitors home (all, when none are named) |
| `keep` | `windows?` | Makes visitors live on the desk in view |
| `remove` | `desk?`, `into?` | Removes a desk; its windows go to `into`, else the desk before it |
| `reorder` | `desk?`, `position` | `first`, `last`, `left`, `right` |
| `set_mode` | `mode` | `classic` or `pro` |

Later phases add `set_background` (phase 2) and `overview` (phase 3).

Every action is layout or navigation: none can reach an agent's process or input, and none needs
explicit confirmation. Layout changes go through the conductor's existing path, so large ones
preview and run after the 1.5 s countdown, and all of them are undoable. In classic mode every
action but `set_mode` answers that desks are part of Canvas Pro; the conductor never switches the
mode unasked.

### 7.2 Existing tools on desks

No schema change, because a desk is a region:

| Tool | On a desk |
| --- | --- |
| `arrange_canvas` `move_into`, `rename_region`, `arrange … tile`, `resize`, `swap` | Work as before |
| `arrange_canvas` `group` | Inside a desk, makes a region within it |
| `canvas_view` `go_to_region`, `next_region`, `previous_region`, `back`, `undo`, `redo`, `stage` | Work as before. Next and previous follow desk order |
| `canvas_view` `leave_region` | From a nested region, back to the desk. On a desk, it says which desk you are on |
| `canvas_view` `home` | The first desk |
| `describe_canvas` | Leads with the mode, the desks in order, and the one in view |
| `focus_agent`, `reopen_agent`, `show_app` | Bring the window's desk into view first |

### 7.3 What to say

"Switch to Canvas Pro" · "new desk called Review with Atlas and Bravo" · "next desk" · "switch to
the Review desk" · "desk two" · "switch back" · "move Cedar to the Frontend desk" · "bring Atlas
here" · "send it back" · "keep it here" · "make a desk for everything that needs me" · "rename
this desk to Ops" · "move this desk left" · "remove the Review desk" · "use the classic canvas".

"Desktop" and "space" are understood for "desk". The full list is in [voice.md](voice.md).

---

## 8. Hotkeys

Secondary. All route to the same store calls as voice.

| Key | Action | Status |
| --- | --- | --- |
| Ctrl+Alt+PageDown / PageUp | Next / previous desk | Works (the sub-canvas keys, now desk-aware) |
| Ctrl+Alt+Left / Right | Back / forward on the trail (covers "last desk") | Works |
| Ctrl+Alt+Home | The first desk | Works |
| Esc | Leaves a Stage, or a region inside a desk; never the desk | Works |
| Ctrl+Alt+Shift+PageDown / PageUp | Move the focused window to the next / previous desk and follow | Proposed, phase 3 |
| Ctrl+Alt+N | New desk | Proposed, phase 3 |

Palette: Toggle Canvas Pro, New Desk, Next Desk, Previous Desk. Ctrl+Alt+1–4 already sets the
multi-canvas view count and Ctrl+Win+Left/Right belongs to Windows, so neither means "desk N".

---

## 9. Phases

### Phase 1: desks. Built

Everything in §3, §4, §5.1–5.3, §7, and §8 marked as working. Renderer and conductor only: no
main-process, PTY, ACP, or database change, and no new dependency.

### Phase 2: backgrounds (about 1 week, after a two-day spike)

Spike first: runtime acrylic in this shell (shows through, survives focus loss and maximize, frame
rate with six WebGL terminals), and which shell layers are opaque. Then `setWindowGlass`, the Wire
procedures for glass and images, the background layer, import, blur and dim, the settings slider,
and `set_background`. This phase touches window creation and adds a file-writing Wire procedure,
which the PR must call out.

### Phase 3: overview, order, and keys (about 1 week)

An overview of desk thumbnails, dragging the strip to reorder, the proposed hotkeys, a different
desk per multi-canvas view, macOS vibrancy, the roll call and the per-desk tone (§5.4).

### Phase 4: polish

Routing eval lines and the nightly model run, telemetry (`canvas_desk_op` with action and source
only), a screen-reader pass on the strip and the signals, and, if wanted, a spike on translucent
terminals.

---

## 10. Decisions

Taken on the recommendations, at the developer's direction (2026-10-10).

| # | Question | Decision |
| --- | --- | --- |
| 1 | Name | Desk; "desktop" and "space" understood by voice |
| 2 | What is glass? | The desk's backdrop, seen in gutters and empty space. Translucent windows are a later option |
| 3 | Blur strength on glass | System acrylic as it is; adjustable blur is for image backgrounds |
| 4 | Mode or separate canvas? | One arrangement, two presentations |
| 5 | Desk shape | Screen-sized and tiled by default; free placement inside a desk still works |
| 6 | Desks before glass? | Yes. Phase 1 ships on the color wash |
| 7 | Backgrounds per desk? | One default, optional per-desk override |
| 8 | One desk per project? | The existing "new windows open in the project's sub-canvas" setting does this; left as it is |
| 9 | Platforms | Windows 11 22H2 or later for glass; macOS vibrancy in phase 3 |

Still open:

- Whether acrylic stays when Maestro is not the focused window. The spike decides; if not, glass
  works only while focused, or the image background becomes the default.
- Whether a gathering desk should also speak what it gathered on arrival.

---

## As built

| Piece | Code |
| --- | --- |
| Desk rules: order, heir, homing, signals, visitor layout | `canvas/api/canvas-desks.ts` |
| Planner: `gather`, `dissolveRegion.into`, `reorderDesk`, order on create | `canvas/api/canvas-layout.ts` |
| Memento v5: `mode`, `order`, `gather` | `canvas/contributions/mementos.ts` |
| Store: mode, desks, the on-a-desk invariant, visitors, gathering, strays | `canvas/api/browser/stores/canvas-store.ts` |
| Board: filtered nodes, instant frame, lock, wash, signals, scrim | `canvas/browser/canvas-board.tsx` |
| Desk surface (no chrome, empty states) | `canvas/browser/tiles/region-node.tsx` |
| Desk strip, visitors bar, mode toggle | `canvas/browser/canvas-toolbar.tsx` |
| Commands and palette | `canvas/contributions/commands.ts`, `palette.ts`, `workbench/browser/window-scope.tsx` |
| Voice tool, mapping, grammar, context, prompt | `conductor/api/tools.ts`, `canvas-desk-ops.ts`, `grammar-canvas.ts`, `system-prompt.ts`, `conductor/browser/conductor-store.ts`, `roster.ts` |
| End-to-end driver | `apps/emdash-desktop/tooling/chorus/steps/desks.mjs` |

### Checked

- **Unit tests** (`vitest --project node`, canvas and conductor slices: 782 pass).
  `canvas-desks.test.ts` covers the pure rules and the new planner ops.
  `canvas-store.desks.test.ts` runs the store against an in-memory memento: entering Pro,
  swapping, the on-a-desk invariant, strays, visitors, undo of a new desk, removing, reordering,
  and refitting a desk to the screen. `mementos.test.ts` covers v4 → v5. The conductor has tests
  for the tool, the mapping, the grammar (about 70 desk utterances), and the tool and spoken
  commands against a real `CanvasStore`. The existing 200-row routing eval is also asserted to
  route identically in a Pro context.
- **In the built app** (`tooling/chorus/steps/desks.mjs`, Playwright over the real Electron
  build, two live agents): entering Pro, a new desk by pointer and rename, swapping by key with
  only the desk in view drawn at zoom 1, "bring Atlas here" and "send it back", "move Atlas to the
  Review desk", a visitor floating over a desk with its own window, "new desk called Ops",
  "switch to the Review desk", "make a desk for everything that needs me", "remove this desk", and
  back to the classic canvas. Screenshots were read at each step.
- **An independent review** of the canvas changes found ten bugs (one a regression on the
  classic canvas: Fit no longer re-tiled a sub-canvas). All ten are fixed, each with a test in
  `canvas-store.desks.test.ts` or `canvas-desks.test.ts`: the locked camera left framing the
  wrong thing, many visitors laid out off the desk, drops landing on a hidden desk, a
  double-clicked note turning a desk free, keyboard and group commands editing a visitor's home,
  undo of the switch to Pro being silently redone, Next Desk doing nothing inside a region, the
  desk in view being folded away, and a stray made during a Stage starting a second Main.
- Typecheck (`tsconfig.browser.json`, `tsconfig.node.json`), `oxlint`, and `oxfmt --check` were
  clean for the canvas and desk code. The checkout was shared with other in-progress work while
  this was built, so the whole-repo gate (`pnpm run check`) was not run and should be before a
  merge.

### Not checked, and known gaps

- **The model path.** `canvas_desks` was exercised through its handler and the grammar, never
  through a live Claude call (the driver runs without an API key), and there are no desk rows in
  the routing eval file.
- **Speech.** Every command above was typed into the HUD, not spoken.
- **Swap cost.** The 250 ms target with six live terminals per desk is not measured; the driver
  used two agents.
- **Edge signals and gathering with live statuses.** The demo agents were idle, so the signal
  chips and a gathering desk actually filling are covered by unit tests only.
- **A visiting app browser**, restart persistence in the app (covered by the memento test only),
  mixed-DPI displays, and a screen-reader pass.
- **Undo after a window resize.** A desk that was refitted to a new window size no longer matches
  the undo entry that created it, so undoing its creation sends the windows home but leaves the
  empty desk. This is conflict-aware undo meeting the refit. Refit on resize predates this work,
  so sub-canvases on the classic canvas probably behave the same; that was not tested.
- **Grammar gaps the model covers:** "remove Review into Ops" and numbered reorder ("make this
  desk third").
