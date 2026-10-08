import { makeAutoObservable, reaction, runInAction } from 'mobx';
import {
  fetchPushState,
  removePushSubscription,
  savePushSubscription,
  sendTestPush,
  type PushEvents,
  type PushSaveFailure,
  type PushTestFailure,
} from '../lib/push-api';
import type { AppStore } from './app-store';

/**
 * - `checking`: not yet known.
 * - `unsupported`: this browser, or this way of opening the app, cannot receive push.
 * - `unavailable`: the computer cannot keep a push key securely.
 * - `unreachable`: the computer did not answer.
 * - `blocked`: notifications were denied for this app in the phone's settings.
 * - `off` / `on`: whether this device is subscribed.
 */
export type PushStatus =
  | 'checking'
  | 'unsupported'
  | 'unavailable'
  | 'unreachable'
  | 'blocked'
  | 'off'
  | 'on';

const DEFAULT_EVENTS: PushEvents = { complete: true, attention: true };
const WORKER_WAIT_MS = 4_000;

const SAVE_FAILURES: Record<PushSaveFailure, string> = {
  'unsupported-push-service': 'This browser’s notification service is not supported. Use Chrome.',
  unavailable: 'Your computer cannot store notification keys securely.',
  unreachable: 'Could not reach your computer. Try again.',
};

const TEST_FAILURES: Record<PushTestFailure, string> = {
  'not-subscribed': 'This phone is not subscribed. Turn notifications off and on again.',
  unavailable: 'Your computer cannot store notification keys securely.',
  expired: 'This phone’s subscription expired. Turn notifications on again.',
  failed: 'The notification service did not accept the test. Try again in a moment.',
  'host-disabled': 'Notifications are turned off in Maestro on your computer.',
  'rate-limited': 'Wait a few seconds before sending another test.',
  unreachable: 'Could not reach your computer. Try again.',
};

/** Whether this device gets a notification when an agent finishes or needs input. */
export class PushStore {
  status: PushStatus = 'checking';
  events: PushEvents = DEFAULT_EVENTS;
  /** The notifications switch in Maestro on the computer. */
  hostEnabled = true;
  busy = false;
  testing = false;
  /** The outcome of the last action, shown under the controls. */
  message: { text: string; tone: 'info' | 'error' } | null = null;

  private publicKey: string | null = null;
  /** Advances whenever the person turns notifications on or off; a sync from before is stale. */
  private epoch = 0;

  constructor(app: AppStore) {
    makeAutoObservable<PushStore, 'publicKey' | 'epoch'>(this, { publicKey: false, epoch: false });
    reaction(
      () => app.phase === 'paired',
      (paired) => {
        if (paired) void this.sync();
      },
      { fireImmediately: true }
    );
  }

  get supported(): boolean {
    return this.status !== 'unsupported' && this.status !== 'checking';
  }

  /**
   * Brings this device and the host back in line. The host keeps one subscription per device
   * and saving is idempotent, so re-sending what the browser holds repairs either side.
   */
  async sync(): Promise<void> {
    if (this.busy) return;
    const epoch = this.epoch;
    const stale = (): boolean => epoch !== this.epoch;
    const registration = await pushRegistration();
    if (stale()) return;
    if (!registration) {
      this.set('unsupported');
      return;
    }
    let host;
    try {
      host = await fetchPushState();
    } catch {
      if (!stale()) this.set('unreachable');
      return;
    }
    if (stale()) return;
    runInAction(() => {
      this.publicKey = host.publicKey;
      this.hostEnabled = host.hostEnabled;
      if (host.subscription) this.events = host.subscription.events;
    });
    if (!host.available || !host.publicKey) {
      this.set('unavailable');
      return;
    }
    if (Notification.permission === 'denied') {
      this.set('blocked');
      return;
    }
    const subscription = await registration.pushManager.getSubscription().catch(() => null);
    if (stale()) return;
    if (
      !subscription ||
      Notification.permission !== 'granted' ||
      !sameKey(subscription, host.publicKey)
    ) {
      this.set('off');
      return;
    }
    const failure = await savePushSubscription(subscription.toJSON(), this.events);
    if (stale()) {
      // Turned off while this was in flight: take back what was just re-saved.
      if (!failure && this.status === 'off' && !this.busy) void removePushSubscription();
      return;
    }
    this.set(failure ? 'off' : 'on');
  }

