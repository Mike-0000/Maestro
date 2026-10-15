import type { AgentTileEntry } from '@core/features/canvas/api/browser/stores/canvas-store';
import type { CompletionReport } from '@core/primitives/agents/api/completion-report';
import { log } from '@core/primitives/logging/browser/logger';
import {
  plainText,
  relayedReplyText,
  REQUEST_TURN_ANSWER_CHARS,
  REQUEST_TURN_NOTE_CHARS,
  deniedContextLines,
  requestContextLines,
  requestReplyText,
  validateAgentRequest,
  type AgentRequest,
  type AgentRequestAck,
  type OpenRequestView,
  type RequestAction,
  type RequestOutcome,
  type RequestSender,
  type ValidAgentRequest,
} from '../api/agent-requests';
import type { ToolOutcome } from '../api/tools';

/** Who a spoken sentence is about, and what it asks of the developer, if anything. */
export type RequestSayContext = {
  readonly conversationId: string;
  readonly requestId: string;
  /** `question`: the agent asked the developer. `request`: a yes or no. `report`: nothing. */
  readonly asks: 'question' | 'request' | 'report';
};

/** What the request desk needs from the conductor (kept structural so it tests without one). */
export interface AgentRequestHost {
  /** Whether the developer lets agents send requests at all. */
  enabled(): boolean;
  entryFor(conversationId: string): AgentTileEntry | undefined;
  sender(entry: AgentTileEntry): RequestSender;
  /** The agent on the canvas with exactly this Maestro name, whatever its case. */
  agentNamed(name: string): AgentTileEntry | undefined;
  /** The Maestro names of the agents on the canvas. */
  agentNames(): string[];
  installedProviders(): Promise<readonly { id: string; name: string }[]>;
  /** True when the conductor can take a model turn now: idle, nothing pending or queued. */
  free(): boolean;
  /** Whether a model is configured to decide requests. */
  canDecide(): boolean;
  /**
   * One fenced model turn over a request. The model settles it through `answer` or leaves it
   * open for the developer; resolves its closing sentence, or '' when it had none.
   */
  decide(open: OpenRequestView): Promise<string>;
  /**
   * Runs one conductor tool exactly as given, in the asking
   * agent's project and aimed at the agent the request named.
   */
  act(
    action: RequestAction,
    context: { from: AgentTileEntry; targetId?: string }
  ): Promise<ToolOutcome>;
  /** Says a sentence to the developer (and shows it). */
  /**
   * `about` names the agent and request a sentence is about, when it is about exactly one: the
   * conductor can then deliver it as that agent's call, and bind the developer's answer to it.
   */
  say(text: string, about?: RequestSayContext): void;
  /** Types text into a running agent's terminal, once that is safe. */
  send(conversationId: string, text: string): Promise<void>;
  /** Writes one line of what happened to the conductor's turn log. */
  record(entry: { said: string; tool: string; outcome: string; reply: string }): void;
}

type OpenRequest = {
  readonly valid: ValidAgentRequest;
  readonly at: number;
  /** The agent the request names, resolved by exact name when it was accepted. */
  readonly targetId?: string;
  state: 'queued' | 'deciding' | 'awaiting-developer';
  timer: ReturnType<typeof setTimeout> | null;
  /** The sentence that put it to the developer, and when. */
  asked: { readonly sentence: string; readonly at: number } | null;
  /** How it ended, for the developer, when the model that settled it said nothing. */
  verdict: string;
};

type Watch = { readonly requestId: string; readonly requesterId: string; readonly at: number };

