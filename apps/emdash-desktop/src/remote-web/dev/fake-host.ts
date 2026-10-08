// Development-only stand-in for the Maestro desktop host. NOT part of the build.
//
// It implements the same surface the real remote-access listener does — /api/session,
// /api/pair, /api/signout and the remote-control Wire contract over a WebSocket at /wire —
// with a handful of scripted agents, so the web client can be run and exercised in a browser
// without the desktop app:
//
//   pnpm run dev:remote-web:fake-host        # this script, on :7462
//   pnpm run dev:remote-web                  # the client, proxied to it, on :7463
//
// Pairing code: ABCD-EFGH. Options (environment):
//   FAKE_HOST_PORT=7462      listen port
//   FAKE_HOST_STATIC=1       also serve the production build from out/remote-web
//   FAKE_HOST_EMPTY=1        start with no agents (empty state)
//   FAKE_HOST_SPEECH=device  replies are spoken by the device (default: host audio)
//   FAKE_HOST_STREAMING=0    no live transcription; recordings are uploaded
//   FAKE_HOST_STT=missing    speech-to-text is not set up (also: empty, fail)
//   FAKE_HOST_TTS=stall      host speech never answers (also: silent, error)
//   FAKE_HOST_TRANSCRIPT=…   what every recording is "heard" as
//   FAKE_HOST_VOICE_UNAVAILABLE=1   the host window is not ready for voice
// Dev controls: POST /dev/drop closes every Wire socket (the client should reconnect);
// POST /dev/pause?ms=4000 also refuses new sockets for that long (a visible outage);
// POST /dev/revoke forgets every paired device (the client should fall back to pairing);
// POST /dev/voice?… changes the voice options above while running, and `say=…` speaks to the
// conductor as the host's own window would; GET /dev/voice/log lists what devices asked for;
// POST /dev/attention?id=conv-migrate makes an agent start waiting for a person.
//
// The conductor is scripted by keywords: "tell/ask … to …" counts down and sends, "shut down"
// and "archive" ask for confirmation, "plan" proposes a plan, "error" fails, "what is … doing"
// answers, anything else is echoed.

import { randomUUID } from 'node:crypto';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import {
  remoteDeviceWireContract,
  type RemoteAgent,
  type RemoteAgentStatus,
  type RemoteControlError,
  type RemoteOverview,
  type RemoteTerminalSize,
  type RemoteTranscription,
  type RemoteVoiceEvent,
  type RemoteVoiceState,
} from '@emdash/core/services/remote-control/api';
import { err, ok, type Result } from '@emdash/shared';
import { createEventStreamHost, LiveLogSource } from '@emdash/wire/live';
import { acceptWebSocket, isWebSocketUpgrade } from '@emdash/wire/node';
import { createController, serve, type ContractImpl, type WireTransport } from '@emdash/wire/rpc';
import { cell, expose, peek } from '@emdash/wire/state';

const PORT = Number(process.env.FAKE_HOST_PORT ?? 7462);
const SERVE_STATIC = process.env.FAKE_HOST_STATIC === '1';
const START_EMPTY = process.env.FAKE_HOST_EMPTY === '1';
const STATIC_ROOT = resolve('out/remote-web');
const PAIRING_CODE = 'ABCDEFGH';
const COOKIE = 'maestro_dev_session';
const HOST = { id: 'host-dev', name: 'Studio PC', appVersion: '0.0.0-dev' };

const ESC = '\x1b';
const dim = (text: string): string => `${ESC}[2m${text}${ESC}[0m`;
const bold = (text: string): string => `${ESC}[1m${text}${ESC}[0m`;
const color = (code: number, text: string): string => `${ESC}[${code}m${text}${ESC}[0m`;

// ── State ────────────────────────────────────────────────────────────────────

const devices = new Map<string, { id: string; name: string }>();
const sockets = new Set<WireTransport>();
/** While this is in the future, Wire upgrades are refused: a host that is briefly out of reach. */
let pausedUntil = 0;

const minutesAgo = (minutes: number): number => Date.now() - minutes * 60_000;

