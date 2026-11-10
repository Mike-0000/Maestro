import type { SettingsPageTab } from '@core/features/settings/contributions/views';
import {
  defineSettingsPageContribution,
  type SettingsPageContribution,
} from '@core/primitives/settings/api/page-contribution';
import { ClaudeAccountsSettingsPage } from '../browser/claude-accounts-settings-page';

export const claudeAccountsSettingsPage = defineSettingsPageContribution({
  id: 'claude-accounts',
  label: 'Claude accounts',
  icon: 'users',
  component: ClaudeAccountsSettingsPage,
} satisfies SettingsPageContribution<SettingsPageTab>);
