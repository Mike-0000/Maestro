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

export const CANVAS_COMMAND_DEFS = [
  openCanvasCommand,
  nextAttentionCommand,
  fitCanvasCommand,
  addCanvasNoteCommand,
  runCanvasAppCommand,
] as const;
