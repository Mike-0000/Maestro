import type Anthropic from '@anthropic-ai/sdk';
import { makeAutoObservable, reaction, runInAction } from 'mobx';
import type {
  AgentTileEntry,
  CanvasStore,
} from '@core/features/canvas/api/browser/stores/canvas-store';
import { getCanvasBrowserHost } from '@core/features/canvas/contributions/browser/app-stores';
import { getProjectManagerStore } from '@core/features/projects/api/browser/stores/project-selectors';
import {
  getTaskManagerStore,
  getTaskStore,
} from '@core/features/tasks/api/browser/task-state/task-selectors';
import { log } from '@core/primitives/logging/browser/logger';
import { announcementText, attentionPhrase } from '../api/announcements';
import { getConductorClient } from '../api/browser/client';
import {
  DEFAULT_CONDUCTOR_SETTINGS,
  type ConductorError,
  type ConductorMode,
  type ConductorSettings,
  type ConductorStatus,
  type ConductorTurnRecord,
  type TraceEvent,
} from '../api/contract';
import { chooseMode, parseCommand, type CloseScope, type GrammarCommand } from '../api/grammar';
import { pruneScreenshots, trimHistory } from '../api/history';
import {
  interpretPermissionRisk,
  interpretPlanReview,
  interpretRouting,
  interpretSubtaskSizes,
  interpretUrgency,
  permissionRiskQuestions,
  planReviewQuestions,
  planReviewState,
  routingQuestions,
  routingState,
  urgencyQuestions,
  type SubtaskSize,
} from '../api/jev';
import { resolveAgent, type RosterAgent } from '../api/resolver';
import { conductorUserMessage } from '../api/system-prompt';
import {
  CANCEL_WINDOW_TOOLS,
  CONFIRM_REQUIRED_TOOLS,
  conductorToolNames,
  conductorToolSchemas,
  type ConductorToolInput,
  type ConductorToolName,
  type ToolOutcome,
} from '../api/tools';
import { atPermissionPrompt, closeTargets, listNames, reopenTargets } from '../api/window-targets';
import {
  answerPermission,
  interruptAgent,
  lastMeaningfulLine,
  readAgentOutput,
  sendToAgent,
  stopAgentSession,
  submitAgentInput,
} from './agent-io';
import { ConductorAppTools, type AppTask } from './app-tools';
import { deliverPromptWhenReady } from './deferred-prompt';
import { focusSpawnedAgent } from './focus-spawned-agent';
import { jevDecide } from './jev';
import { PlanStore } from './plan-store';
import {
  buildContext,
  buildRoster,
  entryForConversation,
  focusedConversationId,
  installedProviders,
  offBoardEntries,
  vocabulary,
} from './roster';
import { resolveProjectId, spawnAgentTask, startAgentSession } from './spawn';

/** What the conductor needs from the voice slice (kept structural to avoid a slice dependency). */
export interface ConductorVoicePort {
  readonly muted: boolean;
  say(text: string, interactionId?: string): void;
  announce(text: string): void;
  setMuted(muted: boolean): void;
  setTranscriptHandler(
    handler: (
      text: string,
      intent: 'command' | 'dictation',
      interactionId: string
    ) => Promise<void> | void
  ): void;
  setTraceHandler(handler: (event: TraceEvent) => void): void;
  setVocabularyProvider(provider: () => string[]): void;
}

export type ConductorPhase = 'idle' | 'thinking' | 'acting';
export type UtteranceSource = 'voice' | 'typed';

export type PendingAction = {
  readonly id: number;
  readonly label: string;
  /** "countdown" runs unless cancelled; "confirm" runs only when confirmed. */
  readonly kind: 'countdown' | 'confirm';
  readonly startedAt: number;
  readonly durationMs: number;
};

export type ConductorErrorState = { message: string; kind: ConductorError['type'] | 'other' };

type ActionRecord = ConductorTurnRecord['actions'][number];

/** Short cancel window before side-effecting commands run. */
export const CANCEL_WINDOW_MS = 1_500;
/** How long an explicit confirmation waits before it lapses. */
const CONFIRM_TIMEOUT_MS = 30_000;
/** Spoken (and shown) for "help" and "what can I say". */
export const HELP_REPLY =
  'Try "focus Atlas", "tell Bravo to run the tests", "what is Cedar doing", "next", ' +
  '"show all", "close", "reopen", "interrupt Atlas", "allow Bravo", or "shut down Cedar".';

/** Upper bound on model round trips for one utterance. */
const MAX_TOOL_ITERATIONS = 8;
/** Attention events arriving within this window are announced together. */
const ANNOUNCE_BATCH_MS = 900;
const READ_AGENT_MAX_CHARS = 6_000;

/**
 * The conductor turns utterances into actions on agents. A deterministic grammar handles common
 * commands instantly; everything else goes to Claude with tools that execute here in the renderer
 * against the live canvas and task stores. Side effects run behind a cancel window, and answering
 * permission prompts always needs an explicit yes.
 */
export class ConductorStore {
  phase: ConductorPhase = 'idle';
  activity = '';
  lastUtterance = '';
  lastRoute: ConductorTurnRecord['route'] | null = null;
  reply = '';
  replyAt = 0;
  error: ConductorErrorState | null = null;
  pending: PendingAction | null = null;
  status: ConductorStatus | null = null;
  /** Bumped after each turn is written to the log, so history views can refresh. */
  logVersion = 0;
  readonly plans: PlanStore;

  private history: Anthropic.Beta.BetaMessageParam[] = [];
  private queued: { text: string; source: UtteranceSource; interactionId: string } | null = null;
  private interactionId: string | null = null;
  private traceWrites: Promise<void> = Promise.resolve();
  private pendingResolve: ((confirmed: boolean) => void) | null = null;
  private pendingTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingSeq = 0;
  private announceQueue: AgentTileEntry[] = [];
  private announceTimer: ReturnType<typeof setTimeout> | null = null;
  /** The windows the conductor closed last, so a bare "reopen" or "undo" restores the batch. */
  private lastClosed: string[] = [];
  private readonly disposers: (() => void)[] = [];
  private appToolsInstance: ConductorAppTools | null = null;

  constructor(
    private readonly canvas: CanvasStore,
    private readonly voice: ConductorVoicePort
  ) {
    this.plans = new PlanStore(canvas, { notify: (text) => this.notify(text) });
    makeAutoObservable<
      ConductorStore,
      | 'canvas'
      | 'voice'
      | 'history'
      | 'queued'
      | 'interactionId'
      | 'traceWrites'
      | 'pendingResolve'
      | 'pendingTimer'
      | 'pendingSeq'
      | 'announceQueue'
      | 'announceTimer'
      | 'lastClosed'
      | 'disposers'
      | 'appToolsInstance'
    >(this, {
      plans: false,
      canvas: false,
      voice: false,
      history: false,
      queued: false,
      interactionId: false,
      traceWrites: false,
      pendingResolve: false,
      pendingTimer: false,
      pendingSeq: false,
      announceQueue: false,
      announceTimer: false,
      lastClosed: false,
      disposers: false,
      appToolsInstance: false,
    });
  }

