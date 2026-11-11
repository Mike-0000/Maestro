/**
 * execute-stream.perf — per-chunk cost of streaming terminal output through
 * the execute row's presenter + measure path.
 *
 * Simulates the client line store: an identity-stable lines array mutated in
 * place with a version bump per flush. After each flush the test runs the real
 * per-update work (executeFromItem → executeUnitDef.measure) and times it.
 *
 * The regression this guards: before the line-structured store, every update
 * re-split and re-measured the entire accumulated output, so per-chunk cost
 * grew linearly with total output. With incremental display lines and
 * running-max width tracking, per-chunk cost must stay flat.
 *
 * performance.now() has 0.1 ms resolution in a browser that is not cross-origin
 * isolated, close to the cost of one update. So the test runs STREAMS
 * independent streams side by side, each with its own identity-stable lines
 * array, and times one flush across all of them as a single sample (several
 * ms), divided by STREAMS. Every stream still does the real
 * first-call-after-flush work (repeating calls on one stream would only hit
 * its memo caches).
 */

import { executeFromItem, executeUnitDef } from '@components/rows/tools/execute/execute.def';
import { createChatCaches } from '@core/caches';
import type { MeasureCtx } from '@core/define';
import { DEFAULT_THEME } from '@core/theme';
import type { SegmentCtx } from '@core/units';
import { describe, expect, it } from 'vitest';
import type { TerminalOutputSnapshot, ToolNode } from '@/model';
import { now, record } from './harness';

const UPDATES = 240;
const LINES_PER_UPDATE = 25;
/** Streams timed together per sample, so one sample spans many timer ticks. */
const STREAMS = 8;
/** performance.now() resolution without cross-origin isolation. */
const TIMER_RESOLUTION_MS = 0.1;
/** Smallest per-update mean a sample can resolve; guards the ratio against 0. */
const MEAN_FLOOR_MS = TIMER_RESOLUTION_MS / STREAMS;

function executeItem(stream: number): Extract<ToolNode, { kind: 'execute-tool-call' }> {
  return {
    kind: 'execute-tool-call',
    id: `perf-exec-${stream}`,
    seq: 0,
    toolCallId: `perf-call-${stream}`,
    title: 'stream',
    command: 'stream --lots-of-output',
    status: 'running',
    terminalId: `perf-term-${stream}`,
  };
}

type Stream = {
  item: Extract<ToolNode, { kind: 'execute-tool-call' }>;
  lines: string[];
  version: number;
  ctx: SegmentCtx;
};

function createStream(index: number): Stream {
  const stream: Stream = {
    item: executeItem(index),
    lines: [''],
    version: 0,
    ctx: segCtx(() => ({ lines: stream.lines, truncated: false, version: stream.version })),
  };
  return stream;
}

function segCtx(snapshot: () => TerminalOutputSnapshot): SegmentCtx {
  return {
    caches: createChatCaches(),
    expanded: () => false,
    active: true,
    plan: () => null,
    pendingToolCallIds: () => new Set<string>(),
    terminalOutput: () => snapshot(),
  };
}

function mean(samples: number[]): number {
  return samples.reduce((sum, value) => sum + value, 0) / samples.length;
}

describe('execute row streaming cost', () => {
  it('per-chunk presenter+measure cost does not scale with accumulated output', () => {
    const streams = Array.from({ length: STREAMS }, (_, index) => createStream(index));
    const measureCtx: MeasureCtx = {
      theme: DEFAULT_THEME,
      width: 640,
      isCollapsed: () => false,
      // Expanded: a collapsed row is header-only and never touches the output,
      // so it would time nothing that could grow with accumulated lines.
      expanded: () => true,
      caches: createChatCaches(),
    };

    const perUpdateMs: number[] = [];
    for (let update = 0; update < UPDATES; update += 1) {
      // Simulate one coalesced flush appending a batch of completed lines.
      const batch: string[] = [];
      for (let i = 0; i < LINES_PER_UPDATE; i += 1) {
        batch.push(`[${update}:${i}] output line with some representative width ${'x'.repeat(i)}`);
      }
      for (const stream of streams) {
        stream.lines.pop();
        for (const line of batch) stream.lines.push(line);
        stream.lines.push('');
        stream.version += 1;
      }

      // One sample: this flush's per-update work on every stream, averaged.
      const start = now();
      for (const stream of streams) {
        const data = executeFromItem(stream.item, stream.ctx);
        executeUnitDef.measure(data, measureCtx, executeUnitDef.vars!);
      }
      perUpdateMs.push((now() - start) / STREAMS);
    }

    // Skip warmup; compare early steady-state cost against cost once ~6000
    // lines have accumulated. The floor keeps a sample below timer resolution
    // from turning the ratio into NaN or Infinity.
    const early = mean(perUpdateMs.slice(20, 60));
    const late = mean(perUpdateMs.slice(UPDATES - 40));
    const ratio = late / Math.max(early, MEAN_FLOOR_MS);

    record({
      label: 'execute stream per-update cost',
      'early mean (ms)': Number(early.toFixed(4)),
      'late mean (ms)': Number(late.toFixed(4)),
      'late/early ratio': Number(ratio.toFixed(2)),
      'total lines': streams[0]!.lines.length,
      streams: STREAMS,
    });

    // O(total-output) behavior produces a ratio near UPDATES-proportional
    // growth (>10x here); flat per-chunk cost stays near 1. The bound is loose
    // to absorb CI noise while still catching a linear regression.
    expect(ratio).toBeLessThan(4);
  });
});
