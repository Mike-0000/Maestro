import type { TerminalShellId } from '@emdash/core/primitives/terminal-shell/api';
import type { Disposable } from '@emdash/shared/concurrency';
import { ReplicaLog } from '@emdash/wire/live';
import type { Terminal as XtermTerminal } from '@xterm/xterm';
import { computed, makeObservable, observable, reaction, runInAction } from 'mobx';
import { makeFileLinkHandlers } from '@core/features/editor/api/browser/open-file-in-file-editor';
import {
  classifyLiveRuntimeObservation,
  type LiveRuntimeObservation,
} from '@core/features/projects/api/browser/live-runtime-observation';
import type { ProjectHostAccess } from '@core/features/projects/api/browser/stores/project-context';
import { getAppSettingValueSnapshot } from '@core/features/settings/api/browser/app-settings-client';
import type { TerminalRuntimeKey } from '@core/features/terminals/api';
import {
  getTerminalsClient,
  type TerminalsClient,
} from '@core/features/terminals/api/browser/client';
import type { FrontendPtyConnector } from '@core/features/terminals/api/browser/pty/pty';
import { PtySession } from '@core/features/terminals/api/browser/pty/pty-session';
import { createXtermLogSink } from '@core/features/terminals/api/browser/pty/xterm-log-sink';
import { Resource } from '@core/primitives/async-resource/browser/resource';
import { log } from '@core/primitives/logging/browser/logger';
import { makePtySessionId } from '@core/primitives/pty/api';
import { type CreateTerminalParams, type Terminal } from '@core/primitives/terminals/api';
import { nextTerminalName } from '../../../browser/task-terminal/terminal-tabs';

/** Longest a new terminal's first connect waits for its `create` call before hydrating anyway. */
const CREATE_WAIT_MS = 30_000;

export class TerminalManagerStore implements Disposable {
  readonly projectId: string;
  readonly taskId: string;
  /** Data layer: plain Terminal records loaded from the main process. */
  readonly list: Resource<Terminal[]>;
  /** Data stores keyed by terminal id â€” populated by reaction on list.data. */
  terminals = observable.map<string, TerminalStore>();
  /** Session layer keyed by terminal id â€” created alongside data, connected lazily. */
  sessions = observable.map<string, PtySession>();
  // Shallow: TerminalKey values must stay plain objects so they can be
  // structured-cloned when posted over the wire (MobX proxies cannot).
  runtimeKeys = observable.map<string, TerminalRuntimeKey>({}, { deep: false });
  /**
   * Terminals created in this window whose `create` call has not settled yet, keyed by id. The
   * session exists (optimistically) before the main process has written the terminal's row, so
   * its first connect waits for this; hydrating earlier fails with "Terminal not found" and left
   * a new terminal blank until relaunch.
   */
  private readonly pendingCreates = new Map<
    string,
    { settled: Promise<void>; settle: () => void }
  >();
  private disposed = false;
  private readonly _disposeReaction: () => void;
  private readonly _disposeHostReaction: () => void;

  constructor(
    projectId: string,
    taskId: string,
    readonly hostAccess?: ProjectHostAccess
  ) {
    this.projectId = projectId;
    this.taskId = taskId;

    this.list = new Resource<Terminal[]>(async () => {
      const result = await (await getTerminalsClient()).list({ projectId, taskId });
      if (!result.success) throw new Error(terminalErrorMessage(result.error));
      return result.data;
    }, [{ kind: 'demand' }]);

    makeObservable(this, {
      terminals: observable,
      sessions: observable,
      runtimeKeys: observable,
      isLoaded: computed,
      observation: computed,
    });

    // Sync terminals and sessions maps whenever the resource data changes.
    // fireImmediately ensures the reaction runs once on construction to establish
    // the dependency on list.data, which triggers the demand-strategy load.
    this._disposeReaction = reaction(
      () => this.list.data,
      (data) => {
        if (!data) return;
        runInAction(() => {
          const incomingIds = new Set(data.map((t) => t.id));

          // Add new entries (no connect()).
          for (const terminal of data) {
            if (!this.terminals.has(terminal.id)) {
              this.terminals.set(terminal.id, new TerminalStore(terminal));
            }
            if (!this.sessions.has(terminal.id)) {
              this.sessions.set(terminal.id, this.createSession(terminal));
            }
          }

          // Remove stale entries.
          const staleIds = Array.from(this.terminals.keys()).filter((id) => !incomingIds.has(id));
          for (const id of staleIds) {
            this.sessions.get(id)?.destroy();
            this.sessions.delete(id);
            this.terminals.delete(id);
          }
        });
      },
      { fireImmediately: true }
    );
    const initialHost = this.hostAccess?.state;
    let lastHostGeneration = initialHost?.kind === 'ready' ? initialHost.hostGeneration : undefined;
    this._disposeHostReaction = reaction(
      () => this.hostAccess?.state,
      (state) => {
        if (state?.kind !== 'ready') return;
        this.list.invalidate();
        const changed = lastHostGeneration !== state.hostGeneration;
        lastHostGeneration = state.hostGeneration;
        for (const session of this.sessions.values()) {
          if (!changed) {
            session.resumeIfRequested();
            continue;
          }
          void session.refreshAttachment().catch((error) => {
            log.warn('Terminal attachment recovery failed', { error });
          });
        }
      }
    );
  }

