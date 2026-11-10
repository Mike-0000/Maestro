import { observable, reaction, runInAction } from 'mobx';
import type { CanvasStore } from '@core/features/canvas/api/browser/stores/canvas-store';
import { log } from '@core/primitives/logging/browser/logger';
import { getConductorClient } from '../../api/browser/client';
import type { ConductorStatus } from '../../api/contract';
import { DEFAULT_CONDUCTOR_SETTINGS } from '../../api/contract';
import { createChatAgentPort } from './agent-port';
import { ChatConductorSession, type ChatConductorPorts } from './session';

/** What the manager reads of Maestro's conductor: its status, kept current by that store. */
export interface ChatConductorStatusSource {
  readonly status: ConductorStatus | null;
}

/**
 * The chat conductors of the app, one session per conversation.
 *
 * A session costs nothing until the developer first shows a chat's Conductor view: only then does
 * it attach and follow the chat. Chats that had a thread when the app closed are followed again
 * as soon as their conversation is loaded; no agent is started to do so.
 */
export class ChatConductorManager {
  private readonly sessions = observable.map<string, ChatConductorSession>([], { deep: false });
  private readonly disposers: (() => void)[] = [];
  /** Conversations with a saved thread that are not followed yet. */
  private readonly waiting = observable.set<string>();
  private disposed = false;

  constructor(
    private readonly canvas: CanvasStore,
    private readonly conductor: ChatConductorStatusSource
  ) {}

  /** Chat conductors can run a turn: the setting is on and a key is set. */
  get ready(): boolean {
    return this.conductor.status?.chatConductorReady ?? false;
  }

  /** Whether the developer turned chat conductors off (as opposed to a missing key). */
  get enabled(): boolean {
    return (
      this.conductor.status?.settings?.chatConductors ?? DEFAULT_CONDUCTOR_SETTINGS.chatConductors
    );
  }

  /** The conductor of a chat, created on first use. It does nothing until attached. */
  session(conversationId: string): ChatConductorSession {
    const existing = this.sessions.get(conversationId);
    if (existing) return existing;
    const session = new ChatConductorSession(conversationId, this.ports(conversationId));
    runInAction(() => this.sessions.set(conversationId, session));
    void session.load();
    return session;
  }

  /** The conductor of a chat if one exists, without creating it. */
  peek(conversationId: string): ChatConductorSession | undefined {
    return this.sessions.get(conversationId);
  }

  activate(): void {
    void this.followSavedThreads();
  }

  dispose(): void {
    this.disposed = true;
    for (const dispose of this.disposers.splice(0)) dispose();
    for (const session of this.sessions.values()) session.dispose();
    this.sessions.clear();
  }

  private async followSavedThreads(): Promise<void> {
    let saved: string[];
    try {
      saved = await (await getConductorClient()).listChatThreads();
    } catch (error) {
      log.warn('chat conductor: saved threads could not be listed', { error });
      return;
    }
    if (this.disposed || saved.length === 0) return;
    runInAction(() => {
      for (const conversationId of saved) this.waiting.add(conversationId);
    });
    // Conversations load with their task and project; each is followed when it shows up.
    const dispose = reaction(
      () => {
        if (this.waiting.size === 0) return [];
        return this.canvas.agentEntries
          .map((entry) => entry.conversationId)
          .filter((conversationId) => this.waiting.has(conversationId));
      },
      (loaded, _previous, self) => {
        for (const conversationId of loaded) {
          this.waiting.delete(conversationId);
          void this.session(conversationId).attach();
        }
        if (this.waiting.size === 0) self.dispose();
      },
      { fireImmediately: true }
    );
    this.disposers.push(dispose);
  }

  private ports(conversationId: string): ChatConductorPorts {
    return {
      runTurn: async (messages) => (await getConductorClient()).runChatTurn({ messages }),
      readThread: async () => (await getConductorClient()).readChatThread({ conversationId }),
      saveThread: async (thread) => (await getConductorClient()).saveChatThread(thread),
      deleteThread: async () => (await getConductorClient()).deleteChatThread({ conversationId }),
      agent: createChatAgentPort(this.canvas, conversationId),
      ready: () => this.ready,
      defaultAutonomy: () =>
        this.conductor.status?.settings?.chatConductorAutonomy ??
        DEFAULT_CONDUCTOR_SETTINGS.chatConductorAutonomy,
      now: () => new Date(),
      newId: () => crypto.randomUUID(),
      warn: (message, data) => log.warn(message, data),
    };
  }
}