function seedAgents(): RemoteAgent[] {
  if (START_EMPTY) return [];
  const base = { kind: 'terminal', providerId: 'claude', title: 'Claude Code' } as const;
  return [
    {
      ...base,
      conversationId: 'conv-auth',
      taskId: 'task-auth',
      projectId: 'maestro',
      taskName: 'Fix flaky auth refresh test',
      status: 'awaiting-input',
      running: true,
      needsAttention: true,
      message: 'Claude needs your permission to use Bash: pnpm vitest run src/auth',
      lastAssistantMessage: 'I found the race in the token refresh path. Let me run the suite.',
      lastActivityAt: minutesAgo(1),
      archived: false,
    },
    {
      ...base,
      conversationId: 'conv-pricing',
      taskId: 'task-pricing',
      projectId: 'website',
      taskName: 'Pricing page redesign',
      providerId: 'codex',
      title: 'Codex',
      status: 'awaiting-input',
      running: true,
      needsAttention: true,
      message: 'Should the annual toggle default to on?',
      lastActivityAt: minutesAgo(6),
      archived: false,
    },
    {
      ...base,
      conversationId: 'conv-migrate',
      taskId: 'task-migrate',
      projectId: 'maestro',
      taskName: 'Migrate settings to versioned schema',
      status: 'working',
      running: true,
      needsAttention: false,
      lastAssistantMessage:
        'Converting the legacy readers now. Three of seven migrations are done and their fixtures regenerate cleanly.',
      lastActivityAt: minutesAgo(0),
      archived: false,
    },
    {
      ...base,
      conversationId: 'conv-deps',
      taskId: 'task-deps',
      projectId: 'infra',
      taskName: 'Bump Terraform providers',
      status: 'working',
      running: true,
      needsAttention: false,
      lastAssistantMessage: 'Running terraform plan against staging.',
      lastActivityAt: minutesAgo(2),
      archived: false,
    },
    {
      ...base,
      conversationId: 'conv-chat',
      taskId: 'task-chat',
      projectId: 'website',
      taskName: 'Draft the changelog',
      kind: 'chat',
      status: 'idle',
      running: true,
      needsAttention: false,
      lastAssistantMessage:
        'Here is a first draft of the 1.3 changelog.\n\n• Remote access: pair a phone and steer agents from anywhere on your tailnet.\n• Faster task switching.\n\nWant me to tighten the wording?',
      lastActivityAt: minutesAgo(38),
      archived: false,
    },
    {
      ...base,
      conversationId: 'conv-docs',
      taskId: 'task-docs',
      projectId: 'maestro',
      taskName: 'Document the Wire reconnect contract',
      status: 'completed',
      running: false,
      needsAttention: false,
      lastAssistantMessage: 'Done. The new section is in agents/conventions/ipc.md.',
      lastActivityAt: minutesAgo(190),
      archived: false,
    },
    {
      ...base,
      conversationId: 'conv-ci',
      taskId: 'task-ci',
      projectId: 'infra',
      taskName: 'Investigate CI cache misses',
      status: 'error',
      running: false,
      needsAttention: false,
      lastAssistantMessage: 'The runner lost its connection while restoring the cache.',
      lastActivityAt: minutesAgo(60 * 26),
      archived: false,
    },
    {
      ...base,
      conversationId: 'conv-old',
      taskId: 'task-old',
      projectId: 'website',
      taskName: 'Old spike: edge rendering',
      status: 'idle',
      running: false,
      needsAttention: false,
      lastActivityAt: minutesAgo(60 * 24 * 12),
      archived: true,
    },
  ];
}

const overview = cell<RemoteOverview>({
  host: HOST,
  projects: [
    { id: 'maestro', name: 'maestro', path: 'C:/Github/maestro', local: true },
    { id: 'website', name: 'website', path: 'C:/Github/website', local: true },
    { id: 'infra', name: 'infra', path: '/srv/infra', local: false },
  ],
  agents: seedAgents(),
  providers: [
    { id: 'claude', name: 'Claude Code' },
    { id: 'codex', name: 'Codex' },
    { id: 'gemini', name: 'Gemini CLI' },
  ],
  defaultProviderId: 'claude',
});

function patchAgent(conversationId: string, patch: Partial<RemoteAgent>): void {
  overview.update((current) => ({
    ...current,
    agents: current.agents.map((agent) =>
      agent.conversationId === conversationId
        ? { ...agent, lastActivityAt: Date.now(), ...patch }
        : agent
    ),
  }));
}

function findAgent(conversationId: string): RemoteAgent | undefined {
  return peek(overview).agents.find((agent) => agent.conversationId === conversationId);
}

// ── A scripted terminal agent ────────────────────────────────────────────────

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

class FakeTerminal {
  readonly log = new LiveLogSource();
  size: RemoteTerminalSize = { cols: 120, rows: 32 };
  private started = false;
  private line = '';
  private pasting = false;
  private timers: ReturnType<typeof setInterval>[] = [];

  constructor(private readonly conversationId: string) {}

