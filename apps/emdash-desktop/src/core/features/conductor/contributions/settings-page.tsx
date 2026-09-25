import type { SettingsPageTab } from '@core/features/settings/contributions/views';
import {
  defineSettingsPageContribution,
  type SettingsPageContribution,
} from '@core/primitives/settings/api/page-contribution';
import { ChorusSettingsPage } from '../browser/settings/chorus-settings-page';

export const chorusSettingsPage = defineSettingsPageContribution({
  id: 'chorus',
  label: 'Voice & Conductor',
  icon: 'mic',
  component: ChorusSettingsPage,
} satisfies SettingsPageContribution<SettingsPageTab>);
