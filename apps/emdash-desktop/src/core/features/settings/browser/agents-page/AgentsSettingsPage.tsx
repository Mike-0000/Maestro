import React from 'react';
import { useSettingsSearch } from '@core/features/settings/browser/search/settings-search-context';
import { AgentsPanel } from '@core/features/settings/contributions/browser/agents-page/AgentsPanel';

export function AgentsSettingsPage() {
  const { query: settingsSearchQuery, setQuery: setSettingsSearchQuery } = useSettingsSearch();

  return (
    <AgentsPanel
      header={{
        title: 'Agents',
        description:
          'The coding agents Maestro can run on this computer, and how each is installed.',
      }}
      searchQuery={settingsSearchQuery}
      onSearchQueryChange={setSettingsSearchQuery}
    />
  );
}
