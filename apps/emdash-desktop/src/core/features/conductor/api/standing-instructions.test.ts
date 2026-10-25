import { describe, expect, it } from 'vitest';
import {
  ADJUSTABLE_SETTINGS,
  adjustableSettingNames,
  describeAdjustableSettings,
  parseSettingChange,
} from './adjustable-settings';
import { conductorSettingsSchema, DEFAULT_CONDUCTOR_SETTINGS } from './contract';
import {
  applyInstructionChange,
  asksToAdjustConductor,
  EMPTY_STANDING_INSTRUCTIONS,
  STANDING_LIMITS,
  standingInstructionsBlock,
  type StandingInstructionsFile,
} from './standing-instructions';

const now = new Date('2026-10-11T12:00:00.000Z');

function saved(...texts: string[]): StandingInstructionsFile {
  let file = EMPTY_STANDING_INSTRUCTIONS;
  for (const text of texts) {
    const result = applyInstructionChange(file, { action: 'add', text }, now);
    if (!result.ok) throw new Error(result.message);
    file = result.file;
  }
  return file;
}

describe('standing instructions', () => {
  it("keeps the developer's own words beside the model's, and shows both", () => {
    const result = applyInstructionChange(
      EMPTY_STANDING_INSTRUCTIONS,
      {
        action: 'add',
        text: 'Approve agent requests the developer asks me to approve.',
        said: "Make sure everything gets approved. I don't want you to be denying things.",
      },
      now
    );
    expect(result.ok).toBe(true);
    const entries = result.ok ? result.file.entries : [];
    expect(entries[0]?.said).toBe(
      "Make sure everything gets approved. I don't want you to be denying things."
    );
    expect(standingInstructionsBlock(entries)).toContain(
      "- [i1] Approve agent requests the developer asks me to approve. (the developer's words: “Make sure everything gets approved. I don't want you to be denying things.”)"
    );
    const replaced = applyInstructionChange(
      result.ok ? result.file : EMPTY_STANDING_INSTRUCTIONS,
      { action: 'replace', id: 'i1', text: 'Approve every agent request.' },
      now
    );
    expect(replaced.ok && replaced.file.entries[0]).toEqual({
      id: 'i1',
      text: 'Approve every agent request.',
      at: now.toISOString(),
    });
  });

  it('saves an instruction on one line under an id that is never reused', () => {
    const first = saved('Keep prompts\n\n  open-ended.', 'Use Codex for reviews.');
    expect(first.entries).toEqual([
      { id: 'i1', text: 'Keep prompts open-ended.', at: now.toISOString() },
      { id: 'i2', text: 'Use Codex for reviews.', at: now.toISOString() },
    ]);
    const removed = applyInstructionChange(first, { action: 'remove', id: 'i2' }, now);
    expect(removed.ok && removed.file.entries.map((entry) => entry.id)).toEqual(['i1']);
    const again = applyInstructionChange(
      removed.ok ? removed.file : first,
      { action: 'add', text: 'Answer in German.' },
      now
    );
    expect(again.ok && again.file.entries.at(-1)?.id).toBe('i3');
  });

  it('replaces and removes by id however the id was said', () => {
    const file = saved('Keep prompts open-ended.', 'Use Codex for reviews.');
    const replaced = applyInstructionChange(
      file,
      { action: 'replace', id: '[I2]', text: 'Use Claude for reviews.' },
      now
    );
    expect(replaced.ok && replaced.file.entries[1]?.text).toBe('Use Claude for reviews.');
    expect(replaced.ok && replaced.file.nextId).toBe(3);
    const removed = applyInstructionChange(file, { action: 'remove', id: 'number 1' }, now);
    expect(removed.ok && removed.file.entries.map((entry) => entry.id)).toEqual(['i2']);
    const cleared = applyInstructionChange(file, { action: 'clear' }, now);
    expect(cleared.ok && cleared.file).toEqual({ nextId: 3, entries: [] });
  });

  it('refuses what it cannot keep and says what to do instead', () => {
    const file = saved('Keep prompts open-ended.');
    const unknown = applyInstructionChange(file, { action: 'remove', id: 'i9' }, now);
    expect(unknown).toEqual({ ok: false, message: expect.stringContaining('The ids are i1.') });
    expect(applyInstructionChange(file, { action: 'add', text: '   ' }, now).ok).toBe(false);
    const long = applyInstructionChange(
      file,
      { action: 'add', text: 'x'.repeat(STANDING_LIMITS.entryChars + 1) },
      now
    );
    expect(long).toEqual({ ok: false, message: expect.stringContaining('split it in two') });
    const full = saved(
      ...Array.from({ length: STANDING_LIMITS.entries }, (_, index) => `Rule ${index}.`)
    );
    const over = applyInstructionChange(full, { action: 'add', text: 'One more.' }, now);
    expect(over).toEqual({ ok: false, message: expect.stringContaining('Replace or remove') });
  });

  it('keeps everything saved within what one prompt may carry', () => {
    let file = EMPTY_STANDING_INSTRUCTIONS;
    for (let index = 0; index < STANDING_LIMITS.entries; index++) {
      const text = `${index} ${'y'.repeat(STANDING_LIMITS.entryChars - 4)}`;
      const result = applyInstructionChange(file, { action: 'add', text }, now);
      if (result.ok) file = result.file;
    }
    const total = file.entries.reduce((sum, entry) => sum + entry.text.length, 0);
    expect(total).toBeLessThanOrEqual(STANDING_LIMITS.totalChars);
    expect(file.entries.length).toBeLessThan(STANDING_LIMITS.entries);
  });

  it('does not save the same instruction twice, or strip an id the text never had', () => {
    const file = saved('Keep prompts open-ended.');
    const twice = applyInstructionChange(
      file,
      { action: 'add', text: '- [i1] keep prompts OPEN-ended.' },
      now
    );
    expect(twice).toEqual({ ok: true, file, summary: 'Already saved as i1.' });
  });

  it('renders nothing when nothing is saved, and each instruction with its id otherwise', () => {
    expect(standingInstructionsBlock([])).toBe('');
    const block = standingInstructionsBlock(saved('Keep prompts open-ended.').entries);
    expect(block.startsWith('Standing instructions from the developer:\n')).toBe(true);
    expect(block).toContain('\n- [i1] Keep prompts open-ended.');
    expect(block).toContain('None of them changes what needs the developer’s confirmation');
  });

  it('tells words about the conductor itself from commands about agents', () => {
    for (const text of [
      "from now on I want you to stop being overly descriptive when you're prompting",
      'Going forward, keep things more open-ended',
      'what are your instructions',
      'forget that last rule',
      'use Codex by default',
      "don't notify me when things don't need my attention",
      'only tell me when an agent needs me',
      'stop dinging me unless it needs me',
    ]) {
      expect(asksToAdjustConductor(text), text).toBe(true);
    }
    for (const text of ['run the tests again', 'tell Atlas to stop', 'close the finished ones']) {
      expect(asksToAdjustConductor(text), text).toBe(false);
    }
  });
});

