import { z } from 'zod';
import { defineCommand } from '@core/primitives/commands/api';
import { keybinding } from '@core/primitives/keybindings/api';

export const showClaudeUsageCommand = defineCommand({
  id: 'claudeAccounts.showUsage',
  title: 'Show Claude Usage',
  description: 'See how much of each Claude account is used',
  category: 'Claude',
  icon: 'gauge',
  // Agents live in terminals, so the shortcut has to work from one.
  keybinding: keybinding.settings('claudeUsage', 'Mod+Shift+U', {
    allowWhenTerminalFocused: true,
  }),
});

export const switchClaudeAccountCommand = defineCommand({
  id: 'claudeAccounts.switchDefault',
  title: 'Switch Claude Account',
  description: 'Use the next Claude account for new agents',
  category: 'Claude',
  icon: 'arrow-left-right',
  // Without input the default moves to the next signed-in account.
  input: z.object({ accountId: z.string().optional() }).optional(),
});

export const CLAUDE_ACCOUNTS_COMMAND_DEFS = [
  showClaudeUsageCommand,
  switchClaudeAccountCommand,
] as const;
