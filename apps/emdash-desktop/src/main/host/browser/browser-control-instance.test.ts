import { afterAll, describe, expect, it, vi } from 'vitest';

const settings = vi.hoisted(() => ({ enabled: true, agentControl: true }));

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

const { browserControlServer, resolveBrowserControlMcpServers } =
  await import('./browser-control-instance');

const context = {
  conversationId: 'conv/1',
  projectId: 'p1',
  workspaceId: 'w1',
  taskId: 't1',
  title: 'Nova',
};

describe('resolveBrowserControlMcpServers', () => {
  afterAll(() => browserControlServer.stop());

  it('registers the conversation with the browser control server', async () => {
    expect(await resolveBrowserControlMcpServers(context)).toEqual([
      {
        name: 'chorus-browser',
        url: `http://127.0.0.1:${browserControlServer.listeningPort}/mcp`,
        headers: { Authorization: expect.stringMatching(/^Bearer chorus_bt_[a-f0-9]{48}$/) },
      },
    ]);
  });

  it('offers no server and revokes the token when agent control is turned off', async () => {
    const [first] = await resolveBrowserControlMcpServers(context);
    if (!first) throw new Error('expected browser tools');
    settings.agentControl = false;
    try {
      expect(await resolveBrowserControlMcpServers(context)).toEqual([]);
    } finally {
      settings.agentControl = true;
    }
    // An unchanged scope reuses its token, so a new one means the old one was revoked.
    const [second] = await resolveBrowserControlMcpServers(context);
    expect(second?.headers).not.toEqual(first.headers);
  });
});
