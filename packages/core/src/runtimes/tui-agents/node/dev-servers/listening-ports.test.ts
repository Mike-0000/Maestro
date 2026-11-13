import { describe, expect, it } from 'vitest';
import {
  commandLineMentionsDirectory,
  loopbackProbeHost,
  parsePosixProcessTable,
  parseLsofListeners,
  parseNetstatListeners,
  parseWindowsProcessTable,
  pruneStaleParentLinks,
} from './listening-ports';

// Captured from `netstat -ano` on Windows 11 (CRLF line endings, abridged).
const NETSTAT_OUTPUT = [
  '',
  'Active Connections',
  '',
  '  Proto  Local Address          Foreign Address        State           PID',
  '  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       2524',
  '  TCP    0.0.0.0:4100           0.0.0.0:0              LISTENING       102',
  '  TCP    127.0.0.1:5835         0.0.0.0:0              LISTENING       6792',
  '  TCP    10.0.0.53:139          0.0.0.0:0              LISTENING       4',
  '  TCP    10.0.0.53:49350        10.0.0.8:24800         ESTABLISHED     7740',
  '  TCP    10.0.0.53:61307        199.232.66.214:443     TIME_WAIT       0',
  '  TCP    [::]:135               [::]:0                 LISTENING       2524',
  '  TCP    [::1]:5173             [::]:0                 LISTENING       22848',
  '  UDP    0.0.0.0:53             *:*                                    5032',
  '  UDP    [::1]:1900             *:*                                    10524',
  '',
].join('\r\n');

// `netstat` on a German Windows: the state column is translated, the rest is not.
const NETSTAT_LOCALIZED_OUTPUT = [
  '  Proto  Lokale Adresse         Remoteadresse          Status           PID',
  '  TCP    0.0.0.0:4100           0.0.0.0:0              ABHÖREN         102',
  '  TCP    127.0.0.1:50000        127.0.0.1:4100         HERGESTELLT      300',
].join('\r\n');

// `lsof -nP -iTCP -sTCP:LISTEN -F pn` on macOS: lsof adds the `f` field itself.
const LSOF_OUTPUT = [
  'p102',
  'f23',
  'n*:4100',
  'f24',
  'n[::1]:5173',
  'p999',
  'f7',
  'n127.0.0.1:5432',
  'f8',
  'n[::]:5432',
  'p1234',
  'f12',
  'n10.0.0.53:8080',
  '',
].join('\n');

// Printed by the PowerShell process-table script: pid, parent pid, creation ms since 1601.
const WINDOWS_PROCESS_TABLE = [
  '0 0 0',
  '4 0 13438940295639',
  '100 48120 13438950000000',
  '101 100 13438950000500',
  '102 101 13438950001000',
  '999 640 13438940300000',
  '',
].join('\r\n');

describe('parseNetstatListeners', () => {
  it('reads IPv4 and IPv6 listening sockets with their owning pids', () => {
    expect(parseNetstatListeners(NETSTAT_OUTPUT)).toEqual([
      { pid: 2524, address: '0.0.0.0', port: 135 },
      { pid: 102, address: '0.0.0.0', port: 4100 },
      { pid: 6792, address: '127.0.0.1', port: 5835 },
      { pid: 4, address: '10.0.0.53', port: 139 },
      { pid: 2524, address: '::', port: 135 },
      { pid: 22848, address: '::1', port: 5173 },
    ]);
  });

  it('does not depend on the localized state column', () => {
    expect(parseNetstatListeners(NETSTAT_LOCALIZED_OUTPUT)).toEqual([
      { pid: 102, address: '0.0.0.0', port: 4100 },
    ]);
  });
});

describe('parseLsofListeners', () => {
  it('reads each process socket from field output', () => {
    expect(parseLsofListeners(LSOF_OUTPUT)).toEqual([
      { pid: 102, address: '*', port: 4100 },
      { pid: 102, address: '::1', port: 5173 },
      { pid: 999, address: '127.0.0.1', port: 5432 },
      { pid: 999, address: '::', port: 5432 },
      { pid: 1234, address: '10.0.0.53', port: 8080 },
    ]);
  });

  it('returns nothing for empty output (lsof exits 1 when nothing listens)', () => {
    expect(parseLsofListeners('')).toEqual([]);
  });
});

describe('parseWindowsProcessTable', () => {
  it('reads pid, parent pid and creation time', () => {
    expect(parseWindowsProcessTable(WINDOWS_PROCESS_TABLE)).toEqual([
      { pid: 0, ppid: 0 },
      { pid: 4, ppid: 0, createdAt: 13438940295639 },
      { pid: 100, ppid: 48120, createdAt: 13438950000000 },
      { pid: 101, ppid: 100, createdAt: 13438950000500 },
      { pid: 102, ppid: 101, createdAt: 13438950001000 },
      { pid: 999, ppid: 640, createdAt: 13438940300000 },
    ]);
  });
});

