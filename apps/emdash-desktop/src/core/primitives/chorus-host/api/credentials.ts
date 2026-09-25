import { z } from 'zod';

/** Credentials Chorus stores (OS-encrypted) for its voice and conductor features. */
export const chorusCredentialIds = [
  'openai',
  'deepgram',
  'anthropic',
  'typesafe',
  'openrouter',
  'gemini',
] as const;
export const chorusCredentialIdSchema = z.enum(chorusCredentialIds);
export type ChorusCredentialId = z.infer<typeof chorusCredentialIdSchema>;
