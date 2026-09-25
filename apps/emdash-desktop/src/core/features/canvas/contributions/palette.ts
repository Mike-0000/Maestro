import { defineCommandPaletteItem } from '@core/primitives/palette/api';
import {
  addCanvasNoteCommand,
  fitCanvasCommand,
  nextAttentionCommand,
  openCanvasCommand,
  runCanvasAppCommand,
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
] as const;
