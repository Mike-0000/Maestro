import { CollectionToolbar } from '@emdash/ui/react/patterns';
import { Button, Tooltip } from '@emdash/ui/react/primitives';
import { RefreshCw } from 'lucide-react';
import React from 'react';
import { cn } from '@core/primitives/styling/browser/cn';

type AgentsToolbarProps = {
  searchQuery: string;
  onSearchQueryChange: (query: string) => void;
  onRefresh: () => void;
  isRefreshing: boolean;
};

export function AgentsToolbar({
  searchQuery,
  onSearchQueryChange,
  onRefresh,
  isRefreshing,
}: AgentsToolbarProps) {
  return (
    <CollectionToolbar.Root>
      <CollectionToolbar.Search
        value={searchQuery}
        onValueChange={onSearchQueryChange}
        placeholder="Search agents…"
      />
      <CollectionToolbar.Spacer />
      <CollectionToolbar.Group>
        <Tooltip.Root>
          <Tooltip.Trigger
            render={
              <Button
                variant="ghost"
                size="sm"
                icon
                onClick={onRefresh}
                disabled={isRefreshing}
                aria-busy={isRefreshing}
                aria-label="Refresh agent detection"
              >
                <RefreshCw
                  className={cn('size-3.5', isRefreshing && 'motion-safe:animate-spin')}
                  aria-hidden
                />
              </Button>
            }
          />
          <Tooltip.Content side="top">Detect installed agents again</Tooltip.Content>
        </Tooltip.Root>
      </CollectionToolbar.Group>
    </CollectionToolbar.Root>
  );
}
