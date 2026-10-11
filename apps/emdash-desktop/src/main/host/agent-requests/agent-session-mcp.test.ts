import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const paths = vi.hoisted(() => ({ userData: '' }));
const settings = vi.hoisted(() => ({ enabled: true, agentControl: true }));

vi.mock('electron', () => ({ app: { getPath: () => paths.userData } }));
vi.mock('@main/bootstrap/core/service-instances', () => ({
  getAppSettingsService: () => ({ get: async () => ({ ...settings }) }),
}));
vi.mock('@core/features/browser/node', () => ({ browserEvents: { emit: vi.fn() } }));
vi.mock('@core/features/preview-servers/api/node/preview-server-service-instance', () => ({
  previewServerService: { listForWorkspace: () => [] },
}));
vi.mock('@core/features/conductor/node/agent-request-hub', () => ({
  agentRequestHub: { submit: vi.fn() },
}));
vi.mock('@main/host/browser/browser-webcontents-registry', () => ({
  browserWebContentsRegistry: {
    getPartition: () => null,
    getBoundWebContents: () => null,
    onBinding: () => () => {},
  },
}));

const { browserControlServer } = await import('@main/host/browser/browser-control-instance');
const { agentRequestServer, resolveAgentSessionMcp, resolveAgentSessionMcpServers } =
  await import('./agent-session-mcp');

const context = {
  conversationId: 'conv/1',
  projectId: 'p1',
  workspaceId: 'w1',
  taskId: 't1',
  title: 'Nova',
};

async function resolveSession() {
  const resolved = await resolveAgentSessionMcp(context);
  if (!resolved) throw new Error('expected session MCP servers');
  return resolved;
}

describe('agent session MCP servers', () => {
  beforeAll(async () => {
    paths.userData = await mkdtemp(join(tmpdir(), 'chorus-agent-mcp-'));
  });

  afterAll(async () => {
    browserControlServer.stop();
    agentRequestServer.stop();
    await rm(paths.userData, { recursive: true, force: true });
  });

  it('writes one private file with both servers and hands each token over by env var', async () => {
    const { sessionMcp, env } = await resolveSession();
    const browserUrl = `http://127.0.0.1:${browserControlServer.listeningPort}/mcp`;
    const conductorUrl = `http://127.0.0.1:${agentRequestServer.listeningPort}/mcp`;

    expect(sessionMcp.configPath).toBe(join(paths.userData, 'chorus', 'agent-mcp', 'conv_1.json'));
    expect(sessionMcp.servers).toEqual([
      { name: 'chorus-browser', url: browserUrl, tokenEnvVar: 'CHORUS_BROWSER_MCP_TOKEN' },
      { name: 'maestro', url: conductorUrl, tokenEnvVar: 'MAESTRO_CONDUCTOR_MCP_TOKEN' },
    ]);
    expect(Object.keys(env).sort()).toEqual([
      'CHORUS_BROWSER_MCP_TOKEN',
      'MAESTRO_CONDUCTOR_MCP_TOKEN',
    ]);
    expect(env.CHORUS_BROWSER_MCP_TOKEN).toMatch(/^chorus_bt_[a-f0-9]{48}$/);
    expect(env.MAESTRO_CONDUCTOR_MCP_TOKEN).toMatch(/^maestro_at_[a-f0-9]{48}$/);

    const config = JSON.parse(await readFile(sessionMcp.configPath, 'utf8'));
    expect(config).toEqual({
      mcpServers: {
        'chorus-browser': {
          type: 'http',
          url: browserUrl,
          headers: { Authorization: `Bearer ${env.CHORUS_BROWSER_MCP_TOKEN}` },
        },
        maestro: {
          type: 'http',
          url: conductorUrl,
          headers: { Authorization: `Bearer ${env.MAESTRO_CONDUCTOR_MCP_TOKEN}` },
        },
      },
    });
    if (process.platform !== 'win32') {
      expect((await stat(sessionMcp.configPath)).mode & 0o077).toBe(0);
    }
  });

  it('keeps the conductor server, and the file, when agent control is turned off', async () => {
    const first = await resolveSession();
    settings.agentControl = false;
    try {
      const { sessionMcp, env } = await resolveSession();

      expect(sessionMcp.configPath).toBe(first.sessionMcp.configPath);
      expect(sessionMcp.servers).toEqual([
        {
          name: 'maestro',
          url: `http://127.0.0.1:${agentRequestServer.listeningPort}/mcp`,
          tokenEnvVar: 'MAESTRO_CONDUCTOR_MCP_TOKEN',
        },
      ]);
      // Same conversation, same task: the conductor token is not rotated.
      expect(env).toEqual({
        MAESTRO_CONDUCTOR_MCP_TOKEN: first.env.MAESTRO_CONDUCTOR_MCP_TOKEN,
      });
      const config = JSON.parse(await readFile(sessionMcp.configPath, 'utf8'));
      expect(Object.keys(config.mcpServers)).toEqual(['maestro']);
      expect(JSON.stringify(config)).not.toContain('chorus_bt_');
    } finally {
      settings.agentControl = true;
    }
  });

  it('gives ACP sessions the browser server first, then the conductor', async () => {
    const servers = await resolveAgentSessionMcpServers(context);
    expect(servers.map((server) => server.name)).toEqual(['chorus-browser', 'maestro']);
    expect(servers[1]?.headers?.Authorization).toMatch(/^Bearer maestro_at_[a-f0-9]{48}$/);

    settings.enabled = false;
    try {
      const withoutBrowser = await resolveAgentSessionMcpServers(context);
      expect(withoutBrowser.map((server) => server.name)).toEqual(['maestro']);
    } finally {
      settings.enabled = true;
    }
  });

  it('keeps the browser tools when the conductor server cannot register', async () => {
    const register = vi
      .spyOn(agentRequestServer, 'register')
      .mockRejectedValue(new Error('listen EADDRINUSE'));
    try {
      const { sessionMcp, env } = await resolveSession();
      expect(sessionMcp.servers.map((server) => server.name)).toEqual(['chorus-browser']);
      expect(Object.keys(env)).toEqual(['CHORUS_BROWSER_MCP_TOKEN']);

      settings.enabled = false;
      // Nothing to hand over: no session MCP, and no stale file with old tokens.
      expect(await resolveAgentSessionMcp(context)).toBeUndefined();
      await expect(stat(sessionMcp.configPath)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      settings.enabled = true;
      register.mockRestore();
    }
  });
});
