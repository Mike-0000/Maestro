import { describe, expect, it } from 'vitest';
import { matchProject, normalizeProjectName, projectMatchError } from './project-match';

const PROJECTS = [
  { id: 'wearable', name: 'Wearable Maestro Trigger' },
  { id: 'wsl', name: 'Maestro (WSL)' },
  { id: 'ace', name: 'ACE COMBAT 8' },
  { id: 'chorus', name: 'chorus' },
];

describe('normalizeProjectName', () => {
  it('drops case, punctuation and "the … project"', () => {
    expect(normalizeProjectName('the Maestro (WSL) project')).toBe('maestro wsl');
    expect(normalizeProjectName('Ace Combat 8')).toBe('ace combat 8');
  });
});

describe('matchProject', () => {
  it('matches exact names in any case or punctuation', () => {
    expect(matchProject('Ace Combat 8', PROJECTS)).toEqual({ kind: 'match', id: 'ace' });
    expect(matchProject('Maestro WSL', PROJECTS)).toEqual({ kind: 'match', id: 'wsl' });
    expect(matchProject('the chorus project', PROJECTS)).toEqual({ kind: 'match', id: 'chorus' });
  });

  it('prefers the exact name over a name that contains it', () => {
    const projects = [...PROJECTS, { id: 'maestro', name: 'Maestro' }];
    expect(matchProject('Maestro', projects)).toEqual({ kind: 'match', id: 'maestro' });
  });

  it('reports a reference several projects contain instead of picking one', () => {
    expect(matchProject('Maestro', PROJECTS)).toEqual({
      kind: 'ambiguous',
      names: ['Wearable Maestro Trigger', 'Maestro (WSL)'],
    });
  });

  it('matches whole words only, and a unique containing name', () => {
    expect(matchProject('Wearable Trigger', PROJECTS)).toEqual({ kind: 'match', id: 'wearable' });
    expect(matchProject('chor', PROJECTS)).toEqual({ kind: 'none' });
  });

  it('explains what went wrong', () => {
    expect(projectMatchError('Maestro', matchProject('Maestro', PROJECTS) as never, PROJECTS)).toBe(
      '"Maestro" could mean "Wearable Maestro Trigger" or "Maestro (WSL)". Ask the developer which project they mean, or use its exact name.'
    );
    expect(projectMatchError('Nope', { kind: 'none' }, PROJECTS)).toContain('Open projects:');
  });
});
