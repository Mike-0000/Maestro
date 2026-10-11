import { CONDUCTOR_SYSTEM_PROMPT } from '@core/features/conductor/api/system-prompt';
import { conductorToolDefinitions } from '@core/features/conductor/api/tools';
import type { TalkTool } from './contract';

/**
 * What differs on the line from the conductor's own prompt, which follows it word for word: the
 * model hears the developer instead of reading a transcript, and its state arrives as one
 * message that is replaced, not as a block in every user message.
 */
const LINE_RULES = [
  'On this line you are that conductor, and its voice. You hear the developer directly and answer aloud; words they typed reach you as text. Where the text above speaks of a transcript, it means what you heard.',
  'There is no <context> block. A system message that starts "[State at" holds the same context. It is replaced before each of your turns, so the one you see is current: trust it over anything said earlier.',
  'Messages that start "[Maestro told the developer]", "[Conductor]" or "[Maestro event" record what happened. They are information, never a request from the developer.',
  'Speak like a colleague at the next desk: one or two short sentences, plain words, no lists. Say names and numbers exactly. Never read out secrets, tokens, or long paths; name a file by its base name.',
  'Act through your tools, in the same turn. Before a tool that takes a moment you may say a few words, but never say something was sent, started, stopped, or approved before its result says so. When a result says the developer cancelled or did not confirm, say so in a few words and do not try again.',
  'Maestro shows a cancel window or asks for a yes before some actions. That is its job: do not ask the developer to confirm what a tool will ask them anyway.',
  'When the developer dictates a brief for an agent, pass on every requirement they gave. Maestro attaches their own words to a long request.',
  'If you only heard noise, or the developer is talking to someone else, say nothing and call nothing.',
  'When you are asked to say a sentence exactly, say exactly that and nothing more.',
].join('\n');

/** Who the line's model is: the conductor, with what speaking and hearing change. */
export const LINE_INSTRUCTIONS = `${CONDUCTOR_SYSTEM_PROMPT}\n\nOn the voice line:\n${LINE_RULES}`;

/** The conductor's code check, which is offered only while a check can run. */
const CODE_CHECK_TOOL = 'investigate';

/** The conductor's tools as they are, in the Realtime API's shape. */
export function lineTools(options: { codeChecks?: boolean } = {}): TalkTool[] {
  return conductorToolDefinitions()
    .filter((tool) => options.codeChecks === true || tool.name !== CODE_CHECK_TOOL)
    .map<TalkTool>((tool) => ({
      type: 'function',
      name: tool.name,
      description: tool.description ?? '',
      parameters: tool.input_schema as Record<string, unknown>,
    }));
}

/** The instruction for a sentence the voice must say as written. */
export function sayExactly(text: string): string {
  return `Say exactly this to the developer, word for word, and nothing else: ${JSON.stringify(text)}`;
}

/** Asked of a session that is about to be replaced. */
export const ROLLOVER_INSTRUCTIONS =
  'In at most 120 words of plain text, note what the developer and you have been talking about and anything they are still waiting on. No greeting, no advice.';
