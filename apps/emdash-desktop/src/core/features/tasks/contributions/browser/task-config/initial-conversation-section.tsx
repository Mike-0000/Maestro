import type { AgentProviderId } from '@emdash/plugins/agents/types';
import { ChatComposer } from '@emdash/ui/react/components';
import type { CommandItem, MentionItem, PromptEditorRef } from '@emdash/ui/react/components';
import { Field, Switch } from '@emdash/ui/react/primitives';
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react';
import { hostRefFromConnectionId } from '@core/features/agents/api/browser/client';
import type { AgentDisableReason } from '@core/features/agents/api/browser/components/agent-selector/agent-selector-options';
import { useAgents } from '@core/features/agents/api/browser/use-agents';
import { AgentSelector } from '@core/features/agents/contributions/browser/agent-selector';
import {
  ClaudeAccountSelect,
  type ClaudeAccountPicker,
} from '@core/features/claude-accounts/contributions/browser/claude-account-picker';
import { useEffectiveProvider } from '@core/features/conversations/api/browser/use-effective-provider';
import { IntegrationIcon } from '@core/features/integrations/contributions/browser/integration-icon';
import { usePromptLibrary } from '@core/features/library/api/browser/prompts/use-prompt-library';
import { getProjectSshConnectionId } from '@core/features/projects/api/browser/stores/project-selectors';
import { buildIssueContextText } from '@core/features/tasks/browser/context-bar/context-actions';
import { appendInitialConversationText } from '@core/features/tasks/browser/create-task-modal/initial-conversation-text';
import { usePromptFileDrop } from '@core/features/tasks/browser/create-task-modal/use-prompt-file-drop';
import {
  agentSupportsAcp,
  agentSupportsInitialPromptDelivery,
  agentSupportsAutoApprove,
} from '@core/primitives/agents/api';
import {
  extractIssueMentionTargets,
  issueMentionToken,
  parseIssueMentionToken,
} from '@core/primitives/issues/api';
import type { LinkedIssue } from '@core/primitives/linked-issues/api';
import { useLocalStorage } from '@core/primitives/react-hooks/browser/useLocalStorage';
import { cn } from '@core/primitives/styling/browser/cn';

type RenderMentionIcon = NonNullable<Parameters<typeof ChatComposer>[0]['renderMentionIcon']>;

export type InitialConversationState = {
  provider: AgentProviderId | null;
  setProvider: (provider: AgentProviderId | null) => void;
  projectId?: string;
  prompt: string;
  setPrompt: Dispatch<SetStateAction<string>>;
  issueContext: string | null;
  setIssueContext: (ctx: string | null) => void;
  autoApprove: boolean;
  setAutoApprove: (autoApprove: boolean) => void;
  issueContextEditorOpen: boolean;
  setIssueContextEditorOpen: (open: boolean) => void;
  /** Selected model id, or null to use the agent CLI default. */
  model: string | null;
  setModel: (model: string | null) => void;
  connectionId?: string;
  /** Whether to start this conversation as an ACP chat UI conversation. */
  useChatUi: boolean;
  setUseChatUi: (v: boolean) => void;
  /** Whether the currently selected provider/mode can receive an automated initial prompt. */
  initialPromptSupported: boolean;
  issueMentionContexts: Record<string, string>;
  setIssueMentionContext: (token: string, context: string | null) => void;
};

interface InitialConversationStateOptions {
  resetPromptOnProjectChange?: boolean;
}

