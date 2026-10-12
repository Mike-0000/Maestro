import { getBrowserClient } from '@core/features/browser/api/browser/client';
import type { CanvasBrowserHost } from '@core/features/canvas/api/browser/stores/canvas-browser-host';
import type {
  BrowserTileEntry,
  CanvasStore,
} from '@core/features/canvas/api/browser/stores/canvas-store';
import { isLocalAppUrl } from '@core/primitives/agents/api/completion-report';
import {
  describeBrowserAction,
  describePublicUrlDenial,
  evaluatePublicUrl,
  formatActResult,
  formatAutomationError,
  formatObservation,
  isMutatingBrowserAction,
  parseUseArgs,
  type BrowserAction,
} from '@core/primitives/browser/api';
import type { ConductorToolInput, ToolOutcome } from '../api/tools';
import { endedTurn } from './roster';

/** The task a conductor app tool acts on. */
export type AppTask = {
  readonly taskId: string;
  readonly projectId: string;
  readonly workspaceId: string;
  readonly name: string;
};

export type AppToolDeps = {
  readonly canvas: CanvasStore;
  readonly host: CanvasBrowserHost;
  requestPending(label: string, kind: 'direct' | 'confirm' | null): Promise<boolean>;
  /** Resolves the tool's `agent` argument (or the focus) to a task with a workspace. */
  resolveTask(agent: string | undefined): { task: AppTask } | { error: string };
  /** The running turn acts on agent output (a completion follow-up), not on the user's words. */
  actingOnAgentOutput?(): boolean;
};

/**
 * After the user lets the conductor drive an app once, further actions within this window run
 * without asking again (main's control lease is the visible signal).
 */
const DRIVE_GRACE_MS = 60_000;

/** The conductor's canvas app tools: run, show, observe, and drive a task's app browser. */
export class ConductorAppTools {
  private readonly approvedUntil = new Map<string, number>();

  constructor(
    private readonly deps: AppToolDeps,
    private readonly now: () => number = Date.now
  ) {}

  async startApp(input: ConductorToolInput<'start_app'>): Promise<ToolOutcome> {
    const resolved = this.deps.resolveTask(input.agent);
    if ('error' in resolved) return { content: resolved.error, isError: true };
    const { task } = resolved;
    const running = this.deps.host.devServerUrls(task)[0];
    if (running) {
      this.deps.host.openForTask(task);
      return { content: `${task.name}'s app is already running at ${running}. Opened it.` };
    }
    if (!(await this.deps.requestPending(`Run ${task.name}'s app`, 'direct'))) {
      return { content: 'Cancelled by the user.' };
    }
    await this.deps.host.runApp(task);
    return {
      content: `Starting ${task.name}'s app with its run script. Its browser opens on the canvas when the dev server is up; check again with look_at_app in a moment.`,
    };
  }

  async stopApp(input: ConductorToolInput<'stop_app'>): Promise<ToolOutcome> {
    const resolved = this.deps.resolveTask(input.agent);
    if ('error' in resolved) return { content: resolved.error, isError: true };
    const { task } = resolved;
    if (!(await this.deps.requestPending(`Stop ${task.name}'s app`, 'direct'))) {
      return { content: 'Cancelled by the user.' };
    }
    await this.deps.host.stopApp(task);
    return { content: `Stopped ${task.name}'s app.` };
  }

