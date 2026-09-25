import { defineCommandPaletteItem } from '@core/primitives/palette/api';
import { toggleListeningCommand, toggleSpokenRepliesCommand } from './commands';

export const VOICE_COMMAND_PALETTE_ITEMS = [
  defineCommandPaletteItem({
    command: toggleListeningCommand,
    aliases: ['microphone', 'talk', 'dictate', 'conductor'],
  }),
  defineCommandPaletteItem({ command: toggleSpokenRepliesCommand, aliases: ['speech', 'tts'] }),
] as const;
