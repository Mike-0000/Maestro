import { observable, runInAction } from 'mobx';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentTileEntry } from '@core/features/canvas/api/browser/stores/canvas-store';
import {
  noteDeveloperInput,
  resetDeveloperTyping,
} from '@core/features/terminals/api/browser/pty/developer-typing';
import {
  CodexNotStartedError,
  DeliveryLeftUnsentError,
  sendToAgent,
  sendToLiveSession,
  stopAgentSession,
  submitAgentInput,
} from './agent-io';
import {
  BETWEEN_MESSAGES_MS,
  type DeliveryEvent,
  DeliveryHeldError,
  MAX_HOLD_MS,
  onAgentDelivery,
} from './delivery-lane';

const mocks = vi.hoisted(() => ({
  sendInput: vi.fn(),
  registryGet: vi.fn(),
  readTerminalTail: vi.fn((): string[] => []),
}));

vi.mock('@core/features/conversations/api/browser/client', () => ({
  getConversationsClient: async () => ({ tui: { sendInput: mocks.sendInput } }),
}));
vi.mock('@core/features/conversations/api/browser/stores/conversation-registry', () => ({
  conversationRegistry: { get: mocks.registryGet },
}));
vi.mock('@core/features/canvas/api/browser/terminal-tail', () => ({
  readTerminalTail: mocks.readTerminalTail,
}));

const ok = { success: true as const, data: undefined };
const refused = (type: string) => ({ success: false as const, error: { type } });

function entry(overrides: Partial<AgentTileEntry> = {}): AgentTileEntry {
  return {
    taskId: 'task-1',
    conversationId: 'conv-1',
    taskName: 'echo task',
    providerId: 'claude',
    type: 'pty',
    sessionActive: false,
    ...overrides,
  } as AgentTileEntry;
}

/** The live conversation store the agent's hooks update. */
const conversation = observable({
  status: 'idle',
  lastNotificationType: null as string | null,
  completionReport: null as object | null,
});
/** The agent's hooks report a new status. */
function hookStatus(status: string, lastNotificationType: string | null = null): void {
  runInAction(() => {
    conversation.status = status;
    conversation.lastNotificationType = lastNotificationType;
  });
}

beforeEach(() => {
  resetDeveloperTyping();
  hookStatus('idle');
  mocks.sendInput.mockReset();
  mocks.sendInput.mockResolvedValue(ok);
  mocks.readTerminalTail.mockReset();
  mocks.readTerminalTail.mockReturnValue([]);
  mocks.registryGet.mockReset();
  mocks.registryGet.mockReturnValue({
    sessions: new Map([['conv-1', { connect: async () => {}, pty: { terminal: { rows: 40 } } }]]),
    conversations: new Map([['conv-1', conversation]]),
    killSession: async () => {},
  });
});

const enters = () => mocks.sendInput.mock.calls.filter(([input]) => input.data === '\r').length;

