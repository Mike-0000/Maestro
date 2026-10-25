import { z } from 'zod';
import { completionAnnouncementModes } from './announcements';
import { callModes } from './calls';
// Type only: the contract reaches the tool list, which names these settings.
import type { ConductorSettings } from './contract';

/**
 * The conductor settings the conductor may change itself when the developer asks for it by
 * voice. It is an allowlist: a setting is adjustable only when it is named here. Everything
 * about where models run, what they cost, and what leaves this computer (provider, models, keys,
 * budgets, diagnostics, code checks) stays in the settings page.
 */

type Adjustable = {
  readonly key: keyof ConductorSettings;
  /** The values it takes: the same bounds as the settings schema, which a test holds it to. */
  readonly schema: z.ZodType;
  /** What it does, for the model and the developer. */
  readonly about: string;
  /**
   * Values that take a safeguard away: Maestro asks the developer for a yes before one is set,
   * whatever they said.
   */
  readonly confirmWhen?: (value: unknown) => boolean;
};

const onOff = z.boolean();
const effort = z.enum(['low', 'medium', 'high', 'xhigh', 'max']);

export const ADJUSTABLE_SETTINGS = {
  completion_follow_up: {
    key: 'completionFollowUp',
    schema: onOff,
    about: 'When an agent finishes, read its final reply and say what it reported.',
  },
  attention_verdicts: {
    key: 'attentionVerdicts',
    schema: onOff,
    about: 'Judge from a finished reply whether the agent needs the developer.',
  },
  announce_completions: {
    key: 'announceCompletions',
    schema: z.enum(completionAnnouncementModes),
    about:
      'Which finished agents are announced: all, or attention_only (only those that need the developer are spoken and sound; the rest show on screen). attention_only needs attention_verdicts on.',
  },
  agent_requests: {
    key: 'agentRequests',
    schema: onOff,
    about: 'Let agents send requests to the conductor (start an agent, message one, ask).',
    confirmWhen: (value) => value === true,
  },
  auto_approve_plans: {
    key: 'autoApprovePlans',
    schema: onOff,
    about: 'Start planned agents without waiting for the developer to approve the plan.',
    confirmWhen: (value) => value === true,
  },
  fast_verbatim_routing: {
    key: 'jevVerbatimRouting',
    schema: onOff,
    about:
      "Send the developer's own words straight to an agent when the fast router is sure, without rewriting them.",
  },
  calls: {
    key: 'calls',
    schema: z.enum(callModes),
    about: 'How agents reach the developer: off (batched), quiet (shown), or spoken.',
  },
  call_window_seconds: {
    key: 'callWindowSec',
    schema: z.number().int().min(2).max(30),
    about: 'Seconds a call stays on the line (2 to 30).',
  },
  max_agents_per_plan: {
    key: 'maxAgentsPerPlan',
    schema: z.number().int().min(1).max(12),
    about: 'Most agents one plan may start (1 to 12).',
  },
  command_effort: {
    key: 'commandEffort',
    schema: effort,
    about: 'How hard the text conductor thinks about a quick command; higher is slower.',
  },
  plan_effort: {
    key: 'planEffort',
    schema: effort,
    about: 'How hard the text conductor thinks about a plan; higher is slower.',
  },
} as const satisfies Record<string, Adjustable>;

export type AdjustableSettingName = keyof typeof ADJUSTABLE_SETTINGS;

export const adjustableSettingNames = Object.keys(ADJUSTABLE_SETTINGS) as [
  AdjustableSettingName,
  ...AdjustableSettingName[],
];

/** What the developer has to change in the settings page themselves, said when they ask. */
export const SETTINGS_PAGE_ONLY =
  'the provider, models and API keys, the daily budgets, diagnostics, code checks, and the voice line (its model, voice, listening and reply length)';

const ON = new Set(['on', 'true', 'yes', 'enable', 'enabled', '1']);
const OFF = new Set(['off', 'false', 'no', 'disable', 'disabled', '0']);

export type SettingChange =
  | {
      ok: true;
      patch: Partial<ConductorSettings>;
      /** "Set calls to spoken", for a confirmation and the result. */
      label: string;
      confirm: boolean;
    }
  | { ok: false; message: string };

/**
 * Turns the model's `change_setting` call into a settings patch. The value arrives as text
 * ("on", "spoken", "6") because a voice model fills one plain field more reliably than a union,
 * and is read as whichever of a switch, a number or a choice the setting takes.
 */
export function parseSettingChange(setting: string, rawValue: string): SettingChange {
  if (!Object.hasOwn(ADJUSTABLE_SETTINGS, setting)) {
    return {
      ok: false,
      message: `${setting} is not a setting you can change. You can change: ${adjustableSettingNames.join(', ')}. The developer changes ${SETTINGS_PAGE_ONLY} in Settings → Voice & Conductor.`,
    };
  }
  const spec: Adjustable = ADJUSTABLE_SETTINGS[setting as AdjustableSettingName];
  const word = rawValue.trim().toLowerCase();
  const candidates: unknown[] = [word];
  if (ON.has(word)) candidates.unshift(true);
  if (OFF.has(word)) candidates.unshift(false);
  if (word !== '' && Number.isFinite(Number(word))) candidates.push(Number(word));
  for (const candidate of candidates) {
    const parsed = spec.schema.safeParse(candidate);
    if (!parsed.success) continue;
    const value: unknown = parsed.data;
    return {
      ok: true,
      patch: { [spec.key]: value },
      label: `Set ${setting.replace(/_/g, ' ')} to ${shown(value)}`,
      confirm: spec.confirmWhen?.(value) === true,
    };
  }
  return {
    ok: false,
    message: `${JSON.stringify(rawValue)} is not a value ${setting} takes. ${spec.about}`,
  };
}

function shown(value: unknown): string {
  return typeof value === 'boolean' ? (value ? 'on' : 'off') : String(value ?? '?');
}

/** Every adjustable setting with its current value, for `review_instructions`. */
export function describeAdjustableSettings(settings: ConductorSettings | null): string[] {
  return adjustableSettingNames.map((name) => {
    const spec: Adjustable = ADJUSTABLE_SETTINGS[name];
    return `- ${name} = ${shown(settings?.[spec.key])}. ${spec.about}`;
  });
}