  async showApp(input: ConductorToolInput<'show_app'>): Promise<ToolOutcome> {
    const resolved = this.deps.resolveTask(input.agent);
    if ('error' in resolved) return { content: resolved.error, isError: true };
    const { task } = resolved;
    const existing = this.deps.canvas.browserForTask(task.taskId);
    const known = existing?.url && existing.url !== 'about:blank' ? existing.url : undefined;
    const served = this.deps.host.devServerUrls(task)[0];
    const reported = this.reportedAppUrl(task.taskId);
    let url: string | undefined;
    let publicOrigin: string | undefined;
    if (input.url) {
      const parsed = parseUseArgs(
        { action: 'navigate', url: input.url },
        known ?? served ?? reported
      );
      if (typeof parsed === 'string') return { content: parsed, isError: true };
      if (parsed.kind === 'navigate') url = parsed.url;
      // Anything else is a public website: off unless enabled, and the user confirms each site.
      if (url && !isLocalAppUrl(url) && !sameOrigin(url, known ?? served)) {
        const admitted = await this.admitPublicUrl(task, url, existing);
        if ('outcome' in admitted) return admitted.outcome;
        publicOrigin = admitted.origin;
      }
    } else if (!known && !served && reported) {
      // No dev server detected (the agent started it itself): use the URL it reported.
      url = reported;
    }
    this.deps.host.openForTask({ ...task, ...(url ? { url } : {}) });
    const entry = this.deps.canvas.browserForTask(task.taskId);
    if (entry && publicOrigin) await this.deps.host.approvePublicOrigin(entry, publicOrigin);
    const shown = entry?.url && entry.url !== 'about:blank' ? ` at ${entry.url}` : '';
    const running = this.deps.host.appRunning(task)
      ? ''
      : ' No dev server is detected yet; start_app runs it.';
    return { content: `Showing ${task.name}'s app${shown}.${running}` };
  }

  async closeApp(input: ConductorToolInput<'close_app'>): Promise<ToolOutcome> {
    const resolved = this.deps.resolveTask(input.agent);
    if ('error' in resolved) return { content: resolved.error, isError: true };
    const entry = this.deps.canvas.browserForTask(resolved.task.taskId);
    if (!entry) return { content: `${resolved.task.name} has no app browser open.` };
    await this.deps.host.close(entry);
    return { content: `Closed ${resolved.task.name}'s app browser.` };
  }

  async lookAtApp(input: ConductorToolInput<'look_at_app'>): Promise<ToolOutcome> {
    const target = await this.controllable(input.agent, { mutating: false });
    if ('outcome' in target) return target.outcome;
    const client = await getBrowserClient();
    const result = await client.observe({
      browserId: target.entry.browserId,
      mode: input.mode,
      includeConsole: input.include_console ?? false,
    });
    if (!result.success) return { content: formatAutomationError(result.error), isError: true };
    const { image, ...rest } = result.data;
    return {
      content: formatObservation(rest),
      ...(image ? { images: [image] } : {}),
    };
  }

  async useApp(input: ConductorToolInput<'use_app'>): Promise<ToolOutcome> {
    const { agent, ...args } = input;
    const target = await this.controllable(agent, { mutating: true });
    if ('outcome' in target) return target.outcome;
    const action = parseUseArgs(args, target.entry.url);
    if (typeof action === 'string') return { content: action, isError: true };
    if (action.kind === 'navigate' && this.leavesTheApp(target.task, action.url)) {
      const admitted = await this.admitPublicUrl(target.task, action.url, target.entry);
      if ('outcome' in admitted) return admitted.outcome;
      await this.deps.host.approvePublicOrigin(target.entry, admitted.origin);
    }
    const approved = await this.approveDrive(target.entry, target.task, action);
    if (!approved) return { content: 'Cancelled by the user.' };
    const client = await getBrowserClient();
    const result = await client.act({ browserId: target.entry.browserId, action });
    if (!result.success) return { content: formatAutomationError(result.error), isError: true };
    return { content: formatActResult(action, result.data) };
  }

  /** A local app URL that one of the task's agents reported in its latest final reply. */
  private reportedAppUrl(taskId: string): string | undefined {
    for (const entry of this.deps.canvas.agentEntries) {
      if (entry.taskId !== taskId || !endedTurn(entry)) continue;
      const url = entry.completionReport?.appUrls[0];
      if (url) return url;
    }
    return undefined;
  }

  /** A public https URL outside the task's own app; main judges every other URL. */
  private leavesTheApp(task: AppTask, url: string): boolean {
    if (!evaluatePublicUrl(url).ok) return false;
    return !this.deps.host.devServerUrls(task).some((served) => sameOrigin(url, served));
  }

