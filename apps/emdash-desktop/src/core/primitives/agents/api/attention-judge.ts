/**
 * The seam between agent status and whoever decides if a finished turn needs the developer. The
 * status service owns the status; the conductor owns the model. The conductor registers a judge
 * here, and the status service asks it once per finished turn. With no judge, or one that cannot
 * answer, a finished turn is simply completed.
 */

export type AttentionVerdict = {
  /** True when the agent cannot go on until the developer answers, decides, or does something. */
  readonly needsDeveloper: boolean;
  /** One short sentence saying why, for diagnostics. */
  readonly reason: string;
};

export type AttentionJudgeInput = {
  readonly conversationId: string;
  readonly providerId?: string;
  /** The agent's final reply of the turn. Untrusted agent output. */
  readonly reply: string;
};

export type AttentionJudge = {
  /** Cheap check made before anything is fetched for a verdict. */
  enabled(): Promise<boolean>;
  /** Null when no verdict could be reached: the caller keeps its rule-based status. */
  judge(input: AttentionJudgeInput): Promise<AttentionVerdict | null>;
};

let registered: AttentionJudge | null = null;

export function setAttentionJudge(judge: AttentionJudge | null): void {
  registered = judge;
}

export function getAttentionJudge(): AttentionJudge | null {
  return registered;
}
