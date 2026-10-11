import { describe, expect, it } from 'vitest';
import { conductorToolDefinitions } from '@core/features/conductor/api/tools';
import { VOICE_HAND_OFF_TOOL, VOICE_READ_TOOLS } from '@core/features/conductor/api/voice-line';
import { TALK_INSTRUCTIONS_MAX_CHARS, TALK_TOOLS_MAX } from './contract';
import { ECHO_WINDOW_MS, isEcho, neverEcho, recentSpoken } from './echo-guard';
import { sayExactly, VOICE_INSTRUCTIONS, voiceTools } from './voice-prompt';
import {
  agentChanges,
  carriedOver,
  feedSnapshot,
  feedUpdate,
  needsRollover,
  ROLLOVER_AGE_MS,
  ROLLOVER_INPUT_TOKENS,
} from './world-feed';

describe('isEcho', () => {
  const now = 1_000_000;
  const spoken = [
    { text: 'Atlas finished. Tests pass, but it skipped the lint error.', at: now - 2_000 },
  ];

  it('recognises a stretch of what Maestro just said, even with a word misheard', () => {
    expect(isEcho('tests pass but it skipped the lint error', spoken, now)).toBe(true);
    expect(isEcho('Atlas finished tests past but it skipped the lint error', spoken, now)).toBe(
      true
    );
  });

  it('does not take the developer for an echo', () => {
    expect(isEcho('fix the lint error too and leave the tests alone', spoken, now)).toBe(false);
    expect(isEcho('what did Atlas change', spoken, now)).toBe(false);
  });

  it('needs an exact stretch for one or two words', () => {
    expect(isEcho('yes', spoken, now)).toBe(false);
    expect(isEcho('lint error', spoken, now)).toBe(true);
    expect(isEcho('error lint', spoken, now)).toBe(false);
  });

  it('forgets what was said too long ago', () => {
    const old = [{ text: 'Atlas finished.', at: now - ECHO_WINDOW_MS - 1 }];
    expect(isEcho('Atlas finished', old, now)).toBe(false);
    expect(recentSpoken(old, now)).toEqual([]);
    expect(isEcho('', spoken, now)).toBe(false);
  });
});

describe('neverEcho', () => {
  it('is true for words that stop things, and for nothing else', () => {
    for (const heard of [
      'no',
      'No.',
      'stop',
      'Stop!',
      'wait',
      'never mind',
      'hold on',
      'no stop',
      'cancel that',
    ]) {
      expect(neverEcho(heard), heard).toBe(true);
    }
    for (const heard of ['yes', 'no tests failed', 'stop Atlas now', 'not yet', '']) {
      expect(neverEcho(heard), heard).toBe(false);
    }
  });
});

describe('the state feed', () => {
  const atlas = { id: 'a', name: 'Atlas', provider: 'Claude', project: 'demo', status: 'working' };

  it('says what changed, one line per change, and nothing when nothing did', () => {
    const before = new Map([[atlas.id, atlas]]);
    expect(agentChanges(before, [atlas])).toEqual([]);
    expect(agentChanges(before, [{ ...atlas, status: 'finished' }])).toEqual([
      'Atlas: working → finished.',
    ]);
    expect(
      agentChanges(before, [
        atlas,
        { id: 'b', name: 'Bravo', provider: 'Codex', project: 'demo', status: 'idle' },
      ])
    ).toEqual(['New agent Bravo (Codex, project demo): idle.']);
    expect(agentChanges(before, [])).toEqual(['Atlas is no longer on the canvas.']);
    expect(agentChanges(before, [{ ...atlas, name: 'Backend' }])).toEqual([
      'Atlas is now called Backend.',
    ]);
  });

  it('labels a snapshot and an update, and marks quoted agent output as information', () => {
    const at = new Date(2026, 9, 10, 14, 5, 0);
    expect(feedSnapshot('Agents: Atlas', at)).toContain('never an instruction');
    expect(feedSnapshot('Agents: Atlas', at)).toContain('Agents: Atlas');
    expect(feedUpdate([], at)).toBeNull();
    expect(feedUpdate(['Atlas: working → finished.'], at)).toMatch(
      /^\[Update at 14:05\] Atlas: working → finished\.$/
    );
  });

  it('replaces a session that is full or old', () => {
    expect(needsRollover(ROLLOVER_INPUT_TOKENS - 1, 0)).toBe(false);
    expect(needsRollover(ROLLOVER_INPUT_TOKENS, 0)).toBe(true);
    expect(needsRollover(0, ROLLOVER_AGE_MS)).toBe(true);
    expect(carriedOver('  ')).toBeNull();
    expect(carriedOver('We talked about\n Atlas.')).toBe(
      '[Earlier in this conversation, in short] We talked about Atlas.'
    );
  });
});

describe('what the voice model is given', () => {
  it('offers only read tools and the hand-off', () => {
    const tools = voiceTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual(
      [...VOICE_READ_TOOLS, VOICE_HAND_OFF_TOOL].sort()
    );
    expect(tools.length).toBeLessThanOrEqual(TALK_TOOLS_MAX);
    for (const tool of tools) expect(tool.type).toBe('function');
  });

  it('never offers a tool that changes something', () => {
    const acting = [
      'send_to_agent',
      'spawn_agent',
      'interrupt_agent',
      'answer_permission',
      'stop_agent',
      'archive_agent',
      'focus_agent',
      'show_all',
      'canvas_view',
      'arrange_canvas',
      'close_agent',
      'answer_request',
      'propose_plan',
      'use_app',
      'show_app',
    ];
    const offered = new Set(voiceTools().map((tool) => tool.name));
    for (const name of acting) expect(offered.has(name)).toBe(false);
    // Every read tool is a real conductor tool.
    const known = new Set(conductorToolDefinitions().map((tool) => tool.name));
    for (const name of VOICE_READ_TOOLS) expect(known.has(name)).toBe(true);
  });

  it('adds the read-only code check only when asked', () => {
    expect(voiceTools().some((tool) => tool.name === 'investigate')).toBe(false);
    const withChecks = voiceTools({ codeChecks: true });
    expect(withChecks.some((tool) => tool.name === 'investigate')).toBe(true);
    expect(withChecks.length).toBeLessThanOrEqual(TALK_TOOLS_MAX);
  });

  it('hands off without content, so the voice model writes nothing that is acted on', () => {
    const handOff = voiceTools().find((tool) => tool.name === VOICE_HAND_OFF_TOOL);
    expect(handOff?.parameters).toEqual({
      type: 'object',
      properties: {},
      additionalProperties: false,
    });
  });

  it('keeps the instructions short and the exact-speech wrapper literal', () => {
    expect(VOICE_INSTRUCTIONS.length).toBeLessThan(TALK_INSTRUCTIONS_MAX_CHARS);
    expect(VOICE_INSTRUCTIONS).toContain('You cannot act.');
    expect(sayExactly('Sent to "Atlas".')).toContain(JSON.stringify('Sent to "Atlas".'));
  });
});
