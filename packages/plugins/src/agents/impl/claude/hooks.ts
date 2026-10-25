import type {
  BackgroundWork,
  BackgroundWorkKind,
  CanonicalHookEvent,
  NotificationType,
} from '@emdash/core/services/agent-plugins/api/plugins';
import {
  buildNestedJsonHookConfig,
  configRoots,
  defaultHookEventParser,
  envConfigRoot,
  extractProviderSessionId,
  makeStdinHookCommand,
} from '@emdash/core/services/agent-plugins/api/plugins/helpers';

export const CLAUDE_SETTINGS_PATH = 'settings.json';

/**
 * Claude Code hook payloads, mapped onto canonical events:
 *
 * - Every payload includes `session_id`, and it changes when the user switches sessions inside
 *   the TUI (`/resume`). Status events carry it so the runtime resumes the session Claude is
 *   actually in, not the one it launched with.
 * - `Stop` lists the session's in-flight background work. Claude fires `Stop` whenever a turn
 *   ends, including when the turn only launched a background shell and is now waiting for it;
 *   the session is woken by a `<task-notification>` prompt when that work settles.
 * - `UserPromptSubmit` also fires for those machine-injected wake-ups.
 * - `Notification` carries `notification_type`; older builds omit it, so the message text is
 *   the fallback.
 */
function parseClaudeHookEvent(
  eventType: string,
  body: Record<string, unknown>
): CanonicalHookEvent {
  const event = parseClaudeStatusEvent(eventType, body);
  if (event.kind !== 'status') return event;
  const providerSessionId = extractProviderSessionId(body);
  return providerSessionId ? { ...event, providerSessionId } : event;
}

function parseClaudeStatusEvent(
  eventType: string,
  body: Record<string, unknown>
): CanonicalHookEvent {
  if (eventType === 'notification') return parseClaudeNotification(body);
  const event = defaultHookEventParser(eventType, body);
  if (event.kind !== 'status') return event;
  if (event.type === 'stop') {
    const backgroundWork = claudeBackgroundWork(body);
    return backgroundWork.length > 0 ? { ...event, backgroundWork } : event;
  }
  if (event.type === 'start' && isBackgroundWakeUp(body)) {
    return { ...event, initiator: 'background' };
  }
  return event;
}

/**
 * How Claude's `background_tasks[].type` labels bear on completion. Claude reports a friendly
 * label (2.1.310: local_agent → 'subagent', local_workflow → 'workflow', local_bash → 'shell',
 * monitor_mcp and monitor_ws → 'monitor', mcp_task → 'MCP task', in_process_teammate →
 * 'teammate', remote_agent → 'cloud session') and the raw discriminant for types it has no
 * label for.
 *
 * Teammates and cloud sessions are not 'agent' work although they are agents: an idle teammate
 * stays `running` between assignments, and a cloud session can be long-running (PR autofix), so
 * holding on them would pin the lead at working for good. Unlisted types count as 'process' for
 * the same reason: a wrong 'process' can only end a wait early, a wrong 'agent' never ends it.
 */
const CLAUDE_TASK_KINDS = new Map<string, BackgroundWorkKind>([
  ['subagent', 'agent'],
  ['workflow', 'agent'],
  ['shell', 'process'],
  ['monitor', 'process'],
  ['MCP task', 'process'],
  ['teammate', 'process'],
  ['cloud session', 'process'],
]);

/** Claude's own bookkeeping tasks; they never hand a result back to the conversation. */
const CLAUDE_HOUSEKEEPING_TASK_TYPES = new Set(['dream', 'auto-mode scan', 'memory import']);

const CLAUDE_IN_FLIGHT_TASK_STATUSES = new Set(['running', 'pending']);

/**
 * The work that will wake this session: `background_tasks` (shells, subagents, workflows,
 * monitors) and one-shot `session_crons` (ScheduleWakeup, `/loop`). Recurring crons are
 * excluded: a standing schedule does not mean the current request is unfinished.
 */
