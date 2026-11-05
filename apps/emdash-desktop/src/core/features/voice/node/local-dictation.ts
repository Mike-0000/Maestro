import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { availableParallelism } from 'node:os';
import { join } from 'node:path';
import type { OfflineRecognizer } from 'sherpa-onnx-node';
import type { DictationModelStatus, LocalSpeechModelId } from '../api/contract';
import { STT_SAMPLE_RATE } from '../api/wav';
import { BufferedDictationStream } from './buffered-dictation';

export type ModelFile = { readonly name: string; readonly size: number; readonly sha256: string };

/** Where one model's files come from: a pinned Hugging Face revision and every file's SHA-256. */
export type DictationModelSource = {
  readonly revision: string;
  readonly baseUrl: string;
  readonly files: readonly ModelFile[];
};

export type DictationModelSpec = DictationModelSource & {
  /** Folder under `<dataDir>/models`. */
  readonly dirName: string;
};

/**
 * The on-device models, as int8 ONNX transducers for sherpa-onnx. They are too large to ship in
 * the installer, so each is fetched once, on request, from a pinned revision, and every file is
 * checked against its SHA-256 before it is used.
 */
export const DICTATION_MODELS: Record<LocalSpeechModelId, DictationModelSpec> = {
  /**
   * Moondream Parakeet Ultra (CC-BY-4.0): NVIDIA Parakeet TDT 0.6B v3 post-trained by Moondream,
   * 25 European languages. Moondream publishes it only as transformers safetensors, so this is the
   * int8 export made with sherpa-onnx's own v3 recipe (its `export_ultra.py` is in the repository);
   * the decoder and joiner are byte-identical across several independent exports of the weights.
   */
  'parakeet-ultra': {
    dirName: 'parakeet-ultra-0.6b-int8',
    revision: 'f7bc472677ff70be95cdb0ef9df509fee6f5ec0b',
    baseUrl:
      'https://huggingface.co/leogaudin/sherpa-onnx-nemo-parakeet-ultra-int8/resolve/f7bc472677ff70be95cdb0ef9df509fee6f5ec0b',
    files: [
      {
        name: 'encoder.int8.onnx',
        size: 652_282_340,
        sha256: '8bd3b8dc07056def6dfd19910e9f90c9e1a4e7e20901f58bdfe2a570a8081a2a',
      },
      {
        name: 'decoder.int8.onnx',
        size: 11_845_275,
        sha256: '94373c6405c8149d1c9d1e9862514e0e3e88dab1c7de18fac9d5df9c6ba5efdd',
      },
      {
        name: 'joiner.int8.onnx',
        size: 6_355_277,
        sha256: '8a71aaccfdba3d451775507a889afd2257d2e754463fd81095a8c8f290f924c2',
      },
      {
        name: 'tokens.txt',
        size: 93_939,
        sha256: 'd58544679ea4bc6ac563d1f545eb7d474bd6cfa467f0a6e2c1dc1c7d37e3c35d',
      },
    ],
  },
  /** NVIDIA Parakeet Unified English 0.6B (NVIDIA Open Model License), exported by sherpa-onnx. */
  'parakeet-unified-en': {
    dirName: 'parakeet-unified-en-0.6b-int8',
    revision: '8c3a10fb13408c7a7054f6898958bf1c64a8d6c7',
    baseUrl:
      'https://huggingface.co/csukuangfj2/sherpa-onnx-nemo-parakeet-unified-en-0.6b-int8-non-streaming/resolve/8c3a10fb13408c7a7054f6898958bf1c64a8d6c7',
    files: [
      {
        name: 'encoder.int8.onnx',
        size: 654_040_552,
        sha256: '6716910b7a0833997fec7a410494c995d70124001a0e9b66d6370d6aced577e0',
      },
      {
        name: 'decoder.int8.onnx',
        size: 7_257_753,
        sha256: 'a5e223392c90e75f8144cdb5eb95af7625db389e39edef2bd1a9c872b3298fe6',
      },
      {
        name: 'joiner.int8.onnx',
        size: 1_735_860,
        sha256: '869f43f7d24595c55581ad3bf249a935fb8a71389fbdaa7504b9f46f93140f8a',
      },
      {
        name: 'tokens.txt',
        size: 8_952,
        sha256: 'dc0b4584ab2e4ddbf888425c076c61b736e7356a015250db7d307e6f1a8188ff',
      },
    ],
  },
};

const VERIFIED_MARKER = '.verified';
const PROGRESS_INTERVAL_MS = 250;
/** The loaded model holds about 700 MB of memory; it is released after this long unused. */
const UNLOAD_AFTER_MS = 10 * 60_000;

/** The model files on disk: whether they are there, and fetching them when they are not. */
export class DictationModel {
  private download: Promise<void> | null = null;
  private abort: AbortController | null = null;
  private received = 0;
  private failure: string | null = null;
  private readonly total: number;
  private readonly files: readonly ModelFile[];

  constructor(
    readonly dir: string,
    private readonly source: DictationModelSource
  ) {
    this.files = source.files;
    this.total = source.files.reduce((sum, file) => sum + file.size, 0);
  }

  path(name: string): string {
    return join(this.dir, name);
  }

  async status(): Promise<DictationModelStatus> {
    if (this.download) {
      return { state: 'downloading', receivedBytes: this.received, totalBytes: this.total };
    }
    if (await this.ready()) {
      return { state: 'ready', receivedBytes: this.total, totalBytes: this.total };
    }
    return this.failure
      ? { state: 'failed', receivedBytes: 0, totalBytes: this.total, message: this.failure }
      : { state: 'missing', receivedBytes: 0, totalBytes: this.total };
  }