  activate(): void {
    this.voice.setTraceHandler((event) => this.writeTrace(event));
    this.voice.setTranscriptHandler((text, intent, interactionId) =>
      intent === 'dictation'
        ? this.dictate(text, interactionId)
        : this.handleUtterance(text, 'voice', interactionId)
    );
    this.voice.setVocabularyProvider(() => this.vocabulary());
    void this.refreshStatus();
    void installedProviders();
    this.disposers.push(
      reaction(
        () => this.canvas.noteDrop,
        (drop) => {
          if (!drop) return;
          this.canvas.consumeNoteDrop(drop.id);
          void this.sendNote(drop.conversationId, drop.text);
        }
      )
    );
    let known = new Set(this.canvas.attentionEntries.map((entry) => entry.tileId));
    this.disposers.push(
      reaction(
        () => this.canvas.attentionEntries,
        (entries) => {
          const fresh = entries.filter((entry) => !known.has(entry.tileId));
          known = new Set(entries.map((entry) => entry.tileId));
          for (const entry of fresh) {
            // Triage first (Jev answers in well under a second) so the announcement can say how
            // risky the request is; announce regardless if triage fails.
            void this.triage(entry)
              .catch(() => {})
              .then(() => this.queueAnnouncements([entry]));
          }
          // Drop insights for agents that stopped waiting.
          const waiting = new Set(entries.map((entry) => entry.conversationId));
          for (const id of [...this.canvas.insights.keys()]) {
            if (!waiting.has(id)) this.canvas.clearInsight(id);
          }
        }
      )
    );
  }

  dispose(): void {
    for (const dispose of this.disposers.splice(0)) dispose();
    this.plans.dispose();
    this.settlePending(false);
    if (this.announceTimer) clearTimeout(this.announceTimer);
  }

  get busy(): boolean {
    return this.phase !== 'idle';
  }

  get configured(): boolean {
    return this.status?.configured ?? false;
  }

  get settings(): ConductorSettings | null {
    return this.status?.settings ?? null;
  }

  /** Words for the speech engine's vocabulary hint. */
  vocabulary(): string[] {
    return vocabulary(this.canvas);
  }

  // ── Entry points ───────────────────────────────────────────────────────────

  /** Voice dictation: types the text into the focused agent without pressing Enter. */
  async dictate(text: string, interactionId: string = crypto.randomUUID()): Promise<void> {
    this.trace('dictation', text, { status: 'requested' }, interactionId);
    const entry = this.focusedEntry();
    if (!entry) {
      this.setReply('Focus an agent first, then dictate.', 'voice', interactionId);
      return;
    }
    const blocked = this.permissionBlock(entry);
    if (blocked) {
      this.setReply(blocked, 'voice', interactionId);
      return;
    }
    try {
      await sendToAgent(entry, text, false);
      this.trace(
        'action-result',
        undefined,
        { tool: 'dictation', status: 'accepted' },
        interactionId
      );
      this.setReply(
        `Typed into ${this.nameOf(entry)}. Say "send it" to submit.`,
        null,
        interactionId
      );
    } catch (error) {
      this.trace(
        'action-result',
        undefined,
        { tool: 'dictation', status: 'failed' },
        interactionId
      );
      this.setReply(errorMessage(error), 'voice', interactionId);
    }
  }

  async handleUtterance(
    raw: string,
    source: UtteranceSource,
    interactionId: string = crypto.randomUUID()
  ): Promise<void> {
    const text = raw.trim();
    if (!text) return;
    if (source === 'typed') this.trace('capture', text, { source: 'typed' }, interactionId);

    // A pending action is answered before anything else, even while a turn is running.
    const roster = buildRoster(this.canvas);
    const focusedId = focusedConversationId(this.canvas);
    const command = parseCommand(text, roster, focusedId);
    if (this.pending) {
      if (command?.kind === 'confirm') {
        this.trace(
          'confirmation',
          text,
          { status: 'user-confirmed', targetInteractionId: this.interactionId ?? '' },
          interactionId
        );
        return this.confirmPending();
      }
      // "Close" with something pending closes the prompt in front of the user, not a window.
      if (command?.kind === 'reject' || (command?.kind === 'close' && !command.agent)) {
        this.cancelPending();
        this.trace(
          'confirmation',
          text,
          { status: 'user-cancelled', targetInteractionId: this.interactionId ?? '' },
          interactionId
        );
        this.setReply('Cancelled.', source, interactionId);
        return;
      }
      this.cancelPending();
    }

    if (this.busy) {
      if (this.queued)
        this.trace(
          'ignored',
          undefined,
          { reason: 'superseded-by-new-command' },
          this.queued.interactionId
        );
      this.queued = { text, source, interactionId };
      this.trace('route', undefined, { status: 'queued' }, interactionId);
      return;
    }

    this.interactionId = interactionId;
    this.lastUtterance = text;
    this.error = null;
    const startedAt = performance.now();
    try {
      if (command && (await this.runGrammar(command, source, startedAt))) return;
      const routed = await this.routeWithJev(text, source, startedAt);
      if (routed.handled) return;
      await this.runModel(text, source, startedAt, routed.mode);
    } finally {
      runInAction(() => {
        this.phase = 'idle';
        this.activity = '';
      });
      const next = this.queued;
      this.queued = null;
      if (next) void this.handleUtterance(next.text, next.source, next.interactionId);
    }
  }

  /** A note dropped on an agent: send its text after the usual cancel window. */
  private async sendNote(conversationId: string, text: string): Promise<void> {
    const entry = entryForConversation(this.canvas, conversationId);
    if (!entry) return;
    const name = this.nameOf(entry);
    const blocked = this.permissionBlock(entry);
    if (blocked) {
      this.setReply(blocked, null);
      return;
    }
    const confirmed = await this.requestPending(
      `Send note to ${name}: “${truncate(text, 80)}”`,
      'countdown'
    );
    if (!confirmed) {
      this.setReply('Cancelled.', null);
      return;
    }
    this.setReply(
      await this.attempt(() => this.deliver(entry, text, true), this.deliveryReply(entry)),
      null
    );
  }

  // ── Fast path ──────────────────────────────────────────────────────────────

