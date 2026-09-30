import type { CloseScope } from '../grammar';
import { normalizeSpoken, type RosterAgent } from '../resolver';
import type { ConversationSnapshot } from './context';

/**
 * The vocabulary Jev routes with: intents (with rubrics drawn from real commands), target
 * sentinels that resolve "it" and "the one you just started" through the conversation context,
 * and the joint action catalog — up to 255 fully bound actions ("send · Maple 2", "spawn · Codex in
 * Chorus"). The router acts only when the catalog's pick matches the pick composed from the
 * separate slot answers, so each request checks itself.
 */

type IntentRubric = { what: string; not_for?: string; examples?: string[] };

export const INTENT_RUBRICS = {
  focus: {
    what: 'Show, open, bring up, zoom to, or switch to one specific agent',
    not_for: 'starting a new agent, or reopening a window the user closed earlier',
    examples: ['bring up the codex one', 'show me Maple 2', 'go to Tango'],
  },
  status: {
    what: 'Ask what one specific agent is doing, whether it is done, or what it asked',
    not_for: 'a detailed summary of its work or its final report',
    examples: ['is Delta done yet', 'what is Echo doing'],
  },
  summarize_agent: {
    what: "Summarize, explain, or read back an agent's work, report, or output in detail",
    examples: ['what did Maple find', 'summarize what Harbor 2 changed'],
  },
  interrupt: {
    what: 'Interrupt or cancel the step one specific agent is working on right now',
    not_for: 'closing its window or ending its session',
    examples: ['stop Delta, it is going the wrong way', 'interrupt the claude agent'],
  },
  close: {
    what: "Hide or dismiss one specific agent's window; the agent keeps running",
    not_for: 'shutting an agent down, archiving it, or stopping its work',
    examples: ['close Echo', 'hide that window'],
  },
  close_many: {
    what: 'Hide several agent windows at once: all of them, the others, or the finished ones',
    examples: ['close all the windows', 'hide the finished ones'],
  },
  reopen: {
    what: 'Bring back an agent window that was closed or hidden',
    examples: ['reopen Tango', 'bring all the closed windows back'],
  },
  overview: {
    what: 'Show every agent at once; zoom out to the whole board',
    examples: ['show me everything', 'zoom out'],
  },
  next: {
    what: 'Go to whichever agent is waiting for the user',
    examples: ['who needs me', 'next one'],
  },
  kill: {
    what: "End or kill an agent's session entirely",
    examples: ['kill Delta', 'shut down the codex agent'],
  },
  archive: {
    what: 'Archive or delete an agent and its conversation',
    examples: ['archive Maple', 'get rid of the old gemini agent'],
  },
  permission_allow: {
    what: "Approve an agent's pending permission prompt",
    examples: ['allow it', 'yes let Tango run that'],
  },
  permission_deny: {
    what: "Deny an agent's pending permission prompt",
    examples: ['deny that', "don't let it push"],
  },
  send_verbatim: {
    what: "Give an existing agent a message, answer, or instruction in the developer's own words",
    not_for: 'asking Chorus to write, improve, or compose the message; or starting a new agent',
    examples: [
      'tell Maple 2 to run the tests again',
      'send Tango: use the staging database instead',
      'follow up with the exact verbatim text I gave you',
    ],
  },
  send_composed: {
    what: 'Have Chorus write or compose a message for an existing agent from a description',
    examples: [
      'write Delta a detailed prompt about the auth bug',
      'give Echo a better prompt, that one was too thin',
    ],
  },
  spawn_blank: {
    what: 'Start one new agent without giving it a task yet',
    examples: [
      'open a new codex agent',
      "spin up a claude agent, I'll give it a prompt in a second",
    ],
  },
  spawn_with_brief: {
    what: 'Start one new agent and give it a task described in the utterance',
    not_for: 'splitting a goal across several agents',
    examples: [
      'start a codex agent to fix the login redirect',
      'create a pi agent in chorus that adds dark mode to the settings page',
    ],
  },
  plan_multi: {
    what: 'Split a goal across several new agents, or start more than one agent',
    examples: ['split the auth rewrite across three agents', 'spin up two agents for this'],
  },
  delivery: {
    what: 'Merge, promote, push, roll back, or schedule delivery of an agent’s work',
  },
  app: {
    what: "Start, stop, open, or screenshot an agent's running app or dev server",
    examples: ['open the app Harbor built', 'start the dev server'],
  },
  canvas_layout: {
    what: 'Arrange the canvas: regions, sizes, positions, the stage, pages',
  },
  project_question: {
    what: 'A question about the project, code, conflicts, or notes that Chorus should answer',
  },
  conversation: {
    what: 'Talking with Chorus itself: a question to it, an idea, thanks, or chit-chat',
  },
  other: {
    what: 'Anything else, several different actions at once, or unclear',
  },
} as const satisfies Record<string, IntentRubric>;

