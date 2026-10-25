import {
  action,
  comparer,
  computed,
  makeObservable,
  observable,
  reaction,
  runInAction,
} from 'mobx';
import {
  AGENT_WINDOW_NAMES,
  agentWindowName,
  parseAgentWindowNameSlot,
} from '@core/features/conversations/api/agent-window-names';
import type { ConversationStore } from '@core/features/conversations/api/browser/conversation-manager';
import { conversationRegistry } from '@core/features/conversations/api/browser/stores/conversation-registry';
import type { ProjectManagerStore } from '@core/features/projects/api/browser/stores/project-manager';
import { asAvailableProject } from '@core/features/projects/api/browser/stores/project-selectors';
import type { TaskStore } from '@core/features/tasks/api/browser/stores/task-store';
import { getTaskManagerStore } from '@core/features/tasks/api/browser/task-state/task-selectors';
import { taskManagerStoreToken } from '@core/features/tasks/contributions/browser/project-store-tokens';
import type { AgentStatus, NotificationType } from '@core/primitives/agents/api';
import type { CompletionReport } from '@core/primitives/agents/api/completion-report';
import { log } from '@core/primitives/logging/browser/logger';
import type { MementoHandle } from '@core/primitives/mementos/browser';
import { isProvisioned } from '@core/primitives/task-state/browser/task-state';
import {
  canvasBoardMemento,
  DEFAULT_LAYOUT_SETTINGS,
  type CanvasBoardState,
  type CanvasBrowserState,
  type CanvasDocState,
  type CanvasLayoutSettings,
  type CanvasLocationState,
  type CanvasStageTarget,
} from '../../../contributions/mementos';
import {
  adjacentDesk,
  deskIds,
  deskOf,
  deskSignals,
  gatherMatches,
  homeLooseOps,
  looseWindows,
  mainDeskId,
  removeDeskOps,
  stampDeskOrder,
  visitorLayout,
  type CanvasMode,
  type DeskPosition,
  type DeskSignal,
} from '../../canvas-desks';
import {
  diffLayout,
  pushHistory,
  redoEntry,
  undoEntry,
  type LayoutHistoryEntry,
  type LayoutSource,
} from '../../canvas-history';
import {
  MAX_OPS_PER_BATCH,
  planLayout,
  readingOrder,
  regionAt,
  settleDesks,
  type LayoutEnv,
  type LayoutOp,
  type LayoutPlan,
  type PlanResult,
} from '../../canvas-layout';
import {
  AGENT_TILE_SIZE,
  BROWSER_TILE_SIZE,
  DOC_TILE_SIZE,
  assignSpokenName,
  duplicateSpokenNames,
  frameRect,
  isLegacySpokenName,
  NOTE_TILE_SIZE,
  nextFreeAnchor,
  placeTiles,
  rectsOverlap,
  spokenNameKey,
  viewportRect,
  type CanvasViewport,
  type TileRect,
} from '../../canvas-model';
import {
  clampPaneCount,
  livePane,
  paneBoxes,
  splitViewport,
  type PaneView,
} from '../../canvas-panes';
import {
  descendantTiles,
  frameAllowanceFor,
  isFoldedAway,
  isRegionId,
  isTiled,
  isWithin,
  newRegionId,
  nodeRect,
  parentOf,
  projectRegionId,
  regionDepth,
  regionFootprint,
  regionPath,
  statusSummary,
  uniqueName,
  type LayoutState,
  type LayoutWindow,
  type RegionColor,
  type WindowStatus,
} from '../../canvas-regions';
import {
  homeForNewWindow,
  opsForNewWindowHome,
  withProjectRegionTags,
  type NewWindowHome,
} from '../../canvas-spawn';
import {
  DESK_INSETS,
  deskGap,
  deskPageBox,
  deskPageCount,
  deskPageOf,
  deskTilesArea,
  deskViolations,
  type DeskViolation,
} from '../../desk-layout';
import { spokenProviderLabel } from '../../provider-names';
import {
  adjacentRegion,
  cameraLeftRegion,
  frameViewport,
  peerRegions,
  workspaceSize,
  promotedTiles,
  PROMOTED_LIVE_CAP,
} from '../../region-tiling';
import { EMPTY_STAGE, stageOrder, type StageSaved } from '../../stage-layout';

export type AgentTileEntry = {
  readonly tileId: string;
  readonly conversationId: string;
  readonly taskId: string;
  readonly projectId: string;
  readonly projectName: string;
  readonly taskName: string;
  readonly providerId: string;
  readonly conversationTitle: string;
  readonly type: 'pty' | 'acp';
  readonly status: AgentStatus;
  readonly seen: boolean;
  readonly notificationType: NotificationType | null;
  /** Few-word synopsis of what the agent finished (status 'completed' only). */
  readonly completionSummary: string | null;
  /** The agent's final reply, redacted and bounded (status 'completed' only). */
  readonly completionReport: CompletionReport | null;
  /** Subagents the agent is waiting on (status 'working' only); absent for none. */
  readonly backgroundAgents?: number;
  /** True when the task workspace is provisioned (its sessions can attach). */
  readonly taskProvisioned: boolean;
  /** True when the host reports a running session for this conversation. */
  readonly sessionActive: boolean;
  readonly workspaceId: string | null;
  readonly linesAdded: number;
  readonly linesDeleted: number;
  /** When the agent's task was created (ISO), for "the latest agent"; null while it is being made. */
  readonly createdAt: string | null;
  /** When the user last sent this agent something (ISO), if ever. */
  readonly lastInteractedAt: string | null;
};

export type NoteTileEntry = {
  readonly tileId: string;
  readonly noteId: string;
  readonly text: string;
  readonly color: NonNullable<CanvasBoardState['notes'][string]['color']>;
};

/** A task's app browser on the board. */
export type BrowserTileEntry = {
  readonly tileId: string;
  /** Stable browser session id (`canvas-app-<taskId>`). */
  readonly browserId: string;
  readonly taskId: string;
  readonly projectId: string;
  readonly workspaceId: string;
  readonly projectName: string;
  readonly taskName: string;
  readonly url: string;
  readonly title: string | undefined;
  readonly control: CanvasBrowserState['control'];
};

/** A Markdown file shown as a window, with the task whose agent it came from. */
export type DocTileEntry = CanvasDocState & {
  readonly tileId: string;
  readonly docId: string;
  readonly projectName: string;
  readonly taskName: string;
};

/** A note dropped onto an agent tile: its text is offered to that agent (the conductor sends it). */
export type NoteDrop = {
  readonly id: number;
  readonly noteId: string;
  readonly conversationId: string;
  readonly text: string;
};

/** A frame around one task's agents: its worktree, diff stats, and a way into diff review. */
export type TaskFrameEntry = {
  readonly frameId: string;
  readonly taskId: string;
  readonly projectId: string;
  /** The task's workspace, when provisioned (needed to run its app). */
  readonly workspaceId: string | null;
  readonly taskName: string;
  readonly projectName: string;
  readonly rect: TileRect;
  readonly tileIds: readonly string[];
  readonly linesAdded: number;
  readonly linesDeleted: number;
  readonly working: number;
  readonly waiting: number;
};

export function taskFrameId(taskId: string): string {
  return `frame:${taskId}`;
}

/**
 * Decisions other slices attach to an agent (the conductor's Jev triage): how risky its pending
 * permission request is and how urgently it needs the user. Ephemeral, never persisted.
 */
export type AgentInsight = {
  readonly riskLevel?: 'low' | 'moderate' | 'elevated' | 'high';
  /** 0 (can wait) to 1 (needs the user now). */
  readonly urgency?: number;
  /** The conductor is delivering this agent's call: its window is marked, never focused. */
  readonly onLine?: boolean;
};

/** A region as the board and the conductor see it. */
export type RegionEntry = {
  readonly regionId: string;
  readonly name: string;
  readonly parentId: string | null;
  readonly color: RegionColor | undefined;
  readonly collapsed: boolean;
  /** Footprint on the board (a collapsed region is its header chip). */
  readonly rect: TileRect;
  readonly depth: number;
  /** Visible windows anywhere inside, and how many need the user or are working. */
  readonly windowCount: number;
  readonly waiting: number;
  readonly working: number;
  readonly failed: number;
  /** "2 need you, 1 working". */
  readonly summary: string;
  readonly auto: boolean;
  /** Members fill it as a weighted split (quadrants for four) and re-tile as they change. */
  readonly tiled: boolean;
};

/** A desk (Canvas Pro): a top-level region shown alone, in its place in the desk order. */
export type DeskEntry = {
  readonly regionId: string;
  readonly name: string;
  /** Place in the order, from 0. */
  readonly index: number;
  readonly color: RegionColor | undefined;
  readonly active: boolean;
  readonly windowCount: number;
  readonly waiting: number;
  readonly working: number;
  readonly failed: number;
  readonly summary: string;
  /** A gathering desk: windows with this status visit it while it shows. */
  readonly gather: WindowStatus | null;
};

/** One page of the desk in view (Canvas Pro): a desk too full for one screen has several. */
export type DeskPageEntry = {
  readonly index: number;
  readonly active: boolean;
  readonly windowCount: number;
  readonly waiting: number;
  readonly working: number;
  readonly failed: number;
};

export type CanvasLocation = CanvasLocationState;
export type StageTarget = CanvasStageTarget;

/** The last layout change: the board animates it and flashes its targets. */
export type LayoutChange = {
  readonly id: number;
  readonly label: string;
  readonly targets: readonly string[];
  readonly displaced: readonly string[];
  readonly source: LayoutSource;
  readonly at: number;
};

/** A proposed layout shown as outlines before it applies (large voice changes). */
export type LayoutGhost = {
  readonly id: number;
  readonly state: LayoutState;
  readonly label: string;
  readonly targets: readonly string[];
  /** Re-planned on apply, so changes made while the preview was up are respected. */
  readonly ops: readonly LayoutOp[];
  readonly source: LayoutSource;
};

export type LayoutRunResult =
  | { readonly ok: true; readonly plan: LayoutPlan; readonly applied: boolean }
  | { readonly ok: false; readonly reason: string };

/** Result of undo/redo: what it reverted and how many fields were changed since and kept. */
export type LayoutUndoResult = { readonly label: string; readonly conflicts: number };

/** A window that has just appeared, with what decides where it goes. */
type NewTile = {
  readonly tileId: string;
  readonly conversationId?: string;
  readonly projectId: string;
  readonly projectName: string;
};

/** Windows bound for the same place. */
type NewTileHome = { readonly home: NewWindowHome; readonly tiles: string[] };

/** Tags each project region the windows went to, so it is found again after a rename. */
function tagProjectHomes(state: LayoutState, homes: readonly NewTileHome[]): LayoutState {
  const tags = homes.flatMap(({ home }) => {
    if (home.kind !== 'project') return [];
    const regionId = home.regionId ?? projectRegionId(state, home.projectId, home.name);
    return regionId ? [{ regionId, projectId: home.projectId }] : [];
  });
  return withProjectRegionTags(state, tags);
}

type StageHistoryEntry = {
  readonly key: string;
  readonly before: StageSaved;
  readonly after: StageSaved;
  readonly label: string;
  readonly at: number;
};

const TRANSIENT_STAGE_KEY = '';
const MAX_TRAIL = 50;
/** How many earlier names an agent still answers to after renames. */
const FORMER_NAMES_KEPT = 3;
/** How many names of agents that left this session are remembered as gone. */
const DEPARTED_NAMES_KEPT = 30;
/** How long a departed agent's name still means that agent to the conductor. */
const DEPARTED_NAME_TTL_MS = 10 * 60_000;
/** How long an agent must stay gone before its name is free: longer than a refused removal. */
const DEPARTURE_GRACE_MS = 60_000;
/** How often a conversation's host is asked to take the spoken name as title. */
const TITLE_SYNC_ATTEMPTS = 3;
const BOARD_ROOT: CanvasLocation = { kind: 'board', regionScope: null };
const NO_VISITORS: ReadonlyMap<string, TileRect> = new Map();

export type ViewportCommand =
  | { readonly id: number; readonly kind: 'focus'; readonly tileId: string }
  | { readonly id: number; readonly kind: 'fit'; readonly tileIds?: readonly string[] }
  /** Frame a region as the workspace: filling the screen, at zoom 1 when it is screen-sized. */
  | {
      readonly id: number;
      readonly kind: 'frame';
      readonly regionId: string;
      /** Canvas Pro swaps desks: the camera jumps instead of travelling across the board. */
      readonly instant?: boolean;
    }
  /** Put the camera back where it was (the main canvas the user left for a region). */
  | { readonly id: number; readonly kind: 'restore'; readonly viewport: CanvasViewport };

/** Views shown when multi-canvas is switched on without a number. */
const DEFAULT_MULTI_COUNT = 4;

/** How long a board resize settles before a screen-sized workspace re-tiles to it. */
const REFIT_DELAY_MS = 250;
/** Repairs of a desk in a row before giving up (each one should leave it holding the rules). */
const MAX_DESK_REPAIRS = 4;

export function agentTileId(conversationId: string): string {
  return `agent:${conversationId}`;
}

export function noteTileId(noteId: string): string {
  return `note:${noteId}`;
}

export function browserTileId(taskId: string): string {
  return `browser:${taskId}`;
}

export function docTileId(docId: string): string {
  return `doc:${docId}`;
}

export function canvasBrowserId(taskId: string): string {
  return `canvas-app-${taskId}`;
}

const ATTENTION_STATUSES: ReadonlySet<AgentStatus> = new Set([
  'awaiting-input',
  'error',
  'completed',
]);

export function needsAttention(entry: Pick<AgentTileEntry, 'status' | 'seen'>): boolean {
  return ATTENTION_STATUSES.has(entry.status) && !entry.seen;
}

/**
 * App-scoped view model for the agent canvas.
 *
 * Tiles are derived from live project/task/conversation stores; only presentation (geometry,
 * notes, names, viewport) is persisted, through the `canvas.board` memento.
 */
export class CanvasStore {
  private _handle: MementoHandle<CanvasBoardState> | undefined;
  private _fallbackState: CanvasBoardState = canvasBoardMemento.default;
  /** Most-recently focused tile ids, most recent first. Ephemeral. */
  focusOrder: string[] = [];
  focusedTileId: string | null = null;
  viewportCommand: ViewportCommand | null = null;
  noteDrop: NoteDrop | null = null;
  /** Conversations the user explicitly asked to start or resume from the canvas. */
  readonly startRequested = observable.set<string>();
  /** Conversations whose spoken names were claimed before they existed, this session. */
  private readonly claimedNames = new Set<string>();
  /** Where each agent was last seen on the roster this session, by conversation id. */
  private readonly seenAgents = new Map<string, { projectId: string; taskId: string }>();
  /** Names agents were renamed from this session, newest first, by conversation id. */
  private readonly formerNames = new Map<string, string[]>();
  /** When each agent seen this session was first found gone, by conversation id. */
  private readonly goneSince = new Map<string, number>();
  /** Names of agents that left the roster this session and when, newest first. */
  private readonly leftNames: { name: string; at: number }[] = [];
  /** Conversations whose leftover titles were looked at this session. */
  private readonly titlesChecked = new Set<string>();
  /** Conversations whose title still has to become their spoken name, by conversation id. */
  private readonly titlesOwed = new Map<
    string,
    {
      /** The spoken name before a rename: a title equal to it follows the rename. */
      previous?: string;
      attempts: number;
      /** The title the first try set out to replace, as a name key. */
      replacing?: string;
      inFlight?: boolean;
    }
  >();
  /** Jev triage per conversation id (risk, urgency). */
  readonly insights = observable.map<string, AgentInsight>();
  /** First time each tile was observed needing attention, for oldest-first cycling. */
  private readonly attentionSince = observable.map<string, number>();
  /** Layout undo/redo (ephemeral: a restart starts a fresh history). */
  undoStack: LayoutHistoryEntry[] = [];
  redoStack: LayoutHistoryEntry[] = [];
  private stageUndo: StageHistoryEntry[] = [];
  private stageRedo: StageHistoryEntry[] = [];
  /** Tiles and regions selected on the board ("these", "group the selection"). */
  selection: string[] = [];
  lastChange: LayoutChange | null = null;
  ghost: LayoutGhost | null = null;
  /** Board size in CSS px, reported by the board (screen-relative sizes and slots use it). */
  boardSize = { width: 1600, height: 900 };
  /** Push-to-talk is held: windows and regions show large name badges. */
  listening = false;
  /** Region a pointer drag would drop into (highlighted while dragging). */
  dropHint: string | null = null;
  /** Region whose name field is open for editing (new regions open it). */
  renamingRegionId: string | null = null;
  /**
   * Canvas Pro: windows brought to the desk in view from other desks. They are drawn there without
   * leaving their own desk, and go home when the desk changes.
   */
  visitorIds: string[] = [];
  /** Canvas Pro: the desk that was in view before this one ("switch back", "the other desk"). */
  previousDeskId: string | null = null;
  /** Canvas Pro: the page each desk was last on, this session (see `desk-layout.ts`). */
  readonly deskPages = observable.map<string, number>();
  /** Repairs of the desk in view since it last held the desk rules (a guard against looping). */
  private deskRepairs = 0;
  /**
   * Bumped when a pointer gesture ends on a desk. The board then redraws every window from the
   * layout: a drop or a resize there can leave the layout as it was (the window goes back to its
   * pane), which no change to the layout would tell the board.
   */
  boardSync = 0;
  /** The undo entry of the last switch to Canvas Pro: undoing it switches back. */
  private proEntryId: number | null = null;
  backTrail: CanvasLocation[] = [];
  forwardTrail: CanvasLocation[] = [];
  /** Region the user was in before the current one ("switch back", "the other one"). */
  previousRegionId: string | null = null;
  /** Region created most recently this session ("the new sub-canvas"). */
  newestRegionId: string | null = null;
  /** Zoom the board framed the current region at (leaving it is measured from there). */
  scopeFramedZoom: number | null = null;
  /** Main-canvas camera from before the user entered a region, restored on the way out. */
  private rootViewport: CanvasViewport | null = null;
  private refitTimer: ReturnType<typeof setTimeout> | null = null;
  /** Size of each multi-canvas view in CSS px, reported by its board. */
  paneSizes: { width: number; height: number }[] = [];
  /** How many views "multi-canvas on" last meant, for switching it back on. */
  private lastMultiCount = DEFAULT_MULTI_COUNT;
  /** Each inactive view's main-canvas camera from before it entered a region. */
  private readonly paneRootViewports = new Map<number, CanvasViewport | null>();
  /** Stage arrangement for selection and solo stages (region stages persist theirs). */
  private transientStage: StageSaved = EMPTY_STAGE;
  /** Region names reserved for agents about to be created (a plan's agents arrive together). */
  private readonly pendingRegions = new Map<string, string>();
  private commandSeq = 0;
  private readonly disposers: (() => void)[] = [];
  private disposed = false;

