import { observer } from 'mobx-react-lite';
import { useEffect, useState } from 'react';
import { getCanvasStore } from '@core/features/canvas/contributions/browser/app-stores';
import { formatConversationTitleForDisplay } from '@core/features/conversations/api/browser/conversation-title-utils';
import { subAgentCount } from '@core/primitives/agents/api';
import { cn } from '@core/primitives/styling/browser/cn';
import { entryForConversation } from '../roster';
import {
  advanceSubAgentStripTo,
  EMPTY_SUB_AGENT_STRIP,
  hasLeavingSubAgents,
  hasNamedSubAgents,
  settleSubAgentStrip,
  showsSubAgentLabels,
  subAgentChatSummary,
  subAgentSlotMotion,
  subAgentsKey,
  subAgentTitle,
  taskSubAgents,
  type RunningSubAgents,
  type SubAgentSlot,
  type SubAgentStripState,
} from './sub-agent-strip';

/** How long a leaving sub-agent stays mounted; matches the exit's `duration-200`. */
const EXIT_MS = 200;

/**
 * One colour per place, read by the orb's parts as `currentColor`. All four are the same solid in
 * light and dark, and none is a warning or an error.
 */
const TONES = [
  'text-foreground-info',
  'text-foreground-merged',
  'text-foreground-success',
  'text-foreground-conflict',
] as const;

const ENTER = 'animate-in fade-in fill-mode-backwards duration-300 ease-out';
const EXIT = 'animate-out fade-out fill-mode-forwards duration-200 ease-in motion-reduce:opacity-0';

/** Keeps the places of sub-agents that finished for one exit, then drops them. */
function useSubAgentStrip(running: RunningSubAgents): SubAgentStripState {
  const [strip, setStrip] = useState(() => advanceSubAgentStripTo(EMPTY_SUB_AGENT_STRIP, running));
  const key = subAgentsKey(running);
  const [seen, setSeen] = useState(key);
  if (seen !== key) {
    setSeen(key);
    setStrip(advanceSubAgentStripTo(strip, running));
  }

  useEffect(() => {
    if (!hasLeavingSubAgents(strip)) return;
    const timer = setTimeout(() => setStrip(settleSubAgentStrip), EXIT_MS);
    return () => clearTimeout(timer);
  }, [strip]);

  return strip;
}

/**
 * One running sub-agent: a core with a bead circling it. Only transform and opacity move, the
 * circling is one CSS animation, and with reduced motion the bead rests where it would start.
 */
function SubAgentOrb({ slot, title }: { slot: SubAgentSlot; title: string }) {
  const motion = subAgentSlotMotion(slot.index, TONES.length);
  return (
    <span
      aria-hidden
      title={slot.agent ? subAgentTitle(slot.agent) : title}
      className={cn('flex h-6 w-5 shrink-0 items-center justify-center', TONES[motion.tone])}
    >
      <span
        className={cn(
          'relative size-4 motion-reduce:animate-none',
          slot.leaving ? cn(EXIT, 'zoom-out-50') : cn(ENTER, 'zoom-in-50')
        )}
        style={slot.leaving ? undefined : { animationDelay: `${motion.enterDelayMs}ms` }}
      >
        <span className="absolute inset-0 rounded-full border border-current opacity-30" />
        <span className="absolute inset-[5px] rounded-full bg-current" />
        <span
          className="absolute inset-0 motion-safe:animate-spin"
          style={{
            rotate: `${motion.startDeg}deg`,
            animationDuration: `${motion.orbitMs}ms`,
            animationDirection: motion.reverse ? 'reverse' : 'normal',
          }}
        >
          <span className="absolute -top-0.5 left-1/2 size-1 -translate-x-1/2 rounded-full bg-current" />
        </span>
      </span>
    </span>
  );
}

/**
 * A named sub-agent's label beside its orb, cut to fit, and after it the name of its chat when
 * the task has several. Each shows only where the strip is wide enough (container queries on the
 * strip): a narrow pane keeps the orbs alone, a wider one adds the labels, a wide one the chats.
 */