  /** Must be called straight from a tap: the browser only asks for permission then. */
  async enable(): Promise<void> {
    if (this.busy) return;
    this.begin();
    try {
      const failure = await this.subscribe();
      runInAction(() => {
        if (failure === null) this.status = 'on';
        else if (failure) this.message = { text: failure, tone: 'error' };
      });
    } finally {
      runInAction(() => {
        this.busy = false;
      });
    }
  }

  async disable(): Promise<void> {
    if (this.busy) return;
    this.begin();
    try {
      await removePushSubscription();
      const registration = await pushRegistration();
      const subscription = await registration?.pushManager.getSubscription().catch(() => null);
      await subscription?.unsubscribe().catch(() => false);
      this.set('off');
    } finally {
      runInAction(() => {
        this.busy = false;
      });
    }
  }

  async setEvent(event: keyof PushEvents, on: boolean): Promise<void> {
    const previous = this.events;
    this.events = { ...previous, [event]: on };
    this.message = null;
    const registration = await pushRegistration();
    const subscription = await registration?.pushManager.getSubscription().catch(() => null);
    const failure = subscription
      ? await savePushSubscription(subscription.toJSON(), this.events)
      : 'unreachable';
    if (!failure) return;
    runInAction(() => {
      this.events = previous;
      this.message = { text: SAVE_FAILURES[failure], tone: 'error' };
    });
  }

  async sendTest(): Promise<void> {
    if (this.testing) return;
    this.testing = true;
    this.message = null;
    const failure = await sendTestPush();
    runInAction(() => {
      this.testing = false;
      this.message = failure
        ? { text: TEST_FAILURES[failure] ?? TEST_FAILURES.failed, tone: 'error' }
        : { text: 'Test sent. It should arrive in a few seconds.', tone: 'info' };
    });
    if (failure === 'expired' || failure === 'not-subscribed') this.set('off');
  }

  /**
   * Resolves with null once this device is subscribed, otherwise with what went wrong in words
   * (empty when the status already says it).
   */
  private async subscribe(): Promise<string | null> {
    const registration = await pushRegistration();
    if (!registration) return 'This browser cannot receive notifications.';
    if (!this.publicKey) return SAVE_FAILURES.unreachable;

    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      if (permission !== 'denied') return 'Notifications were not allowed.';
      this.set('blocked');
      return '';
    }

    let subscription = await registration.pushManager.getSubscription().catch(() => null);
    // A subscription made for another host key can never be delivered to; replace it.
    if (subscription && !sameKey(subscription, this.publicKey)) {
      await subscription.unsubscribe().catch(() => false);
      subscription = null;
    }
    try {
      subscription ??= await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: this.publicKey,
      });
    } catch {
      return 'This phone could not subscribe to notifications. Check your connection and try again.';
    }

    const failure = await savePushSubscription(subscription.toJSON(), this.events);
    if (!failure) return null;
    // The host does not have it, so the browser must not keep it either.
    await subscription.unsubscribe().catch(() => false);
    return SAVE_FAILURES[failure];
  }

  private begin(): void {
    this.epoch += 1;
    this.busy = true;
    this.message = null;
  }

  private set(status: PushStatus): void {
    runInAction(() => {
      this.status = status;
    });
  }
}

/** The app's service worker when this page can receive push at all, otherwise null. */
async function pushRegistration(): Promise<ServiceWorkerRegistration | null> {
  if (
    !window.isSecureContext ||
    !('serviceWorker' in navigator) ||
    !('PushManager' in window) ||
    !('Notification' in window)
  ) {
    return null;
  }
  // The worker is registered once the page has loaded, and only in production builds: wait a
  // moment for it, never forever.
  return Promise.race([
    navigator.serviceWorker.ready,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), WORKER_WAIT_MS)),
  ]);
}

function sameKey(subscription: PushSubscription, publicKey: string): boolean {
  const key = subscription.options.applicationServerKey;
  if (!key) return false;
  return toBase64Url(new Uint8Array(key)) === publicKey;
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
}