export type RouterIntent = keyof typeof INTENT_RUBRICS;

/** Intents about one existing agent. */
export const AGENT_INTENTS: ReadonlySet<RouterIntent> = new Set([
  'focus',
  'status',
  'summarize_agent',
  'interrupt',
  'close',
  'reopen',
  'kill',
  'archive',
  'permission_allow',
  'permission_deny',
  'send_verbatim',
  'send_composed',
]);

/** Intents that end an agent's work or answer for the developer: never acted on by Jev alone. */
export const DESTRUCTIVE_INTENTS: ReadonlySet<RouterIntent> = new Set([
  'kill',
  'archive',
  'permission_allow',
  'permission_deny',
  'close_many',
]);

/** Risk class of the intents Jev may execute directly; anything absent needs Claude. */
export const DIRECT_CLASS: Partial<Record<RouterIntent, 'navigate' | 'guarded' | 'write'>> = {
  focus: 'navigate',
  status: 'navigate',
  overview: 'navigate',
  next: 'navigate',
  reopen: 'navigate',
  close: 'guarded',
  close_many: 'guarded',
  interrupt: 'guarded',
  send_verbatim: 'write',
  spawn_blank: 'write',
  spawn_with_brief: 'write',
};

export const SENTINEL = {
  justStarted: '(the agent you just started)',
  lastMessaged: '(the agent you last messaged)',
  justReported: '(the agent that just reported)',
  focused: '(the focused agent)',
  several: '(several agents)',
  all: '(all agents)',
  newAgent: '(an agent that does not exist yet)',
  unknownName: '(a name not in this list)',
  none: '(not about an agent)',
} as const;

export const NOT_MENTIONED = '(not mentioned)';
export const SAME_AS_LAST = '(same as last time)';
export const FOCUSED_PROJECT = "(the focused agent's project)";

export type ProjectOption = { readonly id: string; readonly name: string };
export type ProviderOption = { readonly id: string; readonly label: string };

/** Spoken variants of provider names, for rubrics. */
const PROVIDER_EXAMPLES: Record<string, string[]> = {
  claude: ['Claude code', 'clod', 'cloud'],
  codex: ['codecs', 'code x'],
  'oh-my-pi': ['oh my pi', 'OMP', 'OMT'],
  pi: ['PI code', 'pie'],
  gemini: ['Jiminy'],
  cursor: ['curser'],
  opencode: ['open code'],
};

export type RouterInput = {
  readonly utterance: string;
  readonly roster: readonly RosterAgent[];
  readonly focused: RosterAgent | null;
  readonly projects: readonly ProjectOption[];
  /** Project of the focused agent, the default for a new agent. */
  readonly focusedProject: ProjectOption | null;
  readonly providers: readonly ProviderOption[];
  readonly context: ConversationSnapshot;
};

