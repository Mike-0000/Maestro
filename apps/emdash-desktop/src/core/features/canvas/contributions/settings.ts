import { z } from 'zod';
import { defineSettingsContribution } from '@core/primitives/settings/api';

export type CanvasBrowserSettings = {
  /** Browser tiles on the canvas ("Run app", "Show app"). */
  enabled: boolean;
  /** Open the app's tile automatically when its dev server becomes ready after "Run app". */
  autoOpenOnRun: boolean;
  /** Let the conductor look at and use apps in agent-controllable tiles. */
  conductorControl: boolean;
  /** Let coding agents (ACP sessions) drive their own task's browser through Chorus's MCP server. */
  agentControl: boolean;
  /** Send screenshots and page text to the conductor's model provider. */
  sendPageContentToModel: boolean;
  /** Browsers kept alive at once; the least recently used idle one is suspended beyond this. */
  maxAliveBrowsers: number;
};

export const DEFAULT_CANVAS_BROWSER_SETTINGS: CanvasBrowserSettings = {
  enabled: true,
  autoOpenOnRun: true,
  conductorControl: true,
  agentControl: false,
  sendPageContentToModel: true,
  maxAliveBrowsers: 4,
};

export const canvasBrowserSettingsContribution = defineSettingsContribution<
  'canvasBrowser',
  CanvasBrowserSettings
>({
  key: 'canvasBrowser',
  schema: z.object({
    enabled: z.boolean(),
    autoOpenOnRun: z.boolean(),
    conductorControl: z.boolean(),
    agentControl: z.boolean(),
    sendPageContentToModel: z.boolean(),
    maxAliveBrowsers: z.number().int().min(1).max(12),
  }),
  defaults: DEFAULT_CANVAS_BROWSER_SETTINGS,
});
