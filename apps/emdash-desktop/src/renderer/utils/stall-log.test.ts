import { createManualClock } from '@emdash/shared/testing';
import { describe, expect, it, vi } from 'vitest';
import type { TerminalOutputTallyEntry } from '@core/features/terminals/api/browser/pty/terminal-output-tally';
import type { RendererPerfEntry } from './perf-vitals';
import {
  STALL_LOG_OUTPUT_CHARS,
  STALL_LOG_WINDOW_MS,
  startStallLog,
  type StallLogReport,
} from './stall-log';

function setup(tallies: TerminalOutputTallyEntry[][] = []) {
  let longTask: ((entries: readonly RendererPerfEntry[]) => void) | undefined;
  const disconnect = vi.fn();
  const warnings: Array<{ message: string; report: StallLogReport }> = [];
  const clock = createManualClock(0);
  const dispose = startStallLog({
    observe: (_options, callback) => {
      longTask = callback;
      return disconnect;
    },
    takeOutputTally: () => tallies.shift() ?? [],
    warn: (message, report) => warnings.push({ message, report }),
    clock,
  });
  const task = (duration: number) => longTask?.([{ entryType: 'longtask', duration }]);
  return { clock, dispose, disconnect, task, warnings };
}

describe('startStallLog', () => {
  it('names the sessions that were streaming when a task froze the renderer', async () => {
    const topOutput = [
      { label: 'conversation big', chars: 900_000 },
      { label: 'conversation small', chars: 100 },
    ];
    const { clock, task, warnings } = setup([topOutput]);

    task(80);
    task(2_500);
    await clock.advanceBy(STALL_LOG_WINDOW_MS);

    expect(warnings).toEqual([
      {
        message: 'renderer: main thread stalled',
        report: {
          longestTaskMs: 2_500,
          longTaskTotalMs: 2_580,
          longTasks: 2,
          outputChars: 900_100,
          topOutput,
        },
      },
    ]);
  });

  it('stays quiet through short tasks and ordinary output, then starts a fresh window', async () => {
    const { clock, task, warnings } = setup([[{ label: 'conversation a', chars: 10_000 }]]);

    task(900);
    await clock.advanceBy(STALL_LOG_WINDOW_MS);
    await clock.advanceBy(STALL_LOG_WINDOW_MS);

    expect(warnings).toEqual([]);
  });

  it('reports an output flood even when no task ran long', async () => {
    const flood = [{ label: 'conversation big', chars: STALL_LOG_OUTPUT_CHARS }];
    const { clock, warnings } = setup([flood]);

    await clock.advanceBy(STALL_LOG_WINDOW_MS);

    expect(warnings.map((warning) => warning.message)).toEqual(['renderer: heavy terminal output']);
  });

  it('stops observing and logging once disposed', async () => {
    const { clock, dispose, disconnect, task, warnings } = setup();

    dispose();
    task(5_000);
    await clock.advanceBy(STALL_LOG_WINDOW_MS);

    expect(disconnect).toHaveBeenCalled();
    expect(warnings).toEqual([]);
  });
});
