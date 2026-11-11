import { PageLayout } from '@emdash/ui/react/patterns';
import IntegrationsCard from '../components/IntegrationsCard';

export function IntegrationsSettingsPage() {
  return (
    <div className="pb-16">
      <PageLayout.Header
        sticky
        title="Integrations"
        description="Issue trackers and code hosts Maestro can read from when you create a task."
      />
      <IntegrationsCard />
    </div>
  );
}
