import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { secret } from '@emdash/shared';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { encodeWav } from '../../api/wav';
import { OpenRouterSttEngine } from './openrouter';

let server: Server;
let lastBody: Record<string, unknown> | null = null;
let reply = '"tell Codex 1 to run the tests"';
const savedBase = process.env.OPENROUTER_BASE_URL;

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      lastBody = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: reply } }] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  process.env.OPENROUTER_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.close();
});

afterEach(() => {
  if (savedBase === undefined) delete process.env.OPENROUTER_BASE_URL;
});

describe('OpenRouterSttEngine', () => {
  it('sends base64 WAV as input_audio with vocabulary hints and strips quotes', async () => {
    const engine = new OpenRouterSttEngine(
      async () => secret('sk-or-test', 'openrouter'),
      async () => 'google/gemini-3.5-flash-lite'
    );
    const audio = encodeWav(new Float32Array(1600));
    const text = await engine.transcribe({ audio, vocabulary: ['Codex 1'], language: 'en' });
    expect(text).toBe('tell Codex 1 to run the tests');
    expect(lastBody?.model).toBe('google/gemini-3.5-flash-lite');
    const messages = lastBody?.messages as { role: string; content: unknown }[];
    expect(String(messages[0]?.content)).toContain('Codex 1');
    const parts = messages[1]?.content as {
      type: string;
      input_audio?: { data: string; format: string };
    }[];
    const audioPart = parts.find((part) => part.type === 'input_audio');
    expect(audioPart?.input_audio?.format).toBe('wav');
    expect(
      Buffer.from(audioPart?.input_audio?.data ?? '', 'base64')
        .subarray(0, 4)
        .toString()
    ).toBe('RIFF');
  });

  it('requires a key', async () => {
    reply = 'x';
    const engine = new OpenRouterSttEngine(
      async () => null,
      async () => 'm'
    );
    await expect(
      engine.transcribe({ audio: new Uint8Array(100), vocabulary: [], language: 'en' })
    ).rejects.toMatchObject({ kind: 'not-configured' });
  });
});
