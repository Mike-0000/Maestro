import { noopLogger, type Logger } from '@emdash/shared/logger';
import type { DetectedPreviewUrl } from '#services/preview-detection/node';
import { collectDescendantProcesses } from '#services/pty/api';
import {
  createLocalProcessPortSnapshotter,
  loopbackProbeHost,
  probeHttpPort,
  type HttpPortProbe,
  type ListeningSocket,
  type ProcessPortSnapshotter,
} from './listening-ports';

/** How often listeners are read while at least one root process is running. */
export const PROCESS_PORT_POLL_INTERVAL_MS = 5_000;
/** A listener that has not answered HTTP after this many probes is left alone until it closes. */
const MAX_HTTP_PROBE_ATTEMPTS = 3;

/** A process whose tree is watched for listening sockets, such as an agent session's PTY child. */
export type ProcessTreeRoot = { id: string; pid: number };

/** A server found in a root's process tree; `pid` owns the listening socket. */
export type ProcessTreeServer = DetectedPreviewUrl & { pid: number };

export type ProcessTreePortDetector = {
  /** Re-reads the roots and starts or stops polling to match. Call when the roots change. */
  wake(): void;
  /** Polls now (after any poll already running) and resolves when that poll has finished. */
  poll(): Promise<void>;
  dispose(): void;
};

export type ProcessTreePortDetectorOptions = {
  roots: () => ProcessTreeRoot[];
  onDetected: (rootId: string, server: ProcessTreeServer) => void;
  onClosed: (rootId: string, server: ProcessTreeServer) => void;
  snapshotter?: ProcessPortSnapshotter;
  httpProbe?: HttpPortProbe;
  intervalMs?: number;
  logger?: Logger;
};

type Candidate = { rootId: string; pid: number; port: number; probeHost: string };

/**
 * Finds dev servers that a process started itself, outside any terminal Maestro reads: a socket
 * listening on loopback whose owning process is a root or one of its descendants, and which
 * answers HTTP. Ancestry is the evidence the server belongs to that root; a listener owned by any
 * other process is never reported.
 *
 * Polls only while there are roots. Each poll reads the listening sockets; the process table is
 * read only when a listening process appears that has not been placed yet, because a running
 * process never moves into another tree. A reported server is closed when its socket stops
 * listening or its root goes away. Never throws out of the poller.
 */