  constructor(private readonly projectManager: ProjectManagerStore) {
    makeObservable<
      CanvasStore,
      | '_handle'
      | '_fallbackState'
      | 'updateState'
      | 'transientStage'
      | 'stageUndo'
      | 'stageRedo'
      | 'writeLayout'
      | 'writeStage'
      | 'markChanged'
    >(this, {
      undoStack: observable.ref,
      redoStack: observable.ref,
      stageUndo: observable.ref,
      stageRedo: observable.ref,
      selection: observable.ref,
      lastChange: observable.ref,
      ghost: observable.ref,
      boardSize: observable.ref,
      listening: observable,
      dropHint: observable,
      renamingRegionId: observable,
      visitorIds: observable.ref,
      previousDeskId: observable,
      mode: computed,
      proMode: computed,
      desks: computed,
      activeDeskId: computed,
      boardSync: observable,
      deskLocked: computed,
      deskPageCount: computed,
      deskPage: computed,
      deskFrame: computed({ equals: comparer.structural }),
      deskPager: computed({ equals: comparer.structural }),
      deskViolations: computed({ equals: comparer.structural }),
      setDeskPage: action,
      stepDeskPage: action,
      deskSignals: computed,
      visitors: computed({ equals: comparer.structural }),
      visitorRects: computed,
      visitorsFloating: computed,
      setMode: action,
      switchDesk: action,
      answerDesk: action,
      createDesk: action,
      removeDesk: action,
      reorderDesk: action,
      bringHere: action,
      sendBack: action,
      keepVisitors: action,
      gatherVisitors: action,
      homeStrays: action,
      setDropHint: action,
      setRenamingRegion: action,
      groupSelection: action,
      backTrail: observable.ref,
      forwardTrail: observable.ref,
      previousRegionId: observable,
      newestRegionId: observable,
      scopeFramedZoom: observable,
      paneSizes: observable.ref,
      paneCount: computed,
      activePane: computed,
      paneViews: computed,
      paneRects: computed,
      setPaneCount: action,
      toggleMultiCanvas: action,
      activatePane: action,
      setPaneViewport: action,
      setPaneSize: action,
      focusedRegionId: computed,
      promotedTileIds: computed({ equals: comparer.structural }),
      promotedSet: computed,
      setScopeFramedZoom: action,
      requestFrame: action,
      reframe: action,
      leaveScope: action,
      cameraMoved: action,
      goToAdjacentRegion: action,
      stepDesk: action,
      refitScope: action,
      transientStage: observable.ref,
      layoutState: computed,
      layoutWindows: computed,
      regionEntries: computed,
      location: computed,
      stageTarget: computed,
      stageTileIds: computed,
      stageSaved: computed,
      stagedSet: computed,
      breadcrumbs: computed,
      layoutSettings: computed,
      canUndo: computed,
      canRedo: computed,
      writeLayout: action,
      writeStage: action,
      markChanged: action,
      commitLayout: action,
      runLayout: action,
      applyPlan: action,
      showGhost: action,
      applyGhost: action,
      clearGhost: action,
      undo: action,
      redo: action,
      setSelection: action,
      setBoardSize: action,
      setListening: action,
      dropNodes: action,
      resizeTile: action,
      navigate: action,
      back: action,
      forward: action,
      up: action,
      home: action,
      goToRegion: action,
      enterStage: action,
      leaveStage: action,
      stageSelection: action,
      setStagePage: action,
      setStageImmersive: action,
      updateStage: action,
      setLayoutSettings: action,
      reserveRegion: action,
      joinRegionOnArrival: action,
      _handle: observable.ref,
      _fallbackState: observable.ref,
      focusOrder: observable.ref,
      focusedTileId: observable,
      viewportCommand: observable.ref,
      noteDrop: observable.ref,
      noteDropped: action,
      consumeNoteDrop: action,
      state: computed,
      agentEntries: computed,
      visibleAgentEntries: computed,
      noteEntries: computed,
      browserEntries: computed,
      visibleBrowserEntries: computed,
      taskFrames: computed,
      openBrowser: action,
      closeBrowser: action,
      docEntries: computed,
      visibleDocEntries: computed,
      openDoc: action,
      closeDoc: action,
      setBrowserUrl: action,
      setBrowserControl: action,
      setOpenOnLaunch: action,
      setShowTaskFrames: action,
      moveTiles: action,
      setInsight: action,
      clearInsight: action,
      attentionEntries: computed,
      projectOptions: computed,
      updateState: action,
      attachMemento: action,
      focusTile: action,
      requestFocus: action,
      requestFit: action,
      consumeViewportCommand: action,
      setTileRect: action,
      setViewport: action,
      addNote: action,
      updateNote: action,
      removeNote: action,
      hideConversation: action,
      hideConversations: action,
      showConversation: action,
      showConversations: action,
      showAllConversations: action,
      revealConversation: action,
      setSpokenName: action,
      setProjectFilter: action,
      ensureLayout: action,
      resumeAgent: action,
    });
  }

  private startLayoutTracking(): void {
    // Assign geometry and spoken names to agents as they appear, so placement is stable.
    this.disposers.push(
      reaction(
        () => this.agentEntries.map((entry) => entry.tileId).join('|'),
        () => this.ensureLayout(),
        { fireImmediately: true }
      ),
      reaction(
        () =>
          this.agentEntries
            .filter(needsAttention)
            .map((entry) => entry.tileId)
            .join('|'),
        () => this.trackAttention(),
        { fireImmediately: true }
      ),
      // Canvas Pro: a window on no desk would never be seen, so it joins one.
      reaction(
        () =>
          this.proMode
            ? [deskIds(this.layoutState).length, ...this.looseTileIds()].join('|')
            : 'classic',
        () => this.homeStrays(),
        { fireImmediately: true }
      ),
      // Canvas Pro: the page in view moved under a camera that is locked on it (another page, a
      // re-tile, the window resized), so it is framed again.
      reaction(
        () => {
          const desk = this.location.kind === 'board' ? this.activeDeskId : null;
          const frame = desk ? this.deskFrame : null;
          return desk && frame ? { desk, ...frame } : null;
        },
        (now, before) => {
          if (now && before && now.desk === before.desk) this.reframe();
        },
        { equals: comparer.structural }
      ),
      // Canvas Pro: the desk in view always holds the desk rules. Every planned change keeps
      // them; this repairs what was not planned (an undo, a frame dragged, an older canvas).
      reaction(
        () => {
          const desk = this.activeDeskId;
          const found = desk ? this.deskViolations : [];
          return desk && found.length > 0 ? `${desk}:${found.join(',')}` : null;
        },
        (drift) => this.repairDesk(drift),
        { fireImmediately: true }
      ),
      // A gathering desk collects the windows with its status for as long as it shows.
      reaction(
        () => this.gatherKey(),
        (key) => {
          if (key) this.gatherVisitors();
        },
        { fireImmediately: true }
      )
    );
  }

  dispose(): void {
    this.disposed = true;
    if (this.refitTimer) clearTimeout(this.refitTimer);
    for (const dispose of this.disposers.splice(0)) dispose();
  }

  /**
   * Attached from the renderer bootstrap once mementos are ready. Layout tracking starts only then,
   * so placement and spoken names build on stored state rather than the default.
   */
  attachMemento(handle: MementoHandle<CanvasBoardState>): void {
    if (this._handle) throw new Error('Canvas memento is already attached');
    this._handle = handle;
    if (!this.disposed) this.startLayoutTracking();
  }

  get state(): CanvasBoardState {
    return this._handle?.value ?? this._fallbackState;
  }

  private updateState(update: (current: CanvasBoardState) => CanvasBoardState): void {
    if (this._handle) this._handle.update(update);
    else this._fallbackState = update(this._fallbackState);
  }

  // ── Derived entries ────────────────────────────────────────────────────────

  get agentEntries(): AgentTileEntry[] {
    const entries: AgentTileEntry[] = [];
    for (const project of this.projectManager.projects.values()) {
      const context = asAvailableProject(project);
      if (!context) continue;
      const tasks = context.get(taskManagerStoreToken).tasks;
      for (const task of tasks.values()) {
        if (!isCanvasTask(task)) continue;
        const manager = conversationRegistry.get(task.data.id);
        if (!manager) continue;
        for (const conversation of manager.conversations.values()) {
          entries.push(
            toAgentEntry(project.name ?? 'Project', task, conversation, {
              sessionActive: manager.isSessionActive(conversation.data.id),
            })
          );
        }
      }
    }
    entries.sort((a, b) => a.conversationId.localeCompare(b.conversationId));
    return entries;
  }

  /** Agent entries after the user's hide list and project filter. */
  get visibleAgentEntries(): AgentTileEntry[] {
    const hidden = new Set(this.state.hiddenConversationIds);
    const filter = this.state.projectFilter;
    return this.agentEntries.filter(
      (entry) => !hidden.has(entry.conversationId) && (!filter || entry.projectId === filter)
    );
  }

  get noteEntries(): NoteTileEntry[] {
    return Object.entries(this.state.notes).map(([noteId, note]) => ({
      tileId: noteTileId(noteId),
      noteId,
      text: note.text,
      color: note.color ?? 'yellow',
    }));
  }

  /** App browsers whose task is still on the board, in task order. */
  get browserEntries(): BrowserTileEntry[] {
    const browsers = this.state.browsers;
    if (Object.keys(browsers).length === 0) return [];
    const entries: BrowserTileEntry[] = [];
    for (const project of this.projectManager.projects.values()) {
      const context = asAvailableProject(project);
      if (!context) continue;
      for (const task of context.get(taskManagerStoreToken).tasks.values()) {
        const browser = browsers[task.data.id];
        if (!browser || !isCanvasTask(task)) continue;
        entries.push({
          tileId: browserTileId(task.data.id),
          browserId: canvasBrowserId(task.data.id),
          taskId: task.data.id,
          projectId: project.id,
          workspaceId: browser.workspaceId,
          projectName: project.name ?? 'Project',
          taskName: task.displayName,
          url: browser.url,
          title: browser.title,
          control: browser.control,
        });
      }
    }
    entries.sort((a, b) => a.taskId.localeCompare(b.taskId));
    return entries;
  }

  /** Browser entries after the project filter. */
  get visibleBrowserEntries(): BrowserTileEntry[] {
    const filter = this.state.projectFilter;
    const hidden = new Set(this.state.hiddenTiles);
    return this.browserEntries.filter(
      (entry) => !hidden.has(entry.tileId) && (!filter || entry.projectId === filter)
    );
  }

  browserForTask(taskId: string): BrowserTileEntry | undefined {
    return this.browserEntries.find((entry) => entry.taskId === taskId);
  }

  /** Document windows whose task is still on the board, in document order. */
  get docEntries(): DocTileEntry[] {
    const entries: DocTileEntry[] = [];
    for (const [docId, doc] of Object.entries(this.state.docs ?? {})) {
      const project = this.projectManager.projects.get(doc.projectId);
      const task = asAvailableProject(project)?.get(taskManagerStoreToken).tasks.get(doc.taskId);
      if (!project || !task || !isCanvasTask(task)) continue;
      entries.push({
        ...doc,
        tileId: docTileId(docId),
        docId,
        projectName: project.name ?? 'Project',
        taskName: task.displayName,
      });
    }
    entries.sort((a, b) => a.docId.localeCompare(b.docId));
    return entries;
  }

  /** Document entries after the project filter. */
  get visibleDocEntries(): DocTileEntry[] {
    const filter = this.state.projectFilter;
    const hidden = new Set(this.state.hiddenTiles);
    return this.docEntries.filter(
      (entry) => !hidden.has(entry.tileId) && (!filter || entry.projectId === filter)
    );
  }

  /**
   * One frame per task and region with visible agents or an app browser (empty when frames are
   * off). A task split across regions gets a frame in each; windows in collapsed regions have none.
   */
  get taskFrames(): TaskFrameEntry[] {
    if (!this.state.showTaskFrames) return [];
    const layout = this.layoutState;
    const groups = new Map<string, { taskId: string; region: string | null }>();
    const pro = this.proMode;
    const keyOf = (taskId: string, tileId: string) => {
      const region = parentOf(layout, tileId);
      // A desk's pages are a screen apart: a frame holds the task's windows on one page.
      const desk = pro && region && !parentOf(layout, region) ? layout.regions[region] : undefined;
      const rect = desk ? layout.tiles[tileId] : undefined;
      const page = desk && rect ? deskPageOf(desk.rect, this.boardSize, rect) : 0;
      const where = region ? `@${region}${page > 0 ? `#${page}` : ''}` : '';
      const key = `${taskFrameId(taskId)}${where}`;
      groups.set(key, { taskId, region });
      return key;
    };
    const byTask = new Map<string, AgentTileEntry[]>();
    for (const entry of this.visibleAgentEntries) {
      if (isFoldedAway(layout, entry.tileId)) continue;
      const key = keyOf(entry.taskId, entry.tileId);
      const group = byTask.get(key) ?? [];
      group.push(entry);
      byTask.set(key, group);
    }
    const browsers = new Map<string, BrowserTileEntry>();
    for (const entry of this.visibleBrowserEntries) {
      if (isFoldedAway(layout, entry.tileId)) continue;
      browsers.set(keyOf(entry.taskId, entry.tileId), entry);
    }
    const frames: TaskFrameEntry[] = [];
    for (const [frameId, group] of groups) {
      const taskId = group.taskId;
      const entries = byTask.get(frameId) ?? [];
      const browser = browsers.get(frameId);
      const first = entries[0];
      const tileIds = [
        ...entries.map((entry) => entry.tileId),
        ...(browser ? [browser.tileId] : []),
      ];
      const rect = frameRect(tileIds.map((tileId) => this.tileRect(tileId)));
      const named = first ?? browser;
      if (!named || !rect) continue;
      frames.push({
        frameId,
        taskId,
        projectId: named.projectId,
        workspaceId: first?.workspaceId ?? browser?.workspaceId ?? null,
        taskName: named.taskName,
        projectName: named.projectName,
        rect,
        tileIds,
        linesAdded: first?.linesAdded ?? 0,
        linesDeleted: first?.linesDeleted ?? 0,
        working: entries.filter((entry) => entry.status === 'working').length,
        waiting: entries.filter(needsAttention).length,
      });
    }
    return frames;
  }

  get openOnLaunch(): boolean {
    return this.state.openOnLaunch;
  }

  get showTaskFrames(): boolean {
    return this.state.showTaskFrames;
  }

  setOpenOnLaunch(openOnLaunch: boolean): void {
    this.updateState((current) => ({ ...current, openOnLaunch }));
  }

  setShowTaskFrames(showTaskFrames: boolean): void {
    this.updateState((current) => ({ ...current, showTaskFrames }));
  }

  /** Moves several tiles by the same offset (dragging a task frame moves its agents). Undoable. */
  moveTiles(tileIds: readonly string[], dx: number, dy: number): void {
    if (dx === 0 && dy === 0) return;
    if (this.proMode) {
      // On a desk a drop is a change of order, which the planner makes while keeping it full.
      this.dropNodes(
        tileIds.map((id) => {
          const rect = this.tileRect(id);
          return { id, x: rect.x + dx, y: rect.y + dy };
        })
      );
      return;
    }
    const layout = this.layoutState;
    const tiles = { ...layout.tiles };
    for (const tileId of tileIds) {
      const rect = this.tileRect(tileId);
      tiles[tileId] = { ...rect, x: Math.round(rect.x + dx), y: Math.round(rect.y + dy) };
    }
    const names = tileIds.map((id) => this.windowName(id));
    const label = names.length === 1 ? `Moved ${names[0]}` : `Moved ${names.length} windows`;
    this.commitLayout({ ...layout, tiles }, label, 'pointer', tileIds);
  }

  /** Visible agents needing the user: most urgent first (Jev triage), then oldest first. */
  get attentionEntries(): AgentTileEntry[] {
    const urgency = (entry: AgentTileEntry) =>
      this.insights.get(entry.conversationId)?.urgency ?? 0;
    return this.visibleAgentEntries
      .filter(needsAttention)
      .sort(
        (a, b) =>
          urgency(b) - urgency(a) ||
          (this.attentionSince.get(a.tileId) ?? 0) - (this.attentionSince.get(b.tileId) ?? 0)
      );
  }

  insight(conversationId: string): AgentInsight | undefined {
    return this.insights.get(conversationId);
  }

  setInsight(conversationId: string, insight: AgentInsight): void {
    this.insights.set(conversationId, { ...this.insights.get(conversationId), ...insight });
  }

  clearInsight(conversationId: string): void {
    this.insights.delete(conversationId);
  }

  get projectOptions(): { id: string; name: string }[] {
    const options: { id: string; name: string }[] = [];
    for (const project of this.projectManager.projects.values()) {
      if (asAvailableProject(project)) options.push({ id: project.id, name: project.name ?? '' });
    }
    return options;
  }