  start(prompt?: string): void {
    if (this.started) return;
    this.started = true;
    const agent = findAgent(this.conversationId);
    // Ask for bracketed paste, as real agent TUIs do.
    this.write(`${ESC}[?2004h`);
    this.banner(agent?.title ?? 'Agent', agent?.taskName ?? this.conversationId);
    for (let index = 1; index <= 40; index += 1) {
      this.write(
        dim(`  history ${String(index).padStart(2, '0')}  earlier output, kept for scrollback`) +
          '\r\n'
      );
    }
    this.write('\r\n');
    if (prompt) {
      this.write(`${color(36, '>')} ${prompt.replace(/\r?\n/g, '\r\n  ')}\r\n\r\n`);
      this.work(prompt);
      return;
    }
    if (agent?.needsAttention) this.askPermission();
    else if (agent?.status === 'working') this.work('the task');
    else this.prompt();
  }

  input(data: string): void {
    patchAgent(this.conversationId, {});
    let rest = data;
    while (rest.length > 0) {
      if (rest.startsWith(`${ESC}[200~`)) {
        this.pasting = true;
        rest = rest.slice(6);
        continue;
      }
      if (rest.startsWith(`${ESC}[201~`)) {
        this.pasting = false;
        rest = rest.slice(6);
        continue;
      }
      const char = rest[0]!;
      rest = rest.slice(1);
      if (char === '\x03') {
        this.stopTimers();
        this.line = '';
        this.write('^C\r\n');
        patchAgent(this.conversationId, {
          status: 'idle',
          needsAttention: false,
          message: undefined,
        });
        this.prompt();
      } else if (char === ESC) {
        // A lone Escape, or the start of a key sequence: show it the way `cat -v` would.
        const sequence = /^(\[[0-9;]*[A-Za-z~]|O[A-Z])/.exec(rest)?.[0] ?? '';
        rest = rest.slice(sequence.length);
        this.write(dim(`^[${sequence}`));
      } else if (char === '\r' && this.pasting) {
        this.line += '\n';
        this.write('\r\n  ');
      } else if (char === '\r') {
        this.submit();
      } else if (char === '\x7f') {
        if (this.line.length > 0) {
          this.line = this.line.slice(0, -1);
          this.write('\b \b');
        }
      } else if (char === '\t') {
        this.write(dim('⇥'));
      } else {
        this.line += char;
        this.write(char);
        if (findAgent(this.conversationId)?.needsAttention && /^[yn123]$/.test(char)) this.submit();
      }
    }
  }

  resize(size: RemoteTerminalSize): void {
    this.size = size;
    this.write(`\r\n${dim(`[terminal resized to ${size.cols}×${size.rows}]`)}\r\n`);
  }

  private submit(): void {
    const text = this.line.trim();
    this.line = '';
    this.write('\r\n');
    const agent = findAgent(this.conversationId);
    if (agent?.needsAttention) {
      const approved = /^(y|1|2)/i.test(text) || text === '';
      this.write(
        approved ? `${color(32, '✓')} Approved.\r\n\r\n` : `${color(31, '✗')} Declined.\r\n\r\n`
      );
      patchAgent(this.conversationId, { needsAttention: false, message: undefined });
      if (approved) this.work('the approved command');
      else {
        patchAgent(this.conversationId, { status: 'idle' });
        this.prompt();
      }
      return;
    }
    if (!text) {
      this.prompt();
      return;
    }
    this.work(text);
  }

  private work(task: string): void {
    this.stopTimers();
    patchAgent(this.conversationId, {
      status: 'working',
      running: true,
      needsAttention: false,
      message: undefined,
    });
    let frame = 0;
    const spinner = setInterval(() => {
      frame += 1;
      const elapsed = (frame / 10).toFixed(1);
      this.write(
        `\r${color(35, SPINNER[frame % SPINNER.length]!)} Working on ${bold(task.split('\n')[0]!.slice(0, Math.max(4, this.size.cols - 36)))} ${dim(`${elapsed}s · esc`)}${ESC}[K`
      );
      if (frame === 25) {
        this.write(
          `\r${ESC}[K${color(34, '●')} Read 4 files, edited ${bold('src/auth/refresh.ts')}\r\n`
        );
      }
      if (frame < 50) return;
      clearInterval(spinner);
      this.write(`\r${ESC}[K`);
      const summary = `Finished: ${task.split('\n')[0]!.slice(0, 80)}. Everything passes.`;
      this.write(`${color(32, '●')} ${summary}\r\n\r\n`);
      patchAgent(this.conversationId, { status: 'idle', lastAssistantMessage: summary });
      this.prompt();
    }, 100);
    this.timers.push(spinner);
  }

  private askPermission(): void {
    const width = Math.min(this.size.cols - 2, 72);
    const rule = '─'.repeat(width);
    const row = (text: string): string =>
      `│ ${text}${' '.repeat(Math.max(0, width - 1 - stripAnsi(text).length))}│\r\n`;
    this.write(
      `╭${rule}╮\r\n` +
        row(bold('Bash command')) +
        row('') +
        row(`  ${color(33, 'pnpm vitest run src/auth')}`) +
        row(dim('  Run the auth test suite')) +
        row('') +
        row('Do you want to proceed?') +
        row(`${color(36, '❯')} 1. Yes`) +
        row("  2. Yes, and don't ask again for pnpm vitest") +
        row('  3. No, and tell Claude what to do differently') +
        `╰${rule}╯\r\n`
    );
  }

  private banner(title: string, task: string): void {
    this.write(
      `${color(35, '╭──────────────────────────────────────────────╮')}\r\n` +
        `${color(35, '│')} ${bold(`✻ ${title}`.padEnd(45))}${color(35, '│')}\r\n` +
        `${color(35, '│')} ${dim(task.slice(0, 44).padEnd(45))}${color(35, '│')}\r\n` +
        `${color(35, '╰──────────────────────────────────────────────╯')}\r\n\r\n`
    );
  }

  private prompt(): void {
    this.write(`${color(36, '>')} `);
  }

  private write(text: string): void {
    this.log.append(text);
  }

  private stopTimers(): void {
    for (const timer of this.timers.splice(0)) clearInterval(timer);
  }
}

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, '');
}

