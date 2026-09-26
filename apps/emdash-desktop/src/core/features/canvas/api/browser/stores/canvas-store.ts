import { action, computed, makeObservable, observable, reaction, runInAction } from 'mobx';
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
  type CanvasLayoutSettings,
  type CanvasLocationState,
  type CanvasStageTarget,
} from '../../../contributions/mementos';
import {
  diffLayout,
  pushHistory,
  redoEntry,
  undoEntry,
  type LayoutHistoryEntry,
  type LayoutSource,
} from '../../canvas-history';
import {
  planLayout,
  readingOrder,
  regionAt,
  type LayoutEnv,
  type LayoutOp,
  type LayoutPlan,
  type PlanResult,
} from '../../canvas-layout';
import {
  AGENT_TILE_SIZE,
  BROWSER_TILE_SIZE,
  assignSpokenName,
  frameRect,
  isLegacySpokenName,
  NOTE_TILE_SIZE,
  nextFreeAnchor,
  placeTiles,
  rectsOverlap,
  viewportRect,
  type CanvasViewport,
  type TileRect,
} from '../../canvas-model';
import {
  descendantTiles,
  frameAllowanceFor,
  isFoldedAway,
  isRegionId,
  newRegionId,
  nodeRect,
  parentOf,
  regionByName,
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
import { spokenProviderLabel } from '../../provider-names';
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
  /** True when the task workspace is provisioned (its sessions can attach). */
  readonly taskProvisioned: boolean;
  /** True when the host reports a running session for this conversation. */
  readonly sessionActive: boolean;
  readonly workspaceId: string | null;
  readonly linesAdded: number;
  readonly linesDeleted: number;
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
  /** "2 need you, 1 working". */
  readonly summary: string;
  readonly auto: boolean;
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

type StageHistoryEntry = {
  readonly key: string;
  readonly before: StageSaved;
  readonly after: StageSaved;
  readonly label: string;
  readonly at: number;
};

const TRANSIENT_STAGE_KEY = '';
const MAX_TRAIL = 50;
const BOARD_ROOT: CanvasLocation = { kind: 'board', regionScope: null };

export type ViewportCommand =
  | { readonly id: number; readonly kind: 'focus'; readonly tileId: string }
  | { readonly id: number; readonly kind: 'fit'; readonly tileIds?: readonly string[] };

export function agentTileId(conversationId: string): string {
  return `agent:${conversationId}`;
}

export function noteTileId(noteId: string): string {
  return `note:${noteId}`;
}

export function browserTileId(taskId: string): string {
  return `browser:${taskId}`;
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
  backTrail: CanvasLocation[] = [];
  forwardTrail: CanvasLocation[] = [];
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
      setDropHint: action,
      setRenamingRegion: action,
      groupSelection: action,
      backTrail: observable.ref,
      forwardTrail: observable.ref,
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
      )
    );
  }

  dispose(): void {
    this.disposed = true;
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

  /**
   * One frame per task and region with visible agents or an app browser (empty when frames are
   * off). A task split across regions gets a frame in each; windows in collapsed regions have none.
   */
  get taskFrames(): TaskFrameEntry[] {
    if (!this.state.showTaskFrames) return [];
    const layout = this.layoutState;
    const groups = new Map<string, { taskId: string; region: string | null }>();
    const keyOf = (taskId: string, tileId: string) => {
      const region = parentOf(layout, tileId);
      const key = region ? `${taskFrameId(taskId)}@${region}` : taskFrameId(taskId);
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
    const stored = this.state.tiles[tileId];
    if (stored) return stored;
    const size = tileId.startsWith('note:')
      ? NOTE_TILE_SIZE
      : tileId.startsWith('browser:')
        ? BROWSER_TILE_SIZE
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

  // ── Layout ─────────────────────────────────────────────────────────────────

  /** Gives every agent a tile rect and a spoken name the first time it is seen. */
  ensureLayout(): void {
    const state = this.state;
    const missing = this.agentEntries.filter((entry) => !state.tiles[entry.tileId]);
    const unnamed = this.agentEntries.filter((entry) => {
      const name = state.spokenNames[entry.conversationId];
      return !name || isLegacySpokenName(name, spokenProviderLabel(entry.providerId));
    });
    if (missing.length === 0 && unnamed.length === 0) return;

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
      for (const entry of unnamed) delete spokenNames[entry.conversationId];
      for (const entry of unnamed) {
        spokenNames[entry.conversationId] = assignSpokenName(
          entry.conversationTitle,
          Object.values(spokenNames)
        );
      }
      return { ...current, tiles, spokenNames };
    });
    if (missing.length > 0) this.joinRegions(missing.map((entry) => entry.conversationId));
  }

  /**
   * New agents join a region: the one reserved for them (a plan's agents), else the region the user
   * is looking at when that setting is on. Not undoable (it is where they were born).
   */
  private joinRegions(conversationIds: readonly string[]): void {
    const byName = new Map<string, string[]>();
    const current: string[] = [];
    const scope = this.currentRegion();
    for (const id of conversationIds) {
      const reserved = this.pendingRegions.get(id);
      this.pendingRegions.delete(id);
      if (reserved) byName.set(reserved, [...(byName.get(reserved) ?? []), agentTileId(id)]);
      else if (scope && this.layoutSettings.placeNewAgentsInCurrentRegion) {
        current.push(agentTileId(id));
      }
    }
    const ops: LayoutOp[] = [];
    for (const [name, tiles] of byName) {
      const existing = regionByName(this.layoutState, name);
      ops.push(
        existing
          ? { op: 'move', targets: tiles, to: { kind: 'region', region: existing } }
          : { op: 'createRegion', name, members: tiles }
      );
    }
    if (scope && current.length > 0) {
      ops.push({ op: 'move', targets: current, to: { kind: 'region', region: scope } });
    }
    if (ops.length === 0) return;
    const result = this.planOps(ops);
    if (!result.ok) return;
    this.writeLayout(result.plan.state);
    this.markChanged(result.plan.summary, result.plan.targets, 'command', []);
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
    this.focusTile(tileId);
    this.viewportCommand = { id: ++this.commandSeq, kind: 'focus', tileId };
  }

  requestFit(tileIds?: readonly string[]): void {
    this.viewportCommand = { id: ++this.commandSeq, kind: 'fit', tileIds };
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
   * Adds a task's app browser (or updates its URL) and places it beside the task's agents.
   * Returns the tile id.
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
        summary: statusSummary(tileStatuses),
        auto: region.auto === true,
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
    return this.state.layoutSettings ?? DEFAULT_LAYOUT_SETTINGS;
  }

  setLayoutSettings(patch: Partial<CanvasLayoutSettings>): void {
    this.updateState((current) => ({
      ...current,
      layoutSettings: { ...current.layoutSettings, ...patch },
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
    this.updateState((current) => {
      const stageLayouts = Object.fromEntries(
        Object.entries(current.stageLayouts).filter(([regionId]) => next.regions[regionId])
      );
      return {
        ...current,
        tiles: { ...next.tiles },
        regions: { ...next.regions },
        membership: { ...next.membership },
        hiddenConversationIds: agents,
        hiddenTiles: others,
        stageLayouts,
        location: locationWithin(current.location, next),
      };
    });
    const hidden = new Set(next.hidden);
    if (this.focusedTileId && hidden.has(this.focusedTileId)) this.focusedTileId = null;
    const stale = (id: string) => hidden.has(id) || (isRegionId(id) && !next.regions[id]);
    if (this.selection.some(stale)) this.selection = this.selection.filter((id) => !stale(id));
  }

  private markChanged(
    label: string,
    targets: readonly string[],
    source: LayoutSource,
    displaced: readonly string[]
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
    const members = ids.filter((id) => !id.startsWith('frame:'));
    if (members.length === 0) return null;
    const result = this.runLayout([{ op: 'createRegion', members, ...(name ? { name } : {}) }], {
      source: 'keyboard',
    });
    if (!result.ok) return null;
    const regionId = result.plan.created[0] ?? null;
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
    const ops: LayoutOp[] = [];
    for (const drop of drops.slice(0, 12)) {
      const rect = nodeRect(layout, drop.id);
      if (Math.round(rect.x) === Math.round(drop.x) && Math.round(rect.y) === Math.round(drop.y)) {
        continue;
      }
      const probe = { x: drop.x + rect.w / 2, y: drop.y + Math.min(rect.h / 2, 60) };
      const region = regionAt(layout, probe, isRegionId(drop.id) ? drop.id : undefined);
      ops.push({
        op: 'move',
        targets: [drop.id],
        to: { kind: 'exact', x: drop.x, y: drop.y, region },
      });
    }
    if (ops.length > 0) this.runLayout(ops, { source: 'pointer' });
  }

  resizeTile(tileId: string, rect: TileRect): void {
    this.runLayout([{ op: 'resize', targets: [tileId], size: { kind: 'exact', rect } }], {
      source: 'pointer',
    });
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
  navigate(location: CanvasLocation, options: { record?: boolean } = {}): void {
    const current = this.location;
    if (sameLocation(current, location)) {
      this.revealLocation(location);
      return;
    }
    if (options.record !== false) {
      this.backTrail = [...this.backTrail, current].slice(-MAX_TRAIL);
      this.forwardTrail = [];
    }
    if (current.kind === 'stage' && !sameStageTarget(current, location)) {
      this.transientStage = EMPTY_STAGE;
    }
    this.updateState((state) => ({ ...state, location }));
    this.revealLocation(location);
  }

  private revealLocation(location: CanvasLocation): void {
    if (location.kind !== 'board') return;
    if (location.regionScope && this.state.regions[location.regionScope]) {
      this.requestFit([location.regionScope]);
    }
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
    this.navigate({ kind: 'board', regionScope: parent });
    if (!parent) this.requestFit();
    return true;
  }

  home(): void {
    this.navigate(BOARD_ROOT);
    this.requestFit();
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
    const name = assignSpokenName(undefined, Object.values(this.state.spokenNames));
    this.updateState((current) => ({
      ...current,
      spokenNames: { ...current.spokenNames, [conversationId]: name },
    }));
    return name;
  }

  /** Frees a name claimed for an agent that was never created. */
  releaseSpokenName(conversationId: string): void {
    if (!this.state.spokenNames[conversationId]) return;
    this.updateState((current) => {
      const spokenNames = { ...current.spokenNames };
      delete spokenNames[conversationId];
      return { ...current, spokenNames };
    });
  }

  setSpokenName(conversationId: string, name: string): void {
    const trimmed = name.trim();
    if (!trimmed) return;
    this.updateState((current) => ({
      ...current,
      spokenNames: { ...current.spokenNames, [conversationId]: trimmed },
    }));
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
    taskProvisioned: isProvisioned(task),
    sessionActive: runtime.sessionActive,
    workspaceId: task.workspaceId,
    linesAdded: workspaceGit?.linesAdded ?? 0,
    linesDeleted: workspaceGit?.linesDeleted ?? 0,
  };
}
