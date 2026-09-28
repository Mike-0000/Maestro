import type Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import {
  LOOK_AT_APP_DESCRIPTION,
  USE_APP_DESCRIPTION,
  type BrowserImage,
} from '@core/primitives/browser/api';
import { ARRANGE_OPS, ARRANGE_SIZES, ARRANGE_SLOTS } from './canvas-tool-ops';

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
  // Canvas layout (appended; see the note above).
  describe_canvas: z.object({}),
  arrange_canvas: z.object({
    steps: z
      .array(
        z.object({
          op: z.enum(ARRANGE_OPS),
          windows: z
            .array(z.string().min(1))
            .optional()
            .describe('Windows or regions by spoken name ("Atlas", "Checkout app", "Review").'),
          region: z
            .string()
            .optional()
            .describe('Region by name; "board" for the main board (move_into).'),
          name: z.string().max(40).optional().describe('group / rename_region: region name.'),
          color: z.enum(['blue', 'violet', 'green', 'amber', 'rose', 'teal', 'gray']).optional(),
          anchor: z.string().optional().describe('place: the window to place next to.'),
          side: z.enum(['left', 'right', 'above', 'below']).optional(),
          slot: z.enum(ARRANGE_SLOTS).optional().describe('place: spot in the view instead.'),
          size: z.enum(ARRANGE_SIZES).optional(),
          like: z.string().optional().describe("resize: match this window's size."),
          layout: z
            .enum(['grid', 'row', 'column', 'tidy', 'tile'])
            .optional()
            .describe(
              'arrange: tile fills the region (or a new one) as a weighted split; four make quadrants.'
            ),
          by: z.enum(['task', 'project', 'status', 'provider']).optional(),
        })
      )
      .min(1)
      .max(12),
  }),
  canvas_view: z.object({
    action: z.enum([
      'stage',
      'leave_stage',
      'go_to_region',
      'leave_region',
      'next_region',
      'previous_region',
      'home',
      'back',
      'undo',
      'redo',
    ]),
    windows: z
      .array(z.string().min(1))
      .optional()
      .describe('stage: windows or one region to show full screen; go_to_region: the region.'),
    immersive: z.boolean().optional().describe('stage: also hide the app chrome.'),
  }),
  delivery_status: z.object({ project: z.string().optional() }),
  enable_delivery: z.object({ project: z.string().optional() }),
  prepare_delivery: z.object({
    project: z.string().optional(),
    policy: z.enum(['snapshot', 'follow-project']),
    tasks: z.array(z.string().min(1)).optional(),
  }),
  resume_delivery: z.object({ project: z.string().optional(), candidate_id: z.string().uuid() }),
  validate_delivery: z.object({ project: z.string().optional(), candidate_id: z.string().uuid() }),
  promote_delivery: z.object({ project: z.string().optional(), candidate_id: z.string().uuid() }),
  push_delivery_backup: z.object({
    project: z.string().optional(),
    candidate_id: z.string().uuid(),
  }),
  schedule_delivery: z.object({
    project: z.string().optional(),
    candidate_id: z.string().uuid(),
    restart: z.literal('manual'),
  }),
  cancel_delivery: z.object({ project: z.string().optional(), candidate_id: z.string().uuid() }),
  rollback_delivery: z.object({ project: z.string().optional(), candidate_id: z.string().uuid() }),
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
    "Open or focus a task's app browser on the canvas, optionally at a URL on the app's own origin or on localhost (such as the dev server URL an agent reported). Without a url it opens the running app, or the local URL the task's agent reported.",
  look_at_app: LOOK_AT_APP_DESCRIPTION,
  use_app: `${USE_APP_DESCRIPTION} The first use in a while gives the user a short window to cancel.`,
  stop_app: "Stop a task's app (its dev server). The browser tile stays with its last view.",
  close_app: "Close a task's app browser tile. The app's dev server keeps running.",
  describe_canvas:
    'Describe how the canvas is organized: regions and the windows in each, where the user is, and the selection.',
  arrange_canvas:
    'Rearrange canvas windows in one undoable change: group windows into named regions (sub-canvases), move them into or out of regions, place them next to each other or in a spot, resize, line up, organize by task/project/status/provider, swap, and rename, recolor, collapse, fit, or dissolve regions. Steps run in order; large changes are previewed briefly first. Windows keep running; nothing is closed.',
  canvas_view:
    'Change what the user looks at: put windows or a region on the stage (tiled full screen, live), leave the stage, go into a sub-canvas (it fills the screen), leave it for its parent, go to the next or previous sub-canvas, show the main canvas, go back, or undo/redo the last layout change.',
  delivery_status:
    'Report the local Maestro delivery queue for the named project, including active tasks, the frozen candidate, validation, and whether later work made it ineligible.',
  enable_delivery:
    'Enable the durable local update coordinator for a local Maestro Git project and enroll its existing active tasks.',
  prepare_delivery:
    'Freeze and combine ready task commits in an isolated integration worktree. snapshot uses exactly the current ready set; follow-project waits for every enrolled task and includes late arrivals.',
  resume_delivery:
    'After conflicts are resolved and committed in the preserved candidate worktree, verify the resolution and merge the remaining selected commits. Never resolves conflicts automatically.',
  validate_delivery:
    'Run the fixed repository checks and Windows package build for one integrated candidate, then record the verified artifact hashes.',
  promote_delivery:
    'Fast-forward the selected validated candidate onto the local chorus/main branch. This changes the project source checkout only when that branch is clean and unchanged.',
  push_delivery_backup:
    'Push the exact promoted candidate commit to origin/main on GitHub without force. Report backup success or leave it visibly pending if GitHub rejects the push.',
  schedule_delivery:
    'Schedule a promoted, validated local update after explicit user confirmation. Scheduling is rejected while any agent, terminal, or remote session is active. Maestro stays open until the user quits normally; then a detached worker installs and verifies the candidate with rollback available.',
  cancel_delivery:
    'Cancel a prepared candidate or atomically cancel a scheduled install before the replacement worker claims it. Once file replacement begins, cancellation is refused and recovery must finish.',
  rollback_delivery:
    'Roll back the currently installed candidate to its exact retained previous build after explicit user confirmation. The matched pre-update Maestro profile is restored and the current profile is retained for recovery; every Maestro session must be stopped and Maestro must be quit normally.',
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
  'promote_delivery',
  'push_delivery_backup',
  'schedule_delivery',
  'rollback_delivery',
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
