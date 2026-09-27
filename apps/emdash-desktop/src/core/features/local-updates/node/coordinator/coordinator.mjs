import { execFile as execFileCallback } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { dirname, isAbsolute, join as joinPath, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';
import { REQUIRED_BUILD_CHECKS, validateIntegratedCandidate } from './build-validation.mjs';
import { applyEvent, createProjectState, isCandidateEligible, requireTask } from './model.mjs';

const execFile = promisify(execFileCallback);
const LIFECYCLE_WITHDRAWALS = new Set(['archived', 'deleted']);

export function createCoordinator({
  stateRoot = defaultStateRoot(),
  git = runGit,
  runValidation = validateIntegratedCandidate,
} = {}) {
  async function repositoryIdentity(worktreePath) {
    const resolvedPath = resolve(worktreePath);
    if (!isAbsolute(resolvedPath)) throw new Error('Repository path must be absolute.');
    const commonDir = await git(resolvedPath, [
      'rev-parse',
      '--path-format=absolute',
      '--git-common-dir',
    ]);
    const realCommonDir = resolve(commonDir.trim());
    const repositoryPath = (await git(resolvedPath, ['rev-parse', '--show-toplevel'])).trim();
    return {
      repositoryPath,
      gitCommonDir: realCommonDir,
      repositoryId: createHash('sha256').update(realCommonDir.toLocaleLowerCase()).digest('hex'),
    };
  }

  async function openStateDb() {
    await mkdir(stateRoot, { recursive: true });
    const database = new DatabaseSync(joinPath(stateRoot, 'coordinators.sqlite'));
    database.exec('PRAGMA synchronous = FULL; PRAGMA busy_timeout = 15000;');
    database.exec(`CREATE TABLE IF NOT EXISTS coordinators (
      repository_id TEXT PRIMARY KEY NOT NULL,
      state_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`);
    database.exec(`CREATE TABLE IF NOT EXISTS delivery_events (
      event_id INTEGER PRIMARY KEY AUTOINCREMENT,
      repository_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      recorded_at TEXT NOT NULL,
      payload_json TEXT NOT NULL
    )`);
    return database;
  }

  function readState(database, repositoryId, repositoryPath, options = {}) {
    const row = database
      .prepare('SELECT state_json FROM coordinators WHERE repository_id = ?')
      .get(repositoryId);
    if (!row) {
      return createProjectState({
        repositoryId,
        repositoryPath,
        ...(options.mainRef && { mainRef: options.mainRef }),
        ...(options.installTarget && { installTarget: options.installTarget }),
      });
    }
    const parsed = JSON.parse(row.state_json);
    if (parsed.schemaVersion !== 1 || parsed.repositoryId !== repositoryId) {
      throw new Error(
        'Delivery coordinator state has an unsupported schema or repository identity.'
      );
    }
    return parsed;
  }

  async function loadState(identity) {
    const database = await openStateDb();
    try {
      return readState(database, identity.repositoryId, identity.repositoryPath);
    } finally {
      database.close();
    }
  }

  async function transaction(repositoryId, repositoryPath, action) {
    const database = await openStateDb();
    try {
      database.exec('BEGIN IMMEDIATE');
      const state = readState(database, repositoryId, repositoryPath);
      const result = await action(state);
      if (result.event) {
        const recorded = { ...result.event, at: new Date().toISOString() };
        database
          .prepare(
            'INSERT INTO delivery_events (repository_id, event_type, recorded_at, payload_json) VALUES (?, ?, ?, ?)'
          )
          .run(repositoryId, recorded.type, recorded.at, JSON.stringify(recorded));
        Object.assign(state, applyEvent(state, recorded));
      }
      database
        .prepare(
          `INSERT INTO coordinators (repository_id, state_json, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(repository_id) DO UPDATE SET state_json = excluded.state_json, updated_at = excluded.updated_at`
        )
        .run(repositoryId, JSON.stringify(state), new Date().toISOString());
      database.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        database.exec('ROLLBACK');
      } catch {
        // The transaction may have failed before BEGIN completed.
      }
      throw error;
    } finally {
      database.close();
    }
  }

  async function record(identity, action) {
    return transaction(identity.repositoryId, identity.repositoryPath, action);
  }

  async function configure({
    repositoryPath,
    projectId,
    mainRef = 'refs/heads/chorus/main',
    installTarget = null,
  }) {
    if (!projectId) throw new Error('A project id is required.');
    const identity = await repositoryIdentity(repositoryPath);
    if (!/^refs\/heads\/[A-Za-z0-9._/-]+$/.test(mainRef) || mainRef.includes('..')) {
      throw new Error('The delivery base must be a local branch ref.');
    }
    await git(identity.repositoryPath, ['check-ref-format', mainRef]);
    await git(identity.repositoryPath, ['rev-parse', '--verify', `${mainRef}^{commit}`]);
    const root = (await git(identity.repositoryPath, ['rev-parse', '--show-toplevel'])).trim();
    const result = await record(identity, async (state) => ({
      event: state.enabled
        ? null
        : { type: 'project-enabled', repositoryPath: root, mainRef, installTarget },
      result: { repositoryId: identity.repositoryId, generation: state.generation, enabled: true },
    }));
    return result;
  }

  async function status(repositoryPath) {
    const identity = await repositoryIdentity(repositoryPath);
    const database = await openStateDb();
    let state;
    try {
      state = readState(database, identity.repositoryId, identity.repositoryPath);
    } finally {
      database.close();
    }
    const candidate = state.activeCandidateId ? state.candidates[state.activeCandidateId] : null;
    return {
      repositoryId: state.repositoryId,
      repositoryPath: state.repositoryPath,
      enabled: state.enabled,
      generation: state.generation,
      tasks: Object.values(state.tasks).map((task) => ({
        projectId: task.projectId,
        taskId: task.taskId,
        taskName: task.taskName,
        mode: task.mode,
        state: task.state,
        withdrawnReason: task.state === 'withdrawn' ? (task.withdrawnReason ?? 'explicit') : null,
        worktreePath: task.worktreePath,
        commit: task.ready?.commit ?? null,
        revision: task.revision,
      })),
      candidate: candidate && {
        id: candidate.id,
        policy: candidate.policy,
        generation: candidate.generation,
        state: candidate.state,
        base: candidate.base,
        commit: candidate.commit ?? null,
        included: candidate.included,
        eligible: isCandidateEligible(state, candidate),
        worktreePath: candidate.worktreePath,
        error: candidate.error ?? null,
        validation: candidate.validation ?? null,
        githubBackup: candidate.githubBackup ?? null,
        health: candidate.health ?? null,
        rollbackHealth: candidate.rollbackHealth ?? null,
      },
      applyingCandidateId: state.applyingCandidateId,
      installedCandidateId: state.installedCandidateId,
      githubBackups: Object.values(state.candidates)
        .filter((entry) => entry.githubBackup?.state === 'pending')
        .map((entry) => ({
          candidateId: entry.id,
          commit: entry.commit,
          state: entry.githubBackup.state,
          remote: entry.githubBackup.remote,
          branch: entry.githubBackup.branch,
          error: entry.githubBackup.error ?? null,
        })),
      lastError: state.lastError,
    };
  }

  async function identify(worktreePath) {
    const identity = await repositoryIdentity(worktreePath);
    const state = await loadState(identity);
    const path = resolve(worktreePath).toLocaleLowerCase();
    const task = Object.values(state.tasks).find(
      (entry) => resolve(entry.worktreePath).toLocaleLowerCase() === path
    );
    if (!task) throw new Error('This worktree is not enrolled in the Chorus delivery coordinator.');
    return {
      repositoryId: identity.repositoryId,
      repositoryPath: identity.repositoryPath,
      projectId: task.projectId,
      taskId: task.taskId,
      taskName: task.taskName,
      mode: task.mode,
      state: task.state,
      base: task.baseCommit,
      revision: task.revision,
      commit: task.ready?.commit ?? null,
    };
  }

  async function join({
    repositoryPath,
    projectId,
    taskId,
    taskName,
    worktreePath,
    mode = 'shipping',
  }) {
    validateId(projectId, 'project id');
    validateId(taskId, 'task id');
    if (!['shipping', 'research'].includes(mode))
      throw new Error('Task mode must be shipping or research.');
    const identity = await repositoryIdentity(repositoryPath);
    const taskIdentity = await repositoryIdentity(worktreePath);
    if (taskIdentity.repositoryId !== identity.repositoryId) {
      throw new Error('Task worktree belongs to a different Git repository.');
    }
    const path = resolve(worktreePath);
    const state = await loadState(identity);
    const head = (await git(path, ['rev-parse', 'HEAD'])).trim();
    const baseCommit = (await git(path, ['merge-base', state.mainRef, head])).trim();
    assertSha(baseCommit, 'task base');
    return record(identity, async (state) => {
      if (!state.enabled)
        throw new Error('Enable the Chorus project coordinator before enrolling tasks.');
      if (state.applyingCandidateId) {
        // A task created after apply begins belongs to the next project generation.
      }
      const existing = state.tasks[taskId];
      if (existing?.state === 'withdrawn' && LIFECYCLE_WITHDRAWALS.has(existing.withdrawnReason)) {
        // A restored task resumes where it left off; an explicit withdrawal stays withdrawn.
        return {
          event: { type: 'task-rejoined', taskId },
          result: { joined: true, rejoined: true, generation: state.generation + 1 },
        };
      }
      if (existing) return { event: null, result: { joined: false, generation: state.generation } };
      return {
        event: {
          type: 'task-joined',
          projectId,
          taskId,
          taskName,
          worktreePath: path,
          baseCommit,
          mode,
        },
        result: { joined: true, generation: state.generation + 1 },
      };
    });
  }

  async function invalidate({ repositoryPath, taskId, reason = 'new coding work' }) {
    const identity = await repositoryIdentity(repositoryPath);
    return record(identity, async (state) => {
      const task = requireTask(state, taskId);
      if (state.applyingCandidateId) {
        throw new Error(
          'A local Chorus update is applying; new agent work is temporarily blocked.'
        );
      }
      if (task.mode === 'research' || task.state === 'withdrawn') {
        return { event: null, result: { invalidated: false, generation: state.generation } };
      }
      if (task.state === 'working' && task.ready === null) {
        return { event: null, result: { invalidated: false, generation: state.generation } };
      }
      return {
        event: { type: 'task-work-started', taskId, reason },
        result: { invalidated: true, generation: state.generation + 1 },
      };
    });
  }

  async function submit({
    repositoryPath,
    taskId,
    commit,
    base,
    summary,
    dependencies = [],
    checks = [],
  }) {
    assertSha(commit, 'commit');
    assertSha(base, 'base');
    const identity = await repositoryIdentity(repositoryPath);
    const database = await openStateDb();
    let state;
    try {
      state = readState(database, identity.repositoryId, identity.repositoryPath);
    } finally {
      database.close();
    }
    const task = requireTask(state, taskId);
    if (task.mode !== 'shipping')
      throw new Error('Research tasks must be enrolled as shipping before submission.');
    if (base !== task.baseCommit)
      throw new Error('Submission base must match the task worktree base recorded at enrollment.');
    const head = (await git(task.worktreePath, ['rev-parse', 'HEAD'])).trim();
    if (head !== commit) throw new Error('Submission SHA must equal the task worktree HEAD.');
    const dirt = await git(task.worktreePath, [
      'status',
      '--porcelain',
      '--untracked-files=normal',
    ]);
    if (dirt.trim())
      throw new Error('Submit only after the task worktree is clean, including untracked files.');
    await git(identity.repositoryPath, ['cat-file', '-e', `${commit}^{commit}`]);
    await git(identity.repositoryPath, ['merge-base', '--is-ancestor', base, commit]);
    if (!Array.isArray(dependencies) || dependencies.length > 50)
      throw new Error('Submission dependencies must be a list of at most 50 task SHAs.');
    const dependencyKeys = new Set();
    const normalizedDependencies = dependencies.map((dependency) => {
      validateId(dependency?.taskId, 'dependency task id');
      assertSha(dependency.commit, 'dependency commit');
      const key = `${dependency.taskId}@${dependency.commit}`;
      if (dependencyKeys.has(key)) throw new Error(`Duplicate submission dependency ${key}.`);
      dependencyKeys.add(key);
      if (
        !state.tasks[dependency.taskId]?.history.some((entry) => entry.commit === dependency.commit)
      ) {
        throw new Error(
          `Dependency ${dependency.taskId}@${dependency.commit} is not a submitted task revision.`
        );
      }
      return { taskId: dependency.taskId, commit: dependency.commit };
    });
    if (!Array.isArray(checks) || checks.length > 50)
      throw new Error('Submission checks must be a list of at most 50 items.');
    const claimedChecks = checks.map((check) => cleanText(check, 300));
    const changedPaths = (
      await git(identity.repositoryPath, ['diff', '--name-only', '-z', base, commit, '--'])
    )
      .split('\0')
      .filter(Boolean);
    const pin = `refs/chorus/delivery/${identity.repositoryId.slice(0, 16)}/${safeRef(taskId)}/${commit}`;
    await git(identity.repositoryPath, ['update-ref', pin, commit]);
    return record(identity, async (current) => {
      const latest = requireTask(current, taskId);
      if (latest.revision !== task.revision)
        throw new Error(
          'Task was reopened while preparing this submission; review and submit its new revision.'
        );
      const alreadySubmitted = latest.ready?.commit === commit && latest.state === 'submitted';
      if (alreadySubmitted)
        return { event: null, result: { submitted: false, generation: current.generation } };
      const event = {
        type: 'task-submitted',
        taskId,
        commit,
        base,
        summary: cleanText(summary, 4000),
        changedPaths,
        dependencies: normalizedDependencies,
        checks: claimedChecks,
        pin,
      };
      return {
        event,
        result: { submitted: true, generation: current.generation + 1, commit, changedPaths },
      };
    });
  }

  async function noChange({
    repositoryPath,
    taskId,
    commit,
    base,
    summary = 'No source changes.',
  }) {
    assertSha(commit, 'commit');
    assertSha(base, 'base');
    const identity = await repositoryIdentity(repositoryPath);
    const state = await loadState(identity);
    const task = requireTask(state, taskId);
    const head = (await git(task.worktreePath, ['rev-parse', 'HEAD'])).trim();
    if (head !== commit || commit !== base || base !== task.baseCommit)
      throw new Error(
        'No-change handoff requires an unchanged task HEAD equal to its recorded base.'
      );
    const dirt = await git(task.worktreePath, [
      'status',
      '--porcelain',
      '--untracked-files=normal',
    ]);
    if (dirt.trim()) throw new Error('No-change handoff requires a clean task worktree.');
    return record(identity, async (current) => ({
      event: {
        type: 'task-no-change',
        taskId,
        commit,
        base,
        summary: cleanText(summary, 4000),
        checks: [],
      },
      result: { submitted: true, noChange: true, generation: current.generation + 1 },
    }));
  }

  async function withdraw({ repositoryPath, taskId }) {
    const identity = await repositoryIdentity(repositoryPath);
    return record(identity, async (state) => {
      const task = requireTask(state, taskId);
      if (task.state === 'withdrawn' && task.withdrawnReason === 'explicit') {
        return { event: null, result: { withdrawn: false, generation: state.generation } };
      }
      return {
        event: { type: 'task-withdrawn', taskId, reason: 'explicit' },
        result: { withdrawn: true, generation: state.generation + 1 },
      };
    });
  }

  /**
   * Withdraws unfinished work when its Chorus task is archived or deleted. A task that already
   * handed off (submitted, no-change, integrated) keeps its handoff: archiving finished work is
   * the normal way to put it away and must not drop it from the next update.
   */
  async function retire({ repositoryPath, taskId, reason }) {
    if (!LIFECYCLE_WITHDRAWALS.has(reason))
      throw new Error('Task retirement reason must be archived or deleted.');
    const identity = await repositoryIdentity(repositoryPath);
    const { result } = await record(identity, async (state) => {
      const task = state.tasks[taskId];
      if (!task || task.state !== 'working') {
        return { event: null, result: { withdrawn: false, generation: state.generation } };
      }
      return {
        event: { type: 'task-withdrawn', taskId, reason },
        result: { withdrawn: true, generation: state.generation + 1 },
      };
    });
    return result;
  }

  async function prepare({ repositoryPath, policy = 'snapshot', taskIds = null }) {
    if (!['snapshot', 'follow-project'].includes(policy))
      throw new Error('Policy must be snapshot or follow-project.');
    const identity = await repositoryIdentity(repositoryPath);
    const database = await openStateDb();
    let snapshot;
    try {
      snapshot = readState(database, identity.repositoryId, identity.repositoryPath);
    } finally {
      database.close();
    }
    const includedIds =
      taskIds ??
      Object.values(snapshot.tasks)
        .filter((task) => task.mode === 'shipping' && task.state === 'submitted')
        .map((task) => task.taskId);
    if (policy === 'follow-project') {
      const waiting = Object.values(snapshot.tasks).filter(
        (task) =>
          task.mode === 'shipping' &&
          !['submitted', 'no-change', 'withdrawn', 'integrated'].includes(task.state)
      );
      if (waiting.length)
        throw new Error(
          `Following the project is waiting for: ${waiting.map((task) => task.taskName).join(', ')}.`
        );
    }
    if (includedIds.length === 0)
      throw new Error('There are no submitted Chorus changes to integrate.');
    if (policy === 'follow-project' && taskIds) {
      const allSubmitted = Object.values(snapshot.tasks)
        .filter((task) => task.mode === 'shipping' && task.state === 'submitted')
        .map((task) => task.taskId)
        .sort((left, right) => left.localeCompare(right));
      if (
        JSON.stringify([...new Set(taskIds)].sort((left, right) => left.localeCompare(right))) !==
        JSON.stringify(allSubmitted)
      ) {
        throw new Error(
          'A follow-project candidate must include every current ready shipping task.'
        );
      }
    }
    const included = await Promise.all(
      includedIds.map(async (taskId) => {
        const task = requireTask(snapshot, taskId);
        if (task.state !== 'submitted' || !task.ready)
          throw new Error(`Task ${task.taskName} has no current ready submission.`);
        if (!task.ready.pin) throw new Error(`Task ${task.taskName} has no retained handoff ref.`);
        const pinned = (await git(identity.repositoryPath, ['rev-parse', task.ready.pin])).trim();
        if (pinned !== task.ready.commit)
          throw new Error(`Pinned handoff ref for ${task.taskName} is missing or moved.`);
        return {
          taskId,
          taskName: task.taskName,
          commit: task.ready.commit,
          dependencies: task.ready.dependencies,
        };
      })
    );
    const base = (await git(identity.repositoryPath, ['rev-parse', snapshot.mainRef])).trim();
    assertSha(base, 'integration base');
    for (const task of included) {
      for (const dependency of task.dependencies ?? []) {
        if (
          !included.some(
            (item) => item.taskId === dependency.taskId && item.commit === dependency.commit
          )
        ) {
          await git(identity.repositoryPath, [
            'merge-base',
            '--is-ancestor',
            dependency.commit,
            base,
          ]);
        }
      }
    }
    const includedKeys = new Set(included.map((task) => `${task.taskId}@${task.commit}`));
    const ordered = topological(
      included.map((task) => ({
        ...task,
        dependencies: (task.dependencies ?? []).filter((dependency) =>
          includedKeys.has(`${dependency.taskId}@${dependency.commit}`)
        ),
      }))
    );
    const id = randomUUID();
    const worktreePath = candidateWorktreePath(stateRoot, identity.repositoryId, id);
    const candidate = {
      id,
      policy,
      repositoryId: identity.repositoryId,
      generation: snapshot.generation,
      base,
      included: ordered.map(({ taskId, taskName, commit }) => ({ taskId, taskName, commit })),
      worktreePath,
      state: 'preparing',
      commit: null,
      validation: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const created = await record(identity, async (current) => {
      if (current.generation !== snapshot.generation)
        throw new Error('Project membership changed while freezing the candidate; retry prepare.');
      if (current.applyingCandidateId)
        throw new Error('Another delivery candidate is already applying.');
      if (hasBusyCandidate(current))
        throw new Error('The repository integration/build worker is busy with another candidate.');
      return { event: { type: 'candidate-prepared', candidate }, result: candidate };
    });

    try {
      await mkdir(dirname(worktreePath), { recursive: true });
      await git(identity.repositoryPath, ['worktree', 'add', '--detach', worktreePath, base]);
      for (const item of ordered) {
        await git(worktreePath, ['merge', '--no-edit', '--no-ff', item.commit]);
      }
      const commit = (await git(worktreePath, ['rev-parse', 'HEAD'])).trim();
      const clean = (
        await git(worktreePath, ['status', '--porcelain', '--untracked-files=normal'])
      ).trim();
      if (clean)
        throw new Error(
          'Integrated candidate worktree is not clean after merging submitted commits.'
        );
      const currentMain = (
        await git(identity.repositoryPath, ['rev-parse', snapshot.mainRef])
      ).trim();
      if (currentMain !== base)
        throw new Error(
          'The canonical Chorus branch moved while preparing; discard this candidate and prepare from the new base.'
        );
      await record(identity, async (current) => ({
        event: { type: 'candidate-integrated', candidateId: id, commit },
        result: current.candidates[id],
      }));
      return { ...created.result, state: 'integrated', commit, worktreePath };
    } catch (error) {
      const conflictPaths = (
        await git(worktreePath, ['diff', '--name-only', '--diff-filter=U', '-z']).catch(() => '')
      )
        .split('\0')
        .filter(Boolean);
      const message = conflictPaths.length
        ? `Integration conflict in ${conflictPaths.join(', ')}. Resolve and commit the merge in the preserved coordinator worktree.`
        : error instanceof Error
          ? error.message
          : String(error);
      await record(identity, async (current) => ({
        event: { type: 'candidate-blocked', candidateId: id, error: message },
        result: current.candidates[id],
      }));
      return { ...created.result, state: 'blocked', error: message, worktreePath };
    }
  }

  async function validateCandidate({ repositoryPath, candidateId }) {
    const identity = await repositoryIdentity(repositoryPath);
    const database = await openStateDb();
    let snapshot;
    try {
      snapshot = readState(database, identity.repositoryId, identity.repositoryPath);
    } finally {
      database.close();
    }
    const candidate = snapshot.candidates[candidateId];
    if (!candidate || candidate.state !== 'integrated' || !candidate.commit) {
      throw new Error('Only an integrated candidate can be validated.');
    }
    await record(identity, async (state) => {
      const current = state.candidates[candidateId];
      if (!current || current.state !== 'integrated')
        throw new Error('Candidate validation is already running or no longer available.');
      if (hasBusyCandidate(state, candidateId))
        throw new Error('The repository integration/build worker is busy with another candidate.');
      return { event: { type: 'candidate-validation-started', candidateId }, result: null };
    });
    try {
      const validation = await runValidation({
        repositoryPath: identity.repositoryPath,
        candidate: structuredClone(candidate),
        stateRoot,
        git,
      });
      const validated =
        validation?.integratedCommit === candidate.commit &&
        REQUIRED_BUILD_CHECKS.every((check) => validation.checks?.includes(check)) &&
        /^[a-f0-9]{64}$/.test(validation.artifactDigest ?? '') &&
        typeof validation.manifestPath === 'string';
      const result = await record(identity, async (state) => ({
        event:
          state.candidates[candidateId]?.state === 'validating'
            ? {
                type: 'candidate-validation',
                candidateId,
                success: validated,
                validation: validated
                  ? validation
                  : {
                      error: 'The build receipt did not certify the integrated commit and package.',
                    },
              }
            : null,
        result:
          state.candidates[candidateId]?.state === 'validating'
            ? { validated, state: validated ? 'validated' : 'blocked' }
            : { validated: false, state: state.candidates[candidateId]?.state ?? 'missing' },
      }));
      return result.result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const result = await record(identity, async (state) => ({
        event:
          state.candidates[candidateId]?.state === 'validating'
            ? {
                type: 'candidate-validation',
                candidateId,
                success: false,
                validation: { error: message },
              }
            : null,
        result:
          state.candidates[candidateId]?.state === 'validating'
            ? { validated: false, state: 'blocked', error: message }
            : { validated: false, state: state.candidates[candidateId]?.state ?? 'missing' },
      }));
      return result.result;
    }
  }

  async function resumeCandidate({ repositoryPath, candidateId }) {
    const identity = await repositoryIdentity(repositoryPath);
    const initial = await loadState(identity);
    const candidate = initial.candidates[candidateId];
    if (
      !candidate ||
      candidate.state !== 'blocked' ||
      !candidate.error?.startsWith('Integration conflict in ')
    ) {
      throw new Error(
        'Only a candidate blocked by a merge conflict can resume after conflict resolution.'
      );
    }
    if (!isCandidateEligible(initial, candidate)) {
      throw new Error('The project changed while resolving conflicts; prepare a fresh candidate.');
    }
    const currentMain = (await git(identity.repositoryPath, ['rev-parse', initial.mainRef])).trim();
    if (currentMain !== candidate.base)
      throw new Error('Canonical Chorus main moved; prepare a fresh candidate.');
    const unresolved = (
      await git(candidate.worktreePath, ['diff', '--name-only', '--diff-filter=U', '-z'])
    )
      .split('\0')
      .filter(Boolean);
    if (unresolved.length)
      throw new Error(`Resolve remaining conflicts first: ${unresolved.join(', ')}.`);
    const dirt = (
      await git(candidate.worktreePath, ['status', '--porcelain', '--untracked-files=normal'])
    ).trim();
    if (dirt)
      throw new Error(
        'Commit the conflict resolution and leave the coordinator worktree clean before resuming.'
      );
    const resolvedHead = (await git(candidate.worktreePath, ['rev-parse', 'HEAD'])).trim();
    await git(candidate.worktreePath, [
      'merge-base',
      '--is-ancestor',
      candidate.base,
      resolvedHead,
    ]);
    await record(identity, async (state) => {
      const latest = state.candidates[candidateId];
      if (!latest || latest.state !== 'blocked')
        throw new Error('Candidate state changed while starting conflict resolution.');
      if (!isCandidateEligible(state, latest))
        throw new Error('Project membership changed; prepare a fresh candidate.');
      if (hasBusyCandidate(state, candidateId))
        throw new Error('The repository integration/build worker is busy with another candidate.');
      return { event: { type: 'candidate-resuming', candidateId }, result: null };
    });
    try {
      for (const item of candidate.included) {
        const contains = await git(candidate.worktreePath, [
          'merge-base',
          '--is-ancestor',
          item.commit,
          resolvedHead,
        ]).then(
          () => true,
          () => false
        );
        if (!contains)
          await git(candidate.worktreePath, ['merge', '--no-edit', '--no-ff', item.commit]);
      }
      const commit = (await git(candidate.worktreePath, ['rev-parse', 'HEAD'])).trim();
      const finalDirt = (
        await git(candidate.worktreePath, ['status', '--porcelain', '--untracked-files=normal'])
      ).trim();
      if (finalDirt)
        throw new Error('Resumed candidate is not clean after merging its selected commits.');
      const latestMain = (
        await git(identity.repositoryPath, ['rev-parse', initial.mainRef])
      ).trim();
      if (latestMain !== candidate.base)
        throw new Error('Canonical Chorus main moved during conflict resolution.');
      return await record(identity, async (state) => {
        const latest = state.candidates[candidateId];
        if (!latest || latest.state !== 'resuming')
          throw new Error('Candidate state changed while resuming integration.');
        if (!isCandidateEligible(state, latest))
          throw new Error('Project membership changed; prepare a fresh candidate.');
        return {
          event: { type: 'candidate-integrated', candidateId, commit },
          result: {
            state: 'integrated',
            candidateId,
            commit,
            worktreePath: candidate.worktreePath,
          },
        };
      });
    } catch (error) {
      const conflictPaths = (
        await git(candidate.worktreePath, ['diff', '--name-only', '--diff-filter=U', '-z']).catch(
          () => ''
        )
      )
        .split('\0')
        .filter(Boolean);
      const message = conflictPaths.length
        ? `Integration conflict in ${conflictPaths.join(', ')}. Resolve and commit the merge in the preserved coordinator worktree.`
        : error instanceof Error
          ? error.message
          : String(error);
      await record(identity, async (state) => ({
        event:
          state.candidates[candidateId]?.state === 'resuming'
            ? { type: 'candidate-blocked', candidateId, error: message }
            : null,
        result: { state: 'blocked', candidateId, error: message },
      }));
      return {
        state: 'blocked',
        candidateId,
        error: message,
        worktreePath: candidate.worktreePath,
      };
    }
  }

  async function schedule({ repositoryPath, candidateId, restartPolicy }) {
    if (restartPolicy !== 'manual')
      throw new Error('Chorus updates require an explicit manual quit and install.');
    const identity = await repositoryIdentity(repositoryPath);
    const before = await loadState(identity);
    const currentMain = (await git(identity.repositoryPath, ['rev-parse', before.mainRef])).trim();
    return record(identity, async (state) => {
      const candidate = state.candidates[candidateId];
      if (!candidate) throw new Error(`Unknown delivery candidate ${candidateId}.`);
      if (candidate.state === 'scheduled') {
        return {
          event: null,
          result: { scheduled: true, candidateId, alreadyScheduled: true },
        };
      }
      const expectedMain = candidate.state === 'promoted' ? candidate.commit : candidate.base;
      if (currentMain !== expectedMain)
        throw new Error(
          'The canonical Chorus branch moved after candidate preparation; prepare and validate a new candidate.'
        );
      if (!isCandidateEligible(state, candidate))
        throw new Error(
          'The project changed after this candidate was prepared; prepare a new combined update.'
        );
      if (candidate.state !== 'promoted')
        throw new Error('Only a promoted, validated candidate can be scheduled.');
      return {
        event: { type: 'candidate-scheduled', candidateId, restartPolicy },
        result: { scheduled: true, candidateId },
      };
    });
  }

  async function beginApply({ repositoryPath, candidateId }) {
    const identity = await repositoryIdentity(repositoryPath);
    const before = await loadState(identity);
    const currentMain = (await git(identity.repositoryPath, ['rev-parse', before.mainRef])).trim();
    return record(identity, async (state) => {
      const candidate = state.candidates[candidateId];
      if (!candidate) throw new Error(`Unknown delivery candidate ${candidateId}.`);
      if (candidate.state !== 'scheduled' || !candidate.validation) {
        throw new Error('Only a scheduled, validated candidate can begin installation.');
      }
      if (state.applyingCandidateId) throw new Error('Another Chorus update is already applying.');
      if (candidate.state !== 'scheduled' || currentMain !== candidate.commit) {
        throw new Error('The promoted Chorus branch moved before apply.');
      }
      if (!isCandidateEligible(state, candidate)) {
        throw new Error('Project membership changed before apply; prepare a fresh candidate.');
      }
      return {
        event: { type: 'candidate-applying', candidateId },
        result: { applying: true, candidateId },
      };
    });
  }

  async function promote({ repositoryPath, candidateId }) {
    const identity = await repositoryIdentity(repositoryPath);
    return record(identity, async (state) => {
      const candidate = state.candidates[candidateId];
      if (candidate?.state === 'promoted' && candidate.commit) {
        const currentMain = (
          await git(identity.repositoryPath, ['rev-parse', '--verify', `${state.mainRef}^{commit}`])
        ).trim();
        if (currentMain === candidate.commit) {
          return {
            event: null,
            result: { promoted: true, candidateId, commit: candidate.commit, recovered: true },
          };
        }
      }
      if (!candidate || candidate.state !== 'validated' || !candidate.commit) {
        throw new Error('Only the validated integrated candidate can be promoted.');
      }
      if (!isCandidateEligible(state, candidate))
        throw new Error('Project membership changed; prepare a fresh candidate.');
      const currentMain = (
        await git(identity.repositoryPath, ['rev-parse', '--verify', `${state.mainRef}^{commit}`])
      ).trim();
      if (currentMain !== candidate.base) {
        if (currentMain === candidate.commit) {
          return {
            event: { type: 'candidate-promoted', candidateId },
            result: { promoted: true, candidateId, commit: candidate.commit, recovered: true },
          };
        }
        throw new Error(
          'The canonical Chorus branch moved after candidate preparation; prepare and validate a new candidate.'
        );
      }
      await git(identity.repositoryPath, [
        'merge-base',
        '--is-ancestor',
        candidate.base,
        candidate.commit,
      ]);
      const worktrees = await git(identity.repositoryPath, ['worktree', 'list', '--porcelain']);
      const mainWorktree = worktrees
        .split(/\r?\n\r?\n/)
        .find((block) => block.split(/\r?\n/).includes(`branch ${state.mainRef}`));
      if (mainWorktree) {
        const pathLine = mainWorktree.split(/\r?\n/).find((line) => line.startsWith('worktree '));
        const mainWorktreePath = pathLine?.slice('worktree '.length);
        if (!mainWorktreePath)
          throw new Error('Could not locate the canonical Chorus checkout for promotion.');
        const dirt = await git(mainWorktreePath, [
          'status',
          '--porcelain',
          '--untracked-files=all',
        ]);
        if (dirt.trim())
          throw new Error(
            'The canonical Chorus checkout has local changes; preserve or resolve them before promotion.'
          );
        await git(mainWorktreePath, ['merge', '--ff-only', candidate.commit]);
      } else {
        await git(identity.repositoryPath, [
          'update-ref',
          state.mainRef,
          candidate.commit,
          currentMain,
        ]);
      }
      const promoted = (
        await git(identity.repositoryPath, ['rev-parse', '--verify', `${state.mainRef}^{commit}`])
      ).trim();
      if (promoted !== candidate.commit)
        throw new Error('Canonical Chorus promotion did not reach the candidate SHA.');
      return {
        event: { type: 'candidate-promoted', candidateId },
        result: { promoted: true, candidateId, commit: candidate.commit },
      };
    });
  }

  async function pushBackup({ repositoryPath, candidateId }) {
    const identity = await repositoryIdentity(repositoryPath);
    const state = await loadState(identity);
    const candidate = state.candidates[candidateId];
    if (
      !candidate ||
      !['promoted', 'scheduled', 'applying', 'installed'].includes(candidate.state) ||
      !candidate.commit
    ) {
      throw new Error('Promote and validate this candidate before pushing its GitHub backup.');
    }
    const remote = (await git(identity.repositoryPath, ['remote', 'get-url', 'origin'])).trim();
    if (!isGitHubRemote(remote))
      throw new Error('The origin remote is not a GitHub repository; no push was attempted.');
    try {
      await git(identity.repositoryPath, [
        'push',
        '--porcelain',
        'origin',
        `${candidate.commit}:refs/heads/main`,
      ]);
      const recorded = await record(identity, async () => ({
        event: {
          type: 'candidate-github-backup',
          candidateId,
          success: true,
          remote: 'origin',
          branch: 'main',
        },
        result: {
          backedUp: true,
          candidateId,
          commit: candidate.commit,
          remote: 'origin',
          branch: 'main',
        },
      }));
      return recorded.result;
    } catch {
      const recorded = await record(identity, async () => ({
        event: {
          type: 'candidate-github-backup',
          candidateId,
          success: false,
          remote: 'origin',
          branch: 'main',
          error:
            'GitHub backup push failed; origin/main was not updated. Check authentication and remote history.',
        },
        result: {
          backedUp: false,
          candidateId,
          commit: candidate.commit,
          remote: 'origin',
          branch: 'main',
          error:
            'GitHub backup push failed; origin/main was not updated. Check authentication and remote history.',
        },
      }));
      return recorded.result;
    }
  }

  async function finishApply({ repositoryPath, candidateId, health }) {
    const identity = await repositoryIdentity(repositoryPath);
    return record(identity, async (state) => {
      const candidate = state.candidates[candidateId];
      if (
        !candidate ||
        candidate.state !== 'applying' ||
        state.applyingCandidateId !== candidateId
      ) {
        throw new Error('The candidate is not the active installation.');
      }
      if (
        health?.commit !== candidate.commit ||
        health?.artifactDigest !== candidate.validation?.artifactDigest ||
        health?.buildId !== candidate.validation?.buildId ||
        typeof health?.readyAt !== 'string'
      ) {
        throw new Error('Startup health does not match the validated candidate package.');
      }
      return {
        event: { type: 'candidate-installed', candidateId, health },
        result: { installed: true, candidateId },
      };
    });
  }

  async function failCandidate({ repositoryPath, candidateId, error }) {
    const identity = await repositoryIdentity(repositoryPath);
    return record(identity, async () => ({
      event: { type: 'candidate-failed', candidateId, error: cleanText(error, 4000) },
      result: { failed: true, candidateId },
    }));
  }

  async function markCandidateNeedsRecovery({ repositoryPath, candidateId, error }) {
    const identity = await repositoryIdentity(repositoryPath);
    return record(identity, async () => ({
      event: {
        type: 'candidate-install-recovery-needed',
        candidateId,
        error: cleanText(error, 4000),
      },
      result: { recoveryRequired: true, candidateId },
    }));
  }

  async function cancelApply({ repositoryPath, candidateId }) {
    const identity = await repositoryIdentity(repositoryPath);
    return record(identity, async (state) => {
      const candidate = state.candidates[candidateId];
      if (
        !candidate ||
        candidate.state !== 'applying' ||
        state.applyingCandidateId !== candidateId
      ) {
        throw new Error('The candidate is not the active installation.');
      }
      return {
        event: { type: 'candidate-cancelled-before-apply', candidateId },
        result: { cancelled: true, candidateId, beforeReplacement: true },
      };
    });
  }

  async function beginRollback({ repositoryPath, candidateId }) {
    const identity = await repositoryIdentity(repositoryPath);
    return record(identity, async (state) => {
      const candidate = state.candidates[candidateId];
      const previousBuild = candidate?.health?.previousBuild;
      if (
        !candidate ||
        candidate.state !== 'installed' ||
        state.installedCandidateId !== candidateId ||
        state.applyingCandidateId
      ) {
        throw new Error('Only the currently installed candidate can be rolled back.');
      }
      if (
        !candidate.health?.backupRoot ||
        !previousBuild ||
        previousBuild.deliveryProtocol !== 1 ||
        !/^[a-f0-9]{40}$/.test(previousBuild.commit ?? '') ||
        !/^[a-f0-9-]{36}$/.test(previousBuild.buildId ?? '')
      ) {
        throw new Error(
          'The retained installation does not have a compatible startup-health receipt; rollback is unavailable.'
        );
      }
      return {
        event: { type: 'candidate-rollback-started', candidateId },
        result: { rollbackStarted: true, candidateId, previousBuild },
      };
    });
  }

  async function finishRollback({ repositoryPath, candidateId, health }) {
    const identity = await repositoryIdentity(repositoryPath);
    return record(identity, async (state) => {
      const candidate = state.candidates[candidateId];
      const previousBuild = candidate?.health?.previousBuild;
      if (
        !candidate ||
        candidate.state !== 'rolling-back' ||
        state.applyingCandidateId !== candidateId ||
        health?.commit !== previousBuild?.commit ||
        health?.buildId !== previousBuild?.buildId ||
        typeof health?.readyAt !== 'string'
      ) {
        throw new Error('Rollback startup health did not match the retained previous build.');
      }
      return {
        event: { type: 'candidate-rolled-back', candidateId, health },
        result: { rolledBack: true, candidateId, health },
      };
    });
  }

  async function failRollback({ repositoryPath, candidateId, error }) {
    const identity = await repositoryIdentity(repositoryPath);
    return record(identity, async () => ({
      event: {
        type: 'candidate-rollback-failed',
        candidateId,
        error: cleanText(error, 4000),
      },
      result: { rollbackFailed: true, candidateId },
    }));
  }

  async function markRollbackNeedsRecovery({ repositoryPath, candidateId, error }) {
    const identity = await repositoryIdentity(repositoryPath);
    return record(identity, async () => ({
      event: {
        type: 'candidate-rollback-recovery-needed',
        candidateId,
        error: cleanText(error, 4000),
      },
      result: { recoveryRequired: true, candidateId },
    }));
  }

  async function cancel({ repositoryPath, candidateId }) {
    const identity = await repositoryIdentity(repositoryPath);
    return record(identity, async (state) => {
      const candidate = state.candidates[candidateId];
      if (!candidate) throw new Error(`Unknown delivery candidate ${candidateId}.`);
      if (['applying', 'installed'].includes(candidate.state)) {
        throw new Error('An applying or installed candidate needs its dedicated recovery action.');
      }
      return {
        event: { type: 'candidate-cancelled', candidateId },
        result: { cancelled: true, candidateId },
      };
    });
  }

  return {
    configure,
    status,
    identify,
    join,
    invalidate,
    submit,
    noChange,
    withdraw,
    retire,
    prepare,
    resumeCandidate,
    validateCandidate,
    promote,
    pushBackup,
    schedule,
    beginApply,
    finishApply,
    failCandidate,
    markCandidateNeedsRecovery,
    cancelApply,
    beginRollback,
    finishRollback,
    failRollback,
    markRollbackNeedsRecovery,
    cancel,
    repositoryIdentity,
  };
}

export function defaultStateRoot() {
  const local = process.env.LOCALAPPDATA;
  if (process.platform === 'win32' && local) return joinPath(local, 'Chorus', 'Delivery', 'v1');
  return joinPath(
    process.env.XDG_STATE_HOME ?? joinPath(process.env.HOME ?? process.cwd(), '.local', 'state'),
    'chorus-delivery',
    'v1'
  );
}

function hasBusyCandidate(state, exceptCandidateId = null) {
  return Object.entries(state.candidates).some(
    ([candidateId, candidate]) =>
      candidateId !== exceptCandidateId &&
      ['preparing', 'resuming', 'validating'].includes(candidate.state)
  );
}

export function topological(tasks) {
  const byKey = new Map(tasks.map((task) => [`${task.taskId}@${task.commit}`, task]));
  const ordered = [];
  const state = new Map();
  function visit(task) {
    const key = `${task.taskId}@${task.commit}`;
    if (state.get(key) === 'done') return;
    if (state.get(key) === 'visiting') throw new Error('Task dependencies contain a cycle.');
    state.set(key, 'visiting');
    for (const dependency of task.dependencies ?? []) {
      const prerequisite = byKey.get(`${dependency.taskId}@${dependency.commit}`);
      if (prerequisite) visit(prerequisite);
    }
    state.set(key, 'done');
    ordered.push(task);
  }
  for (const task of tasks) visit(task);
  return ordered;
}

export function assertSha(value, label) {
  if (!/^[a-f0-9]{40}$/.test(value ?? ''))
    throw new Error(`${label} must be a full Git commit SHA.`);
}

function validateId(value, label) {
  if (typeof value !== 'string' || !value.trim() || value.length > 200)
    throw new Error(`Invalid ${label}.`);
}

function safeRef(value) {
  return createHash('sha256').update(value).digest('hex').slice(0, 24);
}

function cleanText(value, limit) {
  if (typeof value !== 'string' || value.length > limit)
    throw new Error(`Text must be a string under ${limit} characters.`);
  return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
}

function isGitHubRemote(remote) {
  if (/^(?:ssh:\/\/git@|git@)github\.com[:/]/i.test(remote)) return true;
  try {
    return new URL(remote).hostname.toLocaleLowerCase() === 'github.com';
  } catch {
    return false;
  }
}

function candidateWorktreePath(stateRoot, repositoryId, candidateId) {
  const slug = createHash('sha256').update(candidateId).digest('hex').slice(0, 12);
  return resolve(stateRoot, '..', '..', 'Worktrees', repositoryId.slice(0, 12), slug);
}

async function runGit(cwd, args) {
  const { stdout } = await execFile('git', args, {
    cwd,
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout;
}
