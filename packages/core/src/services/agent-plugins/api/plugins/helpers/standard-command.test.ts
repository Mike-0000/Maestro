import { describe, expect, it } from 'vitest';
import { buildStandardCommand } from './standard-command';

describe('buildStandardCommand', () => {
  it('splits multi-word resume fallback flags into argv parts', () => {
    const result = buildStandardCommand(
      {
        cli: 'codex',
        autoApprove: false,
        sessionId: 'conversation-1',
        isResuming: true,
        model: '',
      },
      {
        resumeFlag: 'resume',
        sessionIdFlag: ' ',
        sessionIdOnResumeOnly: true,
        resumeWithoutSessionFlag: 'resume --last',
      }
    );

    expect(result.args).toEqual(['resume', '--last']);
  });

  it('splits multi-word resume flags before appending the session id', () => {
    const result = buildStandardCommand(
      {
        cli: 'amp',
        autoApprove: false,
        providerSessionId: 'T-thread-1',
        sessionId: 'conversation-1',
        isResuming: true,
        model: '',
      },
      {
        resumeFlag: 'threads continue',
        sessionIdFlag: 'threads continue',
        sessionIdOnResumeOnly: true,
      }
    );

    expect(result.args).toEqual(['threads', 'continue', 'T-thread-1']);
  });

  it('resumes with the captured provider session id when it differs from the emdash id', () => {
    const result = buildStandardCommand(
      {
        cli: 'claude',
        autoApprove: false,
        sessionId: 'conversation-1',
        providerSessionId: 'native-1',
        isResuming: true,
        model: '',
      },
      { resumeFlag: '--resume', sessionIdFlag: '--session-id' }
    );

    expect(result.args).toEqual(['--resume', 'native-1']);
  });

  it('resumes with the emdash session id when no provider session id was captured', () => {
    const result = buildStandardCommand(
      {
        cli: 'claude',
        autoApprove: false,
        sessionId: 'conversation-1',
        isResuming: true,
        model: '',
      },
      { resumeFlag: '--resume', sessionIdFlag: '--session-id' }
    );

    expect(result.args).toEqual(['--resume', 'conversation-1']);
  });

  it('joins =-suffixed resume flags with the captured provider session id', () => {
    const result = buildStandardCommand(
      {
        cli: 'agy',
        autoApprove: false,
        sessionId: 'conversation-1',
        providerSessionId: 'native-1',
        isResuming: true,
        model: '',
      },
      {
        resumeFlag: '--conversation=',
        sessionIdFlag: '--conversation=',
        sessionIdOnResumeOnly: true,
        resumeWithoutSessionFlag: '-c',
      }
    );

    expect(result.args).toEqual(['--conversation=native-1']);
  });

  it('omits the session id flag on fresh spawns when sessionIdOnResumeOnly is set', () => {
    const result = buildStandardCommand(
      {
        cli: 'agy',
        autoApprove: false,
        sessionId: 'conversation-1',
        isResuming: false,
        model: '',
      },
      {
        resumeFlag: '--conversation=',
        sessionIdFlag: '--conversation=',
        sessionIdOnResumeOnly: true,
        resumeWithoutSessionFlag: '-c',
      }
    );

    expect(result.args).toEqual([]);
  });

  it('falls back to resumeWithoutSessionFlag when no provider session id was captured', () => {
    const result = buildStandardCommand(
      {
        cli: 'agy',
        autoApprove: false,
        sessionId: 'conversation-1',
        isResuming: true,
        model: '',
      },
      {
        resumeFlag: '--conversation=',
        sessionIdFlag: '--conversation=',
        sessionIdOnResumeOnly: true,
        resumeWithoutSessionFlag: '-c',
      }
    );

    expect(result.args).toEqual(['-c']);
  });

  it('injects modelFlag when ctx.model is non-empty', () => {
    const result = buildStandardCommand(
      {
        cli: 'claude',
        autoApprove: false,
        sessionId: 'conv-1',
        isResuming: false,
        model: 'sonnet',
      },
      {
        modelFlag: '--model',
        initialPromptFlag: '',
      }
    );

    expect(result.args).toContain('--model');
    expect(result.args).toContain('sonnet');
    const modelIdx = result.args.indexOf('--model');
    expect(result.args[modelIdx + 1]).toBe('sonnet');
  });

  it('does not inject modelFlag when ctx.model is empty', () => {
    const result = buildStandardCommand(
      {
        cli: 'claude',
        autoApprove: false,
        sessionId: 'conv-1',
        isResuming: false,
        model: '',
      },
      {
        modelFlag: '--model',
        initialPromptFlag: '',
      }
    );

    expect(result.args).not.toContain('--model');
  });

  it('injects short modelFlag (-m) for codex style', () => {
    const result = buildStandardCommand(
      {
        cli: 'codex',
        autoApprove: false,
        sessionId: 'conv-1',
        isResuming: false,
        model: 'gpt-5-codex',
      },
      {
        modelFlag: '-m',
        initialPromptFlag: '',
      }
    );

    const mIdx = result.args.indexOf('-m');
    expect(mIdx).toBeGreaterThanOrEqual(0);
    expect(result.args[mIdx + 1]).toBe('gpt-5-codex');
  });

  describe('effortFlag', () => {
    const ctx = {
      cli: 'claude',
      autoApprove: true,
      sessionId: 'conv-1',
      isResuming: false,
      model: 'opus',
      extraArgs: ['--verbose'],
      initialPrompt: 'fix the bug',
    };
    const spec = {
      autoApproveFlag: '--dangerously-skip-permissions',
      initialPromptFlag: '',
      sessionIdFlag: '--session-id',
      resumeFlag: '--resume',
      modelFlag: '--model',
      effortFlag: '--effort',
    };

    it('appends the effort right after the model, ahead of extra args and the prompt', () => {
      expect(buildStandardCommand({ ...ctx, effort: 'high' }, spec).args).toEqual([
        '--session-id',
        'conv-1',
        '--dangerously-skip-permissions',
        '--model',
        'opus',
        '--effort',
        'high',
        '--verbose',
        'fix the bug',
      ]);
    });

    it('leaves the command identical to a spec without effortFlag when no effort is set', () => {
      const { effortFlag: _unused, ...withoutEffortFlag } = spec;
      const expected = buildStandardCommand(ctx, withoutEffortFlag);
      expect(buildStandardCommand(ctx, spec)).toEqual(expected);
      expect(buildStandardCommand({ ...ctx, effort: '' }, spec)).toEqual(expected);
      expect(expected.args).not.toContain('--effort');
    });

    it('ignores an effort when the provider has no effortFlag', () => {
      const { effortFlag: _unused, ...withoutEffortFlag } = spec;
      expect(buildStandardCommand({ ...ctx, effort: 'max' }, withoutEffortFlag)).toEqual(
        buildStandardCommand(ctx, withoutEffortFlag)
      );
    });

    it('keeps the effort on resume, like the model', () => {
      const result = buildStandardCommand({ ...ctx, isResuming: true, effort: 'low' }, spec);
      expect(result.args).toEqual([
        '--resume',
        'conv-1',
        '--dangerously-skip-permissions',
        '--model',
        'opus',
        '--effort',
        'low',
        '--verbose',
      ]);
    });

    it('supports the --flag=value form', () => {
      const result = buildStandardCommand(
        { ...ctx, effort: 'medium' },
        { ...spec, effortFlag: '--effort=' }
      );
      expect(result.args).toContain('--effort=medium');
    });
  });
});
