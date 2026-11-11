import { Button, Dialog, Switch } from '@emdash/ui/react/primitives';
import React, { useEffect, useState } from 'react';
import { defineModal } from '@core/primitives/modals/react';
import { captureDevPerfTrace } from '../api/browser/capture-trace';
import { getDevPerfClient } from '../api/browser/client';
import type { DevPerfProcess } from '../api/contract';
import { createProcessPoller } from './process-poller';

function formatMemory(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${mb.toFixed(1)} MB`;
}

function totalOf(processes: DevPerfProcess[], pick: (p: DevPerfProcess) => number): number {
  return processes.reduce((sum, processInfo) => sum + pick(processInfo), 0);
}

type TraceState =
  | { kind: 'idle' }
  | { kind: 'recording' }
  | { kind: 'done'; path: string }
  | { kind: 'error'; message: string };

export function DevProcessPanelModal() {
  const [processes, setProcesses] = useState<DevPerfProcess[] | null>(null);
  const [supported, setSupported] = useState(true);
  const [spawnLogging, setSpawnLogging] = useState(false);
  const [trace, setTrace] = useState<TraceState>({ kind: 'idle' });

  // Poll only while the panel is mounted; unmount stops all polling.
  useEffect(() => {
    const poller = createProcessPoller({
      fetchSnapshot: async () => (await getDevPerfClient()).processSnapshot(),
      onSnapshot(snapshot) {
        setSupported(snapshot.supported);
        setProcesses(snapshot.processes);
      },
    });
    return () => poller.stop();
  }, []);

  useEffect(() => {
    void getDevPerfClient().then(async (client) => {
      const { enabled } = await client.getVerboseSpawnLogging();
      setSpawnLogging(enabled);
    });
  }, []);

  const handleCaptureTrace = async () => {
    setTrace({ kind: 'recording' });
    const outcome = await captureDevPerfTrace();
    setTrace(
      outcome.ok
        ? { kind: 'done', path: outcome.path }
        : { kind: 'error', message: outcome.message }
    );
  };

  const handleSpawnLoggingChange = async (enabled: boolean) => {
    setSpawnLogging(enabled);
    const client = await getDevPerfClient();
    await client.setVerboseSpawnLogging({ enabled });
  };

  // A dev-only tool, in the standard dialog anatomy: the title and one sentence, a toolbar line
  // (trace capture as a text action, the logging switch), then a dense table. Rows separate with
  // the hairline dense tables may use; numbers are mono and tabular.
  return (
    <>
      <Dialog.Header>
        <Dialog.Title>Processes</Dialog.Title>
        <Dialog.Description>
          The app's process tree, refreshed while this panel is open.
        </Dialog.Description>
      </Dialog.Header>
      <Dialog.Body>
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
          <Button
            type="button"
            variant="text"
            onClick={() => void handleCaptureTrace()}
            disabled={trace.kind === 'recording'}
          >
            {trace.kind === 'recording' ? 'Recording trace (10 s)…' : 'Capture trace (10 s)'}
          </Button>
          <label className="flex items-center gap-2 text-sm text-foreground-muted">
            <Switch
              checked={spawnLogging}
              onCheckedChange={(checked) => void handleSpawnLoggingChange(checked)}
            />
            Verbose spawn logging
          </label>
        </div>

        {trace.kind === 'done' && (
          <p className="font-mono text-tiny break-all text-foreground-muted select-text">
            Trace written to {trace.path}
          </p>
        )}
        {trace.kind === 'error' && (
          <p className="text-xs text-foreground-error">Trace capture failed: {trace.message}</p>
        )}

        {!supported && (
          <p className="text-xs text-foreground-muted">
            Process snapshots are not supported on this platform.
          </p>
        )}

        {processes === null ? (
          <p className="text-xs text-foreground-muted">Loading…</p>
        ) : (
          <div className="max-h-[55dvh] overflow-y-auto">
            <table className="w-full text-left text-xs tabular-nums">
              <thead className="sticky top-0 bg-surface">
                <tr className="text-tiny text-foreground-passive">
                  <th className="h-8 px-2 font-normal">Process</th>
                  <th className="h-8 w-16 px-2 text-right font-normal">PID</th>
                  <th className="h-8 w-16 px-2 text-right font-normal">CPU %</th>
                  <th className="h-8 w-24 px-2 text-right font-normal">Memory</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border-subtle font-mono text-foreground-muted">
                {processes.map((processInfo) => (
                  <tr key={processInfo.pid} className="transition-colors hover:bg-surface-hover">
                    <td
                      className="h-7 max-w-0 truncate px-2 text-foreground"
                      style={{ paddingLeft: `${8 + processInfo.depth * 16}px` }}
                      title={processInfo.command}
                    >
                      {processInfo.command}
                    </td>
                    <td className="px-2 text-right">{processInfo.pid}</td>
                    <td className="px-2 text-right">{processInfo.cpuPercent.toFixed(1)}</td>
                    <td className="px-2 text-right">{formatMemory(processInfo.rssBytes)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="sticky bottom-0 bg-surface">
                <tr className="text-foreground">
                  <td className="h-8 px-2 font-medium">Total ({processes.length} processes)</td>
                  <td />
                  <td className="px-2 text-right font-mono font-medium">
                    {totalOf(processes, ({ cpuPercent }) => cpuPercent).toFixed(1)}
                  </td>
                  <td className="px-2 text-right font-mono font-medium">
                    {formatMemory(totalOf(processes, ({ rssBytes }) => rssBytes))}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </Dialog.Body>
    </>
  );
}

export const devProcessPanelModal = defineModal<void>()({
  id: 'devProcessPanelModal',
  component: DevProcessPanelModal,
  size: 'lg',
});
