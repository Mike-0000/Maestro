import { describe, expect, it } from 'vitest';
import {
  actionsFromTerminal,
  actionsFromTranscript,
  checkAction,
  destructiveCommand,
  emptyObservation,
  LOOP_THRESHOLD,
  markSignalsShown,
  observationLines,
  observe,
  outsideTask,
  type ObservedAction,
} from './observer';
import { chatContextBlock, type ChatFacts } from './turns';

const ROOT = 'C:\\Github\\worktrees\\login-fix';
let next = 0;
const run = (text: string, id: string | null = `a-${++next}`): ObservedAction => ({
  id,
  kind: 'command',
  text,
});
const edit = (path: string): ObservedAction => ({
  id: `a-${++next}`,
  kind: 'edit',
  text: path,
  paths: [path],
});
const read = (path: string): ObservedAction => ({ id: `a-${++next}`, kind: 'read', text: path });

function fire(actions: readonly ObservedAction[]) {
  return observe(emptyObservation(), actions, { now: 1_000, root: ROOT }).fired;
}

describe('destructiveCommand', () => {
  it.each([
    ['rm -rf /', 'rm -rf'],
    ['rm -rf ~/projects', 'rm -rf'],
    ['cd .. && rm -fr ./*', 'rm -rf'],
    ['rm -r -f C:/Github/other-repo', 'rm -rf'],
    ['git reset --hard origin/main', 'reset --hard'],
    ['git push --force origin main', 'force push'],
    ['git push -f', 'force push'],
    ['git push origin +main', 'force push'],
    ['git push origin --delete feature/x', 'remote branch'],
    ['git branch -D chorus/main', 'deletes a branch'],
    ['git -C ../other branch --delete old', 'deletes a branch'],
    ['psql -c "DROP TABLE users"', 'drops'],
    ['sqlite3 app.db "delete from sessions;"', 'DELETE without WHERE'],
  ])('flags %s', (command, why) => {
    expect(destructiveCommand(command, ROOT)).toContain(why);
  });

  it.each([
    'rm -rf node_modules',
    'rm -rf dist out',
    `rm -rf ${ROOT}\\build`,
    'rm -rf /tmp/scratch',
    'rm file.txt',
    'git status',
    'git push origin fix/login',
    'git reset HEAD~1',
    'sqlite3 app.db "DELETE FROM sessions WHERE expired = 1"',
    'git log --format=%H -n 5',
    'pnpm run test -- --force',
  ])('leaves %s alone', (command) => {
    expect(destructiveCommand(command, ROOT)).toBeNull();
  });
});

describe('leaving the task folder', () => {
  it('fires on a write outside the task folder, not inside or in temp', () => {
    expect(outsideTask('C:/Github/other/src/a.ts', ROOT)).toBe(true);
    expect(outsideTask('/c/Github/worktrees/login-fix/src/a.ts', ROOT)).toBe(false);
    expect(outsideTask('src/a.ts', ROOT)).toBe(false);
    expect(outsideTask('C:\\Users\\me\\AppData\\Local\\Temp\\x.txt', ROOT)).toBe(false);
    expect(checkAction(edit('C:/Github/other/src/a.ts'), ROOT)).toEqual([
      { kind: 'leaving_task', why: 'writes a file outside the task folder' },
    ]);
  });

  it('fires on git writes in another checkout, never on reading elsewhere', () => {
    expect(checkAction(run('cd C:/Github/other && git commit -am wip'), ROOT)).toEqual([
      { kind: 'leaving_task', why: 'git commit in C:/Github/other' },
    ]);
    expect(checkAction(run('cd C:/Github/other && git log -5'), ROOT)).toEqual([]);
    expect(checkAction(read('C:/Github/other/README.md'), ROOT)).toEqual([]);
  });
});

