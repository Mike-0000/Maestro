import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { adcPath, streamVertexTts, VertexAuth, type VertexTtsEvent } from './vertex-tts';

const options = () => ({
  token: 'access-token',
  project: 'my-project',
  model: 'gemini-3.8-flash-lite-tts' as const,
  voice: 'voice_f2e3b4a8',
  text: 'Sent to Atlas.',
  signal: new AbortController().signal,
});

function response(...chunks: string[]): Response {
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
        controller.close();
      },
    }),
    { status: 200 }
  );
}

const audioEvent = (data: string, mimeType = 'audio/l16; rate=24000; channels=1') =>
  `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { mimeType, data } }] } }] })}\r\n\r\n`;

describe('Vertex TTS streaming', () => {
  it('sends the voice style with the text, and none when it is blank', async () => {
    const pcm = Buffer.from([0, 0]).toString('base64');
    const request = vi.fn<typeof fetch>().mockImplementation(async () => response(audioEvent(pcm)));
    await streamVertexTts({ ...options(), style: ' laid-back ' }, () => {}, request);
    await streamVertexTts({ ...options(), style: '  ' }, () => {}, request);

    const bodies = request.mock.calls.map(([, init]) => JSON.parse(String(init?.body)));
    expect(bodies[0].contents[0].parts).toEqual([
      { text: 'Sent to Atlas.', speechMetadata: { style: 'laid-back' } },
    ]);
    expect(bodies[1].contents[0].parts).toEqual([{ text: 'Sent to Atlas.' }]);
  });

  it('sends the custom voice to the project endpoint and emits PCM chunks', async () => {
    const pcm = Buffer.from([0, 0, 255, 127]).toString('base64');
    const data = audioEvent(pcm);
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(response(data.slice(0, 30), data.slice(30), audioEvent(pcm)));
    const events: VertexTtsEvent[] = [];
    await streamVertexTts(options(), (event) => events.push(event), request);

    const [url, init] = request.mock.calls[0]!;
    expect(url).toBe(
      'https://aiplatform.googleapis.com/v1beta1/projects/my-project/locations/global/publishers/google/models/gemini-3.8-flash-lite-tts:streamGenerateContent?alt=sse'
    );
    expect(init?.headers).toMatchObject({
      authorization: 'Bearer access-token',
      'x-goog-user-project': 'my-project',
    });
    expect(JSON.parse(String(init?.body))).toMatchObject({
      contents: [{ parts: [{ text: 'Sent to Atlas.' }] }],
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: { voiceConfig: { voice: 'voice_f2e3b4a8' } },
      },
    });
    expect(events).toEqual([
      { type: 'chunk', pcm, sampleRate: 24_000 },
      { type: 'chunk', pcm, sampleRate: 24_000 },
      { type: 'done' },
    ]);
  });

  it('reports Google error statuses without the body text', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ error: { status: 'NOT_FOUND', message: 'voice x' } }), {
        status: 404,
      })
    );
    await expect(streamVertexTts(options(), () => {}, request)).rejects.toThrow(
      'Vertex TTS failed (404 NOT_FOUND).'
    );
  });

  it('rejects audio that is not PCM and streams with no audio', async () => {
    const wav = vi.fn<typeof fetch>().mockResolvedValue(response(audioEvent('AAAA', 'audio/wav')));
    await expect(streamVertexTts(options(), () => {}, wav)).rejects.toThrow('not PCM');
    const empty = vi.fn<typeof fetch>().mockResolvedValue(response('data: {"candidates":[]}\n\n'));
    await expect(streamVertexTts(options(), () => {}, empty)).rejects.toThrow('no audio');
  });
});

describe('VertexAuth', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });
  async function adcFile(contents: unknown) {
    const dir = await mkdtemp(join(tmpdir(), 'chorus-adc-'));
    dirs.push(dir);
    const path = join(dir, 'adc.json');
    await writeFile(path, JSON.stringify(contents));
    return path;
  }
  const user = {
    type: 'authorized_user',
    client_id: 'id',
    client_secret: 'secret',
    refresh_token: 'refresh',
    quota_project_id: 'my-project',
  };

  it('reads an authorized_user sign-in and caches its access token', async () => {
    const path = await adcFile(user);
    const request = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => Response.json({ access_token: 'token-1', expires_in: 3599 }));
    const auth = new VertexAuth(() => path, request);
    const adc = await auth.credentials();
    expect(adc?.quota_project_id).toBe('my-project');
    const signal = new AbortController().signal;
    expect(await auth.accessToken(adc!, signal)).toBe('token-1');
    expect(await auth.accessToken(adc!, signal)).toBe('token-1');
    expect(request).toHaveBeenCalledTimes(1);
    const body = request.mock.calls[0]![1]?.body as URLSearchParams;
    expect(body.get('grant_type')).toBe('refresh_token');
    expect(body.get('refresh_token')).toBe('refresh');
  });

  it('returns null without a usable sign-in', async () => {
    expect(await new VertexAuth(() => join(tmpdir(), 'missing-adc.json')).credentials()).toBeNull();
    const service = await adcFile({ type: 'service_account', private_key: 'x' });
    expect(await new VertexAuth(() => service).credentials()).toBeNull();
  });

  it('prefers GOOGLE_APPLICATION_CREDENTIALS, then CLOUDSDK_CONFIG', () => {
    expect(adcPath({ GOOGLE_APPLICATION_CREDENTIALS: '/x/adc.json' })).toBe('/x/adc.json');
    expect(adcPath({ CLOUDSDK_CONFIG: '/cfg' })).toBe(
      join('/cfg', 'application_default_credentials.json')
    );
  });
});