  get isLoaded(): boolean {
    return this.list.data !== null;
  }

  get observation(): LiveRuntimeObservation<Terminal[]> {
    return classifyLiveRuntimeObservation(
      this.hostAccess?.state ?? { kind: 'ready', hostGeneration: 0 },
      this.list.data ?? undefined
    );
  }

  async createTerminal(params: CreateTerminalParams): Promise<Terminal> {
    if (this.hostAccess?.liveAction.kind === 'disabled') {
      throw new Error('Live actions are unavailable for this Project.');
    }
    const defaultShell = getAppSettingValueSnapshot('terminal')?.defaultShell ?? 'system';
    const optimistic: Terminal = {
      id: params.id,
      projectId: params.projectId,
      taskId: params.taskId,
      shellId: params.shell ?? defaultShell,
      name: params.name,
    };

    // Registered before the session exists, so the session's first connect always sees it.
    let settleCreate: () => void = () => {};
    const settled = new Promise<void>((resolve) => {
      settleCreate = resolve;
    });
    const pending = { settled, settle: settleCreate };
    this.pendingCreates.set(params.id, pending);

    runInAction(() => {
      this.terminals.set(params.id, new TerminalStore(optimistic));
      this.sessions.set(params.id, this.createSession(optimistic));
    });

    try {
      const result = await (await getTerminalsClient()).create(params);
      if (!result.success) throw new Error(terminalErrorMessage(result.error));
      const { terminal, key } = result.data;
      runInAction(() => {
        const store = this.terminals.get(params.id);
        if (store) {
          Object.assign(store.data, terminal);
        }
        this.runtimeKeys.set(params.id, key);
      });
      // A connect that gave up waiting (see CREATE_WAIT_MS) failed to hydrate; retry it now.
      this.sessions.get(params.id)?.resumeIfRequested();
      return terminal;
    } catch (err) {
      runInAction(() => {
        this.sessions.get(params.id)?.destroy();
        this.sessions.delete(params.id);
        this.terminals.delete(params.id);
      });
      throw err;
    } finally {
      // After the rollback above, so a waiting connect finds a destroyed session and stops.
      if (this.pendingCreates.get(params.id) === pending) this.pendingCreates.delete(params.id);
      pending.settle();
    }
  }

  /**
   * Waits for a pending `create` of this terminal, at most CREATE_WAIT_MS, so a create that never
   * settles cannot leave the connect waiting forever (it then hydrates and fails as before, and
   * the create's success retries it).
   */
  private async waitForPendingCreate(terminalId: string): Promise<void> {
    const pending = this.pendingCreates.get(terminalId);
    if (!pending) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        pending.settled,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, CREATE_WAIT_MS);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  async createDefaultTerminal(shell?: TerminalShellId): Promise<Terminal> {
    const names = Array.from(this.terminals.values()).map((t) => t.data.name);
    const name = nextTerminalName(names);
    const id = crypto.randomUUID();
    const params: CreateTerminalParams = {
      id,
      projectId: this.projectId,
      taskId: this.taskId,
      name,
    };
    if (shell !== undefined) params.shell = shell;
    return this.createTerminal(params);
  }

  async deleteTerminal(terminalId: string): Promise<void> {
    const store = this.terminals.get(terminalId);
    const session = this.sessions.get(terminalId);
    if (!store) return;

    runInAction(() => {
      this.terminals.delete(terminalId);
      this.sessions.delete(terminalId);
    });

    try {
      const result = await (
        await getTerminalsClient()
      ).delete({
        projectId: this.projectId,
        taskId: this.taskId,
        terminalId,
      });
      if (!result.success) throw new Error(terminalErrorMessage(result.error));
      session?.destroy();
    } catch (err) {
      runInAction(() => {
        this.terminals.set(terminalId, store);
        if (session) this.sessions.set(terminalId, session);
      });
      throw err;
    }
  }

  async hydrateTerminal(terminalId: string): Promise<void> {
    const store = this.terminals.get(terminalId);
    if (!store) return;
    if (this.hostAccess?.liveAction.kind === 'disabled') {
      throw new Error('Live actions are unavailable for this Project.');
    }
    const result = await (
      await getTerminalsClient()
    ).hydrate({
      projectId: this.projectId,
      taskId: this.taskId,
      terminalId,
    });
    if (!result.success) throw new Error(terminalErrorMessage(result.error));
    runInAction(() => {
      this.runtimeKeys.set(terminalId, result.data.key);
    });
  }