  /** Runs a grammar command. Returns false when the utterance should go to the model instead. */
  private async runGrammar(
    command: GrammarCommand,
    source: UtteranceSource,
    startedAt: number,
    route: 'grammar' | 'jev' = 'grammar'
  ): Promise<boolean> {
    const actions: ActionRecord[] = [];
    let reply = '';
    this.lastRoute = route;
    this.trace('route', undefined, {
      route,
      intent: command.kind,
      input: JSON.stringify(command).slice(0, 2000),
    });
    this.phase = 'acting';

    switch (command.kind) {
      case 'confirm': {
        if (this.plans.awaitingApproval) {
          reply = `Starting ${this.plans.plan?.subtasks.length ?? 0} agents.`;
          void this.plans.approve();
          actions.push({ tool: 'approve_plan', input: {}, outcome: 'ok' });
          break;
        }
        // "Allow it" while the focused agent waits on a permission prompt answers that prompt
        // (still behind an explicit confirmation).
        const focused = this.focusedEntry();
        if (focused && atPermissionPrompt(focused)) {
          reply = await this.answerEntryPermission(focused, 'allow', actions);
          break;
        }
        // A yes may answer the conductor's own last question; without one there is nothing to do.
        if (this.history.length > 0 && this.configured) return false;
        reply = 'Nothing is waiting for a yes.';
        break;
      }
      case 'reject':
        if (this.plans.awaitingApproval) {
          this.plans.cancel();
          reply = 'Plan discarded.';
          break;
        }
        if (this.history.length > 0 && this.configured) return false;
        // Shown, not spoken: saying "nothing to cancel" after a bare "stop" is just noise.
        this.setReply('Nothing to cancel.', null);
        this.log({ route, actions, reply: 'Nothing to cancel.', startedAt });
        return true;
      case 'next': {
        const next = this.canvas.attentionEntries[0];
        if (!next || !this.canvas.focusNextAttention()) {
          reply = 'Nobody needs you right now.';
        } else {
          const focused = this.focusedEntry() ?? next;
          reply =
            announcementText([{ ...focused, name: this.nameOf(focused) }]) ??
            `${this.nameOf(focused)} ${attentionPhrase(focused)}.`;
        }
        break;
      }
      case 'overview':
        this.canvas.requestFit();
        break;
      case 'submit': {
        const entry = this.focusedEntry();
        if (!entry) {
          reply = 'No agent is focused.';
          break;
        }
        reply = await this.attempt(() => submitAgentInput(entry), `Sent.`);
        break;
      }
      case 'mute':
        this.voice.setMuted(true);
        break;
      case 'unmute':
        this.voice.setMuted(false);
        reply = "I'm back.";
        break;
      case 'note':
        this.canvas.addNote(command.text);
        reply = 'Noted.';
        break;
      case 'focus': {
        const entry = entryForConversation(this.canvas, command.agent.id);
        if (!entry) return false;
        if (this.canvas.revealConversation(entry)) reply = `Reopened ${this.nameOf(entry)}.`;
        this.canvas.requestFocus(entry.tileId);
        break;
      }
      case 'clarify':
        reply = command.question;
        break;
      case 'help':
        reply = HELP_REPLY;
        break;
      case 'close':
        reply = this.closeCommand(command.agent, actions);
        break;
      case 'closeMany': {
        const result = await this.closeMany(command.scope, actions);
        if (result === null) return true;
        reply = result;
        break;
      }
      case 'reopen':
        reply = this.reopen(command.target, actions);
        break;
      case 'kill': {
        const entry = entryForConversation(this.canvas, command.agent.id);
        if (!entry) return false;
        reply = await this.stopEntry(entry, actions);
        break;
      }
      case 'archive': {
        const entry = entryForConversation(this.canvas, command.agent.id);
        if (!entry) return false;
        reply = await this.archiveEntry(entry, actions);
        break;
      }
      case 'permission': {
        const entry = entryForConversation(this.canvas, command.agent.id);
        if (!entry) return false;
        reply = await this.answerEntryPermission(entry, command.decision, actions);
        break;
      }
      case 'status': {
        const entry = entryForConversation(this.canvas, command.agent.id);
        if (!entry) return false;
        this.activity = `Reading ${command.agent.name}…`;
        const line = await lastMeaningfulLine(entry).catch(() => null);
        reply = `${command.agent.name} is ${spokenStatus(entry)}.${line ? ` Last line: ${truncate(line, 140)}` : ''}`;
        break;
      }
      case 'interrupt': {
        const entry = entryForConversation(this.canvas, command.agent.id);
        if (!entry) return false;
        if (!entry.sessionActive) {
          reply = `${command.agent.name} isn't running.`;
          break;
        }
        const confirmed = await this.requestPending(`Interrupt ${command.agent.name}`, 'countdown');
        if (!confirmed) {
          this.setReply('Cancelled.', null);
          return true;
        }
        reply = await this.attempt(
          () => interruptAgent(entry),
          `Interrupted ${command.agent.name}.`
        );
        actions.push({
          tool: 'interrupt_agent',
          input: { agent: command.agent.name },
          outcome: reply,
        });
        break;
      }
      case 'send': {
        const entry = entryForConversation(this.canvas, command.agent.id);
        if (!entry) return false;
        const blocked = this.permissionBlock(entry);
        if (blocked) {
          reply = blocked;
          break;
        }
        const confirmed = await this.requestPending(
          `Send to ${command.agent.name}: “${truncate(command.text, 90)}”`,
          'countdown'
        );
        if (!confirmed) {
          this.setReply('Cancelled.', null);
          return true;
        }
        reply = await this.attempt(
          () => this.deliver(entry, command.text, true),
          this.deliveryReply(entry)
        );
        actions.push({
          tool: 'send_to_agent',
          input: { agent: command.agent.name, text: command.text },
          outcome: reply,
        });
        break;
      }
    }

    for (const action of actions)
      this.trace('action-result', action.outcome, {
        tool: action.tool,
        input: JSON.stringify(action.input).slice(0, 2000),
      });
    this.setReply(reply, source);
    this.log({ route, actions, reply, startedAt });
    return true;
  }

  // ── Jev routing ────────────────────────────────────────────────────────────

  /**
   * Asks Jev what an utterance the grammar missed wants. Navigation-style intents it is confident
   * about run immediately (no Claude call); everything else goes to Claude, in plan mode when Jev
   * judges the goal needs splitting across agents.
   */
  private async routeWithJev(
    text: string,
    source: UtteranceSource,
    startedAt: number
  ): Promise<{ handled: boolean; mode?: ConductorMode }> {
    if (!this.status?.jevReady) return { handled: false };
    runInAction(() => {
      this.phase = 'thinking';
      this.activity = 'Routing…';
    });
    const roster = buildRoster(this.canvas);
    const focusedId = focusedConversationId(this.canvas);
    const focusedName = focusedId ? this.canvas.spokenName(focusedId) : null;
    // Visible agents first: Jev sees a bounded number of choices.
    const ordered = [...roster].sort(
      (a, b) => Number(a.hidden ?? false) - Number(b.hidden ?? false)
    );
    const decision = await jevDecide(routingState(text, focusedName), routingQuestions(ordered));
    if (!decision) return { handled: false };
    const routing = interpretRouting(
      decision.answers,
      this.settings?.jevConfidence ?? DEFAULT_CONDUCTOR_SETTINGS.jevConfidence
    );
    if (routing.kind === 'model') {
      this.trace('route', undefined, { route: 'jev-fallback', mode: routing.mode ?? 'command' });
      return { handled: false, mode: routing.mode };
    }

    const agent = routing.agent
      ? roster.find((candidate) => candidate.name === routing.agent)
      : undefined;
    let command: GrammarCommand | null = null;
    if (routing.intent === 'overview') command = { kind: 'overview' };
    else if (routing.intent === 'next') command = { kind: 'next' };
    else if (agent && routing.intent === 'close') command = { kind: 'close', agent };
    else if (agent) command = { kind: routing.intent, agent };
    if (!command) return { handled: false };
    const handled = await this.runGrammar(command, source, startedAt, 'jev');
    return { handled };
  }

