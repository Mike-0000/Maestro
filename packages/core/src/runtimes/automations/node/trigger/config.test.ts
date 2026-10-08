import { describe, expect, it } from 'vitest';
import { loadTriggerGatewayConfig, TRIGGER_CONFIG_ENV, TRIGGER_TOKEN_ENV } from './config';

const TOKEN = 'a-long-enough-secret-token-for-the-gateway';
const env = { [TRIGGER_TOKEN_ENV]: TOKEN, [TRIGGER_CONFIG_ENV]: '/etc/maestro/triggers.json' };
const file = (value: unknown) => async () => JSON.stringify(value);

describe('loadTriggerGatewayConfig', () => {
  it('applies loopback defaults', async () => {
    const result = await loadTriggerGatewayConfig(
      env,
      file({ triggers: { 'maestro-feature': { automationId: 'auto-1' } } })
    );

    expect(result).toEqual({
      success: true,
      data: {
        token: TOKEN,
        listen: { host: '127.0.0.1', port: 7461 },
        maxQueued: 20,
        triggers: { 'maestro-feature': { automationId: 'auto-1' } },
      },
    });
  });

  it('requires a long token and a config path', async () => {
    const short = await loadTriggerGatewayConfig(
      { ...env, [TRIGGER_TOKEN_ENV]: 'short' },
      file({})
    );
    const noPath = await loadTriggerGatewayConfig({ [TRIGGER_TOKEN_ENV]: TOKEN }, file({}));

    expect(short).toMatchObject({ success: false });
    expect(noPath).toMatchObject({ success: false });
  });

  it('rejects an unreadable, empty, or malformed config', async () => {
    const unreadable = await loadTriggerGatewayConfig(env, async () => {
      throw new Error('ENOENT');
    });
    const empty = await loadTriggerGatewayConfig(env, file({ triggers: {} }));
    const badName = await loadTriggerGatewayConfig(
      env,
      file({ triggers: { 'Not A Slug': { automationId: 'auto-1' } } })
    );

    for (const result of [unreadable, empty, badName]) {
      expect(result).toMatchObject({ success: false });
    }
  });
});
