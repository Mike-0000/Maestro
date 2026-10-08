import type { AutomationAgentConfig } from '../../api/deployment';
import type { AutomationRun, AutomationRunRequest } from '../../api/run';

const MAX_SLUG_LENGTH = 32;

/**
 * Request runs reuse the caller's request id as the run id, so a repeated
 * submission collides on the run primary key instead of starting a second agent.
 * The generated name becomes the branch and worktree name.
 */
export function requestRunIdentity(request: AutomationRunRequest): {
  id: string;
  generatedName: string;
} {
  return {
    id: request.id,
    generatedName: `req-${slugify(request.title)}-${request.id.slice(0, 8)}`,
  };
}

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/u, '');
  return slug || 'request';
}

/** The request as the agent sees it: prompt content only, never shell or path input. */
export function formatRequestPrompt(request: AutomationRunRequest): string {
  const origin = [request.requester?.name, request.source?.app && `via ${request.source.app}`]
    .filter(Boolean)
    .join(' ');
  const lines = [origin ? `Feature request from ${origin}:` : 'Feature request:', request.title];
  if (request.body.trim()) lines.push('', request.body.trim());
  return lines.join('\n');
}

/**
 * Appends the request to the automation's standing prompt. The deployment's prompt
 * holds the durable instructions; the request is the task for this one run.
 */
export function agentForRequest(
  agent: AutomationAgentConfig,
  request: AutomationRunRequest
): AutomationAgentConfig {
  const requestPrompt = formatRequestPrompt(request);
  if (agent.type === 'tui') {
    return {
      ...agent,
      title: agent.title ?? request.title,
      start: {
        ...agent.start,
        initialPrompt: `${agent.start.initialPrompt}\n\n---\n\n${requestPrompt}`,
      },
    };
  }

  const [first, ...rest] = agent.start.initialQueue;
  return {
    ...agent,
    title: agent.title ?? request.title,
    start: {
      ...agent.start,
      initialQueue: [
        { ...first, text: `${first?.text ?? ''}\n\n---\n\n${requestPrompt}`.trim() },
        ...rest,
      ],
    },
  };
}

export function pullRequestText(run: AutomationRun): { title: string; body: string } {
  const request = run.request;
  if (!request) {
    return {
      title: run.configSnapshot.name,
      body: `Opened by the "${run.configSnapshot.name}" automation (run ${run.id}).\n\nReview before merging.`,
    };
  }

  const lines = [request.body.trim() || request.title, '', '---'];
  if (request.requester?.name || request.requester?.id) {
    lines.push(`Requested by: ${request.requester.name ?? request.requester.id}`);
  }
  if (request.source?.app) lines.push(`Source: ${request.source.app}`);
  if (request.source?.url) lines.push(`Link: ${request.source.url}`);
  lines.push(`Request: ${request.id}`, '', 'Opened by an automated agent. Review before merging.');
  return { title: request.title, body: lines.join('\n') };
}