  // ── Jev triage ─────────────────────────────────────────────────────────────

  /**
   * Rates what an agent that just started waiting needs: how risky its permission request is and
   * how urgently it needs the user. Results feed the tile pill, attention order, and announcements.
   */
  private async triage(entry: AgentTileEntry): Promise<void> {
    if (!this.status?.jevReady) return;
    const terminal = await readAgentOutput(entry, 30).catch(() => '');
    if (!terminal.trim()) return;
    const permission =
      entry.status === 'awaiting-input' && entry.notificationType === 'permission_prompt';
    const decision = await jevDecide(
      { agent: this.nameOf(entry), task: entry.taskName, terminal: terminal.slice(-6_000) },
      { ...urgencyQuestions(), ...(permission ? permissionRiskQuestions() : {}) }
    );
    if (!decision) return;
    const urgency = interpretUrgency(decision.answers);
    const risk = permission ? interpretPermissionRisk(decision.answers) : null;
    this.canvas.setInsight(entry.conversationId, {
      ...(urgency !== null ? { urgency } : {}),
      ...(risk ? { riskLevel: risk.level } : {}),
    });
  }

  // ── Model path ─────────────────────────────────────────────────────────────

  private async runModel(
    text: string,
    source: UtteranceSource,
    startedAt: number,
    modeHint?: ConductorMode
  ): Promise<void> {
    this.lastRoute = 'llm';
    this.trace('route', undefined, { route: 'llm', mode: modeHint ?? chooseMode(text) });
    if (this.status && !this.status.configured) {
      runInAction(() => {
        this.error = {
          kind: 'not-configured',
          message:
            'Add an Anthropic or OpenRouter API key in Settings → Voice & Conductor to use the conductor.',
        };
      });
      this.setReply("I didn't catch a command I know, and the conductor has no API key.", source);
      return;
    }

    this.phase = 'thinking';
    this.activity = 'Thinking…';
    const mode: ConductorMode = modeHint ?? chooseMode(text);
    const providers = await installedProviders();
    const planLine = this.plans.contextLine;
    const extra = planLine ? [planLine] : [];
    if (mode === 'plan') {
      runInAction(() => (this.activity = 'Reading the project…'));
      const pack = await this.projectContextPack();
      if (pack) extra.push(pack);
      runInAction(() => (this.activity = 'Thinking…'));
    }
    const context = buildContext(this.canvas, providers, extra);
    const messages: Anthropic.Beta.BetaMessageParam[] = [
      ...this.history,
      { role: 'user', content: conductorUserMessage(context, text) },
    ];
    const actions: ActionRecord[] = [];
    let tokens = 0;
    let reply = '';
    let completed = false;

    try {
      const client = await getConductorClient();
      for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
        runInAction(() => {
          this.phase = 'thinking';
          this.activity = iteration === 0 ? 'Thinking…' : 'Thinking about the results…';
        });
        const result = await client.runTurn({ mode, messages: pruneScreenshots(messages) });
        if (!result.success) {
          runInAction(
            () => (this.error = { kind: result.error.type, message: result.error.message })
          );
          reply = spokenError(result.error);
          break;
        }
        const turn = result.data;
        tokens += turn.usage.inputTokens + turn.usage.outputTokens;
        messages.push({
          role: 'assistant',
          content: turn.content as Anthropic.Beta.BetaContentBlockParam[],
        });
        const toolUses = turn.content.filter(
          (block): block is Anthropic.Beta.BetaToolUseBlock => block.type === 'tool_use'
        );
        const text = turn.content
          .filter((block): block is Anthropic.Beta.BetaTextBlock => block.type === 'text')
          .map((block) => block.text)
          .join(' ')
          .trim();
        if (turn.stopReason !== 'tool_use' || toolUses.length === 0) {
          reply = text || (turn.stopReason === 'max_tokens' ? 'That took too long to answer.' : '');
          completed = true;
          break;
        }
        const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
        for (const use of toolUses) {
          runInAction(() => {
            this.phase = 'acting';
            this.activity = describeTool(use.name);
          });
          this.trace('tool-start', undefined, {
            tool: use.name,
            input: JSON.stringify(use.input).slice(0, 2000),
          });
          const outcome = await this.executeTool(use.name, use.input);
          this.trace('tool-result', outcome.content, {
            tool: use.name,
            status: outcome.isError ? 'failed' : 'returned',
          });
          actions.push({
            tool: use.name,
            input: use.input,
            outcome: truncate(outcome.content, 300),
          });
          results.push({
            type: 'tool_result',
            tool_use_id: use.id,
            content: outcome.images?.length
              ? [
                  { type: 'text', text: outcome.content },
                  ...outcome.images.map((image) => ({
                    type: 'image' as const,
                    source: {
                      type: 'base64' as const,
                      media_type: image.mediaType,
                      data: image.data,
                    },
                  })),
                ]
              : outcome.content,
            ...(outcome.isError ? { is_error: true } : {}),
          });
        }
        messages.push({ role: 'user', content: results });
      }
      if (!completed && !reply) reply = 'I stopped after several steps. Check the canvas.';
    } catch (error) {
      log.error('conductor: turn failed', { error });
      runInAction(() => (this.error = { kind: 'other', message: errorMessage(error) }));
      reply = 'Something went wrong talking to the conductor.';
    }

