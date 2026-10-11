import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CanvasRefContext } from './canvas-refs';
import { parseCommand, type GrammarCommand } from './grammar';
import type { RosterAgent } from './resolver';

/**
 * The 200-utterance routing eval (docs/chorus/evals/routing.jsonl, PLAN.md §9.3) against the
 * fast-path grammar. "model" rows must fall through to Jev/Claude; the grammar must never grab
 * them. A route is correct when the command kind, target agent, and (for sends) the instruction
 * text all match.
 */

type Expect =
  | { kind: 'model' }
  | { kind: 'clarify' }
  | { kind: 'focus' | 'status' | 'interrupt'; agent: string }
  | { kind: 'send'; agent: string; text: string }
  | { kind: 'note'; text: string }
  | {
      kind: Exclude<
        GrammarCommand['kind'],
        'focus' | 'status' | 'interrupt' | 'send' | 'note' | 'clarify'
      >;
    };

type Row = { utterance: string; focused: string | null; expect: Expect; tag: string };

const lines = readFileSync(
  join(__dirname, '../../../../../../../docs/chorus/evals/routing.jsonl'),
  'utf8'
)
  .split('\n')
  .filter(Boolean);
const { roster } = JSON.parse(lines[0] ?? '{}') as { roster: RosterAgent[] };
const rows = lines.slice(1).map((line) => JSON.parse(line) as Row);

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[.,!?]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function matches(command: GrammarCommand | null, expected: Expect): boolean {
  if (expected.kind === 'model') return command === null;
  if (!command || command.kind !== expected.kind) return false;
  if ('agent' in expected) {
    if (!('agent' in command) || command.agent?.id !== expected.agent) return false;
  }
  if ('text' in expected) {
    if (!('text' in command)) return false;
    // Trailing politeness ("please", "thanks") may be dropped by the grammar.
    return normalize(command.text).startsWith(normalize(expected.text));
  }
  return true;
}

describe('routing eval (grammar fast path)', () => {
  const failures: string[] = [];
  let correct = 0;
  let grabbedModelRows = 0;
  for (const row of rows) {
    const command = parseCommand(row.utterance, roster, row.focused);
    if (matches(command, row.expect)) correct++;
    else {
      if (row.expect.kind === 'model' && command) grabbedModelRows++;
      failures.push(
        `[${row.tag}] "${row.utterance}" expected ${JSON.stringify(row.expect)} got ${JSON.stringify(command && { ...command, agent: 'agent' in command ? command.agent?.name : undefined })}`
      );
    }
  }
  const accuracy = correct / rows.length;

  it('has 200 cases', () => {
    expect(rows).toHaveLength(200);
  });

  it('meets the M3 bar (>= 95% correct tool and target)', () => {
    if (failures.length > 0)
      console.log(`routing eval: ${(accuracy * 100).toFixed(1)}%\n${failures.join('\n')}`);
    expect(accuracy).toBeGreaterThanOrEqual(0.95);
  });

  it('never executes an utterance that belongs to the model', () => {
    expect(grabbedModelRows).toBe(0);
  });
});

describe('routing eval with a canvas (layout grammar enabled)', () => {
  // The same roster as canvas windows, plus two regions and an app browser.
  const canvas: CanvasRefContext = {
    entities: [
      ...roster.map((agent) => ({
        id: agent.id,
        kind: 'agent' as const,
        name: agent.name,
        providerLabel: agent.providerLabel,
        taskName: agent.taskName,
        ...(agent.hidden ? { hidden: true } : {}),
      })),
      { id: 'region:review', kind: 'region', name: 'Review' },
      { id: 'region:backend', kind: 'region', name: 'Backend' },
      { id: 'browser:1', kind: 'browser', name: 'checkout app', taskName: 'checkout' },
    ],
    selection: [],
    focusedId: null,
    recent: [],
    currentRegion: null,
    onStage: false,
  };
  const grabbed: string[] = [];
  let correct = 0;
  for (const row of rows) {
    const command = parseCommand(row.utterance, roster, row.focused, {
      ...canvas,
      focusedId: row.focused,
    });
    // Layout undo stands in for "reopen last" when a canvas is present (it falls back to reopen).
    const undo = command?.kind === 'canvas' && command.action.type === 'undo';
    if (matches(command, row.expect) || (undo && row.expect.kind === 'reopen')) correct++;
    else if (row.expect.kind === 'model' && command) {
      grabbed.push(`"${row.utterance}" -> ${JSON.stringify(command)}`);
    }
  }

  it('keeps the M3 bar', () => {
    expect(correct / rows.length).toBeGreaterThanOrEqual(0.95);
  });

  it('never grabs an utterance that belongs to the model', () => {
    expect(grabbed).toEqual([]);
  });

  // Canvas Pro adds desk commands. None of the eval's utterances is one, so with the same regions
  // as desks (and a window visiting, which arms "send it back") every row must route as before.
  it('routes every row the same way in Canvas Pro', () => {
    const pro: CanvasRefContext = {
      ...canvas,
      currentRegion: 'region:review',
      desks: {
        order: ['region:review', 'region:backend'],
        active: 'region:review',
        newest: 'region:backend',
        visitors: ['browser:1'],
      },
    };
    const classic: CanvasRefContext = { ...canvas, currentRegion: 'region:review' };
    const changed = rows
      .filter((row) => {
        const on = (context: CanvasRefContext) =>
          JSON.stringify(
            parseCommand(row.utterance, roster, row.focused, { ...context, focusedId: row.focused })
          );
        return on(pro) !== on(classic);
      })
      .map((row) => row.utterance);
    expect(changed).toEqual([]);
  });
});

/**
 * Questions about the code must reach the model, which can run a code check; an agent or its
 * task named in the question still wins, as it did before. The same file pins the phrases that
 * steer calls, and the neighbours they must not take over.
 */
describe('routing eval (code questions and call steering)', () => {
  const extraLines = readFileSync(
    join(__dirname, '../../../../../../../docs/chorus/evals/code-questions.jsonl'),
    'utf8'
  )
    .split('\n')
    .filter(Boolean);
  const extraRoster = (JSON.parse(extraLines[0] ?? '{}') as { roster: RosterAgent[] }).roster;
  const extraRows = extraLines.slice(1).map((line) => JSON.parse(line) as Row);

  it('routes every row as expected', () => {
    const wrong = extraRows
      .filter((row) => !matches(parseCommand(row.utterance, extraRoster, row.focused), row.expect))
      .map((row) => {
        const command = parseCommand(row.utterance, extraRoster, row.focused);
        return `[${row.tag}] "${row.utterance}" expected ${JSON.stringify(row.expect)} got ${JSON.stringify(command?.kind ?? null)}`;
      });
    expect(wrong).toEqual([]);
  });

  it('sends every code question to the model', () => {
    const questions = extraRows.filter((row) => row.tag === 'code-question');
    expect(questions.length).toBeGreaterThanOrEqual(8);
    for (const row of questions) {
      expect(parseCommand(row.utterance, extraRoster, row.focused)).toBeNull();
    }
  });
});
