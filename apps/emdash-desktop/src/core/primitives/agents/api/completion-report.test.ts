import { describe, expect, it } from 'vitest';
import {
  buildCompletionReport,
  COMPLETION_REPORT_MAX_CHARS,
  extractAppUrls,
  finalAssistantReply,
  isLocalAppUrl,
  spokenAppUrl,
  TERMINAL_TAIL_REPORT_CHARS,
  terminalTailReport,
} from './completion-report';

const NODE_APP_REPLY = `I scaffolded the Express todo app and started the dev server.

- \`npm run dev\` is running in the background
- The app is live at http://localhost:3000 — the API is at http://localhost:3000/api/todos.

Open it in a browser to try adding a todo.`;

describe('buildCompletionReport', () => {
  it('keeps the whole final reply and pulls out the local app URL', () => {
    const report = buildCompletionReport(NODE_APP_REPLY);
    expect(report).toEqual({
      text: NODE_APP_REPLY,
      truncated: false,
      appUrls: ['http://localhost:3000/', 'http://localhost:3000/api/todos'],
    });
  });

  it('returns null for a missing or empty reply', () => {
    expect(buildCompletionReport(undefined)).toBeNull();
    expect(buildCompletionReport(null)).toBeNull();
    expect(buildCompletionReport('')).toBeNull();
    expect(buildCompletionReport(' \n\t \u001b[0m ')).toBeNull();
  });

  it('redacts secrets and URL credentials and strips terminal control sequences', () => {
    const report = buildCompletionReport(
      '\u001b[32mDone.\u001b[0m Set API_KEY=sk-ant-abcdefghijklmnopqrstuvwxyz0123 in .env; ' +
        'the database is postgres://admin:hunter2@localhost:5432/app and a token ghp_' +
        'a'.repeat(36) +
        '.'
    );
    expect(report?.text).not.toMatch(/sk-ant-|hunter2|ghp_a|\u001b/);
    expect(report?.text).toContain('Done.');
    expect(report?.text).toContain('postgres://[REDACTED_CREDENTIALS]@localhost:5432/app');
  });

  it('bounds a very long reply, keeping its head and tail', () => {
    const middle = 'filler line\n'.repeat(2_000);
    const report = buildCompletionReport(
      `Summary: shipped the dashboard.\n${middle}Next: open http://127.0.0.1:8080 to check it.`
    );
    expect(report?.truncated).toBe(true);
    expect(report!.text.length).toBeLessThanOrEqual(COMPLETION_REPORT_MAX_CHARS + 60);
    expect(report?.text.startsWith('Summary: shipped the dashboard.')).toBe(true);
    expect(report?.text).toMatch(/characters omitted/);
    expect(report?.text).toContain('Next: open http://127.0.0.1:8080 to check it.');
    // URLs are found in the whole reply, not just the kept part.
    expect(report?.appUrls).toEqual(['http://127.0.0.1:8080/']);
  });
});

describe('extractAppUrls', () => {
  it('finds loopback URLs in prose, markdown, and bare host:port form', () => {
    expect(
      extractAppUrls(
        'Vite: [app](http://localhost:5173/). Also `localhost:4000/graphql`, ' +
          '<http://0.0.0.0:8000>, and http://[::1]:9000/health.'
      )
    ).toEqual([
      'http://localhost:5173/',
      'http://localhost:4000/graphql',
      'http://localhost:8000/',
    ]);
  });

  it('ignores remote URLs', () => {
    expect(extractAppUrls('Deployed to https://example.com and https://evil.test:3000/x')).toEqual(
      []
    );
  });
});

describe('isLocalAppUrl', () => {
  it('accepts loopback http(s) only', () => {
    expect(isLocalAppUrl('http://localhost:3000/')).toBe(true);
    expect(isLocalAppUrl('https://app.localhost/')).toBe(true);
    expect(isLocalAppUrl('http://127.0.0.1:8080')).toBe(true);
    expect(isLocalAppUrl('https://example.com/')).toBe(false);
    expect(isLocalAppUrl('http://localhost.evil.com/')).toBe(false);
    expect(isLocalAppUrl('file:///C:/secrets.txt')).toBe(false);
    expect(isLocalAppUrl('http://user:pass@localhost:3000/')).toBe(false);
    expect(isLocalAppUrl('not a url')).toBe(false);
  });
});