  async ready(): Promise<boolean> {
    try {
      if ((await readFile(this.path(VERIFIED_MARKER), 'utf8')).trim() !== this.source.revision) {
        return false;
      }
      for (const file of this.files) {
        if ((await stat(this.path(file.name))).size !== file.size) return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  /** Starts the download unless one is running or the model is already there. */
  async start(onProgress: (status: DictationModelStatus) => void): Promise<DictationModelStatus> {
    if (!this.download && !(await this.ready())) {
      this.failure = null;
      this.received = 0;
      const abort = new AbortController();
      this.abort = abort;
      this.download = this.fetchAll(abort.signal, onProgress)
        .catch((error: unknown) => {
          this.failure = abort.signal.aborted
            ? 'The download was stopped.'
            : error instanceof Error
              ? error.message
              : 'The download failed.';
        })
        .then(async () => {
          this.download = null;
          this.abort = null;
          onProgress(await this.status());
        });
    }
    return this.status();
  }

  dispose(): void {
    this.abort?.abort();
  }

  private async fetchAll(
    signal: AbortSignal,
    onProgress: (status: DictationModelStatus) => void
  ): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await rm(this.path(VERIFIED_MARKER), { force: true });
    let reportedAt = 0;
    const report = () => {
      const now = Date.now();
      if (now - reportedAt < PROGRESS_INTERVAL_MS) return;
      reportedAt = now;
      onProgress({ state: 'downloading', receivedBytes: this.received, totalBytes: this.total });
    };
    for (const file of this.files) {
      const partial = this.path(`${file.name}.part`);
      const response = await fetch(`${this.source.baseUrl}/${file.name}`, { signal });
      if (!response.ok || !response.body) {
        throw new Error(`The model download failed (${response.status}).`);
      }
      const hash = createHash('sha256');
      const out = createWriteStream(partial);
      let size = 0;
      try {
        for await (const chunk of response.body) {
          hash.update(chunk);
          size += chunk.byteLength;
          this.received += chunk.byteLength;
          if (size > file.size) throw new Error('The model download is larger than expected.');
          if (!out.write(chunk))
            await new Promise<void>((resolve) => out.once('drain', () => resolve()));
          report();
        }
      } finally {
        await new Promise<void>((resolve) => out.end(() => resolve()));
      }
      // Never keep bytes that are not exactly the pinned model.
      if (size !== file.size || hash.digest('hex') !== file.sha256) {
        await rm(partial, { force: true });
        throw new Error('The downloaded model did not match its checksum.');
      }
      await rename(partial, this.path(file.name));
    }
    await writeFile(this.path(VERIFIED_MARKER), `${this.source.revision}\n`);
  }
}

/** On-device dictation: the lazily loaded recognizer and the live streams that use it. */
export class LocalDictation {
  private recognizer: Promise<OfflineRecognizer> | null = null;
  private unloadTimer: NodeJS.Timeout | null = null;

  constructor(readonly model: DictationModel) {}

  /** A live stream; the model starts loading now and audio queues until it is ready. */
  open(onPartial: (text: string) => void): BufferedDictationStream {
    void this.load().catch(() => {});
    return new BufferedDictationStream((samples) => this.transcribe(samples), onPartial);
  }

  /** Loads the model now, if it is not loaded, so the next recording does not wait for it. */
  warm(): void {
    void this.load().catch(() => {});
  }

  /** Stops a download and releases the loaded model; the next use starts over. */
  dispose(): void {
    if (this.unloadTimer) clearTimeout(this.unloadTimer);
    this.unloadTimer = null;
    this.recognizer = null;
    this.model.dispose();
  }

  /** One whole recording (16 kHz mono samples) to text; loads the model when it is not. */
  async transcribe(samples: Float32Array): Promise<string> {
    const recognizer = await this.load();
    const stream = recognizer.createStream();
    stream.acceptWaveform({ samples, sampleRate: STT_SAMPLE_RATE });
    await recognizer.decodeAsync(stream);
    return recognizer.getResult(stream).text;
  }

  private load(): Promise<OfflineRecognizer> {
    if (this.unloadTimer) clearTimeout(this.unloadTimer);
    this.unloadTimer = setTimeout(() => {
      this.unloadTimer = null;
      this.recognizer = null;
    }, UNLOAD_AFTER_MS);
    this.unloadTimer.unref();
    return (this.recognizer ??= this.create());
  }

  private async create(): Promise<OfflineRecognizer> {
    try {
      // oxlint-disable-next-line emdash/no-dynamic-imports -- Load native code only when dictation is used.
      const { default: sherpa } = await import('sherpa-onnx-node');
      return await sherpa.OfflineRecognizer.createAsync({
        // The model carries its own feature settings; these are the recognizer's defaults.
        featConfig: { sampleRate: STT_SAMPLE_RATE, featureDim: 80 },
        modelConfig: {
          transducer: {
            encoder: this.model.path('encoder.int8.onnx'),
            decoder: this.model.path('decoder.int8.onnx'),
            joiner: this.model.path('joiner.int8.onnx'),
          },
          tokens: this.model.path('tokens.txt'),
          numThreads: Math.max(1, Math.min(4, availableParallelism() - 1)),
          provider: 'cpu',
          modelType: 'nemo_transducer',
          debug: 0,
        },
      });
    } catch (error) {
      this.recognizer = null; // Allow a retry once the files are in place.
      throw error;
    }
  }
}