  get viewport(): CanvasViewport {
    return this.state.viewport;
  }

  get projectFilter(): string | null {
    return this.state.projectFilter;
  }

  tileRect(tileId: string): TileRect {
    // A visitor is drawn on the desk in view; its own place on its desk is untouched.
    const visiting = this.visitorRects.get(tileId);
    if (visiting) return visiting;
    const stored = this.state.tiles[tileId];
    if (stored) return stored;
    const size = tileId.startsWith('note:')
      ? NOTE_TILE_SIZE
      : tileId.startsWith('browser:')
        ? BROWSER_TILE_SIZE
        : tileId.startsWith('doc:')
          ? DOC_TILE_SIZE
          : AGENT_TILE_SIZE;
    return { x: 0, y: 0, ...size };
  }

  spokenName(conversationId: string): string {
    return this.state.spokenNames[conversationId] ?? 'Agent';
  }

  entryForTile(tileId: string): AgentTileEntry | undefined {
    return this.agentEntries.find((entry) => entry.tileId === tileId);
  }

  /**
   * Per-conversation lookup so a tile observer does not subscribe to every agent
   * in `agentEntries` (status/git churn on one task would otherwise re-render all tiles).
   */
  entryForConversation(
    projectId: string,
    taskId: string,
    conversationId: string
  ): AgentTileEntry | undefined {
    const project = this.projectManager.projects.get(projectId);
    const context = asAvailableProject(project);
    if (!project || !context) return undefined;
    const task = context.get(taskManagerStoreToken).tasks.get(taskId);
    if (!task || !isCanvasTask(task)) return undefined;
    const manager = conversationRegistry.get(taskId);
    const conversation = manager?.conversations.get(conversationId);
    if (!manager || !conversation) return undefined;
    return toAgentEntry(project.name ?? 'Project', task, conversation, {
      sessionActive: manager.isSessionActive(conversationId),
    });
  }

  focusRank(tileId: string): number {
    const index = this.focusOrder.indexOf(tileId);
    return index === -1 ? Number.MAX_SAFE_INTEGER : index;
  }

  // ── Render promotion ───────────────────────────────────────────────────────

  /** The region the board is scoped to (the workspace the user is in); null on the main canvas. */
  get focusedRegionId(): string | null {
    const location = this.location;
    if (location.kind !== 'board' || !location.regionScope) return null;
    const region = this.state.regions[location.regionScope];
    return region && !region.collapsed ? location.regionScope : null;
  }

  /**
   * Windows of the focused region whose app browsers stay mounted for as long as the region is
   * focused, most recently focused first up to the cap.
   */
  get promotedTileIds(): string[] {
    const promoted = promotedTiles(
      this.layoutState,
      this.focusedRegionId,
      this.visibleTileIds(),
      (id) => this.focusRank(id),
      PROMOTED_LIVE_CAP
    );
    // Canvas Pro: windows visiting the desk in view are in view too, ahead of its own.
    const visiting = this.visitors;
    if (visiting.length === 0) return promoted;
    const rest = promoted.filter((id) => !visiting.includes(id));
    return [...visiting, ...rest].slice(0, PROMOTED_LIVE_CAP);
  }

  get promotedSet(): ReadonlySet<string> {
    return new Set(this.promotedTileIds);
  }

  // ── Layout ─────────────────────────────────────────────────────────────────

  /** Gives every agent a tile rect and a spoken name the first time it is seen. */
  ensureLayout(): void {
    const state = this.state;
    const missing = this.agentEntries.filter((entry) => !state.tiles[entry.tileId]);
    const unnamed = this.agentEntries.filter((entry) => {
      const name = state.spokenNames[entry.conversationId];
      return !name || isLegacySpokenName(name, spokenProviderLabel(entry.providerId));
    });
    // Two agents under one name cannot be told apart by voice: all but one get a new name.
    const renamed = new Set(
      duplicateSpokenNames(
        this.agentEntries.flatMap((entry) => {
          const name = state.spokenNames[entry.conversationId];
          if (!name || unnamed.includes(entry)) return [];
          const settled = this.seenAgents.has(entry.conversationId);
          return [{ id: entry.conversationId, name, createdAt: entry.createdAt, settled }];
        })
      )
    );
    const duplicates = this.agentEntries.filter((entry) => renamed.has(entry.conversationId));
    const departed = [...this.departedConversationIds()].filter((id) => state.spokenNames[id]);
    this.forgetDeparted(departed);
    // An agent whose title is a name (its own, from before it was archived) takes it back before
    // the others are given the first free ones.
    const named = (entry: AgentTileEntry) =>
      parseAgentWindowNameSlot(entry.conversationTitle) !== null;
    const arriving = [
      ...unnamed.filter(named),
      ...unnamed.filter((entry) => !named(entry)),
      ...duplicates,
    ];
    for (const entry of this.agentEntries) {
      // An agent that exists holds its name by existing; the claim made for it has done its job.
      this.claimedNames.delete(entry.conversationId);
      this.seenAgents.set(entry.conversationId, {
        projectId: entry.projectId,
        taskId: entry.taskId,
      });
    }
    if (
      missing.length === 0 &&
      unnamed.length === 0 &&
      duplicates.length === 0 &&
      departed.length === 0
    ) {
      this.syncTitles([]);
      return;
    }

    this.updateState((current) => {
      const tiles = { ...current.tiles };
      const spokenNames = { ...current.spokenNames };
      // Regions are occupied space: new agents never land inside or on top of one.
      const regionRects = rootRegionRects(current.regions);
      if (missing.length > 0) {
        // Keep tiles from the same task adjacent: place per task group.
        const byTask = new Map<string, AgentTileEntry[]>();
        for (const entry of missing) {
          const group = byTask.get(entry.taskId) ?? [];
          group.push(entry);
          byTask.set(entry.taskId, group);
        }
        for (const group of byTask.values()) {
          const existing = [...Object.values(tiles), ...regionRects];
          const siblingRects = this.agentEntries
            .filter((entry) => entry.taskId === group[0]?.taskId && tiles[entry.tileId])
            .map((entry) => tiles[entry.tileId] as TileRect);
          // Siblings of an existing task extend its row; new tasks fill the first free grid slots.
          const anchor = siblingRects.length > 0 ? nextFreeAnchor(siblingRects) : { x: 0, y: 0 };
          const rects = placeTiles(existing, group.length, AGENT_TILE_SIZE, anchor);
          group.forEach((entry, index) => {
            const rect = rects[index];
            if (rect) tiles[entry.tileId] = rect;
          });
        }
      }
      // The names of agents known to be gone are free again, here and in later sessions.
      for (const id of departed) delete spokenNames[id];
      for (const entry of arriving) delete spokenNames[entry.conversationId];
      for (const entry of arriving) {
        spokenNames[entry.conversationId] = assignSpokenName(
          entry.conversationTitle,
          Object.values(spokenNames)
        );
      }
      return { ...current, tiles, spokenNames };
    });
    this.syncTitles(arriving);
    if (missing.length > 0) {
      this.joinNewTiles(
        missing.map((entry) => ({
          tileId: entry.tileId,
          conversationId: entry.conversationId,
          projectId: entry.projectId,
          projectName: entry.projectName,
        }))
      );
    }
  }

  /**
   * New windows join a region: a reserved region (a plan's, or the one the developer named), in
   * Canvas Pro their project's desk, the region in view when that setting is on, or the project's
   * main sub-canvas (created if needed). Not undoable (birth placement).
   */
  private joinNewTiles(tiles: readonly NewTile[]): void {
    // A gathering desk only hosts visitors: nothing is born on it.
    const currentRegionId = this.gatheringHere ? null : this.currentRegion();
    const layout = this.layoutState;
    const homes = this.homesForNewTiles(layout, tiles, { currentRegionId, pro: this.proMode });
    const ops = homes.flatMap(({ home, tiles: ids }) => opsForNewWindowHome(home, ids));
    if (ops.length === 0) return;
    const result = this.planOps(ops);
    if (!result.ok) return;
    this.writeLayout(tagProjectHomes(result.plan.state, homes));
    const created = result.plan.created.filter(isRegionId).at(-1);
    if (created) this.newestRegionId = created;
    // A window born on another page of the desk does not pull the user off the one they are on.
    this.markChanged(result.plan.summary, result.plan.targets, 'command', [], !this.proMode);
  }

  /** Where each new window goes, with the windows bound for the same place put together. */
  private homesForNewTiles(
    layout: LayoutState,
    tiles: readonly NewTile[],
    where: { currentRegionId: string | null; pro: boolean }
  ): NewTileHome[] {
    const settings = this.layoutSettings;
    const buckets = new Map<string, NewTileHome>();
    for (const tile of tiles) {
      const reservedName = tile.conversationId
        ? this.pendingRegions.get(tile.conversationId)
        : undefined;
      if (tile.conversationId) this.pendingRegions.delete(tile.conversationId);
      const home = homeForNewWindow({
        reservedName,
        currentRegionId: where.currentRegionId,
        projectId: tile.projectId,
        projectName: tile.projectName,
        layout,
        pro: where.pro,
        settings,
      });
      if (home.kind === 'root') continue;
      const key =
        home.kind === 'reserved'
          ? 'reserved:' + home.name
          : home.kind === 'current'
            ? 'current:' + home.regionId
            : 'project:' + home.projectId;
      const bucket = buckets.get(key);
      if (bucket) bucket.tiles.push(tile.tileId);
      else buckets.set(key, { home, tiles: [tile.tileId] });
    }
    return [...buckets.values()];
  }

  /** The project a window belongs to: agents, app browsers, and documents have one; notes not. */
  private projectOfTile(tileId: string): { projectId: string; projectName: string } | null {
    const entry =
      this.agentEntries.find((candidate) => candidate.tileId === tileId) ??
      this.browserEntries.find((candidate) => candidate.tileId === tileId) ??
      this.docEntries.find((candidate) => candidate.tileId === tileId);
    return entry?.projectId ? { projectId: entry.projectId, projectName: entry.projectName } : null;
  }

  /** The region the user is looking at: the board scope or the stage's region. */
  currentRegion(): string | null {
    const location = this.location;
    const id =
      location.kind === 'board'
        ? location.regionScope
        : location.target.kind === 'region'
          ? location.target.regionId
          : null;
    return id && this.state.regions[id] ? id : null;
  }

  setTileRect(tileId: string, rect: Partial<TileRect>): void {
    this.updateState((current) => ({
      ...current,
      tiles: { ...current.tiles, [tileId]: { ...this.tileRect(tileId), ...rect } },
    }));
  }

  setViewport(viewport: CanvasViewport): void {
    const current = this.state.viewport;
    if (current.x === viewport.x && current.y === viewport.y && current.zoom === viewport.zoom) {
      return;
    }
    this.updateState((state) => ({ ...state, viewport }));
  }

  setProjectFilter(projectId: string | null): void {
    this.updateState((current) => ({ ...current, projectFilter: projectId }));
  }

  // ── Multi-canvas ───────────────────────────────────────────────────────────

  /** How many views of the board share the screen (1: the single canvas). */
  get paneCount(): number {
    return clampPaneCount(this.state.panes?.count ?? 1);
  }

  get multiCanvas(): boolean {
    return this.paneCount > 1;
  }

  /**
   * The view the user last touched. `viewport`, `boardSize`, the board scope, and every viewport
   * command (focus, fit, frame) are this view's.
   */
  get activePane(): number {
    return Math.min(this.state.panes?.active ?? 0, this.paneCount - 1);
  }

  /** One entry per view; the active view's camera is always the board's `viewport`. */
  get paneViews(): PaneView[] {
    const stored = this.state.panes?.views ?? [];
    const active = this.activePane;
    const viewport = this.state.viewport;
    return Array.from({ length: this.paneCount }, (_, index) => {
      const view = stored[index] ?? { viewport, regionScope: null };
      return index === active ? { ...view, viewport } : view;
    });
  }

  /** The part of the board each view shows, in canvas units. */
  get paneRects(): TileRect[] {
    return this.paneViews.map((view, index) =>
      viewportRect(view.viewport, this.paneSizes[index] ?? this.boardSize)
    );
  }

  paneViewport(pane: number): CanvasViewport {
    return this.paneViews[pane]?.viewport ?? this.state.viewport;
  }

  /** The sub-canvas a view is in: the board scope for the active view, its own otherwise. */
  paneScope(pane: number): string | null {
    if (pane === this.activePane) return this.focusedRegionId;
    const scope = this.paneViews[pane]?.regionScope;
    const region = scope ? this.state.regions[scope] : undefined;
    return scope && region && !region.collapsed ? scope : null;
  }

  /**
   * The view a window is live in. A terminal or a webview mounts once, so a window that shows in
   * several views is live in the active one (else the first) and a placeholder in the others.
   */
  livePaneOf(tileId: string): number {
    if (this.paneCount === 1) return 0;
    return livePane(this.tileRect(tileId), this.paneRects, this.activePane);
  }

  /**
   * Splits the canvas into `count` views, or back into one. Splitting the single canvas keeps the
   * picture: each view continues it where that view lies. Going back keeps the active view.
   */
  setPaneCount(requested: number): void {
    // Canvas Pro shows one desk: a single view.
    const count = this.proMode ? 1 : clampPaneCount(requested);
    const before = this.paneCount;
    if (count === before) return;
    const current = this.paneViews;
    const active = this.activePane;
    const location = this.location;
    let views: PaneView[] = [];
    let nextActive = 0;
    if (count > 1 && before === 1) {
      const scope = location.kind === 'board' ? location.regionScope : null;
      views = splitViewport(this.state.viewport, paneBoxes(count, this.boardSize)).map(
        (viewport, index) => ({ viewport, regionScope: index === 0 ? scope : null })
      );
    } else if (count > 1) {
      views = Array.from(
        { length: count },
        (_, index) => current[index] ?? { viewport: this.state.viewport, regionScope: null }
      );
      // The active view survives a smaller split: it takes the last place.
      nextActive = Math.min(active, count - 1);
      const kept = current[active];
      if (kept && nextActive !== active) views[nextActive] = kept;
    }
    if (count > 1) this.lastMultiCount = count;
    this.paneRootViewports.clear();
    this.paneSizes = [];
    this.updateState((state) => ({ ...state, panes: { count, active: nextActive, views } }));
  }

  /** Multi-canvas on (the number of views it last had) or off. */
  toggleMultiCanvas(): void {
    this.setPaneCount(this.multiCanvas ? 1 : this.lastMultiCount);
  }

  /** Makes a view the active one: the board takes its camera and the sub-canvas it was in. */
  activatePane(pane: number): void {
    const count = this.paneCount;
    const from = this.activePane;
    if (count === 1 || pane === from || pane < 0 || pane >= count) return;
    const location = this.location;
    const views = [...this.paneViews];
    const left = views[from];
    const next = views[pane];
    if (!left || !next) return;
    if (location.kind === 'board') views[from] = { ...left, regionScope: location.regionScope };
    this.paneRootViewports.set(from, this.rootViewport);
    this.updateState((state) => ({
      ...state,
      viewport: next.viewport,
      panes: { count, active: pane, views },
    }));
    const size = this.paneSizes[pane];
    if (size) this.boardSize = size;
    if (location.kind === 'board') {
      const scope = next.regionScope && this.state.regions[next.regionScope];
      this.navigate(
        { kind: 'board', regionScope: scope ? next.regionScope : null },
        { record: false, reveal: false }
      );
    }
    this.rootViewport = this.paneRootViewports.get(pane) ?? null;
  }

  /** A view's camera moved. */
  setPaneViewport(pane: number, viewport: CanvasViewport): void {
    const panes = this.state.panes;
    if (!panes || this.paneCount === 1) {
      this.setViewport(viewport);
      return;
    }
    const views = this.paneViews;
    const current = views[pane]?.viewport;
    if (!current) return;
    if (current.x === viewport.x && current.y === viewport.y && current.zoom === viewport.zoom) {
      return;
    }
    const active = this.activePane;
    this.updateState((state) => ({
      ...state,
      ...(pane === active ? { viewport } : {}),
      panes: {
        count: this.paneCount,
        active,
        views: views.map((view, index) => (index === pane ? { ...view, viewport } : view)),
      },
    }));
  }

  /** A view's size in CSS px; the active view's is the board size. */
  setPaneSize(pane: number, width: number, height: number): void {
    if (width <= 0 || height <= 0) return;
    const known = this.paneSizes[pane];
    if (!known || known.width !== width || known.height !== height) {
      const sizes = [...this.paneSizes];
      sizes[pane] = { width, height };
      this.paneSizes = sizes;
    }
    if (pane === this.activePane) this.setBoardSize(width, height);
  }

  // ── Focus and viewport commands ────────────────────────────────────────────

  focusTile(tileId: string | null): void {
    this.focusedTileId = tileId;
    if (!tileId) return;
    this.focusOrder = [tileId, ...this.focusOrder.filter((id) => id !== tileId)].slice(0, 64);
    const entry = this.entryForTile(tileId);
    if (entry && !entry.seen) {
      conversationRegistry.get(entry.taskId)?.conversations.get(entry.conversationId)?.markSeen();
    }
  }

  /** Focuses a tile and asks the board to center it at interactive zoom. */
  requestFocus(tileId: string): void {
    // Canvas Pro: a window on another desk is not on screen, so its desk comes into view first.
    if (this.proMode && !isRegionId(tileId)) {
      this.revealOnDesk(tileId);
      this.showPageOf(tileId);
    }
    this.focusTile(tileId);
    // A desk that fills the screen is already framed at zoom 1: the camera stays put.
    if (this.proMode && this.deskLocked) return;
    this.viewportCommand = { id: ++this.commandSeq, kind: 'focus', tileId };
  }

