import { PageLayout } from '@emdash/ui/react/patterns';
import { BrowserSettingsCard } from '../components/BrowserSettingsCard';
import { CanvasBrowserSettingsCard } from '../components/CanvasBrowserSettingsCard';

export function BrowserSettingsPage() {
  return (
    <div className="pb-16">
      <PageLayout.Header
        sticky
        title="Browser"
        description="The in-app browser: its profiles, stored logins and what agents may do with it."
      />
      <div className="flex flex-col gap-10">
        <BrowserSettingsCard />
        <CanvasBrowserSettingsCard />
      </div>
    </div>
  );
}
