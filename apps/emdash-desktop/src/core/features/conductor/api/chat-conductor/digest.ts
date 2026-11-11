import { z } from 'zod';

/**
 * A conductor's report in a fixed shape (what was done, where things stand, what the developer
 * should do now), for the moments a short line cannot carry: the work is finished, blocked, or
 * waits on the developer. The model fills `post_digest` (snake_case input); the thread stores and
 * the panel renders the camelCase `ChatDigest` made from it.
 */

export const CHAT_DIGEST_LIMITS = {
  headline: 200,
  item: 240,
  row: 200,
  didItems: 4,
  url: 2_000,
} as const;

export const chatDigestOutcomeSchema = z.enum(['finished', 'blocked', 'needs_you']);
export type ChatDigestOutcome = z.infer<typeof chatDigestOutcomeSchema>;

const { headline, item, row, didItems, url } = CHAT_DIGEST_LIMITS;

/** The report as stored and rendered. */
export const chatDigestSchema = z.object({
  outcome: chatDigestOutcomeSchema,
  headline: z.string().min(1).max(headline),
  did: z.array(z.string().min(1).max(item)).min(1).max(didItems),
  status: z.string().min(1).max(item),
  next: z.string().min(1).max(item),
  risk: z.string().min(1).max(item).optional(),
  caveat: z.string().min(1).max(item).optional(),
  asked: z.string().min(1).max(row),
  where: z.string().min(1).max(row),
  move: z.string().min(1).max(row),
  appUrl: z.string().min(1).max(url).optional(),
});
export type ChatDigest = z.infer<typeof chatDigestSchema>;

/**
 * The input of the `post_digest` tool, as the model fills it. Text lengths are not refused here:
 * `digestFromInput` cuts over-long text to the limits, so a long line costs a cut, not a retry.
 * The number of `did` items is refused, so the model learns the shape.
 */
export const postDigestInputSchema = z.object({
  outcome: chatDigestOutcomeSchema.describe(
    '`finished`: the work they asked for is done. `blocked`: it stopped on something. `needs_you`: it waits on the developer.'
  ),
  headline: z
    .string()
    .min(1)
    .describe(
      'One line in the form "<Thing>: <state>." such as "Hang-up: ready to try, not merged."'
    ),
  did: z
    .array(z.string().min(1))
    .min(1)
    .max(didItems)
    .describe(
      'One to four short items: what was actually done, with exact names, commands and paths in backticks.'
    ),
  status: z.string().min(1).describe('Where things stand now, including what was not checked.'),
  next: z
    .string()
    .min(1)
    .describe(
      'The next step, written as something the developer can do or say back in a few words.'
    ),
  risk: z
    .string()
    .min(1)
    .optional()
    .describe('Optional. Something that could go wrong if they act on this.'),
  caveat: z
    .string()
    .min(1)
    .optional()
    .describe('Optional. What is unverified, assumed or left out.'),
  asked: z
    .string()
    .min(1)
    .describe('What the developer asked for, in one sentence in their terms.'),
  where: z.string().min(1).describe('Where the work is: branch, folder, address, merged or not.'),
  your_move: z.string().min(1).describe('The one thing the developer should do now.'),
  app_url: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Optional. A local address of the app this task runs, when there is something to open.'
    ),
});
export type PostDigestInput = z.infer<typeof postDigestInputSchema>;

const MORE = '…';

/** Text within `max` characters, ending in an ellipsis when it was cut. */
function clip(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max - MORE.length) + MORE;
}

/** The trimmed text, or the text as it was when trimming would leave nothing. */
function tidy(text: string): string {
  return text.trim() || text;
}

/** An optional field's trimmed text, or undefined when it holds nothing. */
function tidyOptional(text: string | undefined): string | undefined {
  const trimmed = text?.trim();
  return trimmed ? trimmed : undefined;
}

/** The stored report made from the tool input, cut to its limits. */
export function digestFromInput(input: PostDigestInput): ChatDigest {
  const risk = tidyOptional(input.risk);
  const caveat = tidyOptional(input.caveat);
  const appUrl = tidyOptional(input.app_url);
  const did = input.did.map((text) => text.trim()).filter(Boolean);
  return boundDigest({
    outcome: input.outcome,
    headline: tidy(input.headline),
    did: did.length > 0 ? did : input.did,
    status: tidy(input.status),
    next: tidy(input.next),
    ...(risk === undefined ? {} : { risk }),
    ...(caveat === undefined ? {} : { caveat }),
    asked: tidy(input.asked),
    where: tidy(input.where),
    move: tidy(input.your_move),
    ...(appUrl === undefined ? {} : { appUrl }),
  });
}

/**
 * Every field cut to its limit, and at most `didItems` items. An address over its limit is dropped
 * rather than cut, since a cut address leads nowhere.
 */
export function boundDigest(digest: ChatDigest): ChatDigest {
  const { appUrl, risk, caveat, ...rest } = digest;
  return {
    ...rest,
    headline: clip(digest.headline, headline),
    did: digest.did.slice(0, didItems).map((text) => clip(text, item)),
    status: clip(digest.status, item),
    next: clip(digest.next, item),
    ...(risk === undefined ? {} : { risk: clip(risk, item) }),
    ...(caveat === undefined ? {} : { caveat: clip(caveat, item) }),
    asked: clip(digest.asked, row),
    where: clip(digest.where, row),
    move: clip(digest.move, row),
    ...(appUrl === undefined || appUrl.length > url ? {} : { appUrl }),
  };
}

/** The report with `map` applied to every text field (secret redaction, for one). */
export function mapDigestText(digest: ChatDigest, map: (text: string) => string): ChatDigest {
  const { appUrl, risk, caveat, ...rest } = digest;
  return {
    ...rest,
    headline: map(digest.headline),
    did: digest.did.map(map),
    status: map(digest.status),
    next: map(digest.next),
    ...(risk === undefined ? {} : { risk: map(risk) }),
    ...(caveat === undefined ? {} : { caveat: map(caveat) }),
    asked: map(digest.asked),
    where: map(digest.where),
    move: map(digest.move),
    ...(appUrl === undefined ? {} : { appUrl: map(appUrl) }),
  };
}

const OUTCOME_LABELS: Record<ChatDigestOutcome, string> = {
  finished: 'Finished',
  blocked: 'Blocked',
  needs_you: 'Needs you',
};

/** The report as plain text, one field per line: for copying, and for tests. */
export function digestPlainText(digest: ChatDigest): string {
  return [
    `${OUTCOME_LABELS[digest.outcome]}: ${digest.headline}`,
    'Done:',
    ...digest.did.map((text) => `- ${text}`),
    `Status: ${digest.status}`,
    `Next: ${digest.next}`,
    ...(digest.risk === undefined ? [] : [`Risk: ${digest.risk}`]),
    ...(digest.caveat === undefined ? [] : [`Caveat: ${digest.caveat}`]),
    `You asked: ${digest.asked}`,
    `Where: ${digest.where}`,
    `Your move: ${digest.move}`,
    ...(digest.appUrl === undefined ? [] : [`App: ${digest.appUrl}`]),
  ].join('\n');
}
