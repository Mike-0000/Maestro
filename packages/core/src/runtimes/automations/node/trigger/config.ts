import { readFile } from 'node:fs/promises';
import { err, ok, type Result } from '@emdash/shared';
import { z } from 'zod';

export const TRIGGER_TOKEN_ENV = 'MAESTRO_TRIGGER_TOKEN';
export const TRIGGER_CONFIG_ENV = 'MAESTRO_TRIGGER_CONFIG';

const MIN_TOKEN_LENGTH = 32;

/**
 * The file is the gateway's allowlist: a caller names a trigger, never an automation
 * id or a path, so only automations listed here can be started over HTTP.
 */
export const triggerGatewayFileSchema = z.object({
  listen: z
    .object({
      host: z.string().min(1).default('127.0.0.1'),
      port: z.number().int().min(1).max(65_535).default(7461),
    })
    .default({ host: '127.0.0.1', port: 7461 }),
  /** Requests allowed to wait per trigger before new ones are refused with 429. */
  maxQueued: z.number().int().positive().default(20),
  triggers: z.record(
    z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/u, 'Trigger names are lowercase slugs'),
    z.object({ automationId: z.string().min(1) })
  ),
});

export type TriggerGatewayConfig = z.infer<typeof triggerGatewayFileSchema> & {
  token: string;
};

export async function loadTriggerGatewayConfig(
  env: NodeJS.ProcessEnv = process.env,
  read: (path: string) => Promise<string> = (path) => readFile(path, 'utf8')
): Promise<Result<TriggerGatewayConfig, string>> {
  const token = env[TRIGGER_TOKEN_ENV]?.trim() ?? '';
  if (token.length < MIN_TOKEN_LENGTH) {
    return err(`${TRIGGER_TOKEN_ENV} must be set to at least ${MIN_TOKEN_LENGTH} characters`);
  }
  const path = env[TRIGGER_CONFIG_ENV]?.trim();
  if (!path) return err(`${TRIGGER_CONFIG_ENV} must point at the trigger config file`);

  let raw: unknown;
  try {
    raw = JSON.parse(await read(path));
  } catch (error) {
    return err(
      `Cannot read trigger config ${path}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  const parsed = triggerGatewayFileSchema.safeParse(raw);
  if (!parsed.success) {
    return err(`Invalid trigger config ${path}: ${z.prettifyError(parsed.error)}`);
  }
  if (Object.keys(parsed.data.triggers).length === 0) {
    return err(`Trigger config ${path} lists no triggers`);
  }
  return ok({ ...parsed.data, token });
}
