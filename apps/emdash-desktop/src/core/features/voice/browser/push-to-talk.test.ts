import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DOUBLE_TAP_MS, HOLD_DELAY_MS } from '../api/hold-to-talk';
import { HOLD_TO_TALK_CODE, installPushToTalk } from './push-to-talk';
import type { VoiceStore } from './voice-store';

function setup() {
  const target = new EventTarget();
  const store = {
    mode: 'hold',
    isListening: false,
    tap: vi.fn(),
    startListening: vi.fn(async () => {
      store.isListening = true;
    }),
    stopListening: vi.fn(async () => {
      store.isListening = false;
    }),
    cancelListening: vi.fn(),
  };
  const uninstall = installPushToTalk(store as unknown as VoiceStore, target as Window);
  const key = (type: 'keydown' | 'keyup', code: string, extra: object = {}) => {
    const event = new Event(type);
    Object.assign(event, { code, key: code, repeat: false, shiftKey: false, ...extra });
    target.dispatchEvent(event);
  };
  const tapKey = () => {
    key('keydown', HOLD_TO_TALK_CODE);
    key('keyup', HOLD_TO_TALK_CODE);
  };
  return { store, key, tapKey, uninstall, target };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('installPushToTalk', () => {
  it('reports one tap once no second tap follows', () => {
    const { store, tapKey, uninstall } = setup();
    tapKey();
    expect(store.tap).not.toHaveBeenCalled();
    vi.advanceTimersByTime(DOUBLE_TAP_MS);
    expect(store.tap).toHaveBeenCalledTimes(1);
    expect(store.startListening).not.toHaveBeenCalled();
    uninstall();
  });

  it('starts a command on a double tap, never a tap, and stops on the next tap', () => {
    const { store, tapKey, uninstall } = setup();
    tapKey();
    vi.advanceTimersByTime(150);
    tapKey();
    vi.advanceTimersByTime(DOUBLE_TAP_MS * 2);
    expect(store.tap).not.toHaveBeenCalled();
    expect(store.startListening).toHaveBeenCalledWith('hold', 'command');
    tapKey();
    expect(store.stopListening).toHaveBeenCalledTimes(1);
    uninstall();
  });

  it('listens while the key is held and stops on release', () => {
    const { store, key, uninstall } = setup();
    key('keydown', HOLD_TO_TALK_CODE);
    vi.advanceTimersByTime(HOLD_DELAY_MS);
    expect(store.startListening).toHaveBeenCalledWith('hold', 'command');
    key('keydown', 'KeyC');
    expect(store.cancelListening).not.toHaveBeenCalled();
    key('keyup', HOLD_TO_TALK_CODE);
    expect(store.stopListening).toHaveBeenCalledTimes(1);
    expect(store.tap).not.toHaveBeenCalled();
    uninstall();
  });

  it('ignores a chord and stops a hold when the window loses focus', () => {
    const { store, key, uninstall, target } = setup();
    key('keydown', HOLD_TO_TALK_CODE);
    key('keydown', 'KeyC');
    key('keyup', HOLD_TO_TALK_CODE);
    vi.advanceTimersByTime(1000);
    expect(store.startListening).not.toHaveBeenCalled();
    expect(store.tap).not.toHaveBeenCalled();

    key('keydown', HOLD_TO_TALK_CODE);
    vi.advanceTimersByTime(HOLD_DELAY_MS);
    target.dispatchEvent(new Event('blur'));
    expect(store.stopListening).toHaveBeenCalledTimes(1);
    uninstall();
  });
});
