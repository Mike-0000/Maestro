import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  Automation,
  ConversationConfig,
  StoredAutomationTaskConfig,
  UpdateAutomationPatch,
} from '@core/primitives/automations/api';

const mocks = vi.hoisted(() => ({
  mutateAsync: vi.fn(async (_input: { id: string; patch: unknown }) => undefined),
  agents: [
    {
      id: 'claude',
      name: 'Claude Code',
      capabilities: {
        acp: { kind: 'supported' },
        prompt: { kind: 'argv' },
        effort: {
          kind: 'selectable',
          effortOptions: {
            low: { label: 'Low', level: 1 },
            medium: { label: 'Medium', level: 2 },
            high: { label: 'High', level: 3 },
            xhigh: { label: 'Extra high', level: 4 },
            max: { label: 'Max', level: 5 },
          },
        },
      },
    },
    {
      id: 'codex',
      name: 'Codex',
      capabilities: {
        acp: { kind: 'supported' },
        prompt: { kind: 'argv' },
        effort: { kind: 'none' },
      },
    },
  ],
  workspaceConfig: {
    git: { kind: 'none' },
    workspace: { kind: 'repo-root' },
  },
}));

vi.mock('@core/features/agents/api/browser/client', () => ({
  hostRefFromConnectionId: () => ({ kind: 'local' }),
}));
vi.mock('@core/features/agents/api/browser/use-agents', () => ({
  useAgents: () => ({ data: mocks.agents }),
}));
vi.mock('@core/features/projects/api/browser/stores/project-selectors', () => ({
  asAvailableProject: (store: unknown) => store,
  firstAvailableProjectId: () => 'project-1',
  getProjectSshConnectionId: () => undefined,
  getProjectStore: () => ({}),
  projectData: () => ({ repositoryWorkspaceId: null }),
}));
vi.mock('@core/features/tasks/api/browser/create-task-modal/use-project-git-context', () => ({
  useProjectGitContext: () => ({
    defaultBranch: 'main',
    isUnborn: false,
    hasRepository: true,
    currentBranch: 'main',
    repositoryWorkspaceId: null,
  }),
}));
vi.mock('@core/features/tasks/api/browser/create-task-modal/use-task-name', () => ({
  useTaskName: (options: { generatedName?: string }) => ({
    effectiveTaskName: options.generatedName ?? '',
  }),
}));
vi.mock('@core/features/tasks/api/browser/create-task-modal/use-workspace-config', () => ({
  useWorkspaceConfig: () => ({ isValid: true, resolvedConfig: mocks.workspaceConfig }),
}));
vi.mock(
  '@core/features/tasks/contributions/browser/task-config/initial-conversation-section',
  async () => {
    const { useState } = await import('react');
    return {
      // The conversation sub-state, reduced to what the automation form reads and writes.
      useInitialConversationState: (_projectId: string | undefined, initialProvider?: string) => {
        const [provider, setProvider] = useState<string | null>(initialProvider ?? null);
        const [prompt, setPrompt] = useState('');
        const [model, setModel] = useState<string | null>(null);
        const [useChatUi, setUseChatUi] = useState(false);
        return {
          provider,
          setProvider,
          prompt,
          setPrompt,
          model,
          setModel,
          useChatUi,
          setUseChatUi,
        };
      },
    };
  }
);
vi.mock('./use-automations', () => ({
  useUpdateAutomation: () => ({ mutateAsync: mocks.mutateAsync, isPending: false, error: null }),
  useAutomationTargetAvailability: () => ({ data: { available: true } }),
}));

import {
  useAutomationSettingsAutoSave,
  type AutomationSettingsAutoSave,
} from './useAutomationSettingsAutoSave';

const taskConfig = {
  version: '1',
  taskConfig: { version: '1', name: 'Nightly research' },
  workspaceConfig: mocks.workspaceConfig,
} as unknown as StoredAutomationTaskConfig;

function automationWith(conversationConfig: ConversationConfig): Automation {
  return {
    id: 'automation-1',
    projectId: 'project-1',
    name: 'Nightly research',
    triggerConfig: { expr: '0 9 * * *', tz: 'UTC' },
    conversationConfig,
    taskConfig,
    enabled: true,
    revision: 1,
    createdAt: 0,
    updatedAt: 0,
  };
}

/** An automation saved before effort and close-when-done existed. */
const legacyConfig: ConversationConfig = {
  prompt: 'Research the topic and write a report',
  provider: 'claude',
  autoApprove: false,
  type: 'pty',
  model: 'opus',
  title: 'Research',
};

let host: HTMLDivElement;
let root: Root;
let autoSave: AutomationSettingsAutoSave;

function Harness({ automation }: { automation: Automation }) {
  autoSave = useAutomationSettingsAutoSave(automation);
  return null;
}

async function mount(conversationConfig: ConversationConfig) {
  await act(async () => {
    root.render(<Harness automation={automationWith(conversationConfig)} />);
  });
}

