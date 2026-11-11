import { FolderOpen, Github, Plus, Server, type LucideIcon } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { Fragment } from 'react';
import { getSidebarStore } from '@core/features/workbench/contributions/browser/app-stores';
import { homeViewDef } from '@core/features/workbench/contributions/views';
import { useOpenModal } from '@core/manifests/browser/modal-api';
import { ChorusMark } from '@core/primitives/app-identity/browser/chorus-logo';
import { Shortcut } from '@core/primitives/keybindings/browser/shortcut';
import { useArrowKeyNavigation } from '@core/primitives/react-hooks/browser/use-arrow-key-navigation';
import { cn } from '@core/primitives/styling/browser/cn';
import { defineViewRuntime } from '@core/primitives/views/react';

const PROJECT_ACTIONS = [
  {
    label: 'Open project',
    description: 'A folder already on this computer',
    icon: FolderOpen,
    modalArgs: { strategy: 'local', mode: 'pick' },
  },
  {
    label: 'Create repository',
    description: 'A new folder and a new repository on GitHub',
    icon: Plus,
    modalArgs: { strategy: 'local', mode: 'create' },
  },
  {
    label: 'Clone from GitHub',
    description: 'Copy a GitHub repository to this computer',
    icon: Github,
    modalArgs: { strategy: 'local', mode: 'clone' },
  },
  {
    label: 'Add remote project',
    description: 'A folder on another machine, over SSH',
    icon: Server,
    modalArgs: { strategy: 'ssh', mode: 'pick' },
  },
] as const;

/**
 * The view with nothing open (and the first screen of a fresh install). One quiet column in the
 * middle of the content: the mark, a hero line, one sentence on how projects work, then the four
 * ways in as menu rows. Arrow keys move the highlight and Enter opens it, so the screen works
 * without a pointer.
 */
export const HomeMainPanel = observer(function HomeMainPanel() {
  const openAddProjectModal = useOpenModal('addProjectModal');
  const hasProjects = getSidebarStore().orderedProjects.length > 0;
  const { selectedIndex, setSelectedIndex } = useArrowKeyNavigation(
    PROJECT_ACTIONS.length,
    (index) => {
      void openAddProjectModal(PROJECT_ACTIONS[index].modalArgs);
    }
  );

  return (
    <div className="flex h-full w-full flex-col overflow-y-auto bg-background text-foreground">
      <div className="flex min-h-full flex-1 flex-col items-center justify-center px-6 py-16">
        <div className="flex w-full max-w-md flex-col motion-safe:animate-in motion-safe:duration-300 motion-safe:fade-in">
          <div className="flex flex-col items-center text-center">
            <ChorusMark size={36} animated={false} />
            <h1 className="mt-6 text-2xl font-medium text-balance text-foreground">
              {hasProjects ? 'Nothing is open' : 'Add a project to begin'}
            </h1>
            <p className="mt-3 max-w-sm text-sm leading-relaxed text-balance text-foreground-muted">
              {hasProjects
                ? 'Pick a task from the sidebar, or add another project.'
                : 'Agents work inside a project, each task on its own branch. Open a folder you have, or start a new one.'}
            </p>
          </div>
          <div className="mt-8 flex flex-col gap-0.5" role="group" aria-label="Add a project">
            {PROJECT_ACTIONS.map((action, i) => (
              <HomeProjectAction
                key={action.label}
                label={action.label}
                description={action.description}
                icon={action.icon}
                isSelected={i === selectedIndex}
                onMouseEnter={() => setSelectedIndex(i)}
                onClick={() => void openAddProjectModal(action.modalArgs)}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
});

function HomeProjectAction({
  label,
  description,
  icon: Icon,
  isSelected,
  onClick,
  onMouseEnter,
}: {
  label: string;
  description: string;
  icon: LucideIcon;
  isSelected: boolean;
  onClick: () => void;
  onMouseEnter: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      onMouseEnter={onMouseEnter}
      data-active={isSelected || undefined}
      className="group/action flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-left transition-colors outline-none hover:bg-surface-hover focus-visible:ring-1 focus-visible:ring-ring data-[active=true]:bg-surface-hover"
    >
      <Icon
        className={cn(
          'size-4 shrink-0 text-foreground-passive transition-colors',
          isSelected && 'text-foreground-muted'
        )}
        aria-hidden
      />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span
          className={cn(
            'truncate text-sm text-foreground-muted transition-colors',
            isSelected && 'text-foreground'
          )}
        >
          {label}
        </span>
        <span className="truncate text-xs text-foreground-passive">{description}</span>
      </span>
      <Shortcut
        hotkey="Enter"
        variant="keycaps"
        className={cn('transition-opacity', isSelected ? 'opacity-100' : 'opacity-0')}
      />
    </button>
  );
}

export const homeViewRuntime = defineViewRuntime(homeViewDef, {
  slots: {
    wrap: Fragment,
    main: HomeMainPanel,
  },
});