describe('spokenAppUrl', () => {
  it('reads a URL the way a person would say it', () => {
    expect(spokenAppUrl('http://localhost:3000/')).toBe('localhost port 3000');
    expect(spokenAppUrl('http://127.0.0.1:5173/admin/users')).toBe(
      'localhost port 5173 slash admin slash users'
    );
  });
});

describe('finalAssistantReply', () => {
  it('returns the assistant text after the last tool call, never thinking', () => {
    expect(
      finalAssistantReply([
        { kind: 'message', role: 'user', text: 'Build it' },
        { kind: 'message', role: 'assistant', text: 'Starting.' },
        { kind: 'execute-tool-call' },
        { kind: 'thinking', text: 'secret plan' },
        { kind: 'message', role: 'assistant', text: 'Running at http://localhost:3000.' },
        { kind: 'message', role: 'assistant', text: 'Open it to try it.' },
      ])
    ).toBe('Running at http://localhost:3000.\n\nOpen it to try it.');
  });

  it('falls back to the last assistant message and returns null when there is none', () => {
    expect(
      finalAssistantReply([
        { kind: 'message', role: 'assistant', text: 'Here is the plan.' },
        { kind: 'execute-tool-call' },
      ])
    ).toBe('Here is the plan.');
    expect(finalAssistantReply([{ kind: 'message', role: 'user', text: 'hi' }])).toBeNull();
    expect(finalAssistantReply([])).toBeNull();
  });
});

describe('terminalTailReport', () => {
  // What a Codex TUI shows when it finishes: tool output, then its closing message, then chrome.
  const CODEX_SCREEN = [
    '• Ran npm install',
    '  └ added 212 packages in 9s',
    '',
    '',
    '',
    '╭──────────────────────────────────────────╮',
    '│ Built the todo app and started it on      │',
    '│ http://0.0.0.0:5173 — run npm test to    │',
    '│ check it. Token: sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCD │',
    '╰──────────────────────────────────────────╯',
    '',
    '› Ask Codex to do anything',
    '  ⏎ send   ⌃J newline   ⌃C quit',
  ].join('\n');

  it('keeps the closing message and URLs, drops borders and blank runs, redacts', () => {
    const report = terminalTailReport(CODEX_SCREEN)!;
    expect(report.source).toBe('terminal-tail');
    expect(report.truncated).toBe(false);
    expect(report.text).toContain('Built the todo app and started it on');
    expect(report.appUrls).toEqual(['http://localhost:5173/']);
    expect(report.text).not.toMatch(/[╭╰│─]/);
    expect(report.text).not.toMatch(/\n{3,}/);
    expect(report.text).not.toContain('abcdefghijklmnopqrstuvwxyz');
  });

  it('keeps the end of a long terminal and starts on a whole line', () => {
    const scrollback = Array.from({ length: 400 }, (_, i) => `line ${i} of tool output`).join('\n');
    const report = terminalTailReport(`${scrollback}\nDone: open http://localhost:3000`)!;
    expect(report.truncated).toBe(true);
    expect(report.text.length).toBeLessThanOrEqual(TERMINAL_TAIL_REPORT_CHARS);
    expect(report.text).toMatch(/^line \d+ of tool output/);
    expect(report.text.endsWith('Done: open http://localhost:3000')).toBe(true);
  });

  it('returns null for a missing or blank terminal', () => {
    expect(terminalTailReport(null)).toBeNull();
    expect(terminalTailReport(undefined)).toBeNull();
    expect(terminalTailReport('\n  \n╭────╮\n╰────╯\n')).toBeNull();
  });
});
