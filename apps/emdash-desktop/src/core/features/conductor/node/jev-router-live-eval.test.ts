import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { secret } from '@emdash/shared';
import { describe, expect, it } from 'vitest';
import { chooseMode } from '../api/grammar';
import type { ProjectOption, ProviderOption } from '../api/jev-router/catalog';
import { ConversationContext, type SendRecord, type SpawnRecord } from '../api/jev-router/context';
import { decideRoute, thresholdsFrom, type RouterDecision } from '../api/jev-router/policy';
import { buildRouterRequest } from '../api/jev-router/questions';
import { answersDetail } from '../api/jev-router/trace';
import type { RosterAgent } from '../api/resolver';
import { evaluateWithJev, type JevVia } from './jev-client';

/**
 * The Jev router eval (docs/chorus/evals/jev-router.jsonl) against the live System One API. Opt
 * in: `JEV_LIVE_EVAL=1` plus `TYPESAFE_API_KEY` or `OPENROUTER_API_KEY`. It costs a few cents.
 *
 * The bar is safety, not recall: the router may hand anything to Claude, but it must never act
 * where Claude or a question was expected, and every action it takes must be the expected one.
 */

type Expect =
  | { kind: 'llm'; mode?: 'plan' | 'command' }
  | { kind: 'clarify' }
  | { kind: 'artifact' }
  | {
      kind: 'act';
      verb: string;
      agent?: string;
      provider?: string;
      project?: string;
      text?: string;
    };

type Row = {
  utterance: string;
  focused: string | null;
  context?: { reply?: string; lastSent?: SendRecord; lastSpawned?: SpawnRecord };
  expect: Expect;
  tag: string;
};

type Header = { roster: RosterAgent[]; projects: ProjectOption[]; providers: ProviderOption[] };

const lines = readFileSync(
  join(__dirname, '../../../../../../../docs/chorus/evals/jev-router.jsonl'),
  'utf8'
)
  .split('\n')
  .filter(Boolean);
const header = JSON.parse(lines[0] ?? '{}') as Header;
const rows = lines.slice(1).map((line) => JSON.parse(line) as Row);

const typesafeKey = process.env.TYPESAFE_API_KEY;
const openRouterKey = process.env.OPENROUTER_API_KEY;
const live = process.env.JEV_LIVE_EVAL === '1' && Boolean(typesafeKey || openRouterKey);
const via: JevVia = typesafeKey ? 'typesafe' : 'openrouter';

const normalize = (text: string) =>
  text
    .toLowerCase()
    .replace(/[.,!?]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();

function contextFor(row: Row): ConversationContext {
  const context = new ConversationContext();
  if (row.context?.lastSpawned) context.noteSpawn(row.context.lastSpawned);
  if (row.context?.lastSent) context.noteSend(row.context.lastSent);
  if (row.context?.reply) context.noteReply(row.context.reply);
  return context;
}

/** Whether an action is the expected one; null when the decision is not an action. */
function sameAction(decision: RouterDecision, expected: Expect): boolean | null {
  if (decision.kind !== 'act') return null;
  if (expected.kind !== 'act') return false;
  const { action } = decision;
  if (action.verb !== expected.verb) return false;
  if (expected.agent && (!('agent' in action) || action.agent.id !== expected.agent)) return false;
  if (action.verb === 'spawn') {
    if (expected.provider && action.provider.id !== expected.provider) return false;
    if (expected.project && action.project?.id !== expected.project) return false;
  }
  if (expected.text !== undefined) {
    const text =
      action.verb === 'send' ? action.text : action.verb === 'spawn' ? action.prompt : '';
    if (normalize(text) !== normalize(expected.text)) return false;
  }
  return true;
}

describe.skipIf(!live)('Jev router live eval', () => {
  it(
    'never acts wrongly and reports recall',
    async () => {
      const key = secret(typesafeKey ?? openRouterKey ?? '', 'jev-eval');
      const unsafe: string[] = [];
      let acted = 0;
      let expectedActs = 0;
      for (const row of rows) {
        const focused = header.roster.find((agent) => agent.id === row.focused) ?? null;
        const focusedProject = header.projects[0] ?? null;
        const request = buildRouterRequest({
          utterance: row.utterance,
          roster: header.roster,
          focused,
          projects: header.projects,
          focusedProject,
          providers: header.providers,
          context: contextFor(row).snapshot(),
        });
        const result = await evaluateWithJev(key, request.state, request.questions, { via });
        const decision = decideRoute(result.answers, request.plan, {
          thresholds: thresholdsFrom(0.8),
          verbatim: true,
          planCue: chooseMode(row.utterance) === 'plan',
        });
        const correct = sameAction(decision, row.expect);
        if (row.expect.kind === 'act') expectedActs += 1;
        if (correct) acted += 1;
        // Dropping something the developer said loses it; missing an artifact only costs a turn.
        const wrongKind = decision.kind === 'artifact' && row.expect.kind !== 'artifact';
        const wrongMode =
          row.expect.kind === 'llm' &&
          row.expect.mode === 'plan' &&
          (decision.kind !== 'llm' || decision.mode !== 'plan');
        if (correct === false || wrongKind || wrongMode) {
          unsafe.push(
            `${row.tag}: "${row.utterance}" → ${JSON.stringify(decision)}\n  ${JSON.stringify(
              answersDetail(result.answers)
            )}`
          );
        }
        console.info(
          `${row.tag.padEnd(22)} ${decision.kind.padEnd(8)} ${'reason' in decision ? decision.reason : ''}`
        );
      }
      console.info(`Jev router recall: ${acted}/${expectedActs} expected actions taken directly.`);
      expect(unsafe, unsafe.join('\n')).toEqual([]);
    },
    rows.length * 10_000
  );
});
