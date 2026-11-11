import { observable, reaction, runInAction } from 'mobx';
import type { CanvasStore } from '@core/features/canvas/api/browser/stores/canvas-store';
import {
  getTaskManagerStore,
  getTaskStore,
} from '@core/features/tasks/api/browser/task-state/task-selectors';
import { log } from '@core/primitives/logging/browser/logger';
import { getConductorClient } from '../../api/browser/client';
import type { ConductorStatus } from '../../api/contract';
import { DEFAULT_CONDUCTOR_SETTINGS } from '../../api/contract';
import { chatName, createTaskAgentPort } from './agent-port';
import { createTaskBrowserPort } from './browser-port';
import { DecisionDesk } from './decision-desk';
import type { FrontConductor, FrontConductorSource } from './front';
import { ChatConductorSession, type ChatConductorPorts, type LegacyThread } from './session';

/**
 * A chat tab that is on screen (a pane's active tab): the chat, its task, whether its pane has
 * focus, and whether it shows the Conductor view or the raw chat.
 */
export type ChatConductorScreen = {
  readonly conversationId: string;
  readonly taskId: string;
  readonly focusedPane: boolean;
  /** The Conductor view is in front; false for the raw chat. */
  readonly conductor: boolean;
};

type PlacedScreen = ChatConductorScreen & { readonly at: number };

/** The conductor in front, as the HUD addresses it. */
export type FrontChatConductor = FrontConductor & { readonly session: ChatConductorSession };

/** What the manager reads of Maestro's conductor: its status, kept current by that store. */
export interface ChatConductorStatusSource {
  readonly status: ConductorStatus | null;
}

/** Of several screens, the one in the focused pane, then the one shown or used last. */
function frontmost(screens: Iterable<PlacedScreen>): PlacedScreen | null {
  let best: PlacedScreen | null = null;
  for (const screen of screens) {
    if (
      !best ||
      (screen.focusedPane !== best.focusedPane ? screen.focusedPane : screen.at > best.at)
    ) {
      best = screen;
    }
  }
  return best;
}

/**
 * The conductors of the app, one session per task: every chat in a task is that conductor's, and
 * the Conductor view of any of its chat tabs shows the same thread.
 *
 * A session costs nothing until the developer first shows a Conductor view of its task: only then
 * does it attach and follow the task's chats. Tasks that had a thread when the app closed are
 * followed again as soon as one of their chats is loaded; no agent is started to do so. Threads
 * from when each chat had its own conductor are adopted by their task's thread as the chats load.
 */
export class ChatConductorManager implements FrontConductorSource {
  private readonly sessions = observable.map<string, ChatConductorSession>([], { deep: false });
  private readonly disposers: (() => void)[] = [];
  /** Tasks with a saved thread that are not followed yet. */
  private readonly waitingTasks = observable.set<string>();
  /** Conversations with an own thread from before, not adopted yet. */
  private readonly legacy = observable.set<string>();
  private disposed = false;
  /** The chat tabs on screen right now, by the place that shows them (a pane). */
  private readonly screens = observable.map<string, PlacedScreen>([], { deep: false });
  private screenClock = 0;

  constructor(
    private readonly canvas: CanvasStore,
    private readonly conductor: ChatConductorStatusSource
  ) {}

  /** Conductors can run a turn: the setting is on and a key is set. */
  get ready(): boolean {
    return this.conductor.status?.chatConductorReady ?? false;
  }

  /** Whether the developer turned conductors off (as opposed to a missing key). */
  get enabled(): boolean {
    return (
      this.conductor.status?.settings?.chatConductors ?? DEFAULT_CONDUCTOR_SETTINGS.chatConductors
    );
  }

  /**
   * The conductor the developer is looking at, whose thread the HUD's typed box and voice
   * commands reach: its task's session, named for the task, with the chat whose tab shows it.
   * Null when no Conductor view is on screen (the canvas, a Raw view, another view) or
   * conductors cannot run.
   */
  get front(): FrontChatConductor | null {
    if (!this.ready) return null;
    const best = frontmost([...this.screens.values()].filter((screen) => screen.conductor));
    const session = best ? this.sessions.get(best.taskId) : undefined;
    if (!best || !session) return null;
    const entry = this.canvas.agentEntries.find(
      (candidate) => candidate.conversationId === best.conversationId
    );
    return {
      session,
      name: entry?.taskName ?? this.canvas.spokenName(best.conversationId),
      chatId: best.conversationId,
    };
  }