  requestFit(tileIds?: readonly string[]): void {
    // Canvas Pro: the desk in view is the whole picture, so fitting means framing it again.
    const desk = this.activeDeskId;
    if (desk) {
      // What was asked to be seen is on another page: that page comes into view.
      const here = this.deskPage;
      const pages = (tileIds ?? []).flatMap((id) => {
        const page = this.pageOf(id);
        return page === null ? [] : [page];
      });
      const [first] = pages;
      if (first !== undefined && !pages.includes(here)) this.deskPages.set(desk, first);
      this.requestFrame(this.focusedRegionId ?? desk);
      return;
    }
    this.viewportCommand = { id: ++this.commandSeq, kind: 'fit', tileIds };
  }

  /** Asks the board to frame a region as the workspace (see `frameViewport`). */
  requestFrame(regionId: string, instant = false): void {
    // Canvas Pro: the camera is cut to a page, never flown across a board nobody sees.
    const cut = instant || this.proMode;
    this.viewportCommand = {
      id: ++this.commandSeq,
      kind: 'frame',
      regionId,
      ...(cut ? { instant: cut } : {}),
    };
  }

  /**
   * The camera for a `frame` command. Canvas Pro always frames the page in view of the desk in
   * view, at zoom 1; the classic canvas frames the region as a workspace.
   */
  frameViewportFor(regionId: string): CanvasViewport | null {
    const page = this.deskFrame;
    if (page) return frameViewport(page, this.boardSize, DESK_INSETS);
    const rect = this.regionEntry(regionId)?.rect;
    return rect ? frameViewport(rect, this.boardSize) : null;
  }

  /** Frames the sub-canvas the user is in, else fits the board. */
  reframe(): void {
    const regionId = this.focusedRegionId;
    if (regionId) this.requestFrame(regionId);
    else this.requestFit();
  }

  setScopeFramedZoom(zoom: number | null): void {
    this.scopeFramedZoom = zoom;
  }

  consumeViewportCommand(id: number): void {
    if (this.viewportCommand?.id === id) this.viewportCommand = null;
  }

  /** Focuses the agent that has waited longest for the user; returns false when none waits. */
  focusNextAttention(): boolean {
    const next =
      this.attentionEntries.find((entry) => entry.tileId !== this.focusedTileId) ??
      this.attentionEntries[0];
    if (!next) return false;
    this.requestFocus(next.tileId);
    return true;
  }

  /** When an agent started waiting for the user (epoch ms), if it is waiting now. */
  waitingSince(tileId: string): number | undefined {
    return this.attentionSince.get(tileId);
  }

  private trackAttention(): void {
    const waiting = new Set(this.agentEntries.filter(needsAttention).map((entry) => entry.tileId));
    runInAction(() => {
      for (const tileId of [...this.attentionSince.keys()]) {
        if (!waiting.has(tileId)) this.attentionSince.delete(tileId);
      }
      for (const tileId of waiting) {
        if (!this.attentionSince.has(tileId)) this.attentionSince.set(tileId, Date.now());
      }
    });
  }

  // ── Notes ──────────────────────────────────────────────────────────────────

  addNote(text = '', at?: { x: number; y: number }): string {
    const noteId = crypto.randomUUID();
    const existing = [...Object.values(this.state.tiles), ...rootRegionRects(this.state.regions)];
    const [rect] = at
      ? [{ ...at, ...NOTE_TILE_SIZE }]
      : placeTiles(existing, 1, NOTE_TILE_SIZE, nextFreeAnchor(existing));
    this.updateState((current) => ({
      ...current,
      notes: { ...current.notes, [noteId]: { text, color: 'yellow' } },
      tiles: {
        ...current.tiles,
        [noteTileId(noteId)]: rect ?? { x: 0, y: 0, ...NOTE_TILE_SIZE },
      },
    }));
    return noteId;
  }

  updateNote(noteId: string, patch: Partial<CanvasBoardState['notes'][string]>): void {
    const note = this.state.notes[noteId];
    if (!note) return;
    this.updateState((current) => ({
      ...current,
      notes: { ...current.notes, [noteId]: { ...note, ...patch } },
    }));
  }

  /** Records a note dropped onto an agent tile (largest overlap wins); ignores empty notes. */
  noteDropped(noteTile: string): void {
    const noteId = noteTile.slice('note:'.length);
    const text = this.state.notes[noteId]?.text.trim();
    if (!text) return;
    const rect = this.tileRect(noteTile);
    let best: { conversationId: string; area: number } | null = null;
    for (const entry of this.visibleAgentEntries) {
      const area = overlapArea(rect, this.tileRect(entry.tileId));
      if (area > 0 && (!best || area > best.area)) {
        best = { conversationId: entry.conversationId, area };
      }
    }
    if (!best) return;
    this.noteDrop = { id: ++this.commandSeq, noteId, conversationId: best.conversationId, text };
  }

  consumeNoteDrop(id: number): void {
    if (this.noteDrop?.id === id) this.noteDrop = null;
  }

  removeNote(noteId: string): void {
    this.updateState((current) => {
      const notes = { ...current.notes };
      const tiles = { ...current.tiles };
      const membership = { ...current.membership };
      delete notes[noteId];
      delete tiles[noteTileId(noteId)];
      delete membership[noteTileId(noteId)];
      return { ...current, notes, tiles, membership };
    });
  }

  // ── App browsers ───────────────────────────────────────────────────────────

  /**
   * Adds a task's app browser (or updates its URL) and places it beside the task's agents,
   * then joins the project sub-canvas by default. Returns the tile id.
   */
  openBrowser(input: {
    projectId: string;
    workspaceId: string;
    taskId: string;
    url?: string;
    control?: CanvasBrowserState['control'];
    focus?: boolean;
  }): string {
    const tileId = browserTileId(input.taskId);
    const existing = this.state.browsers[input.taskId];
    const hadTile = Boolean(this.state.tiles[tileId]);
    this.updateState((current) => {
      const browsers = {
        ...current.browsers,
        [input.taskId]: {
          projectId: input.projectId,
          workspaceId: input.workspaceId,
          url: input.url ?? existing?.url ?? 'about:blank',
          control: input.control ?? existing?.control ?? 'user',
          ...(existing?.title ? { title: existing.title } : {}),
        },
      };
      if (current.tiles[tileId]) {
        const hiddenTiles = current.hiddenTiles.filter((id) => id !== tileId);
        return { ...current, browsers, hiddenTiles };
      }
      const siblings = this.agentEntries
        .filter((entry) => entry.taskId === input.taskId && current.tiles[entry.tileId])
        .map((entry) => current.tiles[entry.tileId] as TileRect);
      const occupied = [...Object.values(current.tiles), ...rootRegionRects(current.regions)];
      const anchor = nextFreeAnchor(siblings.length > 0 ? siblings : occupied);
      const [rect] = placeTiles(occupied, 1, BROWSER_TILE_SIZE, anchor, 1);
      return {
        ...current,
        browsers,
        tiles: { ...current.tiles, [tileId]: rect ?? { ...anchor, ...BROWSER_TILE_SIZE } },
      };
    });
    if (!hadTile) {
      const projectName =
        this.browserEntries.find((entry) => entry.taskId === input.taskId)?.projectName ??
        this.projectManager.projects.get(input.projectId)?.name ??
        'Project';
      this.joinNewTiles([{ tileId, projectId: input.projectId, projectName }]);
    }
    if (input.focus !== false) this.requestFocus(tileId);
    return tileId;
  }

  closeBrowser(taskId: string): void {
    if (!this.state.browsers[taskId]) return;
    const tileId = browserTileId(taskId);
    this.updateState((current) => {
      const browsers = { ...current.browsers };
      const tiles = { ...current.tiles };
      const membership = { ...current.membership };
      delete browsers[taskId];
      delete tiles[tileId];
      delete membership[tileId];
      return {
        ...current,
        browsers,
        tiles,
        membership,
        hiddenTiles: current.hiddenTiles.filter((id) => id !== tileId),
      };
    });
    if (this.focusedTileId === tileId) this.focusedTileId = null;
  }

  setBrowserUrl(taskId: string, url: string, title?: string): void {
    const browser = this.state.browsers[taskId];
    if (!browser) return;
    if (browser.url === url && (title === undefined || browser.title === title)) return;
    this.updateState((current) => ({
      ...current,
      browsers: {
        ...current.browsers,
        [taskId]: { ...browser, url, ...(title !== undefined ? { title } : {}) },
      },
    }));
  }

  setBrowserControl(taskId: string, control: CanvasBrowserState['control']): void {
    const browser = this.state.browsers[taskId];
    if (!browser || browser.control === control) return;
    this.updateState((current) => ({
      ...current,
      browsers: { ...current.browsers, [taskId]: { ...browser, control } },
    }));
  }

  // ── Documents ──────────────────────────────────────────────────────────────

  /**
   * Opens a Markdown file as a document window, or brings the window already showing it back.
   * A new window is placed beside the agent that sent it (else beside its task's agents) and
   * joins the sub-canvas or desk the developer is in, else a region like any new window. Unless
   * `focus` is off the window is then shown: a project filter or a collapsed region that hides
   * it is lifted, and on the stage it joins what is staged. Returns the tile id, or null when
   * the file's task is not on the board, so it cannot be a window here.
   */
  openDoc(input: CanvasDocState & { conversationId?: string; focus?: boolean }): string | null {
    const { conversationId, focus, ...doc } = input;
    const project = this.projectManager.projects.get(doc.projectId);
    const task = asAvailableProject(project)?.get(taskManagerStoreToken).tasks.get(doc.taskId);
    if (!project || !task || !isCanvasTask(task)) return null;

    const open = Object.entries(this.state.docs ?? {}).find(
      ([, existing]) => existing.workspaceId === doc.workspaceId && existing.path === doc.path
    );
    const docId = open?.[0] ?? crypto.randomUUID();
    const tileId = docTileId(docId);
    const hadTile = Boolean(this.state.tiles[tileId]);
    this.updateState((current) => {
      const docs = { ...current.docs, [docId]: doc };
      if (current.tiles[tileId]) return { ...current, docs };
      const sender = conversationId ? current.tiles[agentTileId(conversationId)] : undefined;
      const beside = sender
        ? [sender]
        : this.agentEntries
            .filter((entry) => entry.taskId === doc.taskId && current.tiles[entry.tileId])
            .map((entry) => current.tiles[entry.tileId] as TileRect);
      const occupied = [...Object.values(current.tiles), ...rootRegionRects(current.regions)];
      const anchor = nextFreeAnchor(beside.length > 0 ? beside : occupied);
      const [rect] = placeTiles(occupied, 1, DOC_TILE_SIZE, anchor, 1);
      return {
        ...current,
        docs,
        tiles: { ...current.tiles, [tileId]: rect ?? { ...anchor, ...DOC_TILE_SIZE } },
      };
    });
    if (!hadTile) {
      this.homeNewDoc(tileId, doc.projectId, project.name ?? 'Project');
    } else if (this.state.hiddenTiles.includes(tileId)) {
      // Closed by a layout command: it returns through the planner, so a tiled region re-tiles.
      const planned = this.planOps([{ op: 'show', targets: [tileId] }]);
      const base = planned.ok ? planned.plan.state : this.layoutState;
      this.commitLayout(
        { ...base, hidden: base.hidden.filter((id) => id !== tileId) },
        planned.ok ? planned.plan.summary : `Reopened ${doc.title}`,
        'command',
        [tileId]
      );
    }
    if (focus !== false) this.presentDoc(tileId, doc.projectId);
    return tileId;
  }

  /** True when a document window is drawn where the developer is looking. */
  isDocOnScreen(tileId: string): boolean {
    if (!this.visibleTileIds().has(tileId)) return false;
    if (this.stageActive) return this.stagedSet.has(tileId);
    return !this.isFolded(tileId);
  }

  /** Closes a document window for good. Not undoable, like its opening. */
  closeDoc(docId: string): void {
    if (!this.state.docs?.[docId]) return;
    const tileId = docTileId(docId);
    // Out through the planner first, so a tiled region gives its space to the windows left.
    const planned = this.planOps([{ op: 'hide', targets: [tileId] }]);
    if (planned.ok) this.writeLayout(planned.plan.state);
    this.updateState((current) => {
      const docs = { ...current.docs };
      const tiles = { ...current.tiles };
      const membership = { ...current.membership };
      delete docs[docId];
      delete tiles[tileId];
      delete membership[tileId];
      return {
        ...current,
        docs,
        tiles,
        membership,
        hiddenTiles: current.hiddenTiles.filter((id) => id !== tileId),
      };
    });
    if (this.focusedTileId === tileId) this.focusedTileId = null;
  }

  /**
   * A new document joins the region the developer is in: the sub-canvas or desk in view, the
   * staged region, or the one a stage of picked windows was opened from. Elsewhere (the main
   * canvas, a gathering desk) it joins a region like any new window. Birth placement: not undoable.
   */
  private homeNewDoc(tileId: string, projectId: string, projectName: string): void {
    const location = this.location;
    const home = this.gatheringHere
      ? null
      : location.kind === 'stage' && location.target.kind !== 'region'
        ? this.lastBoardScope()
        : this.currentRegion();
    const planned = home
      ? this.planOps([{ op: 'move', targets: [tileId], to: { kind: 'region', region: home } }])
      : null;
    if (!planned?.ok) {
      this.joinNewTiles([{ tileId, projectId, projectName }]);
      return;
    }
    this.writeLayout(planned.plan.state);
    this.markChanged(planned.plan.summary, planned.plan.targets, 'command', []);
  }

  /** Shows a document the developer was just handed, where they are looking. */
  private presentDoc(tileId: string, projectId: string): void {
    const filter = this.state.projectFilter;
    if (filter !== null && filter !== projectId) this.setProjectFilter(null);
    for (let region = this.regionOf(tileId); region; region = this.regionOf(region)) {
      if (!this.state.regions[region]?.collapsed) continue;
      this.runLayout([{ op: 'collapseRegion', region, collapsed: false }], { source: 'command' });
    }
    if (this.location.kind !== 'stage') {
      this.requestFocus(tileId);
      return;
    }
    // On the stage the board's camera is out of sight, and a desk swap would leave the stage.
    this.stageAlso(tileId);
    this.focusTile(tileId);
  }

  /**
   * Puts a window on the stage that is open: into the staged region, or among the picked
   * windows. The stage keeps its page and arrangement; a pane shown alone gives way, so the
   * newcomer is seen.
   */
  private stageAlso(tileId: string): void {
    const location = this.location;
    if (location.kind !== 'stage') return;
    if (!this.stagedSet.has(tileId)) {
      if (location.target.kind === 'region') {
        const to = { kind: 'region' as const, region: location.target.regionId };
        this.runLayout([{ op: 'move', targets: [tileId], to }], { source: 'command' });
      } else {
        const tileIds = [...this.stageTileIds, tileId];
        const label =
          location.target.kind === 'selection' && !/^\d+ windows$/.test(location.target.label)
            ? location.target.label
            : `${tileIds.length} windows`;
        const target: StageTarget = { kind: 'selection', tileIds, label };
        this.updateState((state) => ({ ...state, location: { ...location, target } }));
      }
    }
    if (this.stageSaved.soloTileId && this.stageSaved.soloTileId !== tileId) {
      this.updateStage('Showed a document', (saved) => ({ ...saved, soloTileId: null }));
    }
  }

  // ── Regions, layout history, and navigation ────────────────────────────────

  /** The undoable part of the board: geometry, regions, membership, closed windows. */
  get layoutState(): LayoutState {
    const state = this.state;
    return {
      tiles: state.tiles,
      regions: state.regions,
      membership: state.membership,
      hidden: [...state.hiddenConversationIds.map(agentTileId), ...state.hiddenTiles],
    };
  }

  /** Every window the planner may act on (closed ones included, so "reopen" can find them). */
  get layoutWindows(): LayoutWindow[] {
    const windows: LayoutWindow[] = [];
    for (const entry of this.agentEntries) {
      windows.push({
        tileId: entry.tileId,
        kind: 'agent',
        name: this.spokenName(entry.conversationId),
        taskId: entry.taskId,
        taskName: entry.taskName,
        projectName: entry.projectName,
        projectId: entry.projectId,
        providerLabel: spokenProviderLabel(entry.providerId),
        status: windowStatus(entry),
      });
    }
    for (const entry of this.browserEntries) {
      windows.push({
        tileId: entry.tileId,
        kind: 'browser',
        name: `${entry.taskName} app`,
        taskId: entry.taskId,
        taskName: entry.taskName,
        projectName: entry.projectName,
        projectId: entry.projectId,
      });
    }
    for (const entry of this.docEntries) {
      windows.push({
        tileId: entry.tileId,
        kind: 'doc',
        name: entry.title,
        taskId: entry.taskId,
        taskName: entry.taskName,
        projectName: entry.projectName,
        projectId: entry.projectId,
      });
    }
    for (const entry of this.noteEntries) {
      windows.push({ tileId: entry.tileId, kind: 'note', name: noteName(entry.text) });
    }
    return windows;
  }

  /** Tile ids shown on the board right now (not closed, not filtered out). */
  visibleTileIds(): Set<string> {
    return new Set([
      ...this.visibleAgentEntries.map((entry) => entry.tileId),
      ...this.visibleBrowserEntries.map((entry) => entry.tileId),
      ...this.visibleDocEntries.map((entry) => entry.tileId),
      ...this.noteEntries.map((entry) => entry.tileId),
    ]);
  }