const terminals = new Map<string, FakeTerminal>();

function terminalFor(conversationId: string): FakeTerminal {
  let terminal = terminals.get(conversationId);
  if (!terminal) {
    terminal = new FakeTerminal(conversationId);
    terminals.set(conversationId, terminal);
  }
  return terminal;
}

// ── A scripted conductor ─────────────────────────────────────────────────────

const voiceRemote = remoteDeviceWireContract.remote.voice;
const AGENT_NAMES = ['Atlas', 'Bravo', 'Cedar', 'Delta'];
const SPEECH_SAMPLE_RATE = 24_000;

/** Switches for the voice surface; `POST /dev/voice?key=value` changes them while running. */
const voiceOptions = {
  /** Whether live transcription is offered (`openStream` returns an id). */
  streaming: process.env.FAKE_HOST_STREAMING !== '0',
  /** `ok`, `missing` (speech-to-text not set up), `empty` (no words heard) or `fail`. */
  stt: process.env.FAKE_HOST_STT ?? 'ok',
  /** What every recording is "heard" as. */
  transcript: process.env.FAKE_HOST_TRANSCRIPT ?? 'Tell Atlas to run the tests',
  /** `ok`, `silent` (done without audio), `error`, or `stall` (never answers). */
  tts: process.env.FAKE_HOST_TTS ?? 'ok',
};

const voiceState = cell<RemoteVoiceState>({
  available: process.env.FAKE_HOST_VOICE_UNAVAILABLE !== '1',
  transcriptionReady: voiceOptions.stt !== 'missing',
  phase: 'idle',
  activity: '',
  lastUtterance: '',
  reply: '',
  replyAt: 0,
  error: null,
  pending: null,
  plan: null,
  agentNames: START_EMPTY ? [] : AGENT_NAMES,
  speech: process.env.FAKE_HOST_SPEECH === 'device' ? 'device' : 'host',
});
const voiceEvents = createEventStreamHost(voiceRemote.events);
/** Everything devices asked of the voice surface, newest last (`GET /dev/voice/log`). */
const voiceLog: Record<string, unknown>[] = [];
const voiceStreams = new Map<string, { bytes: number; words: number }>();
const speechTimers = new Map<string, ReturnType<typeof setTimeout>[]>();
let conductorTimer: ReturnType<typeof setTimeout> | undefined;
let nextPendingId = 1;
/** What runs when the pending action is confirmed or its countdown ends. */
let pendingAction: (() => void) | null = null;

function recordVoice(entry: Record<string, unknown>): void {
  voiceLog.push({ at: Date.now(), ...entry });
  if (voiceLog.length > 500) voiceLog.shift();
}

function patchVoice(patch: Partial<RemoteVoiceState>): void {
  voiceState.update((current) => ({ ...current, ...patch }));
}

function conductorReply(reply: string): void {
  patchVoice({ phase: 'idle', activity: '', reply, replyAt: Date.now() });
}

function hold(label: string, kind: 'countdown' | 'confirm', durationMs: number, run: () => void) {
  clearTimeout(conductorTimer);
  pendingAction = run;
  patchVoice({
    phase: 'idle',
    activity: '',
    pending: { id: nextPendingId++, label, kind, startedAt: Date.now(), durationMs },
  });
  if (kind === 'countdown') conductorTimer = setTimeout(() => settlePending('yes'), durationMs);
}