function SubAgentLabel({ slot }: { slot: SubAgentSlot }) {
  if (!slot.agent) return null;
  return (
    <span
      aria-hidden
      title={subAgentTitle(slot.agent)}
      className={cn(
        'hidden shrink-0 items-center gap-1 pr-1.5 text-xs text-foreground-muted motion-reduce:animate-none @md:flex',
        slot.leaving ? EXIT : ENTER
      )}
    >
      <span className="max-w-32 truncate">{slot.agent.label}</span>
      {slot.agent.chat && (
        <span className="hidden max-w-24 truncate text-tiny text-foreground-passive @2xl:block">
          {slot.agent.chat}
        </span>
      )}
    </span>
  );
}

/**
 * The sub-agents running in a task's agent sessions, one orb each after their count, with the
 * label of each beside its orb when they are few and the row has room. Where the host names
 * none, the orbs stand for the sub-agents the agent waits on. In a task with several chats each
 * orb's tooltip names its chat, and the caption's tooltip says how they split. It fills the free space of the row
 * it sits in and holds that space with none running, so nothing around it moves when sub-agents
 * come and go. Orbs that do not fit wrap onto a line that is cut off, so a narrow pane shows
 * fewer whole orbs, never a clipped one.
 */
export function SubAgentStrip({ running }: { running: RunningSubAgents }) {
  const strip = useSubAgentStrip(running);
  const shown = strip.slots.length > 0;
  const labeled = showsSubAgentLabels(strip);
  const split = subAgentChatSummary(running);
  const title =
    (hasNamedSubAgents(strip)
      ? `${subAgentCount(strip.count)} running`
      : split
        ? `Waiting on ${subAgentCount(strip.count)}`
        : `The agent is waiting on ${subAgentCount(strip.count)}`) + (split ? `: ${split}` : '');
  return (
    <div
      role="status"
      className="@container flex h-6 min-w-0 flex-1 flex-wrap content-start items-center gap-x-0.5 overflow-hidden pl-1"
    >
      {shown && (
        <span
          title={title}
          className={cn(
            'flex h-6 shrink-0 items-center gap-2 pr-1 text-xs text-foreground-muted motion-reduce:animate-none',
            strip.leaving ? EXIT : ENTER
          )}
        >
          <span aria-hidden className="h-3 w-px bg-border" />
          <span className="tabular-nums">{subAgentCount(strip.count)}</span>
        </span>
      )}
      {strip.slots.map((slot) => (
        // The orb and its label wrap together, so a label never sits apart from its orb.
        <span key={slot.index} className="flex h-6 shrink-0 items-center">
          <SubAgentOrb slot={slot} title={title} />
          {labeled && <SubAgentLabel slot={slot} />}
        </span>
      ))}
      {strip.overflow > 0 && (
        <span
          aria-hidden
          title={title}
          className={cn(
            'flex h-6 shrink-0 items-center pl-0.5 text-tiny text-foreground-passive tabular-nums motion-reduce:animate-none',
            strip.leaving ? EXIT : ENTER
          )}
        >
          +{strip.overflow}
        </span>
      )}
    </div>
  );
}

/**
 * The strip for a task's chats, in the order given, read live from the agent entries the canvas
 * keeps for them. A chat's name is its window title, as the task view's tab shows it.
 */
export const ChatSubAgents = observer(function ChatSubAgents({
  conversationIds,
}: {
  conversationIds: readonly string[];
}) {
  const canvas = getCanvasStore();
  const chats = conversationIds.map((id) => {
    const entry = entryForConversation(canvas, id);
    return {
      id,
      name: entry
        ? formatConversationTitleForDisplay(entry.providerId, entry.conversationTitle)
        : '',
      named: entry?.subAgents,
      waitingOn: entry?.backgroundAgents,
    };
  });
  return <SubAgentStrip running={taskSubAgents(chats)} />;
});
