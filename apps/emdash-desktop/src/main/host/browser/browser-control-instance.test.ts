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
vi.mock('./browser-webcontents-registry', () => ({
  browserWebContentsRegistry: {
    getPartition: () => null,
    getBoundWebContents: () => null,
    onBinding: () => () => {},
  },
}));

const { browserControlServer, resolveBrowserControlSessionMcp } =
  await import('./browser-control-instance');

const context = {
  conversationId: 'conv/1',
  projectId: 'p1',
  workspaceId: 'w1',
  taskId: 't1',
  title: 'Nova',
};

describe('resolveBrowserControlSessionMcp', () => {
  beforeAll(async () => {
    paths.userData = await mkdtemp(join(tmpdir(), 'chorus-agent-mcp-'));
  });

  afterAll(async () => {
    browserControlServer.stop();
    await rm(paths.userData, { recursive: true, force: true });
  });

  it('writes a private per-session MCP file and hands the token over by env var', async () => {
    const resolved = await resolveBrowserControlSessionMcp(context);
    if (!resolved) throw new Error('expected browser tools');
    const { sessionMcp, env } = resolved;

    expect(sessionMcp.configPath).toBe(join(paths.userData, 'chorus', 'agent-mcp', 'conv_1.json'));
    expect(sessionMcp.servers).toEqual([
      {
        name: 'chorus-browser',
        url: `http://127.0.0.1:${browserControlServer.listeningPort}/mcp`,
        tokenEnvVar: 'CHORUS_BROWSER_MCP_TOKEN',
      },
    ]);
    expect(env.CHORUS_BROWSER_MCP_TOKEN).toMatch(/^chorus_bt_[a-f0-9]{48}$/);

    const config = JSON.parse(await readFile(sessionMcp.configPath, 'utf8'));
    expect(config).toEqual({
      mcpServers: {
        'chorus-browser': {
          type: 'http',
          url: sessionMcp.servers[0]?.url,
          headers: { Authorization: `Bearer ${env.CHORUS_BROWSER_MCP_TOKEN}` },
        },
      },
    });
    if (process.platform !== 'win32') {
      expect((await stat(sessionMcp.configPath)).mode & 0o077).toBe(0);
    }
  });

  it('revokes the token and removes the file when agent control is turned off', async () => {
    const first = await resolveBrowserControlSessionMcp(context);
    if (!first) throw new Error('expected browser tools');
    settings.agentControl = false;
    try {
      expect(await resolveBrowserControlSessionMcp(context)).toBeUndefined();
      await expect(stat(first.sessionMcp.configPath)).rejects.toThrow();
    } finally {
      settings.agentControl = true;
    }
  });
});
