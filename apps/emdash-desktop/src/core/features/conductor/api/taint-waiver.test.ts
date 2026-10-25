import { describe, expect, it } from 'vitest';
import {
  codeCheckTexts,
  jevReading,
  liveCodeCheckInputs,
  namedAction,
  namesAgent,
  quotesCodeCheck,
  waivesCodeCheckTaint,
} from './taint-waiver';

const sure = {
  jev_addressee: 'command_for_chorus (0.98) | conversation_with_conductor=0.01',
  jev_intent: 'spawn_with_brief (0.97) | spawn_blank=0.02',
};

const CHECK =
  '<code-check project="Chorus">The upload client retries three times with a fixed delay of two seconds and never backs off.</code-check>';

function call(overrides: Partial<Parameters<typeof waivesCodeCheckTaint>[0]> = {}) {
  return {
    tool: 'spawn_agent',
    named: 'spawn_agent' as const,
    projectId: 'chorus',
    checkedProjects: new Set(['chorus']),
    brief: 'Add exponential backoff to the upload client and a test for it.',
    checks: [CHECK],
    ...overrides,
  };
}

describe('what the router read the developer’s words as', () => {
  it('reads a sure command to start an agent or send one a message', () => {
    expect(jevReading(sure, 'intent')).toEqual({ choice: 'spawn_with_brief', confidence: 0.97 });
    expect(namedAction(sure)).toBe('spawn_agent');
    expect(namedAction({ ...sure, jev_intent: 'send_composed (0.96)' })).toBe('send_to_agent');
  });

  it('reads nothing when the router was unsure, or the words were not a command', () => {
    expect(namedAction({ ...sure, jev_intent: 'spawn_with_brief (0.9)' })).toBeNull();
    expect(
      namedAction({ ...sure, jev_addressee: 'answer_to_conductor_question (0.99)' })
    ).toBeNull();
    expect(namedAction({ ...sure, jev_intent: 'kill (0.99)' })).toBeNull();
    expect(namedAction({})).toBeNull();
  });
});

describe('waivesCodeCheckTaint', () => {
  it('lets the developer’s own start or send run, in the project the check read', () => {
    expect(waivesCodeCheckTaint(call())).toBe(true);
    const send = { tool: 'send_to_agent', named: 'send_to_agent' as const };
    expect(waivesCodeCheckTaint(call({ ...send, targetNamed: true }))).toBe(true);
    // A send to an agent the developer did not name asks.
    expect(waivesCodeCheckTaint(call({ ...send, targetNamed: false }))).toBe(false);
    expect(waivesCodeCheckTaint(call(send))).toBe(false);
  });

  it('knows the agent the developer named, by the router or by their words', () => {
    expect(namesAgent('Maple 2', 'tell maple two to add the backoff', null)).toBe(true);
    expect(namesAgent('Bravo', 'Bravo, run the tests again', null)).toBe(true);
    expect(namesAgent('Bravo', 'send to bravo: run the tests', null)).toBe(true);
    expect(namesAgent('Bravo', 'have Bravo run the tests', null)).toBe(true);
    // A name said in passing is not whom the words are for.
    expect(namesAgent('Bravo', 'tell Atlas what Bravo found', null)).toBe(false);
    expect(namesAgent('Atlas', 'tell Atlas what Bravo found', null)).toBe(true);
    expect(namesAgent('Bravo', 'I want bravo to run the tests', null)).toBe(false);
    expect(namesAgent('Atlas', 'tell it to add the backoff', null)).toBe(false);
    expect(
      namesAgent('Atlas', 'tell it to add the backoff', { choice: 'Atlas', confidence: 0.97 })
    ).toBe(true);
    expect(
      namesAgent('Atlas', 'tell it to add the backoff', { choice: 'Atlas', confidence: 0.8 })
    ).toBe(false);
  });

  it('counts only the checks whose results are still in the history', () => {
    const asked = (id: string, project: string) => ({
      role: 'assistant' as const,
      content: [
        {
          type: 'tool_use' as const,
          id,
          name: 'investigate',
          input: { project, questions: ['q'] },
        },
      ],
    });
    const result = (id: string, content: string) => ({
      role: 'user' as const,
      content: [{ type: 'tool_result' as const, tool_use_id: id, content }],
    });
    expect(
      liveCodeCheckInputs([
        asked('t1', 'demo'),
        result('t1', CHECK),
        asked('t2', 'website'),
        result('t2', '(an earlier code check, no longer shown)'),
      ])
    ).toEqual([{ project: 'demo', questions: ['q'] }]);
  });

  it('keeps asking for any other tool, another reading, or another project', () => {
    expect(waivesCodeCheckTaint(call({ tool: 'stop_agent' }))).toBe(false);
    expect(waivesCodeCheckTaint(call({ tool: 'archive_agent' }))).toBe(false);
    expect(waivesCodeCheckTaint(call({ named: 'send_to_agent' }))).toBe(false);
    expect(waivesCodeCheckTaint(call({ named: null }))).toBe(false);
    expect(waivesCodeCheckTaint(call({ projectId: 'other' }))).toBe(false);
    expect(waivesCodeCheckTaint(call({ projectId: null }))).toBe(false);
  });

  it('keeps asking for a brief that pushes or merges, or quotes the check', () => {
    expect(waivesCodeCheckTaint(call({ brief: 'Fix the retries, then push to main.' }))).toBe(
      false
    );
    expect(waivesCodeCheckTaint(call({ brief: 'Merge the backoff branch.' }))).toBe(false);
    const quoting = 'Note: it retries three times with a fixed delay of two seconds. Fix that.';
    expect(quotesCodeCheck(quoting, [CHECK])).toBe(true);
    expect(waivesCodeCheckTaint(call({ brief: quoting }))).toBe(false);
  });

  it('finds the checks still in the history', () => {
    expect(
      codeCheckTexts([
        { role: 'user', content: 'check the upload client' },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 't1', content: CHECK }],
        },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 't2', content: 'Sent to Atlas.' }],
        },
      ])
    ).toEqual([CHECK]);
  });
});
