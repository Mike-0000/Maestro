import { describe, expect, it } from 'vitest';
import {
  COMPLETION_SUMMARY_MAX_CHARS,
  COMPLETION_SUMMARY_MAX_WORDS,
  completionNotificationBody,
  completionSentence,
  summarizeCompletionMessage,
  taskNamePhrase,
} from './completion-summary';

describe('summarizeCompletionMessage', () => {
  it('keeps the substance of a research reply, folding a short list into the phrase', () => {
    const message = [
      '## Summary',
      '',
      'I researched TTS models across three areas:',
      '',
      '- **Naturalness**: VITS and StyleTTS 2 lead on MOS scores.',
      '- **Latency**: streaming vocoders cut first-audio time below 200 ms.',
      '- **Multilingual support**: XTTS v2 covers 17 languages.',
      '',
      'Full notes are in `docs/tts-research.md`.',
    ].join('\n');

    expect(summarizeCompletionMessage(message)).toBe(
      'researched TTS models across three areas: naturalness, latency, and multilingual support'
    );
  });

  it('skips filler openers and pronouns', () => {
    expect(
      summarizeCompletionMessage("Done! I've fixed the flaky login test and added a retry guard.")
    ).toBe('fixed the flaky login test and added a retry guard');
    expect(
      summarizeCompletionMessage("Here's what I did:\n- Updated the README install steps")
    ).toBe('Updated the README install steps');
  });

  it('returns null for missing or content-free replies', () => {
    expect(summarizeCompletionMessage(undefined)).toBeNull();
    expect(summarizeCompletionMessage('')).toBeNull();
    expect(summarizeCompletionMessage('Done!')).toBeNull();
    expect(summarizeCompletionMessage('All set. I have completed the task.')).toBeNull();
    expect(summarizeCompletionMessage('```\nnpm test\n```')).toBeNull();
  });

  it('ignores trailing questions', () => {
    expect(summarizeCompletionMessage('Want me to open a PR?')).toBeNull();
  });

  it('caps long replies at a few words and cuts at a clause boundary', () => {
    const summary = summarizeCompletionMessage(
      'I migrated the settings store to the versioned schema, added a backfill for legacy rows, ' +
        'updated every caller in the renderer and the main process, and wrote tests for each path.'
    );
    expect(summary).toBe(
      'migrated the settings store to the versioned schema, added a backfill for legacy rows,'.slice(
        0,
        -1
      )
    );
    expect(summary!.split(' ').length).toBeLessThanOrEqual(COMPLETION_SUMMARY_MAX_WORDS);
    expect(summary!.length).toBeLessThanOrEqual(COMPLETION_SUMMARY_MAX_CHARS);
  });

  it('never ends on a dangling filler word after truncation', () => {
    const summary = summarizeCompletionMessage(
      'Reviewed the authentication flow for the desktop app and the workspace server and the ' +
        'remote SSH bridge and the updater'
    );
    expect(summary).not.toMatch(/\b(?:and|the|for)$/);
  });

  it('drops URLs, e-mail addresses, secrets, and long tokens; shortens paths', () => {
    const summary = summarizeCompletionMessage(
      'Rotated API_KEY=sk-live-abcdef1234567890 in /home/me/project/config/app.env for ' +
        'ops@example.com, see https://example.com/runbook, commit 3f9a1c2b7d4e5f60718293a4b5c6d7e8f9a0b1c2'
    );
    expect(summary).not.toMatch(/sk-live|example\.com|home\/me|3f9a1c2b/);
    expect(summary).toContain('app.env');
  });

  it('keeps "and/or" style pairs intact', () => {
    expect(summarizeCompletionMessage('Compared STT/TTS latency on CPU and GPU runners.')).toBe(
      'Compared STT/TTS latency on CPU and GPU runners'
    );
  });

  it('strips markdown, links, and emoji for a clean spoken phrase', () => {
    expect(
      summarizeCompletionMessage(
        '✅ **Added** [dark mode](https://x.dev) support to the settings page'
      )
    ).toBe('Added dark mode support to the settings page');
  });
});

describe('taskNamePhrase', () => {
  it('turns branch-style slugs back into words and drops random suffixes', () => {
    expect(taskNamePhrase('implement-concise-agent-completion-summa-dpcfs')).toBe(
      'implement concise agent completion summa'
    );
  });

  it('keeps ordinary titles and rejects empty or generic ones', () => {
    expect(taskNamePhrase('Research speech-to-text models')).toBe('Research speech-to-text models');
    expect(taskNamePhrase('')).toBeNull();
    expect(taskNamePhrase(null)).toBeNull();
    expect(taskNamePhrase('task')).toBeNull();
  });
});

describe('completionSentence', () => {
  it('uses the reply synopsis with the agent as subject when it starts with a past-tense verb', () => {
    expect(
      completionSentence(
        'Kilo',
        'researched TTS models across three areas: naturalness, latency, and multilingual support'
      )
    ).toBe(
      'Kilo researched TTS models across three areas: naturalness, latency, and multilingual support.'
    );
    expect(completionSentence('Atlas', 'Built the release notes page')).toBe(
      'Atlas built the release notes page.'
    );
  });

  it('falls back to "finished:" for non-verb synopses', () => {
    expect(completionSentence('Bravo', 'The login bug is fixed and tests pass')).toBe(
      'Bravo finished: The login bug is fixed and tests pass.'
    );
    expect(completionSentence('Bravo', 'Based on benchmarks, Whisper is best')).toBe(
      'Bravo finished: Based on benchmarks, Whisper is best.'
    );
  });

  it('phrases the task name when there is no synopsis', () => {
    expect(completionSentence('Kilo', null, 'Research speech-to-text models')).toBe(
      'Kilo finished researching speech-to-text models.'
    );
    expect(completionSentence('Cedar', null, 'Fix flaky tests')).toBe(
      'Cedar finished fixing flaky tests.'
    );
    expect(completionSentence('Cedar', null, 'Update docs')).toBe('Cedar finished updating docs.');
    expect(completionSentence('Cedar', null, 'Run benchmarks')).toBe(
      'Cedar finished running benchmarks.'
    );
    expect(completionSentence('Cedar', null, 'Speech model shootout')).toBe(
      'Cedar finished: Speech model shootout.'
    );
  });

  it('keeps the generic sentence when nothing specific is known', () => {
    expect(completionSentence('Kilo', null, null)).toBe('Kilo is done.');
    expect(completionSentence('Kilo', undefined, '')).toBe('Kilo is done.');
  });
});

describe('completionNotificationBody', () => {
  it('capitalizes the synopsis as a sentence, or returns null without one', () => {
    expect(completionNotificationBody('researched TTS models')).toBe('Researched TTS models.');
    expect(completionNotificationBody(null)).toBeNull();
  });
});