    // Keep history only for turns that ended on an assistant message (valid to resume from).
    if (completed) this.history = trimHistory(pruneScreenshots(messages, 0));
    this.setReply(reply, source);
    this.log({ route: 'llm', actions, reply, startedAt, tokens });
  }

  private async executeTool(name: string, rawInput: unknown): Promise<ToolOutcome> {
    if (!isToolName(name)) return { content: `Unknown tool ${name}.`, isError: true };
    const parsed = conductorToolSchemas[name].safeParse(rawInput ?? {});
    if (!parsed.success) {
      return { content: `Invalid input: ${parsed.error.message}`, isError: true };
    }
    try {
      return await this.runTool(name, parsed.data as ConductorToolInput<typeof name>);
    } catch (error) {
      log.warn('conductor: tool failed', { error, tool: name });
      return { content: errorMessage(error), isError: true };
    }
  }

  private async runTool<Name extends ConductorToolName>(
    name: Name,
    input: ConductorToolInput<Name>
  ): Promise<ToolOutcome> {
    const confirmKind = CONFIRM_REQUIRED_TOOLS.has(name)
      ? 'confirm'
      : CANCEL_WINDOW_TOOLS.has(name)
        ? 'countdown'
        : null;

    switch (name) {
      case 'list_agents': {
        const providers = await installedProviders();
        return { content: buildContext(this.canvas, providers) };
      }
      case 'read_agent': {
        const { agent, lines } = input as ConductorToolInput<'read_agent'>;
        const entry = this.resolveEntry(agent);
        if ('error' in entry) return { content: entry.error, isError: true };
        const output = await readAgentOutput(entry.entry, lines ?? 40);
        const compact = output.replace(/\n{3,}/g, '\n\n').trim();
        return {
          content: `${this.nameOf(entry.entry)} is ${spokenStatus(entry.entry)}. Recent output:\n${compact.slice(-READ_AGENT_MAX_CHARS) || '(empty)'}`,
        };
      }
      case 'focus_agent': {
        const entry = this.resolveEntry((input as ConductorToolInput<'focus_agent'>).agent);
        if ('error' in entry) return { content: entry.error, isError: true };
        this.canvas.requestFocus(entry.entry.tileId);
        return { content: `Focused ${this.nameOf(entry.entry)}.` };
      }
      case 'show_all':
        this.canvas.requestFit();
        return { content: 'Showing all agents.' };
      case 'send_to_agent': {
        const { agent, text, submit } = input as ConductorToolInput<'send_to_agent'>;
        const entry = this.resolveEntry(agent);
        if ('error' in entry) return { content: entry.error, isError: true };
        const blocked = this.permissionBlock(entry.entry);
        if (blocked) return { content: blocked, isError: true };
        const target = this.nameOf(entry.entry);
        if (
          !(await this.requestPending(`Send to ${target}: “${truncate(text, 90)}”`, confirmKind))
        ) {
          return { content: 'The user cancelled this before it was sent.' };
        }
        const wasRunning = this.isRunning(entry.entry);
        await this.deliver(entry.entry, text, submit ?? true);
        return {
          content: wasRunning
            ? `Sent to ${target}.`
            : `${target} was not running; it is starting and will get the message when ready.`,
        };
      }
      case 'interrupt_agent': {
        const entry = this.resolveEntry((input as ConductorToolInput<'interrupt_agent'>).agent);
        if ('error' in entry) return { content: entry.error, isError: true };
        const target = this.nameOf(entry.entry);
        if (!entry.entry.sessionActive) {
          return { content: `${target} isn't running, so there is nothing to interrupt.` };
        }
        if (!(await this.requestPending(`Interrupt ${target}`, confirmKind))) {
          return { content: 'The user cancelled the interrupt.' };
        }
        await interruptAgent(entry.entry);
        return { content: `Interrupted ${target}.` };
      }
      case 'answer_permission': {
        const { agent, decision } = input as ConductorToolInput<'answer_permission'>;
        const entry = this.resolveEntry(agent);
        if ('error' in entry) return { content: entry.error, isError: true };
        return { content: await this.answerEntryPermission(entry.entry, decision, []) };
      }
      case 'spawn_agent': {
        const spawn = input as ConductorToolInput<'spawn_agent'>;
        const providers = await installedProviders();
        if (providers.length > 0 && !providers.some((p) => p.id === spawn.provider)) {
          return {
            content: `Provider "${spawn.provider}" is not installed. Installed: ${providers.map((p) => p.id).join(', ')}.`,
            isError: true,
          };
        }
        const projectId = resolveProjectId(spawn.project, this.focusedEntry()?.projectId);
        if (!projectId) return { content: 'No project is open.', isError: true };
        const label = `Start ${spawn.provider} on “${truncate(spawn.task_name, 60)}”`;
        if (!(await this.requestPending(label, confirmKind))) {
          return { content: 'The user cancelled the new agent.' };
        }
        runInAction(() => (this.activity = 'Creating a worktree…'));
        const conversationId = crypto.randomUUID();
        const name = this.canvas.claimSpokenName(conversationId);
        const result = await spawnAgentTask({
          projectId,
          providerId: spawn.provider,
          taskName: spawn.task_name,
          prompt: spawn.prompt,
          conversationId,
          title: name,
        }).catch((error: unknown) => {
          this.canvas.releaseSpokenName(conversationId);
          throw error;
        });
        this.disposers.push(focusSpawnedAgent(this.canvas, result.conversationId));
        const interactionId = this.interactionId;
        this.trace('action-result', undefined, { tool: 'spawn_agent', status: 'scheduled' });
        void startAgentSession(projectId, result.taskId, result.conversationId)
          .then(async (started) => {
            if (!started) {
              this.trace(
                'action-result',
                undefined,
                { tool: 'spawn_agent', status: 'failed-to-start' },
                interactionId
              );
              return;
            }
            this.trace(
              'action-result',
              undefined,
              { tool: 'spawn_agent', status: 'session-started' },
              interactionId
            );
            if (result.promptDeferred && spawn.prompt.trim()) {
              const delivered = await deliverPromptWhenReady(
                this.canvas,
                result.conversationId,
                spawn.prompt
              );
              this.trace(
                'action-result',
                undefined,
                { tool: 'spawn_agent', status: delivered ? 'prompt-accepted' : 'prompt-failed' },
                interactionId
              );
            }
          })
          .catch(() =>
            this.trace(
              'action-result',
              undefined,
              { tool: 'spawn_agent', status: 'failed-to-start' },
              interactionId
            )
          );
        return {
          content: `Created task "${spawn.task_name}" in a new worktree; the agent is starting. It will appear on the canvas as ${name}.`,
        };
      }
      case 'propose_plan': {
        const settings = this.settings;
        const plan = input as ConductorToolInput<'propose_plan'>;
        let sizes: (SubtaskSize | null)[] = [];
        if (this.status?.jevReady && plan.subtasks.length > 1) {
          runInAction(() => (this.activity = 'Reviewing the plan…'));
          const decision = await jevDecide(
            planReviewState(plan.goal, plan.subtasks),
            planReviewQuestions(plan.subtasks)
          );
          const review = decision ? interpretPlanReview(decision.answers, plan.subtasks) : null;
          if (review && !review.ok) return { content: review.reason, isError: true };
          if (decision) sizes = interpretSubtaskSizes(decision.answers, plan.subtasks.length);
        }
        const providers = await installedProviders();
        const proposal = this.plans.propose(plan, {
          providers,
          maxAgents: settings?.maxAgentsPerPlan ?? 4,
          preferredProjectId: this.focusedEntry()?.projectId,
        });
        if (!proposal.ok) return { content: proposal.reason, isError: true };
        this.plans.setSizes(sizes);
        if (settings?.autoApprovePlans) {
          void this.plans.approve();
          return {
            content: `Plan started: ${proposal.plan.subtasks.length} agents in ${proposal.plan.projectName}.`,
          };
        }
        return {
          content:
            'The plan is shown to the user for approval. Tell them briefly what it does and that they can say yes to start it.',
        };
      }
      case 'check_conflicts': {
        const { agents } = input as ConductorToolInput<'check_conflicts'>;
        const worktrees: { label: string; path: string }[] = [];
        for (const agent of agents) {
          const entry = this.resolveEntry(agent);
          if ('error' in entry) return { content: entry.error, isError: true };
          const path = getTaskStore(entry.entry.projectId, entry.entry.taskId)?.workspacePath;
          if (!path) return { content: `${agent} has no worktree yet.`, isError: true };
          worktrees.push({ label: this.nameOf(entry.entry), path });
        }
        const result = await (await getConductorClient()).checkConflicts({ worktrees });
        if (!result.success) return { content: result.error.message, isError: true };
        const conflicted = result.data.pairs.filter((pair) => pair.conflicted);
        if (conflicted.length === 0) return { content: 'All branches merge cleanly.' };
        return {
          content: conflicted
            .map((pair) => `${pair.a} and ${pair.b} conflict in ${pair.files.join(', ')}`)
            .join('\n'),
        };
      }
      case 'archive_agent': {
        const entry = this.resolveEntry((input as ConductorToolInput<'archive_agent'>).agent);
        if ('error' in entry) return { content: entry.error, isError: true };
        return { content: await this.archiveEntry(entry.entry, []) };
      }
      case 'add_note':
        this.canvas.addNote((input as ConductorToolInput<'add_note'>).text);
        return { content: 'Note added.' };
      case 'close_agent': {
        const entry = this.resolveEntry((input as ConductorToolInput<'close_agent'>).agent);
        if ('error' in entry) return { content: entry.error, isError: true };
        return { content: this.closeEntries([entry.entry]) };
      }
      case 'reopen_agent': {
        const entry = this.resolveEntry((input as ConductorToolInput<'reopen_agent'>).agent);
        if ('error' in entry) return { content: entry.error, isError: true };
        return { content: this.reopenEntries([entry.entry]) };
      }
      case 'stop_agent': {
        const entry = this.resolveEntry((input as ConductorToolInput<'stop_agent'>).agent);
        if ('error' in entry) return { content: entry.error, isError: true };
        return { content: await this.stopEntry(entry.entry, []) };
      }
      case 'start_app':
        return this.appTools().startApp(input as ConductorToolInput<'start_app'>);
      case 'show_app':
        return this.appTools().showApp(input as ConductorToolInput<'show_app'>);
      case 'look_at_app':
        return this.appTools().lookAtApp(input as ConductorToolInput<'look_at_app'>);
      case 'use_app':
        return this.appTools().useApp(input as ConductorToolInput<'use_app'>);
      case 'stop_app':
        return this.appTools().stopApp(input as ConductorToolInput<'stop_app'>);
      case 'close_app':
        return this.appTools().closeApp(input as ConductorToolInput<'close_app'>);
    }
    return { content: `Unhandled tool ${name}.`, isError: true };
  }

  // ── Windows and agent management ─────────────────────────────────────────

  /**
   * "Close" / "close Atlas". Without a name it closes what is in front of the user: the focused
   * agent's window, else a plan awaiting approval. (A pending action was already cancelled.)
   */
  private closeCommand(agent: RosterAgent | null, actions: ActionRecord[]): string {
    const entry = agent ? entryForConversation(this.canvas, agent.id) : this.focusedEntry();
    if (!entry) {
      if (this.plans.awaitingApproval) {
        this.plans.cancel();
        return 'Plan discarded.';
      }
      return 'Nothing is focused to close. Say a name, like "close Atlas".';
    }
    if (this.canvas.isOffBoard(entry)) return `${this.nameOf(entry)} is already closed.`;
    const reply = this.closeEntries([entry]);
    actions.push({ tool: 'close_agent', input: { agent: this.nameOf(entry) }, outcome: reply });
    return reply;
  }

  /** Hides windows (agents keep running) and remembers them for "reopen". */
  private closeEntries(entries: readonly AgentTileEntry[]): string {
    const open = entries.filter((entry) => !this.canvas.isOffBoard(entry));
    if (open.length === 0) return 'Already closed.';
    const ids = open.map((entry) => entry.conversationId);
    this.canvas.hideConversations(ids);
    this.lastClosed = ids;
    const names = listNames(open.map((entry) => this.nameOf(entry)));
    return `Closed ${names}. ${open.length === 1 ? 'It keeps' : 'They keep'} running; say "reopen" to bring ${open.length === 1 ? 'it' : 'them'} back.`;
  }

  /** "Close all" / "close the others" / "close the finished ones", behind a short countdown. */
  private async closeMany(scope: CloseScope, actions: ActionRecord[]): Promise<string | null> {
    const focusedId = focusedConversationId(this.canvas);
    const visible = this.canvas.visibleAgentEntries;
    const ids = closeTargets(visible, scope, focusedId);
    if (ids === null) return 'Focus the agent to keep first, then say "close the others".';
    const entries = visible.filter((entry) => ids.includes(entry.conversationId));
    if (entries.length === 0) {
      return scope === 'done' ? 'No finished agents are open.' : 'No other windows are open.';
    }
    if (entries.length > 1) {
      const label = `Close ${entries.length} windows: ${listNames(
        entries.map((entry) => this.nameOf(entry)),
        4
      )}`;
      if (!(await this.requestPending(label, 'countdown'))) {
        this.setReply('Cancelled.', null);
        return null;
      }
    }
    const reply = this.closeEntries(entries);
    actions.push({ tool: 'close_agent', input: { scope }, outcome: reply });
    return reply;
  }

  private reopen(target: RosterAgent | 'last' | 'all', actions: ActionRecord[]): string {
    let entries: AgentTileEntry[];
    if (target === 'all') {
      entries = offBoardEntries(this.canvas);
    } else if (target === 'last') {
      const ids = reopenTargets(this.canvas.state.hiddenConversationIds, this.lastClosed);
      entries = ids.flatMap((id) => entryForConversation(this.canvas, id) ?? []);
      if (entries.length === 0) {
        // Nothing hidden by hand; maybe the project filter is hiding agents.
        const filtered = offBoardEntries(this.canvas);
        if (filtered.length === 1 && filtered[0]) entries = filtered;
        else if (filtered.length > 1) {
          return `Which one: ${listNames(
            filtered.map((entry) => this.nameOf(entry)),
            4
          )}? Or say "reopen all".`;
        }
      }
    } else {
      const entry = entryForConversation(this.canvas, target.id);
      entries = entry ? [entry] : [];
    }
    if (entries.length === 0) return 'Nothing is closed.';
    const reply = this.reopenEntries(entries);
    actions.push({
      tool: 'reopen_agent',
      input: { target: typeof target === 'string' ? target : target.name },
      outcome: reply,
    });
    return reply;
  }

  /** Puts agents back on the board and brings them into view. */
  private reopenEntries(entries: readonly AgentTileEntry[]): string {
    const revealed = entries.filter((entry) => this.canvas.revealConversation(entry));
    this.lastClosed = this.lastClosed.filter(
      (id) => !revealed.some((entry) => entry.conversationId === id)
    );
    const [only] = entries;
    if (entries.length === 1 && only) this.canvas.requestFocus(only.tileId);
    else this.canvas.requestFit(entries.map((entry) => entry.tileId));
    if (revealed.length === 0) {
      return entries.length === 1 && only
        ? `${this.nameOf(only)} is already open.`
        : 'They are already open.';
    }
    return `Reopened ${listNames(revealed.map((entry) => this.nameOf(entry)))}.`;
  }

  /** Ends an agent's session after an explicit confirmation. */
  private async stopEntry(entry: AgentTileEntry, actions: ActionRecord[]): Promise<string> {
    const target = this.nameOf(entry);
    if (!entry.sessionActive) return `${target} isn't running.`;
    const label = `Stop ${target}'s session (the conversation is kept and can be resumed)`;
    if (!(await this.requestPending(label, 'confirm')))
      return 'Not confirmed, so nothing was stopped.';
    const reply = await this.attempt(() => stopAgentSession(entry), `Stopped ${target}.`);
    actions.push({ tool: 'stop_agent', input: { agent: target }, outcome: reply });
    return reply;
  }

  /** Archives an agent's task after an explicit confirmation. */
  private async archiveEntry(entry: AgentTileEntry, actions: ActionRecord[]): Promise<string> {
    const target = this.nameOf(entry);
    const label = `Archive ${target} (task "${truncate(entry.taskName, 40)}"; the branch is kept)`;
    if (!(await this.requestPending(label, 'confirm'))) {
      return 'Not confirmed, so nothing was archived.';
    }
    const manager = getTaskManagerStore(entry.projectId);
    if (!manager) return 'That project is not open.';
    const reply = await this.attempt(
      () => manager.archiveTask(entry.taskId),
      `Archived ${target}'s task. Its branch and worktree are kept.`
    );
    actions.push({ tool: 'archive_agent', input: { agent: target }, outcome: reply });
    return reply;
  }

  /** Answers a permission prompt after an explicit confirmation that names the risk. */
  private async answerEntryPermission(
    entry: AgentTileEntry,
    decision: 'allow' | 'deny',
    actions: ActionRecord[]
  ): Promise<string> {
    const target = this.nameOf(entry);
    if (entry.status !== 'awaiting-input') return `${target} is not waiting on a prompt.`;
    if (entry.type === 'acp') return `Answer ${target}'s request in its window.`;
    const riskLevel = this.canvas.insight(entry.conversationId)?.riskLevel;
    const riskNote =
      decision === 'allow' && (riskLevel === 'high' || riskLevel === 'elevated')
        ? ` (${riskLevel === 'high' ? 'high risk' : 'has side effects'})`
        : '';
    const label = `${decision === 'allow' ? 'Allow' : 'Deny'} ${target}'s permission request${riskNote}`;
    if (!(await this.requestPending(label, 'confirm'))) {
      return 'Not confirmed, so nothing was sent.';
    }
    const reply = await this.attempt(
      () => answerPermission(entry, decision),
      `${decision === 'allow' ? 'Allowed' : 'Denied'} for ${target}.`
    );
    actions.push({ tool: 'answer_permission', input: { agent: target, decision }, outcome: reply });
    return reply;
  }

  /** Why text must not be typed into this agent right now, or null when it is safe. */
  private permissionBlock(entry: AgentTileEntry): string | null {
    if (!atPermissionPrompt(entry)) return null;
    const name = this.nameOf(entry);
    return `${name} is waiting on a permission prompt, and typing there could answer it. Say "allow ${name}" or "deny ${name}" first.`;
  }

  // ── Pending actions ────────────────────────────────────────────────────────

  /** Shows a cancellable (or confirmable) action and resolves whether it should run. */
  requestPending(label: string, kind: 'countdown' | 'confirm' | null): Promise<boolean> {
    if (!kind) return Promise.resolve(true);
    this.settlePending(false);
    const durationMs = kind === 'countdown' ? CANCEL_WINDOW_MS : CONFIRM_TIMEOUT_MS;
    this.pending = { id: ++this.pendingSeq, label, kind, startedAt: Date.now(), durationMs };
    this.trace('confirmation', undefined, { status: 'waiting', kind });
    return new Promise<boolean>((resolve) => {
      this.pendingResolve = resolve;
      this.pendingTimer = setTimeout(() => this.settlePending(kind === 'countdown'), durationMs);
    });
  }

  confirmPending(): void {
    this.settlePending(true);
  }

  cancelPending(): void {
    this.settlePending(false);
  }

  private settlePending(confirmed: boolean): void {
    if (this.pendingTimer) clearTimeout(this.pendingTimer);
    this.pendingTimer = null;
    const resolve = this.pendingResolve;
    this.pendingResolve = null;
    this.pending = null;
    if (resolve)
      this.trace('confirmation', undefined, { status: confirmed ? 'confirmed' : 'cancelled' });
    resolve?.(confirmed);
  }

  // ── Announcements ──────────────────────────────────────────────────────────

  private queueAnnouncements(entries: AgentTileEntry[]): void {
    this.announceQueue.push(...entries);
    if (this.announceTimer) return;
    this.announceTimer = setTimeout(() => {
      this.announceTimer = null;
      const batch = this.announceQueue.splice(0);
      const unique = [...new Map(batch.map((entry) => [entry.tileId, entry])).values()];
      const text = announcementText(
        unique.map((entry) => ({
          name: this.nameOf(entry),
          status: entry.status,
          notificationType: entry.notificationType,
          taskName: entry.taskName,
          completionSummary: entry.completionSummary,
          riskLevel: this.canvas.insight(entry.conversationId)?.riskLevel,
        }))
      );
      if (text) this.voice.announce(text);
    }, ANNOUNCE_BATCH_MS);
  }

  private notify(text: string): void {
    runInAction(() => {
      this.reply = text;
      this.replyAt = Date.now();
    });
    this.voice.announce(text);
  }

  // ── Settings ───────────────────────────────────────────────────────────────

  async refreshStatus(): Promise<void> {
    try {
      const status = await (await getConductorClient()).getStatus();
      runInAction(() => (this.status = status));
    } catch (error) {
      log.warn('conductor: status unavailable', { error });
    }
  }

  async updateSettings(patch: Partial<ConductorSettings>): Promise<void> {
    const status = await (await getConductorClient()).updateSettings(patch);
    runInAction(() => (this.status = status));
  }

  async recentTrace(limit = 200): Promise<TraceEvent[]> {
    await this.traceWrites;
    return (await getConductorClient()).readTrace({ limit });
  }

  clearHistory(): void {
    this.history = [];
    this.reply = '';
    this.error = null;
  }

  dismissError(): void {
    this.error = null;
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private focusedEntry(): AgentTileEntry | undefined {
    const id = focusedConversationId(this.canvas);
    return id ? entryForConversation(this.canvas, id) : undefined;
  }

  private appTools(): ConductorAppTools {
    this.appToolsInstance ??= new ConductorAppTools({
      canvas: this.canvas,
      host: getCanvasBrowserHost(),
      requestPending: (label, kind) => this.requestPending(label, kind),
      resolveTask: (agent) => this.resolveAppTask(agent),
    });
    return this.appToolsInstance;
  }

  /** An app tool's task: a named agent's, else the focused app browser's or agent's. */
  private resolveAppTask(agent: string | undefined): { task: AppTask } | { error: string } {
    if (agent) {
      const resolved = this.resolveEntry(agent);
      if ('error' in resolved) return resolved;
      const { entry } = resolved;
      if (!entry.workspaceId)
        return { error: `${this.nameOf(entry)}'s task has no workspace yet.` };
      return {
        task: {
          taskId: entry.taskId,
          projectId: entry.projectId,
          workspaceId: entry.workspaceId,
          name: this.nameOf(entry),
        },
      };
    }
    const focusedTile = this.canvas.focusedTileId;
    const browser = focusedTile
      ? this.canvas.browserEntries.find((candidate) => candidate.tileId === focusedTile)
      : undefined;
    if (browser) {
      return {
        task: {
          taskId: browser.taskId,
          projectId: browser.projectId,
          workspaceId: browser.workspaceId,
          name: browser.taskName,
        },
      };
    }
    const entry = this.focusedEntry();
    if (entry) return this.resolveAppTask(this.nameOf(entry));
    const only = this.canvas.browserEntries;
    if (only.length === 1 && only[0]) {
      return {
        task: {
          taskId: only[0].taskId,
          projectId: only[0].projectId,
          workspaceId: only[0].workspaceId,
          name: only[0].taskName,
        },
      };
    }
    return { error: "Which agent's app? Nothing is focused; name an agent." };
  }

  private nameOf(entry: AgentTileEntry): string {
    return this.canvas.spokenName(entry.conversationId);
  }

  private resolveEntry(reference: string): { entry: AgentTileEntry } | { error: string } {
    const roster = buildRoster(this.canvas);
    const resolution = resolveAgent(reference, roster, focusedConversationId(this.canvas));
    if (resolution.kind === 'ambiguous') {
      return {
        error: `"${reference}" is ambiguous: ${resolution.candidates.map((agent) => agent.name).join(', ')}. Ask the user which one.`,
      };
    }
    if (resolution.kind === 'none') {
      return {
        error: `No agent called "${reference}". Agents: ${roster.map((a) => a.name).join(', ') || 'none'}.`,
      };
    }
    const entry = entryForConversation(this.canvas, resolution.agent.id);
    return entry ? { entry } : { error: `${resolution.agent.name} is no longer on the canvas.` };
  }

  /** Layout, scripts, and hot spots of the project a plan would target (local projects only). */
  private async projectContextPack(): Promise<string | null> {
    const projectId = resolveProjectId(undefined, this.focusedEntry()?.projectId);
    if (!projectId) return null;
    const project = getProjectManagerStore().projects.get(projectId);
    const data = project?.data;
    if (!data || data.type !== 'local') return null;
    try {
      const { text } = await (await getConductorClient()).projectContext({ path: data.path });
      return text ? `Project "${project.name ?? ''}" at a glance:\n${text}` : null;
    } catch {
      return null;
    }
  }

  private isRunning(entry: AgentTileEntry): boolean {
    return entry.type === 'acp' || entry.sessionActive;
  }

  private deliveryReply(entry: AgentTileEntry): string {
    const name = this.nameOf(entry);
    return this.isRunning(entry)
      ? `Sent to ${name}.`
      : `Starting ${name}; it gets the message when it is ready.`;
  }

  /** Sends text to an agent, starting (or resuming) it first when its terminal is not running. */
  private async deliver(entry: AgentTileEntry, text: string, submit: boolean): Promise<void> {
    if (this.isRunning(entry)) {
      await sendToAgent(entry, text, submit);
      this.trace('action-result', undefined, { tool: 'send_to_agent', status: 'accepted' });
      return;
    }
    const started = await startAgentSession(entry.projectId, entry.taskId, entry.conversationId);
    if (!started) throw new Error(`${this.nameOf(entry)} could not be started.`);
    const interactionId = this.interactionId;
    this.trace('action-result', undefined, { tool: 'send_to_agent', status: 'scheduled' });
    void deliverPromptWhenReady(this.canvas, entry.conversationId, text, submit)
      .then((delivered) =>
        this.trace(
          'action-result',
          undefined,
          { tool: 'send_to_agent', status: delivered ? 'accepted' : 'failed' },
          interactionId
        )
      )
      .catch(() =>
        this.trace(
          'action-result',
          undefined,
          { tool: 'send_to_agent', status: 'failed' },
          interactionId
        )
      );
  }

  private async attempt(run: () => Promise<void>, success: string): Promise<string> {
    try {
      await run();
      return success;
    } catch (error) {
      return errorMessage(error);
    }
  }

  private setReply(text: string, source: UtteranceSource | null, id = this.interactionId): void {
    runInAction(() => {
      this.reply = text;
      this.replyAt = Date.now();
    });
    if (text) this.trace('reply', text, { surface: 'hud', source: source ?? 'silent' }, id);
    if (text && source === 'voice') this.voice.say(text, id ?? undefined);
  }

  private writeTrace(event: TraceEvent): void {
    this.traceWrites = this.traceWrites
      .then(async () => {
        await (await getConductorClient()).appendTrace(event);
      })
      .catch((error: unknown) => log.warn('conductor: trace write failed', { error }));
  }

  private trace(
    kind: TraceEvent['kind'],
    text?: string,
    detail?: TraceEvent['detail'],
    id = this.interactionId
  ): void {
    if (!id) return;
    this.writeTrace({
      interactionId: id,
      at: new Date().toISOString(),
      kind,
      ...(text !== undefined ? { text: text.slice(0, 4000) } : {}),
      ...(detail ? { detail } : {}),
    });
  }

  private log(entry: {
    route: ConductorTurnRecord['route'];
    actions: ActionRecord[];
    reply: string;
    startedAt: number;
    tokens?: number;
  }): void {
    const record: ConductorTurnRecord = {
      at: new Date().toISOString(),
      utterance: this.lastUtterance,
      route: entry.route,
      actions: entry.actions,
      reply: entry.reply,
      latencyMs: Math.round(performance.now() - entry.startedAt),
      ...(entry.tokens ? { tokens: entry.tokens } : {}),
    };
    void getConductorClient()
      .then((client) => client.appendLog(record))
      .then(() => runInAction(() => this.logVersion++))
      .catch((error: unknown) => log.warn('conductor: log write failed', { error }));
    if (entry.route === 'llm') void this.refreshStatus();
  }
}