  /** The task's chat whose tab is on screen (Conductor view or raw), if any. */
  chatOnScreen(taskId: string): string | null {
    const best = frontmost([...this.screens.values()].filter((screen) => screen.taskId === taskId));
    return best?.conversationId ?? null;
  }

  /**
   * A place that can show a chat tab (a pane) says what it shows now: `null` when no chat tab of
   * it is on screen, or the place is gone.
   */
  showOnScreen(screenId: string, screen: ChatConductorScreen | null): void {
    const current = this.screens.get(screenId);
    runInAction(() => {
      if (!screen) {
        this.screens.delete(screenId);
        return;
      }
      if (
        current?.conversationId === screen.conversationId &&
        current.taskId === screen.taskId &&
        current.focusedPane === screen.focusedPane &&
        current.conductor === screen.conductor
      ) {
        return;
      }
      this.screens.set(screenId, { ...screen, at: ++this.screenClock });
    });
  }

  /** The developer worked in that place's Conductor view: of two on screen, it is in front. */
  touchScreen(screenId: string): void {
    const current = this.screens.get(screenId);
    if (!current || current.at === this.screenClock) return;
    runInAction(() => this.screens.set(screenId, { ...current, at: ++this.screenClock }));
  }

  /** The conductor of a task, created on first use. It does nothing until attached. */
  session(taskId: string): ChatConductorSession {
    const existing = this.sessions.get(taskId);
    if (existing) return existing;
    const session = new ChatConductorSession(taskId, this.ports(taskId));
    runInAction(() => this.sessions.set(taskId, session));
    void session.load();
    return session;
  }

  /** The conductor of a task if one exists, without creating it. */
  peek(taskId: string): ChatConductorSession | undefined {
    return this.sessions.get(taskId);
  }

  activate(): void {
    void this.followSavedThreads();
    this.decisions.start();
    // A deleted task's conductor stops (main deletes its thread); an archived one stays.
    this.disposers.push(
      reaction(
        () => [...this.sessions.keys()].filter((taskId) => this.taskDeleted(taskId)),
        (deleted) => {
          for (const taskId of deleted) this.forgetTask(taskId);
        }
      )
    );
  }

  /** Where each followed task lives, as last seen, to tell a deleted task from one not loaded. */
  private readonly taskProjects = new Map<string, string>();

  /** The task's project is loaded and the task is gone from it: deleted, not unloaded. */
  private taskDeleted(taskId: string): boolean {
    const entry = this.canvas.agentEntries.find((candidate) => candidate.taskId === taskId);
    if (entry) {
      this.taskProjects.set(taskId, entry.projectId);
      return false;
    }
    const projectId = this.taskProjects.get(taskId);
    if (!projectId || !getTaskManagerStore(projectId)) return false;
    return getTaskStore(projectId, taskId) === undefined;
  }

  private forgetTask(taskId: string): void {
    const session = this.sessions.get(taskId);
    if (!session) return;
    session.dispose();
    this.taskProjects.delete(taskId);
    runInAction(() => this.sessions.delete(taskId));
  }

  /**
   * The conversations whose conductor decides what the developer is told of their events: every
   * chat of a task whose conductor follows it, while conductors can run and the setting is on.
   */
  get decidingChats(): string[] {
    const on =
      this.conductor.status?.settings?.conductorDecidesAttention ??
      DEFAULT_CONDUCTOR_SETTINGS.conductorDecidesAttention;
    if (!this.ready || !on) return [];
    return [...this.sessions.values()]
      .filter((session) => session.attached && session.loaded)
      .flatMap((session) => session.chatIds);
  }

  private readonly decisions = new DecisionDesk({
    claimable: () => this.decidingChats,
    sessionFor: (conversationId) => {
      const entry = this.canvas.agentEntries.find(
        (candidate) => candidate.conversationId === conversationId
      );
      return entry ? (this.sessions.get(entry.taskId) ?? null) : null;
    },
    sessions: () => this.sessions.values(),
    claim: async (conversationIds) =>
      (await getConductorClient()).claimDecisions({ conversationIds: [...conversationIds] }),
    ack: async (holdId) => (await getConductorClient()).ackDecision({ holdId }),
    resolve: async (holdId, conversationId, decision) =>
      (await getConductorClient()).resolveDecision({ holdId, conversationId, decision }),
    open: async () => (await getConductorClient()).openDecisions(),
    subscribe: async (onEvent) =>
      (await getConductorClient()).decisions.subscribe(undefined, { onEvent }),
    warn: (message, data) => log.warn(message, data),
  });

