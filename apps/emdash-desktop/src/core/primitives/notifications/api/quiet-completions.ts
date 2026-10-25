/**
 * The seam between notification routing and whoever decides that finished agents with nothing for
 * the developer stay quiet. The notifications service owns routing; the conductor owns the
 * setting and the verdicts that tell a finished turn from one that needs the developer. The
 * conductor registers a policy here, and routing asks it for each finished-agent notification.
 * With no policy, or one that fails, every finished agent notifies as before.
 */

export type QuietCompletionsPolicy = {
  /** True when a finished agent that does not need the developer should make no sound or alert. */
  quiet(): Promise<boolean>;
};

let registered: QuietCompletionsPolicy | null = null;

export function setQuietCompletionsPolicy(policy: QuietCompletionsPolicy | null): void {
  registered = policy;
}

export async function quietCompletions(): Promise<boolean> {
  if (!registered) return false;
  return await registered.quiet().catch(() => false);
}