export function useInitialConversationState(
  projectId?: string,
  initialProvider?: AgentProviderId,
  autoApproveByDefault = false,
  options: InitialConversationStateOptions = {}
): InitialConversationState {
  const { resetPromptOnProjectChange = true } = options;
  const connectionId = projectId ? getProjectSshConnectionId(projectId) : undefined;
  const { providerId, setProviderOverride } = useEffectiveProvider(connectionId, initialProvider);
  const { data: agents } = useAgents(hostRefFromConnectionId(connectionId));
  const [prompt, setPrompt] = useState('');
  const [issueContext, setIssueContext] = useState<string | null>(null);
  const [autoApprovePreference, setAutoApprovePreference] = useLocalStorage(
    'initial-conversation:auto-approve-enabled',
    autoApproveByDefault
  );
  const [issueContextEditorOpen, setIssueContextEditorOpen] = useState(false);
  const [model, setModel] = useState<string | null>(null);
  const [issueMentionContexts, setIssueMentionContexts] = useState<Record<string, string>>({});
  const [useChatUiPreference, setUseChatUiPreference] = useLocalStorage(
    'initial-conversation:chat-ui-enabled',
    false
  );

  const [prevProjectId, setPrevProjectId] = useState(projectId);
  const [prevProviderId, setPrevProviderId] = useState(providerId);
  const projectChanged = projectId !== prevProjectId;
  const providerChanged = providerId !== prevProviderId;

  if (projectChanged) {
    setPrevProjectId(projectId);
    setProviderOverride(null);
    if (resetPromptOnProjectChange) {
      setPrompt('');
    }
    setIssueContext(null);
    setIssueContextEditorOpen(false);
    setModel(null);
    setIssueMentionContexts({});
  } else if (providerChanged) {
    setPrevProviderId(providerId);
    setModel(null);
  }

  const capabilities = agents?.find((agent) => agent.id === providerId)?.capabilities;
  const autoApproveSupported = agentSupportsAutoApprove(capabilities);
  const autoApprove = autoApproveSupported && autoApprovePreference;
  const acpSupported = agentSupportsAcp(capabilities);
  const useChatUi = acpSupported && useChatUiPreference;
  const initialPromptSupported = useChatUi || agentSupportsInitialPromptDelivery(capabilities);

  return {
    provider: providerId,
    setProvider: setProviderOverride,
    projectId,
    prompt,
    setPrompt,
    issueContext,
    setIssueContext,
    autoApprove,
    setAutoApprove: setAutoApprovePreference,
    issueContextEditorOpen,
    setIssueContextEditorOpen,
    model,
    setModel,
    connectionId,
    useChatUi,
    setUseChatUi: setUseChatUiPreference,
    initialPromptSupported,
    issueMentionContexts,
    setIssueMentionContext: (token, context) =>
      setIssueMentionContexts((current) => {
        if (context === null) {
          const next = { ...current };
          delete next[token];
          return next;
        }
        return { ...current, [token]: context };
      }),
  };
}

function useModelOptions(
  providerId: AgentProviderId | null,
  connectionId: string | undefined
): Record<string, { name: string }> | null {
  const { data: agents } = useAgents(hostRefFromConnectionId(connectionId));
  if (!providerId) return null;
  const models = agents?.find((a) => a.id === providerId)?.capabilities.models;
  return models?.kind === 'selectable' ? models.modelOptions : null;
}

const SLASH_PROMPTS_SECTION = 'Prompts';

function promptPreview(text: string): string {
  return text.split(/\r?\n/, 1)[0] ?? '';
}

function toLinkedIssueMentionItem(issue: LinkedIssue): MentionItem {
  const token = issueMentionToken(issue.provider, issue.identifier, issue);
  return {
    id: token,
    label: token,
    name: issue.displayIdentifier ?? issue.identifier,
    kind: 'issue',
    description: issue.title,
    icon: <IntegrationIcon provider={issue.provider} size={13} />,
  };
}

function promptHasIssueMention(text: string, token: string): boolean {
  return extractIssueMentionTargets(text).some((target) => target.token === token);
}

interface InitialConversationFieldProps {
  state: InitialConversationState;
  linkedIssue?: LinkedIssue;
  includeIssueContextByDefault: boolean;
  onPromptBlur?: () => void;
  placeholder?: string;
  textareaClassName?: string;
  showAutoApproveToggle?: boolean;
  requirePromptDelivery?: boolean;
  /** Offers a Claude account choice when the form supports one and there is one to make. */
  claudeAccount?: ClaudeAccountPicker;
  /** Puts the caret in the prompt once the form opens (the prompt is the form's first field). */
  autoFocus?: boolean;
  /** Resting height of the prompt in lines; it still grows with what is typed. */
  minRows?: number;
}

