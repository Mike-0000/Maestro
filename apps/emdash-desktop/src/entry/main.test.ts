import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  isPackaged: false,
  bootstrapMain: vi.fn(async () => {}),
  clientMain: vi.fn(async () => {}),
  events: [] as string[],
}));

vi.mock('electron', () => ({
  app: {
    commandLine: {},
    get isPackaged() {
      return mocks.isPackaged;
    },
    whenReady: vi.fn(async () => {}),
  },
  dialog: {
    showErrorBox: vi.fn(),
  },
}));

vi.mock('@main/host/chromium-command-line', () => ({
  configureChromiumCommandLine: vi.fn(() => {
    mocks.events.push('configure-command-line');
  }),
}));

vi.mock('@main/bootstrap', () => {
  mocks.events.push('import-bootstrap');
  return {
    main: mocks.bootstrapMain.mockImplementation(async () => {
      mocks.events.push('run-bootstrap');
    }),
  };
});

vi.mock('@main/client/bootstrap', () => {
  mocks.events.push('import-client-bootstrap');
  return {
    clientMain: mocks.clientMain.mockImplementation(async () => {
      mocks.events.push('run-client');
    }),
  };
});

const originalArgv = process.argv;

beforeEach(() => {
  mocks.bootstrapMain.mockClear();
  mocks.clientMain.mockClear();
  mocks.events.length = 0;
  mocks.isPackaged = false;
  vi.resetModules();
  vi.stubEnv('MAESTRO_CLIENT', '');
  process.argv = originalArgv;
});

afterEach(() => {
  vi.unstubAllEnvs();
  process.argv = originalArgv;
});

it('configures Chromium before asynchronously importing bootstrap', async () => {
  await import('./main');
  await vi.waitFor(() => expect(mocks.bootstrapMain).toHaveBeenCalledOnce());

  expect(mocks.events).toEqual(['configure-command-line', 'import-bootstrap', 'run-bootstrap']);
});

it('never loads the client bootstrap without the client switch', async () => {
  process.argv = ['Maestro.exe', '--enable-logging'];
  await import('./main');
  await vi.waitFor(() => expect(mocks.bootstrapMain).toHaveBeenCalledOnce());

  expect(mocks.clientMain).not.toHaveBeenCalled();
  expect(mocks.events).not.toContain('import-client-bootstrap');
});

it('starts the client bootstrap instead of the local one with the client switch', async () => {
  process.argv = ['Maestro.exe', '--maestro-client'];
  await import('./main');
  await vi.waitFor(() => expect(mocks.clientMain).toHaveBeenCalledOnce());

  expect(mocks.bootstrapMain).not.toHaveBeenCalled();
  expect(mocks.events).toEqual(['configure-command-line', 'import-client-bootstrap', 'run-client']);
});

it('starts the client from MAESTRO_CLIENT in development only', async () => {
  vi.stubEnv('MAESTRO_CLIENT', '1');
  process.argv = ['electron.exe', '.'];
  await import('./main');
  await vi.waitFor(() => expect(mocks.clientMain).toHaveBeenCalledOnce());
  expect(mocks.bootstrapMain).not.toHaveBeenCalled();
});

it('ignores MAESTRO_CLIENT in a packaged build but keeps the switch', async () => {
  mocks.isPackaged = true;
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('MAESTRO_CLIENT', '1');
  process.argv = ['Maestro.exe'];
  await import('./main');
  await vi.waitFor(() => expect(mocks.bootstrapMain).toHaveBeenCalledOnce());
  expect(mocks.events).not.toContain('import-client-bootstrap');

  vi.resetModules();
  process.argv = ['Maestro.exe', '--maestro-client'];
  await import('./main');
  await vi.waitFor(() => expect(mocks.clientMain).toHaveBeenCalledOnce());
});
