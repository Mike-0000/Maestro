import crypto from 'node:crypto';
import http from 'node:http';
import type { Logger } from '@emdash/shared/logger';

/**
 * Loopback MCP server (Streamable HTTP, JSON responses only) for tools Maestro hands to the coding
 * agents it runs. Each agent conversation (ACP chat or terminal CLI) gets its own bearer token
 * mapped to a scope; the token is the only authority, so a tool acts for the scope its token was
 * issued for and never for an id in its arguments.
 *
 * Browsers cannot reach it: requests carrying Origin or Sec-Fetch headers, or a Host other than
 * the literal loopback address, are refused before auth.
 *
 * Security-sensitive: see docs/chorus/canvas-browser-plan.md §6 (T5).
 */

const MCP_PATH = '/mcp';
const MAX_BODY_BYTES = 256 * 1024;
const MAX_TOKENS = 256;
const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

type JsonRpcRequest = {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
};

export type ToolContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string };

export type ToolResult = { content: ToolContent[]; isError?: boolean };

/** A tool as `tools/list` advertises it. */
export type LoopbackMcpTool = {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: object;
  readonly annotations?: {
    readonly title?: string;
    readonly readOnlyHint?: boolean;
    readonly openWorldHint?: boolean;
  };
};

/** What an agent session needs to reach the server as one conversation. */
export type LoopbackMcpRegistration = {
  name: string;
  url: string;
  headers: Record<string, string>;
};

export type LoopbackMcpServerOptions<Scope> = {
  /** The MCP server's name, in every registration and in `serverInfo`. */
  readonly name: string;
  /**
   * Starts every token the server issues. A fixed prefix lets file-log redaction match a bare
   * token (see `SECRET_PATTERNS` in packages/shared/src/logger/redact.ts).
   */
  readonly tokenPrefix: string;
  /** Told to the agent once per session, in the `initialize` result. */
  readonly instructions: string;
  readonly tools: readonly LoopbackMcpTool[];
  /** Names the server in its log lines. */
  readonly logLabel: string;
  /** Whether a conversation's token still stands for `next`; when not, the token rotates. */
  readonly sameScope: (current: Scope, next: Scope) => boolean;
  /** Called with the listening port each time the listener starts. */
  readonly onPort?: (port: number) => void;
};

export abstract class LoopbackMcpServer<Scope extends { conversationId: string }> {
  private server: http.Server | null = null;
  private port = 0;
  private starting: Promise<number> | null = null;
  private readonly scopesByToken = new Map<string, Scope>();
  private readonly tokenByConversation = new Map<string, string>();

  constructor(
    private readonly options: LoopbackMcpServerOptions<Scope>,
    private readonly logger: Logger
  ) {}

  /** Runs one tool for `scope`, which is the scope of the token the caller presented. */
  abstract callTool(scope: Scope, name: string, args: Record<string, unknown>): Promise<ToolResult>;

  /**
   * The MCP registration for a conversation. Reuses the conversation's token while its scope is
   * unchanged (the stored scope is still refreshed); a new scope rotates it.
   */
  async register(scope: Scope): Promise<LoopbackMcpRegistration> {
    const port = await this.ensureStarted();
    const existing = this.tokenByConversation.get(scope.conversationId);
    const existingScope = existing ? this.scopesByToken.get(existing) : undefined;
    if (existing && existingScope && this.options.sameScope(existingScope, scope)) {
      this.scopesByToken.set(existing, scope);
      return this.registration(port, existing);
    }
    this.revoke(scope.conversationId);
    if (this.scopesByToken.size >= MAX_TOKENS) {
      const oldest = this.scopesByToken.keys().next().value;
      if (oldest !== undefined) {
        const stale = this.scopesByToken.get(oldest);
        this.scopesByToken.delete(oldest);
        if (stale) this.tokenByConversation.delete(stale.conversationId);
      }
    }
    const token = `${this.options.tokenPrefix}${crypto.randomBytes(24).toString('hex')}`;
    this.scopesByToken.set(token, scope);
    this.tokenByConversation.set(scope.conversationId, token);
    return this.registration(port, token);
  }

  private registration(port: number, token: string): LoopbackMcpRegistration {
    return {
      name: this.options.name,
      url: `http://127.0.0.1:${port}${MCP_PATH}`,
      headers: { Authorization: `Bearer ${token}` },
    };
  }

  revoke(conversationId: string): void {
    const token = this.tokenByConversation.get(conversationId);
    if (!token) return;
    this.scopesByToken.delete(token);
    this.tokenByConversation.delete(conversationId);
  }

  stop(): void {
    this.scopesByToken.clear();
    this.tokenByConversation.clear();
    this.server?.close();
    this.server = null;
    this.port = 0;
  }

  get listeningPort(): number {
    return this.port;
  }

