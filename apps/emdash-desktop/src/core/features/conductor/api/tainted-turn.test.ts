import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { completionTurnText } from './completion-follow-up';
import { MAESTRO_EVENT_MARK } from './history';
import {
  isBareReply,
  lastTurnIsEvent,
  restsOnAgentText,
  taintClass,
  taintClasses,
  taintedActionLabel,
} from './tainted-turn';
import { CANCEL_WINDOW_TOOLS, CONFIRM_REQUIRED_TOOLS, conductorToolNames } from './tools';

describe('taint classes', () => {
  it('gives every tool exactly one class', () => {
    const classes = taintClasses();
    expect(Object.keys(classes).sort()).toEqual([...conductorToolNames].sort());
    for (const name of conductorToolNames) {
      expect(['view', 'confirms', 'countdown', 'other']).toContain(classes[name]);
    }
  });

  it('keeps tools that already ask as they are', () => {
    for (const name of CONFIRM_REQUIRED_TOOLS) expect(taintClass(name)).toBe('confirms');
    for (const name of CANCEL_WINDOW_TOOLS) expect(taintClass(name)).toBe('countdown');
  });

  it('lets reading and showing run, and makes everything else ask first', () => {
    expect(taintClass('read_agent')).toBe('view');
    expect(taintClass('show_app')).toBe('view');
    expect(taintClass('propose_plan')).toBe('view');
    expect(taintClass('add_note')).toBe('other');
    expect(taintClass('use_app')).toBe('other');
    expect(taintClass('prepare_delivery')).toBe('other');
    expect(taintClass('answer_request')).toBe('other');
  });

  it('treats a tool nobody classified as one that changes something', () => {
    expect(taintClass('some_future_tool')).toBe('other');
  });
});

describe('taintedActionLabel', () => {
  it('names the action in the words a developer would check', () => {
    expect(taintedActionLabel('add_note', { text: 'ship it' })).toBe('Add the note “ship it”');
    expect(taintedActionLabel('rename_agent', { agent: 'Atlas', name: 'Backend' })).toBe(
      'Rename Atlas to Backend'
    );
    expect(taintedActionLabel('close_agent', { agent: 'Atlas' })).toBe("Close Atlas's window");
    expect(taintedActionLabel('enable_delivery', { project: 'chorus' })).toBe(
      'enable delivery: {"project":"chorus"}'
    );
  });
});

describe('lastTurnIsEvent', () => {
  const event = completionTurnText([
    {
      name: 'Zulu',
      providerLabel: 'Claude',
      taskName: 'todo',
      report: { text: 'Built it.', truncated: false, appUrls: [] },
    },
  ]);

  it('is true when the newest turn was started by a Maestro event', () => {
    expect(event).toContain(MAESTRO_EVENT_MARK);
    const history: Anthropic.Beta.BetaMessageParam[] = [
      { role: 'user', content: 'tell Atlas to run the tests' },
      { role: 'assistant', content: [{ type: 'text', text: 'Sent.' }] },
      { role: 'user', content: `<context>\n(state)\n</context>\n\n${event}` },
      { role: 'assistant', content: [{ type: 'text', text: 'Zulu built it. Open it?' }] },
    ];
    expect(lastTurnIsEvent(history)).toBe(true);
  });

  it('is false once the developer has spoken since, and for an empty history', () => {
    const history: Anthropic.Beta.BetaMessageParam[] = [
      { role: 'user', content: event },
      { role: 'assistant', content: [{ type: 'text', text: 'Zulu built it. Open it?' }] },
      { role: 'user', content: 'what is Atlas doing' },
      { role: 'assistant', content: [{ type: 'text', text: 'Working.' }] },
    ];
    expect(lastTurnIsEvent(history)).toBe(false);
    expect(lastTurnIsEvent([])).toBe(false);
  });

  it('looks past tool results to the message that started the turn', () => {
    const history: Anthropic.Beta.BetaMessageParam[] = [
      { role: 'user', content: event },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 't1', name: 'read_agent', input: { agent: 'Zulu' } }],
      },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'output' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Open it?' }] },
    ];
    expect(lastTurnIsEvent(history)).toBe(true);
  });
});

describe('isBareReply', () => {
  const names = ['Atlas', 'Bravo 2'];

  it('is true for agreement, refusal and pointing, however it is worded', () => {
    for (const said of [
      'yes',
      'Sure.',
      'okay do that',
      'yes do it',
      'sounds good, go ahead',
      'the second one',
      'go with what Atlas suggested',
      "let's do what Bravo 2 said",
      'no',
      'Atlas',
    ]) {
      expect(isBareReply(said, names), said).toBe(true);
    }
  });

  it('is true for agreement the way it is spoken, fillers and all', () => {
    for (const said of [
      'Oh yeah, go ahead',
      'Um, yes, do that',
      'Mm-hmm',
      'Uh-huh',
      'yes do that right away',
      "let's go with option B",
      "yeah that's fine by me",
      'ok whatever it wants',
      'yes of course go ahead',
      'go with the latter',
      'your call',
    ]) {
      expect(isBareReply(said, names), said).toBe(true);
    }
  });

  it('is true for agreement with one word of its own', () => {
    expect(isBareReply('yeah totally', names)).toBe(true);
    expect(isBareReply('yes, go ahead and run it', names)).toBe(true);
    expect(isBareReply('sure, merge it', names)).toBe(true);
  });

  it('is false for an instruction in the developer own words, however short', () => {
    for (const said of [
      'merge it',
      'push it',
      'commit that',
      'continue',
      'rebase',
      'open a pull request',
      'run the tests again',
      'have Bravo 2 merge that branch once the checks are green',
      'yes, and add a changelog entry for the retry helper',
      'what did Atlas change in the upload client',
    ]) {
      expect(isBareReply(said, names), said).toBe(false);
    }
  });
});

describe('restsOnAgentText', () => {
  const event = `${MAESTRO_EVENT_MARK} Zulu finished its turn.`;
  const reply = (said: string): Anthropic.Beta.BetaMessageParam => ({
    role: 'assistant',
    content: [{ type: 'text', text: said }],
  });

  it('is true while an event turn is one of the two newest turns', () => {
    const history: Anthropic.Beta.BetaMessageParam[] = [
      { role: 'user', content: event },
      reply('Zulu built it. Open it?'),
    ];
    expect(restsOnAgentText(history)).toBe(true);
    // One turn of the developer's own in between does not make the suggestion go away.
    history.push({ role: 'user', content: 'what is Atlas doing' }, reply('Working.'));
    expect(restsOnAgentText(history)).toBe(true);
    history.push({ role: 'user', content: 'and Bravo' }, reply('Idle.'));
    expect(restsOnAgentText(history)).toBe(false);
  });

  it('is true after a turn in which the model read what an agent wrote', () => {
    const history: Anthropic.Beta.BetaMessageParam[] = [
      { role: 'user', content: 'what is Zulu up to' },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 't1', name: 'read_agent', input: { agent: 'Zulu' } }],
      },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'output' }] },
      reply('It wants to merge. Shall I tell it to?'),
    ];
    expect(restsOnAgentText(history)).toBe(true);
  });

  it('is false for turns that read only what Maestro itself knows, and for no history', () => {
    const history: Anthropic.Beta.BetaMessageParam[] = [
      { role: 'user', content: 'who is working' },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 't1', name: 'list_agents', input: {} }],
      },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'Zulu' }] },
      reply('Zulu.'),
    ];
    expect(restsOnAgentText(history)).toBe(false);
    expect(restsOnAgentText([])).toBe(false);
  });
});
