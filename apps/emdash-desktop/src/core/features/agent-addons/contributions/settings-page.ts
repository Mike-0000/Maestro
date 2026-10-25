import { AddonsView } from '@core/features/agent-addons/browser/AddonsView';
import type { SettingsPageTab } from '@core/features/settings/contributions/views';
import {
  defineSettingsPageContribution,
  type SettingsPageContribution,
} from '@core/primitives/settings/api/page-contribution';

export const addonsSettingsPage = defineSettingsPageContribution({
  id: 'addons',
  label: 'Add-ons',
  icon: 'puzzle',
  component: AddonsView,
} satisfies SettingsPageContribution<SettingsPageTab>);