  get regionEntries(): RegionEntry[] {
    const layout = this.layoutState;
    const visible = this.visibleTileIds();
    const statuses = new Map(
      this.agentEntries.map((entry) => [entry.tileId, windowStatus(entry)] as const)
    );
    const entries: RegionEntry[] = [];
    for (const [regionId, region] of Object.entries(layout.regions)) {
      if (isFoldedAway(layout, regionId)) continue;
      const tiles = descendantTiles(layout, regionId).filter((id) => visible.has(id));
      const tileStatuses = tiles.map((id) => statuses.get(id));
      entries.push({
        regionId,
        name: region.name,
        parentId: parentOf(layout, regionId),
        color: region.color,
        collapsed: region.collapsed,
        rect: regionFootprint(region),
        depth: regionDepth(layout, regionId),
        windowCount: tiles.length,
        waiting: tileStatuses.filter((status) => status === 'needs-you').length,
        working: tileStatuses.filter((status) => status === 'working').length,
        failed: tileStatuses.filter((status) => status === 'error').length,
        summary: statusSummary(tileStatuses),
        auto: region.auto === true,
        tiled: isTiled(region),
      });
    }
    // Parents first so the board stacks nested regions above their parents.
    return entries.sort((a, b) => a.depth - b.depth || a.regionId.localeCompare(b.regionId));
  }

  regionEntry(regionId: string): RegionEntry | undefined {
    return this.regionEntries.find((entry) => entry.regionId === regionId);
  }

  /** Region a tile or region sits in (null at the root). */
  regionOf(id: string): string | null {
    return parentOf(this.layoutState, id);
  }

  /** True when a tile is inside a collapsed region (it is not drawn). */
  isFolded(tileId: string): boolean {
    return isFoldedAway(this.layoutState, tileId);
  }

  get layoutSettings(): CanvasLayoutSettings {
    return { ...DEFAULT_LAYOUT_SETTINGS, ...this.state.layoutSettings };
  }

  setLayoutSettings(patch: Partial<CanvasLayoutSettings>): void {
    this.updateState((current) => ({
      ...current,
      layoutSettings: { ...DEFAULT_LAYOUT_SETTINGS, ...current.layoutSettings, ...patch },
    }));
  }

  private layoutEnv(): LayoutEnv {
    return {
      windows: this.layoutWindows,
      screen: this.boardSize,
      viewport: this.state.viewport,
      frameAllowance: frameAllowanceFor(this.state.showTaskFrames),
      now: Date.now(),
      newId: () => newRegionId(crypto.randomUUID()),
      desks: this.proMode,
    };
  }

  /** Plans ops against the current board without applying them. */
  planOps(ops: readonly LayoutOp[]): PlanResult {
    return planLayout(this.layoutState, ops, this.layoutEnv());
  }

  /**
   * Plans and applies ops as one undoable change. With `allowPreview`, a large change (organize, a
   * dissolve, many windows moving) is shown as a ghost instead and returned unapplied; the caller
   * confirms with `applyPlan`.
   */
  runLayout(
    ops: readonly LayoutOp[],
    options: { source: LayoutSource; label?: string; allowPreview?: boolean }
  ): LayoutRunResult {
    const result = this.planOps(ops);
    if (!result.ok) return result;
    if (options.allowPreview && result.plan.tier === 'preview') {
      this.showGhost(result.plan, ops, options.source, options.label);
      return { ok: true, plan: result.plan, applied: false };
    }
    this.applyPlan(result.plan, options);
    return { ok: true, plan: result.plan, applied: true };
  }

  applyPlan(plan: LayoutPlan, options: { source: LayoutSource; label?: string }): void {
    this.ghost = null;
    const created = plan.created.filter(isRegionId).at(-1);
    if (created) this.newestRegionId = created;
    this.commitLayout(plan.state, options.label ?? plan.summary, options.source, plan.targets, {
      displaced: plan.displaced,
    });
  }

  showGhost(
    plan: LayoutPlan,
    ops: readonly LayoutOp[],
    source: LayoutSource,
    label?: string
  ): void {
    this.ghost = {
      id: ++this.commandSeq,
      state: plan.state,
      label: label ?? plan.summary,
      targets: plan.targets,
      ops,
      source,
    };
    const layout = this.layoutState;
    const shown = plan.targets.filter((id) => !isRegionId(id) || layout.regions[id]);
    if (this.location.kind === 'board' && shown.length > 0) this.requestFit(shown);
  }

  /** Applies the previewed change (re-planned against the board as it is now). */
  applyGhost(): LayoutRunResult | null {
    const ghost = this.ghost;
    if (!ghost) return null;
    this.ghost = null;
    return this.runLayout(ghost.ops, { source: ghost.source, label: ghost.label });
  }

  clearGhost(): void {
    this.ghost = null;
  }

  /** Writes `next` and records the difference for undo. Returns false when nothing changed. */
  commitLayout(
    next: LayoutState,
    label: string,
    source: LayoutSource,
    targets: readonly string[],
    extra: { displaced?: readonly string[] } = {}
  ): boolean {
    const diff = diffLayout(this.layoutState, next);
    if (!diff) return false;
    this.writeLayout(next);
    this.undoStack = pushHistory(this.undoStack, {
      id: ++this.commandSeq,
      label,
      source,
      before: diff.before,
      after: diff.after,
      at: Date.now(),
      targets,
    });
    this.redoStack = [];
    this.stageRedo = [];
    this.markChanged(label, targets, source, extra.displaced ?? []);
    return true;
  }

  private writeLayout(next: LayoutState): void {
    const agents: string[] = [];
    const others: string[] = [];
    for (const id of next.hidden) {
      if (id.startsWith('agent:')) agents.push(id.slice('agent:'.length));
      else others.push(id);
    }
    const deskBefore = this.activeDeskId;
    const scopeBefore = regionOfLocation(this.location);
    const preferred = [deskBefore, this.previousRegionId];
    this.updateState((current) => {
      const stageLayouts = Object.fromEntries(
        Object.entries(current.stageLayouts).filter(([regionId]) => next.regions[regionId])
      );
      const within = locationWithin(current.location, next);
      return {
        ...current,
        tiles: { ...next.tiles },
        regions: { ...next.regions },
        membership: { ...next.membership },
        hiddenConversationIds: agents,
        hiddenTiles: others,
        stageLayouts,
        // Canvas Pro: the desk in view was removed, so another one takes its place.
        location: current.mode === 'pro' ? locationOnDesk(within, next, preferred) : within,
      };
    });
    const after = this.location;
    if (deskBefore && after.kind === 'board' && after.regionScope) {
      // The scope went with a removed region: frame where the user is now (the camera is locked
      // on a desk, so it cannot be left framing something that is gone).
      const swapped = this.activeDeskId !== deskBefore;
      if (swapped) this.visitorIds = [];
      if (swapped || scopeBefore !== after.regionScope) {
        this.requestFrame(after.regionScope, swapped);
      }
    }
    const hidden = new Set(next.hidden);
    if (this.focusedTileId && hidden.has(this.focusedTileId)) this.focusedTileId = null;
    const stale = (id: string) => hidden.has(id) || (isRegionId(id) && !next.regions[id]);
    if (this.selection.some(stale)) this.selection = this.selection.filter((id) => !stale(id));
    // Canvas Pro: the desk in view is never folded away (an undo can fold it): it has no header
    // to unfold it from, and nothing on it would be drawn.
    const inView = this.activeDeskId;
    if (inView && next.regions[inView]?.collapsed) {
      const opened = this.planOps([{ op: 'collapseRegion', region: inView, collapsed: false }]);
      if (opened.ok) this.writeLayout(opened.plan.state);
    }
  }

  private markChanged(
    label: string,
    targets: readonly string[],
    source: LayoutSource,
    displaced: readonly string[],
    follow = true
  ): void {
    this.lastChange = {
      id: ++this.commandSeq,
      label,
      targets,
      displaced,
      source,
      at: Date.now(),
    };
    // Changes asked for by voice or command stay in sight: fit them when all are off screen.
    if (source === 'pointer' || source === 'keyboard' || this.location.kind !== 'board') return;
    if (!follow) return;
    const visible = this.visibleTileIds();
    const layout = this.layoutState;
    const shown = targets.filter(
      (id) =>
        (isRegionId(id) ? Boolean(layout.regions[id]) : visible.has(id)) &&
        !isFoldedAway(layout, id)
    );
    if (shown.length === 0) return;
    const view = viewportRect(this.state.viewport, this.boardSize);
    if (!shown.some((id) => rectsOverlap(nodeRect(layout, id), view))) this.requestFit(shown);
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0 || this.stageUndo.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0 || this.stageRedo.length > 0;
  }

  /** What undo would revert, for tooltips and "what did you just do?". */
  get undoLabel(): string | null {
    const layout = this.undoStack.at(-1);
    const stage = this.stageUndo.at(-1);
    if (stage && (!layout || stage.at > layout.at)) return stage.label;
    return layout?.label ?? null;
  }

  get redoLabel(): string | null {
    const layout = this.redoStack.at(-1);
    const stage = this.stageRedo.at(-1);
    if (stage && (!layout || stage.at > layout.at)) return stage.label;
    return layout?.label ?? null;
  }

  undo(): LayoutUndoResult | null {
    this.ghost = null;
    const layout = this.undoStack.at(-1);
    const stage = this.stageUndo.at(-1);
    if (stage && (!layout || stage.at > layout.at)) {
      this.stageUndo = this.stageUndo.slice(0, -1);
      this.stageRedo = [...this.stageRedo, stage];
      this.writeStage(stage.key, stage.before);
      return { label: stage.label, conflicts: 0 };
    }
    if (!layout) return null;
    const result = undoEntry(this.layoutState, layout);
    this.undoStack = this.undoStack.slice(0, -1);
    this.redoStack = [...this.redoStack, layout];
    // Undoing the switch to Canvas Pro goes back to the classic canvas with it: its loose windows
    // could not leave their desk while every window must be on one.
    if (layout.id === this.proEntryId && this.proMode) {
      this.visitorIds = [];
      this.updateState((state) => ({ ...state, mode: 'classic' }));
    }
    this.writeLayout(result.state);
    this.markChanged(`Undid: ${layout.label}`, layout.targets, 'command', []);
    return { label: layout.label, conflicts: result.conflicts };
  }

  redo(): LayoutUndoResult | null {
    this.ghost = null;
    const layout = this.redoStack.at(-1);
    const stage = this.stageRedo.at(-1);
    if (stage && (!layout || stage.at > layout.at)) {
      this.stageRedo = this.stageRedo.slice(0, -1);
      this.stageUndo = [...this.stageUndo, stage];
      this.writeStage(stage.key, stage.after);
      return { label: stage.label, conflicts: 0 };
    }
    if (!layout) return null;
    const result = redoEntry(this.layoutState, layout);
    this.redoStack = this.redoStack.slice(0, -1);
    this.undoStack = [...this.undoStack, layout];
    this.writeLayout(result.state);
    this.markChanged(`Redid: ${layout.label}`, layout.targets, 'command', []);
    // Redoing the switch to Canvas Pro switches again.
    if (layout.id === this.proEntryId && !this.proMode) {
      this.setPaneCount(1);
      this.updateState((state) => ({ ...state, mode: 'pro' }));
      this.showDesk(deskIds(this.layoutState)[0] ?? null);
    }
    return { label: layout.label, conflicts: result.conflicts };
  }

  setSelection(ids: readonly string[]): void {
    if (ids.length === this.selection.length && ids.every((id, i) => this.selection[i] === id)) {
      return;
    }
    this.selection = [...ids];
  }

  setBoardSize(width: number, height: number): void {
    if (width <= 0 || height <= 0) return;
    if (this.boardSize.width === width && this.boardSize.height === height) return;
    this.boardSize = { width, height };
    // A screen-sized workspace follows the window once the resize settles.
    if (this.refitTimer) clearTimeout(this.refitTimer);
    this.refitTimer = null;
    // Canvas Pro: the desk in view follows the window wherever the user is (the Stage included).
    const desk = this.activeDeskId;
    if (!this.focusedRegionId && !desk) return;
    this.refitTimer = setTimeout(() => {
      this.refitTimer = null;
      if (this.disposed) return;
      if (this.proMode) {
        const inView = this.activeDeskId;
        if (inView) this.settleDesk(inView);
      } else {
        this.refitScope();
      }
    }, REFIT_DELAY_MS);
  }

  /**
   * Re-tiles the focused region's top-level workspace to the board size (when it is screen-sized
   * and tiled) and frames the region again. Not undoable: it follows the window, not the user.
   */
  refitScope(): void {
    const regionId = this.focusedRegionId;
    if (!regionId) return;
    this.fitWorkspace(regionId);
    this.requestFrame(regionId);
  }

  /**
   * Re-tiles the screen-sized, tiled workspace a region is in to the board size. Not undoable.
   * `ifResized`: only when its size is not the screen's (a desk coming into view), so a desk that
   * already fits is not written to, which would make a later undo of its creation see it as
   * changed since and leave it behind.
   */
  private fitWorkspace(regionId: string, options: { ifResized?: boolean } = {}): void {
    if (this.proMode) {
      // A desk is laid out by the desk rules, for this screen, whatever it was before.
      const desk = deskOf(this.layoutState, regionId);
      if (desk) this.settleDesk(desk);
      return;
    }
    const layout = this.layoutState;
    const [root] = regionPath(layout, regionId);
    const top = root ? layout.regions[root] : undefined;
    if (!root || !top || !isTiled(top) || top.screenSized === false) return;
    const size = workspaceSize(this.boardSize);
    if (options.ifResized && top.rect.w === size.w && top.rect.h === size.h) return;
    const result = this.planOps([{ op: 'fitRegion', region: root }]);
    if (result.ok && diffLayout(layout, result.plan.state)) this.writeLayout(result.plan.state);
  }

  setListening(listening: boolean): void {
    this.listening = listening;
  }

  setDropHint(regionId: string | null): void {
    if (this.dropHint !== regionId) this.dropHint = regionId;
  }

  setRenamingRegion(regionId: string | null): void {
    this.renamingRegionId = regionId;
  }

  /**
   * Groups the given windows and regions (default: the selection) into a new region and opens its
   * name for editing. Returns the region id.
   */
  groupSelection(ids: readonly string[] = this.selection, name?: string): string | null {
    const visiting = this.visitorRects;
    const members = ids.filter((id) => !id.startsWith('frame:') && !visiting.has(id));
    if (members.length === 0) return null;
    const result = this.runLayout([{ op: 'createRegion', members, ...(name ? { name } : {}) }], {
      source: 'keyboard',
    });
    if (!result.ok) return null;
    const regionId = result.plan.created[0] ?? null;
    if (regionId) this.goToRegion(regionId);
    if (regionId && !name) this.renamingRegionId = regionId;
    if (regionId) this.selection = [regionId];
    return regionId;
  }

  /**
   * Pointer drops: each dragged node lands where it was dropped, in the deepest region under its
   * upper middle (dragging onto a region adds it; dragging out takes it to the board).
   */
  dropNodes(drops: readonly { id: string; x: number; y: number }[]): void {
    const layout = this.layoutState;
    const visiting = this.visitorRects;
    const ops: LayoutOp[] = [];
    for (const drop of drops.slice(0, 12)) {
      // A visitor has no place of its own here to change.
      if (visiting.has(drop.id)) continue;
      const rect = nodeRect(layout, drop.id);
      if (Math.round(rect.x) === Math.round(drop.x) && Math.round(rect.y) === Math.round(drop.y)) {
        continue;
      }
      const probe = { x: drop.x + rect.w / 2, y: drop.y + Math.min(rect.h / 2, 60) };
      const region = this.dropRegionAt(probe, isRegionId(drop.id) ? drop.id : undefined);
      ops.push({
        op: 'move',
        targets: [drop.id],
        to: { kind: 'exact', x: drop.x, y: drop.y, region },
      });
    }
    if (ops.length > 0) this.runLayout(ops, { source: 'pointer' });
    if (this.proMode) this.boardSync++;
  }

  /**
   * The region a pointer drop at `probe` lands in. Canvas Pro: always on the desk in view (the
   * other desks sit beside it on a board the user never sees, and must not catch a drop).
   */
  dropRegionAt(probe: { x: number; y: number }, exclude?: string): string | null {
    const layout = this.layoutState;
    const region = regionAt(layout, probe, exclude);
    const desk = this.activeDeskId;
    if (!desk) return region;
    return region && isWithin(layout, region, desk) ? region : desk;
  }

  resizeTile(tileId: string, rect: TileRect): void {
    if (this.visitorRects.has(tileId)) return;
    this.runLayout([{ op: 'resize', targets: [tileId], size: { kind: 'exact', rect } }], {
      source: 'pointer',
    });
    if (this.proMode) this.boardSync++;
  }

  /** Reserves a region for agents about to be created; they join it as their tiles appear. */
  reserveRegion(conversationIds: readonly string[], preferredName: string): string {
    const taken = [
      ...Object.values(this.state.regions).map((region) => region.name),
      ...this.pendingRegions.values(),
    ];
    const name = uniqueName(preferredName, taken);
    for (const id of conversationIds) this.pendingRegions.set(id, name);
    return name;
  }

  /** Puts an agent that is about to be created into a region (created if needed) on arrival. */
  joinRegionOnArrival(conversationId: string, regionName: string): void {
    this.pendingRegions.set(conversationId, regionName);
  }

  // ── Location: board scope, stage, and the trail ────────────────────────────

  get location(): CanvasLocation {
    return this.state.location ?? BOARD_ROOT;
  }

  get stageActive(): boolean {
    return this.location.kind === 'stage';
  }

  get stageTarget(): StageTarget | null {
    const location = this.location;
    return location.kind === 'stage' ? location.target : null;
  }

  /** Windows on the stage in natural (reading) order, before the user's pane order. */
  get stageTileIds(): string[] {
    return this.tilesFor(this.stageTarget);
  }

  private tilesFor(target: StageTarget | null): string[] {
    if (!target) return [];
    const visible = this.visibleTileIds();
    const layout = this.layoutState;
    switch (target.kind) {
      case 'region':
        return readingOrder(
          descendantTiles(layout, target.regionId).filter((id) => visible.has(id)),
          (id) => nodeRect(layout, id)
        );
      case 'selection':
        return target.tileIds.filter((id) => visible.has(id));
      case 'solo':
        return visible.has(target.tileId) ? [target.tileId] : [];
    }
  }

  get stagedSet(): ReadonlySet<string> {
    return new Set(this.stageTileIds);
  }