export function InitialConversationField({
  state,
  linkedIssue,
  includeIssueContextByDefault,
  onPromptBlur,
  placeholder,
  textareaClassName,
  showAutoApproveToggle = true,
  requirePromptDelivery = false,
  claudeAccount,
  autoFocus = false,
  minRows = 3,
}: InitialConversationFieldProps) {
  const claudeAccountSelectId = useId();
  const autoApproveSwitchId = useId();
  const chatUiSwitchId = useId();
  const editorApiRef = useRef<PromptEditorRef | null>(null);
  const syncingEditorTextRef = useRef(false);
  const { value: promptLibrary } = usePromptLibrary();
  const modelOptions = useModelOptions(state.provider, state.connectionId);
  const defaultIssueContext = useMemo(
    () => (linkedIssue ? buildIssueContextText(linkedIssue) : null),
    [linkedIssue]
  );

  // Auto-inject issue context whenever the linked issue changes.
  useEffect(() => {
    state.setIssueContext(includeIssueContextByDefault ? defaultIssueContext : null);
    // oxlint-disable-next-line react/exhaustive-deps
  }, [defaultIssueContext, includeIssueContextByDefault]);

  const { data: agents } = useAgents(hostRefFromConnectionId(state.connectionId));
  const selectedAgent = state.provider
    ? agents?.find((agent) => agent.id === state.provider)
    : null;
  const capabilities = selectedAgent?.capabilities ?? null;
  const canToggleAutoApprove = agentSupportsAutoApprove(capabilities);
  const canToggleChatUi = agentSupportsAcp(capabilities);
  const canDeliverInitialPrompt = state.initialPromptSupported;
  const getDisabledReason = useCallback<AgentDisableReason>(
    (agent) =>
      requirePromptDelivery &&
      !agentSupportsInitialPromptDelivery(agent.capabilities) &&
      !agentSupportsAcp(agent.capabilities)
        ? "Doesn't support automation prompts"
        : null,
    [requirePromptDelivery]
  );
  const initialPromptInfo = !canDeliverInitialPrompt
    ? canToggleChatUi
      ? `${selectedAgent?.name ?? 'This agent'} doesn't support initial prompts in terminal mode. Enable Chat UI to send an initial prompt.`
      : `${selectedAgent?.name ?? 'This agent'} doesn't support initial prompts.`
    : null;

  const { isDragOver, dropHandlers } = usePromptFileDrop({
    // Local paths would not exist on the remote host of an SSH project.
    disableLocalFiles: Boolean(state.connectionId),
    workspaceId: state.projectId,
    onDropText: (text) =>
      state.setPrompt((current) => appendInitialConversationText(current, text)),
  });

  useEffect(() => {
    const editor = editorApiRef.current;
    if (!editor || editor.getText() === state.prompt) return;
    syncingEditorTextRef.current = true;
    try {
      editor.setText(state.prompt);
    } finally {
      syncingEditorTextRef.current = false;
    }
  }, [state.prompt]);

  // The prompt is the form's first field: once it can take text (the agent list has loaded
  // and the agent accepts an initial prompt), put the caret in it. One frame later, so the
  // dialog's own initial focus has settled first.
  const didAutoFocusRef = useRef(false);
  useEffect(() => {
    if (!autoFocus || !canDeliverInitialPrompt || didAutoFocusRef.current) return;
    const frame = requestAnimationFrame(() => {
      didAutoFocusRef.current = true;
      editorApiRef.current?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [autoFocus, canDeliverInitialPrompt]);

  const linkedIssueMention = useMemo(
    () => (linkedIssue ? toLinkedIssueMentionItem(linkedIssue) : null),
    [linkedIssue]
  );

  useEffect(() => {
    const editor = editorApiRef.current;
    if (!editor || !linkedIssueMention) return;

    if (!state.issueContext) {
      editor.removeMention(linkedIssueMention.id);
      return;
    }

    if (!promptHasIssueMention(editor.getText(), linkedIssueMention.id)) {
      editor.prependMention(linkedIssueMention);
    }
  }, [linkedIssueMention, state.issueContext, state.prompt]);

  const renderMentionIcon = useCallback<RenderMentionIcon>(({ id, kind }) => {
    if (kind !== 'issue') return null;
    const target = parseIssueMentionToken(id);
    if (!target) return null;
    return <IntegrationIcon provider={target.provider} size={12} />;
  }, []);

  const querySlashItems = useCallback(
    async (query: string): Promise<CommandItem[]> => {
      const normalized = query.trim().toLowerCase();
      return promptLibrary
        .filter((prompt) => {
          if (!normalized) return true;
          return [prompt.title, prompt.prompt].some((value) =>
            value.toLowerCase().includes(normalized)
          );
        })
        .map((prompt) => ({
          id: `prompt:${prompt.id}`,
          name: prompt.title,
          label: prompt.title,
          description: promptPreview(prompt.prompt),
          behavior: 'insert-text' as const,
          insertText: prompt.prompt,
          section: SLASH_PROMPTS_SECTION,
        }));
    },
    [promptLibrary]
  );

  const handleComposerInputChange = useCallback(
    (text: string) => {
      if (!canDeliverInitialPrompt) return;
      state.setPrompt(text);
      if (syncingEditorTextRef.current || !linkedIssueMention || !state.issueContext) return;

      if (!promptHasIssueMention(text, linkedIssueMention.id)) {
        state.setIssueContext(null);
      }
    },
    [canDeliverInitialPrompt, linkedIssueMention, state]
  );

  // Prompt first (design brief 2.9): the composer leads, and the conversation's options sit
  // under it as one quiet row that reads as its footer: who runs it, then the switches.
  // A file dragged over the field draws the accent focus ring, never a tinted panel.
  return (
    <Field.Root>
      <div
        className={cn(
          'flex flex-col gap-2 rounded-lg transition-shadow',
          isDragOver && 'ring-2 ring-ring ring-offset-4 ring-offset-(--em-surface)'
        )}
        onBlur={onPromptBlur}
        {...(canDeliverInitialPrompt ? dropHandlers : {})}
      >
        <ChatComposer
          canSubmit={false}
          showSubmitButton={false}
          minRows={minRows}
          placeholder={
            placeholder ?? 'Describe what the agent should do, or use / to select a prompt...'
          }
          onSubmit={() => {}}
          onInputChange={handleComposerInputChange}
          disabled={!canDeliverInitialPrompt}
          editorApiRef={editorApiRef}
          renderMentionIcon={renderMentionIcon}
          queryCommands={canDeliverInitialPrompt ? querySlashItems : undefined}
          modelOptions={modelOptions}
          selectedModel={state.model ?? undefined}
          onModelChange={(modelId) => state.setModel(modelId || null)}
          className={textareaClassName}
        />
        {initialPromptInfo ? (
          <Field.Description className="px-1">{initialPromptInfo}</Field.Description>
        ) : null}

        <div className="flex min-w-0 flex-wrap items-center gap-x-5 gap-y-1.5 pl-1">
          <AgentSelector
            value={state.provider}
            onChange={(provider) => state.setProvider(provider)}
            connectionId={state.connectionId}
            getDisabledReason={getDisabledReason}
            appearance="quiet"
            className="-ml-1"
          />

          {claudeAccount?.visible ? (
            <div className="flex min-w-0 items-center gap-2">
              <Field.Label
                htmlFor={claudeAccountSelectId}
                className="shrink-0 font-normal text-foreground-muted"
              >
                Claude account
              </Field.Label>
              <ClaudeAccountSelect
                id={claudeAccountSelectId}
                picker={claudeAccount}
                variant="inline"
              />
            </div>
          ) : null}

          {showAutoApproveToggle && canToggleAutoApprove ? (
            <div className="flex items-center gap-2">
              <Switch
                id={autoApproveSwitchId}
                size="sm"
                checked={state.autoApprove}
                onCheckedChange={state.setAutoApprove}
                disabled={!state.provider}
              />
              <Field.Label
                htmlFor={autoApproveSwitchId}
                className="font-normal text-foreground-muted"
              >
                Auto-approve permissions
              </Field.Label>
            </div>
          ) : null}

          {canToggleChatUi ? (
            <div className="flex items-center gap-2">
              <Switch
                id={chatUiSwitchId}
                size="sm"
                checked={state.useChatUi}
                onCheckedChange={state.setUseChatUi}
              />
              <Field.Label htmlFor={chatUiSwitchId} className="font-normal text-foreground-muted">
                Use chat UI
              </Field.Label>
            </div>
          ) : null}
        </div>
      </div>
    </Field.Root>
  );
}
