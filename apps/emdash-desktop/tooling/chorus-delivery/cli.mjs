#!/usr/bin/env node
import { createCoordinator } from '../../src/core/features/local-updates/node/coordinator/coordinator.mjs';

const [operation, ...args] = process.argv.slice(2);
const coordinator = createCoordinator({
  ...(process.env.CHORUS_DELIVERY_HOME && { stateRoot: process.env.CHORUS_DELIVERY_HOME }),
});

function value(name, fallback = undefined) {
  const index = args.indexOf(`--${name}`);
  return index < 0 ? fallback : args[index + 1];
}

function list(name) {
  const raw = value(name);
  if (!raw) return [];
  return JSON.parse(raw);
}

try {
  let result;
  switch (operation) {
    case 'configure':
      result = await coordinator.configure({
        repositoryPath: value('repo'),
        projectId: value('project'),
        mainRef: value('main-ref'),
        installTarget: value('install-target', null),
      });
      break;
    case 'status':
      result = await coordinator.status(value('repo'));
      break;
    case 'identify':
      result = await coordinator.identify(value('repo'));
      break;
    case 'join':
      result = await coordinator.join({
        repositoryPath: value('repo'),
        projectId: value('project'),
        taskId: value('task'),
        taskName: value('name'),
        worktreePath: value('worktree'),
        mode: value('mode', 'shipping'),
      });
      break;
    case 'work-started':
      result = await coordinator.invalidate({
        repositoryPath: value('repo'),
        taskId: value('task'),
        reason: value('reason'),
      });
      break;
    case 'submit':
      result = await coordinator.submit({
        repositoryPath: value('repo'),
        taskId: value('task'),
        commit: value('commit'),
        base: value('base'),
        summary: value('summary'),
        dependencies: list('dependencies'),
        checks: list('checks'),
      });
      break;
    case 'no-change':
      result = await coordinator.noChange({
        repositoryPath: value('repo'),
        taskId: value('task'),
        commit: value('commit'),
        base: value('base'),
        summary: value('summary'),
      });
      break;
    case 'withdraw':
      result = await coordinator.withdraw({ repositoryPath: value('repo'), taskId: value('task') });
      break;
    case 'prepare':
      result = await coordinator.prepare({
        repositoryPath: value('repo'),
        policy: value('policy', 'snapshot'),
        taskIds: list('tasks').length ? list('tasks') : null,
      });
      break;
    case 'resume':
      result = await coordinator.resumeCandidate({
        repositoryPath: value('repo'),
        candidateId: value('candidate'),
      });
      break;
    case 'validate':
      result = await coordinator.validateCandidate({
        repositoryPath: value('repo'),
        candidateId: value('candidate'),
      });
      break;
    case 'schedule':
      result = await coordinator.schedule({
        repositoryPath: value('repo'),
        candidateId: value('candidate'),
        restartPolicy: value('restart', 'manual'),
      });
      break;
    case 'begin-apply':
      result = await coordinator.beginApply({
        repositoryPath: value('repo'),
        candidateId: value('candidate'),
      });
      break;
    case 'finish-apply':
      result = await coordinator.finishApply({
        repositoryPath: value('repo'),
        candidateId: value('candidate'),
        health: JSON.parse(value('health', '{}')),
      });
      break;
    case 'fail':
      result = await coordinator.failCandidate({
        repositoryPath: value('repo'),
        candidateId: value('candidate'),
        error: value('error'),
      });
      break;
    case 'cancel':
      result = await coordinator.cancel({
        repositoryPath: value('repo'),
        candidateId: value('candidate'),
      });
      break;
    default:
      throw new Error(
        'Usage: chorus-delivery <configure|status|identify|join|work-started|submit|no-change|withdraw|prepare|resume|validate|schedule|begin-apply|finish-apply|fail|cancel> [--name value]'
      );
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