function isToolName(name: string): name is ConductorToolName {
  return (conductorToolNames as string[]).includes(name);
}

function spokenStatus(entry: AgentTileEntry): string {
  if (entry.type === 'pty' && !entry.sessionActive) return 'not running';
  switch (entry.status) {
    case 'awaiting-input':
      return entry.notificationType === 'permission_prompt'
        ? 'waiting on a permission prompt'
        : 'waiting for you';
    case 'working':
      return 'working';
    case 'completed':
      return 'done';
    case 'error':
      return 'stopped with an error';
    default:
      return 'idle';
  }
}

function describeTool(name: string): string {
  switch (name) {
    case 'read_agent':
      return 'Reading agent output…';
    case 'send_to_agent':
      return 'Sending…';
    case 'spawn_agent':
      return 'Starting an agent…';
    case 'propose_plan':
      return 'Drafting a plan…';
    case 'check_conflicts':
      return 'Checking for conflicts…';
    case 'start_app':
      return 'Starting the app…';
    case 'show_app':
      return 'Opening the app…';
    case 'look_at_app':
      return 'Looking at the app…';
    case 'use_app':
      return 'Using the app…';
    case 'stop_app':
      return 'Stopping the app…';
    case 'close_app':
      return 'Closing the app…';
    default:
      return 'Working…';
  }
}

function spokenError(error: ConductorError): string {
  switch (error.type) {
    case 'not-configured':
      return 'The conductor needs an Anthropic or OpenRouter API key.';
    case 'budget-exceeded':
      return "Today's conductor token budget is used up.";
    case 'rate-limited':
      return 'The conductor is rate limited. Try again in a moment.';
    case 'refused':
      return "I can't help with that one.";
    default:
      return 'The conductor hit an API error.';
  }
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