function settlePending(decision: 'yes' | 'no'): void {
  clearTimeout(conductorTimer);
  const run = pendingAction;
  pendingAction = null;
  patchVoice({ pending: null });
  if (decision === 'yes') run?.();
  else conductorReply('Cancelled.');
}

function settlePlan(decision: 'yes' | 'no'): void {
  const plan = peek(voiceState).plan;
  if (!plan) return;
  if (decision === 'no') {
    patchVoice({ plan: { ...plan, status: 'cancelled' } });
    conductorReply('Plan discarded.');
    return;
  }
  patchVoice({ plan: { ...plan, status: 'running' } });
  conductorReply(`Starting ${plan.subtasks.length} agents.`);
  conductorTimer = setTimeout(() => {
    patchVoice({ plan: { ...plan, status: 'done' } });
    conductorReply('The plan is finished. All three branches are ready to review.');
  }, 4_000);
}

function conductorRespond(decision: 'yes' | 'no'): void {
  const current = peek(voiceState);
  if (current.pending) settlePending(decision);
  else if (current.plan?.status === 'proposed') settlePlan(decision);
  else conductorReply('There is nothing waiting for an answer.');
}

/** Picks what to do from keywords, the way the real conductor decides from meaning. */
function conductorHear(text: string): void {
  clearTimeout(conductorTimer);
  const said = text.trim();
  if (/^(yes|yep|do it|go ahead)\b/i.test(said)) return conductorRespond('yes');
  if (/^(no|stop|cancel|wait|scratch that)\b/i.test(said)) return conductorRespond('no');
  patchVoice({
    lastUtterance: said,
    phase: 'thinking',
    activity: 'Thinking…',
    error: null,
    pending: null,
  });
  pendingAction = null;
  conductorTimer = setTimeout(() => {
    const name = AGENT_NAMES.find((agent) => new RegExp(`\\b${agent}\\b`, 'i').test(said));
    const agent = name ?? 'Atlas';
    if (/\b(plan|split|parallel)\b/i.test(said)) {
      patchVoice({
        phase: 'idle',
        activity: '',
        plan: {
          goal: 'Ship the settings migration',
          status: 'proposed',
          subtasks: [
            { name: 'Schema and migrations', detail: 'src/main/db · adds the versioned column' },
            {
              name: 'Settings readers',
              detail: 'src/core/features/projects · after “Schema and migrations”',
            },
            { name: 'Fixtures and tests', detail: 'drizzle/fixtures, *.db.test.ts' },
          ],
        },
      });
      conductorReply('Here is a plan with three agents. Say yes to start.');
    } else if (/\b(shut down|kill|archive|allow|deny)\b/i.test(said)) {
      const verb = /\barchive\b/i.test(said) ? 'Archive' : 'Shut down';
      hold(`${verb} ${agent}?`, 'confirm', 0, () =>
        conductorReply(`${agent} is ${verb === 'Archive' ? 'archived' : 'shut down'}.`)
      );
    } else if (/\b(tell|ask|send)\b/i.test(said)) {
      const message = /\bto (.+)$/i.exec(said)?.[1] ?? 'continue';
      hold(`Send to ${agent}: ${message}`, 'countdown', 2_500, () => {
        patchVoice({ phase: 'acting', activity: `Sending to ${agent}…` });
        conductorTimer = setTimeout(() => conductorReply(`Sent to ${agent}.`), 500);
      });
    } else if (/\b(error|broken)\b/i.test(said)) {
      patchVoice({
        phase: 'idle',
        activity: '',
        error: 'The conductor could not reach its model. Check the API key on the host.',
      });
    } else if (/\bdoing\b/i.test(said)) {
      conductorReply(`${agent} is running the test suite. Forty of fifty-two files have passed.`);
    } else {
      conductorReply(`You said: ${said}`);
    }
  }, 700);
}

/** A short, quiet two-note chime: enough to prove audio reaches the device's speaker. */
function chimePcm(durationMs: number, frequency: number): string {
  const samples = Math.round((SPEECH_SAMPLE_RATE * durationMs) / 1000);
  const pcm = Buffer.alloc(samples * 2);
  for (let index = 0; index < samples; index += 1) {
    const envelope = Math.sin((Math.PI * index) / samples);
    const value = Math.sin((2 * Math.PI * frequency * index) / SPEECH_SAMPLE_RATE);
    pcm.writeInt16LE(Math.round(value * envelope * 0.2 * 0x7fff), index * 2);
  }
  return pcm.toString('base64');
}