  ensureStarted(): Promise<number> {
    if (this.server && this.port > 0) return Promise.resolve(this.port);
    if (this.starting) return this.starting;
    const server = http.createServer((req, res) => {
      this.handle(req, res).catch((error) => {
        this.logger.warn(`${this.options.logLabel}: request failed`, { error: String(error) });
        if (!res.headersSent) res.writeHead(500);
        res.end();
      });
    });
    this.server = server;
    this.starting = new Promise<number>((resolve, reject) => {
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        this.port = address && typeof address === 'object' ? address.port : 0;
        this.options.onPort?.(this.port);
        this.logger.info(`${this.options.logLabel}: started`, { port: this.port });
        resolve(this.port);
      });
      server.on('error', (error) => {
        this.server = null;
        this.port = 0;
        reject(error);
      });
    }).finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    // DNS rebinding and drive-by requests from web pages: browsers always send one of these.
    if (
      req.headers.origin !== undefined ||
      req.headers['sec-fetch-site'] !== undefined ||
      req.headers['sec-fetch-mode'] !== undefined ||
      req.headers.host !== `127.0.0.1:${this.port}`
    ) {
      return void respond(res, 403);
    }
    const path = (req.url ?? '').split('?')[0];
    if (path !== MCP_PATH) return void respond(res, 404);
    const scope = this.authenticate(req.headers.authorization);
    if (!scope) return void respond(res, 401);
    if (req.method === 'GET' || req.method === 'DELETE') {
      // No server-initiated stream and no server-side session to end.
      return void respond(res, 405, undefined, { Allow: 'POST' });
    }
    if (req.method !== 'POST') return void respond(res, 405, undefined, { Allow: 'POST' });
    if (!String(req.headers['content-type'] ?? '').includes('application/json')) {
      return void respond(res, 415);
    }

    const body = await readBody(req);
    if (body === null) return void respond(res, 413);
    let message: unknown;
    try {
      message = JSON.parse(body);
    } catch {
      return void respondJson(res, rpcError(null, -32700, 'Parse error'));
    }
    if (!isRequest(message)) {
      return void respondJson(res, rpcError(null, -32600, 'Invalid request'));
    }
    if (message.id === undefined || message.id === null) {
      // Notifications (initialized, cancelled) need no answer.
      return void respond(res, 202);
    }
    respondJson(res, await this.dispatch(scope, message));
  }

  private authenticate(header: string | undefined): Scope | null {
    if (!header?.startsWith('Bearer ')) return null;
    const presented = header.slice('Bearer '.length).trim();
    if (!presented.startsWith(this.options.tokenPrefix)) return null;
    const presentedBuffer = Buffer.from(presented);
    for (const [token, scope] of this.scopesByToken) {
      const tokenBuffer = Buffer.from(token);
      if (
        tokenBuffer.length === presentedBuffer.length &&
        crypto.timingSafeEqual(tokenBuffer, presentedBuffer)
      ) {
        return scope;
      }
    }
    return null;
  }

  private async dispatch(scope: Scope, request: JsonRpcRequest): Promise<object> {
    const id = request.id ?? null;
    switch (request.method) {
      case 'initialize': {
        const requested = request.params?.protocolVersion;
        const protocolVersion =
          typeof requested === 'string' && SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
            ? requested
            : SUPPORTED_PROTOCOL_VERSIONS[0];
        return rpcResult(id, {
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: this.options.name, version: '1.0.0' },
          instructions: this.options.instructions,
        });
      }
      case 'ping':
        return rpcResult(id, {});
      case 'tools/list':
        return rpcResult(id, { tools: this.options.tools });
      case 'tools/call': {
        const name = request.params?.name;
        const args = request.params?.arguments;
        if (typeof name !== 'string') return rpcError(id, -32602, 'Missing tool name');
        const result = await this.callTool(
          scope,
          name,
          args && typeof args === 'object' ? (args as Record<string, unknown>) : {}
        );
        return rpcResult(id, result);
      }
      default:
        return rpcError(id, -32601, `Method not found: ${request.method}`);
    }
  }
}

export function textResult(text: string, isError = false): ToolResult {
  return { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) };
}

function isRequest(value: unknown): value is JsonRpcRequest {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    (value as { jsonrpc?: unknown }).jsonrpc === '2.0' &&
    typeof (value as { method?: unknown }).method === 'string'
  );
}

function rpcResult(id: string | number | null, result: unknown): object {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id: string | number | null, code: number, message: string): object {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function respond(
  res: http.ServerResponse,
  status: number,
  body?: string,
  headers: Record<string, string> = {}
): void {
  res.writeHead(status, headers);
  res.end(body);
}

function respondJson(res: http.ServerResponse, payload: object): void {
  respond(res, 200, JSON.stringify(payload), { 'Content-Type': 'application/json' });
}

function readBody(req: http.IncomingMessage): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        resolve(null);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
