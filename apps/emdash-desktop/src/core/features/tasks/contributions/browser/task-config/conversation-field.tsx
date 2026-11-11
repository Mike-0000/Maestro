import type { ClaudeAccountPicker } from '@core/features/claude-accounts/contributions/browser/claude-account-picker';
import { InitialConversationField } from '@core/features/tasks/contributions/browser/task-config/initial-conversation-section';
import { useTaskState } from '@core/features/tasks/contributions/browser/task-config/task-state-context';

interface ConversationFieldProps {
  placeholder?: string;
  textareaClassName?: string;
  onPromptBlur?: () => void;
  showAutoApproveToggle?: boolean;
  requirePromptDelivery?: boolean;
  claudeAccount?: ClaudeAccountPicker;
  /** Puts the caret in the prompt once the form opens. */
  autoFocus?: boolean;
  /** Resting height of the prompt in lines; it still grows with what is typed. */
  minRows?: number;
}

export function ConversationField({
  placeholder,
  textareaClassName,
  onPromptBlur,
  requirePromptDelivery,
  showAutoApproveToggle,
  claudeAccount,
  autoFocus,
  minRows,
}: ConversationFieldProps) {
  const { initialConversation, linkedIssue, includeIssueContextByDefault } = useTaskState();

  return (
    <InitialConversationField
      state={initialConversation}
      linkedIssue={linkedIssue}
      includeIssueContextByDefault={includeIssueContextByDefault}
      placeholder={placeholder}
      textareaClassName={textareaClassName}
      onPromptBlur={onPromptBlur}
      requirePromptDelivery={requirePromptDelivery}
      showAutoApproveToggle={showAutoApproveToggle}
      claudeAccount={claudeAccount}
      autoFocus={autoFocus}
      minRows={minRows}
    />
  );
}
