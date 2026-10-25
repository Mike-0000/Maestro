import type { CanvasStore } from '@core/features/canvas/api/browser/stores/canvas-store';
import { spokenProviderLabel } from '@core/features/canvas/api/provider-names';
import {
  asAvailableProject,
  getProjectManagerStore,
} from '@core/features/projects/api/browser/stores/project-selectors';
import type { TraceEvent } from '../api/contract';
import type { ProjectOption, ProviderOption, RouterInput } from '../api/jev-router/catalog';
import type { ConversationSnapshot } from '../api/jev-router/context';
import { decideRoute, type RouterDecision, type RouterOptions } from '../api/jev-router/policy';
import { buildRouterRequest } from '../api/jev-router/questions';
import { answersDetail } from '../api/jev-router/trace';
import { jevDecide } from './jev';
import { buildRoster, currentProject, focusedConversationId, installedProviders } from './roster';
import { agentMetadata } from './spawn';

type Detail = NonNullable<TraceEvent['detail']>;

export type RoutedUtterance =
  | { ok: true; decision: RouterDecision; detail: Detail }
  | { ok: false; detail: Detail };

function availableProjects(): ProjectOption[] {
  return [...getProjectManagerStore().projects.values()]
    .filter((project) => asAvailableProject(project))
    .map((project) => ({ id: project.id, name: project.name ?? project.id }));
}

async function routerProviders(): Promise<ProviderOption[]> {
  const installed = await installedProviders();
  // Detection failing is "unknown", not "none": offer every provider, as spawn_agent allows.
  const providers = installed.length > 0 ? installed : await agentMetadata().catch(() => []);
  return providers.map((provider) => ({
    id: provider.id,
    label: spokenProviderLabel(provider.id),
  }));
}

/** The router's view of the app right now: roster, projects, providers, and conversation. */
export async function routerInput(
  canvas: CanvasStore,
  utterance: string,
  context: ConversationSnapshot
): Promise<RouterInput> {
  const roster = buildRoster(canvas);
  const focusedId = focusedConversationId(canvas);
  const focused = roster.find((agent) => agent.id === focusedId) ?? null;
  const projects = availableProjects();
  // "Here" is the project on screen; with none on screen it is nothing, never the first project.
  const here = currentProject(canvas)?.name;
  return {
    utterance,
    roster,
    focused,
    projects,
    focusedProject: projects.find((project) => project.name === here) ?? null,
    providers: await routerProviders(),
    context,
  };
}

/**
 * One routing round trip: build the fan-out request, ask Jev, and decide. The detail is the
 * trace record of what Jev answered and why the router did what it did.
 */
export async function routeUtterance(
  input: RouterInput,
  options: RouterOptions
): Promise<RoutedUtterance> {
  const request = buildRouterRequest(input);
  const startedAt = performance.now();
  const outcome = await jevDecide(request.state, request.questions);
  const roundTripMs = Math.round(performance.now() - startedAt);
  const base: Detail = {
    purpose: 'route',
    questions: Object.keys(request.questions).length,
    catalog: request.plan.catalog.actions.size,
    roundTripMs,
  };
  if (!outcome.ok) {
    return { ok: false, detail: { ...base, status: 'failed', reason: outcome.reason } };
  }
  const { decision: jev } = outcome;
  const decision = decideRoute(jev.answers, request.plan, options);
  const detail: Detail = {
    ...base,
    status: 'answered',
    ms: jev.latencyMs,
    via: jev.via,
    model: jev.model,
    ...(jev.costUsd !== undefined ? { costUsd: jev.costUsd } : {}),
    decision: decision.kind,
    ...('reason' in decision ? { reason: decision.reason } : {}),
    ...(decision.kind === 'act'
      ? { action: decision.action.verb, confidence: Math.round(decision.confidence * 100) / 100 }
      : {}),
    ...(decision.kind === 'llm' ? { mode: decision.mode } : {}),
    ...answersDetail(jev.answers),
  };
  return { ok: true, decision, detail };
}