  /** True when a tile is on the stage (its board tile shows a placeholder, not a second mount). */
  isStaged(tileId: string): boolean {
    return this.stagedSet.has(tileId);
  }

  private get stageKey(): string {
    const target = this.stageTarget;
    return target?.kind === 'region' ? target.regionId : TRANSIENT_STAGE_KEY;
  }

  /** Pane order right now: the saved order for windows still there, then newcomers. */
  stageOrderNow(): string[] {
    return stageOrder(this.stageSaved.order, this.stageTileIds);
  }

  get stageSaved(): StageSaved {
    const key = this.stageKey;
    if (key === TRANSIENT_STAGE_KEY) return this.transientStage;
    return this.state.stageLayouts[key] ?? EMPTY_STAGE;
  }

  get stageTitle(): string {
    const target = this.stageTarget;
    if (!target) return '';
    switch (target.kind) {
      case 'region':
        return this.state.regions[target.regionId]?.name ?? 'Region';
      case 'selection':
        return target.label;
      case 'solo':
        return this.windowName(target.tileId);
    }
  }

  /** Spoken name of a window or region ("Atlas", "Checkout app", "Review"). */
  windowName(id: string): string {
    if (isRegionId(id)) return this.state.regions[id]?.name ?? 'Region';
    return this.layoutWindows.find((window) => window.tileId === id)?.name ?? 'Window';
  }

  /** Changes the stage arrangement (pane order, split ratios, solo) as one undoable edit. */
  updateStage(label: string, update: (saved: StageSaved) => StageSaved): void {
    const key = this.stageKey;
    const before = this.stageSaved;
    const after = update(before);
    if (after === before) return;
    this.writeStage(key, after);
    const now = Date.now();
    const last = this.stageUndo.at(-1);
    // Splitter drags arrive as a stream; fold them into one step.
    if (last && last.key === key && last.label === label && now - last.at < 1500) {
      this.stageUndo = [...this.stageUndo.slice(0, -1), { ...last, after, at: now }];
    } else {
      const entry = { key, before, after, label, at: now };
      this.stageUndo = [...this.stageUndo, entry].slice(-MAX_TRAIL);
    }
    this.stageRedo = [];
  }

  private writeStage(key: string, saved: StageSaved): void {
    if (key === TRANSIENT_STAGE_KEY) {
      this.transientStage = saved;
      return;
    }
    if (!this.state.regions[key]) return;
    this.updateState((current) => ({
      ...current,
      stageLayouts: {
        ...current.stageLayouts,
        [key]: { order: [...saved.order], trees: { ...saved.trees }, soloTileId: saved.soloTileId },
      },
    }));
  }

  get breadcrumbs(): { label: string; location: CanvasLocation }[] {
    const location = this.location;
    const crumbs: { label: string; location: CanvasLocation }[] = [
      { label: 'Canvas', location: BOARD_ROOT },
    ];
    const layout = this.layoutState;
    const regionId =
      location.kind === 'board'
        ? location.regionScope
        : location.target.kind === 'region'
          ? location.target.regionId
          : null;
    for (const id of regionPath(layout, regionId)) {
      crumbs.push({
        label: layout.regions[id]?.name ?? 'Region',
        location: { kind: 'board', regionScope: id },
      });
    }
    if (location.kind === 'stage') {
      crumbs.push({
        label: location.target.kind === 'region' ? 'Stage' : this.stageTitle,
        location,
      });
    }
    return crumbs;
  }

  /** Goes to a location, recording where the user was for "back". */
  navigate(target: CanvasLocation, options: { record?: boolean; reveal?: boolean } = {}): void {
    const current = this.location;
    const location = this.onDesk(target);
    const reveal = options.reveal !== false;
    if (sameLocation(current, location)) {
      if (reveal) this.revealLocation(location);
      return;
    }
    if (options.record !== false) {
      this.backTrail = [...this.backTrail, current].slice(-MAX_TRAIL);
      this.forwardTrail = [];
    }
    if (current.kind === 'stage' && !sameStageTarget(current, location)) {
      this.transientStage = EMPTY_STAGE;
    }
    const from = regionOfLocation(current);
    const to = regionOfLocation(location);
    if (from && from !== to) this.previousRegionId = from;
    // Leaving the main canvas for a region: remember its camera for the way back.
    if (current.kind === 'board' && !current.regionScope && to) {
      this.rootViewport = { ...this.state.viewport };
    }
    if (to !== from) this.scopeFramedZoom = null;
    // Canvas Pro: another desk comes into view. Visitors belonged to the one that was showing.
    const deskBefore = this.deskAt(current);
    const swapped = this.proMode && deskBefore !== this.deskAt(location);
    if (swapped) this.previousDeskId = deskBefore;
    if (swapped && this.visitorIds.length > 0) this.visitorIds = [];
    this.updateState((state) => ({ ...state, location }));
    // A desk made at another window size (or before the canvas was measured) fits this screen.
    if (swapped && to) this.fitWorkspace(to, { ifResized: true });
    if (!reveal) return;
    if (location.kind === 'board' && !to && from) this.revealRoot();
    else this.revealLocation(location, swapped);
  }

  private revealLocation(location: CanvasLocation, instant = false): void {
    if (location.kind !== 'board') return;
    if (location.regionScope && this.state.regions[location.regionScope]) {
      this.requestFrame(location.regionScope, instant);
    }
  }

  /** Canvas Pro has no main board to be on: a board location with no region is the desk in view. */
  private onDesk(location: CanvasLocation): CanvasLocation {
    if (!this.proMode || location.kind !== 'board' || location.regionScope) return location;
    const desk = this.activeDeskId;
    return desk ? { kind: 'board', regionScope: desk } : location;
  }

  /** The desk a location is on; a stage of loose windows stays on the desk in view. */
  private deskAt(location: CanvasLocation): string | null {
    return deskOf(this.layoutState, regionOfLocation(location)) ?? this.activeDeskId;
  }

  /** Back on the main canvas: the camera the user left it with, else everything. */
  private revealRoot(): void {
    const viewport = this.rootViewport;
    this.rootViewport = null;
    if (viewport) this.viewportCommand = { id: ++this.commandSeq, kind: 'restore', viewport };
    else this.requestFit();
  }

  back(): boolean {
    const previous = this.backTrail.at(-1);
    if (!previous) return false;
    this.backTrail = this.backTrail.slice(0, -1);
    this.forwardTrail = [...this.forwardTrail, this.location].slice(-MAX_TRAIL);
    this.navigate(this.validLocation(previous), { record: false });
    return true;
  }

  forward(): boolean {
    const next = this.forwardTrail.at(-1);
    if (!next) return false;
    this.forwardTrail = this.forwardTrail.slice(0, -1);
    this.backTrail = [...this.backTrail, this.location].slice(-MAX_TRAIL);
    this.navigate(this.validLocation(next), { record: false });
    return true;
  }

  /** One level out: stage → its region on the board → the parent region → the whole board. */
  up(): boolean {
    const location = this.location;
    if (location.kind === 'stage') {
      const target = location.target;
      this.navigate({
        kind: 'board',
        regionScope: target.kind === 'region' ? target.regionId : this.lastBoardScope(),
      });
      return true;
    }
    if (!location.regionScope) return false;
    const parent = this.regionOf(location.regionScope);
    // A desk has no board above it: you switch desks, you do not leave one.
    if (!parent && this.proMode) return false;
    this.navigate({ kind: 'board', regionScope: parent });
    return true;
  }

  /** The main canvas, with the camera where the user left it (Canvas Pro: the first desk). */
  home(): void {
    if (this.proMode) {
      const [first] = deskIds(this.layoutState);
      if (first) this.switchDesk(first);
      return;
    }
    const from = regionOfLocation(this.location);
    this.navigate(BOARD_ROOT);
    if (!from) this.requestFit();
  }

  /**
   * Leaves the focused region for its parent (or the main canvas) without moving the camera: the
   * user already moved it (panned or zoomed away, clicked outside).
   */
  leaveScope(): boolean {
    const location = this.location;
    if (location.kind !== 'board' || !location.regionScope) return false;
    const parent = this.regionOf(location.regionScope);
    if (!parent && this.proMode) return false;
    // Classic: the user already moved the camera. Canvas Pro: the desk is framed again, since a
    // desk that fills the screen cannot be panned back into place.
    this.navigate({ kind: 'board', regionScope: parent }, { reveal: this.proMode });
    if (!parent) this.rootViewport = null;
    return true;
  }

  /**
   * The user moved the camera to `view` (flow coordinates) at `zoom`. Having left the focused
   * region, the board scope becomes the innermost region still in view, else the main canvas.
   */
  cameraMoved(view: TileRect, zoom: number): void {
    // Canvas Pro: there is nowhere to pan away to; desks are switched, not left.
    if (this.proMode) return;
    const regionId = this.focusedRegionId;
    if (!regionId) return;
    const layout = this.layoutState;
    const framed = this.scopeFramedZoom ?? zoom;
    const left = (id: string) => {
      const region = layout.regions[id];
      return (
        !region ||
        cameraLeftRegion(view, regionFootprint(region), { current: zoom, framed: framed })
      );
    };
    if (!left(regionId)) return;
    let target = this.regionOf(regionId);
    while (target && left(target)) target = this.regionOf(target);
    this.navigate({ kind: 'board', regionScope: target }, { reveal: false });
    if (!target) this.rootViewport = null;
  }

  /** Switches to the next or previous region beside the current one. Returns the region id. */
  goToAdjacentRegion(step: 1 | -1): string | null {
    if (this.proMode) {
      // On a desk (not inside one of its regions): the next or previous desk in order.
      const desk = this.activeDeskId;
      const current = this.currentRegion();
      if (!current || current === desk) return this.stepDesk(step);
      // Inside one of its regions: the region beside it, else the next desk.
      const beside = adjacentRegion(this.layoutState, current, step);
      if (!beside) return this.stepDesk(step);
    }
    const next = adjacentRegion(this.layoutState, this.currentRegion(), step);
    if (!next || !this.goToRegion(next)) return null;
    return next;
  }

  /** Canvas Pro: swaps to the next or previous desk in order, wherever the user is on this one. */
  stepDesk(step: 1 | -1): string | null {
    const other = adjacentDesk(this.layoutState, this.activeDeskId, step);
    return other && this.switchDesk(other) ? other : null;
  }

  /** Shows a region on the board (expanding it when collapsed). */
  goToRegion(regionId: string): boolean {
    const region = this.state.regions[regionId];
    if (!region) return false;
    if (region.collapsed) {
      this.runLayout([{ op: 'collapseRegion', region: regionId, collapsed: false }], {
        source: 'command',
      });
    }
    this.navigate({ kind: 'board', regionScope: regionId });
    return true;
  }

  /** Opens the stage for a region, a set of windows, or one window. Returns false when empty. */
  enterStage(target: StageTarget, options: { immersive?: boolean; page?: number } = {}): boolean {
    if (this.tilesFor(target).length === 0) return false;
    if (target.kind === 'region' && this.state.regions[target.regionId]?.collapsed) {
      this.runLayout([{ op: 'collapseRegion', region: target.regionId, collapsed: false }], {
        source: 'command',
      });
    }
    this.navigate({
      kind: 'stage',
      target,
      page: options.page ?? 0,
      immersive: options.immersive ?? false,
    });
    return true;
  }

  /**
   * Stages what the user is working with: a selected region, the selected windows (one is solo),
   * else the region in view, else the focused window. Returns false when there is nothing.
   */
  stageSelection(): boolean {
    if (this.stageActive) return false;
    const selection = this.selection;
    const [first] = selection;
    if (selection.length === 1 && first && isRegionId(first)) {
      return this.enterStage({ kind: 'region', regionId: first });
    }
    const windows = selection.filter((id) => !isRegionId(id));
    const [only] = windows;
    if (windows.length === 1 && only) return this.enterStage({ kind: 'solo', tileId: only });
    if (windows.length > 1) {
      return this.enterStage({
        kind: 'selection',
        tileIds: windows,
        label: `${windows.length} windows`,
      });
    }
    const region = this.currentRegion();
    if (region) return this.enterStage({ kind: 'region', regionId: region });
    if (this.focusedTileId) return this.enterStage({ kind: 'solo', tileId: this.focusedTileId });
    return false;
  }

  leaveStage(): boolean {
    if (this.location.kind !== 'stage') return false;
    this.navigate({ kind: 'board', regionScope: this.lastBoardScope() });
    return true;
  }

  setStagePage(page: number): void {
    const location = this.location;
    const next = Math.max(0, page);
    if (location.kind !== 'stage' || location.page === next) return;
    this.updateState((state) => ({ ...state, location: { ...location, page: next } }));
  }

  setStageImmersive(immersive: boolean): void {
    const location = this.location;
    if (location.kind !== 'stage' || location.immersive === immersive) return;
    this.updateState((state) => ({ ...state, location: { ...location, immersive } }));
  }

  private lastBoardScope(): string | null {
    for (let i = this.backTrail.length - 1; i >= 0; i--) {
      const location = this.backTrail[i];
      if (location?.kind === 'board') {
        return location.regionScope && this.state.regions[location.regionScope]
          ? location.regionScope
          : null;
      }
    }
    return null;
  }

  /** A trail entry whose region is gone falls back to the board. */
  private validLocation(location: CanvasLocation): CanvasLocation {
    return locationWithin(location, this.layoutState);
  }

  // ── Canvas Pro: desks ──────────────────────────────────────────────────────

  get mode(): CanvasMode {
    return this.state.mode ?? 'classic';
  }

  /** Canvas Pro: top-level regions are desks, shown one at a time. */
  get proMode(): boolean {
    return this.mode === 'pro';
  }

  /** The desk in view (Canvas Pro only): where the board is, else where it last was. */
  get activeDeskId(): string | null {
    if (!this.proMode) return null;
    const layout = this.layoutState;
    return (
      deskOf(layout, this.currentRegion()) ??
      deskOf(layout, this.lastBoardScope()) ??
      deskIds(layout)[0] ??
      null
    );
  }

  /** Desks in order (empty on the classic canvas). */
  get desks(): DeskEntry[] {
    if (!this.proMode) return [];
    const layout = this.layoutState;
    const active = this.activeDeskId;
    const entries = new Map(this.regionEntries.map((entry) => [entry.regionId, entry] as const));
    return deskIds(layout).flatMap((regionId, index) => {
      const entry = entries.get(regionId);
      if (!entry) return [];
      return [
        {
          regionId,
          name: entry.name,
          index,
          color: entry.color,
          active: regionId === active,
          windowCount: entry.windowCount,
          waiting: entry.waiting,
          working: entry.working,
          failed: entry.failed,
          summary: entry.summary,
          gather: layout.regions[regionId]?.gather ?? null,
        },
      ];
    });
  }

  /** The desk a window or region is on (null for a loose window). */
  deskOf(id: string): string | null {
    return deskOf(this.layoutState, id);
  }

  /**
   * True on a desk: the camera stays on the page in view, at zoom 1. A desk always fills the
   * screen (see `desk-layout.ts`), so there is nothing beside it to pan or zoom out to.
   */
  get deskLocked(): boolean {
    return this.deskFrame !== null;
  }

  /** Pages of the desk in view: 1 unless it holds more windows than fit one screen comfortably. */
  get deskPageCount(): number {
    const desk = this.activeDeskId;
    const region = desk ? this.state.regions[desk] : undefined;
    return region ? deskPageCount(region.rect, this.boardSize) : 1;
  }

  /** The page in view of the desk in view. */
  get deskPage(): number {
    const desk = this.activeDeskId;
    if (!desk) return 0;
    return Math.min(this.deskPageCount - 1, Math.max(0, this.deskPages.get(desk) ?? 0));
  }

  /** The part of the board the camera shows in Canvas Pro: the page in view (null off a desk). */
  get deskFrame(): TileRect | null {
    const desk = this.activeDeskId;
    const region = desk ? this.state.regions[desk] : undefined;
    return region ? deskPageBox(region.rect, this.boardSize, this.deskPage) : null;
  }

  /** The page of the desk in view a window or region lies on (null when it is not on that desk). */
  pageOf(id: string): number | null {
    const desk = this.activeDeskId;
    const layout = this.layoutState;
    const region = desk ? layout.regions[desk] : undefined;
    if (!desk || !region || id === desk || this.visitorRects.has(id)) return null;
    if (deskOf(layout, id) !== desk) return null;
    return deskPageOf(region.rect, this.boardSize, nodeRect(layout, id));
  }

  /** The pages of the desk in view with what is on each, for the pager. */
  get deskPager(): DeskPageEntry[] {
    const desk = this.activeDeskId;
    if (!desk) return [];
    const active = this.deskPage;
    const pages = Array.from({ length: this.deskPageCount }, (_, index) => ({
      index,
      active: index === active,
      windowCount: 0,
      waiting: 0,
      working: 0,
      failed: 0,
    }));
    const statuses = new Map(
      this.agentEntries.map((entry) => [entry.tileId, windowStatus(entry)] as const)
    );
    for (const id of this.visibleTileIds()) {
      const page = pages[this.pageOf(id) ?? -1];
      if (!page || this.isFolded(id)) continue;
      page.windowCount++;
      const status = statuses.get(id);
      if (status === 'needs-you') page.waiting++;
      else if (status === 'working') page.working++;
      else if (status === 'error') page.failed++;
    }
    return pages;
  }

  /** Shows a page of the desk in view. Returns false when there is no such page. */
  setDeskPage(page: number): boolean {
    const desk = this.activeDeskId;
    if (!desk || page < 0 || page >= this.deskPageCount) return false;
    if (page !== this.deskPage) this.deskPages.set(desk, page);
    return true;
  }

  /** The next (1) or previous (-1) page of the desk in view. */
  stepDeskPage(step: 1 | -1): boolean {
    return this.setDeskPage(this.deskPage + step);
  }

