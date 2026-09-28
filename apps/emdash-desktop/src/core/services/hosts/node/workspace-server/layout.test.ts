import { describe, expect, it } from 'vitest';
import {
  validateWorkspaceServerVersion,
  windowsWorkspaceServerLayout,
  workspaceServerLayout,
  workspaceServerLayoutForHost,
} from './layout';

describe('workspaceServerLayout', () => {
  it('derives every managed path from the remote home', () => {
    const layout = workspaceServerLayout('/home/dev user');

    expect(layout.root).toBe('/home/dev user/.emdash/workspace-server');
    expect(layout.versionDirectory('1.2.3-canary.1')).toBe(
      '/home/dev user/.emdash/workspace-server/versions/1.2.3-canary.1'
    );
    expect(layout.currentLauncher).toBe(
      '/home/dev user/.emdash/workspace-server/current/bin/emdash-workspace-server'
    );
    expect(layout.socketPath).toBe('/home/dev user/.emdash/workspace-server/run/workspace.sock');
  });

  it('rejects unsafe homes and version components', () => {
    expect(() => workspaceServerLayout('relative/home')).toThrow('Invalid remote home');
    expect(() => workspaceServerLayout('/home/user\nother')).toThrow('Invalid remote home');
    expect(() => validateWorkspaceServerVersion('../1.2.3')).toThrow(
      'Invalid workspace-server version'
    );
    expect(() => validateWorkspaceServerVersion('1.2.3; rm -rf /')).toThrow(
      'Invalid workspace-server version'
    );
  });
});

describe('windowsWorkspaceServerLayout', () => {
  it('derives Windows paths from the profile directory', () => {
    const layout = windowsWorkspaceServerLayout(String.raw`C:\Users\Dev O'Brien`);

    expect(layout.root).toBe(String.raw`C:\Users\Dev O'Brien\.emdash\workspace-server`);
    expect(layout.currentPointer).toBe(
      String.raw`C:\Users\Dev O'Brien\.emdash\workspace-server\current`
    );
    expect(layout.versionNodeExecutable('1.2.3')).toBe(
      String.raw`C:\Users\Dev O'Brien\.emdash\workspace-server\versions\1.2.3\node.exe`
    );
    expect(layout.versionEntrypoint('1.2.3')).toBe(
      String.raw`C:\Users\Dev O'Brien\.emdash\workspace-server\versions\1.2.3\dist\index.mjs`
    );
    expect(layout.socketPath).toBe(
      String.raw`C:\Users\Dev O'Brien\.emdash\workspace-server\run\workspace.sock`
    );
  });

  it('accepts UNC profiles and drive roots', () => {
    expect(windowsWorkspaceServerLayout(String.raw`\\fs01\profiles\dev`).root).toBe(
      String.raw`\\fs01\profiles\dev\.emdash\workspace-server`
    );
    expect(windowsWorkspaceServerLayout('D:\\').root).toBe(String.raw`D:\.emdash\workspace-server`);
  });

  it.each([
    String.raw`Users\dev`,
    '/home/dev',
    'C:/Users/dev',
    'C:\\Users\\dev\\',
    String.raw`C:\Users\..\dev`,
    'C:\\Users\\dev\nother',
    String.raw`C:\Users\dev"x`,
    String.raw`C:\Users\a:b`,
    String.raw`\\?\C:\Users\dev`,
    String.raw`\\.\pipe\x`,
  ])('rejects %j', (home) => {
    expect(() => windowsWorkspaceServerLayout(home)).toThrow('Invalid remote home');
  });

  it('picks the layout from the probed host', () => {
    expect(workspaceServerLayoutForHost({ platform: 'posix', home: '/home/dev' }).platform).toBe(
      'posix'
    );
    expect(
      workspaceServerLayoutForHost({
        platform: 'windows',
        home: String.raw`C:\Users\dev`,
        architecture: 'x64',
      }).platform
    ).toBe('windows');
  });
});
