import { BlockStackView } from '@components/primitives/BlockStackView';
import {
  PlanCompletedIcon,
  PlanInProgressIcon,
  PlanPendingIcon,
} from '@components/primitives/icons';
import { Match, Switch, For } from 'solid-js';
import type { PlanEntryPriority, PlanEntryStatus } from '@/model';
import type { PlanEntryLaid } from './plan.def';
import { planVars } from './plan.css';
import { vars } from '@styles/theme.css';

// ── Status glyph helpers ──────────────────────────────────────────────────────

/** The glyph's tone: done is passive, in progress is the working accent, pending passive. */
function statusColor(status: PlanEntryStatus): string {
  if (status === 'completed') return vars.planDone;
  if (status === 'in_progress') return vars.planActive;
  return vars.fgPassive;
}

/**
 * The entry text's tone. Done steps recede; the step in progress reads in full
 * strength; what is still to come reads as body text, low priority a step down.
 * (A tone, never opacity: every step stays at or above the passive contrast floor.)
 */
function entryColor(status: PlanEntryStatus, priority: PlanEntryPriority): string {
  if (status === 'completed') return vars.fgPassive;
  if (status === 'in_progress') return vars.fg;
  return priority === 'low' ? vars.fgMuted : vars.fgBody;
}

const STATUS_WORDS: Record<PlanEntryStatus, string> = {
  completed: 'Done',
  in_progress: 'In progress',
  pending: 'To do',
};

// ── PlanList ──────────────────────────────────────────────────────────────────

export type PlanListProps = {
  entries: PlanEntryLaid[];
};

export function PlanList(props: PlanListProps) {
  return (
    <div
      style={{
        'padding-top': planVars.padY,
        'padding-bottom': planVars.padY,
      }}
    >
      <For each={props.entries}>
        {(entry, i) => (
          <div
            style={{
              display: 'flex',
              'align-items': 'flex-start',
              'column-gap': planVars.iconGap,
              'margin-top': i() > 0 ? planVars.entryGap : '0',
              color: entryColor(entry.status, entry.priority),
            }}
          >
            <div
              style={{
                width: planVars.iconBox,
                height: planVars.entryMinH,
                'flex-shrink': '0',
                display: 'flex',
                'align-items': 'center',
                'justify-content': 'center',
                color: statusColor(entry.status),
                'user-select': 'none',
              }}
              role="img"
              aria-label={STATUS_WORDS[entry.status]}
              title={STATUS_WORDS[entry.status]}
            >
              <Switch>
                <Match when={entry.status === 'completed'}>
                  <PlanCompletedIcon />
                </Match>
                <Match when={entry.status === 'in_progress'}>
                  <PlanInProgressIcon />
                </Match>
                <Match when={entry.status === 'pending'}>
                  <PlanPendingIcon />
                </Match>
              </Switch>
            </div>
            <div style={{ flex: '1' }}>
              <BlockStackView node={entry.measured} />
            </div>
          </div>
        )}
      </For>
    </div>
  );
}
