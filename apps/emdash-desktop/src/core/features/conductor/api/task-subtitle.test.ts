import { describe, expect, it } from 'vitest';
import { taskSubtitle, type TaskSubtitleChat } from './task-subtitle';

function chat(overrides: Partial<TaskSubtitleChat> = {}): TaskSubtitleChat {
  return {
    status: 'idle',
    completionSummary: null,
    decisionHeadline: null,
    helpers: 0,
    helperLabel: null,
    ...overrides,
  };
}

const everything = [
  chat({
    status: 'working',
    helpers: 2,
    helperLabel: 'Reading flow4_v2.png',
    decisionHeadline: 'Hang-up: ready to try, not merged.',
    completionSummary: 'fixed the hang-up',
  }),
];

describe('taskSubtitle', () => {
  it('shows the conductor headline first, unless the conductor is idle', () => {
    for (const state of ['working', 'needs_you', 'done'] as const) {
      expect(
        taskSubtitle({
          status: { state, headline: 'Login: tests failing.' },
          chats: everything,
          branchName: 'fix/login',
        })
      ).toBe('Login: tests failing.');
    }
    expect(
      taskSubtitle({
        status: { state: 'idle', headline: 'Login: tests failing.' },
        chats: [],
        branchName: 'fix/login',
      })
    ).toBe('On fix/login');
  });

  it('skips a conductor status with an empty headline', () => {
    expect(
      taskSubtitle({
        status: { state: 'working', headline: '  ' },
        chats: [],
        branchName: 'main',
      })
    ).toBe('On main');
  });

  it('then the helpers of a working chat, with their label when there is one', () => {
    expect(taskSubtitle({ status: null, chats: everything, branchName: 'main' })).toBe(
      '2 helpers · Reading flow4_v2.png'
    );
    expect(
      taskSubtitle({
        status: null,
        chats: [chat({ status: 'working', helpers: 1 })],
        branchName: 'main',
      })
    ).toBe('1 helper');
    expect(
      taskSubtitle({
        status: null,
        chats: [
          chat({ status: 'working', helpers: 1 }),
          chat({ status: 'working', helpers: 2, helperLabel: 'Running tests' }),
        ],
        branchName: null,
      })
    ).toBe('3 helpers · Running tests');
  });

  it('ignores helpers of a chat that is not working', () => {
    expect(
      taskSubtitle({
        status: null,
        chats: [chat({ status: 'awaiting-input', helpers: 2, helperLabel: 'Reading' })],
        branchName: 'main',
      })
    ).toBe('On main');
  });

  it('then the newest decision headline', () => {
    expect(
      taskSubtitle({
        status: null,
        chats: [
          chat({ status: 'completed', completionSummary: 'did a thing' }),
          chat({ decisionHeadline: 'Hang-up: ready to try, not merged.' }),
          chat({ decisionHeadline: 'Older: superseded.' }),
        ],
        branchName: 'main',
      })
    ).toBe('Hang-up: ready to try, not merged.');
  });

  it('then the completion summary as a sentence', () => {
    expect(
      taskSubtitle({
        status: null,
        chats: [chat({ status: 'completed', completionSummary: 'fixed the login flow' })],
        branchName: 'main',
      })
    ).toBe('Fixed the login flow.');
    expect(
      taskSubtitle({
        status: null,
        chats: [chat({ status: 'completed', completionSummary: 'Shipped it!' })],
        branchName: 'main',
      })
    ).toBe('Shipped it!');
  });

  it('then the branch', () => {
    expect(taskSubtitle({ status: null, chats: [chat()], branchName: 'feat/sidebar' })).toBe(
      'On feat/sidebar'
    );
  });

  it('else nothing', () => {
    expect(taskSubtitle({ status: null, chats: [], branchName: null })).toBeNull();
    expect(taskSubtitle({ status: null, chats: [chat()], branchName: ' ' })).toBeNull();
  });
});
