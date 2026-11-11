import { Button, Tooltip } from '@emdash/ui/react/primitives';
import { ArrowUp, LoaderCircle } from 'lucide-react';
import {
  type ContextAction,
  type PromptContextAction,
} from '@core/features/tasks/browser/context-bar/context-actions';
import { PromptActionsMenu } from '@core/features/tasks/browser/context-bar/prompt-actions-menu';
import { ProviderLogo } from '../components/issue-selector/issue-selector';

interface ModalContextBarProps {
  actions: ContextAction[];
  onActionClick: (action: ContextAction) => void;
  issueActionPending?: boolean;
}

export function ModalContextBar({
  actions,
  onActionClick,
  issueActionPending = false,
}: ModalContextBarProps) {
  if (actions.length === 0) return null;

  const issueAction = actions.find((a) => a.kind === 'linked-issue') ?? null;
  const promptActions = actions.filter((a): a is PromptContextAction => a.kind === 'prompt');

  return (
    <Tooltip.Provider>
      <div className="flex min-h-9 items-center gap-2 px-2">
        <PromptActionsMenu
          actions={promptActions}
          disabled={false}
          disabledTooltip="Prompt unavailable"
          actionTooltip="Add a prompt to the initial message"
          onActionClick={onActionClick}
        />
        {issueAction ? (
          <Tooltip.Root>
            <Tooltip.Trigger>
              <Button
                variant="ghost"
                size="sm"
                disabled={issueActionPending}
                onClick={() => onActionClick(issueAction)}
                className="max-w-full gap-1.5 px-2 text-xs"
              >
                {issueAction.provider ? (
                  <ProviderLogo provider={issueAction.provider} className="size-3.5" />
                ) : null}
                <span className="max-w-72 truncate">
                  {issueActionPending
                    ? 'Adding issue context…'
                    : `${issueAction.issue.identifier} ${issueAction.issue.title}`}
                </span>
                {issueActionPending ? (
                  <LoaderCircle className="size-3 shrink-0 text-foreground-passive motion-safe:animate-spin" />
                ) : (
                  <ArrowUp className="size-3 shrink-0 text-foreground-passive" />
                )}
              </Button>
            </Tooltip.Trigger>
            <Tooltip.Content>
              {issueActionPending
                ? 'Adding issue context to the initial message'
                : 'Add issue context to the initial message'}
            </Tooltip.Content>
          </Tooltip.Root>
        ) : null}
      </div>
    </Tooltip.Provider>
  );
}