  /**
   * The gate for sending a task's browser to a public website: never on agent output alone, only
   * with the setting on, only for https hosts on the public internet, and only after the user
   * confirmed that origin for this browser. Main enforces the same approval on every navigation.
   */
  private async admitPublicUrl(
    task: AppTask,
    url: string,
    entry: BrowserTileEntry | undefined
  ): Promise<{ origin: string } | { outcome: ToolOutcome }> {
    const refuse = (content: string) => ({ outcome: { content, isError: true } });
    if (this.deps.actingOnAgentOutput?.()) {
      return refuse(
        `Not opening ${url}: an agent's reply cannot send the browser to a public website. Offer it to the user; open it when they ask.`
      );
    }
    const decision = evaluatePublicUrl(url);
    if (!decision.ok)
      return refuse(`Not opening it: ${describePublicUrlDenial(decision.reason, url)}`);
    if (!(await this.deps.host.conductorPublicWebEnabled())) {
      return refuse(
        `Not opening ${url}: public websites are turned off. The user can turn on "Conductor can open public websites" in Settings, Browser. Do not retry until they have.`
      );
    }
    const { origin } = decision;
    if (entry && this.deps.host.publicOriginApproved(entry.browserId, origin)) return { origin };
    const label = `Open the public website ${origin} in ${task.name}'s app browser`;
    if (!(await this.deps.requestPending(label, 'confirm'))) {
      return {
        outcome: { content: `The user did not allow ${origin}. Do not retry.`, cancelled: true },
      };
    }
    return { origin };
  }

  /** Forgets approvals (the user stopped the lease or took the app back). */
  revoke(browserId: string): void {
    this.approvedUntil.delete(browserId);
  }

  /**
   * The task's browser, ready for the conductor: opened (and resumed) if needed, and handed to
   * agents when the user confirms. Observation never hands control over by itself.
   */
  private async controllable(
    agent: string | undefined,
    options: { mutating: boolean }
  ): Promise<{ entry: BrowserTileEntry; task: AppTask } | { outcome: ToolOutcome }> {
    const resolved = this.deps.resolveTask(agent);
    if ('error' in resolved) return { outcome: { content: resolved.error, isError: true } };
    const { task } = resolved;
    let entry = this.deps.canvas.browserForTask(task.taskId);
    if (!entry) {
      if (!this.deps.host.appRunning(task)) {
        return {
          outcome: {
            content: `${task.name} has no app browser and no running dev server. Use start_app first.`,
            isError: true,
          },
        };
      }
      this.deps.host.openForTask(task, { focus: false });
      entry = this.deps.canvas.browserForTask(task.taskId);
      if (!entry) return { outcome: { content: 'Could not open the app.', isError: true } };
    }
    if (entry.control !== 'agents') {
      const label = options.mutating
        ? `Let the conductor use ${task.name}'s app`
        : `Let the conductor see ${task.name}'s app`;
      if (!(await this.deps.requestPending(label, 'confirm'))) {
        return {
          outcome: {
            content:
              'The user keeps this app to themselves. Do not retry; they can switch the tile to Agents.',
          },
        };
      }
      if (!(await this.deps.host.applyControl(entry, 'agents'))) {
        return {
          outcome: {
            content: 'Could not hand the app to agents (browser control may be off in Settings).',
            isError: true,
          },
        };
      }
      // Confirming control counts as approving this action.
      this.approvedUntil.set(entry.browserId, this.now() + DRIVE_GRACE_MS);
      entry = this.deps.canvas.browserForTask(task.taskId) ?? entry;
    }
    this.deps.host.ensureAlive(entry.browserId);
    return { entry, task };
  }

  private async approveDrive(
    entry: BrowserTileEntry,
    task: AppTask,
    action: BrowserAction
  ): Promise<boolean> {
    if (!isMutatingBrowserAction(action)) return true;
    const now = this.now();
    if ((this.approvedUntil.get(entry.browserId) ?? 0) > now) {
      this.approvedUntil.set(entry.browserId, now + DRIVE_GRACE_MS);
      return true;
    }
    const label = `${task.name}'s app: ${describeBrowserAction(action)}`;
    if (!(await this.deps.requestPending(label, 'direct'))) return false;
    this.approvedUntil.set(entry.browserId, this.now() + DRIVE_GRACE_MS);
    return true;
  }
}

function sameOrigin(url: string, base: string | undefined): boolean {
  if (!base) return false;
  try {
    return new URL(url).origin === new URL(base).origin;
  } catch {
    return false;
  }
}
