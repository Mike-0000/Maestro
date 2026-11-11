import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  boundDigest,
  CHAT_DIGEST_LIMITS,
  chatDigestSchema,
  digestFromInput,
  digestPlainText,
  mapDigestText,
  postDigestInputSchema,
  type ChatDigest,
  type PostDigestInput,
} from './digest';

const input: PostDigestInput = {
  outcome: 'finished',
  headline: 'Hang-up: ready to try, not merged.',
  did: ['Added `hangUp()` in `src/talk/session.ts`', 'Ran `pnpm test`: 12 passed'],
  status: 'Tests pass; not tried in the app.',
  next: 'Say "try it" and I open the app.',
  asked: 'Make the conductor hang up when I say bye.',
  where: 'Branch `chorus/hang-up`, not merged.',
  your_move: 'Open the app and say bye.',
  app_url: 'http://localhost:5173',
};

const digest: ChatDigest = {
  outcome: 'blocked',
  headline: 'Build: stopped on a missing key.',
  did: ['Ran `pnpm build`'],
  status: 'The build needs `VITE_KEY`.',
  next: 'Give me the key.',
  asked: 'Ship the build.',
  where: 'Branch `main`.',
  move: 'Add `VITE_KEY` to `.env`.',
};

describe('chat digest', () => {
  it('makes the stored report from the tool input', () => {
    expect(postDigestInputSchema.safeParse(input).success).toBe(true);
    const made = digestFromInput(input);
    expect(made.move).toBe('Open the app and say bye.');
    expect(made.appUrl).toBe('http://localhost:5173');
    expect('your_move' in made).toBe(false);
    expect('app_url' in made).toBe(false);
    expect(chatDigestSchema.parse(made)).toEqual(made);
  });

  it('leaves out optional fields that hold nothing and trims the rest', () => {
    const made = digestFromInput({
      ...input,
      headline: '  Done.  ',
      risk: '   ',
      caveat: 'Not tried on Windows.',
      app_url: undefined,
    });
    expect(made.headline).toBe('Done.');
    expect('risk' in made).toBe(false);
    expect('appUrl' in made).toBe(false);
    expect(made.caveat).toBe('Not tried on Windows.');
  });

  it('cuts over-long input to the limits instead of refusing it', () => {
    const made = digestFromInput({
      ...input,
      headline: 'h'.repeat(500),
      did: ['d'.repeat(500)],
      your_move: 'm'.repeat(500),
      app_url: `http://localhost/${'p'.repeat(CHAT_DIGEST_LIMITS.url)}`,
    });
    expect(made.headline).toHaveLength(CHAT_DIGEST_LIMITS.headline);
    expect(made.headline.endsWith('…')).toBe(true);
    expect(made.did[0]).toHaveLength(CHAT_DIGEST_LIMITS.item);
    expect(made.move).toHaveLength(CHAT_DIGEST_LIMITS.row);
    // A cut address leads nowhere, so it is dropped.
    expect(made.appUrl).toBeUndefined();
    expect(chatDigestSchema.safeParse(made).success).toBe(true);
  });

  it('refuses five done items and an empty headline', () => {
    const five = ['a', 'b', 'c', 'd', 'e'];
    expect(chatDigestSchema.safeParse({ ...digest, did: five }).success).toBe(false);
    expect(chatDigestSchema.safeParse({ ...digest, headline: '' }).success).toBe(false);
    expect(chatDigestSchema.safeParse({ ...digest, did: [] }).success).toBe(false);
    expect(chatDigestSchema.safeParse({ ...digest, outcome: 'done' }).success).toBe(false);
    expect(postDigestInputSchema.safeParse({ ...input, did: five }).success).toBe(false);
    expect(postDigestInputSchema.safeParse({ ...input, headline: '' }).success).toBe(false);
    expect(postDigestInputSchema.safeParse({ ...input, your_move: undefined }).success).toBe(false);
  });

  it('gives the model a plain object schema with the snake_case keys', () => {
    const json = z.toJSONSchema(postDigestInputSchema) as {
      type: string;
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(json.type).toBe('object');
    expect(Object.keys(json.properties)).toEqual([
      'outcome',
      'headline',
      'did',
      'status',
      'next',
      'risk',
      'caveat',
      'asked',
      'where',
      'your_move',
      'app_url',
    ]);
    expect(json.required).not.toContain('risk');
    expect(json.required).not.toContain('app_url');
  });

  it('bounds every field and the number of items', () => {
    const long = 'x'.repeat(1_000);
    const bounded = boundDigest({
      ...digest,
      did: [long, 'b', 'c', 'd', 'e'],
      status: long,
      risk: long,
      asked: long,
      appUrl: 'http://localhost:3000',
    });
    expect(bounded.did).toHaveLength(CHAT_DIGEST_LIMITS.didItems);
    expect(bounded.did[0]).toHaveLength(CHAT_DIGEST_LIMITS.item);
    expect(bounded.status).toHaveLength(CHAT_DIGEST_LIMITS.item);
    expect(bounded.risk).toHaveLength(CHAT_DIGEST_LIMITS.item);
    expect(bounded.asked).toHaveLength(CHAT_DIGEST_LIMITS.row);
    expect(bounded.appUrl).toBe('http://localhost:3000');
    expect(boundDigest(digest)).toEqual(digest);
  });

  it('maps every text field and keeps the outcome', () => {
    const mapped = mapDigestText(
      { ...digest, risk: 'r', caveat: 'c', appUrl: 'http://x' },
      (text) => text.toUpperCase()
    );
    expect(mapped).toEqual({
      outcome: 'blocked',
      headline: 'BUILD: STOPPED ON A MISSING KEY.',
      did: ['RAN `PNPM BUILD`'],
      status: 'THE BUILD NEEDS `VITE_KEY`.',
      next: 'GIVE ME THE KEY.',
      risk: 'R',
      caveat: 'C',
      asked: 'SHIP THE BUILD.',
      where: 'BRANCH `MAIN`.',
      move: 'ADD `VITE_KEY` TO `.ENV`.',
      appUrl: 'HTTP://X',
    });
    expect('risk' in mapDigestText(digest, (text) => text)).toBe(false);
  });

  it('renders as plain text', () => {
    expect(digestPlainText(digestFromInput({ ...input, risk: 'It may drop a call.' }))).toBe(
      [
        'Finished: Hang-up: ready to try, not merged.',
        'Done:',
        '- Added `hangUp()` in `src/talk/session.ts`',
        '- Ran `pnpm test`: 12 passed',
        'Status: Tests pass; not tried in the app.',
        'Next: Say "try it" and I open the app.',
        'Risk: It may drop a call.',
        'You asked: Make the conductor hang up when I say bye.',
        'Where: Branch `chorus/hang-up`, not merged.',
        'Your move: Open the app and say bye.',
        'App: http://localhost:5173',
      ].join('\n')
    );
  });
});
