import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import {
  EMDASH_MARKER,
  EMDASH_HOOK_VERSION_MARKER,
  filterUserHooks,
  isEmdashHookText,
  makeNotificationHookCommand,
  makeStdinHookCommand,
  makeWindowsPowerShellHookCommand,
} from './hooks';

describe('hook command helpers', () => {
  it('builds POSIX stdin hook commands', () => {
    expect(makeStdinHookCommand('stop', { platform: 'linux' })).toBe(
      `${EMDASH_HOOK_VERSION_MARKER}; ` +
        'if [ -z "${EMDASH_HOOK_PORT:-}" ] || [ -z "${EMDASH_HOOK_NONCE:-}" ] || [ -z "${EMDASH_PTY_ID:-}" ]; then exit 0; fi; ' +
        'curl -sf -X POST ' +
        '-H "Content-Type: application/json" ' +
        '-H "X-Emdash-Token: $EMDASH_HOOK_NONCE" ' +
        '-H "X-Emdash-Pty-Id: $EMDASH_PTY_ID" ' +
        '-H "X-Emdash-Event-Type: stop" ' +
        '-d @- ' +
        '"http://127.0.0.1:$EMDASH_HOOK_PORT/hook" || true'
    );
  });

  it.skipIf(process.platform === 'win32')(
    'does not invoke curl when the Emdash hook environment is absent',
    () => {
      const command = makeStdinHookCommand('stop', { platform: 'linux' });
      const shellCommand = `curl() { printf called; }; ${command}`;

      const outsideEmdash = spawnSync('/bin/sh', ['-c', shellCommand], {
        encoding: 'utf8',
        env: { PATH: process.env.PATH ?? '' },
        input: '{}',
      });
      const insideEmdash = spawnSync('/bin/sh', ['-c', shellCommand], {
        encoding: 'utf8',
        env: {
          PATH: process.env.PATH ?? '',
          EMDASH_HOOK_PORT: '1234',
          EMDASH_HOOK_NONCE: 'nonce',
          EMDASH_PTY_ID: 'pty-1',
        },
        input: '{}',
      });

      expect(outsideEmdash.status).toBe(0);
      expect(outsideEmdash.stdout).toBe('');
      expect(insideEmdash.status).toBe(0);
      expect(insideEmdash.stdout).toBe('called');
    }
  );

  it('builds Windows hook commands without a quoted cmd.exe body', () => {
    const command = makeNotificationHookCommand('idle_prompt', { platform: 'win32' });

    expect(command).toMatch(
      /^cmd\.exe \/d \/c set EMDASH_HOOK_MARKER=EMDASH_HOOK_CONFIG_VERSION=1 EMDASH_HOOK_PORT&&powershell\.exe -NoProfile -ExecutionPolicy Bypass -EncodedCommand [A-Za-z0-9+/]+=*$/
    );
    expect(command).toContain(EMDASH_MARKER);
    expect(command).not.toContain('/c "');
    expect(command).not.toContain('& powershell.exe');
  });

  it('emits no redirects (an outer shell parsing >NUL creates a stray NUL file)', () => {
    const command = makeWindowsPowerShellHookCommand('Write-Output "ok"');

    expect(command).not.toContain('>');
  });

  it.skipIf(process.platform === 'win32')(
    'returns safely quoted JSON when transport fails or routing variables are absent',
    () => {
      const response = {
        decision: 'stop',
        reason: "don't run $(printf injected) or `echo injected`",
      };
      const command = makeStdinHookCommand('stop', {
        platform: 'linux',
        stdoutJson: response,
      });
      for (const env of [
        {},
        { EMDASH_HOOK_PORT: '1234', EMDASH_HOOK_NONCE: 'nonce', EMDASH_PTY_ID: 'pty-1' },
      ]) {
        const result = spawnSync(
          '/bin/sh',
          ['-c', `curl() { printf 'unexpected server response'; return 22; }; ${command}`],
          { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', ...env }, input: '{}' }
        );
        expect(result.status).toBe(0);
        expect(JSON.parse(result.stdout)).toEqual(response);
      }
    }
  );

  it('keeps the Emdash markers visible to hook config cleanup without PowerShell args', () => {
    const command = makeWindowsPowerShellHookCommand('Write-Output "ok"');

    expect(
      command.startsWith(
        `cmd.exe /d /c set EMDASH_HOOK_MARKER=${EMDASH_HOOK_VERSION_MARKER} ${EMDASH_MARKER}&&powershell.exe `
      )
    ).toBe(true);
    expect(filterUserHooks([{ command }])).toHaveLength(0);
  });

  it('starts PowerShell directly for agents whose hook shell is Windows PowerShell 5.1', () => {
    // PowerShell 5.1 has no `&&`: the cmd.exe launcher fails there before anything is posted.
    const command = makeStdinHookCommand('stop', {
      platform: 'win32',
      windowsLauncher: 'powershell',
    });

    expect(command).toMatch(
      /^powershell\.exe -NoProfile -ExecutionPolicy Bypass -EncodedCommand [A-Za-z0-9+/]+=*$/
    );
    expect(command).not.toContain('&');
    expect(command).not.toContain('"');
    const script = Buffer.from(command.split(' ').at(-1) ?? '', 'base64').toString('utf16le');
    expect(script.startsWith(`<# ${EMDASH_HOOK_VERSION_MARKER} #> `)).toBe(true);
    expect(script).toContain("'X-Emdash-Event-Type' = 'stop'");
    expect(script).toContain('[Console]::In.ReadToEnd()');
  });

  it('finds the markers inside a directly launched PowerShell command', () => {
    const command = makeNotificationHookCommand('idle_prompt', {
      platform: 'win32',
      windowsLauncher: 'powershell',
    });
    const userScript = Buffer.from('Write-Output "mine"', 'utf16le').toString('base64');
    const userCommand = `powershell.exe -NoProfile -EncodedCommand ${userScript}`;

    expect(command).not.toContain(EMDASH_MARKER);
    expect(isEmdashHookText(command)).toBe(true);
    expect(isEmdashHookText(userCommand)).toBe(false);
    expect(filterUserHooks([{ command }, { command: userCommand }])).toEqual([
      { command: userCommand },
    ]);
  });

  it.runIf(process.platform === 'win32')(
    'posts a Windows stdin body byte for byte, so non-ASCII text arrives intact',
    async () => {
      const sent = JSON.stringify({
        last_assistant_message: 'Done — it’s “ready”. ● café \u{1F680}',
      });
      const received = new Promise<string>((resolve) => {
        const server = http.createServer((req, res) => {
          const chunks: Buffer[] = [];
          req.on('data', (chunk: Buffer) => chunks.push(chunk));
          req.on('end', () => {
            res.writeHead(200);
            res.end();
            server.close();
            resolve(Buffer.concat(chunks).toString('utf8'));
          });
        });
        server.listen(0, '127.0.0.1', () => {
          const child = spawn(makeStdinHookCommand('stop', { platform: 'win32' }), {
            shell: true,
            stdio: ['pipe', 'ignore', 'ignore'],
            env: {
              ...process.env,
              EMDASH_HOOK_PORT: String((server.address() as AddressInfo).port),
              EMDASH_HOOK_NONCE: 'nonce',
              EMDASH_PTY_ID: 'pty-1',
            },
          });
          child.stdin.end(sent);
        });
      });

      expect(await received).toBe(sent);
    },
    30_000
  );
});
