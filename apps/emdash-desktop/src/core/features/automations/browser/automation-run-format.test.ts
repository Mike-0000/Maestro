import { describe, expect, it } from 'vitest';
import { formatAutomationError, formatRunDeliveryLabel } from './automation-run-format';

describe('formatAutomationError', () => {
  it('formats a typed definition error wrapped as an Error cause', () => {
    const cause = {
      type: 'invalid-definition',
      reason: 'conversation_config_prompt_required',
      message: 'Prompt required',
    } as const;

    expect(formatAutomationError(new Error(cause.message, { cause }))).toBe(
      'Add a prompt before saving'
    );
  });

  it('formats typed adoption errors', () => {
    expect(
      formatAutomationError({
        type: 'run-not-adoptable',
        runId: 'run-1',
        message: 'Not ready',
      })
    ).toBe('The automation workspace is not ready yet');
  });

  it('preserves free-form runtime messages', () => {
    expect(
      formatAutomationError({ type: 'runtime-unavailable', message: 'Host disconnected' })
    ).toBe('Host disconnected');
  });

  it('keeps the legacy local cron validation mapping', () => {
    expect(formatAutomationError(new Error('cron_invalid'))).toBe('Enter a valid schedule');
  });
});

describe('formatRunDeliveryLabel', () => {
  const delivery = { pullRequestUrl: null, finishedAt: 10 };

  it('labels a closed run', () => {
    expect(formatRunDeliveryLabel({ ...delivery, state: 'closed', error: null })).toBe(
      'Agent finished and was closed'
    );
  });

  it('words agent timeout and incomplete codes', () => {
    expect(
      formatRunDeliveryLabel({ ...delivery, state: 'failed', error: { code: 'agent_timeout' } })
    ).toBe('Delivery failed: The agent did not finish before the timeout');
    expect(
      formatRunDeliveryLabel({ ...delivery, state: 'failed', error: { code: 'agent_incomplete' } })
    ).toBe('Delivery failed: The agent stopped without finishing');
  });

  it('prefers a recorded message and falls back to an unknown code', () => {
    expect(
      formatRunDeliveryLabel({
        ...delivery,
        state: 'failed',
        error: { code: 'agent_timeout', message: 'Took too long' },
      })
    ).toBe('Delivery failed: Took too long');
    expect(
      formatRunDeliveryLabel({ ...delivery, state: 'failed', error: { code: 'push_failed' } })
    ).toBe('Delivery failed: push_failed');
  });
});
