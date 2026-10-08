/**
 * The page's one AudioContext, shared by microphone capture and reply playback.
 *
 * Phones only let a page make sound after a touch. `unlock` must therefore run inside a user
 * gesture (pressing the mic does it): it creates or resumes the context, plays one silent
 * sample, and speaks one silent utterance, after which replies that arrive on their own, seconds
 * later, are allowed to play.
 */
export class AudioSession {
  private audio: AudioContext | null = null;
  private speechPrimed = false;

  /** The shared context, created on first use. Throws where Web Audio does not exist. */
  context(): AudioContext {
    if (!this.audio || this.audio.state === 'closed') {
      this.audio = new AudioContext({ latencyHint: 'interactive' });
    }
    return this.audio;
  }

  /** Call from a user gesture. Safe to call on every press. */
  unlock(): void {
    try {
      const context = this.context();
      // iOS reports `interrupted` after a call or a trip to the background.
      if (context.state !== 'running') void context.resume().catch(() => {});
      const source = context.createBufferSource();
      source.buffer = context.createBuffer(1, 1, context.sampleRate);
      source.connect(context.destination);
      source.start();
    } catch {
      // No Web Audio here; spoken replies fall back to the system voice.
    }
    this.primeSpeech();
  }

  /** Brings the context back after the page returns from the background, where that is allowed. */
  resume(): void {
    const context = this.audio;
    if (context && context.state !== 'running' && context.state !== 'closed') {
      void context.resume().catch(() => {});
    }
  }

  private primeSpeech(): void {
    if (this.speechPrimed || typeof speechSynthesis === 'undefined') return;
    this.speechPrimed = true;
    try {
      const utterance = new SpeechSynthesisUtterance(' ');
      utterance.volume = 0;
      speechSynthesis.speak(utterance);
    } catch {
      // Speech synthesis is unavailable; nothing to prime.
    }
  }
}
