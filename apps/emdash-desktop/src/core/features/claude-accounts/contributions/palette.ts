import { defineCommandPaletteItem } from '@core/primitives/palette/api';
import { showClaudeUsageCommand, switchClaudeAccountCommand } from './commands';

export const CLAUDE_ACCOUNTS_COMMAND_PALETTE_ITEMS = [
  defineCommandPaletteItem({
    command: showClaudeUsageCommand,
    aliases: ['limits', 'quota', 'subscription', 'weekly'],
  }),
  defineCommandPaletteItem({
    command: switchClaudeAccountCommand,
    aliases: ['subscription', 'default account', 'login'],
  }),
] as const;
