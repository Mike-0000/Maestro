import { PageLayout, SettingsSection } from '@emdash/ui/react/patterns';
import RepositorySettingsCard from '../components/RepositorySettingsCard';

export function RepositorySettingsPage() {
  return (
    <div className="pb-16">
      <PageLayout.Header
        sticky
        title="Repository"
        description="How Maestro names and publishes the branches it creates for tasks."
      />
      <div className="flex flex-col gap-10">
        <SettingsSection title="Branches">
          <RepositorySettingsCard />
        </SettingsSection>
      </div>
    </div>
  );
}
