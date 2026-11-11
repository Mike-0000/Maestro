import type { CatalogSkill } from '@emdash/core/primitives/skills/api';
import { Button, Tooltip } from '@emdash/ui/react/primitives';
import { Plus, Trash2 } from 'lucide-react';
import React from 'react';
import { SkillIconRenderer } from './SkillIconRenderer';

interface SkillCardProps {
  skill: CatalogSkill;
  isInstalled: boolean;
  onInstall: (skillId: string) => void;
  onUninstall: (skillId: string) => void;
  onClick: () => void;
}

/**
 * One skill as a row of its settings card: the skill's mark, its name and one line of what it
 * does. The row opens the skill's details; install or uninstall shows on hover or focus.
 */
export const SkillCard: React.FC<SkillCardProps> = ({
  skill,
  isInstalled,
  onInstall,
  onUninstall,
  onClick,
}) => {
  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={`Show ${skill.displayName}`}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick();
        }
      }}
      className="group -mx-2 flex min-w-0 cursor-pointer items-center gap-3 rounded-md px-2 py-2 transition-colors outline-none hover:bg-surface-hover focus-visible:ring-1 focus-visible:ring-ring"
    >
      <SkillIconRenderer skill={skill} />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm text-foreground">{skill.displayName}</span>
        <p className="line-clamp-1 text-xs text-foreground-muted">{skill.description}</p>
      </div>
      <Tooltip.Root>
        <Tooltip.Trigger
          render={
            <Button
              size="sm"
              icon
              variant="ghost"
              tone={isInstalled ? 'destructive' : 'neutral'}
              className="shrink-0 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 focus-visible:opacity-100"
              aria-label={
                isInstalled ? `Uninstall ${skill.displayName}` : `Install ${skill.displayName}`
              }
              onClick={(e: React.MouseEvent<HTMLButtonElement>) => {
                e.stopPropagation();
                if (isInstalled) {
                  onUninstall(skill.id);
                } else {
                  onInstall(skill.id);
                }
              }}
            />
          }
        >
          {isInstalled ? <Trash2 className="size-3.5" /> : <Plus className="size-4" />}
        </Tooltip.Trigger>
        <Tooltip.Content>{isInstalled ? 'Uninstall' : 'Install'}</Tooltip.Content>
      </Tooltip.Root>
    </div>
  );
};