/** Open requests one agent may have at a time. */
export const MAX_OPEN_REQUESTS_PER_AGENT = 3;
/** Requests one agent may send inside the window below, whatever becomes of them. */
export const MAX_REQUESTS_PER_WINDOW = 8;
const RATE_WINDOW_MS = 10 * 60_000;
/** How long an open request waits before the agent is told to carry on. */
export const DEVELOPER_ANSWER_MS = 10 * 60_000;
/** A bare yes or no counts only for a question the developer has had this long to take in. */
export const HEARD_MS = 2_000;
/** How long an agent's work for another agent may take before its reply is no longer passed on. */
export const WATCH_MS = 2 * 60 * 60_000;
/** How long an unanswered question is still worth telling the developer about. */
const MISSED_QUESTION_MS = 24 * 60 * 60_000;
const MAX_MISSED_QUESTIONS = 6;
const MAX_WATCHED_AGENTS = 50;
/** How long the developer may still overrule a denied request by approving it. */
export const OVERRULE_MS = 15 * 60_000;
const MAX_DENIED = 20;
const MAX_WATCHES_PER_AGENT = 4;

const ACCEPTED_TAIL =
  'The answer will arrive in this conversation as a message starting with "[Maestro reply". Finish what you can and end your turn; do not poll.';

const refuse = (message: string): AgentRequestAck => ({ accepted: false, message });

/**
 * True when text typed into this agent would land on a prompt that waits for the developer (a
 * permission request or a dialog), where it could be read as their answer.
 */
export function atBlockingPrompt(
  agent: Pick<AgentTileEntry, 'type' | 'status' | 'notificationType'>
): boolean {
  return (
    agent.type === 'pty' &&
    agent.status === 'awaiting-input' &&
    (agent.notificationType === 'permission_prompt' ||
      agent.notificationType === 'elicitation_dialog')
  );
}

/**
 * The agents that just finished a turn: completed now, and seen in another state before. An
 * agent that shows up already completed (a reopened window, a reload) finished nothing new.
 */
export function newlyCompleted(
  previous: ReadonlyMap<string, string>,
  current: readonly (readonly [conversationId: string, status: string])[]
): string[] {
  return current.flatMap(([conversationId, status]) => {
    const before = previous.get(conversationId);
    return status === 'completed' && before !== undefined && before !== 'completed'
      ? [conversationId]
      : [];
  });
}

/**
 * Holds the requests agents sent the conductor until they are settled. Every request is checked
 * and accepted or refused the moment it arrives; what happens next depends on who decides its
 * kind. A report is spoken and closed. A question for the developer is spoken and waits for them.
 * Anything the conductor may decide gets one model turn when the conductor is free, and that turn
 * settles it: the developer is not asked, because they are often away. Only when no model is
 * configured does such a request wait for the developer. Whatever the ending, the asking agent
 * gets one reply typed into its terminal.
 */
export class AgentRequestDesk {
  private readonly open = new Map<string, OpenRequest>();
  /** Agents whose next final reply goes back to the agents that asked for their work. */
  private readonly watches = new Map<string, Watch[]>();
  /** When each agent's recent requests arrived, accepted or not. */
  private readonly attempts = new Map<string, number[]>();
  /** Requests past the limits whose verdict is still on its way to the agent. */
  private readonly admitting = new Map<string, number>();
  private draining = false;
  /** What agents asked the developer that ran out unanswered, newest per agent, for their return. */
  private readonly missed = new Map<string, { readonly sentence: string; readonly at: number }>();
  /** The request a model turn is deciding right now; that turn may settle no other. */
  private decidingId: string | null = null;
  /**
   * Requests denied lately, by id: the developer may still overrule a denial ("approve it after
   * all"), which once could not be undone at all.
   */
  private readonly denied = new Map<string, { readonly open: OpenRequest; readonly at: number }>();

  constructor(
    private readonly host: AgentRequestHost,
    private readonly now: () => number = () => Date.now()
  ) {}

  /** True while a request waits for the developer's answer or yes/no. */
  get awaitingDeveloper(): boolean {
    return [...this.open.values()].some((request) => request.state === 'awaiting-developer');
  }

  /** True while request `id` waits for the developer. */
  awaiting(id: string): boolean {
    return this.find(id)?.state === 'awaiting-developer';
  }

