import { describe, expect, it } from 'vitest';
import {
  announcementText,
  batchSource,
  planNoticeSource,
  speaksRequestOutcome,
  stillAnnounced,
  type AnnouncedAgent,
} from './announcements';

function agent(name: string, overrides: Partial<AnnouncedAgent> = {}): AnnouncedAgent {
  return {
    name,
    status: 'completed',
    notificationType: null,
    taskName: '',
    completionSummary: null,
    ...overrides,
  };
}

describe('announcementText', () => {
  it('leads with the task, then says what the agent did, from its completion synopsis', () => {
    expect(
      announcementText([
        agent('Kilo', {
          taskName: 'TTS research',
          completionSummary:
            'researched TTS models across three areas: naturalness, latency, and multilingual support',
        }),
      ])
    ).toBe(
      'TTS research is finished. Kilo researched TTS models across three areas: naturalness, latency, and multilingual support.'
    );
  });

  it('names the agent as a handle when the synopsis is not past tense', () => {
    expect(
      announcementText([
        agent('Kilo', { taskName: 'TTS research', completionSummary: 'TTS model comparison' }),
      ])
    ).toBe('TTS research is finished, on Kilo: TTS model comparison.');
  });

  it('does not double a title the synopsis already says', () => {
    expect(
      announcementText([
        agent('Kilo', {
          taskName: 'Flaky login test',
          completionSummary: 'fixed the flaky login test',
        }),
      ])
    ).toBe('Kilo fixed the flaky login test.');
  });

  it('leads one waiting agent with its task, and keeps several in the compact form', () => {
    const atlas = agent('Atlas', {
      status: 'awaiting-input',
      notificationType: 'permission_prompt',
      riskLevel: 'high',
      taskName: 'Login fix',
    });
    expect(announcementText([atlas])).toBe(
      'Login fix needs permission for something risky, on Atlas.'
    );
    expect(
      announcementText([
        atlas,
        agent('Bravo', {
          status: 'awaiting-input',
          notificationType: 'idle_prompt',
          taskName: 'Docs pass',
        }),
      ])
    ).toBe('Atlas needs permission for something risky, Bravo needs you.');
  });

  it('ends with one offer when asked and exactly one agent finished', () => {
    const kilo = agent('Kilo', {
      taskName: 'TTS research',
      completionSummary: 'TTS model comparison',
    });
    expect(announcementText([kilo], { offer: true })).toBe(
      'TTS research is finished, on Kilo: TTS model comparison. Want to see it?'
    );
    expect(announcementText([kilo], { offer: false })).toBe(
      'TTS research is finished, on Kilo: TTS model comparison.'
    );
    expect(announcementText([kilo])).not.toContain('Want to see it?');
    // Two finished agents: no single thing to show.
    expect(announcementText([kilo, agent('Zulu')], { offer: true })).not.toContain(
      'Want to see it?'
    );
    // Past the count collapse there is no offer either.
    expect(
      announcementText(
        ['A', 'B', 'C', 'D'].map((name) => agent(name)),
        { offer: true }
      )
    ).toBe('4 agents need you.');
  });

  it('says where a finished agent reported its app running', () => {
    expect(
      announcementText([
        agent('Zulu', {
          completionSummary: 'built the todo app and started the dev server',
          appUrl: 'http://localhost:3000/',
        }),
      ])
    ).toBe(
      'Zulu built the todo app and started the dev server. It reported the app at localhost port 3000.'
    );
  });

  it('falls back to the task name, then to the generic sentence', () => {
    expect(announcementText([agent('Kilo', { taskName: 'Research speech-to-text models' })])).toBe(
      'Kilo finished researching speech-to-text models.'
    );
    expect(announcementText([agent('Kilo')])).toBe('Kilo is done.');
  });

  it('keeps waiting agents in one clause and gives each completion its own sentence', () => {
    expect(
      announcementText([
        agent('Atlas', {
          status: 'awaiting-input',
          notificationType: 'permission_prompt',
          riskLevel: 'high',
        }),
        agent('Kilo', { completionSummary: 'fixed the flaky login test' }),
        agent('Bravo', { status: 'awaiting-input', notificationType: 'idle_prompt' }),
      ])
    ).toBe(
      'Atlas needs permission for something risky, Bravo needs you. Kilo fixed the flaky login test.'
    );
  });

  it('collapses large batches into a count and returns null for none', () => {
    expect(announcementText(['A', 'B', 'C', 'D'].map((name) => agent(name)))).toBe(
      '4 agents need you.'
    );
    expect(announcementText([])).toBeNull();
  });
});

describe('what is still worth telling', () => {
  const waiting = {
    conversationId: 'atlas',
    status: 'awaiting-input' as const,
    notificationType: 'permission_prompt' as const,
    seen: false,
  };

  it('keeps an agent that waits as it did, and drops one that moved on or was looked at', () => {
    expect(stillAnnounced([waiting], [waiting])).toEqual([waiting]);
    expect(stillAnnounced([waiting], [{ ...waiting, notificationType: null }])).toEqual([]);
    expect(stillAnnounced([waiting], [{ ...waiting, status: 'working' }])).toEqual([]);
    expect(stillAnnounced([waiting], [{ ...waiting, seen: true }])).toEqual([]);
    expect(stillAnnounced([waiting], [])).toEqual([]);
  });

  it('names what a batch is about', () => {
    expect(batchSource([{ status: 'completed', notificationType: null }])).toBe('completion');
    expect(batchSource([{ status: 'awaiting-input', notificationType: 'idle_prompt' }])).toBe(
      'idle'
    );
    expect(
      batchSource([
        { status: 'completed', notificationType: null },
        { status: 'awaiting-input', notificationType: 'permission_prompt' },
      ])
    ).toBe('attention');
  });
});

describe('speaksRequestOutcome', () => {
  it('says a new agent, a no, a failure and no decision', () => {
    expect(speaksRequestOutcome({ kind: 'spawn_agent', status: 'approved', words: '' })).toBe(true);
    for (const status of ['denied', 'failed', 'undecided', 'cancelled', null]) {
      expect(speaksRequestOutcome({ kind: 'message_agent', status, words: '' })).toBe(true);
    }
  });

  it('only shows a routine message or answer', () => {
    expect(
      speaksRequestOutcome({
        kind: 'message_agent',
        status: 'approved',
        words: 'Send this message to agent "Bravo": the tests pass now.',
      })
    ).toBe(false);
    expect(
      speaksRequestOutcome({
        kind: 'ask_conductor',
        status: 'answered',
        words: 'Question for you, the conductor: tabs or spaces? Told Atlas.',
      })
    ).toBe(false);
  });

  it('says anything that publishes, uploads, pushes, releases, deletes or pays', () => {
    for (const words of [
      'Question for you, the conductor: should I publish the mod to Nexus?',
      'Upload the build to the share.',
      'Can I push to main?',
      'Cut the release?',
      'Delete the old saves folder?',
      'Pay the invoice?',
      'Should I buy the domain?',
    ]) {
      expect(speaksRequestOutcome({ kind: 'ask_conductor', status: 'answered', words })).toBe(true);
    }
  });
});

describe('planNoticeSource', () => {
  it('marks what did not start or arrive as a failure, so holding calls does not hold it', () => {
    expect(planNoticeSource('Importer failed to start.')).toBe('failure');
    expect(planNoticeSource('Echo did not get its "Importer" brief: it is not running.')).toBe(
      'failure'
    );
    expect(planNoticeSource('The plan finished with 1 failed subtask.')).toBe('failure');
    expect(planNoticeSource('The plan is done. All 3 agents finished.')).toBe('other');
  });
});
