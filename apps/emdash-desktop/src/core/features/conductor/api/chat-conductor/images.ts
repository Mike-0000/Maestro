import type Anthropic from '@anthropic-ai/sdk';

type Message = Anthropic.Beta.BetaMessageParam;

/** The image types the model takes. */
export const CONDUCTOR_IMAGE_TYPES = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
] as const;
export type ConductorImageType = (typeof CONDUCTOR_IMAGE_TYPES)[number];

/** Images one message to the conductor may carry. */
export const MAX_CONDUCTOR_IMAGES = 6;
/** The largest image file taken: its base64 stays under the API's 5 MB per image. */
export const MAX_CONDUCTOR_IMAGE_BYTES = 3_750_000;

/** An image the developer pasted or dropped into the composer, read as base64. */
export type ConductorImage = {
  id: string;
  name: string;
  mediaType: ConductorImageType;
  /** Base64, without the `data:` prefix. */
  data: string;
};

const EXTENSION_TYPES: Record<string, ConductorImageType> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};

/**
 * The model's type for a file, from its MIME type or, when that is empty (some drops from the
 * desktop), its extension. Null for anything the model cannot read.
 */
export function conductorImageType(mimeType: string, name: string): ConductorImageType | null {
  const type = mimeType.toLowerCase();
  if ((CONDUCTOR_IMAGE_TYPES as readonly string[]).includes(type)) {
    return type as ConductorImageType;
  }
  if (type) return null;
  const extension = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase();
  return extension ? (EXTENSION_TYPES[extension] ?? null) : null;
}

/**
 * The line added to the developer's message when it carries images. The images go with that
 * message's turn only; the saved history keeps this line, so later turns know they were there.
 */
export function attachedImagesNote(images: readonly Pick<ConductorImage, 'name'>[]): string {
  if (images.length === 0) return '';
  const names = images.map((image) => image.name).join(', ');
  const count = images.length === 1 ? 'an image' : `${images.length} images`;
  return `[The developer attached ${count} to this message (${names}). They are shown with this message only; describe what matters in them if you will need it later.]`;
}

/**
 * The turn's messages as sent to the model: the message at `index`, the developer's (plain text),
 * carries the images before its text. Every other message is left as it is.
 */
export function withTurnImages(
  messages: readonly Message[],
  index: number,
  images: readonly ConductorImage[]
): Message[] {
  const target = messages[index];
  if (images.length === 0 || !target || typeof target.content !== 'string') return [...messages];
  const content: Anthropic.Beta.BetaContentBlockParam[] = [
    ...images.map(
      (image): Anthropic.Beta.BetaImageBlockParam => ({
        type: 'image',
        source: { type: 'base64', media_type: image.mediaType, data: image.data },
      })
    ),
    { type: 'text', text: target.content },
  ];
  const out = [...messages];
  out[index] = { role: target.role, content };
  return out;
}
