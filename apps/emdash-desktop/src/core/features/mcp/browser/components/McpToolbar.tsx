import { CollectionToolbar } from '@emdash/ui/react/patterns';
import { Button, Tooltip } from '@emdash/ui/react/primitives';
import { Plus, RefreshCw } from 'lucide-react';
import React from 'react';
import { useSearchFocusHotkeys } from '@core/primitives/keybindings/browser';
import { cn } from '@core/primitives/styling/browser/cn';

type McpToolbarProps = {
  search: string;
  onSearchChange: (search: string) => void;
  onRefresh: () => void;
  isRefreshing: boolean;
  onAddCustom: () => void;
};

export function McpToolbar({
  search,
  onSearchChange,
  onRefresh,
  isRefreshing,
  onAddCustom,
}: McpToolbarProps) {
  const searchRef = useSearchFocusHotkeys();
  return (
    <CollectionToolbar.Root>
      <CollectionToolbar.Search
        ref={searchRef}
        value={search}
        onValueChange={onSearchChange}
        placeholder="Search servers…"
      />
      <CollectionToolbar.Spacer />
      <CollectionToolbar.Group>
        <Tooltip.Root>
          <Tooltip.Trigger
            render={
              <Button
                variant="ghost"
                icon
                onClick={onRefresh}
                disabled={isRefreshing}
                aria-label="Refresh providers"
              />
            }
          >
            <RefreshCw
              className={cn('size-4', isRefreshing && 'animate-spin motion-reduce:animate-none')}
            />
          </Tooltip.Trigger>
          <Tooltip.Content>Check the agents again</Tooltip.Content>
        </Tooltip.Root>
        <Button variant="primary" onClick={onAddCustom}>
          <Plus className="size-4" aria-hidden />
          Add custom server
        </Button>
      </CollectionToolbar.Group>
    </CollectionToolbar.Root>
  );
}
