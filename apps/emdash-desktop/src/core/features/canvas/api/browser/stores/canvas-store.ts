import { action, computed, makeObservable, observable, reaction, runInAction } from 'mobx';
import type { ConversationStore } from '@core/features/conversations/api/browser/conversation-manager';
import { conversationRegistry } from '@core/features/conversations/api/browser/stores/conversation-registry';
import type { ProjectManagerStore } from '@core/features/projects/api/browser/stores/project-manager';
import { asAvailableProject } from '@core/features/projects/api/browser/stores/project-selectors';
import type { TaskStore } from '@core/features/tasks/api/browser/stores/task-store';
import { getTaskManagerStore } from '@core/features/tasks/api/browser/task-state/task-selectors';
import { taskManagerStoreToken } from '@core/features/tasks/contributions/browser/project-store-tokens';
import type { AgentStatus, NotificationType } from '@core/primitives/agents/api';
import { log } from '@core/primitives/logging/browser/logger';
import type { MementoHandle } from '@core/primitives/mementos/browser';
import { isProvisioned } from '@core/primitives/task-state/browser/task-state';
import {
  canvasBoardMemento,
  type CanvasBoardState,
  type CanvasBrowserState,
} from '../../../contributions/mementos';
import {
  AGENT_TILE_SIZE,
  BROWSER_TILE_SIZE,
  assignSpokenName,
  frameRect,
  isLegacySpokenName,
  NOTE_TILE_SIZE,
  nextFreeAnchor,
  placeTiles,
  type CanvasViewport,
  type TileRect,
} from '../../canvas-model';
import { spokenProviderLabel } from '../../provider-names';

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
  private commandSeq = 0;
  private readonly disposers: (() => void)[] = [];
  private disposed = false;

  constructor(private readonly projectManager: ProjectManagerStore) {
    makeObservable<CanvasStore, '_handle' | '_fallbackState' | 'updateState'>(this, {
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
    return this.browserEntries.filter((entry) => !filter || entry.projectId === filter);
  }

  browserForTask(taskId: string): BrowserTileEntry | undefined {
    return this.browserEntries.find((entry) => entry.taskId === taskId);
  }

  /** One frame per task with visible agents or an app browser (empty when frames are off). */
  get taskFrames(): TaskFrameEntry[] {
    if (!this.state.showTaskFrames) return [];
    const byTask = new Map<string, AgentTileEntry[]>();
    for (const entry of this.visibleAgentEntries) {
      const group = byTask.get(entry.taskId) ?? [];
      group.push(entry);
      byTask.set(entry.taskId, group);
    }
    const browsers = new Map(this.visibleBrowserEntries.map((entry) => [entry.taskId, entry]));
    const frames: TaskFrameEntry[] = [];
    for (const taskId of new Set([...byTask.keys(), ...browsers.keys()])) {
      const entries = byTask.get(taskId) ?? [];
      const browser = browsers.get(taskId);
      const first = entries[0];
      const tileIds = [
        ...entries.map((entry) => entry.tileId),
        ...(browser ? [browser.tileId] : []),
      ];
      const rect = frameRect(tileIds.map((tileId) => this.tileRect(tileId)));
      const named = first ?? browser;
      if (!named || !rect) continue;
      frames.push({
        frameId: taskFrameId(taskId),
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

  /** Moves several tiles by the same offset (dragging a task frame moves its agents). */
  moveTiles(tileIds: readonly string[], dx: number, dy: number): void {
    if (dx === 0 && dy === 0) return;
    this.updateState((current) => {
      const tiles = { ...current.tiles };
      for (const tileId of tileIds) {
        const rect = this.tileRect(tileId);
        tiles[tileId] = { ...rect, x: rect.x + dx, y: rect.y + dy };
      }
      return { ...current, tiles };
    });
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
      if (missing.length > 0) {
        // Keep tiles from the same task adjacent: place per task group.
        const byTask = new Map<string, AgentTileEntry[]>();
        for (const entry of missing) {
          const group = byTask.get(entry.taskId) ?? [];
          group.push(entry);
          byTask.set(entry.taskId, group);
        }
        for (const group of byTask.values()) {
          const existing = Object.values(tiles);
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
    const existing = Object.values(this.state.tiles);
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
      delete notes[noteId];
      delete tiles[noteTileId(noteId)];
      return { ...current, notes, tiles };
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
      if (current.tiles[tileId]) return { ...current, browsers };
      const siblings = this.agentEntries
        .filter((entry) => entry.taskId === input.taskId && current.tiles[entry.tileId])
        .map((entry) => current.tiles[entry.tileId] as TileRect);
      const occupied = Object.values(current.tiles);
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
      delete browsers[taskId];
      delete tiles[tileId];
      return { ...current, browsers, tiles };
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

  // ── Agents ─────────────────────────────────────────────────────────────────

  hideConversation(conversationId: string): void {
    this.hideConversations([conversationId]);
  }

  /** Hides agents from the board (they keep running); a hidden focused tile loses focus. */
  hideConversations(conversationIds: readonly string[]): void {
    const hidden = new Set(this.state.hiddenConversationIds);
    const added = conversationIds.filter((id) => !hidden.has(id));
    if (added.length === 0) return;
    this.updateState((current) => ({
      ...current,
      hiddenConversationIds: [...current.hiddenConversationIds, ...added],
    }));
    const focused = this.focusedTileId ? this.entryForTile(this.focusedTileId) : undefined;
    if (focused && added.includes(focused.conversationId)) this.focusedTileId = null;
  }

  showConversation(conversationId: string): void {
    this.updateState((current) => ({
      ...current,
      hiddenConversationIds: current.hiddenConversationIds.filter((id) => id !== conversationId),
    }));
  }

  showAllConversations(): void {
    if (this.state.hiddenConversationIds.length === 0) return;
    this.updateState((current) => ({ ...current, hiddenConversationIds: [] }));
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
    taskProvisioned: isProvisioned(task),
    sessionActive: runtime.sessionActive,
    workspaceId: task.workspaceId,
    linesAdded: workspaceGit?.linesAdded ?? 0,
    linesDeleted: workspaceGit?.linesDeleted ?? 0,
  };
}
