import { describe, expect, it } from 'vitest';
import {
  agentLine,
  desksLine,
  epoch,
  newestFirst,
  newestPerProject,
  nowLine,
  soundAlikeLine,
  waitingLine,
  type AgentFact,
  type DeskFact,
} from './context-facts';

const MINUTE = 60_000;
const NOW = Date.parse('2026-10-08T23:18:00.000Z');

function fact(name: string, projectName: string, extra: Partial<AgentFact> = {}): AgentFact {
  return {
    name,
    providerLabel: 'Claude',
    status: 'working',
    taskName: `${name} task`,
    projectName,
    ...extra,
  };
}

describe('agentLine names', () => {
  it('gives the other names an agent answers to', () => {
    const line = agentLine(
      fact('Backend', 'chorus', { title: 'API work', formerly: ['Atlas 3', 'Atlas'] }),
      NOW
    );
    expect(line).toContain(
      '- Backend (Claude, also titled "API work", until just now called "Atlas 3" and "Atlas")'
    );
    expect(agentLine(fact('Backend', 'chorus'), NOW)).toContain('- Backend (Claude)');
  });
});

describe('agentLine', () => {
  it('states when the agent started, was messaged, and where it is', () => {
    expect(
      agentLine(
        fact('Jasper 3', 'chorus', {
          status: 'waiting for input',
          title: 'Vesper 3',
          focused: true,
          createdAt: NOW - 3 * 60 * MINUTE,
          lastMessagedAt: NOW - 12 * MINUTE,
          waitingSince: NOW - 8 * MINUTE,
          region: 'Chorus',
          diff: '+12/-3 lines',
        }),
        NOW
      )
    ).toBe(
      '- Jasper 3 (Claude, also titled "Vesper 3", focused): waiting for input for 8 min; ' +
        'task "Jasper 3 task" in project chorus; started 3 h ago; last messaged 12 min ago; ' +
        'in region Chorus; +12/-3 lines'
    );
  });

  it('says an agent that has no date yet is starting', () => {
    expect(agentLine(fact('Umber 3', 'chorus'), NOW)).toBe(
      '- Umber 3 (Claude): working; task "Umber 3 task" in project chorus; starting now'
    );
  });
});

describe('newestFirst', () => {
  it('orders by start time with agents still being created first', () => {
    const agents = [
      fact('Old', 'chorus', { createdAt: NOW - 90 * MINUTE }),
      fact('Starting', 'chorus'),
      fact('New', 'chorus', { createdAt: NOW - MINUTE }),
    ];
    expect(newestFirst(agents).map((agent) => agent.name)).toEqual(['Starting', 'New', 'Old']);
  });
});

describe('newestPerProject', () => {
  it('names the newest agent of each project', () => {
    const agents = [
      fact('Jasper 3', 'chorus', { createdAt: NOW - 300 * MINUTE }),
      fact('Umber 3', 'chorus', { createdAt: NOW - 5 * MINUTE }),
      fact('Lima 3', 'ACE COMBAT 8', { createdAt: NOW - 60 * MINUTE }),
    ];
    expect(newestPerProject(agents)).toBe('chorus: Umber 3; ACE COMBAT 8: Lima 3');
  });

  it('says nothing when every project has one agent', () => {
    expect(newestPerProject([fact('A', 'one'), fact('B', 'two')])).toBeNull();
    expect(newestPerProject([])).toBeNull();
  });
});

describe('waitingLine', () => {
  it('lists waiting agents longest first, only when there is an order to give', () => {
    const agents = [
      fact('Iris 3', 'chorus', { waitingSince: NOW - 4 * MINUTE }),
      fact('Jasper 3', 'chorus', { waitingSince: NOW - 200 * MINUTE }),
      fact('Lima 3', 'ACE COMBAT 8'),
    ];
    expect(waitingLine(agents, NOW)).toBe('Jasper 3 (3 h), Iris 3 (4 min)');
    expect(waitingLine(agents.slice(0, 1), NOW)).toBeNull();
  });
});

describe('soundAlikeLine', () => {
  it('lists names that differ only by their number', () => {
    const agents = [
      fact('Atlas', 'chorus'),
      fact('Atlas 3', 'website'),
      fact('Vesper 2', 'chorus'),
      fact('vesper', 'chorus'),
      fact('Lima 3', 'ACE COMBAT 8'),
    ];
    expect(soundAlikeLine(agents)).toBe('Atlas / Atlas 3; Vesper 2 / vesper');
    expect(soundAlikeLine([fact('Atlas', 'chorus'), fact('Bravo', 'chorus')])).toBeNull();
  });
});

describe('desks in the context (Canvas Pro)', () => {
  const desk = (name: string, extra: Partial<DeskFact> = {}): DeskFact => ({
    name,
    active: false,
    windowCount: 0,
    status: '',
    gathers: null,
    ...extra,
  });

  it('lists the desks in order, starring the one in view', () => {
    expect(
      desksLine([
        desk('Main', { windowCount: 3 }),
        desk('Review', { active: true, windowCount: 2, status: '1 needs you' }),
        desk('Triage', { gathers: 'needs you' }),
      ])
    ).toBe('Main (3), Review* (2, 1 needs you), Triage (gathers needs you)');
    expect(desksLine([])).toBe('none');
  });

  it('stays bounded, and still names the desk in view', () => {
    const many = Array.from({ length: 15 }, (_, index) =>
      desk(`D${index + 1}`, { windowCount: 1, active: index === 13 })
    );
    const line = desksLine(many, 3);
    expect(line).toBe('D1 (1), D2 (1), D3 (1), and 12 more, including D14* (1)');
    expect(desksLine(many.slice(0, 4), 3)).toBe('D1 (1), D2 (1), D3 (1), and 1 more');
  });

  it("says which desk an agent's window is on", () => {
    expect(agentLine(fact('Atlas', 'chorus', { desk: 'Review' }), NOW)).toContain('on desk Review');
    expect(agentLine(fact('Atlas', 'chorus', { desk: 'Review', region: 'Pair' }), NOW)).toContain(
      'in region Pair; on desk Review'
    );
  });
});

describe('nowLine and epoch', () => {
  it('gives the local date and time', () => {
    expect(nowLine(NOW)).toMatch(/^Now: \w+day, October \d+, 2026\b.*\d:\d\d [AP]M \(/);
  });

  it('reads ISO timestamps and tolerates missing ones', () => {
    expect(epoch('2026-10-08T23:18:00.000Z')).toBe(NOW);
    expect(epoch(null)).toBeUndefined();
    expect(epoch('not a date')).toBeUndefined();
  });

  it('reads a timestamp with no zone as UTC, not local time', () => {
    expect(epoch('2026-10-08 23:18:00')).toBe(NOW);
    expect(epoch('2026-10-08T23:18:00')).toBe(NOW);
    expect(epoch('2026-10-08 23:18:00.000')).toBe(NOW);
  });
});
