import { defineVersionedSchema } from '@emdash/core/primitives/versioned-schema/api';
import { z } from 'zod';
import { days, defineMemento } from '@core/primitives/mementos/api';
import { appSubject } from '@core/primitives/subjects/api';

const tileRectSchema = z.object({
  x: z.number(),
  y: z.number(),
  w: z.number(),
  h: z.number(),
});

const noteSchema = z.object({
  text: z.string(),
  color: z.enum(['yellow', 'blue', 'green', 'pink', 'gray']).optional(),
});

const canvasBoardV1Schema = z.object({
  version: z.literal('1'),
  viewport: z.object({ x: z.number(), y: z.number(), zoom: z.number() }),
  /** Tile geometry keyed by tile id (`agent:<conversationId>` or `note:<noteId>`). */
  tiles: z.record(z.string(), tileRectSchema),
  notes: z.record(z.string(), noteSchema),
  /** User-visible, speakable agent names keyed by conversation id. */
  spokenNames: z.record(z.string(), z.string()),
  /** Conversation ids the user removed from the board (the conversation itself is kept). */
  hiddenConversationIds: z.array(z.string()),
  /** Optional project filter; null shows every project. */
  projectFilter: z.string().nullable(),
});

export const canvasBoardSchema = defineVersionedSchema().initial('1', canvasBoardV1Schema).build();

export type CanvasBoardState = typeof canvasBoardSchema.Type;

export const canvasBoardMemento = defineMemento({
  id: 'canvas.board',
  subject: appSubject,
  schema: canvasBoardSchema,
  default: {
    version: '1' as const,
    viewport: { x: 80, y: 80, zoom: 0.6 },
    tiles: {},
    notes: {},
    spokenNames: {},
    hiddenConversationIds: [],
    projectFilter: null,
  },
  retention: { tier: 'persisted', maxAge: days(365), maxEntries: 4 },
});
