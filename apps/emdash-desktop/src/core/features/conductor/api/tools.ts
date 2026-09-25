import type Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import {
  LOOK_AT_APP_DESCRIPTION,
  USE_APP_DESCRIPTION,
  type BrowserImage,
} from '@core/primitives/browser/api';

/**
 * Conductor tools. Definitions are shared: the main process sends them to Claude, the renderer
 * validates inputs with the zod schemas below and executes them through existing Emdash stores.
 * Order is fixed so the tool prefix stays byte-identical for prompt caching.
 */

const agentRef = z.string().min(1).describe('An agent name from the roster, e.g. "Atlas".');
const appRef = agentRef
  .optional()
  .describe("Whose task's app: an agent name. Defaults to the focused agent or app.");

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
  // Appended after the original tools so the cached prefix of earlier definitions is unchanged.
  close_agent: z.object({ agent: agentRef }),
  reopen_agent: z.object({ agent: agentRef }),
  stop_agent: z.object({ agent: agentRef }),
  // Canvas app browsers (appended; see the note above).
  start_app: z.object({ agent: appRef }),
  show_app: z.object({ agent: appRef, url: z.string().optional() }),
  look_at_app: z.object({
    agent: appRef,
    mode: z.enum(['screenshot', 'outline', 'text']),
    include_console: z.boolean().optional(),
  }),
  use_app: z.object({
    agent: appRef,
    action: z.enum([
      'navigate',
      'reload',
      'back',
      'forward',
      'click',
      'type',
      'press',
      'scroll',
      'select',
      'wait',
    ]),
    ref: z.string().optional().describe('Element ref from the latest outline, e.g. "e12".'),
    x: z.number().optional().describe('Screenshot x coordinate, with y, when no ref fits.'),
    y: z.number().optional(),
    url: z.string().optional().describe('navigate: URL or path on the app origin.'),
    text: z.string().max(5000).optional().describe('type: text to enter; wait: text to await.'),
    submit: z.boolean().optional().describe('type: press Enter afterwards.'),
    key: z.string().optional().describe('press: Enter, Tab, Escape, ArrowDown, a, ...'),
    value: z.string().optional().describe('select: option value or label.'),
    delta_y: z.number().optional().describe('scroll: pixels, positive scrolls down.'),
    url_includes: z.string().optional().describe('wait: substring the URL must contain.'),
    timeout_ms: z.number().optional().describe('wait: at most 15000.'),
  }),
  stop_app: z.object({ agent: appRef }),
  close_app: z.object({ agent: appRef }),
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
  close_agent:
    "Close an agent's window: hide its tile from the canvas. The agent keeps running and can be reopened. Use this for close, hide, dismiss, or get rid of a window. It does not stop or archive anything.",
  reopen_agent:
    'Bring a closed (hidden) agent window back onto the canvas and focus it. Closed agents are listed in the context block.',
  start_app:
    "Run a task's app (its run script) and open it in a browser tile on the canvas once its dev server is up.",
  show_app:
    "Open or focus a task's app browser on the canvas, optionally at a URL on the app's own origin.",
  look_at_app: LOOK_AT_APP_DESCRIPTION,
  use_app: `${USE_APP_DESCRIPTION} The first use in a while gives the user a short window to cancel.`,
  stop_app: "Stop a task's app (its dev server). The browser tile stays with its last view.",
  close_app: "Close a task's app browser tile. The app's dev server keeps running.",
  stop_agent:
    "Stop an agent's session entirely (ends its process; the conversation is kept and can be resumed). Only when the user asks to stop, kill, or shut down an agent, not to interrupt its current step; the user confirms first.",
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
  'stop_agent',
]);

/** Tools with side effects that run after a short, cancellable countdown. */
export const CANCEL_WINDOW_TOOLS: ReadonlySet<ConductorToolName> = new Set([
  'send_to_agent',
  'interrupt_agent',
  'spawn_agent',
  'start_app',
  'stop_app',
]);

/** A tool's result for the model: text, plus screenshots for app tools. */
export type ToolOutcome = { content: string; isError?: boolean; images?: BrowserImage[] };
