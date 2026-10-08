import { describe, expect, it } from 'vitest';
import type { AutomationAgentConfig } from '../../api/deployment';
import type { AutomationRunRequest } from '../../api/run';
import { agentForRequest, formatRequestPrompt, requestRunIdentity } from './request';

const request: AutomationRunRequest = {
  id: '0f3c9a52-6d1e-4b7a-9c3e-2a1b4c5d6e7f',
  title: 'Add CSV export to the runs list!',
  body: 'Users want to download runs.',
  requester: { id: 'u_1', name: 'Sam' },
  source: { app: 'admin' },
};

describe('requestRunIdentity', () => {
  it('uses the request id as the run id and derives a branch-safe name', () => {
    expect(requestRunIdentity(request)).toEqual({
      id: request.id,
      generatedName: 'req-add-csv-export-to-the-runs-list-0f3c9a52',
    });
  });

  it('falls back when the title has no usable characters', () => {
    expect(requestRunIdentity({ ...request, title: '!!! ???' }).generatedName).toBe(
      'req-request-0f3c9a52'
    );
  });

  it('keeps shell and path metacharacters out of the name', () => {
    const name = requestRunIdentity({
      ...request,
      title: '../../etc; rm -rf $(x) `y`',
    }).generatedName;
    expect(name).toMatch(/^req-[a-z0-9-]+-0f3c9a52$/u);
  });
});

describe('formatRequestPrompt', () => {
  it('names the requester and source and includes the body', () => {
    expect(formatRequestPrompt(request)).toBe(
      'Feature request from Sam via admin:\nAdd CSV export to the runs list!\n\nUsers want to download runs.'
    );
  });

  it('omits the attribution and body when they are absent', () => {
    expect(formatRequestPrompt({ id: request.id, title: 'Fix it', body: '  ' })).toBe(
      'Feature request:\nFix it'
    );
  });
});

describe('agentForRequest', () => {
  it('appends the request to an ACP automation prompt and keeps its other settings', () => {
    const agent: AutomationAgentConfig = {
      type: 'acp',
      start: {
        providerId: 'claude',
        model: 'opus',
        modeId: 'bypassPermissions',
        initialQueue: [{ text: 'Standing instructions', hiddenContext: 'ctx' }],
      },
    };

    const composed = agentForRequest(agent, request);

    expect(composed).toMatchObject({
      type: 'acp',
      title: request.title,
      start: { providerId: 'claude', model: 'opus', modeId: 'bypassPermissions' },
    });
    if (composed.type !== 'acp') throw new Error('expected acp');
    expect(composed.start.initialQueue).toEqual([
      {
        text: `Standing instructions\n\n---\n\n${formatRequestPrompt(request)}`,
        hiddenContext: 'ctx',
      },
    ]);
  });

  it('appends the request to a TUI automation prompt and keeps an explicit title', () => {
    const agent: AutomationAgentConfig = {
      type: 'tui',
      title: 'Feature agent',
      start: { providerId: 'claude', model: null, initialPrompt: 'Standing', autoApprove: true },
    };

    const composed = agentForRequest(agent, request);

    expect(composed.title).toBe('Feature agent');
    if (composed.type !== 'tui') throw new Error('expected tui');
    expect(composed.start).toEqual({
      providerId: 'claude',
      model: null,
      autoApprove: true,
      initialPrompt: `Standing\n\n---\n\n${formatRequestPrompt(request)}`,
    });
  });
});
