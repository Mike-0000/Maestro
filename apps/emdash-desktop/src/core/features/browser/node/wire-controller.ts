import type { Result } from '@emdash/shared';
import { createController, type Controller } from '@emdash/wire/rpc';
import type {
  BrowserAction,
  BrowserActResult,
  BrowserAutomationError,
  BrowserConsoleEntry,
  BrowserDataClearKind,
  BrowserImage,
  BrowserObservation,
  BrowserObserveInput,
  BrowsingDataKind,
} from '@core/primitives/browser/api';
import { browserContract } from '../api';
import { browserEvents } from './event-host';

export type BrowserOperations = {
  registerSession(input: { browserId: string; partition: string }): BrowserActionResult;
  unregisterSession(browserId: string): BrowserActionResult;
  bindWebContents(input: { browserId: string; webContentsId: number }): BrowserActionResult;
  setActiveBrowser(browserId: string | null): BrowserActionResult;
  getActiveBrowser(): { browserId: string | null };
  openDevTools(browserId: string): BrowserActionResult;
  captureScreenshot(browserId: string): Promise<BrowserActionResult>;
  clearData(browserId: string, kind: BrowserDataClearKind): Promise<BrowserActionResult>;
  clearProfileStorage(profileId: string): Promise<BrowserActionResult>;
  clearBrowsingData(kind: BrowsingDataKind): Promise<BrowserActionResult>;
  observe(input: BrowserObserveInput): Promise<Result<BrowserObservation, BrowserAutomationError>>;
  act(input: {
    browserId: string;
    action: BrowserAction;
  }): Promise<Result<BrowserActResult, BrowserAutomationError>>;
  consoleTail(input: {
    browserId: string;
    limit: number;
  }): Promise<Result<BrowserConsoleEntry[], BrowserAutomationError>>;
  setControl(input: {
    browserId: string;
    projectId: string;
    workspaceId: string;
    taskId: string;
    control: 'user' | 'agents';
    origins?: string[];
  }): Result<void, BrowserAutomationError>;
  stopLease(browserId: string): BrowserActionResult;
  forgetControl(browserId: string): BrowserActionResult;
  ackOpenRequest(input: {
    requestId: string;
    browserId: string | null;
    denial?: 'disabled' | 'declined' | 'consent-pending';
  }): BrowserActionResult;
  capturePreview(input: { browserId: string; maxEdge: number }): Promise<BrowserImage | null>;
};

type BrowserActionResult = { success: boolean; error?: string };

export function createBrowserWireController(browserOperations: BrowserOperations): Controller {
  return createController(browserContract, {
    registerSession: (input) => browserOperations.registerSession(input),
    unregisterSession: ({ browserId }) => browserOperations.unregisterSession(browserId),
    bindWebContents: (input) => browserOperations.bindWebContents(input),
    setActiveBrowser: ({ browserId }) => browserOperations.setActiveBrowser(browserId),
    getActiveBrowser: () => browserOperations.getActiveBrowser(),
    openDevTools: ({ browserId }) => browserOperations.openDevTools(browserId),
    captureScreenshot: ({ browserId }) => browserOperations.captureScreenshot(browserId),
    clearData: ({ browserId, kind }) => browserOperations.clearData(browserId, kind),
    clearProfileStorage: ({ profileId }) => browserOperations.clearProfileStorage(profileId),
    clearBrowsingData: ({ kind }) => browserOperations.clearBrowsingData(kind),
    observe: (input) => browserOperations.observe(input),
    act: (input) => browserOperations.act(input),
    consoleTail: (input) => browserOperations.consoleTail(input),
    setControl: (input) => browserOperations.setControl(input),
    stopLease: ({ browserId }) => browserOperations.stopLease(browserId),
    forgetControl: ({ browserId }) => browserOperations.forgetControl(browserId),
    ackOpenRequest: (input) => browserOperations.ackOpenRequest(input),
    capturePreview: (input) => browserOperations.capturePreview(input),
    events: browserEvents,
  });
}
