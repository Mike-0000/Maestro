import { describe, expect, it } from 'vitest';
import { busyInFolderNote, safeTaskName, type SpawnPeer } from './spawn-notes';

const peer = (extra: Partial<SpawnPeer> = {}): SpawnPeer => ({
  name: 'Quartz',
  projectId: 'p1',
  status: 'working',
  inProjectDirectory: true,
  ...extra,
});

describe('safeTaskName', () => {
  it('renames a task that equals an agent name, ignoring case and a trailing number', () => {
    for (const task of ['Quartz', 'quartz', 'Quartz 2']) {
      const result = safeTaskName(task, [peer()]);
      expect(result.name).toBe(`${task} task`);
      expect(result.note).toContain('agent Quartz');
    }
  });

  it('also checks the other title an agent goes by', () => {
    expect(safeTaskName('Logo work', [peer({ name: 'Tango', title: 'Logo work 3' })]).name).toBe(
      'Logo work task'
    );
  });

  it('leaves other names alone', () => {
    expect(safeTaskName('Fix login', [peer()])).toEqual({ name: 'Fix login' });
    expect(safeTaskName('Quartz refactor', [peer()])).toEqual({ name: 'Quartz refactor' });
  });
});

describe('busyInFolderNote', () => {
  it('names busy agents in the same project directory', () => {
    expect(busyInFolderNote('p1', [peer({ name: 'Maple' })])).toBe(
      'Maple is also working in this folder.'
    );
    expect(
      busyInFolderNote('p1', [
        peer({ name: 'Maple' }),
        peer({ name: 'Oscar', status: 'awaiting-input' }),
        peer({ name: 'Tango' }),
      ])
    ).toBe('Maple, Oscar and Tango are also working in this folder.');
  });

  it('ignores idle agents, worktrees, and other projects', () => {
    expect(
      busyInFolderNote('p1', [
        peer({ status: 'idle' }),
        peer({ inProjectDirectory: false }),
        peer({ projectId: 'p2' }),
      ])
    ).toBeNull();
  });
});