function fakeSpeech(requestId: string): void {
  const emit = (event: RemoteVoiceEvent): void => voiceEvents.emit(undefined, event);
  const later = (ms: number, run: () => void): void => {
    speechTimers.set(requestId, [...(speechTimers.get(requestId) ?? []), setTimeout(run, ms)]);
  };
  if (voiceOptions.tts === 'stall') return;
  if (voiceOptions.tts === 'error') {
    later(150, () => emit({ type: 'speech-error', requestId }));
    return;
  }
  if (voiceOptions.tts !== 'silent') {
    [523, 659, 784].forEach((frequency, index) => {
      later(120 + index * 90, () =>
        emit({
          type: 'speech-chunk',
          requestId,
          pcm: chimePcm(220, frequency),
          sampleRate: SPEECH_SAMPLE_RATE,
        })
      );
    });
  }
  later(450, () => {
    speechTimers.delete(requestId);
    emit({ type: 'speech-done', requestId });
  });
}

const sttMissing = (): RemoteControlError => ({
  type: 'unavailable',
  message: 'Speech-to-text is not set up. Add a key in Settings → Voice & Conductor.',
});

function transcriptOr(error: 'upload' | 'stream'): Result<RemoteTranscription, RemoteControlError> {
  if (voiceOptions.stt === 'missing') return err(sttMissing());
  if (voiceOptions.stt === 'fail') {
    return err({ type: 'failed', message: `The speech engine rejected the ${error}.` });
  }
  return ok({ text: voiceOptions.stt === 'empty' ? '' : voiceOptions.transcript, latencyMs: 420 });
}

const voice: ContractImpl<typeof voiceRemote> = {
  state: expose(voiceRemote.state, { hud: voiceState }),
  events: voiceEvents,

  transcribe: async (_input, file) => {
    const bytes = await file.bytes();
    const header = Buffer.from(bytes.subarray(0, 12)).toString('latin1');
    recordVoice({
      call: 'transcribe',
      bytes: bytes.byteLength,
      mimeType: file.mimeType,
      wav: header.startsWith('RIFF') && header.endsWith('WAVE'),
      sampleRate: bytes.byteLength >= 28 ? Buffer.from(bytes).readUInt32LE(24) : 0,
    });
    await new Promise((resolve) => setTimeout(resolve, 500));
    return transcriptOr('upload');
  },

  openStream: () => {
    const streamId = voiceOptions.streaming && voiceOptions.stt === 'ok' ? randomUUID() : null;
    if (streamId) voiceStreams.set(streamId, { bytes: 0, words: 0 });
    recordVoice({ call: 'openStream', streamId });
    return ok({ streamId });
  },
  pushAudio: ({ streamId, pcm }) => {
    const stream = voiceStreams.get(streamId);
    if (!stream) {
      return err({ type: 'not-found', message: 'That recording is no longer open.' } as const);
    }
    stream.bytes += Buffer.from(pcm, 'base64').byteLength;
    // One more word for every 350 ms of 16 kHz PCM16 heard.
    const words = voiceOptions.transcript.split(' ');
    const heard = Math.min(words.length, Math.floor(stream.bytes / (32_000 * 0.35)));
    if (heard > stream.words) {
      stream.words = heard;
      voiceEvents.emit(undefined, {
        type: 'partial',
        streamId,
        text: words.slice(0, heard).join(' '),
      });
    }
    return ok<void>();
  },
  closeStream: ({ streamId }) => {
    const stream = voiceStreams.get(streamId);
    voiceStreams.delete(streamId);
    recordVoice({ call: 'closeStream', streamId, bytes: stream?.bytes ?? 0 });
    if (!stream) {
      return err({ type: 'not-found', message: 'That recording is no longer open.' } as const);
    }
    return transcriptOr('stream');
  },
  abortStream: ({ streamId }) => {
    recordVoice({ call: 'abortStream', streamId, known: voiceStreams.delete(streamId) });
    return ok<void>();
  },

  say: ({ text }) => {
    recordVoice({ call: 'say', text });
    if (!peek(voiceState).available) {
      return err({
        type: 'unavailable',
        message: 'The Maestro window on the host is not ready for voice commands yet.',
      } as const);
    }
    conductorHear(text);
    return ok<void>();
  },
  respond: ({ decision }) => {
    recordVoice({ call: 'respond', decision });
    conductorRespond(decision);
    return ok<void>();
  },

  speak: ({ requestId, text }) => {
    recordVoice({ call: 'speak', requestId, text });
    if (peek(voiceState).speech !== 'host') {
      return err({
        type: 'unsupported',
        message: 'The host uses its system voice; speak the reply on this device.',
      } as const);
    }
    fakeSpeech(requestId);
    return ok<void>();
  },
  stopSpeaking: ({ requestId }) => {
    recordVoice({ call: 'stopSpeaking', requestId });
    for (const timer of speechTimers.get(requestId) ?? []) clearTimeout(timer);
    speechTimers.delete(requestId);
    return ok<void>();
  },
};

