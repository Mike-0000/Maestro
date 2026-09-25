import { describe, expect, it } from 'vitest';
import {
  registrationsToAcpMcpServers,
  summarizeAcpMcpServers,
  withExtraMcpServers,
} from './mcp-servers';

describe('registrationsToAcpMcpServers', () => {
  it('maps enabled stdio registrations to ACP stdio servers', () => {
    expect(
      registrationsToAcpMcpServers(
        [
          {
            name: 'filesystem',
            command: 'npx',
            args: ['-y', '@modelcontextprotocol/server-filesystem'],
            env: { TOKEN: 'secret' },
          },
        ],
        { http: false, sse: false }
      )
    ).toEqual([
      {
        name: 'filesystem',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem'],
        env: [{ name: 'TOKEN', value: 'secret' }],
      },
    ]);
  });

  it('skips disabled and malformed registrations', () => {
    expect(
      registrationsToAcpMcpServers(
        [
          { name: 'disabled', command: 'node', enabled: false },
          { name: 'missing-command' },
          { name: 'missing-url', type: 'http' },
        ],
        { http: true, sse: true }
      )
    ).toEqual([]);
  });

  it('filters http and sse registrations by advertised capabilities', () => {
    const registrations = [
      {
        name: 'docs',
        type: 'http',
        url: 'https://example.com/mcp',
        headers: { Authorization: 'Bearer token' },
      },
      {
        name: 'events',
        type: 'sse',
        url: 'https://example.com/sse',
      },
    ];

    expect(registrationsToAcpMcpServers(registrations, { http: true, sse: false })).toEqual([
      {
        type: 'http',
        name: 'docs',
        url: 'https://example.com/mcp',
        headers: [{ name: 'Authorization', value: 'Bearer token' }],
      },
    ]);
  });
});

describe('summarizeAcpMcpServers', () => {
  it('returns the display fields for session MCP popovers', () => {
    expect(
      summarizeAcpMcpServers([
        { name: 'filesystem', command: 'npx', args: [], env: [] },
        { type: 'http', name: 'docs', url: 'https://example.com/mcp', headers: [] },
      ])
    ).toEqual([
      { name: 'filesystem', transport: 'stdio' },
      { name: 'docs', transport: 'http' },
    ]);
  });
});

describe('withExtraMcpServers', () => {
  const configured = [
    { name: 'filesystem', command: 'npx', args: [], env: [] },
    { type: 'http' as const, name: 'chorus-browser', url: 'http://old', headers: [] },
  ];
  const extra = [
    {
      name: 'chorus-browser',
      url: 'http://127.0.0.1:4000/mcp',
      headers: { Authorization: 'Bearer chorus_bt_x' },
    },
  ];

  it('appends host servers and replaces same-named configured ones', () => {
    expect(withExtraMcpServers(configured, extra, { http: true, sse: false })).toEqual([
      configured[0],
      {
        type: 'http',
        name: 'chorus-browser',
        url: 'http://127.0.0.1:4000/mcp',
        headers: [{ name: 'Authorization', value: 'Bearer chorus_bt_x' }],
      },
    ]);
  });

  it('drops host servers when the agent lacks HTTP MCP', () => {
    expect(withExtraMcpServers(configured, extra, { http: false, sse: false })).toEqual(configured);
    expect(withExtraMcpServers(configured, undefined, { http: true, sse: false })).toEqual(
      configured
    );
  });
});
