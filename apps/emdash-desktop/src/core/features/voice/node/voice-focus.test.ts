import { describe, expect, it, vi } from 'vitest';
import {
  holdsVoiceFocus,
  VoiceFocus,
  voiceFocusFileName,
  type VoiceFocusPorts,
} from './voice-focus';

const PATH = '/appdata/chorus-voice-focus.json';

/** One shared marker file and a set of live pids, as several processes on one computer see it. */
function computer() {
  let file: string | null = null;
  const alive = new Set<number>();
  const watchers = new Set<() => void>();
  let clock = 1_000;
  const notify = () => {
    for (const watcher of [...watchers]) watcher();
  };
  const ports: VoiceFocusPorts = {
    readFile: () => file,
    writeFile: (_path, text) => {
      file = text;
      notify();
    },
    removeFile: () => {
      file = null;
      notify();
    },
    watch: (dir, fileName, onChange) => {
      expect(dir).toBe('/appdata');
      expect(fileName).toBe('chorus-voice-focus.json');
      watchers.add(onChange);
      return () => void watchers.delete(onChange);
    },
    isPidAlive: (pid) => alive.has(pid),
    now: () => (clock += 1),
  };
  const process = (pid: number, profile: string | null) => {
    alive.add(pid);
    const focus = new VoiceFocus({ path: PATH, pid, profile, ports });
    focus.start();
    return focus;
  };
  return {
    ports,
    process,
    kill: (pid: number) => alive.delete(pid),
    setFile: (text: string | null) => {
      file = text;
      notify();
    },
    file: () => file,
    watcherCount: () => watchers.size,
  };
}

describe('voiceFocusFileName', () => {
  it('names the marker after the shared user-data directory name', () => {
    expect(voiceFocusFileName('chorus')).toBe('chorus-voice-focus.json');
  });
});

describe('holdsVoiceFocus', () => {
  const alive = (pid: number) => pid === 2;
  it('belongs to the process the marker names', () => {
    expect(holdsVoiceFocus({ pid: 1, profile: '', at: 0 }, { pid: 1, profile: '' }, alive)).toBe(
      true
    );
  });
  it('belongs to nobody else while the named process lives', () => {
    expect(holdsVoiceFocus({ pid: 2, profile: '', at: 0 }, { pid: 1, profile: null }, alive)).toBe(
      false
    );
  });
  it('falls back to the local app when the marker is missing or its process is gone', () => {
    expect(holdsVoiceFocus(null, { pid: 1, profile: null }, alive)).toBe(true);
    expect(holdsVoiceFocus(null, { pid: 1, profile: 'fedora' }, alive)).toBe(false);
    const dead = { pid: 9, profile: 'fedora', at: 0 };
    expect(holdsVoiceFocus(dead, { pid: 1, profile: null }, alive)).toBe(true);
    expect(holdsVoiceFocus(dead, { pid: 3, profile: '' }, alive)).toBe(false);
  });
});

describe('VoiceFocus', () => {
  it('gives the keys to the local app until a client window is focused', () => {
    const pc = computer();
    const local = pc.process(1, null);
    const client = pc.process(2, '');
    expect(local.active()).toBe(true);
    expect(client.active()).toBe(false);
  });

  it('moves the keys to whichever window was focused last and tells every process', () => {
    const pc = computer();
    const local = pc.process(1, null);
    const client = pc.process(2, '');
    const fedora = pc.process(3, 'fedora');
    const changes: string[] = [];
    local.subscribe((active) => changes.push(`local:${active}`));
    client.subscribe((active) => changes.push(`client:${active}`));
    fedora.subscribe((active) => changes.push(`fedora:${active}`));

    fedora.claim();
    expect([local.active(), client.active(), fedora.active()]).toEqual([false, false, true]);
    client.claim();
    expect([local.active(), client.active(), fedora.active()]).toEqual([false, true, false]);
    local.claim();
    expect([local.active(), client.active(), fedora.active()]).toEqual([true, false, false]);
    expect(changes).toEqual([
      'local:false',
      'fedora:true',
      'client:true',
      'fedora:false',
      'local:true',
      'client:false',
    ]);
    expect(JSON.parse(pc.file()!)).toMatchObject({ pid: 1, profile: null });
  });

  it('does not rewrite the marker when the focused process already holds it', () => {
    const pc = computer();
    const client = pc.process(2, '');
    const write = vi.spyOn(pc.ports, 'writeFile');
    client.claim();
    client.claim();
    expect(write).toHaveBeenCalledOnce();
  });

  it('hands the keys back to the local app when the holder quits', () => {
    const pc = computer();
    const local = pc.process(1, null);
    const client = pc.process(2, 'fedora');
    client.claim();
    expect(local.active()).toBe(false);
    client.release();
    pc.kill(2);
    expect(pc.file()).toBeNull();
    expect(local.active()).toBe(true);
  });

  it('does not drop a marker another process holds when quitting', () => {
    const pc = computer();
    const local = pc.process(1, null);
    const client = pc.process(2, '');
    client.claim();
    local.release();
    expect(JSON.parse(pc.file()!)).toMatchObject({ pid: 2 });
    expect(pc.watcherCount()).toBe(1);
  });

  it('lets the local app take over from a holder that crashed once it re-reads the marker', () => {
    const pc = computer();
    const local = pc.process(1, null);
    const client = pc.process(2, '');
    client.claim();
    pc.kill(2);
    local.refresh();
    expect(local.active()).toBe(true);
  });

  it('keeps its answer while the marker is caught half written', () => {
    const pc = computer();
    const local = pc.process(1, null);
    pc.process(2, '').claim();
    pc.setFile('{"pid": 1');
    expect(local.active()).toBe(false);
  });

  it('still claims on focus when the marker cannot be written or watched', () => {
    const pc = computer();
    const ports: VoiceFocusPorts = {
      ...pc.ports,
      writeFile: () => {
        throw new Error('read-only');
      },
      watch: () => {
        throw new Error('no watcher');
      },
    };
    const client = new VoiceFocus({ path: PATH, pid: 5, profile: '', ports });
    client.start();
    expect(client.active()).toBe(false);
    client.claim();
    expect(client.active()).toBe(true);
  });
});
