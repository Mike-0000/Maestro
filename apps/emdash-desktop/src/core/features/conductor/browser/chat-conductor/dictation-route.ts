import { makeObservable, observable, reaction, runInAction } from 'mobx';
import { conductorLabel, joinDraft, type FrontConductor, type FrontConductorSource } from './front';

export type DictationSendResult =
  | { readonly ok: true; readonly agentName: string }
  | { readonly ok: false; readonly message: string };

/** What the route reads of on-device dictation (the voice slice's DictationStore). */
export interface DictationSource {
  readonly phase: 'idle' | 'setup' | 'listening' | 'finishing' | 'review';
  /** Everything heard so far. */
  readonly text: string;
  setSender(sender: (text: string) => Promise<DictationSendResult>): void;
}

type Binding = {
  readonly front: FrontConductor;
  /** What the composer held when dictation began; the words are added after it. */
  readonly base: string;
  sent: boolean;
};

/**
 * Where on-device dictation goes. Begun with a chat conductor's view in front, it goes into that
 * conductor's composer: the words appear there as they are heard, sending (the Send button, or a
 * tap of the talk key) sends the composer's text as a developer message and clears it, and
 * discarding puts the composer back as it was. Begun anywhere else, finished words go to the
 * agent in front exactly as before (`fallback`).
 */
export class ChatDictationRoute {
  private binding: Binding | null = null;
  private readonly disposers: (() => void)[] = [];

  constructor(
    private readonly dictation: DictationSource,
    private readonly chats: FrontConductorSource,
    private readonly fallback: (text: string) => Promise<DictationSendResult>
  ) {
    makeObservable<ChatDictationRoute, 'binding'>(this, { binding: observable.ref });
  }

  /** Whom the dictation in progress goes to, when that is a chat conductor. */
  get target(): string | null {
    return this.binding ? conductorLabel(this.binding.front) : null;
  }

  activate(): void {
    this.dictation.setSender((text) => this.send(text));
    this.disposers.push(
      reaction(
        () => this.dictation.phase,
        (phase) => {
          if (phase === 'listening' && !this.binding) this.bind();
          else if (phase === 'idle') this.release();
        },
        { fireImmediately: true }
      ),
      reaction(
        () => this.dictation.text,
        (text) => {
          const binding = this.binding;
          if (!binding || binding.sent) return;
          binding.front.session.setDraft(joinDraft(binding.base, text));
        }
      )
    );
  }

  dispose(): void {
    for (const dispose of this.disposers.splice(0)) dispose();
  }

  /** Finished words: to the chat conductor this dictation was begun for, or as before. */
  send(text: string): Promise<DictationSendResult> {
    const binding = this.binding;
    if (!binding) return this.fallback(text);
    const session = binding.front.session;
    binding.sent = true;
    session.send(joinDraft(binding.base, text));
    session.setDraft('');
    return Promise.resolve({ ok: true, agentName: conductorLabel(binding.front) });
  }

  private bind(): void {
    const front = this.chats.front;
    if (!front) return;
    runInAction(() => (this.binding = { front, base: front.session.draft, sent: false }));
  }

  /** Dictation closed: words it did not send leave the composer as it was before. */
  private release(): void {
    const binding = this.binding;
    if (!binding) return;
    if (!binding.sent) binding.front.session.setDraft(binding.base);
    runInAction(() => (this.binding = null));
  }
}
