import type { AgentProviderId } from '@emdash/plugins/agents/types';
import { useEffect, useMemo, useState } from 'react';
import { hostRefFromConnectionId } from '@core/features/agents/api/browser/client';
import { useAgents } from '@core/features/agents/api/browser/use-agents';
import {
  DEFAULT_CRON_STATE,
  toCron,
} from '@core/features/automations/browser/CronPicker/cron-utils';
import {
  asAvailableProject,
  firstAvailableProjectId,
  getProjectSshConnectionId,
  getProjectStore,
  projectData,
} from '@core/features/projects/api/browser/stores/project-selectors';
import { useProjectGitContext } from '@core/features/tasks/api/browser/create-task-modal/use-project-git-context';
import { useTaskName } from '@core/features/tasks/api/browser/create-task-modal/use-task-name';
import {
  useWorkspaceConfig,
  type WorkspaceConfigInitial,
} from '@core/features/tasks/api/browser/create-task-modal/use-workspace-config';
import { useInitialConversationState } from '@core/features/tasks/contributions/browser/task-config/initial-conversation-section';
import { agentSupportsAcp, agentSupportsInitialPromptDelivery } from '@core/primitives/agents/api';
import type { Automation } from '@core/primitives/automations/api';
import type { StoredAutomationTaskConfig, TriggerConfig } from '@core/primitives/automations/api';
import { getLocalTimeZone } from '@core/primitives/automations/api';
import {
  automationEffortOptions,
  buildAutomationConversationConfig,
  resolveAutomationEffort,
  runOptionsFromConversationConfig,
  type AutomationRunOptions,
} from './automation-run-options';
import type { BuiltinAutomationTemplate } from './automation-template';

const DEFAULT_CRON = toCron(DEFAULT_CRON_STATE);

/**
 * Derives the initial workspace config state for seeding the form from a stored automation.
 */
function workspaceInitialFromConfig(
  config: StoredAutomationTaskConfig | null | undefined
): WorkspaceConfigInitial {
  if (!config) return { mode: 'new-worktree', presetId: 'new-worktree' };
  const { git, workspace } = config.workspaceConfig;

  if (git.kind === 'create-branch') {
    return {
      mode: 'new-worktree',
      presetId: 'new-worktree',
      branchSelection: {
        createBranchAndWorktree: true,
        branchOverride: git.fromBranch,
        pushBranch: git.pushBranch,
      },
    };
  }

  if (git.kind === 'use-branch') {
    return {
      mode: 'new-worktree',
      presetId: 'new-worktree',
      branchSelection: {
        createBranchAndWorktree: false,
        branchOverride: { type: 'local', branch: git.branchName },
      },
    };
  }

  if (git.kind === 'none') {
    if (workspace.kind === 'repository-instance') {
      return {
        mode: 'existing',
        presetId: 'use-existing',
        selectedWorkspaceId: workspace.workspaceId,
      };
    }
    // repo-root or unknown
    return { mode: 'existing', presetId: 'repo-root' };
  }

  return { mode: 'new-worktree', presetId: 'new-worktree' };
}

export type AutomationFormState = ReturnType<typeof useAutomationFormState>;