  /**
   * The developer's own answer to one named request: they picked up its call, so there is no
   * guessing which request a yes, a no, or their words are for.
   */
  answerAs(
    id: string,
    decision: 'approve' | 'deny' | 'answer',
    words?: string
  ): Promise<{ outcome: ToolOutcome; spoken: string }> {
    return this.resolve(id, decision, words, false);
  }

  /**
   * Checks a request and tells the asking agent's tool call the verdict through `acknowledge`.
   * An accepted request is taken on only when that verdict was delivered: a tool call that
   * stopped waiting told its agent nothing happened.
   */
  async receive(
    request: AgentRequest,
    acknowledge: (ack: AgentRequestAck) => Promise<boolean>
  ): Promise<void> {
    // Nothing is awaited before the limits are counted, so requests sent at once cannot all
    // slip under them.
    const admitted = this.admit(request);
    if ('ack' in admitted) {
      await acknowledge(admitted.ack).catch(() => false);
      return;
    }
    const { valid, targetId } = admitted;
    const from = request.from.conversationId;
    try {
      const unavailable = await this.missingProvider(valid);
      const ack = unavailable ? refuse(unavailable) : { accepted: true, message: accepted(valid) };
      const delivered = await acknowledge(ack).catch(() => false);
      if (delivered && ack.accepted) this.accept(valid, targetId);
    } finally {
      const left = (this.admitting.get(from) ?? 1) - 1;
      if (left > 0) this.admitting.set(from, left);
      else this.admitting.delete(from);
    }
  }

  private admit(
    request: AgentRequest
  ): { ack: AgentRequestAck } | { valid: ValidAgentRequest; targetId?: string } {
    if (!this.host.enabled()) {
      return {
        ack: refuse(
          'Requests from agents are turned off in Maestro (Settings, Voice and Conductor).'
        ),
      };
    }
    const validated = validateAgentRequest(request);
    if (!validated.ok) return { ack: refuse(validated.error) };
    const valid = validated.value;
    const from = request.from.conversationId;
    if (!this.host.entryFor(from)) {
      return {
        ack: refuse(
          'Maestro does not show this conversation on its canvas, so the conductor cannot answer it.'
        ),
      };
    }
    if (this.open.has(request.id)) {
      return { ack: refuse(`Request ${request.id} is already open.`) };
    }
    const named = valid.spec.target?.(valid.payload);
    const target = named ? this.host.agentNamed(named) : undefined;
    if (named && !target) {
      const names = this.host.agentNames();
      return {
        ack: refuse(
          `No agent named "${named}" is on the canvas. ${names.length > 0 ? `Agents: ${names.join(', ')}.` : 'There are no other agents.'}`
        ),
      };
    }
    if (target?.conversationId === from) {
      return { ack: refuse(`"${named}" is you. Name another agent.`) };
    }
    const mine = [...this.open.values()].filter(
      (other) => other.valid.request.from.conversationId === from
    );
    const pending = this.admitting.get(from) ?? 0;
    if (valid.spec.decidedBy !== 'nobody' && mine.length + pending >= MAX_OPEN_REQUESTS_PER_AGENT) {
      return {
        ack: refuse(
          `You already have ${mine.length + pending} open requests${mine.length > 0 ? ` (${mine.map((other) => other.valid.request.id).join(', ')})` : ''}. Wait for their answers.`
        ),
      };
    }
    const cutoff = this.now() - RATE_WINDOW_MS;
    const recent = (this.attempts.get(from) ?? []).filter((at) => at > cutoff);
    if (recent.length >= MAX_REQUESTS_PER_WINDOW) {
      this.attempts.set(from, recent);
      return {
        ack: refuse('Too many requests in a short time. Wait a few minutes before asking again.'),
      };
    }
    this.attempts.set(from, [...recent, this.now()]);
    this.admitting.set(from, pending + 1);
    return { valid, ...(target ? { targetId: target.conversationId } : {}) };
  }

