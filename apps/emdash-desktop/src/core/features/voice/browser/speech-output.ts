/**
 * Spoken replies through the platform speech synthesizer (the installed Windows OneCore/SAPI
 * voices: offline and free). Replies are short; pressing push-to-talk cuts them off (barge-in).
 */
export class SpeechOutput {
  private preferredVoice = '';
  onSpeakingChange: ((speaking: boolean) => void) | null = null;

  setPreferredVoice(name: string): void {
    this.preferredVoice = name;
  }

  static voices(): SpeechSynthesisVoice[] {
    return typeof speechSynthesis === 'undefined' ? [] : speechSynthesis.getVoices();
  }

  speak(text: string): void {
    if (typeof speechSynthesis === 'undefined' || !text.trim()) return;
    speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    const voice =
      SpeechOutput.voices().find((candidate) => candidate.name === this.preferredVoice) ??
      SpeechOutput.voices().find(
        (candidate) => candidate.default && candidate.lang.startsWith('en')
      );
    if (voice) utterance.voice = voice;
    utterance.rate = 1.1;
    utterance.onstart = () => this.onSpeakingChange?.(true);
    utterance.onend = () => this.onSpeakingChange?.(false);
    utterance.onerror = () => this.onSpeakingChange?.(false);
    speechSynthesis.speak(utterance);
  }

  stop(): void {
    if (typeof speechSynthesis === 'undefined') return;
    speechSynthesis.cancel();
    this.onSpeakingChange?.(false);
  }
}
