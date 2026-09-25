import { defineCommand } from '@core/primitives/commands/api';

export const toggleListeningCommand = defineCommand({
  id: 'voice.toggleListening',
  title: 'Start or Stop Listening',
  description: 'Talk to the conductor (or hold Right Ctrl)',
  category: 'Voice',
  icon: 'mic',
});

export const toggleSpokenRepliesCommand = defineCommand({
  id: 'voice.toggleMute',
  title: 'Mute or Unmute Spoken Replies',
  description: 'Silence the conductor and attention announcements',
  category: 'Voice',
  icon: 'volume-x',
});

export const VOICE_COMMAND_DEFS = [toggleListeningCommand, toggleSpokenRepliesCommand] as const;