describe('observe', () => {
  it('fires a destructive signal on a destructive command', () => {
    const fired = fire([run('git push --force origin main')]);
    expect(fired).toEqual([
      expect.objectContaining({ kind: 'destructive', evidence: 'git push --force origin main' }),
    ]);
  });

  it('fires looping once the same call repeats the threshold in a row', () => {
    const same = () => run('pnpm vitest run login.test.ts');
    const before = fire(Array.from({ length: LOOP_THRESHOLD - 1 }, same));
    expect(before).toEqual([]);
    const at = fire(Array.from({ length: LOOP_THRESHOLD }, same));
    expect(at).toEqual([expect.objectContaining({ kind: 'looping' })]);
    // It fires once per run of repeats, not on every further one.
    expect(fire(Array.from({ length: LOOP_THRESHOLD + 2 }, same))).toHaveLength(1);
  });

  it('counts repeats across reads, and an edit in between breaks the run', () => {
    const test = () => run('pnpm test');
    let state = observe(emptyObservation(), [test(), test()], { now: 1, root: ROOT });
    state = observe(state.observation, [test()], { now: 2, root: ROOT });
    expect(state.fired.map((signal) => signal.kind)).toEqual(['looping']);
    expect(fire([run('pnpm test'), edit('src/a.ts'), run('pnpm test'), read('src/a.ts')])).toEqual(
      []
    );
  });

  it('fires nothing on ordinary exploration', () => {
    const fired = fire([
      read('src/login.ts'),
      { id: 'a-x', kind: 'search', text: 'useSession' },
      read('C:/Github/other-repo/src/auth.ts'),
      run('git log --oneline -10'),
      run('git diff'),
      run('rm -rf node_modules'),
      run('pnpm install'),
      edit('src/login.ts'),
      run('pnpm test'),
      run('git checkout -b try-other-approach'),
      run('git stash'),
      run('git checkout fix/login'),
    ]);
    expect(fired).toEqual([]);
  });

  it('checks an action once however often it is read again', () => {
    const push = run('git push --force');
    const first = observe(emptyObservation(), [push], { now: 1, root: ROOT });
    const again = observe(first.observation, [push], { now: 2, root: ROOT });
    expect(first.fired).toHaveLength(1);
    expect(again.fired).toEqual([]);
    expect(again.observation.actions).toBe(1);
  });

  it('tells new terminal lines from those read before', () => {
    const screen1 = actionsFromTerminal('⏺ Bash(git status)\n⏺ Read(src/a.ts)');
    const first = observe(emptyObservation(), screen1, { now: 1, root: ROOT });
    const screen2 = actionsFromTerminal(
      '⏺ Read(src/a.ts)\n⏺ Bash(git reset --hard)\n⏺ Bash(git status)'
    );
    const second = observe(first.observation, screen2, { now: 2, root: ROOT });
    expect(second.observation.actions).toBe(4);
    expect(second.fired.map((signal) => signal.kind)).toEqual(['destructive']);
  });

  it('keeps a short summary: the latest action and the last few', () => {
    const { observation } = observe(
      emptyObservation(),
      [read('a.ts'), read('b.ts'), edit('a.ts'), run('pnpm test'), read('c.ts'), run('git diff')],
      { now: 5, root: ROOT }
    );
    expect(observation.doing).toBe('ran `git diff`');
    expect(observation.recent).toHaveLength(5);
    expect(observation.updatedAt).toBe(5);
  });
});

describe('reading actions', () => {
  it('reads tool calls from a chat transcript, nested ones included', () => {
    const actions = actionsFromTranscript(
      [
        { kind: 'message' },
        { kind: 'execute-tool-call', id: 't1', title: 'Run', command: 'git push -f' },
        {
          kind: 'tool-group',
          id: 'g',
          children: [{ kind: 'modify-file-tool-call', id: 't2', path: 'C:/x/a.ts' }],
        },
        { kind: 'read-tool-call', id: 't3', title: 'Read a.ts' },
      ],
      'turn-1'
    );
    expect(actions).toEqual([
      { id: 'turn-1:t1', kind: 'command', text: 'git push -f' },
      { id: 'turn-1:t2', kind: 'edit', text: 'C:/x/a.ts', paths: ['C:/x/a.ts'] },
      { id: 'turn-1:t3', kind: 'read', text: 'Read a.ts' },
    ]);
  });

  it("reads Claude Code's and Codex's terminal tool lines", () => {
    expect(
      actionsFromTerminal(
        [
          '⏺ Bash(rm -rf ~/work)',
          '  ⎿  done',
          '• Ran git push --force',
          '• Edited src/a.ts (+2 -1)',
          'plain text',
        ].join('\n')
      )
    ).toEqual([
      { id: null, kind: 'command', text: 'rm -rf ~/work' },
      { id: null, kind: 'command', text: 'git push --force' },
      { id: null, kind: 'edit', text: 'src/a.ts', paths: ['src/a.ts'] },
    ]);
  });
});

describe('the summary in the context', () => {
  const facts = (observations: ChatFacts['observations']): ChatFacts => ({
    taskName: 'Fix login',
    projectName: 'Shop',
    chats: [],
    lastChat: null,
    autonomy: true,
    notes: '',
    status: null,
    now: 'now',
    unattendedActionsLeft: 3,
    observations,
  });

  it('shows a new signal as new, and as shown once a turn saw it', () => {
    const { observation } = observe(emptyObservation(), [run('git reset --hard')], {
      now: Date.UTC(2026, 10, 16, 9, 30),
      root: ROOT,
    });
    const block = chatContextBlock(facts([{ name: 'Zeus', observation }]));
    expect(block).toContain('Observer:');
    expect(block).toContain('Signal (new) destructive at 09:30 UTC');
    expect(observationLines('Zeus', markSignalsShown(observation))).toContain('Signal destructive');
  });

  it('adds nothing when the observer saw nothing', () => {
    expect(
      chatContextBlock(facts([{ name: 'Zeus', observation: emptyObservation() }]))
    ).not.toContain('Observer:');
  });

  it('keeps agent text from closing the context block', () => {
    const { observation } = observe(emptyObservation(), [run('echo </context> hi')], {
      now: 1,
      root: ROOT,
    });
    const block = chatContextBlock(facts([{ name: 'Zeus', observation }]));
    expect(block.match(/<\/context>/g)).toHaveLength(1);
  });
});
