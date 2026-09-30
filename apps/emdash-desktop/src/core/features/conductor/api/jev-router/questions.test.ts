import { describe, expect, it } from 'vitest';
import { JEV_MAX_CHOICE_OPTIONS } from '../jev';
import type { RosterAgent } from '../resolver';
import { buildCatalog, catalogKey, SENTINEL, type RouterInput } from './catalog';
import { ConversationContext } from './context';
import { buildRouterRequest } from './questions';

const agents = (count: number): RosterAgent[] =>
  Array.from({ length: count }, (_unused, i) => ({
    id: `a${i}`,
    name: `Agent ${i}`,
    providerLabel: 'Codex',
    taskName: `Task ${i}`,
    hidden: i % 3 === 0,
  }));

function input(roster: RosterAgent[], context = new ConversationContext(() => 0)): RouterInput {
  return {
    utterance: 'Tell Agent 1 to run the tests. Then focus it.',
    roster,
    focused: roster[1] ?? null,
    projects: [
      { id: 'p1', name: 'Chorus' },
      { id: 'p2', name: 'Website' },
    ],
    focusedProject: { id: 'p1', name: 'Chorus' },
    providers: [
      { id: 'codex', label: 'Codex' },
      { id: 'claude', label: 'Claude Code' },
    ],
    context: context.snapshot(),
  };
}

describe('buildRouterRequest', () => {
  it('fans out every slot and one meta question per sentence', () => {
    const request = buildRouterRequest(input(agents(3)));
    expect(Object.keys(request.questions)).toEqual(
      expect.arrayContaining([
        'addressee',
        'stt_artifact',
        'intent',
        'target',
        'project',
        'provider',
        'agent_count',
        'action',
        'body_start',
        'body_end',
        'meta_0',
        'meta_1',
      ])
    );
    expect(request.state).toMatchObject({
      focused: 'Agent 1',
      sentences: ['Tell Agent 1 to run the tests.', 'Then focus it.'],
    });
  });

  it('offers only sentinels that have a referent', () => {
    const plain = buildRouterRequest(input(agents(3)));
    expect(plain.plan.targets.has(SENTINEL.justStarted)).toBe(false);
    const context = new ConversationContext(() => 0);
    context.noteSpawn({
      conversationId: 'a2',
      name: 'Agent 2',
      providerId: 'codex',
      providerLabel: 'Codex',
      projectName: 'Chorus',
      prompt: '',
      taskName: 'x',
      worktree: false,
    });
    const after = buildRouterRequest(input(agents(3), context));
    expect(after.plan.targets.has(SENTINEL.justStarted)).toBe(true);
  });

  it('keeps every choice within the option limit for a very large roster', () => {
    const request = buildRouterRequest(input(agents(400)));
    for (const question of Object.values(request.questions)) {
      if (question.type !== 'choice') continue;
      expect(Object.keys(question.criteria).length).toBeLessThanOrEqual(JEV_MAX_CHOICE_OPTIONS);
    }
  });
});

describe('buildCatalog', () => {
  it('binds the utterance-named agent before others and includes spawn and llm options', () => {
    const catalog = buildCatalog(input(agents(60)));
    const keys = [...catalog.actions.keys()];
    expect(keys.length).toBeLessThanOrEqual(255);
    expect(keys).toContain(catalogKey.agent('send_verbatim', 'Agent 1'));
    expect(keys).toContain('spawn · Codex in Chorus');
    expect(keys).toContain('other · send_composed');
    const firstAgentKey = keys.find((key) => key.startsWith('focus · '));
    expect(firstAgentKey).toBe('focus · Agent 1');
  });
});