function savedPatches(): UpdateAutomationPatch[] {
  return mocks.mutateAsync.mock.calls.map(([input]) => input.patch as UpdateAutomationPatch);
}

function lastSavedConversation(): ConversationConfig {
  const patch = savedPatches().at(-1);
  if (!patch?.conversationConfig) throw new Error('Nothing was saved');
  return patch.conversationConfig;
}

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  mocks.mutateAsync.mockClear();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe('useAutomationSettingsAutoSave', () => {
  it('opens an automation without saving anything', async () => {
    await mount(legacyConfig);
    expect(mocks.mutateAsync).not.toHaveBeenCalled();
    expect(autoSave.formState.effort).toBeNull();
    expect(autoSave.formState.closeWhenDone).toBe(false);
    expect(autoSave.formState.closeTimeoutMinutes).toBeNull();
  });

  it('saves an older automation with exactly the conversation config it had', async () => {
    await mount(legacyConfig);

    await act(async () => autoSave.handlePromptBlur());
    await act(async () => autoSave.setCronExpr('30 8 * * *'));
    await act(async () => autoSave.setOnDemand(true));

    const patches = savedPatches();
    expect(patches).toHaveLength(3);
    for (const patch of patches) {
      expect(patch.conversationConfig).toEqual(legacyConfig);
      expect(Object.keys(patch.conversationConfig ?? {}).sort()).toEqual(
        Object.keys(legacyConfig).sort()
      );
    }
  });

  it('saves the chosen effort where it changes, and keeps it on later saves', async () => {
    await mount(legacyConfig);

    await act(async () => autoSave.setEffort('max'));
    expect(lastSavedConversation()).toEqual({ ...legacyConfig, effort: 'max' });
    expect(autoSave.formState.effort).toBe('max');

    await act(async () => autoSave.handlePromptBlur());
    expect(lastSavedConversation().effort).toBe('max');
  });

  it('never writes an older effort over a newer one from a handler not yet re-rendered', async () => {
    await mount(legacyConfig);

    // Both calls run on the same render's handlers, as a blur in the tick of a pick would.
    await act(async () => {
      const stale = autoSave;
      stale.setEffort('high');
      stale.handlePromptBlur();
    });

    expect(savedPatches()).toHaveLength(2);
    for (const patch of savedPatches()) {
      expect(patch.conversationConfig?.effort).toBe('high');
    }
  });

  it('drops the effort again when Default is picked', async () => {
    await mount({ ...legacyConfig, effort: 'max' });
    expect(autoSave.formState.effort).toBe('max');

    await act(async () => autoSave.setEffort(null));
    expect(lastSavedConversation()).toEqual(legacyConfig);
    expect(Object.keys(lastSavedConversation())).not.toContain('effort');
  });

  it('saves close-when-done as an empty object, then with the time limit, then not at all', async () => {
    await mount(legacyConfig);

    await act(async () => autoSave.setCloseWhenDone(true));
    expect(lastSavedConversation()).toEqual({ ...legacyConfig, closeWhenDone: {} });

    await act(async () => autoSave.setCloseTimeoutMinutes(390));
    expect(lastSavedConversation()).toEqual({
      ...legacyConfig,
      closeWhenDone: { timeoutMinutes: 390 },
    });

    await act(async () => autoSave.setCloseTimeoutMinutes(null));
    expect(lastSavedConversation()).toEqual({ ...legacyConfig, closeWhenDone: {} });

    await act(async () => autoSave.setCloseWhenDone(false));
    expect(lastSavedConversation()).toEqual(legacyConfig);
    expect(Object.keys(lastSavedConversation())).not.toContain('closeWhenDone');
  });

  it('keeps a stored effort and close-when-done on unrelated saves', async () => {
    const stored: ConversationConfig = {
      ...legacyConfig,
      effort: 'xhigh',
      closeWhenDone: { timeoutMinutes: 45 },
    };
    await mount(stored);

    await act(async () => autoSave.setCronExpr('0 6 * * 1'));
    expect(lastSavedConversation()).toEqual(stored);
  });

  it('keeps close-when-done stored while on demand, so turning it off restores it', async () => {
    const stored: ConversationConfig = { ...legacyConfig, closeWhenDone: {} };
    await mount(stored);

    await act(async () => autoSave.setOnDemand(true));
    expect(lastSavedConversation()).toEqual(stored);
  });

  it('resets the effort when the agent changes to one that does not offer it', async () => {
    await mount({ ...legacyConfig, effort: 'max' });

    await act(async () => autoSave.formState.initialConversation.setProvider('codex'));

    expect(autoSave.formState.effort).toBeNull();
    expect(autoSave.formState.effortOptions).toBeNull();
    const saved = lastSavedConversation();
    expect(saved.provider).toBe('codex');
    expect(Object.keys(saved)).not.toContain('effort');
  });

  it('offers the agent effort levels lowest first', async () => {
    await mount(legacyConfig);
    expect(autoSave.formState.effortOptions?.map((option) => option.id)).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ]);
  });
});
