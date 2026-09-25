import type Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';

/**
 * Conductor tools. Definitions are shared: the main process sends them to Claude, the renderer
 * validates inputs with the zod schemas below and executes them through existing Emdash stores.
 * Order is fixed so the tool prefix stays byte-identical for prompt caching.
 */

const agentRef = z.string().min(1).describe('An agent name from the roster, e.g. "Atlas".');

export const conductorToolSchemas = {
  list_agents: z.object({}),
  read_agent: z.object({
    agent: agentRef,
    lines: z.number().int().min(5).max(200).optional(),
  }),
  focus_agent: z.object({ agent: agentRef }),
  show_all: z.object({}),
  send_to_agent: z.object({
    agent: agentRef,
    text: z.string().min(1),
    submit: z.boolean().optional(),
  }),
  interrupt_agent: z.object({ agent: agentRef }),
  answer_permission: z.object({ agent: agentRef, decision: z.enum(['allow', 'deny']) }),
  spawn_agent: z.object({
    project: z.string().optional(),
    provider: z.string().min(1),
    task_name: z.string().min(1).max(80),
    prompt: z.string(),
  }),
  propose_plan: z.object({
    goal: z.string().min(1),
    project: z.string().optional(),
    subtasks: z
      .array(
        z.object({
          title: z.string().min(1).max(80),
          provider: z.string().min(1),
          prompt: z.string().min(1),
          owned_paths: z.array(z.string().min(1)).min(1),
          acceptance: z.string().optional(),
          sequential_after: z.string().optional(),
        })
      )
      .min(1)
      .max(12),
  }),
  check_conflicts: z.object({ agents: z.array(agentRef).min(2).max(12) }),
  add_note: z.object({ text: z.string().min(1) }),
  archive_agent: z.object({ agent: agentRef }),
} as const;

export type ConductorToolName = keyof typeof conductorToolSchemas;
export type ConductorToolInput<Name extends ConductorToolName> = z.infer<
  (typeof conductorToolSchemas)[Name]
>;

const descriptions: Record<ConductorToolName, string> = {
  list_agents:
    'List every agent on the canvas with its name, provider, status, task, and project. Use when the context block is not enough.',
  read_agent:
    "Read the last lines of an agent's terminal to see what it is doing, what it asked, or whether it finished.",
  focus_agent: 'Zoom the canvas to one agent so the user can watch or type into it.',
  show_all: 'Zoom the canvas out to show every agent.',
  send_to_agent:
    "Type text into an agent's input. submit defaults to true (presses Enter). Use for instructions, answers to the agent's questions, and follow-ups. The user gets a short window to cancel.",
  interrupt_agent: 'Interrupt an agent that is working (like pressing Escape).',
  answer_permission:
    'Answer an agent that is waiting on a permission prompt. Only when the user explicitly said to allow or deny; the user confirms before it is sent.',
  spawn_agent:
    'Start ONE new agent in a fresh git worktree of a project with a prompt. For goals that split into several independent parts, use propose_plan instead.',
  propose_plan:
    'Propose splitting a goal into parallel agents. Each subtask gets its own worktree and branch, so owned_paths must not overlap between subtasks unless one runs sequential_after another. The user approves the plan on the canvas before anything starts.',
  check_conflicts:
    "Predict whether the named agents' branches would merge cleanly with each other (read-only).",
  add_note: 'Pin a sticky note to the canvas.',
  archive_agent:
    "Archive an agent's task when its work is finished or abandoned. The worktree and branch are kept. Only when the user asked for it; the user confirms first.",
};

function toolDefinition(name: ConductorToolName): Anthropic.Beta.BetaTool {
  const jsonSchema = z.toJSONSchema(conductorToolSchemas[name], { target: 'draft-7' }) as Record<
    string,
    unknown
  >;
  delete jsonSchema.$schema;
  return {
    name,
    description: descriptions[name],
    input_schema: jsonSchema as Anthropic.Beta.BetaTool.InputSchema,
  };
}

export const conductorToolNames = Object.keys(conductorToolSchemas) as ConductorToolName[];

export function conductorToolDefinitions(): Anthropic.Beta.BetaTool[] {
  return conductorToolNames.map(toolDefinition);
}

/** Tools whose effects the user must explicitly confirm (not just get a chance to cancel). */
export const CONFIRM_REQUIRED_TOOLS: ReadonlySet<ConductorToolName> = new Set([
  'answer_permission',
  'archive_agent',
]);

/** Tools with side effects that run after a short, cancellable countdown. */
export const CANCEL_WINDOW_TOOLS: ReadonlySet<ConductorToolName> = new Set([
  'send_to_agent',
  'interrupt_agent',
  'spawn_agent',
]);