export function createProcessTreePortDetector(
  options: ProcessTreePortDetectorOptions
): ProcessTreePortDetector {
  const snapshotter = options.snapshotter ?? createLocalProcessPortSnapshotter();
  const httpProbe = options.httpProbe ?? probeHttpPort;
  const intervalMs = options.intervalMs ?? PROCESS_PORT_POLL_INTERVAL_MS;
  const logger = options.logger ?? noopLogger;

  /** Listening pid → the root whose tree holds it, or null when it belongs to none. */
  const owners = new Map<number, string | null>();
  /** `${rootId}:${port}` → the reported server. */
  const reported = new Map<string, { rootId: string; server: ProcessTreeServer }>();
  /** `${rootId}:${pid}:${port}` → failed HTTP probes. */
  const probeFailures = new Map<string, number>();
  let rootsSignature = '';
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: Promise<void> | null = null;
  let disposed = false;

  const closeAll = () => {
    for (const [key, entry] of reported) {
      reported.delete(key);
      options.onClosed(entry.rootId, entry.server);
    }
  };

  const schedule = () => {
    if (disposed || timer || inFlight) return;
    timer = setTimeout(() => {
      timer = undefined;
      void poll();
    }, intervalMs);
    timer.unref?.();
  };

  const poll = (): Promise<void> => {
    if (disposed) return Promise.resolve();
    // A poll already running read the host before this call; run a fresh one after it.
    if (inFlight) return inFlight.then(() => poll());
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    inFlight = runPoll()
      .catch((error: unknown) => {
        logger.debug('process-tree-port-detector: poll failed', { error: String(error) });
      })
      .finally(() => {
        inFlight = null;
        if (options.roots().length > 0) schedule();
      });
    return inFlight;
  };

  const runPoll = async () => {
    const roots = options.roots();
    const signature = roots
      .map((root) => `${root.id}=${root.pid}`)
      .sort()
      .join(',');
    if (signature !== rootsSignature) {
      // A new root can own processes that were placed under no root before.
      rootsSignature = signature;
      owners.clear();
    }
    if (roots.length === 0) {
      closeAll();
      probeFailures.clear();
      return;
    }

    const listeners = await snapshotter.listListeners();
    if (disposed) return;
    const listening = new Set(listeners.map((listener) => listener.pid));
    for (const pid of owners.keys()) {
      // A pid that stopped listening may be reused later; place it afresh then.
      if (!listening.has(pid)) owners.delete(pid);
    }

    if ([...listening].some((pid) => !owners.has(pid))) {
      const processes = await snapshotter.listProcesses();
      if (disposed) return;
      const treeOwner = new Map<number, string>();
      for (const root of roots) {
        treeOwner.set(root.pid, root.id);
        for (const descendant of collectDescendantProcesses(processes, [root.pid])) {
          if (!treeOwner.has(descendant.pid)) treeOwner.set(descendant.pid, root.id);
        }
      }
      for (const pid of listening) {
        if (!owners.has(pid)) owners.set(pid, treeOwner.get(pid) ?? null);
      }
    }

    const candidates = candidatesFor(listeners, owners, new Set(roots.map((root) => root.id)));
    for (const [key, entry] of reported) {
      const candidate = candidates.get(key);
      if (candidate && candidate.pid === entry.server.pid) continue;
      reported.delete(key);
      options.onClosed(entry.rootId, entry.server);
    }
    const live = new Set<string>();
    for (const [key, candidate] of candidates) {
      const failureKey = `${candidate.rootId}:${candidate.pid}:${candidate.port}`;
      live.add(failureKey);
      if (reported.has(key)) continue;
      if ((probeFailures.get(failureKey) ?? 0) >= MAX_HTTP_PROBE_ATTEMPTS) continue;
      const protocol = await httpProbe(candidate.probeHost, candidate.port);
      if (disposed) return;
      if (!protocol) {
        probeFailures.set(failureKey, (probeFailures.get(failureKey) ?? 0) + 1);
        continue;
      }
      probeFailures.delete(failureKey);
      const server: ProcessTreeServer = {
        protocol,
        host: 'localhost',
        port: candidate.port,
        urlPath: '/',
        pid: candidate.pid,
      };
      reported.set(key, { rootId: candidate.rootId, server });
      options.onDetected(candidate.rootId, server);
    }
    for (const key of probeFailures.keys()) {
      if (!live.has(key)) probeFailures.delete(key);
    }
  };

  return {
    wake() {
      if (disposed || timer || inFlight) return;
      // With no roots left, one more poll closes whatever was reported.
      if (options.roots().length > 0 || reported.size > 0) void poll();
    },
    poll,
    dispose() {
      disposed = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
      owners.clear();
      reported.clear();
      probeFailures.clear();
    },
  };
}

function candidatesFor(
  listeners: ListeningSocket[],
  owners: Map<number, string | null>,
  rootIds: Set<string>
): Map<string, Candidate> {
  const candidates = new Map<string, Candidate>();
  for (const listener of listeners) {
    const rootId = owners.get(listener.pid);
    if (!rootId || !rootIds.has(rootId)) continue;
    const probeHost = loopbackProbeHost(listener.address);
    if (!probeHost) continue;
    const key = `${rootId}:${listener.port}`;
    const existing = candidates.get(key);
    // Prefer IPv4 loopback when a server listens on both families.
    if (existing && (existing.probeHost === '127.0.0.1' || probeHost !== '127.0.0.1')) continue;
    candidates.set(key, { rootId, pid: listener.pid, port: listener.port, probeHost });
  }
  return candidates;
}