describe('parseWindowsProcessTable with command lines', () => {
  it('keeps the command line, spaces and all', () => {
    expect(
      parseWindowsProcessTable(
        [
          '501 500 13438950001000 "C:\\Program Files\\nodejs\\node.exe"  C:\\wt\\vite.js --port 4100',
          '4 0 13438940295639 ',
        ].join('\r\n')
      )
    ).toEqual([
      {
        pid: 501,
        ppid: 500,
        createdAt: 13438950001000,
        commandLine: '"C:\\Program Files\\nodejs\\node.exe"  C:\\wt\\vite.js --port 4100',
      },
      { pid: 4, ppid: 0, createdAt: 13438940295639 },
    ]);
  });
});

describe('parsePosixProcessTable', () => {
  it('reads pid, parent pid and the full command line', () => {
    expect(
      parsePosixProcessTable(
        [
          '  501   500 node /home/me/wt/node_modules/.bin/vite --port 4100',
          '    1     0 /sbin/init',
          '',
        ].join('\n')
      )
    ).toEqual([
      { pid: 501, ppid: 500, commandLine: 'node /home/me/wt/node_modules/.bin/vite --port 4100' },
      { pid: 1, ppid: 0, commandLine: '/sbin/init' },
    ]);
  });
});

describe('commandLineMentionsDirectory', () => {
  it('matches the directory as a whole path, in Windows, forward-slash and MSYS spellings', () => {
    const dir = 'C:\\Work\\shop\\checkout';
    expect(commandLineMentionsDirectory('node C:\\work\\shop\\checkout\\vite.js', dir)).toBe(true);
    expect(commandLineMentionsDirectory('node "c:/work/shop/checkout/vite.js"', dir)).toBe(true);
    expect(
      commandLineMentionsDirectory('bash -c "cd /c/work/shop/checkout && npm run dev"', dir)
    ).toBe(true);
    expect(commandLineMentionsDirectory('code C:\\work\\shop\\checkout', dir)).toBe(true);
  });

  it('does not match a longer sibling path or the directory under another root', () => {
    const dir = 'C:\\work\\shop\\checkout';
    expect(commandLineMentionsDirectory('node C:\\work\\shop\\checkout2\\vite.js', dir)).toBe(
      false
    );
    expect(commandLineMentionsDirectory('node D:\\c\\work\\shop\\checkout\\x.js', dir)).toBe(false);
    expect(commandLineMentionsDirectory('node vite.js', dir)).toBe(false);
  });

  it('matches POSIX paths', () => {
    expect(commandLineMentionsDirectory('node /home/me/wt/vite.js', '/home/me/wt/')).toBe(true);
    expect(commandLineMentionsDirectory('node /home/me/wtx/vite.js', '/home/me/wt')).toBe(false);
  });
});

describe('pruneStaleParentLinks', () => {
  it('cuts a link to a parent created after its child (a reused pid)', () => {
    const rows = pruneStaleParentLinks([
      { pid: 100, ppid: 1, createdAt: 2_000 },
      { pid: 101, ppid: 100, createdAt: 2_500 },
      // 777's parent died; its pid 100 now belongs to the younger agent process.
      { pid: 777, ppid: 100, createdAt: 1_000 },
    ]);
    expect(rows).toEqual([
      { pid: 100, ppid: 1, createdAt: 2_000 },
      { pid: 101, ppid: 100, createdAt: 2_500 },
      { pid: 777, ppid: -1, createdAt: 1_000 },
    ]);
  });

  it('keeps links when creation times are unknown', () => {
    const rows = [
      { pid: 100, ppid: 1 },
      { pid: 101, ppid: 100 },
    ];
    expect(pruneStaleParentLinks(rows)).toEqual(rows);
  });
});

describe('loopbackProbeHost', () => {
  it('dials the loopback of the family a socket is bound to', () => {
    expect(loopbackProbeHost('0.0.0.0')).toBe('127.0.0.1');
    expect(loopbackProbeHost('*')).toBe('127.0.0.1');
    expect(loopbackProbeHost('127.0.0.1')).toBe('127.0.0.1');
    expect(loopbackProbeHost('::')).toBe('::1');
    expect(loopbackProbeHost('::1')).toBe('::1');
  });

  it('skips sockets bound only to another interface', () => {
    expect(loopbackProbeHost('10.0.0.53')).toBeNull();
    expect(loopbackProbeHost('fe80::1')).toBeNull();
  });
});
