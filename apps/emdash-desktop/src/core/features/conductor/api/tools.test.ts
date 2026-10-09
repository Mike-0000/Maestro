import { describe, expect, it } from 'vitest';
import {
  CANCEL_WINDOW_TOOLS,
  CONFIRM_REQUIRED_TOOLS,
  conductorToolNames,
  conductorToolSchemas,
} from './tools';

describe('conductor tools', () => {
  it('appends the app tools after the agent tools (prompt-cache order)', () => {
    expect(conductorToolNames.slice(-25, -19)).toEqual([
      'start_app',
      'show_app',
      'look_at_app',
      'use_app',
      'stop_app',
      'close_app',
    ]);
    expect(conductorToolNames.indexOf('stop_agent')).toBe(conductorToolNames.length - 26);
  });

  it('appends the canvas layout, delivery, and data tools last', () => {
    expect(conductorToolNames.slice(-19, -16)).toEqual([
      'describe_canvas',
      'arrange_canvas',
      'canvas_view',
    ]);
    expect(conductorToolNames.slice(-16, -6)).toEqual([
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
    ]);
    expect(conductorToolNames.slice(-6)).toEqual([
      'agent_details',
      'recent_activity',
      'find_conversations',
      'read_clipboard',
      'rename_agent',
      'filter_canvas',
    ]);
    expect(
      conductorToolSchemas.arrange_canvas.safeParse({
        steps: [{ op: 'group', windows: ['Atlas', 'Bravo'], name: 'Review' }],
      }).success
    ).toBe(true);
    expect(conductorToolSchemas.arrange_canvas.safeParse({ steps: [] }).success).toBe(false);
    expect(conductorToolSchemas.canvas_view.safeParse({ action: 'zoom' }).success).toBe(false);
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