describe('sendToLiveSession', () => {
  it('pastes and submits when the host still has the session', async () => {
    await expect(sendToLiveSession(entry(), 'hello')).resolves.toBe(true);

    expect(mocks.sendInput).toHaveBeenCalledTimes(2);
    expect(mocks.sendInput.mock.calls[0]?.[0].data).toContain('hello');
    expect(mocks.sendInput.mock.calls[1]?.[0]).toEqual({ conversationId: 'conv-1', data: '\r' });
  });

  it('presses Enter again when Codex read the first one as part of the paste', async () => {
    vi.useFakeTimers();
    try {
      const sent = sendToLiveSession(entry({ providerId: 'codex' }), 'hello');
      await vi.advanceTimersByTimeAsync(150);
      expect(enters()).toBe(0);

      await vi.advanceTimersByTimeAsync(400);
      expect(enters()).toBe(1);

      mocks.readTerminalTail.mockReturnValue(['• Working (0s • esc to interrupt)']);
      await vi.advanceTimersByTimeAsync(1_500);
      expect(enters()).toBe(1);
      await vi.advanceTimersByTimeAsync(0);
      await expect(sent).resolves.toBe(true);
      expect(enters()).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries Enter for Codex at most three times, then says the turn never started', async () => {
    const events: DeliveryEvent[] = [];
    const stop = onAgentDelivery((event) => events.push(event));
    vi.useFakeTimers();
    try {
      const sent = sendToLiveSession(entry({ providerId: 'codex' }), 'hello');
      const failed = expect(sent).rejects.toBeInstanceOf(CodexNotStartedError);
      await vi.advanceTimersByTimeAsync(10_000);
      await failed;
      await expect(sent).rejects.toThrow(
        "Pasted into echo task, but Codex didn't start; press Enter in its window."
      );
      expect(enters()).toBe(3);
      expect(events.find((event) => event.type === 'submit')).toMatchObject({
        providerId: 'codex',
        detail: { attempts: 3, outcome: 'not-started', startedOn: null },
      });
    } finally {
      vi.useRealTimers();
      stop();
    }
  });

  it('reports the attempt that started the turn when the first Enter was only a newline', async () => {
    const events: DeliveryEvent[] = [];
    const stop = onAgentDelivery((event) => events.push(event));
    vi.useFakeTimers();
    try {
      const sent = sendToLiveSession(entry({ providerId: 'codex' }), 'hello');
      await vi.advanceTimersByTimeAsync(2_100);
      expect(enters()).toBe(2);
      mocks.readTerminalTail.mockReturnValue(['• Working (0s • esc to interrupt)']);
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(sent).resolves.toBe(true);
      expect(enters()).toBe(2);
      expect(events.find((event) => event.type === 'submit')).toMatchObject({
        detail: { attempts: 2, outcome: 'working', startedOn: 2 },
      });
    } finally {
      vi.useRealTimers();
      stop();
    }
  });

  it('sees the working line as soon as it shows, and reports the attempt', async () => {
    const events: DeliveryEvent[] = [];
    const stop = onAgentDelivery((event) => events.push(event));
    vi.useFakeTimers();
    try {
      const sent = sendToLiveSession(entry({ providerId: 'codex' }), 'hello');
      await vi.advanceTimersByTimeAsync(550);
      expect(enters()).toBe(1);
      mocks.readTerminalTail.mockReturnValue(['› hello', '', '• Working (0s • esc to interrupt)']);
      // Read within a poll, not after the whole check window.
      await vi.advanceTimersByTimeAsync(200);
      await expect(sent).resolves.toBe(true);
      expect(enters()).toBe(1);
      expect(events.find((event) => event.type === 'submit')).toMatchObject({
        detail: { attempts: 1, outcome: 'working', startedOn: 1 },
      });
    } finally {
      vi.useRealTimers();
      stop();
    }
  });

  it("reads the bottom of what Codex drew, not the screen's blank last rows", async () => {
    vi.useFakeTimers();
    try {
      // Fresh Codex draws inline from the top; the rows under its composer are blank (and the
      // tail reader drops them), so the status line is far from the screen's last row.
      const drawn = [
        '╭ OpenAI Codex ╮',
        ...Array(20).fill('history'),
        '• Working (1s • esc to interrupt)',
        '› ',
        '  ⏎ send',
      ];
      mocks.readTerminalTail.mockImplementation(((_terminal: unknown, rows: number) =>
        rows >= 40 ? drawn : []) as never);
      const sent = sendToLiveSession(entry({ providerId: 'codex' }), 'hello');
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(sent).resolves.toBe(true);
      expect(enters()).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops pressing Enter once Codex raised a permission prompt', async () => {
    vi.useFakeTimers();
    try {
      const sent = sendToLiveSession(entry({ providerId: 'codex' }), 'run the tests');
      await vi.advanceTimersByTimeAsync(550);
      expect(enters()).toBe(1);
      hookStatus('awaiting-input', 'permission_prompt');
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(sent).resolves.toBe(true);
      expect(enters()).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('never presses Enter again once the developer typed in Codex after the paste', async () => {
    vi.useFakeTimers();
    try {
      const sent = sendToLiveSession(entry({ providerId: 'codex' }), 'hello');
      const failed = expect(sent).rejects.toBeInstanceOf(DeliveryLeftUnsentError);
      await vi.advanceTimersByTimeAsync(600);
      noteDeveloperInput('proj:task-1:conv-1', 'w');
      await vi.advanceTimersByTimeAsync(5_000);
      // Not "sent": the message waits in the composer with their keys.
      await failed;
      await expect(sent).rejects.toThrow(
        "Left in echo task's input because you were typing there; press Enter when ready."
      );
      expect(enters()).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('presses Enter once for Codex when its screen cannot be read', async () => {
    mocks.registryGet.mockReturnValue(undefined);
    vi.useFakeTimers();
    try {
      const sent = sendToLiveSession(entry({ providerId: 'codex' }), 'hello');
      await vi.advanceTimersByTimeAsync(10_000);
      await expect(sent).resolves.toBe(true);
      expect(enters()).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('resolves false, having typed nothing, when the host has no such session', async () => {
    mocks.sendInput.mockResolvedValue(refused('not-found'));

    await expect(sendToLiveSession(entry(), 'hello')).resolves.toBe(false);
    expect(mocks.sendInput).toHaveBeenCalledTimes(1);
  });

  it('throws on any other refusal instead of starting a second agent', async () => {
    mocks.sendInput.mockResolvedValue(refused('runtime-unavailable'));

    await expect(sendToLiveSession(entry(), 'hello')).rejects.toThrow('runtime-unavailable');
  });

  it('leaves chat agents to the ordinary path', async () => {
    await expect(sendToLiveSession(entry({ type: 'acp' }), 'hello')).resolves.toBe(false);
    expect(mocks.sendInput).not.toHaveBeenCalled();
  });
});

describe('sendToAgent', () => {
  it('still refuses a terminal agent the session list calls stopped', async () => {
    await expect(sendToAgent(entry(), 'hello')).rejects.toThrow('is not running');
    expect(mocks.sendInput).not.toHaveBeenCalled();
  });
});

// Oct 18: the conductor's reply to Zulu was pasted and submitted over the answer the developer was
// typing into Zulu's terminal, and Zulu got both as one prompt.
describe('holding a message while the developer types in that terminal', () => {
  const SESSION = 'proj:task-1:conv-1';
  const running = (overrides: Partial<AgentTileEntry> = {}) =>
    entry({ sessionActive: true, ...overrides });
  const pastes = () =>
    mocks.sendInput.mock.calls.map(([input]) => input.data as string).filter((d) => d !== '\r');
  const inputs = () => mocks.sendInput.mock.calls.map(([input]) => input.data as string);

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('sends at once when the developer has not typed there', async () => {
    const onHold = vi.fn();
    const sent = sendToAgent(running(), 'hello', true, { onHold });
    await vi.advanceTimersByTimeAsync(100);
    await expect(sent).resolves.toBeUndefined();
    expect(enters()).toBe(1);
    expect(onHold).not.toHaveBeenCalled();
  });

  it('holds while they type, says so once, and sends after they go quiet', async () => {
    const onHold = vi.fn();
    const events: DeliveryEvent[] = [];
    const stop = onAgentDelivery((event) => events.push(event));
    noteDeveloperInput(SESSION, 'located at ~/.claude/sk');
    const sent = sendToAgent(running(), '[Maestro reply r-1] hello', true, { onHold });
    expect(onHold).toHaveBeenCalledWith({ conversationId: 'conv-1', reason: 'typing', waiting: 0 });

    await vi.advanceTimersByTimeAsync(10_000);
    noteDeveloperInput(SESSION, 'ills/');
    await vi.advanceTimersByTimeAsync(14_000);
    expect(mocks.sendInput).not.toHaveBeenCalled();

    // Their text stays unsent: quiet alone does not release the message over it.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(mocks.sendInput).not.toHaveBeenCalled();

    noteDeveloperInput(SESSION, '\x15'); // they clear it (Ctrl+U)
    await vi.advanceTimersByTimeAsync(16_000);
    await expect(sent).resolves.toBeUndefined();
    expect(pastes()).toHaveLength(1);
    expect(enters()).toBe(1);
    expect(onHold).toHaveBeenCalledTimes(1);
    expect(events.map((event) => event.type)).toEqual(['held', 'released']);
    stop();
  });

  it('sends a few seconds after they press Enter and pause', async () => {
    noteDeveloperInput(SESSION, 'it is in the subagents folder');
    const sent = sendToAgent(running(), 'hello');
    await vi.advanceTimersByTimeAsync(2_000);
    noteDeveloperInput(SESSION, '\r');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(mocks.sendInput).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_500);
    await expect(sent).resolves.toBeUndefined();
    expect(enters()).toBe(1);
  });

  it('releases on quiet alone after keys that left no text (a menu answer)', async () => {
    noteDeveloperInput(SESSION, '1');
    const sent = sendToAgent(running(), 'hello');
    await vi.advanceTimersByTimeAsync(14_000);
    expect(mocks.sendInput).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_600);
    await expect(sent).resolves.toBeUndefined();
  });

  it("does not count the conductor's own paste and Enter, or terminal reports, as typing", async () => {
    const first = sendToAgent(running(), 'first');
    await vi.advanceTimersByTimeAsync(100);
    await first;
    // Focusing the tile and a TUI querying the terminal reach the same input path.
    noteDeveloperInput(SESSION, '\x1b[I');
    noteDeveloperInput(SESSION, '\x1b[?62;22c\x1b[12;40R');
    const onHold = vi.fn();
    const second = sendToAgent(running(), 'second', true, { onHold });
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(second).resolves.toBeUndefined();
    expect(onHold).not.toHaveBeenCalled();
    expect(enters()).toBe(2);
  });

  it("does not hold for the conductor's own dictation, and never submits it with a message", async () => {
    await sendToAgent(running(), 'fix the', false);
    expect(inputs()).toEqual([expect.stringContaining('fix the')]);
    const onHold = vi.fn();
    const sent = sendToAgent(running(), '[Maestro reply r-2] ok', true, { onHold });
    expect(onHold).toHaveBeenCalledWith(expect.objectContaining({ reason: 'unsent-text' }));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(inputs()).toHaveLength(1);
    // "Send it" submits the dictation; the message follows on its own.
    await submitAgentInput(running());
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(sent).resolves.toBeUndefined();
    expect(inputs()).toEqual([
      expect.stringContaining('fix the'),
      '\r',
      expect.stringContaining('ok'),
      '\r',
    ]);
  });

  it('sends held messages to one agent one at a time, in order, each submitted', async () => {
    noteDeveloperInput(SESSION, 'x');
    const onFirst = vi.fn();
    const onSecond = vi.fn();
    const first = sendToAgent(running(), 'first', true, { onHold: onFirst });
    const second = sendToAgent(running(), 'second', true, { onHold: onSecond });
    expect(onFirst.mock.calls[0]?.[0]).toMatchObject({ waiting: 0 });
    expect(onSecond.mock.calls[0]?.[0]).toMatchObject({ waiting: 1 });
    const at: number[] = [];
    mocks.sendInput.mockImplementation(async () => {
      at.push(Date.now());
      return ok;
    });
    await vi.advanceTimersByTimeAsync(14_000);
    expect(mocks.sendInput).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(6_000);
    await Promise.all([first, second]);
    // The second paste waits for the agent to take the first message in.
    expect(at[2]! - at[1]!).toBeGreaterThanOrEqual(BETWEEN_MESSAGES_MS);
    const sequence = inputs().map((data) => (data === '\r' ? 'enter' : data));
    expect(sequence).toHaveLength(4);
    expect(sequence[0]).toContain('first');
    expect(sequence[1]).toBe('enter');
    expect(sequence[2]).toContain('second');
    expect(sequence[3]).toBe('enter');
  });

  it('gives up after the longest hold instead of typing over their text', async () => {
    noteDeveloperInput(SESSION, 'half a sentence');
    const sent = sendToAgent(running(), 'hello');
    const failed = expect(sent).rejects.toBeInstanceOf(DeliveryHeldError);
    await vi.advanceTimersByTimeAsync(MAX_HOLD_MS + 1_000);
    await failed;
    await expect(sent).rejects.toThrow('echo task has text you have not sent');
    expect(mocks.sendInput).not.toHaveBeenCalled();
    // The lane is free again: the next message is not stuck behind the one given up on.
    noteDeveloperInput(SESSION, '\r');
    await vi.advanceTimersByTimeAsync(4_000);
    const next = sendToAgent(running(), 'later');
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(next).resolves.toBeUndefined();
  });

  it('keeps waiting when a prompt came up during the hold', async () => {
    noteDeveloperInput(SESSION, 'ab\r');
    const sent = sendToAgent(running(), 'hello');
    hookStatus('awaiting-input', 'permission_prompt');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(mocks.sendInput).not.toHaveBeenCalled();
    hookStatus('working');
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(sent).resolves.toBeUndefined();
  });

  it('skips the hold when asked (the developer sending their own words)', async () => {
    noteDeveloperInput(SESSION, 'abc');
    const sent = sendToAgent(running(), 'hello', true, { waitForTyping: false });
    await vi.advanceTimersByTimeAsync(200);
    await expect(sent).resolves.toBeUndefined();
  });

  it('forgets what was typed when the session is stopped', async () => {
    noteDeveloperInput(SESSION, 'abc');
    await stopAgentSession(running());
    await vi.advanceTimersByTimeAsync(0);
    const onHold = vi.fn();
    const sent = sendToAgent(running(), 'hello', true, { onHold });
    await vi.advanceTimersByTimeAsync(200);
    await expect(sent).resolves.toBeUndefined();
    expect(onHold).not.toHaveBeenCalled();
  });

  it('does not let a queued message answer a prompt the message before it raised', async () => {
    const codex = running({ providerId: 'codex' });
    const onSecond = vi.fn();
    const first = sendToAgent(codex, 'run the migration');
    const second = sendToAgent(codex, 'and then the tests', true, { onHold: onSecond });
    // The first Enter starts the turn, which asks for approval at once.
    await vi.advanceTimersByTimeAsync(550);
    expect(enters()).toBe(1);
    hookStatus('awaiting-input', 'permission_prompt');
    await vi.advanceTimersByTimeAsync(200);
    await expect(first).resolves.toBeUndefined();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(pastes()).toHaveLength(1);
    expect(enters()).toBe(1);
    expect(onSecond).toHaveBeenCalledWith(expect.objectContaining({ reason: 'prompt' }));

    hookStatus('working'); // the developer answered it
    mocks.readTerminalTail.mockReturnValue(['• Working (3s • esc to interrupt)']);
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(second).resolves.toBeUndefined();
    expect(pastes()).toHaveLength(2);
  });

  it("sends the developer's own words ahead of a held message, which stays held", async () => {
    noteDeveloperInput(SESSION, 'half typed');
    const held = sendToAgent(running(), '[Maestro reply r-3] later');
    const onHold = vi.fn();
    const own = sendToAgent(running(), 'my own words', true, { waitForTyping: false, onHold });
    await vi.advanceTimersByTimeAsync(200);
    await expect(own).resolves.toBeUndefined();
    expect(onHold).not.toHaveBeenCalled();
    expect(pastes()).toEqual([expect.stringContaining('my own words')]);

    // Their own send was submitted with what they had typed: the held message may now follow.
    await vi.advanceTimersByTimeAsync(20_000);
    await expect(held).resolves.toBeUndefined();
    expect(pastes()[1]).toContain('later');
  });

  it("keeps a held message held while the developer's own send goes", async () => {
    noteDeveloperInput(SESSION, 'abc');
    const held = sendToAgent(running(), 'held');
    noteDeveloperInput(SESSION, 'de'); // still typing when they send by voice
    const own = sendToAgent(running(), 'mine', true, { waitForTyping: false });
    await vi.advanceTimersByTimeAsync(200);
    await own;
    noteDeveloperInput(SESSION, 'more typing');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(pastes()).toHaveLength(1);
    noteDeveloperInput(SESSION, '\r');
    await vi.advanceTimersByTimeAsync(4_000);
    await expect(held).resolves.toBeUndefined();
  });

  it("refuses the developer's own send into a prompt rather than answer it", async () => {
    hookStatus('awaiting-input', 'permission_prompt');
    const own = sendToAgent(running(), 'mine', true, { waitForTyping: false });
    const failed = expect(own).rejects.toThrow('echo task is at a prompt that needs you');
    await vi.advanceTimersByTimeAsync(200);
    await failed;
    expect(mocks.sendInput).not.toHaveBeenCalled();
  });

  it('holds the next message after Codex did not start, until it shows it took the first', async () => {
    const codex = running({ providerId: 'codex' });
    const first = sendToAgent(codex, 'first');
    const failed = expect(first).rejects.toBeInstanceOf(CodexNotStartedError);
    await vi.advanceTimersByTimeAsync(6_000);
    await failed;

    const onHold = vi.fn();
    const second = sendToAgent(codex, 'second', true, { onHold });
    expect(onHold).toHaveBeenCalledWith(expect.objectContaining({ reason: 'unsent-text' }));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(pastes()).toHaveLength(1);

    // Detection was wrong: Codex ran the turn after all, and its Stop hook reports it.
    mocks.readTerminalTail.mockReturnValue(['• Working (0s • esc to interrupt)']);
    hookStatus('working');
    hookStatus('completed');
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(second).resolves.toBeUndefined();
    expect(pastes()).toHaveLength(2);
  });

  it('sends the next message once the developer presses Enter on the one Codex left', async () => {
    const codex = running({ providerId: 'codex' });
    const first = sendToAgent(codex, 'first');
    const failed = expect(first).rejects.toBeInstanceOf(CodexNotStartedError);
    await vi.advanceTimersByTimeAsync(6_000);
    await failed;

    const second = sendToAgent(codex, 'second');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(pastes()).toHaveLength(1);
    noteDeveloperInput(SESSION, '\r');
    mocks.readTerminalTail.mockReturnValue(['• Working (0s • esc to interrupt)']);
    await vi.advanceTimersByTimeAsync(4_000);
    await expect(second).resolves.toBeUndefined();
    expect(pastes()).toHaveLength(2);
  });
});