export function useAutomationFormState(
  seed?: Automation,
  initialTemplate?: BuiltinAutomationTemplate
) {
  const seedTrigger = seed?.triggerConfig;
  const seedConversationConfig = seed?.conversationConfig;
  const seedConfig = seed?.taskConfig;
  const seedPrompt =
    seedConversationConfig?.prompt ?? initialTemplate?.defaultConversationConfig.initialPrompt;

  const [name, setName] = useState(seed?.name ?? initialTemplate?.name ?? '');
  const [projectId, setProjectId] = useState<string | undefined>(
    seed?.projectId ?? firstAvailableProjectId()
  );
  const [cronExpr, setCronExpr] = useState<string>(
    seedTrigger?.expr ?? initialTemplate?.defaultTrigger.expr ?? DEFAULT_CRON
  );
  const [cronTz] = useState<string>(seedTrigger?.tz ?? getLocalTimeZone());
  const [onDemand, setOnDemand] = useState<boolean>(seedTrigger?.onDemand !== undefined);
  // Effort, close-when-done and its timeout. Seeded from the stored automation, so one saved
  // before these existed opens with all three empty.
  const [seedRunOptions] = useState(() => runOptionsFromConversationConfig(seedConversationConfig));
  const [effort, setEffort] = useState<string | null>(seedRunOptions.effort);
  const [closeWhenDone, setCloseWhenDone] = useState(seedRunOptions.closeWhenDone);
  const [closeTimeoutMinutes, setCloseTimeoutMinutes] = useState<number | null>(
    seedRunOptions.closeTimeoutMinutes
  );

  const effectiveProjectId =
    projectId && asAvailableProject(getProjectStore(projectId))
      ? projectId
      : firstAvailableProjectId();

  // Validate the seeded provider against the project's host, not the local machine.
  const connectionId = effectiveProjectId
    ? getProjectSshConnectionId(effectiveProjectId)
    : undefined;
  const { data: agents } = useAgents(hostRefFromConnectionId(connectionId));

  const seedProvider = agents?.some((agent) => agent.id === seedConversationConfig?.provider)
    ? (seedConversationConfig?.provider as AgentProviderId)
    : undefined;

  const seedModel = seedConversationConfig?.model ?? undefined;

  const initialConversation = useInitialConversationState(effectiveProjectId, seedProvider, false, {
    resetPromptOnProjectChange: false,
  });

  const [promptSeeded, setPromptSeeded] = useState(false);
  if (!promptSeeded && seedPrompt) {
    setPromptSeeded(true);
    initialConversation.setPrompt(seedPrompt);
  }

  const [modelSeeded, setModelSeeded] = useState(false);
  if (!modelSeeded && seedModel) {
    setModelSeeded(true);
    initialConversation.setModel(seedModel);
  }

  const seedType = seedConversationConfig?.type;
  const [chatUiSeeded, setChatUiSeeded] = useState(false);
  if (!chatUiSeeded && seedType === 'acp') {
    setChatUiSeeded(true);
    initialConversation.setUseChatUi(true);
  }

  const { defaultBranch, isUnborn, hasRepository, currentBranch, repositoryWorkspaceId } =
    useProjectGitContext(effectiveProjectId);

  // Derive initial workspace config state from stored automation (for edit mode).
  const wsInitial = useMemo(() => workspaceInitialFromConfig(seedConfig), [seedConfig]);

  const taskName = useTaskName({
    generatedName: seedConfig?.taskConfig.name,
    resetKey: effectiveProjectId,
  });

  const workspaceConfig = useWorkspaceConfig({
    projectId: effectiveProjectId,
    defaultBranch,
    isUnborn,
    hasRepository,
    currentBranch,
    repositoryWorkspaceId,
    pr: null, // automations don't link PRs
    taskName: taskName.effectiveTaskName || name,
    linkedIssue: null,
    createBranchAndWorktreeDefault: wsInitial.mode === 'new-worktree',
    resetKey: effectiveProjectId,
    initial: wsInitial,
  });

  const prompt = initialConversation.prompt;
  const provider = initialConversation.provider;
  const model = initialConversation.model;
  const useChatUi = initialConversation.useChatUi;
  const setUseChatUi = initialConversation.setUseChatUi;
  const selectedAgent = provider ? agents?.find((agent) => agent.id === provider) : null;
  const selectedCapabilities = selectedAgent?.capabilities;
  // Effort levels belong to the agent. Once the agent is known, an effort it does not offer
  // (the agent was switched, or it dropped the level) falls back to the agent default.
  const effortOptions = automationEffortOptions(selectedCapabilities);
  if (selectedAgent && effort !== resolveAutomationEffort(effort, effortOptions)) {
    setEffort(null);
  }
  const providerSupportsAutomationPrompt =
    !provider ||
    !agents ||
    !selectedCapabilities ||
    agentSupportsInitialPromptDelivery(selectedCapabilities) ||
    agentSupportsAcp(selectedCapabilities);
  const shouldForceChatUi =
    Boolean(selectedCapabilities) &&
    !agentSupportsInitialPromptDelivery(selectedCapabilities) &&
    agentSupportsAcp(selectedCapabilities);

  useEffect(() => {
    if (shouldForceChatUi && !useChatUi) {
      setUseChatUi(true);
    }
  }, [setUseChatUi, shouldForceChatUi, useChatUi]);

  const canSave =
    name.trim().length > 0 &&
    prompt.trim().length > 0 &&
    !!provider &&
    providerSupportsAutomationPrompt &&
    !!effectiveProjectId &&
    workspaceConfig.isValid;

  function buildTaskConfig(targetProjectId: string): StoredAutomationTaskConfig | null {
    const effectiveRepoWsId =
      projectData(getProjectStore(targetProjectId))?.repositoryWorkspaceId ?? null;

    // Re-resolve with the target project's repositoryWorkspaceId in case it differs.
    // For most cases effectiveProjectId === targetProjectId so workspaceConfig.resolvedConfig is correct.
    // We only need to patch if mode=existing/repo-root and the workspace ID is project-specific.
    const wsConfig = workspaceConfig.resolvedConfig;

    // Patch repository-instance workspace if target project differs.
    const patchedConfig =
      wsConfig.workspace.kind === 'repository-instance' && effectiveRepoWsId
        ? {
            ...wsConfig,
            workspace: { kind: 'repository-instance' as const, workspaceId: effectiveRepoWsId },
          }
        : wsConfig;

    const result: StoredAutomationTaskConfig = {
      version: '1',
      taskConfig: {
        version: '1',
        name: taskName.effectiveTaskName?.trim() || name.trim(),
        linkedIssue: seedConfig?.taskConfig.linkedIssue,
        initialStatus: seedConfig?.taskConfig.initialStatus,
      },
      workspaceConfig: patchedConfig,
    };

    // Strip MobX Proxy wrappers (e.g. fromBranch coming from getGitRepositoryStore)
    // before the value crosses the Electron contextBridge. The structured clone
    // algorithm rejects Proxy objects with a DataCloneError.
    return JSON.parse(JSON.stringify(result)) as StoredAutomationTaskConfig;
  }

  // The schedule is kept while on demand so switching back restores it.
  const triggerConfig: TriggerConfig = {
    expr: cronExpr.trim(),
    tz: cronTz,
    ...(onDemand && { onDemand: seedTrigger?.onDemand ?? {} }),
  };

  /**
   * The conversation config to save. `runOptions` overrides the form's own effort and
   * close-when-done values, for a caller saving in the same tick as it changes one.
   */
  function buildConversationConfig(
    options: { title?: string; runOptions?: AutomationRunOptions } = {}
  ) {
    if (!provider) throw new Error('Cannot build automation conversation config without provider');
    return buildAutomationConversationConfig({
      prompt,
      provider,
      model,
      useChatUi,
      title: options.title,
      ...(options.runOptions ?? { effort, closeWhenDone, closeTimeoutMinutes }),
    });
  }

  function applyTemplate(template: BuiltinAutomationTemplate) {
    setName(template.name);
    setCronExpr(template.defaultTrigger.expr);
    initialConversation.setPrompt(template.defaultConversationConfig.initialPrompt);
  }

  return {
    name,
    setName,
    projectId,
    setProjectId,
    effectiveProjectId,
    cronExpr,
    setCronExpr,
    cronTz,
    onDemand,
    setOnDemand,
    effort,
    setEffort,
    effortOptions,
    closeWhenDone,
    setCloseWhenDone,
    closeTimeoutMinutes,
    setCloseTimeoutMinutes,
    initialConversation,
    workspaceConfig,
    isUnborn,
    hasRepository,
    currentBranch,
    prompt,
    provider,
    model,
    canSave,
    triggerConfig,
    applyTemplate,
    buildTaskConfig,
    buildConversationConfig,
  };
}
