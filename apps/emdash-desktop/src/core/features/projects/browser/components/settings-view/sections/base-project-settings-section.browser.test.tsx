import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getProjectsWireClient } from '@core/features/projects/api/browser/client';
import { setClientModeForTesting } from '@core/primitives/client-mode/browser/client-mode';
import { setHostPlatformForTesting } from '@core/primitives/client-mode/browser/host-platform';
import type { ProjectPlacementDomainSnapshot } from '../../../../api/project-settings-page';
import { BaseProjectSettingsSection } from './base-project-settings-section';

const mocks = vi.hoisted(() => ({
  openSelectDirectoryDialog: vi.fn(),
  getPlatform: vi.fn(),
  openDirectorySelectorModal: vi.fn(),
}));

vi.mock('@core/features/projects/api/browser/effective-settings/use-effective-settings', () => ({
  useEffectiveSettingsInputs: () => null,
  resolveRendererEffectiveSettings: vi.fn(),
}));

vi.mock('@core/features/projects/api/browser/stores/project-selectors', () => ({
  getProjectStore: () => undefined,
  projectData: () => null,
}));

vi.mock('@core/features/projects/api/browser/client', () => ({
  getProjectsWireClient: vi.fn(),
}));

vi.mock('@core/features/projects/contributions/browser/settings-provenance', () => ({
  BrokenSettingNotice: () => null,
  ProvenanceBadge: () => null,
  ProvenanceSourceLine: () => null,
  ResetProvenanceButton: () => null,
}));

vi.mock('@core/features/source-control/contributions/browser/project-branch-selector', () => ({
  ProjectBranchSelector: () => null,
}));

vi.mock('@core/features/source-control/contributions/browser/remote-selector', () => ({
  RemoteSelector: () => null,
}));

vi.mock('./integration-accounts-section', () => ({
  IntegrationAccountsSection: () => null,
}));

vi.mock('@core/manifests/browser/modal-api', () => ({
  useOpenModal: () => mocks.openDirectorySelectorModal,
}));

vi.mock('@core/primitives/desktop-host/browser/host-client', () => ({
  getHostClient: async () => ({
    openSelectDirectoryDialog: mocks.openSelectDirectoryDialog,
    getPlatform: mocks.getPlatform,
  }),
}));

vi.mock('@core/primitives/keybindings/api', () => ({
  detectPlatformContext: () => ({ os: 'mac' }),
}));

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

const placement = {
  stored: {},
  layers: {
    hostWorktreeRoot: null,
    builtInWorktreeRoot: '~/worktrees',
    hostTmux: null,
    appDefaultTmux: false,
  },
  resolved: {
    worktreeRoot: { value: '~/worktrees', provenance: { kind: 'inferred', from: 'app default' } },
    tmux: { value: false, provenance: { kind: 'inferred', from: 'app default' } },
  },
} as unknown as ProjectPlacementDomainSnapshot;

const TMUX_ON = 'Run the agent session inside a tmux session.';
const TMUX_OFF = 'tmux is unavailable for local Windows sessions';

describe('BaseProjectSettingsSection on a local project', () => {
  let container: HTMLDivElement;
  let root: Root;
  const updatePlacement = vi.fn();

  beforeEach(async () => {
    vi.clearAllMocks();
    setHostPlatformForTesting(undefined);
    mocks.getPlatform.mockResolvedValue('win32');
    mocks.openSelectDirectoryDialog.mockResolvedValue('/Users/me/worktrees');
    mocks.openDirectorySelectorModal.mockResolvedValue({
      success: true,
      data: { path: '/home/dev/worktrees' },
    });
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    setClientModeForTesting(undefined);
    setHostPlatformForTesting(undefined);
  });

  async function renderSection() {
    await act(async () =>
      root.render(
        <BaseProjectSettingsSection
          projectId="project-1"
          gitIdentityForm={{
            defaultBranch: null,
            baseRemote: '',
            pushRemote: '',
            agentGitCredentials: 'effective-account',
          }}
          integrationAccountsForm={{}}
          placementForm={{ tmux: undefined, worktreeDirectory: '/start' }}
          placement={placement}
          projectType="local"
          remotes={[]}
          worktreeDirectoryError={null}
          updateGitIdentity={vi.fn()}
          updateIntegrationAccounts={vi.fn()}
          updatePlacement={updatePlacement}
          hostActionReason={null}
          hostObservationKind="fresh"
        />
      )
    );
  }

  async function browse() {
    const button = [...container.querySelectorAll('button')].find((candidate) =>
      candidate.textContent?.includes('Browse')
    );
    await act(async () => button!.click());
    await vi.waitFor(() => expect(updatePlacement).toHaveBeenCalled());
  }

  it('uses the native dialog and this computer in local mode', async () => {
    setClientModeForTesting(false);
    await renderSection();

    expect(container.textContent).toContain(TMUX_ON);
    await browse();

    expect(mocks.openSelectDirectoryDialog).toHaveBeenCalledWith({
      title: 'Select worktree root',
      message: 'Choose the directory where worktrees should be created.',
      defaultPath: '/start',
    });
    expect(mocks.openDirectorySelectorModal).not.toHaveBeenCalled();
    expect(updatePlacement).toHaveBeenCalledWith('worktreeDirectory', '/Users/me/worktrees');
    expect(mocks.getPlatform).not.toHaveBeenCalled();
  });

  it("browses the host's folders and follows its platform in client mode", async () => {
    setClientModeForTesting(true);
    await renderSection();

    await vi.waitFor(() => expect(container.textContent).toContain(TMUX_OFF));
    await browse();

    expect(mocks.openSelectDirectoryDialog).not.toHaveBeenCalled();
    expect(mocks.openDirectorySelectorModal).toHaveBeenCalledWith({
      strategy: 'local',
      initialPath: '/start',
      getProjectsClient: getProjectsWireClient,
    });
    expect(updatePlacement).toHaveBeenCalledWith('worktreeDirectory', '/home/dev/worktrees');
  });
});