/** The roster agent a sentinel stands for right now, or null when it has no referent. */
export function sentinelReferent(
  sentinel: string,
  input: Pick<RouterInput, 'roster' | 'focused' | 'context'>
): RosterAgent | null {
  const byId = (id: string | undefined) =>
    id ? (input.roster.find((agent) => agent.id === id) ?? null) : null;
  switch (sentinel) {
    case SENTINEL.justStarted:
      return byId(input.context.lastSpawned?.conversationId);
    case SENTINEL.lastMessaged:
      return byId(input.context.lastAddressed?.conversationId);
    case SENTINEL.justReported:
      return byId(input.context.lastReported?.conversationId);
    case SENTINEL.focused:
      return input.focused;
    default:
      return null;
  }
}

/** Agents named (or nearly named) in the utterance. */
export function mentionedAgents(utterance: string, roster: readonly RosterAgent[]): RosterAgent[] {
  const spoken = ` ${normalizeSpoken(utterance)} `;
  return roster.filter((agent) => {
    const name = normalizeSpoken(agent.name);
    return name.length > 0 && spoken.includes(` ${name} `);
  });
}

/**
 * Agents worth a slot in the joint catalog, most likely first: context referents, agents the
 * utterance names, visible agents, then closed ones.
 */
export function salientAgents(input: RouterInput, limit: number): RosterAgent[] {
  const ordered: (RosterAgent | null)[] = [
    ...mentionedAgents(input.utterance, input.roster),
    input.focused,
    sentinelReferent(SENTINEL.lastMessaged, input),
    sentinelReferent(SENTINEL.justStarted, input),
    sentinelReferent(SENTINEL.justReported, input),
    ...input.roster.filter((agent) => !agent.hidden),
    ...input.roster.filter((agent) => agent.hidden),
  ];
  const seen = new Set<string>();
  const result: RosterAgent[] = [];
  for (const agent of ordered) {
    if (!agent || seen.has(agent.id)) continue;
    seen.add(agent.id);
    result.push(agent);
    if (result.length >= limit) break;
  }
  return result;
}

/** Sentinels that currently have a meaning (a referent, or none needed). */
export function liveSentinels(input: RouterInput): string[] {
  const withReferent = [
    SENTINEL.justStarted,
    SENTINEL.lastMessaged,
    SENTINEL.justReported,
    SENTINEL.focused,
  ].filter((sentinel) => sentinelReferent(sentinel, input));
  return [
    ...withReferent,
    SENTINEL.several,
    SENTINEL.all,
    SENTINEL.newAgent,
    SENTINEL.unknownName,
    SENTINEL.none,
  ];
}

export function providerRubric(provider: ProviderOption): IntentRubric {
  const examples = PROVIDER_EXAMPLES[provider.id];
  return {
    what: `The ${provider.label} coding agent`,
    ...(examples ? { examples } : {}),
  };
}

// ── Joint action catalog ─────────────────────────────────────────────────────

export type CatalogAction =
  | { readonly intent: RouterIntent; readonly agent: string }
  | { readonly intent: 'overview' | 'next' }
  | { readonly intent: 'close_many'; readonly scope: CloseScope }
  | { readonly intent: 'reopen_all' }
  | { readonly intent: 'spawn'; readonly providerId: string; readonly projectId: string }
  | { readonly intent: 'llm'; readonly bucket: RouterIntent };

/** Verbs the joint catalog binds to each salient agent. */
export const CATALOG_AGENT_VERBS = [
  'focus',
  'status',
  'interrupt',
  'close',
  'reopen',
  'send_verbatim',
  'kill',
  'archive',
  'permission_allow',
  'permission_deny',
] as const satisfies readonly RouterIntent[];

