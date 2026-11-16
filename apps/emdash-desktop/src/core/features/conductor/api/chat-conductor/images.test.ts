import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { toOpenAiMessages } from '../openrouter-format';
import { attachedImagesNote, conductorImageType, withTurnImages } from './images';

const image = { id: 'i1', name: 'shot.png', mediaType: 'image/png' as const, data: 'AAAA' };

describe('conductor images', () => {
  it('reads the type from the MIME type, or the extension when there is none', () => {
    expect(conductorImageType('image/PNG', 'a')).toBe('image/png');
    expect(conductorImageType('', 'photo.JPG')).toBe('image/jpeg');
    expect(conductorImageType('image/svg+xml', 'logo.svg')).toBeNull();
    expect(conductorImageType('', 'notes.txt')).toBeNull();
  });

  it('puts the images before the text of the turn start only', () => {
    const messages: Anthropic.Beta.BetaMessageParam[] = [
      { role: 'user', content: 'earlier' },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: 'look' },
    ];
    const out = withTurnImages(messages, 2, [image]);
    expect(out[0]).toBe(messages[0]);
    expect(out[2]!.content).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
      { type: 'text', text: 'look' },
    ]);
    expect(messages[2]!.content).toBe('look');
  });

  it('names the images in the note', () => {
    expect(attachedImagesNote([])).toBe('');
    expect(attachedImagesNote([image, { name: 'b.png' }])).toContain(
      '2 images to this message (shot.png, b.png)'
    );
  });

  it('passes the images on through OpenRouter with their text', () => {
    const out = toOpenAiMessages(
      'system',
      withTurnImages([{ role: 'user', content: 'look' }], 0, [image])
    );
    expect(out[1]).toEqual({
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
        { type: 'text', text: 'look' },
      ],
    });
  });
});
