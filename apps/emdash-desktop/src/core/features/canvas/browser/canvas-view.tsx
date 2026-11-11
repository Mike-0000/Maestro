import { Button } from '@emdash/ui/react/primitives';
import { ArrowLeft, ArrowRight, ChevronRight } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { type ReactNode } from 'react';
import { Titlebar } from '@core/features/workbench/contributions/browser/Titlebar';
import { cn } from '@core/primitives/styling/browser/cn';
import { defineViewRuntime } from '@core/primitives/views/react';
import { getCanvasStore } from '../contributions/browser/app-stores';
import { canvasViewDef } from '../contributions/views';
import { CanvasBoard } from './canvas-board';

function CanvasViewWrapper({ children }: { children: ReactNode }) {
  return <>{children}</>;
}

/** Where you are on the canvas (board, region, stage), with back and forward. */
const CanvasTitlebar = observer(function CanvasTitlebar() {
  const store = getCanvasStore();
  const crumbs = store.breadcrumbs;
  return (
    <Titlebar
      leftSlot={
        <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-0.5 px-2">
          <NavButton
            label="Back (Ctrl+Alt+Left)"
            disabled={store.backTrail.length === 0}
            onClick={() => store.back()}
          >
            <ArrowLeft className="size-3.5" />
          </NavButton>
          <NavButton
            label="Forward (Ctrl+Alt+Right)"
            disabled={store.forwardTrail.length === 0}
            onClick={() => store.forward()}
          >
            <ArrowRight className="size-3.5" />
          </NavButton>
          {crumbs.map((crumb, index) => {
            const last = index === crumbs.length - 1;
            return (
              <span key={`${index}:${crumb.label}`} className="flex min-w-0 items-center">
                {index > 0 && (
                  <ChevronRight className="size-3.5 shrink-0 text-foreground-passive" />
                )}
                <button
                  type="button"
                  disabled={last}
                  onClick={() => (index === 0 ? store.home() : store.navigate(crumb.location))}
                  className={cn(
                    'truncate rounded-sm px-1 py-0.5 text-sm transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
                    last ? 'text-foreground' : 'text-foreground-muted hover:text-foreground'
                  )}
                >
                  {crumb.label}
                </button>
              </span>
            );
          })}
        </nav>
      }
    />
  );
});

function NavButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="xs"
      icon
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </Button>
  );
}

function CanvasMainPanel() {
  return <CanvasBoard />;
}

export const canvasViewRuntime = defineViewRuntime(canvasViewDef, {
  slots: {
    wrap: CanvasViewWrapper,
    titlebar: CanvasTitlebar,
    main: CanvasMainPanel,
  },
});
