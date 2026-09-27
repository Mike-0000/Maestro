import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LOCAL_HOST_REF } from '@emdash/core/primitives/host/api';
import { workspaceRegistryContract } from '@emdash/core/runtimes/workspace-registry/api';
import {
  createWorkspaceRegistryController,
  workspaceRegistryStore,
  WorkspaceRegistryRuntime,
} from '@emdash/core/runtimes/workspace-registry/node';
import { LocalAttachmentStore } from '@emdash/core/services/attachments/node';
import { ok } from '@emdash/shared';
import { createTestWire } from '@emdash/wire/testing';
import { expect, it } from 'vitest';
import { createWorktreeThroughRegistry } from '@core/features/workspaces/api/node/registry-verbs';

it.each(['repository', 'worktree'] as const)(
  'creates and replays a task from a %s project without changing its registration',
  async (kind) => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'project-registry-')));
    const handle = await workspaceRegistryStore.openTemp();
    const runtime = new WorkspaceRegistryRuntime({
      attachments: new LocalAttachmentStore(path.join(root, 'attachments')),
      handle,
    });
    const wire = createTestWire(
      workspaceRegistryContract,
      createWorkspaceRegistryController(runtime)
    );
    const git = (cwd: string, ...args: string[]) =>
      execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
    try {
      const repositoryPath = path.join(root, 'repository');
      await fs.mkdir(repositoryPath);
      git(repositoryPath, 'init', '--initial-branch=main');
      git(
        repositoryPath,
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.com',
        'commit',
        '--allow-empty',
        '-m',
        'initial'
      );
      const projectPath = kind === 'repository' ? repositoryPath : path.join(root, 'project');
      if (kind === 'worktree') {
        git(repositoryPath, 'worktree', 'add', '-b', 'experimental', projectPath);
        git(
          projectPath,
          '-c',
          'user.name=Test',
          '-c',
          'user.email=test@example.com',
          'commit',
          '--allow-empty',
          '-m',
          'experimental change'
        );
      }
      const registered = await wire.client.createWorkspace({
        workspaceId: 'project',
        path: projectPath,
      });
      expect(registered).toMatchObject({ success: true, data: { kind } });
      if (!registered.success) throw new Error('Project registration failed');
      const spec = {
        host: LOCAL_HOST_REF,
        repositoryWorkspaceId: registered.data.id,
        repositoryPath: projectPath,
        workspaceId: 'task',
        branch: 'task-branch',
        baseRef: kind === 'worktree' ? 'experimental' : 'main',
        path: path.join(root, 'task'),
        preservePatterns: [],
      };
      const runtimes = { client: async () => ok({ workspaceRegistry: wire.client } as never) };
      expect(await createWorktreeThroughRegistry(runtimes, spec)).toEqual(ok(undefined));
      expect(git(spec.path, 'branch', '--show-current')).toBe('task-branch');
      expect(git(spec.path, 'rev-parse', 'HEAD')).toBe(git(projectPath, 'rev-parse', 'HEAD'));
      const task = await wire.client.createWorkspace({ workspaceId: 'task', path: spec.path });
      expect(task).toMatchObject({
        success: true,
        data: { parentId: registered.data.parentId ?? registered.data.id },
      });
      expect(await createWorktreeThroughRegistry(runtimes, spec)).toEqual(ok(undefined));
      expect(
        await wire.client.createWorkspace({ workspaceId: 'project', path: projectPath })
      ).toMatchObject({
        success: true,
        data: { id: registered.data.id, kind, path: registered.data.path },
      });
    } finally {
      await wire.dispose();
      runtime.dispose();
      handle.close();
      await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }
);