function claudeBackgroundWork(body: Record<string, unknown>): BackgroundWork[] {
  const work: BackgroundWork[] = [];
  for (const task of recordList(body.background_tasks)) {
    if (typeof task.id !== 'string') continue;
    if (typeof task.type === 'string' && CLAUDE_HOUSEKEEPING_TASK_TYPES.has(task.type)) continue;
    if (typeof task.status === 'string' && !CLAUDE_IN_FLIGHT_TASK_STATUSES.has(task.status)) {
      continue;
    }
    const kind = typeof task.type === 'string' ? CLAUDE_TASK_KINDS.get(task.type) : undefined;
    work.push({ id: `task:${task.id}`, kind: kind ?? 'process' });
  }
  for (const cron of recordList(body.session_crons)) {
    if (typeof cron.id !== 'string' || cron.recurring !== false) continue;
    work.push({ id: `cron:${cron.id}`, kind: 'wakeup' });
  }
  return work;
}

function recordList(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is Record<string, unknown> => typeof item === 'object' && item !== null
  );
}

const CLAUDE_USER_PROMPT_SOURCES = new Set(['user', 'sdk']);

/**
 * True when a settled background task or scheduled wakeup, not the user, submitted the prompt.
 * `source` is still rolling out; without it the injected `<task-notification>` prompt is the tell.
 */
function isBackgroundWakeUp(body: Record<string, unknown>): boolean {
  if (typeof body.source === 'string') return !CLAUDE_USER_PROMPT_SOURCES.has(body.source);
  return (
    typeof body.prompt === 'string' && body.prompt.trimStart().startsWith('<task-notification>')
  );
}

/** Claude notification types that need the user, mapped onto the canonical attention types. */
const CLAUDE_ATTENTION_NOTIFICATIONS = new Map<string, NotificationType>([
  ['permission_prompt', 'permission_prompt'],
  ['worker_permission_prompt', 'permission_prompt'],
  ['idle_prompt', 'idle_prompt'],
  ['elicitation_dialog', 'elicitation_dialog'],
  ['elicitation_url_dialog', 'elicitation_dialog'],
  ['agent_needs_input', 'elicitation_dialog'],
]);

/** Claude notification types that only inform; they must not read as "waiting for input". */
const CLAUDE_INFORMATIONAL_NOTIFICATIONS = new Set([
  'auth_success',
  'agent_completed',
  'elicitation_complete',
  'elicitation_response',
  'push_notification',
  'computer_use_enter',
  'computer_use_exit',
  'quota_auto_resume_fired',
  'quota_auto_resume_stale',
  'quota_auto_resume_disabled',
  'model_refusal_fallback',
]);

/**
 * Classify by `notification_type`. A missing or unrecognized type falls back to the message
 * text:
 *   /permission|approval/i → permission_prompt
 *   everything else        → idle_prompt (agent waiting / done)
 */
function parseClaudeNotification(body: Record<string, unknown>): CanonicalHookEvent {
  const message = typeof body.message === 'string' ? body.message : '';
  const claudeType = typeof body.notification_type === 'string' ? body.notification_type : '';
  if (CLAUDE_INFORMATIONAL_NOTIFICATIONS.has(claudeType)) return { kind: 'ignore' };
  const notificationType =
    CLAUDE_ATTENTION_NOTIFICATIONS.get(claudeType) ??
    (/permission|approval/i.test(message)
      ? ('permission_prompt' as const)
      : ('idle_prompt' as const));
  return {
    kind: 'status',
    type: 'notification',
    notificationType,
    message: message || undefined,
    title: typeof body.title === 'string' ? body.title : undefined,
  };
}

export function buildClaudeHookConfig() {
  return {
    ...buildNestedJsonHookConfig(CLAUDE_SETTINGS_PATH, [
      { hookKey: 'SessionStart', command: makeStdinHookCommand('session-start') },
      { hookKey: 'UserPromptSubmit', command: makeStdinHookCommand('start') },
      { hookKey: 'Notification', command: makeStdinHookCommand('notification') },
      { hookKey: 'Stop', command: makeStdinHookCommand('stop') },
    ]),
    resolveConfigRoots: configRoots(envConfigRoot('CLAUDE_CONFIG_DIR', '.claude')),
    parseHookEvent: parseClaudeHookEvent,
  };
}
