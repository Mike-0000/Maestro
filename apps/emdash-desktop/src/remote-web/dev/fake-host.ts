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
// Dev controls: POST /dev/drop closes every Wire socket (the client should reconnect);
// POST /dev/pause?ms=4000 also refuses new sockets for that long (a visible outage);
// POST /dev/revoke forgets every paired device (the client should fall back to pairing).

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
} from '@emdash/core/services/remote-control/api';
import { err, ok } from '@emdash/shared';
import { LiveLogSource } from '@emdash/wire/live';
import { acceptWebSocket, isWebSocketUpgrade } from '@emdash/wire/node';
import { createController, serve, type WireTransport } from '@emdash/wire/rpc';
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
