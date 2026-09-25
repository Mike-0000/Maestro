import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CanvasStore } from '@core/features/canvas/api/browser/stores/canvas-store';
import type { TraceEvent } from '../api/contract';
import { ConductorStore, type ConductorVoicePort } from '../browser/conductor-store';
import { InteractionDiagnostics } from './diagnostics';

const { client } = vi.hoisted(() => ({
  client: { appendTrace: vi.fn(), appendLog: vi.fn(), readTrace: vi.fn(), getStatus: vi.fn() },
}));
vi.mock('../api/browser/client', () => ({ getConductorClient: async () => client }));
vi.mock('../browser/roster', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>();
  return { ...original, installedProviders: async () => [] };
});

let dir: string | null = null;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = null;
  vi.clearAllMocks();
});

describe('one voice command', () => {
  it('retrieves the same ID for what was heard, executed, shown and spoken', async () => {
    dir = await mkdtemp(join(tmpdir(), 'chorus-interaction-'));
    const journal = new InteractionDiagnostics(dir);
    client.appendTrace.mockImplementation((event: TraceEvent) => journal.append(event, 7));
    client.readTrace.mockImplementation((query) => journal.read(query, 7));
    client.appendLog.mockResolvedValue(undefined);
    client.getStatus.mockResolvedValue({
      configured: false,
      jevReady: false,
      jevVia: null,
      settings: null,
      usageToday: { day: '', inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 },
    });
    let trace: (event: TraceEvent) => void = () => {};
    let transcript: (
      text: string,
      intent: 'command' | 'dictation',
      id: string
    ) => Promise<void> | void = () => {};
    const voice: ConductorVoicePort = {
      muted: false,
      setTraceHandler(handler) {
        trace = handler;
      },
      setTranscriptHandler(handler) {
        transcript = handler;
      },
      setVocabularyProvider() {},
      setMuted() {},
      announce() {},
      say(_text, id) {
        if (!id) return;
        trace({
          interactionId: id,
          at: new Date().toISOString(),
          kind: 'speech',
          detail: { status: 'started' },
        });
      },
    };
    const addNote = vi.fn();
    const canvas = {
      agentEntries: [],
      focusedTileId: null,
      noteDrop: null,
      attentionEntries: [],
      insights: new Map(),
      addNote,
      layoutWindows: [],
      regionEntries: [],
      selection: [],
      lastChange: null,
      stageActive: false,
      visibleTileIds: () => new Set<string>(),
      regionOf: () => null,
      currentRegion: () => null,
    } as unknown as CanvasStore;
    const store = new ConductorStore(canvas, voice);
    store.activate();
    const id = crypto.randomUUID();
    const heard = 'Take a note: trace works';
    trace({ interactionId: id, at: new Date().toISOString(), kind: 'stt-final', text: heard });
    await transcript(heard, 'command', id);
    const events = await store.recentTrace();
    expect(addNote).toHaveBeenCalledWith('trace works');
    expect(events.every((event) => event.interactionId === id)).toBe(true);
    expect(events.find((event) => event.kind === 'stt-final')?.text).toBe(heard);
    expect(events.find((event) => event.kind === 'route')?.detail?.intent).toBe('note');
    expect(events.find((event) => event.kind === 'reply')?.text).toBe('Noted.');
    expect(events.find((event) => event.kind === 'speech')?.detail?.status).toBe('started');
    store.dispose();
  });
});
