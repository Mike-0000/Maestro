import {
  remoteDeviceWireContract,
  type RemoteOverview,
  type RemoteVoiceState,
} from '@emdash/core/services/remote-control/api';
import { createEventStreamHost } from '@emdash/wire/live';
import { cell, expose } from '@emdash/wire/state';
import type { RemoteControlImpl } from './remote-control';
import type { RemoteVoiceImpl } from './remote-voice';

const remote = remoteDeviceWireContract.remote;

const IDLE_VOICE_STATE: RemoteVoiceState = {
  available: false,
  transcriptionReady: true,
  phase: 'idle',
  activity: '',
  lastUtterance: '',
  reply: '',
  replyAt: 0,
  error: null,
  pending: null,
  plan: null,
  agentNames: [],
  speech: 'device',
};

const EMPTY_OVERVIEW: RemoteOverview = {
  host: { id: 'host-1', name: 'studio', appVersion: '1.2.3' },
  projects: [],
  agents: [],
  providers: [],
  defaultProviderId: null,
};

/** A voice surface with its live endpoints present and nothing behind them. */
export function idleRemoteVoice(): RemoteVoiceImpl {
  return {
    state: expose(remote.voice.state, { hud: cell(IDLE_VOICE_STATE) }),
    events: createEventStreamHost(remote.voice.events),
  };
}

/**
 * A remote-control surface for tests: every live endpoint a controller needs is present, and
 * the verbs under test are supplied by the caller.
 */
export function testRemoteControl(overrides: Partial<RemoteControlImpl> = {}): RemoteControlImpl {
  return {
    overview: expose(remote.overview, { snapshot: cell(EMPTY_OVERVIEW) }),
    output: () => {
      throw new Error('No terminal in this test');
    },
    voice: idleRemoteVoice(),
    ...overrides,
  };
}
