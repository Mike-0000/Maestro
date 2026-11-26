import type { AgentCapabilities } from '@core/primitives/agents/api';
import type { CloseWhenDoneConfig, ConversationConfig } from '@core/primitives/automations/api';

/** One effort level an agent offers, in the order the picker lists them (lowest first). */
export type AutomationEffortOption = { id: string; label: string };

/**
 * How an automation's runs are tuned and ended, as the form holds it. `effort` null means the
 * agent's own default; `closeTimeoutMinutes` null means the runtime default. The timeout is kept
 * while the switch is off, so turning it back on restores what was typed.
 */
export type AutomationRunOptions = {
  effort: string | null;
  closeWhenDone: boolean;
  closeTimeoutMinutes: number | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The effort levels the agent offers, lowest first, or null when it offers none (the picker is
 * hidden then). Reads the capability defensively: a remote host can run an older build whose
 * agent payload has no effort options.
 */
export function automationEffortOptions(
  capabilities: AgentCapabilities | null | undefined
): AutomationEffortOption[] | null {
  const effort: unknown = capabilities?.effort;
  if (!isRecord(effort) || effort.kind !== 'selectable' || !isRecord(effort.effortOptions)) {
    return null;
  }
  const options = Object.entries(effort.effortOptions)
    .map(([id, option], index) => {
      const fields = isRecord(option) ? option : {};
      return {
        id,
        label: typeof fields.label === 'string' && fields.label.trim() ? fields.label : id,
        level: typeof fields.level === 'number' ? fields.level : Number.MAX_SAFE_INTEGER,
        index,
      };
    })
    .filter((option) => option.id.length > 0)
    .sort((a, b) => a.level - b.level || a.index - b.index)
    .map(({ id, label }) => ({ id, label }));
  return options.length > 0 ? options : null;
}

/** The chosen effort if the agent offers it, otherwise null (the agent default). */
export function resolveAutomationEffort(
  effort: string | null | undefined,
  options: readonly AutomationEffortOption[] | null
): string | null {
  if (!effort) return null;
  return options?.some((option) => option.id === effort) ? effort : null;
}

/** Seeds the form's run options from a stored automation. */
export function runOptionsFromConversationConfig(
  config: ConversationConfig | null | undefined
): AutomationRunOptions {
  return {
    effort: config?.effort || null,
    closeWhenDone: config?.closeWhenDone !== undefined,
    closeTimeoutMinutes: normalizeCloseTimeoutMinutes(config?.closeWhenDone?.timeoutMinutes),
  };
}

/** A whole, positive number of minutes, or null for "use the default". */
export function normalizeCloseTimeoutMinutes(minutes: number | null | undefined): number | null {
  if (minutes === null || minutes === undefined || !Number.isFinite(minutes)) return null;
  const whole = Math.floor(minutes);
  return whole > 0 ? whole : null;
}

/** Splits a timeout into the hours and minutes the two-part field shows. */
export function splitCloseTimeout(minutes: number): { hours: number; minutes: number } {
  const whole = Math.max(0, Math.floor(minutes));
  return { hours: Math.floor(whole / 60), minutes: whole % 60 };
}

/** "4 h", "45 min", "1 h 30 min": the words for a timeout, as the field reads. */
export function formatCloseTimeout(totalMinutes: number): string {
  const { hours, minutes } = splitCloseTimeout(totalMinutes);
  if (hours === 0) return `${minutes} min`;
  return minutes === 0 ? `${hours} h` : `${hours} h ${minutes} min`;
}

export type AutomationConversationConfigInput = AutomationRunOptions & {
  prompt: string;
  provider: string;
  model: string | null | undefined;
  useChatUi: boolean;
  /** Carried over from the stored automation; the form has no control for it. */
  title?: string;
};

/**
 * The conversation config the form saves. The run options are written only when set: no effort
 * chosen leaves `effort` out, the switch off leaves `closeWhenDone` out, and the switch on with
 * no timeout writes `{}` (the runtime default). So an automation saved before these options
 * existed keeps exactly the config it had until one of them is changed.
 */
export function buildAutomationConversationConfig({
  prompt,
  provider,
  model,
  useChatUi,
  title,
  effort,
  closeWhenDone,
  closeTimeoutMinutes,
}: AutomationConversationConfigInput): ConversationConfig {
  const timeoutMinutes = normalizeCloseTimeoutMinutes(closeTimeoutMinutes);
  const close: CloseWhenDoneConfig | undefined = closeWhenDone
    ? timeoutMinutes === null
      ? {}
      : { timeoutMinutes }
    : undefined;
  return {
    prompt: prompt.trim(),
    provider,
    autoApprove: false,
    type: useChatUi ? 'acp' : 'pty',
    ...(model && { model }),
    ...(title && { title }),
    ...(effort && { effort }),
    ...(close && { closeWhenDone: close }),
  };
}
