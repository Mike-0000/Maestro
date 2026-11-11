import { observable, runInAction } from 'mobx';
import { describe, expect, it, vi } from 'vitest';
import {
  ChatDictationRoute,
  type DictationSendResult,
  type DictationSource,
} from './dictation-route';
import type { FrontConductor } from './front';

// On-device dictation begun with a chat conductor in front goes into its composer.

function setup(withFront = true) {
  const session = observable({
    draft: 'Ask it',
    busy: false,
    stop() {},
    sent: [] as string[],
    send(text: string) {
      this.sent.push(text);
    },
    setDraft(text: string) {
      this.draft = text;
    },
  });
  const front: FrontConductor = { session, name: 'Atlas' };
  const chats = observable({ front: withFront ? front : null }, { front: observable.ref });
  let sender: ((text: string) => Promise<DictationSendResult>) | null = null;
  const dictation = observable({
    phase: 'idle' as DictationSource['phase'],
    text: '',
    setSender: (next: (text: string) => Promise<DictationSendResult>) => (sender = next),
  });
  const fallback = vi.fn(
    async (_text: string): Promise<DictationSendResult> => ({ ok: true, agentName: 'Bravo' })
  );
  const route = new ChatDictationRoute(dictation, chats, fallback);
  route.activate();
  const set = (phase: DictationSource['phase'], text = dictation.text) =>
    runInAction(() => {
      dictation.phase = phase;
      dictation.text = text;
    });
  const send = (text: string) => sender!(text);
  return { route, session, chats, set, send, fallback };
}

describe('dictation into the chat conductor in front', () => {
  it('shows the words in the composer as they are heard, and sends them on finish', async () => {
    const { route, session, chats, set, send, fallback } = setup();
    set('listening', '');
    expect(route.target).toBe("Atlas's conductor");
    set('listening', 'to run');
    expect(session.draft).toBe('Ask it to run');
    set('listening', 'to run the tests');
    expect(session.draft).toBe('Ask it to run the tests');

    // The developer looks elsewhere before sending: the words still go where they began.
    runInAction(() => (chats.front = null));
    set('finishing', 'to run the tests');
    await expect(send('to run the tests')).resolves.toEqual({
      ok: true,
      agentName: "Atlas's conductor",
    });
    set('idle', '');

    expect(session.sent).toEqual(['Ask it to run the tests']);
    expect(session.draft).toBe('');
    expect(fallback).not.toHaveBeenCalled();
    expect(route.target).toBeNull();
    route.dispose();
  });

  it('puts the composer back as it was when the dictation is discarded', () => {
    const { session, set } = setup();
    set('listening', '');
    set('listening', 'never mind this');
    expect(session.draft).toBe('Ask it never mind this');
    set('idle', '');
    expect(session.draft).toBe('Ask it');
    expect(session.sent).toEqual([]);
  });

  it('sends to the agent in front, as before, with no chat conductor in front', async () => {
    const { route, session, set, send, fallback } = setup(false);
    set('listening', '');
    set('listening', 'run the tests');
    expect(route.target).toBeNull();
    expect(session.draft).toBe('Ask it');
    await expect(send('run the tests')).resolves.toEqual({ ok: true, agentName: 'Bravo' });
    expect(fallback).toHaveBeenCalledWith('run the tests');
    expect(session.sent).toEqual([]);
  });
});
