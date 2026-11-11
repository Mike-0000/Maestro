import { PageLayout, SettingsSection } from '@emdash/ui/react/patterns';
import FilesSettingsCard from '../components/FilesSettingsCard';
import HiddenToolsSettingsCard from '../components/HiddenToolsSettingsCard';
import InterfaceSettingsCard from '../components/InterfaceSettingsCard';
import KeyboardSettingsCard from '../components/KeyboardSettingsCard';
import SidebarMetadataSettingsCard from '../components/SidebarMetadataSettingsCard';
import TerminalSettingsCard from '../components/TerminalSettingsCard';
import ThemeCard from '../components/ThemeCard';
import { TrayIconSettingsRow } from '../components/TrayIconSettingsRow';

export function InterfaceSettingsPage() {
  return (
    <div className="pb-16">
      <PageLayout.Header
        sticky
        title="Interface"
        description="How Maestro looks, and what its windows, terminals and menus show."
      />
      <div className="flex flex-col gap-10">
        <SettingsSection title="Color mode" bare>
          <ThemeCard />
        </SettingsSection>
        <SettingsSection title="Window">
          <TrayIconSettingsRow />
          <InterfaceSettingsCard />
        </SettingsSection>
        <SettingsSection
          title="Sidebar"
          description="What each task row shows in the left sidebar."
        >
          <SidebarMetadataSettingsCard />
        </SettingsSection>
        <SettingsSection title="Terminal">
          <TerminalSettingsCard />
        </SettingsSection>
        <SettingsSection
          title="Files"
          description="Glob patterns, one per line. Matching files and folders are skipped."
        >
          <FilesSettingsCard />
        </SettingsSection>
        <SettingsSection
          title="Open in"
          description="The editors and tools listed in the Open in menu of a task."
        >
          <HiddenToolsSettingsCard />
        </SettingsSection>
        <SettingsSection title="Keyboard shortcuts" bare>
          <KeyboardSettingsCard />
        </SettingsSection>
      </div>
    </div>
  );
}
