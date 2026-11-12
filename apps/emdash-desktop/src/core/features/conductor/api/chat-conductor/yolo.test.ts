import { describe, expect, it } from 'vitest';
import { CONDUCTOR_RULES, CONDUCTOR_SYSTEM_PROMPT } from '../system-prompt';
import { CONDUCTOR_VOCABULARY } from '../vocabulary';
import { CHAT_CONDUCTOR_SYSTEM_PROMPT } from './prompt';
import { chatConductorToolSchemas } from './tools';
import {
  chatContextBlock,
  gateChatTool,
  MAX_UNATTENDED_ACTIONS,
  maxUnattendedActions,
  type ChatFacts,
} from './turns';
import {
  CHAT_YOLO_RULES,
  gateYoloStatus,
  MAX_UNATTENDED_ACTIONS_YOLO,
  YOLO_BLOCKERS,
  type YoloBlocker,
} from './yolo';

const facts = (over: Partial<ChatFacts> = {}): ChatFacts => ({
  taskName: 'Fix login',
  projectName: 'Shop',
  chats: [],
  lastChat: null,
  autonomy: true,
  notes: '',
  status: null,
  now: 'Thu, Nov 12, 2026',
  unattendedActionsLeft: 5,
  ...over,
});

describe('YOLO mode status gate', () => {
  it('refuses needs_you without a blocker in YOLO mode, and says to decide instead', () => {
    const gate = gateYoloStatus({ yolo: true, state: 'needs_you' });
    expect(gate.allowed).toBe(false);
    if (gate.allowed) return;
    expect(gate.reason).toContain('YOLO mode is on');
    expect(gate.reason).toContain('make the choice you would have recommended');
    for (const blocker of Object.keys(YOLO_BLOCKERS)) expect(gate.reason).toContain(blocker);
  });

  it('lets needs_you stand with a blocker, and every other state without one', () => {
    for (const blocker of Object.keys(YOLO_BLOCKERS) as YoloBlocker[]) {
      expect(gateYoloStatus({ yolo: true, state: 'needs_you', blocker }).allowed).toBe(true);
    }
    for (const state of ['working', 'done', 'idle'] as const) {
      expect(gateYoloStatus({ yolo: true, state }).allowed).toBe(true);
    }
  });

  it('changes nothing outside YOLO mode', () => {
    expect(gateYoloStatus({ yolo: false, state: 'needs_you' }).allowed).toBe(true);
  });

  it('takes the blocker on set_status, from the list only', () => {
    const schema = chatConductorToolSchemas.set_status;
    expect(
      schema.safeParse({
        state: 'needs_you',
        headline: 'Login: needs a token',
        blocker: 'credential',
      }).success
    ).toBe(true);
    expect(schema.safeParse({ state: 'needs_you', headline: 'Login: which?' }).success).toBe(true);
    expect(
      schema.safeParse({ state: 'needs_you', headline: 'Login: which?', blocker: 'preference' })
        .success
    ).toBe(false);
  });
});

describe('YOLO mode autonomy', () => {
  it('raises the unattended action cap, and keeps one', () => {
    expect(maxUnattendedActions(false)).toBe(MAX_UNATTENDED_ACTIONS);
    expect(maxUnattendedActions(true)).toBe(MAX_UNATTENDED_ACTIONS_YOLO);
    expect(MAX_UNATTENDED_ACTIONS_YOLO).toBeGreaterThan(MAX_UNATTENDED_ACTIONS);
    const spent = gateChatTool({
      tool: 'send_to_agent',
      trigger: 'event',
      autonomy: true,
      yolo: true,
      unattendedActionsLeft: 0,
    });
    expect(spent.allowed).toBe(false);
    if (!spent.allowed) expect(spent.reason).toContain(`${MAX_UNATTENDED_ACTIONS_YOLO} actions`);
  });

  it('still refuses stopping a working agent on a chat event', () => {
    const gate = gateChatTool({
      tool: 'stop_agent',
      trigger: 'event',
      autonomy: true,
      yolo: true,
      unattendedActionsLeft: 40,
      targetWorking: true,
    });
    expect(gate.allowed).toBe(false);
  });

  it('tells the conductor it is in YOLO mode in the context block', () => {
    const on = chatContextBlock(facts({ yolo: true, unattendedActionsLeft: 41 }));
    expect(on).toContain('Autonomy: YOLO. Every decision is yours');
    expect(on).toContain('41 unattended actions are left');
    const capped = chatContextBlock(facts({ yolo: true, unattendedActionsLeft: 0 }));
    expect(capped).toContain("Autonomy: YOLO, but Maestro's cap");
    expect(chatContextBlock(facts())).toContain('Autonomy: on. On a chat event');
  });
});

describe('YOLO rules', () => {
  it('list every blocker, the end of a task, and the push rule', () => {
    for (const [name, meaning] of Object.entries(YOLO_BLOCKERS)) {
      expect(CHAT_YOLO_RULES).toContain(`- ${name}: ${meaning}.`);
    }
    expect(CHAT_YOLO_RULES).toContain('set_status needs_you with that blocker');
    expect(CHAT_YOLO_RULES).toContain('set_status done with notify true');
    expect(CHAT_YOLO_RULES).toContain('a push, merge or release to anything shared is');
  });

  it('stay out of the cached base prompt', () => {
    expect(CHAT_CONDUCTOR_SYSTEM_PROMPT).not.toContain('YOLO');
  });
});

describe('Conductor vocabulary', () => {
  it('says a cloud agent is a Claude agent', () => {
    expect(CONDUCTOR_VOCABULARY.toLowerCase()).toContain('"cloud agent"');
    expect(CONDUCTOR_VOCABULARY).toContain('a Claude agent, the provider claude');
    expect(CONDUCTOR_VOCABULARY).toContain('never Codex');
  });

  it("is in Maestro's conductor prompt, its voice-line rules, and the chat conductor's prompt", () => {
    expect(CONDUCTOR_RULES).toContain(CONDUCTOR_VOCABULARY);
    expect(CONDUCTOR_SYSTEM_PROMPT).toContain(CONDUCTOR_VOCABULARY);
    expect(CHAT_CONDUCTOR_SYSTEM_PROMPT).toContain(CONDUCTOR_VOCABULARY);
  });
});
