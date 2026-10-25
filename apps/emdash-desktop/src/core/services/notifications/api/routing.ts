import type { AppNotification } from './schemas';

export type NotificationRoutingSettings = {
  enabled: boolean;
  sound: boolean;
  osNotifications: boolean;
  soundFocusMode: 'always' | 'unfocused';
};

export type RoutingContext = {
  appFocused: boolean;
  settings: NotificationRoutingSettings;
  /**
   * The conductor judged that finished agents with nothing for the developer stay quiet. An
   * agent that needs the developer arrives as agent-attention, which this never silences.
   */
  quietCompletions?: boolean;
};

export type RoutingDecision = {
  system: boolean;
  sound: boolean;
  /** Forward to paired phones. They are elsewhere, so this desktop's focus does not matter. */
  push: boolean;
};

export type RoutingPolicy = (
  notification: AppNotification,
  context: RoutingContext
) => RoutingDecision;

export const defaultRoutingPolicy: RoutingPolicy = (notification, context) => {
  if (!context.settings.enabled) return { system: false, sound: false, push: false };
  if (notification.kind === 'update-error' || notification.kind === 'update-available') {
    return { system: false, sound: false, push: false };
  }
  if (notification.kind === 'agent-complete' && context.quietCompletions) {
    return { system: false, sound: false, push: false };
  }

  return {
    push: notification.kind === 'agent-complete' || notification.kind === 'agent-attention',
    system: context.settings.osNotifications && !context.appFocused,
    sound:
      notification.sound !== null &&
      context.settings.sound &&
      (context.settings.soundFocusMode === 'always' || !context.appFocused),
  };
};
