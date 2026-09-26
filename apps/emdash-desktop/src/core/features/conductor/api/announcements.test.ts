import { describe, expect, it } from 'vitest';
import { announcementText, type AnnouncedAgent } from './announcements';

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
  it('says what a finished agent did, from its completion synopsis', () => {
    expect(
      announcementText([
        agent('Kilo', {
          taskName: 'TTS research',
          completionSummary:
            'researched TTS models across three areas: naturalness, latency, and multilingual support',
        }),
      ])
    ).toBe(
      'Kilo researched TTS models across three areas: naturalness, latency, and multilingual support.'
    );
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