  dispose(): void {
    this.disposed = true;
    this._disposeReaction();
    this._disposeHostReaction();
    for (const session of this.sessions.values()) {
      session.destroy();
    }
    // Release connects still waiting on a create; their sessions are destroyed, so they stop.
    for (const pending of this.pendingCreates.values()) pending.settle();
    this.pendingCreates.clear();
    this.list.dispose();
  }

  async renameTerminal(terminalId: string, name: string): Promise<void> {
    const store = this.terminals.get(terminalId);
    if (!store) return;

    const previousName = store.data.name;

    runInAction(() => {
      store.data.name = name;
    });

    try {
      const result = await (await getTerminalsClient()).rename({ terminalId, name });
      if (!result.success) throw new Error(terminalErrorMessage(result.error));
    } catch (err) {
      runInAction(() => {
        store.data.name = previousName;
      });
      throw err;
    }
  }

  private createSession(terminal: Terminal): PtySession {
    const handlers = makeFileLinkHandlers(terminal.projectId, terminal.taskId);
    return new PtySession(
      makePtySessionId(terminal.projectId, terminal.taskId, terminal.id),
      async () => {
        await this.waitForPendingCreate(terminal.id);
        // Disposed or rolled back while waiting: nothing to hydrate.
        if (this.disposed || !this.sessions.has(terminal.id)) return false;
        return this.hydrateTerminal(terminal.id);
      },
      handlers.onOpenFile,
      handlers.onOpenExternal,
      createTerminalsConnector(
        () => this.ensureRuntimeKey(terminal.id),
        () => {
          const state = this.hostAccess?.state;
          return !state ? 0 : state.kind === 'ready' ? state.hostGeneration : undefined;
        }
      ),
      () => this.hostAccess?.liveAction.kind !== 'disabled'
    );
  }

  private async ensureRuntimeKey(terminalId: string): Promise<TerminalRuntimeKey> {
    const existing = this.runtimeKeys.get(terminalId);
    if (existing) return existing;
    await this.hydrateTerminal(terminalId);
    const key = this.runtimeKeys.get(terminalId);
    if (!key) throw new Error(`Terminal ${terminalId} did not hydrate`);
    return key;
  }
}

export class TerminalStore {
  data: Terminal;

  constructor(terminal: Terminal) {
    this.data = terminal;
    makeObservable(this, { data: observable });
  }
}

function terminalErrorMessage(error: { type: string; message?: string }): string {
  return error.message ?? `Terminal operation failed: ${error.type}`;
}

function createTerminalsConnector(
  key: () => Promise<TerminalRuntimeKey>,
  generation: () => number | undefined
): FrontendPtyConnector {
  let logBinding: ReplicaLog | null = null;
  let runtimePromise: Promise<TerminalsClient> | null = null;
  const runtime = () => {
    runtimePromise ??= getTerminalsClient();
    return runtimePromise;
  };

  return {
    async connect(terminal: XtermTerminal) {
      const [terminalsRuntime, terminalKey] = await Promise.all([runtime(), key()]);
      logBinding = new ReplicaLog(terminalsRuntime.output.handle(terminalKey), {
        store: createXtermLogSink(terminal, { label: `terminal ${terminalKey.terminalId}` }),
      });
      await logBinding.ready;
      return () => {
        void logBinding?.dispose();
        logBinding = null;
      };
    },
    sendInput(data: string) {
      const sentGeneration = generation();
      if (sentGeneration === undefined) return;
      void Promise.all([runtime(), key()])
        .then(async ([terminalsRuntime, terminalKey]) => {
          if (generation() !== sentGeneration) return;
          const result = await terminalsRuntime.sendInput({ ...terminalKey, data });
          if (!result.success) {
            log.warn('TerminalManagerStore: terminal input failed', {
              terminalId: terminalKey.terminalId,
              error: result.error,
            });
          }
        })
        .catch((error) => {
          log.warn('TerminalManagerStore: failed to send terminal input', { error });
        });
    },
    resize(cols: number, rows: number) {
      void Promise.all([runtime(), key()])
        .then(async ([terminalsRuntime, terminalKey]) => {
          const result = await terminalsRuntime.resize({ ...terminalKey, cols, rows });
          if (!result.success) {
            log.warn('TerminalManagerStore: terminal resize failed', {
              terminalId: terminalKey.terminalId,
              error: result.error,
            });
          }
        })
        .catch((error) => {
          log.warn('TerminalManagerStore: failed to resize terminal', { error });
        });
    },
  };
}
