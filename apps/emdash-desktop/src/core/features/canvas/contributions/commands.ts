import { defineCommand } from '@core/primitives/commands/api';
import { keybinding } from '@core/primitives/keybindings/api';

export const openCanvasCommand = defineCommand({
  id: 'canvas.open',
  title: 'Open Canvas',
  description: 'Show every agent on the canvas',
  category: 'Canvas',
  icon: 'layout-dashboard',
  keybinding: keybinding.settings('openCanvas', 'Mod+Shift+A'),
});

export const nextAttentionCommand = defineCommand({
  id: 'canvas.nextAttention',
  title: 'Jump to Next Agent Needing You',
  description: 'Focus the agent that has waited longest for input, permission, or review',
  category: 'Canvas',
  icon: 'bell-ring',
  keybinding: keybinding.settings('canvasNextAttention', 'Mod+Shift+J'),
});

export const fitCanvasCommand = defineCommand({
  id: 'canvas.fitAll',
  title: 'Show All Agents',
  description: 'Zoom the canvas out to fit every agent',
  category: 'Canvas',
  icon: 'maximize',
});

export const addCanvasNoteCommand = defineCommand({
  id: 'canvas.addNote',
  title: 'Add Canvas Note',
  description: 'Pin a sticky note to the canvas',
  category: 'Canvas',
  icon: 'sticky-note',
});

export const runCanvasAppCommand = defineCommand({
  id: 'canvas.runApp',
  title: 'Run App on Canvas',
  description: "Start the focused task's app and open it in a browser on the canvas",
  category: 'Canvas',
  icon: 'app-window',
});

export const undoLayoutCommand = defineCommand({
  id: 'canvas.undoLayout',
  title: 'Undo Canvas Layout Change',
  description: 'Revert the last move, resize, grouping, or stage change on the canvas',
  category: 'Canvas',
  icon: 'undo-2',
});

export const redoLayoutCommand = defineCommand({
  id: 'canvas.redoLayout',
  title: 'Redo Canvas Layout Change',
  description: 'Re-apply the canvas layout change you just undid',
  category: 'Canvas',
  icon: 'redo-2',
});

export const groupSelectionCommand = defineCommand({
  id: 'canvas.groupSelection',
  title: 'Group Selected Windows into a Region',
  description: 'Put the selected windows and regions into a new named region',
  category: 'Canvas',
  icon: 'boxes',
});

export const newRegionCommand = defineCommand({
  id: 'canvas.newRegion',
  title: 'New Canvas Region',
  description: 'Add an empty named region to the canvas',
  category: 'Canvas',
  icon: 'square-dashed',
});

export const tidyCanvasCommand = defineCommand({
  id: 'canvas.tidy',
  title: 'Tidy Up Canvas',
  description: 'Line up the windows in the region in view (or the whole board) without overlaps',
  category: 'Canvas',
  icon: 'wand-sparkles',
});

export const organizeByTaskCommand = defineCommand({
  id: 'canvas.organizeByTask',
  title: 'Organize Canvas by Task',
  description: 'Group windows into one region per task',
  category: 'Canvas',
  icon: 'layout-grid',
});

export const organizeByProjectCommand = defineCommand({
  id: 'canvas.organizeByProject',
  title: 'Organize Canvas by Project',
  description: 'Group windows into one region per project',
  category: 'Canvas',
  icon: 'layout-grid',
});

export const organizeByStatusCommand = defineCommand({
  id: 'canvas.organizeByStatus',
  title: 'Organize Canvas by Status',
  description: 'Group agents by needs you, working, idle, and done',
  category: 'Canvas',
  icon: 'layout-grid',
});

export const organizeByProviderCommand = defineCommand({
  id: 'canvas.organizeByProvider',
  title: 'Organize Canvas by Agent Type',
  description: 'Group agents by provider (Claude, Codex, and so on)',
  category: 'Canvas',
  icon: 'layout-grid',
});

export const enterStageCommand = defineCommand({
  id: 'canvas.stage.enter',
  title: 'Open on Stage',
  description: 'Tile the selection, or the region in view, full screen and live',
  category: 'Canvas',
  icon: 'layout-panel-top',
});

export const leaveStageCommand = defineCommand({
  id: 'canvas.stage.leave',
  title: 'Leave Stage',
  description: 'Return from the stage to the canvas board',
  category: 'Canvas',
  icon: 'x',
});

export const canvasBackCommand = defineCommand({
  id: 'canvas.back',
  title: 'Canvas: Go Back',
  description: 'Return to where you were on the canvas before',
  category: 'Canvas',
  icon: 'arrow-left',
});

export const canvasHomeCommand = defineCommand({
  id: 'canvas.home',
  title: 'Canvas: Whole Board',
  description: 'Leave regions and the stage and show the whole board',
  category: 'Canvas',
  icon: 'house',
});

export const toggleMultiCanvasCommand = defineCommand({
  id: 'canvas.toggleMultiCanvas',
  title: 'Toggle Multi-Canvas',
  description: 'Split the canvas into several side-by-side views, or go back to one',
  category: 'Canvas',
  icon: 'grid-2x2',
});

export const toggleCanvasProCommand = defineCommand({
  id: 'canvas.togglePro',
  title: 'Toggle Canvas Pro',
  description: 'Switch between desks you swap between and the classic one-board canvas',
  category: 'Canvas',
  icon: 'layers',
});

export const newDeskCommand = defineCommand({
  id: 'canvas.desk.new',
  title: 'New Desk',
  description: 'Add a desk to Canvas Pro and switch to it',
  category: 'Canvas',
  icon: 'plus',
});

export const nextDeskCommand = defineCommand({
  id: 'canvas.desk.next',
  title: 'Next Desk',
  description: 'Swap to the next desk (Ctrl+Alt+PageDown on the canvas)',
  category: 'Canvas',
  icon: 'chevron-right',
});

export const previousDeskCommand = defineCommand({
  id: 'canvas.desk.previous',
  title: 'Previous Desk',
  description: 'Swap to the previous desk (Ctrl+Alt+PageUp on the canvas)',
  category: 'Canvas',
  icon: 'chevron-left',
});

export const CANVAS_COMMAND_DEFS = [
  openCanvasCommand,
  nextAttentionCommand,
  fitCanvasCommand,
  addCanvasNoteCommand,
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
] as const;
