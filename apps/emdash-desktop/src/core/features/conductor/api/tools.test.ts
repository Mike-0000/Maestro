import { describe, expect, it } from 'vitest';
import { isFollowUpTool } from './completion-follow-up';
import {
  CANCEL_WINDOW_TOOLS,
  CONFIRM_REQUIRED_TOOLS,
  conductorToolNames,
  conductorToolSchemas,
} from './tools';

describe('conductor tools', () => {
  // Each group was appended after the ones before it and must stay in place: a tool inserted or
  // reordered earlier would change the cached prefix. Positions are counted from each group's
  // first tool, so appending a new tool at the end never disturbs these.
  const run = (first: string, count: number) => {
    const at = conductorToolNames.indexOf(first as (typeof conductorToolNames)[number]);
    return conductorToolNames.slice(at, at + count);
  };

  it('appends the app tools after the agent tools (prompt-cache order)', () => {
    expect(run('stop_agent', 7)).toEqual([
      'stop_agent',
      'start_app',
      'show_app',
      'look_at_app',
      'use_app',
      'stop_app',
      'close_app',
    ]);
  });

  it('appends the canvas layout, delivery, data, and request tools after them', () => {
    expect(run('close_app', 21)).toEqual([
      'close_app',
      'describe_canvas',
      'arrange_canvas',
      'canvas_view',
      'delivery_status',
      'enable_delivery',
      'prepare_delivery',
      'resume_delivery',
      'validate_delivery',
      'promote_delivery',
      'push_delivery_backup',
      'schedule_delivery',
      'cancel_delivery',
      'rollback_delivery',
      'agent_details',
      'recent_activity',
      'find_conversations',
      'read_clipboard',
      'rename_agent',
      'filter_canvas',
      'answer_request',
    ]);
    expect(
      conductorToolSchemas.arrange_canvas.safeParse({
        steps: [{ op: 'group', windows: ['Atlas', 'Bravo'], name: 'Review' }],
      }).success
    ).toBe(true);
    expect(conductorToolSchemas.arrange_canvas.safeParse({ steps: [] }).success).toBe(false);
    expect(conductorToolSchemas.canvas_view.safeParse({ action: 'zoom' }).success).toBe(false);
  });

  it('appends the Canvas Pro desk tool after the request tool', () => {
    expect(run('answer_request', 2)).toEqual(['answer_request', 'canvas_desks']);
    const desks = conductorToolSchemas.canvas_desks;
    expect(desks.safeParse({ action: 'switch', desk: 'next' }).success).toBe(true);
    expect(
      desks.safeParse({ action: 'create', name: 'Triage', gather: 'needs-you', follow: false })
        .success
    ).toBe(true);
    expect(
      desks.safeParse({ action: 'move_windows', windows: ['Atlas'], desk: 'Review', follow: true })
        .success
    ).toBe(true);
    expect(desks.safeParse({ action: 'set_mode', mode: 'pro' }).success).toBe(true);
    expect(desks.safeParse({ action: 'overview' }).success).toBe(false);
    expect(desks.safeParse({ action: 'reorder', position: 'middle' }).success).toBe(false);
    expect(desks.safeParse({ action: 'create', gather: 'waiting' }).success).toBe(false);
    expect(desks.safeParse({ action: 'set_mode', mode: 'glass' }).success).toBe(false);
    // A desk change is layout: it previews like one and needs no confirmation of its own.
    expect(CANCEL_WINDOW_TOOLS.has('canvas_desks')).toBe(false);
    expect(CONFIRM_REQUIRED_TOOLS.has('canvas_desks')).toBe(false);
  });

  it('appends the code-check tool last, behind neither a confirmation nor a countdown', () => {
    // Last of 43: the tool list without it is then a plain prefix of the list with it. A tool
    // appended later goes after it (the service handles either list), and this moves with it.
    expect(run('canvas_desks', 2)).toEqual(['canvas_desks', 'investigate']);
    expect(conductorToolNames.at(-1)).toBe('investigate');
    expect(conductorToolNames).toHaveLength(43);
    const investigate = conductorToolSchemas.investigate;
    expect(investigate.safeParse({ questions: ['Is there a retry helper?'] }).success).toBe(true);
    expect(
      investigate.safeParse({
        questions: ['Where is the upload code?', 'Which tests cover it?', 'Is there a queue?'],
        project: 'chorus',
        agent: 'Atlas',
      }).success
    ).toBe(true);
    expect(investigate.safeParse({ questions: [] }).success).toBe(false);
    expect(investigate.safeParse({ questions: ['short'] }).success).toBe(false);
    expect(investigate.safeParse({ questions: ['x'.repeat(401)] }).success).toBe(false);
    expect(
      investigate.safeParse({ questions: Array.from({ length: 4 }, () => 'Is there a helper?') })
        .success
    ).toBe(false);
    // It only reads, so it runs at once. What follows a check is gated by the tainted-turn rule.
    expect(CANCEL_WINDOW_TOOLS.has('investigate')).toBe(false);
    expect(CONFIRM_REQUIRED_TOOLS.has('investigate')).toBe(false);
    // A finished agent's reply is untrusted, so it can never start a check.
    expect(isFollowUpTool('investigate')).toBe(false);
  });

  it('gives app starts and stops a cancel window', () => {
    expect(CANCEL_WINDOW_TOOLS.has('start_app')).toBe(true);
    expect(CANCEL_WINDOW_TOOLS.has('stop_app')).toBe(true);
    expect(CANCEL_WINDOW_TOOLS.has('look_at_app')).toBe(false);
  });

  it('requires explicit confirmation for delivery rollback', () => {
    expect(CONFIRM_REQUIRED_TOOLS.has('rollback_delivery')).toBe(true);
    expect(conductorToolSchemas.rollback_delivery.safeParse({ candidate_id: 'bad' }).success).toBe(
      false
    );
  });

  it('validates app tool input', () => {
    expect(conductorToolSchemas.look_at_app.safeParse({ mode: 'outline' }).success).toBe(true);
    expect(conductorToolSchemas.look_at_app.safeParse({ mode: 'video' }).success).toBe(false);
    expect(
      conductorToolSchemas.use_app.safeParse({ agent: 'Atlas', action: 'click', ref: 'e3' }).success
    ).toBe(true);
    expect(conductorToolSchemas.use_app.safeParse({ action: 'hover' }).success).toBe(false);
  });
});
