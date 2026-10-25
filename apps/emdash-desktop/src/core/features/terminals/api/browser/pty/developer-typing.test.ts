import { beforeEach, describe, expect, it } from 'vitest';
import {
  developerTypedSince,
  developerTyping,
  forgetDeveloperTyping,
  lastDeveloperKeystroke,
  noteConductorSubmit,
  noteDeveloperInput,
  noteDictatedText,
  resetDeveloperTyping,
} from './developer-typing';

const SESSION = 'proj:task:conv';

beforeEach(() => resetDeveloperTyping());

describe('developer typing record', () => {
  it('records keystrokes under the conversation the PTY session belongs to', () => {
    noteDeveloperInput(SESSION, 'h', 1_000);
    noteDeveloperInput(SESSION, 'i', 1_200);
    expect(lastDeveloperKeystroke('conv')).toBe(1_200);
    expect(developerTypedSince('conv', 1_100)).toBe(true);
    expect(developerTypedSince('conv', 1_200)).toBe(false);
    expect(developerTyping('conv')).toEqual({
      lastKeystrokeAt: 1_200,
      lastKeyWasSubmit: false,
      lastSubmitAt: null,
      draft: 'text',
      unsentText: true,
    });
    expect(lastDeveloperKeystroke('other')).toBeNull();
  });

  it("ignores the terminal's own reports to the program", () => {
    const reports = [
      '\x1b[I', // focus in
      '\x1b[O', // focus out
      '\x1b[12;40R', // cursor position
      '\x1b[?62;22c', // device attributes
      '\x1b[>0;276;0c',
      '\x1b[?2004;1$y', // mode report
      '\x1b[<0;10;5M\x1b[<0;10;5m', // SGR mouse
      '\x1b[M !!', // X10 mouse
      '\x1b]11;rgb:0000/0000/0000\x1b\\', // background color
      '\x1b]10;rgb:ffff/ffff/ffff\x07',
      '\x1bP1+r544e=787465726d\x1b\\', // capability answer
      '\x1b[?1u', // keyboard protocol flags
    ];
    for (const report of reports) noteDeveloperInput(SESSION, report, 5_000);
    expect(developerTyping('conv')).toBeNull();
  });

  it('counts keys mixed with reports', () => {
    noteDeveloperInput(SESSION, '\x1b[Ia', 5_000);
    expect(lastDeveloperKeystroke('conv')).toBe(5_000);
  });

  it('tracks whether typed text is still unsent', () => {
    noteDeveloperInput(SESSION, 'fix it', 1);
    expect(developerTyping('conv')?.unsentText).toBe(true);
    noteDeveloperInput(SESSION, '\r', 2);
    expect(developerTyping('conv')).toMatchObject({
      unsentText: false,
      lastKeyWasSubmit: true,
      lastSubmitAt: 2,
    });

    noteDeveloperInput(SESSION, 'ab', 3);
    noteDeveloperInput(SESSION, '\x7f\x7f', 4);
    expect(developerTyping('conv')?.unsentText).toBe(false);

    noteDeveloperInput(SESSION, 'again', 5);
    noteDeveloperInput(SESSION, '\x03', 6); // Ctrl+C clears the input
    expect(developerTyping('conv')?.unsentText).toBe(false);

    noteDeveloperInput(SESSION, 'again', 7);
    noteDeveloperInput(SESSION, '\x15', 8); // Ctrl+U
    expect(developerTyping('conv')?.unsentText).toBe(false);

    noteDeveloperInput(SESSION, 'again', 9);
    noteDeveloperInput(SESSION, '\x1b', 10);
    noteDeveloperInput(SESSION, '\x1b', 400); // Esc twice clears it in Claude Code
    expect(developerTyping('conv')?.draft).toBe('empty');
  });

  it('shrinks the draft with Backspace, Ctrl+W and Alt+Backspace; an emptied one is no draft', () => {
    noteDeveloperInput(SESSION, 'fix the', 1);
    noteDeveloperInput(SESSION, '\x17', 2); // Ctrl+W: "fix "
    expect(developerTyping('conv')?.draft).toBe('text');
    noteDeveloperInput(SESSION, '\x17', 3); // ""
    expect(developerTyping('conv')).toMatchObject({ draft: 'empty', unsentText: false });

    noteDeveloperInput(SESSION, 'go on', 4);
    noteDeveloperInput(SESSION, '\x1b\x7f', 5); // Alt+Backspace: "go "
    noteDeveloperInput(SESSION, '\x7f\x7f', 6); // "g"
    expect(developerTyping('conv')).toMatchObject({ draft: 'empty', unsentText: false });

    noteDeveloperInput(SESSION, '   ', 7);
    expect(developerTyping('conv')?.draft).toBe('empty');
  });

  it('follows the length through cursor moves, but not a word deletion after one', () => {
    noteDeveloperInput(SESSION, 'abc', 1);
    noteDeveloperInput(SESSION, '\x1b[D\x1b[D', 2); // Left twice
    noteDeveloperInput(SESSION, '\x7f\x1b[3~', 3); // Backspace and Delete: one character left
    expect(developerTyping('conv')?.draft).toBe('empty');
    noteDeveloperInput(SESSION, 'more text', 4);
    noteDeveloperInput(SESSION, '\x1b[H\x17', 5); // Home, then Ctrl+W
    expect(developerTyping('conv')?.draft).toBe('unknown');
  });

  it('loses track on keys that rewrite the input, until it is certainly emptied', () => {
    const rewriting = {
      'Up (history)': '\x1b[A',
      'Down (history)': '\x1b[B',
      'application-mode Up': '\x1bOA',
      Tab: '\t',
      'Ctrl+R': '\x12',
      'Escape once': '\x1b',
      'kitty Tab': '\x1b[9u',
    };
    for (const [name, key] of Object.entries(rewriting)) {
      resetDeveloperTyping();
      noteDeveloperInput(SESSION, 'draft text', 1);
      noteDeveloperInput(SESSION, key, 2);
      expect(developerTyping('conv'), name).toMatchObject({ draft: 'unknown', unsentText: false });
      // Typing more does not make it known again.
      noteDeveloperInput(SESSION, 'more', 3);
      expect(developerTyping('conv')?.draft, name).toBe('unknown');
      noteDeveloperInput(SESSION, '\x15', 4);
      expect(developerTyping('conv')?.draft, name).toBe('empty');
    }
  });

  it('reads kitty-encoded Ctrl keys like their plain ones', () => {
    noteDeveloperInput(SESSION, 'abc', 1);
    noteDeveloperInput(SESSION, '\x1b[117;5u', 2); // Ctrl+U
    expect(developerTyping('conv')?.draft).toBe('empty');
  });

  it('treats a one-key answer as no draft', () => {
    noteDeveloperInput(SESSION, '1', 1);
    expect(developerTyping('conv')?.unsentText).toBe(false);
  });

  it('keeps Shift+Enter and Enter inside a paste as newlines, not submits', () => {
    noteDeveloperInput(SESSION, 'line one\n', 1);
    noteDeveloperInput(SESSION, '\x1b[200~two\rthree\x1b[201~', 2);
    expect(developerTyping('conv')).toMatchObject({ unsentText: true, lastSubmitAt: null });
    noteDeveloperInput(SESSION, '\x1b[13;2u', 3); // kitty Shift+Enter
    expect(developerTyping('conv')?.lastSubmitAt).toBeNull();
    noteDeveloperInput(SESSION, '\x1b[13u', 4); // kitty Enter
    expect(developerTyping('conv')).toMatchObject({ unsentText: false, lastSubmitAt: 4 });
  });

  it('counts arrow keys as typing without making a draft', () => {
    noteDeveloperInput(SESSION, '\x1b[A', 1);
    expect(developerTyping('conv')).toMatchObject({ lastKeystrokeAt: 1, unsentText: false });
  });

  it('keeps dictated words unsent until something submits or clears them', () => {
    noteDictatedText('conv');
    expect(developerTyping('conv')).toMatchObject({
      lastKeystrokeAt: null,
      draft: 'text',
      unsentText: true,
    });
    expect(lastDeveloperKeystroke('conv')).toBeNull();
    noteConductorSubmit('conv');
    expect(developerTyping('conv')?.unsentText).toBe(false);

    noteDictatedText('conv');
    noteDeveloperInput(SESSION, '\r', 5);
    expect(developerTyping('conv')?.unsentText).toBe(false);
  });

  it('forgets a conversation', () => {
    noteDeveloperInput(SESSION, 'abc', 1);
    forgetDeveloperTyping('conv');
    expect(developerTyping('conv')).toBeNull();
  });
});
