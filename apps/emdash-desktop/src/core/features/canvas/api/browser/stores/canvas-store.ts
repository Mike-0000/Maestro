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
import { canvasBoardMemento, type CanvasBoardState } from '../../../contributions/mementos';
import {
  AGENT_TILE_SIZE,
  assignSpokenName,
  frameRect,
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
      taskFrames: computed,
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
      showConversation: action,
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

  /** One frame per task with visible agents (empty when frames are turned off). */
  get taskFrames(): TaskFrameEntry[] {
    if (!this.state.showTaskFrames) return [];
    const byTask = new Map<string, AgentTileEntry[]>();
    for (const entry of this.visibleAgentEntries) {
      const group = byTask.get(entry.taskId) ?? [];
      group.push(entry);
      byTask.set(entry.taskId, group);
    }
    const frames: TaskFrameEntry[] = [];
    for (const [taskId, entries] of byTask) {
      const first = entries[0];
      const rect = frameRect(entries.map((entry) => this.tileRect(entry.tileId)));
      if (!first || !rect) continue;
      frames.push({
        frameId: taskFrameId(taskId),
        taskId,
        projectId: first.projectId,
        taskName: first.taskName,
        projectName: first.projectName,
        rect,
        tileIds: entries.map((entry) => entry.tileId),
        linesAdded: first.linesAdded,
        linesDeleted: first.linesDeleted,
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
    const size = tileId.startsWith('note:') ? NOTE_TILE_SIZE : AGENT_TILE_SIZE;
    return { x: 0, y: 0, ...size };
  }

  spokenName(conversationId: string): string {
    return this.state.spokenNames[conversationId] ?? 'Agent';
  }

  entryForTile(tileId: string): AgentTileEntry | undefined {
    return this.agentEntries.find((entry) => entry.tileId === tileId);
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
    const unnamed = this.agentEntries.filter((entry) => !state.spokenNames[entry.conversationId]);
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
      for (const entry of unnamed) {
        spokenNames[entry.conversationId] = assignSpokenName(
          spokenProviderLabel(entry.providerId),
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

  // ── Agents ─────────────────────────────────────────────────────────────────

  hideConversation(conversationId: string): void {
    if (this.state.hiddenConversationIds.includes(conversationId)) return;
    this.updateState((current) => ({
      ...current,
      hiddenConversationIds: [...current.hiddenConversationIds, conversationId],
    }));
  }

  showConversation(conversationId: string): void {
    this.updateState((current) => ({
      ...current,
      hiddenConversationIds: current.hiddenConversationIds.filter((id) => id !== conversationId),
    }));
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
    taskProvisioned: isProvisioned(task),
    sessionActive: runtime.sessionActive,
    workspaceId: task.workspaceId,
    linesAdded: workspaceGit?.linesAdded ?? 0,
    linesDeleted: workspaceGit?.linesDeleted ?? 0,
  };
}