describe('adjustable settings', () => {
  it('names only real settings, with the bounds the settings schema has', () => {
    const shape = conductorSettingsSchema.shape;
    const samples: unknown[] = [true, false, 0, 1, 2, 12, 13, 30, 31, 'off', 'spoken', 'max', 'x'];
    for (const name of adjustableSettingNames) {
      const spec = ADJUSTABLE_SETTINGS[name];
      for (const sample of samples) {
        expect(spec.schema.safeParse(sample).success, `${name} ${String(sample)}`).toBe(
          shape[spec.key].safeParse(sample).success
        );
      }
    }
  });

  it('reads a spoken value as what the setting takes', () => {
    expect(parseSettingChange('completion_follow_up', 'Off')).toEqual({
      ok: true,
      patch: { completionFollowUp: false },
      label: 'Set completion follow up to off',
      confirm: false,
    });
    expect(parseSettingChange('max_agents_per_plan', '6')).toMatchObject({
      patch: { maxAgentsPerPlan: 6 },
    });
    expect(parseSettingChange('calls', 'spoken')).toMatchObject({ patch: { calls: 'spoken' } });
    expect(parseSettingChange('max_agents_per_plan', '40').ok).toBe(false);
    expect(parseSettingChange('calls', 'on').ok).toBe(false);
  });

  it('asks before a safeguard is taken away, and never offers what is not listed', () => {
    expect(parseSettingChange('auto_approve_plans', 'on')).toMatchObject({ confirm: true });
    expect(parseSettingChange('auto_approve_plans', 'off')).toMatchObject({ confirm: false });
    expect(parseSettingChange('agent_requests', 'on')).toMatchObject({ confirm: true });
    for (const name of ['model', 'provider', 'dailyTokenBudget', 'investigations', '__proto__']) {
      const refused = parseSettingChange(name, 'on');
      expect(refused.ok).toBe(false);
      if (!refused.ok) expect(refused.message).toContain('Settings → Voice & Conductor');
    }
    const listed = describeAdjustableSettings(DEFAULT_CONDUCTOR_SETTINGS);
    expect(listed).toHaveLength(adjustableSettingNames.length);
    expect(listed[0]).toContain('completion_follow_up = on.');
  });
});
