import type { PluginFs } from '@emdash/core/services/agent-plugins/api/plugins';
import { makeStdinHookCommand } from '@emdash/core/services/agent-plugins/api/plugins/helpers';
import { describe, expect, it } from 'vitest';
import { CLAUDE_SETTINGS_PATH } from './hooks';
import { provider } from './index';

const RESUMED_SESSION_ID = 'b637979b-a4b6-43b5-90c2-a2fbe61321d8';

function createMemoryFs(files = new Map<string, string>()): PluginFs {
  return {
    read: async (path) => files.get(path) ?? null,
    write: async (path, content) => {
      files.set(path, content);
    },
    delete: async (path) => {
      files.delete(path);
    },
    exists: async (path) => files.has(path),
    list: async () => [],
  };
}

describe('claude hooks', () => {
  const parse = provider.behavior.hooks!.parseHookEvent!;

  it('carries the session id on start events so an in-session /resume is tracked', () => {
    expect(
      parse('start', {
        session_id: RESUMED_SESSION_ID,
        hook_event_name: 'UserPromptSubmit',
        prompt: 'continue with the plan',
      })
    ).toEqual({
      kind: 'status',
      type: 'start',
      providerSessionId: RESUMED_SESSION_ID,
    });
  });

  it('carries the session id on stop events', () => {
    expect(parse('stop', { session_id: RESUMED_SESSION_ID, hook_event_name: 'Stop' })).toEqual({
      kind: 'status',
      type: 'stop',
      providerSessionId: RESUMED_SESSION_ID,
    });
  });

  it('keeps notification classification and adds the session id', () => {
    expect(
      parse('notification', {
        session_id: RESUMED_SESSION_ID,
        hook_event_name: 'Notification',
        message: 'Claude is waiting for your input',
      })
    ).toEqual({
      kind: 'status',
      type: 'notification',
      notificationType: 'idle_prompt',
      message: 'Claude is waiting for your input',
      providerSessionId: RESUMED_SESSION_ID,
    });
  });

  it('reports a background shell still running at stop as work the turn is waiting on', () => {
    // The Stop payload Claude Code 2.1.286 sent after launching a ~20 minute build-and-push
    // with `run_in_background` and replying "I'll report … when it finishes".
    expect(
      parse('stop', {
        session_id: RESUMED_SESSION_ID,
        hook_event_name: 'Stop',
        stop_hook_active: false,
        last_assistant_message: 'The push is running in the background (about 20 minutes).',
        background_tasks: [
          {
            id: 'bjfo4wxom',
            type: 'shell',
            status: 'running',
            description: 'Ship the gate fix to the local install and publish the release',
            command: 'node ship.mjs',
          },
        ],
        session_crons: [],
      })
    ).toEqual({
      kind: 'status',
      type: 'stop',
      lastAssistantMessage: 'The push is running in the background (about 20 minutes).',
      backgroundWork: [{ id: 'task:bjfo4wxom', kind: 'process' }],
      providerSessionId: RESUMED_SESSION_ID,
    });
  });

  it('reports a plain stop when nothing is in flight', () => {
    const event = parse('stop', {
      hook_event_name: 'Stop',
      background_tasks: [],
      session_crons: [],
    });
    expect(event).toEqual({ kind: 'status', type: 'stop' });
    expect(event).not.toHaveProperty('backgroundWork');
  });

  it('counts only work that will wake the session', () => {
    expect(
      parse('stop', {
        hook_event_name: 'Stop',
        background_tasks: [
          { id: 'a1', type: 'subagent', status: 'pending', description: 'review' },
          { id: 'd1', type: 'dream', status: 'running', description: 'memory consolidation' },
          { id: 's1', type: 'shell', status: 'completed', description: 'already done' },
        ],
        session_crons: [
          { id: 'wake', schedule: '5 12 1 10 *', recurring: false, prompt: 'check the deploy' },
          { id: 'daily', schedule: '0 9 * * 1-5', recurring: true, prompt: 'standup' },
        ],
      })
    ).toEqual({
      kind: 'status',
      type: 'stop',
      backgroundWork: [
        { id: 'task:a1', kind: 'agent' },
        { id: 'cron:wake', kind: 'wakeup' },
      ],
    });
  });

  it('reports a running subagent as agent work, which a later user turn cannot acknowledge', () => {
    // The Stop payload Claude Code 2.1.310 sent while a background subagent ran.
    expect(
      parse('stop', {
        hook_event_name: 'Stop',
        stop_hook_active: false,
        background_tasks: [
          {
            id: 'a0e74c182008ca32f',
            type: 'subagent',
            status: 'running',
            description: 'Run sleep 25 and reply',
            agent_type: 'general-purpose',
          },
          {
            id: 'byuv79cbh',
            type: 'shell',
            status: 'running',
            description: 'Sleep for 25 seconds in background',
            command: 'sleep 25',
          },
        ],
        session_crons: [],
      })
    ).toEqual({
      kind: 'status',
      type: 'stop',
      backgroundWork: [
        { id: 'task:a0e74c182008ca32f', kind: 'agent' },
        { id: 'task:byuv79cbh', kind: 'process' },
      ],
    });
  });

  it('classifies every task label Claude reports, and unknown ones as long-lived', () => {
    const kinds = {
      subagent: 'agent',
      workflow: 'agent',
      shell: 'process',
      monitor: 'process',
      'MCP task': 'process',
      teammate: 'process',
      'cloud session': 'process',
      some_future_type: 'process',
    };
    const event = parse('stop', {
      hook_event_name: 'Stop',
      background_tasks: Object.keys(kinds).map((type) => ({ id: type, type, status: 'running' })),
    });
    expect(event).toEqual({
      kind: 'status',
      type: 'stop',
      backgroundWork: Object.entries(kinds).map(([type, kind]) => ({ id: `task:${type}`, kind })),
    });
  });

  it('marks a start submitted by a settled background task as a background wake-up', () => {
    expect(
      parse('start', {
        hook_event_name: 'UserPromptSubmit',
        prompt: '<task-notification>\n<task-id>bjfo4wxom</task-id>\n</task-notification>',
      })
    ).toEqual({ kind: 'status', type: 'start', initiator: 'background' });
    expect(
      parse('start', { hook_event_name: 'UserPromptSubmit', source: 'system', prompt: 'woke' })
    ).toEqual({ kind: 'status', type: 'start', initiator: 'background' });
  });

  it('trusts the prompt source over its text for user prompts', () => {
    const event = parse('start', {
      hook_event_name: 'UserPromptSubmit',
      source: 'user',
      prompt: '<task-notification> is what the agent prints, why?',
    });
    expect(event).toEqual({ kind: 'status', type: 'start' });
  });

  it('classifies notifications by notification_type when Claude sends one', () => {
    expect(
      parse('notification', {
        hook_event_name: 'Notification',
        notification_type: 'worker_permission_prompt',
        message: 'A teammate wants to run Bash',
      })
    ).toMatchObject({ kind: 'status', notificationType: 'permission_prompt' });
    expect(
      parse('notification', {
        hook_event_name: 'Notification',
        notification_type: 'idle_prompt',
        message: 'Claude is waiting for your input',
      })
    ).toMatchObject({ kind: 'status', notificationType: 'idle_prompt' });
    expect(
      parse('notification', {
        hook_event_name: 'Notification',
        notification_type: 'elicitation_dialog',
        message: 'An MCP server needs your input',
      })
    ).toMatchObject({ kind: 'status', notificationType: 'elicitation_dialog' });
  });

  it('ignores informational notifications instead of reporting the agent as waiting', () => {
    for (const notificationType of ['agent_completed', 'auth_success', 'push_notification']) {
      expect(
        parse('notification', {
          hook_event_name: 'Notification',
          notification_type: notificationType,
          message: 'Background agent finished',
        })
      ).toEqual({ kind: 'ignore' });
    }
  });

  it('falls back to the message text for an unrecognized notification type', () => {
    expect(
      parse('notification', {
        hook_event_name: 'Notification',
        notification_type: 'some_future_type',
        message: 'Claude needs your permission to use Bash',
      })
    ).toMatchObject({ kind: 'status', notificationType: 'permission_prompt' });
  });

  it('omits the session id when the payload has none', () => {
    const event = parse('stop', { hook_event_name: 'Stop' });
    expect(event).toEqual({ kind: 'status', type: 'stop' });
    expect(event).not.toHaveProperty('providerSessionId');
  });

  it('maps SessionStart payloads to a session event', () => {
    expect(
      parse('session-start', {
        session_id: RESUMED_SESSION_ID,
        hook_event_name: 'SessionStart',
        source: 'resume',
      })
    ).toEqual({ kind: 'session', providerSessionId: RESUMED_SESSION_ID });
  });

  it('resumes the tracked provider session id instead of the conversation id', () => {
    const command = provider.behavior.prompt!.buildCommand({
      cli: 'claude',
      autoApprove: false,
      initialPrompt: undefined,
      sessionId: 'conversation-1',
      providerSessionId: RESUMED_SESSION_ID,
      isResuming: true,
      model: '',
    });

    expect(command.args.slice(0, 2)).toEqual(['--resume', RESUMED_SESSION_ID]);
  });

  it('declares session as a supported hook event', () => {
    expect(provider.capabilities.hooks).toEqual({
      kind: 'config',
      scope: 'global',
      supportedEvents: ['start', 'notification', 'stop', 'session'],
    });
  });

  it('installs a SessionStart hook that reports the Claude session id', async () => {
    const files = new Map<string, string>();
    const fs = createMemoryFs(files);

    await provider.behavior.hooks!.writeHooks(fs, []);

    const settings = JSON.parse(files.get(CLAUDE_SETTINGS_PATH)!);
    expect(settings.hooks.SessionStart).toEqual([
      { hooks: [{ type: 'command', command: makeStdinHookCommand('session-start') }] },
    ]);
  });
});
