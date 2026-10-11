import { describe, expect, it, vi } from 'vitest';
import type { CanvasStore } from '@core/features/canvas/api/browser/stores/canvas-store';
import type { ConductorStore } from './conductor-store';
import { conductorSnapshot, runRemoteConductorCommand } from './remote-voice-bridge';

vi.mock('./roster', () => ({
  buildRoster: () => [
    { id: 'c1', name: 'Atlas', providerLabel: 'Claude', taskName: 'Fix build' },
    { id: 'c2', name: 'Bravo', providerLabel: 'Codex', taskName: 'Docs', hidden: true },
  ],
}));
vi.mock('@core/features/remote-access/api/browser/client', () => ({
  getRemoteAccessClient: vi.fn(),
}));

function conductor(overrides: Partial<ConductorStore> = {}): ConductorStore {
  return {
    phase: 'idle',
    activity: '',
    lastUtterance: '',
    reply: '',
    replyAt: 0,
    error: null,
    pending: null,
    plans: { plan: null },
    vocabulary: () => ['Atlas', 'Bravo'],
    ...overrides,
  } as unknown as ConductorStore;
}

const canvas = {} as CanvasStore;

describe('conductorSnapshot', () => {
  it('mirrors the heads-up display and names only the visible agents', () => {
    const snapshot = conductorSnapshot(
      conductor({
        phase: 'acting',
        activity: 'Sending to Atlas',
        lastUtterance: 'tell Atlas to run the tests',
        reply: 'Sent.',
        replyAt: 1234,
        error: { message: 'Budget reached', kind: 'other' },
        pending: {
          id: 7,
          label: 'Send to Atlas',
          kind: 'confirm',
          startedAt: 5,
          durationMs: 30_000,
          armedAt: 5,
        },
      }),
      canvas
    );

    expect(snapshot).toEqual({
      phase: 'acting',
      activity: 'Sending to Atlas',
      lastUtterance: 'tell Atlas to run the tests',
      reply: 'Sent.',
      replyAt: 1234,
      error: 'Budget reached',
      pending: { id: 7, label: 'Send to Atlas', kind: 'confirm', startedAt: 5, durationMs: 30_000 },
      plan: null,
      agentNames: ['Atlas'],
      vocabulary: ['Atlas', 'Bravo'],
    });
  });

  it('summarises a proposed plan without shipping whole prompts', () => {
    const snapshot = conductorSnapshot(
      conductor({
        plans: {
          plan: {
            goal: 'Ship the settings page',
            status: 'proposed',
            subtasks: [{ title: 'UI', prompt: 'x'.repeat(500) }],
          },
        },
      } as never),
      canvas
    );

    expect(snapshot.plan).toEqual({
      goal: 'Ship the settings page',
      status: 'proposed',
      subtasks: [{ name: 'UI', detail: 'x'.repeat(200) }],
    });
  });

  it('caps the vocabulary sent for speech-to-text', () => {
    const words = Array.from({ length: 300 }, (_, index) => `word${index}`);
    expect(
      conductorSnapshot(conductor({ vocabulary: () => words }), canvas).vocabulary
    ).toHaveLength(200);
  });
});

describe('runRemoteConductorCommand', () => {
  it('runs device input as typed text so this computer stays silent', async () => {
    const handleUtterance = vi.fn(async () => {});

    await runRemoteConductorCommand(
      { handleUtterance },
      { type: 'utterance', text: 'focus Atlas' }
    );
    await runRemoteConductorCommand({ handleUtterance }, { type: 'respond', decision: 'yes' });
    await runRemoteConductorCommand({ handleUtterance }, { type: 'respond', decision: 'no' });

    expect(handleUtterance.mock.calls).toEqual([
      ['focus Atlas', 'typed'],
      ['yes', 'typed'],
      ['no', 'typed'],
    ]);
  });
});
