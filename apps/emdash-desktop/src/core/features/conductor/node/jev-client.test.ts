import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { secret } from '@emdash/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { urgencyQuestions } from '../api/jev';
import { evaluateWithJev, JevRequestError } from './jev-client';

let server: Server;
let baseUrl = '';
let last: { url?: string; headers: IncomingHttpHeaders; body: Record<string, unknown> } | null;
let status = 200;
let reply: unknown = {};

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      last = {
        url: req.url,
        headers: req.headers,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>,
      };
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(reply));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.close();
});

beforeEach(() => {
  last = null;
  status = 200;
  reply = {
    model: 'jev-1.13.0',
    answers: {
      intent: {
        type: 'choice',
        choice: 'focus',
        probabilities: { focus: 0.93, other: 0.07 },
        confidence: 0.9,
      },
      decompose: { type: 'noul', noul: 0.04 },
    },
    usage: { input_tokens: 300, output_tokens: 20 },
  };
});

const key = secret('ts-test-key', 'typesafe');

describe('evaluateWithJev', () => {
  it('posts state and typed questions to /v1/systemone with a bearer key', async () => {
    const questions = urgencyQuestions();
    const result = await evaluateWithJev(key, { utterance: 'focus clod one' }, questions, {
      baseUrl,
    });
    expect(last?.url).toBe('/v1/systemone');
    expect(last?.headers.authorization).toBe('Bearer ts-test-key');
    expect(last?.body).toEqual({
      model: 'jev-latest',
      state: { utterance: 'focus clod one' },
      questions,
    });
    expect(result.model).toBe('jev-1.13.0');
    expect(result.answers.intent).toMatchObject({ type: 'choice', choice: 'focus' });
  });

  it('calls the OpenRouter System One endpoint with the Jev alias and reports cost', async () => {
    reply = {
      ...(reply as object),
      usage: { input_tokens: 300, output_tokens: 20, cost: 0.00002 },
    };
    const result = await evaluateWithJev(key, 'state', urgencyQuestions(), {
      via: 'openrouter',
      baseUrl,
    });
    expect(last?.url).toBe('/systemone');
    expect(last?.body.model).toBe('~typesafe/jev-latest');
    expect(last?.headers['x-openrouter-title']).toBe('Chorus');
    expect(result.costUsd).toBe(0.00002);
  });

  it('reports missing OpenRouter credits', async () => {
    status = 402;
    await expect(
      evaluateWithJev(key, 's', {}, { via: 'openrouter', baseUrl })
    ).rejects.toMatchObject({ kind: 'no-credits' });
  });

  it('maps a rejected key and rate limits', async () => {
    status = 401;
    await expect(evaluateWithJev(key, 's', {}, { baseUrl })).rejects.toMatchObject({
      kind: 'rejected-key',
    });
    status = 429;
    await expect(evaluateWithJev(key, 's', {}, { baseUrl })).rejects.toBeInstanceOf(
      JevRequestError
    );
  });

  it('rejects malformed answers', async () => {
    reply = { model: 'jev', answers: { x: { type: 'choice', choice: 1 } } };
    await expect(evaluateWithJev(key, 's', {}, { baseUrl })).rejects.toMatchObject({
      kind: 'api-error',
    });
  });
});
