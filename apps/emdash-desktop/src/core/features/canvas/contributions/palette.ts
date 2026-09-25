import { defineCommandPaletteItem } from '@core/primitives/palette/api';
import {
  addCanvasNoteCommand,
  fitCanvasCommand,
  nextAttentionCommand,
  openCanvasCommand,
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
] as const;