  /** Why the provider a request needs cannot be used, or null. */
  private async missingProvider(valid: ValidAgentRequest): Promise<string | null> {
    const provider = valid.spec.provider?.(valid.payload).toLowerCase();
    if (!provider) return null;
    const installed = await this.host.installedProviders().catch(() => []);
    // An empty list means detection failed, not that nothing is installed.
    if (installed.length === 0 || installed.some((candidate) => candidate.id === provider)) {
      return null;
    }
    return `Provider "${provider}" is not installed. Installed: ${installed.map((candidate) => `${candidate.id} (${candidate.name})`).join(', ')}.`;
  }

  private accept(valid: ValidAgentRequest, targetId?: string): void {
    const { request, spec } = valid;
    const entry = this.host.entryFor(request.from.conversationId);
    if (!entry) return;
    const sender = this.host.sender(entry);
    const said = `[request ${request.id}] ${sender.name}: ${request.kind}`;
    if (spec.decidedBy === 'nobody') {
      const spoken = spec.spoken(sender.name, valid.payload);
      this.host.say(spoken, {
        conversationId: request.from.conversationId,
        requestId: request.id,
        asks: 'report',
      });
      this.host.record({ said, tool: 'agent_request', outcome: 'spoken', reply: spoken });
      return;
    }
    const open: OpenRequest = {
      valid,
      at: this.now(),
      ...(targetId ? { targetId } : {}),
      state: 'queued',
      timer: null,
      asked: null,
      verdict: '',
    };
    this.open.set(request.id, open);
    this.arm(open);
    if (spec.decidedBy === 'developer') {
      const spoken = spec.spoken(sender.name, valid.payload);
      this.ask(open, spoken);
      this.host.record({
        said,
        tool: 'agent_request',
        outcome: 'asked the developer',
        reply: spoken,
      });
      return;
    }
    void this.drain();
  }

