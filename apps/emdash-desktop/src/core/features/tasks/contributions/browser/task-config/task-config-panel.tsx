import { Tabs } from '@emdash/ui/react/primitives';
import { useState } from 'react';

interface Tab {
  value: string;
  label: string;
  content: React.ReactNode;
}

interface TaskConfigPanelProps {
  tabs: Tab[];
  defaultTab?: string;
}

/** Text tabs with a 1px underline over the active section (design brief 2.10), no track. */
export function TaskConfigPanel({ tabs, defaultTab }: TaskConfigPanelProps) {
  const [activeTab, setActiveTab] = useState<string>(defaultTab ?? tabs[0]?.value ?? '');

  const currentContent = tabs.find((t) => t.value === activeTab)?.content ?? null;

  return (
    <div className="flex flex-col gap-4">
      <Tabs.Root value={activeTab} onValueChange={(value) => setActiveTab(String(value))}>
        <Tabs.List variant="underline">
          {tabs.map(({ value, label }) => (
            <Tabs.Tab key={value} value={value} size="sm">
              {label}
            </Tabs.Tab>
          ))}
        </Tabs.List>
      </Tabs.Root>
      <div>{currentContent}</div>
    </div>
  );
}
