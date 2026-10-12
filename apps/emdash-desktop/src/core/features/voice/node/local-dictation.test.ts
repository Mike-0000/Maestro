import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DictationModelStatus } from '../api/contract';
import { DictationModel, LocalDictation, type ModelFile } from './local-dictation';

const { createAsync } = vi.hoisted(() => ({ createAsync: vi.fn() }));
vi.mock('sherpa-onnx-node', () => ({ default: { OfflineRecognizer: { createAsync } } }));

const CONTENT = { 'a.onnx': 'model bytes', 'tokens.txt': 'a b c' };

function fileOf(name: keyof typeof CONTENT, body: string = CONTENT[name]): ModelFile {
  return {
    name,
    size: Buffer.byteLength(body),
    sha256: createHash('sha256').update(body).digest('hex'),
  };
}

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dictation-model-'));
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(dir, { recursive: true, force: true });
});

function serve(content: Record<string, string>): void {
  vi.stubGlobal('fetch', async (url: string) => {
    const body = content[url.split('/').at(-1) ?? ''];
    return body === undefined ? new Response(null, { status: 404 }) : new Response(body);
  });
}

async function downloaded(model: DictationModel): Promise<DictationModelStatus> {
  return new Promise((resolve) => {
    void model.start((status) => {
      if (status.state !== 'downloading') resolve(status);
    });
  });
}

describe('DictationModel', () => {
  it('fetches the files once, checks them, and is ready afterwards', async () => {
    serve(CONTENT);
    const model = new DictationModel(dir, [fileOf('a.onnx'), fileOf('tokens.txt')], 'https://m');
    expect((await model.status()).state).toBe('missing');
    expect((await downloaded(model)).state).toBe('ready');
    expect(await readFile(join(dir, 'a.onnx'), 'utf8')).toBe('model bytes');
    // A second model object over the same directory needs no download.
    const again = new DictationModel(dir, [fileOf('a.onnx'), fileOf('tokens.txt')], 'https://m');
    expect((await again.status()).state).toBe('ready');
  });

  it('keeps nothing that does not match its checksum', async () => {
    serve({ ...CONTENT, 'a.onnx': 'other bytes' });
    const model = new DictationModel(dir, [fileOf('a.onnx'), fileOf('tokens.txt')], 'https://m');
    const status = await downloaded(model);
    expect(status.state).toBe('failed');
    expect(status.message).toMatch(/checksum/);
    expect(await model.ready()).toBe(false);
    await expect(readFile(join(dir, 'a.onnx'))).rejects.toThrow();
  });

  it('reports a failed request and can be retried', async () => {
    serve({});
    const model = new DictationModel(dir, [fileOf('a.onnx')], 'https://m');
    expect((await downloaded(model)).state).toBe('failed');
    serve(CONTENT);
    expect((await downloaded(model)).state).toBe('ready');
  });
});

describe('LocalDictation', () => {
  it('loads the recognizer once and transcribes what is pushed', async () => {
    const decodeAsync = vi.fn().mockResolvedValue(undefined);
    createAsync.mockReset().mockResolvedValue({
      createStream: () => ({ acceptWaveform: vi.fn() }),
      decodeAsync,
      getResult: () => ({ text: ' Hello there. ' }),
    });
    const dictation = new LocalDictation(new DictationModel(dir));
    const first = dictation.open(() => {});
    const samples = new Int16Array(16_000).fill(8000);
    first.push(new Uint8Array(samples.buffer));
    expect(await first.finish()).toBe('Hello there.');
    const second = dictation.open(() => {});
    second.push(new Uint8Array(samples.buffer));
    await second.finish();
    expect(createAsync).toHaveBeenCalledTimes(1);
    expect(createAsync.mock.calls[0]?.[0].modelConfig).toMatchObject({
      modelType: 'nemo_transducer',
      provider: 'cpu',
      tokens: join(dir, 'tokens.txt'),
    });
    dictation.dispose();
  });
});