const LLM_BUCKETS: [RouterIntent, string][] = [
  ['send_composed', 'Chorus has to write or improve a message for an agent'],
  ['summarize_agent', "Chorus has to read and explain an agent's work"],
  ['plan_multi', 'Several agents or a plan'],
  ['project_question', 'A question for Chorus about the project or the agents'],
  ['canvas_layout', 'Arranging the canvas'],
  ['app', "An agent's app or dev server"],
  ['delivery', 'Merging, pushing, or delivering work'],
  ['conversation', 'Talking with Chorus, not a command'],
  ['other', 'Several different actions, or none of these'],
];

export const catalogKey = {
  agent: (intent: RouterIntent, agent: string) => `${intent} · ${agent}`,
  spawn: (provider: ProviderOption, project: ProjectOption) =>
    `spawn · ${provider.label} in ${project.name}`,
  closeMany: (scope: CloseScope) => `close_many · ${scope}`,
  reopenAll: 'reopen · all closed windows',
  llm: (bucket: RouterIntent) => `other · ${bucket}`,
};

export const MAX_CATALOG_OPTIONS = 255;
const MAX_SPAWN_OPTIONS = 40;

/** Projects a new agent could go to, the focused agent's project first. */
export function rankedProjects(input: RouterInput): ProjectOption[] {
  const first = input.focusedProject ? [input.focusedProject] : [];
  return [...first, ...input.projects.filter((project) => project.id !== input.focusedProject?.id)];
}

export type Catalog = {
  readonly criteria: Record<string, IntentRubric | string>;
  readonly actions: ReadonlyMap<string, CatalogAction>;
};

export function buildCatalog(input: RouterInput): Catalog {
  const criteria: Record<string, IntentRubric | string> = {};
  const actions = new Map<string, CatalogAction>();
  const add = (key: string, rubric: IntentRubric | string, action: CatalogAction) => {
    if (actions.size >= MAX_CATALOG_OPTIONS || actions.has(key)) return;
    criteria[key] = rubric;
    actions.set(key, action);
  };

  add('overview', INTENT_RUBRICS.overview.what, { intent: 'overview' });
  add('next', INTENT_RUBRICS.next.what, { intent: 'next' });
  add(catalogKey.closeMany('all'), 'Hide every agent window', {
    intent: 'close_many',
    scope: 'all',
  });
  add(catalogKey.closeMany('others'), 'Hide every window except the focused one', {
    intent: 'close_many',
    scope: 'others',
  });
  add(catalogKey.closeMany('done'), 'Hide the windows of agents that finished', {
    intent: 'close_many',
    scope: 'done',
  });
  add(catalogKey.reopenAll, 'Bring every closed agent window back', { intent: 'reopen_all' });
  for (const [bucket, what] of LLM_BUCKETS) {
    add(catalogKey.llm(bucket), what, { intent: 'llm', bucket });
  }

  const projects = rankedProjects(input);
  const providers = input.providers;
  const perProvider = Math.max(1, Math.floor(MAX_SPAWN_OPTIONS / Math.max(1, providers.length)));
  const spawnProjects = projects.slice(0, Math.min(5, perProvider));
  for (const provider of providers) {
    for (const project of spawnProjects) {
      if (actions.size >= LLM_BUCKETS.length + 6 + MAX_SPAWN_OPTIONS) break;
      add(
        catalogKey.spawn(provider, project),
        `Start a new ${provider.label} agent in the ${project.name} project, blank or with a task`,
        { intent: 'spawn', providerId: provider.id, projectId: project.id }
      );
    }
  }

  const room = MAX_CATALOG_OPTIONS - actions.size;
  const agents = salientAgents(input, Math.floor(room / CATALOG_AGENT_VERBS.length));
  for (const agent of agents) {
    for (const verb of CATALOG_AGENT_VERBS) {
      add(
        catalogKey.agent(verb, agent.name),
        `${INTENT_RUBRICS[verb].what}: ${agent.name} (${agent.providerLabel}, "${agent.taskName}")`,
        { intent: verb, agent: agent.name }
      );
    }
  }
  return { criteria, actions };
}
