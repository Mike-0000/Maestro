import {
  hostSettingsErrorSchema,
  hostSettingsStateSchema,
  updateHostSettingsInputSchema,
} from '@emdash/core/runtimes/host-settings/api';
import { resourceUsageSampleSchema } from '@emdash/core/runtimes/resource-usage/api';
import type {
  DependencyStatus,
  HostDependencyError,
  InstallCommandOption,
  InstallMethod,
} from '@emdash/core/services/host-dependencies/api';
import {
  hostDependencyErrorSchema,
  hostDependencyOperationProgressSchema,
  hostDependencySnapshotSchema,
  installMethodSchema,
} from '@emdash/core/services/host-dependencies/api';
import type { Result } from '@emdash/shared';
import { resultSchema } from '@emdash/shared';
import {
  defineContract,
  fallible,
  liveJob,
  liveModel,
  liveState,
  mutation,
  procedure,
} from '@emdash/wire/rpc';
import { z } from 'zod';
import type { SshConfig, SshConnectionUsage } from '@core/primitives/ssh/api';
import type { WslMirrorInfo } from '@core/services/wsl-mirror/api/types';
import {
  addMaestroHostInputSchema,
  inspectMaestroHostInputSchema,
  maestroHostErrorSchema,
  maestroHostInfoSchema,
  repairMaestroHostInputSchema,
  updateMaestroHostInputSchema,
} from './maestro-host';

// syncLocalSettings is excluded from save: it is toggled through the dedicated
// setSyncLocalSettings procedure so flipping it never drops the pinned connection.
export type SaveMachineInput = Partial<Pick<SshConfig, 'id'>> &
  Omit<SshConfig, 'id' | 'syncLocalSettings'> & { password?: string; passphrase?: string };

export type MachineSystemDependencyTier = 'required' | 'recommended';

export type MachineSystemDependencyStatus = {
  id: string;
  name: string;
  tier: MachineSystemDependencyTier;
  status: DependencyStatus;
  path: string | null;
  installDocs?: string;
  installOptions: InstallCommandOption[];
};

export type InstallMachineSystemDependencyInput = {
  machineId?: string;
  id: string;
  method?: InstallMethod;
  elevate?: boolean;
};

export type InstallMachineSystemDependencyResult = Result<
  MachineSystemDependencyStatus,
  HostDependencyError
>;
export type InstallMachineSystemDependenciesInput = {
  machineId?: string;
  dependencies: Array<Omit<InstallMachineSystemDependencyInput, 'machineId'>>;
};
export type InstallMachineSystemDependenciesResult = Record<
  string,
  InstallMachineSystemDependencyResult
>;

const voidInput = z.void();
const hostInput = z.object({ machineId: z.string().min(1).optional() });
const systemDependencyInstallInput = z.object({
  id: z.string().min(1),
  method: installMethodSchema.optional(),
  elevate: z.boolean().optional(),
});
const systemDependencyInstallResult = resultSchema(
  z.custom<MachineSystemDependencyStatus>(),
  hostDependencyErrorSchema
);

export const machinesDomain = 'machines' as const;

