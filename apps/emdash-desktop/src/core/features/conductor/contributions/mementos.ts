import { defineVersionedSchema } from '@emdash/core/primitives/versioned-schema/api';
import { z } from 'zod';
import { conversationSubject } from '@core/features/conversations/contributions/subject';
import { days, defineMemento } from '@core/primitives/mementos/api';

export const chatViewSchema = z.enum(['conductor', 'raw']);
/** What a chat's tab shows: the thread with its conductor, or the agent itself. */
export type ChatView = z.infer<typeof chatViewSchema>;

export const chatViewChoiceSchema = defineVersionedSchema()
  .initial(
    '1',
    z.object({
      version: z.literal('1'),
      /** Null until the developer picks a view for this chat; the app's default applies. */
      view: chatViewSchema.nullable(),
    })
  )
  .build();
export type ChatViewChoiceState = typeof chatViewChoiceSchema.Type;

/** The view the developer last picked for a chat, kept per conversation. */
export const chatViewChoiceMemento = defineMemento({
  id: 'conductor.chat-view',
  subject: conversationSubject,
  schema: chatViewChoiceSchema,
  default: { version: '1' as const, view: null },
  retention: { tier: 'persisted', maxAge: days(90), maxEntries: 5_000 },
});