  /** Brings the page a window or region is on into view. */
  private showPageOf(id: string): void {
    const page = this.pageOf(id);
    if (page !== null) this.setDeskPage(page);
  }

  /** How the desk in view breaks the desk rules right now (empty when it holds them). */
  get deskViolations(): DeskViolation[] {
    const desk = this.activeDeskId;
    if (!desk) return [];
    return deskViolations(this.layoutState, desk, {
      screen: this.boardSize,
      frameAllowance: frameAllowanceFor(this.state.showTaskFrames),
      present: this.visibleTileIds(),
    });
  }

  /** Lays a desk out again by the desk rules, for this screen. Not undoable. */
  private settleDesk(deskId: string): void {
    const layout = this.layoutState;
    const next = settleDesks(layout, this.layoutEnv(), [deskId]);
    if (diffLayout(layout, next)) this.writeLayout(next);
  }

  /**
   * The desk in view stopped holding the desk rules without a planned change (`drift` says how;
   * null: it holds them again). It is laid out again, at once unless the window is still being
   * resized, in which case the refit that follows the resize does it.
   */
  private repairDesk(drift: string | null): void {
    if (!drift) {
      this.deskRepairs = 0;
      return;
    }
    const desk = this.activeDeskId;
    if (!desk || this.refitTimer) return;
    if (this.deskRepairs >= MAX_DESK_REPAIRS) {
      log.warn('Canvas: the desk in view keeps breaking the desk rules', { drift });
      return;
    }
    this.deskRepairs++;
    this.settleDesk(desk);
  }

  /** Desks out of view with agents waiting or failed, by the screen edge they lie toward. */
  get deskSignals(): DeskSignal[] {
    return deskSignals(this.desks, this.activeDeskId);
  }

  /** Follows a signal: brings that desk into view and focuses the agent there that needs the user. */
  answerDesk(regionId: string): boolean {
    if (!this.switchDesk(regionId)) return false;
    const layout = this.layoutState;
    const waiting = this.visibleAgentEntries.filter(
      (entry) =>
        (entry.status === 'awaiting-input' || entry.status === 'error') &&
        deskOf(layout, entry.tileId) === regionId
    );
    const next =
      this.attentionEntries.find((entry) => waiting.includes(entry)) ?? waiting[0] ?? null;
    if (next) this.focusTile(next.tileId);
    return true;
  }

  private get gatheringHere(): boolean {
    const desk = this.activeDeskId;
    return Boolean(desk && this.state.regions[desk]?.gather);
  }

  /**
   * Switches between the classic canvas (one board) and Canvas Pro (desks). Entering Pro puts every
   * loose window on its project's desk (made when missing; with that setting on), the rest on a
   * desk called Main, and gives the top-level regions their order, as one undoable change; undoing
   * it also goes back to the classic canvas (in Pro a window is always on a desk, so the move to
   * Main could not be undone on its own). Leaving Pro changes nothing but the presentation.
   */
  setMode(mode: CanvasMode): {
    changed: boolean;
    desks: number;
    /** Loose windows put on Main. */
    gathered: number;
    /** Loose windows put on their project's desk. */
    sorted: number;
  } {
    const layout = this.layoutState;
    if (mode === this.mode) {
      return { changed: false, desks: deskIds(layout).length, gathered: 0, sorted: 0 };
    }
    this.ghost = null;
    this.visitorIds = [];
    if (mode === 'classic') {
      this.updateState((state) => ({ ...state, mode }));
      this.boardFromDesks();
      return { changed: true, desks: deskIds(layout).length, gathered: 0, sorted: 0 };
    }
    this.setPaneCount(1);
    const env = { ...this.layoutEnv(), desks: true };
    const loose = this.looseTileIds();
    const byProject = this.sortOntoProjectDesks(layout, loose, env);
    const sorted = loose.length - looseWindows(byProject, loose).length;
    const gathered = loose.length - sorted;
    const hadMain = mainDeskId(layout);
    const ops = homeLooseOps(byProject, this.visibleTileIds());
    const planned = ops.length > 0 ? planLayout(byProject, ops, env) : null;
    const homed = planned?.ok ? planned.plan.state : byProject;
    // Every region that becomes a desk is laid out as one, whatever arrangement it had: part of
    // the same undoable change, so undoing the switch gives the old arrangement back.
    const settled = settleDesks(homed, env, deskIds(homed));
    // The order the board shows them in, unless they were ordered as desks before.
    const ordered = Object.values(layout.regions).some((region) => region.order !== undefined)
      ? deskIds(layout)
      : peerRegions(layout, null);
    const main = hadMain ? null : mainDeskId(settled);
    const next = stampDeskOrder(settled, main ? [main, ...ordered] : ordered);
    const focusDesk = this.focusedTileId ? deskOf(next, this.focusedTileId) : null;
    const start = focusDesk ?? deskOf(next, this.currentRegion()) ?? deskIds(next)[0] ?? null;
    this.updateState((state) => ({ ...state, mode }));
    const committed = this.commitLayout(
      next,
      'Switched to Canvas Pro',
      'command',
      main ? [main] : []
    );
    this.proEntryId = committed ? (this.undoStack.at(-1)?.id ?? null) : null;
    this.showDesk(start);
    return { changed: true, desks: deskIds(next).length, gathered, sorted };
  }

  /**
   * Entering Canvas Pro: loose windows that belong to a project go to its desk, made when missing,
   * as they would if they were opened on Pro. Returns the layout unchanged when the setting is off.
   */
  private sortOntoProjectDesks(
    layout: LayoutState,
    loose: readonly string[],
    env: LayoutEnv
  ): LayoutState {
    if (!this.layoutSettings.placeNewWindowsOnProjectDesk) return layout;
    const tiles = loose.flatMap((tileId) => {
      const project = this.projectOfTile(tileId);
      return project ? [{ tileId, ...project }] : [];
    });
    if (tiles.length === 0) return layout;
    const homes = this.homesForNewTiles(layout, tiles, { currentRegionId: null, pro: true });
    const ops = homes.flatMap(({ home, tiles: ids }) => opsForNewWindowHome(home, ids));
    const planned = ops.length > 0 ? planLayout(layout, ops, env) : null;
    return planned?.ok ? tagProjectHomes(planned.plan.state, homes) : layout;
  }

  /**
   * Back on the classic canvas the desks are sub-canvases again: each is re-tiled as one (a screen
   * with its header, however many pages it had) and they are set side by side. Not undoable.
   */
  private boardFromDesks(): void {
    const tiled = deskIds(this.layoutState).filter((id) => {
      const region = this.state.regions[id];
      return region && isTiled(region) && !region.collapsed;
    });
    for (let start = 0; start < tiled.length; start += MAX_OPS_PER_BATCH) {
      const ops = tiled
        .slice(start, start + MAX_OPS_PER_BATCH)
        .map((region): LayoutOp => ({ op: 'fitRegion', region }));
      const result = this.planOps(ops);
      if (result.ok && diffLayout(this.layoutState, result.plan.state)) {
        this.writeLayout(result.plan.state);
      }
    }
    this.reframe();
  }

  /** Brings a desk into view at the screen's size (it may have been a region on the board). */
  private showDesk(desk: string | null): void {
    if (!desk) return;
    this.fitWorkspace(desk, { ifResized: true });
    this.switchDesk(desk);
  }

  /** Brings a desk into view (the swap), or goes into a region on one. */
  switchDesk(regionId: string): boolean {
    return this.goToRegion(regionId);
  }

  /** Makes a desk and switches to it. Returns its region id. */
  createDesk(
    input: { name?: string; members?: readonly string[]; gather?: WindowStatus } = {}
  ): string | null {
    const result = this.runLayout(
      [
        {
          op: 'createRegion',
          parent: null,
          members: input.members ?? [],
          ...(input.name ? { name: input.name } : {}),
          ...(input.gather ? { gather: input.gather } : {}),
        },
      ],
      { source: 'command' }
    );
    const created = result.ok ? result.plan.created[0] : undefined;
    if (!created) return null;
    this.switchDesk(created);
    return created;
  }

  /**
   * Removes a desk; its windows go to `into`, else to the desk before it. Nothing is closed.
   * The last desk cannot be removed.
   */
  removeDesk(regionId: string, into?: string): LayoutRunResult {
    const planned = removeDeskOps(this.layoutState, regionId, into);
    if ('error' in planned) return { ok: false, reason: planned.error };
    const wasActive = this.activeDeskId === regionId;
    const result = this.runLayout(planned.ops, { source: 'command' });
    if (result.ok && result.applied && wasActive) this.switchDesk(planned.heir);
    return result;
  }

  reorderDesk(regionId: string, position: DeskPosition): LayoutRunResult {
    return this.runLayout([{ op: 'reorderDesk', region: regionId, position }], {
      source: 'command',
    });
  }

  /** Windows on no desk, among those showing. */
  private looseTileIds(): string[] {
    const layout = this.layoutState;
    return [...this.visibleTileIds()].filter((id) => parentOf(layout, id) === null).sort();
  }

  /**
   * Canvas Pro: windows on no desk join the desk in view (Main when that one only gathers, or when
   * there is none). Not undoable, like the placement of a new window.
   */
  homeStrays(): void {
    if (!this.proMode) return;
    const layout = this.layoutState;
    const here = this.gatheringHere ? null : this.activeDeskId;
    const ops = homeLooseOps(layout, this.visibleTileIds(), here);
    if (ops.length === 0) return;
    const result = this.planOps(ops);
    if (!result.ok) return;
    // Every desk has its place in the order, a Main made here included.
    this.writeLayout(stampDeskOrder(result.plan.state, deskIds(result.plan.state)));
  }

  // ── Canvas Pro: visitors ───────────────────────────────────────────────────

  /** Visitors showing now: still open, and living on a desk other than the one in view. */
  get visitors(): string[] {
    const desk = this.activeDeskId;
    if (!desk || this.visitorIds.length === 0) return [];
    const layout = this.layoutState;
    const visible = this.visibleTileIds();
    return this.visitorIds.filter((id) => visible.has(id) && deskOf(layout, id) !== desk);
  }

  /**
   * Where each visitor is drawn: tiled across a desk with no windows of its own (a gathering
   * desk), else floating as a group above the desk's windows. Never written to the board.
   */
  get visitorRects(): ReadonlyMap<string, TileRect> {
    const ids = this.visitors;
    const desk = this.activeDeskId;
    const region = desk ? this.state.regions[desk] : undefined;
    if (!desk || !region || ids.length === 0) return NO_VISITORS;
    const page = this.deskFrame;
    if (!page) return NO_VISITORS;
    // Visitors show on the page in view, spaced like the desk's own windows.
    const frameAllowance = frameAllowanceFor(this.state.showTaskFrames);
    return visitorLayout(
      deskTilesArea(page, frameAllowance),
      ids,
      (this.regionEntry(desk)?.windowCount ?? 0) > 0,
      deskGap(frameAllowance)
    );
  }

  /** True when visitors float above the desk's own windows (the desk recedes behind them). */
  get visitorsFloating(): boolean {
    const desk = this.activeDeskId;
    return (
      this.visitors.length > 0 && desk !== null && (this.regionEntry(desk)?.windowCount ?? 0) > 0
    );
  }

  /** The desk a visitor came from. */
  visitorHome(tileId: string): string | null {
    return deskOf(this.layoutState, tileId);
  }

  /**
   * Brings windows from other desks to the desk in view without moving them: they visit, and go
   * home when the desk changes or they are sent back. Returns the ones that came.
   */
  bringHere(tileIds: readonly string[]): string[] {
    const desk = this.activeDeskId;
    if (!desk) return [];
    const layout = this.layoutState;
    const visible = this.visibleTileIds();
    const brought = tileIds.filter(
      (id) => !isRegionId(id) && visible.has(id) && deskOf(layout, id) !== desk
    );
    const next = [...new Set([...this.visitorIds, ...brought])];
    if (next.length !== this.visitorIds.length) this.visitorIds = next;
    const [first] = brought;
    if (first) this.focusTile(first);
    return brought;
  }

  /** Sends visitors home (all of them when none are named). Returns the ones that left. */
  sendBack(tileIds?: readonly string[]): string[] {
    const showing = this.visitors;
    const leaving = tileIds ? showing.filter((id) => tileIds.includes(id)) : showing;
    this.visitorIds = tileIds ? this.visitorIds.filter((id) => !tileIds.includes(id)) : [];
    if (this.focusedTileId && leaving.includes(this.focusedTileId)) this.focusedTileId = null;
    return leaving;
  }

  /** Makes visitors (all of them when none are named) live on the desk in view. Undoable. */
  keepVisitors(tileIds?: readonly string[]): LayoutRunResult | null {
    const desk = this.activeDeskId;
    const showing = this.visitors;
    const staying = tileIds ? showing.filter((id) => tileIds.includes(id)) : showing;
    if (!desk || staying.length === 0) return null;
    const result = this.runLayout(
      [{ op: 'move', targets: staying, to: { kind: 'region', region: desk } }],
      { source: 'command' }
    );
    if (result.ok) this.visitorIds = this.visitorIds.filter((id) => !staying.includes(id));
    return result;
  }

  /** What the gathering desk in view collects right now ('' when it is not a gathering desk). */
  private gatherKey(): string {
    const desk = this.activeDeskId;
    const status = desk ? this.state.regions[desk]?.gather : undefined;
    if (!desk || !status) return '';
    const matches = gatherMatches(
      this.layoutState,
      this.layoutWindows,
      desk,
      status,
      this.visibleTileIds()
    );
    return `${desk}#${matches.join('|')}`;
  }

  /**
   * A gathering desk in view takes in every window with its status. Those already there stay
   * until the desk changes, so an agent does not vanish the moment it is answered.
   */
  gatherVisitors(): void {
    const desk = this.activeDeskId;
    const status = desk ? this.state.regions[desk]?.gather : undefined;
    if (!desk || !status) return;
    const matches = gatherMatches(
      this.layoutState,
      this.layoutWindows,
      desk,
      status,
      this.visibleTileIds()
    );
    const next = [...new Set([...this.visitorIds, ...matches])];
    if (next.length !== this.visitorIds.length) this.visitorIds = next;
  }

  /** Canvas Pro: brings the desk a window is on into view, unless the window already shows. */
  private revealOnDesk(tileId: string): void {
    const layout = this.layoutState;
    const visiting = this.visitors.includes(tileId);
    const desk = visiting ? this.activeDeskId : deskOf(layout, tileId);
    if (!desk) return;
    if (desk !== this.activeDeskId) {
      this.switchDesk(desk);
      return;
    }
    // On this desk, but outside the region the camera frames: back out to the whole desk.
    const scope = this.location.kind === 'board' ? this.location.regionScope : null;
    if (scope && scope !== desk && (visiting || !isWithin(layout, tileId, scope))) {
      this.switchDesk(desk);
    }
  }

  // ── Agents ─────────────────────────────────────────────────────────────────

  hideConversation(conversationId: string): void {
    this.hideConversations([conversationId]);
  }

  /**
   * Hides agents from the board (they keep running) as an undoable change; a hidden focused tile
   * loses focus.
   */
  hideConversations(conversationIds: readonly string[]): void {
    const hidden = new Set(this.state.hiddenConversationIds);
    const added = conversationIds.filter((id) => !hidden.has(id));
    if (added.length === 0) return;
    const tiles = added.map(agentTileId);
    const result = this.runLayout([{ op: 'hide', targets: tiles }], { source: 'command' });
    if (!result.ok) {
      // Agents the board does not know yet: hide them directly.
      const layout = this.layoutState;
      this.commitLayout(
        { ...layout, hidden: [...layout.hidden, ...tiles] },
        'Closed agents',
        'command',
        tiles
      );
    }
    const focused = this.focusedTileId ? this.entryForTile(this.focusedTileId) : undefined;
    if (focused && added.includes(focused.conversationId)) this.focusedTileId = null;
  }

  showConversation(conversationId: string): void {
    this.showConversations([conversationId]);
  }

  /** Puts hidden agents back, settling them where they fit, as one undoable change. */
  showConversations(conversationIds: readonly string[]): void {
    const hidden = new Set(this.state.hiddenConversationIds);
    const ids = conversationIds.filter((id) => hidden.has(id));
    if (ids.length === 0) return;
    const known = new Set(this.agentEntries.map((entry) => entry.conversationId));
    const present = ids.filter((id) => known.has(id)).map(agentTileId);
    const gone = new Set(ids.filter((id) => !known.has(id)).map(agentTileId));
    const planned = present.length > 0 ? this.planOps([{ op: 'show', targets: present }]) : null;
    const base = planned?.ok ? planned.plan.state : this.layoutState;
    const reopened = new Set(present);
    const next = {
      ...base,
      hidden: base.hidden.filter((id) => !gone.has(id) && !reopened.has(id)),
    };
    const label = planned?.ok ? planned.plan.summary : 'Reopened agents';
    this.commitLayout(next, label, 'command', present);
  }

  showAllConversations(): void {
    this.showConversations(this.state.hiddenConversationIds);
  }

  /** True when an agent is off the board: hidden by the user or outside the project filter. */
  isOffBoard(entry: AgentTileEntry): boolean {
    const filter = this.state.projectFilter;
    return (
      this.state.hiddenConversationIds.includes(entry.conversationId) ||
      (filter !== null && entry.projectId !== filter)
    );
  }

  /**
   * Puts an agent back on the board: unhides it and clears a project filter that excludes it.
   * Returns false when it was already visible.
   */
  revealConversation(entry: AgentTileEntry): boolean {
    if (!this.isOffBoard(entry)) return false;
    this.showConversation(entry.conversationId);
    const filter = this.state.projectFilter;
    if (filter !== null && entry.projectId !== filter) this.setProjectFilter(null);
    return true;
  }

