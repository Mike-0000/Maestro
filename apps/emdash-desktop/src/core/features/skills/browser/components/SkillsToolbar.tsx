import { CollectionToolbar } from '@emdash/ui/react/patterns';
import { Button, Tooltip } from '@emdash/ui/react/primitives';
import { Plus, RefreshCw } from 'lucide-react';
import React from 'react';
import { useSearchFocusHotkeys } from '@core/primitives/keybindings/browser';
import { cn } from '@core/primitives/styling/browser/cn';

type SkillsToolbarProps = {
  searchQuery: string;
  onSearchQueryChange: (query: string) => void;
  onRefresh: () => void;
  isRefreshing: boolean;
  onCreateSkill: () => void;
};

export function SkillsToolbar({
  searchQuery,
  onSearchQueryChange,
  onRefresh,
  isRefreshing,
  onCreateSkill,
}: SkillsToolbarProps) {
  const searchRef = useSearchFocusHotkeys();
  return (
    <CollectionToolbar.Root>
      <CollectionToolbar.Search
        ref={searchRef}
        value={searchQuery}
        onValueChange={onSearchQueryChange}
        placeholder="Search skills…"
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
                aria-label="Refresh catalog"
              />
            }
          >
            <RefreshCw
              className={cn('size-4', isRefreshing && 'animate-spin motion-reduce:animate-none')}
            />
          </Tooltip.Trigger>
          <Tooltip.Content>Refresh the catalog</Tooltip.Content>
        </Tooltip.Root>
        <Button variant="primary" onClick={onCreateSkill}>
          <Plus className="size-4" aria-hidden />
          New skill
        </Button>
      </CollectionToolbar.Group>
    </CollectionToolbar.Root>
  );
}