export const machinesContract = defineContract({
  getMachines: procedure({ input: voidInput, output: z.array(z.custom<SshConfig>()) }),
  getMachineUsage: procedure({
    input: voidInput,
    output: z.custom<SshConnectionUsage>(),
  }),
  getMachineMetrics: procedure({
    input: hostInput,
    output: resourceUsageSampleSchema,
  }),
  systemDependencies: liveModel({
    key: hostInput,
    states: {
      current: liveState({ data: hostDependencySnapshotSchema }),
    },
    mutations: {
      refresh: mutation({
        input: z.void(),
        data: hostDependencySnapshotSchema,
        error: hostDependencyErrorSchema,
      }),
    },
  }),
  installSystemDependencies: liveJob({
    input: hostInput.extend({ dependencies: z.array(systemDependencyInstallInput).min(1) }),
    progress: hostDependencyOperationProgressSchema,
    result: z.record(z.string(), systemDependencyInstallResult),
    error: hostDependencyErrorSchema,
  }),
  /**
   * Per-host defaults (shellSetup, worktree root, tmux) from the host-settings
   * runtime; the live model also reflects out-of-band edits to the settings file.
   */
  hostSettings: liveModel({
    key: hostInput,
    states: {
      current: liveState({ data: hostSettingsStateSchema }),
    },
  }),
  updateHostSettings: fallible({
    input: hostInput.extend({ patch: updateHostSettingsInputSchema }),
    data: hostSettingsStateSchema,
    error: hostSettingsErrorSchema,
  }),
  saveMachine: procedure({
    input: z.custom<SaveMachineInput>(),
    output: z.custom<SshConfig>(),
  }),
  /**
   * Flips the per-host "Sync local settings" toggle (connection metadata,
   * desktop-side). Deliberately separate from saveMachine so toggling never
   * drops the pinned host connection.
   */
  /** Adds (or returns) this computer's shared Host, which runs without SSH. */
  addThisComputer: procedure({
    input: voidInput,
    output: z.custom<SshConfig>(),
  }),
  /**
   * Adds (or returns) a WSL2 distro on this computer as a Host. Without a name, the first
   * usable distro that is not a machine yet.
   */
  addWslDistro: procedure({
    input: z.object({ distro: z.string().min(1).optional() }),
    output: z.custom<SshConfig>(),
  }),
  /**
   * Puts a repository on a Windows drive into a WSL2 distro (installing a distro, git settings
   * and Claude Code there as needed), starts the live mirror that keeps the two the same, and
   * returns the machine and path to create the project on. `notes` says what was done and
   * what is left for the user.
   */
  mirrorRepositoryToWsl: procedure({
    input: z.object({ windowsPath: z.string().min(1), name: z.string().min(1) }),
    output: z.custom<{
      machine: SshConfig;
      path: string;
      reused: boolean;
      notes: string[];
      mirror: WslMirrorInfo;
    }>(),
  }),
  /** The live mirrors between Windows folders and their copies in WSL2 distros. */
  getWslMirrors: procedure({ input: voidInput, output: z.array(z.custom<WslMirrorInfo>()) }),
  /** Resolves once the mirror's two sides agree; for a new mirror, after its first full run. */
  waitForWslMirror: procedure({
    input: z.object({ id: z.string().min(1), timeoutMs: z.number().int().positive() }),
    output: z.custom<WslMirrorInfo>(),
  }),
  setWslMirrorPaused: procedure({
    input: z.object({ id: z.string().min(1), paused: z.boolean() }),
    output: z.custom<WslMirrorInfo>(),
  }),
  /** Reads both sides in full now instead of waiting for the next change. */
  syncWslMirror: procedure({
    input: z.object({ id: z.string().min(1) }),
    output: z.custom<WslMirrorInfo>(),
  }),
  /** Stops mirroring for good; both folders stay as they are. */
  removeWslMirror: procedure({ input: z.object({ id: z.string().min(1) }), output: z.void() }),
  /**
   * Maestro hosts: the Maestro app on another computer, reached over its own WebSocket listener
   * instead of SSH. The requests to the host run in the main process; see ./maestro-host.
   */
  /** Asks an address who it is, without pairing or saving anything. */
  inspectMaestroHost: fallible({
    input: inspectMaestroHostInputSchema,
    data: maestroHostInfoSchema,
    error: maestroHostErrorSchema,
  }),
  /** Pairs with a host using a one-time code and saves it as a machine. */
  addMaestroHost: fallible({
    input: addMaestroHostInputSchema,
    data: z.custom<SshConfig>(),
    error: maestroHostErrorSchema,
  }),
  /** Pairs an existing machine again after the host revoked this device. */
  repairMaestroHost: fallible({
    input: repairMaestroHostInputSchema,
    data: z.custom<SshConfig>(),
    error: maestroHostErrorSchema,
  }),
  /** Changes a machine's address or Cloudflare Access credentials, keeping its pairing. */
  updateMaestroHost: fallible({
    input: updateMaestroHostInputSchema,
    data: z.custom<SshConfig>(),
    error: maestroHostErrorSchema,
  }),
  setSyncLocalSettings: procedure({
    input: z.object({ id: z.string(), enabled: z.boolean() }),
    output: z.custom<SshConfig>(),
  }),
  deleteMachine: procedure({
    input: z.object({ id: z.string() }),
    output: z.void(),
  }),
  renameMachine: procedure({
    input: z.object({ id: z.string(), name: z.string() }),
    output: z.void(),
  }),
});
