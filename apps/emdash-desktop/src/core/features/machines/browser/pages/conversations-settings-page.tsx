import { PageLayout } from '@emdash/ui/react/patterns';
import { MachineConversationsList } from '../components/machine-conversations-list';

export function ConversationsSettingsPage() {
  return (
    <div className="flex min-h-0 flex-col pb-16">
      <PageLayout.Header
        sticky
        title="Conversations"
        description="Every conversation record on this computer, including ones no longer linked to a task."
      />
      <MachineConversationsList scope={{ kind: 'local' }} hostReachable />
    </div>
  );
}
