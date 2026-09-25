import { describe, expect, it } from 'vitest';
import { CANCEL_WINDOW_TOOLS, conductorToolNames, conductorToolSchemas } from './tools';

describe('conductor tools', () => {
  it('appends the app tools after the agent tools (prompt-cache order)', () => {
    expect(conductorToolNames.slice(-6)).toEqual([
      'start_app',
      'show_app',
      'look_at_app',
      'use_app',
      'stop_app',
      'close_app',
    ]);
    expect(conductorToolNames.indexOf('stop_agent')).toBe(conductorToolNames.length - 7);
  });

  it('gives app starts and stops a cancel window', () => {
    expect(CANCEL_WINDOW_TOOLS.has('start_app')).toBe(true);
    expect(CANCEL_WINDOW_TOOLS.has('stop_app')).toBe(true);
    expect(CANCEL_WINDOW_TOOLS.has('look_at_app')).toBe(false);
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
