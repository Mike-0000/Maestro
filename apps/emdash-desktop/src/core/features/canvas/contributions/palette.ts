import { defineCommandPaletteItem } from '@core/primitives/palette/api';
import {
  addCanvasNoteCommand,
  fitCanvasCommand,
  nextAttentionCommand,
  openCanvasCommand,
  runCanvasAppCommand,
  undoLayoutCommand,
  redoLayoutCommand,
  groupSelectionCommand,
  newRegionCommand,
  tidyCanvasCommand,
  organizeByTaskCommand,
  organizeByProjectCommand,
  organizeByStatusCommand,
  organizeByProviderCommand,
  enterStageCommand,
  leaveStageCommand,
  canvasBackCommand,
  canvasHomeCommand,
  toggleMultiCanvasCommand,
  toggleCanvasProCommand,
  newDeskCommand,
  nextDeskCommand,
  previousDeskCommand,
} from './commands';

export const CANVAS_COMMAND_PALETTE_ITEMS = [
  defineCommandPaletteItem({
    command: openCanvasCommand,
    aliases: ['board', 'agents', 'overview'],
  }),
  defineCommandPaletteItem({
    command: nextAttentionCommand,
    aliases: ['attention', 'waiting', 'permission', 'next agent'],
  }),
  defineCommandPaletteItem({ command: fitCanvasCommand, aliases: ['zoom out', 'fit'] }),
  defineCommandPaletteItem({ command: addCanvasNoteCommand, aliases: ['sticky'] }),
  defineCommandPaletteItem({
    command: runCanvasAppCommand,
    aliases: ['browser', 'preview', 'dev server', 'open app'],
  }),
  defineCommandPaletteItem({
    command: undoLayoutCommand,
    aliases: ['undo', 'put it back', 'revert layout'],
  }),
  defineCommandPaletteItem({ command: redoLayoutCommand, aliases: ['redo'] }),
  defineCommandPaletteItem({
    command: groupSelectionCommand,
    aliases: ['group', 'region', 'sub-canvas', 'subcanvas', 'cluster'],
  }),
  defineCommandPaletteItem({
    command: newRegionCommand,
    aliases: ['region', 'sub-canvas', 'subcanvas', 'area', 'group'],
  }),
  defineCommandPaletteItem({
    command: tidyCanvasCommand,
    aliases: ['tidy', 'arrange', 'clean up', 'align', 'grid'],
  }),
  defineCommandPaletteItem({
    command: organizeByTaskCommand,
    aliases: ['organize', 'group by task', 'sort'],
  }),
  defineCommandPaletteItem({
    command: organizeByProjectCommand,
    aliases: ['organize', 'group by project', 'sort'],
  }),
  defineCommandPaletteItem({
    command: organizeByStatusCommand,
    aliases: ['organize', 'group by status', 'waiting', 'triage'],
  }),
  defineCommandPaletteItem({
    command: organizeByProviderCommand,
    aliases: ['organize', 'group by provider', 'claude', 'codex'],
  }),
  defineCommandPaletteItem({
    command: enterStageCommand,
    aliases: ['stage', 'full screen', 'focus mode', 'maximize', 'tile'],
  }),
  defineCommandPaletteItem({
    command: leaveStageCommand,
    aliases: ['exit stage', 'back to canvas'],
  }),
  defineCommandPaletteItem({ command: canvasBackCommand, aliases: ['back', 'previous'] }),
  defineCommandPaletteItem({
    command: canvasHomeCommand,
    aliases: ['home', 'whole board', 'overview'],
  }),
  defineCommandPaletteItem({
    command: toggleMultiCanvasCommand,
    aliases: ['multi canvas', 'split', 'views', 'quadrants', 'side by side'],
  }),
  defineCommandPaletteItem({
    command: toggleCanvasProCommand,
    aliases: ['desks', 'desktops', 'spaces', 'pro', 'classic canvas'],
  }),
  defineCommandPaletteItem({
    command: newDeskCommand,
    aliases: ['desk', 'desktop', 'space', 'add desk'],
  }),
  defineCommandPaletteItem({ command: nextDeskCommand, aliases: ['desk', 'switch desk'] }),
  defineCommandPaletteItem({ command: previousDeskCommand, aliases: ['desk', 'switch desk'] }),
] as const;