  dispose(): void {
    this.disposed = true;
    this.decisions.dispose();
    for (const dispose of this.disposers.splice(0)) dispose();
    for (const session of this.sessions.values()) session.dispose();
    runInAction(() => {
      this.sessions.clear();
      this.screens.clear();
    });
  }

  private async followSavedThreads(): Promise<void> {
    let tasks: string[];
    let chats: string[];
    try {
      const client = await getConductorClient();
      [tasks, chats] = await Promise.all([client.listTaskThreads(), client.listChatThreads()]);
    } catch (error) {
      log.warn('task conductor: saved threads could not be listed', { error });
      return;
    }
    if (this.disposed || (tasks.length === 0 && chats.length === 0)) return;
    runInAction(() => {
      for (const taskId of tasks) this.waitingTasks.add(taskId);
      for (const conversationId of chats) this.legacy.add(conversationId);
    });
    // Chats load with their task and project; a task is followed when one of its chats shows up,
    // and a chat's own thread goes into its task's thread then.
    const dispose = reaction(
      () => {
        if (this.waitingTasks.size === 0 && this.legacy.size === 0) return [];
        return this.canvas.agentEntries
          .filter(
            (entry) => this.waitingTasks.has(entry.taskId) || this.legacy.has(entry.conversationId)
          )
          .map((entry) => [entry.taskId, entry.conversationId] as const);
      },
      (loaded, _previous, self) => {
        const tasksToFollow = new Set<string>();
        for (const [taskId, conversationId] of loaded) {
          this.waitingTasks.delete(taskId);
          this.legacy.delete(conversationId);
          tasksToFollow.add(taskId);
        }
        for (const taskId of tasksToFollow) {
          const session = this.session(taskId);
          void session.adoptLoadedChats().then(() => session.attach());
        }
        if (this.waitingTasks.size === 0 && this.legacy.size === 0) self.dispose();
      },
      { fireImmediately: true }
    );
    this.disposers.push(dispose);
  }

  /** The own threads of the task's loaded chats, except those already adopted. */
  private async readLegacy(taskId: string, adopted: readonly string[]): Promise<LegacyThread[]> {
    const chats = this.canvas.agentEntries.filter(
      (entry) => entry.taskId === taskId && !adopted.includes(entry.conversationId)
    );
    if (chats.length === 0) return [];
    const client = await getConductorClient();
    const saved = new Set(await client.listChatThreads());
    const found: LegacyThread[] = [];
    for (const entry of chats) {
      if (!saved.has(entry.conversationId)) continue;
      const thread = await client.readChatThread({ conversationId: entry.conversationId });
      if (thread) found.push({ thread, name: chatName(entry) });
    }
    return found;
  }

  private ports(taskId: string): ChatConductorPorts {
    return {
      runTurn: async (messages) => (await getConductorClient()).runChatTurn({ messages }),
      readThread: async () => (await getConductorClient()).readTaskThread({ taskId }),
      saveThread: async (thread) => (await getConductorClient()).saveTaskThread(thread),
      deleteThread: async () => (await getConductorClient()).deleteTaskThread({ taskId }),
      readLegacy: (adopted) => this.readLegacy(taskId, adopted),
      deleteLegacy: async (conversationIds) => {
        const client = await getConductorClient();
        await Promise.all(
          conversationIds.map((conversationId) => client.deleteChatThread({ conversationId }))
        );
      },
      agent: createTaskAgentPort(this.canvas, taskId),
      browsers: createTaskBrowserPort(this.canvas, taskId),
      chatOnScreen: () => this.chatOnScreen(taskId),
      ready: () => this.ready,
      defaultAutonomy: () =>
        this.conductor.status?.settings?.chatConductorAutonomy ??
        DEFAULT_CONDUCTOR_SETTINGS.chatConductorAutonomy,
      now: () => new Date(),
      newId: () => crypto.randomUUID(),
      warn: (message, data) => log.warn(message, data),
      resolveDecision: (holdId, conversationId, decision) => {
        void getConductorClient()
          .then((client) => client.resolveDecision({ holdId, conversationId, decision }))
          .catch((error: unknown) =>
            log.warn('task conductor: decision could not be sent', { error, holdId })
          );
      },
      announceCompletions: () =>
        this.conductor.status?.settings?.announceCompletions ??
        DEFAULT_CONDUCTOR_SETTINGS.announceCompletions,
    };
  }
}
