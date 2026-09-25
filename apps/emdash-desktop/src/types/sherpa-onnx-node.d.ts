// Minimal surface of sherpa-onnx-node 1.13.8 (upstream publishes JSDoc but no .d.ts).
declare module 'sherpa-onnx-node' {
  interface TtsConfig {
    model: {
      kitten: { model: string; voices: string; tokens: string; dataDir: string };
      numThreads: number;
      provider: 'cpu';
    };
    maxNumSentences: number;
  }

  interface GeneratedAudio {
    samples: Float32Array;
    sampleRate: number;
  }

  class GenerationConfig {
    constructor(options: { sid: number; speed: number; silenceScale?: number });
  }

  export class OfflineTts {
    static createAsync(config: TtsConfig): Promise<OfflineTts>;
    readonly sampleRate: number;
    readonly numSpeakers: number;
    generateAsync(request: {
      text: string;
      generationConfig: GenerationConfig;
      onProgress: (info: { samples: Float32Array; progress: number }) => boolean;
    }): Promise<GeneratedAudio>;
  }

  const sherpa: { OfflineTts: typeof OfflineTts; GenerationConfig: typeof GenerationConfig };
  export default sherpa;
}