  /** Decides queued requests one at a time while the conductor is free. */
  async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      if (!this.host.enabled()) this.closeAll();
      for (;;) {
        const next = [...this.open.values()].find((request) => request.state === 'queued');
        if (!next || !this.host.free()) return;
        await this.decide(next);
      }
    } finally {
      this.draining = false;
    }
  }

  private async decide(open: OpenRequest): Promise<void> {
    const view = this.view(open);
    if (!view) {
      this.close(open);
      return;
    }
    let closing = '';
    if (this.host.canDecide()) {
      open.state = 'deciding';
      this.decidingId = view.id;
      closing = await this.host
        .decide(view)
        .catch((error: unknown) => {
          log.warn('conductor: deciding an agent request failed', { error, id: view.id });
          return '';
        })
        .finally(() => (this.decidingId = null));
    }
    if (this.open.get(view.id) !== open) {
      // Settled in the turn: the model's sentence says how, or the fixed one does.
      this.host.say(closing || `${view.spoken} ${open.verdict}`.trim());
      return;
    }
    if (!this.host.canDecide()) {
      // No model to decide it, so only the developer can.
      this.ask(
        open,
        open.valid.spec.action
          ? `${view.spoken} Say yes to allow it, or no.`
          : `${view.spoken} What should I tell it?`
      );
      return;
    }
    // The turn failed or ended without a decision. The developer may be away, so the agent is
    // not left waiting for them: it is told nothing was done and carries on.
    this.settle(open, { status: 'undecided' });
    this.host.say(`${view.spoken} I could not decide it, so nothing was done.`);
  }

  /**
   * Settles an open request for the conductor's `answer_request` tool. Approving runs the kind's
   * action exactly as the agent asked for it. `inRequestTurn` says the call comes from the model
   * turn that is deciding a request, which may settle only that one.
   */
  async answer(
    id: string,
    decision: 'approve' | 'deny' | 'answer',
    message: string | undefined,
    inRequestTurn: boolean
  ): Promise<ToolOutcome> {
    return (await this.resolve(id, decision, message, inRequestTurn)).outcome;
  }

  /**
   * A spoken yes or no with nothing else pending. It settles a request only when the request's
   * question is the last thing the conductor said and has stood long enough to be heard; a yes
   * meant for something else must never answer an agent. Null when it does not apply; otherwise
   * what to say back.
   */
  async answerLatest(
    decision: 'approve' | 'deny',
    words: string,
    lastReply: string,
    /** When the developer began to say the words; they are an answer only if that was after. */
    saidAt: number = this.now()
  ): Promise<{ outcome: ToolOutcome; spoken: string } | null> {
    const latest = [...this.open.values()]
      .filter((request) => request.state === 'awaiting-developer' && request.asked)
      .sort((a, b) => (a.asked?.at ?? 0) - (b.asked?.at ?? 0))
      .at(-1);
    if (!latest?.asked) return null;
    const said = Math.min(saidAt, this.now());
    if (latest.asked.sentence !== lastReply || said - latest.asked.at < HEARD_MS) {
      return null;
    }
    const question = !latest.valid.spec.action;
    return this.resolve(
      latest.valid.request.id,
      question ? 'answer' : decision,
      question ? words : undefined,
      false
    );
  }

  private async resolve(
    id: string,
    decision: 'approve' | 'deny' | 'answer',
    message: string | undefined,
    inRequestTurn: boolean
  ): Promise<{ outcome: ToolOutcome; spoken: string }> {
    const refused = (content: string) => ({
      outcome: { content, isError: true },
      spoken: content,
    });
    const overruled = !inRequestTurn && decision === 'approve' ? this.reopenDenied(id) : null;
    if (overruled) {
      const words = plainText(message ?? '').trim();
      return this.resolve(
        overruled,
        'approve',
        words || 'The developer overruled the earlier denial: go ahead.',
        false
      );
    }
    const open = this.find(id);
    if (!open) {
      const ids = [...this.open.keys()];
      return refused(
        `No open request "${id}". ${ids.length > 0 ? `Open: ${ids.join(', ')}.` : 'No requests are open.'}`
      );
    }
    const { request, spec, payload } = open.valid;
    if (inRequestTurn && request.id !== this.decidingId) {
      return refused(
        `Only ${this.decidingId ?? 'the request being decided'} can be settled in this turn; ${request.id} waits for the developer.`
      );
    }
    if (!inRequestTurn && open.state !== 'awaiting-developer') {
      return refused(`${request.id} has not been put to the developer yet.`);
    }
    const entry = this.host.entryFor(request.from.conversationId);
    if (!entry) {
      this.close(open);
      return refused('The agent that asked is no longer on the canvas.');
    }
    const sender = this.host.sender(entry);
    const by = inRequestTurn ? 'conductor' : 'developer';
    const words = plainText(message ?? '').trim();
    const asksConductor = spec.decidedBy === 'conductor' && !spec.action;
    // A model deciding on agent output gets one short line to the agent, not a channel; a
    // question put to it gets room for an answer the agent can act on.
    const note = inRequestTurn
      ? words.slice(0, asksConductor ? REQUEST_TURN_ANSWER_CHARS : REQUEST_TURN_NOTE_CHARS)
      : words;

    if (asksConductor) {
      if (!note) {
        return refused(`${request.id} is a question: use answer, with the answer as message.`);
      }
      open.verdict = 'I answered it.';
      this.settle(open, { status: 'answered', by, detail: note });
      return {
        outcome: { content: `Passed the answer to ${sender.name}.` },
        spoken: `Told ${sender.name}.`,
      };
    }
    if (spec.decidedBy === 'developer') {
      if (decision !== 'answer' || !note) {
        return refused(
          `${request.id} is a question for the developer: use answer, with their own words.`
        );
      }
      this.settle(open, { status: 'answered', detail: note });
      return {
        outcome: { content: `Passed the developer's answer to ${sender.name}.` },
        spoken: `Told ${sender.name}.`,
      };
    }
    if (decision === 'answer') {
      return refused(`${request.id} is a ${request.kind} request: approve or deny it.`);
    }
    if (decision === 'deny') {
      open.verdict = 'I said no.';
      this.settle(open, { status: 'denied', by, detail: note });
      this.rememberDenied(open);
      return {
        outcome: { content: `Denied ${request.id}; ${sender.name} is being told.` },
        spoken: `Told ${sender.name} no.`,
      };
    }
    const target = open.targetId ? this.host.entryFor(open.targetId) : undefined;
    if (open.targetId && !target) {
      open.verdict = 'The agent it named is gone.';
      this.settle(open, { status: 'failed', detail: 'The agent you named is no longer there.' });
      return refused('The agent the request named is no longer on the canvas.');
    }
    const action = spec.action?.(payload, {
      sender,
      id: request.id,
      ...(target ? { target: this.host.sender(target).name } : {}),
    });
    if (!action) {
      open.verdict = 'I approved it.';
      this.settle(open, { status: 'approved', by, detail: note });
      return {
        outcome: { content: `Approved ${request.id}; ${sender.name} is being told.` },
        spoken: `Told ${sender.name} yes.`,
      };
    }
    // Off the open list first: a second answer while the action runs must not run it twice.
    this.close(open);
    const result = await this.host
      .act(action, { from: entry, ...(open.targetId ? { targetId: open.targetId } : {}) })
      .catch(
        (error: unknown): ToolOutcome => ({
          content: error instanceof Error ? error.message : String(error),
          isError: true,
        })
      );
    if (result.cancelled) {
      open.verdict = 'It was cancelled.';
      this.reply(open, { status: 'cancelled' });
      return {
        outcome: {
          content: `The developer cancelled it; ${sender.name} is being told.`,
          cancelled: true,
        },
        spoken: `Cancelled. ${sender.name} is being told.`,
      };
    }
    if (result.isError) {
      open.verdict = 'I approved it, but it failed.';
      this.reply(open, { status: 'failed', detail: result.content });
      return {
        outcome: {
          content: `It failed: ${result.content} ${sender.name} is being told.`,
          isError: true,
        },
        spoken: `That failed: ${result.content}`,
      };
    }
    const watching = Boolean(spec.reportBack?.(payload) && result.subject);
    if (watching && result.subject) {
      this.watch(result.subject.conversationId, {
        requestId: request.id,
        requesterId: request.from.conversationId,
        at: this.now(),
      });
    }
    const detail = [
      result.content,
      note,
      watching ? "That agent's final reply will be passed back to you when it finishes." : '',
    ]
      .filter(Boolean)
      .join(' ');
    open.verdict = 'I approved it.';
    this.reply(open, { status: 'approved', by, detail });
    return {
      outcome: {
        content: `Approved ${request.id}: ${result.content} ${sender.name} is being told.`,
      },
      spoken: `Approved for ${sender.name}.`,
    };
  }

  /** The developer wrote to this agent themselves: its open questions are answered. */
  noteDeveloperSend(conversationId: string): void {
    this.missed.delete(conversationId);
    for (const open of [...this.open.values()]) {
      if (
        open.valid.request.from.conversationId === conversationId &&
        open.valid.spec.decidedBy === 'developer'
      ) {
        this.close(open);
      }
    }
  }

  /**
   * One sentence for the developer's return: what agents asked that nobody answered. Each is told
   * once, and only while its agent is still on the canvas. Null when there is nothing to tell.
   */
  takeMissed(): string | null {
    const cutoff = this.now() - MISSED_QUESTION_MS;
    const sentences = [...this.missed]
      .filter(
        ([conversationId, missed]) => missed.at > cutoff && this.host.entryFor(conversationId)
      )
      .map(([, missed]) => missed.sentence);
    this.missed.clear();
    if (sentences.length === 0) return null;
    const lead =
      sentences.length === 1
        ? 'One question went unanswered while you were away.'
        : `${sentences.length} questions went unanswered while you were away.`;
    return `${lead} ${sentences.join(' ')}`;
  }

  /** Whether this agent's next final reply is owed to an agent that asked for its work. */
  watching(conversationId: string): boolean {
    return this.watches.has(conversationId);
  }

  /** An agent finished a turn: when its work was asked for by other agents, pass the reply on. */
  relayFinished(entry: AgentTileEntry, report: CompletionReport | null): void {
    const watches = this.watches.get(entry.conversationId);
    if (!watches) return;
    this.watches.delete(entry.conversationId);
    if (!this.host.enabled()) return;
    const from = this.host.sender(entry);
    for (const watch of watches) {
      if (this.now() - watch.at > WATCH_MS) continue;
      const requester = this.host.entryFor(watch.requesterId);
      if (!requester) continue;
      void this.host
        .send(watch.requesterId, relayedReplyText(watch.requestId, from, report))
        .catch((error: unknown) => {
          log.warn('conductor: passing a reply back failed', { error, id: watch.requestId });
          this.host.say(
            `${this.host.sender(requester).name} did not get ${from.name}'s reply: ${reason(error)}`
          );
        });
    }
  }

  /** Open requests for the conductor's context block. */
  contextLines(): string[] {
    const views = [...this.open.values()].flatMap((open) => this.view(open) ?? []);
    const lines = requestContextLines(views, this.now());
    const denied = this.recentlyDenied().flatMap(({ open, at }) => {
      const view = this.view(open);
      return view ? [{ ...view, at }] : [];
    });
    return [...lines, ...deniedContextLines(denied, this.now())];
  }

  private rememberDenied(open: OpenRequest): void {
    // Only a request whose approval runs an action can be approved again later.
    if (!open.valid.spec.action) return;
    this.denied.set(open.valid.request.id, { open, at: this.now() });
    for (const [id, entry] of this.denied) {
      if (this.now() - entry.at > OVERRULE_MS || this.denied.size > MAX_DENIED) {
        this.denied.delete(id);
      }
    }
  }

  private recentlyDenied(): { readonly open: OpenRequest; readonly at: number }[] {
    return [...this.denied.values()].filter((entry) => this.now() - entry.at <= OVERRULE_MS);
  }

  /**
   * Puts a request denied in the last few minutes back on the open list, waiting for the
   * developer, so their approval runs it as if it had never been denied. Returns its id, or null
   * when no such request is known.
   */
  private reopenDenied(id: string): string | null {
    if (this.find(id)) return null;
    const wanted = id.trim().toLowerCase();
    const key = this.denied.has(wanted) ? wanted : `r-${wanted}`;
    const entry = this.denied.get(key);
    this.denied.delete(key);
    if (!entry || this.now() - entry.at > OVERRULE_MS) return null;
    const { open } = entry;
    if (!this.host.entryFor(open.valid.request.from.conversationId)) return null;
    open.state = 'awaiting-developer';
    open.asked = open.asked ?? { sentence: '', at: entry.at };
    open.timer = null;
    this.open.set(key, open);
    return key;
  }

  dispose(): void {
    for (const open of this.open.values()) {
      if (open.timer) clearTimeout(open.timer);
    }
    this.open.clear();
    this.denied.clear();
    this.watches.clear();
  }

  private view(open: OpenRequest): OpenRequestView | null {
    const { request, kind, spec, payload } = open.valid;
    const entry = this.host.entryFor(request.from.conversationId);
    if (!entry) return null;
    const sender = this.host.sender(entry);
    const target = open.targetId ? this.host.entryFor(open.targetId) : undefined;
    const targetName = target ? this.host.sender(target).name : undefined;
    return {
      id: request.id,
      kind,
      sender,
      at: open.at,
      awaitingDeveloper: open.state === 'awaiting-developer',
      spoken: spec.spoken(sender.name, payload, targetName),
      body: spec.body(payload, targetName),
      ...(request.reason ? { reason: request.reason } : {}),
    };
  }

  private find(id: string): OpenRequest | undefined {
    const wanted = id.trim().toLowerCase();
    return this.open.get(wanted) ?? this.open.get(`r-${wanted}`);
  }

  /** Puts a request to the developer with `sentence` and starts its wait over. */
  private ask(open: OpenRequest, sentence: string): void {
    open.state = 'awaiting-developer';
    open.asked = { sentence, at: this.now() };
    this.arm(open);
    this.host.say(sentence, {
      conversationId: open.valid.request.from.conversationId,
      requestId: open.valid.request.id,
      asks: open.valid.spec.action ? 'request' : 'question',
    });
  }

  /** No request stays open forever: unanswered, the agent is told to carry on. */
  private arm(open: OpenRequest): void {
    if (open.timer) clearTimeout(open.timer);
    open.timer = setTimeout(() => {
      if (this.open.get(open.valid.request.id) !== open) return;
      // A decision in progress ends by settling the request or by asking, which re-arms it.
      if (open.state === 'deciding') {
        this.arm(open);
        return;
      }
      if (open.asked) {
        const from = open.valid.request.from.conversationId;
        // Re-inserted so the newest question is told last.
        this.missed.delete(from);
        this.missed.set(from, { sentence: open.asked.sentence, at: this.now() });
        while (this.missed.size > MAX_MISSED_QUESTIONS) {
          const oldest = this.missed.keys().next().value;
          if (oldest === undefined) break;
          this.missed.delete(oldest);
        }
      }
      this.settle(open, { status: 'expired' });
    }, DEVELOPER_ANSWER_MS);
  }

  /** The developer turned agent requests off: nothing that is still open will be carried out. */
  private closeAll(): void {
    for (const open of [...this.open.values()]) {
      if (open.state === 'deciding') continue;
      this.settle(open, {
        status: 'denied',
        by: 'developer',
        detail: 'Requests from agents were turned off.',
      });
    }
    this.watches.clear();
  }

  private settle(open: OpenRequest, outcome: RequestOutcome): void {
    this.close(open);
    this.reply(open, outcome);
  }

  private close(open: OpenRequest): void {
    if (open.timer) clearTimeout(open.timer);
    open.timer = null;
    this.open.delete(open.valid.request.id);
  }

  private reply(open: OpenRequest, outcome: RequestOutcome): void {
    const { request } = open.valid;
    void this.host
      .send(request.from.conversationId, requestReplyText(request, outcome))
      .catch((error: unknown) => {
        log.warn('conductor: replying to an agent request failed', { error, id: request.id });
        const entry = this.host.entryFor(request.from.conversationId);
        if (entry) {
          this.host.say(
            `${this.host.sender(entry).name} did not get my answer to its request: ${reason(error)}`
          );
        }
      });
  }

  private watch(conversationId: string, watch: Watch): void {
    const watches = [...(this.watches.get(conversationId) ?? []), watch].slice(
      -MAX_WATCHES_PER_AGENT
    );
    this.watches.delete(conversationId);
    this.watches.set(conversationId, watches);
    while (this.watches.size > MAX_WATCHED_AGENTS) {
      const oldest = this.watches.keys().next().value;
      if (oldest === undefined) break;
      this.watches.delete(oldest);
    }
  }
}

function accepted(valid: ValidAgentRequest): string {
  const { id } = valid.request;
  if (valid.spec.decidedBy === 'nobody') {
    return `Request ${id}: the conductor is telling the developer. No reply follows.`;
  }
  return valid.spec.decidedBy === 'developer'
    ? `Request ${id} accepted: the conductor is asking the developer. ${ACCEPTED_TAIL}`
    : `Request ${id} accepted: the conductor will decide it. ${ACCEPTED_TAIL}`;
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
