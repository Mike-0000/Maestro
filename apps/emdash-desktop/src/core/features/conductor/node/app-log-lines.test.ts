import { describe, expect, it } from 'vitest';
import { appLogRecord } from './app-log-lines';

const line = (entry: object) => JSON.stringify(entry);
const at = '2026-11-16T10:00:00.000Z';

describe('appLogRecord', () => {
  it('takes warnings and errors, with their fields', () => {
    const result = appLogRecord(
      line({
        level: 'error',
        time: at,
        proc: 'emdash-main',
        pid: 1,
        projectId: 'p1',
        error: { type: 'repository-unavailable', message: 'realpath failed', stack: 'Error: x' },
        msg: 'ProjectAttachmentManager: failed to attach Project',
      })
    );
    expect(result).toEqual({
      recordedAt: at,
      record: {
        level: 'error',
        msg: 'ProjectAttachmentManager: failed to attach Project',
        proc: 'emdash-main',
        pid: 1,
        projectId: 'p1',
        error: { type: 'repository-unavailable', message: 'realpath failed', stack: 'Error: x' },
      },
    });
    expect(appLogRecord(line({ level: 40, time: at, msg: 'w' }))?.record.level).toBe('warn');
  });

  it('skips info and debug, heartbeats, renderer lines and lines that are not JSON', () => {
    expect(appLogRecord(line({ level: 'info', time: at, msg: 'started' }))).toBeNull();
    expect(appLogRecord(line({ level: 30, time: at, msg: 'started' }))).toBeNull();
    expect(appLogRecord(line({ level: 'warn', time: at, msg: 'main: heartbeat' }))).toBeNull();
    expect(
      appLogRecord(line({ level: 'error', timestamp: at, source: 'renderer', message: 'x' }))
    ).toBeNull();
    expect(appLogRecord('not json')).toBeNull();
    expect(appLogRecord(line({ level: 'warn', msg: 'no time' }))).toBeNull();
  });

  it('never sends a token, key or password found in a line', () => {
    const github = `ghp_${'a'.repeat(36)}`;
    const anthropic = `sk-ant-api03-${'b'.repeat(40)}`;
    const publishable = `sb_publishable_${'c'.repeat(30)}`;
    const unknownKey = 'zq9-custom-upload-key-value-0001';
    const result = appLogRecord(
      line({
        level: 'error',
        time: at,
        msg: `auth failed with ${github} and token=abc123secret, Authorization: Bearer opaque0123456789`,
        apiKey: 'hunter2hunter2',
        password: 'hunter3hunter3',
        error: {
          message: `request to supabase with ${publishable} using ${anthropic} and ${unknownKey}`,
          sessionToken: 'session-secret-value',
        },
      }),
      [unknownKey]
    );
    const text = JSON.stringify(result);
    expect(result).not.toBeNull();
    for (const secret of [
      github,
      anthropic,
      publishable,
      unknownKey,
      'abc123secret',
      'opaque0123456789',
      'hunter2',
      'hunter3',
      'session-secret-value',
    ]) {
      expect(text).not.toContain(secret);
    }
    expect(text).toContain('auth failed with');
  });

  it('drops output, prompts and text, and shortens long strings', () => {
    const result = appLogRecord(
      line({
        level: 'warn',
        time: at,
        msg: 'runtime stderr',
        chunk: 'the contents of a file',
        data: ['typed by the developer'],
        prompt: 'a prompt',
        topOutput: 'process list',
        command: 'git push',
        detail: 'x'.repeat(5_000),
      })
    );
    const text = JSON.stringify(result);
    for (const dropped of [
      'contents of a file',
      'typed by the developer',
      'a prompt',
      'process list',
      'git push',
    ]) {
      expect(text).not.toContain(dropped);
    }
    expect(String(result?.record.detail).length).toBeLessThan(1_100);
  });
});
