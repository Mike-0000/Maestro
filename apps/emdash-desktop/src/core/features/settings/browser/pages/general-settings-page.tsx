import { PageLayout, SettingsSection } from '@emdash/ui/react/patterns';
import { AccountTab } from '../components/AccountTab';
import NotificationSettingsCard from '../components/NotificationSettingsCard';
import {
  AutoApproveByDefaultRow,
  AutoGenerateTaskNamesRow,
  AutoTrustWorktreesRow,
  CreateBranchAndWorktreeRow,
  DeleteBranchByDefaultRow,
  EnableTmuxRow,
  IncludeIssueContextByDefaultRow,
  PreserveTaskNameCapitalizationRow,
} from '../components/TaskSettingsRows';
import TelemetryCard from '../components/TelemetryCard';
import { UpdateCard } from '../components/UpdateCard';

export function GeneralSettingsPage() {
  return (
    <div className="pb-16">
      <PageLayout.Header
        sticky
        draggable
        title="General"
        description="Your account, updates, notifications and the defaults for new tasks."
      />
      <div className="flex flex-col gap-10">
        <SettingsSection title="Account">
          <AccountTab />
        </SettingsSection>
        <SettingsSection title="App">
          <UpdateCard />
          <TelemetryCard />
        </SettingsSection>
        <SettingsSection title="Notifications">
          <NotificationSettingsCard />
        </SettingsSection>
        <SettingsSection title="New tasks">
          <AutoGenerateTaskNamesRow />
          <PreserveTaskNameCapitalizationRow />
          <CreateBranchAndWorktreeRow />
          <IncludeIssueContextByDefaultRow />
          <DeleteBranchByDefaultRow />
        </SettingsSection>
        <SettingsSection title="Agent sessions">
          <AutoApproveByDefaultRow />
          <AutoTrustWorktreesRow />
          <EnableTmuxRow />
        </SettingsSection>
      </div>
    </div>
  );
}
