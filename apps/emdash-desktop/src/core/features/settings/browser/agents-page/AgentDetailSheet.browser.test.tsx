import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { setClientModeForTesting } from '@core/primitives/client-mode/browser/client-mode';
import { setHostPlatformForTesting } from '@core/primitives/client-mode/browser/host-platform';
import { AgentDetailSheet } from './AgentDetailSheet';

const mocks = vi.hoisted(() => ({
  installedAgentContent: vi.fn((_props: { showWsl: boolean }) => null),
  getPlatform: vi.fn(),
}));

vi.mock('@emdash/ui/react/primitives', async () => {
  const { createElement } = await import('react');
  const Container = ({ children }: { children?: React.ReactNode }) =>
    createElement('div', null, children);
  return {
    Sheet: {
      Root: Container,
      Content: Container,
      Header: Container,
      Title: Container,
      Body: Container,
    },
  };
});

vi.mock('@core/features/agents/api/browser/client', () => ({
  hostRefFromConnectionId: () => ({ kind: 'local' }),
}));

vi.mock('@core/features/agents/api/browser/use-agent-settings', () => ({
  useAgentSettings: () => ({
    value: {},
    isOverridden: false,
    isLoading: false,
    update: vi.fn(),
    reset: vi.fn(),
  }),
}));

vi.mock('@core/features/agents/api/browser/use-agents', () => ({
  useAgents: () => ({ data: [{ id: 'claude', name: 'Claude', status: 'available' }] }),
}));

vi.mock('@core/features/settings/browser/agents-page/AgentIntegrationSection', () => ({
  AgentHooksSection: () => null,
  AgentTrustSection: () => null,
}));

vi.mock('@core/features/settings/browser/agents-page/AgentMcpSection', () => ({
  AgentMcpSection: () => null,
  useManageMcpSettingsNavigation: () => vi.fn(),
}));

vi.mock('@core/features/settings/browser/agents-page/AgentSheetHeaderSection', () => ({
  AgentSheetHeaderSection: () => null,
}));

vi.mock('@core/features/settings/browser/agents-page/InstalledAgentContent', () => ({
  InstalledAgentContent: mocks.installedAgentContent,
}));

vi.mock('@core/features/settings/contributions/browser/agents-page/InstallSection', () => ({
  InstallSection: () => null,
}));

vi.mock('@core/primitives/desktop-host/browser/host-client', () => ({
  getHostClient: async () => ({ getPlatform: mocks.getPlatform }),
}));

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

describe('AgentDetailSheet WSL option', () => {
  let host: HTMLDivElement;
  let root: Root;

  function setUserAgent(value: string) {
    Object.defineProperty(navigator, 'userAgent', { value, configurable: true });
  }

  function lastShowWsl(): boolean | undefined {
    return mocks.installedAgentContent.mock.lastCall?.[0].showWsl;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    setHostPlatformForTesting(undefined);
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    Reflect.deleteProperty(navigator, 'userAgent');
    setClientModeForTesting(undefined);
    setHostPlatformForTesting(undefined);
  });

  it('follows this computer in local mode', async () => {
    setClientModeForTesting(false);
    setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64)');

    await act(async () => root.render(<AgentDetailSheet agentId="claude" onClose={vi.fn()} />));

    expect(lastShowWsl()).toBe(true);
    expect(mocks.getPlatform).not.toHaveBeenCalled();
  });

  it('follows the remote host in client mode', async () => {
    setClientModeForTesting(true);
    setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)');
    mocks.getPlatform.mockResolvedValue('win32');

    await act(async () => root.render(<AgentDetailSheet agentId="claude" onClose={vi.fn()} />));

    await vi.waitFor(() => expect(lastShowWsl()).toBe(true));
  });

  it('hides WSL for a non-Windows host even on a Windows client', async () => {
    setClientModeForTesting(true);
    setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64)');
    setHostPlatformForTesting('linux');

    await act(async () => root.render(<AgentDetailSheet agentId="claude" onClose={vi.fn()} />));

    expect(lastShowWsl()).toBe(false);
  });
});
