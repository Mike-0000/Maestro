import { type ReactNode } from 'react';
import { Titlebar } from '@core/features/workbench/contributions/browser/Titlebar';
import { defineViewRuntime } from '@core/primitives/views/react';
import { canvasViewDef } from '../contributions/views';
import { CanvasBoard } from './canvas-board';

function CanvasViewWrapper({ children }: { children: ReactNode }) {
  return <>{children}</>;
}

function CanvasTitlebar() {
  return (
    <Titlebar
      leftSlot={
        <nav aria-label="Breadcrumb" className="flex items-center px-2">
          <span className="truncate rounded-sm px-1 py-0.5 text-sm text-foreground">Canvas</span>
        </nav>
      }
    />
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
