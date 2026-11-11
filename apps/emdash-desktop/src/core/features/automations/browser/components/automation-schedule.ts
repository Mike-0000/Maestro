import cronstrue from 'cronstrue';
import type { Automation } from '@core/primitives/automations/api';
import { describeCron } from '../CronPicker/cron-utils';

/**
 * How often an automation runs, in the picker's own words ("Every day at 09:00"), falling back to
 * cronstrue for hand-written expressions and to the raw expression when even that fails.
 */
export function automationScheduleLabel(automation: Automation): string {
  const trigger = automation.triggerConfig;
  if (trigger?.onDemand) return 'On demand';
  const expr = trigger?.expr?.trim();
  if (!expr) return 'No schedule';
  const described = describeCron(expr);
  if (described) return described;
  try {
    return cronstrue.toString(expr);
  } catch {
    return expr;
  }
}