/** `POST /dev/voice?available=0&speech=device&streaming=0&stt=missing&tts=stall&transcript=…` */
function configureVoice(params: URLSearchParams): Record<string, unknown> {
  const flag = (name: string): boolean | undefined =>
    params.has(name) ? params.get(name) !== '0' : undefined;
  const available = flag('available');
  const streaming = flag('streaming');
  if (streaming !== undefined) voiceOptions.streaming = streaming;
  voiceOptions.stt = params.get('stt') ?? voiceOptions.stt;
  voiceOptions.tts = params.get('tts') ?? voiceOptions.tts;
  voiceOptions.transcript = params.get('transcript') ?? voiceOptions.transcript;
  const speech = params.get('speech');
  patchVoice({
    ...(available === undefined ? {} : { available }),
    ...(speech === 'host' || speech === 'device' ? { speech } : {}),
    transcriptionReady: voiceOptions.stt !== 'missing',
  });
  const say = params.get('say');
  if (say) conductorHear(say);
  return { ...voiceOptions, state: peek(voiceState) };
}

// ── Wire controller ──────────────────────────────────────────────────────────

const notFound = (conversationId: string): RemoteControlError => ({
  type: 'not-found',
  message: `No agent with id ${conversationId}`,
});

const controller = createController(remoteDeviceWireContract, {
  remote: {
    overview: expose(remoteDeviceWireContract.remote.overview, { snapshot: overview }),

    startAgent: ({ projectId, prompt, name, providerId }) => {
      const current = peek(overview);
      if (!current.projects.some((project) => project.id === projectId)) {
        return err({ type: 'not-found', message: 'That project no longer exists.' } as const);
      }
      const provider =
        current.providers.find((entry) => entry.id === (providerId ?? current.defaultProviderId)) ??
        current.providers[0]!;
      const conversationId = `conv-${randomUUID().slice(0, 8)}`;
      const taskId = `task-${randomUUID().slice(0, 8)}`;
      const agent: RemoteAgent = {
        conversationId,
        taskId,
        projectId,
        taskName: name ?? prompt.split('\n')[0]!.slice(0, 60),
        title: provider.name,
        providerId: provider.id,
        kind: 'terminal',
        status: 'working' satisfies RemoteAgentStatus,
        running: true,
        needsAttention: false,
        lastActivityAt: Date.now(),
        archived: false,
      };
      overview.update((value) => ({ ...value, agents: [...value.agents, agent] }));
      terminalFor(conversationId).start(prompt);
      return ok({ taskId, conversationId });
    },

    openAgent: ({ conversationId, size }) => {
      const agent = findAgent(conversationId);
      if (!agent) return err(notFound(conversationId));
      if (agent.kind === 'chat')
        return ok({ kind: 'chat' as const, running: agent.running, size: null });
      const terminal = terminalFor(conversationId);
      if (!agent.running) {
        if (size) terminal.size = size;
        patchAgent(conversationId, { running: true, status: 'idle' });
      }
      terminal.start();
      return ok({ kind: 'terminal' as const, running: true, size: terminal.size });
    },

    output: ({ conversationId }) => terminalFor(conversationId).log,

    sendInput: ({ conversationId, data }) => {
      if (!findAgent(conversationId)) return err(notFound(conversationId));
      terminalFor(conversationId).input(data);
      return ok<void>();
    },

    resize: ({ conversationId, cols, rows }) => {
      if (!findAgent(conversationId)) return err(notFound(conversationId));
      terminalFor(conversationId).resize({ cols, rows });
      return ok<void>();
    },

    adoptConversation: () =>
      err({ type: 'unsupported', message: 'The dev host does not adopt conversations.' } as const),

    voice,
  },
});

// ── HTTP ─────────────────────────────────────────────────────────────────────