  /**
   * Starts (or resumes) an agent that is not running: provisions its task workspace when needed,
   * then lets its tile attach, which hydrates the conversation like opening its tab would.
   */
  resumeAgent(entry: AgentTileEntry): void {
    this.startRequested.add(entry.conversationId);
    this.requestFocus(entry.tileId);
    if (!entry.taskProvisioned) {
      void getTaskManagerStore(entry.projectId)
        ?.provisionTask(entry.taskId)
        .catch((error: unknown) => log.warn('canvas: task provisioning failed', { error }));
    }
  }

  shouldAttach(entry: AgentTileEntry): boolean {
    return entry.sessionActive || this.startRequested.has(entry.conversationId);
  }

  /**
   * Reserves a spoken name for an agent that is about to be created, so agents spawned together get
   * distinct names before their tiles exist. Use the result as the conversation title.
   */
  claimSpokenName(conversationId: string): string {
    const existing = this.state.spokenNames[conversationId];
    if (existing) return existing;
    const departed = this.departedConversationIds();
    this.forgetDeparted([...departed]);
    const kept = Object.entries(this.state.spokenNames).filter(([id]) => !departed.has(id));
    const name = assignSpokenName(
      undefined,
      kept.map(([, taken]) => taken)
    );
    this.claimedNames.add(conversationId);
    this.updateState((current) => ({
      ...current,
      spokenNames: { ...Object.fromEntries(kept), [conversationId]: name },
    }));
    return name;
  }

  /** Frees a name claimed for an agent that was never created. */
  releaseSpokenName(conversationId: string): void {
    this.claimedNames.delete(conversationId);
    if (!this.state.spokenNames[conversationId]) return;
    this.updateState((current) => {
      const spokenNames = { ...current.spokenNames };
      delete spokenNames[conversationId];
      return { ...current, spokenNames };
    });
  }

  /**
   * Renames an agent. Returns false, changing nothing, when the name is empty or another agent
   * already goes by it: two agents under one name could not be addressed by voice.
   */
  setSpokenName(conversationId: string, name: string): boolean {
    const trimmed = name.trim().replace(/\s+/g, ' ');
    const key = spokenNameKey(trimmed);
    if (!key) return false;
    // A stored name is somebody's until its agent is known to be gone, loaded yet or not.
    const taken = this.keptSpokenNames().some(
      ([id, other]) => id !== conversationId && spokenNameKey(other) === key
    );
    if (taken) return false;
    const previous = this.state.spokenNames[conversationId];
    this.updateState((current) => ({
      ...current,
      spokenNames: { ...current.spokenNames, [conversationId]: trimmed },
    }));
    if (previous && spokenNameKey(previous) !== key) {
      this.rememberFormerName(conversationId, previous);
    }
    const entry = this.agentEntries.find((agent) => agent.conversationId === conversationId);
    if (entry) {
      this.titlesOwed.set(conversationId, { previous, attempts: 0 });
      this.syncTitle(entry, trimmed);
    }
    return true;
  }

  /**
   * The renames that would drop the number from every name whose word no other agent uses
   * ("Atlas 3" to "Atlas"): for names numbered back when an archived agent's name was never
   * handed out again. A word an agent that has not loaded may hold is left alone.
   */
  simplifiableNames(): { conversationId: string; from: string; to: string }[] {
    const words = AGENT_WINDOW_NAMES.length;
    const wordOf = (name: string) => {
      const slot = parseAgentWindowNameSlot(name);
      return slot === null ? null : slot % words;
    };
    const kept = this.keptSpokenNames();
    const planned: { conversationId: string; from: string; to: string }[] = [];
    for (const entry of this.agentEntries) {
      const conversationId = entry.conversationId;
      const from = this.state.spokenNames[conversationId];
      const slot = from ? parseAgentWindowNameSlot(from) : null;
      if (!from || slot === null || slot < words) continue;
      const shared = kept.some(
        ([id, other]) => id !== conversationId && wordOf(other) === slot % words
      );
      if (!shared) planned.push({ conversationId, from, to: agentWindowName(slot % words) });
    }
    return planned;
  }

  /**
   * Makes the renames of `simplifiableNames`, or just `planned` when the developer was shown
   * those, and returns the ones that took. Never automatic.
   */
  simplifySpokenNames(
    planned: readonly {
      conversationId: string;
      from: string;
      to: string;
    }[] = this.simplifiableNames()
  ): { from: string; to: string }[] {
    return planned
      .filter(
        ({ conversationId, from, to }) =>
          this.state.spokenNames[conversationId] === from && this.setSpokenName(conversationId, to)
      )
      .map(({ from, to }) => ({ from, to }));
  }

  /** Names this agent was renamed from this session, newest first: it still answers to them. */
  formerNamesOf(conversationId: string): readonly string[] {
    return this.formerNames.get(conversationId) ?? [];
  }

  /** Names of agents that left the roster in the last few minutes (archived, deleted). */
  get departedNames(): readonly string[] {
    const since = Date.now() - DEPARTED_NAME_TTL_MS;
    return this.leftNames.filter((left) => left.at >= since).map((left) => left.name);
  }

  private rememberFormerName(conversationId: string, name: string): void {
    const key = spokenNameKey(name);
    if (!key) return;
    const others = this.formerNamesOf(conversationId).filter(
      (former) => spokenNameKey(former) !== key
    );
    this.formerNames.set(conversationId, [name, ...others].slice(0, FORMER_NAMES_KEPT));
  }

  /** Drops the session's notes on agents whose names have been freed. */
  private forgetDeparted(conversationIds: readonly string[]): void {
    for (const id of conversationIds) {
      this.seenAgents.delete(id);
      this.goneSince.delete(id);
      this.formerNames.delete(id);
      this.titlesChecked.delete(id);
      this.titlesOwed.delete(id);
    }
  }

  /**
   * Brings conversation titles in step with spoken names. An agent just named or renamed gets
   * its name as title. A title from before is looked at once a session and only changed when it
   * misleads, so two computers that know one conversation by different names do not take turns
   * retitling it.
   */
  private syncTitles(named: readonly AgentTileEntry[]): void {
    for (const entry of named) {
      this.titlesOwed.set(entry.conversationId, { attempts: 0 });
    }
    const entries = this.agentEntries;
    // Whether a title misleads depends on who else is here: judged once everyone is.
    const complete = this.rosterComplete();
    for (const entry of entries) {
      const id = entry.conversationId;
      const name = this.state.spokenNames[id];
      if (!name) continue;
      if (complete && !this.titlesChecked.has(id)) {
        this.titlesChecked.add(id);
        if (!this.titlesOwed.has(id) && this.titleMisleads(entry, entries)) {
          this.titlesOwed.set(id, { attempts: 0 });
        }
      }
      if (this.titlesOwed.has(id)) this.syncTitle(entry, name);
    }
  }

  /**
   * True when an agent's default title would send the developer to a different agent: it is
   * another agent's name ("Atlas" here, an agent called Atlas there), the word of another
   * agent's numbered name ("Atlas" beside Atlas 3), or a title several agents share.
   */
  private titleMisleads(entry: AgentTileEntry, entries: readonly AgentTileEntry[]): boolean {
    const title = entry.conversationTitle.trim();
    const key = spokenNameKey(title);
    if (!key) return true;
    const words = AGENT_WINDOW_NAMES.length;
    const slot = parseAgentWindowNameSlot(title);
    return entries.some((other) => {
      if (other.conversationId === entry.conversationId) return false;
      const name = this.state.spokenNames[other.conversationId] ?? '';
      if (spokenNameKey(name) === key) return true;
      const otherSlot = parseAgentWindowNameSlot(name);
      if (slot !== null && slot < words && otherSlot !== null && otherSlot % words === slot) {
        return true;
      }
      return spokenNameKey(other.conversationTitle) === key;
    });
  }

  /**
   * Gives an agent's conversation its spoken name as its title, so the task view, other devices,
   * and a later session all show the name the developer says. Only a default title or the
   * agent's previous name is replaced; a title someone wrote stays, as a second name. The title
   * it replaces keeps working as a name for the rest of the session. A host that is offline
   * refuses: the title stays owed and is tried again when the roster next changes.
   */
  private syncTitle(entry: AgentTileEntry, name: string): void {
    const id = entry.conversationId;
    const owed = this.titlesOwed.get(id);
    // While the host is being asked the title already shows the name: wait for its answer.
    if (!owed || owed.inFlight) return;
    const title = entry.conversationTitle.trim();
    const titleKey = spokenNameKey(title);
    // Retitled by hand since the first try: that title is the developer's now.
    if (owed.replacing !== undefined && owed.replacing !== titleKey) {
      this.titlesOwed.delete(id);
      return;
    }
    const isDefault =
      !title ||
      parseAgentWindowNameSlot(title) !== null ||
      (title.toLowerCase().startsWith(`${entry.providerId.toLowerCase()} (`) &&
        /^\(\d+\)$/.test(title.slice(entry.providerId.length + 1)));
    const wasName = owed.previous !== undefined && titleKey === spokenNameKey(owed.previous);
    const manager = conversationRegistry.get(entry.taskId);
    if (titleKey === spokenNameKey(name) || (!isDefault && !wasName) || !manager) {
      this.titlesOwed.delete(id);
      return;
    }
    if (owed.attempts >= TITLE_SYNC_ATTEMPTS) return;
    if (owed.attempts === 0) {
      owed.replacing = titleKey;
      if (title) this.rememberFormerName(id, title);
    }
    owed.attempts += 1;
    owed.inFlight = true;
    void manager.renameConversation(id, name).then(
      () => {
        if (this.titlesOwed.get(id) === owed) this.titlesOwed.delete(id);
      },
      (error: unknown) => {
        owed.inFlight = false;
        log.warn('canvas: could not give a conversation its spoken name as title', { error });
      }
    );
  }

  /**
   * Stored names that are still somebody's: `[conversationId, name]`. A rename is the
   * developer's own act, so it need not wait out the minute that guards against a removal being
   * undone: the name of an agent that is provably gone is free to it at once.
   */
  private keptSpokenNames(): [string, string][] {
    const departed = this.departedConversationIds(Date.now(), 0);
    return Object.entries(this.state.spokenNames).filter(([id]) => !departed.has(id));
  }

  /**
   * Conversations whose stored names are free again because their agents are known to be gone:
   * archived, deleted, or in a project that was removed. Then names stay short ("Bravo") instead
   * of counting up for ever ("Bravo 3"). An agent that is only not loaded yet (the app is
   * starting, a project is reconnecting) gives no such proof and keeps its name, so a name is
   * never handed to a second agent behind the back of the first.
   */
  private departedConversationIds(now = Date.now(), grace = DEPARTURE_GRACE_MS): Set<string> {
    const live = new Set(this.agentEntries.map((entry) => entry.conversationId));
    const gone = new Set<string>();
    // An agent that was here this session is gone once that can be shown and has lasted: a
    // removal its host refuses is rolled back, and must not cost the agent its name.
    for (const [id, where] of this.seenAgents) {
      if (live.has(id)) {
        this.goneSince.delete(id);
        continue;
      }
      // Not provable right now (its project is reloading): neither freed nor timed afresh.
      if (!this.hasLeft(id, where)) continue;
      const since = this.goneSince.get(id) ?? now;
      if (!this.goneSince.has(id)) {
        this.goneSince.set(id, now);
        const name = this.state.spokenNames[id];
        if (name) {
          const key = spokenNameKey(name);
          const others = this.leftNames.filter((left) => spokenNameKey(left.name) !== key);
          this.leftNames.splice(0, this.leftNames.length, { name, at: now }, ...others);
          this.leftNames.length = Math.min(this.leftNames.length, DEPARTED_NAMES_KEPT);
        }
      }
      if (now - since >= grace) gone.add(id);
    }
    // An agent from an earlier session, not seen in this one. Archived tasks stay loaded with
    // their conversations, which is proof on its own.
    for (const project of this.projectManager.projects.values()) {
      const context = asAvailableProject(project);
      if (!context) continue;
      for (const task of context.get(taskManagerStoreToken).tasks.values()) {
        if (task.state === 'unregistered' || isCanvasTask(task)) continue;
        const manager = conversationRegistry.get(task.data.id);
        for (const id of manager?.conversations.keys() ?? []) {
          if (!this.seenAgents.has(id)) gone.add(id);
        }
      }
    }
    // With everything loaded, a name kept for an agent that is nowhere is kept for nobody.
    if (this.rosterComplete()) {
      for (const id of Object.keys(this.state.spokenNames)) {
        if (!this.claimedNames.has(id) && !this.seenAgents.has(id)) gone.add(id);
      }
    }
    for (const id of live) gone.delete(id);
    return gone;
  }

  /**
   * True when every project, task list, and conversation list has loaded, so the roster holds
   * every agent there is. False whenever that cannot be shown: while the app starts, while a
   * project is hydrating or failed to, or while a list is still on its way.
   */
  private rosterComplete(): boolean {
    const projects = [...this.projectManager.projects.values()];
    if (projects.length === 0) return false;
    for (const project of projects) {
      const context = asAvailableProject(project);
      if (!context) return false;
      const taskManager = context.get(taskManagerStoreToken);
      if (!taskManager.listLoaded) return false;
      for (const task of taskManager.tasks.values()) {
        if (!isCanvasTask(task)) continue;
        const conversations = conversationRegistry.get(task.data.id);
        if (!conversations || conversations.list.data === null) return false;
      }
    }
    return true;
  }

  /** True when an agent seen on the roster earlier is provably gone, not just unloaded. */
  private hasLeft(conversationId: string, where: { projectId: string; taskId: string }): boolean {
    const projects = this.projectManager.projects;
    const project = projects.get(where.projectId);
    // The project was here this session and is not any more: removed from the app.
    if (!project) return true;
    const context = asAvailableProject(project);
    if (!context) return false;
    const taskManager = context.get(taskManagerStoreToken);
    const task = taskManager.tasks.get(where.taskId);
    // A missing task was deleted, as long as the list it is missing from has loaded.
    if (!task) return taskManager.listLoaded;
    if (task.state === 'unregistered') return false;
    if (!isCanvasTask(task)) return true;
    const manager = conversationRegistry.get(where.taskId);
    return !!manager && manager.list.data !== null && !manager.conversations.has(conversationId);
  }
}

/** Footprints of top-level regions (occupied space for automatic placement). */
function rootRegionRects(regions: CanvasBoardState['regions']): TileRect[] {
  return Object.values(regions)
    .filter((region) => !region.parentId || !regions[region.parentId])
    .map(regionFootprint);
}

function windowStatus(entry: AgentTileEntry): WindowStatus {
  switch (entry.status) {
    case 'awaiting-input':
      return 'needs-you';
    case 'working':
      return 'working';
    case 'error':
      return 'error';
    case 'completed':
      return 'done';
    default:
      return 'idle';
  }
}

/** A note's name: its first few words. */
function noteName(text: string): string {
  const words = text.trim().split(/\s+/).filter(Boolean).slice(0, 4).join(' ');
  return words ? `note "${words}"` : 'empty note';
}

function sameLocation(a: CanvasLocation, b: CanvasLocation): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function sameStageTarget(a: CanvasLocation, b: CanvasLocation): boolean {
  return (
    a.kind === 'stage' &&
    b.kind === 'stage' &&
    JSON.stringify(a.target) === JSON.stringify(b.target)
  );
}

/** `location` if its region still exists in `layout`, otherwise the board root. */
function locationWithin(location: CanvasLocation, layout: LayoutState): CanvasLocation {
  if (location.kind === 'board') {
    return location.regionScope && !layout.regions[location.regionScope] ? BOARD_ROOT : location;
  }
  if (location.target.kind === 'region' && !layout.regions[location.target.regionId]) {
    return BOARD_ROOT;
  }
  return location;
}

/** Canvas Pro: a board location is always on a desk: the preferred one, else the first. */
function locationOnDesk(
  location: CanvasLocation,
  layout: LayoutState,
  preferred: readonly (string | null)[]
): CanvasLocation {
  if (location.kind !== 'board' || location.regionScope) return location;
  const desk =
    preferred.map((id) => deskOf(layout, id)).find((id) => id !== null) ?? deskIds(layout)[0];
  return desk ? { kind: 'board', regionScope: desk } : location;
}

function overlapArea(a: TileRect, b: TileRect): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

function isCanvasTask(task: TaskStore): boolean {
  if (task.state === 'unregistered') return false;
  if (task.data.type === 'automation-run') return false;
  return !('archivedAt' in task.data && task.data.archivedAt);
}

function toAgentEntry(
  projectName: string,
  task: TaskStore,
  conversation: ConversationStore,
  runtime: { sessionActive: boolean }
): AgentTileEntry {
  const data = conversation.data;
  const workspaceGit = 'workspaceGit' in task.data ? task.data.workspaceGit : undefined;
  return {
    tileId: agentTileId(data.id),
    conversationId: data.id,
    taskId: data.taskId,
    projectId: data.projectId,
    projectName,
    taskName: task.displayName,
    providerId: data.providerId,
    conversationTitle: data.title,
    type: data.type === 'acp' ? 'acp' : 'pty',
    status: conversation.status,
    seen: conversation.seen,
    notificationType: conversation.lastNotificationType,
    completionSummary: conversation.completionSummary,
    completionReport: conversation.completionReport,
    ...(conversation.backgroundAgents ? { backgroundAgents: conversation.backgroundAgents } : {}),
    taskProvisioned: isProvisioned(task),
    sessionActive: runtime.sessionActive,
    workspaceId: task.workspaceId,
    linesAdded: workspaceGit?.linesAdded ?? 0,
    linesDeleted: workspaceGit?.linesDeleted ?? 0,
    createdAt: 'createdAt' in task.data ? task.data.createdAt : null,
    lastInteractedAt:
      data.lastInteractedAt ??
      ('lastInteractedAt' in task.data ? (task.data.lastInteractedAt ?? null) : null),
  };
}

function regionOfLocation(location: CanvasLocation): string | null {
  if (location.kind === 'board') return location.regionScope;
  return location.target.kind === 'region' ? location.target.regionId : null;
}
