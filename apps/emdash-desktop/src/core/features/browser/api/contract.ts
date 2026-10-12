import { defineContract, eventStream, fallible, procedure } from '@emdash/wire/rpc';
import { z } from 'zod';
import type {
  BrowserAction,
  BrowserActResult,
  BrowserAutomationError,
  BrowserConsoleEntry,
  BrowserDataClearKind,
  BrowserEvent,
  BrowserImage,
  BrowserObservation,
  BrowsingDataKind,
} from '@core/primitives/browser/api';

type BrowserActionResult = { success: boolean; error?: string };

export const browserDomain = 'browser' as const;

export const browserContract = defineContract({
  registerSession: procedure({
    input: z.object({ browserId: z.string(), partition: z.string() }),
    output: z.custom<BrowserActionResult>(),
  }),
  unregisterSession: procedure({
    input: z.object({ browserId: z.string() }),
    output: z.custom<BrowserActionResult>(),
  }),
  bindWebContents: procedure({
    input: z.object({ browserId: z.string(), webContentsId: z.number() }),
    output: z.custom<BrowserActionResult>(),
  }),
  setActiveBrowser: procedure({
    input: z.object({ browserId: z.string().nullable() }),
    output: z.custom<BrowserActionResult>(),
  }),
  getActiveBrowser: procedure({
    input: z.void(),
    output: z.object({ browserId: z.string().nullable() }),
  }),
  openDevTools: procedure({
    input: z.object({ browserId: z.string() }),
    output: z.custom<BrowserActionResult>(),
  }),
  captureScreenshot: procedure({
    input: z.object({ browserId: z.string() }),
    output: z.custom<BrowserActionResult>(),
  }),
  clearData: procedure({
    input: z.object({ browserId: z.string(), kind: z.custom<BrowserDataClearKind>() }),
    output: z.custom<BrowserActionResult>(),
  }),
  clearProfileStorage: procedure({
    input: z.object({ profileId: z.string() }),
    output: z.custom<BrowserActionResult>(),
  }),
  clearBrowsingData: procedure({
    input: z.object({ kind: z.custom<BrowsingDataKind>() }),
    output: z.custom<BrowserActionResult>(),
  }),
  /** Conductor observation of an agent-controllable browser (policy enforced in main). */
  observe: fallible({
    input: z.object({
      browserId: z.string(),
      mode: z.enum(['screenshot', 'outline', 'text']),
      maxEdge: z.number().int().min(160).max(1568).optional(),
      quality: z.number().int().min(30).max(90).optional(),
      includeConsole: z.boolean().optional(),
    }),
    data: z.custom<BrowserObservation>(),
    error: z.custom<BrowserAutomationError>(),
  }),
  /** Conductor action in an agent-controllable browser. */
  act: fallible({
    input: z.object({ browserId: z.string(), action: z.custom<BrowserAction>() }),
    data: z.custom<BrowserActResult>(),
    error: z.custom<BrowserAutomationError>(),
  }),
  consoleTail: fallible({
    input: z.object({ browserId: z.string(), limit: z.number().int().min(1).max(100) }),
    data: z.array(z.custom<BrowserConsoleEntry>()),
    error: z.custom<BrowserAutomationError>(),
  }),
  /** Who may drive a canvas browser; `agents` requires an isolated per-task partition. */
  setControl: fallible({
    input: z.object({
      browserId: z.string(),
      projectId: z.string(),
      workspaceId: z.string(),
      taskId: z.string(),
      control: z.enum(['user', 'agents']),
      origins: z.array(z.string()).max(16).optional(),
      /** Public origins the user approved for the conductor in this browser. */
      publicOrigins: z.array(z.string()).max(16).optional(),
    }),
    data: z.void(),
    error: z.custom<BrowserAutomationError>(),
  }),
  /** Ends a model's control lease (the tile's Stop button). */
  stopLease: procedure({
    input: z.object({ browserId: z.string() }),
    output: z.custom<BrowserActionResult>(),
  }),
  /** The renderer closed a canvas browser for good. */
  forgetControl: procedure({
    input: z.object({ browserId: z.string() }),
    output: z.custom<BrowserActionResult>(),
  }),
  /** Renderer answer to an `open-request` event. */
  ackOpenRequest: procedure({
    input: z.object({
      requestId: z.string(),
      browserId: z.string().nullable(),
      denial: z.enum(['disabled', 'declined', 'consent-pending']).optional(),
    }),
    output: z.custom<BrowserActionResult>(),
  }),
  /** Small preview for a suspended or off-screen tile; user-facing, no model involved. */
  capturePreview: procedure({
    input: z.object({ browserId: z.string(), maxEdge: z.number().int().min(160).max(960) }),
    output: z.custom<BrowserImage | null>(),
  }),
  events: eventStream({ key: z.void(), event: z.custom<BrowserEvent>() }),
});