function deviceOf(request: IncomingMessage): { id: string; name: string } | undefined {
  const cookie = request.headers.cookie ?? '';
  const token = new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`).exec(cookie)?.[1];
  return token ? devices.get(token) : undefined;
}

function json(response: ServerResponse, status: number, body: unknown, headers = {}): void {
  response.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    ...headers,
  });
  response.end(JSON.stringify(body));
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json',
  '.json': 'application/json',
};

function serveStatic(pathname: string, response: ServerResponse): void {
  const candidate = normalize(join(STATIC_ROOT, pathname));
  const inside = candidate.startsWith(STATIC_ROOT);
  const file =
    inside && existsSync(candidate) && statSync(candidate).isFile()
      ? candidate
      : join(STATIC_ROOT, 'index.html');
  if (!existsSync(file)) {
    response.writeHead(404).end('Run `pnpm run build:remote-web` first.');
    return;
  }
  const hashed = file.includes(`${join(STATIC_ROOT, 'assets')}`);
  response.writeHead(200, {
    'Content-Type': CONTENT_TYPES[extname(file)] ?? 'application/octet-stream',
    'Cache-Control': hashed ? 'public, max-age=31536000, immutable' : 'no-cache',
  });
  createReadStream(file).pipe(response);
}

const server = createServer((request, response) => {
  void (async () => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const route = `${request.method} ${url.pathname}`;

    if (route === 'GET /api/session') {
      const device = deviceOf(request);
      json(response, 200, {
        authenticated: Boolean(device),
        hostId: HOST.id,
        hostName: HOST.name,
        ...(device ? { device } : {}),
      });
      return;
    }
    if (route === 'POST /api/pair') {
      const body = await readJson(request);
      const code = String(body.code ?? '')
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, '');
      if (code === 'RATELIMT') {
        json(response, 429, { error: 'rate-limited' });
        return;
      }
      if (code !== PAIRING_CODE) {
        json(response, 401, { error: 'invalid-code' });
        return;
      }
      const token = randomUUID();
      const device = { id: randomUUID(), name: String(body.deviceName ?? 'Browser').slice(0, 60) };
      devices.set(token, device);
      json(
        response,
        200,
        { deviceId: device.id, hostId: HOST.id, hostName: HOST.name },
        { 'Set-Cookie': `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000` }
      );
      return;
    }
    if (route === 'POST /api/signout') {
      const cookie = request.headers.cookie ?? '';
      const token = new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`).exec(cookie)?.[1];
      if (token) devices.delete(token);
      response.writeHead(204, { 'Set-Cookie': `${COOKIE}=; Path=/; HttpOnly; Max-Age=0` }).end();
      return;
    }
    if (route === 'POST /dev/drop') {
      for (const socket of [...sockets]) socket.close?.();
      json(response, 200, { dropped: true });
      return;
    }
    if (route === 'POST /dev/pause') {
      pausedUntil = Date.now() + Number(url.searchParams.get('ms') ?? 4000);
      for (const socket of [...sockets]) socket.close?.();
      json(response, 200, { pausedUntil });
      return;
    }
    if (route === 'POST /dev/revoke') {
      devices.clear();
      for (const socket of [...sockets]) socket.close?.();
      json(response, 200, { revoked: true });
      return;
    }
    if (route === 'POST /dev/voice') {
      json(response, 200, configureVoice(url.searchParams));
      return;
    }
    if (route === 'GET /dev/voice/log') {
      json(response, 200, voiceLog);
      return;
    }
    if (route === 'POST /dev/attention') {
      const id = url.searchParams.get('id') ?? '';
      const waiting = url.searchParams.get('waiting') !== '0';
      if (!findAgent(id)) {
        json(response, 404, { error: 'not-found' });
        return;
      }
      patchAgent(id, {
        needsAttention: waiting,
        status: waiting ? 'awaiting-input' : 'working',
        message: waiting ? 'Claude needs your permission to use Bash: pnpm run build' : undefined,
      });
      json(response, 200, { id, waiting });
      return;
    }
    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/dev/')) {
      json(response, 404, { error: 'not-found' });
      return;
    }
    if (SERVE_STATIC && request.method === 'GET') {
      serveStatic(url.pathname, response);
      return;
    }
    response.writeHead(404).end('Fake Maestro host: API only. Open the Vite dev server instead.');
  })();
});

server.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url ?? '/', 'http://localhost');
  if (Date.now() < pausedUntil) {
    socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
    return;
  }
  if (url.pathname !== '/wire' || !isWebSocketUpgrade(request) || !deviceOf(request)) {
    socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    return;
  }
  const transport = acceptWebSocket(request, socket, head);
  sockets.add(transport);
  const stop = serve(transport, controller);
  transport.onDisconnect(() => {
    sockets.delete(transport);
    stop();
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Fake Maestro host on http://127.0.0.1:${PORT}  (pairing code: ABCD-EFGH)`);
  if (SERVE_STATIC) console.log(`Serving the production build from ${STATIC_ROOT}`);
});
